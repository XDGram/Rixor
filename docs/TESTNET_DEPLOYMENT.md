# Rixor V2 testnet deployment (Robinhood Chain testnet, chain id 46630)

> **NOT EXECUTED. Nothing below may be broadcast without the project owner's separate written authorisation.**
> Everything has been rehearsed on local chains only: `npm run rehearse:testnet` (12 checks) and
> `npm run plan:testnet` (the exact scripts on a local fork of testnet). Mainnet is never involved.

## 1. Approved decisions (8 Nov 2026)

| Decision | Value |
|---|---|
| Safes | Two Safe v1.5.0 proxies, 2-of-3, created and operated with the CLI below and hardware-wallet signatures (no Safe web app) |
| Lock terms | Production rules unchanged (Flexible any time; Committed/Diamond 30–90 days; Class B ≤ 60 days, no Diamond) |
| Defaults | As below (TEST tokens, supplies, caps, faucets, reward funding) |
| HOOKR | Class B (85.8% code-locked ETH depth < 90% Class A threshold; no exception). Not involved in testnet. |

## 2. What gets deployed

| Item | Settings |
|---|---|
| Owner Safe | Safe v1.5.0 (SafeL2 `0xEdd160fE…7C7e`, factory `0x14F2982D…5e7b`, fallback `0x3EfCBb83…f77f4`), 2-of-3, salt `keccak256("rixor.testnet.owner-safe.v1")` |
| Guardian Safe | Same, salt `keccak256("rixor.testnet.guardian-safe.v1")`; at least one signer not an owner signer |
| tMEMEA "Rixor Test Meme A (TEST)" | 18 decimals · 1,000,000,000 supply to the deployer · faucet 100,000 per address per day · **Class A** · unit 1,000 · cap 20,000,000 |
| tMEMEB "Rixor Test Meme B (TEST)" | **6 decimals** · 1,000,000,000 supply · faucet 100,000 per day · **Class B** · unit 1,000 · cap 10,000,000 |
| tWIF "Rixor Test Reward (TEST)" | 18 decimals · 1,000,000,000 supply · faucet 250,000 per day · reward/prize token only (not listed) |
| RixorLocker | owner = owner Safe, guardian = guardian Safe, listings above |
| RixorRewards | locker, reward token tWIF; no owner |
| RixorChallenges | locker, tWIF, minimum hold 3,600 s |
| Reward funding | 140,000 tWIF over 14 days → tMEMEA; 70,000 tWIF over 14 days → tMEMEB |

Roles: the **deployer** (a dedicated hardware-wallet account) only sends the deployment transactions and holds the
TEST supply for seeding; it holds **no** protocol role and **must not** be a Safe signer (the scripts enforce this).
The six Safe signers are separate hardware-wallet accounts.

## 3. Transaction sequence and cost (from `npm run plan:testnet`, placeholder addresses)

| # | Deployer nonce | Script | Action | Gas used |
|---|---|---|---|---|
| 1 | 0 | CreateTestnetSafes | factory.createProxyWithNonce (owner Safe) | 296,282 |
| 2 | 1 | CreateTestnetSafes | factory.createProxyWithNonce (guardian Safe) | 296,270 |
| 3 | 2 | DeployTestnetTokens | deploy tMEMEA | 568,203 |
| 4 | 3 | DeployTestnetTokens | deploy tMEMEB | 568,119 |
| 5 | 4 | DeployTestnetTokens | deploy tWIF | 568,179 |
| 6 | 5 | DeployRixorV2 | deploy RixorLocker | 4,098,296 |
| 7 | 6 | DeployRixorV2 | deploy RixorRewards | 2,027,354 |
| 8 | 7 | DeployRixorV2 | deploy RixorChallenges | 3,307,452 |
| 9 | 8 | SeedTestnetRewards | tWIF.approve(Rewards) | 46,175 |
| 10 | 9 | SeedTestnetRewards | Rewards.fund(tMEMEA, 140,000, 14) | 308,138 |
| 11 | 10 | SeedTestnetRewards | Rewards.fund(tMEMEB, 70,000, 14) | 252,038 |
| | | | **Total** | **12,336,506** |

Testnet base fee 0.01 gwei (flat over the last 20 blocks): **0.000123 testnet ETH** in total; 0.00123 at 10×,
0.0123 at 100×. Fund the deployer with **0.02 testnet ETH** from the faucet. Testnet ETH has no value.

Exact addresses: run the plan with the real addresses (step 4.3). Safe addresses depend only on the signer lists and
salts; all other addresses depend on the deployer address and its nonce (0 for a fresh account).

## 4. Hardware-wallet procedure

### 4.1 Tools (on the operator's machine, from a checkout of the approved commit)

```bash
npm ci && git submodule update --init --recursive
FORGE="node scripts/forge.mjs"                              # pinned Foundry 1.7.1, exit codes propagated
CAST="node_modules/@foundry-rs/cast-linux-amd64/bin/cast"   # or the darwin/win32 package on that machine
RPC=https://rpc.testnet.chain.robinhood.com
export RIXOR_EXPECTED_CHAIN_ID=46630                         # every script refuses any other chain
```

Ledger: Ethereum app open; **Blind signing** enabled for contract deployments (the device cannot clear-sign contract
creation). Never enter a seed phrase anywhere; never paste a private key; nothing in this procedure asks for one.

### 4.2 Collect public addresses

Each of the six signers and the deployer, each on their own device and account index:

```bash
$CAST wallet address --ledger --mnemonic-derivation-path "m/44'/60'/<account>'/0/0"
```

Share only the printed address. The deployer must use an account that is not one of the six signer accounts.

### 4.3 Final plan with the real addresses (no broadcast)

```bash
RIXOR_DEPLOYER=0x<deployer> \
RIXOR_OWNER_SIGNERS=0x<o1>,0x<o2>,0x<o3> \
RIXOR_GUARDIAN_SIGNERS=0x<g1>,0x<g2>,0x<g3> \
npm run plan:testnet            # writes deployments/46630-plan-summary.json (git-ignored)
```

Check: deployer nonce 0 (or note it), every address, roles, listings, total gas. These addresses are what the
broadcast will produce if the steps run in this order from this deployer.

### 4.4 Broadcast (only after written authorisation)

Common flags (`--slow` waits for each receipt; no gas limits are set, the node estimates):

```bash
B="--rpc-url $RPC --broadcast --slow --ledger --sender 0x<deployer> --mnemonic-derivation-path m/44'/60'/<deployerAccount>'/0/0"
```

On every Ledger prompt, confirm the **chain id 46630** and reject anything else.

```bash
# 1. Safes (2 transactions)
RIXOR_OWNER_SIGNERS=0x<o1>,0x<o2>,0x<o3> RIXOR_GUARDIAN_SIGNERS=0x<g1>,0x<g2>,0x<g3> \
  $FORGE script script/CreateTestnetSafes.s.sol $B
# 2. TEST tokens (3 transactions) -> deployments/46630-testnet-config.json  (review it against the plan)
$FORGE script script/DeployTestnetTokens.s.sol $B
# 3. Rixor (3 transactions) -> deployments/46630.json
RIXOR_CONFIG=deployments/46630-testnet-config.json RIXOR_OWNER_SAFE=0x<ownerSafe> RIXOR_GUARDIAN_SAFE=0x<guardianSafe> \
  $FORGE script script/DeployRixorV2.s.sol $B
# 4. Read-only verification
RIXOR_DEPLOYMENT=deployments/46630.json $FORGE script script/VerifyRixorV2.s.sol --rpc-url $RPC
# 5. TEST reward streams (3 transactions)
RIXOR_DEPLOYMENT=deployments/46630.json RIXOR_CONFIG=deployments/46630-testnet-config.json \
  $FORGE script script/SeedTestnetRewards.s.sol $B
```

If a step fails part-way, stop: do not re-run blindly. `CreateTestnetSafes` is idempotent (it skips Safes that
already exist at the predicted address); the others are not.

### 4.5 Source verification (Sourcify supports chain 46630)

```bash
$FORGE verify-contract <address> contracts/RixorLocker.sol:RixorLocker --chain-id 46630 --verifier sourcify --watch
# likewise RixorRewards, RixorChallenges and the three RixorTestToken instances
```

### 4.6 Safe administration later (CLI, hardware-wallet signatures)

```bash
node scripts/safe-tx.mjs prepare --rpc $RPC --safe 0x<safe> --to 0x<target> --data 0x<calldata>
#   -> safe-tx-<safe>-<nonce>.json and the safeTxHash (cross-checked against the Safe contract)
# Two signers, each on their own Ledger (compare the hash the device shows with the printed safeTxHash):
$CAST wallet sign --ledger --mnemonic-derivation-path "m/44'/60'/<account>'/0/0" --data --from-file safe-tx-<safe>-<nonce>.json
# Assemble, verify signers, simulate, and print the exact execTransaction command:
node scripts/safe-tx.mjs exec --rpc $RPC --tx safe-tx-<safe>-<nonce>.json --sig 0x<sig1> --sig 0x<sig2>
```

Rehearsed: guardian 2-of-3 `pause()` and owner 2-of-3 `unpause()`; bad signatures and mainnet are refused.

### 4.7 Frontend (separate approval: publishes to a Vercel preview)

Copy `deployments/46630.json` to `public/testnet/deployment.json` on the feature branch. The app's **Testnet** tab then
activates in the preview build; it refuses chain 4663 and binds every transaction to chain 46630.

## 5. Chain restriction (why nothing can land on mainnet)

1. Every deployment script requires `block.chainid == RIXOR_EXPECTED_CHAIN_ID` (set to 46630); the testnet scripts
   additionally accept only 46630 (or 31337 for local rehearsal).
2. `DeployRixorV2` refuses 4663 unless a written-authorisation sentence is supplied; it is never supplied here.
3. `RixorTestToken`'s constructor reverts on chain 4663.
4. `safe-tx.mjs` refuses any chain other than 46630 or 31337, and its EIP-712 domain embeds chain id 46630.
5. Transactions are EIP-155 signed for chain 46630 (the Ledger displays it).
6. The frontend's testnet mode refuses a manifest or RPC on chain 4663.
