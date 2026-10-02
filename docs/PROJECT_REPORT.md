# Rixor — Detailed Project Report

## 1. Executive summary

Rixor is an onchain savings interface focused on making wallet-based saving understandable before a transaction is signed. The current version is deliberately testnet-first and supports Sepolia and Robinhood Chain Testnet.

The product combines a React/TypeScript frontend with a Solidity savings contract. A connected user can deposit native testnet ETH into a Rixor balance, create a savings plan, top up or extend an active plan, withdraw available funds, or exit a plan. Locked plans expose a declining early-exit fee before the user confirms the withdrawal.

The product currently uses the blockchain as the source of truth for savings balances, plans, and activity. The UI hydrates from contract reads and emitted events instead of depending on a private user-account database.

## 2. Product objective

The main product objective is to make onchain saving feel understandable rather than opaque.

Rixor therefore emphasizes:

- clear wallet and network identity;
- visible principal and plan terms;
- explicit early-exit consequences;
- confirmation states around wallet signatures and mined transactions;
- contract-driven activity and history;
- minimal reliance on offchain user records for financial state.

## 3. Current user journey

### 3.1 Connect a wallet

The user connects an injected EVM wallet. Rixor detects the active chain and wallet address, reads the native balance, and supports switching between Sepolia and Robinhood Chain Testnet.

### 3.2 Add money

The user selects an ETH amount from the connected wallet and reviews the deposit before signing. The contract's payable deposit flow credits that amount to `availableBalance` for the connected address.

The interface exposes wallet approval, pending confirmation, failure, and confirmed-receipt states.

### 3.3 Start a savings plan

The user chooses:

- a goal label;
- an amount from the Rixor available balance;
- a supported plan term;
- the displayed reward preference.

The contract moves principal from `availableBalance` into an owned plan and stores the plan's timestamps and status.

### 3.4 Manage an active plan

The plan detail screen exposes:

- principal;
- term;
- start time;
- maturity;
- progress;
- access rule;
- displayed reward asset;
- withdrawal review;
- Add More;
- Extend Plan.

`topUpPlan` moves ETH from the user's available Rixor balance into an active plan.

`extendPlan` permits moving a plan to a longer supported lock period. The new lock begins when the extension transaction is confirmed.

### 3.5 Withdraw available balance

Available balance can be withdrawn directly back to the connected wallet without affecting an active plan.

### 3.6 Exit a plan

Flexible plans have no early-exit fee.

Locked plans calculate a declining fee based on the portion of the term remaining. Before signing, the interface presents:

- whether the exit is early;
- current fee percentage;
- exact ETH fee with sufficient decimal precision;
- approximate USD loss using an ETH/USD spot price;
- expected ETH returned.

For early exits, the loss is visually shown in red with a negative sign so it is not confused with a neutral informational amount.

After a confirmed withdrawal, the transaction confirmation animation is shown before the user manually returns to the dashboard.

## 4. Smart-contract design

Primary contract: `contracts/RixorSavings.sol`

### 4.1 Core stored state

The contract tracks:

- each address's available balance;
- savings plans by numeric plan ID;
- the ordered plan IDs belonging to each user;
- protocol fees accumulated from early exits;
- fee-recipient/owner authority for protocol-fee withdrawal.

### 4.2 Plan terms

Supported terms:

| Internal type | Product term | Maximum early-exit fee |
| ---: | --- | ---: |
| 0 | Flexible | 0% |
| 1 | 30 days | 2% |
| 2 | 90 days | 4% |
| 3 | 180 days | 6% |
| 4 | 1 year | 8% |

For a locked plan, the fee declines continuously as the remaining duration approaches zero. A matured plan has no early-exit fee.

### 4.3 Core functions

`deposit()`

Credits the caller's available balance with the native ETH sent in the transaction.

`withdrawAvailable(uint256 amount)`

Debits available balance and sends native ETH back to the caller.

`createPlan(uint256 amount, PlanType planType, RewardPreference rewardPreference, bytes32 goal)`

Moves available balance into a new owned plan.

`topUpPlan(uint256 planId, uint256 amount)`

Adds additional available balance to an active plan after ownership, status, amount, and balance checks.

`extendPlan(uint256 planId, PlanType newPlanType)`

Requires an active owned plan and a longer non-flexible target term. The extension resets the lock start and maturity timestamps for the chosen longer term.

`getEarlyWithdrawalQuote(uint256 planId)`

Returns the current early-exit state, fee basis points, fee amount, and principal amount that would be returned.

`withdrawPlan(uint256 planId)`

Closes the plan, applies any current early-exit fee, accrues protocol fees, and sends the returned principal to the owner.

`withdrawProtocolFees(uint256 amount)`

Restricted to the fee recipient.

## 5. Onchain events and UI hydration

Rixor reads plan state directly and also uses events to build Recent Movement and completed/withdrawn history.

Important events include:

- `Deposited`
- `AvailableWithdrawn`
- `PlanCreated`
- `PlanWithdrawn`
- `EarlyExitFeeCharged`
- `PlanToppedUp`
- `PlanExtended`
- `ProtocolFeesWithdrawn`

This architecture keeps transaction history tied to public chain data rather than duplicating the financial source of truth in a private database.

## 6. Network support

### Sepolia

- Chain ID: `11155111`
- Used for Ethereum testnet testing.
- Native principal asset in the current contract: testnet ETH.

### Robinhood Chain Testnet

- Chain ID: `46630` (`0xb626`).
- RPC used by the application: `https://rpc.testnet.chain.robinhood.com`.
- Native principal asset in the current contract: testnet ETH.

Rixor uses chain-specific identity throughout the interface. Sepolia surfaces the Ethereum mark. Robinhood Chain Testnet surfaces the official Robinhood feather used by the project.

## 7. Deployment behavior

The tester-facing app uses canonical contract addresses for each supported testnet. Ordinary users do not deploy contracts and no browser-local deployment registry is used as the source of truth.

Protocol deployment is restricted to the Rixor deployment wallet and is treated as an admin/development operation. Once a deployment is selected as canonical, its address is promoted into the application configuration so every tester uses the same contract on that network.

## 8. Frontend architecture

The current frontend is intentionally compact:

- `src/App.tsx` contains the connected-wallet flows, public marketing sections, plan pages, network state, reads, writes, transaction state, and event hydration.
- `src/styles.css` contains the complete visual system and responsive behavior.
- `src/contracts/RixorSavingsArtifact.json` is generated by the compile script and supplies the ABI/bytecode used by the application.

The UI provides explicit states for:

- wallet approval;
- transaction pending;
- transaction failure;
- transaction confirmation;
- wrong/unsupported network;
- insufficient available balance;
- insufficient wallet balance;
- empty savings state.

## 9. Visual and interaction direction

Rixor uses a minimalist dark/deep-green system with lime as the primary interaction accent. The interface is intended to feel closer to a modern consumer finance product than a generic developer dApp.

Important visual decisions in the current tester build include:

- compact rounded controls;
- chain-specific logos instead of generic placeholder marks;
- restrained ambient chain artwork;
- automatic confirmation motion after completed transactions;
- consistent ETH suffix spacing for financial amounts;
- red negative treatment for early-withdrawal losses;
- independent scroll regions for Recent Movement and plan history;
- light and dark modes.

## 10. Validation performed

The project currently passes:

```bash
npm run contract:test
npm run build
git diff --check
```

The local Solidity test suite covers:

- rejecting zero-value deposits;
- available-balance deposit accounting;
- available-balance withdrawals;
- insufficient-balance protection;
- plan creation;
- plan ownership;
- plan top-ups;
- longer-term extensions;
- early-exit fee application;
- principal conservation across returned amount + fee;
- protocol-fee accrual;
- prevention of double withdrawal;
- flexible-plan withdrawal with no early-exit fee;
- fee reaching zero after maturity;
- restricted protocol-fee withdrawal.

Ganache may print a µWS native-binary compatibility warning on the current Windows/Node setup and fall back to its JavaScript implementation. The test suite still completes successfully.

## 11. Known limitations

### 11.1 `$RIXOR` rewards are not yet onchain

The product UI describes `$RIXOR` as the intended reward asset, but the current Solidity build does not yet include the final reward token, treasury funding controller, vesting engine, or reward claims/payouts.

This means:

- ETH principal savings flows are real testnet transactions.
- The `$RIXOR` reward model is currently product direction/UI presentation.
- Testers should not interpret displayed reward language as proof of a live `$RIXOR` payout implementation.

### 11.2 Testnet deployment registry

The current tester build uses canonical chain-specific contract addresses rather than per-browser deployment state. A production system should still use a controlled deployment registry/configuration strategy.

### 11.3 USD loss value

The USD value shown for an early-exit fee is an approximate display value obtained from an external ETH/USD spot-price endpoint. Contract settlement remains denominated in ETH and does not depend on the USD price request.

### 11.4 No mainnet claim

This repository should currently be evaluated as a functional testnet build, not an audited or production-ready mainnet protocol.

## 12. Security considerations

The contract includes ownership/status checks and non-reentrancy protection around value-returning withdrawal behavior. Nevertheless, the current project has not been represented as externally audited.

Before any production deployment, recommended work includes:

- independent smart-contract audit;
- dedicated fuzz/property testing;
- explicit threat modeling for fee-recipient authority;
- deployment-address governance/configuration;
- reward-token and treasury review once implemented;
- RPC/provider failure hardening;
- broader wallet compatibility testing.

## 13. External tester focus

Testers should focus on:

1. network switching between Sepolia and Robinhood Chain Testnet;
2. deposit and available-balance accuracy;
3. plan creation across terms;
4. Add More behavior;
5. Extend Plan restrictions and new maturity display;
6. early-withdrawal quote accuracy and clarity;
7. confirmed transaction animation/state persistence;
8. plan/activity refresh after successful transactions;
9. wallet rejection and failed-transaction recovery;
10. mobile/responsive layout and readability.

See `docs/TESTER_GUIDE.md` for a concise test sequence.

## 14. Current stage and next steps

Current stage: **external testnet testing**.

After tester feedback, the likely next work is:

- fix usability or state-sync issues discovered during external testing;
- harden wallet/provider failure handling;
- decide and implement the real `$RIXOR` token/reward-treasury architecture;
- increase contract test depth;
- run a security review before any production-oriented deployment.
