import { useMemo, useRef, useState } from 'react'

export default function App() {
  const [lightMode, setLightMode] = useState(false)
  const [amount, setAmount] = useState('1000')
  const [plan, setPlan] = useState<'flexible' | 'locked'>('flexible')
  const savingsPanelRef = useRef<HTMLElement>(null)
  const apy = plan === 'flexible' ? 3.8 : 6.8
  const projected = useMemo(() => {
    const parsed = Number(amount.replace(/,/g, '')) || 0
    return (parsed * apy) / 100
  }, [amount, apy])

  const focusSavingsPanel = () => {
    savingsPanelRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })

    window.setTimeout(() => {
      savingsPanelRef.current?.focus({ preventScroll: true })
    }, 550)
  }

  const scrollToHowItWorks = () => {
    document.getElementById('how-it-works')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  const actionArrow = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 74 74"
      height="34"
      width="34"
      aria-hidden="true"
    >
      <circle strokeWidth="3" stroke="currentColor" r="35.5" cy="37" cx="37" />
      <path
        fill="currentColor"
        d="M25 35.5C24.1716 35.5 23.5 36.1716 23.5 37C23.5 37.8284 24.1716 38.5 25 38.5V35.5ZM49.0607 38.0607C49.6464 37.4749 49.6464 36.5251 49.0607 35.9393L39.5147 26.3934C38.9289 25.8076 37.9792 25.8076 37.3934 26.3934C36.8076 26.9792 36.8076 27.9289 37.3934 28.5147L45.8787 37L37.3934 45.4853C36.8076 46.0711 36.8076 47.0208 37.3934 47.6066C37.9792 48.1924 38.9289 48.1924 39.5147 47.6066L49.0607 38.0607ZM25 38.5L48 38.5V35.5L25 35.5V38.5Z"
      />
    </svg>
  )

  return (
    <main
      className={`carbon-stage ${lightMode ? 'light-mode' : 'dark-mode'}`}
      aria-label="Rixor theme background preview"
    >
      <div className="carbon-layer carbon-base" aria-hidden="true" />
      <div className="carbon-layer carbon-spotlight" aria-hidden="true" />
      <div className="carbon-layer carbon-vignette" aria-hidden="true" />
      <div className="carbon-layer carbon-grain" aria-hidden="true" />

      <header className="top-shell">
        <div className="tab-container" aria-label="Primary navigation">
          <input type="radio" name="tab" id="tab1" className="tab tab--1" defaultChecked />
          <label className="tab_label" htmlFor="tab1" onClick={focusSavingsPanel}>Save</label>

          <input type="radio" name="tab" id="tab2" className="tab tab--2" />
          <label className="tab_label" htmlFor="tab2" onClick={scrollToHowItWorks}>How it works</label>

          <input type="radio" name="tab" id="tab3" className="tab tab--3" />
          <label className="tab_label" htmlFor="tab3">Plans</label>

          <input type="radio" name="tab" id="tab4" className="tab tab--4" />
          <label className="tab_label" htmlFor="tab4">Security</label>

          <div className="indicator" />
        </div>

        <div className="theme-toggle-wrap">
          <label className="switch" aria-label={lightMode ? 'Switch to dark mode' : 'Switch to light mode'}>
            <input
              type="checkbox"
              className="checkbox"
              checked={lightMode}
              onChange={(event) => setLightMode(event.target.checked)}
            />
            <div className="slider" />
          </label>
        </div>
      </header>

      <section className="hero-copy-shell" aria-labelledby="hero-title">
        <div className="hero-layout">
          <div className="hero-copy">
          <div className="hero-kicker hero-enter hero-enter--1">ONCHAIN SAVINGS</div>

          <h1 id="hero-title" className="hero-title">
            <span className="hero-line hero-line--one hero-bounce hero-bounce--1">MAKE ROOM</span>
            <span className="hero-line hero-line--two hero-bounce hero-bounce--2">FOR MORE<span className="hero-period">.</span></span>
          </h1>

          <div className="hero-bottom-row hero-enter hero-enter--3">
            <p className="hero-description">
              Save in USDG with flexible access or lock in longer for higher returns.
            </p>

            <div className="hero-actions">
              <button className="hero-primary" type="button" onClick={focusSavingsPanel}>
                <span>Start saving</span>
                {actionArrow}
              </button>
              <button className="hero-secondary" type="button" onClick={scrollToHowItWorks}>
                <span>How it works</span>
                {actionArrow}
              </button>
            </div>
          </div>
          </div>

          <div className="hero-ball-flight" aria-hidden="true">
            <div className="hero-ball hero-ball--1" />
            <div className="hero-ball hero-ball--2" />
            <div className="hero-ball hero-ball--3" />
            <div className="hero-ball-shadow hero-ball-shadow--1" />
            <div className="hero-ball-shadow hero-ball-shadow--2" />
            <div className="hero-ball-shadow hero-ball-shadow--3" />
          </div>

          <aside
            ref={savingsPanelRef}
            className="savings-panel savings-panel--reveal"
            aria-label="Rixor savings preview"
            tabIndex={-1}
          >
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">SAVE USDG</span>
                <h2>Choose your plan</h2>
              </div>
              <span className="panel-chip">USDG</span>
            </div>

            <div className="amount-block">
              <label htmlFor="save-amount">Amount</label>
              <div className="amount-input-row">
                <span className="currency">$</span>
                <input
                  id="save-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                />
              </div>
              <span className="balance-line">Balance: 0.00 USDG</span>
            </div>

            <div className="plan-cards">
              <button type="button" className={`plan-card ${plan === 'flexible' ? 'active' : ''}`} onClick={() => setPlan('flexible')}>
                <span>Flexible</span>
                <strong>3.8% APY</strong>
                <small>Withdraw anytime</small>
              </button>
              <button type="button" className={`plan-card ${plan === 'locked' ? 'active' : ''}`} onClick={() => setPlan('locked')}>
                <span>Locked</span>
                <strong>6.8% APY</strong>
                <small>Higher return</small>
              </button>
            </div>

            <div className="earnings-row">
              <span>Estimated earnings</span>
              <strong>+{projected.toFixed(2)} USDG / year</strong>
            </div>

            <button className="connect-wallet" type="button">
              <span>Connect Wallet</span>
            </button>
          </aside>
        </div>
      </section>

      <section id="how-it-works" className="how-section" aria-labelledby="how-title">
        <div className="how-heading">
          <span className="how-kicker">HOW RIXOR WORKS</span>
          <h2 id="how-title">One balance. Your timeline.</h2>
          <p>
            Bring funds in from the wallet you already use, convert them into a single USDG
            savings balance, then choose how long you want that money to work.
          </p>
        </div>

        <div className="how-grid">
          <article className="how-card how-card--connect" tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">01</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Connect</h3>
              <p className="how-card-lead">Start with the wallet you already have.</p>
              <p className="how-card-more">
                Connect an EVM or Solana wallet and sign a simple ownership message. Rixor
                reads your public address only — never your seed phrase or private key.
              </p>
            </div>
            <div className="how-visual how-visual--wallet" aria-hidden="true">
              <div className="wallet-shell">
                <span className="wallet-mark">R</span>
                <span className="wallet-line wallet-line--wide" />
                <span className="wallet-line" />
              </div>
              <span className="wallet-pulse" />
            </div>
          </article>

          <article className="how-card how-card--convert" tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">02</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Convert</h3>
              <p className="how-card-lead">Different assets in. One savings balance out.</p>
              <p className="how-card-more">
                Supported deposits are valued and brought into one USDG-denominated balance,
                so your savings stay simple even when the funds came from different networks.
              </p>
            </div>
            <div className="how-visual how-visual--convert" aria-hidden="true">
              <div className="asset-stack">
                <span>ETH</span>
                <span>SOL</span>
                <span>USDC</span>
              </div>
              <span className="flow-line" />
              <div className="usdg-orb">USDG</div>
            </div>
          </article>

          <article className="how-card how-card--choose how-card--wide" tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">03</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Choose</h3>
              <p className="how-card-lead">Flexible when you need it. Locked when you don’t.</p>
              <p className="how-card-more">
                Keep funds accessible with Flexible savings, or choose a fixed term when
                you’re comfortable committing for longer. You review the amount, term and
                illustrative rate before anything moves.
              </p>
            </div>
            <div className="how-visual how-visual--plans" aria-hidden="true">
              <div className="mini-plan mini-plan--active">
                <span>Flexible</span>
                <strong>3.8%</strong>
              </div>
              <div className="mini-plan">
                <span>90 days</span>
                <strong>6.8%</strong>
              </div>
            </div>
          </article>

          <article className="how-card how-card--track" tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">04</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Track</h3>
              <p className="how-card-lead">Know what your money is doing.</p>
              <p className="how-card-more">
                Follow plan balances, earnings, maturity dates and activity from one place.
                Locked plans show the time remaining; Flexible plans stay available.
              </p>
            </div>
            <div className="how-visual how-visual--track" aria-hidden="true">
              <div className="track-meta">
                <span>Travel fund</span>
                <strong>1,000 USDG</strong>
              </div>
              <div className="track-bar"><span /></div>
              <div className="track-foot">
                <span>42 days left</span>
                <span>+34.20</span>
              </div>
            </div>
          </article>

          <article className="how-card how-card--review" tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">05</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Review</h3>
              <p className="how-card-lead">Review first. Confirm second.</p>
              <p className="how-card-more">
                Before a money-moving action is confirmed, Rixor shows the important details
                in plain language so you know exactly what you’re agreeing to.
              </p>
            </div>
            <div className="how-visual how-visual--review" aria-hidden="true">
              <div className="review-sheet">
                <span>90-day plan</span>
                <strong>1,000 USDG</strong>
                <div className="review-row"><span>Rate</span><b>6.8%</b></div>
                <div className="review-confirm">Confirm plan</div>
              </div>
            </div>
          </article>
        </div>

        <div className="how-close">
          <span>Built for saving, not watching charts.</span>
          <p>Put money aside, choose a timeline, and keep the progress clear.</p>
        </div>
      </section>
    </main>
  )
}
