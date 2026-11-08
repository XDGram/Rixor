#!/usr/bin/env node
// Safe transactions with hardware-wallet signatures, without the Safe web app. TESTNET (46630) or local (31337) only.
// This script never holds a key and never broadcasts: it prepares EIP-712 data, checks signatures, and prints the
// exact `cast send` command for a hardware wallet to execute.
//
// 1) Prepare (anyone):
//      node scripts/safe-tx.mjs prepare --rpc <url> --safe <safe> --to <target> --data <calldata> [--out file.json]
//    Writes the EIP-712 SafeTx (operation CALL, value 0, no refund parameters) and prints the safeTxHash, cross-checked
//    against the Safe contract's own getTransactionHash.
// 2) Each signer, on their own machine with their Ledger:
//      cast wallet sign --ledger --data --from-file <file.json>
//    The Ledger shows the typed data (domain chain id 46630 and the Safe address). Returns a 65-byte signature.
// 3) Assemble and check (anyone):
//      node scripts/safe-tx.mjs exec --rpc <url> --tx <file.json> --sig <sig1> --sig <sig2>
//    Recovers each signer, requires them to be distinct Safe owners meeting the threshold, simulates execTransaction
//    with eth_call, and prints the `cast send ... --ledger` command for any one signer (or the deployer) to send.
import { readFileSync, writeFileSync } from 'node:fs'
import { Contract, JsonRpcProvider, TypedDataEncoder, getAddress, verifyTypedData, ZeroAddress, Interface } from 'ethers'

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined }
const all = (k) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]] : []))
const ALLOWED = new Set([46630, 31337])
const SAFE_ABI = [
  'function nonce() view returns (uint256)', 'function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
]
const TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
}
const die = (m) => { console.error(`error: ${m}`); process.exit(1) }

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
  console.log(JSON.stringify({ file: out, chainId, safe: safeAddr, nonce: nonce.toString(), safeTxHash: hash, threshold: Number(await safe.getThreshold()) }, null, 2))
  console.log(`\nEach signer runs (Ledger connected, Ethereum app open):\n  cast wallet sign --ledger --data --from-file ${out}`)
} else if (cmd === 'exec') {
  const { p, chainId } = await connect(opt('rpc'))
  const typed = JSON.parse(readFileSync(opt('tx') ?? die('--tx required'), 'utf8'))
  if (Number(typed.domain.chainId) !== chainId) die(`file is for chain ${typed.domain.chainId}, RPC is chain ${chainId}`)
  const safe = new Contract(typed.domain.verifyingContract, SAFE_ABI, p)
  const m = typed.message
  if (BigInt(m.nonce) !== (await safe.nonce())) die('the Safe nonce changed since this transaction was prepared')
  const owners = (await safe.getOwners()).map((a) => a.toLowerCase())
  const threshold = Number(await safe.getThreshold())
  const sigs = all('sig').map((sig) => ({ sig, signer: verifyTypedData(typed.domain, { SafeTx: typed.types.SafeTx }, m, sig).toLowerCase() }))
  for (const s of sigs) if (!owners.includes(s.signer)) die(`signature from ${s.signer}, which is not an owner of this Safe`)
  if (new Set(sigs.map((s) => s.signer)).size !== sigs.length) die('duplicate signer')
  if (sigs.length < threshold) die(`need ${threshold} signatures, got ${sigs.length}`)
  sigs.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1)) // Safe requires ascending signer order
  const packed = '0x' + sigs.map((s) => s.sig.slice(2)).join('')
  const iface = new Interface(SAFE_ABI)
  const calldata = iface.encodeFunctionData('execTransaction', [m.to, m.value, m.data, m.operation, m.safeTxGas, m.baseGas, m.gasPrice, m.gasToken, m.refundReceiver, packed])
  await p.call({ to: typed.domain.verifyingContract, data: calldata }).catch((e) => die(`execTransaction would revert: ${e.shortMessage ?? e.message}`))
  console.log(JSON.stringify({ safe: typed.domain.verifyingContract, signers: sigs.map((s) => s.signer), simulated: 'ok' }, null, 2))
  console.log(`\nSend with any funded hardware wallet (it only relays; the Safe owners already approved):\n  cast send ${typed.domain.verifyingContract} ${calldata} --rpc-url ${opt('rpc')} --chain ${chainId} --ledger`)
} else {
  console.log('usage: node scripts/safe-tx.mjs prepare|exec ... (see header)')
  process.exit(cmd ? 1 : 0)
}
