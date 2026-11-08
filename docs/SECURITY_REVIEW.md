# Rixor V2 security review

Scope: `contracts/RixorLocker.sol`, `contracts/RixorRewards.sol`, `contracts/RixorChallenges.sol`,
`contracts/interfaces/IRixorLocker.sol`, the deployment scripts in `script/`, and the external contracts Rixor's
liquidity assumptions depend on. This is an **internal review by the implementing team, not an independent audit**.
An external review is required before any deployment that handles real user funds.

Toolchain: Foundry 1.7.1 (pinned via npm; run through `scripts/forge.mjs`, see F-2), solc 0.8.30, EVM **cancun**,
optimizer 200 runs, `via_ir = false`, forge-std v1.17.0. Runtime sizes: Locker 16.4 KB, Challenges 14.8 KB,
Rewards 9.0 KB (limit 24 KB). About 1,270 non-comment source lines.

---

## 1. Security requirements: status

| Requirement | Status | Where enforced / tested |
|---|---|---|
| No upgradeability | ✅ | No proxy, `delegatecall` or `selfdestruct` in any contract |
| No admin withdrawal of principal, streams or escrow | ✅ | No such function; `test_adminCannotMovePrincipal`; invariants `lockerSolvent`, `rewardsSolventAndConserved`, `noCrossChallengeOutflow` |
| Exits independent of Rewards and Challenges | ✅ | The Locker never calls them (`test_exit_makesNoCallsOtherThanTheToken` records every external call); `test_exit_worksWithoutAnyRewardsContract`, `test_exit_worksWhenRewardTokenIsBroken`; invariant `allowedExitsNeverRevert` |
| Exit gas independent of stream count | ✅ | `test_exitGas_independentOfStreamCount` (0 vs 300 streams) |
| Emergency and release never block exits, valid claims or refunds | ✅ | `_exitTerms`; `test_release_*`, `test_emergency_*`, `test_release_freezesThatTokenOnly` |
| Owner and guardian are Safes, never EOAs | ✅ | `_requireContract` rejects EOAs **and EIP-7702-delegated EOAs** (F-1); `test_roles_rejectEip7702DelegatedEoa` |
| Reject fee-on-transfer / incompatible tokens | ✅ | Balance-delta checks on every pull (Locker, Rewards, Challenges) |
| Checks-effects-interactions + reentrancy guards | ✅ | All state-changing externals that transfer are `nonReentrant`; reentrant-token tests |
| Reward conservation | ✅ | Wei-exact match with an independent reference model; 1,000 randomised runs incl. release/emergency; invariant |

## 2. RixorLocker

* **Flows.** In: `lock` (exact pull). Out: `exit` only, to the owner (`amount − fee`) and `0x…dEaD` (fee, or
  retained forever if refused).
* **Properties.** `closedAt` and `endCheckpoint` written once, before transfers; Committed fee monotonic and ≤ 10%;
  Diamond locked to `endsAt` except under release/emergency; class rules (no Diamond for Class B, max 60 days);
  checkpoint weight equals open weight (fuzz + invariant); same-block checkpoints collapse.
* **Privileged surface.** Owner: `transferOwnership`, `setGuardian`, `pause`, `unpause`, `activateEmergency`,
  `releaseToken`, `propose/cancel` for listing, unit, cap increase, class upgrade and enable-locks, `lowerCap`,
  `downgradeClass`, `disableLocks`. Guardian: `pause`, `activateEmergency`, `releaseToken`. Anyone: `execute*` for
  matured proposals, `acceptOwnership` (pending owner). Nothing else.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| L-1 | Medium (availability) | A compromised guardian can activate the irreversible emergency or release a token. Neither moves funds; both let every affected user exit at once. | Accepted by design. Guardian is a multisig with independent signers; monitor `EmergencyActivated` and `TokenReleased`. |
| L-2 | Low | Indefinite pause by the guardian. Exits and payouts continue; the owner can unpause and replace the guardian. | Accepted. |
| L-3 | Low | A listed token that could block transfers would block its exits. | Listing gate W in `TOKEN_VETTING.md` (no owner powers over transfers). |
| L-4 | Low | TORCH-style tokens need ~81k gas remaining for their first transfer out of the Locker. Too little gas reverts the exit cleanly; nothing changes. | Frontend and scripts never set gas limits; fork test `test_fork_torch_lowGasFirstExitRevertsCleanlyAndRetrySucceeds`; dry run checks the estimate. |
| F-1 | **Fixed** (Low) | `_requireContract` accepted an **EIP-7702-delegated EOA** (23 bytes of code) as owner or guardian. Found during the deployment dry run: anvil's default account is delegated on Robinhood mainnet. | Now rejected in the Locker and in `DeployRixorV2`; unit test added. |

## 3. RixorRewards

* **Flows.** In: `fund` (exact WIF pull). Out: `claim` to position owners (earned − claimed), `refund` to the
  stream's funder (once). No owner, no admin functions.
* **Accounting.** Lazy integration over Locker checkpoints and UTC day boundaries with 1e36 precision. Checkpoints
  stamped with the current block are not processed until a later block (fixes a same-block mutation bug found in the
  prototype). Accrual stops at `min(emergency, releasedAt)`.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R-1 | Low (liveness) | A token left unsynced for a long time needs several bounded `sync` calls before claims succeed (one step per day boundary or checkpoint). | `claim`/`refund` revert `NeedsSync`/`NotReady` without loss; anyone can `sync`; tested over a 400-day gap. |
| R-2 | Info | Rounding dust (a few wei per stream) stays in the contract. | Intended; bounded in tests. |
| R-3 | Info | Anyone can trigger `refund` for a finished stream; WIF always goes to the funder. | Intended. |
| R-4 | Info | Rewards trusts the Locker's checkpoints; a different Locker cannot be swapped in (`locker` is immutable). | Intended. |

## 4. RixorChallenges

Unchanged in structure from Gate 1 apart from: 1–3 tokens per community challenge, no WIF special case, no token
multiplier, the prize token passed explicitly, and released tokens refused at creation and join. Previously recorded
risks still apply: **Sybil splitting** and **slot-filling griefing** (sponsors should use `minTier ≥ Committed`
and `minUnitsPerEntry`), manual settlement, and rounding dust returned to sponsors.

## 5. Tooling findings

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| F-2 | **Fixed** (Medium, process) | The npm wrapper `@foundry-rs/forge/bin.mjs` (1.7.1) **always exits 0**, even when tests fail or a script reverts. `npm run test:contracts` could therefore never fail in CI. | All npm scripts now use `scripts/forge.mjs`, which propagates the binary's exit code. |
| F-3 | **Fixed** (process) | Fork tests ran on `shanghai`, so Cancun-compiled mainnet tokens (TORCH) failed with `NotActivated`. | EVM target is now `cancun`, matching the chain. |
| F-4 | **Fixed** (demo only) | The simulation's `eth_estimateGas` was a heuristic that under-estimated TORCH exits and reused warm storage between simulations. | Binary search for the minimum gas, from a cold EIP-2929 journal, as a real node does. |

## 6. Static analysis (Slither 0.11.6)

No high or critical findings. Medium findings were reviewed and are intentional: floor divisions for units and UTC
days (`divide-before-multiply`), strict equalities on timestamps and integration boundaries
(`incorrect-equality`), partial tuple reads (`unused-return`). One `uninitialized-local` was fixed for clarity.
Low findings: timestamp comparisons (by design), calls in loops (bounded by caller input or 200 participants),
missing zero checks (covered by `_requireContract`), one benign reentrancy note in `exit` (guarded).

## 7. External dependencies

* **Uniswap v4 PoolManager** `0x8366…0951` and **PositionManager** `0x58da…4fa7`: verified on Sourcify; the
  PositionManager has not been diffed line by line against Uniswap's official release.
* **Code-locked LP custodians** relied on for risk classes (FeeSplitter, TorchFactory, Pons launch locker,
  NoRemoveHook): reviewed from verified source; see `TOKEN_VETTING.md` §2. They affect market risk only, never
  withdrawal from Rixor.
* **Sequencer timestamps**: Robinhood Chain's sequencer sets `block.timestamp`; one-second boundaries are only as
  precise as the sequencer. Affects edge cases of fees and qualification, never custody.

## 8. Test evidence (V2)

| Suite | Tests | Result |
|---|---|---|
| `test/RixorLocker.t.sol` | 41 (4 fuzz × 1,000 runs) | pass |
| `test/RixorRewards.t.sol` | 18 (1 fuzz × 1,000 runs; wei-exact reference model) | pass |
| `test/RixorChallenges.t.sol` | 45 (2 fuzz × 1,000 runs) | pass |
| `test/invariant/RixorInvariants.t.sol` | 11 invariants × 256 runs × 200 calls, 0 reverts | pass |
| `test/fork/RixorFork.t.sol` | 8 (fresh mainnet fork; real HOOKR, TORCH, WIF; real 2-of-3 Safes) | pass |
| `npm run deploy:local-fork` | 11 checks: deploy, verify, guards, smoke journey with TORCH exit by node gas estimate | pass |
| `npm run demo:verify` / `demo:e2e` | 29 checks / 17 mobile UI steps | pass |

## 9. Unresolved risks before real funds

1. No independent audit.
2. PositionManager not diffed against official Uniswap sources.
3. Sybil splitting and slot-filling in open challenges.
4. Production units, caps and classes, Safe signers, and reward budgets are not decided.
5. NOVAAI awaits formal verification; DOPE remains conditional.
6. Sequencer timestamp trust.
