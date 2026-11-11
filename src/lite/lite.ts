// RixorLite on Robinhood Chain mainnet: the published deployment, its on-chain verification, and one-call reads.
//
// The app shows a deployment only when /lite/deployment.json (or VITE_RIXOR_LITE_MANIFEST) is published AND the chain
// confirms it: a contract at that address whose token, reward token, reward wallet, budget, rate, lock period,
// minimum and cap equal the pinned plan in src/deploy/expected.ts. Only the official Robinhood Chain RPC is used.
import { Interface, JsonRpcProvider, getAddress, isAddress } from 'ethers'
import { LITE, MAINNET_EXPLORER, MAINNET_RPC, MAINNET_TOKENS } from '../deploy/expected'

export const CHAIN = { chainId: 4663, name: 'Robinhood Chain', rpc: MAINNET_RPC, explorer: MAINNET_EXPLORER, multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' } as const
export const TOKEN = MAINNET_TOKENS[LITE.token]
export const WIF = MAINNET_TOKENS.WIF
export const PLAN = LITE

export const LITE_ABI = [
  'function lock(uint256 amount)', 'function exit()', 'function claim() returns (uint256)',
  'function token() view returns (address)', 'function wif() view returns (address)', 'function rewardWallet() view returns (address)',
  'function budget() view returns (uint256)', 'function rate() view returns (uint256)', 'function startTime() view returns (uint256)', 'function endTime() view returns (uint256)',
  'function lockSeconds() view returns (uint256)', 'function minLock() view returns (uint256)', 'function cap() view returns (uint256)',
  'function totalLocked() view returns (uint256)', 'function totalClaimed() view returns (uint256)', 'function rewardsAvailable() view returns (uint256)',
  'function earned(address) view returns (uint256)', 'function accounts(address) view returns (uint256 amount, uint256 accPaid, uint256 owed, uint64 unlockAt)',
  'error InvalidAmount()', 'error CapExceeded()', 'error RewardsEnded()', 'error StillLocked(uint256 unlockAt)', 'error NothingLocked()', 'error NothingToClaim()',
  'error TransferFailed()', 'error IncompatibleToken()', 'error Reentrancy()',
]
export const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']
const lite = new Interface(LITE_ABI)
const erc20 = new Interface(ERC20_ABI)
const multicall = new Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)',
  'function getEthBalance(address) view returns (uint256)', 'function getCurrentBlockTimestamp() view returns (uint256)',
])

export type Deployment = { chainId: number; block: number; lite: string; token: string; wif: string; rewardWallet: string }
export type LiteState = {
  now: number // chain time of the read
  readAt: number // local clock (ms) of the read
  startTime: number; endTime: number
  totalLocked: bigint; totalClaimed: bigint; rewardsAvailable: bigint
  user: null | { locked: bigint; unlockAt: number; earned: bigint; tokenBalance: bigint; tokenAllowance: bigint; wifBalance: bigint; eth: bigint }
}

export const provider = () => new JsonRpcProvider(CHAIN.rpc, CHAIN.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 })

/** The published deployment, or null when none is published (the app then says "not deployed yet"). */
export async function loadDeployment(): Promise<Deployment | null> {
  const url = import.meta.env.VITE_RIXOR_LITE_MANIFEST || '/lite/deployment.json'
  let d: Deployment
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null
    d = await res.json()
  } catch { return null }
  if (Number(d.chainId) !== CHAIN.chainId) throw new Error(`The published deployment is for chain ${d.chainId}, not Robinhood Chain mainnet (4663).`)
  for (const k of ['lite', 'token', 'wif', 'rewardWallet'] as const) if (!isAddress(d[k])) throw new Error(`Published deployment: invalid ${k} address.`)
  if (getAddress(d.token) !== TOKEN.address || getAddress(d.wif) !== WIF.address) throw new Error('Published deployment refused: it does not use HOOKR and the official WIF.')
  return { ...d, chainId: Number(d.chainId), block: Number(d.block), lite: getAddress(d.lite), rewardWallet: getAddress(d.rewardWallet) }
}

async function aggregate(rpc: JsonRpcProvider, calls: { target: string; data: string }[]) {
  const raw = await rpc.call({ to: CHAIN.multicall3, data: multicall.encodeFunctionData('aggregate3', [calls.map((c) => ({ target: c.target, allowFailure: false, callData: c.data }))]) })
  const [out] = multicall.decodeFunctionResult('aggregate3', raw) as unknown as [{ success: boolean; returnData: string }[]]
  return out.map((r) => r.returnData)
}

/** Proves the published deployment from the chain. Throws with the reason if anything differs from the pinned plan. */
export async function verifyDeployment(rpc: JsonRpcProvider, d: Deployment) {
  if (Number((await rpc.getNetwork()).chainId) !== CHAIN.chainId) throw new Error('The RPC is not Robinhood Chain mainnet.')
  if ((await rpc.getCode(d.lite)) === '0x') throw new Error('Deployment refused: there is no contract at the published address.')
  const names = ['token', 'wif', 'rewardWallet', 'budget', 'rate', 'lockSeconds', 'minLock', 'cap'] as const
  let out: string[]
  try { out = await aggregate(rpc, names.map((n) => ({ target: d.lite, data: lite.encodeFunctionData(n, []) }))) } catch { throw new Error('Deployment refused: the published address is not a RixorLite contract.') }
  const v = Object.fromEntries(names.map((n, i) => [n, lite.decodeFunctionResult(n, out[i])[0]])) as Record<(typeof names)[number], string | bigint>
  const problems = [
    getAddress(v.token as string) !== TOKEN.address && 'it does not lock HOOKR',
    getAddress(v.wif as string) !== WIF.address && 'it does not pay the official WIF',
    getAddress(v.rewardWallet as string) !== d.rewardWallet && 'its reward wallet differs from the published one',
    v.budget !== PLAN.budget && 'its reward budget differs from the plan',
    v.rate !== PLAN.budget / PLAN.durationSeconds && 'its reward rate differs from the plan',
    v.lockSeconds !== PLAN.lockSeconds && 'its lock period differs from the plan',
    v.minLock !== PLAN.minLock && 'its minimum lock differs from the plan',
    v.cap !== PLAN.cap && 'its cap differs from the plan',
  ].filter(Boolean)
  if (problems.length) throw new Error(`Deployment refused: ${problems.join('; ')}.`)
}

/** Everything the page shows, in ONE request to the public RPC (Multicall3). */
export async function readState(rpc: JsonRpcProvider, d: Deployment, account: string | null): Promise<LiteState> {
  const L = (fn: string, args: unknown[] = []) => ({ target: d.lite, data: lite.encodeFunctionData(fn, args) })
  const calls = [
    { target: CHAIN.multicall3, data: multicall.encodeFunctionData('getCurrentBlockTimestamp', []) },
    L('startTime'), L('endTime'), L('totalLocked'), L('totalClaimed'), L('rewardsAvailable'),
    ...(account ? [
      L('accounts', [account]), L('earned', [account]),
      { target: TOKEN.address, data: erc20.encodeFunctionData('balanceOf', [account]) },
      { target: TOKEN.address, data: erc20.encodeFunctionData('allowance', [account, d.lite]) },
      { target: WIF.address, data: erc20.encodeFunctionData('balanceOf', [account]) },
      { target: CHAIN.multicall3, data: multicall.encodeFunctionData('getEthBalance', [account]) },
    ] : []),
  ]
  const out = await aggregate(rpc, calls)
  const n = (i: number) => BigInt(out[i])
  let user: LiteState['user'] = null
  if (account) {
    const acc = lite.decodeFunctionResult('accounts', out[6])
    user = { locked: acc.amount as bigint, unlockAt: Number(acc.unlockAt), earned: n(7), tokenBalance: n(8), tokenAllowance: n(9), wifBalance: n(10), eth: n(11) }
  }
  return { now: Number(n(0)), readAt: Date.now(), startTime: Number(n(1)), endTime: Number(n(2)), totalLocked: n(3), totalClaimed: n(4), rewardsAvailable: n(5), user }
}

/** WIF earned right now, extrapolated from the last read with the contract's own formula (display only). */
export function earnedNow(s: LiteState, nowMs: number): bigint {
  if (!s.user || s.user.locked === 0n || s.totalLocked === 0n) return s.user?.earned ?? 0n
  const chainNow = s.now + Math.floor((nowMs - s.readAt) / 1000)
  const until = Math.min(chainNow, s.endTime)
  if (until <= s.now) return s.user.earned
  const rate = PLAN.budget / PLAN.durationSeconds
  return s.user.earned + (BigInt(until - s.now) * rate * s.user.locked) / s.totalLocked
}

const FRIENDLY: Record<string, string> = {
  InvalidAmount: 'That amount is below the minimum lock.',
  CapExceeded: 'The contract has reached its total cap. Try a smaller amount.',
  RewardsEnded: 'The reward period has ended, so new locks are closed. Exits and claims still work.',
  StillLocked: 'Your lock period has not ended yet.',
  NothingLocked: 'This wallet has nothing locked.',
  NothingToClaim: 'There is no WIF to claim yet.',
  TransferFailed: 'A token transfer failed. If you were claiming, the reward wallet may be out of WIF; your unclaimed amount is kept.',
  IncompatibleToken: 'The token did not deliver the exact amount.',
}
export function describeLiteError(error: unknown): string {
  const e = error as { data?: string; info?: { error?: { data?: string; code?: number } }; error?: { data?: string }; shortMessage?: string; message?: string; code?: string | number }
  if (e?.code === 'ACTION_REJECTED' || e?.code === 4001 || e?.info?.error?.code === 4001) return 'You rejected the request in your wallet. Nothing was sent.'
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data
  if (typeof data === 'string' && data.length >= 10) {
    try { const p = lite.parseError(data); if (p) return FRIENDLY[p.name] ?? p.name } catch { /* not a RixorLite error */ }
  }
  const msg = e?.shortMessage ?? e?.message ?? 'Something went wrong.'
  if (/insufficient funds/i.test(msg)) return 'Your wallet does not have enough ETH on Robinhood Chain to pay for gas.'
  return msg.length > 180 ? `${msg.slice(0, 180)}…` : msg
}
