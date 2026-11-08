#!/usr/bin/env node
// TESTNET DEPLOYMENT PLAN: runs the exact testnet scripts against a LOCAL anvil fork of Robinhood Chain testnet
// (chain id 46630 preserved) and prints the transaction sequence, the resulting addresses, gas used and cost.
// Nothing is sent to the real testnet.
//
//   RIXOR_DEPLOYER=0x… RIXOR_OWNER_SIGNERS=0xA,0xB,0xC RIXOR_GUARDIAN_SIGNERS=0xD,0xE,0xF npm run plan:testnet
//
// With the real deployer and signer addresses the printed addresses are exactly what the real broadcast will
// produce, provided the deployer's testnet nonce is unchanged (shown) and the scripts run in this order. Without
// them, labelled PLACEHOLDER addresses are used and the addresses are illustrative only (gas and order still hold).
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcProvider, getAddress, id as labelHash, Wallet, formatEther } from 'ethers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TESTNET_RPC = process.env.RH_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com'
const PORT = 8800 + Math.floor(Math.random() * 100)
const LOCAL = `http://127.0.0.1:${PORT}`
const FORGE = join(ROOT, 'scripts/forge.mjs')
const ANVIL = join(ROOT, 'node_modules/@foundry-rs/anvil/bin.mjs')
const ETH_USD = Number(process.env.ETH_USD || 2236)
const placeholder = (label) => new Wallet(labelHash(`rixor.testnet.plan.placeholder.${label}`)).address
const deployer = getAddress(process.env.RIXOR_DEPLOYER || placeholder('deployer'))
const owners = (process.env.RIXOR_OWNER_SIGNERS || [1, 2, 3].map((i) => placeholder(`owner${i}`)).join(',')).split(',').map(getAddress)
const guardians = (process.env.RIXOR_GUARDIAN_SIGNERS || [1, 2, 3].map((i) => placeholder(`guardian${i}`)).join(',')).split(',').map(getAddress)
const usingPlaceholders = !process.env.RIXOR_DEPLOYER || !process.env.RIXOR_OWNER_SIGNERS || !process.env.RIXOR_GUARDIAN_SIGNERS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const upstream = new JsonRpcProvider(TESTNET_RPC, 46630, { staticNetwork: true })
const upstreamChain = Number((await upstream.getNetwork()).chainId)
if (upstreamChain !== 46630) { console.error(`refusing: ${TESTNET_RPC} is chain ${upstreamChain}, not 46630`); process.exit(1) }
const [gasPrice, startNonce, deployerBalance] = await Promise.all([
  upstream.send('eth_gasPrice', []).then(BigInt), upstream.getTransactionCount(deployer), upstream.getBalance(deployer),
])

const anvil = spawn(process.execPath, [ANVIL, '--fork-url', TESTNET_RPC, '--port', String(PORT), '--silent', '--auto-impersonate'], { stdio: 'ignore' })
const local = new JsonRpcProvider(LOCAL, 46630, { staticNetwork: true, cacheTimeout: -1 })
const steps = []
let ok = true
try {
  for (let i = 0; ; i++) { try { await local.getBlockNumber(); break } catch { if (i > 60) throw new Error('anvil did not start'); await sleep(500) } }
  if (Number((await local.getNetwork()).chainId) !== 46630) throw new Error('local fork lost chain id 46630')
  await local.send('anvil_setBalance', [deployer, '0x' + (10n ** 18n).toString(16)]) // local fork only
  const env = { RIXOR_EXPECTED_CHAIN_ID: '46630', RIXOR_OUTPUT_TAG: 'plan', RIXOR_OWNER_SIGNERS: owners.join(','), RIXOR_GUARDIAN_SIGNERS: guardians.join(',') }
  const common = ['--rpc-url', LOCAL, '--broadcast', '--unlocked', '--sender', deployer, '--slow']
  const run = (script, extra = {}) => {
    const before = Date.now()
    const r = spawnSync(process.execPath, [FORGE, 'script', `script/${script}.s.sol`, ...common], { cwd: ROOT, env: { ...process.env, ...env, ...extra }, encoding: 'utf8' })
    if (r.status !== 0) { console.error(r.stdout.slice(-2500), r.stderr.slice(-1500)); throw new Error(`${script} failed`) }
    const bc = JSON.parse(readFileSync(join(ROOT, 'broadcast', `${script}.s.sol`, '46630', 'run-latest.json'), 'utf8'))
    for (const [i, tx] of bc.transactions.entries()) {
      const rc = bc.receipts[i]
      steps.push({ script, kind: tx.transactionType, contract: tx.contractName ?? '', fn: tx.function ?? '', to: tx.contractAddress ?? tx.transaction.to, gasUsed: BigInt(rc.gasUsed), nonce: Number(BigInt(tx.transaction.nonce)) })
    }
    void before
    return r.stdout
  }
  const safesOut = run('CreateTestnetSafes')
  const ownerSafe = safesOut.match(/owner Safe\s+(0x[0-9a-fA-F]{40})/)[1]
  const guardianSafe = safesOut.match(/guardian Safe\s+(0x[0-9a-fA-F]{40})/)[1]
  run('DeployTestnetTokens')
  const cfgPath = 'deployments/46630-plan-testnet-config.json'
  const cfg = JSON.parse(readFileSync(join(ROOT, cfgPath), 'utf8'))
  run('DeployRixorV2', { RIXOR_CONFIG: cfgPath, RIXOR_OWNER_SAFE: ownerSafe, RIXOR_GUARDIAN_SAFE: guardianSafe })
  const manifest = JSON.parse(readFileSync(join(ROOT, 'deployments', '46630-plan.json'), 'utf8'))
  const v = spawnSync(process.execPath, [FORGE, 'script', 'script/VerifyRixorV2.s.sol', '--rpc-url', LOCAL], { cwd: ROOT, env: { ...process.env, RIXOR_DEPLOYMENT: 'deployments/46630-plan.json' }, encoding: 'utf8' })
  if (!/verification passed/.test(v.stdout)) throw new Error('VerifyRixorV2 failed on the plan')
  run('SeedTestnetRewards', { RIXOR_DEPLOYMENT: 'deployments/46630-plan.json', RIXOR_CONFIG: cfgPath })

  const totalGas = steps.reduce((s, x) => s + x.gasUsed, 0n)
  const cost = (mult) => formatEther(totalGas * gasPrice * BigInt(mult))
  const plan = {
    note: usingPlaceholders ? 'PLACEHOLDER signer/deployer addresses: addresses below are illustrative; rerun with the real addresses before broadcasting.' : 'Real deployer and signer addresses: these are the exact addresses the broadcast will produce if the deployer nonce is unchanged.',
    chainId: 46630, rpc: TESTNET_RPC, deployer, deployerTestnetNonce: startNonce, deployerTestnetBalanceEth: formatEther(deployerBalance),
    ownerSigners: owners, guardianSigners: guardians, threshold: '2 of 3',
    addresses: {
      ownerSafe, guardianSafe,
      tMEMEA: cfg.listings[0].token, tMEMEB: cfg.listings[1].token, tWIF: cfg.wif,
      RixorLocker: manifest.locker, RixorRewards: manifest.rewards, RixorChallenges: manifest.challenges,
    },
    listings: cfg.listings, minHoldSeconds: cfg.minHoldSeconds,
    transactions: steps.map((s, i) => ({ n: i + 1, nonce: s.nonce, script: s.script, action: s.kind === 'CREATE' ? `deploy ${s.contract}` : `${s.contract || 'call'}.${s.fn.split('(')[0] || '?'}`, address: s.to, gasUsed: s.gasUsed.toString() })),
    gas: { total: totalGas.toString(), gasPriceWei: gasPrice.toString() },
    costEth: { atCurrentPrice: cost(1), at10x: cost(10), at100x: cost(100) },
    costUsdEquivalent: { atCurrentPrice: (Number(cost(1)) * ETH_USD).toFixed(4), at100x: (Number(cost(100)) * ETH_USD).toFixed(2), note: 'testnet ETH has no value; shown for scale at mainnet ETH price' },
  }
  writeFileSync(join(ROOT, 'deployments', '46630-plan-summary.json'), JSON.stringify(plan, null, 2))
  console.log(JSON.stringify(plan, null, 2))
} catch (e) {
  ok = false
  console.error(`plan failed: ${e.message}`)
} finally {
  anvil.kill('SIGTERM')
  // Never leave forge broadcast records for chain 46630 from a plan: they could be mistaken for a real deployment.
  for (const s of ['CreateTestnetSafes', 'DeployTestnetTokens', 'DeployRixorV2', 'SeedTestnetRewards']) rmSync(join(ROOT, 'broadcast', `${s}.s.sol`, '46630'), { recursive: true, force: true })
  process.exit(ok ? 0 : 1)
}
