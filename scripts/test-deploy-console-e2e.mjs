#!/usr/bin/env node
// End-to-end test of the Deploy Console UI on a phone viewport: the built console page, served by the rehearsal
// station, driving a local rehearsal chain (31337) through all 11 steps with a Zerion-like wallet stub.
// The stub signs with a throwaway in-memory test key on the Node side (never in the page) and submits raw signed
// transactions to the station's RPC, exactly like a mobile wallet. Nothing reaches any real network.
//   node scripts/test-deploy-console-e2e.mjs [screenshotDir]
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Transaction, Wallet } from 'ethers'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = mkdtempSync(join(tmpdir(), 'rixor-deploy-e2e-'))
const SHOTS = process.argv[2] ?? join(DIR, 'shots')
mkdirSync(SHOTS, { recursive: true })
let failed = 0
const t = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`) }
let station = null, browser = null, log = ''

try {
  // 1. A throwaway deployer key (test only) and six random signer addresses; the exporter builds the rehearsal bundle.
  const deployer = Wallet.createRandom()
  const signers = Array.from({ length: 6 }, () => Wallet.createRandom().address)
  const bundlePath = join(DIR, 'bundle.json')
  const ex = spawnSync(process.execPath, [join(ROOT, 'scripts/export-deploy-bundle.mjs'), '--rehearsal', '--out', bundlePath], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20,
    env: { ...process.env, RH_TESTNET_RPC_URL: 'http://127.0.0.1:1', RIXOR_DEPLOYER: deployer.address, RIXOR_OWNER_SIGNERS: signers.slice(0, 3).join(','), RIXOR_GUARDIAN_SIGNERS: signers.slice(3).join(',') },
  })
  t('exporter builds a final rehearsal bundle for this deployer and six distinct signers', ex.status === 0, (ex.stderr || ex.stdout).slice(-500))
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'))

  // 2. Console build (relative base) and the station.
  const dist = join(DIR, 'dist')
  const b = spawnSync('npx', ['vite', 'build', '--base', './', '--outDir', dist, '--emptyOutDir'], { cwd: ROOT, encoding: 'utf8' })
  t('console builds with a relative base', b.status === 0, b.stderr.slice(-400))
  station = spawn(process.execPath, [join(ROOT, 'scripts/deploy-console/station.mjs'), '--bundle', bundlePath, '--dist', dist, '--port', '0', '--host', '127.0.0.1', '--minutes', '15'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  station.stdout.on('data', (c) => { log += c }); station.stderr.on('data', (c) => { log += c })
  let port, token
  for (let i = 0; i < 300 && !port; i++) { const m = log.match(/STATION_READY (\d+) ([0-9a-f]{32})/); if (m) [, port, token] = m; else await new Promise((r) => setTimeout(r, 100)) }
  t('rehearsal station starts', Boolean(port), log.slice(-500))
  const base = `http://127.0.0.1:${port}/${token}/`
  const rpc = async (method, params = []) => (await (await fetch(`${base}rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json())

  // 3. Relay hardening (direct requests).
  t('relay refuses node control (anvil_setBalance)', (await rpc('anvil_setBalance', [deployer.address, '0x1'])).error?.code === -32601)
  t('relay refuses unsigned sends (eth_sendTransaction)', (await rpc('eth_sendTransaction', [{ from: deployer.address, to: deployer.address }])).error?.code === -32601)
  const raw46630 = await deployer.signTransaction({ chainId: 46630, nonce: 0, gasLimit: 21000, gasPrice: 1, to: deployer.address, value: 0 })
  t('relay refuses a transaction signed for testnet 46630', /chain 46630/.test((await rpc('eth_sendRawTransaction', [raw46630])).error?.message ?? ''))
  const stranger = Wallet.createRandom()
  const rawStranger = await stranger.signTransaction({ chainId: 31337, nonce: 0, gasLimit: 21000, gasPrice: 1, to: stranger.address, value: 0 })
  t('relay refuses a transaction from anyone but the deployer', /not signed by the bundle deployer/.test((await rpc('eth_sendRawTransaction', [rawStranger])).error?.message ?? ''))
  t('relay serves the chain id 31337', (await rpc('eth_chainId')).result === '0x7a69')
  t('wrong token path is 404', (await fetch(`http://127.0.0.1:${port}/${'0'.repeat(32)}/deploy.html`)).status === 404)
  t('the app (index.html) is not served by the station', (await fetch(`${base}index.html`)).status === 404)

  // 4. The phone: a Zerion-like wallet stub.
  browser = await chromium.launch()
  const context = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  let chain = 46630, added = null, rejectNext = false
  const walletCalls = []
  // Errors cross the Playwright bridge as data and are re-thrown in the page with their EIP-1193 code.
  await page.exposeFunction('walletRequest', async (method, params) => {
    try { return { result: await walletImpl(method, params) } } catch (e) { return { error: { code: e.code, message: e.message } } }
  })
  async function walletImpl(method, params) {
    walletCalls.push(method)
    const fwd = async (m, p) => { const r = await rpc(m, p); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.result }
    switch (method) {
      case 'eth_requestAccounts': case 'eth_accounts': return [deployer.address]
      case 'eth_chainId': return '0x' + chain.toString(16)
      case 'wallet_switchEthereumChain': if (params[0].chainId === '0x7a69' && added) { chain = 31337; return null } throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
      case 'wallet_addEthereumChain': added = params[0].rpcUrls[0]; chain = Number(params[0].chainId); return null
      case 'eth_sendTransaction': {
        if (rejectNext) { rejectNext = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }) }
        const tx = params[0]
        const raw = await deployer.signTransaction({ chainId: chain, nonce: Number(await fwd('eth_getTransactionCount', [deployer.address, 'pending'])), gasLimit: BigInt(tx.gas), gasPrice: BigInt(await fwd('eth_gasPrice', [])), to: tx.to ?? null, data: tx.data, value: BigInt(tx.value ?? 0) })
        return fwd('eth_sendRawTransaction', [raw])
      }
      default: return fwd(method, params ?? [])
    }
  }
  await page.addInitScript(() => {
    const provider = { request: async ({ method, params }) => { const r = await window.walletRequest(method, params ?? []); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.result }, on: () => {}, removeListener: () => {} }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'zerion-stub', name: 'Zerion', icon: '', rdns: 'io.zerion.wallet' }, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
  })
  const shot = (n) => page.screenshot({ path: join(SHOTS, `${n}.png`), fullPage: true })
  const connect = async () => { await page.getByRole('button', { name: 'Connect wallet' }).click(); await page.locator('section', { hasText: '2 · Wallet' }).getByText(deployer.address, { exact: true }).waitFor({ timeout: 20_000 }) }
  const doStep = async (i) => {
    await page.getByRole('button', { name: `Check step ${i}`, exact: true }).click()
    await page.getByRole('button', { name: `Ask wallet to sign step ${i}`, exact: true }).click({ timeout: 60_000 })
    await page.getByText(`Step ${i} verified`, { exact: true }).waitFor({ timeout: 90_000 })
  }

  await page.goto(`${base}deploy.html`)
  await page.getByText('Bundle verified', { exact: true }).waitFor({ timeout: 30_000 })
  t('console loads the bundle and verifies it against its pinned constants', true)
  t('rehearsal banner is shown', await page.getByText('REHEARSAL · local chain 31337').isVisible())
  t('the bundle hash is shown in full for comparison', (await page.locator('.hash').innerText()).replace(/\s/g, '') === bundle.bundleHash)
  await connect()
  await page.getByRole('button', { name: 'Switch wallet to chain 31337' }).click()
  await page.getByText('Next: step 1 of 11.').waitFor({ timeout: 20_000 })
  t('wallet added and switched to the rehearsal chain (4902 → add)', chain === 31337 && added === `${base}rpc`, String(added))
  await shot('d01-ready')

  for (let i = 1; i <= 4; i++) { await doStep(i); t(`UI step ${i} signed, mined and verified`, true) }
  await shot('d02-four-done')
  // Interruption: reload the page mid-deployment; the console resumes from the chain alone.
  await page.reload()
  await page.getByText('Bundle verified', { exact: true }).waitFor({ timeout: 30_000 })
  await connect()
  await page.getByText('Next: step 5 of 11.').waitFor({ timeout: 20_000 })
  t('after a reload the console resumes at step 5 with 4/11 confirmed', await page.getByText('3 · Deployment · 4/11 confirmed on chain').isVisible())
  await doStep(5); t('UI step 5 signed, mined and verified', true)
  // Rejection at the largest payload (Locker), then retry.
  rejectNext = true
  await page.getByRole('button', { name: 'Check step 6', exact: true }).click()
  await page.getByRole('button', { name: 'Ask wallet to sign step 6', exact: true }).click({ timeout: 60_000 })
  await page.getByText('You rejected the request in your wallet. Nothing was sent.').waitFor({ timeout: 20_000 })
  t('a rejected signature sends nothing and keeps step 6 next', await page.getByText('Next: step 6 of 11.').isVisible())
  for (let i = 6; i <= 11; i++) { await doStep(i); t(`UI step ${i} signed, mined and verified`, true) }
  await page.getByText('All 11 steps are on chain and verified.').waitFor({ timeout: 30_000 })
  t('deployment complete and verified in the UI', await page.getByText('Deployment verified on chain 31337').isVisible())
  await shot('d03-complete')
  await page.setViewportSize({ width: 320, height: 700 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  t('no horizontal overflow at 320 px', overflow <= 0, `overflow ${overflow}px`)
  await shot('d04-320px')
  t('no page errors', errors.length === 0, errors.join(' | '))
  t('the console only ever asked the wallet to send through eth_sendTransaction (11 sends + 1 rejected)', walletCalls.filter((m) => m === 'eth_sendTransaction').length === 12 && !walletCalls.includes('eth_sign') && !walletCalls.includes('personal_sign'))

  // 5. Serve-only mode for a testnet bundle: console + bundle, no chain, no relay.
  const tn = { ...bundle, chainId: 46630, rehearsal: false, final: true, rpc: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com' }
  const { bundleHashOf } = await import('../src/deploy/core.ts')
  tn.bundleHash = bundleHashOf(tn)
  const tnPath = join(DIR, 'testnet-bundle.json')
  ;(await import('node:fs')).writeFileSync(tnPath, JSON.stringify(tn))
  let log2 = ''
  const st2 = spawn(process.execPath, [join(ROOT, 'scripts/deploy-console/station.mjs'), '--bundle', tnPath, '--dist', dist, '--port', '0', '--host', '127.0.0.1', '--minutes', '2'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  st2.stdout.on('data', (c) => { log2 += c }); st2.stderr.on('data', (c) => { log2 += c })
  let p2, k2
  for (let i = 0; i < 200 && !p2; i++) { const m = log2.match(/STATION_READY (\d+) ([0-9a-f]{32})/); if (m) [, p2, k2] = m; else await new Promise((r) => setTimeout(r, 100)) }
  const b2 = `http://127.0.0.1:${p2}/${k2}/`
  t('testnet bundle: station runs serve-only (no local chain, no relay)', Boolean(p2) && /serve-only/.test(log2) && (await fetch(`${b2}rpc`, { method: 'POST', body: '{}' })).status === 404)
  t('testnet bundle: console page and the exact bundle are served', (await fetch(`${b2}deploy.html`)).status === 200 && (await (await fetch(`${b2}deploy/bundle.json`)).json()).bundleHash === tn.bundleHash)
  const csp = (await fetch(`${b2}deploy.html`)).headers.get('content-security-policy') ?? ''
  t('testnet bundle: the page may reach the official testnet RPC and nothing else external', /connect-src 'self' https:\/\/rpc\.testnet\.chain\.robinhood\.com;/.test(csp), csp)
  const cspReh = (await fetch(`${base}deploy.html`)).headers.get('content-security-policy') ?? ''
  t('rehearsal: the page may only reach the station itself', /connect-src 'self';/.test(cspReh), cspReh)
  st2.kill('SIGTERM'); await new Promise((r) => st2.once('exit', r))
  const badPath = join(DIR, 'bad.json')
  ;(await import('node:fs')).writeFileSync(badPath, JSON.stringify({ ...tn, final: false, bundleHash: bundleHashOf({ ...tn, final: false }) }))
  const st3 = spawnSync(process.execPath, [join(ROOT, 'scripts/deploy-console/station.mjs'), '--bundle', badPath, '--dist', dist, '--port', '0'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
  t('station refuses to serve a non-final testnet bundle', st3.status === 1 && /not a final bundle/.test(st3.stderr))

  // 6. Station log: 11 signed deployer transactions, nothing secret logged.
  const sentLines = log.match(/signed transaction from the deployer, nonce \d+/g) ?? []
  t('station relayed exactly 11 signed deployer transactions (nonces 0–10)', sentLines.length === 11 && sentLines.every((l, i) => l.endsWith(`nonce ${i}`)), sentLines.join(','))
  t('no raw transaction or signature in the station log', !/0x[0-9a-f]{200,}/i.test(log) && !log.includes(raw46630.slice(2, 80)))
  t('the planned deployer is the one that sent them', Transaction.from(raw46630).from === deployer.address)
} catch (e) {
  t('unexpected error', false, e.stack)
} finally {
  if (browser) await browser.close()
  if (station) { station.kill('SIGTERM'); await new Promise((r) => station.once('exit', r)) }
  rmSync(DIR, { recursive: true, force: true })
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${failed} failing test(s) (local rehearsal chain; Zerion-like stub signing with a throwaway test key; no real network)`)
process.exit(failed ? 1 : 0)
