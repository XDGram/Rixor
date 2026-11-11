import { useMemo, useState } from 'react'
import { icon } from '../../ui'
import { DemoTag, Empty } from '../components'
import type { Ctx } from '../ctx'
import { fmtDuration, fmtPoints, fmtToken, pct, phaseOf, PHASE_LABEL, RISK_CLASS, TIERS, type Challenge } from '../model'
import { HoldingsCard } from './Holdings'
import { ENV, MODE } from '../envtext'

type Filter = 'live' | 'ended' | 'mine'

export function ChallengeRow({ ctx, c }: { ctx: Ctx; c: Challenge }) {
  const phase = phaseOf(c, ctx.now)
  const symbols = c.tokens.map((t) => ctx.snapshot.tokens.find((x) => x.address.toLowerCase() === t.toLowerCase())?.symbol ?? '?').join(' + ')
  const goal = c.goalPoints > 0n ? Math.min(100, pct(c.joinedPoints, c.goalPoints)) : null
  const timing = phase === 'open' ? `Join closes in ${fmtDuration(c.joinDeadline - ctx.now)}`
    : phase === 'holding' ? `Ends in ${fmtDuration(c.endTime - ctx.now)}`
      : phase === 'claiming' ? `Claims close in ${fmtDuration(c.claimDeadline - ctx.now)}`
        : PHASE_LABEL[phase]
  const seed = ctx.manifest.seeds.includes(c.id)
  return (
    <button type="button" className="card challenge-card challenge-link" onClick={() => ctx.go({ name: 'challenge', id: c.id })}>
      <header className="challenge-head">
        <div>
          <span className="chip-row">
            <span className={`tag ${c.isSeason ? 'tag--lime' : ''}`}>{c.isSeason ? 'Season' : 'Community'}</span>
            {seed && <span className="tag tag--outline">Demo seed</span>}
            {c.me.entry && <span className="tag tag--outline">{icon('check', 12)} Joined</span>}
          </span>
          <h3>{c.title}</h3>
        </div>
        <span className="challenge-pool"><small>Prefunded pool</small><strong>{fmtToken(c.pool, 18, { compact: true })} WIF</strong></span>
      </header>
      {goal !== null && (
        <div className="challenge-progress">
          <span className="progress"><i style={{ width: `${goal}%` }} /></span>
          <small>{fmtPoints(c.joinedPoints)} / {fmtPoints(c.goalPoints)} goal points joined</small>
        </div>
      )}
      <dl className="rows">
        <div><dt>{PHASE_LABEL[phase]}</dt><dd>{timing}</dd></div>
        <div><dt>Eligible</dt><dd>{symbols} · {TIERS[c.minTier].name}+ · ≥{c.minUnits} unit{c.minUnits === 1 ? '' : 's'}</dd></div>
        <div><dt>Participants</dt><dd>{c.participantCount} / {c.maxParticipants}</dd></div>
      </dl>
    </button>
  )
}

export function Explore({ ctx }: { ctx: Ctx }) {
  const [filter, setFilter] = useState<Filter>('live')
  const { snapshot, now } = ctx
  const challenges = useMemo(() => snapshot.challenges.filter((c) => {
    const p = phaseOf(c, now)
    if (filter === 'mine') return c.me.entry !== null || c.me.contribution > 0n
    if (filter === 'live') return p === 'open' || p === 'holding' || p === 'awaiting'
    return !(p === 'open' || p === 'holding' || p === 'awaiting')
  }), [snapshot.challenges, filter, now])
  const escrow = snapshot.challenges.reduce((s, c) => s + c.escrow, 0n)
  const live = snapshot.challenges.filter((c) => ['open', 'holding'].includes(phaseOf(c, now))).length

  return (
    <div className="view">
      <section className="card explore-hero">
        <small className="kicker">Conviction locking on Robinhood Chain {MODE === 'simulation' && <DemoTag />}</small>
        <h1 className="section-title">Lock the memes you already hold. Earn WIF from prefunded streams.</h1>
        <p className="figure-sub">
          Lock a supported community token straight from your wallet, choose how long you commit, and share the WIF that sponsors stream to that community.
          You never need WIF to lock. Rewards exist only where a sponsor funded them up front.
        </p>
        <div className="stat-grid">
          {snapshot.tokens.map((t) => (
            <div className="stat" key={t.address}><small>{t.symbol} locked</small><strong>{fmtToken(t.totalLocked, t.decimals, { compact: true })}</strong><span>{fmtToken(t.rateNow * 86_400n, 18, { compact: true })} WIF/day streaming</span></div>
          ))}
          <div className="stat"><small>WIF in challenge escrow</small><strong>{fmtToken(escrow, 18, { compact: true })}</strong><span>prefunded by sponsors</span></div>
          <div className="stat"><small>Live challenges</small><strong>{live}</strong><span>{snapshot.challenges.length} total</span></div>
        </div>
        <div className="action-row">
          <button type="button" className="btn btn--lime btn--lg" onClick={() => ctx.go({ name: 'lock' })}>{icon('lock')} Lock tokens</button>
          <button type="button" className="btn btn--ghost btn--lg" onClick={() => ctx.go({ name: 'create' })}>{icon('plus')} Create a challenge</button>
        </div>
      </section>

      {/* The demo side never reads a real wallet: real balances belong to the Live side only. */}
      {!ctx.demoSide && <HoldingsCard ctx={ctx} />}

      <section className="card">
        <header className="panel-head"><div><small className="kicker">Token communities · {ENV.whereShort}</small><h2>Tokens you can lock here</h2></div><DemoTag /></header>
        <ul className="token-list">
          {snapshot.tokens.map((t) => (
            <li key={t.address}>
              <button type="button" className="token-line" onClick={() => ctx.go({ name: 'token', address: t.address })}>
                <span className="token-mark">{t.symbol.slice(0, 1)}</span>
                <span className="token-line-copy"><strong>{t.symbol} <span className={`tag ${t.riskClass === 1 ? 'tag--lime' : 'tag--outline'}`}>{RISK_CLASS[t.riskClass]?.label}</span></strong><span>{t.releasedAt !== 0 ? 'Released: exits free, locks closed' : `${RISK_CLASS[t.riskClass]?.tiers} · ${fmtToken(t.rateNow * 86_400n, 18, { compact: true })} WIF/day`}</span></span>
                <span className="token-line-side"><strong>{fmtToken(t.totalLocked, t.decimals, { compact: true })}</strong><span>locked · {pct(t.totalLocked, t.cap)}% of cap</span></span>
              </button>
            </li>
          ))}
        </ul>
        <p className="fine-print">
          {MODE === 'testnet' ? 'These are valueless TEST tokens deployed for the testnet demo. They represent no real asset. ' : MODE === 'mainnet' ? 'These real tokens are listed in the Rixor Locker on Robinhood Chain mainnet after exact-address vetting (Class B: Flexible and Committed only, capped). ' : 'Demo data: these listings, amounts and rates exist only in the simulation on this device. Of these tokens, only HOOKR can be locked for real today, in the single-token contract under Live. '}
          {MODE === 'mainnet' ? 'Any further listing needs vetting, approval and a 48-hour on-chain timelock.' : 'On Robinhood Chain, a token becomes supported only after exact-address vetting, approval and a 48-hour on-chain timelock.'}
        </p>
      </section>

      <section className="challenges">
        <header className="panel-head">
          <div><small className="kicker">Challenges</small><h2>Hold together, share the pool <DemoTag /></h2></div>
          <button type="button" className="btn btn--dark btn--sm" onClick={() => ctx.go({ name: 'create' })}>{icon('plus', 16)} New</button>
        </header>
        <div className="seg seg--wrap" role="tablist" aria-label="Filter challenges">
          {(['live', 'ended', 'mine'] as Filter[]).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>
              {f === 'live' ? 'Live' : f === 'ended' ? 'Ended' : 'Mine'}
            </button>
          ))}
        </div>
        {challenges.length === 0 ? (
          <Empty title={filter === 'mine' ? 'No challenges joined or sponsored yet' : 'Nothing here yet'}>
            {filter === 'mine' ? 'Join a live challenge with a locked position, or sponsor one.' : 'Create the first one.'}
          </Empty>
        ) : (
          <div className="challenge-grid">{challenges.map((c) => <ChallengeRow key={c.id} ctx={ctx} c={c} />)}</div>
        )}
      </section>
    </div>
  )
}
