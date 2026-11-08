import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { icon } from '../ui'
import { contractsFor, demoWalletFrom, type ConnectedWallet } from './chain'
import { Brand, Sheet, useTx } from './components'
import { hashToRoute, makeLabeler, routeToHash, type Ctx, type Route } from './ctx'
import { safeStorage } from './env'
import { fmtDate, fmtDuration, fmtToken, shortAddr } from './model'
import type { Boot, SimSession } from './sim/session'
import { useChainNow, useProtocol } from './useProtocol'
import { ActivityView } from './views/Activity'
import { ChallengeView } from './views/Challenge'
import { CreateView } from './views/Create'
import { Explore } from './views/Explore'
import { LockView, TokenView } from './views/Lock'
import { Portfolio } from './views/Portfolio'
import './protocol.css'

const NAV: { route: Route['name']; label: string }[] = [
  { route: 'explore', label: 'Explore' },
  { route: 'lock', label: 'Lock' },
  { route: 'portfolio', label: 'Portfolio' },
  { route: 'activity', label: 'Activity' },
]

/** Loads the in-browser EVM lazily so the first paint does not wait for @ethereumjs. */
function useSimSession() {
  const [session, setSession] = useState<SimSession | null>(null)
  const [boot, setBoot] = useState<Boot>({ stage: 'snapshot', detail: 'Starting' })
  const [error, setError] = useState<string | null>(null)
  const start = useCallback(() => {
    setError(null)
    setSession(null)
    import('./sim/session')
      .then((m) => m.bootSim(setBoot))
      .then(setSession)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(() => { start() }, [start])
  return { session, boot, error, restart: start }
}

export default function RixorApp() {
  const { session, boot, error: bootError, restart } = useSimSession()
  const [route, setRoute] = useState<Route>(() => hashToRoute(window.location.hash))
  const [light, setLight] = useState(() => safeStorage.get('rixor.theme') === 'light')
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null)
  const [walletOpen, setWalletOpen] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [working, setWorking] = useState<string | null>(null)

  useEffect(() => {
    const onHash = () => { setRoute(hashToRoute(window.location.hash)); window.scrollTo({ top: 0 }) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => { safeStorage.set('rixor.theme', light ? 'light' : 'dark') }, [light])

  useEffect(() => {
    if (!session) return
    const key = session.walletKey()
    setWallet(key ? demoWalletFrom(key, session.provider) : null)
  }, [session])

  const manifest = session?.manifest ?? null
  const provider = session?.provider ?? null
  const { snapshot, error, refresh } = useProtocol(session ? session.health : null, manifest, provider, wallet?.address ?? null)
  const now = useChainNow(snapshot)
  const resetNonce = useCallback(() => wallet?.resetNonce?.(), [wallet])
  const tx = useTx(refresh, resetNonce)
  const go = useCallback((r: Route) => { window.location.hash = routeToHash(r) }, [])
  const write = useMemo(() => (manifest && wallet ? contractsFor(manifest, wallet.signer) : null), [manifest, wallet])
  const label = useMemo(() => (manifest ? makeLabeler(manifest, wallet?.address ?? null) : (a: string) => shortAddr(a)), [manifest, wallet])

  const flash = (kind: 'ok' | 'error', text: string) => { setNotice({ kind, text }); window.setTimeout(() => setNotice(null), 6000) }

  const createWallet = async () => {
    if (!session) return
    const key = await session.createWalletKey()
    setWallet(demoWalletFrom(key, session.provider))
  }
  const fund = async () => {
    if (!session || !wallet) return
    setWorking('faucet')
    try {
      const r = await session.faucet(wallet.address)
      flash('ok', `Added ${Number(r.meme).toLocaleString('en-US')} demo ${r.symbols.join(' and ')} plus ${Number(r.wif).toLocaleString('en-US')} demo WIF to your simulated wallet.`)
      await refresh()
    } catch (e) { flash('error', e instanceof Error ? e.message : String(e)) } finally { setWorking(null) }
  }
  const advance = async (seconds: number) => {
    if (!session) return
    setWorking(`time-${seconds}`)
    try { await session.advance(seconds); flash('ok', `Simulation time moved forward ${fmtDuration(seconds)}.`); await refresh() } catch (e) { flash('error', e instanceof Error ? e.message : String(e)) } finally { setWorking(null) }
  }
  const forget = async () => {
    if (!session) return
    if (!window.confirm('Forget this demo wallet? Its positions stay in this simulation, but you will lose access to them.')) return
    await session.forgetWallet()
    setWallet(null)
    setWalletOpen(false)
  }
  const resetAll = async () => {
    if (!session) return
    if (!window.confirm('Reset the whole simulation on this device? Every demo position, challenge and balance you created here will be erased.')) return
    await session.reset()
    setWallet(null)
    setWalletOpen(false)
    restart()
  }

  const themeClass = light ? 'theme-light' : 'theme-dark'
  const Shell = ({ children }: { children: ReactNode }) => (
    <main className={`app dashboard ${themeClass}`}>
      <header className="app-bar"><div className="container app-bar-inner"><Brand /></div></header>
      <div className="container app-body">{children}</div>
    </main>
  )

  if (bootError) {
    return (
      <Shell>
        <div className="notice notice--error"><strong>The browser simulation could not start</strong><span>{bootError}</span></div>
        <button type="button" className="btn btn--lime" onClick={restart}>Try again</button>
      </Shell>
    )
  }
  if (!session || !manifest || !provider || !snapshot) {
    return (
      <Shell>
        <section className="card setup-card">
          <small className="kicker">Isolated browser EVM simulation</small>
          <h1 className="section-title">Starting Rixor on this device</h1>
          <div className="tx-progress" role="status"><span className="spinner" aria-hidden="true" /><div><small>{boot.stage === 'replay' ? 'Restoring your simulation' : boot.stage === 'setup' ? 'First visit setup' : 'Loading'}</small><strong>{error ?? boot.detail}</strong></div></div>
          {boot.progress !== undefined && <span className="progress"><i style={{ width: `${Math.round(boot.progress * 100)}%` }} /></span>}
          <p className="fine-print">Rixor's actual contracts run in your browser against a snapshot of Robinhood Chain mainnet state. Nothing is sent to any network, and no deposit is ever needed.</p>
        </section>
      </Shell>
    )
  }

  const ctx: Ctx = { manifest, provider, snapshot, now, wallet, write, tx, go, refresh, openWallet: () => setWalletOpen(true), label }
  const holdsNothing = snapshot.tokens.every((t) => t.balance === 0n) && snapshot.wif.balance === 0n
  const active = route.name === 'token' || route.name === 'challenge' || route.name === 'create' ? 'explore' : route.name

  return (
    <main className={`app dashboard ${themeClass}`}>
      <header className="app-bar">
        <div className="container app-bar-inner">
          <button className="brand-btn" type="button" onClick={() => go({ name: 'explore' })} aria-label="Rixor home"><Brand /></button>
          <nav className="seg seg--nav" aria-label="Sections">
            {NAV.map((n) => (
              <button key={n.route} type="button" className={active === n.route ? 'is-active' : ''} aria-current={active === n.route ? 'page' : undefined} onClick={() => go({ name: n.route } as Route)}>{n.label}</button>
            ))}
          </nav>
          <div className="app-bar-actions">
            <button type="button" className="icon-btn" onClick={() => setLight(!light)} aria-label={light ? 'Switch to dark mode' : 'Switch to light mode'}>{icon(light ? 'moon' : 'sun')}</button>
            <button className="wallet-btn" type="button" onClick={() => setWalletOpen(true)}>
              <span className="dot-live" />
              <span className="wallet-btn-copy">
                <small>Simulation</small>
                <b>{wallet ? shortAddr(wallet.address) : 'Connect'}</b>
              </span>
            </button>
          </div>
        </div>
      </header>

      <div className="container demo-strip" role="note">
        <span className="tag tag--outline"><span className="dot-live" /> Browser simulation</span>
        <span>Isolated EVM on this device, started from Robinhood Chain mainnet block {manifest.upstream.forkBlock.toLocaleString('en-US')}. Not live Robinhood Chain. Assets here have no value.</span>
      </div>

      <div className="container app-body">
        {!session.persistent && <div className="notice notice--warn"><strong>This browser blocks storage</strong><span>The simulation works, but it resets when you close the page.</span></div>}
        {snapshot.emergencyAt !== 0 && <div className="notice notice--error"><strong>Emergency mode is active</strong><span>Every position can exit immediately without a fee. Running challenges are refundable; settled rewards stay claimable.</span></div>}
        {snapshot.paused && snapshot.emergencyAt === 0 && <div className="notice notice--warn"><strong>Paused</strong><span>New locks, challenges, sponsorships and joins are on hold. Exits, settlement, claims and refunds still work.</span></div>}
        {error && <div className="notice notice--warn"><strong>Showing the last data read</strong><span>{error}</span></div>}
        {notice && <div className={`notice ${notice.kind === 'error' ? 'notice--error' : ''}`} role="status"><span>{notice.text}</span></div>}
        {wallet && holdsNothing && snapshot.positions.length === 0 && (
          <div className="empty empty--action">
            <div><strong>Your demo wallet is empty</strong><span>Get demo {manifest.tokens.map((t) => t.symbol).join(' and ')} to lock, plus demo WIF for sponsoring. Nothing real is spent or deposited.</span></div>
            <button type="button" className="btn btn--lime btn--sm" disabled={working !== null} onClick={() => void fund()}>{working === 'faucet' ? 'Funding…' : 'Get demo tokens'}</button>
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
        <Sheet id="wallet-title" kicker="Browser simulation" title={wallet ? 'Demo wallet' : 'Connect'} onClose={() => setWalletOpen(false)}>
          {wallet ? (
            <>
              <div className="wallet-identity">
                <span className="dot-live" />
                <div>
                  <small>Demo wallet · this device only</small>
                  <strong className="mono">{shortAddr(wallet.address)}</strong>
                  <span>{snapshot.tokens.map((t) => `${fmtToken(t.balance, t.decimals, { compact: true })} ${t.symbol}`).join(' · ')} · {fmtToken(snapshot.wif.balance, 18, { compact: true })} WIF · gas is free</span>
                </div>
              </div>
              <div className="notice"><strong>Simulated balances, not real ones</strong><span>These balances exist only inside the isolated EVM in this browser. They are not Robinhood Chain balances and cannot be moved anywhere else.</span></div>
              <div className="sheet-section">
                <small className="kicker">Demo faucet</small>
                <button type="button" className="btn btn--lime btn--block" disabled={working !== null} onClick={() => void fund()}>{working === 'faucet' ? 'Funding…' : `Get demo ${manifest.tokens.map((t) => t.symbol).join(', ')} and WIF`}</button>
              </div>
              <div className="sheet-section">
                <small className="kicker">Simulation time</small>
                <p className="fine-print">Simulation time now: {fmtDate(now)}. Move it forward to reach join deadlines, challenge ends and claim windows without waiting. This has no equivalent on a real network.</p>
                <div className="chip-row">
                  {[3600, 86400, 7 * 86400, 31 * 86400].map((s) => (
                    <button key={s} type="button" className="chip" disabled={working !== null} onClick={() => void advance(s)}>{working === `time-${s}` ? '…' : `+${fmtDuration(s)}`}</button>
                  ))}
                </div>
              </div>
              <div className="sheet-section">
                <small className="kicker">Environment</small>
                <dl className="rows">
                  <div><dt>Engine</dt><dd>@ethereumjs/vm in this browser</dd></div>
                  <div><dt>Snapshot</dt><dd>{manifest.upstream.name} block {manifest.upstream.forkBlock.toLocaleString('en-US')}</dd></div>
                  <div><dt>Simulation chain id</dt><dd>{manifest.chainId} (not Robinhood Chain)</dd></div>
                  <div><dt>Locker</dt><dd className="mono">{shortAddr(manifest.contracts.locker)}</dd></div>
                  <div><dt>Rewards</dt><dd className="mono">{manifest.contracts.rewards ? shortAddr(manifest.contracts.rewards) : '—'}</dd></div>
                  <div><dt>Challenges</dt><dd className="mono">{shortAddr(manifest.contracts.challenges)}</dd></div>
                  <div><dt>Saved on this device</dt><dd>{session.persistent ? `${session.chain.ops.length} operations` : 'No (storage blocked)'}</dd></div>
                </dl>
              </div>
              <div className="sheet-actions">
                <button type="button" className="btn btn--ghost" onClick={() => void forget()}>Forget wallet</button>
                <button type="button" className="btn btn--dark" onClick={() => setWalletOpen(false)}>Done</button>
              </div>
              <button type="button" className="text-btn" onClick={() => void resetAll()}>Reset the whole simulation</button>
            </>
          ) : (
            <>
              <p className="figure-sub">The demo uses a throwaway wallet created on this device. It only works inside this browser simulation, holds only demo assets, and never needs your keys or seed phrase.</p>
              <div className="sheet-section">
                <button type="button" className="btn btn--lime btn--block btn--lg" onClick={() => void createWallet()}>Create demo wallet</button>
              </div>
              <p className="fine-print">Never send real assets to a demo address. The simulation's chain id ({manifest.chainId}) differs from Robinhood Chain, so its signatures are not valid on a real network.</p>
            </>
          )}
        </Sheet>
      )}
    </main>
  )
}
