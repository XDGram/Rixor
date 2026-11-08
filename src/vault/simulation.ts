// SIMULATION ONLY. Runs entirely in this browser (localStorage). No wallet, no chain, no real
// tokens and no real prices. It mirrors RixorConvictionVault's rules so the tiers, ROI exits,
// rewards and challenges can be tried before a testnet deployment exists.
import {
  CLAIM_WINDOW,
  DAY,
  EXIT,
  FLEX_WINDOW,
  ORACLE_ESCAPE,
  TIERS,
  computeExitStatus,
  exitPaysRewards,
  roiBps,
  type ChallengeView,
  type LockInput,
  type PriceInfo,
  type Tier,
  type VaultState,
} from './model'

const STORAGE_KEY = 'rixor:vault-simulation:v1'
const ME = 'you'
const MAX_PRICE_AGE = DAY

type SimLock = {
  id: number
  owner: string
  tier: Tier
  amount: number
  weight: number
  entryPrice: number
  startedAt: number
  endsAt: number
  roiTargetBps: number
  maxLossBps: number
  rewardDebt: number
  open: boolean
  closedAt: number
}

type SimEntry = { lockId: number; qualified: boolean; claimed: boolean }

type SimChallenge = {
  id: number
  title: string
  kind: 0 | 1
  minTier: Tier
  minAmount: number
  roiTargetBps: number
  targetTotal: number
  rewardPool: number
  joinBy: number
  endsAt: number
  claimEndsAt: number
  finalized: boolean
  refunded: boolean
  snapshotPrice: number
  qualifiedCount: number
  qualifiedTotal: number
  committedTotal: number
  entries: Record<string, SimEntry>
  order: string[]
}

type SimState = {
  version: 1
  clockOffset: number
  price: number
  priceUpdatedAt: number
  feedStalled: boolean
  balance: number
  nextLockId: number
  locks: SimLock[]
  acc: number
  totalWeight: number
  totalLocked: number
  openLocks: number
  totalBurned: number
  poolFromFees: number
  poolFunded: number
  rewardsPaid: number
  completedLocks: number
  challenges: SimChallenge[]
}

const realNow = () => Math.floor(Date.now() / 1000)

const seed = (): SimState => {
  const now = realNow()
  const state: SimState = {
    version: 1,
    clockOffset: 0,
    price: 1,
    priceUpdatedAt: now,
    feedStalled: false,
    balance: 1_000_000,
    nextLockId: 1,
    locks: [],
    acc: 0,
    totalWeight: 0,
    totalLocked: 0,
    openLocks: 0,
    totalBurned: 0,
    poolFromFees: 0,
    poolFunded: 0,
    rewardsPaid: 0,
    completedLocks: 0,
    challenges: [],
  }
  const addLock = (owner: string, tier: Tier, amount: number, ageDays: number, termDays: number, target: number, loss: number) => {
    const startedAt = now - ageDays * DAY
    const weight = (amount * TIERS[tier].weightBps) / 10_000
    state.locks.push({
      id: state.nextLockId++, owner, tier, amount, weight, entryPrice: 1, startedAt,
      endsAt: startedAt + (tier === 0 ? FLEX_WINDOW : termDays * DAY), roiTargetBps: target, maxLossBps: loss,
      rewardDebt: weight * state.acc, open: true, closedAt: 0,
    })
    state.totalWeight += weight
    state.totalLocked += amount
    state.openLocks += 1
  }
  addLock('sim:0x9f2c…a1d0', 2, 400_000, 12, 180, 10_000, 5_000)
  addLock('sim:0x41be…77c3', 1, 250_000, 5, 90, 5_000, 3_000)
  addLock('sim:0xd07a…19ef', 0, 120_000, 2, 0, 0, 0)

  // A community reward contribution so the pool is visibly non-empty.
  state.acc += 20_000 / state.totalWeight
  state.poolFunded += 20_000

  const challenge = (title: string, kind: 0 | 1, minTier: Tier, minAmount: number, roiTarget: number, targetTotal: number, reward: number, joinDays: number, endDays: number, joined: Array<[string, number]>): SimChallenge => {
    const entries: Record<string, SimEntry> = {}
    let committedTotal = 0
    for (const [owner, lockId] of joined) {
      entries[owner] = { lockId, qualified: false, claimed: false }
      committedTotal += state.locks.find((item) => item.id === lockId)?.amount ?? 0
    }
    return {
      id: state.challenges.length + 1, title, kind, minTier, minAmount, roiTargetBps: roiTarget, targetTotal, rewardPool: reward,
      joinBy: now + joinDays * DAY, endsAt: now + endDays * DAY, claimEndsAt: 0, finalized: false, refunded: false,
      snapshotPrice: 0, qualifiedCount: 0, qualifiedTotal: 0, committedTotal, entries, order: joined.map(([owner]) => owner),
    }
  }
  state.challenges.push(challenge('Hold the line', 0, 1, 10_000, 0, 600_000, 50_000, 3, 14, [['sim:0x9f2c…a1d0', 1], ['sim:0x41be…77c3', 2]]))
  state.challenges.push(challenge('The +25% club', 1, 0, 1_000, 2_500, 0, 25_000, 2, 10, [['sim:0xd07a…19ef', 3]]))
  return state
}

let cache: SimState | null = null
const listeners = new Set<() => void>()

const load = (): SimState => {
  if (cache) return cache
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null') as SimState | null
    cache = parsed && parsed.version === 1 ? parsed : seed()
  } catch {
    cache = seed()
  }
  return cache
}

const save = () => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Storage can be unavailable (private mode). The simulation keeps working in memory.
  }
  listeners.forEach((listener) => listener())
}

export const subscribeSimulation = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const simNow = (state: SimState) => realNow() + state.clockOffset

const priceInfo = (state: SimState): PriceInfo => {
  const now = simNow(state)
  const updatedAt = state.feedStalled ? state.priceUpdatedAt : now
  return { value: state.price, fresh: now - updatedAt <= MAX_PRICE_AGE, updatedAt, source: 'Simulated price' }
}

const pending = (state: SimState, item: SimLock) => (item.open ? Math.max(0, item.weight * state.acc - item.rewardDebt) : 0)

const distribute = (state: SimState, amount: number) => {
  if (amount <= 0) return 0
  if (state.totalWeight <= 0) return amount
  state.acc += amount / state.totalWeight
  return 0
}

const fail = (message: string): never => {
  throw new Error(message)
}

export const simulationControls = {
  movePrice(percent: number) {
    const state = load()
    state.price = Math.max(0.0001, state.price * (1 + percent / 100))
    if (!state.feedStalled) state.priceUpdatedAt = simNow(state)
    save()
  },
  advance(days: number) {
    const state = load()
    state.clockOffset += days * DAY
    save()
  },
  toggleFeed() {
    const state = load()
    state.feedStalled = !state.feedStalled
    state.priceUpdatedAt = simNow(state)
    save()
  },
  reset() {
    cache = seed()
    save()
  },
  feedStalled: () => load().feedStalled,
}

export const readSimulation = (): VaultState => {
  const state = load()
  const now = simNow(state)
  const price = priceInfo(state)

  const positions = state.locks
    .filter((item) => item.owner === ME && item.open)
    .map((item) => ({
      id: String(item.id),
      tier: item.tier,
      amount: item.amount,
      entryPrice: item.entryPrice,
      startedAt: item.startedAt,
      endsAt: item.endsAt,
      roiTargetBps: item.roiTargetBps,
      maxLossBps: item.maxLossBps,
      pendingReward: pending(state, item),
      status: computeExitStatus(item, price, now),
    }))

  const challenges: ChallengeView[] = state.challenges.map((item) => {
    const mine = item.entries[ME]
    return {
      id: String(item.id),
      title: item.title,
      kind: item.kind,
      minTier: item.minTier,
      minAmount: item.minAmount,
      roiTargetBps: item.roiTargetBps,
      targetTotal: item.targetTotal,
      rewardPool: item.rewardPool,
      participants: item.order.length,
      committedTotal: item.committedTotal,
      joinBy: item.joinBy,
      endsAt: item.endsAt,
      claimEndsAt: item.claimEndsAt,
      finalized: item.finalized,
      refunded: item.refunded,
      qualifiedCount: item.qualifiedCount,
      qualifiedTotal: item.qualifiedTotal,
      snapshotPrice: item.snapshotPrice,
      me: { lockId: mine ? String(mine.lockId) : null, qualified: mine?.qualified ?? false, claimed: mine?.claimed ?? false },
      ranking: item.order.map((owner) => {
        const position = state.locks.find((entry) => entry.id === item.entries[owner].lockId)!
        const held = position.open || position.closedAt >= item.endsAt
        const measurePrice = item.finalized && item.kind === 1 ? item.snapshotPrice : price.fresh ? price.value : null
        return { who: owner, amount: position.amount, roiBps: roiBps(position.entryPrice, measurePrice), held, isMe: owner === ME }
      }),
    }
  })

  return {
    mode: 'simulation',
    status: 'ready',
    tokenSymbol: 'WIF',
    now,
    price,
    stats: {
      totalLocked: state.totalLocked,
      openLocks: state.openLocks,
      totalBurned: state.totalBurned,
      poolFromFees: state.poolFromFees,
      poolFunded: state.poolFunded,
      rewardsPaid: state.rewardsPaid,
      completedLocks: state.completedLocks,
    },
    walletBalance: state.balance,
    positions,
    challenges,
  }
}

const run = (mutate: (state: SimState) => void) => {
  const state = load()
  mutate(state)
  save()
  return Promise.resolve(true)
}

const ownChallenge = (state: SimState, challengeId: string) =>
  state.challenges.find((item) => String(item.id) === challengeId) ?? fail('Challenge not found.')

export const simulationActions = {
  lock: (input: LockInput) => run((state) => {
    const amount = Number(input.amount)
    if (!(amount > 0)) fail('Enter an amount above zero.')
    if (amount > state.balance) fail('That is more than your simulated balance.')
    const price = priceInfo(state)
    if (!price.fresh) fail('The price feed is stale, so new locks are paused.')
    const now = simNow(state)
    const weight = (amount * TIERS[input.tier].weightBps) / 10_000
    state.balance -= amount
    state.locks.push({
      id: state.nextLockId++,
      owner: ME,
      tier: input.tier,
      amount,
      weight,
      entryPrice: state.price,
      startedAt: now,
      endsAt: now + (input.tier === 0 ? FLEX_WINDOW : input.termDays * DAY),
      roiTargetBps: input.tier === 0 ? 0 : input.roiTargetBps,
      maxLossBps: input.tier === 0 ? 0 : input.maxLossBps,
      rewardDebt: weight * state.acc,
      open: true,
      closedAt: 0,
    })
    state.totalWeight += weight
    state.totalLocked += amount
    state.openLocks += 1
  }),

  exit: (lockId: string, maxFeeBps: number) => run((state) => {
    const item = state.locks.find((entry) => String(entry.id) === lockId && entry.owner === ME && entry.open) ?? fail('Lock not found.')
    const now = simNow(state)
    const status = computeExitStatus(item, priceInfo(state), now)
    if (status.reason === EXIT.Locked) fail('This Diamond Hands lock cannot be withdrawn yet.')
    if (status.feeBps > maxFeeBps) fail('The fee changed. Review it again.')
    const reward = pending(state, item)
    item.open = false
    item.closedAt = now
    state.openLocks -= 1
    state.totalLocked -= item.amount
    state.totalWeight -= item.weight
    if (exitPaysRewards(status.reason)) {
      state.completedLocks += 1
      state.rewardsPaid += reward
      state.balance += item.amount + reward
      return
    }
    const fee = (item.amount * status.feeBps) / 10_000
    let burned = fee / 2
    const toPool = fee - burned + reward
    const undistributed = distribute(state, toPool)
    burned += undistributed
    state.poolFromFees += toPool - undistributed
    state.totalBurned += burned
    state.balance += item.amount - fee
  }),

  joinChallenge: (challengeId: string, lockId: string) => run((state) => {
    const challenge = ownChallenge(state, challengeId)
    const now = simNow(state)
    if (now > challenge.joinBy) fail('Joining has closed.')
    if (challenge.entries[ME]) fail('You already joined.')
    const item = state.locks.find((entry) => String(entry.id) === lockId && entry.owner === ME && entry.open) ?? fail('Pick one of your open locks.')
    if (item.tier < challenge.minTier || item.amount < challenge.minAmount) fail('That lock does not meet the requirements.')
    challenge.entries[ME] = { lockId: item.id, qualified: false, claimed: false }
    challenge.order.push(ME)
    challenge.committedTotal += item.amount
  }),

  finalizeChallenge: (challengeId: string) => run((state) => {
    const challenge = ownChallenge(state, challengeId)
    const now = simNow(state)
    if (now < challenge.endsAt) fail('The challenge has not ended yet.')
    if (challenge.finalized) fail('Already finalized.')
    const price = priceInfo(state)
    if (challenge.kind === 1) {
      if (!price.fresh) fail('A fresh price is needed to finalize.')
      challenge.snapshotPrice = state.price
    }
    challenge.finalized = true
    challenge.claimEndsAt = now + CLAIM_WINDOW
    // Simulated community participants prove their result straight away.
    for (const owner of challenge.order.filter((who) => who !== ME)) {
      const entry = challenge.entries[owner]
      const item = state.locks.find((lock) => lock.id === entry.lockId)!
      const held = item.open || item.closedAt >= challenge.endsAt
      const roi = roiBps(item.entryPrice, challenge.snapshotPrice)
      if (held && (challenge.kind === 0 || (roi !== null && roi >= challenge.roiTargetBps))) {
        entry.qualified = true
        challenge.qualifiedCount += 1
        challenge.qualifiedTotal += item.amount
      }
    }
  }),

  qualify: (challengeId: string) => run((state) => {
    const challenge = ownChallenge(state, challengeId)
    const now = simNow(state)
    if (!challenge.finalized || now > challenge.claimEndsAt) fail('Qualifying is not open.')
    const entry = challenge.entries[ME] ?? fail('You did not join this challenge.')
    if (entry.qualified) fail('Already qualified.')
    const item = state.locks.find((lock) => lock.id === entry.lockId)!
    const held = item.open || item.closedAt >= challenge.endsAt
    const roi = roiBps(item.entryPrice, challenge.snapshotPrice)
    if (!held || (challenge.kind === 1 && (roi === null || roi < challenge.roiTargetBps))) fail('Your lock did not meet this challenge.')
    entry.qualified = true
    challenge.qualifiedCount += 1
    challenge.qualifiedTotal += item.amount
  }),

  claimChallenge: (challengeId: string) => run((state) => {
    const challenge = ownChallenge(state, challengeId)
    const now = simNow(state)
    if (!challenge.finalized || now <= challenge.claimEndsAt || challenge.refunded) fail('Claims open after the qualifying window.')
    if (challenge.qualifiedTotal < challenge.targetTotal) fail('The community target was missed.')
    const entry = challenge.entries[ME]
    if (!entry?.qualified || entry.claimed) fail('Nothing to claim.')
    entry.claimed = true
    state.balance += challenge.rewardPool / challenge.qualifiedCount
  }),

  refundChallenge: (challengeId: string) => run((state) => {
    const challenge = ownChallenge(state, challengeId)
    const now = simNow(state)
    const failed = challenge.finalized && now > challenge.claimEndsAt && (challenge.qualifiedCount === 0 || challenge.qualifiedTotal < challenge.targetTotal)
    const stuck = !challenge.finalized && now > challenge.endsAt + ORACLE_ESCAPE
    if (!failed && !stuck) fail('Refunds are not available for this challenge.')
    challenge.refunded = true
  }),
}
