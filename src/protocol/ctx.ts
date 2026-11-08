import type { JsonRpcApiProvider } from 'ethers'
import type { ConnectedWallet, Contracts } from './chain'
import type { useTx } from './components'
import type { Manifest } from './env'
import { shortAddr } from './model'
import type { Snapshot } from './useProtocol'

export type Route =
  | { name: 'explore' }
  | { name: 'token'; address: string }
  | { name: 'lock' }
  | { name: 'portfolio' }
  | { name: 'challenge'; id: number }
  | { name: 'create' }
  | { name: 'activity' }

export type Ctx = {
  manifest: Manifest
  provider: JsonRpcApiProvider
  snapshot: Snapshot
  now: number
  wallet: ConnectedWallet | null
  write: Contracts | null
  tx: ReturnType<typeof useTx>
  go: (route: Route) => void
  refresh: () => Promise<void>
  openWallet: () => void
  label: (address: string) => string
}

export function routeToHash(r: Route): string {
  switch (r.name) {
    case 'token': return `#/token/${r.address}`
    case 'challenge': return `#/challenge/${r.id}`
    default: return `#/${r.name}`
  }
}

export function hashToRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/')
  switch (parts[0]) {
    case 'token': return parts[1] ? { name: 'token', address: parts[1] } : { name: 'explore' }
    case 'challenge': return Number(parts[1]) > 0 ? { name: 'challenge', id: Number(parts[1]) } : { name: 'explore' }
    case 'lock': return { name: 'lock' }
    case 'portfolio': return { name: 'portfolio' }
    case 'create': return { name: 'create' }
    case 'activity': return { name: 'activity' }
    default: return { name: 'explore' }
  }
}

export function makeLabeler(manifest: Manifest, me: string | null) {
  const known = new Map<string, string>()
  manifest.demoAccounts.lockerBots.forEach((a, i) => known.set(a.toLowerCase(), `Demo bot ${i + 1}`))
  known.set(manifest.demoAccounts.sponsorBot.toLowerCase(), 'Demo sponsor')
  known.set(manifest.demoAccounts.faucet.toLowerCase(), 'Demo faucet')
  known.set(manifest.contracts.ownerSafe.toLowerCase(), 'Demo owner Safe')
  known.set(manifest.contracts.guardianSafe.toLowerCase(), 'Demo guardian Safe')
  if (manifest.contracts.rewards) known.set(manifest.contracts.rewards.toLowerCase(), 'Rixor Rewards')
  known.delete('0x0000000000000000000000000000000000000000') // unused demo-account fields (testnet mode)
  return (address: string) => {
    const a = address.toLowerCase()
    if (me && a === me.toLowerCase()) return 'You'
    return known.get(a) ?? shortAddr(address)
  }
}
