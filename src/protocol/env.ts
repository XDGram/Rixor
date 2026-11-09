// Shared types for the demo environment. The active environment is the isolated in-browser EVM
// (src/protocol/sim): a private chain on the visitor's device, started from a snapshot of Robinhood Chain
// mainnet state. Apart from read-only wallet detection (src/protocol/wallet.ts), nothing in this app talks to
// Robinhood Chain, and nothing ever sends a real transaction.

export type Manifest = {
  environment: 'fork-demo' | 'browser-evm' | 'testnet' | 'mainnet'
  label: string
  chainId: number
  upstream: { name: string; chainId: number; forkBlock: number; forkTimestamp: number }
  startBlock: number
  contracts: { locker: string; challenges: string; rewards: string; wif: string; ownerSafe: string; guardianSafe: string }
  tokens: { address: string; symbol: string; name: string; decimals: number; unit: string; cap: string; riskClass: number; provisional: boolean }[]
  params: { minHoldSeconds: number; provisional: boolean; note: string }
  demoAccounts: { faucet: string; sponsorBot: string; lockerBots: string[] }
  seeds: number[]
  features: { faucet: boolean; timeControl: boolean; faucetWif: string; faucetEth: string; maxTimeAdvance: number }
  createdAt: string
  safeVersion?: string
}

const safeStorage = {
  get(key: string) { try { return window.localStorage.getItem(key) } catch { return null } },
  set(key: string, value: string) { try { window.localStorage.setItem(key, value) } catch { /* private mode */ } },
  remove(key: string) { try { window.localStorage.removeItem(key) } catch { /* private mode */ } },
}
export { safeStorage }
