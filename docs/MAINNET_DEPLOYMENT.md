# Rixor V2 on Robinhood Chain mainnet with real $WIF (prepared, NOT executed)

> **Nothing here has been executed on mainnet.** No contract is deployed, no Safe created, nothing signed or
> broadcast, no WIF bought or spent. The Deploy Console refuses to sign on chain 4663 while
> `MAINNET_PLAN_APPROVED = false` (`src/deploy/expected.ts`). Every 🔒 step needs the project owner's written approval.

## 1. Verified facts (9 Nov 2026, ~16:00 UTC)

| Fact | Value | How it was checked |
|---|---|---|
| Network | Robinhood Chain mainnet, chain id **4663** (`eth_chainId` 0x1237), Arbitrum Nitro (`nitro/v3.12.3-rc.4`), ETH for gas | RPC; docs.robinhood.com/chain/connecting |
| RPC / explorer | `https://rpc.mainnet.chain.robinhood.com` (official, rate-limited: batches got HTTP 429) / `https://robinhoodchain.blockscout.com` | Robinhood docs and support page |
| **$WIF** | `0x5173b8eA6923c2d40267890D45C46a3480954773`: "World is Flat", WIF, **18 decimals**, supply 999,996,817 (fixed, ~116k burned) | RPC; worldisflat.fun; repo token list |
| WIF source | Sourcify **full match**: `PonsV2LauncherToken` = OpenZeppelin `ERC20` + `ERC20Burnable`, solc 0.8.35. No owner, mint, pause, fee, blacklist, proxy, `CALL`, `DELEGATECALL` or `SELFDESTRUCT`. Runtime hash `0xbd9466af…f59f` | Sourcify v2; opcode scan |
| WIF transfers | Exact into and out of contracts, `transferFrom` by a contract, and in/out of the Uniswap v4 PoolManager (no tax) | `vet-token` local-fork tests (8/8) |
| WIF holders | 1,600 holders; largest non-infrastructure holder 2.51%; top 10 20.6%; no cluster flag | `vet-token` full Transfer replay (247,462 transfers) |
| WIF liquidity | Bonding curve graduated (curve holds 0). Main pool: Pons v2 hook pool on Uniswap v4, id `0x71ef4106…6548c79`, **~22.7 ETH + 37.8M WIF (~$97k)**, 24 h volume ~$125k; 99.0% of ETH depth locked by code | `vet-token`; DexScreener; GeckoTerminal |
| WIF price | **$0.001283 / 5.99e-7 ETH** (DexScreener), $0.0012806 (GeckoTerminal), $0.0012785 (on-chain pool via `check:live-price`; second DEX within 1.6%) | three independent reads |
| ETH price | ~$2,140–2,147 (CoinGecko, Coinbase, on-chain USDG pool TWAP) | |
| Gas | base fee ~0.0203 gwei; Arbitrum L1 data component ~0 (854 gas for the whole plan) | `eth_gasPrice`; NodeInterface |
| Safe v1.5.0 | factory, SafeL2 singleton and fallback handler on mainnet are **byte-identical** to testnet. Safe{Wallet} supports 4663 with a live Transaction Service | RPC code hashes; safe-config API |
| HOOKR / TORCH | 18 decimals, 1B supply each; ~$0.021 and ~$0.0048; runtime hashes pinned in `expected.ts` | RPC; DexScreener |

**Hackathon rules (re-read 9 Nov):**
- "your project has to use $wif onchain on Robinhood Chain".
- "show us proof with a repo we can see, a demo video and real transactions".
- Disqualification for "faked transactions or proof".
- Submissions close **12 Nov 17:30 UTC**; the app must stay live until **16 Nov 17:30 UTC**.
- The judges' checker passes a transaction only when "$wif moved". Stream funding and reward claims move WIF; a lock alone is informational.
- $WIF exists only on mainnet.

## 2. Contract compatibility with real WIF

The contracts needed **no change**:

- **Constants:** `MIN_FUNDING` (10,000), `MIN_CREATE_POOL` (100,000) and `MIN_SPONSOR_AMOUNT` (10,000) are written as `ether`, i.e. 18 decimals, which matches WIF.
- **Transfers:** every WIF pull is balance-checked (`_pullExact`, so an inexact token reverts with `IncompatibleToken`). Every push uses `transfer` with return-value checks. WIF is a plain OZ ERC20 with no hooks, so it cannot re-enter.
- **Reward token:** Rewards and Challenges refuse to list the reward token. `DeployRixorV2` now also requires the **official WIF on chain 4663**.
- **Proof:** stream accounting was verified with real WIF on a fork: claims + refunds = funded, and the Rewards balance equals funded − claimed − refunded to the wei (`rehearse:mainnet`, `test:fork`).

## 3. The mainnet plan (pinned; CANDIDATE until approved)

Eight transactions, all from the deployer, value 0, consecutive nonces (`MAINNET_STEP_LAYOUT`):

| # | Transaction | Planned gas |
|---|---|---|
| 1 | Create owner Safe (2-of-3, salt `rixor.mainnet.owner-safe.v1`) | 296,282 |
| 2 | Create guardian Safe (2-of-3, salt `rixor.mainnet.guardian-safe.v1`) | 296,282 |
| 3 | Deploy RixorLocker, listing **HOOKR** (unit 1,000, cap 2,500,000) and **TORCH** (unit 5,000, cap 10,000,000), both **Class B** | 4,098,288 |
| 4 | Deploy RixorRewards (official WIF) | 2,027,354 |
| 5 | Deploy RixorChallenges (official WIF, minimum hold 86,400 s) | 3,307,464 |
| 6 | `WIF.approve(Rewards, 20,000 WIF)` | 45,973 |
| 7 | Fund the HOOKR stream: 10,000 WIF over 14 days | 307,916 |
| 8 | Fund the TORCH stream: 10,000 WIF over 14 days | 246,992 |
| | **Total** | **10,626,551** |

- **Listing route:** the listings are set in the **constructor**, so the 48-hour timelock is not used. Nobody can have a position at genesis, so no existing locker is affected. This differs from `LAUNCH_RUNBOOK.md` §4, which listed through the timelock after deployment, and needs approval.
- **Units:** about $20 each.
- **Caps:** about $50k each. A cap can rise only through the timelock, at most 2× per step.
- **Reward start:** streams start at the **next UTC midnight** after funding and run 14 days. Funding by 10 Nov gives live rewards from 11 Nov 00:00 UTC to 25 Nov.

## 4. Exact quantities

| Item | Quantity | Notes |
|---|---|---|
| **WIF in the deployer before step 1** | **20,000 WIF** exactly (the console refuses step 1 with 1 wei less) | ≈ 0.012 ETH ≈ **$26** at today's price. Buy ~5% extra for price movement; the excess stays in the deployer |
| **ETH in the deployer** | needs ≥ ~0.00056 ETH (console gate: 1.3× gas limits at 2× today's price, all remaining steps) | **Fund 0.005 ETH** (≈ $11): ~9× headroom. Actual cost at today's price ≈ **0.000216 ETH** (≈ $0.46) |
| If the deployer buys its own WIF | +~0.012 ETH for the swap, plus a little gas | Must happen **before** the bundle is exported (a swap uses a nonce). Simpler: buy in another wallet and transfer the WIF in; incoming transfers do not change the deployer's nonce |
| Optional demo challenge | 100,000 WIF (≈ $128), from your own (non-deployer) wallet via the app | Not in the bundle; a second "$WIF moved" proof |
| Demo locker wallet | 1 unit of HOOKR (1,000 ≈ $21) or TORCH (5,000 ≈ $24), plus ~0.001 ETH | Any wallet that is not a Safe signer or the deployer |
| Safe signers | 0 ETH to deploy; ~0.001 ETH for whoever later executes a Safe transaction | |

## 5. Addresses and roles needed (public addresses only; never keys or phrases)

| Role | Count | Requirements (enforced by scripts, exporter and console) |
|---|---|---|
| **Deployer** | 1 | Plain EOA on mainnet: no contract code and **no EIP-7702 delegation** (some wallets "upgrade" accounts; that is refused). Not one of the six signers. Signs the 8 transactions. Approved model: hardware-wallet signing. |
| **Owner Safe signers** | 3 | Plain EOAs. 2-of-3. Hold the Locker's owner role: listings, caps, pause and unpause. |
| **Guardian Safe signers** | 3 | Plain EOAs. 2-of-3. Hold the emergency roles. **None shared** with the owner Safe or the deployer. |

The code enforces seven distinct addresses. It cannot enforce seven distinct people or devices. The independence of the six signers is your decision and responsibility.

Template: `scripts/deploy-console/addresses.template.json`.

## 6. Procedure (🔒 = needs your written approval)

1. 🔒 Approve the plan in §3 (listings, units, caps, budget, minimum hold, constructor listing) and the signing model. I then commit `MAINNET_PLAN_APPROVED = true`, plus any changes you ask for, for review.
2. Send the seven public addresses.
3. Fund the deployer: 0.005 ETH through an official bridge route (docs.robinhood.com/chain/bridging: Arbitrum canonical, about 10 minutes; Relay or Across, seconds), then 20,000 WIF.
4. Export: `node scripts/export-deploy-bundle.mjs --mainnet --addresses deploy/addresses.json`. This prints the bundle hash and self-verifies on a local fork.
5. 🔒 Recommended rehearsal with your real deployer wallet on a local mainnet fork:
   - Export: `--mainnet --rehearsal --deployer 0x…`.
   - Serve it through `scripts/deploy-console/station.mjs`.
   - This proves your wallet can sign the 19.6 KB creation transaction. Signatures for chain 31337 are invalid on mainnet.
6. 🔒 Real deployment from the Deploy Console in the wallet's browser:
   - Compare the bundle hash.
   - Tap through the 8 steps: Check, then Ask wallet to sign.
   - The console verifies every receipt and contract state, and handles speed-up and cancel.
7. Read-only: `VerifyRixorV2` against mainnet, then verify the source on Sourcify.
8. 🔒 Publish `public/mainnet/deployment.json` (the console prints it) and deploy the frontend. The **Mainnet** tab then appears, but only if the chain proves the manifest.

## 7. Tests (all local; mainnet RPC read-only)

| Suite | What it proves |
|---|---|
| `npm run rehearse:mainnet` | The real mainnet scripts on a local mainnet fork with real WIF transfers:<br>• signer-overlap, deployer, contract-signer and chain-pin refusals<br>• Safe halt on re-run<br>• exact funding; idempotent re-run<br>• lock, claim, Flexible exit<br>• refund of zero-weight time<br>• exact accounting; Committed exit |
| `npm run test:deploy-console-mainnet` | Pinned plan equals scripts and config:<br>• tampering refused<br>• approval gate on real mainnet (read-only)<br>• WIF and ETH gates<br>• full 8-step run on a fork<br>• speed-up proven by the chain<br>• cancel halts<br>• non-fork chain halts |
| `npm run demo:e2e:mainnet` | The real UI in Mainnet mode against the fork:<br>• lock real HOOKR<br>• claim real WIF<br>• tampered manifests refused |
| `npm run audit:mainnet-guards` | Every script, simulated against real mainnet, is refused without the exact authorisation sentence. |
| `npm run test:fork` | Fork tests with real WIF, HOOKR and TORCH code. |

## 8. Remaining risks

- **No external audit.** Internal review and tests only. Caps limit exposure, but real user funds are at risk if there is a bug.
- **Signing model.** The approved model is hardware-wallet signing.
  - A hot-wallet deployer (for example Zerion without a Ledger) is a deviation that needs your explicit approval.
  - The deployer has no role after deployment, so its exposure is the ETH and WIF it holds.
  - Safe{Wallet} disables `ledger_v2` on chain 4663, so Ledger-held Safe signers may need a browser-extension wallet path. This is untested.
- **Phone wallet and contract creation.** Zerion's handling of contract creation (no `to`) and of the 19.6 KB payload is unconfirmed until the rehearsal.
- **Public RPC limits.** The public RPC is rate-limited. Heavy judging traffic could slow reads; a provider key (for example Alchemy) is a separate decision.
- **Listing data is a snapshot.** Listing data (liquidity, holders) is evidence at one block, and the HOOKR/TORCH re-vet is dated 9 Nov.
- **Timing.** To show claims before 12 Nov 17:30 UTC, the streams must be funded by 11 Nov 23:59 UTC; earlier is better.
