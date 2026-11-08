# Token vetting

Every token that can be locked in RixorLocker must pass this process **before** a listing is proposed, and again
before any production deployment. A pass is evidence gathered at one block. It is not a permanent guarantee:
tokens, holders and liquidity change, so vetting is repeated before every listing decision and periodically for
listed tokens.

## 1. Rules

1. **Exact addresses only.** Tokens are identified by their full 20-byte address, which is checksum-validated.
   Symbols, names, abbreviated addresses and search results are never used to select a token. Many tokens on this
   chain share symbols.
2. **Verified source required.** The token must have verified source code (Sourcify exact or full match) matching
   its runtime bytecode. Unverified tokens are excluded regardless of other results.
3. **No privileged token controls.** The token may have no mint, blacklist, pause, fee/tax, transaction-limit,
   trading-gate or upgrade function, and no proxy or clone indirection. A live `owner()` requires review of exactly
   what the owner controls.
4. **Exact transfers.** Transfers must move exactly the requested amount for EOA and contract senders, recipients
   and spenders. RixorLocker also enforces this on every deposit.
5. **Decimals 6–18** (enforced on chain).
6. **Distribution and liquidity reviewed by a human** using the report below, including clusters and LP custody.
7. **No impersonation** of real people, companies or brands in the name or symbol.
8. **User approval** of each token, in writing, before `proposeListing`.

## 2. The tool: `scripts/vet-token.mjs`

```bash
npm run vet:token -- 0x5173b8eA6923c2d40267890D45C46a3480954773            # one token
npm run vet:token -- <addr1> <addr2> --rpc <url> --out <dir> [--no-fork]    # options
```

The script only reads from the network. Behaviour tests run on a throwaway local Anvil fork started by the script
and killed afterwards; nothing is broadcast. Reports are written to `reports/token-vetting/<address>-<block>.{json,md}`
(git-ignored). The exit code is 2 if any checklist item fails.

| Step | Method |
|---|---|
| Input validation | Rejects anything that is not a 0x-prefixed 40-hex-digit address; enforces EIP-55 when mixed case |
| Metadata | name, symbol, decimals, totalSupply, `owner()`/`getOwner()` at a pinned head block |
| Admin surface | 4-byte selector scan for mint, blacklist, fee, limits, trading gates, upgrade, ownership; opcode walk (skipping PUSH data) for `DELEGATECALL` and `SELFDESTRUCT` |
| Proxy detection | EIP-1967 implementation, admin and beacon slots; EIP-1167 clone prefix |
| Source | Sourcify v2 API (status, contract name, compiler) |
| Age | Earliest `Transfer` via chunked binary search |
| **Holders (full replay)** | Replays **every** `Transfer` event from the first one to the head block, splitting `getLogs` ranges adaptively (10M-block and 10k-result limits). Reconstructs every balance, checks Σ balances = `totalSupply`, and cross-checks the 25 largest replayed balances against live `balanceOf` |
| Labels | EOA, EIP-7702-delegated EOA, contract (Safe/proxy hint), known infrastructure (PoolManager, PositionManager, Pons locker and factory, zero, `0x…dEaD`) |
| Concentration | Top-1, top-10, infrastructure share; largest, top-10 and top-50 **non-infrastructure** holders |
| **Cluster analysis** | Over the 500 largest non-infrastructure holders: (a) **signer clusters**: who signed the transaction that first delivered tokens to each holder, and multi-recipient (bundled) first receipts; (b) **funding clusters**: the first sender of tokens to each holder, with verified routers and settlers identified via Sourcify and excluded as shared venues; (c) **equal-balance clusters** (balances within 2%); (d) **first-receipt timing** (holders first funded within one ~1 h window) |
| Liquidity | Uniswap v4 pools from PoolManager `Initialize` events (token as currency0 or currency1); live `slot0` and liquidity via `extsload`; LP positions from `ModifyLiquidity` (net liquidity per sender, salt and range); PositionManager NFT owners via `ownerOf(salt)`; share of in-range liquidity that is burned (`0x…dEaD`), locker-held, or withdrawable |
| Behaviour (local fork) | Impersonating the largest EOA holder: EOA→EOA, EOA→contract, `transferFrom` by a contract spender, contract→EOA, to `0x…dEaD`, zero-amount, repeated transfers, and `burn` if present. Each must be exact |

### Limitations (also printed in every report)

* The public RPC is **not an archive node**. State is available only for roughly 10–35 minutes, so the script pins
  a head block and must finish within that window. WIF's full replay took about 3 minutes.
* Selector matching is heuristic. It can miss renamed functions and can produce false positives. Any WARN or FAIL
  must be resolved by reading the verified source.
* Cluster analysis looks one hop back. **Wallets that sign their own transactions but were funded with gas by one
  entity are not detected**, because native-transfer tracing needs an indexer this RPC lacks. CEX withdrawals,
  intermediaries and swaps defeat the heuristics. A clean result does not prove that holders are independent.
* Only Uniswap v4 PoolManager liquidity is attributed; other venues are not scanned.
* "Locker-held" LP means owned by the Pons locker. Whether that is effectively permanent depends on the locker and
  the PositionManager (see `SECURITY_REVIEW.md` §7).
* Blockscout's API is behind Cloudflare (403), and the Etherscan v2 API for chain 4663 requires a paid plan, so
  neither is used.

## 3. Gate 1 results (8 Nov 2026)

### 3.1 WIF: World is Flat `0x5173b8eA6923c2d40267890D45C46a3480954773`: **approved**

Report block 109,227,109. Overall: **PASS WITH WARNINGS** (one WARN, reviewed below).

* Sourcify `match`: `PonsV2LauncherToken`, solc 0.8.35. 3,248 bytes; not a proxy; no `DELEGATECALL` or `SELFDESTRUCT`;
  no owner; no mint, blacklist, fee, pause or upgrade selectors. Burnable by holders.
* Supply 999,997,149.10 WIF (some burned); 18 decimals; first transfer 6 Aug 2026 (94 days old).
* Full replay: 244,019 transfers, 1,586 holders, Σ = `totalSupply`, 0 of the top 25 differ from live balances, 0
  failed log ranges.
* Concentration: the Pons locker holds 8.16% (locked supply) and the PoolManager 3.73%. The largest non-infrastructure
  holder is an EOA with 2.51%; the top 10 non-infrastructure holders have 20.63%, and the top 50 have 65.05%.
* Clusters:
  * 316 of the top 500 holders signed their own first receipt.
  * The largest third-party signer funded 2 holders (2.54%), and there were no bundled first receipts.
  * The largest raw funding source, `0xb92fe925…Ff4f`, accounts for 9.87%. It is Sourcify-verified **RelayRouterV3**,
    a shared bridge/swap router, so it is excluded as a shared venue. RobinHoodSettler (0.72%) and UniversalRouter
    (0.14%) are also shared venues.
  * The largest remaining group is 0.27%.
* Liquidity: 27 v4 pools. In the main pool `0x71ef4106…8c79`, 100% of in-range liquidity is PositionManager
  tokenId 511448, owned by the Pons locker with no approvals.
* **WARN (reviewed): the main pool has the Pons hook `0xE5e7…e044`.** Its permissions are swaps only. Its fee is
  snapshotted per pool. It has no liquidity hooks. This is reviewed in `SECURITY_REVIEW.md` §7.2.
* Local-fork behaviour: all 8 tests exact.

### 3.2 DOPE: Doge Pepe `0xf9e990CCb47806AC9268922BD21Dc9a91C8e8899`: **approved, with a recorded concern**

This is the exact full address established by the previous vetting work. Report block 109,226,408. Overall:
**PASS WITH WARNINGS**.

* Sourcify `exact_match`. 1,923 bytes; not a proxy; no owner; no admin selectors; 18 decimals; supply 1,000,000,000.
* First transfer 15 Oct 2026. **WARN: 23.7 days old** (below the 30-day comfort threshold, above the 7-day minimum).
* Full replay: 81,456 transfers, 3,257 holders, Σ = `totalSupply`, 0 mismatches, 0 failed ranges.
* Concentration: the PoolManager holds 1.15%. The largest non-infrastructure holder has 0.088%; the top 10
  non-infrastructure holders have 0.84%, and the top 50 have 4.02%.
* **WARN: first-receipt timing.** All 500 of the largest holders first received DOPE within one ~1-hour window,
  starting at block 89,484,429, which is about two minutes after the first transfer at 89,483,120. The distribution
  is unusually flat: thousands of wallets each hold about 0.03–0.09%.
  * Signer analysis found **500 distinct transactions, each signed by the holder itself**.
  * There were no bundled multi-recipient transactions and no third-party signer.
  * All 500 bought through the PoolManager.
  * Interpretation: this is consistent with a crowded fair launch, **and also with one operator running many
    self-signing wallets**. The tool cannot distinguish the two, because gas-funding tracing is unavailable.
  * This is **not a custody risk** for Rixor. It is a **Sybil and farming consideration** for DOPE-eligible
    challenges: sponsors should use `minTier` and `minUnitsPerEntry`, and the pilot should keep DOPE caps low.
* Liquidity: 20 v4 pools. In the main pool `0xde60e54e…9442` there is **no hook**, and 100% of in-range liquidity is
  tokenId 3841115, owned by `0x…dEaD` with no approvals.
* Local-fork behaviour: all 7 tests exact (no burn function).

### 3.3 CHARLIE `0x5FeA0f4E7239907602bB779C52A559279F542F45`: **excluded**

Report block 109,229,016. Overall: **FAIL**.

* **FAIL: source not verified** on Sourcify. Its bytecode is the Pons token template and differs from WIF's in 60 of
  3,248 bytes. **Exclusion stands until its source is verified and independently reviewed.**
* FAIL (likely a venue artefact): 109 of the largest holders, together 88.5% of supply, first received CHARLIE from
  one unverified contract, `0xC80F8335…7E8d`. The signer analysis shows those holders signed their own first-receipt
  transactions; the largest third-party signer delivered dust (0.009%) to 346 holders, an airdrop pattern. Together
  this suggests `0xC80F…` is the token's launch/bonding-curve venue rather than a distributor wallet. It cannot be
  excluded automatically because it is unverified, and its role was not confirmed.
* WARN: the largest holder is an EOA with 10.54%. WARN: 14 days old.

### 3.4 Previously rejected (Gate 0 research; not re-run)

| Token | Address | Reason |
|---|---|---|
| GIGATENEV | `0xC9675fe679C7d4e1b94416F66D61c96127eb964a` | Name references Robinhood's CEO (impersonation) |
| ANT | `0x36C2…9B30` (full address in the Gate 0 research notes) | "Anthropic" impersonation |
| FOBO | — | 67% held by one contract |
| CALLCAT, ORGENT, STONKSPAIR | — | Brand new; STONKSPAIR had 36.6% in one wallet |

None may be listed without a fresh vetting run against an exact address, and explicit approval.

## 4. Human review checklist (per listing)

- [ ] Exact address confirmed from at least two independent sources (for example, the deployer's announcement and
      the verified contract page).
- [ ] Verified source read in full; every WARN and FAIL explained in writing.
- [ ] Holder table and cluster sections reviewed; concentration acceptable for the planned cap.
- [ ] LP custody understood (burned, locked or withdrawable), and the dependency contracts reviewed.
- [ ] Unit size derived from the 7-day median (`LAUNCH_RUNBOOK.md` §3.1) and a pilot cap chosen.
- [ ] Written approval from the project owner recorded.
