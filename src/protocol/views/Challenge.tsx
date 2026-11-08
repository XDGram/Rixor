import { useEffect, useMemo, useState } from 'react'
import { zeroPadValue, toBeHex } from 'ethers'
import { icon } from '../../ui'
import { challengesIface, contractsFor } from '../chain'
import { TxNotice } from '../components'
import type { Ctx } from '../ctx'
import { fmtDate, fmtDuration, fmtPoints, fmtToken, MAX_POOL, MIN_SPONSOR, parseAmount, pct, phaseOf, PHASE_LABEL, TIERS, type Challenge } from '../model'
import { loadStandings, type Standing } from '../useProtocol'

type Sponsor = { address: string; amount: bigint }

function useDetail(ctx: Ctx, c: Challenge | undefined) {
  const [standings, setStandings] = useState<Standing[] | null>(null)
  const [sponsors, setSponsors] = useState<Sponsor[]>([])
  const [previews, setPreviews] = useState<Record<number, bigint>>({})
  const stamp = ctx.snapshot.loadedAt
  useEffect(() => {
    if (!c) return
    let live = true
    const read = contractsFor(ctx.manifest, ctx.provider)
    void (async () => {
      try {
        const rows = await loadStandings(ctx.manifest, ctx.provider, c)
        const idTopic = zeroPadValue(toBeHex(c.id), 32)
        const logs = await ctx.provider.getLogs({
          address: ctx.manifest.contracts.challenges,
          topics: [[challengesIface.getEvent('ChallengeCreated')!.topicHash, challengesIface.getEvent('Sponsored')!.topicHash], idTopic],
          fromBlock: ctx.manifest.startBlock,
        })
        const totals = new Map<string, bigint>()
        for (const l of logs) {
          const ev = challengesIface.parseLog(l)
          if (!ev) continue
          const who = ev.name === 'ChallengeCreated' ? ev.args.creator : ev.args.sponsor
          const amt = ev.name === 'ChallengeCreated' ? ev.args.pool : ev.args.amount
          totals.set(who, (totals.get(who) ?? 0n) + amt)
        }
        const mine: Record<number, bigint> = {}
        for (const p of ctx.snapshot.positions.filter((x) => x.closedAt === 0)) {
          mine[p.id] = (await read.challenges.previewPoints(c.id, p.id)) as bigint
        }
        if (!live) return
        setStandings(rows)
        setSponsors([...totals.entries()].map(([address, amount]) => ({ address, amount })).sort((a, b) => (b.amount > a.amount ? 1 : -1)))
        setPreviews(mine)
      } catch {
        if (live) setStandings([])
      }
    })()
    return () => { live = false }
  }, [ctx.manifest, ctx.provider, c?.id, stamp]) // eslint-disable-line react-hooks/exhaustive-deps
  return { standings, sponsors, previews }
}

export function ChallengeView({ ctx, id }: { ctx: Ctx; id: number }) {
  const c = ctx.snapshot.challenges.find((x) => x.id === id)
  const { standings, sponsors, previews } = useDetail(ctx, c)
  const [positionId, setPositionId] = useState<number | ''>('')
  const [sponsorText, setSponsorText] = useState('')
  const { now, write, wallet, tx } = ctx

  const eligible = useMemo(() => {
    if (!c) return []
    return ctx.snapshot.positions.filter((p) => p.closedAt === 0).map((p) => {
      const tokenOk = c.tokens.some((t) => t.toLowerCase() === p.token.toLowerCase())
      const lane = ctx.snapshot.challenges.find((o) => o.id !== c.id && o.isSeason === c.isSeason && o.me.entry?.positionId === p.id && o.endTime > now)
      let reason: string | null = null
      if (!tokenOk) reason = 'token not allowed'
      else if (p.tier < c.minTier) reason = `needs ${TIERS[c.minTier].name}+`
      else if (p.tier !== 0 && p.endsAt < c.endTime) reason = 'term ends before the challenge'
      else if ((previews[p.id] ?? 1n) === 0n) reason = `below ${c.minUnits} unit${c.minUnits === 1 ? '' : 's'}`
      else if (lane) reason = `already in “${lane.title}”`
      return { p, reason, points: previews[p.id] ?? null }
    })
  }, [c, ctx.snapshot.positions, ctx.snapshot.challenges, previews, now])

  if (!c) return <div className="view"><div className="notice notice--warn"><strong>Challenge not found</strong><span>It may not exist on this demo chain.</span></div></div>

  const phase = phaseOf(c, now)
  const symbols = c.tokens.map((t) => ctx.snapshot.tokens.find((x) => x.address.toLowerCase() === t.toLowerCase())?.symbol ?? '?').join(' + ')
  const projected = standings ? standings.filter((s) => s.status === 'holding' || s.status === 'qualified').reduce((s, r) => s + r.points, 0n) : null
  const goalBase = c.settled ? c.qualifiedPoints : (projected ?? c.joinedPoints)
  const goalPct = c.goalPoints > 0n ? Math.min(100, pct(goalBase, c.goalPoints)) : null
  const myEntry = c.me.entry
  const myStanding = standings?.find((s) => ctx.label(s.address) === 'You')
  const myShareIfNow = myEntry && projected && projected > 0n && myStanding?.status === 'holding' ? (c.pool * myEntry.points) / projected : null
  const sponsorAmount = parseAmount(sponsorText)
  const sponsorProblem = sponsorAmount === null ? null
    : sponsorAmount < MIN_SPONSOR ? 'Minimum sponsorship is 10,000 WIF.'
      : c.pool + sponsorAmount > MAX_POOL ? `The pool cannot exceed 10,000,000 WIF (room for ${fmtToken(MAX_POOL - c.pool)}).`
        : wallet && sponsorAmount > (ctx.snapshot.tokens[0]?.balance ?? 0n) ? 'More than this wallet holds.' : null
  const blocked = ctx.snapshot.paused || ctx.snapshot.emergencyAt !== 0
  const canSponsor = (phase === 'open' || phase === 'holding') && !blocked
  const sweepEstimate = c.pool > 0n ? (c.escrow * c.me.contribution) / c.pool : 0n

  const act = (key: string, label: string, done: string, send: () => Promise<never>) => tx.run(key, [{ label, send }], done)
  const join = async () => {
    if (!write || positionId === '') return
    const ok = await act('join', `Join with position #${positionId}`, `Joined “${c.title}”`, () => write.challenges.join(c.id, positionId, '0x0000000000000000000000000000000000000000') as Promise<never>)
    if (ok) setPositionId('')
  }
  const sponsor = async () => {
    if (!write || !sponsorAmount) return
    const steps = []
    const wif = ctx.snapshot.tokens.find((t) => t.address.toLowerCase() === ctx.manifest.contracts.wif.toLowerCase())
    if ((wif?.allowanceChallenges ?? 0n) < sponsorAmount) steps.push({ label: `Approve ${fmtToken(sponsorAmount)} WIF`, send: () => write.wif.approve(ctx.manifest.contracts.challenges, sponsorAmount) })
    steps.push({ label: `Sponsor ${fmtToken(sponsorAmount)} WIF`, send: () => write.challenges.sponsor(c.id, sponsorAmount) })
    const ok = await tx.run('sponsor', steps, `Added ${fmtToken(sponsorAmount)} WIF to the pool`)
    if (ok) setSponsorText('')
  }

  return (
    <div className="view">
      <button type="button" className="back-btn" onClick={() => ctx.go({ name: 'explore' })}>{icon('arrowLeft', 16)} All challenges</button>
      <section className="card challenge-card">
        <header className="challenge-head">
          <div>
            <span className="chip-row">
              <span className={`tag ${c.isSeason ? 'tag--lime' : ''}`}>{c.isSeason ? 'Season' : 'Community'}</span>
              {ctx.manifest.seeds.includes(c.id) && <span className="tag tag--outline">Demo seed</span>}
              <span className="tag tag--outline">#{c.id}</span>
            </span>
            <h3>{c.title}</h3>
          </div>
          <span className="challenge-pool"><small>Prefunded pool</small><strong>{fmtToken(c.pool, 18, { compact: true })} WIF</strong></span>
        </header>
        {ctx.snapshot.descriptions[c.id] && <p className="challenge-goal">{ctx.snapshot.descriptions[c.id]}</p>}
        {goalPct !== null && (
          <div className="challenge-progress">
            <span className="progress"><i style={{ width: `${goalPct}%` }} /></span>
            <small>{fmtPoints(goalBase)} / {fmtPoints(c.goalPoints)} goal points {c.settled ? 'qualified' : 'still holding'}</small>
          </div>
        )}
        <dl className="rows">
          <div><dt>Status</dt><dd>{PHASE_LABEL[phase]}</dd></div>
          <div><dt>Join window</dt><dd>{phase === 'open' ? `closes in ${fmtDuration(c.joinDeadline - now)}` : `closed ${fmtDate(c.joinDeadline)}`}</dd></div>
          <div><dt>Ends</dt><dd>{c.endTime > now ? `in ${fmtDuration(c.endTime - now)}` : fmtDate(c.endTime)}</dd></div>
          <div><dt>Eligible positions</dt><dd>{symbols} · {TIERS[c.minTier].name}+ · ≥{c.minUnits} unit{c.minUnits === 1 ? '' : 's'}</dd></div>
          <div><dt>Participants</dt><dd>{c.participantCount} / {c.maxParticipants}{c.settled ? ` · ${c.qualifiedCount} qualified` : ''}</dd></div>
          <div><dt>Escrow remaining</dt><dd>{fmtToken(c.escrow)} WIF</dd></div>
          {c.settled && c.success && <div><dt>Claim window</dt><dd>{phase === 'claiming' ? `closes in ${fmtDuration(c.claimDeadline - now)}` : `closed ${fmtDate(c.claimDeadline)}`}</dd></div>}
        </dl>
        <p className="fine-print">
          Qualify by keeping the joined position open until the end. Rewards are split pro-rata by points among qualifiers.
          If nobody qualifies or the goal is missed, sponsors get their WIF back. Unclaimed rewards return to sponsors after 30 days.
        </p>
      </section>

      {/* ---------------------------------------------------------------- my actions */}
      <section className="card">
        <header className="panel-head"><div><small className="kicker">Your part</small><h2>{myEntry ? 'You are in' : c.me.contribution > 0n ? 'You sponsor this' : 'Take part'}</h2></div></header>
        {!wallet && <button type="button" className="btn btn--lime btn--block" onClick={ctx.openWallet}>Connect demo wallet</button>}
        {/* One stable place for this challenge's transaction status: the action that started it may disappear
            once the chain state changes (for example, the join form after joining). */}
        {['join', 'sponsor', 'settle', 'claim', 'refund', 'sweep'].map((k) => <TxNotice key={k} tx={tx.tx} for={k} />)}

        {wallet && myEntry && (
          <dl className="rows">
            <div><dt>Position</dt><dd>#{myEntry.positionId}</dd></div>
            <div><dt>Your points</dt><dd>{fmtPoints(myEntry.points)}</dd></div>
            <div><dt>Standing</dt><dd>{c.settled ? (myEntry.qualified ? 'Qualified' : 'Not qualified') : myStanding?.status === 'exited-early' ? 'Exited early: not qualifying' : 'Holding'}</dd></div>
            {myShareIfNow !== null && <div><dt>Share if everyone holding qualifies</dt><dd>≈ {fmtToken(myShareIfNow)} WIF</dd></div>}
            {c.me.claimable > 0n && <div><dt>Claimable now</dt><dd>{fmtToken(c.me.claimable)} WIF</dd></div>}
            {myEntry.claimed && <div><dt>Reward</dt><dd>Claimed</dd></div>}
          </dl>
        )}

        {wallet && phase === 'open' && !myEntry && !blocked && (
          <div className="sheet-section">
            {eligible.length === 0 ? (
              <div className="empty empty--action">
                <div><strong>No open position</strong><span>Lock {symbols} first, then come back to join.</span></div>
                <button type="button" className="btn btn--lime btn--sm" onClick={() => ctx.go({ name: 'lock' })}>Lock</button>
              </div>
            ) : (
              <>
                <small className="kicker">Choose a position</small>
                <ul className="choice-list">
                  {eligible.map(({ p, reason, points }) => (
                    <li key={p.id}>
                      <button type="button" disabled={reason !== null} className={`choice ${positionId === p.id ? 'is-active' : ''}`} onClick={() => setPositionId(p.id)} aria-pressed={positionId === p.id}>
                        <span><strong>#{p.id} · {TIERS[p.tier].name}</strong><small>{fmtToken(p.amount)} {ctx.snapshot.tokens[0]?.symbol}</small></span>
                        <span>{reason ? <small className="is-loss">{reason}</small> : <strong>{points !== null ? `${fmtPoints(points)} pts` : '…'}</strong>}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                                <button type="button" className="btn btn--lime btn--block" disabled={positionId === '' || tx.busy || !write} onClick={() => void join()}>Join challenge</button>
              </>
            )}
          </div>
        )}

        {wallet && phase === 'awaiting' && (
          <div className="sheet-section">
            <p className="fine-print">The challenge has ended. Anyone can settle it; qualification is read from each position's on-chain exit time, so who settles cannot change the result.</p>
            {c.settleCursor > 0 && <small className="kicker">{c.settleCursor} / {c.participantCount} processed</small>}
                        <button type="button" className="btn btn--dark btn--block" disabled={tx.busy || !write} onClick={() => void act('settle', 'Settle challenge', 'Challenge settled', () => write!.challenges.settle(c.id, 200) as Promise<never>)}>Settle challenge</button>
          </div>
        )}

        {wallet && phase === 'claiming' && c.me.claimable > 0n && (
          <div className="sheet-section">
                        <button type="button" className="btn btn--lime btn--block btn--lg" disabled={tx.busy || !write} onClick={() => void act('claim', 'Claim reward', `Claimed ${fmtToken(c.me.claimable)} WIF`, () => write!.challenges.claim(c.id) as Promise<never>)}>Claim {fmtToken(c.me.claimable)} WIF</button>
          </div>
        )}

        {wallet && (phase === 'failed' || phase === 'cancelled') && c.me.contribution > 0n && (
          <div className="sheet-section">
            {c.me.refunded ? <span className="tag tag--lime">{icon('check', 12)} Contribution refunded</span> : (
              <>
                                <button type="button" className="btn btn--lime btn--block" disabled={tx.busy || !write} onClick={() => void act('refund', 'Request refund', `Refunded ${fmtToken(c.me.contribution)} WIF`, () => write!.challenges.refund(c.id) as Promise<never>)}>Refund my {fmtToken(c.me.contribution)} WIF</button>
              </>
            )}
          </div>
        )}

        {wallet && phase === 'sweeping' && c.me.contribution > 0n && (
          <div className="sheet-section">
            {c.me.swept ? <span className="tag tag--lime">{icon('check', 12)} Unclaimed share returned</span> : (
              <>
                                <button type="button" className="btn btn--dark btn--block" disabled={tx.busy || !write} onClick={() => void act('sweep', 'Return unclaimed share', 'Unclaimed share returned', () => write!.challenges.sweep(c.id) as Promise<never>)}>Return my unclaimed share (≈ {fmtToken(sweepEstimate)} WIF)</button>
              </>
            )}
          </div>
        )}

        {wallet && canSponsor && (
          <div className="sheet-section">
            <small className="kicker">Sponsor this challenge with WIF</small>
            <div className={`amount-input amount-input--sm ${sponsorProblem ? 'is-error' : ''}`}>
              <input inputMode="decimal" autoComplete="off" placeholder="10,000 minimum" value={sponsorText} onChange={(e) => setSponsorText(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Sponsorship amount" />
              <span>WIF</span>
            </div>
            {sponsorProblem && <div className="field-error">{sponsorProblem}</div>}
            <p className="fine-print">Your WIF joins this challenge's escrow. You get it back only if the challenge fails or is cancelled; after a successful challenge, only unclaimed rewards return pro-rata. Sponsoring earns nothing.</p>
                        <button type="button" className="btn btn--ghost btn--block" disabled={!sponsorAmount || Boolean(sponsorProblem) || tx.busy || !write} onClick={() => void sponsor()}>Sponsor</button>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- standings */}
      <section className="card">
        <header className="panel-head"><div><small className="kicker">Rankings</small><h2>Participants by points</h2></div></header>
        {standings === null ? <p className="fine-print">Loading standings…</p> : standings.length === 0 ? <p className="fine-print">No participants yet.</p> : (
          <ol className="board">
            {standings.map((s, i) => (
              <li key={s.address} className={ctx.label(s.address) === 'You' ? 'is-me' : ''}>
                <span className="board-rank">{i + 1}</span>
                <span>{ctx.label(s.address)} <small className="board-note">{s.status === 'holding' ? 'holding' : s.status === 'qualified' ? 'qualified' : s.status === 'exited-early' ? 'exited early' : 'not qualified'}</small></span>
                <strong>{fmtPoints(s.points)}</strong>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card">
        <header className="panel-head"><div><small className="kicker">Sponsors</small><h2>Who funded the pool</h2></div></header>
        <ol className="board board--compact">
          {sponsors.map((s, i) => (
            <li key={s.address}><span className="board-rank">{i + 1}</span><span>{ctx.label(s.address)}</span><strong>{fmtToken(s.amount, 18, { compact: true })} WIF</strong></li>
          ))}
        </ol>
        <dl className="rows">
          <div><dt>Claimed</dt><dd>{fmtToken(c.claimedTotal, 18, { compact: true })} WIF</dd></div>
          <div><dt>Refunded</dt><dd>{fmtToken(c.refundedTotal, 18, { compact: true })} WIF</dd></div>
          <div><dt>Returned unclaimed</dt><dd>{fmtToken(c.sweptTotal, 18, { compact: true })} WIF</dd></div>
        </dl>
      </section>
    </div>
  )
}
