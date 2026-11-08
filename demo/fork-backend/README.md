# Rixor fork-demo backend

Private, persistent demo chain built from Robinhood Chain mainnet state, plus a restricted public HTTP API.
Fork only: it never sends anything to a real network. See [`docs/DEMO.md`](../../docs/DEMO.md) for the architecture,
security boundaries, hosting options and costs.

```bash
npm ci
STATE_DIR=./data PORT=8080 npm start
```

`artifacts/` is generated from the Foundry build by `npm run demo:artifacts` at the repository root.
`data/` (state and throwaway keys) is never committed.
