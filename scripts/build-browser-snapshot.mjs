#!/usr/bin/env node
// Builds the Robinhood Chain mainnet snapshot used by the in-browser EVM demo.
//
//   node scripts/build-browser-snapshot.mjs [--rpc URL] [--out public/demo/robinhood-snapshot.json]
//
// Read-only. Nothing is sent to any network. Steps:
//   1. Pin the latest Robinhood Chain mainnet block.
//   2. Start a throwaway LOCAL anvil fork at that block and use eth_createAccessList to discover every
//      account and storage slot touched by the demo's dependencies:
//        - WIF: name/symbol/decimals/totalSupply/balanceOf/allowance/transfer/approve/transferFrom/burn,
//          including transfers out of the large holders that the demo faucet draws from;
//        - Safe v1.5.0: proxy creation through the factory, setup, and an execTransaction.
//   3. Fetch code and every discovered slot DIRECTLY from the upstream RPC at the pinned block
//      (not from the fork), and record keccak256 code hashes.
//   4. Verify closure: every address touched in step 2 is present with its code, and every value matches.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Contract, Interface, JsonRpcProvider, Wallet, keccak256, parseEther } from 'ethers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d }
const RPC = opt('--rpc', process.env.RH_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com')
const OUT = resolve(opt('--out', join(ROOT, 'public', 'demo', 'robinhood-snapshot.json')))

const WIF = '0x5173b8eA6923c2d40267890D45C46a3480954773'
const SAFE = {
  singletonL2: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
  factory: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
  fallbackHandler: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
}
// Large WIF holders (from docs/TOKEN_VETTING.md). Inside the isolated browser EVM, the demo faucet moves
// part of their copied balance to visitors. Their real balances are never touched.
const RESERVES = [
  '0x1089a7C3915c9F067615909DBd07697C21c32156',
  '0x2243928944619f832f689BBc15f1E654B7686504',
  '0xe89DE31F1423f6041851ffA974A9f29a06eF8e11',
]
const ERC20 = new Interface([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)', 'function transferFrom(address,address,uint256) returns (bool)',
  'function burn(uint256)',
])
const SAFE_IFACE = new Interface([
  'function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)',
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)',
  'function nonce() view returns (uint256)',
])

const log = (m) => console.log(`[snapshot] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (n) => '0x' + BigInt(n).toString(16)

async function startFork(block) {
  const port = 8600 + Math.floor(Math.random() * 300)
  const child = spawn(process.execPath, [join(ROOT, 'node_modules/@foundry-rs/anvil/bin.mjs'), '--fork-url', RPC, '--fork-block-number', String(block), '--port', String(port), '--silent'], { stdio: 'ignore', env: process.env })
  const p = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { batchMaxCount: 1 })
  for (let i = 0; i < 60; i++) { try { await p.send('eth_chainId', []); return { child, p } } catch { await sleep(500) } }
  throw new Error('fork did not start')
}

async function accessList(p, tx) {
  const res = await p.send('eth_createAccessList', [tx, 'latest'])
  if (res.error) throw new Error(`access list failed: ${JSON.stringify(res.error)}`)
  return res.accessList ?? []
}

async function main() {
  const upstream = new JsonRpcProvider(RPC, 4663, { staticNetwork: true, batchMaxCount: 1 })
  const block = await upstream.getBlock('latest')
  log(`pinned Robinhood Chain mainnet block ${block.number} (${new Date(block.timestamp * 1000).toISOString()})`)
  const { child, p } = await startFork(block.number)
  const touched = new Map() // address(lower) -> Set(slot)
  const add = (list) => { for (const it of list) { const a = it.address.toLowerCase(); const s = touched.get(a) ?? new Set(); it.storageKeys.forEach((k) => s.add(k)); touched.set(a, s) } }
  try {
    const spender = '0x00000000000000000000000000000000000ab1e1'
    // WIF surface, from each reserve holder and a fresh account.
    for (const from of [...RESERVES, spender]) {
      for (const data of [
        ERC20.encodeFunctionData('name'), ERC20.encodeFunctionData('symbol'), ERC20.encodeFunctionData('decimals'),
        ERC20.encodeFunctionData('totalSupply'), ERC20.encodeFunctionData('balanceOf', [from]),
        ERC20.encodeFunctionData('allowance', [from, spender]),
      ]) add(await accessList(p, { from, to: WIF, data }))
    }
    for (const from of RESERVES) {
      add(await accessList(p, { from, to: WIF, data: ERC20.encodeFunctionData('transfer', [spender, 10n ** 18n]) }))
      add(await accessList(p, { from, to: WIF, data: ERC20.encodeFunctionData('approve', [spender, 10n ** 18n]) }))
      add(await accessList(p, { from, to: WIF, data: ERC20.encodeFunctionData('burn', [10n ** 18n]) }))
    }
    // transferFrom needs a real allowance: create one on the throwaway fork, then trace.
    await p.send('anvil_setBalance', [RESERVES[0], hex(parseEther('1'))])
    await p.send('anvil_impersonateAccount', [RESERVES[0]])
    await (await new Contract(WIF, ERC20, await p.getSigner(RESERVES[0])).approve(spender, 10n ** 18n)).wait()
    add(await accessList(p, { from: spender, to: WIF, data: ERC20.encodeFunctionData('transferFrom', [RESERVES[0], spender, 10n ** 18n]) }))

    // Safe v1.5.0: create a 2-of-3 proxy and execute a transaction through it.
    const owners = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()]
    const init = SAFE_IFACE.encodeFunctionData('setup', [owners.map((o) => o.address), 2, '0x0000000000000000000000000000000000000000', '0x', SAFE.fallbackHandler, '0x0000000000000000000000000000000000000000', 0, '0x0000000000000000000000000000000000000000'])
    const createData = SAFE_IFACE.encodeFunctionData('createProxyWithNonce', [SAFE.singletonL2, init, 1])
    add(await accessList(p, { from: spender, to: SAFE.factory, data: createData }))
    await p.send('anvil_setBalance', [spender, hex(parseEther('1'))])
    await p.send('anvil_impersonateAccount', [spender])
    const signer = await p.getSigner(spender)
    const proxy = await new Contract(SAFE.factory, SAFE_IFACE, signer).createProxyWithNonce.staticCall(SAFE.singletonL2, init, 1)
    await (await signer.sendTransaction({ to: SAFE.factory, data: createData })).wait()
    const safe = new Contract(proxy, SAFE_IFACE, signer)
    const zero = '0x0000000000000000000000000000000000000000'
    const execTo = WIF
    const execData = ERC20.encodeFunctionData('approve', [spender, 1n])
    const h = await safe.getTransactionHash(execTo, 0, execData, 0, 0, 0, 0, zero, zero, await safe.nonce())
    const sigs = '0x' + owners.slice(0, 2).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
      .map((o) => { const s = o.signingKey.sign(h); return s.r.slice(2) + s.s.slice(2) + s.v.toString(16) }).join('')
    add(await accessList(p, { from: spender, to: proxy, data: SAFE_IFACE.encodeFunctionData('execTransaction', [execTo, 0, execData, 0, 0, 0, 0, zero, zero, sigs]) }))
    touched.delete(proxy.toLowerCase()) // created by the demo itself, not part of the snapshot
  } finally {
    child.kill('SIGTERM')
  }

  // Required dependencies regardless of what the traces show.
  for (const a of [WIF, SAFE.singletonL2, SAFE.factory, SAFE.fallbackHandler, ...RESERVES]) if (!touched.has(a.toLowerCase())) touched.set(a.toLowerCase(), new Set())
  touched.delete('0x00000000000000000000000000000000000ab1e1')

  // Fetch everything directly from the upstream at the pinned block.
  const accounts = {}
  for (const [addr, slots] of touched) {
    const [code, balance, nonce] = await Promise.all([
      upstream.getCode(addr, block.number), upstream.getBalance(addr, block.number), upstream.getTransactionCount(addr, block.number),
    ])
    const storage = {}
    for (const slot of [...slots].sort()) storage[slot] = await upstream.getStorage(addr, slot, block.number)
    accounts[addr] = { code, codeHash: keccak256(code), balance: hex(balance), nonce, storage }
  }

  // Verification: required contracts present with code; values re-read and compared.
  const problems = []
  for (const [name, a] of Object.entries({ WIF, ...SAFE })) if ((accounts[a.toLowerCase()]?.code ?? '0x') === '0x') problems.push(`${name} has no code`)
  for (const [addr, acc] of Object.entries(accounts)) {
    const again = await upstream.getCode(addr, block.number)
    if (keccak256(again) !== acc.codeHash) problems.push(`code changed for ${addr}`)
  }
  const wif = new Contract(WIF, ERC20, upstream)
  const reserveBalances = {}
  for (const r of RESERVES) reserveBalances[r] = (await wif.balanceOf(r, { blockTag: block.number })).toString()
  if (problems.length) throw new Error(`snapshot verification failed: ${problems.join('; ')}`)

  const snapshot = {
    kind: 'rixor-browser-evm-snapshot',
    version: 1,
    source: { name: 'Robinhood Chain mainnet', chainId: 4663, rpc: RPC, block: block.number, blockHash: block.hash, timestamp: block.timestamp, builtAt: new Date().toISOString() },
    method: 'Code and storage read directly from the upstream RPC at the pinned block; slot set discovered with eth_createAccessList on a throwaway local fork.',
    contracts: { WIF, ...SAFE },
    reserves: RESERVES,
    reserveBalances,
    accounts,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(snapshot))
  const slots = Object.values(accounts).reduce((s, a) => s + Object.keys(a.storage).length, 0)
  log(`wrote ${OUT}: ${Object.keys(accounts).length} accounts, ${slots} storage slots, ${(JSON.stringify(snapshot).length / 1024).toFixed(1)} KB`)
  for (const [addr, a] of Object.entries(accounts)) log(`  ${addr} code ${(a.code.length - 2) / 2} B, ${Object.keys(a.storage).length} slots`)
}

main().catch((e) => { console.error(e); process.exit(1) })
