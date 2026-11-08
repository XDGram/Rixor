# RixorWifOracle: design (not implemented)

Status: **design only.** No oracle is built, deployed or wired to the vault. The app's live $WIF price is **display only** and never reaches the vault, ROI eligibility or challenge results.

## 1. Verified market facts (Robinhood Chain mainnet, 4663, read-only)

| Item | Value |
| --- | --- |
| $WIF | `0x5173b8eA6923c2d40267890D45C46a3480954773`, 18 decimals, burnable, no owner or mint |
| Main WIF market | Pons V2 pool on the official Uniswap V4 PoolManager `0x8366…0951`, pool id `0x71ef…8c79`, key (ETH, WIF, fee 0, tickSpacing 200, hook `0xE5e7…e044`). The id is recomputed from the key at runtime. |
| Depth | Full-range, ~23.1 ETH per side (~$103k total), a single locked LP position |
| Activity | ~2,150 swaps per day, ~51 ETH per day; heavily bot-driven (sample: 14 tx senders, top 5 ≈ 63%) |
| Native price history | **None.** V4 core has no oracle and the Pons hook exposes no `observe` |
| Other WIF pools | V3-fork WETH/WIF `0xb0c7…` (0.43 WETH, has `observe`, cardinality 1); official Uniswap V3 WETH/WIF `0x1560…` (**0 liquidity**); the rest are empty or junk |
| ETH/USD | Official Uniswap V3 WETH/USDG 0.01% `0x52e6…71Ca`: ~3,680 WETH + 2.24M USDG, **10,816 native observations (~39h)**; 30-minute and 24-hour `observe()` verified |
| Chainlink WIF feed | None found. Robinhood's docs list feeds for "a selected subset of assets"; unlisted assets go through Robinhood's developer contact |

## 2. Requirement: real historical observations

A secure TWAP needs a price accumulator written **by the pool, on every block that trades**, like Uniswap V3's `tickCumulative`. An external contract that samples spot prices when someone calls it is not equivalent. It only sees the instant it is called, so an attacker who controls the price at those instants controls the "TWAP".

Ways to get real observations for $WIF, in order of preference:

1. **An established oracle feed** (Chainlink, or another provider with an L2 sequencer-uptime check) for WIF/USD or WIF/ETH. This is independent of Rixor and the strongest option, but it requires the provider to list WIF.
2. **An oracle-capable pool holding real liquidity:**
   - the official Uniswap V3 WETH/WIF pool, using `increaseObservationCardinalityNext`; or
   - a Uniswap V4 WETH/WIF pool with an oracle hook that records cumulative ticks in `afterSwap`/`beforeSwap`.

   Neither works until meaningful liquidity lives there (today the V3 pool is empty). The Pons pool's hook is fixed at creation and cannot gain an oracle.
3. **Keeper-sampled observations of the Pons pool.** These are acceptable only as a **secondary validation signal**, never as the sole authority. Sampling helps detect manipulation (deviation checks) but does not resist it on its own.

**Conclusion:** there is no WIF source today that meets the bar for contract decisions. The design below is ready for option 1 or 2 once one exists.

## 3. Oracle parameters

| Check | Proposed rule | Basis |
| --- | --- | --- |
| TWAP window | ≥ 30 minutes for both WIF and ETH legs | ~17k blocks at ~0.1s; ~45 Pons swaps per 30 min today |
| Observation capacity | Cardinality ≥ 2× the observations written per window (≥ 200 for a WIF V3 pool at today's activity) | Must cover the window with margin |
| Liquidity floor | Spot in-range liquidity ≥ 15 ETH per side, **and** harmonic-mean liquidity over the window (V3 `secondsPerLiquidityCumulative`) ≥ the same | Current depth is 23.1 ETH; the harmonic mean resists flash adds |
| Freshness | Source updated within the window; Chainlink: within heartbeat and L2 sequencer up for ≥ 1 hour | Stale data pauses decisions |
| Spot vs TWAP | Price decisions pause if they differ by more than 5% | Observed: ETH spot/TWAP 0.08%; WIF max intra-block move 0.11%; WIF 24h range ~12% |
| Independent validation | Primary vs secondary venue within 10%, otherwise pause | Live check today: Pons vs V3-fork pool 0.33% apart |
| Exposure cap | Value of price-triggered positions ≤ ~10% of pool depth | Keeps any gain from gaming a trigger (at most the avoided fee) below the cost of manipulation |
| USDG peg | ETH/USD leg validated against an independent ETH/USD feed if available; pause if more than 2% apart | USDG is assumed to be $1 |

## 4. Interface (fits the existing vault)

```solidity
// Returns USD with 18 decimals. updatedAt is the time of the last *healthy* reading.
// When any check fails, it keeps returning the last healthy updatedAt, so the vault's
// existing freshness rule (maxPriceAge) pauses price decisions automatically.
function latestPrice() external view returns (uint256 usdPrice, uint256 updatedAt);

// Diagnostics for the app (not used by the vault).
function health() external view returns (bool healthy, uint8 reason, uint256 twapUsd, uint256 spotUsd, uint256 liquidity);
```

`usdPrice = twap(WIF/ETH, 30m) × twap(ETH/USD, 30m)`.

## 5. Safe pause behaviour (already supported by RixorConvictionVault)

When the oracle is unhealthy, the vault sees a stale price:

- **Paused:** new locks (they need an entry price), ROI-target exits, max-loss exits, and performance-challenge finalization.
- **Still allowed:** Flexible exits, Committed early exits at the normal fee, term-end exits, and holding-challenge flows.
- **Never trapped:** Diamond Hands locks open after 7 days of stale data, and every term ends within 365 days.

## 6. ROI in USD

- The user-facing ROI is a **USD return**: `ROI = (amount × usdPrice_now) / (amount × usdPrice_entry) − 1`. Both legs (WIF/ETH and ETH/USD) are captured at entry and at measurement.
- ETH/USD movement therefore shows up exactly as it changes the position's dollar value:
  - WIF/ETH flat and ETH +10% → **+10%**.
  - WIF/ETH +25% and ETH −20% → **0%**.

  ETH-terms ROI would wrongly show 0% and +25%. This is unit-tested in `scripts/test-pricing.mjs` (`usdRoi`).
- The entry price must come from the **TWAP oracle**, never spot, so nobody can lock at a manipulated low price and hit a target easily.

### Display price vs decision price

| | Display price | Decision price |
| --- | --- | --- |
| Source | Pons WIF/ETH spot × WETH/USDG 30-min TWAP, read by the browser | The vault's `IRixorPriceOracle` (today: hand-set mock on testnet, or simulated) |
| Used for | Showing market value | Entry price, ROI, target and max-loss exits, challenge snapshots |
| Labelled | "Live market data · Display only" | "Vault decision price" / "Simulated decision price" |

## 7. Implementation estimate (when a valid source exists)

- Oracle contract and mainnet-fork tests, including manipulation and staleness simulations: 4–6 days.
- Vault wiring and exposure caps: 2–3 days.
- Keeper for the secondary sampler: 1 day.
- App health display: 1–2 days.
- Independent audit: 2–4 weeks.
