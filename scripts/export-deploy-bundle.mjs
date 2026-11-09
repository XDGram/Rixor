#!/usr/bin/env node
// DEPLOY BUNDLE EXPORTER (sends nothing to any real network).
//
// Runs the real deployment scripts (scripts/lib/forge-plan.mjs: same scripts, order and guards as plan-testnet.mjs)
// on a LOCAL chain and exports the exact 11 transactions for the iPhone Deploy Console (src/deploy). The bundle is
// then checked with the console's own core (src/deploy/core.ts): every transaction must equal the one the console
// rebuilds from its pinned constants, and every post-deployment check must pass on the local chain.
//
// Final testnet bundle (requires the real seven public addresses):
//   node scripts/export-deploy-bundle.mjs --addresses deploy/addresses.json [--out deployments/46630-deploy-bundle.json]
//   (or RIXOR_DEPLOYER=… RIXOR_OWNER_SIGNERS=a,b,c RIXOR_GUARDIAN_SIGNERS=d,e,f)
//   Local fork of Robinhood Chain testnet (chain id 46630 preserved, deployer nonce read from testnet).
//
// Rehearsal bundle (local chain 31337 with the Safe v1.5.0 snapshot; for the Zerion rehearsal and the tests):
//   node scripts/export-deploy-bundle.mjs --rehearsal [--addresses … | --deployer 0x… | --allow-placeholders] [--out …]
//   (--deployer: the real deployer account that will sign in the wallet, with placeholder Safe signers)
//
// MAINNET profile (real $WIF; add --mainnet to either form above):
//   node scripts/export-deploy-bundle.mjs --mainnet --addresses deploy/addresses.json         → deployments/4663-deploy-bundle.json
//   node scripts/export-deploy-bundle.mjs --mainnet --rehearsal --deployer 0x…                → deployments/31337-mainnet-deploy-bundle-placeholder.json
//   The plan always runs on a LOCAL fork of mainnet with chain id 31337 (deployer nonce, Safes, WIF, HOOKR and TORCH
//   read from mainnet; the deployer's WIF is written on the fork only). No authorisation sentence is ever supplied.
//
// Placeholder addresses are allowed only with --allow-placeholders and always produce `final: false`; the console
// refuses a non-final bundle on testnet (and the file name ends in -placeholder).
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Interface, JsonRpcProvider, Wallet, formatEther, getAddress, id as labelHash, keccak256 } from 'ethers'
import { runForgePlan } from './lib/forge-plan.mjs'
import { fundLocal, fundLocalWif, startRehearsalChain } from './lib/rehearsal-chain.mjs'
import { signerCodeProblems } from './lib/signer-sets.mjs'
import { BUNDLE_FORMAT, PROFILES, assess, bundleHashOf, expectedChecks, signerProblems, validateBundle } from '../src/deploy/core.ts'
import { GAS_MARGIN_BPS, MAINNET_APPROVE_TOTAL, REHEARSAL_RPC_PATH } from '../src/deploy/expected.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined }
const die = (m) => { console.error(`refusing: ${m}`); process.exit(1) }
const REHEARSAL = flag('rehearsal')
const NETWORK = flag('mainnet') ? 'mainnet' : 'testnet'
const PROFILE = PROFILES[NETWORK]
const LIVE_ID = PROFILE.liveChainId
// --created-at / --gas-price make a bundle reproducible: the same commit, addresses, start nonce and these two values
// always give the same bundle hash, so a bundle regenerated elsewhere can be compared hash-for-hash.
const CREATED_AT = opt('created-at') ?? new Date().toISOString()
if (Number.isNaN(Date.parse(CREATED_AT))) { console.error('refusing: --created-at must be an ISO date'); process.exit(1) }
const GAS_PRICE_OVERRIDE = opt('gas-price') ? BigInt(opt('gas-price')) : null
const CHAIN_ID = REHEARSAL ? 31337 : LIVE_ID
const UPSTREAM_RPC = NETWORK === 'mainnet' ? (process.env.RH_MAINNET_RPC_URL || PROFILE.rpc) : (process.env.RH_TESTNET_RPC_URL || PROFILE.rpc)

// ---------------------------------------------------------------- the seven public addresses
const placeholder = (label) => new Wallet(labelHash(`rixor.${NETWORK}.plan.placeholder.${label}`)).address
let input = null
if (opt('addresses')) {
  const j = JSON.parse(readFileSync(opt('addresses'), 'utf8'))
  input = { deployer: j.deployer?.address ?? j.deployer, owner: (j.ownerSafeSigners ?? j.owner ?? []).map((s) => s.address ?? s), guardian: (j.guardianSafeSigners ?? j.guardian ?? []).map((s) => s.address ?? s) }
} else if (process.env.RIXOR_DEPLOYER && process.env.RIXOR_OWNER_SIGNERS && process.env.RIXOR_GUARDIAN_SIGNERS) {
  input = { deployer: process.env.RIXOR_DEPLOYER, owner: process.env.RIXOR_OWNER_SIGNERS.split(','), guardian: process.env.RIXOR_GUARDIAN_SIGNERS.split(',') }
}
// Rehearsal only: the real deployer (the account that will sign in the wallet) with placeholder signers, before the
// six signer addresses are collected. Always final:false; the Safes then exist only on the local rehearsal chain.
let rehearsalDeployerOnly = null
if (opt('deployer')) {
  if (!REHEARSAL || input) die('--deployer is only for a rehearsal bundle without the full seven addresses')
  rehearsalDeployerOnly = opt('deployer')
}
const final = input !== null
if (!final && !rehearsalDeployerOnly && !flag('allow-placeholders')) die('the real seven public addresses are required (--addresses file or RIXOR_* env); use --allow-placeholders for an illustrative, non-final bundle')
// A testnet-fork bundle with placeholders is only for testing this exporter: it is marked final:false and the console
// refuses it on testnet.
let deployer, owners, guardians
try {
  deployer = getAddress((input?.deployer ?? rehearsalDeployerOnly ?? placeholder('deployer')).trim())
  owners = (input?.owner ?? [1, 2, 3].map((i) => placeholder(`owner${i}`))).map((a) => getAddress(String(a).trim()))
  guardians = (input?.guardian ?? [1, 2, 3].map((i) => placeholder(`guardian${i}`))).map((a) => getAddress(String(a).trim()))
} catch (e) { die(`invalid address: ${e.shortMessage ?? e.message}`) }
const sp = signerProblems(deployer, owners, guardians)
if (sp.length) die(sp.join('; '))

// Signers must be plain EOAs on the live chain (no code, no EIP-7702 delegation): checked read-only.
const upstream = new JsonRpcProvider(UPSTREAM_RPC, LIVE_ID, { staticNetwork: true })
let upstreamOk = true
try {
  if (Number(await upstream.send('eth_chainId', [])) !== LIVE_ID) die(`${UPSTREAM_RPC} is not Robinhood Chain ${NETWORK} (${LIVE_ID})`)
  const cp = await signerCodeProblems(upstream, { owners, guardians, deployer })
  if (cp.length) die(cp.join('; '))
} catch (e) {
  if (!REHEARSAL || NETWORK === 'mainnet') die(`cannot read Robinhood Chain ${NETWORK}: ${e.message}`)
  upstreamOk = false
}

// ---------------------------------------------------------------- local chain
let chain, startNonce = 0, gasPrice = 10_000_000n
if (NETWORK === 'mainnet') {
  // Both the real mainnet bundle and its rehearsal are planned on a local mainnet fork (chain id 31337): the deployer's
  // real nonce, the real Safe factory and the real tokens; ETH and WIF for the deployer are written on the fork only.
  startNonce = await upstream.getTransactionCount(deployer, 'latest')
  if ((await upstream.getTransactionCount(deployer, 'pending')) !== startNonce) die('the deployer has a pending transaction on mainnet; wait and re-run')
  gasPrice = GAS_PRICE_OVERRIDE ?? BigInt(await upstream.send('eth_gasPrice', []))
  chain = await startRehearsalChain({ impersonate: true, fork: 'mainnet' })
  await fundLocal(chain.provider, deployer, 10n ** 17n)
  await fundLocalWif(chain.provider, deployer, MAINNET_APPROVE_TOTAL)
} else if (REHEARSAL) {
  chain = await startRehearsalChain({ impersonate: true })
  await fundLocal(chain.provider, deployer, 10n ** 18n)
  if (upstreamOk) gasPrice = BigInt(await upstream.send('eth_gasPrice', []))
  if (GAS_PRICE_OVERRIDE !== null) gasPrice = GAS_PRICE_OVERRIDE
} else {
  startNonce = await upstream.getTransactionCount(deployer, 'latest')
  if ((await upstream.getTransactionCount(deployer, 'pending')) !== startNonce) die('the deployer has a pending transaction on testnet; wait and re-run')
  gasPrice = GAS_PRICE_OVERRIDE ?? BigInt(await upstream.send('eth_gasPrice', []))
  const port = 8900 + Math.floor(Math.random() * 90)
  const anvil = spawn(process.execPath, [join(ROOT, 'node_modules/@foundry-rs/anvil/bin.mjs'), '--fork-url', UPSTREAM_RPC, '--host', '127.0.0.1', '--port', String(port), '--silent', '--auto-impersonate'], { stdio: 'ignore' })
  const rpc = `http://127.0.0.1:${port}`
  const provider = new JsonRpcProvider(rpc, 46630, { staticNetwork: true, cacheTimeout: -1 })
  for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break } catch { if (i > 120) { anvil.kill(); die('local fork did not start') } await new Promise((r) => setTimeout(r, 500)) } }
  if (Number(await provider.send('eth_chainId', [])) !== 46630) { anvil.kill(); die('local fork lost chain id 46630') }
  await provider.send('anvil_setBalance', [deployer, '0xde0b6b3a7640000']) // local fork only
  chain = { rpc, provider, stop: () => new Promise((r) => { anvil.once('exit', () => r()); anvil.kill('SIGTERM') }) }
}

let ok = false
try {
  const local = chain.provider
  const localRpc = (m, p) => local.send(m, p)
  const LAYOUT = PROFILE.layout
  const planChain = NETWORK === 'mainnet' ? 31337 : CHAIN_ID
  const plan = runForgePlan({ rpc: chain.rpc, chainId: planChain, deployer, owners, guardians, tag: 'bundle', network: NETWORK })
  if (plan.records.length !== LAYOUT.length) throw new Error(`the scripts sent ${plan.records.length} transactions, expected ${LAYOUT.length}`)

  const transactions = []
  for (const [i, r] of plan.records.entries()) {
    const t = r.transaction
    if (BigInt(r.receipt.status) !== 1n) throw new Error(`step ${i + 1} reverted on the local plan`)
    if (getAddress(t.from) !== deployer || Number(BigInt(t.nonce)) !== startNonce + i) throw new Error(`step ${i + 1}: unexpected sender or nonce`)
    let creates = null
    const L = LAYOUT[i]
    if (L.kind === 'safe') creates = { address: L.role === 'owner' ? plan.ownerSafe : plan.guardianSafe }
    else if (r.type === 'CREATE') creates = { address: getAddress(r.receipt.contractAddress) }
    if (creates) creates.codeHash = keccak256(await local.getCode(creates.address))
    transactions.push({ index: i + 1, nonce: startNonce + i, label: L.label, from: deployer, to: t.to ? getAddress(t.to) : null, value: '0x0', data: t.input, gasPlanned: BigInt(r.receipt.gasUsed).toString(), creates, checks: [] })
  }
  const addresses = NETWORK === 'mainnet'
    ? { ownerSafe: plan.ownerSafe, guardianSafe: plan.guardianSafe, locker: getAddress(plan.manifest.locker), rewards: getAddress(plan.manifest.rewards), challenges: getAddress(plan.manifest.challenges) }
    : {
        ownerSafe: plan.ownerSafe, guardianSafe: plan.guardianSafe, tMEMEA: getAddress(plan.cfg.listings[0].token), tMEMEB: getAddress(plan.cfg.listings[1].token),
        tWIF: getAddress(plan.cfg.wif), locker: getAddress(plan.manifest.locker), rewards: getAddress(plan.manifest.rewards), challenges: getAddress(plan.manifest.challenges),
      }
  const skeleton = { network: NETWORK, deployer, signers: { owner: owners, guardian: guardians }, addresses, transactions }
  transactions.forEach((t, i) => { t.checks = expectedChecks(skeleton, i) })

  // Arbitrum L1 data component (NodeInterface, read-only on the real chain): not modelled by a local chain.
  let l1 = 0n
  if (upstreamOk) {
    const ni = new Interface(['function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)'])
    for (const t of transactions) {
      const out = ni.decodeFunctionResult('gasEstimateL1Component', await upstream.call({ to: '0x00000000000000000000000000000000000000C8', data: ni.encodeFunctionData('gasEstimateL1Component', [t.to ?? '0x0000000000000000000000000000000000000000', t.to === null, t.data]) }))
      l1 += out[0]
    }
  }
  let commit = 'unknown', dirty = true
  try { commit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); dirty = execSync('git status --porcelain -- contracts script src/deploy scripts/lib scripts/export-deploy-bundle.mjs', { cwd: ROOT, encoding: 'utf8' }).trim() !== '' } catch { /* not a git checkout */ }
  const bundle = {
    format: BUNDLE_FORMAT, network: NETWORK, final, rehearsal: REHEARSAL, chainId: CHAIN_ID,
    rpc: REHEARSAL ? REHEARSAL_RPC_PATH : PROFILE.rpc, explorer: REHEARSAL ? null : PROFILE.explorer,
    createdAt: CREATED_AT, source: { commit, dirty, planner: 'scripts/export-deploy-bundle.mjs (forge scripts on a local chain)' },
    deployer, startNonce, signers: { owner: owners, guardian: guardians }, addresses, transactions,
    gas: { totalPlanned: transactions.reduce((s, t) => s + BigInt(t.gasPlanned), 0n).toString(), gasPriceWei: gasPrice.toString(), l1ComponentGas: l1.toString() },
  }
  bundle.bundleHash = bundleHashOf(bundle)

  // Self-check with the console's own core: static validation, then every durable check on the local chain.
  const problems = validateBundle(bundle, { exporterSelfCheckOfPlaceholder: !final })
  if (problems.length) throw new Error(`the bundle fails the console's validation:\n  - ${problems.join('\n  - ')}`)
  // The local plan chain may differ from the bundle's chain id (mainnet bundles are planned on a 31337 fork).
  const a = await assess(localRpc, { ...bundle, startNonce, chainId: Number(await local.send('eth_chainId', [])) })
  if (a.status !== 'complete') throw new Error(`the local chain does not verify against the bundle: ${a.status} ${a.problems.join('; ')}`)
  const failed = a.steps.flatMap((s, i) => s.checks.filter((c) => !c.ok).map((c) => `step ${i + 1} ${c.label}: ${c.detail}`))
  if (failed.length) throw new Error(failed.join('\n'))

  const out = opt('out') ?? join('deployments', `${CHAIN_ID}-${NETWORK === 'mainnet' && REHEARSAL ? 'mainnet-' : ''}deploy-bundle${final ? '' : '-placeholder'}.json`)
  mkdirSync(dirname(resolve(ROOT, out)), { recursive: true })
  writeFileSync(resolve(ROOT, out), JSON.stringify(bundle, null, 2) + '\n')

  const limits = transactions.reduce((s, t) => s + (BigInt(t.gasPlanned) * GAS_MARGIN_BPS + 9_999n) / 10_000n, 0n)
  const need = limits * gasPrice * 2n
  console.log(JSON.stringify({
    file: out, bundleHash: bundle.bundleHash, network: NETWORK, final, rehearsal: REHEARSAL, chainId: CHAIN_ID, deployer, startNonce,
    signers: bundle.signers, addresses,
    transactions: transactions.map((t) => ({ n: t.index, nonce: t.nonce, step: t.label, to: t.to ?? 'contract creation', bytes: (t.data.length - 2) / 2, gasPlanned: t.gasPlanned, creates: t.creates?.address ?? null })),
    gas: { ...bundle.gas, sumOfGasLimits: limits.toString(), worstCaseCostEth: formatEther(need), recommendedDeployerBalanceEth: formatEther(need * 10n > 5n * 10n ** 15n ? need * 10n : 5n * 10n ** 15n) },
    selfCheck: `console core: bundle valid; all ${a.steps.reduce((s, x) => s + x.checks.length, 0)} post-deployment checks pass on the local chain`,
  }, null, 2))
  ok = true
} catch (e) {
  console.error(`export failed: ${e.message}`)
} finally {
  await chain.stop()
  process.exit(ok ? 0 : 1)
}
