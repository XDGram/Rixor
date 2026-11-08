# Rixor protocol architecture (V2)

Status: **contracts, tests, deployment scripts and an in-browser demo. Nothing is deployed** on Robinhood Chain
testnet or mainnet. This document describes `contracts/RixorLocker.sol`, `contracts/RixorRewards.sol`,
`contracts/RixorChallenges.sol` and `contracts/interfaces/IRixorLocker.sol`.

Rixor is a meme-token **conviction and rewards** protocol on Robinhood Chain (chain id 4663). People who already
hold a community meme token lock it straight from their wallet for a chosen commitment, earn **$WIF from prefunded
reward streams**, and can join challenges. **$WIF is the reward and utility token. It is never needed to lock and is
not itself lockable.** The protocol supports many communities and depends on no single token.

The legacy contracts (`RixorSavings.sol`, `RixorConvictionVault.sol`, `contracts/testnet/*`, `contracts/test/*`) are
untouched and excluded from the Foundry build (`foundry.toml` → `skip`).

---

## 1. Components

```
              ┌──────────────────────────── Owner Safe (multisig) ───────────────────────────────┐
              │ timelocked: list token, change unit size, raise cap, upgrade class B→A,           │
              │             re-enable locks                                                         │
              │ immediate (risk-reducing): lower cap, downgrade class A→B, disable new locks        │
              │ creates & funds Season challenges (from its own WIF)                                │
              └───────────────┬───────────────────────────────────────────────────┬──────────────┘
   Guardian Safe ── pause / release token / emergency ──┐                          │
                                                        ▼                          ▼
 holders ── lock()/exit() ──►  RixorLocker  ◄── reads: positions, checkpoints, ──  RixorChallenges ◄── sponsors (WIF)
                               (principal)       releasedAt, emergency, paused        (per-challenge escrow)
                                    ▲
                                    └── reads ──  RixorRewards  ◄── funders (WIF streams)
                                                  (stream escrow)  ── claim → position owners, refund → funders
```

* **RixorLocker** holds principal and records per-token weight checkpoints. **It never calls Rewards or
  Challenges**, so exits cannot depend on them. Its only external calls are the locked token's own transfers.
* **RixorRewards** holds prefunded WIF streams. It reads the Locker; it cannot move positions. No owner, no admin.
* **RixorChallenges** holds per-challenge WIF escrow. It reads the Locker; it cannot move positions.
* No proxy, no oracle, no minting, no emissions, no protocol treasury.

## 2. RixorLocker

### 2.1 Tiers and positions

`lock(token, amount, tier, termDays)` creates a non-transferable position owned by `msg.sender`:

| Tier | Weight multiplier | Term | Exit before term end |
|---|---|---|---|
| Flexible (0) | 0.5× | none (`termDays` = 0) | any time, no fee |
| Committed (1) | 1.5× | 30 days up to the class maximum | allowed; fee = ceil(10% × remaining / duration), burned |
| Diamond (2) | 2.5× | 30–90 days, **Class A only** | not allowed (`StillLocked`) unless the token is released or an emergency is active |

* `weight = amount × tierMultiplier`, fixed at lock. There are no token multipliers and no boosts.
* `amount` must be 1–50 **unit sizes**; the token's `totalLocked` may not exceed its cap.
* Deposits use a **balance-delta check**: anything other than exactly `amount` received reverts `IncompatibleToken`.
* `exit(positionId, maxFeeBps)` writes `closedAt` and the exit checkpoint once, before any transfer
  (checks-effects-interactions plus a reentrancy guard). The fee goes to `0x…dEaD`; if the token refuses that
  transfer the exit still succeeds and the fee stays in the Locker permanently (`retainedFees`).

### 2.2 Risk classes

Risk classes limit **what a holder can commit to**. They never limit withdrawing one's own tokens: withdrawal safety
is a listing requirement (see `TOKEN_VETTING.md`), not a class.

| Class | Tiers | Max term | Intended for |
|---|---|---|---|
| A (1) | Flexible, Committed, Diamond | 90 days | deep, code-locked liquidity and widely spread holders |
| B (2) | Flexible, Committed | 60 days | tokens with higher market or concentration risk: holders can always leave early |

Downgrading A→B is immediate (existing positions keep their terms). Upgrading B→A is timelocked (48 h).
`allowedTiers(token)` returns the tier bitmask and maximum term the frontend shows.

### 2.3 Per-token release and global emergency

* `releaseToken(token)` (guardian or owner, **irreversible**): for an incident affecting one token. Every position
  in that token, including Diamond, can exit immediately with no fee; new locks in it stop for good; reward accrual
  for it stops at that timestamp; challenges stop accepting it. It moves no funds.
* `activateEmergency()` (guardian or owner, irreversible): the same for every token, plus a permanent pause.
  Running challenges become refund-only.
* `pause()` blocks new locks, challenge creation, sponsorship and joins. It never blocks exits, claims or refunds.

### 2.4 Weight checkpoints

Every lock and exit writes `Checkpoint(time, totalWeight)` for the token; several changes in one block collapse into
one checkpoint. Listing writes a genesis checkpoint with zero weight. A position stores the checkpoint index written
by its lock (`startCheckpoint`) and its exit (`endCheckpoint`). **A checkpoint stamped with the current block's
timestamp can still change in that block**, so readers only treat it as final in a later block.

### 2.5 Registry and roles

| Change | Delay | Bound |
|---|---|---|
| List a token (with its class) | 48 h timelock | code exists, decimals 6–18, `unit ≤ cap ≤ 2^128` |
| Change unit size | 48 h and ≥ 7 days since the last change | each step within [50%, 150%] |
| Raise cap | 48 h | at most 2× per step, ≤ 2^128 |
| Upgrade class B→A | 48 h | not for released tokens |
| Lower cap · downgrade A→B · disable new locks | immediate | risk-reducing only |
| Re-enable locks | 48 h | not for released tokens |

The owner must be a contract (a Safe) at construction and on every two-step transfer; there is no renounce. The
guardian is a contract set by the owner. **Neither role can move user principal, reward streams or challenge escrow.**

## 3. RixorRewards

* `fund(token, amount, days)`: anyone may fund a stream for a listed, not-released token: **10,000 WIF minimum**,
  **7–90 whole days**, starting at the **next UTC midnight**. `rate = floor(amount / seconds)`; the remainder is
  refunded later. Funding uses a balance-delta check.
* A stream only adds a rate change on its start day and end day, so there is **no cap on concurrent streams** and no
  loop over streams anywhere.
* `sync(token, maxSteps)` is permissionless and bounded: it integrates the token's checkpoints and UTC day
  boundaries in time order (`acc += rate × dt × 1e36 / totalWeight`; zero-weight seconds are counted instead).
  `claim` and `refund` call it with a caller-chosen step budget and revert `NeedsSync` / `NotReady` (losing
  nothing) if more catching up is needed.
* A position earns `weight × (acc_end − acc_start) / 1e36`, where `acc_end` is its exit checkpoint, or the current
  value (bounded by the stop time) if it is still open or exited after the stop. Rewards stay claimable after exit.
* Accrual for a token stops at `min(emergency, releasedAt(token))`. Each stream's refund to its funder is
  `rate × (zero-weight seconds in its window) + rate × (unstreamed seconds after the stop) + remainder`.
* No owner and no admin function. WIF leaves only as claims to position owners or refunds to funders.

Verified behaviour (see `test/RixorRewards.t.sol`): payouts match an independent BigInt reference model to the wei;
1,000 randomised runs conserve funds to within rounding dust; exits work without any Rewards contract and with a
reverting reward token; exit gas does not depend on the number of streams (300 streams tested).

## 4. RixorChallenges

* **Community challenges:** anyone; **1–3 distinct listed tokens**, any combination. **Season challenges:** the
  Locker owner only, up to 8 tokens, funded by the caller.
* The creator escrows 100,000–10,000,000 WIF; anyone may co-sponsor (≥ 10,000 WIF). Each challenge pays only from
  its own escrow.
* A position may be in at most one running community challenge and one running Season challenge.
* Scoring, fixed at join: `units = min(floor(amount / unitSnapshot), 10)`, `points = units × tierMultiplierBps`.
  Unit sizes (snapshotted at creation) make tokens comparable; every token counts equally. Released tokens cannot
  join.
* Qualification uses the Locker's write-once `closedAt` (open, or closed at/after `endTime`). Settlement is
  permissionless, batched, strictly after `endTime`. Success pays pro-rata for 30 days, then unclaimed WIF returns
  to sponsors; failure or emergency cancellation refunds each sponsor exactly.

Worked example (1,000,000 WIF pool; `test_scoring_workedExample`): 10 units Diamond = 250,000 points in any token;
3 units Committed = 45,000; 20 units Flexible (capped at 10) = 50,000.

## 5. Limitations

* **Rewards are prefunded, not yield.** WIF exists only where a sponsor funded a stream or challenge. Estimates
  shown in the app change as others lock and exit. Token prices can fall to zero while locked.
* **Points and units are relative scoring units**, not valuations; unit sizes lag price moves by design.
* **Sybil resistance is limited**: large holders can split across wallets. Caps, the 50-unit position limit and the
  10-unit scoring limit reduce, but do not remove, this.
* **Lazy accrual**: a token nobody syncs for a long time needs several bounded `sync` calls before claims succeed.
* **Unaudited.** No external review has been performed yet.

## 6. EVM target

Contracts compile with solc 0.8.30 for **Cancun** (`foundry.toml`). Robinhood Chain (Arbitrum Orbit) executes
Cancun opcodes on mainnet, and candidate tokens (for example TORCH) are compiled for Cancun, so fork tests must run
with the same rules.
