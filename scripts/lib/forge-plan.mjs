// Runs the real Rixor testnet deployment scripts (the same four scripts, order, environment and guards as
// scripts/plan-testnet.mjs) against a LOCAL chain with `--unlocked`, then returns Forge's own broadcast records: the
// exact transactions a real deployment sends. Never used against a real network: the caller passes a local RPC.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FORGE = join(ROOT, 'scripts/forge.mjs')
export const SCRIPTS = ['CreateTestnetSafes', 'DeployTestnetTokens', 'DeployRixorV2', 'SeedTestnetRewards']

const isLocal = (rpc) => /^http:\/\/127\.0\.0\.1:\d+$/.test(rpc)

export function runForgePlan({ rpc, chainId, deployer, owners, guardians, tag = 'bundle' }) {
  if (!isLocal(rpc)) throw new Error(`runForgePlan only runs against a local chain (got ${rpc})`)
  const env = { ...process.env, RIXOR_EXPECTED_CHAIN_ID: String(chainId), RIXOR_OUTPUT_TAG: tag, RIXOR_OWNER_SIGNERS: owners.join(','), RIXOR_GUARDIAN_SIGNERS: guardians.join(',') }
  const common = ['--rpc-url', rpc, '--broadcast', '--unlocked', '--sender', deployer, '--slow']
  const records = []
  mkdirSync(join(ROOT, 'deployments'), { recursive: true }) // the scripts write their config/manifest here (absent in a fresh clone)
  const run = (script, extra = {}) => {
    const r = spawnSync(process.execPath, [FORGE, 'script', `script/${script}.s.sol`, ...common], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) throw new Error(`${script} failed:\n${r.stdout.slice(-2500)}\n${r.stderr.slice(-1500)}`)
    const bc = JSON.parse(readFileSync(join(ROOT, 'broadcast', `${script}.s.sol`, String(chainId), 'run-latest.json'), 'utf8'))
    bc.transactions.forEach((tx, i) => records.push({ script, type: tx.transactionType, contractName: tx.contractName ?? '', fn: tx.function ?? '', transaction: tx.transaction, receipt: bc.receipts[i] }))
    return r.stdout
  }
  try {
    const safesOut = run('CreateTestnetSafes')
    const ownerSafe = safesOut.match(/owner Safe\s+(0x[0-9a-fA-F]{40})/)[1]
    const guardianSafe = safesOut.match(/guardian Safe\s+(0x[0-9a-fA-F]{40})/)[1]
    run('DeployTestnetTokens')
    const cfgPath = `deployments/${chainId}-${tag}-testnet-config.json`
    run('DeployRixorV2', { RIXOR_CONFIG: cfgPath, RIXOR_OWNER_SAFE: ownerSafe, RIXOR_GUARDIAN_SAFE: guardianSafe })
    const manifestPath = `deployments/${chainId}-${tag}.json`
    const v = spawnSync(process.execPath, [FORGE, 'script', 'script/VerifyRixorV2.s.sol', '--rpc-url', rpc], { cwd: ROOT, env: { ...env, RIXOR_DEPLOYMENT: manifestPath, RIXOR_CONFIG: cfgPath }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (!/verification passed/.test(v.stdout)) throw new Error(`VerifyRixorV2 failed on the plan:\n${v.stdout.slice(-2000)}`)
    run('SeedTestnetRewards', { RIXOR_DEPLOYMENT: manifestPath, RIXOR_CONFIG: cfgPath })
    const cfg = JSON.parse(readFileSync(join(ROOT, cfgPath), 'utf8'))
    const manifest = JSON.parse(readFileSync(join(ROOT, manifestPath), 'utf8'))
    return { records, ownerSafe, guardianSafe, cfg, manifest }
  } finally {
    // Never leave broadcast records or manifests from a plan behind: they could be mistaken for a real deployment.
    for (const s of SCRIPTS) rmSync(join(ROOT, 'broadcast', `${s}.s.sol`, String(chainId)), { recursive: true, force: true })
    for (const f of [`deployments/${chainId}-${tag}-testnet-config.json`, `deployments/${chainId}-${tag}.json`]) rmSync(join(ROOT, f), { force: true })
  }
}
