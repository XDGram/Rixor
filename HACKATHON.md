# Rixor: world is flat hackathon submission

**One-liner:** Tiered conviction locks for $WIF. Set an ROI target and a max loss, earn from early leavers, and win community challenges.

**Categories:** hooks and defi · social and creators

## What it does

- **Three tiers:** Flexible (1x reward weight, up to 1% fee in the first 7 days), Committed (1.5x, an ROI target, up to 10% fee falling over the term) and Diamond Hands (3x, no early exit; opens at the ROI target, the max loss or the end of a term of up to 365 days).
- **Live ROI** from your entry price, with clear withdrawal eligibility and a fee guard on every exit.
- **Rewards:** early-exit fees split 50/50 between burning and a commitment reward pool that pays out when commitments complete. Anyone can add to the pool.
- **Community challenges:** holding and performance challenges with sponsored reward pools, progress toward community targets, participant rankings and equal payouts to qualifiers.

## The flywheel

Stronger commitments earn more weight. Every early exit burns supply and funds the people who kept their word. Challenges give holders reasons to lock more and come back.

## Status: honest

- Contract and tests: done (`npm run contract:test`).
- Testnet vault: **not deployed yet.** This needs a deployer key, an existing burnable test token on Robinhood Chain Testnet, and the mock oracle.
- $WIF: the official mainnet token is integrated read-only. It is not on testnet, and **no verified $WIF price feed exists**, so locking real $WIF is blocked on a real oracle and a mainnet deployment.
- Simulation mode lets judges try every feature now; it is clearly labelled and sends nothing to any chain.

## Notes

Rixor is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. $WIF comes with no promise of value or return. The contract is tested, not audited.
