// Public HTTP surface of the demo backend. Anvil itself listens on 127.0.0.1 only; this server exposes:
//   POST /rpc            allowlisted JSON-RPC (no anvil_*, evm_*, debug_*, eth_sendTransaction, signing)
//   GET  /manifest       public deployment description (addresses, provisional demo parameters, labels)
//   GET  /health         liveness
//   POST /faucet         rate-limited fork-WIF + fork-ETH for a demo address
//   POST /time/advance   bounded fork-time control for demonstrating settlement (demo only)
import { createServer } from 'node:http'
import { Contract, NonceManager, Wallet, isAddress, getAddress, parseEther, parseUnits } from './deps.mjs'

const ALLOWED = new Set([
  'web3_clientVersion', 'net_version', 'net_listening', 'eth_chainId', 'eth_blockNumber', 'eth_syncing',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_estimateGas', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getTransactionCount', 'eth_sendRawTransaction',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getLogs', 'eth_accounts',
])
const MAX_BODY = 128 * 1024
const MAX_BATCH = 25
const MAX_LOG_RANGE = 200_000

const hex = (n) => '0x' + BigInt(n).toString(16)
/** Reads the latest block without the ethers provider cache. */
const latestBlock = async (provider) => {
  const b = await provider.send('eth_getBlockByNumber', ['latest', false])
  return { number: Number(b.number), timestamp: Number(b.timestamp) }
}

class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map() }
  allow(key) {
    const now = Date.now()
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (list.length >= this.limit) { this.hits.set(key, list); return false }
    list.push(now)
    this.hits.set(key, list)
    return true
  }
}

/** Serialises privileged operations (faucet transfers, time control) so nonces never collide. */
class Mutex {
  constructor() { this.p = Promise.resolve() }
  run(fn) { const next = this.p.then(fn, fn); this.p = next.catch(() => {}); return next }
}

export function createApi({ config, anvilUrl, provider, manifest, keys, clock, log }) {
  const rpcLimiter = new RateLimiter(600, 60_000)
  const sendLimiter = new RateLimiter(60, 60_000)
  const faucetIpLimiter = new RateLimiter(10, 60 * 60_000)
  const timeLimiter = new RateLimiter(30, 60 * 60_000)
  const faucetByAddress = new Map()
  const mutex = new Mutex()
  const faucetSigner = new NonceManager(new Wallet(keys.faucet, provider))
  const wif = new Contract(manifest.contracts.wif, ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], faucetSigner)

  const cors = (req, res) => {
    const origin = req.headers.origin
    const allowAll = config.allowedOrigins.includes('*')
    if (origin && (allowAll || config.allowedOrigins.some((o) => origin === o || (o.startsWith('*.') && origin.endsWith(o.slice(1)))))) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    res.setHeader('Access-Control-Max-Age', '86400')
    // Chrome Private Network Access preflight (only relevant when the backend runs on a private address).
    if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-rixor-environment': 'fork-demo' })
    res.end(JSON.stringify(body))
  }
  const ipOf = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(new Error('invalid JSON')) } })
    req.on('error', reject)
  })

  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

  async function forward(call) {
    const res = await fetch(anvilUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call) })
    return res.json()
  }

  async function handleCall(call, ip) {
    if (!call || call.jsonrpc !== '2.0' || typeof call.method !== 'string') return rpcError(call?.id, -32600, 'invalid request')
    if (!ALLOWED.has(call.method)) return rpcError(call.id, -32601, `method ${call.method} is not available on the Rixor demo RPC`)
    if (call.method === 'eth_accounts') return { jsonrpc: '2.0', id: call.id, result: [] }
    if (call.method === 'eth_sendRawTransaction' && !sendLimiter.allow(ip)) return rpcError(call.id, -32005, 'rate limited')
    if (call.method === 'eth_getLogs') {
      const f = call.params?.[0] ?? {}
      if (f.blockHash === undefined) {
        const latest = (await latestBlock(provider)).number
        const toNum = (v, d) => (v === undefined || v === 'latest' || v === 'pending' ? d : v === 'earliest' ? 0 : Number(v))
        const from = toNum(f.fromBlock, latest)
        const to = toNum(f.toBlock, latest)
        if (to - from > MAX_LOG_RANGE) return rpcError(call.id, -32005, `log range limited to ${MAX_LOG_RANGE} blocks`)
      }
    }
    return forward(call)
  }

  async function faucet(address, ip) {
    if (!isAddress(address)) return [400, { error: 'address must be a 0x-prefixed 20-byte address' }]
    const who = getAddress(address)
    const last = faucetByAddress.get(who) ?? 0
    if (Date.now() - last < config.faucetCooldownMs) {
      return [429, { error: 'This demo address was funded recently. Try again later.', retryAfterMs: config.faucetCooldownMs - (Date.now() - last) }]
    }
    if (!faucetIpLimiter.allow(ip)) return [429, { error: 'Too many faucet requests from this network. Try again later.' }]
    return mutex.run(async () => {
      const amount = parseUnits(config.faucetWif, 18)
      const reserve = await wif.balanceOf(manifest.demoAccounts.faucet)
      if (reserve < amount) return [503, { error: 'Demo faucet reserve is empty.' }]
      const minEth = parseEther(config.faucetEth)
      const ethBal = await provider.getBalance(who)
      if (ethBal < minEth) await provider.send('anvil_setBalance', [who, hex(minEth)])
      const tx = await wif.transfer(who, amount)
      await tx.wait()
      faucetByAddress.set(who, Date.now())
      log(`faucet: ${config.faucetWif} fork-WIF -> ${who}`)
      return [200, { ok: true, address: who, wif: config.faucetWif, eth: config.faucetEth, txHash: tx.hash, note: 'Fork-demo assets only. Worthless outside the Rixor demo chain.' }]
    })
  }

  async function advanceTime(seconds, ip) {
    if (!config.timeControl) return [403, { error: 'Time control is disabled on this backend.' }]
    const s = Number(seconds)
    if (!Number.isInteger(s) || s < 60 || s > config.maxTimeAdvance) return [400, { error: `seconds must be an integer between 60 and ${config.maxTimeAdvance}` }]
    if (!timeLimiter.allow(ip)) return [429, { error: 'Too many time changes. Try again later.' }]
    return mutex.run(async () => {
      await provider.send('evm_increaseTime', [s])
      await provider.send('evm_mine', [])
      clock.offset += s
      const block = await latestBlock(provider)
      log(`time: advanced ${s}s -> ${block.timestamp}`)
      return [200, { ok: true, advancedBy: s, timestamp: block.timestamp, block: block.number, chainNow: block.timestamp }]
    })
  }

  return createServer(async (req, res) => {
    cors(req, res)
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const ip = ipOf(req)
    const path = (req.url ?? '/').split('?')[0]
    try {
      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        const block = await latestBlock(provider)
        // chainNow: the time the next block would carry (anvil time = wall clock + demo offset).
        const chainNow = Math.max(block.timestamp, Math.floor(Date.now() / 1000) + clock.offset)
        return send(res, 200, { ok: true, environment: 'fork-demo', chainId: config.chainId, block: block.number, timestamp: block.timestamp, chainNow })
      }
      if (req.method === 'GET' && path === '/manifest') return send(res, 200, manifest)
      if (req.method === 'POST' && path === '/rpc') {
        if (!rpcLimiter.allow(ip)) return send(res, 429, rpcError(null, -32005, 'rate limited'))
        const body = await readBody(req)
        if (Array.isArray(body)) {
          if (body.length > MAX_BATCH) return send(res, 200, rpcError(null, -32600, `batch limited to ${MAX_BATCH}`))
          return send(res, 200, await Promise.all(body.map((c) => handleCall(c, ip))))
        }
        return send(res, 200, await handleCall(body, ip))
      }
      if (req.method === 'POST' && path === '/faucet') {
        const body = await readBody(req)
        const [status, out] = await faucet(body.address, ip)
        return send(res, status, out)
      }
      if (req.method === 'POST' && path === '/time/advance') {
        const body = await readBody(req)
        const [status, out] = await advanceTime(body.seconds, ip)
        return send(res, status, out)
      }
      return send(res, 404, { error: 'not found' })
    } catch (e) {
      log(`error: ${e.message}`)
      return send(res, 500, { error: 'internal error' })
    }
  })
}
