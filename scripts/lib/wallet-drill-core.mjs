// Pure logic for the mobile-wallet signing drill station (scripts/wallet-drill.mjs) and its tests
// (scripts/test-wallet-drill.mjs). No network, no device, no keys. The drill file itself is produced by the unchanged
// `safe-tx.mjs drill`; this module only checks it against the published values and verifies signatures with the same
// functions `safe-tx.mjs check` uses (signatureProblem + EIP-712 verifyTypedData).
import { createHash } from 'node:crypto'
import { getAddress, verifyTypedData } from 'ethers'
import { TYPES, hashesOf, signatureProblem, typedProblems } from './safe-typed.mjs'

// Published drill values (docs/LEDGER_WINDOWS_CMD.md, docs/TESTNET_DEPLOYMENT.md, scripts/test-safe-signing.mjs).
export const PINNED = Object.freeze({
  fileSha256: '489faedae00cff6af2e32a71275c01cb34a0f98ce49069860f655023a4356e53',
  domainHash: '0xb1d7214fcc497f10f1d3856096eb3488620f3bf807fbce3d2b736a6d60644130',
  messageHash: '0xb55a82e23ac7c0476cc3abb0ad7a160811c811401e1db2f8a9f00e787db9cc22',
  safeTxHash: '0x249e198fa22b02449b18882b9e4b4f500f94d2c5dfdee82b766f41972df17d80',
})
export const DRILL_CHAIN_ID = 31337
export const DRILL_CHAIN_HEX = '0x7a69'
export const DUMMY_CONTRACT = '0x000000000000000000000000000000000000dEaD'

/** Accepts the drill file bytes only if they are byte-identical to the published drill and bound to chain 31337 and
 *  the dummy contract. Returns { typed, hashes } or throws. */
export function canonicalDrill(bytes) {
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== PINNED.fileSha256) throw new Error(`drill file SHA-256 ${sha} differs from the published ${PINNED.fileSha256}`)
  const typed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  const problems = typedProblems(typed)
  if (problems.length) throw new Error(`drill file is not canonical: ${problems.join('; ')}`)
  if (Number(typed.domain.chainId) !== DRILL_CHAIN_ID || typed.domain.verifyingContract !== DUMMY_CONTRACT || typed.message.to !== DUMMY_CONTRACT) {
    throw new Error('drill file is not bound to chain 31337 and the dummy contract')
  }
  const hashes = hashesOf(typed)
  if (hashes.domainHash !== PINNED.domainHash || hashes.messageHash !== PINNED.messageHash || hashes.safeTxHash !== PINNED.safeTxHash) {
    throw new Error('drill hashes differ from the published values')
  }
  return { typed, hashes }
}

/** Shortened address for display and logs in page-entry mode: 0x1234...abcd (never the full address). */
export const maskAddress = (a) => { const x = getAddress(a); return `${x.slice(0, 6)}...${x.slice(-4)}` }

/** Strict check of a wallet signature over the canonical drill: the same rules as `safe-tx.mjs check`
 *  (65 bytes, v = 27/28, EIP-712 recovery; EIP-191 signatures never recover to the signer). Never returns or logs the
 *  signature. */
export function checkDrillSignature(typed, sig, expect) {
  const expected = getAddress(expect)
  const bad = signatureProblem(sig)
  if (bad) return { result: 'FAIL', matchesExpected: false, reason: bad }
  let signer
  try { signer = verifyTypedData(typed.domain, TYPES, typed.message, sig) } catch { return { result: 'FAIL', matchesExpected: false, reason: 'signature does not recover under EIP-712' } }
  const matchesExpected = signer === expected
  return { result: matchesExpected ? 'PASS' : 'FAIL', matchesExpected, reason: matchesExpected ? 'EIP-712 signature recovers to the expected address' : 'signature recovers to a different address (wrong account, or not an EIP-712 signature of this drill)' }
}

// Read-only JSON-RPC methods a wallet needs to add and display a network. Everything else is refused by the station,
// including every method that sends, signs or changes node state (eth_sendRawTransaction, eth_sendTransaction,
// eth_sign*, personal_*, anvil_*, evm_*, hardhat_*, debug_*, txpool_*, ...).
export const RPC_ALLOWED = Object.freeze(new Set([
  'eth_chainId', 'net_version', 'net_listening', 'web3_clientVersion', 'eth_syncing',
  'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBalance', 'eth_getTransactionCount',
  'eth_getCode', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs',
]))
export const rpcMethodAllowed = (method) => typeof method === 'string' && RPC_ALLOWED.has(method)

/** Validates a JSON-RPC request body (single or batch). Returns { ok: true } or { ok: false, refused: [methods] }.
 *  A batch is refused as a whole if any entry is refused, so nothing in it reaches the node. */
export function rpcRequestCheck(body) {
  const items = Array.isArray(body) ? body : [body]
  if (items.length === 0 || items.length > 20) return { ok: false, refused: ['(empty or oversized batch)'] }
  const refused = items.filter((r) => !r || typeof r !== 'object' || !rpcMethodAllowed(r.method)).map((r) => String(r?.method ?? '(invalid)'))
  return refused.length ? { ok: false, refused } : { ok: true }
}

/** Anvil arguments: loopback only (never reachable from the network), chain 31337, no dev accounts (no funded or
 *  unlocked keys exist on this chain). */
export const anvilArgs = (port) => ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(DRILL_CHAIN_ID), '--accounts', '0']
