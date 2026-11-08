import { useCallback, useEffect, useMemo, useState } from 'react'
import { icon } from '../ui'
import { connectBrowserWallet, contractsFor, demoWallet, forgetDemoWallet, hasBrowserWallet, makeProvider, type ConnectedWallet } from './chain'
import { Brand, Sheet, useTx } from './components'
import { hashToRoute, makeLabeler, routeToHash, type Ctx, type Route } from './ctx'
import { advanceDemoTime, fetchManifest, forgetBackendUrl, rememberBackendUrl, requestFaucet, resolveBackendUrl, safeStorage, type Manifest } from './env'
import { fmtDate, fmtDuration, fmtToken, shortAddr } from './model'
import { useChainNow, useProtocol } from './useProtocol'
import { ActivityView } from './views/Activity'
import { ChallengeView } from './views/Challenge'
import { CreateView } from './views/Create'
import { Explore } from './views/Explore'
import { LockView, TokenView } from './views/Lock'
import { Portfolio } from './views/Portfolio'
import './protocol.css'

const NAV: { route: Route['name']; label: string; icon: 'home' | 'lock' | 'diamond' | 'clock' | 'trophy' }[] = [
  { route: 'explore', label: 'Explore', icon: 'home' },
  { route: 'portfolio', label: 'Portfolio', icon: 'diamond' },
  { route: 'activity', label: 'Activity', icon: 'clock' },
]

function BackendSetup({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)
  return (
    <div className="container app-body">
      <section className="card setup-card">
        <small className="kicker">Rixor fork demo</small>
        <h1 className="section-title">Connect to the demo chain</h1>
        <p className="figure-sub">
          This preview runs against a private copy of Robinhood Chain mainnet state hosted by the Rixor demo backend.
          {error ? ' The backend could not be reached.' : ' No backend is configured for this build yet.'}
        </p>
        {error && <div className="notice notice--error"><strong>Backend unavailable</strong><span>{error}</span></div>}
        <label className="field"><span>Demo backend URL (https)</span><input value={value} onChange={(e) => { setValue(e.target.value); setInvalid(false) }} placeholder="https://rixor-fork.example.app" inputMode="url" autoCapitalize="off" autoCorrect="off" /></label>
        {invalid && <div className="field-error">Use an https:// URL.</div>}
        <div className="btn-pair">
          <button type="button" className="btn btn--ghost" onClick={onRetry}>Retry</button>
          <button type="button" className="btn btn--lime" onClick={() => { if (rememberBackendUrl(value.trim())) onRetry(); else setInvalid(true) }}>Connect</button>
        </div>
        <p className="fine-print">No real network, wallet funds or deposits are involved. Nothing here is Robinhood Chain mainnet.</p>
      </section>
    </div>
  )
}

export default function RixorApp() {
  const [backend, setBackend] = useState<string | null>(() => resolveBackendUrl())
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [route, setRoute] = useState<Route>(() => hashToRoute(window.location.hash))
  const [light, setLight] = useState(() => safeStorage.get('rixor.theme') === 'light')
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null)
  const [walletOpen, setWalletOpen] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [working, setWorking] = useState<string | null>(null)

  const boot = useCallback(() => {
    const url = resolveBackendUrl()
    setBackend(url)
    setBootError(null)
    setManifest(null)
    if (!url) return
    fetchManifest(url).then(setManifest).catch((e) => setBootError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(() => { boot() }, [boot])

  useEffect(() => {
    const onHash = () => { setRoute(hashToRoute(window.location.hash)); window.scrollTo({ top: 0 }) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => { safeStorage.set('rixor.theme', light ? 'light' : 'dark') }, [light])

  const provider = useMemo(() => (backend && manifest ? makeProvider(backend, manifest) : null), [backend, manifest])
  useEffect(() => {
    if (manifest && provider && !wallet) setWallet(demoWallet(manifest, provider, false))
  }, [manifest, provider]) // eslint-disable-line react-hooks/exhaustive-deps

  const { snapshot, error, refresh } = useProtocol(backend, manifest, provider, wallet?.address ?? null)
  const now = useChainNow(snapshot)
  const resetNonce = useCallback(() => wallet?.resetNonce?.(), [wallet])
  const tx = useTx(refresh, resetNonce)
  const go = useCallback((r: Route) => { window.location.hash = routeToHash(r) }, [])
  const write = useMemo(() => (manifest && wallet ? contractsFor(manifest, wallet.signer) : null), [manifest, wallet])
  const label = useMemo(() => (manifest ? makeLabeler(manifest, wallet?.address ?? null) : (a: string) => shortAddr(a)), [manifest, wallet])

  const flash = (kind: 'ok' | 'error', text: string) => { setNotice({ kind, text }); window.setTimeout(() => setNotice(null), 6000) }

  const createDemoWallet = () => {
    if (!manifest || !provider) return
    setWallet(demoWallet(manifest, provider, true))
  }
  const useBrowser = async () => {
    if (!manifest || !backend) return
    try { setWallet(await connectBrowserWallet(manifest, backend)); flash('ok', 'Browser wallet connected on the fork demo network.') } catch (e) { flash('error', e instanceof Error ? e.message : String(e)) }
  }
  const fund = async () => {
    if (!backend || !wallet) return
    setWorking('faucet')
    try {
      const r = await requestFaucet(backend, wallet.address)
      flash('ok', `Added ${Number(r.wif).toLocaleString('en-US')} fork WIF and ${r.eth} fork ETH for gas.`)
      await refresh()
    } catch (e) { flash('error', e instanceof Error ? e.message : String(e)) } finally { setWorking(null) }
  }
  const advance = async (seconds: number) => {
    if (!backend) return
    setWorking(`time-${seconds}`)
    try { await advanceDemoTime(backend, seconds); flash('ok', `Demo chain time moved forward ${fmtDuration(seconds)}.`); await refresh() } catch (e) { flash('error', e instanceof Error ? e.message : String(e)) } finally { setWorking(null) }
  }
  const resetWallet = () => {
    if (!manifest) return
    if (!window.confirm('Forget this demo wallet? Its fork positions stay on the demo chain but this browser will lose access to them.')) return
    forgetDemoWallet(manifest)
    setWallet(null)
    setWalletOpen(false)
  }

  const themeClass = light ? 'theme-light' : 'theme-dark'

  if (!backend || bootError) {
    return (
      <main className={`app dashboard ${themeClass}`}>
        <header className="app-bar"><div className="container app-bar-inner"><Brand /></div></header>
        <BackendSetup error={bootError} onRetry={() => { if (bootError) forgetBackendUrl(); boot() }} />
      </main>
    )
  }

  if (!manifest || !provider || !snapshot) {
    return (
      <main className={`app dashboard ${themeClass}`}>
        <header className="app-bar"><div className="container app-bar-inner"><Brand /></div></header>
        <div className="container app-body">
          {error ? <div className="notice notice--error"><strong>Could not read the demo chain</strong><span>{error}</span></div> : (
            <div className="tx-progress" role="status"><span className="spinner" aria-hidden="true" /><div><small>Rixor fork demo</small><strong>Reading the demo chain…</strong></div></div>
          )}
        </div>
      </main>
    )
  }

  const ctx: Ctx = { backend, manifest, provider, snapshot, now, wallet, write, tx, go, refresh, openWallet: () => setWalletOpen(true), label }
  const wif = snapshot.tokens.find((t) => t.address.toLowerCase() === manifest.contracts.wif.toLowerCase())
  const active = route.name === 'token' || route.name === 'challenge' || route.name === 'create' ? 'explore' : route.name === 'lock' ? 'lock' : route.name

  return (
    <main className={`app dashboard ${themeClass}`}>
      <header className="app-bar">
        <div className="container app-bar-inner">
          <button className="brand-btn" type="button" onClick={() => go({ name: 'explore' })} aria-label="Rixor home"><Brand /></button>
          <nav className="seg seg--nav" aria-label="Sections">
            {[...NAV.slice(0, 1), { route: 'lock' as const, label: 'Lock', icon: 'lock' as const }, ...NAV.slice(1)].map((n) => (
              <button key={n.route} type="button" className={active === n.route ? 'is-active' : ''} aria-current={active === n.route ? 'page' : undefined} onClick={() => go({ name: n.route } as Route)}>{n.label}</button>
            ))}
          </nav>
          <div className="app-bar-actions">
            <button type="button" className="icon-btn" onClick={() => setLight(!light)} aria-label={light ? 'Switch to dark mode' : 'Switch to light mode'}>{icon(light ? 'moon' : 'sun')}</button>
            <button className="wallet-btn" type="button" onClick={() => setWalletOpen(true)}>
              <span className="dot-live" />
              <span className="wallet-btn-copy">
                <small>Fork demo</small>
                <b>{wallet ? shortAddr(wallet.address) : 'Connect'}</b>
              </span>
            </button>
          </div>
        </div>
      </header>

      <div className="container demo-strip" role="note">
        <span className="tag tag--outline"><span className="dot-live" /> Fork demo</span>
        <span>Private copy of Robinhood Chain mainnet at block {manifest.upstream.forkBlock.toLocaleString('en-US')}. Not mainnet. Assets here have no value.</span>
      </div>

      <div className="container app-body">
        {snapshot.emergencyAt !== 0 && <div className="notice notice--error"><strong>Emergency mode is active</strong><span>Every position can exit immediately without a fee. Running challenges are refundable; settled rewards stay claimable.</span></div>}
        {snapshot.paused && snapshot.emergencyAt === 0 && <div className="notice notice--warn"><strong>Paused</strong><span>New locks, challenges, sponsorships and joins are on hold. Exits, settlement, claims and refunds still work.</span></div>}
        {error && <div className="notice notice--warn"><strong>Showing the last data read</strong><span>{error}</span></div>}
        {notice && <div className={`notice ${notice.kind === 'error' ? 'notice--error' : ''}`} role="status"><span>{notice.text}</span></div>}
        {wallet && wif && wif.balance === 0n && snapshot.positions.length === 0 && (
          <div className="empty empty--action">
            <div><strong>Your demo wallet is empty</strong><span>Get fork WIF and fork ETH from the demo faucet. Nothing real is spent.</span></div>
            <button type="button" className="btn btn--lime btn--sm" disabled={working !== null} onClick={() => void fund()}>{working === 'faucet' ? 'Funding…' : 'Get demo funds'}</button>
          </div>
        )}

        {route.name === 'explore' && <Explore ctx={ctx} />}
        {route.name === 'token' && <TokenView ctx={ctx} address={route.address} />}
        {route.name === 'lock' && <LockView ctx={ctx} />}
        {route.name === 'portfolio' && <Portfolio ctx={ctx} />}
        {route.name === 'challenge' && <ChallengeView key={route.id} ctx={ctx} id={route.id} />}
        {route.name === 'create' && <CreateView ctx={ctx} />}
        {route.name === 'activity' && <ActivityView ctx={ctx} />}
      </div>

      <nav className="tabbar tabbar--five" aria-label="Sections">
        <button type="button" className={active === 'explore' ? 'is-active' : ''} onClick={() => go({ name: 'explore' })}>{icon('home', 20)}<span>Explore</span></button>
        <button type="button" className={active === 'portfolio' ? 'is-active' : ''} onClick={() => go({ name: 'portfolio' })}>{icon('diamond', 20)}<span>Portfolio</span></button>
        <button type="button" className="tabbar-cta" aria-label="Lock tokens" onClick={() => go({ name: 'lock' })}>{icon('lock', 22)}</button>
        <button type="button" className={active === 'activity' ? 'is-active' : ''} onClick={() => go({ name: 'activity' })}>{icon('clock', 20)}<span>Activity</span></button>
        <button type="button" onClick={() => setWalletOpen(true)}>{icon('coins', 20)}<span>Wallet</span></button>
      </nav>

      {walletOpen && (
        <Sheet id="wallet-title" kicker="Fork demo wallet" title={wallet ? 'Demo wallet' : 'Connect'} onClose={() => setWalletOpen(false)}>
          {wallet ? (
            <>
              <div className="wallet-identity">
                <span className="dot-live" />
                <div>
                  <small>{wallet.kind === 'demo' ? 'Demo wallet · this browser only' : 'Browser wallet · fork demo network'}</small>
                  <strong className="mono">{shortAddr(wallet.address)}</strong>
                  <span>{fmtToken(wif?.balance ?? 0n, 18, { compact: true })} fork WIF · {fmtToken(snapshot.ethBalance, 18)} fork ETH</span>
                </div>
              </div>
              <div className="notice"><strong>Demo balances, not real ones</strong><span>These balances exist only on the private Rixor demo chain (id {manifest.chainId}). They are not your Robinhood Chain balances and cannot be withdrawn anywhere.</span></div>
              {manifest.features.faucet && (
                <div className="sheet-section">
                  <small className="kicker">Demo faucet</small>
                  <button type="button" className="btn btn--lime btn--block" disabled={working !== null} onClick={() => void fund()}>{working === 'faucet' ? 'Funding…' : `Get ${Number(manifest.features.faucetWif).toLocaleString('en-US')} fork WIF`}</button>
                </div>
              )}
              {manifest.features.timeControl && (
                <div className="sheet-section">
                  <small className="kicker">Demo time control · moves the shared demo chain clock</small>
                  <p className="fine-print">Chain time now: {fmtDate(now)}. Use this to reach join deadlines, challenge ends and claim windows without waiting. It has no equivalent on a real network.</p>
                  <div className="chip-row">
                    {[3600, 86400, 7 * 86400, 31 * 86400].map((s) => (
                      <button key={s} type="button" className="chip" disabled={working !== null} onClick={() => void advance(s)}>{working === `time-${s}` ? '…' : `+${fmtDuration(s)}`}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="sheet-section">
                <small className="kicker">Environment</small>
                <dl className="rows">
                  <div><dt>Network</dt><dd>Rixor fork demo · chain {manifest.chainId}</dd></div>
                  <div><dt>Forked from</dt><dd>{manifest.upstream.name} block {manifest.upstream.forkBlock.toLocaleString('en-US')}</dd></div>
                  <div><dt>Backend</dt><dd className="mono">{new URL(backend).host}</dd></div>
                  <div><dt>Locker</dt><dd className="mono">{shortAddr(manifest.contracts.locker)}</dd></div>
                  <div><dt>Challenges</dt><dd className="mono">{shortAddr(manifest.contracts.challenges)}</dd></div>
                </dl>
              </div>
              <div className="sheet-actions">
                {wallet.kind === 'demo' ? <button type="button" className="btn btn--ghost" onClick={resetWallet}>Forget wallet</button> : <button type="button" className="btn btn--ghost" onClick={() => setWallet(demoWallet(manifest, provider, false))}>Use demo wallet</button>}
                <button type="button" className="btn btn--dark" onClick={() => setWalletOpen(false)}>Done</button>
              </div>
            </>
          ) : (
            <>
              <p className="figure-sub">The demo uses a throwaway wallet created in this browser. It only works on the private Rixor demo chain, holds only fork assets, and never needs your keys or seed phrase.</p>
              <div className="sheet-section">
                <button type="button" className="btn btn--lime btn--block btn--lg" onClick={createDemoWallet}>Create demo wallet</button>
                {hasBrowserWallet() && <button type="button" className="btn btn--ghost btn--block" onClick={() => void useBrowser()}>Use my browser wallet on the demo network</button>}
              </div>
              <p className="fine-print">Never send real assets to a demo address. The demo chain id ({manifest.chainId}) is different from Robinhood Chain mainnet, so demo signatures cannot be replayed there.</p>
            </>
          )}
        </Sheet>
      )}
    </main>
  )
}
