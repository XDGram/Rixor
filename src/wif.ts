import { Interface, formatUnits, getAddress, isAddress } from 'ethers'
import { useEffect, useState } from 'react'
import diamondArtifact from './contracts/RixorDiamondHandsArtifact.json'

export const ROBINHOOD_MAINNET = {
  id: 4663,
  hexId: '0x1237',
  name: 'Robinhood Chain',
  shortName: 'Robinhood Chain',
  // Overridable only so the lock flow can be tested end to end against a local chain.
  rpcUrl: String(import.meta.env.VITE_RIXOR_MAINNET_RPC_URL ?? '').trim() || 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robin.etherscan.io',
} as const

/** $WIF (World is Flat) on Robinhood Chain. Verified onchain: symbol WIF, 18 decimals, burnable. */
const WIF_MAINNET = '0x5173b8eA6923c2d40267890D45C46a3480954773'
const wifOverride = String(import.meta.env.VITE_RIXOR_WIF_ADDRESS ?? '').trim()
export const WIF_ADDRESS = isAddress(wifOverride) ? getAddress(wifOverride) : WIF_MAINNET
export const WIF_DECIMALS = 18

const configuredDiamond = String(import.meta.env.VITE_RIXOR_DIAMOND_ADDRESS ?? '').trim()
/** Set after deployment via VITE_RIXOR_DIAMOND_ADDRESS. Empty means the lock contract is not live yet. */
export const DIAMOND_ADDRESS = isAddress(configuredDiamond) ? getAddress(configuredDiamond) : ''
/** Deployment block, so event history scans start there instead of at genesis. */
export const DIAMOND_FROM_BLOCK = Number(import.meta.env.VITE_RIXOR_DIAMOND_FROM_BLOCK ?? 0) || 0

export const diamondInterface = new Interface(diamondArtifact.abi)
export const erc20Interface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function totalSupply() view returns (uint256)',
])

export const LOCK_TERMS = [
  { id: 0, label: '7 days', short: '7D', days: 7, maxFeeBps: 500, weightBps: 10_000 },
  { id: 1, label: '30 days', short: '30D', days: 30, maxFeeBps: 1_000, weightBps: 12_500 },
  { id: 2, label: '90 days', short: '90D', days: 90, maxFeeBps: 1_500, weightBps: 15_000 },
  { id: 3, label: '180 days', short: '180D', days: 180, maxFeeBps: 2_000, weightBps: 20_000 },
  { id: 4, label: '1 year', short: '1Y', days: 365, maxFeeBps: 2_500, weightBps: 30_000 },
] as const

export const toWif = (value: bigint) => Number(formatUnits(value, WIF_DECIMALS))

export const formatWif = (value: number, compact = false) => {
  if (!Number.isFinite(value)) return '0'
  if (compact && Math.abs(value) >= 1_000) {
    return value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 2 })
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : value >= 1 ? 2 : 4 })
}

/** Mirrors RixorDiamondHands._currentFeeBps: linear decline from the term maximum to 0, rounded up. */
export const currentFeeBps = (term: number, startedAt: number, unlocksAt: number, nowSeconds: number) => {
  if (nowSeconds >= unlocksAt) return 0
  const max = LOCK_TERMS[term]?.maxFeeBps ?? 0
  const duration = Math.max(1, unlocksAt - startedAt)
  return Math.ceil((max * (unlocksAt - nowSeconds)) / duration)
}

let rpcId = 0
export const rpc = async <T,>(method: string, params: unknown[]): Promise<T> => {
  const response = await fetch(ROBINHOOD_MAINNET.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  if (!response.ok) throw new Error(`Robinhood Chain RPC error ${response.status}`)
  const payload = await response.json() as { result?: T; error?: { message?: string } }
  if (payload.error) throw new Error(payload.error.message || 'Robinhood Chain RPC error')
  return payload.result as T
}

export const readContract = async (iface: Interface, address: string, fn: string, args: unknown[] = []) => {
  const data = iface.encodeFunctionData(fn, args)
  const result = await rpc<string>('eth_call', [{ to: address, data }, 'latest'])
  return iface.decodeFunctionResult(fn, result)
}

export type DiamondStats = {
  status: 'not-deployed' | 'loading' | 'ready' | 'error'
  totalLocked: number
  totalBurned: number
  totalDistributed: number
  openLocks: number
}

const emptyStats: Omit<DiamondStats, 'status'> = { totalLocked: 0, totalBurned: 0, totalDistributed: 0, openLocks: 0 }

export const readDiamondStats = async (): Promise<Omit<DiamondStats, 'status'>> => {
  const [locked, burned, distributed, open] = await Promise.all([
    readContract(diamondInterface, DIAMOND_ADDRESS, 'totalLocked'),
    readContract(diamondInterface, DIAMOND_ADDRESS, 'totalBurned'),
    readContract(diamondInterface, DIAMOND_ADDRESS, 'totalDistributed'),
    readContract(diamondInterface, DIAMOND_ADDRESS, 'openLocks'),
  ])
  return {
    totalLocked: toWif(locked[0] as bigint),
    totalBurned: toWif(burned[0] as bigint),
    totalDistributed: toWif(distributed[0] as bigint),
    openLocks: Number(open[0] as bigint),
  }
}

/** Live flywheel totals read straight from the contract through the public RPC. */
export const useDiamondStats = (refreshKey = 0): DiamondStats => {
  const [stats, setStats] = useState<DiamondStats>({ status: DIAMOND_ADDRESS ? 'loading' : 'not-deployed', ...emptyStats })

  useEffect(() => {
    if (!DIAMOND_ADDRESS) return
    let cancelled = false
    const load = () => readDiamondStats()
      .then((next) => { if (!cancelled) setStats({ status: 'ready', ...next }) })
      .catch(() => { if (!cancelled) setStats((current) => ({ ...current, status: current.status === 'ready' ? 'ready' : 'error' })) })
    void load()
    const interval = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [refreshKey])

  return stats
}

export type DiamondEvent = {
  key: string
  kind: 'locked' | 'unlocked' | 'broken' | 'claimed'
  owner: string
  lockId: string
  amount: number
  burned: number
  term?: number
  blockNumber: number
  txHash: string
}

export type LeaderboardRow = { owner: string; locked: number }

/** Rebuilds the leaderboard and recent feed from contract events. */
export const readDiamondHistory = async (): Promise<{ events: DiamondEvent[]; leaderboard: LeaderboardRow[] }> => {
  type RawLog = { data: string; topics: string[]; blockNumber: string; transactionHash: string; logIndex: string }
  const fromBlock = `0x${DIAMOND_FROM_BLOCK.toString(16)}`
  const topics = ['Locked', 'Unlocked', 'LockBroken', 'RewardClaimed'].map((name) => diamondInterface.getEvent(name)!.topicHash)
  const logs = await rpc<RawLog[]>('eth_getLogs', [{ address: DIAMOND_ADDRESS, fromBlock, toBlock: 'latest', topics: [topics] }])

  const net = new Map<string, number>()
  const events: DiamondEvent[] = []
  for (const log of logs) {
    const parsed = diamondInterface.parseLog({ data: log.data, topics: log.topics })
    if (!parsed) continue
    const owner = String(parsed.args.owner)
    const base = {
      key: `${log.transactionHash}-${log.logIndex}`,
      owner,
      lockId: String(parsed.args.lockId),
      blockNumber: Number.parseInt(log.blockNumber, 16),
      txHash: log.transactionHash,
      burned: 0,
    }
    if (parsed.name === 'Locked') {
      const amount = toWif(parsed.args.amount as bigint)
      net.set(owner, (net.get(owner) ?? 0) + amount)
      events.push({ ...base, kind: 'locked', amount, term: Number(parsed.args.term) })
    } else if (parsed.name === 'Unlocked') {
      const amount = toWif(parsed.args.amount as bigint)
      net.set(owner, (net.get(owner) ?? 0) - amount)
      events.push({ ...base, kind: 'unlocked', amount: amount + toWif(parsed.args.reward as bigint) })
    } else if (parsed.name === 'LockBroken') {
      const principal = toWif((parsed.args.amountReturned as bigint) + (parsed.args.fee as bigint))
      net.set(owner, (net.get(owner) ?? 0) - principal)
      events.push({ ...base, kind: 'broken', amount: toWif(parsed.args.fee as bigint), burned: toWif(parsed.args.burned as bigint) })
    } else if (parsed.name === 'RewardClaimed') {
      events.push({ ...base, kind: 'claimed', amount: toWif(parsed.args.reward as bigint) })
    }
  }

  const leaderboard = [...net.entries()]
    .filter(([, locked]) => locked > 0.000001)
    .map(([owner, locked]) => ({ owner, locked }))
    .sort((a, b) => b.locked - a.locked)
    .slice(0, 10)

  return { events: events.reverse().slice(0, 12), leaderboard }
}

export const useDiamondHistory = (refreshKey = 0) => {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; events: DiamondEvent[]; leaderboard: LeaderboardRow[] }>({
    status: DIAMOND_ADDRESS ? 'loading' : 'idle',
    events: [],
    leaderboard: [],
  })

  useEffect(() => {
    if (!DIAMOND_ADDRESS) return
    let cancelled = false
    readDiamondHistory()
      .then((next) => { if (!cancelled) setState({ status: 'ready', ...next }) })
      .catch(() => { if (!cancelled) setState((current) => ({ ...current, status: 'error' })) })
    return () => { cancelled = true }
  }, [refreshKey])

  return state
}

export const shortAddr = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address)
export const explorerAddress = (address: string) => `${ROBINHOOD_MAINNET.explorerUrl}/address/${address}`
export const explorerTx = (hash: string) => `${ROBINHOOD_MAINNET.explorerUrl}/tx/${hash}`
