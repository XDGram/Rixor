// Where the app reads chain data from. In this phase the ONLY supported environment is the Rixor fork demo:
// a private copy of Robinhood Chain mainnet state served by the demo backend (demo/fork-backend).
// Nothing in this app talks to Robinhood Chain mainnet or sends a mainnet transaction.

export type Manifest = {
  environment: 'fork-demo'
  label: string
  chainId: number
  upstream: { name: string; chainId: number; forkBlock: number; forkTimestamp: number }
  startBlock: number
  contracts: { locker: string; challenges: string; wif: string; ownerSafe: string; guardianSafe: string }
  tokens: { address: string; symbol: string; name: string; decimals: number; unit: string; cap: string; provisional: boolean }[]
  params: { minHoldSeconds: number; provisional: boolean; note: string }
  demoAccounts: { faucet: string; sponsorBot: string; lockerBots: string[] }
  seeds: number[]
  features: { faucet: boolean; timeControl: boolean; faucetWif: string; faucetEth: string; maxTimeAdvance: number }
  createdAt: string
}

const BACKEND_KEY = 'rixor.demo.backend'

const safeStorage = {
  get(key: string) { try { return window.localStorage.getItem(key) } catch { return null } },
  set(key: string, value: string) { try { window.localStorage.setItem(key, value) } catch { /* private mode */ } },
  remove(key: string) { try { window.localStorage.removeItem(key) } catch { /* private mode */ } },
}
export { safeStorage }

const isAcceptableUrl = (value: string) => {
  try {
    const u = new URL(value)
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

/**
 * The backend URL comes from, in order: `?backend=` (remembered on this device), the build-time
 * VITE_RIXOR_FORK_BACKEND, then nothing. Only https URLs (or localhost for development) are accepted.
 */
export function resolveBackendUrl(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get('backend')
  if (fromQuery && isAcceptableUrl(fromQuery)) {
    const clean = fromQuery.replace(/\/+$/, '')
    safeStorage.set(BACKEND_KEY, clean)
    return clean
  }
  const stored = safeStorage.get(BACKEND_KEY)
  if (stored && isAcceptableUrl(stored)) return stored
  const built = import.meta.env.VITE_RIXOR_FORK_BACKEND as string | undefined
  if (built && isAcceptableUrl(built)) return built.replace(/\/+$/, '')
  return null
}

export function rememberBackendUrl(url: string): boolean {
  if (!isAcceptableUrl(url)) return false
  safeStorage.set(BACKEND_KEY, url.replace(/\/+$/, ''))
  return true
}

export function forgetBackendUrl() {
  safeStorage.remove(BACKEND_KEY)
}

export async function fetchManifest(backend: string): Promise<Manifest> {
  const res = await fetch(`${backend}/manifest`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Demo backend answered ${res.status}`)
  const m = (await res.json()) as Manifest
  if (m.environment !== 'fork-demo') throw new Error('This backend is not a Rixor fork demo.')
  if (m.chainId === 4663 || m.chainId === 46630) throw new Error('Refusing a demo backend that uses a real Robinhood Chain id.')
  return m
}

export type Health = { ok: boolean; block: number; timestamp: number; chainNow: number }

export async function fetchHealth(backend: string): Promise<Health> {
  const res = await fetch(`${backend}/health`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Demo backend answered ${res.status}`)
  return res.json()
}

export async function requestFaucet(backend: string, address: string) {
  const res = await fetch(`${backend}/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Faucet answered ${res.status}`)
  return body as { wif: string; eth: string; txHash: string }
}

export async function advanceDemoTime(backend: string, seconds: number) {
  const res = await fetch(`${backend}/time/advance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds }) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Time control answered ${res.status}`)
  return body as { chainNow: number }
}
