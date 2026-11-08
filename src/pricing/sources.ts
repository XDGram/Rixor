// Exact onchain price sources for the LIVE MARKET DATA display. All on Robinhood Chain
// mainnet (4663), read-only. Verified in the pricing research (see docs/ORACLE_DESIGN.md).
// DISPLAY ONLY: nothing here feeds the vault, ROI eligibility or challenge results.

export const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com'
export const MAINNET_EXPLORER = 'https://robin.etherscan.io'

/** World Is Flat ($WIF). */
export const WIF = { address: '0x5173b8eA6923c2d40267890D45C46a3480954773', decimals: 18 } as const

/**
 * WIF/ETH: Pons V2 pool on the official Uniswap V4 PoolManager.
 * The pool id is recomputed from this key at runtime and must match, so a wrong id is caught.
 */
export const PONS_WIF_ETH_POOL = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  poolId: '0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79',
  key: {
    currency0: '0x0000000000000000000000000000000000000000', // native ETH
    currency1: WIF.address,
    fee: 0,
    tickSpacing: 200,
    hooks: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044', // PonsV2MemeHook
  },
  /** Uniswap V4 PoolManager storage slot of the `_pools` mapping. */
  poolsSlot: 6n,
} as const

/**
 * ETH/USD: official Uniswap V3 WETH/USDG 0.01% pool (factory 0x1f7d…2EfA). Read through its
 * native observe() TWAP. USDG (Global Dollar) is treated as $1; that peg is an assumption.
 */
export const ETH_USDG_V3_POOL = {
  address: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca',
  token0: { symbol: 'WETH', decimals: 18 },
  token1: { symbol: 'USDG', decimals: 6 },
  twapSeconds: 1_800,
} as const
