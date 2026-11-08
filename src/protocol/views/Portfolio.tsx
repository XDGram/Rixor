import { useState } from 'react'
import { Empty, TxNotice } from '../components'
import type { Ctx } from '../ctx'
import { fmtDate, fmtDuration, fmtToken, phaseOf, TIERS, type Position } from '../model'

function PositionItem({ ctx, p }: { ctx: Ctx; p: Position }) {
  const [confirming, setConfirming] = useState(false)
  const token = ctx.snapshot.tokens.find((t) => t.address.toLowerCase() === p.token.toLowerCase())
  const symbol = token?.symbol ?? 'TOKEN'
  const decimals = token?.decimals ?? 18
  const closed = p.closedAt !== 0
  const fee = (p.amount * BigInt(p.feeBps)) / 10_000n
  const emergency = ctx.snapshot.emergencyAt !== 0
  const commitments = ctx.snapshot.challenges.filter((c) => c.me.entry?.positionId === p.id)
  const running = commitments.filter((c) => ['open', 'holding'].includes(phaseOf(c, ctx.now)))
  const status = closed ? `Closed ${fmtDate(p.closedAt)}`
    : emergency ? 'Emergency: exit any time without a fee'
      : p.tier === 0 ? 'Flexible: exit any time, no fee'
        : ctx.now >= p.endsAt ? 'Term complete: exit without a fee'
          : p.tier === 2 ? `Locked until ${fmtDate(p.endsAt)} (${fmtDuration(p.endsAt - ctx.now)})`
            : `Early exit fee now ${(p.feeBps / 100).toFixed(2)}% · free in ${fmtDuration(p.endsAt - ctx.now)}`
  const key = `exit-${p.id}`

  const exit = async () => {
    if (!ctx.write) return
    const ok = await ctx.tx.run(key, [{ label: `Exit position #${p.id}`, send: () => ctx.write!.locker.exit(p.id, p.feeBps) }], `Exited position #${p.id}`)
    if (ok) setConfirming(false)
  }

  return (
    <li className="lock-row">
      <div className="lock-row-top">
        <span className={`plan-badge ${closed || p.exitAllowed ? 'is-matured' : ''}`}>{TIERS[p.tier].short}</span>
        <div className="lock-row-main">
          <strong>{fmtToken(p.amount, decimals)} {symbol}</strong>
          <span>{TIERS[p.tier].name} · #{p.id} · since {fmtDate(p.startedAt)}</span>
        </div>
        <div className="lock-row-side">
          <strong>{closed ? 'Closed' : p.exitAllowed ? 'Open' : 'Locked'}</strong>
          <span>{running.length ? `${running.length} running challenge${running.length === 1 ? '' : 's'}` : 'no running challenge'}</span>
        </div>
      </div>
      <p className={`eligibility ${closed ? '' : p.exitAllowed ? (p.feeBps > 0 ? 'is-fee' : 'is-open') : ''}`}>{status}</p>
      {!closed && running.length > 0 && (
        <p className="fine-print">Exiting before a challenge ends disqualifies this position from: {running.map((c) => c.title).join(', ')}.</p>
      )}
      {!closed && (
        <div className="lock-row-actions">
          <span className="lock-reward">{p.tier !== 0 && !emergency ? `Term ends ${fmtDate(p.endsAt)}` : 'No term'}</span>
          <div>
            <button type="button" className={`btn btn--sm ${p.exitAllowed && p.feeBps === 0 ? 'btn--lime' : 'btn--ghost'}`} disabled={!p.exitAllowed || ctx.tx.busy || !ctx.write} onClick={() => setConfirming(!confirming)}>
              {p.exitAllowed ? (p.feeBps > 0 ? 'Exit early' : 'Exit') : 'Locked'}
            </button>
          </div>
        </div>
      )}
      {confirming && p.exitAllowed && !closed && (
        <div className={`break-confirm ${p.feeBps === 0 ? 'is-calm' : ''}`}>
          <dl className="rows">
            {p.feeBps > 0 && <div className="is-loss"><dt>Fee ({(p.feeBps / 100).toFixed(2)}%, burned)</dt><dd>−{fmtToken(fee, decimals)} {symbol}</dd></div>}
            <div><dt>You receive</dt><dd>{fmtToken(p.amount - fee, decimals)} {symbol}</dd></div>
            {running.length > 0 && <div className="is-loss"><dt>Challenges</dt><dd>Disqualified from {running.length}</dd></div>}
          </dl>
          <div className="btn-pair">
            <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>Keep holding</button>
            <button type="button" className={`btn ${p.feeBps > 0 || running.length ? 'btn--danger' : 'btn--lime'}`} disabled={ctx.tx.busy} onClick={() => void exit()}>Confirm exit</button>
          </div>
        </div>
      )}
      <TxNotice tx={ctx.tx.tx} for={key} />
    </li>
  )
}

export function Portfolio({ ctx }: { ctx: Ctx }) {
  const { snapshot, wallet } = ctx
  if (!wallet) {
    return (
      <div className="view">
        <Empty title="Connect the demo wallet" action={<button type="button" className="btn btn--lime" onClick={ctx.openWallet}>Connect</button>}>
          Positions, challenge entries and rewards appear here.
        </Empty>
      </div>
    )
  }
  const open = snapshot.positions.filter((p) => p.closedAt === 0)
  const closed = snapshot.positions.filter((p) => p.closedAt !== 0)
  const actionable = snapshot.challenges.filter((c) => c.me.claimable > 0n
    || (c.me.contribution > 0n && !c.me.refunded && (phaseOf(c, ctx.now) === 'failed' || phaseOf(c, ctx.now) === 'cancelled'))
    || (c.me.contribution > 0n && !c.me.swept && phaseOf(c, ctx.now) === 'sweeping'))
  const wif = snapshot.tokens[0]

  return (
    <div className="view">
      <section className="card">
        <header className="panel-head"><div><small className="kicker">Demo wallet · fork balances</small><h2>Your portfolio</h2></div></header>
        <div className="stat-grid">
          {snapshot.tokens.map((t) => <div className="stat" key={t.address}><small>Fork {t.symbol} available</small><strong>{fmtToken(t.balance, t.decimals, { compact: true })}</strong><span>not a real balance</span></div>)}
          <div className="stat"><small>Open positions</small><strong>{open.length}</strong><span>{closed.length} closed</span></div>
          <div className="stat"><small>Challenges joined</small><strong>{snapshot.challenges.filter((c) => c.me.entry).length}</strong><span>{snapshot.challenges.filter((c) => c.me.contribution > 0n).length} sponsored</span></div>
          <div className="stat"><small>Rewards claimed</small><strong>{fmtToken(snapshot.activity.filter((a) => a.kind === 'Claimed' && ctx.label(a.actor) === 'You').reduce((s, a) => s + (a.amount ?? 0n), 0n), 18, { compact: true })}</strong><span>fork {wif?.symbol ?? 'WIF'}</span></div>
        </div>
      </section>

      {actionable.length > 0 && (
        <section className="card">
          <header className="panel-head"><div><small className="kicker">Ready for you</small><h2>Claims and refunds</h2></div></header>
          <ul className="feed">
            {actionable.map((c) => (
              <li key={c.id}>
                <span className="feed-icon feed-icon--deposit">#{c.id}</span>
                <span className="feed-copy"><strong>{c.title}</strong><span>{c.me.claimable > 0n ? `Claim ${fmtToken(c.me.claimable)} WIF` : phaseOf(c, ctx.now) === 'sweeping' ? 'Unclaimed share returns to sponsors' : 'Refund your contribution'}</span></span>
                <span className="feed-amount"><button type="button" className="btn btn--lime btn--sm" onClick={() => ctx.go({ name: 'challenge', id: c.id })}>Open</button></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card list-card my-locks">
        <header className="panel-head">
          <div><small className="kicker">Positions</small><h2>{open.length ? `${open.length} open` : 'No open positions'}</h2></div>
          <button type="button" className="btn btn--lime btn--sm" onClick={() => ctx.go({ name: 'lock' })}>New lock</button>
        </header>
        {snapshot.positions.length === 0 ? <Empty title="Nothing locked yet">Lock WIF to join challenges.</Empty> : (
          <ul className="lock-list">{[...open, ...closed].map((p) => <PositionItem key={p.id} ctx={ctx} p={p} />)}</ul>
        )}
      </section>
    </div>
  )
}
