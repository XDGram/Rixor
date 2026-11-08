// Real RixorConvictionVault reads and writes. Testnet first: defaults to Robinhood Chain Testnet.
import { Interface, decodeBytes32String, formatUnits, getAddress, isAddress, parseUnits } from 'ethers'
import vaultArtifact from '../contracts/RixorConvictionVaultArtifact.json'
import {
  roiBps,
  type ChallengeView,
  type ExitReason,
  type LockInput,
  type Position,
  type Tier,
  type VaultState,
} from './model'

const env = import.meta.env
const configuredVault = String(env.VITE_RIXOR_VAULT_ADDRESS ?? '').trim()

export const VAULT_NETWORK = {
  id: Number(env.VITE_RIXOR_VAULT_CHAIN_ID ?? 46630) || 46630,
  name: 'Robinhood Chain Testnet',
  rpcUrl: String(env.VITE_RIXOR_VAULT_RPC_URL ?? '').trim() || 'https://rpc.testnet.chain.robinhood.com',
  explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
}
/** Empty until a testnet deployment is configured. */
export const VAULT_ADDRESS = isAddress(configuredVault) ? getAddress(configuredVault) : ''
/** True unless the deployment explicitly says it uses a real oracle. */
export const VAULT_USES_MOCK_ORACLE = String(env.VITE_RIXOR_VAULT_MOCK_ORACLE ?? 'true') !== 'false'

export const vaultInterface = new Interface(vaultArtifact.abi)
const erc20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])

let rpcId = 0
const rpc = async <T,>(method: string, params: unknown[]): Promise<T> => {
  const response = await fetch(VAULT_NETWORK.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  if (!response.ok) throw new Error(`RPC error ${response.status}`)
  const payload = await response.json() as { result?: T; error?: { message?: string } }
  if (payload.error) throw new Error(payload.error.message || 'RPC error')
  return payload.result as T
}

const call = async (iface: Interface, to: string, fn: string, args: unknown[] = []) => {
  const result = await rpc<string>('eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, 'latest'])
  return iface.decodeFunctionResult(fn, result)
}

let tokenMeta: { address: string; symbol: string; decimals: number } | null = null
const loadToken = async () => {
  if (tokenMeta) return tokenMeta
  const [address] = await call(vaultInterface, VAULT_ADDRESS, 'token')
  const [[symbol], [decimals]] = await Promise.all([call(erc20, address, 'symbol'), call(erc20, address, 'decimals')])
  tokenMeta = { address: String(address), symbol: String(symbol), decimals: Number(decimals) }
  return tokenMeta
}

export const readOnchain = async (user: string | null): Promise<VaultState> => {
  const token = await loadToken()
  const units = (value: bigint) => Number(formatUnits(value, token.decimals))
  const price18 = (value: bigint) => Number(formatUnits(value, 18))

  const [block, [priceRaw, fresh, updatedAt], ...statValues] = await Promise.all([
    rpc<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false]),
    call(vaultInterface, VAULT_ADDRESS, 'currentPrice'),
    ...['totalLocked', 'openLocks', 'totalBurned', 'totalFeesToPool', 'totalFunded', 'totalRewardsPaid', 'completedLocks', 'nextChallengeId']
      .map((fn) => call(vaultInterface, VAULT_ADDRESS, fn).then((result) => result[0] as bigint)),
  ])
  const [totalLocked, openLocks, totalBurned, feesToPool, funded, rewardsPaid, completed, nextChallengeId] = statValues
  const now = Number.parseInt(block.timestamp, 16)
  const price = { value: fresh ? price18(priceRaw as bigint) : null, fresh: Boolean(fresh), updatedAt: Number(updatedAt), source: VAULT_USES_MOCK_ORACLE ? 'Mock testnet oracle (set by hand)' : 'Onchain oracle' }

  let walletBalance = 0
  let positions: Position[] = []
  if (user) {
    const [[balance], [ids]] = await Promise.all([
      call(erc20, token.address, 'balanceOf', [user]),
      call(vaultInterface, VAULT_ADDRESS, 'getOwnerLockIds', [user]),
    ])
    walletBalance = units(balance as bigint)
    const rows = await Promise.all((ids as bigint[]).map(async (id) => {
      const record = await call(vaultInterface, VAULT_ADDRESS, 'locks', [id])
      if (!record.open) return null
      const [status, [reward]] = await Promise.all([
        call(vaultInterface, VAULT_ADDRESS, 'exitStatus', [id]),
        call(vaultInterface, VAULT_ADDRESS, 'pendingReward', [id]),
      ])
      return {
        id: String(id),
        tier: Number(record.tier) as Tier,
        amount: units(record.amount as bigint),
        entryPrice: price18(record.entryPrice as bigint),
        startedAt: Number(record.startedAt),
        endsAt: Number(record.endsAt),
        roiTargetBps: Number(record.roiTargetBps),
        maxLossBps: Number(record.maxLossBps),
        pendingReward: units(reward as bigint),
        status: {
          reason: Number(status.reason) as ExitReason,
          feeBps: Number(status.feeBps),
          roiBps: status.priceFresh ? Number(status.roiBps) : null,
          priceFresh: Boolean(status.priceFresh),
        },
      } satisfies Position
    }))
    positions = rows.filter((row): row is Position => row !== null)
  }

  const firstChallenge = Math.max(1, Number(nextChallengeId) - 10)
  const challengeIds = Array.from({ length: Math.max(0, Number(nextChallengeId) - firstChallenge) }, (_, index) => BigInt(firstChallenge + index))
  const challenges = await Promise.all(challengeIds.map(async (id): Promise<ChallengeView> => {
    const [record, [participants], mine] = await Promise.all([
      call(vaultInterface, VAULT_ADDRESS, 'challenges', [id]),
      call(vaultInterface, VAULT_ADDRESS, 'getChallengeParticipants', [id]),
      user ? call(vaultInterface, VAULT_ADDRESS, 'entries', [id, user]) : Promise.resolve(null),
    ])
    const snapshot = price18(record.snapshotPrice as bigint)
    const ranking = await Promise.all((participants as string[]).slice(0, 50).map(async (who) => {
      const entry = await call(vaultInterface, VAULT_ADDRESS, 'entries', [id, who])
      const lock = await call(vaultInterface, VAULT_ADDRESS, 'locks', [entry.lockId])
      const held = Boolean(lock.open) || Number(lock.closedAt) >= Number(record.endsAt)
      const measure = record.finalized && Number(record.kind) === 1 ? snapshot : price.value
      return { who, amount: units(lock.amount as bigint), roiBps: roiBps(price18(lock.entryPrice as bigint), measure), held, isMe: user ? who.toLowerCase() === user.toLowerCase() : false }
    }))
    let title = ''
    try {
      title = decodeBytes32String(record.title as string)
    } catch {
      title = ''
    }
    return {
      id: String(id),
      title: title || `Challenge #${id}`,
      kind: Number(record.kind) as 0 | 1,
      minTier: Number(record.minTier) as Tier,
      minAmount: units(record.minAmount as bigint),
      roiTargetBps: Number(record.roiTargetBps),
      targetTotal: units(record.targetTotal as bigint),
      rewardPool: units(record.rewardPool as bigint),
      participants: Number(record.participants),
      committedTotal: units(record.committedTotal as bigint),
      joinBy: Number(record.joinBy),
      endsAt: Number(record.endsAt),
      claimEndsAt: Number(record.claimEndsAt),
      finalized: Boolean(record.finalized),
      refunded: Boolean(record.refunded),
      qualifiedCount: Number(record.qualifiedCount),
      qualifiedTotal: units(record.qualifiedTotal as bigint),
      snapshotPrice: snapshot,
      me: {
        lockId: mine && (mine.lockId as bigint) > 0n ? String(mine.lockId) : null,
        qualified: Boolean(mine?.qualified),
        claimed: Boolean(mine?.claimed),
      },
      ranking,
    }
  }))

  return {
    mode: 'onchain',
    status: 'ready',
    tokenSymbol: token.symbol,
    now,
    price,
    stats: {
      totalLocked: units(totalLocked),
      openLocks: Number(openLocks),
      totalBurned: units(totalBurned),
      poolFromFees: units(feesToPool),
      poolFunded: units(funded),
      rewardsPaid: units(rewardsPaid),
      completedLocks: Number(completed),
    },
    walletBalance,
    positions,
    challenges: challenges.reverse(),
  }
}

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
export type TxUpdate = (update: { status: 'awaiting-wallet' | 'pending' | 'confirmed'; hash?: string; step?: string }) => void

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

const describeError = (error: unknown) => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? Number((error as { code?: number }).code) : null
  if (code === 4001) return 'You rejected the request in your wallet.'
  const raw = typeof error === 'object' && error !== null && 'data' in error ? (error as { data?: unknown }).data : null
  const data = typeof raw === 'string' ? raw : (raw as { data?: string; result?: string } | null)?.data ?? (raw as { result?: string } | null)?.result
  if (typeof data === 'string' && data.length >= 10) {
    try {
      const parsed = vaultInterface.parseError(data)
      if (parsed) return `The vault rejected this: ${parsed.name}.`
    } catch {
      // Not a vault error.
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 180 ? `${message.slice(0, 180)}…` : message
}

export const createOnchainActions = (provider: Provider, from: string, onUpdate: TxUpdate) => {
  const send = async (to: string, data: string, step: string) => {
    let gas: string
    try {
      const estimate = BigInt(await provider.request({ method: 'eth_estimateGas', params: [{ from, to, data }] }) as string)
      gas = `0x${((estimate * 12n) / 10n).toString(16)}`
    } catch (error) {
      throw new Error(`This transaction would fail. ${describeError(error)}`)
    }
    onUpdate({ status: 'awaiting-wallet', step })
    let hash: string
    try {
      hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to, data, gas }] }) as string
    } catch (error) {
      throw new Error(describeError(error))
    }
    onUpdate({ status: 'pending', hash, step })
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }) as { status?: string } | null
      if (receipt) {
        if (receipt.status === '0x0') throw new Error('The transaction reverted onchain.')
        onUpdate({ status: 'confirmed', hash, step })
        return hash
      }
      await sleep(1_500)
    }
    throw new Error('Timed out waiting for confirmation. Check the explorer.')
  }

  const vaultTx = (fn: string, args: unknown[], step: string) => send(VAULT_ADDRESS, vaultInterface.encodeFunctionData(fn, args), step).then(() => true)

  return {
    lock: async (input: LockInput) => {
      const token = await loadToken()
      const amount = parseUnits(input.amount || '0', token.decimals)
      const [allowance] = await call(erc20, token.address, 'allowance', [from, VAULT_ADDRESS])
      if ((allowance as bigint) < amount) {
        await send(token.address, erc20.encodeFunctionData('approve', [VAULT_ADDRESS, amount]), `Approve ${token.symbol}`)
      }
      return vaultTx('lock', [amount, input.tier, input.tier === 0 ? 0 : input.termDays, input.tier === 0 ? 0 : input.roiTargetBps, input.tier === 0 ? 0 : input.maxLossBps], 'Lock')
    },
    exit: (lockId: string, maxFeeBps: number) => vaultTx('exit', [BigInt(lockId), maxFeeBps], 'Withdraw'),
    joinChallenge: (challengeId: string, lockId: string) => vaultTx('joinChallenge', [BigInt(challengeId), BigInt(lockId)], 'Join challenge'),
    finalizeChallenge: (challengeId: string) => vaultTx('finalizeChallenge', [BigInt(challengeId)], 'Finalize challenge'),
    qualify: (challengeId: string) => vaultTx('qualify', [BigInt(challengeId)], 'Qualify'),
    claimChallenge: (challengeId: string) => vaultTx('claimChallengeReward', [BigInt(challengeId)], 'Claim reward'),
    refundChallenge: (challengeId: string) => vaultTx('refundChallenge', [BigInt(challengeId)], 'Refund sponsor'),
  }
}

export const vaultExplorerTx = (hash: string) => `${VAULT_NETWORK.explorerUrl}/tx/${hash}`
export const vaultExplorerAddress = (address: string) => `${VAULT_NETWORK.explorerUrl}/address/${address}`
