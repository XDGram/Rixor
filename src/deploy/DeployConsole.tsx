// Rixor Deploy Console: review and sign the 11 planned testnet deployment transactions from a phone wallet
// (Zerion Browser), one explicit tap per wallet request. All checks live in ./core.ts; this file is only UI.
//
// It never signs or broadcasts on its own: each step needs two taps by the user ("Check step N", then "Ask wallet to
// sign step N"), and the wallet then asks for its own approval. Nothing is sent automatically after a step completes.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { discoverWallets, switchToChain, type WalletOption } from '../protocol/wallet'
import {
  assess, explorerAddress, explorerTx, manifestFor, preflight, rpcFromEip1193, validateBundle, verifySent,
  type Assessment, type Bundle, type CheckResult, type Preflight, type Rpc,
} from './core'
import { MAINNET_CHAIN_ID, REHEARSAL_CHAIN_ID } from './expected'

// ------------------------------------------------------------------ helpers

/** JSON-RPC over fetch to the chain's own RPC (the console's independent view; never the wallet). */
function nodeRpc(url: string): Rpc {
  let id = 0
  return async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    const body = await res.json()
    if (body.error) throw Object.assign(new Error(body.error.message ?? 'RPC error'), { code: body.error.code })
    return body.result
  }
}
/** Bundles load from the console's own origin only (a relative path), never from another site. */
function bundleUrl(): string {
  const q = new URLSearchParams(window.location.search).get('bundle') ?? 'deploy/bundle.json'
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(q)) throw new Error('The bundle must be loaded from this site (a relative path).')
  return new URL(q, window.location.href).href
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const groups = (h: string) => h.replace(/^0x/, '').match(/.{1,4}/g)!
const errText = (e: unknown) => {
  const x = e as { code?: number | string; message?: string }
  // Some mobile wallets reject without code 4001, so the wording is recognised too.
  if (x?.code === 4001 || x?.code === 'ACTION_REJECTED' || /user (rejected|denied|cancel)|rejected by user|request (was )?(rejected|cancel)/i.test(String(x?.message ?? ''))) return 'You rejected the request in your wallet. Nothing was sent.'
  return `${x?.code !== undefined ? `[${x.code}] ` : ''}${String(x?.message ?? e).slice(0, 220)}`
}
const sentKey = (b: Bundle) => `rixor.deploy.sent.${b.bundleHash}`
const loadSent = (b: Bundle): Record<number, string> => { try { return JSON.parse(localStorage.getItem(sentKey(b)) ?? '{}') } catch { return {} } }
const saveSent = (b: Bundle, m: Record<number, string>) => { try { localStorage.setItem(sentKey(b), JSON.stringify(m)) } catch { /* private mode: links only */ } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function Checks({ list }: { list: CheckResult[] }) {
  return (
    <ul className="checks">
      {list.map((c, i) => <li key={i} className={c.ok ? 'ok' : 'bad'}>{c.label}{!c.ok && c.detail ? <small>{c.detail}</small> : null}</li>)}
    </ul>
  )
}

// ------------------------------------------------------------------ component

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking'; i: number }
  | { kind: 'checked'; i: number; pf: Preflight }
  | { kind: 'awaiting-wallet'; i: number }
  | { kind: 'mining'; i: number; hash: string; since: number }
  | { kind: 'verified'; i: number; hash: string; checks: CheckResult[]; ok: boolean }
  | { kind: 'error'; i: number; message: string }

export function DeployConsole() {
  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [wallets, setWallets] = useState<WalletOption[] | null>(null)
  const [wallet, setWallet] = useState<WalletOption | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [walletChain, setWalletChain] = useState<number | null>(null)
  const [a, setA] = useState<Assessment | null>(null)
  const [assessing, setAssessing] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [sent, setSent] = useState<Record<number, string>>({})
  const [message, setMessage] = useState<string | null>(null)

  const problems = useMemo(() => (bundle ? validateBundle(bundle) : []), [bundle])
  // A testnet bundle names the official RPC; a rehearsal bundle names a path relative to this page (same origin).
  const rpcUrl = useMemo(() => (bundle ? new URL(bundle.rpc, window.location.href).href : null), [bundle])
  const node = useMemo(() => (rpcUrl ? nodeRpc(rpcUrl) : null), [rpcUrl])
  const busy = phase.kind === 'checking' || phase.kind === 'awaiting-wallet' || phase.kind === 'mining'

  // Load the bundle once.
  useEffect(() => {
    let url: string
    try { url = bundleUrl() } catch (e) { setLoadError(errText(e)); return }
    fetch(url, { cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error(`No bundle at ${url} (HTTP ${r.status}). Paste one below instead.`); return r.json() })
      .then((b: Bundle) => { setBundle(b); setSent(loadSent(b)) })
      .catch((e) => setLoadError(errText(e)))
  }, [])

  const refresh = useCallback(async () => {
    if (!bundle || !node || problems.length) return
    setAssessing(true)
    try { setA(await assess(node, bundle)) } catch (e) { setMessage(`Could not read the chain: ${errText(e)}`) } finally { setAssessing(false) }
  }, [bundle, node, problems.length])
  useEffect(() => { void refresh() }, [refresh])

  // Wallet: any account or network change invalidates every check result.
  useEffect(() => {
    const p = wallet?.provider
    if (!p?.on) return
    const onAccounts = (acc: unknown) => { setAccount(Array.isArray(acc) && acc[0] ? String(acc[0]) : null); setPhase({ kind: 'idle' }) }
    const onChain = (c: unknown) => { setWalletChain(Number(c)); setPhase({ kind: 'idle' }) }
    p.on('accountsChanged', onAccounts)
    p.on('chainChanged', onChain)
    return () => { p.removeListener?.('accountsChanged', onAccounts); p.removeListener?.('chainChanged', onChain) }
  }, [wallet])

  const usePasted = () => {
    try { const b = JSON.parse(pasted) as Bundle; setBundle(b); setSent(loadSent(b)); setLoadError(null) } catch { setLoadError('That is not valid JSON.') }
  }
  const findWallets = async () => {
    setMessage(null)
    const list = await discoverWallets()
    setWallets(list)
    const zerion = list.find((w) => /zerion/i.test(`${w.id} ${w.name}`))
    if (list.length === 1 || zerion) void connect(zerion ?? list[0])
  }
  const connect = async (w: WalletOption) => {
    setMessage(null)
    try {
      const acc = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[]
      setWallet(w)
      setAccount(acc?.[0] ?? null)
      setWalletChain(Number(await w.provider.request({ method: 'eth_chainId' })))
    } catch (e) { setMessage(errText(e)) }
  }
  const switchNetwork = async () => {
    if (!wallet || !bundle || !rpcUrl) return
    setMessage(null)
    try {
      await switchToChain(wallet, { chainId: bundle.chainId, name: bundle.rehearsal ? 'Rixor Rehearsal (local, 31337)' : 'Robinhood Chain Testnet', rpc: rpcUrl })
      setWalletChain(Number(await wallet.provider.request({ method: 'eth_chainId' })))
    } catch (e) { setMessage(errText(e)) }
  }

  const check = async (i: number) => {
    if (!bundle || !node || !wallet) return
    setPhase({ kind: 'checking', i })
    try {
      const pf = await preflight(node, rpcFromEip1193(wallet.provider), bundle, i)
      setPhase({ kind: 'checked', i, pf })
    } catch (e) { setPhase({ kind: 'error', i, message: errText(e) }) }
  }

  const sign = async (i: number) => {
    if (!bundle || !node || !wallet) return
    // Re-run every check immediately before the wallet request, and send exactly what the checks approved.
    setPhase({ kind: 'checking', i })
    let pf: Preflight
    try { pf = await preflight(node, rpcFromEip1193(wallet.provider), bundle, i) } catch (e) { setPhase({ kind: 'error', i, message: errText(e) }); return }
    if (!pf.ok || !pf.request) { setPhase({ kind: 'checked', i, pf }); return }
    setPhase({ kind: 'awaiting-wallet', i })
    let hash: string
    try {
      hash = String(await wallet.provider.request({ method: 'eth_sendTransaction', params: [pf.request] }))
    } catch (e) {
      setPhase({ kind: 'error', i, message: errText(e) })
      await refresh()
      return
    }
    const nextSent = { ...loadSent(bundle), [i]: hash }
    saveSent(bundle, nextSent)
    setSent(nextSent)
    await waitAndVerify(i, hash)
  }

  const waitAndVerify = async (i: number, hash: string) => {
    if (!bundle || !node) return
    const since = Date.now()
    setPhase({ kind: 'mining', i, hash, since })
    for (;;) {
      try {
        const rc = await node('eth_getTransactionReceipt', [hash])
        if (rc) break
      } catch { /* keep waiting */ }
      await sleep(2500)
    }
    try {
      const v = await verifySent(node, bundle, i, hash)
      setPhase({ kind: 'verified', i, hash, checks: v.checks, ok: v.ok })
    } catch (e) { setPhase({ kind: 'error', i, message: `Sent, but verification could not run: ${errText(e)}` }) }
    await refresh()
  }

  // Resume: a transaction this device sent is still pending -> keep waiting for it (never send again).
  useEffect(() => {
    if (!bundle || !a || a.status !== 'pending' || phase.kind !== 'idle') return
    const hash = sent[a.next]
    if (hash) void waitAndVerify(a.next, hash)
  }, [a]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- render

  if (!bundle) {
    return (
      <main className="dc">
        <h1><b>RIXOR</b> Deploy Console</h1>
        <p className="sub">Loads a reviewed deployment bundle, then asks your wallet to sign each planned transaction, one tap at a time.</p>
        {loadError && <div className="banner banner--bad"><strong>No bundle loaded</strong>{loadError}</div>}
        <section className="card stack">
          <h2>Paste a bundle</h2>
          <textarea aria-label="Bundle JSON" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"format":"rixor-deploy-bundle/1", …}' />
          <button type="button" className="btn btn--ghost" disabled={!pasted.trim()} onClick={usePasted}>Load this bundle</button>
        </section>
      </main>
    )
  }

  const n = bundle.transactions.length
  const done = a ? a.steps.filter((s) => s.state === 'done').length : 0
  const wrongChain = wallet && walletChain !== null && walletChain !== bundle.chainId
  const wrongAccount = wallet && account && account.toLowerCase() !== bundle.deployer.toLowerCase()
  const ready = problems.length === 0 && wallet && !wrongChain && !wrongAccount && a?.status === 'ready'
  const lockerStep = bundle.transactions.findIndex((t) => t.creates?.address.toLowerCase() === bundle.addresses.locker.toLowerCase())

  return (
    <main className="dc">
      <h1><b>RIXOR</b> Deploy Console</h1>
      <p className="sub">Each step: check, then ask your wallet to sign. Nothing is ever sent automatically.</p>

      {bundle.chainId === MAINNET_CHAIN_ID
        ? <div className="banner banner--bad"><strong>Mainnet refused</strong>This console never deploys to Robinhood Chain mainnet.</div>
        : bundle.rehearsal
          ? <div className="banner banner--rehearsal" role="note"><strong>REHEARSAL · local chain 31337</strong>A private local chain. Nothing here reaches Robinhood Chain testnet or mainnet, and signatures for chain 31337 are not valid on any real network.</div>
          : <div className="banner banner--testnet" role="note"><strong>ROBINHOOD CHAIN TESTNET · chain 46630</strong>Real testnet transactions, signed by your wallet. Testnet ETH and TEST tokens only; nothing has value.</div>}

      <section className="card">
        <h2>1 · Reviewed plan</h2>
        <p className="sub" style={{ margin: '0 0 4px' }}>Bundle hash: compare every character with the plan review.</p>
        <div className="hash" aria-label={`Bundle hash ${bundle.bundleHash}`}>0x {groups(bundle.bundleHash).map((g, i) => <span key={i}>{g}</span>)}</div>
        {problems.length === 0
          ? <div className="banner banner--ok"><strong>Bundle verified</strong>Every transaction and check equals what this console rebuilds from its pinned constants: Safe factory, salts and 2-of-3 signers, contract bytecode, constructor arguments, amounts and nonces.</div>
          : <div className="banner banner--bad" role="alert"><strong>Bundle refused: do not continue</strong><ul className="checks">{problems.map((p, i) => <li key={i} className="bad">{p}</li>)}</ul></div>}
        <details>
          <summary>Addresses and signers</summary>
          <dl className="rows" style={{ marginTop: 10 }}>
            <dt>Deployer</dt><dd className="mono">{bundle.deployer}</dd>
            <dt>Start nonce</dt><dd>{bundle.startNonce}</dd>
            {bundle.signers.owner.map((s, i) => <div key={`o${i}`} style={{ display: 'contents' }}><dt>Owner signer {i + 1}</dt><dd className="mono">{s}</dd></div>)}
            {bundle.signers.guardian.map((s, i) => <div key={`g${i}`} style={{ display: 'contents' }}><dt>Guardian signer {i + 1}</dt><dd className="mono">{s}</dd></div>)}
            {Object.entries(bundle.addresses).map(([k, v]) => {
              const link = explorerAddress(bundle, v)
              return <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd className="mono">{link && done > 0 ? <a href={link} target="_blank" rel="noreferrer">{v}</a> : v}</dd></div>
            })}
            <dt>Planned gas</dt><dd>{Number(bundle.gas.totalPlanned).toLocaleString('en-US')} (L1 component {bundle.gas.l1ComponentGas})</dd>
            <dt>Generated</dt><dd>{bundle.createdAt} · commit {bundle.source.commit.slice(0, 7)}{bundle.source.dirty ? ' (uncommitted changes)' : ''}</dd>
          </dl>
        </details>
      </section>

      <section className="card stack">
        <h2>2 · Wallet</h2>
        {!wallet && (
          <>
            <button type="button" className="btn btn--lime" onClick={() => void findWallets()} disabled={problems.length > 0}>Connect wallet</button>
            {wallets && wallets.length === 0 && <div className="banner banner--bad">No wallet found. Open this page in your wallet app's browser (for example Zerion → Browser).</div>}
            {wallets && wallets.length > 1 && <div className="chip-row">{wallets.map((w) => <button key={w.id} type="button" className="btn btn--ghost btn--sm" onClick={() => void connect(w)}>{w.name}</button>)}</div>}
          </>
        )}
        {wallet && (
          <dl className="rows">
            <dt>Wallet</dt><dd>{wallet.name}</dd>
            <dt>Account</dt><dd className="mono">{account ?? 'none'}</dd>
            <dt>Network</dt><dd>chain {walletChain ?? '?'}</dd>
          </dl>
        )}
        {wallet && walletChain === MAINNET_CHAIN_ID && <div className="banner banner--bad" role="alert"><strong>Mainnet refused</strong>Your wallet is on Robinhood Chain mainnet. Switch to {bundle.rehearsal ? 'the rehearsal chain' : 'Robinhood Chain testnet'}.</div>}
        {wrongChain && <button type="button" className="btn btn--ghost" onClick={() => void switchNetwork()}>Switch wallet to chain {bundle.chainId}</button>}
        {wrongAccount && <div className="banner banner--bad" role="alert"><strong>Wrong account</strong>Select the planned deployer {short(bundle.deployer)} in your wallet. Never use a Safe signer's account to deploy.</div>}
        {message && <div className="banner banner--bad" role="alert">{message}</div>}
      </section>

      <section className="card">
        <h2>3 · Deployment · {done}/{n} confirmed on chain</h2>
        <div className="progress"><i style={{ width: `${(done / n) * 100}%` }} /></div>
        <div className="status-line" style={{ margin: '8px 0' }}>
          {assessing && <span className="spinner" aria-hidden="true" />}
          <span>{!a ? 'Reading the chain…'
            : a.status === 'complete' ? 'All 11 steps are on chain and verified.'
              : a.status === 'pending' ? 'A transaction from the deployer is pending. Waiting for it; nothing else can be sent.'
                : a.status === 'halt' ? 'STOPPED: the chain does not match the plan.'
                  : `Next: step ${a.next + 1} of ${n}.`}</span>
          <button type="button" className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }} disabled={busy || assessing} onClick={() => void refresh()}>Refresh</button>
        </div>
        {a?.status === 'halt' && <div className="banner banner--bad" role="alert"><strong>Stopped</strong><ul className="checks">{a.problems.map((p, i) => <li key={i} className="bad">{p}</li>)}</ul></div>}

        <ol className="steps">
          {bundle.transactions.map((t, i) => {
            const st = a?.steps[i]?.state ?? 'todo'
            const isNext = a?.status === 'ready' && a.next === i
            const here = phase.kind !== 'idle' && 'i' in phase && phase.i === i
            const hash = sent[i]
            const link = hash ? explorerTx(bundle, hash) : null
            return (
              <li key={i} className={`step step--${st === 'done' ? 'done' : st === 'failed' ? 'failed' : isNext ? 'next' : 'todo'}`}>
                <div className="step-head">
                  <span className="step-n">{st === 'done' ? '✓' : t.index}</span>
                  <div>
                    <div className="step-title">{t.label}</div>
                    <div className="step-meta">
                      nonce {t.nonce} · {t.to ? `to ${short(t.to)}` : `contract creation, ${((t.data.length - 2) / 2).toLocaleString('en-US')} bytes`}
                      {t.creates ? ` · creates ${short(t.creates.address)}` : ''} · ~{Number(t.gasPlanned).toLocaleString('en-US')} gas
                    </div>
                    {hash && <div className="step-meta">tx {link ? <a href={link} target="_blank" rel="noreferrer">{short(hash)}</a> : <span className="mono">{short(hash)}</span>}</div>}
                  </div>
                  <span className={`badge badge--${st === 'done' ? 'done' : st === 'failed' ? 'failed' : isNext ? 'next' : 'todo'}`}>{st === 'done' ? 'done' : st === 'failed' ? 'mismatch' : isNext ? 'next' : 'waiting'}</span>
                </div>
                {st !== 'todo' && a?.steps[i]?.checks.length ? <details><summary>On-chain checks</summary><Checks list={a.steps[i].checks} /></details> : null}

                {isNext && (
                  <div className="stack" style={{ marginTop: 10 }}>
                    <button type="button" className="btn btn--ghost" disabled={!ready || busy} onClick={() => void check(i)}>Check step {t.index}</button>
                    {here && phase.kind === 'checking' && <div className="status-line"><span className="spinner" /> Checking chain, wallet, nonce, calldata and balance…</div>}
                    {here && phase.kind === 'checked' && (
                      <>
                        <Checks list={phase.pf.checks} />
                        {phase.pf.ok
                          ? <button type="button" className="btn btn--lime" disabled={!ready || busy} onClick={() => void sign(i)}>Ask wallet to sign step {t.index}</button>
                          : <div className="banner banner--bad" role="alert"><strong>Not sent</strong>Fix the failed check above, then check again.</div>}
                      </>
                    )}
                    {here && phase.kind === 'awaiting-wallet' && <div className="status-line"><span className="spinner" /> Approve or reject step {t.index} in your wallet.</div>}
                    {here && phase.kind === 'error' && <div className="banner banner--bad" role="alert">{phase.message}</div>}
                  </div>
                )}
                {here && phase.kind === 'mining' && <div className="status-line" style={{ marginTop: 10 }}><span className="spinner" /> Sent. Waiting for it to be mined, then verifying…</div>}
                {here && phase.kind === 'verified' && (
                  <div style={{ marginTop: 10 }}>
                    <div className={`banner ${phase.ok ? 'banner--ok' : 'banner--bad'}`} role={phase.ok ? 'status' : 'alert'}><strong>{phase.ok ? `Step ${t.index} verified` : `Step ${t.index} does not match the plan: STOP`}</strong>{phase.ok ? 'Receipt, address, bytecode and contract state all match the plan.' : 'Do not send anything else from the deployer.'}</div>
                    <Checks list={phase.checks} />
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </section>

      {a?.status === 'complete' && (
        <section className="card stack">
          <h2>4 · Complete</h2>
          <div className="banner banner--ok"><strong>Deployment verified on chain {bundle.chainId}</strong>Every step's on-chain checks pass. Publishing the app manifest is a separate, explicitly approved step.</div>
          <details>
            <summary>App manifest (for review; not published by this console)</summary>
            <ManifestBlock bundle={bundle} node={node} lockerStep={lockerStep} sent={sent} />
          </details>
        </section>
      )}

      <p className="sub" style={{ marginTop: 20 }}>
        Safety: this page holds no keys and never signs. It rebuilds every transaction from pinned constants, refuses mainnet (4663), checks the chain, account, nonce, calldata,
        destination, value, empty address, gas and balance before each request, and verifies the receipt, address, bytecode hash and contract state after it.
        {bundle.chainId === REHEARSAL_CHAIN_ID ? ' Rehearsal: nothing reaches a real network.' : ' Testnet ETH and TEST tokens have no value.'}
      </p>
    </main>
  )
}

function ManifestBlock({ bundle, node, lockerStep, sent }: { bundle: Bundle; node: Rpc | null; lockerStep: number; sent: Record<number, string> }) {
  const [block, setBlock] = useState<number | null>(null)
  useEffect(() => {
    const hash = sent[lockerStep]
    if (!node || !hash) return
    node('eth_getTransactionReceipt', [hash]).then((rc) => setBlock(rc ? Number(BigInt(String((rc as { blockNumber: string }).blockNumber))) : null)).catch(() => setBlock(null))
  }, [node, lockerStep, sent])
  return <pre>{JSON.stringify(manifestFor(bundle, block ?? 0), null, 2)}{block === null ? '\n// block: the RixorLocker deployment block (read from the Locker transaction receipt)' : ''}</pre>
}
