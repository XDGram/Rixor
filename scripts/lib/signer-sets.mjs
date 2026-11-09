// Signer-set rules for the Rixor owner and guardian Safes. Mirrors script/RixorSignerChecks.sol exactly and is used
// by planning (plan-testnet) and the live preflight, so every stage applies the same rules:
//   - exactly 3 signers per Safe (2-of-3); no zero address; no duplicate inside either Safe;
//   - SIX DISTINCT signers: no address is both an owner signer and a guardian signer (not even one);
//   - the deployer is none of the six;
//   - (live, with a provider) every signer and the deployer is a plain EOA: no contract code, no EIP-7702 delegation.
import { ZeroAddress, getAddress } from 'ethers'

/** Pure checks. Returns a list of problems (empty = valid). Never throws on bad input. */
export function signerSetProblems({ owners, guardians, deployer }) {
  const problems = []
  const norm = (list, role) => (list ?? []).map((a, i) => { try { return getAddress(a) } catch { problems.push(`${role}: signer ${i + 1} is not a valid address (${a})`); return null } })
  const o = norm(owners, 'owner')
  const g = norm(guardians, 'guardian')
  let d = null
  try { d = getAddress(deployer) } catch { problems.push(`deployer is not a valid address (${deployer})`) }
  for (const [role, s] of [['owner', o], ['guardian', g]]) {
    if (s.length !== 3) problems.push(`${role}: exactly 3 signers expected (2-of-3), got ${s.length}`)
    s.forEach((a, i) => {
      if (a === null) return
      if (a === ZeroAddress) problems.push(`${role}: zero signer`)
      if (d && a === d) problems.push(`${role}: the deployer must not be a signer (${a})`)
      if (s.indexOf(a) !== i) problems.push(`${role}: duplicate signer ${a}`)
    })
  }
  for (const a of new Set(o.filter((x) => x && g.includes(x)))) problems.push(`owner and guardian Safes must not share any signer (six distinct signers required): ${a}`)
  return problems
}

/** Live checks: every signer and the deployer has no code (plain EOA, not delegated). Returns problems. */
export async function signerCodeProblems(provider, { owners, guardians, deployer }) {
  const problems = []
  for (const [role, a] of [...owners.map((x) => ['owner', x]), ...guardians.map((x) => ['guardian', x]), ['deployer', deployer]]) {
    const code = await provider.getCode(a)
    if (code !== '0x') problems.push(`${role} ${a} has code (${code.length > 2 && code.startsWith('0xef0100') ? 'EIP-7702 delegation' : 'contract'}): must be a plain EOA`)
  }
  return problems
}
