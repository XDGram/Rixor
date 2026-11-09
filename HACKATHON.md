# Rixor: World Is Flat hackathon submission

**One-liner:** Conviction locks for Robinhood Chain meme tokens. Lock a token you already hold, earn $WIF from
prefunded reward streams, and win $WIF in community challenges.

**Categories:** hooks and defi · social and creators · games

## What it does

- **Lock what you already hold.** Holders lock a supported community meme token straight from their wallet. No $WIF
  and no new token is needed to lock.
- **Three conviction tiers** (time only, no price oracle):

  | Tier | Reward weight | Term | Exit |
  |---|---|---|---|
  | Flexible | 0.5x | none | any time, no fee |
  | Committed | 1.5x | 30–90 days | early exit costs up to 10%, falling linearly to 0 at the end of the term |
  | Diamond | 2.5x | 30–90 days | no exit before the end of the term |

  Early-exit fees are burned (sent to `0x…dEaD`) in the locked token.
- **Risk classes per token.** Class A allows every tier up to 90 days. Class B, for tokens with thinner code-locked
  liquidity, allows Flexible and Committed only, up to 60 days. Classes limit what a holder can commit to, never what
  they can withdraw.
- **$WIF reward streams.** Anyone (a token community, a project, a whale) can fund a $WIF stream for a listed token:
  at least 10,000 $WIF over 7 to 90 days. It pays every open position in that token by weight (amount x tier). Time
  with nobody locked is refundable to the funder.
- **$WIF challenges.** Anyone can create a challenge for 1–3 listed tokens by escrowing at least 100,000 $WIF. Holders
  join with a locked position, sponsors can add $WIF, and anyone can settle once it ends. Holders who kept their
  position through the end share the pool by points (units x tier). A failed challenge refunds its sponsors, and
  unclaimed rewards return to sponsors after 30 days.

## How $WIF is used, and the flywheel

$WIF is the reward and prize currency: it funds every reward stream and every challenge pool, and it is what lockers
and challenge winners earn.

1. Token communities and projects fund $WIF streams and challenges to reward their committed holders.
2. Holders lock for longer to earn a bigger share, and come back to claim $WIF and join the next challenge.
3. Committed and Diamond locks keep tokens committed for a term (a Committed holder who leaves early pays a fee that
   is burned), which gives communities a reason to fund the next stream or challenge with more $WIF.

## Architecture

| Contract | Role |
|---|---|
| `contracts/RixorLocker.sol` | Principal custody, tiers, risk classes, per-token weight checkpoints. Exits never depend on any other contract. |
| `contracts/RixorRewards.sol` | Prefunded $WIF streams. No owner and no admin function. |
| `contracts/RixorChallenges.sol` | Per-challenge $WIF escrow, joining, settlement, claims and refunds. No admin can move escrow. |

- No proxy, no upgrade path, no oracle, no minting, no emissions and no treasury. No account can move a user's
  principal except that user, through `exit()`.
- Locker administration is held by two separate 2-of-3 Safes (owner and guardian). Listings, unit changes and cap
  increases are timelocked for 48 hours. Risk-reducing actions (pause, release one token, emergency) are immediate
  and only ever make exits easier.
- Frontend: React and Vite (`src/protocol`). It talks to the contracts through ethers v6, and the same views and
  write paths are used in every mode.

## Try it

| Mode | What runs | Transactions |
|---|---|---|
| **Simulation** (default) | The real V2 contracts inside your browser, on an isolated chain started from a verified snapshot of Robinhood Chain mainnet state, with the real $WIF, HOOKR and TORCH token code | Real EVM transactions inside your browser, signed by a throwaway demo wallet; nothing reaches a network |
| **Testnet** (appears once a deployment manifest is published) | The same contracts on Robinhood Chain testnet with valueless TEST tokens (tMEMEA, tMEMEB, tWIF) | Signed by your own wallet |
| **Real wallet, read-only** (Explore page) | Detects which supported meme tokens you hold on Robinhood Chain mainnet | None; only your address is read |

In the simulation you can lock tokens, see your tier, claim $WIF rewards, create, join, sponsor, settle and claim
challenges, and move the simulation clock forward to see a full challenge finish in minutes.

## Status (honest)

- **Contracts:** done and tested. 131 Foundry tests pass (unit, invariant and signer checks). A separate fork suite
  (`test/fork/`) exercises the real HOOKR and TORCH token contracts. Internal review only; **no external audit**.
- **Simulation demo:** complete. The end-to-end browser journey passes 17/17 steps, covering locks, tiers, rewards,
  both challenge outcomes, refunds and exits.
- **Testnet:** **not deployed yet.** The deployment is scripted and rehearsed: on a local chain, the rehearsal passes
  13/13 checks and the testnet-mode browser journey passes 11/11 steps (connect, faucet, lock, rewards, claim, early
  exit). Real testnet transactions will be linked here once the contracts are deployed. A mobile Deploy Console
  (`docs/DEPLOY_CONSOLE.md`) can send the same 11 deployment transactions from a phone wallet; it is tested on local
  chains only.
- **Mainnet:** not deployed, and **no production token is listed or approved**. HOOKR and TORCH appear in the
  simulation only, as candidate Class B tokens under review.

## Notes

Rixor is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. $WIF comes with no
promise of value or return. The contracts are tested but not audited. Simulation and TEST-token balances have no value.
