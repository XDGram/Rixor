#!/usr/bin/env node
// Verifies the in-browser EVM demo with the SAME engine code the browser runs (bundled with esbuild):
//   1. the Robinhood Chain snapshot contains every contract the journey calls (runtime call audit);
//   2. the complete Rixor V2 journey works against the actual compiled bytecode and real token code
//      (HOOKR, TORCH and WIF copied from Robinhood Chain mainnet);
//   3. a saved journal replays deterministically to the identical chain.
//   node scripts/verify-browser-evm.mjs
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'cache', 'verify-browser-evm')
mkdirSync(OUT, { recursive: true })
const entry = join(OUT, 'entry.ts')
writeFileSync(entry, `
export { bootSim } from '${join(ROOT, 'src/protocol/sim/session.ts')}'
export { SimChain } from '${join(ROOT, 'src/protocol/sim/engine.ts')}'
export { SimProvider } from '${join(ROOT, 'src/protocol/sim/provider.ts')}'
`)
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: join(OUT, 'engine.mjs'), logLevel: 'error', loader: { '.json': 'json' }, packages: 'external' })
const { bootSim, SimChain, SimProvider } = await import(pathToFileURL(join(OUT, 'engine.mjs')).href)
const { Contract, Wallet, parseUnits, formatUnits } = await import('ethers')

const lockerAbi = JSON.parse(readFileSync(join(ROOT, 'src/protocol/abi/RixorLocker.json'), 'utf8'))
const challengesAbi = JSON.parse(readFileSync(join(ROOT, 'src/protocol/abi/RixorChallenges.json'), 'utf8'))
const rewardsAbi = JSON.parse(readFileSync(join(ROOT, 'src/protocol/abi/RixorRewards.json'), 'utf8'))
const snapshot = JSON.parse(readFileSync(join(ROOT, 'public/demo/robinhood-snapshot.json'), 'utf8'))
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)']
const W = (n) => parseUnits(String(n), 18)
const results = []
const check = (name, cond, detail = '') => { results.push({ name, ok: Boolean(cond), detail }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const t = () => performance.now()

// ---------------------------------------------------------------- boot + seed
const t0 = t()
const s = await bootSim(undefined, snapshot)
check('boot + first-visit setup from snapshot', s.manifest.contracts.locker, `${Math.round(t() - t0)} ms, ${s.chain.ops.length} journaled operations`)
const p = s.provider
const { locker: L, challenges: C, rewards: RW, wif: WIF } = s.manifest.contracts
const HOOKR = snapshot.memeTokens.HOOKR.address
const TORCH = snapshot.memeTokens.TORCH.address
const wifR = new Contract(WIF, ERC20, p)
check('real WIF code and storage from mainnet snapshot', (await wifR.symbol()) === 'WIF' && (await wifR.totalSupply()) > 0n, `symbol WIF, totalSupply ${formatUnits(await wifR.totalSupply(), 18)}`)
check('real HOOKR and TORCH code from mainnet snapshot', (await new Contract(HOOKR, ERC20, p).symbol()) === 'HOOKR' && (await new Contract(TORCH, ERC20, p).symbol()) === 'TORCH')
const lockerR = new Contract(L, lockerAbi, p)
check('Locker owned by a Safe v1.5.0 proxy', (await lockerR.owner()) === s.manifest.contracts.ownerSafe, `Safe ${s.manifest.safeVersion}`)
check('Locker lists HOOKR (Class A) and TORCH (Class B); WIF is not lockable', Number(await lockerR.riskClass(HOOKR)) === 1 && Number(await lockerR.riskClass(TORCH)) === 2 && !(await lockerR.isListed(WIF)))
check('demo seeds: 2 challenges, 2 reward streams, 3 demo lockers', Number(await new Contract(C, challengesAbi, p).nextChallengeId()) === 3 && Number(await new Contract(RW, rewardsAbi, p).streamCount()) === 2)

// ---------------------------------------------------------------- the journey
const user = Wallet.createRandom().connect(p)
const sponsor = Wallet.createRandom().connect(p)
const lk = new Contract(L, lockerAbi, user)
const ch = new Contract(C, challengesAbi, user)
const rw = new Contract(RW, rewardsAbi, user)
const wifU = new Contract(WIF, ERC20, user)
const hookrU = new Contract(HOOKR, ERC20, user)
const torchU = new Contract(TORCH, ERC20, user)
const timings = {}
const step = async (name, fn) => { const a = t(); const r = await fn(); timings[name] = Math.round(t() - a); return r }

await step('faucet', () => s.faucet(user.address))
await s.faucet(sponsor.address)
check('faucet: demo HOOKR, TORCH and WIF (no deposit)', (await hookrU.balanceOf(user.address)) === W(500_000) && (await torchU.balanceOf(user.address)) === W(500_000) && (await wifR.balanceOf(user.address)) === W(1_000_000))

await step('approve+lock', async () => { await (await hookrU.approve(L, W(100_000))).wait(); await (await lk.lock(HOOKR, W(100_000), 2, 90)).wait() })
const pid = Number((await lk.positionsOf(user.address))[0])
check('lock HOOKR: Diamond 10 units, 90 days, exact transfer', (await lk.positionOf(pid)).amount === W(100_000) && (await hookrU.balanceOf(L)) >= W(100_000))
let noDiamond = false
await (await torchU.approve(L, W(50_000))).wait()
try { await lk.lock.staticCall(TORCH, W(50_000), 2, 30) } catch { noDiamond = true }
check('Class B: Diamond lock on TORCH rejected', noDiamond)
await (await lk.lock(TORCH, W(50_000), 1, 60)).wait()
const tpid = Number((await lk.positionsOf(user.address))[1])
check('lock TORCH: Committed 60 days, no buy tax on deposit', (await lk.positionOf(tpid)).amount === W(50_000))

const now = s.chain.now()
const params = (title, goal) => ({ tokens: [HOOKR, TORCH], minTier: 0, minUnitsPerEntry: 1, joinDeadline: now + 3600, endTime: now + 7200, goalPoints: goal, maxParticipants: 200, title, description: 'verify' })
await step('create', async () => { await (await wifU.approve(C, W(200_000))).wait(); await (await ch.createChallenge(params('verify: success', 0n), W(100_000))).wait() })
const cid = Number(await ch.nextChallengeId()) - 1
await (await ch.createChallenge(params('verify: refund', 10_000_000n), W(100_000))).wait()
const fid = cid + 1
check('create multi-token challenge escrows the pool', (await ch.getChallenge(cid)).escrow === W(100_000) && (await ch.challengeTokens(cid)).length === 2)

await step('join', () => ch.join(cid, pid, '0x0000000000000000000000000000000000000000').then((tx) => tx.wait()))
check('join scores 250,000 points (10 units x Diamond; every token counts equally)', (await ch.entryOf(cid, user.address)).points === 250_000n)
let laneBlocked = false
try { await ch.join.staticCall(fid, pid, '0x0000000000000000000000000000000000000000') } catch (e) { laneBlocked = true }
check('lane rule: same position cannot join a second running community challenge', laneBlocked)

await step('sponsor', async () => { const cs = new Contract(C, challengesAbi, sponsor); await (await new Contract(WIF, ERC20, sponsor).approve(C, W(20_000))).wait(); await (await cs.sponsor(cid, W(20_000))).wait() })
check('sponsor adds to the pool', (await ch.getChallenge(cid)).pool === W(120_000))

let early = false
try { await ch.settle.staticCall(cid, 200) } catch { early = true }
check('settle reverts before the end (NotEnded)', early)
await s.advance(7300)
await step('settle', () => ch.settle(cid, 200).then((tx) => tx.wait()))
const c1 = await ch.getChallenge(cid)
check('settle: successful, 1 qualified', c1.settled && c1.success && Number(c1.qualifiedCount) === 1)
const before = await wifR.balanceOf(user.address)
await step('claim', () => ch.claim(cid).then((tx) => tx.wait()))
check('claim pays the whole 120,000 WIF pool', (await wifR.balanceOf(user.address)) - before === W(120_000))

await (await ch.settle(fid, 200)).wait()
check('goal missed → failed challenge', !(await ch.getChallenge(fid)).success)
const b2 = await wifR.balanceOf(user.address)
await step('refund', () => ch.refund(fid).then((tx) => tx.wait()))
check('refund returns the exact 100,000 WIF contribution', (await wifR.balanceOf(user.address)) - b2 === W(100_000))

// Reward streams: the seed funded 140,000 WIF / 14 days for HOOKR and 70,000 / 14 days for TORCH.
await s.advance(3 * 86400)
const expected = await rw.claim.staticCall([pid, tpid], 2_000)
const b4 = await wifR.balanceOf(user.address)
await step('claimRewards', () => rw.claim([pid, tpid], 2_000).then((tx) => tx.wait()))
const got = (await wifR.balanceOf(user.address)) - b4
// The simulation clock follows wall time, so the mined claim includes the few seconds since the preview.
check('stream rewards: claim pays the simulated preview (plus seconds elapsed)', got >= expected && got - expected < expected / 1000n, `${formatUnits(got, 18)} WIF after 3 days (preview ${formatUnits(expected, 18)})`)
const again = await rw.claim.staticCall([pid, tpid], 2_000) // the simulation clock follows wall time, so a second or two accrues
check('stream rewards: no double payment (only the seconds since the claim are claimable)', again < got / 1000n, `${formatUnits(again, 18)} WIF`)

await s.advance(31 * 86400)
await step('sweep', () => ch.sweep(cid).then((tx) => tx.wait()))
check('sweep after the claim window', await ch.swept(cid, user.address))

let locked = false
try { await lk.exit.staticCall(pid, 0) } catch { locked = true }
check('Diamond cannot exit before its term (StillLocked)', locked)
await s.advance(31 * 86400); await s.advance(31 * 86400)
const tb = await torchU.balanceOf(user.address)
await (await lk.exit(tpid, 0)).wait()
check('TORCH exit after the 60-day term returns the full 50,000 (no buy tax)', (await torchU.balanceOf(user.address)) - tb === W(50_000))
const b3 = await hookrU.balanceOf(user.address)
await step('exit', () => lk.exit(pid, 0).then((tx) => tx.wait()))
check('HOOKR exit after term returns the full 100,000', (await hookrU.balanceOf(user.address)) - b3 === W(100_000))
const after = await rw.claim.staticCall([pid, tpid], 2_000)
check('rewards stay claimable after exit', after > 0n, `${formatUnits(after, 18)} WIF`)

const logs = await p.getLogs({ address: [L, C, RW], fromBlock: 0, toBlock: 'latest' })
check('events emitted by the real contracts', logs.length > 20, `${logs.length} Rixor events`)
check('runtime dependency audit: no call to an address without code', s.chain.missingDependencies.size === 0, s.chain.missingDependencies.size ? [...s.chain.missingDependencies].join(',') : 'none')

// ---------------------------------------------------------------- deterministic replay
const r0 = t()
const replica = await SimChain.create(snapshot, s.chain.chainId)
await replica.replay(s.chain.ops)
const rp = new SimProvider(replica)
const same = replica.head.hash === s.chain.head.hash
  && (await new Contract(WIF, ERC20, rp).balanceOf(user.address)) === (await wifR.balanceOf(user.address))
  && (await rp.getLogs({ address: [L, C, RW], fromBlock: 0, toBlock: 'latest' })).length === logs.length
check('journal replays to the identical chain (head hash, balances, events)', same, `${s.chain.ops.length} operations replayed in ${Math.round(t() - r0)} ms`)

const mem = process.memoryUsage()
console.log(JSON.stringify({ stepTimingsMs: timings, heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1), rssMB: +(mem.rss / 1048576).toFixed(1), operations: s.chain.ops.length, blocks: s.chain.head.number }, null, 1))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
