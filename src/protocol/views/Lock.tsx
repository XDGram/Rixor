import { useMemo, useState } from 'react'
import { formatUnits } from 'ethers'
import { TxNotice } from '../components'
import type { Ctx } from '../ctx'
import { fmtToken, MAX_POSITION_UNITS, MAX_SCORED_UNITS, parseAmount, pointsFor, TIERS, fmtPoints } from '../model'

const TERMS = [30, 60, 90]

export function LockView({ ctx }: { ctx: Ctx }) {
  const { snapshot, wallet, write, tx } = ctx
  const [tokenAddr, setTokenAddr] = useState(snapshot.tokens[0]?.address ?? '')
  const token = snapshot.tokens.find((t) => t.address === tokenAddr) ?? snapshot.tokens[0]
  const [amountText, setAmountText] = useState('')
  const [tier, setTier] = useState(1)
  const [termDays, setTermDays] = useState(30)

  const amount = parseAmount(amountText, token?.decimals ?? 18)
  const min = token?.unit ?? 0n
  const max = token ? token.unit * BigInt(MAX_POSITION_UNITS) : 0n
  const capLeft = token ? token.cap - token.totalLocked : 0n
  const problem = useMemo(() => {
    if (!token) return 'No supported token.'
    if (!token.locksEnabled) return 'New locks are disabled for this token.'
    if (amount === null) return null
    if (amount < min) return `Minimum is 1 unit (${fmtToken(min, token.decimals)} ${token.symbol}).`
    if (amount > max) return `Maximum is ${MAX_POSITION_UNITS} units (${fmtToken(max, token.decimals)} ${token.symbol}) per position.`
    if (amount > capLeft) return `Only ${fmtToken(capLeft, token.decimals)} ${token.symbol} of cap remains.`
    if (wallet && amount > token.balance) return 'That is more than this wallet holds.'
    return null
  }, [token, amount, min, max, capLeft, wallet])

  if (!token) return null
  const score = amount ? pointsFor(amount, token.unit, tier, token.multiplierBps) : null
  const busy = tx.busy
  const canSubmit = Boolean(wallet && write && amount && !problem && !busy && !snapshot.paused)

  const submit = async () => {
    if (!write || !amount || !wallet) return
    const steps = []
    if (token.allowanceLocker < amount) {
      steps.push({ label: `Approve ${fmtToken(amount, token.decimals)} ${token.symbol}`, send: () => write.wif.approve(ctx.manifest.contracts.locker, amount) })
    }
    steps.push({ label: `Lock ${fmtToken(amount, token.decimals)} ${token.symbol} · ${TIERS[tier].name}`, send: () => write.locker.lock(token.address, amount, tier, tier === 0 ? 0 : termDays) })
    const ok = await tx.run('lock', steps, `Locked ${fmtToken(amount, token.decimals)} ${token.symbol} (${TIERS[tier].name})`)
    if (ok) setAmountText('')
  }

  const setUnits = (u: number) => setAmountText(formatUnits(token.unit * BigInt(u), token.decimals).replace(/\.0$/, ''))

  return (
    <div className="view">
      <section className="card lock-card">
        <header className="panel-head">
          <div><small className="kicker">New position</small><h2>Lock {token.symbol}</h2></div>
          {snapshot.tokens.length > 1 && (
            <div className="seg">
              {snapshot.tokens.map((t) => <button key={t.address} type="button" className={t.address === token.address ? 'is-active' : ''} onClick={() => setTokenAddr(t.address)}>{t.symbol}</button>)}
            </div>
          )}
        </header>

        <div className="term-grid tier-grid" role="radiogroup" aria-label="Tier">
          {TIERS.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={tier === t.id} className={`term ${tier === t.id ? 'is-active' : ''}`} onClick={() => setTier(t.id)}>
              <span className="term-top"><strong>{t.name}</strong><em>{t.multiplierBps / 10_000}×</em></span>
              <small>{t.summary}</small>
            </button>
          ))}
        </div>

        <div className="amount-field">
          <div className="amount-field-head">
            <label htmlFor="lock-amount">Amount</label>
            <span className={problem && amount !== null ? 'is-error' : ''}>{wallet ? `${fmtToken(token.balance, token.decimals)} demo ${token.symbol} in your demo wallet` : 'Connect the demo wallet'}</span>
          </div>
          <div className={`amount-input ${problem && amount !== null ? 'is-error' : ''}`}>
            <input id="lock-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amountText} onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ''))} />
            <span>{token.symbol}</span>
          </div>
          <div className="chip-row">
            {[1, 5, 10, MAX_POSITION_UNITS].map((u) => (
              <button key={u} type="button" className="chip" onClick={() => setUnits(u)}>{u} unit{u === 1 ? '' : 's'}</button>
            ))}
          </div>
          {problem && amount !== null && <div className="field-error">{problem}</div>}
        </div>

        {tier !== 0 && (
          <div className="commit-field">
            <span>Term</span>
            <div className="chip-row">
              {TERMS.map((d) => <button key={d} type="button" className={`chip ${termDays === d ? 'is-active' : ''}`} onClick={() => setTermDays(d)}>{d} days</button>)}
            </div>
          </div>
        )}

        <dl className="rows">
          <div><dt>Unit size (provisional)</dt><dd>1 unit = {fmtToken(token.unit, token.decimals)} {token.symbol}</dd></div>
          <div><dt>Challenge score per entry</dt><dd>{score ? `${score.units} unit${score.units === 1 ? '' : 's'} → ${fmtPoints(score.points)} points` : '—'}</dd></div>
          {tier === 0 && <div><dt>Leaving</dt><dd>Any time, no fee</dd></div>}
          {tier === 1 && <div><dt>Leaving early</dt><dd>Fee up to 10%, falling to 0 over {termDays} days, burned</dd></div>}
          {tier === 2 && <div><dt>Leaving</dt><dd>Not before {termDays} days (emergency excepted)</dd></div>}
        </dl>
        <p className="fine-print">
          Points count at most {MAX_SCORED_UNITS} units per challenge entry and are relative scoring units, not a valuation.
          Locking does not earn yield. You can win WIF only from a prefunded challenge you join and complete.
        </p>

        <TxNotice tx={tx.tx} for="lock" />
        {wallet ? (
          <button type="button" className="btn btn--lime btn--block btn--lg" disabled={!canSubmit} onClick={() => void submit()}>
            {busy && tx.tx?.key === 'lock' ? 'Working…' : snapshot.paused ? 'Locks paused' : `Lock ${token.symbol}`}
          </button>
        ) : (
          <button type="button" className="btn btn--lime btn--block btn--lg" onClick={ctx.openWallet}>Connect demo wallet</button>
        )}
        {wallet && token.allowanceLocker < (amount ?? 0n) && <p className="fine-print">Two simulated transactions: approve, then lock.</p>}
      </section>
    </div>
  )
}

export function TokenView({ ctx, address }: { ctx: Ctx; address: string }) {
  const token = ctx.snapshot.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase())
  const lockers = useMemo(() => {
    const byOwner = new Map<string, bigint>()
    for (const a of [...ctx.snapshot.activity].reverse()) {
      if (a.kind === 'Locked' && a.amount) byOwner.set(a.actor, (byOwner.get(a.actor) ?? 0n) + a.amount)
      if (a.kind === 'Exited' && a.amount !== undefined) byOwner.set(a.actor, (byOwner.get(a.actor) ?? 0n) - a.amount - (a.fee ?? 0n))
    }
    return [...byOwner.entries()].filter(([, v]) => v > 0n).sort((x, y) => (y[1] > x[1] ? 1 : -1)).slice(0, 10)
  }, [ctx.snapshot.activity])
  if (!token) return <div className="view"><div className="notice notice--warn"><strong>Unsupported token</strong><span>This address is not listed in the Rixor Locker.</span></div></div>
  const accepting = ctx.snapshot.challenges.filter((c) => c.tokens.some((t) => t.toLowerCase() === token.address.toLowerCase()))
  return (
    <div className="view">
      <section className="card">
        <header className="panel-head">
          <div><small className="kicker">Token community</small><h2>{token.symbol}</h2></div>
          <button type="button" className="btn btn--lime btn--sm" onClick={() => ctx.go({ name: 'lock' })}>Lock {token.symbol}</button>
        </header>
        <div className="stat-grid">
          <div className="stat"><small>Total locked</small><strong>{fmtToken(token.totalLocked, token.decimals, { compact: true })}</strong><span>{token.symbol}</span></div>
          <div className="stat"><small>Pilot cap</small><strong>{fmtToken(token.cap, token.decimals, { compact: true })}</strong><span>provisional demo value</span></div>
          <div className="stat"><small>Unit size</small><strong>{fmtToken(token.unit, token.decimals, { compact: true })}</strong><span>provisional demo value</span></div>
          <div className="stat"><small>Token multiplier</small><strong>{(token.multiplierBps / 10_000).toFixed(1)}×</strong><span>{token.multiplierBps > 10_000 ? 'reward-token bonus' : 'standard'}</span></div>
        </div>
        <dl className="rows">
          <div><dt>Contract</dt><dd className="mono">{token.address}</dd></div>
          <div><dt>Vetting</dt><dd>Verified source · no owner · exact transfers</dd></div>
          <div><dt>Challenges accepting {token.symbol}</dt><dd>{accepting.length}</dd></div>
        </dl>
      </section>
      <section className="card">
        <header className="panel-head"><div><small className="kicker">Community</small><h2>Largest open lockers</h2></div></header>
        {lockers.length === 0 ? <p className="fine-print">No open positions yet.</p> : (
          <ol className="board">
            {lockers.map(([who, amt], i) => (
              <li key={who} className={ctx.label(who) === 'You' ? 'is-me' : ''}>
                <span className="board-rank">{i + 1}</span><span>{ctx.label(who)}</span><strong>{fmtToken(amt, token.decimals, { compact: true })} {token.symbol}</strong>
              </li>
            ))}
          </ol>
        )}
        <p className="fine-print">Computed from on-chain Locked and Exited events on the demo chain.</p>
      </section>
    </div>
  )
}
