<p align="center">
  <img src="public/images/rixor-logo.svg" alt="Rixor" width="360" />
</p>

# Rixor

**Diamond hands for $WIF, enforced onchain on Robinhood Chain.**

Rixor lets holders lock $WIF for 7 days to 1 year. Breaking a lock early costs a paper-hands fee that falls every second until it reaches zero at unlock. Every fee splits 50/50: half is **burned** through $WIF's own `burn()`, half is **paid to everyone still locked**, weighted by how long they committed. Patience gets paid, panic gets burned.

Rixor also includes ETH savings plans on Sepolia and Robinhood Chain Testnet (described further below).

## Diamond Hands ($WIF)

Contract: `contracts/RixorDiamondHands.sol` · token: $WIF `0x5173b8eA6923c2d40267890D45C46a3480954773` on Robinhood Chain (chain ID 4663).

| Lock | Reward weight | Max paper-hands fee |
| --- | ---: | ---: |
| 7 days | 1x | 5% |
| 30 days | 1.25x | 10% |
| 90 days | 1.5x | 15% |
| 180 days | 2x | 20% |
| 1 year | 3x | 25% |

- `lock(amount, term)`: lock $WIF (after `approve`).
- `claim(lockId)`: collect rewards earned from other holders' exits, anytime.
- `unlock(lockId)`: after the term, withdraw principal plus rewards with no fee.
- `breakLock(lockId)`: exit early. Pays the current fee and forfeits unclaimed rewards. Half the fee is burned; the rest (plus the forfeit) goes to open locks. If no one else is locked, all of it is burned.

**The flywheel:** locking takes $WIF out of circulation → paper hands burn supply and fund holders → holders come back to claim and relock for a bigger share → more $WIF locked.

**Trust model:** no owner, no admin, no upgrade path, no protocol fee. Rewards come only from exit fees; nothing is minted. Tested (`npm run contract:test`), not audited.

The app reads live totals, your locks, a leaderboard and a feed of locks and paper-hand exits straight from the contract through the public Robinhood Chain RPC. There is no backend.

### Deploying Diamond Hands

```bash
npm run contract:compile
npm run contract:deploy:diamond -- robinhood-mainnet   # needs RIXOR_DEPLOYER_PRIVATE_KEY with a little ETH for gas
```

Then set `VITE_RIXOR_DIAMOND_ADDRESS` and `VITE_RIXOR_DIAMOND_FROM_BLOCK` (printed by the script) in Vercel and redeploy. Until the address is set, the app shows Diamond Hands in a "not deployed yet" state and never sends transactions.

## ETH savings (testnet)

The original Rixor flow: move testnet ETH into an onchain balance, place part of it into a savings plan, understand the lock and early-exit rules before signing, and see activity reconstructed from contract events. Runs on **Sepolia** and **Robinhood Chain Testnet** only.

Rixor is an independent project and is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. $WIF comes with no promise of value or return.

### What is working

- Connect an injected EVM wallet.
- Switch between Sepolia and Robinhood Chain Testnet.
- Read the wallet's native testnet ETH balance.
- Deposit testnet ETH into the Rixor contract.
- Create Flexible, 30-day, 90-day, 180-day, and 1-year savings plans.
- View active plans from onchain state.
- Top up an active plan from the user's Rixor available balance.
- Extend an active plan to a longer lock period.
- Withdraw the available Rixor balance back to the connected wallet.
- Exit an active plan, including a declining early-withdrawal fee for locked plans.
- Preview the early-exit fee, net ETH returned, and an approximate USD loss before signing.
- Read plan history and recent movement from contract events.
- Show wallet approval, pending, and transaction-confirmed UI states.
- Use chain-specific visual identity: Ethereum for Sepolia and the Robinhood feather for Robinhood Chain Testnet.
- Use the canonical Rixor contract deployment for the selected supported testnet.

## Screenshots

### Landing experience

![Rixor landing page](docs/screenshots/home.png)

### Plans

![Rixor plans section](docs/screenshots/plans.png)

### Security

![Rixor security section](docs/screenshots/security.png)

### Mobile

<img src="docs/screenshots/mobile-home.png" alt="Rixor on mobile" width="320" />

## Smart-contract behavior

The current Solidity contract is `contracts/RixorSavings.sol`.

Core actions:

| Action | Contract behavior |
| --- | --- |
| Deposit | Adds native ETH to the user's `availableBalance` |
| Withdraw available | Sends ETH from `availableBalance` back to the plan owner |
| Create plan | Moves ETH from `availableBalance` into a new savings plan |
| Top up plan | Moves additional ETH from `availableBalance` into an active plan |
| Extend plan | Moves an active plan to a longer supported term and starts the new lock period |
| Withdraw plan | Closes the plan and returns principal minus any applicable early-exit fee |

### Early-exit fee schedule

Locked plans use a maximum fee that declines continuously toward zero as the plan approaches maturity.

| Plan | Maximum early-exit fee |
| --- | ---: |
| Flexible | 0% |
| 30 days | 2% |
| 90 days | 4% |
| 180 days | 6% |
| 1 year | 8% |

At maturity the early-exit fee is zero. The UI shows the current percentage, ETH fee, approximate USD loss, and expected ETH returned before the user signs.

## Supported networks

### Sepolia

- Chain ID: `11155111`
- Native asset: testnet ETH
- Explorer: Sepolia Etherscan

### Robinhood Chain Testnet

- Chain ID: `46630`
- Hex chain ID: `0xb626`
- RPC: `https://rpc.testnet.chain.robinhood.com`
- Native asset used by the current Rixor contract: testnet ETH
- Explorer: Robinhood Chain Testnet Explorer

Rixor uses canonical contract addresses for Sepolia and Robinhood Chain Testnet. Testers and ordinary connected wallets never deploy protocol contracts from the app. Contract deployment is an admin/development action owned by the Rixor deployment wallet.

## Architecture

```text
Rixor/
├─ contracts/
│  └─ RixorSavings.sol
├─ scripts/
│  ├─ compile-contract.mjs
│  ├─ deploy-contract.mjs
│  └─ test-contract.mjs
├─ src/
│  ├─ App.tsx
│  ├─ styles.css
│  └─ contracts/
│     └─ RixorSavingsArtifact.json
├─ public/
│  └─ images/
├─ docs/
│  ├─ PROJECT_REPORT.md
│  ├─ TESTER_GUIDE.md
│  └─ screenshots/
└─ vite.config.ts
```

Frontend state is intentionally hydrated from the connected wallet, contract reads, and emitted events rather than from a private account database.

## Tech stack

- React 19
- TypeScript
- Vite
- ethers v6
- Solidity `0.8.x`
- solc-js
- Ganache for local contract tests
- Native/injected EVM wallet provider APIs

## Local development

Requirements:

- Node.js
- npm
- An injected EVM wallet for live testnet interactions
- Test ETH on the selected supported network

Install and run:

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

Compile the contract:

```bash
npm run contract:compile
```

Run contract tests:

```bash
npm run contract:test
```

## Current validation status

Before this documentation update, the current workspace passed:

- `npm run contract:test`
- `npm run build`
- `git diff --check`

The contract test suite covers deposits, available-balance withdrawals, plan creation, plan ownership checks, top-ups, extensions, early exits, fee conservation, flexible-plan exits, maturity behavior, and protocol-fee access control.

## Important current limitation: `$RIXOR` rewards

The interface describes rewards in `$RIXOR`, but the current testnet contract **does not yet implement the final `$RIXOR` token, reward treasury, reward-controller, or vesting payout system**.

For this build:

- ETH principal accounting and savings-plan actions are real testnet contract behavior.
- `$RIXOR` reward presentation is product/UI direction rather than a live onchain reward payout.
- Testers should evaluate the existing ETH savings flows separately from the future reward-token implementation.

This distinction is intentional so the repository does not imply that an unfinished reward system is already live.

## Tester documentation

- [Detailed project report](docs/PROJECT_REPORT.md)
- [Tester guide](docs/TESTER_GUIDE.md)

## Status

**Current stage: functional testnet build / tester handoff.**

The next phase after external testing is to address tester feedback, harden failure/recovery states, and decide the production architecture for the `$RIXOR` reward system before any mainnet-oriented work.
