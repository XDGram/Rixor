// Shared model for the conviction vault. Mirrors RixorConvictionVault so the simulation and
// the onchain reader produce identical shapes and identical exit rules.

export type Tier = 0 | 1 | 2
export type VaultMode = 'onchain' | 'simulation'

export const EXIT = {
  Locked: 0,
  EarlyWithFee: 1,
  FlexWindowPassed: 2,
  TermEnded: 3,
  TargetReached: 4,
  StopLoss: 5,
  OracleStale: 6,
} as const
export type ExitReason = (typeof EXIT)[keyof typeof EXIT]

export const DAY = 86_400
export const FLEX_WINDOW = 7 * DAY
export const ORACLE_ESCAPE = 7 * DAY
export const CLAIM_WINDOW = 3 * DAY

export const TIERS = [
  {
    id: 0 as Tier,
    name: 'Flexible',
    short: '1x',
    weightBps: 10_000,
    maxFeeBps: 100,
    summary: 'Exit any time. Up to 1% fee in the first 7 days.',
    commitment: 'No target needed',
  },
  {
    id: 1 as Tier,
    name: 'Committed',
    short: '1.5x',
    weightBps: 15_000,
    maxFeeBps: 1_000,
    summary: 'Set an ROI target. Leaving before it or the term ends costs up to 10%.',
    commitment: 'ROI target, 30-365 day term, optional max loss',
  },
  {
    id: 2 as Tier,
    name: 'Diamond Hands',
    short: '3x',
    weightBps: 30_000,
    maxFeeBps: 0,
    summary: 'No early exit. Opens at your target, your max loss, or the end of your term.',
    commitment: 'ROI target, max loss and a 30-365 day backstop term',
  },
] as const

export const TERM_OPTIONS = [30, 90, 180, 365] as const
export const TARGET_OPTIONS = [2_500, 5_000, 10_000, 20_000] as const
export const LOSS_OPTIONS = [2_000, 3_000, 5_000] as const

export type ExitStatus = { reason: ExitReason; feeBps: number; roiBps: number | null; priceFresh: boolean }

export type Position = {
  id: string
  tier: Tier
  amount: number
  entryPrice: number
  startedAt: number
  endsAt: number
  roiTargetBps: number
  maxLossBps: number
  pendingReward: number
  status: ExitStatus
}

export type ChallengeRankRow = { who: string; amount: number; roiBps: number | null; held: boolean; isMe: boolean }

export type ChallengeView = {
  id: string
  title: string
  kind: 0 | 1
  minTier: Tier
  minAmount: number
  roiTargetBps: number
  targetTotal: number
  rewardPool: number
  participants: number
  committedTotal: number
  joinBy: number
  endsAt: number
  claimEndsAt: number
  finalized: boolean
  refunded: boolean
  qualifiedCount: number
  qualifiedTotal: number
  snapshotPrice: number
  me: { lockId: string | null; qualified: boolean; claimed: boolean }
  ranking: ChallengeRankRow[]
}

export type VaultStats = {
  totalLocked: number
  openLocks: number
  totalBurned: number
  poolFromFees: number
  poolFunded: number
  rewardsPaid: number
  completedLocks: number
}

export type PriceInfo = { value: number | null; fresh: boolean; updatedAt: number; source: string }

export type VaultState = {
  mode: VaultMode
  status: 'loading' | 'ready' | 'error'
  error?: string
  tokenSymbol: string
  now: number
  price: PriceInfo
  stats: VaultStats
  walletBalance: number
  positions: Position[]
  challenges: ChallengeView[]
}

export type LockInput = { amount: string; tier: Tier; termDays: number; roiTargetBps: number; maxLossBps: number }

export type VaultActions = {
  lock: (input: LockInput) => Promise<boolean>
  exit: (lockId: string, maxFeeBps: number) => Promise<boolean>
  joinChallenge: (challengeId: string, lockId: string) => Promise<boolean>
  finalizeChallenge: (challengeId: string) => Promise<boolean>
  qualify: (challengeId: string) => Promise<boolean>
  claimChallenge: (challengeId: string) => Promise<boolean>
  refundChallenge: (challengeId: string) => Promise<boolean>
}

export const roiBps = (entryPrice: number, price: number | null) =>
  price === null || entryPrice <= 0 ? null : Math.trunc(((price - entryPrice) * 10_000) / entryPrice)

/** Mirrors RixorConvictionVault._exitStatus. */
export const computeExitStatus = (
  position: Pick<Position, 'tier' | 'startedAt' | 'endsAt' | 'roiTargetBps' | 'maxLossBps' | 'entryPrice'>,
  price: PriceInfo,
  now: number,
): ExitStatus => {
  const roi = price.fresh ? roiBps(position.entryPrice, price.value) : null
  const remaining = Math.max(0, position.endsAt - now)
  const duration = Math.max(1, position.endsAt - position.startedAt)
  const ceilFee = (max: number) => (remaining === 0 ? 0 : Math.ceil((max * remaining) / duration))
  const base = { roiBps: roi, priceFresh: price.fresh }

  if (position.tier === 0) {
    return remaining === 0 ? { ...base, reason: EXIT.FlexWindowPassed, feeBps: 0 } : { ...base, reason: EXIT.EarlyWithFee, feeBps: ceilFee(TIERS[0].maxFeeBps) }
  }
  if (remaining === 0) return { ...base, reason: EXIT.TermEnded, feeBps: 0 }
  if (roi !== null && roi >= position.roiTargetBps) return { ...base, reason: EXIT.TargetReached, feeBps: 0 }
  if (roi !== null && position.maxLossBps > 0 && roi <= -position.maxLossBps) return { ...base, reason: EXIT.StopLoss, feeBps: 0 }
  if (position.tier === 2) {
    const escape = !price.fresh && (price.updatedAt > now || now - price.updatedAt > ORACLE_ESCAPE)
    return { ...base, reason: escape ? EXIT.OracleStale : EXIT.Locked, feeBps: 0 }
  }
  return { ...base, reason: EXIT.EarlyWithFee, feeBps: ceilFee(TIERS[1].maxFeeBps) }
}

/** Completed exits pay accrued rewards; early-with-fee and stop-loss exits forfeit them. */
export const exitPaysRewards = (reason: ExitReason) => reason !== EXIT.EarlyWithFee && reason !== EXIT.StopLoss && reason !== EXIT.Locked

export const exitReasonLabel = (reason: ExitReason) => ({
  [EXIT.Locked]: 'Locked',
  [EXIT.EarlyWithFee]: 'Early exit with fee',
  [EXIT.FlexWindowPassed]: 'Free to withdraw',
  [EXIT.TermEnded]: 'Term ended',
  [EXIT.TargetReached]: 'ROI target reached',
  [EXIT.StopLoss]: 'Max loss hit',
  [EXIT.OracleStale]: 'Price feed stale for 7 days',
})[reason]

export type ChallengePhase = 'joining' | 'running' | 'awaiting-final' | 'qualifying' | 'claimable' | 'refundable' | 'closed'

export const challengePhase = (challenge: ChallengeView, now: number): ChallengePhase => {
  if (challenge.refunded) return 'closed'
  if (!challenge.finalized) {
    if (now <= challenge.joinBy) return 'joining'
    if (now < challenge.endsAt) return 'running'
    return now > challenge.endsAt + ORACLE_ESCAPE ? 'refundable' : 'awaiting-final'
  }
  if (now <= challenge.claimEndsAt) return 'qualifying'
  const failed = challenge.qualifiedCount === 0 || challenge.qualifiedTotal < challenge.targetTotal
  return failed ? 'refundable' : 'claimable'
}

export const formatBps = (bps: number, signed = false) => {
  const value = bps / 100
  const text = `${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
  if (!signed) return text
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${text}`
}

export const formatAmount = (value: number, compact = false) => {
  if (!Number.isFinite(value)) return '0'
  if (compact && Math.abs(value) >= 1_000) return value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 2 })
  return value.toLocaleString(undefined, { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 2 : 4 })
}

export const formatDuration = (seconds: number) => {
  if (seconds <= 0) return 'now'
  const days = Math.floor(seconds / DAY)
  const hours = Math.floor((seconds % DAY) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${Math.max(1, minutes)}m`
}

export const formatDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
