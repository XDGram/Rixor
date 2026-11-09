#!/usr/bin/env node
// Mobile-wallet signing drill station (Zerion Wallet on iPhone, or any wallet with an in-app browser). DRILL ONLY.
//
//   node scripts/wallet-drill.mjs --expect 0xYOUR_ADDRESS [--port 8787] [--host 0.0.0.0] [--minutes 60]
//
// What it does, on the operator's own PC:
//   1. Creates the drill file with the unchanged `safe-tx.mjs drill`, and refuses to start unless it is byte-identical
//      to the published drill (SHA-256 489faeda…, chain 31337, dummy contract 0x…dEaD).
//   2. Starts the bundled Anvil on 127.0.0.1 only (chain 31337, no dev accounts: no funded or unlocked keys).
//   3. Serves, under a random one-time path on the local network:
//        /         the drill page (Stage 1: connect + network checks, no signing; Stage 2: sign the drill)
//        rpc       a read-only JSON-RPC relay to that Anvil for the wallet's custom network. Every method that
//                  sends, signs or changes state is refused (eth_sendRawTransaction, eth_sendTransaction, ...).
//        check     verifies a signature with the same rules as `safe-tx.mjs check` (65 bytes, v = 27/28, EIP-712
//                  recovery) against --expect. Prints only PASS/FAIL and matchesExpected.
// The signature is never printed, logged, saved or sent anywhere else. The drill signature is valid on no network and
// for no Safe. Nothing is broadcast. This does not change the Ledger workflow or the testnet signing requirements.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'ethers'
import { DRILL_CHAIN_HEX, DUMMY_CONTRACT, PINNED, anvilArgs, canonicalDrill, checkDrillSignature, rpcRequestCheck } from './lib/wallet-drill-core.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined }
const die = (m) => { console.error(`error: ${m}`); process.exit(1) }

let EXPECT
try { EXPECT = getAddress(opt('expect') ?? die('--expect 0xYOUR_ADDRESS is required (your own public address, typed on this PC)')) } catch { die('--expect is not a valid address') }
const PORT = Number(opt('port') ?? 8787)
const HOST = opt('host') ?? '0.0.0.0'
const MINUTES = Number(opt('minutes') ?? 60)
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) die('--port must be 0-65535')
if (!(MINUTES > 0 && MINUTES <= 240)) die('--minutes must be between 1 and 240')

// 1. The canonical drill, produced by the unchanged Ledger-workflow script, then checked against the published values.
const tmp = mkdtempSync(join(tmpdir(), 'rixor-wallet-drill-'))
let DRILL_BYTES, DRILL
try {
  const out = join(tmp, 'safe-signing-drill.json')
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/safe-tx.mjs'), 'drill', '--out', out], { encoding: 'utf8' })
  if (r.status !== 0) die(`safe-tx.mjs drill failed: ${r.stderr}`)
  DRILL_BYTES = readFileSync(out)
  DRILL = canonicalDrill(DRILL_BYTES).typed
} catch (e) { die(e.message) } finally { rmSync(tmp, { recursive: true, force: true }) }

const PAGE_DIR = join(ROOT, 'scripts/wallet-drill')
const ASSETS = {
  '': ['text/html; charset=utf-8', readFileSync(join(PAGE_DIR, 'index.html'))],
  'drill-page.js': ['text/javascript; charset=utf-8', readFileSync(join(PAGE_DIR, 'drill-page.js'))],
  'drill.json': ['application/json; charset=utf-8', DRILL_BYTES],
  'pinned.json': ['application/json; charset=utf-8', Buffer.from(JSON.stringify({ ...PINNED, chainIdHex: DRILL_CHAIN_HEX, dummyContract: DUMMY_CONTRACT }))],
}
const TOKEN = randomBytes(16).toString('hex')
const BASE = `/${TOKEN}/`

// 2. Anvil, loopback only, on a free port.
const freePort = () => new Promise((ok, no) => { const s = createNetServer(); s.once('error', no); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
const arch = process.arch === 'x64' ? 'amd64' : process.arch
const ANVIL = join(ROOT, 'node_modules/@foundry-rs', `anvil-${process.platform}-${arch}`, 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil')
const anvilPort = await freePort()
// stdio ignored: Anvil's banner prints its public test mnemonic; nothing from it is shown.
const anvil = spawn(ANVIL, anvilArgs(anvilPort), { stdio: 'ignore', windowsHide: true })
anvil.on('error', (e) => die(`cannot start Anvil (${ANVIL}): ${e.message}. Run "npx -y npm@11.21.2 ci" first.`))
const UPSTREAM = `http://127.0.0.1:${anvilPort}`
const rpcUpstream = async (body) => (await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text()
let ready = false
for (let i = 0; i < 100 && !ready; i++) {
  try { ready = JSON.parse(await rpcUpstream(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }))).result === DRILL_CHAIN_HEX } catch { await new Promise((r) => setTimeout(r, 100)) }
}
if (!ready) { anvil.kill(); die('Anvil did not start as chain 31337') }

// 3. HTTP station.
const clean = (v, n = 120) => String(v ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, n) // no control characters in the terminal
const send = (res, status, type, body) => {
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  })
  res.end(body)
}
const json = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj))
const readBody = (req) => new Promise((ok, no) => {
  let size = 0; const chunks = []
  req.on('data', (c) => { size += c.length; if (size > 65536) { no(Object.assign(new Error('too large'), { status: 413 })); req.destroy() } else chunks.push(c) })
  req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
  req.on('error', no)
})
const seenMethods = new Set()

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://station')
  const from = clean(req.socket.remoteAddress, 60)
  if (url.pathname === `/${TOKEN}`) { res.writeHead(301, { location: BASE }); return res.end() }
  if (!url.pathname.startsWith(BASE)) return send(res, 404, 'text/plain', 'not found')
  const path = url.pathname.slice(BASE.length)
  try {
    if (req.method === 'GET' && Object.hasOwn(ASSETS, path)) { const [type, body] = ASSETS[path]; return send(res, 200, type, body) }
    if (req.method !== 'POST') return send(res, 404, 'text/plain', 'not found')
    let body
    try { body = JSON.parse(await readBody(req)) } catch (e) { return json(res, e.status ?? 400, { error: e.status === 413 ? 'request too large' : 'invalid JSON' }) }

    if (path === 'rpc') {
      const verdict = rpcRequestCheck(body)
      if (!verdict.ok) {
        console.log(`rpc REFUSED from ${from}: ${verdict.refused.map((m) => clean(m, 60)).join(', ')} (only read methods are allowed; nothing is broadcast)`)
        const err = (r) => ({ jsonrpc: '2.0', id: r?.id ?? null, error: { code: -32601, message: 'method not allowed by the Rixor drill station (read-only; no transactions)' } })
        return json(res, 200, Array.isArray(body) ? body.map(err) : err(body))
      }
      for (const r of Array.isArray(body) ? body : [body]) if (!seenMethods.has(r.method)) { seenMethods.add(r.method); console.log(`rpc first ${r.method} from ${from}`) }
      return send(res, 200, 'application/json; charset=utf-8', await rpcUpstream(JSON.stringify(body)))
    }
    if (path === 'stage1') {
      let accountMatchesExpected = false
      try { accountMatchesExpected = getAddress(body.account) === EXPECT } catch {}
      const report = {
        wallet: clean(body.wallet), rdns: clean(body.rdns), chainId: clean(body.chainId, 20), onDrillChain: body.chainId === DRILL_CHAIN_HEX,
        accountMatchesExpected, steps: Array.isArray(body.steps) ? body.steps.slice(0, 20).map((s) => clean(s, 200)) : [],
      }
      console.log(`stage 1 report from ${from}:\n${JSON.stringify(report, null, 2)}`)
      return json(res, 200, { accountMatchesExpected, onDrillChain: report.onDrillChain })
    }
    if (path === 'check') {
      const verdict = checkDrillSignature(DRILL, body.signature, EXPECT)
      let connectedMatchesExpected = false
      try { connectedMatchesExpected = getAddress(body.account) === EXPECT } catch {}
      body.signature = undefined // not kept, logged or echoed
      console.log(`stage 2 check from ${from}:\n${JSON.stringify({ result: verdict.result, matchesExpected: verdict.matchesExpected, reason: verdict.reason, connectedMatchesExpected }, null, 2)}`)
      return json(res, 200, { ...verdict, connectedMatchesExpected })
    }
    return send(res, 404, 'text/plain', 'not found')
  } catch {
    return json(res, 500, { error: 'station error' })
  }
})

const shutdown = (why) => { console.log(`\nStopping the drill station (${why}).`); anvil.kill(); server.close(); setTimeout(() => process.exit(0), 300).unref() }
process.on('exit', () => { try { anvil.kill() } catch {} }) // also on errors: never leave Anvil running
process.on('SIGINT', () => shutdown('Ctrl+C'))
process.on('SIGTERM', () => shutdown('terminated'))
anvil.on('exit', () => { if (server.listening) shutdown('Anvil stopped') })
setTimeout(() => shutdown(`${MINUTES}-minute limit`), MINUTES * 60_000).unref()

server.listen(PORT, HOST, () => {
  const port = server.address().port
  const ips = HOST === '0.0.0.0'
    ? Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
    : [HOST]
  console.log(`Rixor wallet drill station: DRILL ONLY (chain 31337, dummy contract ${DUMMY_CONTRACT}; valid on no network)`)
  console.log(`Expected address (from --expect): ${EXPECT}`)
  console.log(`Drill file SHA-256 ${PINNED.fileSha256} (matches the published drill)`)
  console.log(`  Domain hash  ${PINNED.domainHash}\n  Message hash ${PINNED.messageHash}`)
  console.log(`Anvil: 127.0.0.1 only, chain 31337, no accounts. RPC relay: read-only; transaction methods refused.`)
  if (!ips.length) console.log('No local network address found. Connect this PC to Wi-Fi (or your phone hotspot) and restart.')
  for (const ip of ips) console.log(`\nOn the iPhone (network ${ip}):\n  Network RPC URL: http://${ip}:${port}${BASE}rpc\n  Page (open in the wallet's browser): http://${ip}:${port}${BASE}`)
  console.log(`\nStops after ${MINUTES} minutes or with Ctrl+C. The signature is never shown, logged or saved.`)
  console.log(`STATION_READY ${port} ${TOKEN}`)
})
