#!/usr/bin/env node
// Tests for the mobile-wallet drill station (scripts/wallet-drill.mjs, scripts/lib/wallet-drill-core.mjs,
// scripts/wallet-drill/). Local only: throwaway in-memory keys, loopback Anvil, no wallet app, no external network.
//   node scripts/test-wallet-drill.mjs
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Signature, Transaction, TypedDataEncoder, Wallet, getAddress } from 'ethers'
import { TYPES, hashesOf } from './lib/safe-typed.mjs'
import { PINNED, RPC_ALLOWED, anvilArgs, canonicalDrill, checkDrillSignature, rpcRequestCheck } from './lib/wallet-drill-core.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.arch === 'x64' ? 'amd64' : process.arch
const CAST = join(ROOT, 'node_modules/@foundry-rs', `cast-${process.platform}-${arch}`, 'bin', process.platform === 'win32' ? 'cast.exe' : 'cast')
const DIR = mkdtempSync(join(tmpdir(), 'rixor-wallet-drill-test-'))
let failed = 0
const t = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`) }
let station = null

try {
  // 1. Pinned values agree with the existing Ledger drill tests and guide (no divergence).
  const ledgerTest = readFileSync(join(ROOT, 'scripts/test-safe-signing.mjs'), 'utf8')
  const ledgerGuide = readFileSync(join(ROOT, 'docs/LEDGER_WINDOWS_CMD.md'), 'utf8')
  t('pinned drill values equal those in test-safe-signing.mjs', Object.values(PINNED).every((v) => ledgerTest.includes(v)))
  t('pinned file SHA-256 and hashes equal those in the Ledger guide', [PINNED.fileSha256, PINNED.domainHash, PINNED.messageHash].every((v) => ledgerGuide.includes(v)))

  // 2. The drill comes from the unchanged safe-tx.mjs and passes the canonical check; altered files are refused.
  const drillPath = join(DIR, 'drill.json')
  const d = spawnSync(process.execPath, [join(ROOT, 'scripts/safe-tx.mjs'), 'drill', '--out', drillPath], { encoding: 'utf8' })
  t('safe-tx.mjs drill exits 0', d.status === 0, d.stderr)
  const bytes = readFileSync(drillPath)
  const { typed } = canonicalDrill(bytes)
  t('canonical drill is bound to chain 31337 and 0x…dEaD', typed.domain.chainId === 31337 && typed.domain.verifyingContract === '0x000000000000000000000000000000000000dEaD')
  const refusedDrill = (buf) => { try { canonicalDrill(buf); return false } catch { return true } }
  t('canonicalDrill refuses a whitespace change', refusedDrill(Buffer.from(bytes.toString('utf8') + '\n')))
  const alt = JSON.parse(bytes); alt.domain.chainId = 46630
  t('canonicalDrill refuses a testnet-chain variant', refusedDrill(Buffer.from(JSON.stringify(alt, null, 2))))

  // 3. RPC filter: read methods only; every sending/signing/state-changing method refused; batches all-or-nothing.
  t('eth_chainId and eth_blockNumber allowed', rpcRequestCheck({ method: 'eth_chainId' }).ok && rpcRequestCheck({ method: 'eth_blockNumber' }).ok)
  const forbidden = ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_signTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4',
    'eth_sendBundle', 'eth_sendRawTransactionConditional', 'eth_submitWork', 'anvil_setBalance', 'anvil_impersonateAccount', 'anvil_setCode',
    'evm_mine', 'evm_setNextBlockTimestamp', 'hardhat_setBalance', 'debug_traceCall', 'txpool_content', 'personal_unlockAccount', 'eth_accounts',
    'wallet_addEthereumChain', 'ETH_SENDRAWTRANSACTION', '', null, 42]
  t('every sending/signing/state-changing method is refused', forbidden.every((m) => !rpcRequestCheck({ method: m }).ok))
  t('allowlist contains no send, sign or node-control method', [...RPC_ALLOWED].every((m) => !/send|sign|submit|unlock|anvil_|evm_|hardhat_|debug_|txpool_|personal_/i.test(m)))
  t('a batch containing one send is refused as a whole', !rpcRequestCheck([{ method: 'eth_chainId' }, { method: 'eth_sendRawTransaction' }]).ok)
  t('empty and oversized batches are refused', !rpcRequestCheck([]).ok && !rpcRequestCheck(Array(21).fill({ method: 'eth_chainId' })).ok)
  t('Anvil runs on loopback, chain 31337, with no dev accounts', JSON.stringify(anvilArgs(1)) === JSON.stringify(['--host', '127.0.0.1', '--port', '1', '--chain-id', '31337', '--accounts', '0']))

  // 4. Signature checks (pure): the same strict rules as `safe-tx.mjs check`.
  const w = Wallet.createRandom() // throwaway, in memory, this run only
  const other = Wallet.createRandom()
  const sigEthers = await w.signTypedData(typed.domain, TYPES, typed.message)
  const castSig = spawnSync(CAST, ['wallet', 'sign', '--private-key', w.privateKey, '--data', '--from-file', drillPath], { encoding: 'utf8' }).stdout.trim()
  t('ethers and Cast produce the same EIP-712 signature', sigEthers.toLowerCase() === castSig.toLowerCase())
  const S = Signature.from(sigEthers)
  const v01 = S.r + S.s.slice(2) + (S.v - 27).toString(16).padStart(2, '0')
  const sig191 = await w.signMessage(Buffer.from(hashesOf(typed).safeTxHash.slice(2), 'hex'))
  const sigOtherChain = await w.signTypedData({ ...typed.domain, chainId: 46630 }, TYPES, typed.message)
  const sigOther = await other.signTypedData(typed.domain, TYPES, typed.message)
  const cases = {
    good: [sigEthers, 'PASS'], cast: [castSig, 'PASS'], otherKey: [sigOther, 'FAIL'], eip191: [sig191, 'FAIL'], v01: [v01, 'FAIL'],
    short: [sigEthers.slice(0, -2), 'FAIL'], nonHex: ['0x' + 'zz'.repeat(65), 'FAIL'], missing: [undefined, 'FAIL'], otherChain: [sigOtherChain, 'FAIL'],
  }
  for (const [name, [sig, want]] of Object.entries(cases)) {
    const r = checkDrillSignature(typed, sig, w.address)
    t(`checkDrillSignature ${name} -> ${want}`, r.result === want && r.matchesExpected === (want === 'PASS'), JSON.stringify(r))
  }
  t('checkDrillSignature never returns the signature or recovered key material', !JSON.stringify(checkDrillSignature(typed, sigEthers, w.address)).includes(sigEthers.slice(2, 20)))

  // 5. The page asks for exactly one signing method and never for a transaction.
  const page = readFileSync(join(ROOT, 'scripts/wallet-drill/drill-page.js'), 'utf8')
  const methods = [...page.matchAll(/method: '([a-z0-9]+_[a-zA-Z0-9_]+)'/g)].map((m) => m[1]) // JSON-RPC names (not fetch's 'POST')
  t('page requests only connect/read/network methods plus eth_signTypedData_v4',
    methods.every((m) => ['eth_requestAccounts', 'eth_chainId', 'eth_blockNumber', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_signTypedData_v4'].includes(m)) && methods.includes('eth_signTypedData_v4'), methods.join(','))
  t('page has no transaction request, storage or console logging', !/eth_send|sendTransaction|personal_sign|localStorage|sessionStorage|indexedDB|console\./.test(page))
  t('page loads no external script', !/<script[^>]+src="https?:/i.test(readFileSync(join(ROOT, 'scripts/wallet-drill/index.html'), 'utf8')))

  // 6. Start-up refusals.
  const noExpect = spawnSync(process.execPath, [join(ROOT, 'scripts/wallet-drill.mjs')], { encoding: 'utf8' })
  t('station refuses to start without --expect', noExpect.status === 1 && /--expect/.test(noExpect.stderr))
  const badExpect = spawnSync(process.execPath, [join(ROOT, 'scripts/wallet-drill.mjs'), '--expect', '0x1234'], { encoding: 'utf8' })
  t('station refuses an invalid --expect', badExpect.status === 1)

  // 7. The running station (loopback only in this test).
  let out = ''
  station = spawn(process.execPath, [join(ROOT, 'scripts/wallet-drill.mjs'), '--expect', w.address, '--port', '0', '--host', '127.0.0.1', '--minutes', '5'], { stdio: ['ignore', 'pipe', 'pipe'] })
  station.stdout.on('data', (c) => { out += c }); station.stderr.on('data', (c) => { out += c })
  let port, token
  for (let i = 0; i < 200 && !port; i++) { const m = out.match(/STATION_READY (\d+) ([0-9a-f]{32})/); if (m) [, port, token] = m; else await new Promise((r) => setTimeout(r, 100)) }
  t('station starts and prints its one-time path', Boolean(port), out)
  const origin = `http://127.0.0.1:${port}`
  const base = `${origin}/${token}/`
  const rpc = async (body) => (await fetch(`${base}rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  const postJ = async (path, body) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()

  t('root path is 404', (await fetch(`${origin}/`)).status === 404)
  t('wrong token is 404', (await fetch(`${origin}/${'0'.repeat(32)}/`)).status === 404 && (await fetch(`${origin}/${'0'.repeat(32)}/rpc`, { method: 'POST', body: '{}' })).status === 404)
  const pageRes = await fetch(base)
  t('page served with a strict Content-Security-Policy', pageRes.status === 200 && /script-src 'self'/.test(pageRes.headers.get('content-security-policy') ?? '') && /connect-src 'self'/.test(pageRes.headers.get('content-security-policy') ?? ''))
  t('page script served', (await fetch(`${base}drill-page.js`)).status === 200)
  const served = Buffer.from(await (await fetch(`${base}drill.json`)).arrayBuffer())
  t('served drill is byte-identical to the published drill', createHash('sha256').update(served).digest('hex') === PINNED.fileSha256)

  t('rpc eth_chainId is 0x7a69 (31337)', (await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })).result === '0x7a69')
  const bn0 = (await rpc({ jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] })).result
  t('rpc eth_blockNumber works', typeof bn0 === 'string')
  const rawTx = await Wallet.createRandom().signTransaction(Transaction.from({ chainId: 31337, to: w.address, value: 0, nonce: 0, gasLimit: 21000, gasPrice: 1 }))
  const refusedBy = (r) => r && r.error && r.error.code === -32601 && /Rixor drill station/.test(r.error.message)
  t('rpc refuses eth_sendRawTransaction', refusedBy(await rpc({ jsonrpc: '2.0', id: 3, method: 'eth_sendRawTransaction', params: [rawTx] })))
  t('rpc refuses eth_sendTransaction', refusedBy(await rpc({ jsonrpc: '2.0', id: 4, method: 'eth_sendTransaction', params: [{ from: w.address, to: w.address }] })))
  t('rpc refuses node-control methods (anvil_setBalance, evm_mine)', refusedBy(await rpc({ jsonrpc: '2.0', id: 5, method: 'anvil_setBalance', params: [w.address, '0x1'] })) && refusedBy(await rpc({ jsonrpc: '2.0', id: 6, method: 'evm_mine', params: [] })))
  const batch = await rpc([{ jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] }, { jsonrpc: '2.0', id: 8, method: 'eth_sendRawTransaction', params: [rawTx] }])
  t('rpc refuses a batch containing a send (no entry forwarded)', Array.isArray(batch) && batch.every(refusedBy))
  t('chain state unchanged after the refused requests', (await rpc({ jsonrpc: '2.0', id: 9, method: 'eth_blockNumber', params: [] })).result === bn0 &&
    (await rpc({ jsonrpc: '2.0', id: 10, method: 'eth_getBalance', params: [w.address, 'latest'] })).result === '0x0')
  t('invalid JSON is 400', (await fetch(`${base}rpc`, { method: 'POST', body: 'not json' })).status === 400)
  t('oversized body is refused', await fetch(`${base}rpc`, { method: 'POST', body: 'x'.repeat(70000) }).then((r) => r.status === 413, () => true))

  const s1 = await postJ('stage1', { wallet: 'Test', rdns: 'test', chainId: '0x7a69', account: w.address, steps: ['a'] })
  t('stage 1: matching account on 31337 -> ok', s1.accountMatchesExpected === true && s1.onDrillChain === true)
  const s1b = await postJ('stage1', { wallet: 'Test', chainId: '0x1', account: other.address })
  t('stage 1: other account or chain -> not ok', s1b.accountMatchesExpected === false && s1b.onDrillChain === false)

  for (const [name, [sig, want]] of Object.entries(cases)) {
    const r = await postJ('check', { signature: sig, account: w.address })
    t(`station check ${name} -> ${want}`, r.result === want && r.matchesExpected === (want === 'PASS') && !JSON.stringify(r).includes(String(sig).slice(2, 20) || 'n/a'), JSON.stringify(r))
  }
  t('station check reports whether the connected account matches', (await postJ('check', { signature: sigEthers, account: other.address })).connectedMatchesExpected === false)

  // 8. Nothing secret reaches the terminal output.
  const secrets = Object.values(cases).map(([s]) => s).filter((s) => typeof s === 'string' && s.length > 40).map((s) => s.slice(2, 66).toLowerCase())
  t('station output never contains a signature', secrets.every((s) => !out.toLowerCase().includes(s)))
  t('station output never contains a private key or the Anvil mnemonic', !out.includes(w.privateKey.slice(2)) && !/test test test|Private Keys/.test(out))
  t('station logged the refused methods', /rpc REFUSED .*eth_sendRawTransaction/.test(out))

  const children = process.platform === 'win32' ? '' : spawnSync('pgrep', ['-P', String(station.pid)], { encoding: 'utf8' }).stdout.trim()
  if (process.platform !== 'win32') t('station runs exactly one child process (Anvil)', children.split('\n').filter(Boolean).length === 1, children)
  station.kill('SIGTERM')
  const code = await new Promise((r) => station.on('exit', r))
  station = null
  t('station stops cleanly', code === 0)
  if (process.platform !== 'win32') {
    await new Promise((r) => setTimeout(r, 300))
    t('its Anvil is stopped with the station', children && spawnSync('kill', ['-0', children]).status !== 0)
  }
} catch (e) {
  t('unexpected error', false, e.stack)
} finally {
  if (station) station.kill('SIGTERM')
  rmSync(DIR, { recursive: true, force: true })
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${failed} failing test(s) (local only; throwaway in-memory keys; loopback Anvil; no wallet app, no network)`)
process.exit(failed ? 1 : 0)
