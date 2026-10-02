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
- Show access rules, maturity, available Rixor balance, reward preference, and early-withdrawal implications before review.
- v0.1 has no reward engine. Early plan exit returns principal and emits whether the exit was early, but reward paid/forfeited values remain zero.
- Any displayed rates are illustrative rates and are not enforced or paid by the current testnet contract.

## Withdraw UX

- Available-balance withdrawal is a dedicated full-page in-app flow and only calls `withdrawAvailable(...)`.
- Savings-plan exits are initiated from the exact Plan Detail page so `withdrawPlan(planId)` always targets a known onchain plan ID.
- Destination defaults to the connected wallet and is shown before review.
- v0.1 never fabricates reward or penalty amounts; plan withdrawal returns principal and the contract emits the `earlyExit` flag with zero reward fields.
- Locked-plan early exits now charge a time-decaying fee: 30 days starts at 2%, 90 days at 4%, 180 days at 6%, and 1 year at 8%. The fee declines linearly to 0% at maturity. Flexible plans remain fee-free.
- Early-exit fees accrue onchain as protocol fees and can only be withdrawn by the deployment fee recipient.
- Confirmed plan withdrawals are removed from Active Plans and reconstructed into Plan History from `PlanWithdrawn` events.

## Onchain account history

- The connected wallet address is the user identity for account loading.
- Active plans should come from Rixor contract state keyed by wallet address.
- Deposits, plan starts, available withdrawals, and plan withdrawals are reconstructed from contract events/logs for that wallet.
- The dashboard should hydrate Active Plans and Recent Activity automatically after wallet connection and network changes.
- No traditional private user-history database is required as the source of truth.
- For production-scale querying, use an RPC/indexer service to read chain logs efficiently; the indexed data remains a cache/query layer over onchain truth, not the authoritative account ledger.
- Plan detail pages should be derived from the same contract state and event history.

## UI direction

- Keep the high-end minimalist Rixor visual language already established.
- Reuse the supplied soft-card, progress, and wallet/pocket interaction patterns where they fit.
- Avoid chunky warning panels. Insufficient-balance states should be compact and red, with a clear top-up instruction.
- Keep wallet balance, saved principal, and earned rewards visually distinct.

## Testnet build rule

- Onchain actions are enabled only when a real contract address exists for the selected supported testnet.
- Never send test funds to placeholder addresses or fake successful contract interactions.
- Current build remains testnet-only. No mainnet deployment or mainnet funds are supported.

## RixorSavings v0.1 contract

- Solidity contract: `contracts/RixorSavings.sol`.
- v0.1 accepts native testnet ETH deposits and records a per-wallet available balance.
- Users can move available balance into Flexible / 30 / 90 / 180 / 365 day plan records.
- Plan metadata includes reward preference and savings-goal hash, but v0.1 deliberately does not fabricate yield.
- Available-balance withdrawals and plan-principal withdrawals are supported by the contract interface.
- Contract events cover deposits, available withdrawals, plan creation, and plan withdrawal so account history can be reconstructed by wallet address.
- Frontend Add Money is wired to send a real `eth_sendTransaction` deposit once a deployed contract address is configured for the active testnet.
- Frontend reads `availableBalance(address)` directly from the deployed contract and uses it for the dashboard's available Rixor balance.
- Deployment scripts support Sepolia and Robinhood Chain Testnet.
- CLI deployment requires a dedicated local testnet deployer key. Any wallet-signed browser deployment path is restricted to the Rixor deployment admin wallet.

- Tester wallets never deploy Rixor contracts. Supported testnets use canonical contract addresses shared by every user instead of browser-local deployment state.
- Robinhood Testnet balance reads use the official RPC first, then /rpc, then https://robinhood-sepolia-rpc.publicnode.com as a fallback.
- Canonical Sepolia RixorSavings deployment: `0x1B644D969D0b755770033AC332BaCCeFBdbc18bA`.
- Canonical Robinhood Chain Testnet RixorSavings deployment: `0xeFddb13d2d3a88E65C0e935603eA26a849f6239b`.
- Canonical Sepolia deployment transaction: `0x2341b308ed9549144b5aecef2c9d409f17dc02f5ea78e4f939a787c0cba1aee6`.
- Canonical Robinhood Chain Testnet deployment transaction: `0x7a3d0c7355f3ea43d707a88ccd615f089d3ce3ab2eaad92d74029859b7ca5c3c`.
- Start Plan uses Rixor's onchain available balance and calls `createPlan(...)` on the deployed contract.
- Available-balance withdrawal calls `withdrawAvailable(...)`.
- Plan Detail calls `withdrawPlan(planId)` for the selected active plan and refreshes Active Plans, Plan History, Activity, and balances after confirmation.
- Dashboard activity hydrates `Deposited`, `AvailableWithdrawn`, `PlanCreated`, and `PlanWithdrawn` events.
- EVM wallet sessions silently reconnect after reload only when the previously authorized account is still exposed by the same injected wallet; no signing prompt is triggered for reconnect.
- Add Money `Max` reserves test ETH for gas using a dynamic estimate with a conservative fallback reserve.
- Contract behavior tests run against a local in-process EVM with `npm run contract:test`.
- Robinhood Chain Testnet uses the confirmed canonical deployment recorded above.
