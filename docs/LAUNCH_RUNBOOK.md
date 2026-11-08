# Rixor V2 launch runbook (NOT executed)

> **Nothing in this runbook has been executed on a live network.** No contract has been deployed to Robinhood Chain
> testnet or mainnet, no Safe created, no transaction sent and no WIF spent. Every step marked 🔒 needs the project
> owner's explicit written authorisation. Values marked `TBD` are decided by the project owner.

## 1. Build settings (must match exactly)

| Setting | Value |
|---|---|
| Foundry | 1.7.1 (pinned via npm; always run through `node scripts/forge.mjs`, which propagates exit codes) |
| solc / EVM | 0.8.30 / **cancun** |
| Optimizer / via-IR / metadata | 200 runs / false / `ipfs` |
| forge-std (tests only) | v1.17.0 |

Pre-deployment checks on the exact commit to be deployed:

```bash
npm ci && git submodule update --init --recursive
npm run test:contracts          # unit + fuzz + invariant (exits non-zero on failure)
npm run test:fork               # fresh local mainnet fork: HOOKR, TORCH, WIF, Safes
npm run deploy:local-fork       # full deployment dry run on a local fork (11 checks)
npm run vet:token -- <each token to be listed>
```

## 2. Scripts

| Script | Purpose | Sends transactions? |
|---|---|---|
| `script/LocalForkSafes.s.sol` | Throwaway 2-of-3 Safes on a **local** fork (refuses any chain id but 31337) | Local fork only |
| `script/DeployRixorV2.s.sol` | Deploys Locker, Rewards, Challenges from `deploy/config/*.json`; writes `deployments/<chainId>.json` | Only with `--broadcast` |
| `script/VerifyRixorV2.s.sol` | Read-only post-deployment checks (wiring, roles, Locker code hash, listings) | Never |
| `scripts/deploy-local-fork.mjs` | Runs all of the above on a local anvil fork plus a smoke journey | Local fork only |

`DeployRixorV2` guards (it reverts before broadcasting if any fails): chain must be 31337, 46630, or 4663 with the
exact sentence `I have written authorisation to deploy Rixor V2 to Robinhood Chain mainnet` in
`RIXOR_CONFIRM_MAINNET`; owner and guardian must be deployed contracts (not EOAs or EIP-7702-delegated EOAs), must
differ, and on a real chain must have a threshold of at least 2; the reward token must have code and must not be
listed. No script sets a gas limit: every transaction uses the node's `eth_estimateGas`.

## 3. Testnet (Robinhood Chain testnet, chain id 46630)

Full procedure: `docs/TESTNET_DEPLOYMENT.md`. Rehearsed end to end on a local chain: `npm run rehearse:testnet` (12 checks) and the testnet-mode UI journey
(`demo/e2e/testnet-journey.mjs`, 8 steps). Every 🔒 step waits for the project owner's written approval.

**Prepared defaults** (`script/DeployTestnetTokens.s.sol`; reviewable before anything is sent):

| Item | Value |
|---|---|
| tMEMEA "Rixor Test Meme A (TEST)" | 18 decimals, 1,000,000,000 supply, faucet 100,000/day, **Class A**, unit 1,000, cap 20,000,000 (2%) |
| tMEMEB "Rixor Test Meme B (TEST)" | **6 decimals**, 1,000,000,000 supply, faucet 100,000/day, **Class B**, unit 1,000, cap 10,000,000 (1%) |
| tWIF "Rixor Test Reward (TEST)" | 18 decimals, 1,000,000,000 supply, faucet 250,000/day; reward token only |
| Challenge minimum hold | 3,600 s (contract minimum; production 86,400 s) |
| Lock terms | Unchanged production rules: Committed/Diamond 30–90 days (Class B ≤ 60); Flexible any time |
| TEST reward funding | 140,000 tWIF / 14 days to tMEMEA, 70,000 tWIF / 14 days to tMEMEB (`SeedTestnetRewards`; refuses non-TEST reward tokens) |

TEST tokens refuse to deploy on mainnet, have no owner, and have public rate-limited faucets (acceptable only because
they are valueless; a real token with a mint would fail vetting).

**Sequence** (signer: the owner's testnet-only deployer via `--ledger` or `--keystore`; never a raw key):

1. 🔒 Approve testnet deployment and these defaults.
2. 🔒 The owner creates the deployer key and funds it from the testnet faucet.
3. 🔒 Create the owner and guardian Safes (Safe v1.5.0, ≥ 3 signers, threshold ≥ 2, at least one guardian signer not
   an owner signer, the deployer not a signer). Note: Safe{Wallet}'s web app disables MetaMask, Ledger, WalletConnect
   and most other connectors on Robinhood testnet, so creation and operation may need another Safe client (decision).
4. `DeployTestnetTokens` → writes `deployments/46630-testnet-config.json`. Review it.
5. `DeployRixorV2` with that config and the two Safes (its guards reject anything that is not a genuine Safe proxy
   meeting the rules above) → `deployments/46630.json`.
6. `VerifyRixorV2` (read-only), then Sourcify verification of the three Rixor contracts and the TEST tokens.
7. `SeedTestnetRewards` (deployer funds the two TEST streams).
8. Publish `deployments/46630.json` as `public/testnet/deployment.json` (or set `VITE_RIXOR_TESTNET_MANIFEST`) in a
   preview build; the app's **Testnet** tab activates. Run the journey with a real wallet.

## 4. Mainnet (chain id 4663), after an independent review

1. 🔒 External review complete; findings resolved or accepted in writing.
2. 🔒 Owner Safe and Guardian Safe created (Safe v1.5.0, at least 2-of-3, hardware wallets held by different
   people; at least one guardian signer independent of the owner signers). Addresses recorded here.
3. 🔒 Deploy with `deploy/config/mainnet.json` (listings empty) and the confirmation sentence. Verify on Sourcify.
4. 🔒 For each token approved in writing: run `vet:token`, complete the checklist in `TOKEN_VETTING.md`, then the
   Owner Safe calls `proposeListing(token, unit, cap, class)`; anyone executes after 48 hours.
5. 🔒 Reward budgets: any stream or Season funding is a separate written approval.
6. Set `VITE_RIXOR_LOCKER_4663` in the production frontend only after the Locker is verified.

## 5. Operating procedures

| Situation | Action | Who |
|---|---|---|
| A token looks risky | `disableLocks(token)` and/or `lowerCap`; `downgradeClass` (A→B) | Owner Safe (immediate) |
| Incident affecting one token (exploit, hostile admin action, liquidity removed) | `releaseToken(token)`: irreversible; that token's positions exit fee-free; its rewards stop | Guardian or Owner Safe |
| Protocol-wide, recoverable | `pause()` then `unpause()` | Guardian or Owner; unpause owner only |
| Protocol-wide, irrecoverable | `activateEmergency()`: irreversible | Guardian or Owner |

Monitor: `Paused`, `EmergencyActivated`, `TokenReleased`, every `*Proposed` event, `OwnershipTransferStarted`,
`GuardianChanged`, `StreamFunded`, `ChallengeCreated`, `Settled`. Alert on any proposal the team did not initiate.

## 6. Cost reference (8 Nov 2026; base fee 0.0202 gwei, ETH ≈ $2,236)

| Item | Gas | Today | 5× | 50× |
|---|---|---|---|---|
| Deploy Locker + Rewards + Challenges | ~10.6M | $0.48 | $2.37 | $23.70 |
| Two Safes | ~0.6M | $0.03 | $0.13 | $1.34 |
| Configuration | ~3M | $0.14 | $0.67 | $6.70 |
| User approve + lock | ~0.32M | $0.014 | $0.07 | $0.72 |

Recommended deployer balance: 0.02 ETH on mainnet. Reward funding (minimum stream 10,000 WIF) and an external
review are the real costs and need separate approval.
