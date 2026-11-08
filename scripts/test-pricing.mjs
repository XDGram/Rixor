// Unit tests for src/pricing/math.ts, plus an optional read-only live check of the mainnet
// price reader (npm run check:live-price). The live check never sends transactions.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rixor-pricing-'))
const bundle = async (entry) => {
  const outfile = path.join(outDir, `${path.basename(entry, '.ts')}.mjs`)
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const math = await bundle('src/pricing/math.ts')
const close = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`)

// Price conversions.
close(math.priceFromSqrtX96(2n ** 96n, 18, 18), 1, 1e-12, 'sqrt price 1:1')
close(math.priceFromSqrtX96(2n ** 97n, 18, 18), 4, 1e-12, 'sqrt price doubles -> price x4')
close(math.priceFromTick(0, 18, 6), 1e12, 1e-3, 'tick 0 with 18/6 decimals')
close(math.priceFromTick(-199_207.5, 18, 6), 2233.4, 1, 'WETH/USDG tick -> ~$2233')
close(math.meanTick(1_000n, 4_600n, 1_800), 2, 1e-12, 'mean tick from cumulatives')
assert.equal(math.percentChange(0, 1), null, 'no change from a zero base')
close(math.percentChange(2, 3), 50, 1e-12, 'percent change')

// USD ROI: ETH/USD movement must be reflected in dollars, not hidden or doubled.
let roi = math.usdRoi({ wifEth: 1e-6, ethUsd: 2000 }, { wifEth: 1e-6, ethUsd: 2200 })
close(roi.roiPercent, 10, 1e-9, 'flat WIF/ETH, ETH +10% -> +10% in USD')
close(roi.roiPercentInEth, 0, 1e-9, 'ETH-terms ROI would wrongly show 0%')
roi = math.usdRoi({ wifEth: 1e-6, ethUsd: 2000 }, { wifEth: 1.25e-6, ethUsd: 1600 })
close(roi.roiPercent, 0, 1e-9, 'WIF/ETH +25% while ETH -20% -> 0% in USD')
close(roi.roiPercentInEth, 25, 1e-9, 'ETH-terms ROI would overstate at +25%')
close((1 + roi.roiPercentInEth / 100) * (1 + roi.ethUsdEffectPercent / 100), 1 + roi.roiPercent / 100, 1e-12, 'decomposition multiplies out')
roi = math.usdRoi({ wifEth: 6.234e-7, ethUsd: 2233.55 }, { wifEth: 6.234e-7 * 1.5, ethUsd: 2233.55 })
close(roi.entryUsd, 0.0013924, 1e-6, 'entry USD price')
close(roi.roiPercent, 50, 1e-9, 'pure WIF move with stable ETH')

assert.equal(math.formatUsdPrice(null), '—')
assert.equal(math.formatUsdPrice(0.00139247), '$0.001392')
console.log('Pricing math tests passed.')

if (process.argv.includes('--live')) {
  const live = await bundle('src/pricing/livePrice.ts')
  const { Contract, JsonRpcProvider } = await import('ethers')
  live.verifyPoolId()
  const price = await live.readLiveWifPrice()
  console.log(JSON.stringify(price, null, 2))
  assert.ok(price.wifEth > 0 && price.ethUsd > 0 && price.wifUsd > 0, 'live prices are positive')
  assert.ok(price.inRangeEth > 0, 'pool has active liquidity')

  // Independent cross-checks (validation only, not price sources):
  const provider = new JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true })
  const slot0 = ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)']
  // ETH/USD spot from the same V3 pool vs its 30-minute TWAP.
  const [ethSqrt] = await new Contract('0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca', slot0, provider).slot0()
  const ethSpot = math.priceFromSqrtX96(ethSqrt, 18, 6)
  const ethGap = Math.abs(ethSpot / price.ethUsd - 1) * 100
  console.log(`ETH/USD spot ${ethSpot.toFixed(2)} vs 30-min TWAP ${price.ethUsd.toFixed(2)} (${ethGap.toFixed(2)}% apart)`)
  assert.ok(ethGap < 5, 'ETH/USD spot and TWAP agree within 5%')
  // A separate WETH/WIF pool on another DEX (thin, so only a loose sanity bound).
  // This fork's slot0 has a different struct, so read only its first word (sqrtPriceX96).
  const forkRaw = await provider.call({ to: '0xb0c724e6c234a08add4b7697138f667c97dee5aa', data: '0x3850c7bd' })
  const forkSqrt = BigInt(forkRaw.slice(0, 66))
  const forkWifEth = 1 / math.priceFromSqrtX96(forkSqrt, 18, 18)
  const wifGap = Math.abs(forkWifEth / price.wifEth - 1) * 100
  console.log(`WIF/ETH Pons ${price.wifEth.toExponential(4)} vs other DEX ${forkWifEth.toExponential(4)} (${wifGap.toFixed(2)}% apart)`)
  assert.ok(wifGap < 25, 'independent WIF/ETH venue within 25%')
  console.log('Live price check passed (read-only).')
}

fs.rmSync(outDir, { recursive: true, force: true })
