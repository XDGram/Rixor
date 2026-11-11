#!/usr/bin/env node
// RIXOR LITE journey through the real UI, against a LOCAL FORK of Robinhood Chain mainnet. Nothing reaches mainnet.
//   node demo/e2e/lite-journey.mjs [screenshotDir] [--no-build]
//
// 1. A local anvil fork of mainnet (chain id 31337) gets the real deployment from the real script
//    (script/DeployRixorLite.s.sol through scripts/lib/forge-plan.mjs): RixorLite + the 1,000 WIF reward approval.
//    Then the fork's chain id is set to 4663 so the app's mainnet checks run unchanged.
// 2. The browser's requests to the official mainnet RPC are answered by the local fork (Playwright routing), and the
//    deployment manifest is served by routing too: nothing is written to public/ and nothing is published.
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
import { LITE, MAINNET_TOKENS } from '../../src/deploy/expected.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')
const args = process.argv.slice(2)
const shotDir = args.find((a) => !a.startsWith('--')) ?? join(ROOT, 'demo/e2e/mainnet-shots')
mkdirSync(shotDir, { recursive: true })
const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com'
const HOOKR = MAINNET_TOKENS.HOOKR.address, WIF = MAINNET_TOKENS.WIF.address
const USER = '0xA522e716e1750702F775416f2Aa3Df620D9A1831' // existing mainnet HOOKR holder, impersonated on the fork only
const E18 = 10n ** 18n
const results = []
let onFail = async () => {}
const step = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`[lite-e2e] PASS ${name}`) } catch (e) { results.push({ name, ok: false }); console.log(`[lite-e2e] FAIL ${name}: ${String(e.message).split('\n')[0]}`); await onFail().catch(() => {}); throw e }
}

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
  // ---------------------------------------------------------------- deployment with the real script
  const rewardWallet = getAddress('0x' + labelHash('rixor.lite-e2e.reward-wallet').slice(26))
  await fundLocal(chain.provider, rewardWallet, parseEther('0.0003'))
  await fundLocalWif(chain.provider, rewardWallet, LITE.budget)
  const { manifest: m } = runForgePlan({ rpc: chain.rpc, chainId: 31337, deployer: rewardWallet, owners: [], guardians: [], tag: 'e2e', network: 'lite' })
  await chain.provider.send('anvil_setChainId', [4663])
  if (Number(await chain.provider.send('eth_chainId', [])) !== 4663) throw new Error('could not set the fork chain id to 4663')
  await chain.provider.send('anvil_setBalance', [USER, '0x' + parseEther('1').toString(16)])
  const manifest = { chainId: 4663, block: Number(m.block), lite: m.lite, token: m.token, wif: m.wif, rewardWallet: m.rewardWallet }
  const erc = (a) => new Contract(a, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], chain.provider)
  const forward = async (body) => (await fetch(chain.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text()

  browser = await chromium.launch()
  const newPage = async (served) => {
    const context = await browser.newContext({ ...devices['iPhone 13'] })
    for (const pattern of [`${MAINNET_RPC}/**`, MAINNET_RPC]) await context.route(pattern, async (r) => r.fulfill({ status: 200, contentType: 'application/json', body: await forward(r.request().postData() ?? '{}') }))
    await context.route('**/lite/deployment.json', (r) => (served ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(served) }) : r.fulfill({ status: 404, contentType: 'text/plain', body: 'none' })))
    await context.addInitScript(({ rpc, user }) => {
      let id = 0
      const call = async (method, params) => {
        const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) })
        const body = await res.json()
        if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data })
        return body.result
      }
      const provider = {
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [user]
          if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
          if (method === 'eth_sendTransaction') {
            // Like a real wallet, it sets its own fee (anvil rejects the dapp's EIP-1559 hints on a fork).
            const { maxFeePerGas: _a, maxPriorityFeePerGas: _b, ...tx } = params[0]
            return call(method, [{ ...tx, gasPrice: await call('eth_gasPrice', []) }])
          }
          return call(method, params)
        },
        on: () => {}, removeListener: () => {},
      }
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'e2e-fork', name: 'E2E fork wallet', icon: '', rdns: 'test.e2e.fork' }, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
    }, { rpc: MAINNET_RPC, user: USER })
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    return page
  }
  const appUrl = `http://127.0.0.1:${port}`

  await step('before a deployment is published the page says "Not deployed yet" and offers nothing to sign', async () => {
    const p0 = await newPage(null)
    await p0.goto(`${appUrl}/`)
    await p0.locator('.notice', { hasText: 'Not deployed yet' }).waitFor({ timeout: 60_000 })
    if (await p0.getByRole('button', { name: /Lock|Claim|Exit/ }).count()) throw new Error('action buttons shown without a deployment')
    if (!(await p0.locator('.wallet-btn').isDisabled())) throw new Error('connect must be disabled without a deployment')
  })

  const page = await newPage(manifest)
  const shot = (n) => page.screenshot({ path: join(shotDir, `${n}.png`), fullPage: true })
  const receipt = (text) => page.locator('.receipt', { hasText: text }).first().waitFor({ timeout: 90_000 })
  const earned = async () => Number((await page.getByTestId('earned').innerText()).replace(/,/g, ''))
  onFail = async () => { await shot('lite-fail'); for (const n of await page.locator('.notice, .receipt, .field-error, .tx-progress').allInnerTexts()) console.log(`[lite-e2e]   ui: ${n.replace(/\s+/g, ' ').slice(0, 300)}`) }
  const connect = async () => { await page.getByRole('button', { name: 'Connect wallet', exact: true }).click(); await page.locator('.wallet-btn b', { hasText: '0xA522' }).waitFor({ timeout: 30_000 }) }

  await step('the verified deployment is shown: funded reward wallet, rate, contract links; only the demo is visible', async () => {
    await page.goto(`${appUrl}/`)
    await page.locator('.stat', { hasText: 'Reward wallet' }).locator('strong', { hasText: '1,000' }).waitFor({ timeout: 90_000 })
    await page.locator('.stat', { hasText: 'Reward rate' }).locator('strong', { hasText: '142.86' }).waitFor()
    await page.locator(`a[href$="${manifest.lite}"]`).waitFor()
    const text = await page.locator('body').innerText()
    for (const hidden of ['Simulation', 'Testnet', 'Challenge', 'Diamond', 'TORCH']) if (text.includes(hidden)) throw new Error(`"${hidden}" is still visible in the demo`)
    await shot('l01-home')
  })
  await step('connect the wallet on chain 4663', async () => {
    await connect()
    await page.locator('h2', { hasText: 'Nothing locked yet' }).waitFor({ timeout: 30_000 })
  })
  await step('amounts below the minimum are refused before anything is signed', async () => {
    await page.locator('#lock-amount').fill('5')
    await page.locator('.field-error', { hasText: 'Minimum is 10 HOOKR' }).waitFor()
    if (!(await page.getByRole('button', { name: 'Lock HOOKR' }).isDisabled())) throw new Error('lock must be disabled below the minimum')
  })
  await step('lock 50 HOOKR: exact approval, then the lock; the contract holds exactly 50 real HOOKR', async () => {
    await page.locator('.chip', { hasText: /^50$/ }).click()
    await page.getByRole('button', { name: 'Lock HOOKR' }).click()
    await receipt('Locked 50 HOOKR')
    await page.locator('h2', { hasText: '50 HOOKR locked' }).waitFor({ timeout: 30_000 })
    if ((await erc(HOOKR).balanceOf(m.lite)) !== 50n * E18) throw new Error('contract does not hold exactly 50 HOOKR')
    if ((await erc(HOOKR).allowance(USER, m.lite)) !== 0n) throw new Error('approval was not exact')
    await shot('l02-locked')
  })
  await step('exit is not offered during the 1-day lock period', async () => {
    if (!(await page.getByRole('button', { name: /Exit available in/ }).isDisabled())) throw new Error('exit must be disabled while locked')
  })
  await step('WIF is earned every second (10 minutes on the fork ≈ 0.99 WIF for a sole locker)', async () => {
    await chain.provider.send('evm_increaseTime', [600]); await chain.provider.send('evm_mine', [])
    await page.reload(); await connect()
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="earned"]')?.textContent?.replace(/,/g, '')) > 0.9, null, { timeout: 60_000 })
    const a = await earned(); await page.waitForTimeout(2200); const b = await earned()
    if (!(b > a)) throw new Error(`the counter is not growing (${a} → ${b})`)
    console.log(`[lite-e2e]   earned counter ${a} → ${b} WIF`)
    await shot('l03-earning')
  })
  let claimed = 0n
  await step('claim: real WIF moves from the reward wallet to the user', async () => {
    const [u0, r0] = await Promise.all([erc(WIF).balanceOf(USER), erc(WIF).balanceOf(m.rewardWallet)])
    await page.getByRole('button', { name: 'Claim WIF' }).click()
    await receipt('Claimed WIF')
    const [u1, r1] = await Promise.all([erc(WIF).balanceOf(USER), erc(WIF).balanceOf(m.rewardWallet)])
    claimed = u1 - u0
    if (claimed <= 0n || r0 - r1 !== claimed) throw new Error(`user +${claimed}, reward wallet -${r0 - r1}`)
    if ((await erc(WIF).balanceOf(m.lite)) !== 0n) throw new Error('the contract must never hold WIF')
    await page.locator('.rows a[href*="/tx/"]').first().waitFor()
    console.log(`[lite-e2e]   claimed ${Number(claimed / 10n ** 14n) / 1e4} WIF, paid by the reward wallet`)
    await shot('l04-claimed')
  })
  await step('after the lock period, exit returns exactly the 50 HOOKR', async () => {
    const before = await erc(HOOKR).balanceOf(USER)
    await chain.provider.send('evm_increaseTime', [86400]); await chain.provider.send('evm_mine', [])
    await page.reload(); await connect()
    await page.getByRole('button', { name: 'Exit 50 HOOKR' }).click({ timeout: 60_000 })
    await receipt('Exited HOOKR')
    if ((await erc(HOOKR).balanceOf(USER)) - before !== 50n * E18) throw new Error('exit did not return exactly 50 HOOKR')
    if ((await erc(HOOKR).balanceOf(m.lite)) !== 0n) throw new Error('contract still holds HOOKR')
    await shot('l05-exited')
  })
  await step('a tampered deployment (different reward wallet) is refused', async () => {
    const bad = await newPage({ ...manifest, rewardWallet: USER })
    await bad.goto(`${appUrl}/`)
    await bad.locator('.notice--error', { hasText: 'Deployment refused' }).waitFor({ timeout: 60_000 })
  })
  await step('an address that is not RixorLite is refused', async () => {
    const bad = await newPage({ ...manifest, lite: WIF })
    await bad.goto(`${appUrl}/`)
    await bad.locator('.notice--error', { hasText: 'Deployment refused' }).waitFor({ timeout: 60_000 })
  })
  await step('the full protocol is hidden, not removed: it still loads with ?full', async () => {
    const old = await newPage(null)
    await old.goto(`${appUrl}/?full`)
    await old.locator('.demo-strip .seg button', { hasText: 'Simulation' }).waitFor({ timeout: 120_000 })
  })
} catch (e) { if (!results.some((r) => !r.ok)) { results.push({ name: 'setup', ok: false }); console.log(`[lite-e2e] FAIL setup: ${e.message.split('\n')[0]}`) } } finally {
  await browser?.close()
  preview.kill('SIGTERM')
  await chain.stop()
  const failed = results.filter((r) => !r.ok).length
  console.log(JSON.stringify({ passed: results.length - failed, failed, pageErrors: errors }, null, 1))
  process.exit(failed || errors.length ? 1 : 0)
}
