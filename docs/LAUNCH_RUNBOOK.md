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

1. 🔒 Authorise testnet deployment.
2. 🔒 Choose the deployer: a **fresh testnet-only** key that the project owner generates and holds (in a hardware
   wallet or `cast wallet` keystore). It never holds a role and is never shared with anyone, including Claude.
   Fund it from the testnet faucet.
3. 🔒 Create two Safes on testnet (owner, guardian), each at least 2-of-3, with testnet-only signers.
4. Deploy clearly named TEST tokens (for example "Rixor Test Meme A (TEST)") and a TEST reward token. Never reuse
   real token names. Fill `deploy/config/testnet.template.json` → `deploy/config/testnet.json`.
5. Deploy:
   ```bash
   RIXOR_CONFIG=deploy/config/testnet.json RIXOR_OWNER_SAFE=0x… RIXOR_GUARDIAN_SAFE=0x… \
   node scripts/forge.mjs script script/DeployRixorV2.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com \
     --broadcast --ledger            # or --keystore <path>; never a raw key on the command line
   RIXOR_DEPLOYMENT=deployments/46630.json node scripts/forge.mjs script script/VerifyRixorV2.s.sol \
     --rpc-url https://rpc.testnet.chain.robinhood.com
   ```
6. Verify all three contracts on Sourcify with §1 settings.
7. Point a testnet build of the frontend at `deployments/46630.json` and run the journey with real wallets.

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
