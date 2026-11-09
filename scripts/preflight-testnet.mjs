#!/usr/bin/env node
// PREFLIGHT: read-only GO/NO-GO check run IMMEDIATELY before each testnet broadcast step. Sends nothing.
//
//   node scripts/preflight-testnet.mjs --step safes|tokens|rixor|seed --deployer 0x… [--plan deployments/46630-plan-summary.json]
//
// Checks (all must pass for GO):
//   - the RPC answers eth_chainId = 46630 (raw call) and is not 4663; the latest block is fresh;
//   - Safe v1.5.0 singleton / factory / fallback handler code hashes equal the values recorded on 9 Nov 2026;
//   - the plan's six signers are distinct (no overlap between the Safes), exclude the deployer, and are plain EOAs;
//   - existing Safes have exactly the planned signers, 2-of-3;
//   - the deployer is a plain EOA, is funded, and its nonce equals the nonce this step must start at (from the plan);
//   - the addresses this step will create are still empty (Safes: empty, or already the identical planned Safe);
//   - step prerequisites exist on chain (Safes before Rixor; Rixor and TEST balance before funding).
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, JsonRpcProvider, formatEther, getAddress, keccak256 } from 'ethers'
import { signerCodeProblems, signerSetProblems } from './lib/signer-sets.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined }
const RPC = process.env.RH_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com'
const step = opt('step')
const STEP_NONCE_OFFSET = { safes: 0, tokens: 2, rixor: 5, seed: 8 }
if (!(step in STEP_NONCE_OFFSET)) { console.error('--step must be safes, tokens, rixor or seed'); process.exit(2) }
const deployer = getAddress(opt('deployer') ?? (() => { console.error('--deployer required'); process.exit(2) })())
const plan = JSON.parse(readFileSync(join(ROOT, opt('plan') ?? 'deployments/46630-plan-summary.json'), 'utf8'))
const SAFE_CODEHASH = {
  // keccak256(runtime code) on Robinhood Chain testnet, recorded 9 Nov 2026 (identical bytecode on mainnet).
  '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e': '0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc', // SafeL2 v1.5.0
  '0x14F2982D601c9458F93bd70B218933A6f8165e7b': '0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529', // SafeProxyFactory
  '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4': '0x3c6a85bcf7b563daa624b884b4e9a1b9fa5371edde7be945d998071a48f28bbc', // fallback handler
}
const results = []
const check = (name, ok, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

const p = new JsonRpcProvider(RPC, undefined, { staticNetwork: false })
const rawChain = Number(BigInt(await p.send('eth_chainId', [])))
check('RPC eth_chainId is 46630 (Robinhood Chain testnet)', rawChain === 46630, `eth_chainId = ${rawChain}`)
if (rawChain === 4663) { console.log('NO-GO: this RPC is MAINNET'); process.exit(1) }
const block = await p.getBlock('latest')
check('latest block is fresh (< 10 minutes old)', Date.now() / 1000 - block.timestamp < 600, `block ${block.number}`)
check('plan is for chain 46630 and this deployer', plan.chainId === 46630 && getAddress(plan.deployer) === deployer)
check('plan was made with the REAL deployer and signer addresses (not placeholders)', !String(plan.note).startsWith('PLACEHOLDER'), plan.note.slice(0, 60))
const roles = { owners: plan.ownerSigners ?? [], guardians: plan.guardianSigners ?? [], deployer }
const setProblems = signerSetProblems(roles)
check('six distinct signers (no overlap between Safes), deployer separate', setProblems.length === 0, setProblems.join('; '))
const codeProblems = setProblems.length ? ['skipped'] : await signerCodeProblems(p, roles)
check('all six signers and the deployer are plain EOAs (no code, no EIP-7702 delegation)', codeProblems.length === 0, codeProblems.join('; '))
for (const [addr, expected] of Object.entries(SAFE_CODEHASH)) {
  const h = keccak256(await p.getCode(addr))
  check(`Safe contract code unchanged at ${addr.slice(0, 10)}…`, h === expected, h)
}
const [code, balance, nonce] = await Promise.all([p.getCode(deployer), p.getBalance(deployer), p.getTransactionCount(deployer)])
check('deployer is a plain EOA (no code, no delegation)', code === '0x')
check('deployer funded (>= 0.005 testnet ETH)', balance >= 5n * 10n ** 15n, `${formatEther(balance)} ETH`)
const want = plan.deployerTestnetNonce + STEP_NONCE_OFFSET[step]
check(`deployer nonce is ${want} (start of step "${step}")`, nonce === want, `current nonce ${nonce}; if different, STOP and re-plan`)

const a = plan.addresses
const empty = async (k) => (await p.getCode(a[k])) === '0x'
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.map(getAddress).includes(getAddress(x)))
const safeState = async (k, signers) => {
  if (await empty(k)) return { exists: false }
  const s = new Contract(a[k], ['function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])'], p)
  const [t, o] = await Promise.all([s.getThreshold(), s.getOwners()])
  return { exists: true, ok: Number(t) === 2 && sameSet(o, signers), detail: `threshold ${t}, owners ${o.join(',')}` }
}
const planSigners = { ownerSafe: roles.owners, guardianSafe: roles.guardians }
for (const k of ['ownerSafe', 'guardianSafe']) {
  const st = await safeState(k, planSigners[k])
  if (step === 'safes') check(`${k} ${a[k]} not yet created, or already exactly the planned 2-of-3 Safe`, !st.exists || st.ok, st.exists ? st.detail : 'empty')
  else check(`${k} exists, 2-of-3, signers exactly as planned`, st.exists && st.ok, st.exists ? st.detail : `no code at ${a[k]}`)
}
if (step === 'tokens') for (const k of ['tMEMEA', 'tMEMEB', 'tWIF']) check(`${k} address ${a[k]} still empty`, await empty(k))
if (step === 'rixor') {
  for (const k of ['tMEMEA', 'tMEMEB', 'tWIF']) check(`${k} deployed at the planned address`, !(await empty(k)), a[k])
  for (const k of ['RixorLocker', 'RixorRewards', 'RixorChallenges']) check(`${k} address ${a[k]} still empty`, await empty(k))
}
if (step === 'seed') {
  for (const k of ['RixorLocker', 'RixorRewards', 'RixorChallenges']) check(`${k} deployed at the planned address`, !(await empty(k)), a[k])
  const t = new Contract(a.tWIF, ['function balanceOf(address) view returns (uint256)', 'function name() view returns (string)'], p)
  const bal = await t.balanceOf(deployer)
  check('deployer holds >= 210,000 tWIF for the two approved streams', bal >= 210_000n * 10n ** 18n, `${formatEther(bal)} tWIF`)
  check('reward token is the TEST token', (await t.name()) === 'Rixor Test Reward (TEST)')
}
const go = results.every(Boolean)
console.log(`\n${go ? 'GO' : 'NO-GO'}: ${results.filter(Boolean).length}/${results.length} checks passed for step "${step}" on chain ${rawChain}. Read-only; nothing was sent.`)
process.exit(go ? 0 : 1)
