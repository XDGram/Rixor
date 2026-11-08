// Runtime configuration. Every value can be overridden with an environment variable.
import { resolve } from 'node:path'

const num = (v, d) => (v === undefined || v === '' ? d : Number(v))

export const config = {
  port: num(process.env.PORT, 8080),
  stateDir: resolve(process.env.STATE_DIR || './data'),
  // Read-only source of mainnet state, used ONCE to build the genesis. Nothing is ever sent to it.
  upstreamRpc: process.env.UPSTREAM_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  upstreamChainId: 4663,
  // The demo chain deliberately uses a different chain id from Robinhood Chain mainnet (4663) and testnet
  // (46630) so that a transaction signed for the demo can never be replayed on a real network.
  chainId: num(process.env.DEMO_CHAIN_ID, 466399),
  anvilPort: num(process.env.ANVIL_PORT, 8546),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  faucetWif: process.env.FAUCET_WIF || '1000000', // whole fork-WIF per request
  faucetEth: process.env.FAUCET_ETH || '0.5', // fork ETH for gas
  faucetCooldownMs: num(process.env.FAUCET_COOLDOWN_MS, 10 * 60 * 1000),
  timeControl: process.env.TIME_CONTROL !== 'off',
  maxTimeAdvance: num(process.env.MAX_TIME_ADVANCE, 31 * 24 * 3600),
  // Demo-only parameters. Provisional; NOT approved production values.
  demo: {
    minHoldSeconds: num(process.env.DEMO_MIN_HOLD, 3600),
    wifUnit: process.env.DEMO_WIF_UNIT || '7500',
    wifCap: process.env.DEMO_WIF_CAP || '50000000',
    faucetReserve: process.env.DEMO_FAUCET_RESERVE || '60000000',
  },
}

export const ADDR = {
  WIF: '0x5173b8eA6923c2d40267890D45C46a3480954773',
  // Canonical Safe v1.5.0 deployments (verified on chain 4663; copied into the demo genesis).
  SAFE_L2_SINGLETON: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
  SAFE_FACTORY: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
  SAFE_FALLBACK: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
  // Large WIF holders on mainnet. On the private fork only, a slice of their balance is moved to the demo
  // faucet by impersonation. Their real mainnet balances are untouched.
  WIF_SOURCES: [
    '0x1089a7C3915c9F067615909DBd07697C21c32156',
    '0x2243928944619f832f689BBc15f1E654B7686504',
    '0xe89DE31F1423f6041851ffA974A9f29a06eF8e11',
  ],
}
