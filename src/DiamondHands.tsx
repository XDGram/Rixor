import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { icon } from './ui'
import { ROBINHOOD_MAINNET, WIF_ADDRESS, explorerAddress, shortAddr, useWifBalance } from './wif'
import {
  EXIT,
  LOSS_OPTIONS,
  TARGET_OPTIONS,
  TERM_OPTIONS,
  TIERS,
  challengePhase,
  exitPaysRewards,
  exitReasonLabel,
  formatAmount,
  formatBps,
  formatDate,
  formatDuration,
  type ChallengeView,
  type Position,
  type Tier,
  type VaultMode,
} from './vault/model'
import { VAULT_ADDRESS, VAULT_NETWORK, VAULT_USES_MOCK_ORACLE, vaultExplorerAddress, vaultExplorerTx } from './vault/onchain'
import { simulationControls } from './vault/simulation'
import { formatUsdPrice } from './pricing/math'
import { ETH_USDG_V3_POOL, MAINNET_EXPLORER, PONS_WIF_ETH_POOL } from './pricing/sources'
import { useLiveWifPrice } from './pricing/useLiveWifPrice'
import { onchainAvailable, useVault, type TxState } from './vault/useVault'

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

type Props = {
  walletAddress: string | null
  provider: Provider | null
  chainId: number | null
  switching: boolean
  onSwitchNetwork: (chainId: number) => void
}

const roiClass = (roi: number | null) => (roi === null ? '' : roi > 0 ? 'is-gain' : roi < 0 ? 'is-loss' : '')

export default function DiamondHands({ walletAddress, provider, chainId, switching, onSwitchNetwork }: Props) {
  const [mode, setMode] = useState<VaultMode>(onchainAvailable ? 'onchain' : 'simulation')
  const { state, actions, tx, canTransact, onWrongChain } = useVault({ mode, walletAddress, provider, chainId })
  const wif = useWifBalance(walletAddress)
  const market = useLiveWifPrice()
  const simulated = mode === 'simulation'
  const symbol = state.tokenSymbol

  const [tier, setTier] = useState<Tier>(1)
  const [amount, setAmount] = useState('')
  const [termDays, setTermDays] = useState<number>(90)
  const [target, setTarget] = useState<number>(5_000)
  const [maxLoss, setMaxLoss] = useState<number>(3_000)
  const [confirmExit, setConfirmExit] = useState<string | null>(null)
  const [joinChoice, setJoinChoice] = useState<Record<string, string>>({})

  // Diamond Hands always needs a max loss; Committed may run without one.
  useEffect(() => {
    if (tier === 2 && maxLoss === 0) setMaxLoss(3_000)
  }, [tier, maxLoss])

  const parsed = Number(amount || 0)
  const insufficient = parsed > state.walletBalance
  const amountValid = parsed > 0 && !insufficient
  const busy = tx?.status === 'awaiting-wallet' || tx?.status === 'pending'
  const tierMeta = TIERS[tier]
  const accrued = state.positions.reduce((total, position) => total + position.pendingReward, 0)
  const lockedByMe = state.positions.reduce((total, position) => total + position.amount, 0)
  // Decision price: the price the vault (or simulation) uses for ROI and exits. Never the live market display price.
  const priceText = state.price.value === null ? 'unavailable' : formatUsdPrice(state.price.value)

  const submitLock = async () => {
    const ok = await actions.lock({ amount, tier, termDays, roiTargetBps: target, maxLossBps: tier === 0 ? 0 : maxLoss })
    if (ok) setAmount('')
  }

  const renderTx = (key: string) => {
    if (!tx || tx.key !== key) return null
    return <TxNotice tx={tx} />
  }

  const lockButtonLabel = () => {
    if (simulated) return `Lock ${symbol} (simulated)`
    if (!VAULT_ADDRESS) return 'Testnet vault not deployed yet'
    if (!walletAddress) return 'Connect a wallet'
    if (onWrongChain) return `Switch to ${VAULT_NETWORK.name}`
    return `Lock ${symbol} on testnet`
  }

  return (
    <div className="view diamond" key="diamond">
      <section className="diamond-hero">
        <div className="diamond-hero-copy">
          <p className="eyebrow">Diamond Hands · {simulated ? 'Simulation' : VAULT_NETWORK.name}</p>
          <h1>Pick your conviction. Get paid for keeping it.</h1>
          <p>Flexible, Committed or Diamond Hands. Set an ROI target and a max loss, see your live ROI, and earn from everyone who leaves early.</p>
        </div>
        <div className="flywheel-stats">
          <div><small>{symbol} locked</small><strong>{formatAmount(state.stats.totalLocked, true)}</strong></div>
          <div><small>Reward pool so far</small><strong>{formatAmount(state.stats.poolFromFees + state.stats.poolFunded, true)}</strong></div>
          <div><small>Burned by early exits</small><strong>{formatAmount(state.stats.totalBurned, true)}</strong></div>
          <div><small>Commitments completed</small><strong>{state.stats.completedLocks.toLocaleString()}</strong></div>
        </div>
      </section>

      <div className="mode-bar">
        <div className="seg" role="radiogroup" aria-label="Data source">
          <button type="button" role="radio" aria-checked={mode === 'onchain'} className={mode === 'onchain' ? 'is-active' : ''} onClick={() => setMode('onchain')}>
            Testnet
          </button>
          <button type="button" role="radio" aria-checked={simulated} className={simulated ? 'is-active' : ''} onClick={() => setMode('simulation')}>
            Simulation
          </button>
        </div>
        <span className={`tag ${simulated ? 'tag--sim' : 'tag--outline'}`}>
          {simulated ? 'Simulated: no blockchain, no real prices' : VAULT_ADDRESS ? 'Real testnet transactions · test tokens only' : 'Not deployed'}
        </span>
      </div>

      {simulated ? (
        <section className="card sim-panel">
          <div className="sim-panel-copy">
            <strong>This is a simulation running only in your browser.</strong>
            <span>Balances, prices, other holders and challenges are made up so you can try every rule. Nothing is sent to any chain.</span>
          </div>
          <div className="sim-controls">
            <div className="sim-price">
              <small>Simulated decision price (USD)</small>
              <strong>{priceText}</strong>
              <span className={state.price.fresh ? '' : 'is-loss'}>{state.price.fresh ? 'feed live' : 'feed stalled'}</span>
            </div>
            <div className="chip-row">
              <button type="button" className="chip" onClick={() => simulationControls.movePrice(-10)}>Price −10%</button>
              <button type="button" className="chip" onClick={() => simulationControls.movePrice(10)}>Price +10%</button>
              <button type="button" className="chip" onClick={() => simulationControls.advance(1)}>Skip 1 day</button>
              <button type="button" className="chip" onClick={() => simulationControls.advance(7)}>Skip 7 days</button>
              <button type="button" className="chip" onClick={() => simulationControls.toggleFeed()}>{simulationControls.feedStalled() ? 'Resume feed' : 'Stall feed'}</button>
              <button type="button" className="chip" onClick={() => { if (window.confirm('Reset the simulation?')) simulationControls.reset() }}>Reset</button>
            </div>
          </div>
        </section>
      ) : !VAULT_ADDRESS ? (
        <div className="notice notice--warn">
          <strong>The testnet vault is not deployed yet.</strong>
          <span>Real locking turns on once RixorConvictionVault is deployed to {VAULT_NETWORK.name} and its address is configured. Use Simulation to try every feature meanwhile.</span>
        </div>
      ) : (
        <>
          <div className="notice">
            <strong>{VAULT_NETWORK.name} · vault decision price {priceText}</strong>
            <span>
              {state.price.source}.{VAULT_USES_MOCK_ORACLE ? ' ROI and exits use this hand-set test price, not a market price.' : ''}{' '}
              Vault <a href={vaultExplorerAddress(VAULT_ADDRESS)} target="_blank" rel="noreferrer">{shortAddr(VAULT_ADDRESS)}</a>
            </span>
          </div>
          {state.status === 'error' && <div className="notice notice--error"><strong>Could not read the vault.</strong><span>{state.error}</span></div>}
          {walletAddress && onWrongChain && (
            <div className="notice notice--warn notice--action">
              <div><strong>Switch to {VAULT_NETWORK.name}.</strong><span>The vault runs on testnet. No real funds are involved.</span></div>
              <button type="button" className="btn btn--dark btn--sm" onClick={() => onSwitchNetwork(VAULT_NETWORK.id)} disabled={switching}>{switching ? 'Switching…' : 'Switch network'}</button>
            </div>
          )}
        </>
      )}

      <section className="card wif-card">
        <div className="wif-card-balance">
          <small className="kicker">Your $WIF on {ROBINHOOD_MAINNET.name} · live, read-only</small>
          <p className="figure figure--sm">
            {!walletAddress ? '—' : wif.status === 'ready' ? formatAmount(wif.balance) : wif.status === 'error' ? 'Unavailable' : '…'} <em>$WIF</em>
          </p>
          {walletAddress && wif.status === 'ready' && market.data && (
            <span className="figure-sub">≈ {formatUsdPrice(wif.balance * market.data.wifUsd)} at the live market price</span>
          )}
        </div>

        <div className="market-price" aria-live="polite">
          <div className="market-price-head">
            <span className="tag tag--market"><span className="dot-live" /> Live market data</span>
            <span className="tag tag--outline">Display only</span>
          </div>
          {market.status === 'loading' ? (
            <p className="fine-print">Reading Robinhood Chain…</p>
          ) : !market.data ? (
            <p className="fine-print">Live price unavailable right now. {market.error}</p>
          ) : (
            <>
              <div className="market-price-figure">
                <strong>{formatUsdPrice(market.data.wifUsd)}</strong>
                {market.data.change24hUsd !== null ? (
                  <span className={market.data.change24hUsd >= 0 ? 'is-gain' : 'is-loss'}>
                    {market.data.change24hUsd >= 0 ? '▲' : '▼'} {formatBps(Math.round(Math.abs(market.data.change24hUsd) * 100))} 24h
                  </span>
                ) : <span>24h change unavailable</span>}
              </div>
              <dl className="rows">
                <div><dt>WIF / ETH (Pons pool, spot)</dt><dd>{market.data.wifEth.toExponential(4)} ETH</dd></div>
                <div><dt>ETH / USD (30-min TWAP)</dt><dd>{formatUsdPrice(market.data.ethUsd)}</dd></div>
                {market.data.change24hEth !== null && <div><dt>24h in ETH terms</dt><dd>{formatBps(Math.round(market.data.change24hEth * 100), true)}</dd></div>}
                <div><dt>Pool depth (in range)</dt><dd>≈ {formatAmount(market.data.inRangeEth)} ETH per side</dd></div>
                <div><dt>Read at block</dt><dd>{market.data.blockNumber.toLocaleString()} · {new Date(market.data.blockTime * 1000).toLocaleTimeString()}</dd></div>
              </dl>
            </>
          )}
        </div>

        <p className="fine-print wif-card-note">
          Official token <a href={explorerAddress(WIF_ADDRESS)} target="_blank" rel="noreferrer">{shortAddr(WIF_ADDRESS)}</a>, verified onchain.
          Price from the Pons V2 WIF/ETH pool on Uniswap V4 (<a href={`${MAINNET_EXPLORER}/address/${PONS_WIF_ETH_POOL.poolManager}`} target="_blank" rel="noreferrer">PoolManager</a>, pool {shortAddr(PONS_WIF_ETH_POOL.poolId)}),
          converted with the official Uniswap V3 WETH/USDG pool's 30-minute TWAP (<a href={`${MAINNET_EXPLORER}/address/${ETH_USDG_V3_POOL.address}`} target="_blank" rel="noreferrer">{shortAddr(ETH_USDG_V3_POOL.address)}</a>), treating USDG as $1.
          The 24h change compares against the last pool swap before 24 hours ago. This price is never used for vault withdrawals, ROI eligibility or challenge results.
        </p>
      </section>

      <div className="diamond-grid">
        <section className="card lock-card">
          <header className="panel-head">
            <div><small className="kicker">New lock</small><h2>Choose your tier</h2></div>
          </header>

          <div className="term-grid tier-grid" role="radiogroup" aria-label="Tier">
            {TIERS.map((option) => (
              <button key={option.id} type="button" role="radio" aria-checked={tier === option.id} className={`term ${tier === option.id ? 'is-active' : ''}`} onClick={() => setTier(option.id)}>
                <span className="term-top"><strong>{option.name}</strong><em>{option.weightBps / 10_000}x</em></span>
                <small>{option.summary}</small>
              </button>
            ))}
          </div>

          <div className="amount-field">
            <div className="amount-field-head">
              <label htmlFor="vault-amount">Amount</label>
              <span className={insufficient ? 'is-error' : ''}>
                {simulated || walletAddress ? `${formatAmount(state.walletBalance)} ${symbol}${simulated ? ' (simulated)' : ''} available` : 'Connect a wallet'}
              </span>
            </div>
            <div className={`amount-input ${insufficient ? 'is-error' : ''}`}>
              <input id="vault-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} />
              <span>{symbol}</span>
            </div>
            <div className="chip-row">
              {[25, 50, 75, 100].map((percent) => (
                <button key={percent} type="button" className="chip" disabled={state.walletBalance <= 0} onClick={() => setAmount(String(Math.floor(((state.walletBalance * percent) / 100) * 10_000) / 10_000))}>
                  {percent === 100 ? 'Max' : `${percent}%`}
                </button>
              ))}
            </div>
            {insufficient && <div className="field-error">That is more than you have available.</div>}
          </div>

          {tier !== 0 && (
            <div className="commit-fields">
              <div className="commit-field">
                <span>Term (hard backstop)</span>
                <div className="chip-row">
                  {TERM_OPTIONS.map((days) => (
                    <button key={days} type="button" className={`chip ${termDays === days ? 'is-active' : ''}`} onClick={() => setTermDays(days)}>{days === 365 ? '1 year' : `${days} days`}</button>
                  ))}
                </div>
              </div>
              <div className="commit-field">
                <span>ROI target</span>
                <div className="chip-row">
                  {TARGET_OPTIONS.map((bps) => (
                    <button key={bps} type="button" className={`chip ${target === bps ? 'is-active' : ''}`} onClick={() => setTarget(bps)}>{formatBps(bps, true)}</button>
                  ))}
                </div>
              </div>
              <div className="commit-field">
                <span>Max loss {tier === 1 ? '(optional)' : '(required)'}</span>
                <div className="chip-row">
                  {tier === 1 && <button type="button" className={`chip ${maxLoss === 0 ? 'is-active' : ''}`} onClick={() => setMaxLoss(0)}>None</button>}
                  {LOSS_OPTIONS.map((bps) => (
                    <button key={bps} type="button" className={`chip ${maxLoss === bps ? 'is-active' : ''}`} onClick={() => setMaxLoss(bps)}>{formatBps(-bps, true)}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <dl className="rows">
            <div><dt>Reward weight</dt><dd>{tierMeta.weightBps / 10_000}x your amount</dd></div>
            {tier === 0 && <div><dt>Leaving</dt><dd>Any time · up to 1% in the first 7 days</dd></div>}
            {tier === 1 && <div><dt>Leaving early</dt><dd>Up to 10%, falling to 0% over {termDays} days</dd></div>}
            {tier === 1 && <div><dt>Free exit when</dt><dd>{formatBps(target, true)} reached{maxLoss ? `, ${formatBps(-maxLoss, true)} hit` : ''} or term ends</dd></div>}
            {tier === 2 && <div><dt>Withdrawal opens</dt><dd>At {formatBps(target, true)}, at {formatBps(-maxLoss, true)}, or after {termDays} days</dd></div>}
            <div><dt>Rewards</dt><dd>Paid when the commitment completes</dd></div>
          </dl>

          {renderTx('lock')}
          <button type="button" className="btn btn--lime btn--block btn--lg" disabled={!canTransact || !amountValid || busy} onClick={() => void submitLock()}>
            {lockButtonLabel()}
          </button>
          {!simulated && canTransact && <p className="fine-print">If needed, your wallet first asks to approve the amount, then to lock it.</p>}
        </section>

        <section className="card list-card my-locks">
          <header className="panel-head">
            <div><small className="kicker">Your positions</small><h2>{formatAmount(lockedByMe)} {symbol} locked</h2></div>
            {accrued > 0 && <span className="tag tag--lime">+{formatAmount(accrued)} accrued</span>}
          </header>
          {tx?.key.startsWith('exit:') && !state.positions.some((position) => `exit:${position.id}` === tx.key) && <TxNotice tx={tx} />}
          {!simulated && !walletAddress ? (
            <div className="empty"><span>Connect a wallet to see your positions.</span></div>
          ) : state.status === 'loading' ? (
            <div className="empty"><span className="spinner" aria-hidden="true" /></div>
          ) : state.positions.length === 0 ? (
            <div className="empty"><strong>No open positions.</strong><span>Your locks appear here with live ROI, unlock conditions and accrued rewards.</span></div>
          ) : (
            <ul className="lock-list">
              {state.positions.map((position) => (
                <PositionRow
                  key={position.id}
                  position={position}
                  symbol={symbol}
                  now={state.now}
                  currentPrice={state.price.value}
                  confirming={confirmExit === position.id}
                  disabled={!canTransact || busy}
                  onToggle={() => setConfirmExit(confirmExit === position.id ? null : position.id)}
                  onConfirm={() => { setConfirmExit(null); void actions.exit(position.id, position.status.feeBps) }}
                  txNotice={renderTx(`exit:${position.id}`)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card rewards-card">
        <header className="panel-head">
          <div><small className="kicker">Rewards</small><h2>Commitment reward pool</h2></div>
          {icon('coins', 20)}
        </header>
        <div className="reward-stats">
          <div><small>From early-exit fees</small><strong>{formatAmount(state.stats.poolFromFees)} {symbol}</strong></div>
          <div><small>Funded by the community</small><strong>{formatAmount(state.stats.poolFunded)} {symbol}</strong></div>
          <div><small>Paid to completed commitments</small><strong>{formatAmount(state.stats.rewardsPaid)} {symbol}</strong></div>
          <div><small>Your accrued rewards</small><strong>{formatAmount(accrued)} {symbol}</strong></div>
        </div>
        <p className="fine-print">
          The pool accrues to every open lock by weight (Flexible 1x, Committed 1.5x, Diamond Hands 3x). You receive your share when a lock completes: its term ends, its ROI target is reached, or a Flexible lock passes 7 days. Exiting early or at your max loss forfeits it to the remaining holders.
        </p>
      </section>

      <section className="challenges">
        <header className="panel-head">
          <div><small className="kicker">Community challenges</small><h2>Hold together, earn together</h2></div>
          {icon('trophy', 20)}
        </header>
        {state.challenges.length === 0 ? (
          <div className="card empty"><span>{simulated || VAULT_ADDRESS ? 'No challenges yet. Sponsors create them by escrowing reward tokens in the vault.' : 'Challenges appear once the testnet vault is live.'}</span></div>
        ) : (
          <div className="challenge-grid">
            {state.challenges.map((challenge) => (
              <ChallengeCard
                key={challenge.id}
                challenge={challenge}
                symbol={symbol}
                now={state.now}
                positions={state.positions}
                joinChoice={joinChoice[challenge.id] ?? ''}
                onChoose={(lockId) => setJoinChoice((current) => ({ ...current, [challenge.id]: lockId }))}
                disabled={!canTransact || busy}
                actions={actions}
                txNotice={renderTx(`challenge:${challenge.id}`)}
              />
            ))}
          </div>
        )}
      </section>

      <p className="fine-print fine-print--center">
        {simulated
          ? 'Simulation mode. Nothing here is a real transaction or a real price.'
          : 'Testnet only. No mainnet deployment and no real funds.'}{' '}
        $WIF comes with no promise of value or return.
      </p>
    </div>
  )
}

function TxNotice({ tx }: { tx: TxState }) {
  if (tx.status === 'failed') {
    return <div className="notice notice--error" role="alert"><strong>{tx.simulated ? 'Simulation rejected this' : 'Transaction failed'}</strong><span>{tx.error}</span></div>
  }
  if (tx.status === 'confirmed') {
    if (tx.simulated) {
      return (
        <div className="receipt receipt--sim">
          <span className="receipt-check">{icon('check', 22)}</span>
          <span className="receipt-copy"><small>Simulated</small><strong>Done. No transaction was sent.</strong></span>
        </div>
      )
    }
    return (
      <a className="receipt" href={tx.hash ? vaultExplorerTx(tx.hash) : undefined} target="_blank" rel="noreferrer">
        <span className="receipt-check">{icon('check', 22)}</span>
        <span className="receipt-copy"><small>Confirmed on {VAULT_NETWORK.name}</small><strong>{tx.step ?? 'Transaction'} confirmed</strong></span>
        <span className="receipt-link">Receipt {icon('arrowUpRight', 14)}</span>
      </a>
    )
  }
  return (
    <div className="tx-progress" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <div>
        <small>{tx.status === 'awaiting-wallet' ? 'Waiting for your wallet' : tx.simulated ? 'Simulating' : 'Confirming onchain'}</small>
        <strong>{tx.step ?? 'Working…'}</strong>
      </div>
    </div>
  )
}

function PositionRow(props: {
  position: Position
  symbol: string
  now: number
  currentPrice: number | null
  confirming: boolean
  disabled: boolean
  onToggle: () => void
  onConfirm: () => void
  txNotice: ReactNode
}) {
  const { position, symbol, now, currentPrice, confirming, disabled, onToggle, onConfirm, txNotice } = props
  const { status } = position
  const tier = TIERS[position.tier]
  const roi = status.roiBps
  const value = currentPrice === null ? null : (position.amount * currentPrice) / position.entryPrice
  const locked = status.reason === EXIT.Locked
  const paysRewards = exitPaysRewards(status.reason)
  const fee = (position.amount * status.feeBps) / 10_000
  const remaining = position.endsAt - now

  // ROI meter from the stop-loss (or −50%) on the left to the target on the right.
  const floor = position.maxLossBps || 5_000
  const meter = position.tier === 0 || roi === null
    ? null
    : Math.min(100, Math.max(0, ((roi + floor) / (position.roiTargetBps + floor)) * 100))

  const eligibility = (() => {
    if (status.reason === EXIT.EarlyWithFee) {
      return position.tier === 0
        ? `Early exit fee ${formatBps(status.feeBps)} now · free in ${formatDuration(remaining)}`
        : `Early exit fee ${formatBps(status.feeBps)} now · free at ${formatBps(position.roiTargetBps, true)}${position.maxLossBps ? ` or ${formatBps(-position.maxLossBps, true)}` : ''} or in ${formatDuration(remaining)}`
    }
    if (locked) {
      return `Locked · opens at ${formatBps(position.roiTargetBps, true)} or ${formatBps(-position.maxLossBps, true)}, or on ${formatDate(position.endsAt)}${status.priceFresh ? '' : ' (price feed stale)'}`
    }
    return `Withdraw now: ${exitReasonLabel(status.reason).toLowerCase()}`
  })()

  return (
    <li className="lock-row">
      <div className="lock-row-top">
        <span className={`plan-badge ${locked ? '' : 'is-matured'}`}>{tier.short}</span>
        <div className="lock-row-main">
          <strong>{formatAmount(position.amount)} {symbol}</strong>
          <span>{tier.name} · #{position.id} · entry {formatUsdPrice(position.entryPrice)}</span>
        </div>
        <div className="lock-row-side">
          <strong className={roiClass(roi)}>{roi === null ? '—' : formatBps(roi, true)}</strong>
          <span>{value === null ? 'ROI unavailable' : `≈ ${formatAmount(value)} value`}</span>
        </div>
      </div>

      {meter !== null && (
        <div className="roi-meter" aria-label="ROI progress between max loss and target">
          <span className="progress progress--sm"><i style={{ width: `${meter}%` }} /></span>
          <div className="roi-meter-labels">
            <span>{position.maxLossBps ? `${formatBps(-position.maxLossBps, true)} max loss` : '−50%'}</span>
            <span>{formatBps(position.roiTargetBps, true)} target</span>
          </div>
        </div>
      )}

      <p className={`eligibility ${locked ? '' : status.reason === EXIT.EarlyWithFee ? 'is-fee' : 'is-open'}`}>{eligibility}</p>

      <div className="lock-row-actions">
        <span className="lock-reward">
          {icon('coins', 14)} {formatAmount(position.pendingReward)} accrued · {paysRewards ? 'paid if you withdraw now' : locked ? 'paid on completion' : 'forfeited if you leave now'}
        </span>
        <div>
          <button type="button" className={`btn btn--sm ${locked ? 'btn--ghost' : status.reason === EXIT.EarlyWithFee ? 'btn--ghost btn--paper' : 'btn--lime'}`} disabled={disabled || locked} onClick={onToggle}>
            {locked ? 'Locked' : status.reason === EXIT.EarlyWithFee ? 'Exit early' : 'Withdraw'}
          </button>
        </div>
      </div>

      {confirming && !locked && (
        <div className={`break-confirm ${paysRewards ? 'is-calm' : ''}`}>
          <dl className="rows">
            <div><dt>Reason</dt><dd>{exitReasonLabel(status.reason)}</dd></div>
            {status.feeBps > 0 && <div className="is-loss"><dt>Fee ({formatBps(status.feeBps)})</dt><dd>−{formatAmount(fee)} {symbol}</dd></div>}
            {status.feeBps > 0 && <div><dt>Burned · to reward pool</dt><dd>{formatAmount(fee / 2)} · {formatAmount(fee / 2)}</dd></div>}
            <div className={paysRewards ? '' : 'is-loss'}><dt>Accrued rewards</dt><dd>{paysRewards ? `+${formatAmount(position.pendingReward)}` : `forfeited (${formatAmount(position.pendingReward)})`}</dd></div>
            <div><dt>You receive</dt><dd>{formatAmount(position.amount - fee + (paysRewards ? position.pendingReward : 0))} {symbol}</dd></div>
          </dl>
          <div className="btn-pair">
            <button type="button" className="btn btn--ghost" onClick={onToggle}>Keep holding</button>
            <button type="button" className={`btn ${paysRewards ? 'btn--lime' : 'btn--danger'}`} onClick={onConfirm}>Confirm withdrawal</button>
          </div>
        </div>
      )}
      {txNotice}
    </li>
  )
}

function ChallengeCard(props: {
  challenge: ChallengeView
  symbol: string
  now: number
  positions: Position[]
  joinChoice: string
  onChoose: (lockId: string) => void
  disabled: boolean
  actions: ReturnType<typeof useVault>['actions']
  txNotice: ReactNode
}) {
  const { challenge, symbol, now, positions, joinChoice, onChoose, disabled, actions, txNotice } = props
  const phase = challengePhase(challenge, now)
  const eligibleLocks = positions.filter((position) => position.tier >= challenge.minTier && position.amount >= challenge.minAmount)
  const progressBase = challenge.finalized ? challenge.qualifiedTotal : challenge.committedTotal
  const progress = challenge.targetTotal > 0 ? Math.min(100, (progressBase / challenge.targetTotal) * 100) : null
  const ranking = useMemo(() => [...challenge.ranking].sort((a, b) => (
    challenge.kind === 1 ? (b.roiBps ?? -Infinity) - (a.roiBps ?? -Infinity) : b.amount - a.amount
  )).slice(0, 5), [challenge])
  const share = challenge.qualifiedCount > 0 ? challenge.rewardPool / challenge.qualifiedCount : challenge.rewardPool / Math.max(1, challenge.participants)
  const joined = challenge.me.lockId !== null

  const phaseLabel = {
    joining: `Joining · closes in ${formatDuration(challenge.joinBy - now)}`,
    running: `Running · ends in ${formatDuration(challenge.endsAt - now)}`,
    'awaiting-final': 'Ended · waiting to be finalized',
    qualifying: `Qualifying · ${formatDuration(challenge.claimEndsAt - now)} left`,
    claimable: 'Rewards claimable',
    refundable: 'Did not complete · refundable to sponsor',
    closed: 'Closed',
  }[phase]

  return (
    <article className="card challenge-card">
      <header className="challenge-head">
        <div>
          <span className="tag">{challenge.kind === 0 ? 'Holding' : 'Performance'}</span>
          <h3>{challenge.title}</h3>
        </div>
        <span className="challenge-pool"><small>Reward pool</small><strong>{formatAmount(challenge.rewardPool, true)} {symbol}</strong></span>
      </header>

      <p className="challenge-goal">
        {challenge.kind === 0
          ? `Keep a ${TIERS[challenge.minTier].name}-or-higher lock of at least ${formatAmount(challenge.minAmount)} ${symbol} open until ${formatDate(challenge.endsAt)}.`
          : `Hold through ${formatDate(challenge.endsAt)} and finish at ${formatBps(challenge.roiTargetBps, true)} ROI or better.`}
        {challenge.targetTotal > 0 && ` Community goal: ${formatAmount(challenge.targetTotal, true)} ${symbol} committed by qualifiers.`}
      </p>

      {progress !== null && (
        <div className="challenge-progress">
          <span className="progress"><i style={{ width: `${progress}%` }} /></span>
          <small>{formatAmount(progressBase, true)} / {formatAmount(challenge.targetTotal, true)} {symbol} {challenge.finalized ? 'qualified' : 'committed'}</small>
        </div>
      )}

      <dl className="rows">
        <div><dt>Status</dt><dd>{phaseLabel}</dd></div>
        <div><dt>Participants</dt><dd>{challenge.participants}{challenge.finalized ? ` · ${challenge.qualifiedCount} qualified` : ''}</dd></div>
        <div><dt>Your share if you qualify</dt><dd>≈ {formatAmount(share)} {symbol}</dd></div>
      </dl>

      {ranking.length > 0 && (
        <ol className="board board--compact">
          {ranking.map((row, index) => (
            <li key={row.who} className={row.isMe ? 'is-me' : ''}>
              <span className="board-rank">{index + 1}</span>
              <span>{row.isMe ? 'You' : row.who.startsWith('sim:') ? `${row.who.slice(4)} (sim)` : shortAddr(row.who)}{row.held ? '' : ' · left'}</span>
              <strong className={challenge.kind === 1 ? roiClass(row.roiBps) : ''}>
                {challenge.kind === 1 ? (row.roiBps === null ? '—' : formatBps(row.roiBps, true)) : `${formatAmount(row.amount, true)} ${symbol}`}
              </strong>
            </li>
          ))}
        </ol>
      )}

      {txNotice}

      <div className="challenge-actions">
        {phase === 'joining' && !joined && (
          eligibleLocks.length === 0 ? (
            <span className="fine-print">Open a {TIERS[challenge.minTier].name}-or-higher lock of at least {formatAmount(challenge.minAmount)} {symbol} to join.</span>
          ) : (
            <>
              <select className="lock-select" value={joinChoice} onChange={(event) => onChoose(event.target.value)} aria-label="Lock to enter">
                <option value="">Choose a lock</option>
                {eligibleLocks.map((position) => (
                  <option key={position.id} value={position.id}>#{position.id} · {TIERS[position.tier].name} · {formatAmount(position.amount)} {symbol}</option>
                ))}
              </select>
              <button type="button" className="btn btn--lime btn--sm" disabled={disabled || !joinChoice} onClick={() => void actions.joinChallenge(challenge.id, joinChoice)}>Join</button>
            </>
          )
        )}
        {joined && (phase === 'joining' || phase === 'running') && <span className="tag tag--lime">You're in with lock #{challenge.me.lockId}</span>}
        {phase === 'awaiting-final' && <button type="button" className="btn btn--dark btn--sm" disabled={disabled} onClick={() => void actions.finalizeChallenge(challenge.id)}>Finalize results</button>}
        {phase === 'qualifying' && joined && !challenge.me.qualified && <button type="button" className="btn btn--lime btn--sm" disabled={disabled} onClick={() => void actions.qualify(challenge.id)}>Prove I qualified</button>}
        {phase === 'qualifying' && challenge.me.qualified && <span className="tag tag--lime">Qualified · claim opens in {formatDuration(challenge.claimEndsAt - now)}</span>}
        {phase === 'claimable' && challenge.me.qualified && !challenge.me.claimed && (
          <button type="button" className="btn btn--lime btn--sm" disabled={disabled} onClick={() => void actions.claimChallenge(challenge.id)}>Claim {formatAmount(share)} {symbol}</button>
        )}
        {phase === 'claimable' && challenge.me.claimed && <span className="tag tag--lime">Reward claimed</span>}
        {phase === 'refundable' && <button type="button" className="btn btn--ghost btn--sm" disabled={disabled} onClick={() => void actions.refundChallenge(challenge.id)}>Return pool to sponsor</button>}
      </div>
    </article>
  )
}
