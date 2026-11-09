// Local rehearsal chain for the Deploy Console: a fresh anvil chain with chain id 31337 (never 46630, so nothing signed
// for it can be replayed on Robinhood Chain testnet), loaded with the Safe v1.5.0 contracts copied from testnet
// (scripts/deploy-console/safe-v150-snapshot.json). Binds to 127.0.0.1 only.
//
//   impersonate: true  -> anvil --auto-impersonate (exporter and automated tests sign as any address; LOCAL ONLY)
//   impersonate: false -> only real signed transactions are accepted (the Zerion rehearsal)
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcProvider, keccak256 } from 'ethers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const REHEARSAL_CHAIN_ID = 31337
/** Robinhood Chain testnet's observed gas price (0.01 gwei). */
export const TESTNET_LIKE_GAS_PRICE = 10_000_000
export const SAFE_SNAPSHOT = join(ROOT, 'scripts/deploy-console/safe-v150-snapshot.json')

const arch = process.arch === 'x64' ? 'amd64' : process.arch
export const ANVIL_BIN = join(ROOT, 'node_modules/@foundry-rs', `anvil-${process.platform}-${arch}`, 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil')

export const freePort = () => new Promise((ok, no) => {
  const s = createServer(); s.once('error', no)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) })
})

/** Robinhood Chain mainnet public RPC: the fork source of a MAINNET rehearsal (read-only; nothing is ever sent to it). */
export const MAINNET_FORK_SOURCE = process.env.RH_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
/** Official $WIF (OpenZeppelin ERC20: `_balances` is the mapping at storage slot 0). */
export const OFFICIAL_WIF = '0x5173b8eA6923c2d40267890D45C46a3480954773'

/**
 * Starts the rehearsal chain. Testnet profile: a fresh chain loaded with the Safe snapshot. Mainnet profile
 * (`fork: 'mainnet'`): a local FORK of Robinhood Chain mainnet, still with chain id 31337, so the real Safe factory,
 * $WIF, HOOKR and TORCH contracts are present and nothing signed for it is valid on mainnet. Returns { rpc, port, provider, stop }.
 */
export async function startRehearsalChain({ port, impersonate = false, blockTime, fork } = {}) {
  const p = port ?? await freePort()
  // Testnet profile: gas priced like Robinhood Chain testnet (0.01 gwei). Mainnet fork: the forked block's own base fee.
  const args = fork === 'mainnet'
    ? ['--fork-url', MAINNET_FORK_SOURCE, '--host', '127.0.0.1', '--port', String(p), '--chain-id', String(REHEARSAL_CHAIN_ID), '--accounts', '0', '--no-priority-fee']
    : ['--host', '127.0.0.1', '--port', String(p), '--chain-id', String(REHEARSAL_CHAIN_ID), '--accounts', '0', '--base-fee', String(TESTNET_LIKE_GAS_PRICE), '--gas-price', String(TESTNET_LIKE_GAS_PRICE), '--no-priority-fee']
  if (fork && fork !== 'mainnet') throw new Error(`unknown fork ${fork}`)
  if (impersonate) args.push('--auto-impersonate')
  if (blockTime) args.push('--block-time', String(blockTime))
  const anvil = spawn(ANVIL_BIN, args, { stdio: 'ignore', windowsHide: true })
  const rpc = `http://127.0.0.1:${p}`
  const provider = new JsonRpcProvider(rpc, REHEARSAL_CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 })
  let up = false
  for (let i = 0; i < (fork ? 600 : 100) && !up; i++) { try { await provider.getBlockNumber(); up = true } catch { await new Promise((r) => setTimeout(r, 100)) } }
  if (!up) { anvil.kill(); throw new Error('rehearsal chain did not start') }
  if (Number(await provider.send('eth_chainId', [])) !== REHEARSAL_CHAIN_ID) { anvil.kill(); throw new Error('rehearsal chain has the wrong chain id') }
  const stop = () => new Promise((r) => { if (anvil.exitCode !== null) return r(); anvil.once('exit', () => r()); anvil.kill('SIGTERM') })
  if (fork === 'mainnet') {
    if ((await provider.getCode(OFFICIAL_WIF)) === '0x') { anvil.kill(); throw new Error('the mainnet fork has no official WIF') }
    return { rpc, port: p, provider, anvil, stop, fork }
  }
  const snap = JSON.parse(readFileSync(SAFE_SNAPSHOT, 'utf8'))
  for (const acct of Object.values(snap.accounts)) {
    if (keccak256(acct.code) !== acct.codeHash) { anvil.kill(); throw new Error(`snapshot code hash mismatch for ${acct.address}`) }
    await provider.send('anvil_setCode', [acct.address, acct.code])
    for (const [slot, value] of Object.entries(acct.storage)) await provider.send('anvil_setStorageAt', [acct.address, slot, value])
  }
  return { rpc, port: p, provider, anvil, stop }
}

/** LOCAL CHAIN ONLY: gives an address testnet-like ETH for gas on the rehearsal chain. */
export async function fundLocal(provider, address, wei) {
  if (Number(await provider.send('eth_chainId', [])) !== REHEARSAL_CHAIN_ID) throw new Error('fundLocal is for the local rehearsal chain only')
  await provider.send('anvil_setBalance', [address, '0x' + BigInt(wei).toString(16)])
}

/** LOCAL MAINNET FORK ONLY: gives an address `wei` of the official $WIF by writing its OpenZeppelin `_balances` slot
 *  (mapping at slot 0) on the fork, then reads balanceOf back to prove the slot. Never touches a real network. */
export async function fundLocalWif(provider, address, wei) {
  if (Number(await provider.send('eth_chainId', [])) !== REHEARSAL_CHAIN_ID) throw new Error('fundLocalWif is for the local rehearsal chain only')
  const { AbiCoder, Interface, keccak256: k } = await import('ethers')
  const slot = k(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [address, 0]))
  await provider.send('anvil_setStorageAt', [OFFICIAL_WIF, slot, '0x' + BigInt(wei).toString(16).padStart(64, '0')])
  const iface = new Interface(['function balanceOf(address) view returns (uint256)'])
  const got = BigInt(await provider.call({ to: OFFICIAL_WIF, data: iface.encodeFunctionData('balanceOf', [address]) }))
  if (got !== BigInt(wei)) throw new Error('WIF balance slot did not take effect on the fork')
}
