// Isolated in-browser EVM for the Rixor demo.
//
// The chain starts from a snapshot of Robinhood Chain mainnet state (real WIF code and storage, canonical
// Safe v1.5.0 contracts) and executes the actual compiled Gate 1 bytecode with @ethereumjs/vm. It answers
// the JSON-RPC methods the app uses. Nothing here talks to a network: it is a private chain on this device.
//
// Persistence is an append-only journal of operations (signed raw transactions, faucet transfers, time
// changes) that is replayed deterministically on load. Every replayed transaction re-executes the real
// bytecode; no result is stored or faked.
import { createVM, runTx, type VM } from '@ethereumjs/vm'
import { createCustomCommon, Hardfork, Mainnet, type Common } from '@ethereumjs/common'
import { createTxFromRLP } from '@ethereumjs/tx'
import { createBlock } from '@ethereumjs/block'
import { createAccount, createAddressFromString, bytesToHex, hexToBytes, setLengthLeft, type Address } from '@ethereumjs/util'
import { keccak256, toUtf8Bytes } from 'ethers'

export type Snapshot = {
  kind: 'rixor-browser-evm-snapshot'
  version: number
  source: { name: string; chainId: number; block: number; blockHash: string; timestamp: number; builtAt: string }
  contracts: { WIF: string; singletonL2: string; factory: string; fallbackHandler: string }
  reserves: string[]
  reserveBalances: Record<string, string>
  accounts: Record<string, { code: string; codeHash: string; balance: string; nonce: number; storage: Record<string, string> }>
}

export type Op =
  | { k: 'raw'; raw: string; ts: number }
  | { k: 'imp'; from: string; to: string; data: string; ts: number; label: string }
  | { k: 'bal'; addr: string; wei: string }
  | { k: 'mine'; ts: number }

type BlockRec = { number: number; hash: string; parentHash: string; timestamp: number; txs: string[]; gasUsed: bigint }
type LogRec = { address: string; topics: string[]; data: string; blockNumber: number; blockHash: string; transactionHash: string; transactionIndex: number; logIndex: number }
type TxRec = {
  hash: string; from: string; to: string | null; nonce: number; input: string; value: bigint; gas: bigint
  maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; type: number; chainId: number; v: bigint; r: string; s: string
  blockNumber: number; blockHash: string
}
type ReceiptRec = {
  transactionHash: string; blockNumber: number; blockHash: string; from: string; to: string | null
  contractAddress: string | null; gasUsed: bigint; cumulativeGasUsed: bigint; status: number; logs: LogRec[]; logsBloom: string; type: number
}

export type RpcPayload = { id: number | string; jsonrpc: '2.0'; method: string; params?: unknown[] }
export type RpcResponse = { id: number | string; result?: unknown; error?: { code: number; message: string; data?: string } }

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: string) { super(message) }
}

const ZERO = '0x0000000000000000000000000000000000000000'
const q = (n: bigint | number) => '0x' + BigInt(n).toString(16)
const lower = (a: string) => a.toLowerCase()
const GAS_LIMIT = 30_000_000n

/** Serialises every VM access: concurrent reads must never interleave with checkpoints or execution. */
class Mutex {
  private p: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.p.then(fn, fn)
    this.p = next.catch(() => undefined)
    return next
  }
}

export class SimChain {
  readonly chainId: number
  private vm!: VM
  private common: Common
  private blocks: BlockRec[] = []
  private txs = new Map<string, TxRec>()
  private receipts = new Map<string, ReceiptRec>()
  private logs: LogRec[] = []
  private mutex = new Mutex()
  readonly ops: Op[] = []
  clockOffset = 0
  onOp?: (op: Op) => void
  /** Calls with calldata to an address without code (a missing snapshot dependency) are recorded here. */
  readonly missingDependencies = new Set<string>()

  private constructor(readonly snapshot: Snapshot, chainId: number) {
    this.chainId = chainId
    // Prague rules: the snapshot's WIF was compiled with solc 0.8.35; Gate 1 targets shanghai (a subset).
    this.common = createCustomCommon({ chainId }, Mainnet, { hardfork: Hardfork.Prague })
  }

  static async create(snapshot: Snapshot, chainId: number): Promise<SimChain> {
    if (snapshot.kind !== 'rixor-browser-evm-snapshot') throw new Error('Not a Rixor snapshot')
    if (chainId === 4663 || chainId === 46630) throw new Error('The simulation must not use a real Robinhood Chain id')
    const chain = new SimChain(snapshot, chainId)
    chain.vm = await createVM({ common: chain.common })
    const sm = chain.vm.stateManager
    for (const [addr, a] of Object.entries(snapshot.accounts)) {
      const address = createAddressFromString(addr)
      await sm.putAccount(address, createAccount({ nonce: BigInt(a.nonce), balance: BigInt(a.balance) }))
      if (a.code && a.code !== '0x') await sm.putCode(address, hexToBytes(a.code as `0x${string}`))
      for (const [slot, value] of Object.entries(a.storage)) {
        await sm.putStorage(address, setLengthLeft(hexToBytes(slot as `0x${string}`), 32), hexToBytes(value as `0x${string}`))
      }
    }
    chain.vm.evm.events?.on('beforeMessage', async (msg, resolve) => {
      try {
        const to = msg.to
        // Precompiles (0x01-0xff, e.g. ecrecover used by Safe) have no code by design.
        const isPrecompile = to ? BigInt(to.toString()) <= 0xffn : false
        if (to && msg.data.length > 0 && !isPrecompile) {
          const code = await chain.vm.stateManager.getCode(to)
          if (code.length === 0) chain.missingDependencies.add(to.toString())
        }
      } finally {
        resolve?.()
      }
    })
    chain.blocks.push({ number: 0, hash: snapshot.source.blockHash, parentHash: ZERO.padEnd(66, '0'), timestamp: snapshot.source.timestamp, txs: [], gasUsed: 0n })
    return chain
  }

  get head() { return this.blocks[this.blocks.length - 1] }
  /** Time the next block would carry: wall clock plus the demo offset, never earlier than the head. */
  now() { return Math.max(this.head.timestamp + 1, Math.floor(Date.now() / 1000) + this.clockOffset) }

  // ------------------------------------------------------------------ operations (journaled)

  apply(op: Op, journal = true): Promise<unknown> {
    return this.mutex.run(async () => {
      const out = await this.execOp(op)
      if (journal) { this.ops.push(op); this.onOp?.(op) }
      return out
    })
  }

  /** Re-executes a journal from a previous session. */
  async replay(ops: Op[], onProgress?: (done: number, total: number) => void) {
    for (let i = 0; i < ops.length; i++) {
      await this.apply(ops[i], false)
      this.ops.push(ops[i])
      if (onProgress && (i % 5 === 0 || i === ops.length - 1)) onProgress(i + 1, ops.length)
    }
  }

  private evmBlock(number: number, timestamp: number) {
    return createBlock({ header: { number: BigInt(number), timestamp: BigInt(timestamp), gasLimit: GAS_LIMIT, baseFeePerGas: 0n, coinbase: createAddressFromString(ZERO) } }, { common: this.common })
  }

  private seal(timestamp: number, txs: string[], gasUsed: bigint): BlockRec {
    const parent = this.head
    const number = parent.number + 1
    const hash = keccak256(toUtf8Bytes(JSON.stringify({ chain: this.chainId, number, parent: parent.hash, timestamp, txs })))
    const block = { number, hash, parentHash: parent.hash, timestamp, txs, gasUsed }
    this.blocks.push(block)
    return block
  }

  private recordLogs(raw: [Uint8Array, Uint8Array[], Uint8Array][], txHash: string, block: BlockRec): LogRec[] {
    const out = raw.map(([address, topics, data], i) => ({
      address: bytesToHex(address), topics: topics.map((t) => bytesToHex(t)), data: bytesToHex(data),
      blockNumber: block.number, blockHash: block.hash, transactionHash: txHash, transactionIndex: 0, logIndex: this.logs.length + i,
    }))
    this.logs.push(...out)
    return out
  }

  private async execOp(op: Op): Promise<unknown> {
    switch (op.k) {
      case 'raw': return this.execRaw(op.raw, op.ts)
      case 'imp': return this.execImpersonated(op)
      case 'bal': {
        const address = createAddressFromString(op.addr)
        const acc = (await this.vm.stateManager.getAccount(address)) ?? createAccount({})
        acc.balance = BigInt(op.wei)
        await this.vm.stateManager.putAccount(address, acc)
        return true
      }
      case 'mine': this.seal(Math.max(op.ts, this.head.timestamp + 1), [], 0n); return true
    }
  }

  private async execRaw(raw: string, ts: number): Promise<string> {
    let tx
    try {
      tx = createTxFromRLP(hexToBytes(raw as `0x${string}`), { common: this.common })
    } catch (e) {
      throw new RpcError(-32602, `invalid transaction: ${(e as Error).message}`)
    }
    if (tx.common.chainId() !== BigInt(this.chainId)) throw new RpcError(-32000, 'wrong chain id')
    const hash = bytesToHex(tx.hash())
    if (this.txs.has(hash)) return hash
    const timestamp = Math.max(ts, this.head.timestamp + 1)
    const number = this.head.number + 1
    const from = tx.getSenderAddress().toString()
    let result
    try {
      result = await runTx(this.vm, { tx, block: this.evmBlock(number, timestamp), skipBlockGasLimitValidation: true })
    } catch (e) {
      throw new RpcError(-32000, (e as Error).message.split('\n')[0])
    }
    const block = this.seal(timestamp, [hash], result.totalGasSpent)
    const status = result.execResult.exceptionError ? 0 : 1
    const logs = this.recordLogs(result.receipt.logs as [Uint8Array, Uint8Array[], Uint8Array][], hash, block)
    const t = tx as unknown as { nonce: bigint; to?: Address; data: Uint8Array; value: bigint; gasLimit: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint; type: number; v?: bigint; r?: bigint; s?: bigint }
    this.txs.set(hash, {
      hash, from, to: t.to ? t.to.toString() : null, nonce: Number(t.nonce), input: bytesToHex(t.data), value: t.value, gas: t.gasLimit,
      maxFeePerGas: t.maxFeePerGas ?? t.gasPrice ?? 0n, maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? 0n, type: t.type, chainId: this.chainId,
      v: t.v ?? 0n, r: q(t.r ?? 0n), s: q(t.s ?? 0n), blockNumber: block.number, blockHash: block.hash,
    })
    this.receipts.set(hash, {
      transactionHash: hash, blockNumber: block.number, blockHash: block.hash, from, to: t.to ? t.to.toString() : null,
      contractAddress: result.createdAddress ? result.createdAddress.toString() : null, gasUsed: result.totalGasSpent,
      cumulativeGasUsed: result.totalGasSpent, status, logs, logsBloom: bytesToHex(result.bloom.bitvector), type: t.type,
    })
    return hash
  }

  /**
   * Executes a call from an account whose key nobody holds, exactly like anvil's impersonation. Used only for
   * the demo faucet, which moves copied WIF from large mainnet holders inside this isolated chain.
   */
  private async execImpersonated(op: Extract<Op, { k: 'imp' }>): Promise<string> {
    const timestamp = Math.max(op.ts, this.head.timestamp + 1)
    const number = this.head.number + 1
    const caller = createAddressFromString(op.from)
    await this.vm.stateManager.checkpoint()
    const res = await this.vm.evm.runCall({
      caller, origin: caller, to: createAddressFromString(op.to), data: hexToBytes(op.data as `0x${string}`), gasLimit: GAS_LIMIT,
      block: this.evmBlock(number, timestamp),
    })
    if (res.execResult.exceptionError) {
      await this.vm.stateManager.revert()
      throw new RpcError(-32000, `${op.label} failed: ${res.execResult.exceptionError.error}`)
    }
    await this.vm.stateManager.commit()
    const hash = keccak256(toUtf8Bytes(JSON.stringify({ imp: this.ops.length, op })))
    const block = this.seal(timestamp, [hash], res.execResult.executionGasUsed)
    const logs = this.recordLogs((res.execResult.logs ?? []) as [Uint8Array, Uint8Array[], Uint8Array][], hash, block)
    this.txs.set(hash, { hash, from: op.from, to: op.to, nonce: 0, input: op.data, value: 0n, gas: GAS_LIMIT, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, type: 2, chainId: this.chainId, v: 0n, r: '0x0', s: '0x0', blockNumber: block.number, blockHash: block.hash })
    this.receipts.set(hash, { transactionHash: hash, blockNumber: block.number, blockHash: block.hash, from: op.from, to: op.to, contractAddress: null, gasUsed: res.execResult.executionGasUsed, cumulativeGasUsed: res.execResult.executionGasUsed, status: 1, logs, logsBloom: '0x' + '0'.repeat(512), type: 2 })
    return hash
  }

  // ------------------------------------------------------------------ JSON-RPC

  rpc(p: RpcPayload): Promise<RpcResponse> {
    if (p.method === 'eth_sendRawTransaction') {
      const raw = (p.params?.[0] ?? '') as string
      return this.apply({ k: 'raw', raw, ts: this.now() })
        .then((result) => ({ id: p.id, result }))
        .catch((e: unknown) => this.toError(p.id, e))
    }
    return this.mutex.run(() => this.read(p)).then((result) => ({ id: p.id, result })).catch((e: unknown) => this.toError(p.id, e))
  }

  private toError(id: RpcPayload['id'], e: unknown): RpcResponse {
    if (e instanceof RpcError) return { id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } }
    return { id, error: { code: -32603, message: (e as Error)?.message ?? String(e) } }
  }

  private blockByTag(tag: unknown): BlockRec | null {
    if (tag === undefined || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized') return this.head
    if (tag === 'earliest') return this.blocks[0]
    const n = Number(tag)
    return this.blocks[n] ?? null
  }

  private async simulate(call: { from?: string; to?: string; data?: string; input?: string; value?: string }) {
    const number = this.head.number + 1
    const caller = createAddressFromString(call.from ?? ZERO)
    await this.vm.stateManager.checkpoint()
    try {
      return await this.vm.evm.runCall({
        caller, origin: caller, to: call.to ? createAddressFromString(call.to) : undefined,
        data: hexToBytes(((call.data ?? call.input) || '0x') as `0x${string}`), value: call.value ? BigInt(call.value) : 0n,
        gasLimit: GAS_LIMIT, block: this.evmBlock(number, this.now()),
      })
    } finally {
      await this.vm.stateManager.revert()
    }
  }

  private formatBlock(b: BlockRec, full: boolean) {
    return {
      number: q(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: q(b.timestamp), nonce: '0x0000000000000000',
      difficulty: '0x0', gasLimit: q(GAS_LIMIT), gasUsed: q(b.gasUsed), miner: ZERO, extraData: '0x', baseFeePerGas: '0x0',
      logsBloom: '0x' + '0'.repeat(512), sha3Uncles: '0x' + '0'.repeat(64), stateRoot: '0x' + '0'.repeat(64), receiptsRoot: '0x' + '0'.repeat(64),
      transactionsRoot: '0x' + '0'.repeat(64), mixHash: '0x' + '0'.repeat(64), size: '0x0', uncles: [],
      transactions: full ? b.txs.map((h) => this.formatTx(this.txs.get(h)!)) : b.txs,
    }
  }

  private formatTx(t: TxRec) {
    return {
      hash: t.hash, from: t.from, to: t.to, nonce: q(t.nonce), input: t.input, value: q(t.value), gas: q(t.gas),
      maxFeePerGas: q(t.maxFeePerGas), maxPriorityFeePerGas: q(t.maxPriorityFeePerGas), gasPrice: q(t.maxFeePerGas), type: q(t.type),
      chainId: q(t.chainId), v: q(t.v), r: t.r, s: t.s, yParity: q(t.v), accessList: [], blockNumber: q(t.blockNumber), blockHash: t.blockHash, transactionIndex: '0x0',
    }
  }

  private formatLog(l: LogRec) {
    return { ...l, blockNumber: q(l.blockNumber), transactionIndex: q(l.transactionIndex), logIndex: q(l.logIndex), removed: false }
  }

  private async read(p: RpcPayload): Promise<unknown> {
    const params = (p.params ?? []) as unknown[]
    switch (p.method) {
      case 'eth_chainId': return q(this.chainId)
      case 'net_version': return String(this.chainId)
      case 'web3_clientVersion': return 'rixor-browser-evm/1 (@ethereumjs/vm 10.1.3)'
      case 'eth_syncing': return false
      case 'eth_accounts': case 'eth_requestAccounts': return []
      case 'eth_blockNumber': return q(this.head.number)
      case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x0'
      case 'eth_feeHistory': return { oldestBlock: q(this.head.number), baseFeePerGas: ['0x0', '0x0'], gasUsedRatio: [0], reward: [['0x0']] }
      case 'eth_getBalance': {
        const acc = await this.vm.stateManager.getAccount(createAddressFromString(params[0] as string))
        return q(acc?.balance ?? 0n)
      }
      case 'eth_getTransactionCount': {
        const acc = await this.vm.stateManager.getAccount(createAddressFromString(params[0] as string))
        return q(acc?.nonce ?? 0n)
      }
      case 'eth_getCode': return bytesToHex(await this.vm.stateManager.getCode(createAddressFromString(params[0] as string)))
      case 'eth_getStorageAt': {
        const v = await this.vm.stateManager.getStorage(createAddressFromString(params[0] as string), setLengthLeft(hexToBytes(params[1] as `0x${string}`), 32))
        return bytesToHex(setLengthLeft(v, 32))
      }
      case 'eth_call': {
        const res = await this.simulate(params[0] as Record<string, string>)
        if (res.execResult.exceptionError) throw new RpcError(3, 'execution reverted', bytesToHex(res.execResult.returnValue))
        return bytesToHex(res.execResult.returnValue)
      }
      case 'eth_estimateGas': {
        const res = await this.simulate(params[0] as Record<string, string>)
        if (res.execResult.exceptionError) throw new RpcError(3, 'execution reverted', bytesToHex(res.execResult.returnValue))
        const callData = (((params[0] as Record<string, string>).data ?? (params[0] as Record<string, string>).input ?? '0x').length - 2) / 2
        return q(((res.execResult.executionGasUsed + 21_000n + BigInt(callData) * 16n) * 13n) / 10n + 30_000n)
      }
      case 'eth_getBlockByNumber': { const b = this.blockByTag(params[0]); return b ? this.formatBlock(b, Boolean(params[1])) : null }
      case 'eth_getBlockByHash': { const b = this.blocks.find((x) => x.hash === params[0]); return b ? this.formatBlock(b, Boolean(params[1])) : null }
      case 'eth_getTransactionByHash': { const t = this.txs.get(params[0] as string); return t ? this.formatTx(t) : null }
      case 'eth_getTransactionReceipt': {
        const r = this.receipts.get(params[0] as string)
        if (!r) return null
        return {
          transactionHash: r.transactionHash, transactionIndex: '0x0', blockNumber: q(r.blockNumber), blockHash: r.blockHash, from: r.from, to: r.to,
          contractAddress: r.contractAddress, gasUsed: q(r.gasUsed), cumulativeGasUsed: q(r.cumulativeGasUsed), effectiveGasPrice: '0x0',
          status: q(r.status), logs: r.logs.map((l) => this.formatLog(l)), logsBloom: r.logsBloom, type: q(r.type),
        }
      }
      case 'eth_getLogs': {
        const f = (params[0] ?? {}) as { address?: string | string[]; topics?: (string | string[] | null)[]; fromBlock?: string; toBlock?: string; blockHash?: string }
        const addrs = f.address ? (Array.isArray(f.address) ? f.address : [f.address]).map(lower) : null
        let from = 0
        let to = this.head.number
        if (f.blockHash) {
          const b = this.blocks.find((x) => x.hash === f.blockHash)
          if (!b) return []
          from = to = b.number
        } else {
          from = this.blockByTag(f.fromBlock ?? 'latest')?.number ?? 0
          to = this.blockByTag(f.toBlock ?? 'latest')?.number ?? this.head.number
        }
        return this.logs.filter((l) => {
          if (l.blockNumber < from || l.blockNumber > to) return false
          if (addrs && !addrs.includes(lower(l.address))) return false
          return (f.topics ?? []).every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.map(lower).includes(lower(l.topics[i] ?? '')) : lower(t) === lower(l.topics[i] ?? '')))
        }).map((l) => this.formatLog(l))
      }
      default:
        throw new RpcError(-32601, `method ${p.method} is not supported by the browser EVM`)
    }
  }
}
