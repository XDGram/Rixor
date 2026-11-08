# Rixor protocol architecture (Gate 1)

Status: **contracts and tests only. Nothing is deployed.** This document describes `contracts/RixorLocker.sol`,
`contracts/RixorChallenges.sol` and `contracts/interfaces/IRixorLocker.sol` as implemented for Gate 1.

Rixor is a multi-token meme **conviction-locking** protocol on Robinhood Chain (chain id 4663). Holders lock
curated meme tokens for a chosen time commitment. $WIF is the reward and incentive token: community challenges
and Season challenges distribute **prefunded** $WIF pools to holders who keep their positions locked.

The legacy contracts (`RixorSavings.sol`, `RixorConvictionVault.sol`, `contracts/testnet/*`, `contracts/test/*`)
are untouched and excluded from the Foundry build (`foundry.toml` → `skip`). They are not part of this design.

---

## 1. Components

```
                ┌──────────────────────────── Owner Safe (2-of-3) ───────────────────────────┐
                │ timelocked: list token, change unit size, raise cap, re-enable locks        │
                │ immediate (risk-reducing): lower cap, disable new locks, pause, emergency   │
                │ creates & funds Season challenges (from its own WIF)                         │
                └───────────────┬──────────────────────────────────────────────┬──────────────┘
                                │                                              │
     Guardian Safe ──pause / emergency──┐                                       │ createSeason()
                                        ▼                                       ▼
 holders ── lock()/exit() ──►  RixorLocker  ◄──── positionOf / multipliers ──  RixorChallenges  ◄── sponsors
                               (principal)        emergencyActivatedAt / paused  (per-challenge WIF escrow)
                                   │                                                │
                         early-exit fee → 0x…dEaD                         claim / refund / sweep (pull)
```

* **RixorLocker** holds principal. It knows nothing about challenges and never pays rewards.
* **RixorChallenges** holds only $WIF reward escrow. It reads positions from the Locker but can never move them.
* There is no third contract, no proxy, no oracle and no token minted by Rixor.

## 2. RixorLocker

### 2.1 Positions

`lock(token, amount, tier, termDays)` creates a non-transferable position owned by `msg.sender`:

| Tier | Multiplier | Term | Exit before term end |
|---|---|---|---|
| Flexible (0) | 0.5× (5,000 bps) | none (`termDays` must be 0) | any time, no fee |
| Committed (1) | 1.5× (15,000 bps) | 30–90 days | allowed; fee = ceil(10% × remaining / duration), falls linearly to 0 |
| Diamond (2) | 2.5× (25,000 bps) | 30–90 days | not allowed (`StillLocked`) |

Token multiplier: $WIF 2.0× (20,000 bps), every other listed token 1.0×. All multipliers are compile-time constants.

* `amount` must be between 1 and 50 **unit sizes** of the token, and the token's `totalLocked` may not exceed its cap.
* Tokens are pulled with a **balance-delta check**: if the Locker receives anything other than `amount`
  (fee-on-transfer, rebasing at transfer time) the call reverts `IncompatibleToken`. A `false` return reverts
  `TransferFailed`. Tokens returning no data (USDT style) are accepted.
* `exit(positionId, maxFeeBps)` — position owner only. `maxFeeBps` is slippage protection for the time-dependent fee.
  `closedAt` is written exactly once, here, before any token transfer (checks-effects-interactions + reentrancy guard).
* The fee is sent to `0x000000000000000000000000000000000000dEaD`. If the token refuses that transfer, the exit still
  succeeds and the fee is recorded in `retainedFees[token]`: it stays in the Locker forever because no function can
  withdraw it (economically a burn). Exits can never be blocked by the burn address.

### 2.2 Token registry

Each listed token has `unitAmount` (the "one unit" size used for scoring), `maxTotalLocked` (cap) and a
`locksEnabled` flag. The initial list is passed to the constructor; later changes follow:

| Change | Delay | Bound |
|---|---|---|
| List a token | 48 h timelock, executable by anyone after | must pass on-chain validation (code exists, decimals 6–18, `cap ≥ unit`) |
| Change unit size | 48 h timelock **and** ≥ 7 days since the last change | each step within [50%, 150%] of the current unit |
| Raise cap | 48 h timelock | at most 2× the current cap per step |
| Lower cap | immediate | must be lower; cancels a pending raise |
| Disable new locks | immediate | existing positions unaffected |
| Re-enable locks | 48 h timelock | — |

Unit sizes are intended to track a **7-day median** value (an off-chain process documented in
`LAUNCH_RUNBOOK.md`); the on-chain bounds and delays limit how far and how fast any change can move scoring.

### 2.3 Roles

* **Owner** — must be a contract at construction and on every transfer (a Safe; enforced by `extcodesize`). Two-step
  transfer (`transferOwnership` → `acceptOwnership`). There is no `renounceOwnership`.
* **Guardian** — a contract (Safe) set by the owner. Can `pause()` and `activateEmergency()`. The owner can do both too.
* `pause()` blocks **new** locks, challenge creation, sponsorship and joins. It never blocks exits, settlement, claims,
  refunds or sweeps. Only the owner can `unpause()`.
* `activateEmergency()` is **irreversible**: it records `emergencyActivatedAt`, pauses permanently, and makes every
  position — including Diamond — exitable immediately with no fee.
* Neither role has any function that transfers user principal or challenge escrow.

## 3. RixorChallenges

### 3.1 Lanes

There are two lanes:

* **Community challenges** (`createChallenge`) — anyone may create one. Token set: one listed token, optionally
  plus $WIF as the second token (`[TOKEN, WIF]`), or $WIF alone.
* **Season challenges** (`createSeason`) — only the Locker owner (the Safe) may create them, funding them from its own
  $WIF. Up to 8 listed tokens.

A position may be in **at most one running community challenge and at most one running Season challenge at the same
time** (they stack). A lane is occupied until the referenced challenge's `endTime` has passed, after which the position
can join a new challenge in that lane even before the old one is settled. (Joins are impossible after an emergency,
so a cancelled challenge never needs to release a lane.)

### 3.2 Creation and funding

* The creator escrows the full pool at creation: **100,000 – 10,000,000 WIF**. The challenge's own `escrow` field is
  the only source of its payouts, so one challenge can never spend another's funds.
* Anyone may co-sponsor (≥ 10,000 WIF, until `endTime`, total pool ≤ 10,000,000 WIF). Each sponsor's
  `contributionOf` is recorded.
* Rules fixed at creation: token list, minimum tier, `minUnitsPerEntry` (1–10), `joinDeadline`, `endTime`,
  `goalPoints`, `maxParticipants` (1–200), title (≤ 80 bytes) and description (≤ 2,000 bytes).
* Timing: `now < joinDeadline`, `joinDeadline + minHold ≤ endTime`, `endTime ≤ now + 30 days`. `minHold` is an
  immutable constructor parameter bounded to 1 hour – 7 days; **production uses 24 hours**. Demo deployments may use a
  shorter `minHold` without changing production code.
* At creation the challenge **snapshots** each allowed token's unit size and token multiplier. Later registry changes
  never affect an existing challenge.

### 3.3 Joining and scoring

`join(id, positionId, referrer)` requires: protocol active (not paused, no emergency), `now ≤ joinDeadline`, one entry
per address, below `maxParticipants`, caller owns the position, position open, token allowed, tier ≥ `minTier`, and for
Committed/Diamond `endsAt ≥ endTime` (Flexible positions have no end). `referrer` is emitted only; it earns nothing.

```
units  = min( floor(amount / unitSnapshot), 10 )        must be ≥ 1 and ≥ minUnitsPerEntry
points = units × tierMultiplierBps × tokenMultiplierSnapshot / 10_000
```

Points per entry range from 5,000 (1 unit, Flexible, 1.0× token) to 500,000 (10 units, Diamond, $WIF). Points are
computed once, at join.

Worked example (1,000,000 WIF pool; tested in `test_scoring_workedExample`):

| Participant | Position | Points | Payout |
|---|---|---|---|
| Alice | 70,000 WIF (10 units) Diamond | 10 × 25,000 × 20,000 / 10,000 = 500,000 | 591,715.98 WIF |
| Bob | 10 DOPE units Diamond | 250,000 | 295,857.99 WIF |
| Carol | 3 DOPE units Committed | 45,000 | 53,254.44 WIF |
| Dan | 20 DOPE units Flexible (capped at 10) | 50,000 | 59,171.60 WIF |
| **Total** | | **845,000** | dust < 4 wei, returned to sponsors |

### 3.4 Qualification and settlement

* Qualification is decided from the Locker's write-once `closedAt`: a participant qualifies if the position is still
  open (`closedAt == 0`) or was closed **at or after** `endTime`. Closing even one second before `endTime` disqualifies.
* `settle(id, maxItems)` is permissionless, batched, and allowed only **strictly after** `endTime`. Because
  `closedAt` cannot change, settlement order and timing cannot change the result.
* When the last participant is processed: `success = qualifiedPoints > 0 && qualifiedPoints ≥ goalPoints`, and the
  claim window opens for 30 days.

### 3.5 Payouts (all pull-based)

| Outcome | Who | Amount |
|---|---|---|
| Successful | each qualified participant, once, until `claimDeadline` (inclusive) | `pool × points / qualifiedPoints` (rounded down) |
| Successful, after `claimDeadline` | each sponsor, once | `remainingEscrow × contribution / pool` — unclaimed rewards and dust return pro-rata |
| Failed (goal missed or nobody qualified) | each sponsor, once | exactly their contribution |
| Cancelled by emergency | each sponsor, once | exactly their contribution |

### 3.6 Emergency semantics

A challenge is **cancelled** iff the emergency was activated while it was still running
(`emergencyActivatedAt < endTime`) and it is not settled. Cancelled challenges cannot settle; sponsors refund in
full. A challenge whose `endTime` had already been reached when the emergency began (`endTime ≤ emergencyActivatedAt`)
still settles and pays normally. Settled challenges are never affected: claims and sweeps continue.

## 4. Scoring limitations (read before using points for anything)

* **Points are relative scoring units, not fair USD valuations.** A unit of DOPE and a unit of $WIF are set to be
  roughly comparable when unit sizes are chosen; they are not price-equivalent at any later moment.
* **Cross-token fairness deteriorates as prices change.** If one token's price doubles after its unit size was set,
  its holders need half the value for the same points until the unit size is updated. Updates are timelocked,
  rate-limited and bounded, so they lag the market by design.
* **Unit-size controls reduce manipulation risk but do not eliminate it.** The owner can move a unit by at most
  ±50% per step, at most once per 7 days, with 48 hours' public notice, and only new challenges are affected. A
  determined owner could still bias future challenges over several weeks; a token's market price can also be pushed
  around the 7-day median window.
* **Sybil resistance is limited.** One entry per address and a 10-unit cap per entry mean a large holder can split
  across many wallets to earn more points. `maxParticipants` (≤ 200) can be filled by cheap Flexible positions that
  later exit (griefing); sponsors can mitigate by setting `minTier` (Committed/Diamond) and `minUnitsPerEntry`.
* **Reward pools are prefunded.** Every WIF paid out was deposited by a sponsor before or during the challenge. There
  is no emission, no minting and no protocol treasury.
* **Locking does not generate yield or guaranteed returns.** Locked tokens sit idle in the Locker. Rewards exist only
  if someone sponsors a challenge, the participant qualifies, and the challenge succeeds. Token prices can fall to
  zero while locked, and Diamond positions cannot be exited to limit losses (except in an emergency).

## 5. Out of scope for Gate 1

Frontend integration, deployment, Safe signer selection, Season budget and funding, production unit sizes and caps,
and any change to legacy contracts or product features. See `LAUNCH_RUNBOOK.md` for the configuration that a later,
separately approved deployment would require.
