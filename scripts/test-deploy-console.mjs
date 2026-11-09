#!/usr/bin/env node
// Tests for the Deploy Console (src/deploy/core.ts), the bundle exporter and the rehearsal chain.
// LOCAL ONLY: rehearsal chains (31337) on 127.0.0.1, impersonated accounts, a stub wallet. Nothing is signed with a
// real key and nothing reaches any real network.
//   node scripts/test-deploy-console.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AbiCoder, Contract, Interface, Wallet, ZeroAddress, concat, getAddress, id as labelHash, keccak256 } from 'ethers'
import { fundLocal, startRehearsalChain } from './lib/rehearsal-chain.mjs'
import { assess, bundleHashOf, canonicalJson, expectedChecks, expectedTx, manifestFor, preflight, safeInitializer, safeSalt, validateBundle, verifySent } from '../src/deploy/core.ts'
import * as X from '../src/deploy/expected.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = mkdtempSync(join(tmpdir(), 'rixor-deploy-console-'))
let failed = 0
const t = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`) }
const clone = (o) => JSON.parse(JSON.stringify(o))
const rehash = (b) => { b.bundleHash = bundleHashOf(b); return b }
const refused = (b, re) => { const p = validateBundle(b); return p.length > 0 && (!re || p.some((x) => re.test(x))) }
const chains = []

try {
  // ------------------------------------------------------------ 1. pinned constants vs the build and the scripts
  const art = (c) => JSON.parse(readFileSync(join(ROOT, `out/${c}.sol/${c}.json`), 'utf8'))
  for (const c of Object.keys(X.INITCODE_HASH)) {
    const b = art(c).bytecode.object
    t(`pinned ${c} creation-code hash equals the Forge build`, keccak256(b) === X.INITCODE_HASH[c] && (b.length - 2) / 2 === X.INITCODE_BYTES[c])
  }
  t('pinned Locker runtime hash equals the Forge build', keccak256(art('RixorLocker').deployedBytecode.object) === X.LOCKER_RUNTIME_HASH)
  const safesSol = readFileSync(join(ROOT, 'script/CreateTestnetSafes.s.sol'), 'utf8')
  t('Safe factory, singleton, fallback handler and salts equal CreateTestnetSafes.s.sol',
    safesSol.includes(X.SAFE.factory) && safesSol.includes(X.SAFE.singletonL2) && safesSol.includes(X.SAFE.fallbackHandler) &&
    safesSol.includes(`keccak256("${X.SAFE.ownerSaltLabel}")`) && safesSol.includes(`keccak256("${X.SAFE.guardianSaltLabel}")`) && /THRESHOLD = 2;/.test(safesSol))
  const tokensSol = readFileSync(join(ROOT, 'script/DeployTestnetTokens.s.sol'), 'utf8')
  for (const k of X.TOKENS) {
    const dec = k.decimals === 18 ? 'e18' : 'e6'
    const re = new RegExp(`new RixorTestToken\\("${k.name.replace(/[()]/g, '\\$&')}", "${k.symbol}", ${k.decimals}, 1_000_000_000${dec}, deployer, ${(k.faucet / 10n ** BigInt(k.decimals)).toLocaleString('en-US').replace(/,/g, '_')}${dec}\\)`)
    t(`token ${k.symbol} parameters equal DeployTestnetTokens.s.sol`, re.test(tokensSol), re.source)
  }
  t('listings, units, caps and minimum hold equal DeployTestnetTokens.s.sol',
    /"unitAmount", vm.toString\(uint256\(1_000e18\)\)/.test(tokensSol) && /"maxTotalLocked", vm.toString\(uint256\(20_000_000e18\)\)/.test(tokensSol) && /\(a, "riskClass", 1\)/.test(tokensSol) &&
    /"unitAmount", vm.toString\(uint256\(1_000e6\)\)/.test(tokensSol) && /"maxTotalLocked", vm.toString\(uint256\(10_000_000e6\)\)/.test(tokensSol) && /\(b, "riskClass", 2\)/.test(tokensSol) &&
    /"minHoldSeconds":3600/.test(tokensSol) && X.MIN_HOLD_SECONDS === 3600n)
  const seedSol = readFileSync(join(ROOT, 'script/SeedTestnetRewards.s.sol'), 'utf8')
  t('reward streams equal SeedTestnetRewards.s.sol', /AMOUNT_A = 140_000e18/.test(seedSol) && /AMOUNT_B = 70_000e18/.test(seedSol) && /DAYS = 14/.test(seedSol) && X.APPROVE_TOTAL === X.STREAMS[0].amount + X.STREAMS[1].amount)

  // ------------------------------------------------------------ 2. the exporter (rehearsal bundle) and its refusals
  const bundlePath = join(DIR, 'bundle.json')
  const ex = spawnSync(process.execPath, [join(ROOT, 'scripts/export-deploy-bundle.mjs'), '--rehearsal', '--allow-placeholders', '--out', bundlePath], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, RH_TESTNET_RPC_URL: 'http://127.0.0.1:1' } })
  t('exporter builds a rehearsal bundle from the real Forge scripts and self-checks it', ex.status === 0 && /all 40 post-deployment checks pass/.test(ex.stdout), (ex.stderr || ex.stdout).slice(-600))
  const B = JSON.parse(readFileSync(bundlePath, 'utf8'))
  const noAddr = spawnSync(process.execPath, [join(ROOT, 'scripts/export-deploy-bundle.mjs'), '--rehearsal'], { cwd: ROOT, encoding: 'utf8' })
  t('exporter refuses without the real seven addresses unless --allow-placeholders', noAddr.status === 1 && /seven public addresses/.test(noAddr.stderr))
  const dup = spawnSync(process.execPath, [join(ROOT, 'scripts/export-deploy-bundle.mjs'), '--rehearsal'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, RIXOR_DEPLOYER: B.deployer, RIXOR_OWNER_SIGNERS: B.signers.owner.join(','), RIXOR_GUARDIAN_SIGNERS: [B.signers.owner[0], ...B.signers.guardian.slice(1)].join(',') } })
  t('exporter refuses a signer shared between the Safes', dup.status === 1 && /six distinct/.test(dup.stderr))
  const dep = spawnSync(process.execPath, [join(ROOT, 'scripts/export-deploy-bundle.mjs'), '--rehearsal'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, RIXOR_DEPLOYER: B.signers.guardian[2], RIXOR_OWNER_SIGNERS: B.signers.owner.join(','), RIXOR_GUARDIAN_SIGNERS: B.signers.guardian.join(',') } })
  t('exporter refuses a deployer who is also a Safe signer', dep.status === 1 && /deployer must not be/.test(dep.stderr))

  const repro = (out) => spawnSync(process.execPath, [join(ROOT, 'scripts/export-deploy-bundle.mjs'), '--rehearsal', '--allow-placeholders', '--created-at', '2026-11-10T00:00:00.000Z', '--gas-price', '10000000', '--out', out], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, RH_TESTNET_RPC_URL: 'http://127.0.0.1:1' } })
  const r1 = repro(join(DIR, 'r1.json')), r2 = repro(join(DIR, 'r2.json'))
  const h1 = r1.status === 0 && JSON.parse(readFileSync(join(DIR, 'r1.json'), 'utf8')).bundleHash, h2 = r2.status === 0 && JSON.parse(readFileSync(join(DIR, 'r2.json'), 'utf8')).bundleHash
  t('reproducible: two independent exports with the same inputs give the same bundle hash', Boolean(h1) && h1 === h2, `${h1} vs ${h2}`)

  // ------------------------------------------------------------ 3. static validation: the bundle cannot deviate
  t('valid rehearsal bundle passes', validateBundle(B).length === 0, validateBundle(B).join('; '))
  t('11 transactions, 11 consecutive nonces, all from the deployer', B.transactions.length === 11 && B.transactions.every((x, i) => x.nonce === B.startNonce + i && x.from === B.deployer))
  t('largest payload is the Locker creation (~19.6 KB) and is accepted', Math.max(...B.transactions.map((x) => (x.data.length - 2) / 2)) === (B.transactions[5].data.length - 2) / 2 && (B.transactions[5].data.length - 2) / 2 > 19_000)
  const flip = (hex, at) => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1)
  const cases = [
    ['content changed without re-hashing', (b) => { b.transactions[8].data = flip(b.transactions[8].data, 40) }, /bundle hash/, false],
    ['approve calldata altered (re-hashed)', (b) => { b.transactions[8].data = flip(b.transactions[8].data, 40) }, /calldata differs/],
    ['fund amount altered (re-hashed)', (b) => { const I = new Interface(['function fund(address,uint256,uint256)']); b.transactions[9].data = I.encodeFunctionData('fund', [b.addresses.tMEMEA, 140_001n * 10n ** 18n, 14]) }, /calldata differs/],
    ['destination altered (re-hashed)', (b) => { b.transactions[9].to = b.addresses.challenges }, /destination/],
    ['creation turned into a call (re-hashed)', (b) => { b.transactions[5].to = b.addresses.locker }, /destination/],
    ['nonce altered (re-hashed)', (b) => { b.transactions[3].nonce += 1 }, /nonce/],
    ['value added (re-hashed)', (b) => { b.transactions[2].value = '0x1' }, /value must be 0/],
    ['Locker bytecode altered (re-hashed)', (b) => { b.transactions[5].data = flip(b.transactions[5].data, 5000) }, /creation code differs/],
    ['Locker guardian swapped in constructor args (re-hashed)', (b) => { const d = b.transactions[5].data; b.transactions[5].data = d.replace(b.addresses.guardianSafe.slice(2).toLowerCase(), b.signers.owner[0].slice(2).toLowerCase()) }, /constructor arguments differ/],
    ['token supply altered in constructor args (re-hashed)', (b) => { const d = b.transactions[2].data; const at = d.length - 64 * 3 - 1; b.transactions[2].data = flip(d, at) }, /constructor arguments differ|wrong size/],
    ['Safe owner swapped in the Safe initializer (re-hashed)', (b) => { b.transactions[0].data = b.transactions[0].data.replace(b.signers.owner[1].slice(2).toLowerCase(), b.deployer.slice(2).toLowerCase()) }, /calldata differs/],
    ['predicted address altered (re-hashed)', (b) => { b.transactions[6].creates.address = b.addresses.challenges }, /predicted address/],
    ['Locker code hash altered (re-hashed)', (b) => { b.transactions[5].creates.codeHash = keccak256('0x01') }, /Locker code hash/],
    ['a verification check removed (re-hashed)', (b) => { b.transactions[5].checks.pop() }, /checks differ/],
    ['an extra 12th transaction (re-hashed)', (b) => { b.transactions.push(clone(b.transactions[10])) }, /exactly 11/],
    ['address table altered (re-hashed)', (b) => { b.addresses.rewards = b.addresses.challenges }, /address rewards/],
    ['deployer replaced (re-hashed)', (b) => { b.deployer = Wallet.createRandom().address }, /address|sender|calldata/],
    ['duplicate signer (re-hashed)', (b) => { b.signers.guardian[0] = b.signers.owner[0] }, /six distinct/],
    ['deployer listed as a signer (re-hashed)', (b) => { b.signers.owner[2] = b.deployer }, /deployer must not/],
    ['mainnet chain id 4663', (b) => { b.chainId = 4663 }, /mainnet/i],
    ['unknown chain id 1', (b) => { b.chainId = 1 }, /unsupported chain/],
    ['rehearsal flag on a testnet chain id', (b) => { b.chainId = 46630 }, /rehearsal flag|not a final|official RPC/],
    ['testnet bundle with a different RPC', (b) => { b.chainId = 46630; b.rehearsal = false; b.final = true; b.rpc = 'https://evil.example'; b.explorer = X.TESTNET_EXPLORER }, /official RPC/],
    ['non-final (placeholder) bundle on testnet', (b) => { b.chainId = 46630; b.rehearsal = false; b.final = false; b.rpc = X.TESTNET_RPC; b.explorer = X.TESTNET_EXPLORER }, /not a final bundle/],
  ]
  for (const [name, mutate, re, doRehash = true] of cases) {
    const b = clone(B); mutate(b); if (doRehash) rehash(b)
    t(`refused: ${name}`, refused(b, re), validateBundle(b).join(' | ').slice(0, 300))
  }

  // ------------------------------------------------------------ 4. live: full run through preflight → wallet → verify
  const newChain = async () => { const c = await startRehearsalChain({ impersonate: true }); chains.push(c); await fundLocal(c.provider, B.deployer, 10n ** 17n); return c }
  const c1 = await newChain()
  const node = (m, p) => c1.provider.send(m, p)
  let walletChain = 31337, walletAccount = B.deployer, reject = false, walletNonceOverride = null
  const sentByWallet = []
  const wallet = async (m, p) => {
    if (m === 'eth_chainId') return '0x' + walletChain.toString(16)
    if (m === 'eth_accounts') return [walletAccount]
    if (m === 'eth_getTransactionCount' && walletNonceOverride !== null) return '0x' + walletNonceOverride.toString(16)
    if (m === 'eth_sendTransaction') { if (reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); sentByWallet.push(p[0]); return c1.provider.send('eth_sendTransaction', [{ ...p[0], gasPrice: '0x989680' }]) } // a wallet sets its own fees
    return c1.provider.send(m, p)
  }
  const step = async (i) => {
    const pf = await preflight(node, wallet, B, i)
    if (!pf.ok) return { ok: false, pf }
    const hash = await wallet('eth_sendTransaction', [pf.request])
    await c1.provider.waitForTransaction(hash)
    return { ok: true, pf, hash, v: await verifySent(node, B, i, hash) }
  }
  const failedLabel = (pf) => pf.checks.find((c) => !c.ok)?.label ?? ''

  let a = await assess(node, B)
  t('fresh chain: ready at step 1', a.status === 'ready' && a.next === 0, JSON.stringify(a.problems))
  walletChain = 46630
  let pf = await preflight(node, wallet, B, 0)
  t('wrong wallet network (46630 for a 31337 bundle) is refused', !pf.ok && /Wallet network/.test(failedLabel(pf)))
  walletChain = 4663
  pf = await preflight(node, wallet, B, 0)
  t('wallet on mainnet 4663 is refused explicitly', !pf.ok && pf.checks.some((c) => /mainnet/i.test(c.detail ?? '')))
  walletChain = 31337; walletAccount = B.signers.owner[0]
  pf = await preflight(node, wallet, B, 0)
  t('wrong account (a Safe signer instead of the deployer) is refused', !pf.ok && /planned deployer/.test(failedLabel(pf)))
  walletAccount = B.deployer; walletNonceOverride = 5
  pf = await preflight(node, wallet, B, 0)
  t("wallet's nonce disagreeing with the chain is refused", !pf.ok && /nonce agrees/.test(failedLabel(pf)))
  walletNonceOverride = null
  await fundLocal(c1.provider, B.deployer, 1000n)
  pf = await preflight(node, wallet, B, 0)
  t('insufficient testnet ETH is refused', !pf.ok && /Enough testnet ETH/.test(failedLabel(pf)))
  await fundLocal(c1.provider, B.deployer, 10n ** 17n)
  pf = await preflight(node, wallet, B, 2)
  t('a later step cannot be sent before the next one', !pf.ok && /next step/.test(failedLabel(pf)))
  reject = true
  pf = await preflight(node, wallet, B, 0)
  let rejected = false
  try { await wallet('eth_sendTransaction', [pf.request]) } catch (e) { rejected = e.code === 4001 }
  reject = false
  a = await assess(node, B)
  t('user rejection: nothing sent, still ready at step 1', pf.ok && rejected && a.status === 'ready' && a.next === 0 && sentByWallet.length === 0)
  t('the wallet request equals the approved transaction exactly (no nonce field, value 0)',
    pf.request && !('nonce' in pf.request) && !('to' in pf.request) === false && pf.request.to === B.transactions[0].to && pf.request.data === B.transactions[0].data && pf.request.value === '0x0' && BigInt(pf.request.gas) >= BigInt(B.transactions[0].gasPlanned))

  for (let i = 0; i < 5; i++) {
    const r = await step(i)
    t(`step ${i + 1} (${B.transactions[i].label}) passes preflight, is sent and verifies`, r.ok && r.v.ok, r.ok ? r.v.checks.filter((c) => !c.ok).map((c) => c.label).join(', ') : failedLabel(r.pf))
  }
  // Interrupted: a fresh "session" sees only the chain.
  a = await assess(node, B)
  t('interruption after step 5: resumes at step 6 with steps 1–5 proven on chain', a.status === 'ready' && a.next === 5 && a.steps.slice(0, 5).every((s) => s.state === 'done' && s.checks.every((c) => c.ok)))
  pf = await preflight(node, wallet, B, 3)
  t('duplicate prevention: a completed step cannot be sent again', !pf.ok && /next step/.test(failedLabel(pf)))
  // Pending: the Locker creation (largest payload) waits in the mempool.
  await c1.provider.send('evm_setAutomine', [false])
  pf = await preflight(node, wallet, B, 5)
  const lockerHash = pf.ok ? await wallet('eth_sendTransaction', [pf.request]) : null
  a = await assess(node, B)
  const pf2 = await preflight(node, wallet, B, 5)
  t('pending transaction: assessment waits and nothing can be sent twice', Boolean(lockerHash) && a.status === 'pending' && !pf2.ok)
  await c1.provider.send('evm_mine', [])
  await c1.provider.send('evm_setAutomine', [true])
  const lv = await verifySent(node, B, 5, lockerHash)
  t('Locker (19.6 KB creation) mined: address, bytecode hash and state verified', lv.ok, lv.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join('; '))
  const wrongHash = await verifySent(node, B, 6, lockerHash)
  t('verifying a transaction against the wrong step fails', !wrongHash.ok)
  for (let i = 6; i < 11; i++) {
    const r = await step(i)
    t(`step ${i + 1} (${B.transactions[i].label}) passes preflight, is sent and verifies`, r.ok && r.v.ok, r.ok ? r.v.checks.filter((c) => !c.ok).map((c) => c.label).join(', ') : failedLabel(r.pf))
  }
  a = await assess(node, B)
  t('complete: all 11 steps proven by their on-chain checks', a.status === 'complete' && a.steps.every((s) => s.state === 'done'))
  pf = await preflight(node, wallet, B, 10)
  t('after completion nothing more can be sent', !pf.ok)
  const m = manifestFor(B, 7)
  t('app manifest has exactly the testnet-mode fields', canonicalJson(Object.keys(m).sort()) === canonicalJson(['block', 'chainId', 'challenges', 'guardianSafe', 'locker', 'minHoldSeconds', 'ownerSafe', 'rewards', 'wif']) && m.locker === B.addresses.locker)
  const rewards = new Contract(B.addresses.rewards, ['function streamCount() view returns (uint256)'], c1.provider)
  t('exactly two reward streams exist (no double funding)', (await rewards.streamCount()) === 2n)

  // ------------------------------------------------------------ 5. hostile chain states
  const c2 = await newChain()
  const node2 = (m, p) => c2.provider.send(m, p)
  await c2.provider.send('eth_sendTransaction', [{ from: B.deployer, to: B.deployer, value: '0x1', gasPrice: '0x989680' }])
  a = await assess(node2, B)
  t('deployer nonce used by an unrelated transaction: halts (step 1 not proven)', a.status === 'halt' && /step 1/.test(a.problems.join(' ')))

  const c3 = await newChain()
  const node3 = (m, p) => c3.provider.send(m, p)
  const send3 = async (tx) => c3.provider.waitForTransaction(await c3.provider.send('eth_sendTransaction', [{ gasPrice: '0x989680', ...tx }]))
  await send3({ from: B.deployer, to: B.transactions[0].to, data: B.transactions[0].data, gas: '0x100000' })
  await send3({ from: B.deployer, to: B.transactions[1].to, data: B.transactions[1].data, gas: '0x100000' })
  // A wallet that altered step 3: a token with a different name at the predicted address.
  const tokenArt = art('RixorTestToken').bytecode.object
  const altered = concat([tokenArt, AbiCoder.defaultAbiCoder().encode(['string', 'string', 'uint8', 'uint256', 'address', 'uint256'], ['Evil (TEST)', 'tMEMEA', 18, 10n ** 27n, B.deployer, 10n ** 23n])])
  const evil = await c3.provider.send('eth_sendTransaction', [{ from: B.deployer, data: altered, gas: '0x200000', gasPrice: '0x989680' }])
  await c3.provider.waitForTransaction(evil)
  a = await assess(node3, B)
  t('a different contract at a predicted address: halts (state differs from the plan)', a.status === 'halt' && /step 3/.test(a.problems.join(' ')))
  const ev = await verifySent(node3, B, 2, evil)
  t('post-transaction verification catches altered calldata and contract state', !ev.ok && ev.checks.some((c) => /Calldata/.test(c.label) && !c.ok))

  const c4 = await newChain()
  const node4 = (m, p) => c4.provider.send(m, p)
  const stranger = Wallet.createRandom().address
  await fundLocal(c4.provider, stranger, 10n ** 17n)
  await c4.provider.waitForTransaction(await c4.provider.send('eth_sendTransaction', [{ from: stranger, to: B.transactions[0].to, data: B.transactions[0].data, gas: '0x100000', gasPrice: '0x989680' }]))
  a = await assess(node4, B)
  t('owner Safe created by someone else first: halts and asks for a re-plan', a.status === 'halt' && /already exists/.test(a.problems.join(' ')))

  const c5 = await newChain()
  const node5 = (m, p) => c5.provider.send(m, p)
  await c5.provider.send('anvil_setCode', [B.signers.guardian[1], '0xef0100' + '11'.repeat(20)])
  a = await assess(node5, B)
  t('a signer with EIP-7702 delegation (code) is refused before step 1', a.status === 'halt' && /not a plain EOA/.test(a.problems.join(' ')))

  // ------------------------------------------------------------ 6. independent derivations
  const want = expectedTx(B, 0)
  const init = safeInitializer(B.signers.owner)
  t('Safe salt is keccak256 of the label, as in CreateTestnetSafes', safeSalt(X.SAFE.ownerSaltLabel) === BigInt(labelHash(X.SAFE.ownerSaltLabel)) && want.data.includes(init.slice(10)))
  t('checks for each step are generated by the console, not taken from the bundle', B.transactions.every((x, i) => canonicalJson(x.checks) === canonicalJson(expectedChecks(B, i))))
  t('no private key, seed phrase or signature appears in the bundle', !/privateKey|mnemonic|seed|"signature"|"r":|"s":/i.test(JSON.stringify(B)) && getAddress(B.deployer) !== ZeroAddress)
} catch (e) {
  t('unexpected error', false, e.stack)
} finally {
  for (const c of chains) await c.stop()
  rmSync(DIR, { recursive: true, force: true })
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${failed} failing test(s) (local rehearsal chains only; stub wallet; nothing signed with a real key; no real network)`)
process.exit(failed ? 1 : 0)
