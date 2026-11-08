import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ganache from 'ganache'
import { BrowserProvider, ContractFactory, parseEther } from 'ethers'

const load = (name) => {
  const file = path.join(process.cwd(), 'artifacts', `${name}.json`)
  if (!fs.existsSync(file)) throw new Error(`Missing ${name} artifact. Run npm run contract:compile first.`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const eip1193 = ganache.provider({
  logging: { quiet: true },
  wallet: { totalAccounts: 6, defaultBalance: 100 },
  chain: { chainId: 31337 },
})
const provider = new BrowserProvider(eip1193)
const signers = await Promise.all([0, 1, 2, 3, 4, 5].map((index) => provider.getSigner(index)))
const [deployer, alice, bob, carol, dave, erin] = signers

const tokenArtifact = load('MockBurnableToken')
const handsArtifact = load('RixorDiamondHands')
const token = await (await new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, deployer).deploy()).waitForDeployment()
const hands = await (await new ContractFactory(handsArtifact.abi, handsArtifact.bytecode, deployer).deploy(await token.getAddress())).waitForDeployment()
const handsAddress = await hands.getAddress()

const DAY = 24 * 60 * 60
const increaseTime = async (seconds) => {
  await provider.send('evm_increaseTime', [seconds])
  await provider.send('evm_mine', [])
}
const send = async (promise) => (await promise).wait()
const expectRevert = async (action, label) => {
  let reverted = false
  try {
    await (await action()).wait()
  } catch {
    reverted = true
  }
  assert.equal(reverted, true, label)
}
const balanceOf = (signer) => signer.getAddress().then((address) => token.balanceOf(address))
const lockIdsOf = async (signer) => hands.getOwnerLockIds(await signer.getAddress())

// Solvency: the contract must always hold principal plus every reward still owed.
const assertSolvent = async (label) => {
  let owed = await hands.totalLocked()
  const next = await hands.nextLockId()
  for (let id = 1n; id < next; id += 1n) owed += await hands.pendingReward(id)
  const held = await token.balanceOf(handsAddress)
  assert.ok(held >= owed, `${label}: contract holds ${held} but owes ${owed}`)
  assert.ok(held - owed < 1_000_000_000n, `${label}: unexpected surplus ${held - owed}`)
}

for (const signer of [alice, bob, carol, dave, erin]) {
  await send(token.mint(await signer.getAddress(), parseEther('10000')))
  await send(token.connect(signer).approve(handsAddress, parseEther('10000')))
}

// --- input validation
await expectRevert(() => hands.connect(alice).lock(0n, 0), 'zero amount must revert')
await expectRevert(() => hands.connect(alice).lock(parseEther('1'), 5), 'invalid term must revert')
await send(token.connect(erin).approve(handsAddress, 0n))
await expectRevert(() => hands.connect(erin).lock(parseEther('1'), 0), 'lock without allowance must revert')
await send(token.connect(erin).approve(handsAddress, parseEther('10000')))

// --- locking records amount, weight and timing
await send(hands.connect(alice).lock(parseEther('1000'), 4))
const [aliceId] = await lockIdsOf(alice)
const aliceLock = await hands.locks(aliceId)
assert.equal(aliceLock.amount, parseEther('1000'), 'lock stores amount')
assert.equal(aliceLock.weight, parseEther('3000'), '1-year lock has 3x weight')
assert.equal(aliceLock.unlocksAt - aliceLock.startedAt, BigInt(365 * DAY), '1-year lock duration')
assert.equal(await hands.totalLocked(), parseEther('1000'))
assert.equal(await hands.openLocks(), 1n)

// --- ownership checks
await expectRevert(() => hands.connect(bob).claim(aliceId), 'only owner can claim')
await expectRevert(() => hands.connect(bob).breakLock(aliceId), 'only owner can break')
await expectRevert(() => hands.connect(bob).unlock(aliceId), 'only owner can unlock')
await expectRevert(() => hands.connect(alice).unlock(aliceId), 'unlock before maturity must revert')

// --- breaking immediately: max fee, half burned, half to the remaining holder
await send(hands.connect(bob).lock(parseEther('1000'), 0))
const [bobId] = await lockIdsOf(bob)
const supplyBefore = await token.totalSupply()
const bobBefore = await balanceOf(bob)
const [quoteBps] = await hands.breakQuote(bobId)
assert.ok(quoteBps <= 500n && quoteBps >= 499n, `7-day max fee is 5%, got ${quoteBps}`)
await send(hands.connect(bob).breakLock(bobId))
const bobFee = parseEther('1000') - ((await balanceOf(bob)) - bobBefore)
assert.ok(bobFee > parseEther('49.9') && bobFee <= parseEther('50'), `bob fee ~50, got ${bobFee}`)
const burned = supplyBefore - (await token.totalSupply())
assert.equal(burned, bobFee / 2n, 'half of the fee is burned')
assert.equal(await hands.totalBurned(), burned)
const alicePending = await hands.pendingReward(aliceId)
assert.ok(bobFee - burned - alicePending < 1_000_000n, 'the other half goes to the remaining holder')
await expectRevert(() => hands.connect(bob).breakLock(bobId), 'closed lock cannot be broken again')
await assertSolvent('after first break')

// --- claiming pays rewards and keeps the lock open
const aliceBeforeClaim = await balanceOf(alice)
await send(hands.connect(alice).claim(aliceId))
assert.equal((await balanceOf(alice)) - aliceBeforeClaim, alicePending, 'claim pays pending reward')
assert.equal(await hands.pendingReward(aliceId), 0n)
assert.equal((await hands.locks(aliceId)).open, true, 'claim keeps the lock open')
await assertSolvent('after claim')

// --- rewards split by weight between remaining holders
await send(hands.connect(carol).lock(parseEther('1000'), 1)) // weight 1250
await send(hands.connect(dave).lock(parseEther('500'), 2)) // weight 750
const [carolId] = await lockIdsOf(carol)
const [daveId] = await lockIdsOf(dave)
await increaseTime(15 * DAY) // half of carol's 30-day term
const [carolBps] = await hands.breakQuote(carolId)
assert.ok(carolBps >= 499n && carolBps <= 502n, `fee halves at mid-term (expected ~500 bps), got ${carolBps}`)
await send(hands.connect(carol).breakLock(carolId))
const aliceShare = await hands.pendingReward(aliceId)
const daveShare = await hands.pendingReward(daveId)
const ratio = Number((aliceShare * 1000n) / daveShare) / 1000
assert.ok(Math.abs(ratio - 4) < 0.01, `alice (3000 weight) earns 4x dave (750 weight), got ${ratio}`)
await assertSolvent('after weighted split')

// --- forfeited rewards are redistributed when breaking
await send(hands.connect(erin).lock(parseEther('2000'), 3)) // weight 4000
const [erinId] = await lockIdsOf(erin)
const daveForfeit = await hands.pendingReward(daveId)
assert.ok(daveForfeit > 0n, 'dave has rewards to forfeit')
const erinBefore = await hands.pendingReward(erinId)
await send(hands.connect(dave).breakLock(daveId))
assert.ok((await hands.pendingReward(erinId)) > erinBefore, 'other holders receive the break fee and forfeit')
await assertSolvent('after forfeit')

// --- matured locks unlock without a fee and cannot be broken
await increaseTime(181 * DAY)
await expectRevert(() => hands.connect(erin).breakLock(erinId), 'matured lock cannot be broken')
const erinReward = await hands.pendingReward(erinId)
const erinBalanceBefore = await balanceOf(erin)
await send(hands.connect(erin).unlock(erinId))
assert.equal((await balanceOf(erin)) - erinBalanceBefore, parseEther('2000') + erinReward, 'unlock returns principal plus rewards')
await assertSolvent('after unlock')

// --- the last holder breaking burns everything, since nobody is left to pay
await send(hands.connect(bob).lock(parseEther('100'), 0))
await increaseTime(200 * DAY)
await send(hands.connect(alice).unlock(aliceId))
const ids = await lockIdsOf(bob)
const lastId = ids[ids.length - 1]
await send(hands.connect(bob).lock(parseEther('100'), 4))
const loneId = (await lockIdsOf(bob))[ids.length]
await increaseTime(8 * DAY)
await send(hands.connect(bob).unlock(lastId))
assert.equal(await hands.openLocks(), 1n, 'only one lock remains')
const burnedBefore = await hands.totalBurned()
const distributedBefore = await hands.totalDistributed()
await send(hands.connect(bob).breakLock(loneId))
assert.equal(await hands.totalDistributed(), distributedBefore, 'no distribution with no other holders')
assert.ok((await hands.totalBurned()) > burnedBefore, 'fee is fully burned')
assert.equal(await hands.totalLocked(), 0n)
assert.equal(await hands.totalWeight(), 0n)
await assertSolvent('after lone break')

console.log('RixorDiamondHands contract tests passed.')
