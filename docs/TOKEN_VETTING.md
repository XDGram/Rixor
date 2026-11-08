# Token vetting

Every token that can be locked in RixorLocker must pass this process **before** a listing is proposed, and again
before any production deployment. A pass is evidence gathered at one block, not a permanent guarantee: vetting is
repeated before every listing decision and periodically for listed tokens.

**Nothing in this document approves a production listing.** Listing requires the project owner's written approval,
then a 48-hour on-chain timelock.

## 1. Four separate questions

| Axis | Question | Outcome |
|---|---|---|
| **W. Contract compatibility and withdrawal safety** | Can the Locker always return the exact principal? | **Pass/fail gate** for listing |
| **M. Market liquidity and price** | Can holders sell what they get back, and at what impact? | Risk class, cap |
| **H. Holder concentration and manipulation** | Can a whale or cluster dump on holders who cannot exit, or farm rewards? | Risk class, cap, Watch |
| **V. Admin and venue control** | Can anyone change the token or its main pool? | Token-level admin powers fail W; pool or venue admin powers are disclosed or put the token on Watch |

Pulling a token's trading liquidity does **not** stop holders withdrawing from the Locker. It affects what their
tokens are worth, which is why it shapes the **tiers** a token allows (Diamond holders cannot react to a dump).

### W gates (all required)

1. **Exact address**, checksum-validated. Symbols and search results are never used to select a token.
2. **Verified source** (Sourcify match), or runtime bytecode proven identical to verified source and then formally
   verified.
3. No proxy, `DELEGATECALL` or `SELFDESTRUCT`; no owner powers over balances or transfers (mint, blacklist, pause,
   fee setting, rebasing).
4. **Exact transfers** into and out of a contract, including `transferFrom`, proven on a local fork. A tax that applies
   only when tokens leave a **pool** is acceptable only if the Locker's own transfers are proven untaxed.
5. Decimals 6–18; no transfer callbacks into the caller; no impersonation of real people or brands.

### Classes

| Class | Rule | Tiers |
|---|---|---|
| **A** | W passes; ≥ 90% of ETH-pool depth burned or locked by code, ≥ 50 ETH depth, age ≥ 30 days; largest holder ≤ 5%, top 10 ≤ 25%, largest cluster ≤ 10% | Flexible, Committed, Diamond (≤ 90 days) |
| **B** | W passes; weaker market or holder figures (≥ 50% locked or ≥ 20 ETH, holders up to 15% / 40% / 20%) | Flexible, Committed (≤ 60 days) |
| **Watch** | W passes, but an open question remains (age, clusters, venue admin) | shown as "Under review", not lockable |
| **Rejected** | W fails | shown as "Unsupported" with the reason |

A single entity above 25% means rejection. Caps: Class A at most 2% of supply, Class B at most 1% (proposed).

## 2. The tool: `scripts/vet-token.mjs`

```bash
npm run vet:token -- 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c          # one token
npm run vet:token -- <addr1> <addr2> --rpc <url> --out <dir> [--no-fork]  # options
```

Read-only. Behaviour tests run on a throwaway local Anvil fork that the script starts and kills; nothing is
broadcast. Reports go to `reports/token-vetting/<address>-<block>.{json,md}` (git-ignored). Exit code 2 on any FAIL.

| Step | Method |
|---|---|
| Metadata, admin surface, proxy | Pinned head block; 4-byte selector scan; opcode walk; EIP-1967/1167 checks |
| Source | Sourcify v2 |
| Age | Earliest `Transfer` by bisection (an RPC error on a large range means "has logs", so the search narrows instead of failing) |
| Holders | Full `Transfer` replay with adaptive `getLogs` ranges; Σ balances = `totalSupply`; top 25 cross-checked live; re-pins to a fresh head and replays the gap when the replay outlives the RPC's state window |
| Clusters | Signer, funding, equal-balance and first-receipt-timing clusters over the 500 largest holders |
| **Liquidity: ETH depth** | Uniswap v4 pools paired with **native ETH**, ranked by in-range virtual ETH depth (`L × 2^96 / sqrtPriceX96`). Token/token pools are listed but never chosen as the "main pool" |
| **Liquidity: custody** | Classifies each position's owner: burned (`0x…dEaD`), **locked by code** (reviewed custodians with no liquidity-removal path, or a hook that reverts removals), or withdrawable. Reports the code-locked share of ETH depth |
| Behaviour (local fork) | EOA→EOA, EOA→contract, `transferFrom` by a contract, contract→EOA, burn address, zero amount, repeated transfers, `burn`, **and a transfer out of the PoolManager** (a buy) to detect pool-exit taxes the selector scan cannot see |

### Reviewed custodians and hooks (locked by code)

These were reviewed from verified source in November 2026. Each has no function that removes liquidity:

| Contract | Address | Why it counts as locked |
|---|---|---|
| Pons launch locker (RobinFunFiV2LaunchLocker) | `0x267444d099b10fb5ed7c3cc7b7c767adca574952` | No withdrawal or arbitrary-call function |
| Uniswap FeeSplitter | `0xeff166aaf189323c58dc27ed1206eb2c37faacdf` | Only zero-liquidity decreases (fee collection); no NFT transfer or approval |
| TorchFactory | `0x7891ea889899928afe637e4cca8106188427776a` | No function passes a negative liquidity delta |
| NoRemoveHook (hook) | `0x5a2f8ce3332f9cd909dd80c32dfa2835214ac200` | `beforeRemoveLiquidity` reverts any real removal; bound to the canonical PoolManager |

Adding a custodian requires the same source review. Unknown contracts are reported as "withdrawable (inspect)".

### Limitations (printed in every report)

* The public RPC is not an archive node (state for about 10–35 minutes); the script pins and re-pins head blocks.
* Selector matching is heuristic: every WARN or FAIL is resolved by reading verified source.
* Clusters look one hop back; wallets funded with gas by one entity are not detected without an indexer.
* Only Uniswap v4 liquidity is attributed. Virtual depth is an upper bound for concentrated positions.

## 3. Current candidates (November 2026)

| Token | Address | Status | Evidence |
|---|---|---|---|
| **HOOKR** | `0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c` | **Class A candidate, class under review** (implementation testing only) | Uniswap UERC20 (Solady), verified, no owner, no buy/sell tax; 9/9 fork transfers exact; 10,020 holders, largest 3.0%, top 10 15.9%, no cluster above 3.9%; age 94.6 days. Re-vet at block 109,466,311: ~276.6 ETH depth across 108 ETH pools; **85.8% locked by code** (93.2% of the main pool held by the Uniswap FeeSplitter; the smaller ETH pools are withdrawable). That is **below the 90% Class A threshold**, so the class needs a decision (see the readiness report); the LIME pool behind NoRemoveHook is not ETH-paired and does not count. Solady pre-approves Permit2 for all holders; fork-tested that this cannot move the Locker's tokens |
| **TORCH** | `0x000050E18ffa3F8F7aD170Eb9CeF160eb3Ed1111` | **Class B candidate** (implementation testing only) | OpenZeppelin ERC20, verified, no owner; **fixed 2% buy tax only on transfers out of a pool**; Locker deposits and exits fork-tested untaxed; Re-vet at block 109,461,446: ~390.9 ETH depth, **99.9% locked by code** (TorchFactory); 4,193 holders, largest 6.7%; buy tax detected by the pool-exit test (98.0% received). **The first transfer out of a new holder contract needs about 81k gas remaining** (`InsufficientGasForProbe` below that), so exits must use the node's gas estimate, never a fixed limit |
| NOVAAI | `0x51250B135174Ca09450EC01c4afF73CF69DBb590` | Under review | Runtime bytecode identical (including metadata hash) to the verified Pons `PonsV2LauncherToken`; awaiting formal verification. 14,805 holders; LP 100% in the Pons launch locker; one funding cluster at 11.25% |
| DOPE | `0xf9e990CCb47806AC9268922BD21Dc9a91C8e8899` | Conditional | Plain OpenZeppelin ERC20; LP burned; under 30 days old until 14 Nov 2026; all 500 largest holders first bought within one hour of launch (cannot yet rule out one operator) |
| PANGEA, FOREVER, V4 | see `src/protocol/tokenlist.ts` | Under review | Cross-chain mint paths; age; holder clusters |
| UNIWALL, TIBBIR | see token list | Unsupported | Transfer restrictions; transfer fee |
| MOW, AnsemCat | see token list | Unsupported | Funding or holder clusters above limits |

WIF (`0x5173b8eA6923c2d40267890D45C46a3480954773`) is the **reward token**. It is not a lockable community.

## 4. Human review checklist (per listing)

- [ ] Exact address confirmed from two independent sources.
- [ ] Verified source read in full; every WARN and FAIL explained in writing.
- [ ] Fork behaviour: exact in/out of a contract, plus the pool-exit test result understood.
- [ ] ETH depth and custody understood; every "locked by code" custodian is in the reviewed table above.
- [ ] Holder and cluster sections reviewed; class and cap chosen.
- [ ] Written approval from the project owner recorded before `proposeListing`.
