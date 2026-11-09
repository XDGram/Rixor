#!/usr/bin/env node
// Tests for the Safe signing drill and signature check (scripts/safe-tx.mjs, scripts/lib/safe-typed.mjs) against the
// REAL Cast 1.7.1 binary. Local only: no network, no Ledger. Signatures come from a throwaway key created in memory
// for this run (valid nowhere); a Ledger cannot be exercised here and needs the physical-device drill.
//   npm run test:safe-signing
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Signature, TypedDataEncoder, Wallet, concat, getAddress, keccak256, verifyMessage, verifyTypedData } from 'ethers'
import { TYPES, hashesOf, signatureProblem, typedProblems } from './lib/safe-typed.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.arch === 'x64' ? 'amd64' : process.arch
const CAST = join(ROOT, 'node_modules/@foundry-rs', `cast-${process.platform}-${arch}`, 'bin', process.platform === 'win32' ? 'cast.exe' : 'cast')
const SAFE_TX = join(ROOT, 'scripts/safe-tx.mjs')
const DIR = mkdtempSync(join(tmpdir(), 'rixor-safe-signing-'))
// Values published in docs/TESTNET_DEPLOYMENT.md and the Windows guide. Changing the drill must update both.
const PINNED = {
  domainHash: '0xb1d7214fcc497f10f1d3856096eb3488620f3bf807fbce3d2b736a6d60644130',
  messageHash: '0xb55a82e23ac7c0476cc3abb0ad7a160811c811401e1db2f8a9f00e787db9cc22',
  safeTxHash: '0x249e198fa22b02449b18882b9e4b4f500f94d2c5dfdee82b766f41972df17d80',
  fileSha256: '489faedae00cff6af2e32a71275c01cb34a0f98ce49069860f655023a4356e53',
}

let failed = 0
const t = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`) }
const run = (bin, args) => spawnSync(bin, args, { cwd: DIR, encoding: 'utf8' })
const node = (args) => run(process.execPath, [SAFE_TX, ...args])
const cast = (args) => run(CAST, args)
const write = (name, obj) => { const f = join(DIR, name); writeFileSync(f, JSON.stringify(obj, null, 2)); return f }

try {
  t('Cast binary is 1.7.1', /cast Version: 1\.7\.1/.test(cast(['--version']).stdout))

  // 1. The drill file is byte-for-byte reproducible and its hashes equal the published values.
  const d = node(['drill', '--out', 'drill.json'])
  t('drill exits 0', d.status === 0, d.stderr)
  const drillFile = join(DIR, 'drill.json')
  const bytes = readFileSync(drillFile)
  const typed = JSON.parse(bytes)
  const h = hashesOf(typed)
  t('drill file SHA-256 equals the published value', createHash('sha256').update(bytes).digest('hex') === PINNED.fileSha256)
  t('drill domain hash equals the published value', h.domainHash === PINNED.domainHash)
  t('drill message hash equals the published value', h.messageHash === PINNED.messageHash)
  t('drill output prints both hashes and the blind-signing requirement', d.stdout.includes(PINNED.domainHash) && d.stdout.includes(PINNED.messageHash) && /Blind signing must be/.test(d.stdout))
  t('EIP-712 digest = keccak256(0x1901 || domain hash || message hash)', keccak256(concat(['0x1901', h.domainHash, h.messageHash])) === h.safeTxHash && h.safeTxHash === PINNED.safeTxHash)
  t('drill is bound to local chain 31337 and the dummy contract', typed.domain.chainId === 31337 && typed.domain.verifyingContract === '0x000000000000000000000000000000000000dEaD')
  t('drill file passes the strict SafeTx validation', typedProblems(typed).length === 0, typedProblems(typed).join('; '))

  // 2. What `cast wallet sign --data --from-file` signs: EIP-712 typed data (same code path as --ledger up to the
  //    device call: domain separator + struct hash of this file).
  const w = Wallet.createRandom() // throwaway, in memory, this run only
  const signed = cast(['wallet', 'sign', '--private-key', w.privateKey, '--data', '--from-file', drillFile])
  const sig = signed.stdout.trim()
  t('cast wallet sign --data --from-file returns a 65-byte signature', /^0x[0-9a-f]{130}$/i.test(sig), signed.stderr)
  t('Cast output has v = 27 or 28 (valid Safe ECDSA encoding)', signatureProblem(sig) === null, signatureProblem(sig) ?? '')
  t('signature recovers to the signer under EIP-712 over the file', verifyTypedData(typed.domain, TYPES, typed.message, sig) === w.address)
  const expected = w.signingKey.sign(h.safeTxHash).serialized
  t('Cast signed exactly the EIP-712 digest (byte-identical to an independent RFC 6979 signature of it)', sig.toLowerCase() === expected.toLowerCase())
  t('it is NOT an EIP-191 personal-message signature of the file contents', verifyMessage(bytes.toString('utf8'), sig) !== w.address)
  t('it is NOT an EIP-191 signature of the digest', verifyMessage(Buffer.from(h.safeTxHash.slice(2), 'hex'), sig) !== w.address)
  const plain = cast(['wallet', 'sign', '--private-key', w.privateKey, drillFile]).stdout.trim()
  t('without --data, Cast signs EIP-191 instead (different signature)', /^0x[0-9a-f]{130}$/i.test(plain) && plain !== sig && verifyMessage(drillFile, plain) === w.address)

  // 3. Recovery logic (`safe-tx check`) matches that method.
  const ok = node(['check', '--tx', drillFile, '--sig', sig, '--expect', w.address])
  t('check: correct signer -> matchesExpected true, exit 0', ok.status === 0 && /"matchesExpected": true/.test(ok.stdout), ok.stderr)
  const other = Wallet.createRandom().address
  const wrong = node(['check', '--tx', drillFile, '--sig', sig, '--expect', other])
  t('check: other expected address -> matchesExpected false, exit 1', wrong.status === 1 && /"matchesExpected": false/.test(wrong.stdout))
  const p191 = node(['check', '--tx', drillFile, '--sig', plain, '--expect', w.address])
  t('check: an EIP-191 signature from the right key is NOT accepted', p191.status !== 0)
  t('cast wallet verify --data --from-file agrees with check', cast(['wallet', 'verify', '--address', w.address, '--data', '--from-file', drillFile, sig]).status === 0 &&
    cast(['wallet', 'verify', '--address', other, '--data', '--from-file', drillFile, sig]).status !== 0)
  for (const [name, mutate] of [
    ['domain chain id changed to 46630', (x) => { x.domain.chainId = 46630 }],
    ['verifying contract changed', (x) => { x.domain.verifyingContract = getAddress('0x' + '11'.repeat(20)) }],
    ['message.to changed', (x) => { x.message.to = getAddress('0x' + '22'.repeat(20)) }],
    ['nonce changed', (x) => { x.message.nonce = '1' }],
    ['data changed', (x) => { x.message.data = '0x00' }],
  ]) {
    const x = JSON.parse(bytes); mutate(x)
    const r = node(['check', '--tx', write(`m-${name.replace(/\W+/g, '-')}.json`, x), '--sig', sig, '--expect', w.address])
    t(`check: drill signature does not verify when the ${name}`, r.status !== 0)
  }

  // 4. Strict validation: non-canonical files are refused (the device shows only hashes, so the file must be exact).
  for (const [name, mutate] of [
    ['an extra domain field (name)', (x) => { x.domain.name = 'Safe'; x.types.EIP712Domain.unshift({ name: 'name', type: 'string' }) }],
    ['EIP712Domain fields reordered', (x) => { x.types.EIP712Domain.reverse() }],
    ['an extra type', (x) => { x.types.Extra = [{ name: 'a', type: 'uint256' }] }],
    ['a modified SafeTx type', (x) => { x.types.SafeTx[1].type = 'uint128' }],
    ['primaryType not SafeTx', (x) => { x.primaryType = 'EIP712Domain' }],
    ['operation DELEGATECALL', (x) => { x.message.operation = 1 }],
    ['non-zero gasPrice', (x) => { x.message.gasPrice = '1' }],
    ['non-zero value', (x) => { x.message.value = '1' }],
    ['a refund receiver', (x) => { x.message.refundReceiver = getAddress('0x' + '33'.repeat(20)) }],
    ['a gas token', (x) => { x.message.gasToken = getAddress('0x' + '44'.repeat(20)) }],
    ['mainnet chain id 4663', (x) => { x.domain.chainId = 4663 }],
    ['an extra top-level key', (x) => { x.extra = 1 }],
    ['malformed data', (x) => { x.message.data = '0x0' }],
    ['an extra message field', (x) => { x.message.extra = '0' }],
  ]) {
    const x = JSON.parse(bytes); mutate(x)
    const f = write(`bad-${name.replace(/\W+/g, '-')}.json`, x)
    const insp = node(['inspect', '--tx', f])
    t(`refused: ${name} (inspect and check)`, typedProblems(x).length > 0 && insp.status !== 0 && node(['check', '--tx', f, '--sig', sig]).status !== 0)
  }

  // 5. Signature encoding: v must be 27/28 (v = 0/1 would mean contract signature / approved hash to a Safe).
  const S = Signature.from(sig)
  const v01 = S.r + S.s.slice(2) + (S.v - 27).toString(16).padStart(2, '0')
  t('signature with v = 0/1 refused by check', signatureProblem(v01) !== null && node(['check', '--tx', drillFile, '--sig', v01, '--expect', w.address]).status !== 0)
  t('64-byte signature refused', signatureProblem(sig.slice(0, -2)) !== null)
  t('non-hex signature refused', signatureProblem('0x' + 'zz'.repeat(65)) !== null)

  // 6. inspect recomputes the device hashes offline.
  const ins = node(['inspect', '--tx', drillFile])
  t('inspect prints the drill label and both device hashes', ins.status === 0 && /DRILL/.test(ins.stdout) && ins.stdout.includes(PINNED.domainHash) && ins.stdout.includes(PINNED.messageHash))
  const tn = JSON.parse(bytes); tn.domain.chainId = 46630; tn.domain.verifyingContract = getAddress('0x' + '55'.repeat(20))
  const tnOut = node(['inspect', '--tx', write('testnet.json', tn)])
  const tnH = hashesOf(tn)
  t('inspect of a testnet SafeTx prints its own hashes (not the drill ones)', tnOut.status === 0 && !/DRILL/.test(tnOut.stdout) && tnOut.stdout.includes(tnH.domainHash) && tnH.domainHash !== PINNED.domainHash && tnH.messageHash === PINNED.messageHash)
  t('domain hash changes with the chain id (it binds the signature to the chain)', TypedDataEncoder.hashDomain({ chainId: 46630, verifyingContract: typed.domain.verifyingContract }) !== PINNED.domainHash)
} finally {
  rmSync(DIR, { recursive: true, force: true })
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${failed} failing test(s) (local only; throwaway in-memory key; no Ledger, no network)`)
process.exit(failed ? 1 : 0)
