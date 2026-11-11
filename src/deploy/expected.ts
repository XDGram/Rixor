// Pinned facts the Deploy Console checks every transaction against. They are compiled into the console itself, so a
// bundle cannot change them. Every value mirrors a deployment-script constant or the reviewed Forge build, and
// scripts/test-deploy-console.mjs fails if any of them drifts from script/*.s.sol or out/*.json.

/** Chains the console will ever talk to. Mainnet (4663) only with a mainnet-profile bundle AND MAINNET_PLAN_APPROVED. */
export const TESTNET_CHAIN_ID = 46630
export const REHEARSAL_CHAIN_ID = 31337
export const MAINNET_CHAIN_ID = 4663
/** The only RPC a testnet bundle may name (Robinhood Chain docs). A rehearsal bundle must use a same-origin relative
 *  path ("rpc"), so the console's independent reads always go to the chain the bundle was made for. */
export const TESTNET_RPC = 'https://rpc.testnet.chain.robinhood.com'
export const TESTNET_EXPLORER = 'https://explorer.testnet.chain.robinhood.com'
export const REHEARSAL_RPC_PATH = 'rpc'

/** Safe v1.5.0 on Robinhood Chain testnet (CreateTestnetSafes.s.sol). */
export const SAFE = {
  factory: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
  singletonL2: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
  fallbackHandler: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
  /** keccak256(factory.proxyCreationCode() ++ uint256(singletonL2)): the CREATE2 init-code hash of every Rixor Safe. */
  proxyInitcodeHash: '0xc00f8ed2d8e1bacf9a81836a956d9be01fbb50416bce76c09d18859e6bb6d223',
  threshold: 2,
  /** uint256(keccak256("rixor.testnet.owner-safe.v1")) and (...guardian-safe.v1), as decimal strings. */
  ownerSaltLabel: 'rixor.testnet.owner-safe.v1',
  guardianSaltLabel: 'rixor.testnet.guardian-safe.v1',
} as const

/** Runtime code hash of every Safe v1.5.0 proxy created by the factory (the singleton lives in storage slot 0). */
export const SAFE_PROXY_RUNTIME_HASH = '0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f'

/** keccak256 of each contract's creation code (bytecode without constructor arguments), from the reviewed build. */
export const INITCODE_HASH = {
  RixorTestToken: '0x084d62ec46c074d8ab267d7faf67677e9810788e5139b82a79d20f503248490e',
  RixorLocker: '0x25c37a99e723adaf680bc422a864b6cca8d238cdb420f67bd4fb698b2aec7715',
  RixorRewards: '0x9f85a8f8b47cc19f601d546984eb9cd275ad1916fdb02caab0419a715f2317b5',
  RixorChallenges: '0xf59dc41f161d4ea3e5cdd9ee566a8f0b0c5ae95ef694fa5b23cb01da6bb7e852',
  RixorLite: '0x8bc3a6122bee64d3c518a868f92e3a2c4682a87bb6c9dc7436f695d6dc7a7c9d',
} as const
export const INITCODE_BYTES = { RixorTestToken: 2885, RixorLocker: 19201, RixorRewards: 9484, RixorChallenges: 15274, RixorLite: 4753 } as const
/** The Locker has no immutables, so its runtime code is identical on every chain (VerifyRixorV2 relies on this too). */
export const LOCKER_RUNTIME_HASH = '0xeeda456a7d3ea255b3b9c08c083117be611edcfb4c2d7c1c55913876b10b3aa6'

/** Approved TEST tokens (DeployTestnetTokens.s.sol). The whole initial supply goes to the deployer. */
export const TOKENS = [
  { key: 'tMEMEA', name: 'Rixor Test Meme A (TEST)', symbol: 'tMEMEA', decimals: 18, supply: 1_000_000_000n * 10n ** 18n, faucet: 100_000n * 10n ** 18n },
  { key: 'tMEMEB', name: 'Rixor Test Meme B (TEST)', symbol: 'tMEMEB', decimals: 6, supply: 1_000_000_000n * 10n ** 6n, faucet: 100_000n * 10n ** 6n },
  { key: 'tWIF', name: 'Rixor Test Reward (TEST)', symbol: 'tWIF', decimals: 18, supply: 1_000_000_000n * 10n ** 18n, faucet: 250_000n * 10n ** 18n },
] as const

/** Approved Locker listings set in the constructor (no timelock) and the Challenges minimum hold. */
export const LISTINGS = [
  { token: 'tMEMEA', unitAmount: 1_000n * 10n ** 18n, maxTotalLocked: 20_000_000n * 10n ** 18n, riskClass: 1 },
  { token: 'tMEMEB', unitAmount: 1_000n * 10n ** 6n, maxTotalLocked: 10_000_000n * 10n ** 6n, riskClass: 2 },
] as const
export const MIN_HOLD_SECONDS = 3600n

/** Approved reward streams (SeedTestnetRewards.s.sol): one approval for the total, then one fund() per token. */
export const STREAMS = [
  { token: 'tMEMEA', amount: 140_000n * 10n ** 18n, days: 14n },
  { token: 'tMEMEB', amount: 70_000n * 10n ** 18n, days: 14n },
] as const
export const APPROVE_TOTAL = 210_000n * 10n ** 18n

/** The only accepted step layout: 11 transactions, all from the deployer, value 0, nonces consecutive. */
export const STEP_LAYOUT = [
  { kind: 'safe', role: 'owner', label: 'Create the owner Safe (2-of-3)' },
  { kind: 'safe', role: 'guardian', label: 'Create the guardian Safe (2-of-3)' },
  { kind: 'token', token: 'tMEMEA', label: 'Deploy tMEMEA (TEST, Class A)' },
  { kind: 'token', token: 'tMEMEB', label: 'Deploy tMEMEB (TEST, Class B)' },
  { kind: 'token', token: 'tWIF', label: 'Deploy tWIF (TEST reward token)' },
  { kind: 'locker', label: 'Deploy RixorLocker' },
  { kind: 'rewards', label: 'Deploy RixorRewards' },
  { kind: 'challenges', label: 'Deploy RixorChallenges' },
  { kind: 'approve', label: 'Approve 210,000 tWIF for RixorRewards' },
  { kind: 'fund', stream: 0, label: 'Fund the tMEMEA stream: 140,000 tWIF over 14 days' },
  { kind: 'fund', stream: 1, label: 'Fund the tMEMEB stream: 70,000 tWIF over 14 days' },
] as const

/** Gas: the live estimate is used, but never less than this margin over the reviewed plan, and a live estimate this
 *  many times larger than the plan stops the console (something differs from what was reviewed). */
export const GAS_MARGIN_BPS = 13_000n // 1.3x
export const GAS_ESTIMATE_MAX_FACTOR = 3n

// ================================================================== MAINNET PROFILE (real $WIF)
// Robinhood Chain mainnet (4663). Same contracts and Safe v1.5.0 deployment; no TEST tokens: the reward token is the
// official $WIF and the listed tokens are existing mainnet tokens. Mirrors script/CreateMainnetSafes.s.sol,
// script/SeedMainnetRewards.s.sol and deploy/config/mainnet.candidate.json (scripts/test-deploy-console.mjs fails on
// drift). Rehearsal: a local fork of mainnet with chain id 31337.

/**
 * The single switch for real mainnet signing. While false the console verifies, displays and rehearses a mainnet bundle
 * (on a chain-31337 fork) but refuses to ask a wallet to sign anything on chain 4663. It is set to true only in a
 * reviewed commit made after the project owner's written approval of exactly the plan below (listings, units, caps,
 * reward budgets, minimum hold).
 */
export const MAINNET_PLAN_APPROVED = false

/** Official endpoints (docs.robinhood.com/chain/connecting). */
export const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com'
export const MAINNET_EXPLORER = 'https://robinhoodchain.blockscout.com'
export const MAINNET_SAFE_SALT_LABELS = { owner: 'rixor.mainnet.owner-safe.v1', guardian: 'rixor.mainnet.guardian-safe.v1' } as const

const E18 = 10n ** 18n
/** Existing mainnet tokens, pinned by address AND runtime code hash (checked before step 1 and on every resume). */
export const MAINNET_TOKENS = {
  WIF: { address: '0x5173b8eA6923c2d40267890D45C46a3480954773', name: 'World is Flat', symbol: 'WIF', decimals: 18, runtimeHash: '0xbd9466af58a95576282f8a67fe81c5ed8b78c22c362be48c511608a30652f59f' },
  HOOKR: { address: '0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c', name: 'Hookr.fun', symbol: 'HOOKR', decimals: 18, runtimeHash: '0xd9346eaf1a9878650549765e1d4ce8b3d0516d93d3203e1c8b99e382428ebc8d' },
  TORCH: { address: '0x000050E18ffa3F8F7aD170Eb9CeF160eb3Ed1111', name: 'Torch', symbol: 'TORCH', decimals: 18, runtimeHash: '0xb0fa838cbdc6954847ba655756962fbfaec782836d3dfc78a14c3a97b13e6007' },
} as const
export type MainnetTokenKey = keyof typeof MAINNET_TOKENS

/** CANDIDATE listings (constructor, no timelock: nobody can have locked anything yet). Units ~$20, caps ~$50k (9 Nov 2026). */
export const MAINNET_LISTINGS = [
  { token: 'HOOKR', unitAmount: 1_000n * E18, maxTotalLocked: 2_500_000n * E18, riskClass: 2 },
  { token: 'TORCH', unitAmount: 5_000n * E18, maxTotalLocked: 10_000_000n * E18, riskClass: 2 },
] as const
export const MAINNET_MIN_HOLD_SECONDS = 86_400n
/** CANDIDATE reward budget: the contract minimum per stream (10,000 WIF), 14 days each, funded by the deployer. */
export const MAINNET_STREAMS = [
  { token: 'HOOKR', amount: 10_000n * E18, days: 14n },
  { token: 'TORCH', amount: 10_000n * E18, days: 14n },
] as const
export const MAINNET_APPROVE_TOTAL = 20_000n * E18

export const MAINNET_STEP_LAYOUT = [
  { kind: 'safe', role: 'owner', label: 'Create the owner Safe (2-of-3)' },
  { kind: 'safe', role: 'guardian', label: 'Create the guardian Safe (2-of-3)' },
  { kind: 'locker', label: 'Deploy RixorLocker (lists HOOKR and TORCH, Class B)' },
  { kind: 'rewards', label: 'Deploy RixorRewards (pays the official WIF)' },
  { kind: 'challenges', label: 'Deploy RixorChallenges (pays the official WIF)' },
  { kind: 'approve', label: 'Approve 20,000 WIF for RixorRewards' },
  { kind: 'fund', stream: 0, label: 'Fund the HOOKR stream: 10,000 WIF over 14 days' },
  { kind: 'fund', stream: 1, label: 'Fund the TORCH stream: 10,000 WIF over 14 days' },
] as const

// ================================================================== LITE PROFILE (the $5 hackathon demo)
// One contract (contracts/RixorLite.sol), one lockable token (HOOKR), rewards in the official $WIF paid from a
// separate reward wallet, which is the deployer. Two transactions. Mirrors script/DeployRixorLite.s.sol
// (scripts/test-deploy-console-lite.mjs fails on drift). RixorLite has no owner, so the plan has no Safes.

/** The single switch for real mainnet signing of the Lite plan.
 *  APPROVED by the project owner in writing on 11 Nov 2026: the Lite contract with the parameters below, without Safes
 *  or signers, for the hackathon demo. This only lets the Deploy Console ASK a wallet to sign: every transaction still
 *  needs the owner's own tap and their wallet's approval, a final bundle for their deployer, and a prefunded reward
 *  wallet. Any change to a parameter below needs a new approval. */
export const LITE_PLAN_APPROVED = true

export const LITE = {
  token: 'HOOKR',
  budget: 1_000n * E18, // WIF the reward wallet commits
  durationSeconds: 7n * 86_400n, // rewards run for 7 days from deployment
  lockSeconds: 86_400n, // each lock or top-up is held for 1 day
  minLock: 10n * E18,
  cap: 100_000n * E18, // the most HOOKR the contract will ever hold
} as const

export const LITE_STEP_LAYOUT = [
  { kind: 'lite', label: 'Deploy RixorLite (lock HOOKR, earn WIF)' },
  { kind: 'approve', label: 'Approve 1,000 WIF for RixorLite rewards' },
] as const
