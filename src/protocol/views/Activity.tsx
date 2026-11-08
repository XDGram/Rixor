import { useState } from 'react'
import { icon } from '../../ui'
import { Empty } from '../components'
import type { Ctx } from '../ctx'
import { fmtDate, fmtPoints, fmtToken, shortAddr, TIERS } from '../model'
import type { ActivityItem } from '../useProtocol'
import { ENV } from '../envtext'

function describe(ctx: Ctx, a: ActivityItem): { title: string; detail: string; amount?: string; icon: 'lock' | 'arrowUp' | 'trophy' | 'coins' | 'check' | 'flame' | 'plus' } {
  const who = ctx.label(a.actor)
  const tok = ctx.snapshot.tokens.find((t) => t.address.toLowerCase() === a.token?.toLowerCase())
  const sym = tok?.symbol ?? ''
  const dec = tok?.decimals ?? 18
  const ch = a.challengeId !== undefined ? ctx.snapshot.challenges.find((c) => c.id === a.challengeId) : undefined
  const name = ch ? `“${ch.title}”` : `challenge #${a.challengeId}`
  switch (a.kind) {
    case 'Locked': return { title: `${who} locked ${sym}`, detail: `${TIERS[a.tier ?? 0].name} · position #${a.positionId}`, amount: `${fmtToken(a.amount ?? 0n, dec, { compact: true })} ${sym}`, icon: 'lock' }
    case 'Exited': return { title: `${who} exited`, detail: a.fee && a.fee > 0n ? `fee ${fmtToken(a.fee, dec, { compact: true })} ${sym} burned` : `position #${a.positionId}`, amount: `${fmtToken(a.amount ?? 0n, dec, { compact: true })} ${sym}`, icon: 'arrowUp' }
    case 'StreamFunded': return { title: `${who} funded a ${sym} reward stream`, detail: 'Prefunded WIF, shared by lockers', amount: `${fmtToken(a.amount ?? 0n, 18, { compact: true })} WIF`, icon: 'coins' }
    case 'RewardClaimed': return { title: `${who} claimed stream rewards`, detail: `position #${a.positionId}`, amount: `${fmtToken(a.amount ?? 0n, 18, { compact: true })} WIF`, icon: 'trophy' }
    case 'StreamRefunded': return { title: `Stream refund paid to ${who === 'You' ? 'you' : who}`, detail: 'Unallocated or unstreamed WIF', amount: `${fmtToken(a.amount ?? 0n, 18, { compact: true })} WIF`, icon: 'coins' }
    case 'TokenReleased': return { title: `${sym} released by ${who}`, detail: 'All its positions can exit without a fee', icon: 'flame' }
    case 'ChallengeCreated': return { title: `${who} created a ${a.success ? 'Season' : 'community'} challenge`, detail: a.title ?? name, amount: `${fmtToken(a.amount ?? 0n, 18, { compact: true })} WIF`, icon: 'plus' }
    case 'Sponsored': return { title: `${who} sponsored`, detail: name, amount: `+${fmtToken(a.amount ?? 0n, 18, { compact: true })} WIF`, icon: 'coins' }
    case 'Joined': return { title: `${who} joined`, detail: name, amount: `${fmtPoints(a.points ?? 0n)} pts`, icon: 'trophy' }
    case 'Settled': return { title: `${name} settled`, detail: a.success ? `succeeded · ${fmtPoints(a.points ?? 0n)} qualified points` : 'did not succeed · refunds open', icon: 'check' }
    case 'Claimed': return { title: `${who} claimed`, detail: name, amount: `${fmtToken(a.amount ?? 0n, 18, { compact: true })} WIF`, icon: 'trophy' }
    case 'Refunded': return { title: `Refund paid to ${who === 'You' ? 'you' : who}`, detail: name, amount: `${fmtToken(a.amount ?? 0n, 18, { compact: true })} WIF`, icon: 'coins' }
    case 'Swept': return { title: `Unclaimed share returned to ${who === 'You' ? 'you' : who}`, detail: name, amount: `${fmtToken(a.amount ?? 0n, 18, { compact: true })} WIF`, icon: 'coins' }
  }
}

export function ActivityView({ ctx }: { ctx: Ctx }) {
  const [mine, setMine] = useState(false)
  const items = ctx.snapshot.activity.filter((a) => !mine || ctx.label(a.actor) === 'You')
  return (
    <div className="view">
      <section className="card">
        <header className="panel-head">
          <div><small className="kicker">Contract events · {ENV.whereShort}</small><h2>{mine ? 'Your transactions' : 'Everything happening'}</h2></div>
          <div className="seg">
            <button type="button" className={!mine ? 'is-active' : ''} onClick={() => setMine(false)}>All</button>
            <button type="button" className={mine ? 'is-active' : ''} onClick={() => setMine(true)} disabled={!ctx.wallet}>Mine</button>
          </div>
        </header>
        {items.length === 0 ? <Empty title="No activity yet" /> : (
          <ul className="feed">
            {items.map((a) => {
              const d = describe(ctx, a)
              return (
                <li key={a.key}>
                  <span className={`feed-icon ${a.kind === 'Locked' || a.kind === 'ChallengeCreated' ? 'feed-icon--deposit' : ''}`}>{icon(d.icon, 16)}</span>
                  <span className="feed-copy">
                    <strong>{d.title}</strong>
                    <span>{d.detail}{a.timestamp ? ` · ${fmtDate(a.timestamp)}` : ''}</span>
                  </span>
                  <span className="feed-amount">
                    {d.amount && <strong>{d.amount}</strong>}
                    <small className="mono">{shortAddr(a.tx)}</small>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <p className="fine-print">{ENV.events}</p>
      </section>
    </div>
  )
}
