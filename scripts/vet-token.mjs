#!/usr/bin/env node
// Rixor token vetting — repeatable, read-only checks for a candidate lockable token on Robinhood Chain.
//
//   npm run vet:token -- <0xExactTokenAddress> [--rpc URL] [--out DIR] [--no-fork] [--from-block N]
//
// What it does (nothing is ever broadcast to a live network):
//   1. Validates the input is an exact 20-byte address (EIP-55 checksum enforced when mixed-case).
//      Symbols and names are never accepted as input and never used to select a token.
//   2. Reads metadata, bytecode admin surface (risky selectors), proxy/clone markers and owner().
//   3. Finds the first Transfer (token age).
//   4. Replays the token's FULL Transfer history (adaptive log chunking) to reconstruct every
//      holder balance, cross-checks the largest balances and the total against on-chain state,
//      labels holders (EOA / contract / known infrastructure) and computes concentration.
//   5. Checks source verification on Sourcify.
//   6. Discovers Uniswap v4 pools (PoolManager Initialize events), reads live liquidity, and
//      attributes LP positions to their NFT owners (burn address, lockers, wallets).
//   7. Starts a throwaway LOCAL Anvil fork and runs behavioural transfer tests (exactness,
//      contract recipients/spenders, burn address) by impersonating a real holder locally.
//   8. Writes JSON + Markdown reports with PASS / WARN / FAIL per checklist item and an explicit
//      list of limitations (RPC retention, indexing gaps, heuristics).
//
// A PASS here is evidence, not a guarantee. Every listing still needs human review (docs/TOKEN_VETTING.md).

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  getAddress,
  id,
  keccak256,
  toBeHex,
  zeroPadValue,
} from 'ethers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHAIN_ID = 4663
const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com'

// Known infrastructure on Robinhood Chain mainnet (verified during Gate 1 research; re-verify when it matters).
const KNOWN = {
  '0x0000000000000000000000000000000000000000': 'zero address (mint/burn)',
  '0x000000000000000000000000000000000000dead': 'burn address 0x…dEaD',
  '0x8366a39cc670b4001a1121b8f6a443a643e40951': 'Uniswap v4 PoolManager',
  '0x58daec3116aae6d93017baaea7749052e8a04fa7': 'Uniswap v4 PositionManager',
  '0x267444d099b10fb5ed7c3cc7b7c767adca574952': 'Pons RobinFunFiV2LaunchLocker',
  '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e': 'Pons launch factory',
}
const INFRASTRUCTURE = new Set(Object.keys(KNOWN))
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
const PONS_LOCKER = '0x267444d099b10fb5ed7c3cc7b7c767adca574952'
const DEAD = '0x000000000000000000000000000000000000dead'

const RISKY = {
  'mint(address,uint256)': 'mint', 'mint(uint256)': 'mint', 'pause()': 'pause', 'unpause()': 'pause',
  'blacklist(address)': 'blacklist', 'addToBlacklist(address)': 'blacklist', 'setBlacklist(address,bool)': 'blacklist',
  'isBlacklisted(address)': 'blacklist', 'setFee(uint256)': 'fee', 'setTaxes(uint256,uint256)': 'fee',
  'setBuyTax(uint256)': 'fee', 'setSellTax(uint256)': 'fee', 'excludeFromFee(address)': 'fee', '_taxFee()': 'fee',
  'setMaxTxAmount(uint256)': 'limits', 'setMaxWallet(uint256)': 'limits', 'maxTransactionAmount()': 'limits',
  'enableTrading()': 'trading-gate', 'tradingEnabled()': 'trading-gate', 'tradingOpen()': 'trading-gate',
  'upgradeTo(address)': 'upgrade', 'upgradeToAndCall(address,bytes)': 'upgrade', 'setHook(address)': 'config',
  'setPool(address)': 'config', 'setRouter(address)': 'config', 'transferOwnership(address)': 'ownership',
  'renounceOwnership()': 'ownership', 'owner()': 'ownership',
}
const BENIGN = ['burn(uint256)', 'burnFrom(address,uint256)', 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)']
const BRAND_WORDS = ['robinhood', 'hood', 'tenev', 'anthropic', 'claude', 'openai', 'chatgpt', 'coinbase', 'binance',
  'tesla', 'elon', 'musk', 'apple', 'google', 'nvidia', 'trump', 'official', 'sec ', 'etf']

const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const EIP1967_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
const EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const TRANSFER = id('Transfer(address,address,uint256)')
const ERC20 = [
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function owner() view returns (address)',
  'function getOwner() view returns (address)', 'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)', 'function transferFrom(address,address,uint256) returns (bool)',
  'function burn(uint256)',
]
const PM_IFACE = new Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  'function extsload(bytes32 slot) view returns (bytes32)',
])

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const args = { rpc: process.env.RH_MAINNET_RPC_URL || DEFAULT_RPC, out: join(ROOT, 'reports', 'token-vetting'), fork: true, fromBlock: 0 }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--rpc') args.rpc = argv[++i]
    else if (a === '--out') args.out = resolve(argv[++i])
    else if (a === '--no-fork') args.fork = false
    else if (a === '--from-block') args.fromBlock = Number(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
    else positional.push(a)
  }
  args.inputs = positional
  return args
}

/** Exact-address validation. Never resolves names or symbols. */
export function validateAddress(input) {
  if (typeof input !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(input)) {
    throw new Error(`"${input}" is not an exact 20-byte hex address. Symbols, names and abbreviated addresses are not accepted.`)
  }
  const mixed = /[a-f]/.test(input.slice(2)) && /[A-F]/.test(input.slice(2))
  const checksummed = getAddress(input.toLowerCase())
  if (mixed && checksummed !== input) throw new Error(`"${input}" fails its EIP-55 checksum (expected ${checksummed}). Re-copy the exact address.`)
  return checksummed
}

// ------------------------------------------------------------------ RPC helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withRetry(fn, label, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const msg = String(e?.error?.message || e?.shortMessage || e?.message)
      if (/exceed|limit|range|too many|spans|10000|query returned more/i.test(msg)) throw e // caller splits
      await sleep(500 * 2 ** i)
    }
  }
  throw new Error(`${label}: ${last?.shortMessage || last?.message}`)
}

/** Streams logs in [from, to] to `onLog`, splitting ranges that exceed the RPC's span or result limits. */
async function streamLogs(provider, filter, from, to, onLog, stats) {
  const MAX_SPAN = 9_999_999
  const stack = []
  for (let f = from; f <= to; f += MAX_SPAN + 1) stack.push([f, Math.min(to, f + MAX_SPAN)])
  stack.reverse()
  while (stack.length) {
    const [a, b] = stack.pop()
    try {
      const logs = await withRetry(() => provider.getLogs({ ...filter, fromBlock: a, toBlock: b }), `getLogs ${a}-${b}`)
      stats.requests++
      for (const l of logs) onLog(l)
    } catch (e) {
      if (b > a) {
        const mid = Math.floor((a + b) / 2)
        stack.push([mid + 1, b], [a, mid]) // process the lower half first, preserving order
        stats.splits++
      } else {
        stats.failedRanges.push([a, b, String(e?.shortMessage || e?.message).slice(0, 120)])
      }
    }
  }
}

async function findFirstTransfer(provider, token, from, head) {
  // Probe chunks in order; within the first non-empty chunk, binary-search down to a small range.
  for (let f = from; f <= head; f += 10_000_000) {
    let lo = f
    let hi = Math.min(head, f + 9_999_999)
    const probe = await provider.getLogs({ address: token, topics: [TRANSFER], fromBlock: lo, toBlock: hi }).catch(() => null)
    if (probe !== null && probe.length === 0) continue
    if (probe && probe.length) return probe[0]
    while (hi - lo > 50_000) {
      const mid = Math.floor((lo + hi) / 2)
      const l = await provider.getLogs({ address: token, topics: [TRANSFER], fromBlock: lo, toBlock: mid }).catch(() => null)
      if (l === null || l.length) hi = mid
      else lo = mid + 1
    }
    const l = await provider.getLogs({ address: token, topics: [TRANSFER], fromBlock: lo, toBlock: hi }).catch(() => [])
    if (l.length) return l[0]
  }
  return null
}

// ------------------------------------------------------------------ checks

function selectorsIn(code, signatures) {
  return signatures.filter((s) => code.includes(id(s).slice(2, 10)))
}

async function metadata(provider, address, head) {
  const t = new Contract(address, ERC20, provider)
  const code = await provider.getCode(address, head)
  const r = { address, codeBytes: (code.length - 2) / 2 }
  if (r.codeBytes === 0) return { ...r, hasCode: false }
  r.hasCode = true
  r.name = await t.name({ blockTag: head }).catch(() => null)
  r.symbol = await t.symbol({ blockTag: head }).catch(() => null)
  r.decimals = Number(await t.decimals({ blockTag: head }).catch(() => -1))
  r.totalSupplyRaw = (await t.totalSupply({ blockTag: head })).toString()
  r.totalSupply = r.decimals >= 0 ? formatUnits(r.totalSupplyRaw, r.decimals) : null
  r.owner = await t.owner({ blockTag: head }).catch(() => null)
  r.getOwner = await t.getOwner({ blockTag: head }).catch(() => null)
  const lowered = code.toLowerCase()
  r.riskySelectors = selectorsIn(lowered, Object.keys(RISKY)).map((s) => ({ signature: s, category: RISKY[s] }))
  r.benignSelectors = selectorsIn(lowered, BENIGN)
  r.eip1167Clone = lowered.startsWith('0x363d3d373d3d3d363d73')
  r.eip1167Implementation = r.eip1167Clone ? getAddress('0x' + lowered.slice(22, 62)) : null
  r.eip1967 = {
    implementation: await provider.getStorage(address, EIP1967_IMPL, head),
    admin: await provider.getStorage(address, EIP1967_ADMIN, head),
    beacon: await provider.getStorage(address, EIP1967_BEACON, head),
  }
  r.delegatecallOpcodePresent = hasOpcode(lowered, 0xf4)
  r.selfdestructOpcodePresent = hasOpcode(lowered, 0xff)
  return r
}

/** Walks bytecode skipping PUSH data so that immediates are not mistaken for opcodes. */
function hasOpcode(codeHex, opcode) {
  const bytes = Buffer.from(codeHex.slice(2), 'hex')
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i]
    if (op === opcode) return true
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f
  }
  return false
}

async function replayHolders(provider, address, from, head, totalSupplyRaw) {
  const balances = new Map()
  const firstSource = new Map() // address -> sender of its first incoming transfer
  const firstBlock = new Map() // address -> block of its first incoming transfer
  const firstTx = new Map() // address -> transaction of its first incoming transfer
  const stats = { requests: 0, splits: 0, failedRanges: [], transfers: 0 }
  const credit = (who, v) => balances.set(who, (balances.get(who) ?? 0n) + v)
  await streamLogs(provider, { address, topics: [TRANSFER] }, from, head, (l) => {
    if (l.topics.length !== 3 || l.data.length < 66) return // non-standard event shape
    stats.transfers++
    const fromA = '0x' + l.topics[1].slice(26)
    const toA = '0x' + l.topics[2].slice(26)
    const v = BigInt(l.data.slice(0, 66))
    credit(fromA, -v)
    credit(toA, v)
    if (!firstSource.has(toA)) {
      firstSource.set(toA, fromA)
      firstBlock.set(toA, l.blockNumber)
      firstTx.set(toA, l.transactionHash)
    }
  }, stats)
  const zero = '0x0000000000000000000000000000000000000000'
  let circulating = 0n
  let holders = 0
  let negative = 0
  for (const [a, v] of balances) {
    if (a === zero) continue
    if (v > 0n) {
      circulating += v
      holders++
    } else if (v < 0n) negative++
  }
  const sorted = [...balances.entries()].filter(([a, v]) => a !== zero && v > 0n).sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0))
  return { stats, holders, negative, circulatingFromReplay: circulating.toString(), supplyMatches: circulating === BigInt(totalSupplyRaw), sorted, firstSource, firstBlock, firstTx }
}

async function labelHolders(provider, address, sorted, totalSupplyRaw, decimals, head, topN = 25) {
  const t = new Contract(address, ERC20, provider)
  const supply = BigInt(totalSupplyRaw)
  const out = []
  let mismatches = 0
  for (const [a, replayBal] of sorted.slice(0, topN)) {
    const live = await t.balanceOf(a, { blockTag: head }).catch(() => null)
    const code = await provider.getCode(a, head).catch(() => '0x')
    const isContract = code.length > 2
    let kind = KNOWN[a] ? 'infrastructure' : isContract ? 'contract' : 'EOA'
    let note = KNOWN[a] ?? null
    if (isContract && !KNOWN[a]) {
      const lc = code.toLowerCase()
      if (lc.startsWith('0xef0100')) { kind = 'EOA (EIP-7702 delegated)'; note = 'delegates to 0x' + lc.slice(8, 48) }
      else if (selectorsIn(lc, ['getThreshold()', 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)']).length === 2 || lc.length < 400) note = 'possibly a Safe/proxy wallet (inspect manually)'
    }
    if (live !== null && live !== replayBal) mismatches++
    out.push({
      address: getAddress(a), kind, note, balance: formatUnits(replayBal, decimals),
      pctSupply: Number((replayBal * 1_000_000n) / (supply || 1n)) / 10_000,
      liveBalanceMatchesReplay: live === null ? null : live === replayBal,
    })
  }
  return { top: out, mismatches }
}

function concentration(sorted, totalSupplyRaw) {
  const supply = BigInt(totalSupplyRaw) || 1n
  const pct = (v) => Number((v * 1_000_000n) / supply) / 10_000
  const nonInfra = sorted.filter(([a]) => !INFRASTRUCTURE.has(a))
  const infraTotal = sorted.filter(([a]) => INFRASTRUCTURE.has(a)).reduce((s, [, v]) => s + v, 0n)
  const sum = (arr) => arr.reduce((s, [, v]) => s + v, 0n)
  return {
    top1Pct: sorted.length ? pct(sorted[0][1]) : 0,
    top10Pct: pct(sum(sorted.slice(0, 10))),
    infrastructurePct: pct(infraTotal),
    largestNonInfrastructure: nonInfra.length ? { address: getAddress(nonInfra[0][0]), pct: pct(nonInfra[0][1]) } : null,
    top10NonInfrastructurePct: pct(sum(nonInfra.slice(0, 10))),
    top50NonInfrastructurePct: pct(sum(nonInfra.slice(0, 50))),
  }
}

/**
 * Concentration per address understates risk when one entity spreads supply across many wallets.
 * Two heuristics over the largest holders:
 *  - funding clusters: holders grouped by the sender of their first incoming tokens (a distributor
 *    wallet seeding many recipients shows up as one large group; buys from the PoolManager do not);
 *  - equal-balance clusters: many holders with near-identical balances (typical of scripted splits).
 */
function clusters(sorted, firstSource, firstBlock, totalSupplyRaw, sample = 500, windowBlocks = 34_000) {
  const supply = BigInt(totalSupplyRaw) || 1n
  const pct = (v) => Number((v * 1_000_000n) / supply) / 10_000
  const top = sorted.filter(([a]) => !INFRASTRUCTURE.has(a)).slice(0, sample)
  const bySource = new Map()
  for (const [a, v] of top) {
    const src = firstSource.get(a) ?? 'unknown'
    const g = bySource.get(src) ?? { source: src, holders: 0, balance: 0n }
    g.holders++
    g.balance += v
    bySource.set(src, g)
  }
  const fundingClusters = [...bySource.values()]
    .filter((g) => !INFRASTRUCTURE.has(g.source) && g.holders >= 3)
    .sort((x, y) => (y.balance > x.balance ? 1 : -1))
    .slice(0, 10)
    .map((g) => ({ source: g.source === 'unknown' ? g.source : getAddress(g.source), holders: g.holders, pctSupply: pct(g.balance) }))
  const fromPoolManager = bySource.get(POOL_MANAGER)
  // Equal-balance clusters: sliding window of balances within 2% of each other.
  let best = { holders: 0, balance: 0n, low: 0n, high: 0n }
  for (let i = 0, j = 0, sum = 0n; i < top.length; i++) {
    sum += top[i][1]
    while (top[j][1] * 100n > top[i][1] * 102n) sum -= top[j++][1]
    if (i - j + 1 > best.holders) best = { holders: i - j + 1, balance: sum, low: top[i][1], high: top[j][1] }
  }
  // Timing clusters: many large holders whose first receipt lands in the same ~1 hour window
  // (34,000 blocks at ~0.105 s/block) suggests coordinated buying across wallets.
  const timed = top.map(([a, v]) => [firstBlock.get(a) ?? 0, v]).sort((x, y) => x[0] - y[0])
  let timing = { holders: 0, balance: 0n, fromBlock: 0 }
  for (let i = 0, j = 0, sum = 0n; i < timed.length; i++) {
    sum += timed[i][1]
    while (timed[i][0] - timed[j][0] > windowBlocks) sum -= timed[j++][1]
    if (i - j + 1 > timing.holders) timing = { holders: i - j + 1, balance: sum, fromBlock: timed[j][0] }
  }
  return {
    sampleSize: top.length,
    largestFirstReceiptWindow: { holders: timing.holders, pctSupply: pct(timing.balance), fromBlock: timing.fromBlock, windowBlocks },
    largestFundingClusterPct: fundingClusters[0]?.pctSupply ?? 0,
    fundingClusters,
    boughtFromPoolManager: fromPoolManager ? { holders: fromPoolManager.holders, pctSupply: pct(fromPoolManager.balance) } : null,
    largestEqualBalanceCluster: { holders: best.holders, pctSupply: pct(best.balance) },
  }
}

/**
 * Strongest cheap Sybil signal: who signed the transaction that first delivered tokens to each large
 * holder. Many wallets first funded by transactions from one signer (or inside one bundled transaction)
 * are very likely controlled by one entity, regardless of the router used.
 */
async function signerClusters(provider, sorted, firstTx, totalSupplyRaw, sample = 500) {
  const supply = BigInt(totalSupplyRaw) || 1n
  const pct = (v) => Number((v * 1_000_000n) / supply) / 10_000
  const top = sorted.filter(([a]) => !INFRASTRUCTURE.has(a)).slice(0, sample)
  const txFrom = new Map()
  let failures = 0
  const bySigner = new Map()
  const byTx = new Map()
  for (const [a, v] of top) {
    const h = firstTx.get(a)
    if (!h) continue
    if (!txFrom.has(h)) {
      const tx = await withRetry(() => provider.getTransaction(h), `tx ${h}`).catch(() => null)
      if (!tx) failures++
      txFrom.set(h, tx ? tx.from.toLowerCase() : null)
    }
    const signer = txFrom.get(h)
    const t = byTx.get(h) ?? { tx: h, holders: 0, balance: 0n }
    t.holders++
    t.balance += v
    byTx.set(h, t)
    if (!signer) continue
    const g = bySigner.get(signer) ?? { signer, holders: 0, balance: 0n, selfFunded: 0 }
    g.holders++
    g.balance += v
    if (signer === a) g.selfFunded++
    bySigner.set(signer, g)
  }
  // A signer that only bought for itself is an ordinary buyer; count holders funded by someone else.
  const groups = [...bySigner.values()]
    .map((g) => ({ ...g, others: g.holders - g.selfFunded }))
    .filter((g) => g.others >= 2)
    .sort((x, y) => (y.balance > x.balance ? 1 : -1))
  const selfBuyers = [...bySigner.values()].reduce((s, g) => s + g.selfFunded, 0)
  const bundles = [...byTx.values()].filter((t) => t.holders >= 2).sort((x, y) => y.holders - x.holders)
  return {
    sampleSize: top.length,
    distinctFirstTransactions: byTx.size,
    holdersWhoSignedTheirOwnFirstReceipt: selfBuyers,
    lookupFailures: failures,
    largestSignerCluster: groups[0] ? { signer: getAddress(groups[0].signer), holders: groups[0].holders, pctSupply: pct(groups[0].balance) } : null,
    signerClusters: groups.slice(0, 10).map((g) => ({ signer: getAddress(g.signer), holders: g.holders, pctSupply: pct(g.balance) })),
    largestBundledTransaction: bundles[0] ? { tx: bundles[0].tx, holders: bundles[0].holders, pctSupply: pct(bundles[0].balance) } : null,
  }
}

const ROUTER_NAME = /router|settler|aggregat|swap|bridge|relay|multicall|universal|permit2|positionmanager/i

/** Labels funding-cluster sources: EOAs and unverified contracts stay suspicious; verified routers are shared venues. */
async function classifySources(provider, c, head) {
  for (const g of c.fundingClusters) {
    if (g.source === 'unknown') continue
    const code = await provider.getCode(g.source, head).catch(() => '0x')
    if (code.length <= 2) {
      g.kind = 'EOA (distributor wallet: possible single-entity cluster)'
      g.sharedVenue = false
      continue
    }
    const v = await sourcify(g.source)
    g.verifiedName = v.name ?? null
    g.sharedVenue = Boolean(v.name && ROUTER_NAME.test(v.name))
    g.kind = g.sharedVenue ? `verified router/settler (${v.name}): shared by many users, not a cluster` : `contract${v.name ? ` (${v.name})` : ' (unverified)'}: inspect`
  }
  const suspicious = c.fundingClusters.filter((g) => !g.sharedVenue)
  c.largestFundingClusterPct = suspicious[0]?.pctSupply ?? 0
  c.largestSuspiciousCluster = suspicious[0] ?? null
  return c
}

async function sourcify(address) {
  const urls = [
    `https://sourcify.dev/server/v2/contract/${CHAIN_ID}/${address}?fields=compilation`,
    `https://sourcify.dev/server/check-by-addresses?addresses=${address}&chainIds=${CHAIN_ID}`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (res.status === 404) return { status: 'not verified', source: url }
      if (!res.ok) continue
      const body = await res.json()
      if (Array.isArray(body)) {
        const s = body[0]?.chainIds?.[0]?.status ?? body[0]?.status
        return { status: s && s !== 'false' ? s : 'not verified', source: url }
      }
      return { status: body.match ?? body.runtimeMatch ?? body.creationMatch ?? 'unknown', name: body.compilation?.name ?? null, compiler: body.compilation?.compilerVersion ?? null, source: url }
    } catch (e) {
      // try next endpoint
    }
  }
  return { status: 'unknown (Sourcify unreachable)', source: null }
}

async function v4Pools(provider, address, from, head) {
  const init = PM_IFACE.getEvent('Initialize').topicHash
  const mod = PM_IFACE.getEvent('ModifyLiquidity').topicHash
  const topic = zeroPadValue(address, 32)
  const inits = []
  const stats = { requests: 0, splits: 0, failedRanges: [] }
  await streamLogs(provider, { address: POOL_MANAGER, topics: [init, null, topic] }, from, head, (l) => inits.push(l), stats)
  await streamLogs(provider, { address: POOL_MANAGER, topics: [init, null, null, topic] }, from, head, (l) => inits.push(l), stats)
  const pm = new Contract(POOL_MANAGER, PM_IFACE.fragments, provider)
  const posm = new Contract(POSITION_MANAGER, ['function ownerOf(uint256) view returns (address)'], provider)
  const coder = AbiCoder.defaultAbiCoder()
  const pools = []
  for (const log of inits) {
    const a = PM_IFACE.parseLog(log).args
    const poolSlot = BigInt(keccak256(coder.encode(['bytes32', 'uint256'], [a.id, 6n])))
    const slot0 = BigInt(await pm.extsload(toBeHex(poolSlot, 32), { blockTag: head }))
    const liquidity = BigInt(await pm.extsload(toBeHex(poolSlot + 3n, 32), { blockTag: head })) & ((1n << 128n) - 1n)
    const tick = Number(BigInt.asIntN(24, (slot0 >> 160n) & 0xffffffn))
    // Attribute live LP positions: sum liquidityDelta per (sender, salt, range).
    const positions = new Map()
    const mstats = { requests: 0, splits: 0, failedRanges: [] }
    await streamLogs(provider, { address: POOL_MANAGER, topics: [mod, a.id] }, log.blockNumber, head, (l) => {
      const m = PM_IFACE.parseLog(l).args
      const key = `${m.sender.toLowerCase()}|${m.salt}|${m.tickLower}|${m.tickUpper}`
      const cur = positions.get(key) ?? { sender: m.sender.toLowerCase(), salt: m.salt, tickLower: Number(m.tickLower), tickUpper: Number(m.tickUpper), liquidity: 0n }
      cur.liquidity += BigInt(m.liquidityDelta)
      positions.set(key, cur)
    }, mstats)
    const live = [...positions.values()].filter((p) => p.liquidity > 0n)
    const inRangeTotal = live.filter((p) => p.tickLower <= tick && tick < p.tickUpper).reduce((s, p) => s + p.liquidity, 0n)
    const owners = []
    for (const p of live) {
      let owner = null
      let tokenId = null
      if (p.sender === POSITION_MANAGER) {
        tokenId = BigInt(p.salt).toString()
        owner = await posm.ownerOf(tokenId, { blockTag: head }).then((o) => o.toLowerCase()).catch(() => 'burned/unknown')
      }
      const inRange = p.tickLower <= tick && tick < p.tickUpper
      owners.push({
        manager: KNOWN[p.sender] ?? p.sender, tokenId, owner: owner ? (KNOWN[owner] ?? owner) : null,
        custody: owner === DEAD ? 'burned (0x…dEaD)' : owner === PONS_LOCKER ? 'Pons launch locker' : owner ? 'wallet/contract (withdrawable)' : 'non-PositionManager (inspect)',
        inRange, shareOfInRangePct: inRange && inRangeTotal > 0n ? Number((p.liquidity * 10_000n) / inRangeTotal) / 100 : 0,
        tickLower: p.tickLower, tickUpper: p.tickUpper,
      })
    }
    owners.sort((x, y) => y.shareOfInRangePct - x.shareOfInRangePct)
    pools.push({
      poolId: a.id, currency0: a.currency0, currency1: a.currency1, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing),
      hooks: a.hooks, hasHook: a.hooks !== '0x0000000000000000000000000000000000000000', createdBlock: log.blockNumber,
      currentTick: tick, activeLiquidity: liquidity.toString(), livePositions: live.length,
      lockedOrBurnedInRangePct: owners.filter((o) => o.custody !== 'wallet/contract (withdrawable)' && o.custody !== 'non-PositionManager (inspect)').reduce((s, o) => s + o.shareOfInRangePct, 0),
      positions: owners.slice(0, 10), logStats: mstats,
    })
  }
  pools.sort((x, y) => (BigInt(y.activeLiquidity) > BigInt(x.activeLiquidity) ? 1 : -1))
  return { pools, logStats: stats }
}

// ------------------------------------------------------------------ local fork behaviour tests

async function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
    s.on('error', rej)
  })
}

async function behaviourTests(rpc, address, holder, decimals, hasBurn, head) {
  const port = await freePort()
  const anvilBin = join(ROOT, 'node_modules', '@foundry-rs', 'anvil', 'bin.mjs')
  const child = spawn(process.execPath, [anvilBin, '--fork-url', rpc, '--fork-block-number', String(head), '--port', String(port), '--chain-id', String(CHAIN_ID), '--silent'], {
    env: { ...process.env, SSL_CERT_FILE: process.env.SSL_CERT_FILE || '/root/.ccr/ca-bundle.crt' },
    stdio: 'ignore',
  })
  const fork = new JsonRpcProvider(`http://127.0.0.1:${port}`, CHAIN_ID, { staticNetwork: true })
  const results = { forkBlock: head, holder, tests: {} }
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await fork.send('eth_chainId', [])
        break
      } catch {
        await sleep(500)
      }
      if (i === 59) throw new Error('local anvil fork did not start')
    }
    const fund = async (a) => fork.send('anvil_setBalance', [a, '0x56BC75E2D63100000'])
    await fork.send('anvil_impersonateAccount', [holder])
    await fund(holder)
    const signer = await fork.getSigner(holder)
    const tk = new Contract(address, ERC20, signer)
    const bal = await tk.balanceOf(holder)
    const amount = bal / 20n > 0n ? bal / 20n : bal
    if (amount === 0n) throw new Error('impersonated holder has no balance')
    const eoa = Wallet.createRandom().address
    const vault = Wallet.createRandom().address
    await fork.send('anvil_setCode', [vault, '0x00']) // minimal contract recipient/spender
    const exact = async (who, before, expected) => {
      const got = (await tk.balanceOf(who)) - before
      return got === expected ? 'exact' : `received ${got} of ${expected} (FEE/REBASE)`
    }
    const run = async (name, fn) => {
      try {
        results.tests[name] = await fn()
      } catch (e) {
        results.tests[name] = 'REVERT: ' + String(e?.shortMessage || e?.message).slice(0, 120)
      }
    }
    await run('eoaToEoa', async () => { const b = await tk.balanceOf(eoa); await (await tk.transfer(eoa, amount / 4n)).wait(); return exact(eoa, b, amount / 4n) })
    await run('eoaToContract', async () => { const b = await tk.balanceOf(vault); await (await tk.transfer(vault, amount / 4n)).wait(); return exact(vault, b, amount / 4n) })
    await run('transferFromByContract', async () => {
      await (await tk.approve(vault, amount / 4n)).wait()
      await fork.send('anvil_impersonateAccount', [vault])
      await fund(vault)
      const vt = new Contract(address, ERC20, await fork.getSigner(vault))
      const b = await tk.balanceOf(vault)
      await (await vt.transferFrom(holder, vault, amount / 4n)).wait()
      return exact(vault, b, amount / 4n)
    })
    await run('contractToEoa', async () => {
      const vt = new Contract(address, ERC20, await fork.getSigner(vault))
      const b = await tk.balanceOf(eoa)
      await (await vt.transfer(eoa, amount / 8n)).wait()
      return exact(eoa, b, amount / 8n)
    })
    await run('toBurnAddress', async () => { const d = '0x000000000000000000000000000000000000dEaD'; const b = await tk.balanceOf(d); await (await tk.transfer(d, amount / 16n)).wait(); return exact(d, b, amount / 16n) })
    await run('zeroAmountTransfer', async () => { await (await tk.transfer(eoa, 0n)).wait(); return 'ok' })
    await run('repeatedTransfersStable', async () => {
      for (let i = 0; i < 3; i++) {
        const b = await tk.balanceOf(eoa)
        await (await tk.transfer(eoa, amount / 32n)).wait()
        const r = await exact(eoa, b, amount / 32n)
        if (r !== 'exact') return r
      }
      return 'exact'
    })
    if (hasBurn) await run('burnReducesSupply', async () => { const s = await tk.totalSupply(); await (await tk.burn(amount / 32n)).wait(); return s - (await tk.totalSupply()) === amount / 32n ? 'exact' : 'mismatch' })
    results.decimals = decimals
  } catch (e) {
    results.error = String(e?.message).slice(0, 200)
  } finally {
    child.kill('SIGTERM')
  }
  return results
}

// ------------------------------------------------------------------ checklist

function checklist(r) {
  const items = []
  const add = (key, status, detail) => items.push({ key, status, detail })
  const m = r.metadata
  add('exact-address', 'PASS', `Validated exact address ${m.address}; selection never by symbol.`)
  add('has-code', m.hasCode ? 'PASS' : 'FAIL', m.hasCode ? `${m.codeBytes} bytes of runtime code` : 'No code at address')
  if (!m.hasCode) return items
  add('decimals', m.decimals >= 6 && m.decimals <= 18 ? 'PASS' : 'FAIL', `decimals = ${m.decimals} (Locker accepts 6-18)`)
  const proxy = m.eip1167Clone || [m.eip1967.implementation, m.eip1967.beacon].some((s) => BigInt(s) !== 0n)
  add('not-upgradeable', proxy ? 'FAIL' : m.delegatecallOpcodePresent ? 'WARN' : 'PASS',
    proxy ? 'Proxy/clone markers present: implementation can change or is delegated' : m.delegatecallOpcodePresent ? 'DELEGATECALL opcode present; confirm it cannot change logic' : 'No EIP-1967/1167 markers, no DELEGATECALL')
  const owner = m.owner ?? m.getOwner
  const ownerLive = owner && BigInt(owner) !== 0n
  add('no-active-owner', ownerLive ? 'WARN' : 'PASS', ownerLive ? `owner() = ${owner}: review what the owner controls` : 'No owner or ownership renounced')
  const hard = m.riskySelectors.filter((s) => ['mint', 'blacklist', 'fee', 'pause', 'upgrade', 'limits', 'trading-gate'].includes(s.category))
  add('no-privileged-token-controls', hard.length ? 'FAIL' : 'PASS',
    hard.length ? `Selectors present: ${hard.map((s) => s.signature).join(', ')} (selector heuristics; confirm in source)` : 'No mint/blacklist/fee/pause/upgrade/limit selectors found')
  add('selfdestruct', m.selfdestructOpcodePresent ? 'WARN' : 'PASS', m.selfdestructOpcodePresent ? 'SELFDESTRUCT opcode present' : 'No SELFDESTRUCT opcode')
  const verified = /match|perfect|partial|exact/i.test(String(r.sourcify.status))
  add('source-verified', verified ? 'PASS' : 'FAIL', `Sourcify: ${r.sourcify.status}${r.sourcify.name ? ` (${r.sourcify.name}, ${r.sourcify.compiler})` : ''}`)
  const brand = BRAND_WORDS.filter((w) => `${m.name ?? ''} ${m.symbol ?? ''}`.toLowerCase().includes(w))
  add('no-impersonation', brand.length ? 'WARN' : 'PASS', brand.length ? `Name/symbol contains: ${brand.join(', ')} — manual review for impersonation` : 'No brand/person keywords (heuristic)')
  if (r.age) {
    const days = r.age.days
    add('age', days >= 30 ? 'PASS' : days >= 7 ? 'WARN' : 'FAIL', `First transfer ${r.age.firstTransferTime} (${days.toFixed(1)} days)`)
  } else add('age', 'WARN', 'First transfer not found')
  const h = r.holders
  if (h) {
    const complete = h.replay.stats.failedRanges.length === 0
    add('holder-replay-complete', complete && h.replay.supplyMatches && h.labels.mismatches === 0 ? 'PASS' : 'WARN',
      `${h.replay.stats.transfers} transfers replayed; ${h.replay.holders} holders; supply ${h.replay.supplyMatches ? 'matches' : 'DOES NOT match'} replay; ${h.labels.mismatches} of top ${h.labels.top.length} live balances differ; ${h.replay.stats.failedRanges.length} failed log ranges`)
    const big = h.concentration.largestNonInfrastructure?.pct ?? 0
    add('largest-holder', big < 5 ? 'PASS' : big < 15 ? 'WARN' : 'FAIL', `Largest non-infrastructure holder ${big}% of supply`)
    const fc = h.clusters.largestFundingClusterPct
    const sc = h.clusters.largestSuspiciousCluster
    const venues = h.clusters.fundingClusters.filter((g) => g.sharedVenue)
    add('funding-clusters', fc < 5 ? 'PASS' : fc < 15 ? 'WARN' : 'FAIL',
      `Largest group of top holders seeded by one non-router sender: ${fc}% of supply` + (sc ? ` (${sc.holders} holders from ${sc.source}, ${sc.kind})` : '') +
      (venues.length ? `; excluded shared venues: ${venues.map((g) => `${g.verifiedName} ${g.pctSupply}%`).join(', ')}` : ''))
    const eq = h.clusters.largestEqualBalanceCluster
    add('equal-balance-clusters', eq.holders >= 50 && eq.pctSupply >= 5 ? 'WARN' : 'PASS',
      `${eq.holders} of the top ${h.clusters.sampleSize} holders have balances within 2% of each other (${eq.pctSupply}% of supply)`)
    const sg = h.signers
    const sgPct = Math.max(sg.largestSignerCluster?.pctSupply ?? 0, sg.largestBundledTransaction?.pctSupply ?? 0)
    add('signer-clusters', sgPct < 5 ? 'PASS' : sgPct < 15 ? 'WARN' : 'FAIL',
      `${sg.holdersWhoSignedTheirOwnFirstReceipt} of top ${sg.sampleSize} holders signed their own first receipt; ` +
      (sg.largestSignerCluster ? `largest third-party signer funded ${sg.largestSignerCluster.holders} holders (${sg.largestSignerCluster.pctSupply}%); ` : 'no third-party signer funded 2+ top holders; ') +
      (sg.largestBundledTransaction ? `largest bundle delivered to ${sg.largestBundledTransaction.holders} holders in one tx (${sg.largestBundledTransaction.pctSupply}%)` : 'no multi-recipient first-receipt transactions'))
    const tw = h.clusters.largestFirstReceiptWindow
    add('first-receipt-timing', tw.holders >= 100 && tw.pctSupply >= 10 ? 'WARN' : 'PASS',
      `${tw.holders} of the top ${h.clusters.sampleSize} holders first received tokens within one ~1h window from block ${tw.fromBlock} (${tw.pctSupply}% of supply)`)
    const t10 = h.concentration.top10NonInfrastructurePct
    add('top10-concentration', t10 < 30 ? 'PASS' : t10 < 50 ? 'WARN' : 'FAIL', `Top-10 non-infrastructure holders ${t10}% of supply`)
  }
  if (r.liquidity) {
    const main = r.liquidity.pools[0]
    add('liquidity-exists', main && BigInt(main.activeLiquidity) > 0n ? 'PASS' : 'FAIL', main ? `${r.liquidity.pools.length} v4 pool(s); deepest ${main.poolId.slice(0, 12)}… active liquidity ${main.activeLiquidity}` : 'No Uniswap v4 pool found')
    if (main) {
      add('main-pool-no-hook', main.hasHook ? 'WARN' : 'PASS', main.hasHook ? `Hook ${main.hooks}: review hook code and ownership` : 'No hook')
      const lp = main.lockedOrBurnedInRangePct
      add('lp-custody', lp >= 80 ? 'PASS' : lp >= 50 ? 'WARN' : 'FAIL', `${lp.toFixed(1)}% of in-range liquidity in burned or locker-held positions (do not call it "permanently locked" without reviewing the locker)`)
    }
  }
  if (r.behaviour) {
    const vals = Object.entries(r.behaviour.tests)
    const bad = vals.filter(([, v]) => !['exact', 'ok'].includes(v))
    add('transfer-behaviour', r.behaviour.error ? 'WARN' : bad.length ? 'FAIL' : 'PASS', r.behaviour.error ? `Fork tests did not run: ${r.behaviour.error}` : bad.length ? bad.map(([k, v]) => `${k}: ${v}`).join('; ') : `${vals.length} local-fork transfer tests exact`)
  }
  return items
}

function markdown(r) {
  const m = r.metadata
  const lines = []
  lines.push(`# Token vetting report: ${m.name ?? '?'} (${m.symbol ?? '?'})`, '')
  lines.push(`- Address: \`${m.address}\``, `- Chain: Robinhood Chain mainnet (${CHAIN_ID})`, `- Head block analysed: ${r.head}`, `- Generated: ${r.generatedAt}`, `- Overall: **${r.overall}**`, '')
  lines.push('> A PASS is evidence gathered at one block, not a guarantee. Listing still requires human review.', '')
  lines.push('## Checklist', '', '| Check | Status | Detail |', '|---|---|---|')
  for (const i of r.checklist) lines.push(`| ${i.key} | ${i.status} | ${String(i.detail).replace(/\|/g, '\\|')} |`)
  if (r.holders) {
    lines.push('', '## Largest holders (full Transfer replay)', '', '| # | Address | Kind | % supply | Live = replay | Note |', '|---|---|---|---|---|---|')
    r.holders.labels.top.forEach((h, i) => lines.push(`| ${i + 1} | \`${h.address}\` | ${h.kind} | ${h.pctSupply} | ${h.liveBalanceMatchesReplay} | ${h.note ?? ''} |`))
    lines.push('', '```json', JSON.stringify({ concentration: r.holders.concentration, clusters: r.holders.clusters, signers: r.holders.signers }, null, 2), '```')
  }
  if (r.liquidity?.pools.length) {
    lines.push('', '## Uniswap v4 pools', '')
    for (const p of r.liquidity.pools.slice(0, 5)) {
      lines.push(`- \`${p.poolId}\` fee ${p.fee} hook ${p.hasHook ? p.hooks : 'none'}; active liquidity ${p.activeLiquidity}; ${p.livePositions} live positions; locked/burned in-range ${p.lockedOrBurnedInRangePct.toFixed(1)}%`)
      for (const o of p.positions.slice(0, 5)) lines.push(`  - tokenId ${o.tokenId ?? '-'} owner ${o.owner ?? o.manager}: ${o.custody}, ${o.inRange ? `${o.shareOfInRangePct}% of in-range` : 'out of range'}`)
    }
  }
  if (r.behaviour) lines.push('', '## Local-fork transfer tests', '', '```json', JSON.stringify(r.behaviour, null, 2), '```')
  lines.push('', '## Limitations', '')
  for (const l of r.limitations) lines.push(`- ${l}`)
  return lines.join('\n') + '\n'
}

// ------------------------------------------------------------------ main

async function vet(address, args) {
  const provider = new JsonRpcProvider(args.rpc, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 })
  const chainId = Number(await provider.send('eth_chainId', []))
  if (chainId !== CHAIN_ID) throw new Error(`RPC is chain ${chainId}, expected ${CHAIN_ID}`)
  const head = await provider.getBlockNumber()
  const r = { generatedAt: new Date().toISOString(), rpc: args.rpc.replace(/\/\/.*@/, '//***@'), head, limitations: [] }
  r.limitations.push(
    'Public RPC is not an archive node: state reads use the pinned head block and must finish within roughly 10-35 minutes.',
    'getLogs is limited to 10M-block spans and 10k results per call; ranges are split adaptively. Any range that still failed is listed under holder/liquidity log stats and makes the replay incomplete.',
    'Risky-function detection uses 4-byte selector matching on bytecode: it can miss renamed functions and can false-positive on unrelated constants. Verified source must be read for any WARN/FAIL.',
    'Signer clustering identifies wallets whose first tokens arrived in a transaction signed by another account. Independent signers funded with gas by one entity are not detected (native-transfer tracing needs an indexer this RPC lacks).',
    'Cluster heuristics only look one hop back (first funding sender) and at balance similarity; funding through intermediaries, CEX withdrawals or swaps defeats them.',
    'Holder labels distinguish EOA, contract and known infrastructure only. Exchange, team, bridge and multi-wallet clusters are not identified; a single entity may control many addresses (Sybil).',
    'LP attribution covers Uniswap v4 PoolManager positions only. Other DEXes or v3-style pools are not scanned. "Locked" means owned by the Pons locker, whose ownership controls must be reviewed separately (docs/SECURITY_REVIEW.md).',
  )
  process.stderr.write(`[vet] ${address} at block ${head}\n`)
  r.metadata = await metadata(provider, address, head)
  if (!r.metadata.hasCode) {
    r.checklist = checklist(r)
    r.overall = 'FAIL'
    return r
  }
  process.stderr.write('[vet] age\n')
  const first = await findFirstTransfer(provider, address, args.fromBlock, head)
  if (first) {
    const b = await provider.getBlock(first.blockNumber)
    const now = (await provider.getBlock(head)).timestamp
    r.age = { firstTransferBlock: first.blockNumber, firstTransferTime: new Date(b.timestamp * 1000).toISOString(), days: (now - b.timestamp) / 86400 }
  } else r.limitations.push('No Transfer event found; age and holder replay unavailable.')
  process.stderr.write('[vet] sourcify\n')
  r.sourcify = await sourcify(address)
  if (first) {
    process.stderr.write('[vet] replaying full Transfer history\n')
    const replay = await replayHolders(provider, address, first.blockNumber, head, r.metadata.totalSupplyRaw)
    const labels = await labelHolders(provider, address, replay.sorted, r.metadata.totalSupplyRaw, r.metadata.decimals, head)
    process.stderr.write('[vet] first-receipt signer analysis\n')
    const signers = await signerClusters(provider, replay.sorted, replay.firstTx, r.metadata.totalSupplyRaw)
    r.holders = {
      signers,
      replay: { ...replay, sorted: undefined, firstSource: undefined, firstBlock: undefined, firstTx: undefined },
      labels,
      concentration: concentration(replay.sorted, r.metadata.totalSupplyRaw),
      clusters: await classifySources(provider, clusters(replay.sorted, replay.firstSource, replay.firstBlock, r.metadata.totalSupplyRaw), head),
    }
    if (replay.negative) r.limitations.push(`${replay.negative} addresses have negative replayed balances: the token emits non-standard Transfer events or the log scan is incomplete.`)
    if (!replay.supplyMatches) r.limitations.push('Replayed circulating balance does not equal totalSupply (rebasing, non-standard mint/burn events, or incomplete logs).')
    process.stderr.write('[vet] v4 pools\n')
    r.liquidity = await v4Pools(provider, address, first.blockNumber, head)
    if (args.fork) {
      const candidate = labels.top.find((h) => h.kind === 'EOA') ?? labels.top.find((h) => h.kind !== 'infrastructure')
      if (candidate) {
        process.stderr.write(`[vet] local fork tests impersonating ${candidate.address}\n`)
        r.behaviour = await behaviourTests(args.rpc, address, candidate.address, r.metadata.decimals, r.metadata.benignSelectors.includes('burn(uint256)'), head)
      } else r.limitations.push('No suitable holder to impersonate for behaviour tests.')
    } else r.limitations.push('Local-fork behaviour tests skipped (--no-fork).')
  }
  r.checklist = checklist(r)
  r.overall = r.checklist.some((i) => i.status === 'FAIL') ? 'FAIL' : r.checklist.some((i) => i.status === 'WARN') ? 'PASS WITH WARNINGS (manual review required)' : 'PASS (manual review still required)'
  return r
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.inputs.length === 0) {
    console.log('Usage: npm run vet:token -- <0xExactTokenAddress> [more addresses] [--rpc URL] [--out DIR] [--no-fork] [--from-block N]')
    process.exit(args.help ? 0 : 1)
  }
  const addresses = args.inputs.map(validateAddress)
  mkdirSync(args.out, { recursive: true })
  let failed = false
  for (const address of addresses) {
    const r = await vet(address, args)
    const stamp = `${address}-${r.head}`
    const json = join(args.out, `${stamp}.json`)
    const md = join(args.out, `${stamp}.md`)
    writeFileSync(json, JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
    writeFileSync(md, markdown(r))
    console.log(`${address} ${r.metadata.symbol ?? ''}: ${r.overall}`)
    for (const i of r.checklist) console.log(`  [${i.status}] ${i.key}: ${i.detail}`)
    console.log(`  reports: ${md}`)
    if (r.overall === 'FAIL') failed = true
  }
  process.exit(failed ? 2 : 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[vet] error: ${e.message}`)
    process.exit(1)
  })
}
