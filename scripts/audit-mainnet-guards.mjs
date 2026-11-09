#!/usr/bin/env node
// MAINNET GUARD AUDIT: proves no script can run against Robinhood Chain mainnet (4663) without the exact
// written-authorisation sentence. Every script is SIMULATED (no --broadcast, so forge cannot send anything) against
// the real mainnet RPC under every pin/flag combination:
//   - testnet scripts must be refused in EVERY variant (they never touch mainnet);
//   - mainnet scripts (CreateMainnetSafes, SeedMainnetRewards) must be refused in every variant except the one that
//     carries the exact sentence, where a read-only simulation is allowed (that is the authorised path);
//   - DeployRixorV2 must be refused (here its owner/guardian are EOAs, so even the sentence cannot pass its guards).
// Also runs the Safe CLI against mainnet (must refuse).
//   npm run audit:mainnet-guards
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress, id } from 'ethers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAINNET = process.env.RH_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const FORGE = join(ROOT, 'scripts/forge.mjs')
const sender = getAddress('0x' + id('rixor.audit.sender').slice(26)) // an address only; no key exists
const signers = (tag) => [1, 2, 3].map((i) => getAddress('0x' + id(`rixor.audit.${tag}.${i}`).slice(26))).join(',')
const baseEnv = {
  RIXOR_OWNER_SIGNERS: signers('o'), RIXOR_GUARDIAN_SIGNERS: signers('g'),
  RIXOR_CONFIG: 'deploy/config/mainnet.template.json', RIXOR_OWNER_SAFE: sender, RIXOR_GUARDIAN_SAFE: sender,
  RIXOR_DEPLOYMENT: 'deploy/config/mainnet.template.json',
}
const scripts = ['CreateTestnetSafes', 'DeployTestnetTokens', 'DeployRixorV2', 'SeedTestnetRewards', 'CreateMainnetSafes', 'SeedMainnetRewards']
const MAINNET_SCRIPTS = new Set(['CreateMainnetSafes', 'SeedMainnetRewards'])
const variants = [
  { name: 'pin 4663', env: { RIXOR_EXPECTED_CHAIN_ID: '4663' }, flags: [] },
  { name: 'pin 46630', env: { RIXOR_EXPECTED_CHAIN_ID: '46630' }, flags: [] },
  { name: 'pin 46630 + --chain 46630', env: { RIXOR_EXPECTED_CHAIN_ID: '46630' }, flags: ['--chain', '46630'] },
  { name: 'pin 4663 + wrong sentence', env: { RIXOR_EXPECTED_CHAIN_ID: '4663', RIXOR_CONFIRM_MAINNET: 'I have written authorisation to deploy Rixor V2 to Robinhood Chain mainnet.' }, flags: [] },
  { name: 'pin 4663 + --chain 31337', env: { RIXOR_EXPECTED_CHAIN_ID: '31337' }, flags: ['--chain', '31337'] },
  { name: 'pin 4663 + mainnet sentence', sentence: true, env: { RIXOR_EXPECTED_CHAIN_ID: '4663', RIXOR_CONFIRM_MAINNET: 'I have written authorisation to deploy Rixor V2 to Robinhood Chain mainnet' }, flags: [] },
]
let bad = 0
for (const s of scripts) {
  for (const v of variants) {
    // Retry transient RPC errors (the public node is not an archive node) so every refusal records its real guard.
    let r
    for (let attempt = 0; attempt < 4; attempt++) {
      r = spawnSync(process.execPath, [FORGE, 'script', `script/${s}.s.sol`, '--rpc-url', MAINNET, '--sender', sender, ...v.flags], { cwd: ROOT, env: { ...process.env, ...baseEnv, ...v.env }, encoding: 'utf8' })
      if (r.status === 0 || /script failed/.test(r.stdout + r.stderr)) break
    }
    const reason = (r.stdout + r.stderr).match(/script failed: ([^\n]+)/)?.[1] ?? (r.status === 0 ? 'SUCCEEDED' : 'failed')
    const refused = r.status !== 0
    const allowed = v.sentence && MAINNET_SCRIPTS.has(s) // authorised path: simulation may proceed
    if (!refused && !allowed) bad++
    console.log(`${refused ? 'REFUSED' : allowed ? 'ALLOWED (sentence)' : 'NOT REFUSED'}  ${s.padEnd(20)} ${v.name.padEnd(30)} ${reason}`)
  }
}
const cli = spawnSync(process.execPath, [join(ROOT, 'scripts/safe-tx.mjs'), 'prepare', '--rpc', MAINNET, '--safe', sender, '--to', sender, '--data', '0x'], { encoding: 'utf8' })
console.log(`${cli.status !== 0 ? 'REFUSED' : 'NOT REFUSED'}  safe-tx prepare      mainnet RPC                    ${cli.stderr.trim()}`)
if (cli.status === 0) bad++
console.log(`\n${bad === 0 ? 'PASS' : 'FAIL'}: ${bad} script/variant combinations were not refused on mainnet (simulation only; nothing sent)`)
process.exit(bad ? 1 : 0)
