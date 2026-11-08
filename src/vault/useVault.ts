import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VAULT_ADDRESS, VAULT_NETWORK, createOnchainActions, readOnchain } from './onchain'
import { readSimulation, simulationActions, subscribeSimulation } from './simulation'
import type { VaultActions, VaultMode, VaultState } from './model'

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

export type TxState = {
  key: string
  status: 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'
  simulated: boolean
  step?: string
  hash?: string
  error?: string
}

const emptyState = (mode: VaultMode): VaultState => ({
  mode,
  status: 'loading',
  tokenSymbol: mode === 'simulation' ? 'WIF' : '…',
  now: Math.floor(Date.now() / 1000),
  price: { value: null, fresh: false, updatedAt: 0, source: '' },
  stats: { totalLocked: 0, openLocks: 0, totalBurned: 0, poolFromFees: 0, poolFunded: 0, rewardsPaid: 0, completedLocks: 0 },
  walletBalance: 0,
  positions: [],
  challenges: [],
})

export const onchainAvailable = Boolean(VAULT_ADDRESS)

export function useVault(options: { mode: VaultMode; walletAddress: string | null; provider: Provider | null; chainId: number | null }) {
  const { mode, walletAddress, provider, chainId } = options
  const [state, setState] = useState<VaultState>(() => (mode === 'simulation' ? readSimulation() : emptyState(mode)))
  const [tx, setTx] = useState<TxState | null>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const refresh = useCallback(async () => {
    if (mode === 'simulation') {
      setState(readSimulation())
      return
    }
    if (!VAULT_ADDRESS) return
    try {
      const next = await readOnchain(walletAddress)
      if (modeRef.current === 'onchain') setState(next)
    } catch (error) {
      if (modeRef.current === 'onchain') {
        setState((current) => ({ ...current, status: 'error', error: error instanceof Error ? error.message : String(error) }))
      }
    }
  }, [mode, walletAddress])

  useEffect(() => {
    setState(mode === 'simulation' ? readSimulation() : emptyState(mode))
    setTx(null)
    void refresh()
    const interval = window.setInterval(() => void refresh(), mode === 'simulation' ? 1_000 : 20_000)
    const unsubscribe = mode === 'simulation' ? subscribeSimulation(() => setState(readSimulation())) : () => undefined
    return () => {
      window.clearInterval(interval)
      unsubscribe()
    }
  }, [mode, refresh])

  const onWrongChain = mode === 'onchain' && chainId !== VAULT_NETWORK.id
  const canTransact = mode === 'simulation' || (Boolean(VAULT_ADDRESS) && Boolean(walletAddress && provider) && !onWrongChain)

  const actions = useMemo<VaultActions>(() => {
    const wrap = <A extends unknown[]>(key: string, run: (...args: A) => Promise<boolean>) => async (...args: A) => {
      const simulated = modeRef.current === 'simulation'
      setTx({ key, status: simulated ? 'pending' : 'awaiting-wallet', simulated })
      try {
        const ok = await run(...args)
        setTx((current) => ({ ...(current ?? { key, simulated }), key, simulated, status: 'confirmed' }))
        await refresh()
        return ok
      } catch (error) {
        setTx((current) => ({ ...(current ?? { key, simulated }), key, simulated, status: 'failed', error: error instanceof Error ? error.message : String(error) }))
        return false
      }
    }

    if (mode === 'simulation') {
      return {
        lock: wrap('lock', simulationActions.lock),
        exit: (lockId, maxFee) => wrap(`exit:${lockId}`, simulationActions.exit)(lockId, maxFee),
        joinChallenge: (cid, lockId) => wrap(`challenge:${cid}`, simulationActions.joinChallenge)(cid, lockId),
        finalizeChallenge: (cid) => wrap(`challenge:${cid}`, simulationActions.finalizeChallenge)(cid),
        qualify: (cid) => wrap(`challenge:${cid}`, simulationActions.qualify)(cid),
        claimChallenge: (cid) => wrap(`challenge:${cid}`, simulationActions.claimChallenge)(cid),
        refundChallenge: (cid) => wrap(`challenge:${cid}`, simulationActions.refundChallenge)(cid),
      }
    }

    const unavailable = () => Promise.reject(new Error('Connect a wallet on Robinhood Chain Testnet first.'))
    const live = provider && walletAddress && VAULT_ADDRESS
      ? createOnchainActions(provider, walletAddress, (update) => setTx((current) => current && { ...current, ...update }))
      : null
    const pick = <K extends keyof VaultActions>(name: K) => (live ? live[name] : unavailable) as VaultActions[K]
    return {
      lock: wrap('lock', pick('lock')),
      exit: (lockId, maxFee) => wrap(`exit:${lockId}`, pick('exit'))(lockId, maxFee),
      joinChallenge: (cid, lockId) => wrap(`challenge:${cid}`, pick('joinChallenge'))(cid, lockId),
      finalizeChallenge: (cid) => wrap(`challenge:${cid}`, pick('finalizeChallenge'))(cid),
      qualify: (cid) => wrap(`challenge:${cid}`, pick('qualify'))(cid),
      claimChallenge: (cid) => wrap(`challenge:${cid}`, pick('claimChallenge'))(cid),
      refundChallenge: (cid) => wrap(`challenge:${cid}`, pick('refundChallenge'))(cid),
    }
  }, [mode, provider, walletAddress, refresh])

  return { state, actions, tx, clearTx: () => setTx(null), refresh, canTransact, onWrongChain }
}

/** Real onchain totals and challenges for the landing page. Null when no vault is deployed. */
export function useVaultSummary() {
  const [summary, setSummary] = useState<VaultState | null>(null)
  useEffect(() => {
    if (!VAULT_ADDRESS) return
    let cancelled = false
    const load = () => readOnchain(null).then((next) => { if (!cancelled) setSummary(next) }).catch(() => undefined)
    void load()
    const interval = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])
  return summary
}
