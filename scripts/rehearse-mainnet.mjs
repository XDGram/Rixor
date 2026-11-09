#!/usr/bin/env node
// MAINNET REHEARSAL ON A LOCAL FORK. Nothing is sent to any real network; no key exists for any address used here.
//
//   npm run rehearse:mainnet [-- --config deploy/config/mainnet.candidate.json]
//
// 1. Starts a throwaway anvil fork of Robinhood Chain mainnet with chain id 31337 (signatures and transactions on it
//    can never be replayed on mainnet 4663).
// 2. A label-derived deployer and six label-derived signers (plain EOAs with no code on mainnet). The deployer gets
//    ETH from anvil and REAL $WIF through a real transfer from an existing mainnet holder (impersonated on the fork).
// 3. The real mainnet scripts in order: CreateMainnetSafes → DeployRixorV2 (official WIF, reviewed config) →
//    VerifyRixorV2 → SeedMainnetRewards, plus every guard that must refuse.
// 4. A user journey with real HOOKR/TORCH/WIF token code: lock, stream start at UTC midnight, claim, Flexible exit,
//    refund of zero-weight time, Committed exit at term end, and exact reward accounting.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, JsonRpcProvider, getAddress, id as labelHash, parseEther, formatUnits } from 'ethers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = process.env.RH_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const argv = process.argv.slice(2)
const CONFIG = argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : 'deploy/config/mainnet.candidate.json'
const PORT = 8900 + Math.floor(Math.random() * 90)
const LOCAL = `http://127.0.0.1:${PORT}`
const FORGE = join(ROOT, 'scripts/forge.mjs')
const ANVIL = join(ROOT, 'node_modules/@foundry-rs/anvil/bin.mjs')
const WIF = '0x5173b8eA6923c2d40267890D45C46a3480954773'
const HOOKR = '0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c'
const TORCH = '0x000050E18ffa3F8F7aD170Eb9CeF160eb3Ed1111'
// Existing mainnet holders (read from chain, Nov 2026), impersonated only on the local fork.
const HOLDERS = { [HOOKR]: '0xA522e716e1750702F775416f2Aa3Df620D9A1831', [TORCH]: '0x9eAc2DD9A2cEE409575901f50C8B3e5Bd7eE1b2d', [WIF]: '0x1089a7C3915c9F067615909DBd07697C21c32156' }
const SENTENCE = 'I have written authorisation to deploy Rixor V2 to Robinhood Chain mainnet'
const ERC20 = ['function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']
const DAY = 86400
const TAG = 'mainnet-rehearsal'
const cfg = JSON.parse(readFileSync(join(ROOT, CONFIG), 'utf8'))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const addr = (label) => getAddress('0x' + labelHash(label).slice(26))
const out = (r) => r.stdout + r.stderr

function forgeRaw(args, env = {}) {
  return spawnSync(process.execPath, [FORGE, ...args], { cwd: ROOT, env: { ...process.env, RIXOR_EXPECTED_CHAIN_ID: '31337', RIXOR_OUTPUT_TAG: TAG, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}
function forge(args, env = {}) {
  const r = forgeRaw(args, env)
  if (r.status !== 0) { console.error(r.stdout.slice(-3000), r.stderr.slice(-2000)); throw new Error(`forge ${args[1]} failed`) }
  return r.stdout
}
const logged = (text, label) => text.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`))?.[1]

const anvil = spawn(process.execPath, [ANVIL, '--fork-url', UPSTREAM, '--chain-id', '31337', '--port', String(PORT), '--silent'], { stdio: 'ignore' })
const provider = new JsonRpcProvider(LOCAL, 31337, { staticNetwork: true, cacheTimeout: -1 })
const cleanup = () => {
  for (const s of ['CreateMainnetSafes', 'DeployRixorV2', 'SeedMainnetRewards']) rmSync(join(ROOT, 'broadcast', `${s}.s.sol`, '31337'), { recursive: true, force: true })
  rmSync(join(ROOT, 'deployments', `31337-${TAG}.json`), { force: true })
}
try {
  for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break } catch { if (i > 60) throw new Error('anvil did not start'); await sleep(500) } }
  mkdirSync(join(ROOT, 'deployments'), { recursive: true })
  const deployer = addr('rixor.mainnet-rehearsal.deployer')
  const owners = [1, 2, 3].map((i) => addr(`rixor.mainnet-rehearsal.owner.${i}`))
  const guardians = [1, 2, 3].map((i) => addr(`rixor.mainnet-rehearsal.guardian.${i}`))
  for (const a of [deployer, ...owners, ...guardians]) if ((await provider.getCode(a)) !== '0x') throw new Error(`${a} has code on mainnet`)
  await provider.send('anvil_setBalance', [deployer, '0x' + parseEther('0.05').toString(16)])
  await provider.send('anvil_impersonateAccount', [deployer])
  const as = async (a) => { await provider.send('anvil_impersonateAccount', [a]); await provider.send('anvil_setBalance', [a, '0x' + parseEther('1').toString(16)]); return provider.getSigner(a) }
  const bal = (token, who) => new Contract(token, ERC20, provider).balanceOf(who)

  const streamTotal = cfg.streams.reduce((s, x) => s + BigInt(x.amount), 0n)
  // Real WIF moves to the deployer through a real transfer on the fork (exactness of WIF transfers, as on mainnet).
  const wifHolder = await as(HOLDERS[WIF])
  await (await new Contract(WIF, ERC20, wifHolder).transfer(deployer, streamTotal)).wait()
  check('deployer funded with real WIF by a real transfer (exact)', (await bal(WIF, deployer)) === streamTotal, `${formatUnits(streamTotal, 18)} WIF`)

  const unlocked = ['--rpc-url', LOCAL, '--broadcast', '--unlocked', '--sender', deployer, '--slow']
  const safeEnv = { RIXOR_OWNER_SIGNERS: owners.join(','), RIXOR_GUARDIAN_SIGNERS: guardians.join(',') }

  // ------------------------------------------------------------------ guards that must refuse
  const safesRefuse = (env, re) => { const r = forgeRaw(['script', 'script/CreateMainnetSafes.s.sol', '--rpc-url', LOCAL, '--sender', deployer], { ...safeEnv, ...env }); return r.status !== 0 && re.test(out(r)) }
  check('CreateMainnetSafes refuses a shared signer', safesRefuse({ RIXOR_GUARDIAN_SIGNERS: [owners[0], guardians[1], guardians[2]].join(',') }, /must not share any signer/))
  check('CreateMainnetSafes refuses the deployer as a signer', safesRefuse({ RIXOR_OWNER_SIGNERS: [deployer, owners[1], owners[2]].join(',') }, /deployer must not be a signer/))
  check('CreateMainnetSafes refuses a contract signer', safesRefuse({ RIXOR_OWNER_SIGNERS: [WIF, owners[1], owners[2]].join(',') }, /plain EOAs/))
  check('CreateMainnetSafes refuses 2 signers', safesRefuse({ RIXOR_OWNER_SIGNERS: owners.slice(0, 2).join(',') }, /exactly 3 signers/))
  check('CreateMainnetSafes refuses a chain pin mismatch (4663 pin on a 31337 RPC)', safesRefuse({ RIXOR_EXPECTED_CHAIN_ID: '4663', RIXOR_CONFIRM_MAINNET: SENTENCE }, /differs from RIXOR_EXPECTED_CHAIN_ID/))

  // ------------------------------------------------------------------ deployment
  const planned = forge(['script', 'script/CreateMainnetSafes.s.sol', '--rpc-url', LOCAL, '--sender', deployer], safeEnv)
  const safes = forge(['script', 'script/CreateMainnetSafes.s.sol', ...unlocked], safeEnv)
  const ownerSafe = logged(safes, 'owner Safe'), guardianSafe = logged(safes, 'guardian Safe')
  check('CreateMainnetSafes: two 2-of-3 Safe v1.5.0 at the predicted addresses', ownerSafe && guardianSafe && ownerSafe === logged(planned, 'predicted owner Safe') && guardianSafe === logged(planned, 'predicted guardian Safe'), `${ownerSafe} / ${guardianSafe}`)
  check('CreateMainnetSafes halts on a re-run (Safe already exists → re-plan)', safesRefuse({}, /HALT: the owner Safe address already has code/))

  const depEnv = { RIXOR_CONFIG: CONFIG, RIXOR_OWNER_SAFE: ownerSafe, RIXOR_GUARDIAN_SAFE: guardianSafe }
  forge(['script', 'script/DeployRixorV2.s.sol', ...unlocked], depEnv)
  const manifestPath = `deployments/31337-${TAG}.json`
  const m = JSON.parse(readFileSync(join(ROOT, manifestPath), 'utf8'))
  check('DeployRixorV2 deployed Locker, Rewards and Challenges wired to the official WIF', getAddress(m.wif) === WIF && m.minHoldSeconds === cfg.minHoldSeconds)
  const verify = forge(['script', 'script/VerifyRixorV2.s.sol', '--rpc-url', LOCAL], { RIXOR_DEPLOYMENT: manifestPath, RIXOR_CONFIG: CONFIG })
  check('VerifyRixorV2: code hash, roles, six distinct signers, listings equal the config', /verification passed/.test(verify))

  const seedRefuse = (env, re) => { const r = forgeRaw(['script', 'script/SeedMainnetRewards.s.sol', '--rpc-url', LOCAL, '--sender', deployer], { RIXOR_DEPLOYMENT: manifestPath, RIXOR_CONFIG: CONFIG, ...env }); return r.status !== 0 && re.test(out(r)) }
  check('SeedMainnetRewards refuses a config whose reward token is not the official WIF', seedRefuse({ RIXOR_CONFIG: 'deploy/config/testnet.template.json' }, /not the official WIF/))
  const fundTx = forge(['script', 'script/SeedMainnetRewards.s.sol', ...unlocked], { RIXOR_DEPLOYMENT: manifestPath, RIXOR_CONFIG: CONFIG })
  const rewardsAbi = JSON.parse(readFileSync(join(ROOT, 'src/protocol/abi/RixorRewards.json'), 'utf8'))
  const lockerAbi = JSON.parse(readFileSync(join(ROOT, 'src/protocol/abi/RixorLocker.json'), 'utf8'))
  const rewards = new Contract(m.rewards, rewardsAbi, provider)
  check('SeedMainnetRewards funded every planned stream with real WIF (exact transfer)', (await rewards.streamCount()) === BigInt(cfg.streams.length) && (await bal(WIF, m.rewards)) === streamTotal && (await rewards.totalFunded()) === streamTotal, /stream id/.test(fundTx) ? 'ok' : '')
  check('the exact approval is fully consumed (no residual WIF allowance)', (await new Contract(WIF, ERC20, provider).allowance(deployer, m.rewards)) === 0n)
  check('deployer holds no WIF afterwards', (await bal(WIF, deployer)) === 0n)
  const rerun = forge(['script', 'script/SeedMainnetRewards.s.sol', ...unlocked], { RIXOR_DEPLOYMENT: manifestPath, RIXOR_CONFIG: CONFIG })
  check('SeedMainnetRewards re-run is a no-op (never double-funds)', /nothing to do/.test(rerun) && (await rewards.streamCount()) === BigInt(cfg.streams.length))

  // ------------------------------------------------------------------ user journey (real token code)
  const hookrL = cfg.listings.find((l) => getAddress(l.token) === HOOKR), torchL = cfg.listings.find((l) => getAddress(l.token) === TORCH)
  const hookrS = cfg.streams.find((s) => getAddress(s.token) === HOOKR), torchS = cfg.streams.find((s) => getAddress(s.token) === TORCH)
  const hookrUser = await as(HOLDERS[HOOKR]), torchUser = await as(HOLDERS[TORCH])
  const locker = (s) => new Contract(m.locker, lockerAbi, s)
  const hookrBefore = await bal(HOOKR, HOLDERS[HOOKR]), torchBefore = await bal(TORCH, HOLDERS[TORCH])
  const hookrUnit = BigInt(hookrL.unitAmount), torchUnit = BigInt(torchL.unitAmount)
  await (await new Contract(HOOKR, ERC20, hookrUser).approve(m.locker, hookrUnit)).wait()
  await (await locker(hookrUser).lock(HOOKR, hookrUnit, 1, 30)).wait() // Committed, 30 days
  await (await new Contract(TORCH, ERC20, torchUser).approve(m.locker, torchUnit)).wait()
  await (await locker(torchUser).lock(TORCH, torchUnit, 0, 0)).wait() // Flexible
  check('lock one unit of HOOKR (Committed 30 d) and TORCH (Flexible): exact principal in the Locker', (await bal(HOOKR, m.locker)) === hookrUnit && (await bal(TORCH, m.locker)) === torchUnit)
  const diamond = await locker(hookrUser).lock.staticCall(HOOKR, hookrUnit, 2, 30).then(() => true, () => false)
  check('Class B refuses Diamond for HOOKR', !diamond)

  const s0 = await rewards.streamOf(0), s1 = await rewards.streamOf(1)
  const startTs = Number(s0.startDay) * DAY
  const now = (await provider.getBlock('latest')).timestamp
  check('streams start at the next UTC midnight', startTs > now && startTs - now <= DAY && startTs % DAY === 0, new Date(startTs * 1000).toISOString())
  const hookrId = (await locker(provider).positionsOf(HOLDERS[HOOKR]))[0]
  const torchId = (await locker(provider).positionsOf(HOLDERS[TORCH]))[0]
  const goto = async (t) => { await provider.send('evm_setNextBlockTimestamp', [t]); await provider.send('evm_mine', []) }

  // Day 1 of the stream: TORCH Flexible holder exits after exactly one day of rewards.
  await goto(startTs + DAY)
  const torchRate = BigInt(torchS === cfg.streams[0] ? s0.rate : s1.rate)
  await (await new Contract(m.rewards, rewardsAbi, torchUser).sync(TORCH, 100)).wait()
  const wifT0 = await bal(WIF, HOLDERS[TORCH])
  await (await new Contract(m.rewards, rewardsAbi, torchUser).claim([torchId], 100)).wait()
  const torchGot = (await bal(WIF, HOLDERS[TORCH])) - wifT0
  const torchExpect = torchRate * BigInt(DAY)
  // Tolerance: the claim is mined one block (≈1 s) after the target time.
  check('TORCH holder claims one day of the stream in real WIF (sole locker gets the full rate)', (torchGot > torchExpect ? torchGot - torchExpect : torchExpect - torchGot) <= torchRate * 2n, `${formatUnits(torchGot, 18)} WIF ≈ ${formatUnits(torchExpect, 18)}`)
  await (await locker(torchUser).exit(torchId, 0)).wait()
  check('TORCH Flexible exit returns the exact principal', (await bal(TORCH, HOLDERS[TORCH])) === torchBefore)

  // Day 3: HOOKR Committed holder claims three days.
  await goto(startTs + 3 * DAY)
  const hookrRate = BigInt(hookrS === cfg.streams[0] ? s0.rate : s1.rate)
  const wifH0 = await bal(WIF, HOLDERS[HOOKR])
  await (await new Contract(m.rewards, rewardsAbi, hookrUser).claim([hookrId], 200)).wait()
  const hookrGot = (await bal(WIF, HOLDERS[HOOKR])) - wifH0
  const hookrExpect = hookrRate * 3n * BigInt(DAY)
  check('HOOKR holder claims three days of the stream in real WIF', (hookrGot > hookrExpect ? hookrGot - hookrExpect : hookrExpect - hookrGot) <= hookrRate * 2n, `${formatUnits(hookrGot, 18)} WIF ≈ ${formatUnits(hookrExpect, 18)}`)
  const early = await locker(hookrUser).exit.staticCall(hookrId, 0).then(() => 'ok', (e) => e.shortMessage ?? 'reverted')
  check('Committed early exit with maxFee 0 is refused (fee applies before term end)', early !== 'ok', early)

  // After both streams end: refunds of the zero-weight time to the funder (the deployer), then final accounting.
  const endTs = Math.max(Number(s0.endDay), Number(s1.endDay)) * DAY
  await goto(endTs + DAY)
  for (const t of [HOOKR, TORCH]) await (await new Contract(m.rewards, rewardsAbi, wifHolder).sync(t, 500)).wait()
  const depSigner = await provider.getSigner(deployer)
  const torchStreamId = torchS === cfg.streams[0] ? 0 : 1, hookrStreamId = 1 - torchStreamId
  const [refundable, refundReady] = await rewards.refundable(torchStreamId)
  const wifD0 = await bal(WIF, deployer)
  await (await new Contract(m.rewards, rewardsAbi, depSigner).refund(torchStreamId, 500)).wait()
  const refunded = (await bal(WIF, deployer)) - wifD0
  const torchStream = BigInt(torchS.amount)
  check('TORCH stream: unearned WIF (time with nothing locked + rounding) refunds to the funder exactly', refundReady && refunded === torchStream - torchGot && refundable === refunded, `${formatUnits(refunded, 18)} WIF`)
  const wifH1 = await bal(WIF, HOLDERS[HOOKR])
  await (await new Contract(m.rewards, rewardsAbi, hookrUser).claim([hookrId], 2000)).wait()
  const hookrRest = (await bal(WIF, HOLDERS[HOOKR])) - wifH1
  const wifD1 = await bal(WIF, deployer)
  await (await new Contract(m.rewards, rewardsAbi, depSigner).refund(hookrStreamId, 500)).wait()
  const hookrRefund = (await bal(WIF, deployer)) - wifD1
  check('HOOKR stream fully paid: claims + refund = funded amount', hookrGot + hookrRest + hookrRefund === BigInt(hookrS.amount), `claimed ${formatUnits(hookrGot + hookrRest, 18)}, refunded ${formatUnits(hookrRefund, 18)}`)
  const [funded, claimed, refundedTotal] = await Promise.all([rewards.totalFunded(), rewards.totalClaimed(), rewards.totalRefunded()])
  const held = await bal(WIF, m.rewards)
  check('Rewards accounting: WIF held = funded − claimed − refunded (no WIF created or lost)', held === funded - claimed - refundedTotal && held < 1000n, `dust ${held} wei`)

  // After the HOOKR term (30 d from lock): Committed exit is fee-free and exact.
  const pos = await locker(provider).positionOf(hookrId)
  const termEnd = Number(pos.endsAt)
  const t = (await provider.getBlock('latest')).timestamp
  if (t <= termEnd) await goto(termEnd + 1)
  await (await locker(hookrUser).exit(hookrId, 0)).wait()
  check('HOOKR Committed exit after the term returns the exact principal, no fee', (await bal(HOOKR, HOLDERS[HOOKR])) === hookrBefore)
} catch (e) {
  check('rehearsal completed', false, e.message)
} finally {
  anvil.kill('SIGTERM')
  cleanup()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed (local mainnet fork, chain 31337; nothing sent to any real network)`)
  process.exit(failed ? 1 : 0)
}
