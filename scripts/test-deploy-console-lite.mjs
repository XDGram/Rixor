#!/usr/bin/env node
// Tests for the Deploy Console's LITE profile (one contract, one approval). LOCAL ONLY for every transaction: local
// forks of Robinhood Chain mainnet with chain id 31337, impersonated accounts, a stub wallet. The only real-network
// calls are read-only. Nothing is signed with a real key and nothing is sent to any real network.
//   node scripts/test-deploy-console-lite.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, Interface, JsonRpcProvider, getAddress, parseEther } from 'ethers'
import { fundLocal, fundLocalWif, startRehearsalChain } from './lib/rehearsal-chain.mjs'
import { assess, bundleHashOf, manifestFor, preflight, validateBundle, verifySent } from '../src/deploy/core.ts'
import * as X from '../src/deploy/expected.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = mkdtempSync(join(tmpdir(), 'rixor-dc-lite-'))
let failed = 0
const t = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`) }
const clone = (o) => JSON.parse(JSON.stringify(o))
const rehash = (b) => { b.bundleHash = bundleHashOf(b); return b }
const refused = (b, re) => { const p = validateBundle(b); return p.length > 0 && (!re || p.some((x) => re.test(x))) }
const word = (v) => BigInt(v).toString(16).padStart(64, '0')
const chains = []
const WIF = X.MAINNET_TOKENS.WIF.address, HOOKR = X.MAINNET_TOKENS.HOOKR.address
const HOOKR_HOLDER = '0xA522e716e1750702F775416f2Aa3Df620D9A1831' // existing mainnet holder, impersonated on the fork only
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']
const LITE_ABI = JSON.parse(readFileSync(join(ROOT, 'out/RixorLite.sol/RixorLite.json'), 'utf8')).abi

try {
  // ------------------------------------------------------------ 1. pins vs the script and the build
  const sol = readFileSync(join(ROOT, 'script/DeployRixorLite.s.sol'), 'utf8')
  t('script constants equal the pinned Lite plan', sol.includes(HOOKR) && /BUDGET = 1_000e18/.test(sol) && /DURATION = 7 days/.test(sol) && /LOCK_SECONDS = 1 days/.test(sol) && /MIN_LOCK = 10e18/.test(sol) && /CAP = 100_000e18/.test(sol)
    && X.LITE.budget === 1000n * 10n ** 18n && X.LITE.durationSeconds === 604800n && X.LITE.lockSeconds === 86400n && X.LITE.minLock === 10n * 10n ** 18n && X.LITE.cap === 100000n * 10n ** 18n && X.LITE.token === 'HOOKR')
  const art = JSON.parse(readFileSync(join(ROOT, 'out/RixorLite.sol/RixorLite.json'), 'utf8')).bytecode.object
  const { keccak256 } = await import('ethers')
  t('pinned RixorLite creation-code hash equals the Forge build', keccak256(art) === X.INITCODE_HASH.RixorLite && (art.length - 2) / 2 === X.INITCODE_BYTES.RixorLite)
  t('this build does NOT approve mainnet signing (LITE_PLAN_APPROVED = false)', X.LITE_PLAN_APPROVED === false)
  t('RixorLite has no owner or admin function', !LITE_ABI.some((f) => f.type === 'function' && /owner|admin|pause|upgrade|sweep|rescue|set[A-Z]/.test(f.name)))
  t('the only state-changing functions are lock, exit and claim', LITE_ABI.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort().join() === 'claim,exit,lock')

  // ------------------------------------------------------------ 2. export
  const bundlePath = join(DIR, 'lite-rehearsal.json')
  const ex = spawnSync(process.execPath, [join(ROOT, 'scripts/export-deploy-bundle.mjs'), '--lite', '--rehearsal', '--allow-placeholders', '--out', bundlePath], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  t('exporter: lite rehearsal bundle from the real script on a local mainnet fork, self-verified', ex.status === 0, (ex.stderr + ex.stdout).slice(-1500))
  const B = JSON.parse(readFileSync(bundlePath, 'utf8'))
  t('bundle: network lite, 2 steps, no signers, one address', B.network === 'lite' && B.transactions.length === 2 && B.signers.owner.length === 0 && B.signers.guardian.length === 0 && Object.keys(B.addresses).join() === 'lite')
  t('bundle validates against the pinned Lite plan', validateBundle(B).length === 0, validateBundle(B).join('; '))
  t('step 1 is a contract creation of 5.3 KB; step 2 approves exactly 1,000 WIF to RixorLite', B.transactions[0].to === null && (B.transactions[0].data.length - 2) / 2 < 6000 && getAddress(B.transactions[1].to) === WIF && B.transactions[1].data.endsWith(word(X.LITE.budget)) && B.transactions[1].data.includes(B.addresses.lite.slice(2).toLowerCase()))

  // ------------------------------------------------------------ 3. tampering
  const tamper = (i, f) => { const b = clone(B); f(b.transactions[i]); return rehash(b) }
  t('reward budget raised in the constructor: refused', refused(tamper(0, (tx) => { tx.data = tx.data.replace(word(X.LITE.budget), word(X.LITE.budget * 10n)) }), /constructor arguments/))
  t('reward wallet replaced in the constructor: refused', refused(tamper(0, (tx) => { tx.data = tx.data.replace(B.deployer.slice(2).toLowerCase(), HOOKR_HOLDER.slice(2).toLowerCase()) }), /constructor arguments/))
  t('lockable token replaced: refused', refused(tamper(0, (tx) => { tx.data = tx.data.replace(HOOKR.slice(2).toLowerCase(), X.MAINNET_TOKENS.TORCH.address.slice(2).toLowerCase()) }), /constructor arguments/))
  t('lock period lengthened: refused', refused(tamper(0, (tx) => { tx.data = tx.data.replace(word(X.LITE.lockSeconds), word(30n * 86400n)) }), /constructor arguments/))
  t('contract bytecode altered: refused', refused(tamper(0, (tx) => { tx.data = tx.data.slice(0, 200) + (tx.data[200] === 'a' ? 'b' : 'a') + tx.data.slice(201) }), /creation code/))
  t('approval amount raised: refused', refused(tamper(1, (tx) => { tx.data = tx.data.slice(0, -64) + word(X.LITE.budget * 100n) }), /calldata/))
  t('approval to another spender: refused', refused(tamper(1, (tx) => { tx.data = tx.data.replace(B.addresses.lite.slice(2).toLowerCase(), HOOKR_HOLDER.slice(2).toLowerCase()) }), /calldata/))
  t('Safe signers added to a lite bundle: refused', refused(rehash({ ...clone(B), signers: { owner: [HOOKR_HOLDER], guardian: [] } }), /no Safes/))
  t('lite bundle relabelled mainnet: refused', refused(rehash({ ...clone(B), network: 'mainnet' })))
  t('lite bundle on testnet chain 46630: refused', refused(rehash({ ...clone(B), chainId: 46630, rehearsal: false }), /unsupported chain/))

  // ------------------------------------------------------------ 4. approval gate on REAL mainnet (read-only)
  const F = rehash({ ...clone(B), chainId: 4663, rehearsal: false, final: true, rpc: X.MAINNET_RPC, explorer: X.MAINNET_EXPLORER })
  t('a final lite bundle (chain 4663, official RPC) passes static validation', validateBundle(F).length === 0, validateBundle(F).join('; '))
  const mainnetRpc = new JsonRpcProvider(X.MAINNET_RPC, 4663, { staticNetwork: true })
  const sends = []
  const stub = async (m, p) => { if (/send|sign/i.test(m)) { sends.push(m); throw new Error('must never be called') } if (m === 'eth_chainId') return '0x1237'; if (m === 'eth_accounts') return [F.deployer]; return mainnetRpc.send(m, p) }
  const gate = await preflight((m, p) => mainnetRpc.send(m, p), stub, F, 0)
  t('preflight on real mainnet stops at the approval gate (nothing requested from the wallet)', !gate.ok && gate.request === null && gate.checks.some((c) => /plan approved/.test(c.label) && !c.ok && /LITE_PLAN_APPROVED/.test(c.detail)) && sends.length === 0)

  // ------------------------------------------------------------ 5. full run on a mainnet fork
  const c1 = await startRehearsalChain({ impersonate: true, fork: 'mainnet' }); chains.push(c1)
  const node = (m, p) => c1.provider.send(m, p)
  const price = await c1.provider.send('eth_gasPrice', [])
  const wallet = async (m, p) => (m === 'eth_chainId' ? '0x7a69' : m === 'eth_accounts' ? [B.deployer] : m === 'eth_sendTransaction' ? c1.provider.send(m, [{ ...p[0], gasPrice: price }]) : c1.provider.send(m, p))
  await fundLocal(c1.provider, B.deployer, parseEther('0.0003')) // the planned deployer balance (about $0.60)
  await fundLocalWif(c1.provider, B.deployer, X.LITE.budget - 1n)
  let pf = await preflight(node, wallet, B, 0)
  t('WIF gate: reward wallet 1 wei short of 1,000 WIF → nothing can be sent', !pf.ok && pf.checks.some((c) => /holds the 1,000 WIF/.test(c.label) && !c.ok))
  await fundLocalWif(c1.provider, B.deployer, X.LITE.budget)
  await fundLocal(c1.provider, B.deployer, 10n ** 12n)
  pf = await preflight(node, wallet, B, 0)
  t('ETH gate: not enough ETH for both steps → nothing can be sent', !pf.ok && pf.checks.some((c) => /every remaining step/.test(c.label) && !c.ok))
  await fundLocal(c1.provider, B.deployer, parseEther('0.0003'))
  for (const i of [0, 1]) {
    const p = await preflight(node, wallet, B, i)
    const why = p.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join('; ')
    if (!p.ok) { t(`step ${i + 1} passes preflight with 0.0003 ETH and 1,000 WIF`, false, why); continue }
    const hash = await wallet('eth_sendTransaction', [p.request])
    await c1.provider.waitForTransaction(hash)
    const v = await verifySent(node, B, i, hash)
    t(`step ${i + 1} (${B.transactions[i].label}) passes preflight, is sent and verifies`, v.ok, v.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join('; '))
  }
  const done = await assess(node, B)
  t('complete: both steps proven by their on-chain checks', done.status === 'complete' && done.steps.every((s) => s.state === 'done'))
  const lite = new Contract(B.addresses.lite, LITE_ABI, c1.provider)
  const wif = new Contract(WIF, ERC20, c1.provider)
  t('rewards are fully funded: rewardsAvailable = 1,000 WIF, still in the reward wallet', (await lite.rewardsAvailable()) === X.LITE.budget && (await wif.balanceOf(B.deployer)) === X.LITE.budget && (await wif.balanceOf(B.addresses.lite)) === 0n)
  const spent = parseEther('0.0003') - (await c1.provider.getBalance(B.deployer))
  t('deployment cost on the fork is under 0.00003 ETH', spent > 0n && spent < parseEther('0.00003'), `${Number(spent) / 1e18} ETH`)
  console.log(`     deployment used ${Number(spent) / 1e18} ETH at the fork's gas price`)

  // A real user locks and claims: the approval check must still hold afterwards (allowance + claimed = budget).
  await c1.provider.send('anvil_setBalance', [HOOKR_HOLDER, '0x' + parseEther('1').toString(16)])
  const erc = new Interface(ERC20)
  const sendAs = async (to, data) => c1.provider.waitForTransaction(await c1.provider.send('eth_sendTransaction', [{ from: HOOKR_HOLDER, to, data, gasPrice: price }]))
  await sendAs(HOOKR, erc.encodeFunctionData('approve', [B.addresses.lite, 50n * 10n ** 18n]))
  await sendAs(B.addresses.lite, lite.interface.encodeFunctionData('lock', [50n * 10n ** 18n]))
  await c1.provider.send('evm_increaseTime', [600]); await c1.provider.send('evm_mine', [])
  const before = await wif.balanceOf(HOOKR_HOLDER)
  await sendAs(B.addresses.lite, lite.interface.encodeFunctionData('claim', []))
  const got = (await wif.balanceOf(HOOKR_HOLDER)) - before
  t('a user locks 50 HOOKR and claims real WIF paid by the reward wallet', got > 0n && (await wif.balanceOf(B.deployer)) === X.LITE.budget - got, `${Number(got) / 1e18} WIF`)
  const after = await assess(node, B)
  t('after claims the deployment still verifies (allowance + claimed = budget)', after.status === 'complete' && after.steps[1].state === 'done')
  const m = manifestFor(B, 123)
  t('app manifest: lite address, HOOKR, official WIF, reward wallet', m.lite === B.addresses.lite && m.token === HOOKR && m.wif === WIF && m.rewardWallet === B.deployer)
  t('no private key, seed phrase or signature appears in the bundle', !/"(privateKey|mnemonic|seed|signature|r|s|v)"\s*:/i.test(readFileSync(bundlePath, 'utf8')))
} catch (e) {
  t('lite console tests completed', false, e.stack)
} finally {
  for (const c of chains) await c.stop()
  rmSync(DIR, { recursive: true, force: true })
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${failed} failing test(s) (local mainnet forks, chain 31337; stub wallet; mainnet RPC read-only)`)
  process.exit(failed ? 1 : 0)
}
