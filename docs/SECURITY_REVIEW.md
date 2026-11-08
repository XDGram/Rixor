# Rixor Gate 1 security review

Scope: `contracts/RixorLocker.sol`, `contracts/RixorChallenges.sol`, `contracts/interfaces/IRixorLocker.sol`, plus a
review of the external contracts Rixor's liquidity and pricing assumptions depend on. This is an **internal
review by the implementing team, not an independent audit**. An external audit is recommended before any
mainnet deployment beyond a capped pilot.

Toolchain: Foundry 1.7.1 (forge/anvil/cast pinned in `package.json`), solc 0.8.30, EVM `shanghai`, optimizer
200 runs, `via_ir = false`, forge-std v1.17.0 (`f3dae6e6…`). Runtime sizes: Locker 12,498 bytes, Challenges
14,873 bytes (both below the 24,576-byte limit).

---

## 1. Security requirements: status

| Requirement | Status | Where enforced / tested |
|---|---|---|
| No upgradeability | ✅ | No proxy, no `delegatecall`, no `selfdestruct`; immutable `WIF`, `locker`, `minHold` |
| No admin/guardian withdrawal of user principal | ✅ | No such function exists; `test_adminCannotMovePrincipal`, invariant `lockerSolvent` |
| No admin/guardian withdrawal of challenge escrow | ✅ | Escrow leaves only via `claim`/`refund`/`sweep` to entitled callers; invariants `noCrossChallengeOutflow`, `sponsorReceiptsBounded`, `payoutEligibilityRespected` |
| Emergency never blocks exits, valid claims or refunds | ✅ | `_exitTerms` returns (true, 0) under emergency; payouts don't check pause; `test_emergency_*`, `test_pause_doesNotBlockSettleClaimRefundSweep`, invariant `payoutEligibilityRespected` |
| Safe is owner from construction, never an EOA | ✅ | Constructor and `transferOwnership` require `code.length > 0`; fork test deploys with a real 2-of-3 Safe v1.4.1 as owner |
| 2-of-3 Safe design, no signers chosen | ✅ | Fork tests use throwaway keys only; `LAUNCH_RUNBOOK.md` leaves signers blank |
| No hidden privileged functions | ✅ | Full privileged surface listed in §2.4 and §3.4 |
| Reject fee-on-transfer / incompatible tokens | ✅ | Balance-delta checks on every pull (`IncompatibleToken`); decimals 6–18; tests with fee, false-return, no-return, bad-decimals tokens |
| Validate every external token interaction | ✅ | Low-level calls check success and optional bool return; `balanceOf` responses length-checked |
| Checks-effects-interactions + reentrancy protection | ✅ | State written before transfers everywhere; `nonReentrant` on all state-changing externals that transfer; reentrant-token tests on both contracts |

## 2. RixorLocker

### 2.1 Asset flows

* **In:** `lock` only (pull with exact balance-delta check).
* **Out:** `exit` only, to the position owner (`amount − fee`) and to `0x…dEaD` (`fee`). If the burn transfer
  fails, the fee is kept forever (`retainedFees`) — there is no function that can move it.
* Per-token accounting (`totalLocked`) means a misbehaving token cannot affect positions in other tokens.

### 2.2 Verified properties

* `closedAt` is written once (in `exit`, before transfers) — invariant `closedAtWriteOnce`, unit `test_exit_onlyOwnerAndOnce`.
* Committed fee: ceil(1000 × remaining / duration) bps, monotonically non-increasing, 0 at `endsAt`, never above 10%
  (`testFuzz_committedFeeMonotonicAndBounded`, 1,000 runs; boundary tests at start, mid-term, `endsAt − 1`, `endsAt`).
* Diamond: `StillLocked` at `endsAt − 1`, exit allowed at exactly `endsAt`.
* `maxFeeBps` protects users from a higher fee than they saw (`FeeTooHigh`).
* Bounds: `unit ≤ amount ≤ 50 × unit`, cap per token, term 30–90 days, Flexible term must be 0.
* Unit changes: within [50%, 150%] per step, 48 h timelock, ≥ 7 days between changes, bounds re-checked at execution.
  Cap raises ≤ 2× per step, timelocked; cap lowering and disabling locks are immediate (risk-reducing only).

### 2.3 Findings and accepted risks

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| L-1 | Medium (availability) | A compromised guardian (or owner) can activate the irreversible emergency. That ends new activity and cancels running challenges; it cannot move funds, and every user can exit immediately. | Accepted by design. Guardian must be a 2-of-3 Safe with independent signers; monitor `EmergencyActivated`. |
| L-2 | Low | A guardian can pause indefinitely. Exits and payouts continue; only the owner can unpause, and the owner can replace the guardian. | Accepted. |
| L-3 | Low | If a listed token later gains the ability to block transfers (it is not upgradeable, but e.g. a blacklist), exits of that token could revert. | Mitigated by vetting: listed tokens must have no owner/blacklist/pause/upgrade surface (`docs/TOKEN_VETTING.md`). |
| L-4 | Low | The owner can list a harmful token after 48 h public notice, and scoring in *new* challenges that allow it could be affected. | Accepted. Timelock gives users notice; accounting is per token; challenges choose their tokens. |
| L-5 | Info | Fees retained in `retainedFees` when the burn address rejects a transfer are irrecoverable. | Intended (equivalent to burning). |
| L-6 | Info | Positions are non-transferable. | Intended (prevents trading qualified positions). |

### 2.4 Complete privileged surface

Owner: `transferOwnership`, `setGuardian`, `unpause`, `pause`, `activateEmergency`, `proposeListing`/`cancelListing`,
`proposeUnitAmount`/`cancelUnitAmount`, `proposeCapIncrease`/`cancelCapIncrease`, `lowerCap`, `disableLocks`,
`proposeEnableLocks`/`cancelEnableLocks`. Guardian: `pause`, `activateEmergency`. Anyone: `acceptOwnership` (pending
owner only), `execute*` for matured proposals. **Nothing else.**

## 3. RixorChallenges

### 3.1 Asset flows

* **In:** `createChallenge`/`createSeason`/`sponsor` (exact WIF pull, balance-delta checked).
* **Out:** `claim` (qualified participant of a successful challenge), `refund` (sponsor of a failed or cancelled
  challenge, exactly their contribution, once), `sweep` (sponsor of a successful challenge after the claim window,
  pro-rata of a one-time snapshot of the remaining escrow, once).
* Every payout decrements the specific challenge's `escrow` and the global `totalEscrow`; Solidity checked arithmetic
  makes an over-payment revert rather than draw on another challenge.

### 3.2 Verified properties (invariant suite, 256 runs × 200 calls each, `fail_on_revert = true`)

| Required invariant | Test |
|---|---|
| Total escrow always covers all outstanding challenge liabilities | `invariant_escrowCoversLiabilities` (`totalEscrow == Σ escrow`, WIF balance ≥ `totalEscrow`) |
| A position cannot occupy two community lanes or two Season lanes simultaneously | `invariant_laneExclusivity` (every pair of joins of one position in one lane is non-overlapping) |
| `closedAt` can only be written once | `invariant_closedAtWriteOnce` |
| Total claims never exceed the funded pool | `invariant_claimsBoundedAndConserved` (`claimed ≤ pool`; `claimed + refunded + swept + escrow == pool`; claims and refunds mutually exclusive) |
| A sponsor cannot receive more than their refundable contribution | `invariant_sponsorReceiptsBounded` |
| One challenge cannot use another challenge's escrow | `invariant_noCrossChallengeOutflow` (each payout's WIF outflow equals that challenge's escrow decrease) |
| Emergency activation cannot interfere with already-settled claims | `invariant_payoutEligibilityRespected` (no eligible claim/refund/sweep ever reverted, including after the randomly-triggered emergency; no ineligible one ever succeeded) |
| (additional) Locker solvency | `invariant_lockerSolvent` (balance ≥ `totalLocked`, cap respected, Σ open positions == `totalLocked`) |

### 3.3 Findings and accepted risks

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| C-1 | Medium (economic) | **Sybil splitting.** The 10-unit cap per entry and one entry per address mean a holder can split a large position across wallets for more points. | Accepted and documented (`ARCHITECTURE.md` §4). Sponsors control `minUnitsPerEntry`, `minTier` and `maxParticipants`. |
| C-2 | Medium (griefing) | **Slot filling.** An attacker can fill `maxParticipants` with minimum-size Flexible positions and exit later (losing only gas), crowding out real participants. | Sponsors should use `minTier ≥ Committed` (exit costs a fee) and a higher `minUnitsPerEntry` for open challenges. Consider a join bond in a future version. |
| C-3 | Low | Settlement is permissionless but not automatic; an unsettled challenge keeps funds escrowed until someone calls `settle`. | Accepted; any sponsor or participant can settle. A full 200-participant settle fits in one transaction (< 15M gas, `test_settle_twoHundredParticipantsInBatches`). |
| C-4 | Low | Pro-rata division rounds down; dust (< 1 wei per claimant) stays in escrow until swept. | Intended; tested (`test_scoring_workedExample`, fuzz `testFuzz_payoutsNeverExceedPool`). |
| C-5 | Info | Lane release on cancellation (tightening change 4) is implicit: joins are impossible after an emergency, so a cancelled challenge never blocks a lane that could otherwise be used. | Documented. |
| C-6 | Info | `referrer` is an unvalidated, emitted-only field. Off-chain consumers must not trust it. | Documented. |
| C-7 | Info | Season creation is authorised against `locker.owner()` at call time; after an ownership transfer, existing Season refunds still go to the original funding Safe. | Intended. |

### 3.4 Complete privileged surface

`createSeason` (Locker owner only, funded by the caller). No owner, no admin setters, no pausing of its own, no
withdrawal or rescue function. It reads `paused` and `emergencyActivatedAt` from the Locker.

## 4. The eight tightening changes

| # | Change | Implementation | Test |
|---|---|---|---|
| 1 | Lane frees when the referenced challenge has ended | `join` treats a lane as occupied only while `endTime > now` | `test_lanes_sequentialReuseAfterEnd` (`endTime − 1` reverts, `endTime` succeeds) |
| 2 | Season challenges owner-only | `createSeason` requires `locker.owner()` | `test_createSeason_ownerOnlyAndManyTokens` |
| 3 | No settlement for emergency-cancelled challenges; single emergency switch in the Locker | `_isCancelled` reads `locker.emergencyActivatedAt()`; `settle` reverts `Cancelled` | `test_emergency_*` |
| 4 | Season lane also frees on cancellation | Implicit (C-5) | `test_emergency_cancelsRunningChallengeAndRefunds` |
| 5 | Settle strictly after `endTime` | `block.timestamp <= endTime` reverts | `test_settle_onlyStrictlyAfterEnd` |
| 6 | Join requires open position, `now ≤ joinDeadline`, `joinDeadline + minHold ≤ endTime`, Committed/Diamond `endsAt ≥ endTime` | `join`, `_create` | `test_join_*`, `test_create_timingBoundaries` |
| 7 | Unit sizes from a 7-day median with bounded, timelocked changes | Locker bounds + timelock + 7-day interval; median process in runbook | `test_unitAmount_boundedTimelockedAndRateLimited`, `test_unitChangeAfterCreationDoesNotAffectSnapshot` |
| 8 | Sponsor-set `minUnitsPerEntry` | `CreateParams.minUnitsPerEntry` (1–10) | `test_join_validation`, `test_unitIncreaseCanDropSmallPositionsBelowMinimum` |

## 5. Static analysis (forge lint)

* 15 × `block-timestamp`: intended. All timing (terms, deadlines, timelocks) is in hours or days.
* 11 × `unsafe-typecast`: all reviewed and bounded — `uint64` casts of `block.timestamp` plus at most 90 days or
  48 hours, `uint8(decimals)` after a 6–18 range check, `uint32` participant cursors bounded by 200.
* Position `amount` is stored as `uint256` (no truncation).

## 6. Chain-level assumptions

* **Sequencer timestamps.** Robinhood Chain is an Arbitrum Orbit chain whose sequencer sets `block.timestamp` within
  protocol bounds. One-second boundaries (`endTime`, `joinDeadline`, `endsAt`) are therefore as precise as the
  sequencer's timestamps. A misbehaving sequencer could shift a borderline exit across a boundary. This affects only
  edge cases of qualification and fee size, never custody.
* **EVM target.** Contracts compile for `shanghai` (PUSH0). Tokens on this chain are compiled with solc 0.8.35 and
  run newer opcodes, so `shanghai` is a conservative target. Fork tests execute the contracts against live state.
* **$WIF is a plain ERC-20.** Verified on Sourcify as `PonsV2LauncherToken` (solc 0.8.35); no owner, no proxy, no
  mint/blacklist/fee functions; all fork transfers exact. RixorChallenges assumes this permanently (it is immutable).

## 7. External dependency review: Pons liquidity locker and pools

Reviewed at Robinhood Chain block ≈ 109,227,966 (8 Nov 2026).

### 7.1 RobinFunFiV2LaunchLocker `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952`

**Verified (source and on-chain state):**
* Sourcify `match`, `src/v2/RobinFunFiV2LaunchLocker.sol`, solc 0.8.26. No EIP-1967 implementation slot (not a proxy).
* `Ownable2Step`; `renounceOwnership` always reverts. Owner `0x263ed295dAFaE1d9AAdD6E56c4B6F9f38eE019Dd`,
  `pendingOwner` = 0.
* The owner's only function is `setFactory`, which is one-time and already set to
  `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`. The owner has no remaining power over locked assets.
* The factory can only call `lockPosition` / `lockTokenSupply`, which **add** locks.
* `onERC721Received` accepts NFTs only from the PositionManager.
* **There is no withdraw, transfer, approve, `setApprovalForAll`, `call` or `delegatecall` path** in the source.
* The WIF launch LP NFT (PositionManager tokenId **511448**) is owned by the locker, and `getApproved(511448)` = 0.
  The locker also holds 8.16% of the WIF supply via `lockTokenSupply`, with no transfer path.

**Uncertain / not verified:**
* The PositionManager `0x58daec3116aae6D93017bAAea7749052E8a04fA7` is a Sourcify `match` for `PositionManager`
  (solc 0.8.26) and gates position actions with `onlyIfApproved`. It has **not** been diffed line by line against
  Uniswap's official v4-periphery release, and an earlier source reported that Uniswap has not published an official
  PositionManager deployment for this chain. If this PositionManager had a hidden path, the LP could be at risk.
* Only the main pool was attributed in detail; WIF has 27 v4 pools, most of them small.

**Conclusion:** Based on the verified sources reviewed, neither the locker owner nor the factory can withdraw the WIF
launch liquidity, and no code path in the locker can move it. **We do not describe this liquidity as "permanently
locked"** until the PositionManager is confirmed to be identical to an official Uniswap v4-periphery build. Even
then, locked liquidity protects against an LP rug pull, not against price declines.

### 7.2 Pons hook on the WIF pool `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` (PonsV2MemeHook)

* Sourcify `match`. Owner `0x263ed295…` (same as the locker owner); `renounceOwnership` reverts.
* Hook permissions: `beforeInitialize`, `afterSwap`, `afterSwapReturnDelta` only. **No add- or remove-liquidity
  hooks**, so the hook cannot block or redirect liquidity withdrawals or deposits.
* The swap fee charged by `afterSwap` is read from the pool's registration snapshot (`launches[poolId].hookFeeBps`),
  not from the owner-settable global. Owner setters (`setHookFeeBps` ≤ 10%, protocol share, recipients, sweep
  operator) affect future launches and fee distribution, not this pool's LP. `rescuePoolFees` pays only accrued
  swap fees to the protocol and creator.
* Uncertain: the snapshotted fee value for the WIF pool was not read on chain, and fee distribution logic
  (`PonsV2BuybackVault`) was not reviewed in depth. Neither affects Rixor custody.

### 7.3 DOPE main pool `0xde60e54e…9442`

* No hook. 100% of in-range liquidity is in PositionManager tokenId **3841115**, owned by `0x…dEaD` with
  `getApproved` = 0. Assuming nobody controls the key for `0x…dEaD` (the standard assumption), that liquidity cannot be
  withdrawn — subject to the same PositionManager caveat as §7.1.

### 7.4 Uniswap v4 PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`

* Has an owner (`0x2BAD8182…46CD`) and a protocol fee controller (`0x6d000950…314c`). In standard v4, these can set a
  bounded protocol fee on swaps but cannot move LP principal. Not independently audited here.

## 8. Test evidence (Gate 1 run)

| Suite | Tests | Result |
|---|---|---|
| `test/RixorLocker.t.sol` | 30 (3 fuzz × 1,000 runs) | pass |
| `test/RixorChallenges.t.sol` | 45 (2 fuzz × 1,000 runs) | pass |
| `test/invariant/RixorInvariants.t.sol` | 8 invariants × 256 runs × 200 depth (51,200 calls each, 0 reverts) | pass |
| `test/fork/RixorFork.t.sol` | 3 (fresh fork, real WIF and DOPE, real Safe v1.4.1 2-of-3) | pass |

The two Locker test failures and the one Challenges test failure observed during development were defects in the
tests (wrong guardian after rotation; amount above the 50-unit maximum; DOPE disabled before the valid-shape section),
not in the contracts, and were corrected without weakening any assertion. A handler arithmetic overflow in the
invariant suite was also fixed, after which `fail_on_revert` was enabled.

## 9. Unresolved risks before mainnet

1. No independent audit yet.
2. PositionManager not diffed against official Uniswap sources (§7.1).
3. Sybil splitting and slot-filling griefing in open challenges (C-1, C-2).
4. DOPE holder distribution is unusually flat and launch-timed (see `TOKEN_VETTING.md`). This is a Sybil/farming
   consideration for DOPE challenges, not a custody risk.
5. Production unit sizes and caps not yet chosen; Safe signers not yet chosen; Season budget not approved.
6. Sequencer timestamp trust (§6).
