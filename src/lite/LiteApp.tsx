// Rixor Lite: the whole hackathon demo on one page. Connect → lock HOOKR → earn $WIF → claim (→ exit).
// Real transactions on Robinhood Chain mainnet, signed by the visitor's own wallet. All reads and checks live in
// ./lite.ts; this file is UI. The page never holds a key and never sets a gas limit (the wallet estimates gas).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BrowserProvider, Contract, formatUnits, type ContractTransactionResponse, type Eip1193Provider, type Signer } from 'ethers'
import { icon } from '../ui'
import { Brand } from '../protocol/components'
import { fmtDate, fmtDuration, fmtToken, parseAmount, shortAddr } from '../protocol/model'
import { discoverWallets, requestAccount, switchToChain, type WalletOption } from '../protocol/wallet'
import { CHAIN, ERC20_ABI, LITE_ABI, PLAN, TOKEN, WIF, describeLiteError, earnedNow, loadDeployment, provider as makeProvider, readState, verifyDeployment, type Deployment, type LiteState } from './lite'
import '../protocol/protocol.css'

type Tx = { key: string; status: 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'; step: string; hash?: string; error?: string }
type Receipt = { label: string; hash: string }
const E18 = 10n ** 18n
const whole = (v: bigint) => (v / E18).toLocaleString('en-US')
const explorerTx = (hash: string) => `${CHAIN.explorer}/tx/${hash}`
const explorerAddr = (a: string) => `${CHAIN.explorer}/address/${a}`
/** "1 day", "7 days", "12 hours": plain words for the fixed periods of the plan. */
const plainPeriod = (seconds: bigint) => { const h = Number(seconds) / 3600; return h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}` }
const LOCK_PERIOD = plainPeriod(PLAN.lockSeconds)
const DAILY = (PLAN.budget / PLAN.durationSeconds) * 86_400n
/** WIF with enough decimals to see it grow second by second. */
const fmtWif = (v: bigint) => { const s = formatUnits(v, 18); const [a, b = ''] = s.split('.'); return `${Number(a).toLocaleString('en-US')}.${(b + '0000').slice(0, 4)}` }

function AddressRow({ label, address }: { label: string; address: string }) {
  return <div><dt>{label}</dt><dd><a className="mono" href={explorerAddr(address)} target="_blank" rel="noopener noreferrer">{shortAddr(address)}</a></dd></div>
}

const DEMO_PAGES = [
  { hash: '#/explore', icon: 'trophy', title: 'Campaigns and challenges', body: 'Communities pool $WIF for holders who keep their lock.' },
  { hash: '#/lock', icon: 'lock', title: 'Token listings and tiers', body: 'More meme tokens, with Flexible, Committed and Diamond locks.' },
  { hash: '#/portfolio', icon: 'diamond', title: 'Portfolio dashboard', body: 'Positions, claims and refunds in one place.' },
  { hash: '#/activity', icon: 'clock', title: 'Activity feed', body: 'Every lock, claim and challenge as it happens.' },
] as const

/** `envSwitch`: the Live / Demo switch from src/Root.tsx. `goDemo`: opens a page of the demo side. */
export default function LiteApp({ envSwitch, goDemo }: { envSwitch?: ReactNode; goDemo?: (hash: string) => void } = {}) {
  const rpc = useMemo(makeProvider, [])
  const [deployment, setDeployment] = useState<Deployment | null | undefined>(undefined)
  const [bootError, setBootError] = useState<string | null>(null)
  const [state, setState] = useState<LiteState | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [walletOption, setWalletOption] = useState<WalletOption | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [signer, setSigner] = useState<Signer | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [tx, setTx] = useState<Tx | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [amountText, setAmountText] = useState('')
  const [tick, setTick] = useState(() => Date.now())
  const accountRef = useRef<string | null>(null)
  accountRef.current = account
  const busy = tx?.status === 'awaiting-wallet' || tx?.status === 'pending'

  // Published deployment → verified against the chain before anything is shown.
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const d = await loadDeployment()
        if (d) await verifyDeployment(rpc, d)
        if (live) setDeployment(d)
      } catch (e) { if (live) { setDeployment(null); setBootError(e instanceof Error ? e.message : String(e)) } }
    })()
    return () => { live = false }
  }, [rpc])

  const refresh = useCallback(async () => {
    if (!deployment) return
    try { setState(await readState(rpc, deployment, accountRef.current)); setReadError(null) } catch (e) { setReadError(e instanceof Error ? e.message.slice(0, 160) : String(e)) }
  }, [rpc, deployment])
  useEffect(() => {
    if (!deployment) return
    void refresh()
    const id = window.setInterval(() => void refresh(), 12_000)
    return () => window.clearInterval(id)
  }, [deployment, account, refresh])
  useEffect(() => { const id = window.setInterval(() => setTick(Date.now()), 250); return () => window.clearInterval(id) }, [])

  // Any account or network change disconnects, so nothing is ever signed for a stale account or the wrong chain.
  useEffect(() => {
    const p = walletOption?.provider
    if (!p?.on) return
    const drop = () => { setAccount(null); setSigner(null); setWalletOption(null); setNotice('Your wallet changed account or network. Connect again to continue.') }
    p.on('accountsChanged', drop)
    p.on('chainChanged', drop)
    return () => { p.removeListener?.('accountsChanged', drop); p.removeListener?.('chainChanged', drop) }
  }, [walletOption])

  const connect = async () => {
    setConnecting(true)
    setNotice(null)
    try {
      const options = await discoverWallets()
      if (!options.length) throw new Error('No wallet found. Open this page in your wallet app\'s browser.')
      const option = options[0]
      let acc = await requestAccount(option)
      if (acc.chainId !== CHAIN.chainId) {
        await switchToChain(option, { chainId: CHAIN.chainId, name: CHAIN.name, rpc: CHAIN.rpc })
        acc = await requestAccount(option)
        if (acc.chainId !== CHAIN.chainId) throw new Error('Your wallet is not on Robinhood Chain.')
      }
      // Bound to chain 4663: ethers refuses to send if the wallet is on any other network.
      const s = await new BrowserProvider(option.provider as unknown as Eip1193Provider, CHAIN.chainId).getSigner(acc.address)
      setWalletOption(option); setSigner(s); setAccount(await s.getAddress())
    } catch (e) { setNotice(describeLiteError(e)) } finally { setConnecting(false) }
  }
  const disconnect = () => { setAccount(null); setSigner(null); setWalletOption(null) }

  const run = async (key: string, steps: { label: string; send: () => Promise<ContractTransactionResponse> }[], done: string) => {
    let last: string | undefined
    try {
      for (const step of steps) {
        setTx({ key, status: 'awaiting-wallet', step: step.label })
        const sent = await step.send()
        last = sent.hash
        setTx({ key, status: 'pending', step: step.label, hash: sent.hash })
        const rc = await sent.wait()
        if (!rc || rc.status !== 1) throw new Error('The transaction reverted.')
        setReceipts((r) => [{ label: step.label, hash: sent.hash }, ...r].slice(0, 8))
      }
      await refresh()
      setTx({ key, status: 'confirmed', step: done, hash: last })
      return true
    } catch (e) {
      setTx({ key, status: 'failed', step: done, hash: last, error: describeLiteError(e) })
      await refresh()
      return false
    }
  }

  // ---------------------------------------------------------------- render

  // The rest of the product, as a labelled demo. Shown under the live page (also before the contract is deployed).
  const demoCard = goDemo && (
    <section className="card view">
      <header className="panel-head"><div><small className="kicker">The rest of Rixor</small><h2>Explore the full product</h2></div><span className="tag tag--sim">Demo</span></header>
      <p className="figure-sub" style={{ marginTop: 0 }}>These pages run in a simulation on your device with demo tokens. They show where Rixor is going. Nothing in them is onchain, and they never use your wallet.</p>
      <ul className="token-list">
        {DEMO_PAGES.map((d) => (
          <li key={d.hash}>
            <button type="button" className="token-line" onClick={() => goDemo(d.hash)}>
              <span className="token-mark" style={{ background: 'var(--surface-2)', color: 'var(--ink)' }}>{icon(d.icon, 18)}</span>
              <span className="token-line-copy"><strong>{d.title}</strong><span>{d.body}</span></span>
              <span className="token-line-side">{icon('arrowRight', 18)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )

  // Plain functions, not components: a component created during render would remount (and reset inputs) every tick.
  const shell = (children: ReactNode) => (
    <main className="app dashboard theme-dark">
      <header className="app-bar">
        <div className="container app-bar-inner">
          <Brand />
          <div className="app-bar-actions">
            <button className="wallet-btn" type="button" onClick={() => (account ? disconnect() : void connect())} disabled={connecting || !deployment} title={account ? 'Disconnect' : undefined}>
              <span className="dot-live" />
              <span className="wallet-btn-copy"><small>Robinhood Chain</small><b>{account ? shortAddr(account) : connecting ? 'Connecting…' : 'Connect'}</b></span>
            </button>
          </div>
        </div>
      </header>
      {envSwitch && <div className="container env-switch">{envSwitch}</div>}
      <div className="container app-body">{children}{demoCard}</div>
    </main>
  )
  const plan = (
    <dl className="rows">
      <div><dt>Lock</dt><dd>{TOKEN.symbol}, held for {LOCK_PERIOD} per lock</dd></div>
      <div><dt>Rewards</dt><dd>{whole(PLAN.budget)} WIF over {Number(PLAN.durationSeconds) / 86_400} days, shared by everyone locked</dd></div>
      <div><dt>Minimum / total cap</dt><dd>{whole(PLAN.minLock)} / {whole(PLAN.cap)} {TOKEN.symbol}</dd></div>
    </dl>
  )

  if (deployment === undefined) {
    return shell(<section className="card"><div className="tx-progress" role="status"><span className="spinner" aria-hidden="true" /><div><small>Loading</small><strong>Reading and verifying the contract on Robinhood Chain</strong></div></div></section>)
  }
  if (deployment === null) {
    return shell(
        <section className="card view">
          <small className="kicker">Robinhood Chain mainnet · real $WIF</small>
          <h1 className="section-title">Lock {TOKEN.symbol}. Earn $WIF.</h1>
          {bootError
            ? <div className="notice notice--error" role="alert"><strong>Deployment refused</strong><span>{bootError}</span></div>
            : <div className="notice notice--warn"><strong>Not deployed yet</strong><span>The RixorLite contract is not live on Robinhood Chain yet. This page turns on by itself once the deployment is published and verified on chain.</span></div>}
          {plan}
        </section>,
    )
  }

  const s = state
  const u = s?.user ?? null
  const now = s ? s.now + Math.floor((tick - s.readAt) / 1000) : 0
  const ended = s ? now >= s.endTime : false
  const earned = s ? earnedNow(s, tick) : 0n
  const unlockIn = u && u.locked > 0n ? u.unlockAt - now : 0
  const amount = parseAmount(amountText, TOKEN.decimals)
  const room = s ? PLAN.cap - s.totalLocked : 0n
  const lockProblem = !u || amount === null ? null
    : amount === 0n ? null
      : u.locked + amount < PLAN.minLock ? `Minimum is ${whole(PLAN.minLock)} ${TOKEN.symbol}.`
        : amount > u.tokenBalance ? `You have ${fmtToken(u.tokenBalance, TOKEN.decimals)} ${TOKEN.symbol}.`
          : amount > room ? `Only ${fmtToken(room, TOKEN.decimals)} ${TOKEN.symbol} fits under the cap.`
            : null
  const canLock = Boolean(signer && u && amount && amount > 0n && !lockProblem && !ended && !busy)
  const setAmount = (v: bigint) => setAmountText(formatUnits(v, TOKEN.decimals).replace(/\.0$/, ''))

  const doLock = async () => {
    if (!signer || !u || !amount) return
    const token = new Contract(TOKEN.address, ERC20_ABI, signer)
    const lite = new Contract(deployment.lite, LITE_ABI, signer)
    const label = `${fmtToken(amount, TOKEN.decimals)} ${TOKEN.symbol}`
    const steps = [
      // Exact approval: only the amount being locked, only for this contract.
      ...(u.tokenAllowance < amount ? [{ label: `Approve ${label}`, send: () => token.approve(deployment.lite, amount) as Promise<ContractTransactionResponse> }] : []),
      { label: `Lock ${label}`, send: () => lite.lock(amount) as Promise<ContractTransactionResponse> },
    ]
    if (await run('lock', steps, `Locked ${label}`)) setAmountText('')
  }
  const doClaim = () => signer && run('claim', [{ label: 'Claim WIF', send: () => new Contract(deployment.lite, LITE_ABI, signer).claim() as Promise<ContractTransactionResponse> }], 'Claimed WIF')
  const doExit = () => signer && u && run('exit', [{ label: `Exit ${fmtToken(u.locked, TOKEN.decimals)} ${TOKEN.symbol}`, send: () => new Contract(deployment.lite, LITE_ABI, signer).exit() as Promise<ContractTransactionResponse> }], `Exited ${TOKEN.symbol}`)

  const txNote = (key: string) => {
    if (!tx || tx.key !== key) return null
    if (tx.status === 'failed') return <div className="notice notice--error" role="alert"><strong>Not completed</strong><span>{tx.error}</span></div>
    if (tx.status === 'confirmed') {
      return (
        <div className="receipt">
          <span className="receipt-check">{icon('check', 22)}</span>
          <span className="receipt-copy"><small>Confirmed on Robinhood Chain</small><strong>{tx.step}</strong></span>
          {tx.hash && <a className="receipt-link" href={explorerTx(tx.hash)} target="_blank" rel="noopener noreferrer">{shortAddr(tx.hash)}</a>}
        </div>
      )
    }
    return <div className="tx-progress" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><div><small>{tx.status === 'awaiting-wallet' ? 'Approve in your wallet' : 'Waiting for Robinhood Chain'}</small><strong>{tx.step}</strong></div></div>
  }

  return shell(
    <>
      <section className="card view">
        <small className="kicker"><span className="tag tag--lime">Live · onchain</span> Robinhood Chain mainnet · real $WIF</small>
        <h1 className="section-title">Lock {TOKEN.symbol}. Earn $WIF.</h1>
        <p className="figure-sub" style={{ marginTop: 0 }}>Lock the {TOKEN.symbol} you already hold for {LOCK_PERIOD}. Earn $WIF every second while it is locked, and claim whenever you like.</p>
        <div className="stat-grid">
          <div className="stat"><small>Locked now</small><strong>{s ? fmtToken(s.totalLocked, TOKEN.decimals, { compact: true }) : '…'} <em>{TOKEN.symbol}</em></strong><span>cap {whole(PLAN.cap)}</span></div>
          <div className="stat"><small>Reward rate</small><strong>{fmtToken(DAILY, 18, { compact: true })} <em>WIF / day</em></strong><span>shared by everyone locked</span></div>
          <div className="stat"><small>Reward wallet</small><strong>{s ? fmtToken(s.rewardsAvailable, 18, { compact: true }) : '…'} <em>WIF</em></strong><span>ready to pay out</span></div>
          <div className="stat"><small>Rewards end</small><strong>{s ? (ended ? 'Ended' : fmtDuration(s.endTime - now)) : '…'}</strong><span>{s ? fmtDate(s.endTime) : ''}</span></div>
        </div>
        {notice && <div className="notice notice--warn" role="status"><span>{notice}</span></div>}
        {readError && <div className="notice notice--warn"><strong>Showing the last data read</strong><span>{readError}</span></div>}
        {s && ended && <div className="notice notice--warn"><strong>The reward period has ended</strong><span>New locks are closed. You can still claim what you earned and exit.</span></div>}
        {s && !ended && s.rewardsAvailable === 0n && <div className="notice notice--warn"><strong>The reward wallet is empty</strong><span>Claims are on hold until it is refilled. What you earn is still recorded, and exits are never affected.</span></div>}
        {!account && <button type="button" className="btn btn--lime btn--block btn--lg" disabled={connecting} onClick={() => void connect()}>{connecting ? 'Connecting…' : 'Connect wallet'}</button>}
      </section>

      {account && u && (
        <section className="card view">
          <header className="panel-head"><div><small className="kicker">Your position · read from the chain</small><h2>{u.locked > 0n ? `${fmtToken(u.locked, TOKEN.decimals)} ${TOKEN.symbol} locked` : 'Nothing locked yet'}</h2></div></header>
          <div>
            <small className="kicker">WIF earned</small>
            <div className="figure figure--xl" data-testid="earned" style={{ color: 'var(--lime)' }}>{fmtWif(earned)}</div>
            <span className="figure-sub">{u.locked > 0n && s && s.totalLocked > 0n && !ended ? `≈ ${fmtToken((DAILY * u.locked) / s.totalLocked, 18)} WIF per day at your current share` : 'Lock to start earning'} · {fmtToken(u.wifBalance, 18)} WIF in your wallet</span>
          </div>
          <button type="button" className="btn btn--lime btn--block btn--lg" disabled={busy || earned === 0n} onClick={() => void doClaim()}>Claim WIF</button>
          {txNote('claim')}
          {u.locked > 0n && (
            <>
              <dl className="rows">
                <div><dt>Lock period</dt><dd>{unlockIn > 0 ? `Unlocks in ${fmtDuration(unlockIn)} (${fmtDate(u.unlockAt)})` : 'Finished: you can exit'}</dd></div>
              </dl>
              <button type="button" className="btn btn--ghost btn--block" disabled={busy || unlockIn > 0} onClick={() => void doExit()}>{unlockIn > 0 ? `Exit available in ${fmtDuration(unlockIn)}` : `Exit ${fmtToken(u.locked, TOKEN.decimals)} ${TOKEN.symbol}`}</button>
            </>
          )}
          {txNote('exit')}
        </section>
      )}

      {account && u && (
        <section className="card view">
          <header className="panel-head"><div><small className="kicker">Lock</small><h2>{u.locked > 0n ? `Add more ${TOKEN.symbol}` : `Lock ${TOKEN.symbol}`}</h2></div></header>
          <div className={`amount-input ${lockProblem ? 'is-error' : ''}`}>
            <input id="lock-amount" inputMode="decimal" autoComplete="off" placeholder="0" aria-label={`Amount of ${TOKEN.symbol} to lock`} value={amountText} onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ''))} />
            <span>{TOKEN.symbol}</span>
          </div>
          <div className="chip-row">
            <button type="button" className="chip" onClick={() => setAmount(PLAN.minLock)}>Min {whole(PLAN.minLock)}</button>
            <button type="button" className="chip" onClick={() => setAmount(50n * E18)}>50</button>
            <button type="button" className="chip" disabled={u.tokenBalance === 0n} onClick={() => setAmount(u.tokenBalance < room ? u.tokenBalance : room)}>Max</button>
          </div>
          <span className="figure-sub" style={{ marginTop: 0 }}>{fmtToken(u.tokenBalance, TOKEN.decimals)} {TOKEN.symbol} in your wallet · {fmtToken(u.eth, 18)} ETH for gas</span>
          {lockProblem && <div className="field-error">{lockProblem}</div>}
          <button type="button" className="btn btn--lime btn--block btn--lg" disabled={!canLock} onClick={() => void doLock()}>Lock {TOKEN.symbol}</button>
          {txNote('lock')}
          <p className="fine-print">Each lock or top-up is held for {LOCK_PERIOD}; a top-up restarts that period for your whole balance. You approve only the exact amount you lock. Rixor never sells or swaps tokens.</p>
        </section>
      )}

      {receipts.length > 0 && (
        <section className="card view">
          <header className="panel-head"><div><small className="kicker">This session</small><h2>Your transactions</h2></div></header>
          <dl className="rows">{receipts.map((r) => <div key={r.hash}><dt>{r.label}</dt><dd><a className="mono" href={explorerTx(r.hash)} target="_blank" rel="noopener noreferrer">{shortAddr(r.hash)}</a></dd></div>)}</dl>
        </section>
      )}

      <section className="card view">
        <header className="panel-head"><div><small className="kicker">How it works</small><h2>One contract, nothing hidden</h2></div></header>
        <dl className="rows">
          <AddressRow label="RixorLite contract" address={deployment.lite} />
          <AddressRow label={`${TOKEN.symbol} (locked token)`} address={TOKEN.address} />
          <AddressRow label="$WIF (reward token)" address={WIF.address} />
          <AddressRow label="Reward wallet" address={deployment.rewardWallet} />
          <div><dt>WIF paid out so far</dt><dd>{s ? fmtToken(s.totalClaimed, 18) : '…'} WIF</dd></div>
          <div><dt>All activity</dt><dd><a href={explorerAddr(deployment.lite)} target="_blank" rel="noopener noreferrer">Every lock, claim and exit on the explorer</a></dd></div>
        </dl>
        {plan}
        <p className="fine-print">
          Only the wallet that locked a token can withdraw it. The contract has no owner, no admin, no pause and no upgrade path, and it never holds WIF: each claim moves WIF from the reward wallet straight to you.
          The reward wallet can stop funding rewards, but it can never touch a locked token, and exits never depend on it.
        </p>
        <p className="fine-print">Tested, not audited. $WIF carries no promise of value or return. Rixor is not affiliated with Robinhood Markets, Inc.</p>
      </section>
    </>,
  )
}
