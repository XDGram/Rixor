#!/usr/bin/env node
// DEPLOY CONSOLE STATION: serves the Deploy Console page and one reviewed bundle under a random one-time path.
//
//   node scripts/deploy-console/station.mjs --bundle <bundle.json> --dist <console build dir>
//        [--public-url https://<host>] [--port 8788] [--host 0.0.0.0] [--minutes 45] [--fund-eth 0.01]
//
// TESTNET bundle (chain 46630, final): serve-only. No chain and no RPC relay: the console in the phone's wallet browser
// talks to the official Robinhood Chain testnet RPC directly, and the wallet signs and sends. The station never sees a
// transaction.
//
// REHEARSAL bundle (chain 31337): LOCAL CHAIN ONLY. Nothing can reach Robinhood Chain testnet or mainnet, and
// signatures for chain 31337 are not valid on any real network. It starts a fresh rehearsal chain (scripts/lib/rehearsal-chain.mjs, Safe v1.5.0 snapshot, NO impersonation: only
// transactions signed by the wallet are accepted), gives the bundle's deployer some local-only ETH for gas, and
// serves, under a random one-time path:
//   deploy.html + assets   the Deploy Console (built with a relative base)
//   deploy/bundle.json     the rehearsal bundle (validated by the console's own core before serving)
//   rpc                    a JSON-RPC relay to the local chain for the wallet's custom network and the console:
//                          read methods, plus eth_sendRawTransaction ONLY for chain 31337 and ONLY from the bundle's
//                          deployer. Unsigned sends, signing methods and every node-control method are refused.
// Never logs raw transactions, signatures or keys. Prints STATION_READY <port> <token> when ready.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { Transaction, getAddress, parseEther } from 'ethers'
import { fundLocal, startRehearsalChain, REHEARSAL_CHAIN_ID } from '../lib/rehearsal-chain.mjs'
import { validateBundle } from '../../src/deploy/core.ts'
import { TESTNET_RPC } from '../../src/deploy/expected.ts'

const args = process.argv.slice(2)
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined }
const die = (m) => { console.error(`error: ${m}`); process.exit(1) }

const bundlePath = opt('bundle') ?? die('--bundle <rehearsal bundle> is required')
const dist = resolve(opt('dist') ?? die('--dist <console build dir> is required (npm run build:deploy-console)'))
if (!existsSync(join(dist, 'deploy.html'))) die(`${dist}/deploy.html not found (build with: npm run build:deploy-console)`)
const BUNDLE_BYTES = readFileSync(bundlePath)
const bundle = JSON.parse(BUNDLE_BYTES)
const REHEARSAL = bundle.rehearsal === true && bundle.chainId === REHEARSAL_CHAIN_ID
if (!REHEARSAL && bundle.chainId !== 46630) die('only a rehearsal bundle (31337) or a final testnet bundle (46630) can be served')
const problems = validateBundle(bundle)
if (problems.length) die(`the bundle fails the console's validation:\n  - ${problems.join('\n  - ')}`)
const DEPLOYER = getAddress(bundle.deployer)
const PORT = Number(opt('port') ?? 8788)
const HOST = opt('host') ?? '0.0.0.0'
const MINUTES = Number(opt('minutes') ?? 45)
const FUND = parseEther(opt('fund-eth') ?? '0.01')
let PUBLIC_URL = null
if (opt('public-url')) {
  const u = new URL(opt('public-url'))
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) die('--public-url must be a bare https:// origin')
  PUBLIC_URL = u.origin
}
if (!(MINUTES > 0 && MINUTES <= 240)) die('--minutes must be between 1 and 240')

const chain = REHEARSAL ? await startRehearsalChain({ impersonate: false }) : null
if (chain) await fundLocal(chain.provider, DEPLOYER, FUND) // local rehearsal chain only
const TOKEN = randomBytes(16).toString('hex')
const BASE = `/${TOKEN}/`

// Read methods a wallet and the console need; eth_sendRawTransaction is handled separately below.
const READ = new Set(['eth_chainId', 'net_version', 'net_listening', 'web3_clientVersion', 'eth_syncing', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs'])
const seen = new Set()
function vetRaw(raw) {
  let tx
  try { tx = Transaction.from(raw) } catch { return 'not a signed transaction' }
  if (tx.chainId !== BigInt(REHEARSAL_CHAIN_ID)) return `signed for chain ${tx.chainId}, not the rehearsal chain ${REHEARSAL_CHAIN_ID}`
  if (!tx.from || getAddress(tx.from) !== DEPLOYER) return 'not signed by the bundle deployer'
  return null
}
async function relay(req) {
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }
  const id = req.id ?? null
  if (req.method === 'eth_sendRawTransaction') {
    const why = vetRaw(req.params?.[0])
    if (why) { console.log(`rehearsal rpc REFUSED raw transaction: ${why}`); return { jsonrpc: '2.0', id, error: { code: -32003, message: `refused by the rehearsal station: ${why}` } } }
    const tx = Transaction.from(req.params[0])
    console.log(`rehearsal rpc: signed transaction from the deployer, nonce ${tx.nonce}, ${tx.to ? `to ${tx.to}` : 'contract creation'}, ${(req.params[0].length - 2) / 2} bytes`)
  } else if (!READ.has(req.method)) {
    console.log(`rehearsal rpc REFUSED ${String(req.method).replace(/[^\x20-\x7e]/g, '?').slice(0, 60)}`)
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not allowed by the rehearsal station' } }
  } else if (!seen.has(req.method)) { seen.add(req.method); console.log(`rehearsal rpc first ${req.method}`) }
  try { return { jsonrpc: '2.0', id, result: await chain.provider.send(req.method, req.params ?? []) } } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: e?.error?.code ?? -32000, message: String(e?.error?.message ?? e?.shortMessage ?? e?.message ?? 'error').slice(0, 300) } }
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const headers = (type) => ({
  'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  // Rehearsal: the console talks only to this station. Testnet: the console also reads the official testnet RPC
  // (the only RPC a testnet bundle may name), straight from the phone.
  'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'${REHEARSAL ? '' : ` ${TESTNET_RPC}`}; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
})
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://station')
  if (url.pathname === `/${TOKEN}`) { res.writeHead(301, { location: `${BASE}deploy.html` }); return res.end() }
  if (!url.pathname.startsWith(BASE)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found') }
  const path = url.pathname.slice(BASE.length)
  try {
    if (req.method === 'POST' && path === 'rpc' && REHEARSAL) {
      let size = 0; const chunks = []
      for await (const c of req) { size += c.length; if (size > 512 * 1024) { res.writeHead(413); return res.end() } chunks.push(c) }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400, headers('application/json')); return res.end('{"error":"invalid JSON"}') }
      const out = Array.isArray(body) ? await Promise.all(body.slice(0, 50).map(relay)) : await relay(body)
      res.writeHead(200, headers('application/json; charset=utf-8'))
      return res.end(JSON.stringify(out))
    }
    if (req.method !== 'GET') { res.writeHead(404); return res.end() }
    if (path === 'deploy/bundle.json') { res.writeHead(200, headers(TYPES['.json'])); return res.end(BUNDLE_BYTES) }
    const file = normalize(join(dist, path === '' ? 'deploy.html' : path))
    if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile() || /(^|\/)index\.html$/.test(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found') }
    res.writeHead(200, headers(TYPES[extname(file)] ?? 'application/octet-stream'))
    return res.end(readFileSync(file))
  } catch {
    res.writeHead(500); return res.end()
  }
})

const shutdown = (why) => { console.log(`\nStopping the station (${why}).`); server.close(); (chain ? chain.stop() : Promise.resolve()).then(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref() }
process.on('SIGINT', () => shutdown('Ctrl+C'))
process.on('SIGTERM', () => shutdown('terminated'))
process.on('exit', () => { try { chain?.anvil.kill() } catch { /* already stopped */ } })
chain?.anvil.on('exit', () => { if (server.listening) shutdown('rehearsal chain stopped') })
setTimeout(() => shutdown(`${MINUTES}-minute limit`), MINUTES * 60_000).unref()

server.listen(PORT, HOST, () => {
  const port = server.address().port
  const origins = PUBLIC_URL ? [PUBLIC_URL] : (HOST === '0.0.0.0' ? Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${port}`) : [`http://${HOST}:${port}`])
  if (REHEARSAL) {
    console.log('Rixor Deploy Console REHEARSAL: local chain 31337 only (no real network; chain-31337 signatures are valid nowhere else)')
    console.log(`Bundle ${bundle.bundleHash} · deployer ${DEPLOYER} (funded with local-only ETH)`)
    for (const o of origins) console.log(`  Wallet network RPC URL: ${o}${BASE}rpc   (chain ID 31337)\n  Console page:           ${o}${BASE}deploy.html`)
  } else {
    console.log('Rixor Deploy Console: ROBINHOOD CHAIN TESTNET (46630) bundle, serve-only (no relay; the wallet sends to the official testnet RPC)')
    console.log(`Bundle ${bundle.bundleHash} · deployer ${DEPLOYER}`)
    for (const o of origins) console.log(`  Console page: ${o}${BASE}deploy.html`)
  }
  console.log(`Stops after ${MINUTES} minutes or with Ctrl+C. Raw transactions and signatures are never logged.`)
  console.log(`STATION_READY ${port} ${TOKEN}`)
})
