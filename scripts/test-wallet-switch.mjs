#!/usr/bin/env node
// Tests src/protocol/wallet.ts switchToChain against stub EIP-1193 wallets that mimic how different (mobile) wallets
// report an unknown chain. No network, no wallet app, no keys.   npm run test:wallet-switch
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'rixor-wallet-switch-'))
const out = join(dir, 'wallet.mjs')
await build({ entryPoints: [join(ROOT, 'src/protocol/wallet.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const { switchToChain } = await import(pathToFileURL(out).href)
rmSync(dir, { recursive: true, force: true })

const CHAIN = { chainId: 46630, name: 'Robinhood Chain Testnet', rpc: 'https://rpc.testnet.chain.robinhood.com' }
const err = (code, extra = {}) => Object.assign(new Error(`err ${code}`), { code, ...extra })
// A stub wallet: `known` = chain already added; `unknownError` = what switch throws for an unknown chain;
// `addSwitches` = whether wallet_addEthereumChain also switches.
function wallet({ start = 1, known = false, unknownError = err(4902), addSwitches = true, rejectSwitch = false, rejectAdd = false }) {
  const s = { chain: start, known, calls: [] }
  return { s, w: { name: 'stub', provider: { request: async ({ method, params }) => {
    s.calls.push(method)
    if (method === 'eth_chainId') return '0x' + s.chain.toString(16)
    if (method === 'wallet_switchEthereumChain') {
      if (rejectSwitch) throw err(4001)
      if (!s.known) throw unknownError
      s.chain = Number(params[0].chainId); return null
    }
    if (method === 'wallet_addEthereumChain') {
      if (rejectAdd) throw err(4001)
      const p = params[0]
      if (p.chainId !== '0xb626' || p.rpcUrls[0] !== CHAIN.rpc || p.nativeCurrency.symbol !== 'ETH') throw new Error('bad add params')
      s.known = true; if (addSwitches) s.chain = Number(p.chainId); return null
    }
    throw err(4200)
  } } } }
}
let failed = 0
const t = async (name, opts, expectOk, check = () => true) => {
  const { s, w } = wallet(opts)
  let ok
  try { await switchToChain(w, CHAIN); ok = expectOk && s.chain === 46630 && check(s) } catch (e) { ok = !expectOk && check(s, e) }
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — calls: ${s.calls.join(', ')}`)
}
await t('chain already known: switches directly, no add', { known: true }, true, (s) => !s.calls.includes('wallet_addEthereumChain'))
await t('unknown chain, error 4902 (MetaMask desktop): adds then on chain', {}, true)
await t('unknown chain, -32603 (older mobile wallets): adds', { unknownError: err(-32603) }, true)
await t('unknown chain, nested data.originalError.code 4902 (MetaMask Mobile): adds', { unknownError: err(-32603, { data: { originalError: { code: 4902 } } }) }, true)
await t('unknown chain, plain error without code: adds', { unknownError: new Error('Unrecognized chain ID') }, true)
await t('unknown chain, other code (e.g. 4200): adds', { unknownError: err(4200) }, true)
await t('wallet adds the chain without switching: switches again', { addSwitches: false }, true, (s) => s.calls.filter((c) => c === 'wallet_switchEthereumChain').length === 2)
await t('user rejects the switch (4001): error, no add', { rejectSwitch: true }, false, (s, e) => e?.code === 4001 && !s.calls.includes('wallet_addEthereumChain'))
await t('user rejects adding the chain (4001): error', { rejectAdd: true }, false, (s, e) => e?.code === 4001)
await t('nested 4001 rejection is not retried as an add', { unknownError: err(-32603, { data: { originalError: { code: 4001 } } }) }, false, (s) => !s.calls.includes('wallet_addEthereumChain'))
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${failed} failing case(s) (stub wallets only; no network)`)
process.exit(failed ? 1 : 0)
