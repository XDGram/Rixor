#!/usr/bin/env node
// End-to-end journey through the real UI in a mobile browser (iPhone 13 emulation).
//   node demo/e2e/journey.mjs <appUrl> [screenshotDir]
//   THROTTLE=4 node demo/e2e/journey.mjs ...   # emulate a slower phone CPU (Chrome DevTools throttling)
//   PRELOAD_URL=<vercel share link> ...        # visit first to pass Vercel preview protection
// Every step clicks the interface a reviewer would use; the assertions read what the UI shows after the
// transactions execute in the isolated in-browser EVM. No step talks to a real network.
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

  await step('create demo wallet and get demo WIF from the faucet', async () => {
    await openWallet()
    await page.getByRole('button', { name: 'Create demo wallet' }).click()
    await page.locator('.sheet', { hasText: 'Simulated balances, not real ones' }).waitFor()
    await page.locator('.sheet button', { hasText: 'demo WIF' }).click()
    await page.locator('.notice', { hasText: 'Added' }).waitFor({ timeout: 30_000 })
    await shot('02-wallet-funded')
    await closeSheet()
  })

  await step('lock 10 units of WIF as Diamond for 90 days', async () => {
    await go('#/lock')
    await page.getByRole('radio', { name: /Diamond/ }).click()
    await page.locator('.chip', { hasText: '10 units' }).click()
    await page.locator('.chip', { hasText: '90 days' }).click()
    await page.locator('.rows', { hasText: '10 units' }).waitFor()
    await shot('03-lock-form')
    await page.getByRole('button', { name: 'Lock WIF' }).click()
    await receipt('Locked')
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
    await page.locator('.lock-row', { hasText: '75,000 WIF' }).waitFor({ timeout: 30_000 })
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

  await step('exit the Diamond position after its term', async () => {
    await advance('+31d')
    await advance('+31d')
    await go('#/portfolio')
    await page.locator('.lock-row').first().getByRole('button', { name: 'Exit', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm exit' }).click()
    await receipt('Exited position')
    await shot('08-portfolio')
  })

  await step('activity feed shows the journey', async () => {
    await go('#/activity')
    await page.locator('.seg button', { hasText: 'Mine' }).click()
    for (const t of ['You locked', 'You joined', 'You sponsored', 'You claimed', 'Refund paid to you', 'Unclaimed share returned to you', 'You exited']) {
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
