// Testnet mode: real transactions, signed by the visitor's own wallet, against a Rixor deployment on Robinhood
// Chain testnet. Available only when a deployment manifest is published at /testnet/deployment.json (or the URL in
// VITE_RIXOR_TESTNET_MANIFEST). It refuses Robinhood Chain mainnet: this mode never touches real assets.
import { Contract, JsonRpcProvider, getAddress, isAddress } from 'ethers'
import { LOCKER_ABI, ERC20_ABI } from './chain'
import type { Manifest } from './env'

export const TESTNET = { chainId: 46630, name: 'Robinhood Chain Testnet', rpc: 'https://rpc.testnet.chain.robinhood.com' }
const MAINNET_ID = 4663
const ZERO = '0x0000000000000000000000000000000000000000'

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
export async function loadTestnetDeployment(): Promise<TestnetDeployment | null> {
  const url = import.meta.env.VITE_RIXOR_TESTNET_MANIFEST || '/testnet/deployment.json'
  let d: TestnetDeployment
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null
    d = await res.json()
  } catch { return null }
  if (Number(d.chainId) === MAINNET_ID) throw new Error('The testnet manifest points at Robinhood Chain mainnet. Testnet mode refuses mainnet.')
  for (const k of ['locker', 'rewards', 'challenges', 'wif', 'ownerSafe', 'guardianSafe'] as const) {
    if (!isAddress(d[k])) throw new Error(`Testnet manifest: invalid ${k} address.`)
  }
  return { ...d, chainId: Number(d.chainId), block: Number(d.block) }
}

export type TestnetSession = {
  deployment: TestnetDeployment
  manifest: Manifest
  provider: JsonRpcProvider
  rpc: string
  health: () => Promise<{ ok: boolean; block: number; timestamp: number; chainNow: number }>
}

export async function bootTestnet(d: TestnetDeployment): Promise<TestnetSession> {
  const rpc = d.rpc || import.meta.env.VITE_RIXOR_TESTNET_RPC || TESTNET.rpc
  const provider = new JsonRpcProvider(rpc, d.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 })
  const chainId = Number((await provider.getNetwork()).chainId)
  if (chainId === MAINNET_ID || chainId !== d.chainId) throw new Error(`Testnet RPC reports chain ${chainId}, expected ${d.chainId}.`)
  const locker = new Contract(d.locker, LOCKER_ABI, provider)
  if ((await provider.getCode(d.locker)) === '0x') throw new Error('No Rixor Locker at the manifest address on this network.')
  const listed = (await locker.listedTokens()) as string[]
  const tokens = await Promise.all(listed.map(async (address) => {
    const erc = new Contract(address, [...ERC20_ABI, 'function name() view returns (string)'], provider)
    const [cfg, symbol, name] = await Promise.all([locker.tokenConfig(address), erc.symbol() as Promise<string>, erc.name() as Promise<string>])
    return { address: getAddress(address), symbol, name, decimals: Number(cfg.decimals), unit: cfg.unitAmount.toString(), cap: cfg.maxTotalLocked.toString(), riskClass: Number(cfg.riskClass), provisional: true }
  }))
  const manifest: Manifest = {
    environment: 'testnet',
    label: d.label ?? 'Robinhood Chain testnet. TEST tokens only; nothing here has value.',
    chainId: d.chainId,
    upstream: { name: d.label ?? TESTNET.name, chainId: d.chainId, forkBlock: d.block, forkTimestamp: 0 },
    startBlock: d.block,
    contracts: { locker: d.locker, challenges: d.challenges, rewards: d.rewards, wif: d.wif, ownerSafe: d.ownerSafe, guardianSafe: d.guardianSafe },
    tokens,
    params: { minHoldSeconds: d.minHoldSeconds, provisional: true, note: 'Testnet parameters.' },
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
