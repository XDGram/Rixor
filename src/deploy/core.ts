// Rixor Deploy Console core: every safety check, independent of any UI. Used by the browser console
// (src/deploy/DeployConsole.tsx), the bundle exporter (scripts/export-deploy-bundle.mjs) and the tests
// (scripts/test-deploy-console.mjs). It never signs and never broadcasts: `preflight` returns the exact request for
// the user's wallet, and the user approves it there.
//
// Trust model: the console does not trust the bundle. It rebuilds every transaction (destination, calldata, value,
// nonce) and every post-deployment check from the pinned constants in ./expected.ts plus the seven reviewed
// addresses, and refuses a bundle that differs in any byte. The only values taken from the bundle are the runtime
// code hashes of contracts with constructor immutables (measured on the local plan and covered by the bundle hash
// the user compares out of band), the planned gas and labels.
import { AbiCoder, Interface, ZeroAddress, concat, dataLength, dataSlice, getAddress, getCreate2Address, getCreateAddress, id, isAddress, keccak256, solidityPacked, toUtf8Bytes } from 'ethers'
import {
  APPROVE_TOTAL, GAS_ESTIMATE_MAX_FACTOR, GAS_MARGIN_BPS, INITCODE_BYTES, INITCODE_HASH, LISTINGS, LOCKER_RUNTIME_HASH, MAINNET_CHAIN_ID, MIN_HOLD_SECONDS,
  REHEARSAL_CHAIN_ID, REHEARSAL_RPC_PATH, SAFE, SAFE_PROXY_RUNTIME_HASH, STEP_LAYOUT, STREAMS, TESTNET_CHAIN_ID, TESTNET_EXPLORER, TESTNET_RPC, TOKENS,
} from './expected.ts'

export const BUNDLE_FORMAT = 'rixor-deploy-bundle/1'
const coder = AbiCoder.defaultAbiCoder()

// ------------------------------------------------------------------ types

export type Check =
  | { kind: 'code'; label: string; address: string; codeHash: string }
  | { kind: 'storage'; label: string; address: string; slot: string; expect: string }
  | { kind: 'call'; label: string; to: string; data: string; expect: string; words?: number[] }
  | { kind: 'approveAccounted'; label: string; token: string; owner: string; spender: string; total: string; streamTokens: string[] }
  | { kind: 'stream'; label: string; rewards: string; id: number; funder: string; token: string; amount: string; days: number }

export type BundleTx = {
  index: number // 1..11
  nonce: number
  label: string
  from: string
  to: string | null // null = contract creation
  value: string // hex quantity
  data: string
  gasPlanned: string // gas used on the local plan (decimal)
  creates: { address: string; codeHash: string } | null
  checks: Check[]
}

export type Addresses = { ownerSafe: string; guardianSafe: string; tMEMEA: string; tMEMEB: string; tWIF: string; locker: string; rewards: string; challenges: string }

export type Bundle = {
  format: typeof BUNDLE_FORMAT
  final: boolean // true only when generated from the real, validated seven addresses
  rehearsal: boolean // true only for the local rehearsal chain (31337)
  chainId: number
  rpc: string
  explorer: string | null
  createdAt: string
  source: { commit: string; dirty: boolean; planner: string }
  deployer: string
  startNonce: number
  signers: { owner: string[]; guardian: string[] }
  addresses: Addresses
  transactions: BundleTx[]
  gas: { totalPlanned: string; gasPriceWei: string; l1ComponentGas: string }
  bundleHash: string
}

/** Raw JSON-RPC: the node's RPC (independent view) or the wallet's EIP-1193 `request`. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>
export const rpcFromEip1193 = (p: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }): Rpc => (method, params) => p.request({ method, params })

export type CheckResult = { label: string; ok: boolean; detail?: string }

// ------------------------------------------------------------------ helpers

const eq = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16)
const tokenAddr = (a: Addresses, key: string) => (a as Record<string, string>)[key]

/** Deterministic JSON (sorted keys) used for the bundle hash. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
export function bundleHashOf(b: Omit<Bundle, 'bundleHash'> & { bundleHash?: string }): string {
  const { bundleHash: _ignored, ...rest } = b
  void _ignored
  return keccak256(toUtf8Bytes(canonicalJson(rest)))
}

const SAFE_IFACE = new Interface([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)',
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
])
const ERC20 = new Interface([
  'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)',
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function faucetAmount() view returns (uint256)',
])
const LOCKER = new Interface([
  'function owner() view returns (address)', 'function guardian() view returns (address)', 'function pendingOwner() view returns (address)',
  'function listedTokens() view returns (address[])',
  'function tokenConfig(address) view returns ((bool listed,bool locksEnabled,uint8 decimals,uint8 riskClass,uint64 lastUnitChange,uint64 releasedAt,uint256 unitAmount,uint256 maxTotalLocked,uint256 totalLocked,uint256 totalWeight))',
])
const REWARDS = new Interface([
  'function fund(address token, uint256 amount, uint256 days_) returns (uint256)',
  'function locker() view returns (address)', 'function wif() view returns (address)', 'function streamCount() view returns (uint256)',
  'function streamOf(uint256) view returns ((address funder,address token,uint64 startDay,uint64 endDay,bool refunded,uint256 rate,uint256 amount))',
])
const CHALLENGES = new Interface(['function locker() view returns (address)', 'function wif() view returns (address)', 'function minHold() view returns (uint256)'])

export const safeSalt = (label: string) => BigInt(id(label))
export function safeInitializer(signers: string[]): string {
  return SAFE_IFACE.encodeFunctionData('setup', [signers, SAFE.threshold, ZeroAddress, '0x', SAFE.fallbackHandler, ZeroAddress, 0, ZeroAddress])
}
/** Safe v1.5.0 factory CREATE2: salt = keccak256(keccak256(initializer) ++ saltNonce). */
export function predictSafe(signers: string[], saltLabel: string): string {
  const salt = keccak256(solidityPacked(['bytes32', 'uint256'], [keccak256(safeInitializer(signers)), safeSalt(saltLabel)]))
  return getCreate2Address(SAFE.factory, salt, SAFE.proxyInitcodeHash)
}
export const predictCreate = (deployer: string, nonce: number) => getCreateAddress({ from: deployer, nonce })

// ------------------------------------------------------------------ expected transactions and checks

type ExpectedTx = { to: string | null; data?: string; createKind?: keyof typeof INITCODE_HASH; ctorArgs?: string; creates: string | null }

/** The approved addresses for these seven inputs, computed independently of the bundle. */
export function expectedAddresses(deployer: string, startNonce: number, owner: string[], guardian: string[]): Addresses {
  const c = (k: number) => predictCreate(deployer, startNonce + k)
  return {
    ownerSafe: predictSafe(owner, SAFE.ownerSaltLabel), guardianSafe: predictSafe(guardian, SAFE.guardianSaltLabel),
    tMEMEA: c(2), tMEMEB: c(3), tWIF: c(4), locker: c(5), rewards: c(6), challenges: c(7),
  }
}

/** What step `i` (0-based) must be, rebuilt from the pinned constants. */
export function expectedTx(b: Pick<Bundle, 'deployer' | 'signers' | 'addresses'>, i: number): ExpectedTx {
  const L = STEP_LAYOUT[i]
  const a = b.addresses
  switch (L.kind) {
    case 'safe': {
      const signers = L.role === 'owner' ? b.signers.owner : b.signers.guardian
      const salt = safeSalt(L.role === 'owner' ? SAFE.ownerSaltLabel : SAFE.guardianSaltLabel)
      return { to: SAFE.factory, data: SAFE_IFACE.encodeFunctionData('createProxyWithNonce', [SAFE.singletonL2, safeInitializer(signers), salt]), creates: L.role === 'owner' ? a.ownerSafe : a.guardianSafe }
    }
    case 'token': {
      const t = TOKENS.find((x) => x.key === L.token)!
      return { to: null, createKind: 'RixorTestToken', ctorArgs: coder.encode(['string', 'string', 'uint8', 'uint256', 'address', 'uint256'], [t.name, t.symbol, t.decimals, t.supply, b.deployer, t.faucet]), creates: tokenAddr(a, t.key) }
    }
    case 'locker':
      return {
        to: null, createKind: 'RixorLocker', creates: a.locker,
        ctorArgs: coder.encode(['address', 'address', 'tuple(address,uint256,uint256,uint8)[]'], [a.ownerSafe, a.guardianSafe, LISTINGS.map((l) => [tokenAddr(a, l.token), l.unitAmount, l.maxTotalLocked, l.riskClass])]),
      }
    case 'rewards':
      return { to: null, createKind: 'RixorRewards', creates: a.rewards, ctorArgs: coder.encode(['address', 'address'], [a.locker, a.tWIF]) }
    case 'challenges':
      return { to: null, createKind: 'RixorChallenges', creates: a.challenges, ctorArgs: coder.encode(['address', 'address', 'uint256'], [a.locker, a.tWIF, MIN_HOLD_SECONDS]) }
    case 'approve':
      return { to: a.tWIF, data: ERC20.encodeFunctionData('approve', [a.rewards, APPROVE_TOTAL]), creates: null }
    case 'fund': {
      const s = STREAMS[L.stream]
      return { to: a.rewards, data: REWARDS.encodeFunctionData('fund', [tokenAddr(a, s.token), s.amount, s.days]), creates: null }
    }
  }
}

/** Durable checks for step `i`: true right after the step and at any later time, so they also prove a completed step
 *  on resumption. Values that legitimately change with use (balances, totals, rates) are never compared. */
export function expectedChecks(b: Pick<Bundle, 'deployer' | 'signers' | 'addresses' | 'transactions'>, i: number): Check[] {
  const L = STEP_LAYOUT[i]
  const a = b.addresses
  const call = (label: string, to: string, iface: Interface, fn: string, args: unknown[], result: unknown[], words?: number[]): Check => ({
    kind: 'call', label, to, data: iface.encodeFunctionData(fn, args), expect: iface.encodeFunctionResult(fn, result), ...(words ? { words } : {}),
  })
  const created = b.transactions[i]?.creates
  switch (L.kind) {
    case 'safe': {
      const safe = L.role === 'owner' ? a.ownerSafe : a.guardianSafe
      const signers = L.role === 'owner' ? b.signers.owner : b.signers.guardian
      return [
        { kind: 'code', label: `${L.role} Safe proxy code`, address: safe, codeHash: SAFE_PROXY_RUNTIME_HASH },
        { kind: 'storage', label: `${L.role} Safe singleton is Safe v1.5.0 (L2)`, address: safe, slot: hex(0), expect: coder.encode(['address'], [SAFE.singletonL2]) },
        call(`${L.role} Safe signers`, safe, SAFE_IFACE, 'getOwners', [], [signers]),
        call(`${L.role} Safe threshold is 2`, safe, SAFE_IFACE, 'getThreshold', [], [SAFE.threshold]),
      ]
    }
    case 'token': {
      const t = TOKENS.find((x) => x.key === L.token)!
      const addr = tokenAddr(a, t.key)
      return [
        { kind: 'code', label: `${t.symbol} code`, address: addr, codeHash: created?.codeHash ?? '' },
        call(`${t.symbol} name`, addr, ERC20, 'name', [], [t.name]),
        call(`${t.symbol} symbol`, addr, ERC20, 'symbol', [], [t.symbol]),
        call(`${t.symbol} decimals`, addr, ERC20, 'decimals', [], [t.decimals]),
        call(`${t.symbol} faucet amount`, addr, ERC20, 'faucetAmount', [], [t.faucet]),
      ]
    }
    case 'locker': {
      const cfg = (l: (typeof LISTINGS)[number]) => {
        const dec = TOKENS.find((x) => x.key === l.token)!.decimals
        // words: 0 listed, 2 decimals, 3 riskClass, 6 unitAmount, 7 maxTotalLocked (1, 4, 5, 8, 9 change with use)
        return call(`Locker listing ${l.token}: class ${l.riskClass}, unit and cap`, a.locker, LOCKER, 'tokenConfig', [tokenAddr(a, l.token)], [[true, true, dec, l.riskClass, 0, 0, l.unitAmount, l.maxTotalLocked, 0, 0]], [0, 2, 3, 6, 7])
      }
      return [
        { kind: 'code', label: 'RixorLocker code (matches the reviewed build byte for byte)', address: a.locker, codeHash: LOCKER_RUNTIME_HASH },
        call('Locker owner is the owner Safe', a.locker, LOCKER, 'owner', [], [a.ownerSafe]),
        call('Locker guardian is the guardian Safe', a.locker, LOCKER, 'guardian', [], [a.guardianSafe]),
        call('Locker has no pending owner', a.locker, LOCKER, 'pendingOwner', [], [ZeroAddress]),
        call('Locker lists exactly tMEMEA and tMEMEB', a.locker, LOCKER, 'listedTokens', [], [[a.tMEMEA, a.tMEMEB]]),
        ...LISTINGS.map(cfg),
      ]
    }
    case 'rewards':
      return [
        { kind: 'code', label: 'RixorRewards code', address: a.rewards, codeHash: created?.codeHash ?? '' },
        call('Rewards reads the Locker', a.rewards, REWARDS, 'locker', [], [a.locker]),
        call('Rewards pays tWIF', a.rewards, REWARDS, 'wif', [], [a.tWIF]),
      ]
    case 'challenges':
      return [
        { kind: 'code', label: 'RixorChallenges code', address: a.challenges, codeHash: created?.codeHash ?? '' },
        call('Challenges reads the Locker', a.challenges, CHALLENGES, 'locker', [], [a.locker]),
        call('Challenges pays tWIF', a.challenges, CHALLENGES, 'wif', [], [a.tWIF]),
        call('Challenges minimum hold is 3,600 s', a.challenges, CHALLENGES, 'minHold', [], [MIN_HOLD_SECONDS]),
      ]
    case 'approve':
      return [{ kind: 'approveAccounted', label: 'Approval for 210,000 tWIF (remaining allowance + funded streams)', token: a.tWIF, owner: b.deployer, spender: a.rewards, total: APPROVE_TOTAL.toString(), streamTokens: STREAMS.map((s) => tokenAddr(a, s.token)) }]
    case 'fund': {
      const s = STREAMS[L.stream]
      return [{ kind: 'stream', label: `Stream ${L.stream}: ${s.token}, ${(s.amount / 10n ** 18n).toLocaleString('en-US')} tWIF over ${s.days} days, funded by the deployer`, rewards: a.rewards, id: L.stream, funder: b.deployer, token: tokenAddr(a, s.token), amount: s.amount.toString(), days: Number(s.days) }]
    }
  }
}

// ------------------------------------------------------------------ static validation (no network)

export function signerProblems(deployer: string, owner: string[], guardian: string[]): string[] {
  const p: string[] = []
  if (!Array.isArray(owner) || !Array.isArray(guardian) || owner.length !== 3 || guardian.length !== 3) return ['exactly 3 owner-Safe signers and 3 guardian-Safe signers are required (2-of-3 each)']
  const all = [...owner, ...guardian]
  for (const s of all) if (!isAddress(s) || getAddress(s) === ZeroAddress) p.push(`invalid signer address ${String(s)}`)
  if (p.length) return p
  const lower = all.map((s) => s.toLowerCase())
  if (new Set(lower).size !== 6) p.push('the six Safe signers must be six distinct addresses (no duplicate, no address in both Safes)')
  if (lower.includes(deployer.toLowerCase())) p.push('the deployer must not be one of the Safe signers')
  return p
}

/** Everything that can be checked without the network. Empty array = the bundle is exactly the approved plan. */
/** `opts.exporterSelfCheckOfPlaceholder` is used ONLY by the exporter to self-check an illustrative (final:false)
 *  testnet bundle; the console never passes it, so it always refuses a non-final testnet bundle. */
export function validateBundle(b: Bundle, opts: { exporterSelfCheckOfPlaceholder?: boolean } = {}): string[] {
  const p: string[] = []
  if (!b || typeof b !== 'object') return ['not a bundle']
  if (b.format !== BUNDLE_FORMAT) p.push(`unknown bundle format ${String(b.format)}`)
  if (b.chainId === MAINNET_CHAIN_ID) return ['REFUSED: Robinhood Chain mainnet (4663). This console only deploys to testnet (46630) or the local rehearsal chain (31337).']
  if (b.chainId !== TESTNET_CHAIN_ID && b.chainId !== REHEARSAL_CHAIN_ID) return [`unsupported chain ${String(b.chainId)}: only 46630 (testnet) or 31337 (local rehearsal)`]
  if (b.rehearsal !== (b.chainId === REHEARSAL_CHAIN_ID)) p.push('the rehearsal flag does not match the chain id')
  if (b.chainId === TESTNET_CHAIN_ID && !b.final && !opts.exporterSelfCheckOfPlaceholder) p.push('not a final bundle: it was made with placeholder addresses and cannot be used on testnet')
  if (b.chainId === TESTNET_CHAIN_ID && (b.rpc !== TESTNET_RPC || b.explorer !== TESTNET_EXPLORER)) p.push(`a testnet bundle must use the official RPC ${TESTNET_RPC} and explorer ${TESTNET_EXPLORER}`)
  if (b.chainId === REHEARSAL_CHAIN_ID && b.rpc !== REHEARSAL_RPC_PATH) p.push(`a rehearsal bundle must use the same-origin RPC path "${REHEARSAL_RPC_PATH}"`)
  if (!isAddress(b.deployer) || getAddress(b.deployer) === ZeroAddress) return [...p, 'invalid deployer address']
  if (!Number.isInteger(b.startNonce) || b.startNonce < 0) p.push('invalid start nonce')
  p.push(...signerProblems(b.deployer, b.signers?.owner, b.signers?.guardian))
  if (p.length) return p
  const want = expectedAddresses(b.deployer, b.startNonce, b.signers.owner, b.signers.guardian)
  for (const k of Object.keys(want) as (keyof Addresses)[]) if (!eq(b.addresses?.[k], want[k])) p.push(`address ${k} is ${b.addresses?.[k]}, but the approved plan gives ${want[k]}`)
  if (!Array.isArray(b.transactions) || b.transactions.length !== STEP_LAYOUT.length) return [...p, `expected exactly ${STEP_LAYOUT.length} transactions`]
  b.transactions.forEach((t, i) => {
    const n = i + 1
    if (t.index !== n) p.push(`transaction ${n}: wrong index`)
    if (t.nonce !== b.startNonce + i) p.push(`transaction ${n}: nonce ${t.nonce}, expected ${b.startNonce + i}`)
    if (!eq(t.from, b.deployer)) p.push(`transaction ${n}: sender is not the deployer`)
    if (BigInt(t.value ?? '0x0') !== 0n) p.push(`transaction ${n}: value must be 0`)
    if (t.label !== STEP_LAYOUT[i].label) p.push(`transaction ${n}: unexpected label`)
    const e = expectedTx(b, i)
    if ((t.to === null) !== (e.to === null) || (e.to && !eq(t.to, e.to))) p.push(`transaction ${n}: destination ${t.to ?? 'contract creation'} differs from the approved ${e.to ?? 'contract creation'}`)
    if (e.data !== undefined) {
      if (!eq(t.data, e.data)) p.push(`transaction ${n}: calldata differs from the approved transaction`)
    } else if (e.createKind) {
      const size = INITCODE_BYTES[e.createKind]
      const d = String(t.data ?? '0x')
      if (!/^0x[0-9a-fA-F]*$/.test(d) || dataLength(d) !== size + dataLength(e.ctorArgs!)) p.push(`transaction ${n}: deployment payload has the wrong size`)
      else {
        if (keccak256(dataSlice(d, 0, size)) !== INITCODE_HASH[e.createKind]) p.push(`transaction ${n}: ${e.createKind} creation code differs from the reviewed build`)
        if (!eq(dataSlice(d, size), e.ctorArgs!)) p.push(`transaction ${n}: ${e.createKind} constructor arguments differ from the approved configuration`)
      }
    }
    if (!eq(t.creates?.address ?? null, e.creates)) p.push(`transaction ${n}: predicted address differs from the approved plan`)
    if (e.creates && !/^0x[0-9a-f]{64}$/i.test(t.creates?.codeHash ?? '')) p.push(`transaction ${n}: missing expected code hash`)
    if (STEP_LAYOUT[i].kind === 'locker' && !eq(t.creates?.codeHash, LOCKER_RUNTIME_HASH)) p.push(`transaction ${n}: Locker code hash differs from the reviewed build`)
    if (STEP_LAYOUT[i].kind === 'safe' && !eq(t.creates?.codeHash, SAFE_PROXY_RUNTIME_HASH)) p.push(`transaction ${n}: Safe proxy code hash differs`)
    if (canonicalJson(t.checks) !== canonicalJson(expectedChecks(b, i))) p.push(`transaction ${n}: verification checks differ from the approved checks`)
    if (!/^\d+$/.test(String(t.gasPlanned)) || BigInt(t.gasPlanned) === 0n) p.push(`transaction ${n}: missing planned gas`)
  })
  if (b.bundleHash !== bundleHashOf(b)) p.push('bundle hash does not match the content (the file was changed after it was generated)')
  return p
}

// ------------------------------------------------------------------ live checks

export async function runCheck(rpc: Rpc, c: Check): Promise<CheckResult> {
  try {
    switch (c.kind) {
      case 'code': {
        const code = String(await rpc('eth_getCode', [c.address, 'latest']))
        if (code === '0x') return { label: c.label, ok: false, detail: 'no contract at the expected address' }
        return keccak256(code) === c.codeHash.toLowerCase() || eq(keccak256(code), c.codeHash) ? { label: c.label, ok: true } : { label: c.label, ok: false, detail: 'contract code differs from the reviewed build' }
      }
      case 'storage': {
        const v = String(await rpc('eth_getStorageAt', [c.address, c.slot, 'latest']))
        return eq(v, c.expect) ? { label: c.label, ok: true } : { label: c.label, ok: false, detail: `found ${v}` }
      }
      case 'call': {
        const out = String(await rpc('eth_call', [{ to: c.to, data: c.data }, 'latest']))
        if (!c.words) return eq(out, c.expect) ? { label: c.label, ok: true } : { label: c.label, ok: false, detail: 'unexpected value' }
        for (const w of c.words) if (!eq(dataSlice(out, w * 32, w * 32 + 32), dataSlice(c.expect, w * 32, w * 32 + 32))) return { label: c.label, ok: false, detail: `field ${w} differs` }
        return { label: c.label, ok: true }
      }
      case 'approveAccounted': {
        const allowance = BigInt(String(await rpc('eth_call', [{ to: c.token, data: ERC20.encodeFunctionData('allowance', [c.owner, c.spender]) }, 'latest'])))
        const n = Number(BigInt(String(await rpc('eth_call', [{ to: c.spender, data: REWARDS.encodeFunctionData('streamCount', []) }, 'latest']))))
        let funded = 0n
        for (let i = 0; i < n; i++) {
          const raw = String(await rpc('eth_call', [{ to: c.spender, data: REWARDS.encodeFunctionData('streamOf', [i]) }, 'latest']))
          const [s] = REWARDS.decodeFunctionResult('streamOf', raw)
          if (eq(s.funder, c.owner) && c.streamTokens.some((t) => eq(t, s.token))) funded += BigInt(s.amount)
        }
        return allowance + funded === BigInt(c.total) ? { label: c.label, ok: true } : { label: c.label, ok: false, detail: `allowance ${allowance} + funded ${funded} != ${c.total}` }
      }
      case 'stream': {
        const n = Number(BigInt(String(await rpc('eth_call', [{ to: c.rewards, data: REWARDS.encodeFunctionData('streamCount', []) }, 'latest']))))
        if (n <= c.id) return { label: c.label, ok: false, detail: 'stream not found' }
        const [s] = REWARDS.decodeFunctionResult('streamOf', String(await rpc('eth_call', [{ to: c.rewards, data: REWARDS.encodeFunctionData('streamOf', [c.id]) }, 'latest'])))
        const ok = eq(s.funder, c.funder) && eq(s.token, c.token) && BigInt(s.amount) === BigInt(c.amount) && BigInt(s.endDay) - BigInt(s.startDay) === BigInt(c.days)
        return ok ? { label: c.label, ok: true } : { label: c.label, ok: false, detail: 'stream differs (funder, token, amount or duration)' }
      }
    }
  } catch (e) {
    return { label: c.label, ok: false, detail: e instanceof Error ? e.message.slice(0, 160) : String(e) }
  }
}

export type StepState = 'done' | 'next' | 'todo' | 'failed'
export type Assessment = {
  status: 'ready' | 'complete' | 'pending' | 'halt'
  /** 0-based index of the next step to send (ready), or the number of steps when complete. */
  next: number
  steps: { state: StepState; checks: CheckResult[] }[]
  problems: string[]
  chainNonce: number
}

const nonceOf = async (rpc: Rpc, a: string, tag: 'latest' | 'pending') => Number(BigInt(String(await rpc('eth_getTransactionCount', [a, tag]))))

/** Reads the chain (never the wallet) and decides what has been done. Completed steps are proven by their durable
 *  checks; anything unexpected halts the console. */
export async function assess(rpc: Rpc, b: Bundle): Promise<Assessment> {
  const steps = b.transactions.map(() => ({ state: 'todo' as StepState, checks: [] as CheckResult[] }))
  const halt = (problems: string[], chainNonce = -1, next = 0): Assessment => ({ status: 'halt', next, steps, problems, chainNonce })
  const chain = Number(BigInt(String(await rpc('eth_chainId', []))))
  if (chain === MAINNET_CHAIN_ID) return halt(['REFUSED: the RPC is Robinhood Chain mainnet (4663).'])
  if (chain !== b.chainId) return halt([`the RPC is chain ${chain}, the bundle is for chain ${b.chainId}`])
  const [latest, pending] = await Promise.all([nonceOf(rpc, b.deployer, 'latest'), nonceOf(rpc, b.deployer, 'pending')])
  if (pending > latest) return { status: 'pending', next: latest - b.startNonce, steps, problems: ['a transaction from the deployer is still pending; wait for it to be mined'], chainNonce: latest }
  const sent = latest - b.startNonce
  if (sent < 0) return halt([`the deployer's nonce (${latest}) is below the plan's start (${b.startNonce}): wrong chain or wrong plan`], latest)
  const n = b.transactions.length
  const problems: string[] = []
  for (let i = 0; i < Math.min(sent, n); i++) {
    const results = await Promise.all(expectedChecks(b, i).map((c) => runCheck(rpc, c)))
    steps[i] = { state: results.every((r) => r.ok) ? 'done' : 'failed', checks: results }
    if (steps[i].state === 'failed') problems.push(`step ${i + 1} (nonce ${b.startNonce + i}) was used, but its result does not match the plan: ${results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.detail}`).join('; ')}`)
  }
  if (problems.length) return halt([...problems, 'Stop. Do not send anything else from the deployer. Re-plan from the current chain state.'], latest, Math.min(sent, n))
  if (sent >= n) return { status: 'complete', next: n, steps, problems: sent > n ? [`the deployer has sent ${sent - n} more transaction(s) after the deployment (not part of the plan)`] : [], chainNonce: latest }
  // Nothing may already exist where the remaining steps will deploy (a pre-existing Safe would shift every nonce).
  for (let i = sent; i < n; i++) {
    const at = b.transactions[i].creates?.address
    if (at && String(await rpc('eth_getCode', [at, 'latest'])) !== '0x') problems.push(`step ${i + 1}: a contract already exists at ${at}. Re-plan (a Safe created by someone else shifts every later address).`)
  }
  if (sent === 0) {
    for (const s of [...b.signers.owner, ...b.signers.guardian]) {
      if (String(await rpc('eth_getCode', [s, 'latest'])) !== '0x') problems.push(`signer ${s} is not a plain EOA on this chain (contract code or EIP-7702 delegation)`)
    }
    if (String(await rpc('eth_getCode', [b.deployer, 'latest'])) !== '0x') problems.push('the deployer is not a plain EOA on this chain')
  }
  if (problems.length) return halt(problems, latest, sent)
  steps[sent].state = 'next'
  return { status: 'ready', next: sent, steps, problems: [], chainNonce: latest }
}

export type TxRequest = { from: string; to?: string; data: string; value: string; gas: string }
export type Preflight = { ok: boolean; checks: CheckResult[]; request: TxRequest | null; costWei: bigint; gasLimit: bigint }

/** Independent checks before asking the wallet to sign step `i` (0-based). `node` is the chain's RPC, `wallet` the
 *  wallet's EIP-1193 request. Returns the exact request to pass to eth_sendTransaction, or ok:false. */
export async function preflight(node: Rpc, wallet: Rpc, b: Bundle, i: number): Promise<Preflight> {
  const checks: CheckResult[] = []
  const add = (label: string, ok: boolean, detail?: string) => { checks.push({ label, ok, detail }); return ok }
  const fail = (): Preflight => ({ ok: false, checks, request: null, costWei: 0n, gasLimit: 0n })
  const staticProblems = validateBundle(b)
  if (!add('Bundle is exactly the approved plan', staticProblems.length === 0, staticProblems.slice(0, 3).join('; '))) return fail()
  const t = b.transactions[i]
  if (!add(`Step ${i + 1} exists`, Boolean(t))) return fail()

  const [walletChain, nodeChain] = await Promise.all([wallet('eth_chainId', []).then((v) => Number(BigInt(String(v)))).catch(() => -1), node('eth_chainId', []).then((v) => Number(BigInt(String(v)))).catch(() => -1)])
  if (walletChain === MAINNET_CHAIN_ID || nodeChain === MAINNET_CHAIN_ID) { add('Not Robinhood Chain mainnet', false, 'REFUSED: mainnet (4663) is never used by this console'); return fail() }
  if (!add(`Wallet network is chain ${b.chainId}`, walletChain === b.chainId, `wallet is on chain ${walletChain}`)) return fail()
  if (!add(`RPC is chain ${b.chainId}`, nodeChain === b.chainId, `RPC reports chain ${nodeChain}`)) return fail()

  const accounts = (await wallet('eth_accounts', []).catch(() => [])) as string[]
  if (!add('Connected account is the planned deployer', Array.isArray(accounts) && eq(accounts[0], b.deployer), `connected: ${accounts?.[0] ?? 'none'}`)) return fail()

  const a = await assess(node, b)
  if (!add('Chain state matches the plan', a.status === 'ready' || a.status === 'complete', a.problems.join(' '))) return fail()
  if (!add(`Step ${i + 1} is the next step (no step is ever sent twice)`, a.status === 'ready' && a.next === i, a.status === 'complete' ? 'deployment already complete' : `next step is ${a.next + 1}`)) return fail()

  const [latest, pending] = await Promise.all([nonceOf(node, b.deployer, 'latest'), nonceOf(node, b.deployer, 'pending')])
  if (!add(`Deployer nonce is ${t.nonce} (reviewed plan)`, latest === t.nonce && pending === t.nonce, `chain nonce ${latest}, pending ${pending}`)) return fail()
  const walletNonce = await wallet('eth_getTransactionCount', [b.deployer, 'pending']).then((v) => Number(BigInt(String(v)))).catch(() => null)
  if (walletNonce !== null && !add("Wallet's view of the nonce agrees", walletNonce === t.nonce, `wallet reports ${walletNonce}`)) return fail()

  const e = expectedTx(b, i)
  if (!add('Destination matches the approved transaction', e.to === null ? t.to === null : eq(t.to, e.to))) return fail()
  const dataOk = e.data !== undefined ? eq(t.data, e.data) : keccak256(dataSlice(t.data, 0, INITCODE_BYTES[e.createKind!])) === INITCODE_HASH[e.createKind!] && eq(dataSlice(t.data, INITCODE_BYTES[e.createKind!]), e.ctorArgs!)
  if (!add('Calldata matches the approved transaction exactly', dataOk)) return fail()
  if (!add('Value is 0', BigInt(t.value) === 0n)) return fail()
  if (t.creates && !add(`Predicted address ${t.creates.address} is still empty`, String(await node('eth_getCode', [t.creates.address, 'latest'])) === '0x')) return fail()

  let estimate: bigint
  try {
    estimate = BigInt(String(await node('eth_estimateGas', [{ from: b.deployer, ...(t.to ? { to: t.to } : {}), data: t.data, value: '0x0' }])))
  } catch (err) {
    add('The transaction would succeed (gas estimate)', false, `the node rejects it: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`)
    return fail()
  }
  const planned = BigInt(t.gasPlanned)
  if (!add('Gas estimate is consistent with the reviewed plan', estimate <= planned * GAS_ESTIMATE_MAX_FACTOR, `estimate ${estimate} vs planned ${planned}`)) return fail()
  const base = estimate > planned ? estimate : planned
  const gasLimit = (base * GAS_MARGIN_BPS + 9_999n) / 10_000n
  const gasPrice = BigInt(String(await node('eth_gasPrice', [])))
  const costWei = gasLimit * gasPrice * 2n // twice the current price as headroom
  const balance = BigInt(String(await node('eth_getBalance', [b.deployer, 'latest'])))
  if (!add('Enough testnet ETH for this step', balance >= costWei, `balance ${balance} wei, needs up to ${costWei} wei`)) return fail()

  const request: TxRequest = { from: getAddress(b.deployer), ...(t.to ? { to: getAddress(t.to) } : {}), data: t.data, value: '0x0', gas: hex(gasLimit) }
  return { ok: true, checks, request, costWei, gasLimit }
}

/** After the wallet returns a hash and the transaction is mined: proves it was exactly step `i` and that it worked. */
export async function verifySent(node: Rpc, b: Bundle, i: number, hash: string): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const checks: CheckResult[] = []
  const add = (label: string, ok: boolean, detail?: string) => { checks.push({ label, ok, detail }); return ok }
  const t = b.transactions[i]
  const tx = (await node('eth_getTransactionByHash', [hash])) as { from: string; to: string | null; nonce: string; input: string; value: string; chainId?: string } | null
  const rc = (await node('eth_getTransactionReceipt', [hash])) as { status: string; contractAddress: string | null } | null
  if (!add('Transaction found on chain', Boolean(tx) && Boolean(rc))) return { ok: false, checks }
  add('Sent by the deployer', eq(tx!.from, b.deployer), tx!.from)
  add(`Used nonce ${t.nonce}`, Number(BigInt(tx!.nonce)) === t.nonce, `nonce ${Number(BigInt(tx!.nonce))}`)
  if (tx!.chainId !== undefined && tx!.chainId !== null) add(`Signed for chain ${b.chainId}`, Number(BigInt(tx!.chainId)) === b.chainId)
  add('Destination is the approved one', t.to === null ? !tx!.to : eq(tx!.to, t.to))
  add('Calldata is exactly the approved calldata', eq(tx!.input, t.data))
  add('Value is 0', BigInt(tx!.value) === 0n)
  add('Executed successfully', BigInt(rc!.status) === 1n, `status ${rc!.status}`)
  if (t.to === null && t.creates) add(`Contract created at ${t.creates.address}`, eq(rc!.contractAddress, t.creates.address), `created at ${rc!.contractAddress}`)
  for (const c of expectedChecks(b, i)) checks.push(await runCheck(node, c))
  return { ok: checks.every((c) => c.ok), checks }
}

/** The app manifest (public/testnet/deployment.json) for a completed, verified deployment. Publishing it is a
 *  separate, explicitly approved step. */
export function manifestFor(b: Bundle, block: number) {
  // Same fields as src/protocol/testnet.ts TestnetDeployment.
  return {
    chainId: b.chainId, block, locker: b.addresses.locker, rewards: b.addresses.rewards, challenges: b.addresses.challenges,
    wif: b.addresses.tWIF, ownerSafe: b.addresses.ownerSafe, guardianSafe: b.addresses.guardianSafe, minHoldSeconds: Number(MIN_HOLD_SECONDS),
  }
}

export const explorerTx = (b: Bundle, hash: string) => (b.explorer ? `${b.explorer.replace(/\/$/, '')}/tx/${hash}` : null)
export const explorerAddress = (b: Bundle, addr: string) => (b.explorer ? `${b.explorer.replace(/\/$/, '')}/address/${addr}` : null)
