// Official $WIF integration. READ-ONLY: Rixor never sends transactions to mainnet.
//
// Verified onchain (Robinhood Chain mainnet, chain 4663, RPC eth_chainId = 0x1237):
//   address  0x5173b8eA6923c2d40267890D45C46a3480954773
//   name     "World is Flat", symbol "WIF", 18 decimals
//   exposes  burn(uint256) and burnFrom; no owner(), mint(), pause() or proxy slot
// Not available on Robinhood Chain Testnet (no contract code at this address on chain 46630).
import { Interface, formatUnits } from 'ethers'
import { useEffect, useState } from 'react'

export const ROBINHOOD_MAINNET = {
  id: 4663,
  hexId: '0x1237',
  name: 'Robinhood Chain',
  shortName: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robin.etherscan.io',
} as const

export const WIF_ADDRESS = '0x5173b8eA6923c2d40267890D45C46a3480954773'
export const WIF_DECIMALS = 18

const erc20 = new Interface(['function balanceOf(address) view returns (uint256)'])

const mainnetCall = async (to: string, data: string) => {
  const response = await fetch(ROBINHOOD_MAINNET.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  })
  const payload = await response.json() as { result?: string; error?: { message?: string } }
  if (!response.ok || payload.error || !payload.result) throw new Error(payload.error?.message || 'Robinhood Chain RPC error')
  return payload.result
}

/** Live, read-only $WIF balance of an address on Robinhood Chain mainnet. */
export const useWifBalance = (address: string | null) => {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; balance: number }>({ status: 'idle', balance: 0 })

  useEffect(() => {
    if (!address) {
      setState({ status: 'idle', balance: 0 })
      return
    }
    let cancelled = false
    const load = () => mainnetCall(WIF_ADDRESS, erc20.encodeFunctionData('balanceOf', [address]))
      .then((result) => {
        const [raw] = erc20.decodeFunctionResult('balanceOf', result)
        if (!cancelled) setState({ status: 'ready', balance: Number(formatUnits(raw as bigint, WIF_DECIMALS)) })
      })
      .catch(() => { if (!cancelled) setState((current) => ({ ...current, status: 'error' })) })
    setState((current) => ({ ...current, status: current.status === 'ready' ? 'ready' : 'loading' }))
    void load()
    const interval = window.setInterval(load, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [address])

  return state
}

export const shortAddr = (address: string) => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address)
export const explorerAddress = (address: string) => `${ROBINHOOD_MAINNET.explorerUrl}/address/${address}`
