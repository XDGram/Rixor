# Rixor Lite: the $5 hackathon demo (approved, NOT deployed)

> **Nothing here has been executed on mainnet.** Nothing is deployed, signed, broadcast, bought or published.
> The project owner approved the Lite plan in writing on 11 Nov 2026 (this contract and these parameters, without
> Safes or signers), so `LITE_PLAN_APPROVED = true` in `src/deploy/expected.ts`. That only lets the Deploy Console ask
> the owner's wallet to sign; each transaction still needs the owner's own tap. Every 🔒 step below still needs the
> owner's go-ahead.

## 1. What it is

| Piece | Detail |
|---|---|
| Contract | `contracts/RixorLite.sol`: one contract, about 150 lines, 4.0 KB of bytecode |
| Lockable token | HOOKR `0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c` (18 decimals, no transfer tax, no owner) |
| Reward token | Official $WIF `0x5173b8eA6923c2d40267890D45C46a3480954773` |
| Reward wallet | The deployer's wallet. It holds the WIF and approves the contract to pay claims from it |
| Reward budget | **1,000 WIF over 7 days** from deployment (about 143 WIF a day, shared by everyone locked) |
| Lock period | **1 day** per lock or top-up |
| Limits | Minimum lock 10 HOOKR; the contract holds at most 100,000 HOOKR |

**Flow:** connect → approve the exact amount → `lock` → WIF accrues every second → `claim` (WIF moves from the reward
wallet to the claimer) → `exit` after the lock period (exact principal back).

**Rewards start at deployment**, not at the next midnight, so the whole flow can be shown within minutes.

### The app: Live and Demo

The app opens on **Live**: the real HOOKR lock, with every number read from the chain. A switch at the top of every
page opens **Demo**: the broader product (more tokens, tiers, challenges, portfolio, activity) running in a simulation
on the visitor's device with demo tokens.

- Every demo page carries a "Demo data" strip and "Demo" tags; simulated actions say "Simulated on this device · not an
  onchain transaction" and show no transaction hash.
- The demo never reads a real wallet. It uses a throwaway demo wallet that exists only inside the simulation.
- The Live page shows no simulated token, balance or challenge. It links to the demo pages with a "Demo" tag.
- The demo needs no contract, no deployment and no funds: it adds nothing to the budget.

### Safety properties (each one is tested)

- **No admin.** No owner, pause, upgrade path or fee. The only state-changing functions are `lock`, `exit`, `claim`.
- **Only the locker can withdraw.** `exit()` returns the caller's own tokens and nothing else.
- **Exits never depend on rewards.** `exit()` never calls the reward token or the reward wallet. Tests exit with a
  reward token that reverts on every call, and with the reward wallet emptied and its approval revoked.
- **The contract never holds WIF.** A claim is one `transferFrom(rewardWallet → claimer)`.
- **Rewards can never exceed the budget.** Total claimed plus claimable is at most rate × elapsed time (invariant test,
  51,200 random calls). A failed claim loses nothing: the amount stays recorded.
- **Exact tokens only.** A token that delivers less than the amount sent (fee-on-transfer) is refused.
- **A cap** limits what unaudited code can hold.

**Gas margin.** The contract writes its reward bookkeeping only when time has moved on, so the same call costs more one
second after another RixorLite transaction than in the same second. An estimate made at the wrong moment would be too
low and the transaction would run out of gas (nothing is lost; it just fails). Measured with real transactions: 6–8%
more in normal use, and 40% in one edge case (the second lock ever, estimated in the very second of the first). The app
therefore adds **50%** to the node's estimate for lock, claim and exit. Unused gas is not charged.

### What changed from the earlier plan, and what you are trusting

| Earlier (full protocol) | Lite |
|---|---|
| Two 2-of-3 Safes, six signers, hold the admin roles | **No Safes: there is no admin role to hold.** Nothing can be paused, listed or changed |
| Rewards escrowed in a contract | Rewards stay in the reward wallet (one key). It can stop funding rewards; it can never touch locked tokens |
| Hardware-wallet deployer | The deployer is also the reward wallet. Whether it is a hardware or phone wallet is your decision |
| Pause and emergency exit | None. Exits always work after the lock period; there is no emergency switch |

These replace earlier decisions (six signers, Safes, hardware signing). The owner approved the Lite contract without
Safes or signers on 11 Nov 2026.

## 2. Exact costs (prices read 11 Nov 2026: WIF $0.001255, HOOKR $0.0218, ETH $2,053, gas 0.0201 gwei)

### Measured gas

| Transaction | Who | Gas | Cost |
|---|---|---|---|
| Deploy RixorLite | Wallet A | 975,004 | $0.040 |
| Approve 1,000 WIF | Wallet A | 45,961 | $0.002 |
| Approve HOOKR | Wallet B | ~46,000 | $0.002 |
| Lock | Wallet B | ~137,700 | $0.006 |
| Claim | Wallet B | ~145,400 | $0.006 |
| Exit | Wallet B | ~89,300 | $0.004 |
| **All six** | | **~1.44M** | **about $0.06** |

### What you need to put on chain

| Item | Amount | Cost | Is it spent? |
|---|---|---|---|
| WIF reward budget (Wallet A) | 1,000 WIF (buy ~1,050 for price movement) | $1.26–1.32 | Paid out to whoever locks. Your own demo wallet earns it back while it is the only locker |
| HOOKR for the demo lock (Wallet B) | 50 HOOKR (minimum 10) | $1.09 (minimum $0.22) | No: returned by `exit` |
| ETH in Wallet A | 0.0003 ETH | $0.62 | About $0.04 used. The console needs at least 0.000054 ETH before it will start |
| ETH in Wallet B | 0.0001 ETH | $0.21 | About $0.02 used |
| Swaps (WIF, HOOKR) and transfers | gas plus swap fees (estimate, ≤1% each) | about $0.07 | Yes |
| Bridge to Robinhood Chain | one bridge from Base (Relay quote) | about $0.03 | Yes |
| **Total needed** | | **about $3.35** | **Truly consumed: about $0.20, plus WIF earned by other lockers** |

- **Simplest:** bridge **0.002 ETH** (about $4.11, plus the $0.03 bridge fee: **$4.14**). That covers everything
  above and leaves about $0.80 of spare ETH in Wallet A, which stays yours.

- **Hard minimum:** about **$1.80** (1,000 WIF, 10 HOOKR, gas and fees only, no spare ETH).
- **$5 is feasible.** The earlier $17 came from the old Rewards contract's fixed 10,000 WIF minimum, which RixorLite
  does not have.
- Prices move. If WIF or HOOKR rises more than about 20% before you buy, the total can pass $5; buy less HOOKR (the
  minimum is 10) to stay under it.

## 3. What you need to do (🔒 = needs your written approval first)

1. ✅ **Plan approved** (11 Nov 2026). `LITE_PLAN_APPROVED = true`.
2. **Two wallets** in your wallet app (I only ever need public addresses, never a key or phrase):
   - **Wallet A**: deployer and reward wallet. Must be a plain account (not upgraded to a smart account).
   - **Wallet B**: your demo wallet.
3. **Fund them** (you spend about $4.14):
   - Bridge 0.002 ETH to Wallet A on Robinhood Chain.
   - In Wallet A, swap for **1,050 WIF** (about 0.00064 ETH).
   - Send 0.0007 ETH to Wallet B, and in Wallet B swap for **50 HOOKR** (about 0.00053 ETH).
   - Leave at least 0.0003 ETH in Wallet A.
4. **Send me Wallet A's address.** I export the two-transaction bundle and give you its hash.
   After this, **do not send anything from Wallet A** until the deployment is done: the plan is tied to its
   transaction count.
5. 🔒 **Deploy** from the Deploy Console in your wallet's browser: two taps (deploy, approve), each checked before and
   verified after. Cost about $0.04.
6. 🔒 **Publish** `public/lite/deployment.json` (the console prints it) and the frontend, so the page turns on. This is
   a hosting change and needs your approval.
7. **Record the demo** with Wallet B: connect, lock 50 HOOKR, watch WIF accrue, claim (this is the transaction where
   "$wif moved"), and exit a day later.

Timing: submissions close **12 Nov 2026, 17:30 UTC**. Deploy, lock and claim before then. An exit needs 24 hours after
the lock, so it fits before the deadline only if you lock by 11 Nov 17:30 UTC; it is not required for the flow. Rewards run for 7 days from deployment, which covers judging until 16 Nov.

## 4. Tests (all local; the mainnet RPC is only read)

| Suite | Result | What it proves |
|---|---|---|
| `test/RixorLite.t.sol` | 25 pass | Unit, fuzz and two invariants (exact custody; rewards bounded) |
| `test/fork/RixorLiteFork.t.sol` | 3 pass | The full flow with the real HOOKR and WIF token code |
| `npm run test:deploy-console-lite` | 36 pass | Pinned plan equals the script and build; tampering refused; an unfunded deployer is stopped on real mainnet before any wallet request; WIF and ETH gates; both steps on a fork; the app's gas margin measured with real transactions; still verifies after claims |
| `npm run demo:e2e:lite` | 14 pass | The real UI on a fork: not-deployed state, connect, minimum check, lock, live earnings, claim (real WIF from the reward wallet), exit, tampered deployments refused; the Live page shows no demo data; the Demo side is tagged and never shows the real wallet |
| `npm run audit:mainnet-guards` | pass | `DeployRixorLite` is refused on mainnet without the authorisation sentence, and without a prefunded reward wallet |
| Full regression | pass | 156 contract tests, 11 fork tests, the testnet and mainnet console suites, and the hidden full app's journeys |

## 5. Remaining risks

- **No external audit.** The contract is small and heavily tested, but real tokens are at risk if there is a bug. The
  100,000 HOOKR cap (about $2,200) bounds it.
- **No emergency switch.** With no admin, nothing can be paused or rescued. That is the trade for having no trusted
  party.
- **Reward wallet is a single key.** If it is lost or emptied, rewards stop (locked tokens are unaffected).
- **Phone wallet.** Whether your wallet signs a contract creation is unconfirmed until tried; the payload is now 5 KB
  instead of 20 KB.
- **HOOKR data is a snapshot** (vetted 9 Nov: verified source, no owner, exact transfers, 86% of ETH liquidity locked).
- **Public RPC rate limits** can slow the page under heavy use; the page reads everything in one request per refresh.
