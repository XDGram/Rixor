#!/usr/bin/env node
// LOCAL REHEARSAL of the full testnet deployment, end to end, on a throwaway local chain. Nothing is sent to any
// real network.
//
//   npm run rehearse:testnet              # run and stop
//   npm run rehearse:testnet -- --keep    # keep the local chain running (for the frontend's testnet-mode e2e)
//
// Runs exactly the scripts a testnet deployment would run, in order:
//   LocalForkSafes (stand-in for the two testnet Safes) → DeployTestnetTokens → DeployRixorV2 (with the generated
//   config) → VerifyRixorV2 → SeedTestnetRewards, then a tester journey (faucet, lock, rewards, early exit).
// The chain is a local fork of Robinhood Chain mainnet with chain id 31337, because Safe v1.5.0 is deployed at the
// same addresses on testnet and mainnet (verified) and a plain local chain has no Safe contracts.
// Writes public/testnet/deployment.json (git-ignored) so a local frontend build can run in testnet mode.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, Interface, JsonRpcProvider, Wallet, formatUnits, id as labelHash, parseUnits } from 'ethers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = process.env.RH_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const PORT = Number(process.env.REHEARSAL_PORT || 8545)
const LOCAL = `http://127.0.0.1:${PORT}`
const KEEP = process.argv.includes('--keep')
const FORGE = join(ROOT, 'scripts/forge.mjs')
const ANVIL = join(ROOT, 'node_modules/@foundry-rs/anvil/bin.mjs')
const ERC20 = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function faucet() returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function name() view returns (string)']
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function forge(args, env = {}) {
  const r = spawnSync(process.execPath, [FORGE, ...args], { cwd: ROOT, env: { ...process.env, RIXOR_EXPECTED_CHAIN_ID: '31337', ...env }, encoding: 'utf8' })
  if (r.status !== 0) { console.error(r.stdout.slice(-3000), r.stderr.slice(-2000)); throw new Error(`forge ${args[1]} failed`) }
  return r.stdout
}
const logged = (out, label) => out.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`))?.[1]

const anvil = spawn(process.execPath, [ANVIL, '--fork-url', UPSTREAM, '--chain-id', '31337', '--port', String(PORT), '--silent'], { stdio: 'ignore', detached: KEEP })
const provider = new JsonRpcProvider(LOCAL, 31337, { staticNetwork: true, cacheTimeout: -1 })
let failed = false
try {
  for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break } catch { if (i > 60) throw new Error('anvil did not start'); await sleep(500) } }
  const accounts = await provider.send('eth_accounts', [])
  const [deployer, , tester] = accounts
  const unlocked = ['--rpc-url', LOCAL, '--broadcast', '--unlocked', '--sender', deployer, '--slow']
  mkdirSync(join(ROOT, 'deployments'), { recursive: true })

  // Signers: throwaway LOCAL test keys standing in for six hardware wallets (they sign with cast below, exactly as a
  // Ledger would with `cast wallet sign --ledger`). Never used anywhere else.
  // (Derived from labels: well-known keys such as 0x11…11 are EIP-7702-delegated on Robinhood mainnet and the
  // script correctly refuses them as hardware-wallet signers.)
  const ownerKeys = [1, 2, 3].map((i) => labelHash(`rixor.local.rehearsal.owner.${i}`))
  const guardianKeys = [1, 2, 3].map((i) => labelHash(`rixor.local.rehearsal.guardian.${i}`))
  const addr = (k) => new Wallet(k).address
  const safeEnv = { RIXOR_OWNER_SIGNERS: ownerKeys.map(addr).join(','), RIXOR_GUARDIAN_SIGNERS: guardianKeys.map(addr).join(',') }
  const planned = forge(['script', 'script/CreateTestnetSafes.s.sol', '--rpc-url', LOCAL, '--sender', deployer], safeEnv) // simulation only
  const safes = forge(['script', 'script/CreateTestnetSafes.s.sol', ...unlocked], safeEnv)
  const ownerSafe = logged(safes, 'owner Safe')
  const guardianSafe = logged(safes, 'guardian Safe')
  check('CreateTestnetSafes: 2-of-3 Safe v1.5.0, addresses equal the pre-broadcast prediction',
    ownerSafe && guardianSafe && logged(planned, 'predicted owner Safe') === ownerSafe && logged(planned, 'predicted guardian Safe') === guardianSafe, `${ownerSafe} / ${guardianSafe}`)

  const tok = forge(['script', 'script/DeployTestnetTokens.s.sol', ...unlocked])
  const cfgPath = 'deployments/31337-testnet-config.json'
  const cfg = JSON.parse(readFileSync(join(ROOT, cfgPath), 'utf8'))
  const [a, b] = cfg.listings.map((l) => new Contract(l.token, ERC20, provider))
  const reward = new Contract(cfg.wif, ERC20, provider)
  check('TEST tokens deployed and named as TEST', (await a.name()).endsWith('(TEST)') && (await b.name()).endsWith('(TEST)') && (await reward.symbol()) === 'tWIF' && logged(tok, 'tWIF'),
    `${await a.symbol()} (${await a.decimals()} dec), ${await b.symbol()} (${await b.decimals()} dec), ${await reward.symbol()}`)
  check('generated config: classes A and B, minimum hold 1 hour', cfg.listings[0].riskClass === 1 && cfg.listings[1].riskClass === 2 && cfg.minHoldSeconds === 3600)

  const env = { RIXOR_CONFIG: cfgPath, RIXOR_OWNER_SAFE: ownerSafe, RIXOR_GUARDIAN_SAFE: guardianSafe }
  forge(['script', 'script/DeployRixorV2.s.sol', ...unlocked], env)
  const manifest = JSON.parse(readFileSync(join(ROOT, 'deployments', '31337.json'), 'utf8'))
  const verify = forge(['script', 'script/VerifyRixorV2.s.sol', '--rpc-url', LOCAL], { RIXOR_DEPLOYMENT: 'deployments/31337.json' })
  check('DeployRixorV2 + VerifyRixorV2', /verification passed/.test(verify))

  forge(['script', 'script/SeedTestnetRewards.s.sol', ...unlocked], { RIXOR_DEPLOYMENT: 'deployments/31337.json', RIXOR_CONFIG: cfgPath })
  const rewardsAbi = JSON.parse(readFileSync(join(ROOT, 'src/protocol/abi/RixorRewards.json'), 'utf8'))
  const lockerAbi = JSON.parse(readFileSync(join(ROOT, 'src/protocol/abi/RixorLocker.json'), 'utf8'))
  check('TEST reward streams funded (2 × 14 days)', (await new Contract(manifest.rewards, rewardsAbi, provider).streamCount()) === 2n)

  // Tester journey: no deposit, no gas limits.
  const t = await provider.getSigner(tester)
  await (await new Contract(cfg.listings[1].token, ERC20, t).faucet()).wait()
  const bal = await b.balanceOf(tester)
  check('tester gets tMEMEB from its faucet', bal === parseUnits('100000', 6), formatUnits(bal, 6))
  await (await new Contract(cfg.listings[1].token, ERC20, t).approve(manifest.locker, parseUnits('20000', 6))).wait()
  const lk = new Contract(manifest.locker, lockerAbi, t)
  let noDiamond = false
  try { await lk.lock.staticCall(cfg.listings[1].token, parseUnits('20000', 6), 2, 30) } catch { noDiamond = true }
  check('Class B TEST token refuses Diamond', noDiamond)
  await (await lk.lock(cfg.listings[1].token, parseUnits('20000', 6), 1, 60)).wait()
  await provider.send('evm_increaseTime', [2 * 86400]); await provider.send('evm_mine', [])
  const id = (await lk.positionsOf(tester))[0]
  const rw = new Contract(manifest.rewards, rewardsAbi, t)
  const due = await rw.claim.staticCall([id], 2000)
  await (await rw.claim([id], 2000)).wait()
  check('tester claims tWIF from the stream', due > 0n && (await reward.balanceOf(tester)) >= due, `${formatUnits(due, 18)} tWIF`)
  const [, fee] = await lk.exitTerms(id)
  await (await lk.exit(id, fee)).wait()
  check('early Committed exit with the quoted fee', (await b.balanceOf(manifest.locker)) === 0n, `fee ${Number(fee) / 100}%`)

  // Multisig administration with the CLI flow: guardian Safe pauses, owner Safe unpauses (2 signatures each).
  const safeTx = async (safe, keys, data, label) => {
    const file = join(ROOT, 'deployments', `31337-safe-tx-${label}.json`)
    const run = (a) => spawnSync(process.execPath, [join(ROOT, 'scripts/safe-tx.mjs'), ...a], { cwd: ROOT, encoding: 'utf8' })
    const prep = run(['prepare', '--rpc', LOCAL, '--safe', safe, '--to', manifest.locker, '--data', data, '--out', file])
    if (prep.status !== 0) throw new Error(`safe-tx prepare: ${prep.stderr}`)
    const sigs = keys.slice(0, 2).map((k) => spawnSync(process.execPath, [join(ROOT, 'node_modules/@foundry-rs/cast/bin.mjs'), 'wallet', 'sign', '--private-key', k, '--data', '--from-file', file], { encoding: 'utf8' }).stdout.trim())
    const ex = run(['exec', '--rpc', LOCAL, '--tx', file, ...sigs.flatMap((x) => ['--sig', x])])
    if (ex.status !== 0) throw new Error(`safe-tx exec: ${ex.stderr}`)
    const calldata = ex.stdout.match(/cast send 0x[0-9a-fA-F]{40} (0x[0-9a-fA-F]+)/)[1]
    await (await (await provider.getSigner(deployer)).sendTransaction({ to: safe, data: calldata })).wait() // relays only
  }
  const L = new Interface(lockerAbi)
  const lockerRead = new Contract(manifest.locker, lockerAbi, provider)
  await safeTx(guardianSafe, guardianKeys, L.encodeFunctionData('pause'), 'pause')
  const pausedAfter = await lockerRead.paused()
  await safeTx(ownerSafe, ownerKeys, L.encodeFunctionData('unpause'), 'unpause')
  check('Safe CLI flow: guardian 2-of-3 pause, owner 2-of-3 unpause (typed-data signatures)', pausedAfter === true && (await lockerRead.paused()) === false)
  const oneSig = spawnSync(process.execPath, [join(ROOT, 'scripts/safe-tx.mjs'), 'exec', '--rpc', LOCAL, '--tx', join(ROOT, 'deployments', '31337-safe-tx-unpause.json'), '--sig', '0x' + '00'.repeat(65)], { encoding: 'utf8' })
  check('Safe CLI refuses insufficient or invalid signatures', oneSig.status !== 0)
  const mainnetPrep = spawnSync(process.execPath, [join(ROOT, 'scripts/safe-tx.mjs'), 'prepare', '--rpc', UPSTREAM, '--safe', ownerSafe, '--to', manifest.locker, '--data', '0x'], { encoding: 'utf8' })
  check('Safe CLI refuses Robinhood Chain mainnet (4663)', mainnetPrep.status !== 0 && /refused/.test(mainnetPrep.stderr))

  // Frontend testnet-mode manifest (local build only; git-ignored).
  mkdirSync(join(ROOT, 'public', 'testnet'), { recursive: true })
  writeFileSync(join(ROOT, 'public', 'testnet', 'deployment.json'), JSON.stringify({ ...manifest, rpc: LOCAL, label: 'Local testnet rehearsal (chain 31337)' }, null, 2))
  console.log(`frontend manifest: public/testnet/deployment.json (rpc ${LOCAL})`)
} catch (e) {
  failed = true
  check('rehearsal completed', false, e.message)
} finally {
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} checks passed (local chain only; nothing sent to any real network)`)
  if (KEEP && !failed && bad === 0) { console.log(`local chain left running on ${LOCAL} (pid ${anvil.pid})`); anvil.unref(); process.exit(0) }
  anvil.kill('SIGTERM')
  process.exit(bad ? 1 : 0)
}
