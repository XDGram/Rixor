#!/usr/bin/env node
// Testnet-mode journey through the real UI, against the LOCAL testnet rehearsal chain (npm run rehearse:testnet -- --keep).
//   node demo/e2e/testnet-journey.mjs <appUrl> <localRpc> [screenshotDir]
// The page sees a test-only EIP-1193 wallet stub that forwards every request to the local anvil chain, where anvil
// signs for its unlocked default test account. No key exists in this script and nothing reaches a real network
// (wallet detection on the Explore page still reads mainnet balances read-only).
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')
const [appUrl, rpc, shotDir = './testnet-e2e-shots'] = process.argv.slice(2)
if (!appUrl || !rpc) { console.error('usage: node demo/e2e/testnet-journey.mjs <appUrl> <localRpc> [shots]'); process.exit(1) }
mkdirSync(shotDir, { recursive: true })
const results = []
const step = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`[testnet-e2e] PASS ${name}`) } catch (e) { results.push({ name, ok: false, error: String(e.message).split('\n')[0] }); console.log(`[testnet-e2e] FAIL ${name}: ${String(e.message).split('\n')[0]}`); throw e }
}
const rpcCall = async (method, params = []) => (await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result

const accounts = await rpcCall('eth_accounts')
const tester = accounts[3]
const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 13'] })
await context.addInitScript(({ rpc, tester }) => {
  let id = 0
  const provider = {
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [tester]
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) })
      const body = await res.json()
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data })
      return body.result
    },
    on: () => {}, removeListener: () => {},
  }
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'e2e-anvil', name: 'E2E local wallet', icon: '', rdns: 'test.e2e.anvil' }, provider }) }))
  window.addEventListener('eip6963:requestProvider', announce)
}, { rpc, tester })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const shot = (n) => page.screenshot({ path: join(shotDir, `${n}.png`), fullPage: true })
const receipt = (text) => page.locator('.receipt', { hasText: text }).first().waitFor({ timeout: 60_000 })
const go = async (hash) => { await page.evaluate((h) => { window.location.hash = h }, hash); await page.waitForTimeout(400) }

try {
  await step('switch from Simulation to Testnet', async () => {
    await page.goto(`${appUrl}/?full`)
    await page.locator('.demo-strip .seg button', { hasText: 'Testnet' }).click({ timeout: 120_000 })
    await page.locator('.demo-strip', { hasText: 'TEST tokens only' }).waitFor({ timeout: 60_000 })
    await page.locator('.wallet-btn small', { hasText: 'Testnet' }).waitFor()
    await shot('t01-testnet-explore')
  })
  await step('connect the browser wallet (testnet)', async () => {
    await page.locator('.tabbar button', { hasText: 'Wallet' }).click()
    await page.locator('.sheet').getByRole('button', { name: 'Connect wallet', exact: true }).click()
    await page.locator('.sheet .wallet-identity').waitFor({ timeout: 30_000 })
    await page.locator('.sheet .icon-btn[aria-label="Close"]').click()
  })
  await step('get TEST tokens from the faucets (wallet-signed, node gas estimates)', async () => {
    await page.getByRole('button', { name: 'Get TEST tokens' }).click()
    await receipt('Received TEST')
  })
  await step('faucet cooldown is shown per token and nothing is re-sent', async () => {
    await page.locator('.tabbar button', { hasText: 'Wallet' }).click()
    const sheet = page.locator('.sheet')
    await sheet.locator('dd', { hasText: 'Next at' }).nth(2).waitFor({ timeout: 30_000 }) // tMEMEA, tMEMEB, tWIF
    if (!(await sheet.getByRole('button', { name: 'Get all available TEST tokens' }).isDisabled())) throw new Error('faucet button must be disabled while every token is cooling down')
    await shot('t01b-faucet-cooldown')
    await sheet.locator('.icon-btn[aria-label="Close"]').click()
  })
  await step('mainnet holdings card in testnet mode: no network switch, testnet wallet stays connected', async () => {
    await go('#/explore')
    await page.getByRole('button', { name: 'Connect wallet (read-only)' }).click()
    await page.locator('dd', { hasText: 'Your wallet stays on testnet' }).waitFor({ timeout: 30_000 })
    if (await page.getByRole('button', { name: 'Switch to Robinhood Chain' }).count()) throw new Error('testnet mode must not offer a switch to mainnet')
    const label = await page.locator('.wallet-btn b').innerText()
    if (label === 'Connect') throw new Error('testnet wallet was disconnected')
  })
  await step('Class B TEST token: Diamond disabled; lock Committed 60 days', async () => {
    await go('#/lock')
    await page.locator('.seg button', { hasText: 'tMEMEB' }).click()
    if (!(await page.getByRole('radio', { name: /Diamond/ }).isDisabled())) throw new Error('Diamond must be disabled for Class B')
    await page.locator('.notice', { hasText: 'Testnet listing · TEST token' }).waitFor()
    await page.getByRole('radio', { name: /Committed/ }).click()
    await page.locator('.chip', { hasText: '5 units' }).click()
    await page.locator('.chip', { hasText: '60 days' }).click()
    await page.getByRole('button', { name: 'Lock tMEMEB' }).click()
    await receipt('Locked 5,000 tMEMEB')
    await shot('t02-locked')
  })
  await step('rewards accrue on testnet (time moved on the local chain) and are claimed', async () => {
    await rpcCall('evm_increaseTime', [2 * 86400]); await rpcCall('evm_mine')
    await go('#/portfolio')
    await page.reload()
    const claimAll = page.getByRole('button', { name: /^Claim all / })
    await claimAll.waitFor({ timeout: 60_000 })
    await claimAll.click()
    await receipt('Claimed')
  })
  await step('early exit with the quoted fee', async () => {
    await page.locator('.lock-row', { hasText: 'tMEMEB' }).getByRole('button', { name: 'Exit early' }).click()
    await page.getByRole('button', { name: 'Confirm exit' }).click()
    await receipt('Exited position')
    await page.locator('.lock-row', { hasText: '5,000 tMEMEB' }).locator('strong', { hasText: 'Closed' }).waitFor({ timeout: 30_000 })
    await shot('t03-portfolio')
  })
  await step('after the cooldown (time moved on the local chain), one token can be claimed on its own', async () => {
    await page.locator('.tabbar button', { hasText: 'Wallet' }).click()
    const sheet = page.locator('.sheet')
    await sheet.getByRole('button', { name: 'Get tMEMEA', exact: true }).click({ timeout: 30_000 })
    await sheet.locator('.receipt', { hasText: 'Received TEST tMEMEA' }).waitFor({ timeout: 60_000 })
    await sheet.locator('dd', { hasText: 'Next at' }).first().waitFor({ timeout: 30_000 })
    if (!(await sheet.getByRole('button', { name: 'Get tMEMEB', exact: true }).count())) throw new Error('tMEMEB faucet should still be available')
    await sheet.locator('.icon-btn[aria-label="Close"]').click()
  })
  await step('activity shows 6-decimal amounts correctly', async () => {
    await go('#/activity')
    await page.locator('.feed li', { hasText: 'locked tMEMEB' }).locator('strong', { hasText: '5,000 tMEMEB' }).first().waitFor({ timeout: 30_000 })
  })
  await step('switch back to Simulation cleanly (wallet not carried over)', async () => {
    await page.locator('.demo-strip .seg button', { hasText: 'Simulation' }).click()
    await page.locator('.demo-strip', { hasText: 'Not live Robinhood Chain' }).waitFor({ timeout: 120_000 })
    await page.locator('.wallet-btn small', { hasText: 'Simulation' }).waitFor()
    const label = await page.locator('.wallet-btn b').innerText()
    if (label.toLowerCase().includes(tester.slice(2, 6).toLowerCase())) throw new Error('testnet wallet leaked into the simulation')
    await shot('t04-back-to-simulation')
  })
} catch { /* reported below */ } finally {
  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(JSON.stringify({ passed: results.length - failed, failed, pageErrors: errors }, null, 1))
  process.exit(failed || errors.length ? 1 : 0)
}
