import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ganache from 'ganache'
import {
  BrowserProvider,
  ContractFactory,
  encodeBytes32String,
  parseEther,
} from 'ethers'

const artifactPath = path.join(process.cwd(), 'artifacts', 'RixorSavings.json')
if (!fs.existsSync(artifactPath)) {
  throw new Error('Missing artifact. Run npm run contract:compile first.')
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
const eip1193 = ganache.provider({
  logging: { quiet: true },
  wallet: { totalAccounts: 3, defaultBalance: 100 },
  chain: { chainId: 31337 },
})

const provider = new BrowserProvider(eip1193)
const owner = await provider.getSigner(0)
const outsider = await provider.getSigner(1)
const ownerAddress = await owner.getAddress()

const factory = new ContractFactory(artifact.abi, artifact.bytecode, owner)
const contract = await factory.deploy()
await contract.waitForDeployment()

const expectRevert = async (action, label) => {
  let reverted = false
  try {
    const tx = await action()
    await tx.wait()
  } catch {
    reverted = true
  }
  assert.equal(reverted, true, label)
}

await expectRevert(
  () => contract.deposit({ value: 0n }),
  'zero-value deposits must revert',
)

await (await contract.deposit({ value: parseEther('1') })).wait()
assert.equal(
  await contract.availableBalance(ownerAddress),
  parseEther('1'),
  'deposit must increase available balance',
)

await (await contract.withdrawAvailable(parseEther('0.25'))).wait()
assert.equal(
  await contract.availableBalance(ownerAddress),
  parseEther('0.75'),
  'available withdrawal must reduce available balance',
)

await expectRevert(
  () => contract.withdrawAvailable(parseEther('1')),
  'withdrawing more than available must revert',
)

const flexibleGoal = encodeBytes32String('emergency')
await (await contract.createPlan(parseEther('0.20'), 0, 0, flexibleGoal)).wait()

const lockedGoal = encodeBytes32String('school')
await (await contract.createPlan(parseEther('0.30'), 2, 1, lockedGoal)).wait()

await (await contract.topUpPlan(2n, parseEther('0.05'))).wait()
const toppedUpPlan = await contract.plans(2n)
assert.equal(toppedUpPlan.principal, parseEther('0.35'), 'top-up must increase plan principal')
assert.equal(await contract.availableBalance(ownerAddress), parseEther('0.20'), 'top-up must spend available balance')

await (await contract.extendPlan(2n, 3)).wait()
const extendedPlan = await contract.plans(2n)
assert.equal(extendedPlan.planType, 3n, 'extension must move the plan to the selected longer term')
assert.equal(
  extendedPlan.maturesAt - extendedPlan.startedAt,
  180n * 24n * 60n * 60n,
  'extended plan must restart with the new term duration',
)

const ids = await contract.getUserPlanIds(ownerAddress)
assert.deepEqual(ids.map(String), ['1', '2'], 'user plan ids must be durable and ordered')
assert.equal(
  await contract.availableBalance(ownerAddress),
  parseEther('0.20'),
  'creating plans must move principal out of available balance',
)

const flexiblePlan = await contract.plans(1n)
assert.equal(flexiblePlan.principal, parseEther('0.20'))
assert.equal(flexiblePlan.planType, 0n)
assert.equal(flexiblePlan.maturesAt, 0n)
assert.equal(flexiblePlan.status, 0n)

const lockedPlan = await contract.plans(2n)
assert.equal(lockedPlan.principal, parseEther('0.35'))
assert.equal(lockedPlan.planType, 3n)
assert.equal(lockedPlan.rewardPreference, 1n)
assert.equal(
  lockedPlan.maturesAt - lockedPlan.startedAt,
  180n * 24n * 60n * 60n,
  'extended plan maturity must be 180 days after extension',
)

await expectRevert(
  () => contract.connect(outsider).withdrawPlan(2n),
  'only the plan owner may withdraw a plan',
)

const earlyExitTx = await contract.withdrawPlan(2n)
const earlyExitReceipt = await earlyExitTx.wait()
const earlyExitEvent = earlyExitReceipt.logs
  .map((log) => {
    try {
      return contract.interface.parseLog(log)
    } catch {
      return null
    }
  })
  .find((event) => event?.name === 'PlanWithdrawn')

assert.ok(earlyExitEvent, 'plan withdrawal must emit PlanWithdrawn')
assert.equal(earlyExitEvent.args.planId, 2n)
assert.ok(earlyExitEvent.args.principalReturned < parseEther('0.35'))
assert.equal(earlyExitEvent.args.earlyExit, true)
assert.equal(earlyExitEvent.args.rewardPaid, 0n)
assert.equal(earlyExitEvent.args.rewardForfeited, 0n)

const earlyFeeEvent = earlyExitReceipt.logs
  .map((log) => {
    try {
      return contract.interface.parseLog(log)
    } catch {
      return null
    }
  })
  .find((event) => event?.name === 'EarlyExitFeeCharged')

assert.ok(earlyFeeEvent, 'early plan withdrawal must emit EarlyExitFeeCharged')
assert.equal(earlyFeeEvent.args.planId, 2n)
assert.ok(earlyFeeEvent.args.feeBps > 0n && earlyFeeEvent.args.feeBps <= 600n)
assert.equal(
  earlyExitEvent.args.principalReturned + earlyFeeEvent.args.feeAmount,
  parseEther('0.35'),
  'returned principal plus early fee must equal original principal',
)
assert.equal(
  await contract.protocolFees(),
  earlyFeeEvent.args.feeAmount,
  'early exit fee must accrue to protocol fees',
)

const closedLockedPlan = await contract.plans(2n)
assert.equal(closedLockedPlan.status, 1n, 'withdrawn plan must be closed')
assert.equal(closedLockedPlan.principal, 0n, 'closed plan principal must be zeroed')

await expectRevert(
  () => contract.withdrawPlan(2n),
  'a closed plan must not be withdrawable twice',
)

const flexibleExitTx = await contract.withdrawPlan(1n)
const flexibleExitReceipt = await flexibleExitTx.wait()
const flexibleExitEvent = flexibleExitReceipt.logs
  .map((log) => {
    try {
      return contract.interface.parseLog(log)
    } catch {
      return null
    }
  })
  .find((event) => event?.name === 'PlanWithdrawn')

assert.ok(flexibleExitEvent)
assert.equal(flexibleExitEvent.args.earlyExit, false, 'flexible plan exit is never an early exit')
assert.equal(flexibleExitEvent.args.principalReturned, parseEther('0.20'))

await (await contract.deposit({ value: parseEther('1') })).wait()
await (await contract.createPlan(parseEther('0.40'), 4, 0, flexibleGoal)).wait()
const quoteAtStart = await contract.getEarlyWithdrawalQuote(3n)
assert.equal(quoteAtStart.earlyExit, true)
assert.ok(quoteAtStart.feeBps > 0n && quoteAtStart.feeBps <= 800n)
assert.equal(
  quoteAtStart.amountReturned + quoteAtStart.feeAmount,
  parseEther('0.40'),
  'quote must conserve principal',
)

await eip1193.request({ method: 'evm_increaseTime', params: [365 * 24 * 60 * 60] })
await eip1193.request({ method: 'evm_mine', params: [] })
const maturedQuote = await contract.getEarlyWithdrawalQuote(3n)
assert.equal(maturedQuote.earlyExit, false)
assert.equal(maturedQuote.feeBps, 0n)
assert.equal(maturedQuote.feeAmount, 0n)
assert.equal(maturedQuote.amountReturned, parseEther('0.40'))

const protocolFees = await contract.protocolFees()
await expectRevert(
  () => contract.connect(outsider).withdrawProtocolFees(protocolFees),
  'only the fee recipient may withdraw protocol fees',
)
await (await contract.withdrawProtocolFees(protocolFees)).wait()
assert.equal(await contract.protocolFees(), 0n, 'fee withdrawal must clear accrued protocol fees')

console.log('RixorSavings contract tests passed.')
