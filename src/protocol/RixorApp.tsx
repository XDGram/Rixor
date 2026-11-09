import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { icon } from '../ui'
import { browserWalletFrom, contractsFor, demoWalletFrom, FAUCET_COOLDOWN, TEST_FAUCET_ABI, type ConnectedWallet } from './chain'
import { Contract, type Eip1193Provider } from 'ethers'
import { setMode, type Mode } from './envtext'
import { bootTestnet, loadTestnetDeployment, TESTNET, type TestnetDeployment, type TestnetSession } from './testnet'
import { discoverWallets, requestAccount, switchToChain, type WalletOption } from './wallet'
import { Brand, Sheet, TxNotice, useTx } from './components'
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
function useSimSession(enabled: boolean) {
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
  useEffect(() => { if (enabled && !session) start() }, [start, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  return { session, boot, error, restart: start }
}

/** Testnet mode is offered only when a deployment manifest is published (see src/protocol/testnet.ts). */
function useTestnet(enabled: boolean) {
  const [deployment, setDeployment] = useState<TestnetDeployment | null | undefined>(undefined)
  const [session, setSession] = useState<TestnetSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { loadTestnetDeployment().then(setDeployment).catch((e) => { setDeployment(null); setError(e instanceof Error ? e.message : String(e)) }) }, [])
  useEffect(() => {
    if (!enabled || !deployment || session) return
    bootTestnet(deployment).then(setSession).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [enabled, deployment, session])
  return { deployment, session, error }
}

export default function RixorApp() {
  const [mode, setModeState] = useState<Mode>(() => (safeStorage.get('rixor.mode') === 'testnet' ? 'testnet' : 'simulation'))
  const testnet = useTestnet(mode === 'testnet')
  // Fall back to the simulation when no testnet deployment is published.
  const effectiveMode: Mode = mode === 'testnet' && testnet.deployment === null ? 'simulation' : mode
  setMode(effectiveMode)
  const isSim = effectiveMode === 'simulation'
  const { session: simSession, boot, error: simError, restart } = useSimSession(isSim)
  const session = isSim ? simSession : null
  const bootError = isSim ? simError : testnet.error
  const [browserWallet, setBrowserWallet] = useState<WalletOption | null>(null)
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
    if (!isSim) return
    if (!session) { setWallet(null); return }
    const key = session.walletKey()
    setWallet(key ? demoWalletFrom(key, session.provider) : null)
  }, [session, isSim])

  // A wallet is never carried across modes: switching always disconnects.
  const switchMode = (m: Mode) => {
    if (m === mode) return
    safeStorage.set('rixor.mode', m)
    setWallet(null)
    setBrowserWallet(null)
    setWalletOpen(false)
    setModeState(m)
  }

  // Testnet: the visitor's own wallet. Any account or network change disconnects it, so nothing is ever signed for
  // a stale account or the wrong chain (ethers also refuses to send when the wallet's network differs).
  useEffect(() => {
    const p = browserWallet?.provider
    if (!p?.on) return
    const drop = () => { setWallet(null); setBrowserWallet(null); flash('error', 'Your wallet changed account or network. Reconnect to continue.') }
    p.on('accountsChanged', drop)
    p.on('chainChanged', drop)
    return () => { p.removeListener?.('accountsChanged', drop); p.removeListener?.('chainChanged', drop) }
  }, [browserWallet]) // eslint-disable-line react-hooks/exhaustive-deps

  const tn = isSim ? null : testnet.session
  const manifest = isSim ? session?.manifest ?? null : tn?.manifest ?? null
  const provider = isSim ? session?.provider ?? null : tn?.provider ?? null
  const health = isSim ? (session ? session.health : null) : (tn ? tn.health : null)
  const { snapshot, error, refresh } = useProtocol(health, manifest, provider, wallet?.address ?? null)
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
  const connectBrowser = async () => {
    if (!tn) return
    setWorking('connect')
    try {
      const options = await discoverWallets()
      if (!options.length) throw new Error('No browser wallet found. Open this page in a wallet browser or install one.')
      const option = options[0]
      let acc = await requestAccount(option)
      if (acc.chainId !== tn.deployment.chainId) {
        await switchToChain(option, { chainId: tn.deployment.chainId, name: tn.deployment.label ?? TESTNET.name, rpc: tn.rpc })
        acc = await requestAccount(option)
        if (acc.chainId !== tn.deployment.chainId) throw new Error('Your wallet is not on Robinhood Chain testnet.')
      }
      setWallet(await browserWalletFrom(option.provider as unknown as Eip1193Provider, acc.address, tn.deployment.chainId))
      setBrowserWallet(option)
      safeStorage.set('rixor.testnet.connected', '1')
    } catch (e) {
      const code = (e as { code?: number })?.code
      flash('error', code === 4001 ? 'You declined the request in your wallet.' : e instanceof Error ? e.message : String(e))
    } finally { setWorking(null) }
  }
  // Restore a previously connected testnet wallet without prompting (eth_accounts), only if it is still on the right chain.
  useEffect(() => {
    if (!tn || wallet || safeStorage.get('rixor.testnet.connected') !== '1') return
    let live = true
    void (async () => {
      const [option] = await discoverWallets()
      if (!option || !live) return
      const accounts = (await option.provider.request({ method: 'eth_accounts' }).catch(() => [])) as string[]
      const chainId = Number(await option.provider.request({ method: 'eth_chainId' }).catch(() => 0))
      if (!live || !accounts?.length || chainId !== tn.deployment.chainId) return
      setWallet(await browserWalletFrom(option.provider as unknown as Eip1193Provider, accounts[0], tn.deployment.chainId))
      setBrowserWallet(option)
    })()
    return () => { live = false }
  }, [tn]) // eslint-disable-line react-hooks/exhaustive-deps

  // TEST faucets (testnet only): one claim per token per address per day. Each faucet's cooldown is read first, so a
  // token still cooling down is skipped and its next time shown, instead of reverting and stopping the others.
  const faucetTargets = useMemo(
    () => (!isSim && manifest ? [...manifest.tokens.map((t) => ({ address: t.address, symbol: t.symbol })), { address: manifest.contracts.wif, symbol: 'tWIF' }] : []),
    [isSim, manifest],
  )
  const [faucetNext, setFaucetNext] = useState<Record<string, number>>({})
  const readFaucets = useCallback(async (): Promise<Record<string, number>> => {
    if (!provider || !wallet || faucetTargets.length === 0) return {}
    const [block, ...lasts] = await Promise.all([
      provider.getBlock('latest'),
      ...faucetTargets.map((t) => new Contract(t.address, TEST_FAUCET_ABI, provider).lastFaucet(wallet.address) as Promise<bigint>),
    ])
    const chainNow = block?.timestamp ?? Math.floor(Date.now() / 1000)
    const next: Record<string, number> = {}
    faucetTargets.forEach((t, i) => {
      const availableAt = lasts[i] === 0n ? 0 : Number(lasts[i]) + FAUCET_COOLDOWN
      next[t.address] = availableAt > chainNow ? availableAt : 0 // 0 = ready now
    })
    setFaucetNext(next)
    return next
  }, [provider, wallet, faucetTargets])
  useEffect(() => { if (walletOpen && !isSim && wallet) readFaucets().catch(() => setFaucetNext({})) }, [walletOpen, isSim, wallet, readFaucets])
  const testFaucet = async (only?: string) => {
    if (!manifest || !wallet) return
    const targets = only ? faucetTargets.filter((t) => t.address === only) : faucetTargets
    // If the cooldown read fails, send anyway: a cooldown then shows as a readable error from the wallet's estimate.
    const next = await readFaucets().catch(() => ({} as Record<string, number>))
    const ready = targets.filter((t) => !next[t.address])
    const waiting = targets.filter((t) => next[t.address]).map((t) => `${t.symbol} at ${fmtDate(next[t.address])}`).join(', ')
    if (ready.length === 0) { flash('error', `Daily faucet limit reached. Available again: ${waiting}.`); return }
    const ok = await tx.run('faucet', ready.map((t) => ({ label: `Get TEST ${t.symbol} from its faucet`, send: () => new Contract(t.address, TEST_FAUCET_ABI, wallet.signer).faucet() })), `Received TEST ${ready.map((t) => t.symbol).join(', ')}`)
    if (waiting) flash(ok ? 'ok' : 'error', `Skipped (one claim per day): ${waiting}.`)
    readFaucets().catch(() => setFaucetNext({}))
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
        <div className="notice notice--error"><strong>{isSim ? 'The browser simulation could not start' : 'Testnet mode is unavailable'}</strong><span>{bootError}</span></div>
        {isSim ? <button type="button" className="btn btn--lime" onClick={restart}>Try again</button> : <button type="button" className="btn btn--lime" onClick={() => switchMode('simulation')}>Use the simulation</button>}
      </Shell>
    )
  }
  if (!isSim && (!manifest || !provider || !snapshot)) {
    return (
      <Shell>
        <section className="card setup-card">
          <small className="kicker">Robinhood Chain testnet</small>
          <h1 className="section-title">Connecting to the testnet deployment</h1>
          <div className="tx-progress" role="status"><span className="spinner" aria-hidden="true" /><div><small>Loading</small><strong>{error ?? 'Reading the Rixor contracts on testnet'}</strong></div></div>
          <button type="button" className="text-btn" onClick={() => switchMode('simulation')}>Use the simulation instead</button>
        </section>
      </Shell>
    )
  }
  if (!manifest || !provider || !snapshot || (isSim && !session)) {
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
                <small>{isSim ? 'Simulation' : 'Testnet'}</small>
                <b>{wallet ? shortAddr(wallet.address) : 'Connect'}</b>
              </span>
            </button>
          </div>
        </div>
      </header>

      <div className="container demo-strip" role="note">
        <div className="seg" role="tablist" aria-label="Environment">
          <button type="button" role="tab" aria-selected={isSim} className={isSim ? 'is-active' : ''} onClick={() => switchMode('simulation')}>Simulation</button>
          <button type="button" role="tab" aria-selected={!isSim} className={!isSim ? 'is-active' : ''} disabled={!testnet.deployment} title={testnet.deployment ? undefined : 'Not deployed to testnet yet'} onClick={() => switchMode('testnet')}>Testnet</button>
        </div>
        {isSim
          ? <span>Isolated EVM on this device, started from Robinhood Chain mainnet block {manifest.upstream.forkBlock.toLocaleString('en-US')}. Not live Robinhood Chain. Assets here have no value.{testnet.deployment ? '' : ' Testnet: not deployed yet.'}</span>
          : <span>{manifest.label} Real transactions signed by your wallet on chain {manifest.chainId}. TEST tokens only; "WIF" here means the valueless tWIF.</span>}
      </div>

      <div className="container app-body">
        {isSim && session && !session.persistent && <div className="notice notice--warn"><strong>This browser blocks storage</strong><span>The simulation works, but it resets when you close the page.</span></div>}
        {snapshot.emergencyAt !== 0 && <div className="notice notice--error"><strong>Emergency mode is active</strong><span>Every position can exit immediately without a fee. Running challenges are refundable; settled rewards stay claimable.</span></div>}
        {snapshot.paused && snapshot.emergencyAt === 0 && <div className="notice notice--warn"><strong>Paused</strong><span>New locks, challenges, sponsorships and joins are on hold. Exits, settlement, claims and refunds still work.</span></div>}
        {error && <div className="notice notice--warn"><strong>Showing the last data read</strong><span>{error}</span></div>}
        {notice && <div className={`notice ${notice.kind === 'error' ? 'notice--error' : ''}`} role="status"><span>{notice.text}</span></div>}
        {isSim && wallet && holdsNothing && snapshot.positions.length === 0 && (
          <div className="empty empty--action">
            <div><strong>Your demo wallet is empty</strong><span>Get demo {manifest.tokens.map((t) => t.symbol).join(' and ')} to lock, plus demo WIF for sponsoring. Nothing real is spent or deposited.</span></div>
            <button type="button" className="btn btn--lime btn--sm" disabled={working !== null} onClick={() => void fund()}>{working === 'faucet' ? 'Funding…' : 'Get demo tokens'}</button>
          </div>
        )}

        {!isSim && wallet && holdsNothing && snapshot.positions.length === 0 && (
          <div className="empty empty--action">
            <div><strong>No TEST tokens yet</strong><span>Each TEST token has a public faucet (once per day per address). They are valueless and exist only on testnet. You need a little testnet ETH for gas.</span></div>
            <button type="button" className="btn btn--lime btn--sm" disabled={tx.busy} onClick={() => void testFaucet()}>Get TEST tokens</button>
          </div>
        )}
        {!isSim && <TxNotice tx={tx.tx} for="faucet" />}

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

      {walletOpen && !isSim && (
        <Sheet id="wallet-title" kicker="Robinhood Chain testnet" title={wallet ? 'Your wallet' : 'Connect'} onClose={() => setWalletOpen(false)}>
          {wallet ? (
            <>
              <div className="wallet-identity">
                <span className="dot-live" />
                <div>
                  <small>{browserWallet?.name ?? 'Browser wallet'} · chain {manifest.chainId}</small>
                  <strong className="mono">{shortAddr(wallet.address)}</strong>
                  <span>{snapshot.tokens.map((t) => `${fmtToken(t.balance, t.decimals, { compact: true })} ${t.symbol}`).join(' · ')} · {fmtToken(snapshot.wif.balance, 18, { compact: true })} tWIF · {fmtToken(snapshot.ethBalance, 18)} ETH for gas</span>
                </div>
              </div>
              <div className="notice"><strong>Testnet only</strong><span>Every transaction is signed by your wallet on Robinhood Chain testnet. TEST tokens have no value. Your wallet estimates gas; Rixor never sets gas limits.</span></div>
              <div className="sheet-section">
                <small className="kicker">TEST token faucets · one claim per token per day</small>
                <button type="button" className="btn btn--lime btn--block" disabled={tx.busy || faucetTargets.every((t) => faucetNext[t.address])} onClick={() => void testFaucet()}>Get all available TEST tokens</button>
                <dl className="rows">
                  {faucetTargets.map((t) => (
                    <div key={t.address}>
                      <dt>{t.symbol}</dt>
                      <dd>{faucetNext[t.address]
                        ? <>Next at {fmtDate(faucetNext[t.address])}</>
                        : <button type="button" className="text-btn" disabled={tx.busy} onClick={() => void testFaucet(t.address)}>Get {t.symbol}</button>}</dd>
                    </div>
                  ))}
                </dl>
                <p className="fine-print">Gas is paid in Robinhood Chain testnet ETH, which Rixor does not provide.</p>
                <TxNotice tx={tx.tx} for="faucet" />
              </div>
              <div className="sheet-section">
                <small className="kicker">Deployment</small>
                <dl className="rows">
                  <div><dt>Network</dt><dd>{manifest.upstream.name} (chain {manifest.chainId})</dd></div>
                  <div><dt>Locker</dt><dd className="mono">{shortAddr(manifest.contracts.locker)}</dd></div>
                  <div><dt>Rewards</dt><dd className="mono">{shortAddr(manifest.contracts.rewards)}</dd></div>
                  <div><dt>Challenges</dt><dd className="mono">{shortAddr(manifest.contracts.challenges)}</dd></div>
                  <div><dt>Owner / guardian Safe</dt><dd className="mono">{shortAddr(manifest.contracts.ownerSafe)} / {shortAddr(manifest.contracts.guardianSafe)}</dd></div>
                </dl>
              </div>
              <div className="sheet-actions">
                <button type="button" className="btn btn--ghost" onClick={() => { setWallet(null); setBrowserWallet(null); safeStorage.remove('rixor.testnet.connected') }}>Disconnect</button>
                <button type="button" className="btn btn--dark" onClick={() => setWalletOpen(false)}>Done</button>
              </div>
            </>
          ) : (
            <>
              <p className="figure-sub">Connect your own browser wallet on Robinhood Chain testnet. Rixor asks your wallet to switch networks if needed, and never asks for your keys or seed phrase.</p>
              <div className="sheet-section">
                <button type="button" className="btn btn--lime btn--block btn--lg" disabled={working !== null} onClick={() => void connectBrowser()}>{working === 'connect' ? 'Connecting…' : 'Connect wallet'}</button>
              </div>
              <p className="fine-print">Testnet transactions use test ETH for gas and valueless TEST tokens. Never send real assets to testnet addresses.</p>
            </>
          )}
        </Sheet>
      )}

      {walletOpen && isSim && session && (
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
