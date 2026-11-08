// Phase A: build a standalone genesis from a fresh, private, local fork of Robinhood Chain mainnet.
//
// Anvil's dumpState only contains storage that was *written* on the fork, and a fork-mode dump cannot be
// reloaded without the upstream node (which keeps state for only ~10-35 minutes). So the demo chain is a
// standalone chain whose genesis contains:
//   - the real WIF contract code and every storage slot its functions read (found via eth_createAccessList),
//   - the canonical Safe v1.5.0 contracts,
//   - a demo faucet funded with WIF moved, on the fork only, from large holders via impersonation.
// Nothing is ever broadcast to the real network; the upstream is used for reads by anvil's fork backend.
import { Contract, Interface, JsonRpcProvider, parseEther, parseUnits, gunzipSync } from './deps.mjs'
import { ADDR } from './config.mjs'
import { startAnvil, stopAnvil } from './anvil.mjs'

const ERC20 = new Interface([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)', 'function transferFrom(address,address,uint256) returns (bool)',
  'function burn(uint256)',
])

const hex = (n) => '0x' + BigInt(n).toString(16)

function decodeDump(raw) {
  const bytes = Buffer.from(String(raw).slice(2), 'hex')
  let text
  try { text = gunzipSync(bytes).toString('utf8') } catch { text = bytes.toString('utf8') }
  return JSON.parse(text)
}

export async function buildGenesis({ upstreamRpc, upstreamChainId, chainId, anvilPort, faucetAddress, reserveWif, log }) {
  const upstream = new JsonRpcProvider(upstreamRpc, upstreamChainId, { staticNetwork: true })
  const forkBlock = await upstream.getBlockNumber()
  log(`genesis: forking Robinhood Chain mainnet at block ${forkBlock} (local, private)`)
  const { child, provider } = await startAnvil(
    ['--fork-url', upstreamRpc, '--fork-block-number', String(forkBlock), '--chain-id', String(chainId), '--silent'],
    { port: anvilPort, chainId, log },
  )
  try {
    const wif = new Contract(ADDR.WIF, ERC20, provider)
    const symbol = await wif.symbol()
    if (symbol !== 'WIF') throw new Error(`unexpected WIF symbol ${symbol}`)

    // 1. Move the demo reserve to the faucet (fork only).
    let remaining = parseUnits(reserveWif, 18)
    for (const holder of ADDR.WIF_SOURCES) {
      if (remaining === 0n) break
      const bal = await wif.balanceOf(holder)
      const take = bal * 9n / 10n < remaining ? bal * 9n / 10n : remaining
      if (take === 0n) continue
      await provider.send('anvil_setBalance', [holder, hex(parseEther('1'))])
      await provider.send('anvil_impersonateAccount', [holder])
      const signer = await provider.getSigner(holder)
      await (await wif.connect(signer).transfer(faucetAddress, take)).wait()
      await provider.send('anvil_stopImpersonatingAccount', [holder])
      remaining -= take
    }
    const faucetBal = await wif.balanceOf(faucetAddress)
    if (faucetBal === 0n) throw new Error('could not fund the demo faucet with fork WIF')
    log(`genesis: faucet holds ${faucetBal / 10n ** 18n} fork-WIF`)

    // 2. Discover every WIF storage slot touched by its ERC-20 surface.
    const holder = faucetAddress
    const other = '0x00000000000000000000000000000000000ab1e1'
    await provider.send('anvil_setBalance', [holder, hex(parseEther('1'))])
    await provider.send('anvil_impersonateAccount', [holder])
    const hs = await provider.getSigner(holder)
    await (await wif.connect(hs).approve(other, 10n ** 18n)).wait()
    const calls = [
      { from: holder, data: ERC20.encodeFunctionData('name') },
      { from: holder, data: ERC20.encodeFunctionData('symbol') },
      { from: holder, data: ERC20.encodeFunctionData('decimals') },
      { from: holder, data: ERC20.encodeFunctionData('totalSupply') },
      { from: holder, data: ERC20.encodeFunctionData('balanceOf', [holder]) },
      { from: holder, data: ERC20.encodeFunctionData('allowance', [holder, other]) },
      { from: holder, data: ERC20.encodeFunctionData('transfer', [other, 1n]) },
      { from: holder, data: ERC20.encodeFunctionData('approve', [other, 1n]) },
      { from: holder, data: ERC20.encodeFunctionData('burn', [1n]) },
      { from: other, data: ERC20.encodeFunctionData('transferFrom', [holder, other, 1n]) },
    ]
    const slots = new Map() // address -> Set(slot)
    for (const c of calls) {
      try {
        const res = await provider.send('eth_createAccessList', [{ ...c, to: ADDR.WIF }, 'latest'])
        for (const item of res.accessList ?? []) {
          const set = slots.get(item.address.toLowerCase()) ?? new Set()
          for (const k of item.storageKeys) set.add(k)
          slots.set(item.address.toLowerCase(), set)
        }
      } catch (e) {
        log(`genesis: access list skipped for one call (${String(e.shortMessage || e.message).slice(0, 80)})`)
      }
    }
    // Reset the probe approval so the genesis starts clean.
    await (await wif.connect(hs).approve(other, 0n)).wait()
    await provider.send('anvil_stopImpersonatingAccount', [holder])

    // 3. Dump written state, then merge in external contracts' code and the slots they read.
    const dump = decodeDump(await provider.send('anvil_dumpState', []))
    const accounts = {}
    for (const [k, v] of Object.entries(dump.accounts)) accounts[k.toLowerCase()] = v
    const external = [ADDR.WIF, ADDR.SAFE_L2_SINGLETON, ADDR.SAFE_FACTORY, ADDR.SAFE_FALLBACK, ...slots.keys()]
    for (const addr of new Set(external.map((a) => a.toLowerCase()))) {
      const code = await provider.getCode(addr)
      if (code === '0x') continue
      const acc = accounts[addr] ?? { nonce: 1, balance: '0x0', code, storage: {} }
      acc.code = code
      acc.storage = acc.storage ?? {}
      for (const slot of slots.get(addr) ?? []) {
        if (acc.storage[slot] === undefined) acc.storage[slot] = await provider.getStorage(addr, slot)
      }
      accounts[addr] = acc
    }
    const timestamp = (await provider.getBlock('latest')).timestamp
    const genesis = {
      block: { ...dump.block, number: '0x0', timestamp: hex(timestamp) },
      accounts,
      best_block_number: null,
      blocks: [],
      transactions: [],
      historical_states: null,
    }
    log(`genesis: ${Object.keys(accounts).length} accounts, ${slots.get(ADDR.WIF.toLowerCase())?.size ?? 0} WIF slots copied`)
    return { genesis, forkBlock, forkTimestamp: timestamp }
  } finally {
    await stopAnvil(child)
  }
}
