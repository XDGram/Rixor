# Rixor launch runbook (prepared at Gate 1, NOT executed)

> **Nothing in this runbook has been executed.** No contract has been deployed, no Safe created, no transaction
> sent and no WIF spent. Each step below requires explicit approval at Gate 2 or later. Values marked
> `TBD` must be decided by the project owner; they are deliberately not chosen here.

Target: a **capped pilot** on Robinhood Chain mainnet (chain id 4663), only after unit tests, fork tests and the
security review pass, and after the open items in `SECURITY_REVIEW.md` §9 are accepted or resolved.

---

## 1. Build and verification settings (must match exactly)

| Setting | Value |
|---|---|
| Foundry | 1.7.1 (`@foundry-rs/forge`, `anvil`, `cast` pinned in `package.json`) |
| solc | 0.8.30 |
| EVM version | `shanghai` |
| Optimizer | enabled, 200 runs |
| via-IR | false |
| Metadata hash | `ipfs` |
| forge-std (tests only) | v1.17.0, `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` |

Pre-deployment check, on the exact commit to be deployed:

```bash
npm ci
git submodule update --init --recursive
npm run test:contracts        # unit + fuzz + invariant
npm run test:fork             # fresh local fork; RH_MAINNET_RPC_URL optional
npm run vet:token -- 0x5173b8eA6923c2d40267890D45C46a3480954773 0xf9e990CCb47806AC9268922BD21Dc9a91C8e8899
```

All must pass, and both vetting reports must be reviewed by a human, on the day of deployment.

## 2. Safes (2-of-3), signers TBD

Use the canonical Safe v1.4.1 deployments verified on chain 4663:

| Contract | Address |
|---|---|
| SafeL2 singleton v1.4.1 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| SafeProxyFactory v1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| CompatibilityFallbackHandler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` |
| MultiSendCallOnly | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` |

Two Safes:

| Safe | Purpose | Threshold | Owners |
|---|---|---|---|
| Owner Safe | Locker owner: registry changes, unpause, Season creation and funding | 2 of 3 | `TBD_1`, `TBD_2`, `TBD_3` |
| Guardian Safe | Pause and emergency | 2 of 3 | `TBD_A`, `TBD_B`, `TBD_C` |

Setup call (as exercised in `test/fork/RixorFork.t.sol`):
`setup(owners, 2, address(0), 0x, 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99, address(0), 0, address(0))` via
`createProxyWithNonce(0x29fcB43b…C762, initializer, saltNonce)`.

Recommendations (owner decides):
* Use hardware wallets held by different people, and separate devices.
* The two Safes should not share all three signers; at least one guardian signer should be independent.
* Confirm both Safes in the Safe{Wallet} UI before use. Its support for chain 4663 is reported by Safe but was not
  verified directly in Gate 1 (the client gateway returned 403).
* Record each Safe's address, owners and threshold in this file at Gate 2.

## 3. Token parameters

Initial token scope (exact addresses; never select by symbol):

| Token | Address | Status |
|---|---|---|
| World is Flat (WIF) | `0x5173b8eA6923c2d40267890D45C46a3480954773` | Approved; reward token; 2.0× multiplier |
| Doge Pepe (DOPE) | `0xf9e990CCb47806AC9268922BD21Dc9a91C8e8899` | Approved; 1.0× multiplier |
| Charlie (CHARLIE) | `0x5FeA0f4E7239907602bB779C52A559279F542F45` | **Excluded** (unverified source) |

### 3.1 Unit sizes (7-day median process)

The unit is the amount of a token that counts as "1 unit" for scoring. Process, repeated for every later change:

1. For each token, sample the main pool's price at least hourly for 7 days, as a time-weighted price from the
   on-chain pool. The pools are `0x71ef4106…8c79` for WIF and `0xde60e54e…9442` for DOPE. Use the ETH quote leg.
2. Take the **median** of the samples (not the mean, not the latest price).
3. Choose one target value per unit, `V` (TBD, the same for all tokens), and set
   `unit = V / median_price`, rounded to a readable number.
4. Record the samples, median, `V` and the resulting units in this file.
5. For changes after deployment: the new unit must be within [50%, 150%] of the current unit, at least 7 days must
   have passed since the last change, and the change executes 48 hours after `proposeUnitAmount`. Only challenges
   created after execution use it.

Test-only values used in the suites (not production values): WIF 7,000 WIF per unit; DOPE 1,000 (unit tests) or
100,000 (fork tests) DOPE per unit.

### 3.2 Pilot caps

`maxTotalLocked` per token: `TBD` (a pilot cap). Raises are limited to 2× per step, with a 48 h timelock; lowering is
immediate.

## 4. Deployment configuration (exact arguments)

Deploy from a fresh deployer EOA that will hold **no role**. Ownership is fixed in the constructor.

### 4.1 RixorLocker

```
constructor(
  address wif_            = 0x5173b8eA6923c2d40267890D45C46a3480954773,
  address owner_          = <OWNER_SAFE>,          // must already exist (code length > 0)
  address guardian_       = <GUARDIAN_SAFE>,       // must already exist
  address[] tokens_       = [0x5173b8eA6923c2d40267890D45C46a3480954773, 0xf9e990CCb47806AC9268922BD21Dc9a91C8e8899],
  uint256[] unitAmounts_  = [<WIF_UNIT_WEI>, <DOPE_UNIT_WEI>],   // §3.1, 18 decimals
  uint256[] maxTotalLocked_ = [<WIF_CAP_WEI>, <DOPE_CAP_WEI>]    // §3.2
)
```

The constructor reverts if the owner or guardian is not a contract, WIF is not in `tokens_`, a token is duplicated,
decimals are outside 6–18, a unit is 0, or a cap is below its unit.

### 4.2 RixorChallenges

```
constructor(
  IRixorLocker locker_ = <RIXOR_LOCKER>,
  uint256 minHold_     = 86400                      // 24 hours, production default
)
```

A separate demo deployment may use a smaller `minHold_` (≥ 3600). It must never be the production instance.

### 4.3 Post-deployment checks (read-only)

| Call | Expected |
|---|---|
| `locker.owner()` | Owner Safe |
| `locker.guardian()` | Guardian Safe |
| `locker.pendingOwner()` | `0x0` |
| `locker.WIF()` / `challenges.wif()` | `0x5173b8eA…4773` |
| `locker.listedTokens()` | `[WIF, DOPE]` |
| `locker.tokenConfig(t)` | unit and cap as configured; `locksEnabled = true` |
| `locker.paused()` / `emergencyActivatedAt()` | `false` / `0` |
| `challenges.locker()` / `minHold()` | Locker / `86400` |

### 4.4 Source verification

Verify both contracts on Sourcify (supported for chain 4663) with the settings in §1, and confirm an exact or
full match. The Etherscan v2 API for this chain requires a paid plan.

## 5. Operating procedures

### 5.1 Season challenges

Seasons are funded by the Owner Safe from its own WIF, and **only after the Season budget is approved**. No budget
is assumed. Each Season is a 2-of-3 Safe batch:
1. `WIF.approve(challenges, pool)` for the exact pool.
2. `challenges.createSeason(params, pool)`.

Sweeps return a Season's unclaimed WIF to the Safe.

### 5.2 Token listing

1. Run `npm run vet:token -- <exact address>` and complete the human review in `TOKEN_VETTING.md`.
2. Obtain approval.
3. Owner Safe calls `proposeListing(token, unit, cap)`. Anyone can call `executeListing(token)` 48 h later.

### 5.3 Incident response

| Situation | Action | Who |
|---|---|---|
| Suspicious activity in a token | `disableLocks(token)` (immediate); `lowerCap` | Owner Safe |
| Protocol-wide concern, recoverable | `pause()`; fix or investigate; `unpause()` | Guardian or Owner Safe; unpause is owner only |
| Irrecoverable problem | `activateEmergency()`: irreversible; every position exits fee-free; running challenges become refund-only | Guardian or Owner Safe |

After an emergency, users call `exit` themselves, sponsors call `refund` on cancelled challenges, and participants
of already-settled challenges keep claiming. No admin action can or needs to move funds.

### 5.4 Monitoring

Watch the events `Paused`, `EmergencyActivated`, `*Proposed` (all timelocked registry proposals), `OwnershipTransferStarted`,
`GuardianChanged`, `ChallengeCreated` and `Settled`. Alert on any proposal that the team did not initiate.

## 6. Explicit non-actions in Gate 1

No deployment (testnet or mainnet), no live-network transaction, no Safe created on a live network, no signer
selected, no WIF transferred or spent, no Season created or funded, no frontend change. All fork activity ran
against local in-memory forks.
