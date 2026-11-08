#!/usr/bin/env node
// End-to-end journey through the real UI in a mobile browser (iPhone 13 emulation).
//   node demo/e2e/journey.mjs <appUrl> [screenshotDir]
//   THROTTLE=4 node demo/e2e/journey.mjs ...   # emulate a slower phone CPU (Chrome DevTools throttling)
//   PRELOAD_URL=<vercel share link> ...        # visit first to pass Vercel preview protection
// Every step clicks the interface a reviewer would use; the assertions read what the UI shows after the
// transactions execute in the isolated in-browser EVM. The only network reads are the read-only wallet-detection
// calls to the public Robinhood Chain RPC; no step sends a transaction anywhere.
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium, devices } = require('playwright')

const [appUrl, shotDir = './demo-e2e-shots'] = process.argv.slice(2)
if (!appUrl) {
  console.error('usage: node demo/e2e/journey.mjs <appUrl> [screenshotDir]')
  process.exit(1)
}
mkdirSync(shotDir, { recursive: true })

const log = (m) => console.log(`[e2e] ${m}`)
const results = []
const step = async (name, fn) => {
  const t = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - t })
    log(`PASS ${name}`)
  } catch (e) {
    results.push({ name, ok: false, error: String(e.message).split('\n')[0] })
    log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`)
    throw e
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 13'] })
// Test-only EIP-1193 stub for the read-only detection step: it shares a public address (a large HOOKR holder,
// also used as a faucet reserve in the simulation) and refuses everything else. It holds no key and signs nothing.
const DETECT_ADDRESS = '0xA522e716e1750702F775416f2Aa3Df620D9A1831'
await context.addInitScript((addr) => {
  const provider = {
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr]
      if (method === 'eth_chainId') return '0x1237'
      throw Object.assign(new Error('not supported by the e2e stub'), { code: 4200 })
    },
  }
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'e2e-stub', name: 'E2E read-only stub', icon: '', rdns: 'test.e2e' }, provider }) }))
  window.addEventListener('eip6963:requestProvider', announce)
}, DETECT_ADDRESS)
const page = await context.newPage()
const throttle = Number(process.env.THROTTLE || 1)
if (throttle > 1) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
}
const metrics = {}
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

const shot = (name) => page.screenshot({ path: join(shotDir, `${name}.png`), fullPage: true })
const go = async (hash) => { await page.evaluate((h) => { window.location.hash = h }, hash); await page.waitForTimeout(400) }
const receipt = (text) => page.locator('.receipt', { hasText: text }).first().waitFor({ timeout: 60_000 })
const openWallet = async () => { await page.locator('.tabbar button', { hasText: 'Wallet' }).click(); await page.locator('.sheet').waitFor() }
const closeSheet = async () => { await page.locator('.sheet .icon-btn[aria-label="Close"]').click() }
const advance = async (label) => {
  await openWallet()
  await page.locator('.sheet .chip', { hasText: label }).click()
  await page.locator('.notice', { hasText: 'Simulation time moved forward' }).waitFor({ timeout: 30_000 })
  await closeSheet()
}

try {
  await step('open app: isolated browser EVM boots from the snapshot', async () => {
    // Optional: a Vercel share link for a protected preview. Visiting it sets the access cookie.
    if (process.env.PRELOAD_URL) await page.goto(process.env.PRELOAD_URL)
    const t0 = Date.now()
    await page.goto(`${appUrl}/`)
    await page.locator('.demo-strip', { hasText: 'Not live Robinhood Chain' }).waitFor({ timeout: 120_000 })
    await page.locator('.challenge-link').first().waitFor({ timeout: 60_000 })
    metrics.firstVisitBootMs = Date.now() - t0
    await shot('01-explore')
  })

  await step('real wallet (read-only): detect Robinhood Chain holdings, HOOKR under review, nothing supported', async () => {
    await page.getByRole('button', { name: 'Connect wallet (read-only)' }).click()
    const card = page.locator('.card', { hasText: 'Meme tokens you hold on Robinhood Chain' })
    await card.locator('.kicker', { hasText: 'Under review' }).waitFor({ timeout: 60_000 })
    await card.locator('.token-line', { hasText: 'HOOKR' }).locator('.tag', { hasText: 'Under review' }).waitFor({ timeout: 30_000 })
    await card.locator('.fine-print', { hasText: 'None yet: no Rixor Locker is deployed on Robinhood Chain.' }).waitFor()
    if (await card.locator('.tag', { hasText: /^Supported$/ }).count()) throw new Error('a token was shown as supported without an on-chain listing')
    await shot('01b-detected-holdings')
  })

  await step('create demo wallet and get demo tokens from the faucet', async () => {
    await openWallet()
    await page.getByRole('button', { name: 'Create demo wallet' }).click()
    await page.locator('.sheet', { hasText: 'Simulated balances, not real ones' }).waitFor()
    await page.locator('.sheet button', { hasText: 'Get demo' }).click()
    await page.locator('.notice', { hasText: 'Added' }).waitFor({ timeout: 30_000 })
    await shot('02-wallet-funded')
    await closeSheet()
  })

  await step('lock 10 units of HOOKR (Class A) as Diamond for 90 days, no WIF needed', async () => {
    await go('#/lock')
    await page.locator('.seg button', { hasText: 'HOOKR' }).click()
    await page.getByRole('radio', { name: /Diamond/ }).click()
    await page.locator('.chip', { hasText: '10 units' }).click()
    await page.locator('.chip', { hasText: '90 days' }).click()
    await page.locator('.rows', { hasText: '10 units' }).waitFor()
    await shot('03-lock-form')
    await page.getByRole('button', { name: 'Lock HOOKR' }).click()
    await receipt('Locked 100,000 HOOKR')
  })

  await step('TORCH (Class B): Diamond unavailable, lock Committed for 60 days', async () => {
    await page.locator('.seg button', { hasText: 'TORCH' }).click()
    const diamond = page.getByRole('radio', { name: /Diamond/ })
    if (!(await diamond.isDisabled())) throw new Error('Diamond should be disabled for a Class B token')
    await page.getByRole('radio', { name: /Committed/ }).click()
    if (await page.locator('.chip', { hasText: '90 days' }).count()) throw new Error('Class B must not offer a 90-day term')
    await page.locator('.chip', { hasText: '5 units' }).click()
    await page.locator('.chip', { hasText: '60 days' }).click()
    await shot('03b-lock-torch')
    await page.getByRole('button', { name: 'Lock TORCH' }).click()
    await receipt('Locked 50,000 TORCH')
  })

  await step('create a community challenge (1h join, minimum hold)', async () => {
    await go('#/create')
    await page.locator('.field', { hasText: 'Title' }).locator('input').fill('E2E: hold through the hour')
    await page.locator('.commit-field', { hasText: 'Join window' }).getByRole('button', { name: '1h', exact: true }).click()
    await page.locator('.commit-field', { hasText: 'Holding period' }).getByRole('button', { name: /\(min\)/ }).click()
    await shot('04-create-form')
    await page.getByRole('button', { name: /Create and escrow/ }).click()
    await receipt('Challenge created')
    await page.getByRole('button', { name: 'Open the new challenge' }).click()
    await page.locator('.challenge-card h3', { hasText: 'E2E: hold through the hour' }).waitFor()
  })

  await step('join the challenge with the Diamond position', async () => {
    await page.locator('.choice:not([disabled])').first().click()
    await page.getByRole('button', { name: 'Join challenge' }).click()
    await receipt('Joined')
    await page.locator('.board li.is-me').waitFor({ timeout: 30_000 })
  })

  await step('sponsor the challenge with 20,000 WIF', async () => {
    await page.getByLabel('Sponsorship amount').fill('20000')
    await page.getByRole('button', { name: 'Sponsor', exact: true }).click()
    await receipt('Added 20,000 WIF')
    await page.locator('.board', { hasText: 'You' }).last().waitFor()
    await shot('05-challenge-joined-sponsored')
  })

  await step('advance demo time past the end and settle', async () => {
    await advance('+1d')
    await page.getByRole('button', { name: 'Settle challenge' }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Settle challenge' }).click()
    await receipt('Challenge settled')
  })

  await step('claim the reward', async () => {
    const claim = page.getByRole('button', { name: /^Claim / })
    await claim.waitFor({ timeout: 30_000 })
    await claim.click()
    await receipt('Claimed')
    await shot('06-claimed')
  })

  await step('reload: state persists in IndexedDB and is re-executed', async () => {
    const t0 = Date.now()
    await page.reload()
    await page.locator('.demo-strip').waitFor({ timeout: 120_000 })
    metrics.reloadReplayMs = Date.now() - t0
    await go('#/portfolio')
    await page.locator('.lock-row', { hasText: '100,000 HOOKR' }).waitFor({ timeout: 30_000 })
    await page.locator('.lock-row', { hasText: '50,000 TORCH' }).waitFor({ timeout: 30_000 })
    await go('#/activity')
    await page.locator('.seg button', { hasText: 'Mine' }).click()
    await page.locator('.feed li', { hasText: 'You claimed' }).first().waitFor({ timeout: 15_000 })
  })

  await step('create a challenge with an unreachable goal and join it', async () => {
    await go('#/create')
    await page.locator('.field', { hasText: 'Title' }).locator('input').fill('E2E: refund path')
    await page.locator('.commit-field', { hasText: 'Join window' }).getByRole('button', { name: '1h', exact: true }).click()
    await page.locator('.commit-field', { hasText: 'Holding period' }).getByRole('button', { name: /\(min\)/ }).click()
    await page.locator('.commit-field', { hasText: 'Collective goal' }).locator('.chip').last().click()
    await page.getByRole('button', { name: /Create and escrow/ }).click()
    await receipt('Challenge created')
    await page.getByRole('button', { name: 'Open the new challenge' }).click()
    await page.locator('.choice:not([disabled])').first().click()
    await page.getByRole('button', { name: 'Join challenge' }).click()
    await receipt('Joined')
  })

  await step('settle the failed challenge and refund the sponsor', async () => {
    await advance('+1d')
    await page.getByRole('button', { name: 'Settle challenge' }).click()
    await receipt('Challenge settled')
    const refund = page.getByRole('button', { name: /Refund my/ })
    await refund.waitFor({ timeout: 30_000 })
    await refund.click()
    await receipt('Refunded')
    await shot('07-refunded')
  })

  await step('after the claim window, return the unclaimed share (sweep)', async () => {
    await advance('+31d')
    await go('#/explore')
    await page.locator('.seg button', { hasText: 'Mine' }).click()
    await page.locator('.challenge-link', { hasText: 'E2E: hold through the hour' }).click()
    const sweep = page.getByRole('button', { name: /Return my unclaimed share/ })
    await sweep.waitFor({ timeout: 30_000 })
    await sweep.click()
    await receipt('Unclaimed share returned')
  })

  await step('claim WIF stream rewards for both positions', async () => {
    await go('#/portfolio')
    const claimAll = page.getByRole('button', { name: /^Claim all / })
    await claimAll.waitFor({ timeout: 30_000 })
    await claimAll.click()
    await receipt('Claimed')
    await shot('07b-rewards-claimed')
  })

  await step('exit both positions after their terms (no fee, exact principal)', async () => {
    await advance('+31d')
    await advance('+31d')
    await go('#/portfolio')
    for (let i = 0; i < 2; i++) {
      await page.locator('.lock-row', { has: page.getByRole('button', { name: 'Exit', exact: true }) }).first().getByRole('button', { name: 'Exit', exact: true }).click()
      await page.getByRole('button', { name: 'Confirm exit' }).click()
      await receipt('Exited position')
    }
    await page.locator('.lock-row', { hasText: '100,000 HOOKR' }).locator('strong', { hasText: 'Closed' }).waitFor({ timeout: 30_000 })
    await page.locator('.lock-row', { hasText: '50,000 TORCH' }).locator('strong', { hasText: 'Closed' }).waitFor({ timeout: 30_000 })
    await shot('08-portfolio')
  })

  await step('activity feed shows the journey', async () => {
    await go('#/activity')
    await page.locator('.seg button', { hasText: 'Mine' }).click()
    for (const t of ['You locked HOOKR', 'You locked TORCH', 'You joined', 'You sponsored', 'You claimed', 'You claimed stream rewards', 'Refund paid to you', 'Unclaimed share returned to you', 'You exited']) {
      await page.locator('.feed li', { hasText: t }).first().waitFor({ timeout: 15_000 })
    }
    await shot('09-activity')
  })
} catch {
  // reported below
} finally {
  await shot('zz-final').catch(() => {})
  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, cpuThrottle: throttle, metrics, pageErrors: errors, results }, null, 2))
  process.exit(failed.length || errors.length ? 1 : 0)
}
