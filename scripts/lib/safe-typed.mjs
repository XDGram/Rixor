// Canonical Safe v1.5.0 SafeTx typed data, strict validation and the hashes a Ledger displays. Shared by
// scripts/safe-tx.mjs and its tests (scripts/test-safe-signing.mjs). Pure: no network, no device, no keys.
import { TypedDataEncoder, getAddress, ZeroAddress } from 'ethers'

export const ALLOWED = new Set([46630, 31337])
export const TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
}

export const DOMAIN_TYPE = [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]
const MESSAGE_KEYS = TYPES.SafeTx.map((f) => f.name)
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Strict shape check of a SafeTx typed-data file: exactly what `prepare`/`drill` write and nothing else. Returns
 *  the list of problems (empty = valid). The Ledger cannot show these fields, so the file must be canonical. */
export function typedProblems(typed) {
  const p = []
  if (!typed || typeof typed !== 'object') return ['not a JSON object']
  if (!sameJson(Object.keys(typed).sort(), ['domain', 'message', 'primaryType', 'types'])) p.push('top-level keys must be exactly types, primaryType, domain, message')
  if (typed.primaryType !== 'SafeTx') p.push('primaryType must be SafeTx')
  if (!typed.types || !sameJson(Object.keys(typed.types).sort(), ['EIP712Domain', 'SafeTx'])) p.push('types must be exactly EIP712Domain and SafeTx')
  else {
    if (!sameJson(typed.types.EIP712Domain, DOMAIN_TYPE)) p.push('EIP712Domain must be exactly (uint256 chainId, address verifyingContract) as used by Safe v1.3+')
    if (!sameJson(typed.types.SafeTx, TYPES.SafeTx)) p.push('SafeTx type differs from the Safe v1.5.0 definition')
  }
  const d = typed.domain ?? {}
  if (!sameJson(Object.keys(d).sort(), ['chainId', 'verifyingContract'])) p.push('domain must contain exactly chainId and verifyingContract')
  if (!ALLOWED.has(Number(d.chainId))) p.push(`domain chainId ${d.chainId} refused: only 46630 or 31337`)
  try { getAddress(d.verifyingContract) } catch { p.push('domain verifyingContract is not an address') }
  const m = typed.message ?? {}
  if (!sameJson(Object.keys(m).sort(), [...MESSAGE_KEYS].sort())) p.push('message must contain exactly the SafeTx fields')
  try { getAddress(m.to) } catch { p.push('message.to is not an address') }
  if (typeof m.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(m.data)) p.push('message.data must be 0x-prefixed hex bytes')
  if (Number(m.operation) !== 0) p.push('operation must be 0 (CALL); DELEGATECALL is refused')
  for (const k of ['value', 'safeTxGas', 'baseGas', 'gasPrice']) if (String(m[k]) !== '0') p.push(`${k} must be 0`)
  for (const k of ['gasToken', 'refundReceiver']) if (m[k] !== ZeroAddress) p.push(`${k} must be the zero address (no refunds)`)
  if (!/^[0-9]+$/.test(String(m.nonce))) p.push('nonce must be a non-negative integer')
  return p
}
/** A Safe ECDSA signature: exactly 65 bytes r||s||v with v = 27 or 28 (v = 0/1 would be misread by the Safe as a
 *  contract signature or an approved hash, so it is refused, never silently changed). */
export function signatureProblem(sig) {
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return 'signature must be 0x followed by 130 hex characters (65 bytes)'
  const v = parseInt(sig.slice(-2), 16)
  return v === 27 || v === 28 ? null : `signature v byte is ${v}; a Safe ECDSA signature needs v = 27 or 28`
}
export const hashesOf = (typed) => ({
  domainHash: TypedDataEncoder.hashDomain(typed.domain),
  messageHash: TypedDataEncoder.from(TYPES).hash(typed.message),
  safeTxHash: TypedDataEncoder.hash(typed.domain, TYPES, typed.message),
})
export const DEVICE_NOTE = 'The Ledger shows ONLY "Domain hash" and "Message hash" (Cast sends hashes, not fields). Blind signing must be\nenabled in the Ethereum app settings, or the device refuses. Compare all 64 hex characters of both (case does not matter):'
