// Read-only connection to the visitor's real Robinhood Chain wallet, for holdings detection.
//
// - Discovers browser wallets with EIP-6963 (falls back to window.ethereum).
// - Asks only for the account address (eth_requestAccounts). It never asks for a signature or a transaction,
//   never asks for a private key or seed phrase, and sends nothing to any network except read-only RPC calls.
// - Detects balances of the tokens in TOKEN_LIST with ONE Multicall3 aggregate3 call to the public RPC.
//
// Limitation: tokens that are not in the token list are not detected (the public RPC cannot search transfer
// logs by wallet). A future indexer option (e.g. a holdings API behind a server-side key) could show every
// token; it would be display-only and could never grant support.
import { Contract, Interface, JsonRpcProvider } from 'ethers'
import { ROBINHOOD_CHAIN, TOKEN_LIST, type ListStatus, type ListedToken } from './tokenlist'

export type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: (...a: unknown[]) => void) => void; removeListener?: (e: string, f: (...a: unknown[]) => void) => void }
export type WalletOption = { id: string; name: string; icon?: string; provider: Eip1193 }

/** EIP-6963 discovery. Resolves after a short window with every wallet that announced itself. */
export function discoverWallets(timeoutMs = 400): Promise<WalletOption[]> {
  return new Promise((resolve) => {
    const found = new Map<string, WalletOption>()
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent).detail as { info?: { uuid: string; name: string; icon?: string }; provider?: Eip1193 }
      if (detail?.info?.uuid && detail.provider) found.set(detail.info.uuid, { id: detail.info.uuid, name: detail.info.name, icon: detail.info.icon, provider: detail.provider })
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    window.setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
      const injected = (window as unknown as { ethereum?: Eip1193 }).ethereum
      if (found.size === 0 && injected) found.set('injected', { id: 'injected', name: 'Browser wallet', provider: injected })
      resolve([...found.values()])
    }, timeoutMs)
  })
}

export async function requestAccount(w: WalletOption): Promise<{ address: string; chainId: number }> {
  const accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[]
  if (!accounts?.length) throw new Error('The wallet did not share an account.')
  const chainHex = (await w.provider.request({ method: 'eth_chainId' })) as string
  return { address: accounts[0], chainId: Number(chainHex) }
}

/** Switches the wallet to `chain`, adding the network first if the wallet does not know it. Mobile wallets report an
 *  unknown chain in different ways (4902, -32603, a nested `data.originalError.code`, or a plain message), and some
 *  add a chain without switching to it, so: any error other than the user's rejection (4001) leads to
 *  `wallet_addEthereumChain`, and the result is confirmed with `eth_chainId` (switching again if needed). */
export async function switchToChain(w: WalletOption, chain: { chainId: number; name: string; rpc: string }) {
  const hex = '0x' + chain.chainId.toString(16)
  const switchTo = () => w.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  const onChain = async () => Number((await w.provider.request({ method: 'eth_chainId' })) as string) === chain.chainId
  try {
    await switchTo()
  } catch (e) {
    const err = e as { code?: number; data?: { originalError?: { code?: number } } }
    if (err?.code === 4001 || err?.data?.originalError?.code === 4001) throw e
    await w.provider.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: hex, chainName: chain.name, rpcUrls: [chain.rpc], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }],
    })
    if (!(await onChain())) await switchTo()
  }
  if (!(await onChain())) throw new Error(`Your wallet is not on ${chain.name} (chain ${chain.chainId}). Switch network in the wallet and try again.`)
}

export const switchToRobinhood = (w: WalletOption) =>
  switchToChain(w, { chainId: ROBINHOOD_CHAIN.chainId, name: ROBINHOOD_CHAIN.name, rpc: ROBINHOOD_CHAIN.rpc })

export type Holding = ListedToken & { balance: bigint; group: 'supported' | 'under_review' | 'unsupported' | 'reward' }
export type Holdings = { address: string; block: number; eth: bigint; tokens: Holding[]; supportedSource: string }

const MULTICALL = new Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)',
  'function getEthBalance(address) view returns (uint256)',
])
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)'])
const LOCKER = ['function listedTokens() view returns (address[])', 'function locksEnabled(address) view returns (bool)']

/**
 * Reads the wallet's balances for every token-list entry (one aggregate3 call), then classifies each token.
 * `lockerAddress`: the production Locker on Robinhood Chain, if one is deployed. Without it, no token can be
 * shown as supported on mainnet.
 */
export async function detectHoldings(address: string, lockerAddress?: string): Promise<Holdings> {
  const rpc = new JsonRpcProvider(ROBINHOOD_CHAIN.rpc, ROBINHOOD_CHAIN.chainId, { staticNetwork: true, batchMaxCount: 1 })
  // Note: on Arbitrum chains Multicall3.getBlockNumber() returns the L1 block, so the L2 block comes from the RPC.
  const calls = [
    { target: ROBINHOOD_CHAIN.multicall3, allowFailure: false, callData: MULTICALL.encodeFunctionData('getEthBalance', [address]) },
    ...TOKEN_LIST.map((t) => ({ target: t.address, allowFailure: true, callData: ERC20.encodeFunctionData('balanceOf', [address]) })),
  ]
  const block = await rpc.getBlockNumber()
  const raw = await rpc.call({ to: ROBINHOOD_CHAIN.multicall3, data: MULTICALL.encodeFunctionData('aggregate3', [calls]), blockTag: block })
  const [results] = MULTICALL.decodeFunctionResult('aggregate3', raw) as unknown as [{ success: boolean; returnData: string }[]]
  const eth = BigInt(results[0].returnData)

  let supported = new Set<string>()
  let supportedSource = 'No Rixor Locker is deployed on Robinhood Chain yet, so no token is supported there.'
  if (lockerAddress && (await rpc.getCode(lockerAddress)) === '0x') {
    supportedSource = `The configured Locker ${lockerAddress} has no code on Robinhood Chain, so no token is shown as supported.`
  } else if (lockerAddress) {
    const locker = new Contract(lockerAddress, LOCKER, rpc)
    const listed = (await locker.listedTokens()) as string[]
    const enabled = await Promise.all(listed.map((a) => locker.locksEnabled(a) as Promise<boolean>))
    supported = new Set(listed.filter((_, i) => enabled[i]).map((a) => a.toLowerCase()))
    supportedSource = `Read from the Rixor Locker at ${lockerAddress}.`
  }

  const tokens: Holding[] = TOKEN_LIST.map((t, i) => {
    const r = results[i + 1]
    const balance = r.success && r.returnData.length >= 66 ? BigInt(r.returnData.slice(0, 66)) : 0n
    const group: Holding['group'] = t.status === 'reward' ? 'reward' : supported.has(t.address.toLowerCase()) ? 'supported' : (t.status as Exclude<ListStatus, 'reward'>)
    return { ...t, balance, group }
  })
  return { address, block, eth, tokens, supportedSource }
}
