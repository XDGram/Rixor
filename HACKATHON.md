# Rixor: world is flat hackathon submission

**One-liner:** Diamond hands for $WIF. Lock it, and paper hands pay you.

**Categories:** hooks and defi · social and creators

## What it does

Holders lock $WIF on Robinhood Chain for 7 days, 30 days, 90 days, 180 days or 1 year. Breaking a lock early costs a paper-hands fee: up to 5% to 25% depending on the term, falling linearly to 0% at unlock. Every fee splits 50/50:

- **50% is burned** with $WIF's own `burn()`, so total supply drops onchain.
- **50% is paid to everyone still locked**, pro rata to lock weight (1x to 3x for longer terms), along with any rewards the exiting holder forfeits.

## The flywheel

1. Locking takes $WIF out of circulation.
2. Every early exit burns supply and pays the holders who stayed.
3. Holders come back to claim, check the leaderboard and relock for a bigger weight.
4. More $WIF is locked, so the next paper hand pays more people and burns more.

## Proof

- Contract: `contracts/RixorDiamondHands.sol`, with no owner, admin key, upgrade path or protocol fee.
- Tests: `npm run contract:test` covers fee decay, the 50/50 split, weighted rewards, forfeits, the only-holder full burn, ownership checks and solvency after every step.
- App: live totals, your locks with countdown and fee-now, a leaderboard and a feed of locks and paper hands, all read from contract state and events.
- Live link: https://rixor-eight.vercel.app
- Lock contract on Robinhood Chain: _add the address after deployment_
- Demo transactions: _add a lock, a claim and a paper-hand transaction after deployment_

## Notes

Rixor is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. $WIF comes with no promise of value or return. The contract has been tested but not audited.
