# Deploy Console: Robinhood Chain testnet deployment from an iPhone (Zerion)

**Status (9 Nov 2026):**
- Built and tested on local chains only: 79 core tests and 37 browser end-to-end tests at iPhone size, with a scripted
  Zerion-like wallet.
- **Not yet used with a real Zerion wallet** (rehearsal pending, §5) and **not used on testnet**.
- Nothing has been deployed, signed or broadcast.
- Testnet deployment, the sandbox rehearsal and any hosting change each need explicit written approval.

The Ledger and computer path (`docs/TESTNET_DEPLOYMENT.md`, `docs/LEDGER_WINDOWS_CMD.md`) is unchanged and still works.
This console is an **additional** path that sends the **same 11 transactions** from a phone wallet.

## 1. What it is

| Piece | File | Role |
|---|---|---|
| Bundle exporter | `scripts/export-deploy-bundle.mjs`, `scripts/lib/forge-plan.mjs` | Runs the real Forge deployment scripts (`CreateTestnetSafes`, `DeployTestnetTokens`, `DeployRixorV2`, `SeedTestnetRewards`, plus `VerifyRixorV2`) on a **local** chain and exports Forge's exact 11 transactions as a bundle. |
| Console core | `src/deploy/core.ts`, `src/deploy/expected.ts` | Every safety check, shared by the page, the exporter and the tests. |
| Console page | `deploy.html`, `src/deploy/DeployConsole.tsx` | Mobile-first UI for Zerion Browser. One explicit tap per wallet request. |
| Station | `scripts/deploy-console/station.mjs` | Serves the page and one bundle under a random one-time path. Rehearsal: also a local chain 31337 and an RPC relay. Testnet: serve-only. |
| Rehearsal chain | `scripts/lib/rehearsal-chain.mjs`, `scripts/deploy-console/safe-v150-snapshot.json` | Local chain 31337 with the Safe v1.5.0 contracts copied from testnet (`scripts/fetch-safe-snapshot.mjs --check` re-verifies them). Gas priced like testnet (0.01 gwei). |
| Sandbox helper | `scripts/deploy-console/sandbox-station.sh` | Sets up and starts a station in a temporary sandbox from the public repo at a pinned commit. |
| Tests | `scripts/test-deploy-console.mjs`, `scripts/test-deploy-console-e2e.mjs` | `npm run test:deploy-console`, `npm run test:deploy-console-e2e`. |

## 2. Security model

**The console does not trust the bundle.** It rebuilds every transaction and every post-deployment check from
constants compiled into the page (`expected.ts`) plus the seven reviewed addresses:
- the Safe factory, singleton and fallback handler;
- the Safe salts, the 2-of-3 threshold and the CREATE2 init-code hash;
- the keccak hash of each contract's creation code (from the reviewed build);
- the approved token, listing and stream parameters;
- the minimum hold.

It refuses a bundle that differs in any byte: calldata, destination, value, nonce, constructor arguments, creation
code, predicted address or checks.

The bundle supplies only:
- the seven addresses;
- the runtime code hashes of the contracts that carry constructor immutables (tokens, Rewards, Challenges);
- planned gas, labels and the creation time.

All of it is covered by the **bundle hash**, which the reviewer compares out of band.

**Before every wallet request** (`preflight`), all of these must hold:
1. The bundle is exactly the approved plan.
2. The wallet's network is 46630 (or 31337 for a rehearsal bundle). Mainnet 4663 is refused explicitly.
3. The RPC's own `eth_chainId` matches. A testnet bundle may only name the official RPC
   `https://rpc.testnet.chain.robinhood.com`.
4. The connected account is the planned deployer.
5. The chain state matches the plan: every earlier step is proven by its on-chain checks, and nothing is pending.
6. This is the **next** step. A completed step can never be sent again; a later step cannot be sent early.
7. The deployer's latest and pending nonce equal the planned nonce, and the wallet's own nonce agrees.
8. The destination, calldata and value equal the rebuilt transaction.
9. The predicted address is still empty.
10. A live `eth_estimateGas` succeeds (the transaction would not revert) and is at most 3× the plan.
11. The balance covers the gas limit at twice the current gas price.

The request sent to the wallet is `{from, to?, data, value: 0, gas}`. No nonce is sent: the wallet picks the next one,
which step 7 proved is the planned one. The gas limit is max(live estimate, plan) × 1.3. The gas limit is the only
field the console chooses, and it never changes what the transaction does.

**After each transaction** (`verifySent`), the console checks:
- the transaction's sender, nonce, chain id, destination, calldata and value;
- `status = 1`;
- for creations, `contractAddress` equals the predicted address;
- the step's durable checks:
  - runtime code hash;
  - Safe singleton slot, owners and threshold;
  - token name, symbol, decimals and faucet amount;
  - Locker owner, guardian, no pending owner, listed tokens, and each listing's class, unit and cap;
  - Rewards and Challenges wiring and minimum hold;
  - approval accounting;
  - each stream's funder, token, amount and 14-day duration.

Any mismatch shows **STOP**, and nothing further is offered.

**Recovery is chain-based, not memory-based.** On load and after every step, `assess` reads the deployer's nonce:
- every step below it must pass its durable checks;
- the next step is the nonce;
- a pending transaction blocks everything until it is mined;
- a used nonce that does not match the plan **halts**;
- any contract already at a future predicted address **halts** (for example, a Safe created by someone else first,
  which would shift every later nonce);
- before step 1, every signer must still be a plain EOA (no code, no EIP-7702 delegation).

The page keeps only public transaction hashes in `localStorage`, for links and to keep waiting for a pending
transaction after a reload.

**What it cannot protect against:**
- a compromised phone or wallet app;
- a wallet that displays one transaction and signs another. The post-verification and halt still stop the sequence
  after one bad step.
- a compromised station host serving a different console build. Mitigations:
  - the bundle hash is compared out of band;
  - the station only runs from a pinned public commit;
  - the testnet console never relays transactions, so the wallet sends straight to the official RPC.

## 3. Proposed change: a dedicated Zerion deployer instead of a Ledger (needs your approval)

| Question | Answer |
|---|---|
| Permanent authority of the deployer? | **None over the protocol.** The Locker's owner and guardian are the two Safes, set in the constructor. Rewards has no owner. Challenges' only privileged function (`createSeason`) checks `locker.owner()`, the owner Safe. The TEST tokens have no owner, pause, blacklist or upgrade. |
| What the deployer keeps | The unfunded TEST token supply (valueless), and as stream funder the right to reclaim unstreamed tWIF (`refund`). |
| What changes in security | The deployment key is a hot wallet on a phone instead of a hardware wallet. The window of exposure is the deployment itself (11 transactions, about 20 minutes). |
| Risks introduced | A phone or wallet compromise **before or during** deployment could send other transactions from the deployer. The console then halts (nonce used differently, or wrong code at a predicted address), and a fresh deployer plus a re-plan are needed. Phishing pages: open the console only from the exact link, and compare the bundle hash. |
| Independent verification | Unchanged. `VerifyRixorV2` (Forge, read-only) plus the console's checks plus the explorer verify the result whoever deployed it. The Locker's runtime code is compared byte for byte with the build. |
| Contract or script changes | **None.** The contracts and the Forge scripts are untouched. The scripts' `_requireRealSender` accepts any plain EOA; the "Ledger" requirement is in the docs only. |
| Six-signer architecture | Unchanged. Two 2-of-3 Safes, six distinct plain-EOA signers (six people), a separate deployer. Enforced by the exporter (`signerProblems` and an on-chain code check), the console (`validateBundle` and `assess`) and the Forge scripts (`RixorSignerChecks`). |

**Recommendation:**
- Use a **new Zerion account dedicated to deploying**: not a signer, with nothing else in it.
- Fund it with testnet ETH only.
- Use it for nothing else until all 11 steps are verified.
- Afterwards it holds nothing of value and no authority.

## 4. The seven public addresses

Template: `scripts/deploy-console/addresses.template.json`. Copy it to `deployments/addresses.json` (git-ignored) and
fill in the seven addresses.

- **O1, O2, O3** (owner Safe) and **G1, G2, G3** (guardian Safe): **six distinct people**, each with their own wallet.
  - Each person reads their own address from their own wallet and sends only that public address.
  - Each must be a plain account: no smart-contract wallet, no EIP-7702 delegation. Zerion's standard accounts are
    plain EOAs.
  - **No Safe signer signs anything** for deployment, seeding or the demo. Their signatures are only needed later for
    Safe administration: pause or unpause, listings and caps, release or emergency, Season challenges.
- **D** (deployer): your dedicated Zerion deployer account (§3).
- Nobody ever sends a private key, seed phrase, recovery phrase or passphrase.

## 5. Zerion rehearsal (local chain 31337; nothing reaches a real network)

**Purpose:** prove that Zerion on your iPhone can:
- add a custom network;
- sign **contract creations**, including the 19,585-byte Locker payload;
- sign the full 11-step sequence and the calls;
- work with the console's checks, before anything touches testnet.

Signatures for chain 31337 are not valid on Robinhood Chain testnet or mainnet.

**Sandbox:**

| Setting | Value |
|---|---|
| Type | Temporary Vercel Sandbox, same approach as the drill |
| Size and lifetime | 1 vCPU / 2 GB, 45-minute hard timeout, non-persistent, no snapshots |
| Exposed port | 8788 only |
| Outbound during setup | Only `github.com`, `codeload.github.com`, `registry.npmjs.org`, `binaries.soliditylang.org` |
| Outbound while running | **Deny-all**, verified before the links are shared |

**Steps (operator):**
1. `bash scripts/deploy-console/sandbox-station.sh setup-rehearsal <commit> <your deployer address>`. This clones the
   public repo at the pinned commit, `npm ci`, builds the rehearsal bundle with the real Forge scripts (placeholder
   Safe signers), and builds the console.
2. Switch outbound to deny-all, and verify that a request from inside fails.
3. `bash scripts/deploy-console/sandbox-station.sh start https://<sandbox host>`.
4. Verify from outside:
   - the console loads;
   - the RPC returns `eth_chainId 0x7a69`;
   - `anvil_setBalance`, `eth_sendTransaction`, a raw transaction signed for 46630 and a raw transaction from another
     account are all refused.
5. Send you the two links and the bundle hash.

**On your iPhone (Zerion):**
1. Select your **deployer** account.
2. Settings → Networks → **Add network manually**:
   - name `Rixor Rehearsal (local)`;
   - RPC URL: the station's `…/rpc` link;
   - chain ID **31337**;
   - symbol `ETH`.

   Select it. If iOS asks for Local Network access, allow it.
3. Zerion → **Browser** → open the console link (`…/deploy.html`).
   - Check the yellow **REHEARSAL · local chain 31337** banner.
   - Compare the bundle hash, character by character, with the one you were sent.
4. Tap **Connect wallet**. If needed, tap **Switch wallet to chain 31337**.
5. For each step 1 to 11:
   - tap **Check step N** and read the checks (all ✓);
   - tap **Ask wallet to sign step N**;
   - read Zerion's screen, then approve;
   - wait for **Step N verified**.

   For contract creations, note what Zerion shows: for example "Deploy contract", the data size, any warning.
6. At the end: **All 11 steps are on chain and verified**.

**Report back:**
- Zerion and iOS versions;
- whether adding the network worked;
- what Zerion showed for a creation (steps 3–8, especially step 6, the Locker) and for a call (steps 1, 9, 10);
- any warning or refusal;
- the final status.

Do not send your seed phrase, key or any signature.

**Pass criteria:** all 11 steps verified in the console, no refused relay requests from the console, and a station
log listing exactly 11 deployer transactions (nonces 0–10).

**Cleanup (operator):**
1. Stop the session (the station and the chain die with the VM).
2. Delete the sandbox and confirm no snapshots.
3. Confirm both links return 404 or 410.

You then delete the `Rixor Rehearsal (local)` network in Zerion.

## 6. Testnet ETH

Measured from the actual plan:
- **12,336,506 gas** in total;
- the Arbitrum L1 component is 0 at the current testnet setting;
- the sum of the 1.3× gas limits is **16,037,462 gas**.

| | Amount |
|---|---|
| At the observed 0.01 gwei | 0.000123 ETH used; worst case 0.00032 ETH (limits × 2 × price) |
| **Required in the deployer** before step 1 | The console checks each step's worst case. Hold **≥ 0.005 testnet ETH** (about 15× the worst case, same threshold as `preflight-testnet.mjs`). |
| Demo wallet (a different account) | About 0.002 testnet ETH covers dozens of faucet, lock, claim and challenge transactions |

**On your iPhone:**
1. In Zerion, copy your deployer address, or the demo wallet's address.
2. Open `https://faucet.testnet.chain.robinhood.com/` in Safari, the official faucet linked from Robinhood's docs. It
   runs a browser check first.
3. Paste the address, choose Robinhood Chain Testnet, and request ETH.
4. In Zerion, select the network **Robinhood Chain Testnet** (chain 46630; the console or the app can add it) and
   confirm the balance.

**Alternative:** get Sepolia ETH from any faucet and bridge it with the Arbitrum canonical bridge to Robinhood Chain
Testnet (about 10 minutes per Robinhood's docs).

The official faucet's limits are not documented publicly; claim early.

## 7. Real testnet deployment (only after written authorisation)

1. **Addresses.** You provide the seven public addresses (§4).
2. **Plan.** I run `node scripts/export-deploy-bundle.mjs --addresses deployments/addresses.json --created-at <T>
   --gas-price <P>` on a local fork of testnet. It:
   - re-checks the six-signer rules and that every signer is a plain EOA on testnet;
   - runs the four Forge scripts and `VerifyRixorV2` on the fork;
   - self-checks all 40 post-deployment checks;
   - prints the bundle hash, every address, every transaction, gas and funding.
3. **Review.** You review that output and give written authorisation for the deployment.
4. **Host the console.** One of:
   - a sandbox station in serve-only mode: `setup-testnet` with the same commit, addresses, `<T>` and `<P>`
     regenerates the **identical bundle hash** independently, and the hashes must match;
   - or the approved public V2 host, if the reviewed bundle is published there (a separate approval).
5. **Timing.** Rewards start at the **UTC midnight after the funding steps (10–11)**. Finish step 11 before
   **23:59 UTC** the day before you want visible rewards.
6. **On your iPhone, in Zerion:**
   - deployer account selected, network **Robinhood Chain Testnet (46630)**;
   - open the console link and check the blue **ROBINHOOD CHAIN TESTNET · chain 46630** banner;
   - compare the bundle hash;
   - then do steps 1–11 exactly as in the rehearsal, about 20 minutes.

   **Stop** at any ✕ or STOP. Do not send anything else from the deployer until all 11 steps are verified.
7. **Verify.** I run `VerifyRixorV2` (read-only) against testnet and re-run the console's assessment. The console
   shows the app manifest.
8. **Publish the manifest.** Publishing it to the V2 site (which enables the app's Testnet tab) is a **separate
   approval**.

## 8. If something goes wrong

| Situation | What the console does | What to do |
|---|---|---|
| You reject in the wallet | "Nothing was sent"; the step stays next | Check again, then sign again |
| Phone locks or the page reloads mid-step | On reload, it reads the chain: pending → waits; mined → verifies and continues | Reopen the same link and reconnect |
| Wrong network or account in Zerion | Check fails; nothing sent | Switch, then check again |
| Not enough testnet ETH | Check fails; nothing sent | Claim from the faucet (§6) |
| A step's result differs from the plan | **STOP** with the failed checks | Send nothing more from the deployer. Report. A new deployer and re-plan may be needed |
| Someone created a planned Safe first | **Halts before step 1**: "contract already exists" | Re-plan (the scripts skip the existing Safe; nonces shift) |
| A step reverts on chain | Verification fails (status 0); the nonce is used | Report. The plan must be regenerated from the new nonce |

## 9. Test coverage

**`npm run test:deploy-console`** (79 tests, local chains):
- pinned constants against the Forge build and the scripts;
- the exporter (including signer refusals and reproducible hashes);
- 24 tampered bundles, each re-hashed so the specific validator must catch it;
- the full 11-step run through preflight, the wallet request and verification;
- wrong chain, mainnet, wrong account, wallet-nonce disagreement, insufficient balance and rejection;
- out-of-order steps and duplicate prevention;
- interruption and resume;
- a pending transaction and the 19.6 KB Locker payload;
- verifying against the wrong step;
- completion;
- hostile chains: unrelated nonce use, a different contract at a predicted address, a pre-created Safe, a signer with
  EIP-7702 code.

**`npm run test:deploy-console-e2e`** (37 tests): the built page at iPhone size through the station, with a
Zerion-like wallet that signs locally and sends raw transactions:
- relay hardening;
- network add and switch (4902 → add);
- all 11 steps;
- reload and resume;
- rejection and retry at the Locker step;
- no overflow at 320 px;
- serve-only testnet mode;
- no raw transaction or signature in the logs.

Real-device behaviour in Zerion is **not tested yet** (§5).
