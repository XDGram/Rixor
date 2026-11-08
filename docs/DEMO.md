# Rixor fork demo

A reviewable, mobile-accessible demo of the Gate 1 contracts running against **a private copy of Robinhood Chain
mainnet state**. Nothing in the demo touches Robinhood Chain mainnet: no deployment, no transaction, no real asset.

```
 Phone / browser ──https──►  Vercel preview (static React app)
        │
        └────────https──►  Rixor fork backend (Node + private anvil)  ── reads mainnet state ONCE at first boot
                            /rpc  /manifest  /health  /faucet  /time/advance
```

## 1. How the demo chain is built

On first boot the backend (`demo/fork-backend`):

1. Starts a **local, private** anvil fork of Robinhood Chain mainnet at the latest block.
2. On that fork only, moves about 58M WIF from three large holders to a demo faucet by impersonation. Their real
   balances are untouched; impersonation exists only inside the private fork.
3. Copies the real **WIF** contract code plus every storage slot its ERC-20 functions read (found with
   `eth_createAccessList`), and the canonical **Safe v1.5.0** contracts.
4. Starts a **standalone** demo chain from that genesis.
   - Chain id **466399**, deliberately different from mainnet 4663 and testnet 46630, so demo signatures cannot be
     replayed on a real network.
   - It is persisted to disk every 10 seconds and on shutdown. The public RPC keeps only about 10–35 minutes of
     state, so the demo must not depend on the upstream after boot.
5. On the demo chain, as ordinary transactions:
   - deploys two 2-of-3 Safes (throwaway keys) as Locker owner and guardian;
   - deploys `RixorLocker` (WIF only; unit 7,500 WIF and cap 50M WIF are **provisional demo values**) and
     `RixorChallenges` (`minHold` = 1 hour, **demo value**; production is 24 hours);
   - creates two **labelled demo seed challenges**: a community challenge funded by a demo sponsor wallet, and a
     Season challenge funded by the demo owner Safe through a 2-of-3 Safe transaction;
   - three labelled **demo bots** lock and join, so the screens are not empty.

Later boots resume the same chain from the state directory. Chain time never moves backwards across restarts.

## 2. Security boundaries

| Concern | How it is handled |
|---|---|
| Real network | The upstream is read only at first boot, through anvil's fork backend. The demo never broadcasts to Robinhood Chain. |
| Replay | Demo chain id 466399 ≠ 4663 / 46630. |
| Privileged RPC | Anvil listens on 127.0.0.1 only. `/rpc` allowlists read methods and `eth_sendRawTransaction`. `anvil_*`, `evm_*`, `debug_*`, `hardhat_*`, `eth_sendTransaction` and `eth_sign` are rejected, and `eth_accounts` returns `[]`. |
| Keys | Throwaway keys (deployer, faucet, Safe signers, demo bots) are generated on the server and stored only in the state directory (mode 600). The frontend contains no keys. |
| Reviewer wallet | A throwaway key generated in the reviewer's browser, used only for chain 466399. Reviewers never share keys or seed phrases. |
| Abuse | Rate limits on RPC (600/min/IP), raw transactions (60/min/IP), the faucet (1 per address per 10 min, 10 per IP per hour) and time control (30 per IP per hour, at most 31 days per call). Request bodies are limited to 128 KB, batches to 25, and log ranges to 200k blocks. |
| Shared time control | `/time/advance` moves the shared demo clock. It is a demo affordance with no real-network equivalent, and is labelled as such in the app. Disable it with `TIME_CONTROL=off`. |

## 3. Hosting the backend (requires approval: paid service)

The frontend is static and goes on Vercel. The backend is a long-running process with a persistent disk, which
Vercel cannot host. Vercel Sandbox sessions are capped at 45 minutes on Hobby and have per-session URLs. Any
container host with a persistent volume works. The image is `demo/fork-backend/Dockerfile`, and it needs about
512 MB of RAM and a 1 GB volume at `/data`.

| Option | Approx. cost (Nov 2026, check before buying) | Setup |
|---|---|---|
| **Fly.io** (recommended) | shared-cpu-1x 512 MB ≈ $3.7/month, plus a 1 GB volume ≈ $0.15/month | `fly launch` from `demo/fork-backend`, `fly volumes create rixor_data --size 1`, mount at `/data` |
| Railway | Hobby $5/month, which includes $5 of usage; this service should fit or slightly exceed it; volumes $0.15/GB-month | "Deploy from GitHub repo", root directory `demo/fork-backend`, add a volume at `/data`, generate a domain |
| Render | Starter about $7/month, plus a disk at about $0.25/GB-month | Docker web service, root `demo/fork-backend`, disk at `/data` |

Each option needs an account created and paid for by the project owner. Claude cannot create accounts or enter
payment details. Once the service has an https URL:

1. Open the preview with `?backend=https://<service-host>` once; the phone remembers it. Or set
   `VITE_RIXOR_FORK_BACKEND` for Preview builds in Vercel.
2. Optionally set `ALLOWED_ORIGINS` on the backend to the preview domain(s), for example
   `https://rixor-*.vercel.app` (`*.` patterns are supported).

Environment variables (all optional): `PORT`, `STATE_DIR` (default `/data`), `UPSTREAM_RPC`, `DEMO_CHAIN_ID`,
`ALLOWED_ORIGINS`, `FAUCET_WIF`, `FAUCET_ETH`, `TIME_CONTROL`, `DEMO_MIN_HOLD`, `DEMO_WIF_UNIT`, `DEMO_WIF_CAP`.

To reset the demo, stop the service and delete the volume contents. The next boot builds a fresh genesis from the
latest mainnet block.

## 4. Reviewing on a phone

1. Open the Vercel preview URL. Vercel asks you to sign in, because preview protection is on.
2. If no backend is configured, paste the backend https URL on the setup screen.
3. Tap **Wallet → Create demo wallet**, then **Get … fork WIF**.
4. **Lock**: choose a tier, amount and term → **Lock WIF**. This sends two fork transactions, approve then lock.
5. **Explore → New**: create a challenge, for example a 1 h join window with the minimum hold. Open it and **Join**
   with your position. Optionally **Sponsor**.
6. **Wallet → +1d** moves demo time past the end. Then **Settle challenge** → **Claim**.
7. For refunds, create a challenge with a large collective goal, join, advance time, settle, then **Refund**.
8. **Portfolio** shows positions, exit rules and claims. **Activity** shows every on-chain event.

## 5. Local development

```bash
npm run demo:backend          # first boot ~10 s; state in demo/fork-backend/data
npm run dev                   # open http://localhost:5173/?backend=http://localhost:8080
npm run demo:e2e -- http://localhost:5173 http://localhost:8080   # mobile end-to-end journey (Playwright)
```
