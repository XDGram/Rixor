# Rixor demo: isolated in-browser EVM plus read-only wallet detection

The reviewable demo has two parts:

1. **Simulation.** Rixor's actual V2 contracts (Locker, Rewards, Challenges) run **inside the visitor's browser** on
   an isolated chain started from a verified snapshot of Robinhood Chain mainnet state, with real HOOKR, TORCH and
   WIF code. No server, no hosting cost, no deposit. Every lock, claim and exit is a real transaction executed by the
   in-browser EVM.
2. **Real wallet, read-only.** A visitor can connect a real wallet to see which of their Robinhood Chain meme
   tokens Rixor supports. Only an address is shared; no signature or transaction is ever requested.

```
 Vercel (static)                     Visitor's browser
 ───────────────                     ───────────────────────────────────────────────────────────────────
 index.html, JS, CSS     ──────►     React app ──JSON-RPC──► SimChain (@ethereumjs/vm 10.1.3, Prague rules)
 /demo/robinhood-snapshot.json ──►                             ├─ real WIF, HOOKR, TORCH code + storage
                                                               ├─ Safe v1.5.0 singleton / factory / handler
                                                               ├─ RixorLocker + RixorRewards + RixorChallenges
                                                               └─ journal ──► IndexedDB (this device)
                                     Wallet detection ──eth_call──► public Robinhood Chain RPC (Multicall3, read-only)
```

## Modes

| Mode | What it does | Transactions |
|---|---|---|
| **Simulation** (default) | V2 contracts in the browser, real HOOKR/TORCH/WIF code | Simulated, demo wallet |
| **Real wallet, read-only** (Explore page) | Detects Robinhood Chain mainnet holdings | None |
| **Testnet** (tab appears once a deployment manifest is published) | The visitor's own wallet on Robinhood Chain testnet against the deployed contracts and TEST tokens | Real testnet transactions; wallet estimates gas |

Switching modes always disconnects the wallet. Testnet mode refuses a manifest or RPC on chain 4663; its signer is
bound to the manifest's chain id, and any wallet account or network change disconnects it.

## 1. The snapshot (`public/demo/robinhood-snapshot.json`)

`npm run demo:snapshot` (`scripts/build-browser-snapshot.mjs`) is read-only. It pins the latest mainnet block,
discovers touched accounts and slots on a throwaway **local** fork with `eth_createAccessList` (WIF, HOOKR and TORCH
ERC-20 surfaces including transfers from their faucet reserve holders, plus Safe v1.5.0 creation and execution),
then reads code and every slot **directly from the upstream RPC at the pinned block** and verifies code hashes.

Current snapshot: block **109,445,894**: 11 accounts, 101 KB.

## 2. What the simulation sets up

On first visit, as real signed transactions: two 2-of-3 demo Safes; RixorLocker listing **HOOKR (Class A)** and
**TORCH (Class B)** with provisional demo units and caps; RixorRewards; RixorChallenges (1-hour minimum hold for the
demo); two **demo WIF streams** (140,000 WIF over 14 days for HOOKR, 70,000 WIF over 14 days for TORCH); a
community challenge and a Season challenge for HOOKR + TORCH; and three labelled demo bot lockers.

**HOOKR and TORCH are candidate tokens listed in the simulation only, for testing. Neither is approved for
production listing**, and the UI says so wherever they appear.

## 3. A visit

- **Get demo tokens**: the faucet moves copied HOOKR and TORCH (to lock) and WIF (to sponsor) from large mainnet
  holders *inside the isolated chain*. Real balances are never touched. Gas is free.
- **Lock** a token from the demo wallet. The approval is always for the selected token and the exact amount. Tiers
  and terms follow the token's class: Diamond is unavailable for TORCH; TORCH terms stop at 60 days.
- **Earn WIF** from the streams; the Portfolio shows claimable WIF per position (computed by simulating the claim)
  and offers Claim all. Anyone can fund a new stream from a token's page.
- **Challenges**: create with 1–3 tokens, join, sponsor, settle, claim, refund, sweep.
- **Simulation time**: +1h / +1d / +7d / +31d moves this device's chain clock.
- **Persistence**: the journal is saved in IndexedDB and re-executed on the next visit.

## 4. Real wallet detection (`src/protocol/wallet.ts`)

- Wallets are discovered with EIP-6963 (falls back to `window.ethereum`). The app requests `eth_requestAccounts`
  only, and can ask the wallet to switch to or add Robinhood Chain.
- Balances for every token in `src/protocol/tokenlist.ts` are read in **one Multicall3 `aggregate3` call** to the
  public RPC (which allows browser requests), at the RPC's current L2 block.
- Tokens are grouped **Supported / Under review / Unsupported**. **Supported requires a listing in an on-chain Rixor
  Locker** (set `VITE_RIXOR_LOCKER_4663` once one is deployed). None is deployed, so nothing is shown as supported
  on mainnet. The token list is metadata only and can never grant support.
- Limitation: only token-list entries are checked. A future indexer (holdings API behind a server-side key) could
  show every token; it would be display-only.

## 5. Verification

```bash
npm run demo:snapshot   # rebuild the snapshot (read-only)
npm run demo:verify     # headless: snapshot + engine + full V2 journey + deterministic replay (29 checks)
npm run build && npx vite preview --port 4173
npm run demo:e2e -- http://127.0.0.1:4173 ./shots   # iPhone 13 journey through the real UI (17 steps)
```

The e2e journey includes the read-only detection step: a test-only EIP-1193 stub shares the public address of a
large HOOKR holder and signs nothing; the page then reads that address's real balances from Robinhood Chain mainnet.

## 6. Safety boundaries

- Simulation chain id 466399 (not 4663 or 46630). The demo wallet key is generated on the device, stored only in
  IndexedDB, and never displayed or sent. Setup keys are discarded after setup.
- The only network traffic besides the static site is read-only `eth_call` / `eth_blockNumber` for wallet detection.
- Every simulated balance is labelled demo; a persistent strip reads "Browser simulation · Not live Robinhood Chain".

## 7. Limitations

- Per-device state: nobody sees anyone else's simulation.
- Engine fidelity: `@ethereumjs/vm` with Prague rules, not ArbOS. Gas estimation binary-searches the smallest gas
  limit that succeeds, starting each simulation from a cold EIP-2929 journal, so contracts that check `gasleft()`
  (TORCH) behave as they do with a real node's `eth_estimateGas`.
- Snapshot scope: only traced storage slots are copied; other holders' balances read as zero inside the simulation.
- Browser wallets cannot sign for the simulation (its chain lives in the page).

`demo/fork-backend` is the superseded Gate 1 Docker backend; it still deploys Gate 1 contracts and is not used.
