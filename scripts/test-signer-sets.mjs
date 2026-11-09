#!/usr/bin/env node
// Unit tests for scripts/lib/signer-sets.mjs (the JS mirror of script/RixorSignerChecks.sol). No network.
//   npm run test:signer-sets
import { getAddress, id } from 'ethers'
import { signerCodeProblems, signerSetProblems } from './lib/signer-sets.mjs'

const A = (tag) => getAddress('0x' + id(`rixor.signer-test.${tag}`).slice(26))
const [o1, o2, o3, g1, g2, g3, d] = ['o1', 'o2', 'o3', 'g1', 'g2', 'g3', 'd'].map(A)
const ZERO = '0x0000000000000000000000000000000000000000'
let failed = 0
const expect = (name, input, pattern) => {
  const p = signerSetProblems(input)
  const ok = pattern ? p.some((x) => pattern.test(x)) : p.length === 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(p)}`}`)
}
const base = { owners: [o1, o2, o3], guardians: [g1, g2, g3], deployer: d }
const SHARE = /must not share any signer/

expect('six distinct signers and a separate deployer accepted', base)
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
  const g = [g1, g2, g3]; g[j] = base.owners[i]
  expect(`one shared signer rejected (owner ${i + 1} as guardian ${j + 1})`, { ...base, guardians: g }, SHARE)
}
expect('two shared signers rejected', { ...base, guardians: [o1, o2, g3] }, SHARE)
expect('two shared signers rejected (other positions)', { ...base, guardians: [g1, o3, o1] }, SHARE)
expect('three shared signers rejected (identical sets)', { ...base, guardians: [o1, o2, o3] }, SHARE)
expect('three shared signers rejected (permuted)', { ...base, guardians: [o3, o1, o2] }, SHARE)
expect('shared signer rejected regardless of address case', { ...base, guardians: [o1.toLowerCase(), g2, g3] }, SHARE)
expect('duplicate inside owner Safe rejected', { ...base, owners: [o1, o1, o3] }, /owner: duplicate signer/)
expect('duplicate inside guardian Safe rejected', { ...base, guardians: [g1, g2, g2] }, /guardian: duplicate signer/)
expect('duplicate inside guardian Safe rejected (case-insensitive)', { ...base, guardians: [g1, g1.toLowerCase(), g3] }, /guardian: duplicate signer/)
for (let i = 0; i < 3; i++) {
  const o = [o1, o2, o3]; o[i] = d
  expect(`deployer as owner signer ${i + 1} rejected`, { ...base, owners: o }, /owner: the deployer must not be a signer/)
  const g = [g1, g2, g3]; g[i] = d
  expect(`deployer as guardian signer ${i + 1} rejected`, { ...base, guardians: g }, /guardian: the deployer must not be a signer/)
}
expect('zero owner signer rejected', { ...base, owners: [o1, ZERO, o3] }, /owner: zero signer/)
expect('zero guardian signer rejected', { ...base, guardians: [ZERO, g2, g3] }, /guardian: zero signer/)
expect('two signers in a Safe rejected', { ...base, owners: [o1, o2] }, /owner: exactly 3/)
expect('four signers in a Safe rejected', { ...base, guardians: [g1, g2, g3, A('g4')] }, /guardian: exactly 3/)
expect('invalid address rejected', { ...base, owners: [o1, o2, '0x1234'] }, /not a valid address/)

// Live code check with a stub provider: contract code and an EIP-7702 delegation are both rejected.
const codes = { [g2]: '0x6080', [o3]: '0xef0100' + 'ab'.repeat(20) }
const stub = { getCode: async (a) => codes[getAddress(a)] ?? '0x' }
const live = await signerCodeProblems(stub, base)
const liveOk = live.length === 2 && live.some((x) => x.includes(g2) && /contract/.test(x)) && live.some((x) => x.includes(o3) && /EIP-7702/.test(x))
if (!liveOk) failed++
console.log(`${liveOk ? 'PASS' : 'FAIL'} contract signer and EIP-7702-delegated signer rejected by the live check`)
const delegatedDeployer = await signerCodeProblems({ getCode: async (a) => (getAddress(a) === d ? '0xef0100' + 'cd'.repeat(20) : '0x') }, base)
const ddOk = delegatedDeployer.length === 1 && /deployer/.test(delegatedDeployer[0])
if (!ddOk) failed++
console.log(`${ddOk ? 'PASS' : 'FAIL'} delegated deployer rejected by the live check`)

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${failed} failing case(s)`)
process.exit(failed ? 1 : 0)
