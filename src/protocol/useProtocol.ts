import { useCallback, useEffect, useRef, useState } from 'react'
import { Contract, type JsonRpcProvider, type Log } from 'ethers'
import { challengesIface, contractsFor, ERC20_ABI, lockerIface } from './chain'
import { fetchHealth, type Health, type Manifest } from './env'
import type { Challenge, Entry, Position, TokenInfo } from './model'

export type ActivityItem = {
  key: string
  kind: 'Locked' | 'Exited' | 'ChallengeCreated' | 'Sponsored' | 'Joined' | 'Settled' | 'Claimed' | 'Refunded' | 'Swept'
  block: number
  tx: string
  actor: string
  challengeId?: number
  positionId?: number
  amount?: bigint
  fee?: bigint
  tier?: number
  points?: bigint
  success?: boolean
  title?: string
  timestamp?: number
}

export type Snapshot = {
  health: Health
  loadedAt: number
  paused: boolean
  emergencyAt: number
  tokens: TokenInfo[]
  ethBalance: bigint
  positions: Position[]
  challenges: Challenge[]
  activity: ActivityItem[]
  descriptions: Record<number, string>
}

const ZERO = '0x0000000000000000000000000000000000000000'
const n = (v: unknown) => Number(v as bigint)

function toEntry(e: { positionId: bigint; points: bigint; qualified: boolean; claimed: boolean }): Entry | null {
  if (!e || e.positionId === 0n) return null
  return { positionId: Number(e.positionId), points: e.points, qualified: e.qualified, claimed: e.claimed }
}

function parseActivity(logs: Log[], manifest: Manifest): { items: ActivityItem[]; descriptions: Record<number, string> } {
  const items: ActivityItem[] = []
  const descriptions: Record<number, string> = {}
  for (const log of logs) {
    const isLocker = log.address.toLowerCase() === manifest.contracts.locker.toLowerCase()
    let parsed
    try { parsed = (isLocker ? lockerIface : challengesIface).parseLog(log) } catch { continue }
    if (!parsed) continue
    const a = parsed.args
    const base = { key: `${log.transactionHash}:${log.index}`, block: log.blockNumber, tx: log.transactionHash }
    switch (parsed.name) {
      case 'Locked': items.push({ ...base, kind: 'Locked', actor: a.owner, positionId: n(a.positionId), amount: a.amount, tier: n(a.tier) }); break
      case 'Exited': items.push({ ...base, kind: 'Exited', actor: a.owner, positionId: n(a.positionId), amount: a.amountReturned, fee: a.fee }); break
      case 'ChallengeCreated':
        descriptions[n(a.id)] = a.description
        items.push({ ...base, kind: 'ChallengeCreated', actor: a.creator, challengeId: n(a.id), amount: a.pool, title: a.title, success: a.isSeason })
        break
      case 'Sponsored': items.push({ ...base, kind: 'Sponsored', actor: a.sponsor, challengeId: n(a.id), amount: a.amount }); break
      case 'Joined': items.push({ ...base, kind: 'Joined', actor: a.participant, challengeId: n(a.id), positionId: n(a.positionId), points: a.points }); break
      case 'Settled': items.push({ ...base, kind: 'Settled', actor: ZERO, challengeId: n(a.id), success: a.success, points: a.qualifiedPoints }); break
      case 'Claimed': items.push({ ...base, kind: 'Claimed', actor: a.participant, challengeId: n(a.id), amount: a.amount }); break
      case 'Refunded': items.push({ ...base, kind: 'Refunded', actor: a.sponsor, challengeId: n(a.id), amount: a.amount }); break
      case 'Swept': items.push({ ...base, kind: 'Swept', actor: a.sponsor, challengeId: n(a.id), amount: a.amount }); break
      default: break
    }
  }
  return { items: items.reverse(), descriptions }
}

export async function loadSnapshot(backend: string, manifest: Manifest, provider: JsonRpcProvider, account: string | null): Promise<Snapshot> {
  const { locker, challenges } = contractsFor(manifest, provider)
  const me = account ?? ZERO
  const [health, paused, emergencyAt, listed, nextId, ethBalance, positionIds] = await Promise.all([
    fetchHealth(backend),
    locker.paused() as Promise<boolean>,
    locker.emergencyActivatedAt() as Promise<bigint>,
    locker.listedTokens() as Promise<string[]>,
    challenges.nextChallengeId() as Promise<bigint>,
    account ? provider.getBalance(account) : Promise.resolve(0n),
    account ? (locker.positionsOf(account) as Promise<bigint[]>) : Promise.resolve([] as bigint[]),
  ])

  const tokens: TokenInfo[] = await Promise.all(listed.map(async (address) => {
    const erc = new Contract(address, ERC20_ABI, provider)
    const [cfg, mult, symbol, balance, allowanceLocker, allowanceChallenges] = await Promise.all([
      locker.tokenConfig(address),
      locker.tokenMultiplierBps(address) as Promise<bigint>,
      erc.symbol() as Promise<string>,
      account ? (erc.balanceOf(account) as Promise<bigint>) : Promise.resolve(0n),
      account ? (erc.allowance(account, manifest.contracts.locker) as Promise<bigint>) : Promise.resolve(0n),
      account ? (erc.allowance(account, manifest.contracts.challenges) as Promise<bigint>) : Promise.resolve(0n),
    ])
    return {
      address, symbol, decimals: Number(cfg.decimals), unit: cfg.unitAmount, cap: cfg.maxTotalLocked, totalLocked: cfg.totalLocked,
      locksEnabled: cfg.locksEnabled, multiplierBps: Number(mult), balance, allowanceLocker, allowanceChallenges,
    }
  }))

  const positions: Position[] = await Promise.all(positionIds.map(async (idRaw) => {
    const [p, terms] = await Promise.all([locker.positionOf(idRaw), locker.exitTerms(idRaw)])
    return {
      id: Number(idRaw), owner: p.owner, token: p.token, tier: Number(p.tier), startedAt: Number(p.startedAt),
      endsAt: Number(p.endsAt), closedAt: Number(p.closedAt), amount: p.amount, exitAllowed: terms[0], feeBps: Number(terms[1]),
    }
  }))
  positions.sort((a, b) => b.id - a.id)

  const ids = Array.from({ length: Math.max(0, Number(nextId) - 1) }, (_, i) => i + 1)
  const list: Challenge[] = await Promise.all(ids.map(async (id) => {
    const [c, toks, cancelled, entry, contribution, refunded, swept, claimable] = await Promise.all([
      challenges.getChallenge(id), challenges.challengeTokens(id) as Promise<string[]>, challenges.isCancelled(id) as Promise<boolean>,
      challenges.entryOf(id, me), challenges.contributionOf(id, me) as Promise<bigint>, challenges.refunded(id, me) as Promise<boolean>,
      challenges.swept(id, me) as Promise<boolean>, challenges.claimable(id, me) as Promise<bigint>,
    ])
    return {
      id, creator: c.creator, isSeason: c.isSeason, minTier: Number(c.minTier), minUnits: Number(c.minUnitsPerEntry),
      maxParticipants: Number(c.maxParticipants), joinDeadline: Number(c.joinDeadline), endTime: Number(c.endTime),
      claimDeadline: Number(c.claimDeadline), settled: c.settled, success: c.success, participantCount: Number(c.participantCount),
      settleCursor: Number(c.settleCursor), qualifiedCount: Number(c.qualifiedCount), goalPoints: c.goalPoints, pool: c.pool,
      escrow: c.escrow, joinedPoints: c.joinedPoints, qualifiedPoints: c.qualifiedPoints, claimedTotal: c.claimedTotal,
      refundedTotal: c.refundedTotal, sweptTotal: c.sweptTotal, title: c.title, tokens: toks, cancelled,
      me: { entry: toEntry(entry), contribution, refunded, swept, claimable },
    }
  }))
  list.sort((a, b) => b.id - a.id)

  const logs = await provider.getLogs({ address: [manifest.contracts.locker, manifest.contracts.challenges], fromBlock: manifest.startBlock, toBlock: 'latest' })
  const { items, descriptions } = parseActivity(logs, manifest)
  const recent = items.slice(0, 60)
  const blocks = [...new Set(recent.map((i) => i.block))]
  const times = await Promise.all(blocks.map((b) => provider.getBlock(b).then((blk) => [b, blk?.timestamp ?? 0] as const)))
  const tsByBlock = new Map(times)
  for (const i of recent) i.timestamp = tsByBlock.get(i.block)

  return { health, loadedAt: Date.now(), paused, emergencyAt: Number(emergencyAt), tokens, ethBalance, positions, challenges: list, activity: recent, descriptions }
}

export function useProtocol(backend: string | null, manifest: Manifest | null, provider: JsonRpcProvider | null, account: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    if (!backend || !manifest || !provider) return
    const mine = ++seq.current
    setLoading(true)
    try {
      const snap = await loadSnapshot(backend, manifest, provider, account)
      if (mine === seq.current) { setSnapshot(snap); setError(null) }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [backend, manifest, provider, account])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 12_000)
    return () => window.clearInterval(id)
  }, [refresh])

  return { snapshot, error, loading, refresh }
}

/** Live chain clock: the backend's chainNow plus wall time elapsed since it was read. */
export function useChainNow(snapshot: Snapshot | null) {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  if (!snapshot) return Math.floor(tick / 1000)
  return snapshot.health.chainNow + Math.floor((tick - snapshot.loadedAt) / 1000)
}

export type Standing = {
  address: string
  positionId: number
  points: bigint
  status: 'holding' | 'qualified' | 'exited-early' | 'disqualified'
  closedAt: number
}

/** Leaderboard for one challenge: every participant, their points and whether their position still counts. */
export async function loadStandings(manifest: Manifest, provider: JsonRpcProvider, c: Challenge): Promise<Standing[]> {
  const { locker, challenges } = contractsFor(manifest, provider)
  const addrs = (await challenges.participants(c.id, 0, 200)) as string[]
  const rows = await Promise.all(addrs.map(async (address) => {
    const e = await challenges.entryOf(c.id, address)
    const p = await locker.positionOf(e.positionId)
    const closedAt = Number(p.closedAt)
    const counts = closedAt === 0 || closedAt >= c.endTime
    let status: Standing['status']
    if (c.settled) status = e.qualified ? 'qualified' : 'disqualified'
    else status = counts ? 'holding' : 'exited-early'
    return { address, positionId: Number(e.positionId), points: e.points as bigint, status, closedAt }
  }))
  return rows.sort((a, b) => (b.points > a.points ? 1 : b.points < a.points ? -1 : 0))
}
