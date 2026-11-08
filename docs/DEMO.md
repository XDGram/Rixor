# Rixor demo: isolated in-browser EVM

The reviewable demo runs **Rixor's actual Gate 1 contracts inside the visitor's browser**, on an isolated
chain started from a verified snapshot of Robinhood Chain mainnet state. There is no server, no hosting cost,
no real network access and no deposit.

```
 Vercel (static)                       Visitor's browser
 ───────────────                       ────────────────────────────────────────────────────────────
 index.html, JS, CSS     ──────►       React app ──JSON-RPC──► SimChain (@ethereumjs/vm 10.1.3, Prague rules)
 /demo/robinhood-snapshot.json ──►                               ├─ real WIF code + storage (mainnet snapshot)
                                                                 ├─ Safe v1.5.0 singleton / factory / handler
                                                                 ├─ RixorLocker + RixorChallenges (compiled bytecode)
                                                                 └─ journal of operations ──► IndexedDB (this device)
```

## 1. The snapshot (`public/demo/robinhood-snapshot.json`)

`npm run demo:snapshot` (`scripts/build-browser-snapshot.mjs`) is read-only. It:

1. Pins the latest Robinhood Chain mainnet block.
2. Uses a throwaway **local** anvil fork only to *discover* touched accounts and storage slots with
   `eth_createAccessList`. It traces the full WIF ERC-20 surface (including transfers out of three large holders,
   which back the demo faucet), and a Safe v1.5.0 proxy creation plus `execTransaction`.
3. Reads every account's code and every discovered slot **directly from the upstream RPC at the pinned block**,
   and records keccak256 code hashes.
4. Verifies that the required contracts have code and that code is unchanged on re-read.

The current snapshot is block **109,291,187**: 7 accounts, 12 WIF storage slots, 72.5 KB.

## 2. Verification (`npm run demo:verify`)

`scripts/verify-browser-evm.mjs` bundles the **same engine code the browser runs** and checks:

- boot from the snapshot and first-visit setup (Safes, Locker, Challenges, seed activity);
- real WIF behaviour (symbol, total supply, balances);
- the complete journey against the actual bytecode: faucet, lock, create, join, sponsor, settle (with `NotEnded`
  enforced first), claim, failed goal then refund, sweep, the Diamond `StillLocked` rule, exit after term, and the
  lane rule;
- a **runtime dependency audit**: every message call with calldata must target an address that has code
  (precompiles excepted), so a missing snapshot dependency fails loudly instead of silently succeeding;
- **deterministic replay**: the saved journal re-executes to the identical chain (head hash, balances, events).

Latest result: 21/21 checks pass.

## 3. How a visit works

- **First visit:** the app downloads the snapshot, starts the EVM, and performs setup as real signed
  transactions (about 2.6 s on a desktop-class CPU, about 7 s with 4× CPU throttling). Setup deploys two 2-of-3
  Safes and the Gate 1 contracts, plus labelled **demo seed** challenges and **demo bot** lockers.
- **Every action** (lock, create, join, sponsor, settle, claim, refund, sweep, exit) is an ethers-signed transaction
  from the visitor's demo wallet, executed by the EVM. Receipts and events come from that execution.
- **Persistence:** the operation journal (signed raw transactions, faucet transfers and time changes) is saved in
  IndexedDB and re-executed on the next visit (about 0.9 s, or 4 s throttled, for a full journey). Nothing is
  stored as a precomputed result.
- **Demo faucet:** moves copied WIF from large mainnet holders *inside the isolated chain*, like anvil
  impersonation. Real balances are never touched. Gas is free in the simulation.
- **Simulation time:** "+1h / +1d / +7d / +31d" moves this device's chain clock so deadlines, claim windows and
  Diamond terms can be reached.
- **Reset:** Wallet → "Reset the whole simulation" erases this device's state and starts fresh.

## 4. Safety boundaries

- No network calls except loading the static app and snapshot from the same origin. No RPC, no backend.
- Simulation chain id 466399 (not 4663 or 46630). The engine refuses to start with a real Robinhood Chain id.
- The demo wallet key is generated on the device, stored only in IndexedDB, and never displayed or sent anywhere.
  Setup keys (deployer, Safe signers, bots) are discarded after setup. Replay needs only the signed transactions.
- Every balance is labelled demo or simulated, and a persistent strip reads "Browser simulation · Not live
  Robinhood Chain".

## 5. Limitations

- **Per-device state:** each visitor has their own isolated chain; nobody sees anyone else's actions. Leaderboards
  show the visitor and the demo bots.
- **Engine fidelity:** `@ethereumjs/vm` with Prague rules, not Robinhood Chain's ArbOS. Gate 1 contracts and WIF
  use standard EVM opcodes. Gas accounting differs slightly from ArbOS, and gas is priced at zero here.
- **Snapshot scope:** WIF storage is limited to slots the traced operations touch. Balances of other mainnet
  holders read as zero inside the simulation.
- **Replay time** grows with the journal: roughly 20 ms per operation unthrottled.
- **Private browsing** that blocks IndexedDB falls back to memory; the app says so, and state resets on close.
- **Browser wallets** (MetaMask and similar) cannot connect: the chain lives inside the page.

## 6. Optional: shared server-hosted chain

`demo/fork-backend` (Docker, anvil) remains in the repository for a future **shared** demo chain on paid
hosting. It is not used by the current app.

## 7. Commands

```bash
npm run demo:snapshot   # rebuild the snapshot (read-only; ~10 s)
npm run demo:verify     # headless verification of snapshot + engine + full journey
npm run build && npx vite preview --port 4173
npm run demo:e2e -- http://127.0.0.1:4173 ./shots      # mobile (iPhone 13) journey; THROTTLE=4 for slow CPU
```
