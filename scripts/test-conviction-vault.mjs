import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ganache from 'ganache'
import { BrowserProvider, ContractFactory, encodeBytes32String, parseEther } from 'ethers'

const load = (name) => {
  const file = path.join(process.cwd(), 'artifacts', `${name}.json`)
  if (!fs.existsSync(file)) throw new Error(`Missing ${name} artifact. Run npm run contract:compile first.`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const eip1193 = ganache.provider({
  logging: { quiet: true },
  wallet: { totalAccounts: 7, defaultBalance: 100 },
  chain: { chainId: 31337 },
})
const provider = new BrowserProvider(eip1193)
const [deployer, alice, bob, carol, dave, erin, sponsor] = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => provider.getSigner(i)))

const DAY = 86_400
const PRICE = parseEther('1') // mock price unit: 1.0
const deploy = async (name, ...args) => {
  const artifact = load(name)
  return (await new ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy(...args)).waitForDeployment()
}

const token = await deploy('MockBurnableToken')
const oracle = await deploy('RixorMockPriceOracle', PRICE)
const vault = await deploy('RixorConvictionVault', await token.getAddress(), await oracle.getAddress(), DAY)
const vaultAddress = await vault.getAddress()

const [FLEX, COMMITTED, DIAMOND] = [0, 1, 2]
const R = { Locked: 0n, EarlyWithFee: 1n, FlexWindowPassed: 2n, TermEnded: 3n, TargetReached: 4n, StopLoss: 5n, OracleStale: 6n }

const increaseTime = async (seconds) => {
  await provider.send('evm_increaseTime', [seconds])
  await provider.send('evm_mine', [])
}
const send = async (promise) => (await promise).wait()
// Ganache's gas estimation ignores evm_increaseTime for some checks, so time-sensitive
// expectations use staticCall (true EVM state) and post-window sends pass an explicit gas limit.
const expectRevert = async (action, errorName, label) => {
  let result
  try {
    result = await action()
  } catch (error) {
    const raw = error?.data ?? error?.info?.error?.data
    const data = typeof raw === 'string' ? raw : raw?.result ?? raw?.data
    const decoded = typeof data === 'string' && data.length >= 10 ? vault.interface.parseError(data) : null
    if (errorName) assert.equal(decoded?.name, errorName, `${label}: expected ${errorName}, got ${decoded?.name ?? 'undecoded revert'}`)
    return
  }
  if (result && typeof result.wait === 'function') {
    try {
      await result.wait()
    } catch {
      if (errorName) assert.fail(`${label}: reverted onchain without a decodable reason`)
      return
    }
  }
  assert.fail(`${label}: expected revert`)
}
const setPrice = (multiplier) => send(oracle.setPrice((PRICE * BigInt(Math.round(multiplier * 1000))) / 1000n))
const balanceOf = async (signer) => token.balanceOf(await signer.getAddress())
const lastLockId = async (signer) => {
  const ids = await vault.getOwnerLockIds(await signer.getAddress())
  return ids[ids.length - 1]
}
const lock = async (signer, amount, tier, days = 0, target = 0, loss = 0) => {
  await send(vault.connect(signer).lock(parseEther(amount), tier, days, target, loss))
  return lastLockId(signer)
}
const assertSolvent = async (label) => {
  let owed = (await vault.totalLocked()) + (await vault.challengeEscrow())
  const next = await vault.nextLockId()
  for (let id = 1n; id < next; id += 1n) owed += await vault.pendingReward(id)
  const held = await token.balanceOf(vaultAddress)
  assert.ok(held >= owed, `${label}: holds ${held} but owes ${owed}`)
  assert.ok(held - owed < 10_000_000_000n, `${label}: unexpected surplus ${held - owed}`)
}

for (const signer of [alice, bob, carol, dave, erin, sponsor]) {
  await send(token.mint(await signer.getAddress(), parseEther('100000')))
  await send(token.connect(signer).approve(vaultAddress, parseEther('100000')))
}

// ---------------------------------------------------------------- validation
await expectRevert(() => vault.connect(alice).lock.staticCall(0n, FLEX, 0, 0, 0), 'ZeroAmount', 'zero amount')
await expectRevert(() => vault.connect(alice).lock.staticCall(parseEther('1'), 3, 30, 1000, 0), 'InvalidTier', 'bad tier')
await expectRevert(() => vault.connect(alice).lock.staticCall(parseEther('1'), COMMITTED, 10, 1000, 0), 'InvalidTerm', 'term too short')
await expectRevert(() => vault.connect(alice).lock.staticCall(parseEther('1'), COMMITTED, 400, 1000, 0), 'InvalidTerm', 'term too long')
await expectRevert(() => vault.connect(alice).lock.staticCall(parseEther('1'), COMMITTED, 30, 0, 0), 'InvalidTarget', 'committed needs a target')
await expectRevert(() => vault.connect(alice).lock.staticCall(parseEther('1'), COMMITTED, 30, 1000, 100), 'InvalidMaxLoss', 'max loss too small')
await expectRevert(() => vault.connect(alice).lock.staticCall(parseEther('1'), DIAMOND, 30, 1000, 0), 'InvalidMaxLoss', 'diamond needs a max loss')
await expectRevert(() => vault.connect(alice).fundRewards.staticCall(parseEther('1')), 'NoOpenLocks', 'no pool without locks')

// ------------------------------------------------------- flexible early exit
const aliceDiamond = await lock(alice, '1000', DIAMOND, 90, 5000, 3000) // weight 3000
const aliceRecord = await vault.locks(aliceDiamond)
assert.equal(aliceRecord.weight, parseEther('3000'), 'diamond weight is 3x')
assert.equal(aliceRecord.entryPrice, PRICE, 'entry price recorded from oracle')
assert.equal(aliceRecord.endsAt - aliceRecord.startedAt, BigInt(90 * DAY), 'diamond backstop term')

const bobFlex = await lock(bob, '1000', FLEX)
let status = await vault.exitStatus(bobFlex)
assert.equal(status.reason, R.EarlyWithFee, 'flexible starts with a fee')
assert.ok(status.feeBps <= 100n && status.feeBps >= 99n, `flexible fee ~1%, got ${status.feeBps}`)
await expectRevert(() => vault.connect(bob).exit.staticCall(bobFlex, 50), 'FeeTooHigh', 'fee guard protects the user')
const supplyBefore = await token.totalSupply()
const bobBefore = await balanceOf(bob)
await send(vault.connect(bob).exit(bobFlex, 100))
const bobFee = parseEther('1000') - ((await balanceOf(bob)) - bobBefore)
assert.ok(bobFee > parseEther('9.8') && bobFee <= parseEther('10'), `bob paid ~1%, got ${bobFee}`)
assert.equal(supplyBefore - (await token.totalSupply()), bobFee / 2n, 'half the fee is burned')
assert.ok((await vault.pendingReward(aliceDiamond)) > 0n, 'other half accrues to open locks')
await expectRevert(() => vault.connect(bob).exit.staticCall(bobFlex, 100), 'LockClosed', 'cannot exit twice')
await assertSolvent('after flexible fee')

// --------------------------------------------------------------- diamond rules
await expectRevert(() => vault.connect(alice).exit.staticCall(aliceDiamond, 10_000), 'StillLocked', 'diamond cannot exit early')
await expectRevert(() => vault.connect(bob).exit.staticCall(aliceDiamond, 10_000), 'NotLockOwner', 'only the owner exits')

// --------------------------------------------------------- reward weights
const carolCommitted = await lock(carol, '1000', COMMITTED, 60, 2000, 0) // weight 1500, target +20%
const daveFlex = await lock(dave, '1000', FLEX) // weight 1000
const aliceBeforeFund = await vault.pendingReward(aliceDiamond)
await send(vault.connect(sponsor).fundRewards(parseEther('550')))
const aliceGain = (await vault.pendingReward(aliceDiamond)) - aliceBeforeFund
const carolGain = await vault.pendingReward(carolCommitted)
const daveGain = await vault.pendingReward(daveFlex)
assert.ok(Math.abs(Number((aliceGain * 1000n) / daveGain) / 1000 - 3) < 0.01, 'diamond earns 3x flexible')
assert.ok(Math.abs(Number((carolGain * 1000n) / daveGain) / 1000 - 1.5) < 0.01, 'committed earns 1.5x flexible')
await assertSolvent('after funding')

// -------------------------------------------------------- committed: fee, target
status = await vault.exitStatus(carolCommitted)
assert.equal(status.reason, R.EarlyWithFee, 'committed early exit has a fee')
assert.ok(status.feeBps <= 1000n && status.feeBps >= 990n, `committed fee ~10%, got ${status.feeBps}`)
await setPrice(1.25) // +25% >= carol's +20% target
status = await vault.exitStatus(carolCommitted)
assert.equal(status.reason, R.TargetReached, 'target reached unlocks committed')
assert.equal(status.roiBps, 2500n, 'live ROI is +25%')
const carolReward = await vault.pendingReward(carolCommitted)
const carolBefore = await balanceOf(carol)
await send(vault.connect(carol).exit(carolCommitted, 0))
assert.equal((await balanceOf(carol)) - carolBefore, parseEther('1000') + carolReward, 'completion pays principal plus rewards')
assert.equal(await vault.completedLocks(), 1n)
await assertSolvent('after target exit')

// ---------------------------------------------------- diamond: target and stop-loss
status = await vault.exitStatus(aliceDiamond)
assert.equal(status.reason, R.Locked, 'diamond +25% is still below its +50% target')
await setPrice(1.5)
assert.equal((await vault.exitStatus(aliceDiamond)).reason, R.TargetReached, 'diamond unlocks at its target')
await setPrice(0.69) // -31% <= alice's -30% max loss
status = await vault.exitStatus(aliceDiamond)
assert.equal(status.reason, R.StopLoss, 'diamond unlocks at its max loss')
const aliceForfeit = await vault.pendingReward(aliceDiamond)
const daveBeforeForfeit = await vault.pendingReward(daveFlex)
const aliceBefore = await balanceOf(alice)
await send(vault.connect(alice).exit(aliceDiamond, 0))
assert.equal((await balanceOf(alice)) - aliceBefore, parseEther('1000'), 'stop-loss returns full principal without fee')
assert.ok((await vault.pendingReward(daveFlex)) - daveBeforeForfeit >= aliceForfeit - 10_000n, 'stop-loss forfeits rewards to remaining holders')
await assertSolvent('after stop-loss')

// --------------------------------------------- diamond anti-trap backstops
await setPrice(1)
const erinDiamond = await lock(erin, '500', DIAMOND, 30, 10_000, 9_000) // +100% target, -90% loss
await increaseTime(2 * DAY) // oracle now stale (max age 1 day) but not past the 7-day escape
status = await vault.exitStatus(erinDiamond)
assert.equal(status.priceFresh, false, 'price is stale')
assert.equal(status.reason, R.Locked, 'short staleness does not unlock')
await expectRevert(() => vault.connect(alice).lock.staticCall(parseEther('1'), FLEX, 0, 0, 0), 'PriceUnavailable', 'no new locks on a stale price')
await increaseTime(6 * DAY)
assert.equal((await vault.exitStatus(erinDiamond)).reason, R.OracleStale, 'a dead oracle cannot trap diamond hands')
await setPrice(1)
assert.equal((await vault.exitStatus(erinDiamond)).reason, R.Locked, 'fresh price relocks')
await increaseTime(23 * DAY)
await setPrice(1)
assert.equal((await vault.exitStatus(erinDiamond)).reason, R.TermEnded, 'the term is a hard backstop')
await send(vault.connect(erin).exit(erinDiamond, 0))
assert.equal((await vault.exitStatus(daveFlex)).reason, R.FlexWindowPassed, 'flexible is free after 7 days')
await send(vault.connect(dave).exit(daveFlex, 0))
assert.equal(await vault.openLocks(), 0n)
await assertSolvent('after backstops')

// --------------------------------------------------------------- challenges
const now = async () => Number((await provider.getBlock('latest')).timestamp)
const title = encodeBytes32String('Hold the line')
let t = await now()
await expectRevert(() => vault.connect(sponsor).createChallenge.staticCall(0, 0, 0, 0, 0, t - 1, t + DAY, parseEther('1'), title), 'InvalidChallenge', 'join window in the past')
await expectRevert(() => vault.connect(sponsor).createChallenge.staticCall(1, 0, 0, 0, 0, t + DAY, t + 2 * DAY, parseEther('1'), title), 'InvalidTarget', 'ROI challenge needs a target')

await send(vault.connect(sponsor).createChallenge(0, COMMITTED, parseEther('100'), 0, parseEther('1500'), t + DAY, t + 10 * DAY, parseEther('300'), title))
const holdId = 1n
const aHold = await lock(alice, '1000', COMMITTED, 30, 5000, 0)
const bHold = await lock(bob, '800', DIAMOND, 30, 5000, 5000)
const cFlex = await lock(carol, '1000', FLEX)
const dHold = await lock(dave, '200', COMMITTED, 30, 5000, 0)
await expectRevert(() => vault.connect(carol).joinChallenge.staticCall(holdId, cFlex), 'NotEligible', 'tier below the minimum')
await expectRevert(() => vault.connect(bob).joinChallenge.staticCall(holdId, aHold), 'NotLockOwner', 'cannot join with another lock')
await send(vault.connect(alice).joinChallenge(holdId, aHold))
await send(vault.connect(bob).joinChallenge(holdId, bHold))
await send(vault.connect(dave).joinChallenge(holdId, dHold))
await expectRevert(() => vault.connect(alice).joinChallenge.staticCall(holdId, aHold), 'AlreadyJoined', 'join once')
let challenge = await vault.challenges(holdId)
assert.equal(challenge.participants, 3n)
assert.equal(challenge.committedTotal, parseEther('2000'), 'progress tracks committed amount')
assert.equal((await vault.getChallengeParticipants(holdId)).length, 3)

await increaseTime(2 * DAY)
await expectRevert(() => vault.connect(erin).joinChallenge.staticCall(holdId, 0n), 'ChallengeClosed', 'join window closed')
await setPrice(1)
await send(vault.connect(dave).exit(dHold, 1_000)) // dave leaves early, paying the committed fee
await expectRevert(() => vault.finalizeChallenge.staticCall(holdId), 'NotReady', 'cannot finalize before the end')
await increaseTime(9 * DAY)
await send(vault.connect(erin).finalizeChallenge(holdId))
await send(vault.connect(alice).qualify(holdId))
await send(vault.connect(bob).qualify(holdId))
await expectRevert(() => vault.connect(dave).qualify.staticCall(holdId), 'NotEligible', 'left before the end')
await expectRevert(() => vault.connect(alice).claimChallengeReward.staticCall(holdId), 'NotReady', 'claim waits for the window')
await increaseTime(4 * DAY)
const aliceBeforeChallenge = await balanceOf(alice)
await send(vault.connect(alice).claimChallengeReward(holdId, { gasLimit: 300_000 }))
await send(vault.connect(bob).claimChallengeReward(holdId, { gasLimit: 300_000 }))
assert.equal((await balanceOf(alice)) - aliceBeforeChallenge, parseEther('150'), 'equal split of the pool')
await expectRevert(() => vault.connect(alice).claimChallengeReward.staticCall(holdId), 'NothingToClaim', 'claim once')
await expectRevert(() => vault.connect(sponsor).refundChallenge.staticCall(holdId), 'NotReady', 'no refund when target met')
await assertSolvent('after hold challenge')

// ROI challenge with a missed community target, refunded to the sponsor.
await setPrice(1)
t = await now()
await send(vault.connect(sponsor).createChallenge(1, FLEX, 0, 2000, parseEther('5000'), t + DAY, t + 5 * DAY, parseEther('100'), encodeBytes32String('Up 20%')))
const roiId = 2n
await send(vault.connect(carol).joinChallenge(roiId, cFlex))
await increaseTime(6 * DAY)
await setPrice(1.3)
await send(vault.finalizeChallenge(roiId))
challenge = await vault.challenges(roiId)
assert.equal(challenge.snapshotPrice, (PRICE * 1300n) / 1000n, 'final price snapshot')
await send(vault.connect(carol).qualify(roiId))
await increaseTime(4 * DAY)
await expectRevert(() => vault.connect(carol).claimChallengeReward.staticCall(roiId), 'NotEligible', 'community target missed')
const sponsorBefore = await balanceOf(sponsor)
await send(vault.connect(erin).refundChallenge(roiId, { gasLimit: 300_000 }))
assert.equal((await balanceOf(sponsor)) - sponsorBefore, parseEther('100'), 'missed target refunds the sponsor')

// A challenge whose price never becomes fresh can still be refunded.
await setPrice(1)
t = await now()
await send(vault.connect(sponsor).createChallenge(1, FLEX, 0, 1000, 0, t + DAY, t + 2 * DAY, parseEther('50'), encodeBytes32String('Stale')))
await increaseTime(3 * DAY)
await expectRevert(() => vault.finalizeChallenge.staticCall(3n), 'PriceUnavailable', 'needs a fresh price to finalize')
await expectRevert(() => vault.connect(sponsor).refundChallenge.staticCall(3n), 'NotReady', 'escape not reached yet')
await increaseTime(7 * DAY)
await send(vault.connect(sponsor).refundChallenge(3n, { gasLimit: 300_000 }))
assert.equal(await vault.challengeEscrow(), 0n, 'all escrow returned or paid')
await assertSolvent('after challenges')

console.log('RixorConvictionVault contract tests passed.')
