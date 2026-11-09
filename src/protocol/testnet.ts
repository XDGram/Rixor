// Live modes: real transactions, signed by the visitor's own wallet, against a published Rixor deployment.
//   testnet: Robinhood Chain testnet (46630), TEST tokens. Manifest /testnet/deployment.json (VITE_RIXOR_TESTNET_MANIFEST).
//            Refuses any manifest or RPC on mainnet.
//   mainnet: Robinhood Chain mainnet (4663), REAL tokens and the official $WIF. Manifest /mainnet/deployment.json
//            (VITE_RIXOR_MAINNET_MANIFEST). Refused unless the chain proves the manifest: Locker bytecode equal to the
//            reviewed build, Rewards and Challenges wired to that Locker and paying the official WIF, owner and guardian
//            equal to the manifest's Safes.
// A mode is offered only when its manifest is published.
import { Contract, JsonRpcProvider, getAddress, isAddress, keccak256 } from 'ethers'
import { LOCKER_ABI, ERC20_ABI, CHALLENGES_ABI, REWARDS_ABI } from './chain'
import type { Manifest } from './env'
import { LOCKER_RUNTIME_HASH, MAINNET_TOKENS } from '../deploy/expected'

export const TESTNET = { chainId: 46630, name: 'Robinhood Chain Testnet', rpc: 'https://rpc.testnet.chain.robinhood.com' }
export const MAINNET = { chainId: 4663, name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com' }
export type LiveNetwork = 'testnet' | 'mainnet'
const MAINNET_ID = 4663
const ZERO = '0x0000000000000000000000000000000000000000'
const OFFICIAL_WIF = MAINNET_TOKENS.WIF.address

export type TestnetDeployment = {
  chainId: number
  block: number
  locker: string
  rewards: string
  challenges: string
  wif: string
  ownerSafe: string
  guardianSafe: string
  minHoldSeconds: number
  rpc?: string
  label?: string
}

/** Returns the published testnet deployment, or null when none is published (the mode is then unavailable). */
export const loadTestnetDeployment = () => loadLiveDeployment('testnet')

/** Returns the published deployment for `network`, or null when none is published. */
export async function loadLiveDeployment(network: LiveNetwork): Promise<TestnetDeployment | null> {
  const url = network === 'mainnet'
    ? (import.meta.env.VITE_RIXOR_MAINNET_MANIFEST || '/mainnet/deployment.json')
    : (import.meta.env.VITE_RIXOR_TESTNET_MANIFEST || '/testnet/deployment.json')
  let d: TestnetDeployment
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null
    d = await res.json()
  } catch { return null }
  const name = network === 'mainnet' ? 'Mainnet' : 'Testnet'
  if (network === 'testnet' && Number(d.chainId) === MAINNET_ID) throw new Error('The testnet manifest points at Robinhood Chain mainnet. Testnet mode refuses mainnet.')
  if (network === 'mainnet' && Number(d.chainId) !== MAINNET_ID) throw new Error(`The mainnet manifest is for chain ${d.chainId}, not Robinhood Chain mainnet (4663).`)
  for (const k of ['locker', 'rewards', 'challenges', 'wif', 'ownerSafe', 'guardianSafe'] as const) {
    if (!isAddress(d[k])) throw new Error(`${name} manifest: invalid ${k} address.`)
  }
  if (network === 'mainnet' && getAddress(d.wif) !== OFFICIAL_WIF) throw new Error('Mainnet manifest: the reward token is not the official WIF. Refused.')
  if (network === 'mainnet' && d.rpc && d.rpc !== MAINNET.rpc) throw new Error('Mainnet manifest: only the official Robinhood Chain RPC is accepted.')
  return { ...d, chainId: Number(d.chainId), block: Number(d.block) }
}

export type TestnetSession = {
  deployment: TestnetDeployment
  manifest: Manifest
  provider: JsonRpcProvider
  rpc: string
  health: () => Promise<{ ok: boolean; block: number; timestamp: number; chainNow: number }>
}

export const bootTestnet = (d: TestnetDeployment) => bootLive(d, 'testnet')

export async function bootLive(d: TestnetDeployment, network: LiveNetwork): Promise<TestnetSession> {
  const rpc = network === 'mainnet' ? MAINNET.rpc : (d.rpc || import.meta.env.VITE_RIXOR_TESTNET_RPC || TESTNET.rpc)
  const provider = new JsonRpcProvider(rpc, d.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 })
  const chainId = Number((await provider.getNetwork()).chainId)
  if (network === 'testnet' && (chainId === MAINNET_ID || chainId !== d.chainId)) throw new Error(`Testnet RPC reports chain ${chainId}, expected ${d.chainId}.`)
  if (network === 'mainnet' && (chainId !== MAINNET_ID || d.chainId !== MAINNET_ID)) throw new Error(`Mainnet RPC reports chain ${chainId}, expected 4663.`)
  const locker = new Contract(d.locker, LOCKER_ABI, provider)
  const lockerCode = await provider.getCode(d.locker)
  if (lockerCode === '0x') throw new Error('No Rixor Locker at the manifest address on this network.')
  if (network === 'mainnet') {
    // Prove the manifest from the chain before showing anything that moves real assets.
    if (keccak256(lockerCode) !== LOCKER_RUNTIME_HASH) throw new Error('Mainnet deployment refused: the Locker bytecode differs from the reviewed build.')
    const rewards = new Contract(d.rewards, REWARDS_ABI, provider)
    const challenges = new Contract(d.challenges, CHALLENGES_ABI, provider)
    const read = Promise.all([
      locker.owner() as Promise<string>, locker.guardian() as Promise<string>, rewards.locker() as Promise<string>, rewards.wif() as Promise<string>,
      challenges.locker() as Promise<string>, challenges.wif() as Promise<string>,
    ])
    const [owner, guardian, rLocker, rWif, cLocker, cWif] = await read.catch(() => { throw new Error('Mainnet deployment refused: the manifest addresses are not a Rixor deployment.') })
    const same = (a: string, b: string) => getAddress(a) === getAddress(b)
    const problems = [
      !same(owner, d.ownerSafe) && 'the Locker owner is not the manifest owner Safe',
      !same(guardian, d.guardianSafe) && 'the Locker guardian is not the manifest guardian Safe',
      !(same(rLocker, d.locker) && same(rWif, OFFICIAL_WIF)) && 'RixorRewards is not wired to this Locker and the official WIF',
      !(same(cLocker, d.locker) && same(cWif, OFFICIAL_WIF)) && 'RixorChallenges is not wired to this Locker and the official WIF',
    ].filter(Boolean)
    if (problems.length) throw new Error(`Mainnet deployment refused: ${problems.join('; ')}.`)
  }
  const listed = (await locker.listedTokens()) as string[]
  const tokens = await Promise.all(listed.map(async (address) => {
    const erc = new Contract(address, [...ERC20_ABI, 'function name() view returns (string)'], provider)
    const [cfg, symbol, name] = await Promise.all([locker.tokenConfig(address), erc.symbol() as Promise<string>, erc.name() as Promise<string>])
    return { address: getAddress(address), symbol, name, decimals: Number(cfg.decimals), unit: cfg.unitAmount.toString(), cap: cfg.maxTotalLocked.toString(), riskClass: Number(cfg.riskClass), provisional: network !== 'mainnet' }
  }))
  const manifest: Manifest = {
    environment: network,
    label: d.label ?? (network === 'mainnet' ? 'Robinhood Chain mainnet. Real tokens and real WIF.' : 'Robinhood Chain testnet. TEST tokens only; nothing here has value.'),
    chainId: d.chainId,
    upstream: { name: network === 'mainnet' ? MAINNET.name : (d.label ?? TESTNET.name), chainId: d.chainId, forkBlock: d.block, forkTimestamp: 0 },
    startBlock: d.block,
    contracts: { locker: d.locker, challenges: d.challenges, rewards: d.rewards, wif: d.wif, ownerSafe: d.ownerSafe, guardianSafe: d.guardianSafe },
    tokens,
    params: { minHoldSeconds: d.minHoldSeconds, provisional: network !== 'mainnet', note: network === 'mainnet' ? 'Mainnet parameters.' : 'Testnet parameters.' },
    demoAccounts: { faucet: ZERO, sponsorBot: ZERO, lockerBots: [] },
    seeds: [],
    features: { faucet: false, timeControl: false, faucetWif: '0', faucetEth: '0', maxTimeAdvance: 0 },
    createdAt: new Date().toISOString(),
  }
  const health = async () => {
    const b = await provider.getBlock('latest')
    return { ok: true, block: b?.number ?? 0, timestamp: b?.timestamp ?? 0, chainNow: b?.timestamp ?? Math.floor(Date.now() / 1000) }
  }
  return { deployment: d, manifest, provider, rpc, health }
}
