#!/usr/bin/env node
// READ-ONLY. Copies the Safe v1.5.0 contracts that CreateTestnetSafes uses (SafeL2 singleton, proxy factory,
// compatibility fallback handler) from Robinhood Chain testnet into scripts/deploy-console/safe-v150-snapshot.json.
// The local rehearsal chain (chain 31337, scripts/lib/rehearsal-chain.mjs) loads this snapshot so the Deploy Console
// can be tested and rehearsed offline against the exact same Safe bytecode, with signatures that are valid only on
// chain 31337 and can never be replayed on testnet.
//
//   node scripts/fetch-safe-snapshot.mjs [--check]     (--check: compare the committed snapshot, write nothing)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcProvider, keccak256, toBeHex } from 'ethers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'scripts/deploy-console/safe-v150-snapshot.json')
const RPC = process.env.RH_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com'
const CONTRACTS = {
  singletonL2: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
  proxyFactory: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
  fallbackHandler: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
}
// Safe v1.5.0 singleton storage: slot 4 is `threshold`, set to 1 by the singleton's constructor so the singleton
// itself can never be set up. Every other slot of these three contracts is zero.
const SLOTS = [0, 1, 2, 3, 4, 5]

const p = new JsonRpcProvider(RPC, 46630, { staticNetwork: true })
const chainId = Number(await p.send('eth_chainId', []))
if (chainId !== 46630) { console.error(`refusing: ${RPC} is chain ${chainId}, not Robinhood Chain testnet (46630)`); process.exit(1) }
const block = await p.getBlockNumber()
const snapshot = { _note: 'Safe v1.5.0 contracts copied read-only from Robinhood Chain testnet for the local rehearsal chain (31337).', sourceChainId: 46630, sourceBlock: block, accounts: {} }
for (const [name, address] of Object.entries(CONTRACTS)) {
  const code = await p.getCode(address, block)
  if (code === '0x') { console.error(`${name} ${address} has no code on testnet`); process.exit(1) }
  const storage = {}
  for (const s of SLOTS) {
    const v = await p.getStorage(address, s, block)
    if (BigInt(v) !== 0n) storage[toBeHex(s, 32)] = v
  }
  snapshot.accounts[name] = { address, codeHash: keccak256(code), code, storage }
}

if (process.argv.includes('--check')) {
  const committed = JSON.parse(readFileSync(OUT, 'utf8'))
  const diff = Object.keys(CONTRACTS).filter((k) => committed.accounts[k]?.codeHash !== snapshot.accounts[k].codeHash || JSON.stringify(committed.accounts[k]?.storage) !== JSON.stringify(snapshot.accounts[k].storage))
  console.log(diff.length ? `MISMATCH with testnet: ${diff.join(', ')}` : `committed snapshot matches testnet at block ${block}`)
  process.exit(diff.length ? 1 : 0)
}
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n')
for (const [k, v] of Object.entries(snapshot.accounts)) console.log(`${k} ${v.address} codeHash ${v.codeHash} storage ${JSON.stringify(v.storage)}`)
console.log(`wrote ${OUT} (testnet block ${block})`)
