# Rixor: World Is Flat hackathon submission

**One-liner:** Lock the meme token you already hold and get paid in $WIF for holding it.

## The demo (Rixor Lite)

One smart contract on Robinhood Chain mainnet, one lockable token (HOOKR), rewards in the official $WIF.

1. **Connect** your wallet on Robinhood Chain.
2. **Lock** HOOKR you already hold. Each lock is held for 1 day.
3. **Earn** $WIF every second while it is locked, in proportion to your share of everything locked.
4. **Claim** whenever you like: real $WIF moves from the reward wallet to your wallet.
5. **Exit** after the lock period: you get back exactly what you locked.

## How $WIF is used, and the flywheel

$WIF is the only reward currency. A reward wallet commits a $WIF budget; lockers earn it second by second.

1. A community or project funds a $WIF budget to reward its committed holders.
2. Holders lock to earn a share, and come back to claim $WIF.
3. Locked tokens stay off the market for the lock period, which gives the community a reason to fund the next budget.

## Architecture

| Piece | Role |
|---|---|
| `contracts/RixorLite.sol` | Holds locked HOOKR, tracks what each locker has earned, pays claims. About 150 lines. |
| Reward wallet | A separate wallet holding the $WIF budget. It approves the contract to pay claims from it. |
| Frontend (`src/lite`) | One page: connect, lock, earn, claim, exit. React, Vite, ethers v6. |

- **No admin at all.** The contract has no owner, no pause, no upgrade path and no fee. Every parameter is fixed at
  deployment. The only way a locked token leaves is `exit()` by the wallet that locked it.
- **Rewards never touch principal.** The contract never holds $WIF. A claim moves $WIF from the reward wallet straight
  to the claimer. An exit never calls the reward token or the reward wallet, so nothing about rewards can block a
  withdrawal.
- **What you are trusting.** The reward wallet is one key. It can stop funding rewards (then claims fail until it is
  refilled; what you earned stays recorded). It can never move a locked token.
- **Limits.** Minimum lock 10 HOOKR; the contract holds at most 100,000 HOOKR in total.

Planned parameters: 1,000 $WIF over 7 days (about 143 $WIF a day, shared), 1-day lock.

## Status (honest)

- **Contract:** done and tested. 25 Foundry tests (unit, fuzz and invariants: custody is exact, rewards never exceed
  the budget), plus 3 fork tests with the real HOOKR and $WIF token code. Internal review only; **no external audit**.
- **Mainnet:** **not deployed yet.** The deployment is two transactions (deploy, then approve the $WIF budget),
  scripted, rehearsed on a local fork of Robinhood Chain mainnet, and gated until approved. The full journey through
  the real UI passes on that fork (12 steps). Real transaction links will be added here once it is live.
  See `docs/LITE_DEMO.md`.
- **Not in the demo:** the larger design (three conviction tiers, several tokens, community challenges, Safe-governed
  listings) is built and tested in this repository (`contracts/RixorLocker.sol`, `RixorRewards.sol`,
  `RixorChallenges.sol`, `src/protocol`) but is not deployed and is hidden in the app.

## Notes

Rixor is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. $WIF comes with no
promise of value or return. The contract is tested but not audited.
