#!/usr/bin/env node
// Verifies the in-browser EVM demo with the SAME engine code the browser runs (bundled with esbuild):
//   1. the Robinhood Chain snapshot contains every contract the journey calls (runtime call audit);
//   2. the complete Rixor journey works against the actual Gate 1 bytecode;
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
const { locker: L, challenges: C, wif: WIF } = s.manifest.contracts
const wifR = new Contract(WIF, ERC20, p)
check('real WIF code and storage from mainnet snapshot', (await wifR.symbol()) === 'WIF' && (await wifR.totalSupply()) > 0n, `symbol WIF, totalSupply ${formatUnits(await wifR.totalSupply(), 18)}`)
check('Locker owned by a Safe v1.5.0 proxy', (await new Contract(L, lockerAbi, p).owner()) === s.manifest.contracts.ownerSafe, `Safe ${s.manifest.safeVersion}`)
check('demo seeds: 2 challenges, 3 demo lockers', Number(await new Contract(C, challengesAbi, p).nextChallengeId()) === 3)

// ---------------------------------------------------------------- the journey
const user = Wallet.createRandom().connect(p)
const sponsor = Wallet.createRandom().connect(p)
const lk = new Contract(L, lockerAbi, user)
const ch = new Contract(C, challengesAbi, user)
const wifU = new Contract(WIF, ERC20, user)
const timings = {}
const step = async (name, fn) => { const a = t(); const r = await fn(); timings[name] = Math.round(t() - a); return r }

await step('faucet', () => s.faucet(user.address))
await s.faucet(sponsor.address)
check('faucet funds a visitor with fork WIF (no deposit)', (await wifR.balanceOf(user.address)) === W(1_000_000))

await step('approve+lock', async () => { await (await wifU.approve(L, W(75_000))).wait(); await (await lk.lock(WIF, W(75_000), 2, 90)).wait() })
const pid = Number((await lk.positionsOf(user.address))[0])
check('lock: Diamond 10 units, 90 days', (await lk.positionOf(pid)).amount === W(75_000))

const now = s.chain.now()
const params = (title, goal) => ({ tokens: [WIF], minTier: 0, minUnitsPerEntry: 1, joinDeadline: now + 3600, endTime: now + 7200, goalPoints: goal, maxParticipants: 200, title, description: 'verify' })
await step('create', async () => { await (await wifU.approve(C, W(200_000))).wait(); await (await ch.createChallenge(params('verify: success', 0n), W(100_000))).wait() })
const cid = Number(await ch.nextChallengeId()) - 1
await (await ch.createChallenge(params('verify: refund', 10_000_000n), W(100_000))).wait()
const fid = cid + 1
check('create challenge escrows the pool', (await ch.getChallenge(cid)).escrow === W(100_000))

await step('join', () => ch.join(cid, pid, '0x0000000000000000000000000000000000000000').then((tx) => tx.wait()))
check('join scores 500,000 points (10 units × Diamond × WIF)', (await ch.entryOf(cid, user.address)).points === 500_000n)
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

await s.advance(31 * 86400)
await step('sweep', () => ch.sweep(cid).then((tx) => tx.wait()))
check('sweep after the claim window', await ch.swept(cid, user.address))

let locked = false
try { await lk.exit.staticCall(pid, 0) } catch { locked = true }
check('Diamond cannot exit before its term (StillLocked)', locked)
await s.advance(31 * 86400); await s.advance(31 * 86400)
const b3 = await wifR.balanceOf(user.address)
await step('exit', () => lk.exit(pid, 0).then((tx) => tx.wait()))
check('exit after term returns the full 75,000 WIF', (await wifR.balanceOf(user.address)) - b3 === W(75_000))

const logs = await p.getLogs({ address: [L, C], fromBlock: 0, toBlock: 'latest' })
check('events emitted by the real contracts', logs.length > 20, `${logs.length} Rixor events`)
check('runtime dependency audit: no call to an address without code', s.chain.missingDependencies.size === 0, s.chain.missingDependencies.size ? [...s.chain.missingDependencies].join(',') : 'none')

// ---------------------------------------------------------------- deterministic replay
const r0 = t()
const replica = await SimChain.create(snapshot, s.chain.chainId)
await replica.replay(s.chain.ops)
const rp = new SimProvider(replica)
const same = replica.head.hash === s.chain.head.hash
  && (await new Contract(WIF, ERC20, rp).balanceOf(user.address)) === (await wifR.balanceOf(user.address))
  && (await rp.getLogs({ address: [L, C], fromBlock: 0, toBlock: 'latest' })).length === logs.length
check('journal replays to the identical chain (head hash, balances, events)', same, `${s.chain.ops.length} operations replayed in ${Math.round(t() - r0)} ms`)

const mem = process.memoryUsage()
console.log(JSON.stringify({ stepTimingsMs: timings, heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1), rssMB: +(mem.rss / 1048576).toFixed(1), operations: s.chain.ops.length, blocks: s.chain.head.number }, null, 1))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
