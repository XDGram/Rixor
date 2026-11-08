// LIVE MARKET DATA, DISPLAY ONLY.
// Reads the real $WIF price from Robinhood Chain mainnet via public JSON-RPC (read-only).
// This module is never used by the vault, ROI eligibility or challenge results.
import { AbiCoder, Interface, keccak256, toBeHex } from 'ethers'
import { ETH_USDG_V3_POOL, MAINNET_RPC, PONS_WIF_ETH_POOL, WIF } from './sources'
import { meanTick, percentChange, priceFromSqrtX96, priceFromTick } from './math'

export type LiveWifPrice = {
  wifUsd: number
  wifEth: number
  ethUsd: number
  /** 24h change of the USD price, or null when a 24h reference could not be read onchain. */
  change24hUsd: number | null
  /** 24h change of the WIF/ETH price (market move excluding ETH/USD). */
  change24hEth: number | null
  /** ETH in range at the current price (L / sqrtP). Approximates full-range pool depth. */
  inRangeEth: number
  blockNumber: number
  blockTime: number
  reference24h: { wifEth: number; ethUsd: number; swapBlock: number } | null
}

const coder = AbiCoder.defaultAbiCoder()
const pmIface = new Interface([
  'function extsload(bytes32 slot) view returns (bytes32)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
])
const v3Iface = new Interface(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])

let rpcId = 0
const rpc = async <T,>(method: string, params: unknown[], rpcUrl = MAINNET_RPC): Promise<T> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  if (!response.ok) throw new Error(`Robinhood Chain RPC error ${response.status}`)
  const payload = await response.json() as { result?: T; error?: { message?: string } }
  if (payload.error) throw new Error(payload.error.message || 'Robinhood Chain RPC error')
  return payload.result as T
}

type Block = { number: string; timestamp: string }
/** JSON-RPC quantities must not have leading zeros. */
const qty = (value: number) => `0x${value.toString(16)}`
const getBlock = (tag: string) => rpc<Block>('eth_getBlockByNumber', [tag, false])

/** Recomputes the V4 pool id from its key; refuses to read prices if it does not match. */
export const verifyPoolId = () => {
  const { key, poolId } = PONS_WIF_ETH_POOL
  const computed = keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]))
  if (computed.toLowerCase() !== poolId.toLowerCase()) throw new Error('Pool id does not match the declared Pons WIF/ETH pool key.')
  return computed
}

const extsload = async (slot: bigint, blockTag: string) => {
  const data = pmIface.encodeFunctionData('extsload', [toBeHex(slot, 32)])
  const result = await rpc<string>('eth_call', [{ to: PONS_WIF_ETH_POOL.poolManager, data }, blockTag])
  return BigInt(pmIface.decodeFunctionResult('extsload', result)[0] as string)
}

/** ETH/USD as the mean price over [secondsAgoStart, secondsAgoEnd] from the V3 pool's own observations. */
const ethUsdTwap = async (secondsAgoStart: number, secondsAgoEnd: number, blockTag: string) => {
  const data = v3Iface.encodeFunctionData('observe', [[secondsAgoStart, secondsAgoEnd]])
  const result = await rpc<string>('eth_call', [{ to: ETH_USDG_V3_POOL.address, data }, blockTag])
  const [ticks] = v3Iface.decodeFunctionResult('observe', result) as unknown as [bigint[]]
  const tick = meanTick(ticks[0], ticks[1], secondsAgoStart - secondsAgoEnd)
  return priceFromTick(tick, ETH_USDG_V3_POOL.token0.decimals, ETH_USDG_V3_POOL.token1.decimals)
}

/** Finds a block close to `targetTime` using the observed block rate (two refinements). */
const blockNear = async (targetTime: number, head: number, headTime: number) => {
  const sample = await getBlock(qty(head - 1_000_000))
  const rate = 1_000_000 / (headTime - Number.parseInt(sample.timestamp, 16))
  let guess = Math.max(1, Math.round(head - (headTime - targetTime) * rate))
  for (let i = 0; i < 2; i += 1) {
    const block = await getBlock(qty(guess))
    guess = Math.max(1, Math.round(guess + (targetTime - Number.parseInt(block.timestamp, 16)) * rate))
  }
  return { block: guess, rate }
}

export const readLiveWifPrice = async (): Promise<LiveWifPrice> => {
  verifyPoolId()
  // Read ~2s behind the head: the public RPC is load-balanced and the newest block may not
  // have reached every node yet. All reads use this one block for a consistent snapshot.
  const latest = Number.parseInt((await getBlock('latest')).number, 16)
  const pinned = await getBlock(qty(latest - 20))
  const blockNumber = Number.parseInt(pinned.number, 16)
  const blockTime = Number.parseInt(pinned.timestamp, 16)
  const tag = qty(blockNumber)

  const poolSlot = BigInt(keccak256(coder.encode(['bytes32', 'uint256'], [PONS_WIF_ETH_POOL.poolId, PONS_WIF_ETH_POOL.poolsSlot])))
  const [slot0, liquidityWord, ethUsd] = await Promise.all([
    extsload(poolSlot, tag),
    extsload(poolSlot + 3n, tag),
    ethUsdTwap(ETH_USDG_V3_POOL.twapSeconds, 0, tag),
  ])
  const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n)
  const liquidity = liquidityWord & ((1n << 128n) - 1n)
  if (sqrtPriceX96 === 0n || liquidity === 0n) throw new Error('The Pons WIF/ETH pool has no active liquidity.')

  // currency0 = ETH, currency1 = WIF, so the pool price is WIF per ETH.
  const wifPerEth = priceFromSqrtX96(sqrtPriceX96, 18, WIF.decimals)
  const wifEth = 1 / wifPerEth
  const inRangeEth = Number(liquidity) / (Number(sqrtPriceX96) / 2 ** 96) / 1e18

  // 24h reference: the pool price after the last swap before now-24h, and the ETH/USD TWAP
  // over the same-length window ending 24h ago. Both are onchain history, not estimates.
  let reference24h: LiveWifPrice['reference24h'] = null
  try {
    const { block: block24, rate } = await blockNear(blockTime - 86_400, blockNumber, blockTime)
    const lookback = Math.round(rate * 1_800)
    const swaps = await rpc<Array<{ data: string; topics: string[]; blockNumber: string }>>('eth_getLogs', [{
      address: PONS_WIF_ETH_POOL.poolManager,
      topics: [pmIface.getEvent('Swap')!.topicHash, PONS_WIF_ETH_POOL.poolId],
      fromBlock: qty(Math.max(1, block24 - lookback)),
      toBlock: qty(block24),
    }])
    const last = swaps.at(-1)
    if (last) {
      const parsed = pmIface.parseLog({ data: last.data, topics: last.topics })!
      const pastWifEth = 1 / priceFromSqrtX96(parsed.args.sqrtPriceX96 as bigint, 18, WIF.decimals)
      const pastEthUsd = await ethUsdTwap(86_400 + ETH_USDG_V3_POOL.twapSeconds, 86_400, tag)
      reference24h = { wifEth: pastWifEth, ethUsd: pastEthUsd, swapBlock: Number.parseInt(last.blockNumber, 16) }
    }
  } catch {
    reference24h = null
  }

  const wifUsd = wifEth * ethUsd
  return {
    wifUsd,
    wifEth,
    ethUsd,
    change24hUsd: reference24h ? percentChange(reference24h.wifEth * reference24h.ethUsd, wifUsd) : null,
    change24hEth: reference24h ? percentChange(reference24h.wifEth, wifEth) : null,
    inRangeEth,
    blockNumber,
    blockTime,
    reference24h,
  }
}
