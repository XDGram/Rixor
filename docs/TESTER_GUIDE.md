# Rixor Tester Guide

Rixor is currently a **testnet build**. Use test ETH only.

## Supported testnets

- Sepolia
- Robinhood Chain Testnet

## Recommended test sequence

1. Connect an EVM wallet.
2. Switch to one of the supported testnets.
3. Confirm the displayed wallet balance and chain logo are correct.
4. Add a small amount of test ETH to Rixor.
5. Confirm the deposit loading state and transaction-confirmed animation.
6. Create a Flexible plan and a locked plan.
7. Open the locked plan and verify principal, term, progress, and maturity information.
8. Use **Add more** and confirm the plan principal increases.
9. Use **Extend plan** and verify the new longer term/maturity.
10. Attempt an early withdrawal before maturity.
11. Check that the early-exit fee is shown with enough ETH precision and that the approximate USD loss is red and prefixed with a minus sign.
12. Confirm the withdrawal and verify that the confirmation animation appears before returning to the dashboard.
13. Check Recent Movement and Completed & Withdrawn history.
14. Withdraw any remaining available Rixor balance to the connected wallet.
15. Repeat the important flows on the second supported testnet.

## Failure cases worth testing

- Reject a wallet signature.
- Try an amount larger than the available wallet balance.
- Try an amount larger than the Rixor available balance.
- Switch to an unsupported chain.
- Switch chains while navigating between Rixor pages.
- Refresh/reopen the app after a successful transaction.
- Test narrow/mobile viewport layouts.

## What is not yet implemented

The final `$RIXOR` reward token/treasury/vesting system is not live in the current smart contract. ETH savings behavior is real testnet contract behavior; `$RIXOR` reward presentation should be treated as future product direction during this test round.

## Reporting a bug

Please include:

- the network used;
- wallet/browser;
- action being attempted;
- expected behavior;
- actual behavior;
- transaction hash if one exists;
- screenshot or screen recording if possible.
