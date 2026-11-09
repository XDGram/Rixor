import { useMemo, useState } from 'react'
import { formatUnits } from 'ethers'
import { TxNotice } from '../components'
import type { Ctx } from '../ctx'
import { estimateDaily, fmtDate, fmtToken, MAX_POSITION_UNITS, MAX_SCORED_UNITS, parseAmount, pointsFor, RISK_CLASS, TIERS, fmtPoints, tierAllowed, weightOf } from '../model'
import { listEntry } from '../tokenlist'
import { ENV } from '../envtext'

const TERMS = [30, 60, 90]

export function ClassTag({ riskClass }: { riskClass: number }) {
  return <span className={`tag ${riskClass === 1 ? 'tag--lime' : 'tag--outline'}`}>{RISK_CLASS[riskClass]?.label ?? 'Unclassified'}</span>
}

export function LockView({ ctx }: { ctx: Ctx }) {
  const { snapshot, wallet, write, tx } = ctx
  const startToken = (() => {
    const fromHash = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('token')
    return snapshot.tokens.find((t) => t.address.toLowerCase() === fromHash?.toLowerCase())?.address ?? snapshot.tokens[0]?.address ?? ''
  })()
  const [tokenAddr, setTokenAddr] = useState(startToken)
  const token = snapshot.tokens.find((t) => t.address === tokenAddr) ?? snapshot.tokens[0]
  const [amountText, setAmountText] = useState('')
  const [tierChoice, setTier] = useState(1)
  const [termChoice, setTermDays] = useState(30)
  const mask = token?.allowedMask ?? 0
  // Keep the choice valid for the selected token's class (e.g. no Diamond for Class B).
  const tier = tierAllowed(mask, tierChoice) ? tierChoice : tierAllowed(mask, 1) ? 1 : 0
  const terms = TERMS.filter((d) => d <= (token?.maxTermDays || 90))
  const termDays = terms.includes(termChoice) ? termChoice : terms[terms.length - 1] ?? 30

  const amount = parseAmount(amountText, token?.decimals ?? 18)
  const min = token?.unit ?? 0n
  const max = token ? token.unit * BigInt(MAX_POSITION_UNITS) : 0n
  const capLeft = token ? token.cap - token.totalLocked : 0n
  const problem = useMemo(() => {
    if (!token) return 'No supported token.'
    if (token.releasedAt !== 0) return 'This token was released: existing positions can exit without a fee, and new locks are closed.'
    if (!token.locksEnabled) return 'New locks are disabled for this token.'
    if (amount === null) return null
    if (amount < min) return `Minimum is 1 unit (${fmtToken(min, token.decimals)} ${token.symbol}).`
    if (amount > max) return `Maximum is ${MAX_POSITION_UNITS} units (${fmtToken(max, token.decimals)} ${token.symbol}) per position.`
    if (amount > capLeft) return `Only ${fmtToken(capLeft, token.decimals)} ${token.symbol} of cap remains.`
    if (wallet && amount > token.balance) return 'That is more than this wallet holds.'
    return null
  }, [token, amount, min, max, capLeft, wallet])

  if (!token) return null
  const score = amount ? pointsFor(amount, token.unit, tier) : null
  const daily = amount ? estimateDaily(token.rateNow, token.totalWeight, weightOf(amount, tier)) : 0n
  const listInfo = listEntry(token.address)
  const nextStream = token.streams.filter((x) => x.start > ctx.now).sort((a, b) => a.start - b.start)[0]
  const busy = tx.busy
  const canSubmit = Boolean(wallet && write && amount && !problem && !busy && !snapshot.paused)

  const submit = async () => {
    if (!write || !amount || !wallet) return
    const steps = []
    if (token.allowanceLocker < amount) {
      // Exact-amount approval of the token being locked, to the Locker only.
      steps.push({ label: `Approve ${fmtToken(amount, token.decimals)} ${token.symbol}`, send: () => write.token(token.address).approve(ctx.manifest.contracts.locker, amount) })
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
          <div><small className="kicker">New position · from your wallet</small><h2>Lock {token.symbol} <ClassTag riskClass={token.riskClass} /></h2></div>
          {snapshot.tokens.length > 1 && (
            <div className="seg">
              {snapshot.tokens.map((t) => <button key={t.address} type="button" className={t.address === token.address ? 'is-active' : ''} onClick={() => setTokenAddr(t.address)}>{t.symbol}</button>)}
            </div>
          )}
        </header>

        <div className="notice"><strong>{ENV.listingTitle}</strong><span>{ENV.listingBody(token.symbol)} {ENV.chain === 'mainnet' ? '' : listInfo?.note ?? ''}</span></div>

        <div className="term-grid tier-grid" role="radiogroup" aria-label="Tier">
          {TIERS.map((t) => {
            const allowed = tierAllowed(mask, t.id)
            return (
              <button key={t.id} type="button" role="radio" aria-checked={tier === t.id} disabled={!allowed} className={`term ${tier === t.id ? 'is-active' : ''}`} onClick={() => setTier(t.id)}>
                <span className="term-top"><strong>{t.name}</strong><em>{t.multiplierBps / 10_000}×</em></span>
                <small>{allowed ? t.summary : `Not available for ${RISK_CLASS[token.riskClass]?.label ?? 'this token'}`}</small>
              </button>
            )
          })}
        </div>
        <p className="fine-print">{RISK_CLASS[token.riskClass]?.label}: {RISK_CLASS[token.riskClass]?.why}</p>

        <div className="amount-field">
          <div className="amount-field-head">
            <label htmlFor="lock-amount">Amount</label>
            <span className={problem && amount !== null ? 'is-error' : ''}>{wallet ? `${fmtToken(token.balance, token.decimals)} ${ENV.bal} ${token.symbol} in your ${ENV.wallet}` : `Connect the ${ENV.wallet}`}</span>
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
              {terms.map((d) => <button key={d} type="button" className={`chip ${termDays === d ? 'is-active' : ''}`} onClick={() => setTermDays(d)}>{d} days</button>)}
            </div>
          </div>
        )}

        <dl className="rows">
          <div><dt>WIF rewards now</dt><dd>{token.rateNow > 0n ? (amount ? `≈ ${fmtToken(daily)} WIF/day at today's stream rate` : `${fmtToken(token.rateNow * 86_400n, 18, { compact: true })} WIF/day shared by all ${token.symbol} lockers`) : nextStream ? `Next stream starts ${fmtDate(nextStream.start)}` : 'No active stream'}</dd></div>
          <div><dt>Unit size{ctx.manifest.params.provisional ? ' (provisional)' : ''}</dt><dd>1 unit = {fmtToken(token.unit, token.decimals)} {token.symbol}</dd></div>
          <div><dt>Challenge score per entry</dt><dd>{score ? `${score.units} unit${score.units === 1 ? '' : 's'} → ${fmtPoints(score.points)} points` : '—'}</dd></div>
          {tier === 0 && <div><dt>Leaving</dt><dd>Any time, no fee</dd></div>}
          {tier === 1 && <div><dt>Leaving early</dt><dd>Fee up to 10%, falling to 0 over {termDays} days, burned</dd></div>}
          {tier === 2 && <div><dt>Leaving</dt><dd>Not before {termDays} days (emergency excepted)</dd></div>}
        </dl>
        <p className="fine-print">
          WIF rewards come only from streams that sponsors fund up front, shared by weight (amount × tier); the estimate changes as others lock or exit and is not guaranteed.
          You never need WIF to lock. Challenge points count at most {MAX_SCORED_UNITS} units per entry and are relative scoring units, not a valuation.
        </p>

        <TxNotice tx={tx.tx} for="lock" />
        {wallet ? (
          <button type="button" className="btn btn--lime btn--block btn--lg" disabled={!canSubmit} onClick={() => void submit()}>
            {busy && tx.tx?.key === 'lock' ? 'Working…' : snapshot.paused ? 'Locks paused' : `Lock ${token.symbol}`}
          </button>
        ) : (
          <button type="button" className="btn btn--lime btn--block btn--lg" onClick={ctx.openWallet}>Connect {ENV.wallet}</button>
        )}
        {wallet && token.allowanceLocker < (amount ?? 0n) && <p className="fine-print">Two transactions {ENV.where}: approve, then lock.</p>}
      </section>
    </div>
  )
}

export function TokenView({ ctx, address }: { ctx: Ctx; address: string }) {
  const token = ctx.snapshot.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase())
  const lockers = useMemo(() => {
    const byOwner = new Map<string, bigint>()
    for (const a of [...ctx.snapshot.activity].reverse()) {
      if (a.token?.toLowerCase() !== address.toLowerCase()) continue
      if (a.kind === 'Locked' && a.amount) byOwner.set(a.actor, (byOwner.get(a.actor) ?? 0n) + a.amount)
      if (a.kind === 'Exited' && a.amount !== undefined) byOwner.set(a.actor, (byOwner.get(a.actor) ?? 0n) - a.amount - (a.fee ?? 0n))
    }
    return [...byOwner.entries()].filter(([, v]) => v > 0n).sort((x, y) => (y[1] > x[1] ? 1 : -1)).slice(0, 10)
  }, [ctx.snapshot.activity, address])
  if (!token) {
    const entry = listEntry(address)
    return <div className="view"><div className="notice notice--warn"><strong>{entry ? `${entry.symbol}: not supported` : 'Unsupported token'}</strong><span>{entry?.note ?? 'This address is not listed in the Rixor Locker.'}</span></div></div>
  }
  const listInfo = listEntry(token.address)
  const accepting = ctx.snapshot.challenges.filter((c) => c.tokens.some((t) => t.toLowerCase() === token.address.toLowerCase()))
  const cls = RISK_CLASS[token.riskClass]
  return (
    <div className="view">
      <section className="card">
        <header className="panel-head">
          <div><small className="kicker">Token community · {ENV.whereShort}</small><h2>{token.symbol} <ClassTag riskClass={token.riskClass} /></h2></div>
          <button type="button" className="btn btn--lime btn--sm" disabled={token.allowedMask === 0} onClick={() => { window.location.hash = `#/lock?token=${token.address}` }}>Lock {token.symbol}</button>
        </header>
        {token.releasedAt !== 0 && <div className="notice notice--error"><strong>Released {fmtDate(token.releasedAt)}</strong><span>Every {token.symbol} position can exit now without a fee. New locks are closed and reward accrual stopped at release.</span></div>}
        <div className="stat-grid">
          <div className="stat"><small>Total locked</small><strong>{fmtToken(token.totalLocked, token.decimals, { compact: true })}</strong><span>{token.symbol}</span></div>
          <div className="stat"><small>WIF streaming now</small><strong>{fmtToken(token.rateNow * 86_400n, 18, { compact: true })}</strong><span>WIF per day</span></div>
          <div className="stat"><small>Cap</small><strong>{fmtToken(token.cap, token.decimals, { compact: true })}</strong><span>{ENV.params}</span></div>
          <div className="stat"><small>Unit size</small><strong>{fmtToken(token.unit, token.decimals, { compact: true })}</strong><span>{ENV.params}</span></div>
        </div>
        <dl className="rows">
          <div><dt>Contract</dt><dd className="mono">{token.address}</dd></div>
          <div><dt>Risk class</dt><dd>{cls?.label}: {cls?.tiers}, terms up to {cls?.maxTermDays} days</dd></div>
          <div><dt>Listing status</dt><dd>{ENV.chain === 'mainnet' ? ENV.listingTitle : listInfo?.note ?? ENV.listingTitle}</dd></div>
          <div><dt>Challenges accepting {token.symbol}</dt><dd>{accepting.length}</dd></div>
        </dl>
        <p className="fine-print">{cls?.why} Risk classes limit what you can commit to; they never limit withdrawing your own tokens.</p>
        {listInfo?.disclosures?.map((d) => <div key={d} className="notice"><span>{d}</span></div>)}
      </section>
      <StreamsCard ctx={ctx} tokenAddress={token.address} />
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
        <p className="fine-print">Computed from on-chain Locked and Exited events on the {ENV.chain}.</p>
      </section>
    </div>
  )
}

/** Reward streams for one token, plus a form to fund a new one with WIF (sponsors only; never needed to lock). */
export function StreamsCard({ ctx, tokenAddress }: { ctx: Ctx; tokenAddress: string }) {
  const token = ctx.snapshot.tokens.find((t) => t.address.toLowerCase() === tokenAddress.toLowerCase())!
  const [amountText, setAmountText] = useState('')
  const [days, setDays] = useState(14)
  const amount = parseAmount(amountText)
  const wif = ctx.snapshot.wif
  const min = 10_000n * 10n ** 18n
  const problem = amount === null ? null : amount < min ? 'The minimum stream is 10,000 WIF.' : amount > wif.balance ? `More ${ENV.bal} WIF than this wallet holds.` : null
  const blocked = ctx.snapshot.emergencyAt !== 0 || token.releasedAt !== 0
  const fund = async () => {
    if (!ctx.write || !amount) return
    const w = ctx.write
    const steps = []
    if (wif.allowanceRewards < amount) steps.push({ label: `Approve ${fmtToken(amount)} WIF`, send: () => w.wif.approve(ctx.manifest.contracts.rewards, amount) })
    steps.push({ label: `Fund a ${days}-day ${token.symbol} stream with ${fmtToken(amount)} WIF`, send: () => w.rewards.fund(token.address, amount, days) })
    const ok = await ctx.tx.run('fund', steps, `Stream funded: ${fmtToken(amount)} WIF over ${days} days`)
    if (ok) setAmountText('')
  }
  const refund = async (id: number) => {
    if (!ctx.write) return
    const w = ctx.write
    await ctx.tx.run(`refund-${id}`, [{ label: `Return stream #${id}'s unallocated WIF to its funder`, send: () => w.rewards.refund(id, 2_000) }], `Stream #${id} refund paid to its funder`)
  }
  const streams = [...token.streams].sort((a, b) => b.id - a.id)
  return (
    <section className="card">
      <header className="panel-head"><div><small className="kicker">Prefunded WIF rewards</small><h2>{token.symbol} reward streams</h2></div></header>
      {streams.length === 0 ? <p className="fine-print">No streams yet.</p> : (
        <ul className="feed">
          {streams.map((x) => {
            const state = x.refunded ? 'refunded' : ctx.now < x.start ? `starts ${fmtDate(x.start)}` : ctx.now < x.end ? `ends ${fmtDate(x.end)}` : 'finished'
            return (
              <li key={x.id}>
                <span className="feed-icon feed-icon--deposit">#{x.id}</span>
                <span className="feed-copy"><strong>{fmtToken(x.amount, 18, { compact: true })} WIF over {Math.round((x.end - x.start) / 86400)} days</strong><span>{ctx.label(x.funder)} · {state}</span></span>
                <span className="feed-amount">
                  <strong>{fmtToken(x.rate * 86_400n, 18, { compact: true })}/day</strong>
                  {!x.refunded && (ctx.now >= x.end || blocked) && ctx.write && <button type="button" className="btn btn--ghost btn--sm" disabled={ctx.tx.busy} onClick={() => void refund(x.id)}>Settle refund</button>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {['fund', ...streams.map((x) => `refund-${x.id}`)].map((k) => <TxNotice key={k} tx={ctx.tx.tx} for={k} />)}
      {ctx.wallet && !blocked && (
        <div className="sheet-section">
          <small className="kicker">Sponsor: fund a new stream</small>
          <div className={`amount-input amount-input--sm ${problem ? 'is-error' : ''}`}>
            <input inputMode="decimal" autoComplete="off" placeholder="10,000 minimum" value={amountText} onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Stream amount" />
            <span>WIF</span>
          </div>
          <div className="chip-row">{[7, 14, 30, 60, 90].map((d) => <button key={d} type="button" className={`chip ${days === d ? 'is-active' : ''}`} onClick={() => setDays(d)}>{d} days</button>)}</div>
          {problem && <div className="field-error">{problem}</div>}
          <p className="fine-print">The stream starts at the next UTC midnight and pays {token.symbol} lockers by weight. Time with nobody locked, and anything left after a release or emergency, returns to you. You hold {fmtToken(wif.balance, 18, { compact: true })} {ENV.bal} WIF.</p>
          <button type="button" className="btn btn--ghost btn--block" disabled={!amount || Boolean(problem) || ctx.tx.busy || !ctx.write} onClick={() => void fund()}>Fund stream</button>
        </div>
      )}
    </section>
  )
}
