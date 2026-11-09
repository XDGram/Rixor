# Rixor V2: hackathon submission package

Prepared 9 Nov 2026 (about 13:00–15:00 UTC). Submissions close **12 Nov 2026, 17:30 UTC**; the app must stay live until
the final closes on **16 Nov 2026, 17:30 UTC**.

Everything here is preparation. **Nothing is deployed, signed, broadcast or submitted.** Items needing the owner's
decision are marked **[APPROVAL]**.

## 1. Official rules versus Rixor today

Source: worldisflat.fun/build/rules, read 9 Nov 2026.

| Rule | Requirement | Status |
|---|---|---|
| 3 | "your project has to use $wif onchain on Robinhood Chain" | **Not met yet.** Real $WIF exists only on mainnet (`0x5173…4773`). The simulation runs real contracts against mainnet $WIF bytecode, but inside the browser. Testnet would use **tWIF**, a valueless stand-in, not $WIF. See §2. |
| 4 | "stay live and working until the final closes" (16 Nov 17:30 UTC) | The simulation works with no backend. A **public** V2 URL does not exist yet (§5). |
| 5 | "a repo we can see, a demo video and real transactions" | The repo `github.com/XDGram/Rixor` is **public**. Demo video: **not recorded** (script in §8). Real transactions: **none yet**; testnet deployment needs authorisation (§3). |
| 6–7 | existing work allowed; needs a flywheel bringing people back to $WIF | Met in design: $WIF funds every stream and challenge (HACKATHON.md "flywheel"). |
| 9 | edits lock when submissions close | Submit early enough to fix mistakes before 12 Nov 17:30 UTC. |
| 11 | no Robinhood name or logo in the project name, logo or handles | Met: name "Rixor", own logo. The UI shows the non-affiliation notice. |
| Terms 4 | faked transactions or proof lead to disqualification | Simulation activity is labelled "Isolated EVM on this device… Not live Robinhood Chain". Never present it as real transactions. |
| Judging | "a real reason to use $wif, a flywheel that holds up, something that works and is built well" | Strong on build quality and flywheel. Weakest point: no real onchain $WIF use. |

## 2. Does testnet tWIF satisfy rule 3?

**Probably not as written.** The rule names $WIF onchain on Robinhood Chain, and $WIF has no testnet deployment. A
testnet deployment gives real, verifiable transactions on Robinhood Chain (chain 46630), but with a TEST token that
merely plays $WIF's role. Only the organisers can say whether that counts. Ask before relying on it.

**[APPROVAL] Draft message to the organisers.** Not sent. Send it from your own account to contact@worldisflat.fun, or
via X (@wifonrh):

> Hi World Is Flat team, I'm building Rixor (conviction locks for Robinhood Chain meme tokens, rewarded in $WIF;
> repo: github.com/XDGram/Rixor). Quick rules question on "use $wif onchain on Robinhood Chain" and "real
> transactions". Our contracts are finished and tested, and we plan to deploy them on Robinhood Chain testnet (46630)
> before the deadline. $WIF itself isn't on testnet, so the testnet version uses a valueless test token in $WIF's
> place for reward streams and challenge prizes. The app also reads real $WIF and meme-token balances on mainnet
> read-only. Would a testnet deployment with real testnet transactions satisfy the onchain and real-transaction
> requirements, or do you require real $WIF transactions on mainnet? We'd rather not put people's real funds into
> unaudited contracts during the hackathon. Thanks!

If they require mainnet $WIF, see §7, blocker B1.

## 3. Testnet deployment map

**Who signs what:**
- All **11 transactions are sent by the deployer D**, an ordinary wallet: a Ledger account used with Foundry on the
  Windows PC.
- **No transaction needs a Safe signature.**
- The six Safe signers only provide **public addresses** before transaction 1. The Safes are created with those owners
  in transactions 1–2.
- Safe (2-of-3) approvals are needed only **after** deployment, for administration: pause, release, listings and caps.
  None of that is needed for the demo.

**Fixed contracts:** Safe factory `0x14F2982D601c9458F93bd70B218933A6f8165e7b`, Safe v1.5.0.

Gas figures are from the local-fork plan, `npm run plan:testnet`. Addresses shown are from **placeholder** signers.
The real ones are produced by re-running the plan with the seven real addresses.

| # | Nonce | Step | Destination | Action | Gas | Predicted address (placeholder run) |
|---|---|---|---|---|---|---|
| 1 | 0 | safes | Safe factory | createProxyWithNonce: owner Safe, owners O1–O3, 2-of-3 | 296,282 | `0x8cA1Ba0e8E86D28C80753C1D33818E4431aa1e09` |
| 2 | 1 | safes | Safe factory | createProxyWithNonce: guardian Safe, G1–G3, 2-of-3 | 296,270 | `0x0a8e57735Dc9bA254Ed656e8a2C7671227b17E1b` |
| 3 | 2 | tokens | contract creation | tMEMEA (18 dec, 1B to D, Class A unit 1,000, cap 20M) | 568,203 | `0x527C41D1334D35794C20a648466F5a7aF99b8040` |
| 4 | 3 | tokens | contract creation | tMEMEB (6 dec, 1B to D, Class B unit 1,000, cap 10M) | 568,119 | `0x0b2a100CA1DA42E7c101E17833A7F04da4DF5898` |
| 5 | 4 | tokens | contract creation | tWIF (18 dec, 1B to D, reward only) | 568,179 | `0xc8D1883Df343D34e5423962270b29b160Cd00822` |
| 6 | 5 | rixor | contract creation | RixorLocker(owner Safe, guardian Safe, the two listings) | 4,098,296 | `0xE477f4FE3142B2A5dE45d42B0e86f7608555c844` |
| 7 | 6 | rixor | contract creation | RixorRewards(Locker, tWIF) | 2,027,354 | `0xcBB4d1b0668b138dB9A64022dFd16166Ec4eFe3E` |
| 8 | 7 | rixor | contract creation | RixorChallenges(Locker, tWIF, minHold 3,600 s) | 3,307,452 | `0x4118262465bD135109d9152C93ddaCd3A7c4F713` |
| 9 | 8 | seed | tWIF | approve(Rewards, 210,000 tWIF) | 46,175 | — |
| 10 | 9 | seed | RixorRewards | fund(tMEMEA, 140,000 tWIF, 14 days) | 308,138 | — |
| 11 | 10 | seed | RixorRewards | fund(tMEMEB, 70,000 tWIF, 14 days) | 252,038 | — |

- Total gas: **12,336,506**. At the last observed gas price (0.01–0.018 gwei) that is about **0.00012–0.00023 testnet
  ETH**. The preflight requires at least **0.005 testnet ETH** in D.
- The listings are set in the Locker's constructor, so **no 48-hour timelock** delays the demo.
- The reward streams start at the next UTC day and run 14 days, which covers judging to 16 Nov.
- After deployment, `VerifyRixorV2` checks everything read-only. Publishing `deployments/46630.json` to the app (which
  enables the Testnet tab) is a **separate [APPROVAL]**.

## 4. Testnet ETH, wallets and devices

- **Testnet ETH:** official faucet `https://faucet.testnet.chain.robinhood.com/`, named in Robinhood's support
  article. It sits behind a browser check, so its limits couldn't be read here; claim it in your own browser.
  Alternative: bridge Sepolia ETH (per Robinhood's docs).
- **Deployer D:** forge needs a **PC with the Ledger on USB** (Windows CMD, `docs/LEDGER_WINDOWS_CMD.md` and
  `docs/TESTNET_DEPLOYMENT.md` §5). An iPhone cannot run the deployment.
- **Zerion on iPhone** is for using the app (judges and you), not for deploying:
  - Open the V2 URL in Zerion's in-app browser.
  - The app adds and switches to chain 46630 itself; that logic is tested against six wallet error styles
    (`npm run test:wallet-switch`).
  - Get testnet ETH, then TEST tokens from the in-app faucets.
  - The real-device Zerion steps are **[DEVICE TEST]**; see `docs/WALLET_IPHONE_DRILL.md`.
- **Ledger drill status:**
  - Verified from source and tests: Cast signs EIP-712 in hash-only mode. The device shows only "Domain hash" and
    "Message hash", and Blind signing must be enabled.
  - **Not yet done on a physical Ledger.**
  - The drill is required **before Safe administration**, not before deployment. The deployment itself only needs D's
    Ledger to sign ordinary transactions. The forge transaction screens are also unconfirmed on a device: check that
    chain ID 46630 is shown on the first transaction.

## 5. Public V2 demo URL

**Current state (verified):**
- Vercel project `rixor` uses **Standard Protection**: every preview URL redirects to a Vercel login.
- The V2 previews for this branch are built and READY, but **not publicly reachable**.
- The only public URL, `https://rixor-eight.vercel.app`, serves **V1** from `main`.

**[APPROVAL] Options.** None touches V1 production. In order of preference:
1. **New Vercel project `rixor-v2`** from the same repo, with its production branch set to `claude/nice-gauss-bjmvku`.
   - It gets a public `rixor-v2*.vercel.app` URL (production URLs are public under Standard Protection).
   - Free on Hobby. Leaves the V1 project and its settings untouched.
   - Settings to use: framework Vite, build `npm run build`, output `dist`. Do not add environment variables.
2. **Disable Vercel Authentication for previews** on project `rixor` (Settings → Deployment Protection).
   - The branch URL `rixor-git-claude-nice-gauss-bjmvku-…vercel.app` becomes public and updates with each push.
   - Downside: every past and future preview of the project becomes public.
3. A Vercel share link: these expire, so they are unsuitable for a demo that must stay live until 16 Nov.

## 6. Shortest practical execution plan

| When (UTC) | Who | Action |
|---|---|---|
| 9 Nov | You | (a) Send the §2 organiser message. (b) Approve a §5 option. |
| 9–10 Nov | You | Claim testnet ETH for D at the faucet. Collect the six signer **public** addresses (`docs/LEDGER_WINDOWS_CMD.md` §1–2). Confirm D's Ledger shows its address. |
| 10 Nov | Claude | Validate the seven addresses. Run the final plan (local fork). Present every address, transaction, nonce and gas figure for review. |
| 10–11 Nov | You | Written deployment authorisation. Then run `docs/TESTNET_DEPLOYMENT.md` §5.4 on the PC with D's Ledger: four steps, about 11 confirmations, preflight before each, then VerifyRixorV2. |
| 11 Nov | You → Claude | [APPROVAL] to publish the testnet manifest. Claude commits it; the V2 URL gets the Testnet tab. Claude re-runs the testnet journey against the live deployment. |
| 11 Nov | You | Do a few real testnet transactions in the app (faucet, lock, claim) as the "real transactions" proof. Record the demo video (§8). |
| by 12 Nov 12:00 | You | Submit on worldisflat.fun: name, one-liner, categories, repo, live link, video, transaction links. Leave buffer before the 17:30 lock. |

## 7. Blockers

| ID | Blocker | Impact | Resolution |
|---|---|---|---|
| B1 | Rule 3 names $WIF; testnet uses tWIF | Possible ineligibility | Organiser answer (§2). If mainnet is required, that is a new decision: a mainnet deployment and a production token listing, both explicitly not approved so far. It also needs real $WIF funding (≥ 10,000 WIF per stream) and has no external audit. Not recommended in three days. |
| B2 | No public V2 URL | Judges can't try V2 | §5 approval |
| B3 | Seven distinct public addresses (six signers on separate devices, recommended six people) | Testnet deployment can't start | You gather them. The scripts refuse any overlap. |
| B4 | Testnet ETH for D (≥ 0.005) | Deployment can't start | Faucet (§4) |
| B5 | Deployment authorisation and a PC with D's Ledger | No real transactions | You |
| B6 | Demo video not recorded | Rule 5 | You record (§8 script) |
| B7 | Forge/Ledger transaction screens unconfirmed on a device | Possible confusion while signing | Reject unless chain ID 46630 is shown; report what the screen shows |
| B8 | Real Safari/WebKit not tested; iPhone checked by Chromium emulation only | Small layout or wallet risk | Open the public URL on your iPhone (Safari and Zerion) once B2 is resolved |

## 8. Demo walkthrough and video script (about 3 minutes)

Record on the public V2 URL. Say clearly which parts are simulation and which are real testnet.

1. **(0:00) Problem, 15 s.** "Meme holders have no reason to stay; communities have no way to reward the ones who
   do. Rixor lets holders lock the meme token they already hold and earn $WIF for their conviction."
2. **(0:15) Explore, 20 s.** Connect a real wallet read-only: Rixor detects which supported Robinhood Chain tokens it
   holds (mainnet, read-only, nothing signed). Show HOOKR and TORCH "under review", Class B.
3. **(0:35) Simulation, 60 s.** Point to the banner: "Isolated EVM on this device… not live Robinhood Chain".
   - Get demo tokens.
   - Lock HOOKR Committed for 60 days: Diamond is unavailable for Class B; no WIF is needed to lock.
   - Create a challenge, join it and sponsor it with WIF.
   - Advance time, settle and claim.
   - Show reward streams paying WIF by weight.
4. **(1:35) Real testnet, 50 s** (only after deployment). Switch to Testnet:
   - connect Zerion or MetaMask;
   - get TEST tokens from the faucet;
   - lock tMEMEB;
   - claim tWIF.

   Open one transaction on `explorer.testnet.chain.robinhood.com` to show it is real. Say "tWIF is the testnet stand-in
   for $WIF".
5. **(2:25) Architecture, 25 s.**
   - Three contracts; the Locker never depends on the others for exits.
   - Two 2-of-3 Safes with six distinct hardware-wallet signers; timelocked listings.
   - 139 Foundry tests, invariants, and fork tests against real HOOKR and TORCH bytecode.
6. **(2:50) Flywheel, 10 s.** "$WIF funds streams and challenges → holders lock longer to earn more → committed
   communities fund the next round."

**One-liner:** Conviction locks for Robinhood Chain meme tokens: lock what you hold, earn $WIF from prefunded streams,
win $WIF challenges.

**Categories:** hooks and defi · social and creators · games.

**Description:** use `HACKATHON.md`, sections "What it does", "How $WIF is used" and "Status (honest)".

**Technical summary:** `HACKATHON.md` "Architecture" and `docs/ARCHITECTURE.md`.
