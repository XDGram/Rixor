#!/usr/bin/env node
// Safe transactions with hardware-wallet signatures, without the Safe web app. TESTNET (46630) or local (31337) only.
// This script never holds a key and never broadcasts: it prepares EIP-712 data, checks signatures, and prints the
// exact `cast send` command for a hardware wallet to execute.
//
// 1) Prepare (anyone):
//      node scripts/safe-tx.mjs prepare --rpc <url> --safe <safe> --to <target> --data <calldata> [--out file.json]
//    Writes the EIP-712 SafeTx (operation CALL, value 0, no refund parameters) and prints the safeTxHash, cross-checked
//    against the Safe contract's own getTransactionHash.
// 2) Each signer, on their own machine: recompute the hashes offline, then sign with their Ledger:
//      node scripts/safe-tx.mjs inspect --tx <file.json>
//      cast wallet sign --ledger --mnemonic-derivation-path "m/44'/60'/<N>'/0/0" --data --from-file <file.json>
//    Cast 1.7.1 signs EIP-712 typed data (never EIP-191 or a raw hash). With --ledger it computes the domain separator
//    and the SafeTx struct hash on the computer and sends ONLY those two hashes to the Ethereum app (SIGN_ETH_EIP_712,
//    P2 = 0x00, "v0" mode). The device therefore displays only "Domain hash" and "Message hash" (no chain ID, Safe
//    address or fields) and refuses unless the app's Blind signing setting is enabled. The signer compares both
//    hashes with `inspect` output from their own machine. Returns a 65-byte signature r||s||v with v = 27 or 28.
// Drill (before deployment, no effect anywhere): node scripts/safe-tx.mjs drill ; each signer signs the file with
//    their Ledger; node scripts/safe-tx.mjs check --tx safe-signing-drill.json --sig <sig> --expect <their address>.
// 3) Assemble and check (anyone):
//      node scripts/safe-tx.mjs exec --rpc <url> --tx <file.json> --sig <sig1> --sig <sig2>
//    Recovers each signer, requires them to be distinct Safe owners meeting the threshold, simulates execTransaction
//    with eth_call, and prints the `cast send ... --ledger` command for any one signer (or the deployer) to send.
import { readFileSync, writeFileSync } from 'node:fs'
import { Contract, JsonRpcProvider, TypedDataEncoder, getAddress, verifyTypedData, ZeroAddress, Interface } from 'ethers'
import { ALLOWED, DEVICE_NOTE, TYPES, hashesOf, signatureProblem, typedProblems } from './lib/safe-typed.mjs'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined }
const all = (k) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]] : []))
const SAFE_ABI = [
  'function nonce() view returns (uint256)', 'function getThreshold() view returns (uint256)', 'function domainSeparator() view returns (bytes32)', 'function getOwners() view returns (address[])',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
]
const die = (m) => { console.error(`error: ${m}`); process.exit(1) }
const loadTyped = (file) => {
  let typed
  try { typed = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { die(`cannot read ${file}: ${e.message}`) }
  const p = typedProblems(typed)
  if (p.length) die(`${file} is not a canonical SafeTx file:\n  - ${p.join('\n  - ')}`)
  return typed
}

async function connect(rpc) {
  if (!rpc) die('--rpc is required')
  const p = new JsonRpcProvider(rpc)
  const chainId = Number((await p.getNetwork()).chainId)
  if (!ALLOWED.has(chainId)) die(`chain ${chainId} refused: only Robinhood Chain testnet (46630) or a local chain (31337)`)
  return { p, chainId }
}

if (cmd === 'prepare') {
  const { p, chainId } = await connect(opt('rpc'))
  const safeAddr = getAddress(opt('safe') ?? die('--safe required'))
  const to = getAddress(opt('to') ?? die('--to required'))
  const data = opt('data') ?? die('--data required')
  const safe = new Contract(safeAddr, SAFE_ABI, p)
  const nonce = await safe.nonce()
  const message = { to, value: '0', data, operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: nonce.toString() }
  const domain = { chainId, verifyingContract: safeAddr }
  const hash = TypedDataEncoder.hash(domain, TYPES, message)
  const onchain = await safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, ZeroAddress, ZeroAddress, nonce)
  if (hash !== onchain) die(`hash mismatch: local ${hash} vs Safe ${onchain}`)
  const typed = { types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...TYPES }, primaryType: 'SafeTx', domain, message }
  const out = opt('out') ?? `safe-tx-${safeAddr.slice(2, 8)}-${nonce}.json`
  writeFileSync(out, JSON.stringify(typed, null, 2))
  const domainHash = TypedDataEncoder.hashDomain(domain)
  if (domainHash !== (await safe.domainSeparator())) die('domain hash differs from the Safe contract\'s domainSeparator()')
  const messageHash = TypedDataEncoder.from(TYPES).hash(message)
  console.log(JSON.stringify({ file: out, chainId, safe: safeAddr, nonce: nonce.toString(), to, data, safeTxHash: hash, ledgerDomainHash: domainHash, ledgerMessageHash: messageHash, threshold: Number(await safe.getThreshold()) }, null, 2))
  console.log(`\nEach signer, on their own machine: first recompute the hashes offline from the file they received,\n  node scripts/safe-tx.mjs inspect --tx ${out}\nthen sign (Ledger connected, Ethereum app open, Ledger Live closed):\n  cast wallet sign --ledger --mnemonic-derivation-path "m/44'/60'/<N>'/0/0" --data --from-file ${out}`)
  console.log(DEVICE_NOTE)
  console.log(`  Domain hash  ${domainHash}\n  Message hash ${messageHash}\nReject on the device if either differs.`)
} else if (cmd === 'exec') {
  const { p, chainId } = await connect(opt('rpc'))
  const typed = loadTyped(opt('tx') ?? die('--tx required'))
  if (Number(typed.domain.chainId) !== chainId) die(`file is for chain ${typed.domain.chainId}, RPC is chain ${chainId}`)
  const safe = new Contract(typed.domain.verifyingContract, SAFE_ABI, p)
  const m = typed.message
  if (BigInt(m.nonce) !== (await safe.nonce())) die('the Safe nonce changed since this transaction was prepared')
  const owners = (await safe.getOwners()).map((a) => a.toLowerCase())
  const threshold = Number(await safe.getThreshold())
  const sigs = all('sig').map((sig) => { const bad = signatureProblem(sig); if (bad) die(bad); return { sig, signer: verifyTypedData(typed.domain, TYPES, m, sig).toLowerCase() } })
  for (const s of sigs) if (!owners.includes(s.signer)) die(`signature from ${s.signer}, which is not an owner of this Safe`)
  if (new Set(sigs.map((s) => s.signer)).size !== sigs.length) die('duplicate signer')
  if (sigs.length < threshold) die(`need ${threshold} signatures, got ${sigs.length}`)
  sigs.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1)) // Safe requires ascending signer order
  const packed = '0x' + sigs.map((s) => s.sig.slice(2)).join('')
  const iface = new Interface(SAFE_ABI)
  const calldata = iface.encodeFunctionData('execTransaction', [m.to, m.value, m.data, m.operation, m.safeTxGas, m.baseGas, m.gasPrice, m.gasToken, m.refundReceiver, packed])
  await p.call({ to: typed.domain.verifyingContract, data: calldata }).catch((e) => die(`execTransaction would revert: ${e.shortMessage ?? e.message}`))
  console.log(JSON.stringify({ safe: typed.domain.verifyingContract, signers: sigs.map((s) => s.signer), simulated: 'ok' }, null, 2))
  console.log(`\nSend with any funded hardware wallet (it only relays; the Safe owners already approved). --chain pins the\nsignature to chain ${chainId}; the Ledger must show chain ID ${chainId}:\n  cast send ${typed.domain.verifyingContract} ${calldata} --rpc-url ${opt('rpc')} --chain ${chainId} --ledger --mnemonic-derivation-path "m/44'/60'/<account>'/0/0"`)
} else if (cmd === 'drill') {
  // Signing drill: a SafeTx bound to the LOCAL chain 31337 and a dummy contract. Signing it has no effect on any
  // network; it proves a signer's Ledger can produce Safe EIP-712 signatures and shows what the device displays.
  const message = { to: '0x000000000000000000000000000000000000dEaD', value: '0', data: '0x', operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: '0' }
  const domain = { chainId: 31337, verifyingContract: '0x000000000000000000000000000000000000dEaD' }
  const typed = { types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...TYPES }, primaryType: 'SafeTx', domain, message }
  const out = opt('out') ?? 'safe-signing-drill.json'
  writeFileSync(out, JSON.stringify(typed, null, 2))
  const h = hashesOf(typed)
  console.log(JSON.stringify({ file: out, note: 'DRILL ONLY: local chain 31337, dummy contract; valid nowhere', ledgerDomainHash: h.domainHash, ledgerMessageHash: h.messageHash }, null, 2))
  console.log(`\n${DEVICE_NOTE}\n  Domain hash  ${h.domainHash}\n  Message hash ${h.messageHash}`)
} else if (cmd === 'check') {
  // Recover the signer of a signature over a prepared or drill file (no network access).
  const typed = loadTyped(opt('tx') ?? die('--tx required'))
  const sig = opt('sig') ?? die('--sig required')
  const bad = signatureProblem(sig)
  if (bad) die(bad)
  // EIP-712 recovery over keccak256(0x1901 || domainHash || messageHash): exactly what Cast/the Ledger signed.
  const signer = verifyTypedData(typed.domain, TYPES, typed.message, sig)
  const expect = opt('expect')
  console.log(JSON.stringify({ signer, matchesExpected: expect ? getAddress(expect) === signer : undefined }, null, 2))
  if (expect && getAddress(expect) !== signer) process.exit(1)
} else if (cmd === 'inspect') {
  // Offline: validate a received file and recompute what the Ledger will display. No network, no device.
  const typed = loadTyped(opt('tx') ?? die('--tx required'))
  const h = hashesOf(typed)
  const drill = Number(typed.domain.chainId) === 31337 && typed.domain.verifyingContract === '0x000000000000000000000000000000000000dEaD'
  console.log(JSON.stringify({ kind: drill ? 'DRILL (local chain 31337, dummy contract; valid nowhere)' : 'SafeTx', chainId: Number(typed.domain.chainId), safe: typed.domain.verifyingContract, to: typed.message.to, value: typed.message.value, data: typed.message.data, operation: 'CALL', nonce: typed.message.nonce, safeTxHash: h.safeTxHash }, null, 2))
  console.log(`\n${DEVICE_NOTE}\n  Domain hash  ${h.domainHash}\n  Message hash ${h.messageHash}`)
} else {
  console.log('usage: node scripts/safe-tx.mjs prepare|exec|drill|check|inspect ... (see header)')
  process.exit(cmd ? 1 : 0)
}
