# Rixor Product Notes

## Current architecture direction

- Build EVM-first on testnets before deploying the final Rixor contract.
- Supported testnets in the app: Ethereum Sepolia and Robinhood Chain Testnet.
- Wallet-native balances are chain-specific and remain separate from Rixor savings state.
- Rixor should not imply that users must convert principal into USDG before saving.
- Principal is the asset the user chooses to deposit/save. For the current testnet flow, that asset is ETH.
- USDG is a reward/interest preference, not the default principal asset.
- Reward preference should be presented separately from the savings principal. Current planned choices: same asset or USDG.
- Do not fabricate USDG conversion values before an oracle/reward adapter is connected.

## Start a plan UX

- Start a Plan is a dedicated full-page in-app flow, not a popup and not a separate browser tab.
- The flow starts from the user's savings goal before showing financial controls.
- Current goal cards: Emergency fund, School fees, Rent, Long-term, Something else.
- Goal selection can suggest a timeline, but the user still chooses the plan.
- Plan choices: Flexible, 30 days, 90 days, 180 days, 1 year.
- Show access rules, maturity, APY, available chain balance, reward preference, and early-withdrawal implications before review.
- Locked-plan rule currently shown in product UI: principal remains intact; early withdrawal forfeits 50% of interest earned so far.
- Rates remain illustrative/not guaranteed until the economics and contracts are finalized.

## Withdraw UX

- Withdraw is a dedicated full-page in-app flow.
- Users choose the source before entering an amount: available balance, flexible plan, or locked plan.
- Available/flexible withdrawals should not imply a penalty when none applies.
- Locked-plan withdrawals must clearly separate principal returned, reward kept, and reward forfeited before review.
- Current early-withdraw rule shown in the UI: principal remains intact; 50% of interest earned so far is forfeited on early exit from a locked plan.
- Destination defaults to the connected wallet and is shown before review.
- Empty sources must say that no funds/positions are available instead of showing fake plan balances.
- Final testnet withdrawal stays disabled until the real Rixor contract is connected.

## UI direction

- Keep the high-end minimalist Rixor visual language already established.
- Reuse the supplied soft-card, progress, and wallet/pocket interaction patterns where they fit.
- Avoid chunky warning panels. Insufficient-balance states should be compact and red, with a clear top-up instruction.
- Keep wallet balance, saved principal, and earned rewards visually distinct.

## Testnet build rule

- UX may be complete before contracts are deployed, but final onchain actions stay disabled until they have a real testnet contract/token adapter.
- Never send test funds to placeholder addresses or fake successful contract interactions.
