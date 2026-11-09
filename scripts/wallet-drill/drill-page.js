// Drill page served by scripts/wallet-drill.mjs. Uses only the wallet's EIP-1193 provider. It requests accounts, reads
// the chain, may ask the wallet to switch to or add the local drill network, and requests ONE eth_signTypedData_v4
// signature over the canonical drill. It never requests a transaction. The signature is sent only to this station's
// `check` endpoint and is never displayed or stored. In page-entry mode (--expect page) the person first sets the
// expected address once (Step 0); the station keeps it in memory and shows it only shortened.
'use strict'
const $ = (id) => document.getElementById(id)
const steps = []
const announced = []
let provider = null
let wallet = { name: '', rdns: '' }
let account = null
let typed = null
let pinned = null
let listening = false
let stage1Pass = false // Stage 2 is enabled only while this is true; any network/account change clears it

window.addEventListener('eip6963:announceProvider', (e) => { if (e.detail && e.detail.provider) announced.push(e.detail) })
window.dispatchEvent(new Event('eip6963:requestProvider'))

const errText = (e) => `${e && e.code !== undefined ? `[${e.code}] ` : ''}${String((e && e.message) || e).slice(0, 160)}`
const log = (msg, cls) => { steps.push(msg); const li = document.createElement('li'); li.textContent = msg; if (cls) li.className = cls; $('log').append(li) }
const setResult = (msg, ok) => { $('result').textContent = msg; $('result').className = `result ${ok ? 'ok' : 'bad'}` }
const post = async (path, body) => { const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json() }
const chainOf = async () => String(await provider.request({ method: 'eth_chainId' })).toLowerCase()
const rpcUrl = () => new URL('rpc', location.href).href

function render() {
  const d = typed.domain, m = typed.message
  const rows = [
    ['Network / chain ID', `31337 (${pinned.chainIdHex})`], ['Verifying contract', d.verifyingContract], ['Primary type', typed.primaryType],
    ['to', m.to], ['value', m.value], ['data', m.data], ['operation', `${m.operation} (CALL)`], ['safeTxGas', m.safeTxGas], ['baseGas', m.baseGas],
    ['gasPrice', m.gasPrice], ['gasToken', m.gasToken], ['refundReceiver', m.refundReceiver], ['nonce', m.nonce],
  ]
  for (const [k, v] of rows) {
    const tr = document.createElement('tr'); const a = document.createElement('td'); const b = document.createElement('td'); const c = document.createElement('code')
    a.textContent = k; c.textContent = String(v); b.append(c); tr.append(a, b); $('fields').append(tr)
  }
  $('hashes').textContent = 'If the wallet shows hashes instead of fields, they must be:'
  for (const [k, v] of [['Domain hash', pinned.domainHash], ['Message hash', pinned.messageHash]]) { const c = document.createElement('code'); c.textContent = `${k} ${v}`; $('hashes').append(c) }
}

async function pickProvider() {
  await new Promise((r) => setTimeout(r, 400)) // let EIP-6963 announcements arrive
  const z = announced.find((d) => /zerion/i.test(`${d.info && d.info.rdns} ${d.info && d.info.name}`))
  const d = z || announced[0]
  if (d) return { p: d.provider, name: (d.info && d.info.name) || 'EIP-6963 wallet', rdns: (d.info && d.info.rdns) || '' }
  const w = window.ethereum
  if (w) return { p: w, name: w.isZerion ? 'Zerion (window.ethereum)' : w.isMetaMask ? 'MetaMask-compatible (window.ethereum)' : 'window.ethereum', rdns: '' }
  return null
}

function resetStage2(reason) {
  stage1Pass = false
  $('stage2').disabled = true
  if (reason) setResult(reason, false)
}

async function stage1() {
  steps.length = 0; $('log').textContent = ''; $('result').textContent = ''; resetStage2()
  let chain = ''
  try {
    const found = await pickProvider()
    if (!found) { log('No wallet found. Open this page inside the wallet app\'s Browser tab.', 'bad'); return }
    provider = found.p; wallet = { name: found.name, rdns: found.rdns }
    if (!listening && typeof provider.on === 'function') {
      listening = true
      provider.on('chainChanged', () => resetStage2('The wallet network changed. Run Stage 1 again.'))
      provider.on('accountsChanged', () => resetStage2('The wallet account changed. Run Stage 1 again.'))
    }
    log(`Wallet: ${found.name}${found.rdns ? ` (${found.rdns})` : ''}`)
    try { [account] = await provider.request({ method: 'eth_requestAccounts' }) } catch (e) { log(`Connection refused: ${errText(e)}`, 'bad'); return }
    log(account ? 'Connected: account received' : 'Connected, but no account was returned', account ? 'ok' : 'bad')
    chain = await chainOf()
    log(`Wallet network chain ID: ${chain}`)
    if (chain !== pinned.chainIdHex) {
      log('Not on chain 31337: asking the wallet to switch...')
      try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: pinned.chainIdHex }] }); log('Switch request accepted') } catch (e) {
        log(`Switch failed: ${errText(e)}`)
        log('Asking the wallet to add the drill network...')
        try {
          await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: pinned.chainIdHex, chainName: 'Rixor Drill (local)', rpcUrls: [rpcUrl()], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }] })
          log('Add-network request accepted')
        } catch (e2) { log(`Add network failed: ${errText(e2)}. Add it manually in the wallet (see the guide), select it, then run Stage 1 again.`, 'bad') }
      }
      chain = await chainOf()
      log(`Wallet network chain ID now: ${chain}`, chain === pinned.chainIdHex ? 'ok' : 'bad')
    } else log('On chain 31337', 'ok')
    if (chain === pinned.chainIdHex) {
      try { const bn = await provider.request({ method: 'eth_blockNumber' }); log(`Wallet read block ${parseInt(bn, 16)} from the drill network`, 'ok') } catch (e) { log(`Wallet could not read the drill network: ${errText(e)}`, 'bad') }
    }
  } catch (e) {
    log(`Stage 1 error: ${errText(e)}`, 'bad')
  } finally {
    let verdict = { accountMatchesExpected: false, onDrillChain: false }
    try { verdict = await post('stage1', { wallet: wallet.name, rdns: wallet.rdns, chainId: chain, account, steps }) } catch (e) { log(`Could not reach the station: ${errText(e)}`, 'bad') }
    if (verdict.error) log(`Station: ${verdict.error}`, 'bad')
    else if (account) log(verdict.accountMatchesExpected ? 'Account matches the expected address' : 'Account does NOT match the expected address. Select the right account, then run Stage 1 again.', verdict.accountMatchesExpected ? 'ok' : 'bad')
    stage1Pass = Boolean(account && verdict.onDrillChain && verdict.accountMatchesExpected)
    log(stage1Pass ? 'Stage 1 PASS: Stage 2 is enabled' : 'Stage 1 not passed: Stage 2 stays disabled', stage1Pass ? 'ok' : 'bad')
    $('stage2').disabled = !stage1Pass
  }
}

async function stage2() {
  $('stage2').disabled = true
  try {
    if ((await chainOf()) !== pinned.chainIdHex) return resetStage2('The wallet left chain 31337. Run Stage 1 again.')
    setResult('Waiting for the wallet...', true)
    let signature
    try { signature = await provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] }) } catch (e) { return setResult(`Signing rejected or failed: ${errText(e)}`, false) }
    const verdict = await post('check', { signature, account })
    signature = undefined
    if (verdict.error) setResult(`Station: ${verdict.error}`, false)
    else setResult(`${verdict.result}: ${verdict.reason}. matchesExpected ${verdict.matchesExpected}`, verdict.result === 'PASS')
  } catch (e) {
    setResult(`Stage 2 error: ${errText(e)}`, false)
  } finally {
    $('stage2').disabled = !stage1Pass
  }
}

function showExpected(masked) {
  $('expect').hidden = true; $('setExpect').hidden = true
  $('log0').textContent = ''
  const li = document.createElement('li'); li.className = 'ok'; li.textContent = `Expected address set: ${masked} (locked for this session)`; $('log0').append(li)
  $('stage1').disabled = false
}

async function setExpect() {
  $('setExpect').disabled = true
  $('log0').textContent = ''
  try {
    const r = await post('expect', { address: $('expect').value })
    if (r.expected && !r.error) return showExpected(r.expected)
    const li = document.createElement('li'); li.className = 'bad'; li.textContent = r.error || 'not accepted'; $('log0').append(li)
    if (r.expected) showExpected(r.expected) // already locked earlier in this session
  } catch (e) {
    const li = document.createElement('li'); li.className = 'bad'; li.textContent = `Could not reach the station: ${errText(e)}`; $('log0').append(li)
  } finally {
    $('setExpect').disabled = false
  }
}

;(async () => {
  let status
  try {
    ;[typed, pinned, status] = await Promise.all(['drill.json', 'pinned.json', 'status'].map((f) => fetch(f).then((r) => r.json())))
    render()
  } catch (e) { setResult(`Could not load the drill from the station: ${errText(e)}`, false); return }
  if (status.pageEntry) {
    $('stage0').hidden = false
    if (status.expectSet) showExpected(status.expected)
    else $('stage1').disabled = true
  }
  $('setExpect').addEventListener('click', setExpect)
  $('stage1').addEventListener('click', stage1)
  $('stage2').addEventListener('click', stage2)
})()
