import { useMemo, useState } from 'react'
import { contractsFor } from '../chain'
import { TxNotice } from '../components'
import type { Ctx } from '../ctx'
import { fmtDate, fmtDuration, fmtPoints, fmtToken, MAX_DURATION, MAX_POOL, MIN_POOL, parseAmount, TIERS } from '../model'

const H = 3600
const D = 86400

export function CreateView({ ctx }: { ctx: Ctx }) {
  const { snapshot, wallet, write, tx, manifest } = ctx
  const minHold = manifest.params.minHoldSeconds
  const wif = snapshot.tokens.find((t) => t.address.toLowerCase() === manifest.contracts.wif.toLowerCase())
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [minTier, setMinTier] = useState(0)
  const [minUnits, setMinUnits] = useState(1)
  const [maxParticipants, setMaxParticipants] = useState('200')
  const [joinWindow, setJoinWindow] = useState(D)
  const [hold, setHold] = useState(Math.max(minHold, D))
  const [goal, setGoal] = useState(0n)
  const [poolText, setPoolText] = useState('100000')
  const [createdId, setCreatedId] = useState<number | null>(null)

  const joinOptions = [H, 6 * H, D, 3 * D]
  const holdOptions = [...new Set([minHold, D, 3 * D, 7 * D, 14 * D])].filter((h) => h >= minHold).sort((a, b) => a - b)
  const pool = parseAmount(poolText)
  const maxP = Number(maxParticipants)
  const enc = new TextEncoder()

  const problems = useMemo(() => {
    const out: string[] = []
    const tb = enc.encode(title.trim()).length
    if (tb === 0) out.push('Add a title.')
    if (tb > 80) out.push('Title is limited to 80 bytes.')
    if (enc.encode(description).length > 2000) out.push('Description is limited to 2,000 bytes.')
    if (!Number.isInteger(maxP) || maxP < 1 || maxP > 200) out.push('Participants must be between 1 and 200.')
    if (joinWindow + hold > MAX_DURATION) out.push('A challenge can last at most 30 days.')
    if (pool === null) out.push('Enter a pool amount.')
    else if (pool < MIN_POOL) out.push('The minimum pool is 100,000 WIF.')
    else if (pool > MAX_POOL) out.push('The maximum pool is 10,000,000 WIF.')
    else if (wallet && wif && pool > wif.balance) out.push('That is more fork WIF than this wallet holds.')
    return out
  }, [title, description, maxP, joinWindow, hold, pool, wallet, wif]) // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = snapshot.paused || snapshot.emergencyAt !== 0
  const joinDeadline = ctx.now + joinWindow
  const endTime = joinDeadline + hold
  // Points for one maximum entry under these rules, for orienting the goal.
  const maxEntry = BigInt(10 * TIERS[2].multiplierBps) * BigInt(wif?.multiplierBps ?? 10_000) / 10_000n

  const submit = async () => {
    if (!write || !pool || !wif) return
    // Deadlines are measured from the demo chain's clock, which can differ from wall-clock time.
    const chainNow = ctx.now
    const params = {
      tokens: [wif.address], minTier, minUnitsPerEntry: minUnits, joinDeadline: chainNow + joinWindow, endTime: chainNow + joinWindow + hold,
      goalPoints: goal, maxParticipants: maxP, title: title.trim(), description: description.trim(),
    }
    const steps = []
    if (wif.allowanceChallenges < pool) steps.push({ label: `Approve ${fmtToken(pool)} WIF`, send: () => write.wif.approve(manifest.contracts.challenges, pool) })
    const nextId = Number(await contractsFor(manifest, ctx.provider).challenges.nextChallengeId())
    steps.push({ label: `Create “${params.title}” with ${fmtToken(pool)} WIF`, send: () => write.challenges.createChallenge(params, pool) })
    const ok = await tx.run('create', steps, `Challenge created with ${fmtToken(pool)} WIF escrowed`)
    if (ok) setCreatedId(nextId)
  }

  if (!wallet) {
    return <div className="view"><section className="card"><header className="panel-head"><div><small className="kicker">New challenge</small><h2>Create a challenge</h2></div></header><button type="button" className="btn btn--lime btn--block" onClick={ctx.openWallet}>Connect demo wallet</button></section></div>
  }

  return (
    <div className="view">
      <section className="card lock-card">
        <header className="panel-head"><div><small className="kicker">New community challenge</small><h2>Create and fund a challenge</h2></div></header>

        <label className="field"><span>Title</span><input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Hold the line" /></label>
        <label className="field"><span>Description <small>(optional)</small></span><textarea value={description} rows={3} maxLength={2000} onChange={(e) => setDescription(e.target.value)} placeholder="What participants commit to, in plain words." /></label>

        <div className="commit-field">
          <span>Minimum tier</span>
          <div className="chip-row">{TIERS.map((t) => <button key={t.id} type="button" className={`chip ${minTier === t.id ? 'is-active' : ''}`} onClick={() => setMinTier(t.id)}>{t.name}+</button>)}</div>
        </div>
        <div className="commit-field">
          <span>Minimum units per entry</span>
          <div className="chip-row">{[1, 2, 3, 5, 10].map((u) => <button key={u} type="button" className={`chip ${minUnits === u ? 'is-active' : ''}`} onClick={() => setMinUnits(u)}>{u}</button>)}</div>
        </div>
        <div className="commit-field">
          <span>Join window</span>
          <div className="chip-row">{joinOptions.map((s) => <button key={s} type="button" className={`chip ${joinWindow === s ? 'is-active' : ''}`} onClick={() => setJoinWindow(s)}>{fmtDuration(s)}</button>)}</div>
        </div>
        <div className="commit-field">
          <span>Holding period after the join window</span>
          <div className="chip-row">{holdOptions.map((s) => <button key={s} type="button" className={`chip ${hold === s ? 'is-active' : ''}`} onClick={() => setHold(s)}>{fmtDuration(s)}{s === minHold ? ' (min)' : ''}</button>)}</div>
        </div>
        <div className="commit-field">
          <span>Collective goal <small>(points that must still be holding at the end)</small></span>
          <div className="chip-row">{[0n, maxEntry, maxEntry * 5n, maxEntry * 20n].map((g) => <button key={String(g)} type="button" className={`chip ${goal === g ? 'is-active' : ''}`} onClick={() => setGoal(g)}>{g === 0n ? 'None' : `${fmtPoints(g)} pts`}</button>)}</div>
        </div>
        <label className="field"><span>Maximum participants</span><input inputMode="numeric" value={maxParticipants} onChange={(e) => setMaxParticipants(e.target.value.replace(/[^0-9]/g, ''))} /></label>

        <div className="amount-field">
          <div className="amount-field-head"><label htmlFor="pool">WIF pool (escrowed now)</label><span>{fmtToken(wif?.balance ?? 0n)} fork WIF available</span></div>
          <div className="amount-input"><input id="pool" inputMode="decimal" value={poolText} onChange={(e) => setPoolText(e.target.value.replace(/[^0-9.]/g, ''))} /><span>WIF</span></div>
        </div>

        <dl className="rows">
          <div><dt>Eligible token</dt><dd>{wif?.symbol} (pilot scope)</dd></div>
          <div><dt>Joining closes</dt><dd>{fmtDate(joinDeadline)}</dd></div>
          <div><dt>Ends</dt><dd>{fmtDate(endTime)}</dd></div>
          <div><dt>If it succeeds</dt><dd>Pool split by points among qualifiers</dd></div>
          <div><dt>If it fails</dt><dd>Your WIF is refunded</dd></div>
          <div><dt>Unclaimed after 30 days</dt><dd>Returned to sponsors pro-rata</dd></div>
        </dl>
        <p className="fine-print">Creating a challenge escrows your WIF in the challenge contract immediately. No one, including the protocol, can withdraw it except through claims, refunds or the unclaimed-reward return. Do not describe pools as yield or guaranteed returns.</p>

        {problems.length > 0 && <div className="notice notice--warn"><strong>Check the form</strong><span>{problems.join(' ')}</span></div>}
        {blocked && <div className="notice notice--warn"><strong>Unavailable</strong><span>The protocol is paused or in emergency mode.</span></div>}
        <TxNotice tx={tx.tx} for="create" />
        {createdId !== null && tx.tx?.key === 'create' && tx.tx.status === 'confirmed' ? (
          <button type="button" className="btn btn--dark btn--block btn--lg" onClick={() => ctx.go({ name: 'challenge', id: createdId })}>Open the new challenge</button>
        ) : (
          <button type="button" className="btn btn--lime btn--block btn--lg" disabled={problems.length > 0 || blocked || tx.busy || !write} onClick={() => void submit()}>Create and escrow {pool ? fmtToken(pool, 18, { compact: true }) : ''} WIF</button>
        )}
      </section>
    </div>
  )
}
