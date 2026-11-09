#!/usr/bin/env node
// Tests for the Deploy Console's MAINNET profile (real $WIF plan). LOCAL ONLY for every transaction: local forks of
// Robinhood Chain mainnet with chain id 31337, impersonated accounts, a stub wallet. The only real-network calls are
// read-only (the exporter's nonce/gas reads and one preflight against the public mainnet RPC that must refuse before
// anything could be signed). Nothing is signed with a real key and nothing is sent to any real network.
//   node scripts/test-deploy-console-mainnet.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Interface, JsonRpcProvider, getAddress, hexlify, id as labelHash, keccak256, randomBytes } from 'ethers'
import { fundLocal, fundLocalWif, startRehearsalChain } from './lib/rehearsal-chain.mjs'
import { assess, bundleHashOf, expectedAddresses, manifestFor, preflight, sentStatus, validateBundle, verifySent } from '../src/deploy/core.ts'
import * as X from '../src/deploy/expected.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = mkdtempSync(join(tmpdir(), 'rixor-dc-mainnet-'))
let failed = 0
const t = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`) }
const clone = (o) => JSON.parse(JSON.stringify(o))
const rehash = (b) => { b.bundleHash = bundleHashOf(b); return b }
const refused = (b, re) => { const p = validateBundle(b); return p.length > 0 && (!re || p.some((x) => re.test(x))) }
const chains = []
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'])
const E18 = 10n ** 18n

try {
  // ------------------------------------------------------------ 1. pinned mainnet plan vs scripts, config and chain
  const cfg = JSON.parse(readFileSync(join(ROOT, 'deploy/config/mainnet.candidate.json'), 'utf8'))
  const safesSol = readFileSync(join(ROOT, 'script/CreateMainnetSafes.s.sol'), 'utf8')
  const baseSol = readFileSync(join(ROOT, 'script/RixorScriptBase.sol'), 'utf8')
  t('mainnet Safe salts equal CreateMainnetSafes.s.sol', safesSol.includes(`keccak256("${X.MAINNET_SAFE_SALT_LABELS.owner}")`) && safesSol.includes(`keccak256("${X.MAINNET_SAFE_SALT_LABELS.guardian}")`))
  t('mainnet Safe salts differ from the testnet salts', X.MAINNET_SAFE_SALT_LABELS.owner !== X.SAFE.ownerSaltLabel && X.MAINNET_SAFE_SALT_LABELS.guardian !== X.SAFE.guardianSaltLabel)
  t('Safe factory, singleton and fallback in CreateMainnetSafes equal the pinned Safe v1.5.0', [X.SAFE.factory, X.SAFE.singletonL2, X.SAFE.fallbackHandler].every((a) => safesSol.includes(a)))
  t('official WIF equals RixorScriptBase.OFFICIAL_WIF and the config', baseSol.includes(X.MAINNET_TOKENS.WIF.address) && getAddress(cfg.wif) === X.MAINNET_TOKENS.WIF.address)
  t('listings equal deploy/config/mainnet.candidate.json', cfg.listings.length === X.MAINNET_LISTINGS.length && X.MAINNET_LISTINGS.every((l, i) => getAddress(cfg.listings[i].token) === X.MAINNET_TOKENS[l.token].address && BigInt(cfg.listings[i].unitAmount) === l.unitAmount && BigInt(cfg.listings[i].maxTotalLocked) === l.maxTotalLocked && cfg.listings[i].riskClass === l.riskClass))
  t('streams equal the config; approval total is their sum', cfg.streams.length === X.MAINNET_STREAMS.length && X.MAINNET_STREAMS.every((s, i) => getAddress(cfg.streams[i].token) === X.MAINNET_TOKENS[s.token].address && BigInt(cfg.streams[i].amount) === s.amount && BigInt(cfg.streams[i].days) === s.days) && X.MAINNET_APPROVE_TOTAL === X.MAINNET_STREAMS.reduce((a, s) => a + s.amount, 0n))
  t('minimum hold equals the config (production 86,400 s)', BigInt(cfg.minHoldSeconds) === X.MAINNET_MIN_HOLD_SECONDS && X.MAINNET_MIN_HOLD_SECONDS === 86_400n)
  t('every stream is at least the contract minimum (10,000 WIF) and 7–90 days', X.MAINNET_STREAMS.every((s) => s.amount >= 10_000n * E18 && s.days >= 7n && s.days <= 90n))
  t('Class B listings: cap ≤ 1% of a 1B supply, unit ≤ cap/50', X.MAINNET_LISTINGS.every((l) => l.riskClass === 2 && l.maxTotalLocked <= 10_000_000n * E18 && l.unitAmount * 50n <= l.maxTotalLocked))
  t('this build does NOT approve mainnet signing (MAINNET_PLAN_APPROVED = false)', X.MAINNET_PLAN_APPROVED === false)

  // ------------------------------------------------------------ 2. export a mainnet rehearsal bundle (local fork)
  const bundlePath = join(DIR, 'mainnet-rehearsal.json')
  const ex = spawnSync(process.execPath, [join(ROOT, 'scripts/export-deploy-bundle.mjs'), '--mainnet', '--rehearsal', '--allow-placeholders', '--out', bundlePath], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  t('exporter: mainnet rehearsal bundle from the real scripts on a local mainnet fork, self-verified', ex.status === 0, (ex.stderr + ex.stdout).slice(-1500))
  const B = JSON.parse(readFileSync(bundlePath, 'utf8'))
  t('bundle: network mainnet, chain 31337, 8 steps, rehearsal, not final', B.network === 'mainnet' && B.chainId === 31337 && B.transactions.length === 8 && B.rehearsal === true && B.final === false)
  t('bundle validates against the pinned mainnet plan', validateBundle(B).length === 0, validateBundle(B).join('; '))
  t('addresses: two Safes + Locker/Rewards/Challenges at nonce+2..4, no TEST tokens', canonicalKeys(B.addresses) === 'challenges,guardianSafe,locker,ownerSafe,rewards' && B.addresses.locker === expectedAddresses(B.deployer, B.startNonce, B.signers.owner, B.signers.guardian, 'mainnet').locker)
  t('approve step targets the official WIF; fund steps target Rewards', getAddress(B.transactions[5].to) === X.MAINNET_TOKENS.WIF.address && B.transactions.slice(6).every((tx) => tx.to === B.addresses.rewards))

  // ------------------------------------------------------------ 3. tampering is refused
  t('network relabelled testnet: refused', refused(rehash({ ...clone(B), network: 'testnet' })))
  t('network missing: refused', refused(rehash((() => { const b = clone(B); delete b.network; return b })()), /network/))
  t('mainnet bundle on chain 46630: refused', refused(rehash({ ...clone(B), chainId: 46630, rehearsal: false }), /unsupported chain/))
  t('extra TEST-token address in a mainnet bundle: refused', refused(rehash((() => { const b = clone(B); b.addresses.tWIF = b.addresses.rewards; return b })()), /unexpected address/))
  const tamper = (i, f) => { const b = clone(B); f(b.transactions[i]); return rehash(b) }
  t('Locker listing cap changed (constructor args): refused', refused(tamper(2, (tx) => { tx.data = tx.data.replace(X.MAINNET_LISTINGS[0].maxTotalLocked.toString(16).padStart(64, '0'), (X.MAINNET_LISTINGS[0].maxTotalLocked * 10n).toString(16).padStart(64, '0')) }), /constructor arguments/))
  t('Rewards pays a different token: refused', refused(tamper(3, (tx) => { tx.data = tx.data.replace(X.MAINNET_TOKENS.WIF.address.slice(2).toLowerCase(), X.MAINNET_TOKENS.HOOKR.address.slice(2).toLowerCase()) }), /constructor arguments/))
  t('approval amount raised: refused', refused(tamper(5, (tx) => { tx.data = tx.data.slice(0, -64) + (X.MAINNET_APPROVE_TOTAL * 100n).toString(16).padStart(64, '0') }), /calldata/))
  t('stream days changed: refused', refused(tamper(6, (tx) => { tx.data = tx.data.slice(0, -64) + (90n).toString(16).padStart(64, '0') }), /calldata/))
  t('Challenges minimum hold lowered to 1 h: refused', refused(tamper(4, (tx) => { tx.data = tx.data.slice(0, -64) + (3600n).toString(16).padStart(64, '0') }), /constructor arguments/))

  // ------------------------------------------------------------ 4. the approval gate on REAL mainnet (read-only)
  const F = rehash({ ...clone(B), chainId: 4663, rehearsal: false, final: true, rpc: X.MAINNET_RPC, explorer: X.MAINNET_EXPLORER })
  t('a final mainnet bundle (chain 4663, official RPC and explorer) passes static validation', validateBundle(F).length === 0, validateBundle(F).join('; '))
  t('mainnet bundle with an unofficial RPC: refused', refused(rehash({ ...clone(F), rpc: 'https://evil.example' }), /official RPC/))
  t('mainnet bundle that is not final: refused', refused(rehash({ ...clone(F), final: false }), /not a final bundle/))
  const mainnetRpc = new JsonRpcProvider(X.MAINNET_RPC, 4663, { staticNetwork: true })
  const sends = []
  const stubOnMainnet = async (m, p) => { if (/send|sign/i.test(m)) { sends.push(m); throw new Error('must never be called') } if (m === 'eth_chainId') return '0x1237'; if (m === 'eth_accounts') return [F.deployer]; return mainnetRpc.send(m, p) }
  const gate = await preflight((m, p) => mainnetRpc.send(m, p), stubOnMainnet, F, 0)
  t('preflight on real mainnet stops at "Mainnet plan approved in this build" (nothing requested from the wallet)', !gate.ok && gate.request === null && gate.checks.some((c) => /Mainnet plan approved/.test(c.label) && !c.ok) && sends.length === 0, JSON.stringify(gate.checks.map((c) => [c.label, c.ok])))

  // ------------------------------------------------------------ 5. full run on a mainnet fork (chain 31337)
  const c1 = await startRehearsalChain({ impersonate: true, fork: 'mainnet' }); chains.push(c1)
  const node1 = (m, p) => c1.provider.send(m, p)
  const price1 = await c1.provider.send('eth_gasPrice', [])
  await fundLocal(c1.provider, B.deployer, 5n * 10n ** 15n) // 0.005 ETH: the recommended deployer balance
  await fundLocalWif(c1.provider, B.deployer, X.MAINNET_APPROVE_TOTAL - 1n)
  const sentByWallet = []
  const wallet1 = async (m, p) => {
    if (m === 'eth_chainId') return '0x7a69'
    if (m === 'eth_accounts') return [B.deployer]
    if (m === 'eth_sendTransaction') { sentByWallet.push(p[0]); return c1.provider.send('eth_sendTransaction', [{ ...p[0], gasPrice: price1 }]) }
    return c1.provider.send(m, p)
  }
  const a0 = await assess(node1, B)
  t('fork: pinned WIF, HOOKR and TORCH code verified; step 1 is next', a0.status === 'ready' && a0.next === 0, a0.problems.join('; '))
  let pf = await preflight(node1, wallet1, B, 0)
  t('WIF gate: 1 wei short of 20,000 WIF → step 1 refused before anything is sent', !pf.ok && pf.checks.some((c) => /holds the 20,000 WIF/.test(c.label) && !c.ok))
  await fundLocalWif(c1.provider, B.deployer, X.MAINNET_APPROVE_TOTAL)
  await fundLocal(c1.provider, B.deployer, 10n ** 12n)
  pf = await preflight(node1, wallet1, B, 0)
  t('ETH gate: not enough ETH for every remaining step → step 1 refused', !pf.ok && pf.checks.some((c) => /every remaining step/.test(c.label) && !c.ok))
  await fundLocal(c1.provider, B.deployer, 5n * 10n ** 15n)
  pf = await preflight(node1, wallet1, B, 0)
  t('with 0.005 ETH and 20,000 WIF, step 1 passes every check', pf.ok, pf.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join('; '))
  t('the wallet request has no nonce, value 0, the approved calldata', pf.request && !('nonce' in pf.request) && pf.request.value === '0x0' && pf.request.data === B.transactions[0].data)

  const runStep = async (i) => {
    const p = await preflight(node1, wallet1, B, i)
    if (!p.ok) return { ok: false, why: p.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join('; ') }
    const hash = await wallet1('eth_sendTransaction', [p.request])
    await c1.provider.waitForTransaction(hash)
    const v = await verifySent(node1, B, i, hash)
    return { ok: v.ok, why: v.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join('; ') }
  }
  for (const i of [0, 1, 2]) { const r = await runStep(i); t(`step ${i + 1} (${B.transactions[i].label}) passes preflight, is sent and verifies`, r.ok, r.why) }
  const mid = await assess(node1, B)
  t('interruption after step 3: resumes at step 4 with steps 1–3 proven on chain', mid.status === 'ready' && mid.next === 3 && mid.steps.slice(0, 3).every((s) => s.state === 'done'))

  // Wallet "speed up" of step 4: the same transaction re-signed with a higher fee gets a different hash, and the hash the
  // console holds is never mined. The console must notice and prove the step from the chain.
  const p4 = await preflight(node1, wallet1, B, 3)
  const heldHash = hexlify(randomBytes(32))
  const realHash = await c1.provider.send('eth_sendTransaction', [{ ...p4.request, gasPrice: '0x' + (BigInt(price1) * 3n).toString(16) }])
  await c1.provider.waitForTransaction(realHash)
  t('speed-up: the held hash is reported "replaced" (never mined)', (await sentStatus(node1, B, 3, heldHash)) === 'replaced')
  const afterSpeedUp = await assess(node1, B)
  t('speed-up: the chain proves step 4 done by its durable checks; step 5 is next', afterSpeedUp.steps[3].state === 'done' && afterSpeedUp.next === 4)
  t('the real hash is reported "mined"', (await sentStatus(node1, B, 3, realHash)) === 'mined')
  for (const i of [4, 5, 6, 7]) { const r = await runStep(i); t(`step ${i + 1} (${B.transactions[i].label}) passes preflight, is sent and verifies`, r.ok, r.why) }
  const done = await assess(node1, B)
  t('complete: all 8 steps proven by their on-chain checks', done.status === 'complete' && done.steps.every((s) => s.state === 'done'))
  const wifIn = BigInt(await node1('eth_call', [{ to: X.MAINNET_TOKENS.WIF.address, data: ERC20.encodeFunctionData('balanceOf', [B.addresses.rewards]) }, 'latest']))
  const allowance = BigInt(await node1('eth_call', [{ to: X.MAINNET_TOKENS.WIF.address, data: ERC20.encodeFunctionData('allowance', [B.deployer, B.addresses.rewards]) }, 'latest']))
  t('Rewards holds exactly 20,000 real WIF; no allowance left', wifIn === X.MAINNET_APPROVE_TOTAL && allowance === 0n)
  t('after completion nothing more can be sent', !(await preflight(node1, wallet1, B, 7)).ok)
  t('only the console\'s requests were sent by the wallet (7; step 4 was the speed-up)', sentByWallet.length === 7)
  const m = manifestFor(B, 123)
  t('app manifest: official WIF, 86,400 s minimum hold, mainnet addresses', m.wif === X.MAINNET_TOKENS.WIF.address && m.minHoldSeconds === 86_400 && m.locker === B.addresses.locker && m.chainId === B.chainId)

  // ------------------------------------------------------------ 6. a wallet "cancel" halts everything
  const c2 = await startRehearsalChain({ impersonate: true, fork: 'mainnet' }); chains.push(c2)
  const node2 = (m, p) => c2.provider.send(m, p)
  const price2 = await c2.provider.send('eth_gasPrice', [])
  await fundLocal(c2.provider, B.deployer, 5n * 10n ** 15n); await fundLocalWif(c2.provider, B.deployer, X.MAINNET_APPROVE_TOTAL)
  const w2 = async (m, p) => (m === 'eth_chainId' ? '0x7a69' : m === 'eth_accounts' ? [B.deployer] : c2.provider.send(m, p))
  const s1 = await preflight(node2, w2, B, 0)
  await c2.provider.waitForTransaction(await c2.provider.send('eth_sendTransaction', [{ ...s1.request, gasPrice: price2 }]))
  // Step 2 is "cancelled" in the wallet: a 0-value self-transfer takes its nonce.
  await c2.provider.waitForTransaction(await c2.provider.send('eth_sendTransaction', [{ from: B.deployer, to: B.deployer, value: '0x0', gasPrice: price2 }]))
  t('cancel: the held hash is reported "replaced"', (await sentStatus(node2, B, 1, hexlify(randomBytes(32)))) === 'replaced')
  const halted = await assess(node2, B)
  t('cancel: the console halts (step 2 not proven) and asks for a re-plan', halted.status === 'halt' && halted.steps[1].state === 'failed' && /Re-plan/.test(halted.problems.join(' ')))
  t('cancel: nothing further passes preflight', !(await preflight(node2, w2, B, 2)).ok)

  // ------------------------------------------------------------ 7. a chain that is not a mainnet fork halts
  const c3 = await startRehearsalChain({ impersonate: true }); chains.push(c3)
  const notFork = await assess((m, p) => c3.provider.send(m, p), B)
  t('mainnet bundle on a non-fork 31337 chain: halts (pinned tokens missing)', notFork.status === 'halt' && /not the pinned mainnet contract/.test(notFork.problems.join(' ')))
  const unknownHash = await sentStatus((m, p) => c3.provider.send(m, p), B, 0, hexlify(randomBytes(32)))
  t('an unknown hash at the current nonce is "unseen" (not mined, not replaced)', unknownHash === 'unseen')
  t('no private key, seed phrase or signature appears in the bundle', !/"(privateKey|mnemonic|seed|signature|r|s|v)"\s*:/i.test(readFileSync(bundlePath, 'utf8')))
} catch (e) {
  t('mainnet console tests completed', false, e.stack)
} finally {
  for (const c of chains) await c.stop()
  rmSync(DIR, { recursive: true, force: true })
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${failed} failing test(s) (local mainnet forks, chain 31337; stub wallet; mainnet RPC read-only)`)
  process.exit(failed ? 1 : 0)
}

function canonicalKeys(o) { return Object.keys(o).sort().join(',') }
void labelHash; void keccak256
