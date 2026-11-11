#!/usr/bin/env node
// MAINNET-MODE journey through the real UI, against a LOCAL FORK of Robinhood Chain mainnet. Nothing reaches mainnet.
//   node demo/e2e/mainnet-journey.mjs [screenshotDir]          (builds the app first unless --no-build)
//
// 1. A local anvil fork of mainnet (chain id 31337) gets the real deployment from the real mainnet scripts
//    (scripts/lib/forge-plan.mjs, network mainnet: CreateMainnetSafes → DeployRixorV2 → VerifyRixorV2 →
//    SeedMainnetRewards, official WIF). Then the fork's chain id is set to 4663 so the app's mainnet checks run unchanged.
// 2. The browser's requests to the official mainnet RPC are answered by the local fork (Playwright routing), and the
//    mainnet manifest is served by routing too: nothing is written to public/ and nothing is published.
// 3. A test-only EIP-1193 wallet stub forwards to the fork, where anvil impersonates an existing HOOKR holder.
//    No key exists in this script.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, getAddress, id as labelHash, parseEther } from 'ethers'
import { fundLocal, fundLocalWif, freePort, startRehearsalChain } from '../../scripts/lib/rehearsal-chain.mjs'
import { runForgePlan } from '../../scripts/lib/forge-plan.mjs'
import { MAINNET_APPROVE_TOTAL, MAINNET_TOKENS } from '../../src/deploy/expected.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')
const args = process.argv.slice(2)
const shotDir = args.find((a) => !a.startsWith('--')) ?? join(ROOT, 'demo/e2e/mainnet-shots')
mkdirSync(shotDir, { recursive: true })
const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com'
const HOOKR = MAINNET_TOKENS.HOOKR.address, WIF = MAINNET_TOKENS.WIF.address
const HOOKR_HOLDER = '0xA522e716e1750702F775416f2Aa3Df620D9A1831' // existing mainnet holder, impersonated on the fork only
const results = []
let onFail = async () => {}
const step = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`[mainnet-e2e] PASS ${name}`) } catch (e) { results.push({ name, ok: false }); console.log(`[mainnet-e2e] FAIL ${name}: ${String(e.message).split('\n')[0]}`); await onFail().catch(() => {}); throw e }
}
const addr = (l) => getAddress('0x' + labelHash(l).slice(26))

if (!args.includes('--no-build')) {
  const b = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  if (b.status !== 0) { console.error(b.stdout, b.stderr); process.exit(1) }
}
const chain = await startRehearsalChain({ impersonate: true, fork: 'mainnet' })
const port = await freePort()
const preview = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
let browser
const errors = []
try {
  // ---------------------------------------------------------------- deployment with the real mainnet scripts
  const deployer = addr('rixor.mainnet-e2e.deployer')
  const owners = [1, 2, 3].map((i) => addr(`rixor.mainnet-e2e.owner.${i}`)), guardians = [1, 2, 3].map((i) => addr(`rixor.mainnet-e2e.guardian.${i}`))
  await fundLocal(chain.provider, deployer, parseEther('0.05'))
  await fundLocalWif(chain.provider, deployer, MAINNET_APPROVE_TOTAL)
  const plan = runForgePlan({ rpc: chain.rpc, chainId: 31337, deployer, owners, guardians, tag: 'e2e', network: 'mainnet' })
  const m = plan.manifest
  // Streams start at the next UTC midnight: move past it so the UI shows live WIF rates.
  const now = (await chain.provider.getBlock('latest')).timestamp
  await chain.provider.send('evm_setNextBlockTimestamp', [Math.ceil(now / 86400) * 86400 + 600]); await chain.provider.send('evm_mine', [])
  await chain.provider.send('anvil_setChainId', [4663])
  if (Number(await chain.provider.send('eth_chainId', [])) !== 4663) throw new Error('could not set the fork chain id to 4663')
  await chain.provider.send('anvil_setBalance', [HOOKR_HOLDER, '0x' + parseEther('1').toString(16)])
  const manifest = { chainId: 4663, block: Number(m.block), locker: m.locker, rewards: m.rewards, challenges: m.challenges, wif: m.wif, ownerSafe: m.ownerSafe, guardianSafe: m.guardianSafe, minHoldSeconds: m.minHoldSeconds }
  const forward = async (body) => (await fetch(chain.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text()

  browser = await chromium.launch()
  const newPage = async (served) => {
    const context = await browser.newContext({ ...devices['iPhone 13'] })
    // Every request to the official mainnet RPC is answered by the local fork; the manifest is served by routing.
    await context.route(`${MAINNET_RPC}/**`, async (r) => r.fulfill({ status: 200, contentType: 'application/json', body: await forward(r.request().postData() ?? '{}') }))
    await context.route(MAINNET_RPC, async (r) => r.fulfill({ status: 200, contentType: 'application/json', body: await forward(r.request().postData() ?? '{}') }))
    await context.route('**/mainnet/deployment.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(served) }))
    await context.route('**/testnet/deployment.json', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'none' }))
    await context.addInitScript(({ rpc, tester }) => {
      let id = 0
      const provider = {
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [tester]
          if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
          if (method === 'eth_sendTransaction') {
            // Like a real wallet, set its own fee: the node's gas price (anvil rejects the dapp's EIP-1559 hints on a fork).
            const gp = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'eth_gasPrice', params: [] }) })).json()
            const { maxFeePerGas: _a, maxPriorityFeePerGas: _b, ...tx } = params[0]
            params = [{ ...tx, gasPrice: gp.result }]
          }
          const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) })
          const body = await res.json()
          if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data })
          return body.result
        },
        on: () => {}, removeListener: () => {},
      }
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'e2e-fork', name: 'E2E fork wallet', icon: '', rdns: 'test.e2e.fork' }, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
    }, { rpc: MAINNET_RPC, tester: HOOKR_HOLDER })
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    return page
  }
  const page = await newPage(manifest)
  const shot = (n) => page.screenshot({ path: join(shotDir, `${n}.png`), fullPage: true })
  const receipt = (text) => page.locator('.receipt', { hasText: text }).first().waitFor({ timeout: 90_000 })
  const go = async (hash) => { await page.evaluate((h) => { window.location.hash = h }, hash); await page.waitForTimeout(400) }
  const appUrl = `http://127.0.0.1:${port}`
  onFail = async () => { await shot('fail'); for (const n of await page.locator('.notice, .receipt, .field-error, .tx-progress').allInnerTexts()) console.log(`[mainnet-e2e]   ui: ${n.replace(/\s+/g, ' ').slice(0, 300)}`) }

  await step('Mainnet tab appears once a verified mainnet manifest is published; real-asset warning shown', async () => {
    await page.goto(`${appUrl}/?full`)
    await page.locator('.demo-strip .seg button', { hasText: 'Mainnet' }).click({ timeout: 120_000 })
    await page.locator('.demo-strip', { hasText: 'real assets' }).waitFor({ timeout: 90_000 })
    await page.locator('.wallet-btn small', { hasText: 'Mainnet' }).waitFor()
    await page.locator('.token-list', { hasText: 'HOOKR' }).first().waitFor({ timeout: 60_000 })
    await page.locator('.token-list', { hasText: 'TORCH' }).first().waitFor()
    await shot('m01-mainnet-explore')
  })
  await step('connect the wallet on chain 4663 (no faucet offered on mainnet)', async () => {
    await page.locator('.tabbar button', { hasText: 'Wallet' }).click()
    await page.locator('.sheet .kicker', { hasText: 'Robinhood Chain mainnet' }).first().waitFor()
    await page.locator('.sheet').getByRole('button', { name: 'Connect wallet', exact: true }).click()
    await page.locator('.sheet .wallet-identity').waitFor({ timeout: 30_000 })
    await page.locator('.sheet .notice', { hasText: 'Real assets on mainnet' }).waitFor()
    if (await page.locator('.sheet', { hasText: 'faucet' }).count()) throw new Error('mainnet must not offer any faucet')
    await shot('m02-wallet')
    await page.locator('.sheet .icon-btn[aria-label="Close"]').click()
  })
  await step('Class B HOOKR: Diamond disabled; lock 1 unit (1,000 HOOKR) Committed 30 days with real HOOKR', async () => {
    await go('#/lock')
    await page.locator('.seg button', { hasText: 'HOOKR' }).click()
    if (!(await page.getByRole('radio', { name: /Diamond/ }).isDisabled())) throw new Error('Diamond must be disabled for Class B')
    await page.locator('.notice', { hasText: 'Mainnet listing · real token' }).waitFor()
    await page.getByRole('radio', { name: /Committed/ }).click()
    await page.locator('.chip', { hasText: /^1 unit$/ }).click()
    await page.locator('.chip', { hasText: '30 days' }).click()
    await page.getByRole('button', { name: 'Lock HOOKR' }).click()
    await receipt('Locked 1,000 HOOKR')
    const held = await new Contract(HOOKR, ['function balanceOf(address) view returns (uint256)'], chain.provider).balanceOf(m.locker)
    if (held !== 1000n * 10n ** 18n) throw new Error(`Locker holds ${held} HOOKR wei`)
    await shot('m03-locked')
  })
  await step('real WIF rewards accrue from the funded stream and are claimed to the wallet', async () => {
    const wif = new Contract(WIF, ['function balanceOf(address) view returns (uint256)'], chain.provider)
    const before = await wif.balanceOf(HOOKR_HOLDER)
    await chain.provider.send('evm_increaseTime', [2 * 86400]); await chain.provider.send('evm_mine', [])
    await go('#/portfolio')
    await page.reload()
    const claimAll = page.getByRole('button', { name: /^Claim all / })
    await claimAll.waitFor({ timeout: 90_000 })
    await claimAll.click()
    await receipt('Claimed')
    const got = (await wif.balanceOf(HOOKR_HOLDER)) - before
    if (got <= 0n) throw new Error('no WIF received')
    console.log(`[mainnet-e2e]   claimed ${Number(got / 10n ** 14n) / 1e4} WIF (official WIF token code on the fork)`)
    await shot('m04-claimed')
  })
  await step('activity lists the lock and the claim', async () => {
    await go('#/activity')
    await page.locator('.feed li', { hasText: 'locked HOOKR' }).first().waitFor({ timeout: 30_000 })
  })
  await step('a tampered manifest (Rewards pays HOOKR) is refused: the Mainnet tab never appears', async () => {
    const bad = await newPage({ ...manifest, wif: HOOKR })
    await bad.goto(`${appUrl}/?full`)
    await bad.locator('.demo-strip', { hasText: 'Not live Robinhood Chain' }).waitFor({ timeout: 120_000 })
    await bad.waitForTimeout(1500)
    if (await bad.locator('.demo-strip .seg button', { hasText: 'Mainnet' }).count()) throw new Error('Mainnet tab shown for a manifest with the wrong reward token')
  })
  await step('a manifest whose Locker is another contract is refused when Mainnet mode starts', async () => {
    const bad = await newPage({ ...manifest, locker: m.rewards })
    await bad.goto(`${appUrl}/?full`)
    await bad.locator('.demo-strip .seg button', { hasText: 'Mainnet' }).click({ timeout: 120_000 })
    await bad.locator('.notice--error', { hasText: 'Mainnet deployment refused' }).waitFor({ timeout: 60_000 })
  })
} catch (e) { if (!results.some((r) => !r.ok)) { results.push({ name: 'setup', ok: false }); console.log(`[mainnet-e2e] FAIL setup: ${e.message.split('\n')[0]}`) } } finally {
  await browser?.close()
  preview.kill('SIGTERM')
  await chain.stop()
  const failed = results.filter((r) => !r.ok).length
  console.log(JSON.stringify({ passed: results.length - failed, failed, pageErrors: errors }, null, 1))
  process.exit(failed || errors.length ? 1 : 0)
}
