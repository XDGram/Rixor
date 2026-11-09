# Rixor V2 testnet deployment checklist (Robinhood Chain testnet, chain id 46630)

> **NOT EXECUTED. Nothing below may be signed or broadcast without the project owner's separate written
> authorisation.** Independently reviewed on 9 Nov 2026. Rehearsed only on local chains:
> `npm run rehearse:testnet` (12 checks), `npm run deploy:local-fork` (16 checks), `npm run plan:testnet`
> (the exact scripts on a local fork of testnet, with every address independently recomputed), and
> `npm run audit:mainnet-guards` (16 script/flag combinations against mainnet, all refused). Mainnet is never involved.

## 1. Decisions (approved 8 Nov 2026)

Safes via CLI with hardware-wallet signatures (no Safe web app) · production lock terms unchanged · TEST defaults
approved · HOOKR Class B (not involved in testnet) · deployment waits for written authorisation.

## 2. Public addresses required (no secrets)

| Slot | Who | Rule (enforced by the scripts) |
|---|---|---|
| Owner signers O1, O2, O3 | three people, each a Ledger account | non-zero; distinct; plain EOAs (no code, no EIP-7702 delegation) |
| Guardian signers G1, G2, G3 | three people, each a Ledger account | non-zero; distinct; plain EOAs; **none of them may be an owner signer** |
| Deployer D | one Ledger account used only for deployment | plain EOA; **not any of the six signers**; holds no protocol role |

**Six distinct signer addresses are mandatory.** No address may appear twice, within a Safe or across the two
Safes (not even one shared signer), and the deployer is none of the six. Both Safes are 2-of-3. The rule lives in
`script/RixorSignerChecks.sol` (Safe creation, deployment, verification) and its mirror `scripts/lib/signer-sets.mjs`
(planning and the live preflight); every stage refuses a violation before anything is signed. Tests:
`test/RixorSignerChecks.t.sol` and `npm run test:signer-sets`.

**Recommended: six separate people, each with their own Ledger device.** The scripts can only compare addresses: two
accounts on the same device (or the same recovery phrase) look distinct but are not independent, so this part is
the owner's responsibility. The deployer may be a separate account on the operator's device, as it holds no role.

How each person obtains their address (their own machine, Ledger Ethereum app open; nothing secret is shown or shared):

```bash
node_modules/@foundry-rs/cast-<os>-<arch>/bin/cast wallet address --ledger --mnemonic-derivation-path "m/44'/60'/<N>'/0/0"
```

Record `<N>` (the account index) with the address; the same index is used for signing later. Never type a seed phrase
into a computer, and never send a private key: no step needs one.

## 3. Predicted addresses

Safe addresses = CREATE2 from the canonical factory and depend only on the signer list (order matters), threshold 2,
fallback handler and salt. All other addresses = CREATE from the deployer address and nonce. Placeholder run
(`plan:testnet` without real addresses; deployer `0x35F5…3703`, nonce 0):

| Contract | Placeholder address | Formula (independently recomputed with ethers, matched) |
|---|---|---|
| Owner Safe | `0x8cA1Ba0e8E86D28C80753C1D33818E4431aa1e09` | CREATE2(factory, keccak(keccak(setup(O1,O2,O3,2,…)), keccak("rixor.testnet.owner-safe.v1")), keccak(proxyCreationCode ‖ singleton)) |
| Guardian Safe | `0x0a8e57735Dc9bA254Ed656e8a2C7671227b17E1b` | same with G1–G3 and salt `rixor.testnet.guardian-safe.v1` |
| tMEMEA | `0x527C41D1334D35794C20a648466F5a7aF99b8040` | CREATE(D, nonce 2) |
| tMEMEB | `0x0b2a100CA1DA42E7c101E17833A7F04da4DF5898` | CREATE(D, nonce 3) |
| tWIF | `0xc8D1883Df343D34e5423962270b29b160Cd00822` | CREATE(D, nonce 4) |
| RixorLocker | `0xE477f4FE3142B2A5dE45d42B0e86f7608555c844` | CREATE(D, nonce 5) |
| RixorRewards | `0xcBB4d1b0668b138dB9A64022dFd16166Ec4eFe3E` | CREATE(D, nonce 6) |
| RixorChallenges | `0x4118262465bD135109d9152C93ddaCd3A7c4F713` | CREATE(D, nonce 7) |

**The real addresses come from step 5.3 with the real public addresses.** The preflight refuses a placeholder plan.

## 4. Transaction order, settings and gas (all from the deployer D)

| # | Nonce | Step | Transaction | Gas used |
|---|---|---|---|---|
| 1 | 0 | safes | factory `0x14F2…5e7b`.createProxyWithNonce → owner Safe (2-of-3, Safe v1.5.0) | 296,282 |
| 2 | 1 | safes | factory.createProxyWithNonce → guardian Safe | 296,270 |
| 3 | 2 | tokens | deploy tMEMEA "Rixor Test Meme A (TEST)", 18 dec, 1B supply to D, faucet 100k/day | 568,203 |
| 4 | 3 | tokens | deploy tMEMEB "Rixor Test Meme B (TEST)", 6 dec, 1B to D, faucet 100k/day | 568,119 |
| 5 | 4 | tokens | deploy tWIF "Rixor Test Reward (TEST)", 18 dec, 1B to D, faucet 250k/day | 568,179 |
| 6 | 5 | rixor | deploy RixorLocker(owner Safe, guardian Safe, [tMEMEA Class A unit 1,000 cap 20M; tMEMEB Class B unit 1,000 cap 10M]) | 4,098,296 |
| 7 | 6 | rixor | deploy RixorRewards(Locker, tWIF) | 2,027,354 |
| 8 | 7 | rixor | deploy RixorChallenges(Locker, tWIF, 3,600 s) | 3,307,452 |
| 9 | 8 | seed | tWIF.approve(Rewards, 210,000) | 46,175 |
| 10 | 9 | seed | Rewards.fund(tMEMEA, 140,000 tWIF, 14 days) | 308,138 |
| 11 | 10 | seed | Rewards.fund(tMEMEB, 70,000 tWIF, 14 days) | 252,038 |
| | | | **Total** | **12,336,506** |

Gas price on testnet: 0.010–0.018 gwei observed (8–9 Nov) → **0.000123–0.000225 testnet ETH** in total; 0.0225 at
100× today's price. Fund D with **0.02 testnet ETH** from the faucet. No script sets a gas limit; the node estimates.

## 5. Procedure

### 5.1 Machine setup (operator)

```bash
git clone … && cd Rixor && git checkout <approved commit>
npm ci && git submodule update --init --recursive
npm run test:contracts                       # must pass (exit code is propagated)
npm run audit:mainnet-guards                 # must print PASS
export RIXOR_EXPECTED_CHAIN_ID=46630
RPC=https://rpc.testnet.chain.robinhood.com
FORGE="node scripts/forge.mjs"
CAST=node_modules/@foundry-rs/cast-<os>-<arch>/bin/cast
D=0x<deployer>   DPATH="m/44'/60'/<N>'/0/0"
LEDGER=(--ledger --sender "$D" --mnemonic-derivation-paths "$DPATH")   # forge script: plural "paths"
```

**Never pass `--chain` to `forge script`**: it overrides the script's `block.chainid` view. The scripts therefore
also query the RPC's own `eth_chainId` and refuse unless both equal 46630.

### 5.2 Ledger signing drill (each of the six signers; no effect anywhere)

```bash
node scripts/safe-tx.mjs drill                                     # chain 31337, dummy contract: valid nowhere
$CAST wallet sign --ledger --mnemonic-derivation-path "m/44'/60'/<N>'/0/0" --data --from-file safe-signing-drill.json
node scripts/safe-tx.mjs check --tx safe-signing-drill.json --sig 0x<signature> --expect 0x<their address>
```

Proves each device produces Safe EIP-712 signatures and shows the signer what the device displays.

### 5.3 Final plan with real addresses (no broadcast)

```bash
RIXOR_DEPLOYER=$D RIXOR_OWNER_SIGNERS=0x<O1>,0x<O2>,0x<O3> RIXOR_GUARDIAN_SIGNERS=0x<G1>,0x<G2>,0x<G3> npm run plan:testnet
```

The plan refuses to run unless the six signers are distinct, exclude the deployer and are plain EOAs on testnet.
Review `deployments/46630-plan-summary.json` (git-ignored): every address, the independent address check, the deployer
nonce (must be 0, or the shown value), roles and listings. The owner confirms these addresses in writing.

### 5.4 Broadcast (only after written authorisation). Before EVERY step run the preflight; continue only on GO.

The preflight re-checks the six-distinct-signer rule against the plan, that all seven addresses have no code on
testnet, and (after step "safes") that each live Safe is 2-of-3 with exactly its planned signers.

```bash
# Step "safes" (2 tx)
npm run preflight:testnet -- --step safes --deployer $D
RIXOR_OWNER_SIGNERS=0x<O1>,0x<O2>,0x<O3> RIXOR_GUARDIAN_SIGNERS=0x<G1>,0x<G2>,0x<G3> \
  $FORGE script script/CreateTestnetSafes.s.sol --rpc-url $RPC --broadcast --slow "${LEDGER[@]}"

# Step "tokens" (3 tx) -> deployments/46630-testnet-config.json ; compare with the plan before continuing
npm run preflight:testnet -- --step tokens --deployer $D
$FORGE script script/DeployTestnetTokens.s.sol --rpc-url $RPC --broadcast --slow "${LEDGER[@]}"

# Step "rixor" (3 tx) -> deployments/46630.json
npm run preflight:testnet -- --step rixor --deployer $D
RIXOR_CONFIG=deployments/46630-testnet-config.json RIXOR_OWNER_SAFE=0x<ownerSafe> RIXOR_GUARDIAN_SAFE=0x<guardianSafe> \
  $FORGE script script/DeployRixorV2.s.sol --rpc-url $RPC --broadcast --slow "${LEDGER[@]}"
RIXOR_DEPLOYMENT=deployments/46630.json RIXOR_CONFIG=deployments/46630-testnet-config.json \
  $FORGE script script/VerifyRixorV2.s.sol --rpc-url $RPC

# Step "seed" (3 tx). First run WITHOUT --broadcast: prints balance, existing streams and what will be funded.
npm run preflight:testnet -- --step seed --deployer $D
RIXOR_DEPLOYMENT=deployments/46630.json RIXOR_CONFIG=deployments/46630-testnet-config.json \
  $FORGE script script/SeedTestnetRewards.s.sol --rpc-url $RPC --sender $D
RIXOR_DEPLOYMENT=deployments/46630.json RIXOR_CONFIG=deployments/46630-testnet-config.json \
  $FORGE script script/SeedTestnetRewards.s.sol --rpc-url $RPC --broadcast --slow "${LEDGER[@]}"
```

### 5.5 What each Ledger prompt should display (reject anything else)

| Transactions | Expect on the device |
|---|---|
| 1–2 (create Safes) | Review transaction · **Network / Chain ID 46630** · To `0x14F2982D601c9458F93bd70B218933A6f8165e7b` · Amount 0 ETH · blind-signing warning (contract data) · max fees a tiny fraction of ETH |
| 3–8 (deployments) | Review transaction · **Chain ID 46630** · contract creation (no To address) · Amount 0 · blind-signing warning |
| 9 (approve) | **Chain ID 46630** · To = tWIF address from the plan · Amount 0 |
| 10–11 (fund) | **Chain ID 46630** · To = RixorRewards address from the plan · Amount 0 |
| Safe signatures (later) | Typed message: either clear-signed fields with chainId 46630 and the Safe address, or a **domain hash and message hash** that must equal the values printed by `safe-tx.mjs prepare` |

Blind signing must be enabled in the Ledger Ethereum app for transactions 1–8. Disable it again afterwards.

### 5.6 Verification after deployment

1. `VerifyRixorV2` (above) prints `verification passed`: Locker bytecode equals this build; owner/guardian are the
   planned 2-of-3 Safe v1.5.0 proxies; Rewards and Challenges wired to the Locker and tWIF; listings, units, caps and
   classes equal the config; the two streams (140,000 and 70,000 tWIF, 14 days) are listed with funder D.
2. Safe owners: `$CAST call 0x<ownerSafe> "getOwners()(address[])" --rpc-url $RPC` and `getThreshold()` (= 2); same for
   the guardian Safe. The two owner lists must have no address in common (`VerifyRixorV2` also enforces this).
3. Source verification on Sourcify (supports 46630), for each of the eight contracts except the two Safe proxies
   (already verified upstream):
   ```bash
   $FORGE verify-contract <address> <path>:<Contract> --verifier sourcify --chain 46630 --rpc-url $RPC --guess-constructor-args --watch
   ```
4. Compare every deployed address with the confirmed plan. Any difference: stop and report.
5. Publishing `deployments/46630.json` to a Vercel preview (to enable the app's Testnet tab) is a **separate approval**.

## 6. Recovery if a step fails part-way

| Situation | Action |
|---|---|
| Preflight NO-GO | Do not sign. Fix the cause (funding, wrong network, nonce moved) and re-run the preflight. A moved nonce means re-plan. |
| Ledger prompt rejected, device timeout, or wrong chain shown | Nothing was sent (reject). Re-run the preflight, then the same step. |
| `safes` interrupted after transaction 1 | Re-run the same command: `CreateTestnetSafes` skips a Safe that already exists at its predicted address (and verifies its owners). |
| `tokens` or `rixor` interrupted after some transactions | Re-run the **same command with `--resume`** added (forge sends only the remaining transactions from `broadcast/…/46630/run-latest.json`; addresses stay as planned). Never re-run without `--resume`: that would deploy new contracts at new addresses. Then run `VerifyRixorV2`. |
| A transaction reverted (should not happen; all were rehearsed) | Stop. Nothing is at risk (TEST tokens are valueless, no user funds). Report the transaction hash; a corrected plan from the current nonce is prepared before anything else is sent. |
| `seed` interrupted | Re-run the same command: it skips any token already funded by D and approves only what is still needed. |
| Manifest written but contracts missing | Manifests are written during simulation. `VerifyRixorV2` fails if code is missing; treat as "interrupted" above. |
| A problem after deployment | Testnet only: guardian Safe can `pause()` via `scripts/safe-tx.mjs` (2-of-3); nothing holds value. |

## 7. Chain binding and mainnet safety (verified)

1. Every script requires `block.chainid` **and** the RPC's own `eth_chainId` to equal `RIXOR_EXPECTED_CHAIN_ID`
   (46630); testnet scripts accept only 46630 or 31337. `npm run audit:mainnet-guards` runs all four broadcasting
   scripts against the mainnet RPC under four pin/flag combinations (16 runs): all refused.
2. `DeployRixorV2` refuses 4663 without a written-authorisation sentence that is never used here, and even then needs
   genuine Safes; `RixorTestToken` reverts on chain 4663; `safe-tx.mjs` refuses any chain but 46630/31337 and binds
   signatures to chain 46630 through the EIP-712 domain; `preflight-testnet.mjs` stops on a mainnet RPC.
3. Every transaction is EIP-155 signed for chain 46630 and the Ledger displays the chain.

## 8. Secrets

No private key, seed phrase or signing secret is used, stored or logged anywhere in this procedure: all signing
happens on Ledger devices; local rehearsals use addresses derived from labels (no keys) or throwaway keys generated
in memory for the local chain only. Repository scan (9 Nov): no keys or mnemonics in tracked files; the only
key-named variable is the empty legacy `RIXOR_DEPLOYER_PRIVATE_KEY` in `.env.example`, unused by V2. `.env*`,
`broadcast/`, `deployments/*-plan*`, `safe-tx-*.json` and drill files are git-ignored.
