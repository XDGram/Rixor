// Pure price math shared by the live display and the ROI design. No I/O.

/** token1 per token0, adjusted for decimals, from a Uniswap sqrtPriceX96. */
export const priceFromSqrtX96 = (sqrtPriceX96: bigint, decimals0: number, decimals1: number) => {
  const ratio = Number(sqrtPriceX96) / 2 ** 96
  return ratio * ratio * 10 ** (decimals0 - decimals1)
}

/** token1 per token0, adjusted for decimals, from a Uniswap tick (e.g. a TWAP mean tick). */
export const priceFromTick = (tick: number, decimals0: number, decimals1: number) =>
  1.0001 ** tick * 10 ** (decimals0 - decimals1)

/** Arithmetic-mean tick between two Uniswap V3 tickCumulatives. */
export const meanTick = (tickCumulativeOlder: bigint, tickCumulativeNewer: bigint, seconds: number) =>
  Number(tickCumulativeNewer - tickCumulativeOlder) / seconds

export const percentChange = (from: number, to: number) => (from > 0 ? ((to - from) / from) * 100 : null)

export type UsdRoi = {
  entryUsd: number
  currentUsd: number
  /** Dollar return the user actually experienced. This is the user-facing ROI. */
  roiPercent: number
  /** What ROI would read if measured in ETH, ignoring ETH/USD movement. Never shown as ROI. */
  roiPercentInEth: number
  /** Part of the dollar return explained by ETH/USD moving (multiplicative decomposition). */
  ethUsdEffectPercent: number
}

/**
 * User-facing ROI in USD. Both legs are captured at entry and at measurement, so a move in
 * ETH/USD is reflected exactly as it changes the dollar value of the position, instead of
 * being hidden (ETH-terms ROI) or double counted.
 */
export const usdRoi = (entry: { wifEth: number; ethUsd: number }, now: { wifEth: number; ethUsd: number }): UsdRoi => {
  const entryUsd = entry.wifEth * entry.ethUsd
  const currentUsd = now.wifEth * now.ethUsd
  return {
    entryUsd,
    currentUsd,
    roiPercent: (currentUsd / entryUsd - 1) * 100,
    roiPercentInEth: (now.wifEth / entry.wifEth - 1) * 100,
    ethUsdEffectPercent: (now.ethUsd / entry.ethUsd - 1) * 100,
  }
}

/** Formats a small USD price with enough significant digits (e.g. $0.001392). */
export const formatUsdPrice = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value >= 1) return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  return `$${value.toPrecision(4)}`
}
