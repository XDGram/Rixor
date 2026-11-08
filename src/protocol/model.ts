import { formatUnits } from 'ethers'

export const TIERS = [
  { id: 0, name: 'Flexible', short: 'FLX', multiplierBps: 5_000, summary: 'Exit any time, no fee.' },
  { id: 1, name: 'Committed', short: 'CMT', multiplierBps: 15_000, summary: '30–90 days. Early exit fee up to 10%, falling to 0.' },
  { id: 2, name: 'Diamond', short: 'DMD', multiplierBps: 25_000, summary: '30–90 days. No exit before the term ends.' },
] as const

export const MAX_SCORED_UNITS = 10
export const MAX_POSITION_UNITS = 50
export const MIN_POOL = 100_000n * 10n ** 18n
export const MAX_POOL = 10_000_000n * 10n ** 18n
export const MIN_SPONSOR = 10_000n * 10n ** 18n
export const MAX_PARTICIPANTS = 200
export const MAX_DURATION = 30 * 86400

export type TokenInfo = {
  address: string
  symbol: string
  decimals: number
  unit: bigint
  cap: bigint
  totalLocked: bigint
  locksEnabled: boolean
  multiplierBps: number
  balance: bigint
  allowanceLocker: bigint
  allowanceChallenges: bigint
}

export type Position = {
  id: number
  owner: string
  token: string
  tier: number
  startedAt: number
  endsAt: number
  closedAt: number
  amount: bigint
  exitAllowed: boolean
  feeBps: number
}

export type Entry = { positionId: number; points: bigint; qualified: boolean; claimed: boolean }

export type Challenge = {
  id: number
  creator: string
  isSeason: boolean
  minTier: number
  minUnits: number
  maxParticipants: number
  joinDeadline: number
  endTime: number
  claimDeadline: number
  settled: boolean
  success: boolean
  participantCount: number
  settleCursor: number
  qualifiedCount: number
  goalPoints: bigint
  pool: bigint
  escrow: bigint
  joinedPoints: bigint
  qualifiedPoints: bigint
  claimedTotal: bigint
  refundedTotal: bigint
  sweptTotal: bigint
  title: string
  tokens: string[]
  cancelled: boolean
  me: { entry: Entry | null; contribution: bigint; refunded: boolean; swept: boolean; claimable: bigint }
}

export type Phase = 'open' | 'holding' | 'awaiting' | 'claiming' | 'sweeping' | 'failed' | 'cancelled'

export function phaseOf(c: Challenge, now: number): Phase {
  if (c.cancelled) return 'cancelled'
  if (!c.settled) {
    if (now <= c.joinDeadline) return 'open'
    if (now <= c.endTime) return 'holding'
    return 'awaiting'
  }
  if (!c.success) return 'failed'
  return now <= c.claimDeadline ? 'claiming' : 'sweeping'
}

export const PHASE_LABEL: Record<Phase, string> = {
  open: 'Open to join',
  holding: 'Holding period',
  awaiting: 'Ended · awaiting settlement',
  claiming: 'Settled · rewards claimable',
  sweeping: 'Settled · claim window closed',
  failed: 'Did not reach its goal · refunds',
  cancelled: 'Cancelled by emergency · refunds',
}

/** Mirrors RixorChallenges scoring. Points are relative scoring units, not values. */
export function pointsFor(amount: bigint, unit: bigint, tier: number, tokenMultiplierBps: number) {
  if (unit === 0n) return { units: 0, points: 0n }
  let units = Number(amount / unit)
  if (units > MAX_SCORED_UNITS) units = MAX_SCORED_UNITS
  const points = (BigInt(units) * BigInt(TIERS[tier]?.multiplierBps ?? 0) * BigInt(tokenMultiplierBps)) / 10_000n
  return { units, points }
}

// ------------------------------------------------------------------ formatting

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export function fmtToken(value: bigint, decimals = 18, opts: { compact?: boolean } = {}) {
  const n = Number(formatUnits(value, decimals))
  if (opts.compact && Math.abs(n) >= 10_000) return compact.format(n)
  return plain.format(n)
}

export const fmtPoints = (p: bigint) => plain.format(Number(p))
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export function fmtDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${s}s`
}

export function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
}

export const pct = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * 10_000n) / whole) / 100)

/** Parses a user-typed decimal amount into wei. Returns null for empty or invalid input. */
export function parseAmount(input: string, decimals = 18): bigint | null {
  const v = input.trim()
  if (!/^\d+(\.\d+)?$/.test(v)) return null
  const [whole, frac = ''] = v.split('.')
  if (frac.length > decimals) return null
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')
}
