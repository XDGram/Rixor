// Boots the visitor's isolated demo chain: loads the Robinhood Chain snapshot, then either replays the
// visitor's saved journal from IndexedDB or performs first-visit setup. Exposes the demo faucet and the
// demo clock. Everything runs on this device; there is no server.
import { Wallet } from 'ethers'
import type { Manifest } from '../env'
import { SimChain, type Op, type Snapshot } from './engine'
import { idbDelete, idbGet, idbSet, persistent } from './idb'
import { SimProvider } from './provider'
import { DEMO_PARAMS, faucetTransfer, seedChain } from './seed'

export const SIM_CHAIN_ID = 466399
const STATE_KEY = 'state-v1'
const MAX_TIME_ADVANCE = 31 * 86400

type Saved = { snapshotBlockHash: string; manifest: Manifest; ops: Op[]; clockOffset: number; walletKey?: string; createdAt: string }

export type Boot = { stage: 'snapshot' | 'replay' | 'setup' | 'ready'; detail: string; progress?: number }

export type SimSession = {
  chain: SimChain
  provider: SimProvider
  manifest: Manifest
  snapshot: Snapshot
  persistent: boolean
  resumed: boolean
  bootMs: number
  health: () => Promise<{ ok: boolean; block: number; timestamp: number; chainNow: number }>
  faucet: (address: string) => Promise<{ wif: string }>
  advance: (seconds: number) => Promise<{ chainNow: number }>
  walletKey: () => string | undefined
  createWalletKey: () => Promise<string>
  forgetWallet: () => Promise<void>
  reset: () => Promise<void>
}

export async function loadSnapshot(url = '/demo/robinhood-snapshot.json'): Promise<Snapshot> {
  const res = await fetch(url, { cache: 'force-cache' })
  if (!res.ok) throw new Error(`Could not load the Robinhood Chain snapshot (${res.status})`)
  return res.json()
}

export async function bootSim(onBoot?: (b: Boot) => void, snapshotOverride?: Snapshot): Promise<SimSession> {
  const t0 = performance.now()
  onBoot?.({ stage: 'snapshot', detail: 'Loading the Robinhood Chain mainnet snapshot' })
  const snapshot = snapshotOverride ?? (await loadSnapshot())
  const chain = await SimChain.create(snapshot, SIM_CHAIN_ID)
  const provider = new SimProvider(chain)

  let saved = await idbGet<Saved>(STATE_KEY)
  if (saved && saved.snapshotBlockHash !== snapshot.source.blockHash) {
    // The app now ships a newer snapshot; a journal from the old one cannot be replayed faithfully.
    await idbDelete(STATE_KEY)
    saved = undefined
  }

  let manifest: Manifest
  let resumed = false
  if (saved) {
    onBoot?.({ stage: 'replay', detail: `Re-executing ${saved.ops.length} saved transactions`, progress: 0 })
    chain.clockOffset = saved.clockOffset
    await chain.replay(saved.ops, (done, total) => onBoot?.({ stage: 'replay', detail: `Re-executing saved transactions (${done}/${total})`, progress: done / total }))
    manifest = saved.manifest
    resumed = true
  } else {
    onBoot?.({ stage: 'setup', detail: 'Deploying the Gate 1 contracts in your browser' })
    const seeded = await seedChain(chain, provider, snapshot, (label) => onBoot?.({ stage: 'setup', detail: label }))
    manifest = {
      environment: 'browser-evm',
      label: 'Isolated browser EVM simulation of Robinhood Chain mainnet state. Not live Robinhood Chain. Assets here have no value.',
      chainId: SIM_CHAIN_ID,
      upstream: { name: snapshot.source.name, chainId: snapshot.source.chainId, forkBlock: snapshot.source.block, forkTimestamp: snapshot.source.timestamp },
      startBlock: 0,
      contracts: seeded.contracts,
      tokens: [{ address: seeded.contracts.wif, symbol: 'WIF', name: 'World is Flat', decimals: 18, unit: (BigInt(DEMO_PARAMS.wifUnit) * 10n ** 18n).toString(), cap: (BigInt(DEMO_PARAMS.wifCap) * 10n ** 18n).toString(), provisional: true }],
      params: { minHoldSeconds: DEMO_PARAMS.minHoldSeconds, provisional: true, note: 'Demo parameters only. Production unit sizes, caps and budgets are not approved.' },
      demoAccounts: { faucet: snapshot.reserves[0], sponsorBot: seeded.sponsorBot, lockerBots: seeded.lockerBots },
      seeds: seeded.seeds,
      features: { faucet: true, timeControl: true, faucetWif: DEMO_PARAMS.faucetWif, faucetEth: '0', maxTimeAdvance: MAX_TIME_ADVANCE },
      createdAt: new Date().toISOString(),
      safeVersion: seeded.safeVersion,
    }
    saved = { snapshotBlockHash: snapshot.source.blockHash, manifest, ops: [...chain.ops], clockOffset: 0, createdAt: manifest.createdAt }
    await idbSet(STATE_KEY, saved)
  }
  if (chain.missingDependencies.size) {
    throw new Error(`Snapshot is missing contract code for: ${[...chain.missingDependencies].join(', ')}`)
  }

  // Persist every new operation (debounced so a burst of transactions writes once).
  let timer: number | undefined
  const state: Saved = saved
  const flush = () => { state.ops = [...chain.ops]; state.clockOffset = chain.clockOffset; void idbSet(STATE_KEY, state) }
  const schedule = () => { if (timer !== undefined) clearTimeout(timer); timer = setTimeout(flush, 150) as unknown as number }
  chain.onOp = schedule

  onBoot?.({ stage: 'ready', detail: 'Ready' })
  return {
    chain, provider, manifest, snapshot, persistent, resumed, bootMs: Math.round(performance.now() - t0),
    health: async () => ({ ok: true, block: chain.head.number, timestamp: chain.head.timestamp, chainNow: chain.now() }),
    faucet: async (address) => {
      await faucetTransfer(chain, provider, snapshot, address, DEMO_PARAMS.faucetWif)
      return { wif: DEMO_PARAMS.faucetWif }
    },
    advance: async (seconds) => {
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > MAX_TIME_ADVANCE) throw new Error('Choose between one minute and 31 days.')
      chain.clockOffset += seconds
      await chain.apply({ k: 'mine', ts: chain.now() })
      flush()
      return { chainNow: chain.now() }
    },
    walletKey: () => state.walletKey,
    createWalletKey: async () => {
      // A throwaway key generated on this device for this simulation only. It is never displayed or sent anywhere.
      state.walletKey = state.walletKey ?? Wallet.createRandom().privateKey
      flush()
      return state.walletKey
    },
    forgetWallet: async () => { delete state.walletKey; flush() },
    reset: async () => { if (timer !== undefined) clearTimeout(timer); await idbDelete(STATE_KEY) },
  }
}
