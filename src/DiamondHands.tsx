import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUnits, parseUnits } from 'ethers'
import { icon } from './ui'
import {
  DIAMOND_ADDRESS,
  LOCK_TERMS,
  ROBINHOOD_MAINNET,
  WIF_ADDRESS,
  WIF_DECIMALS,
  currentFeeBps,
  diamondInterface,
  erc20Interface,
  explorerAddress,
  explorerTx,
  formatWif,
  readContract,
  shortAddr,
  toWif,
  useDiamondHistory,
  useDiamondStats,
} from './wif'

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

type Props = {
  walletAddress: string | null
  provider: Provider | null
  chainId: number | null
  switching: boolean
  onSwitchToMainnet: () => void
}

type UserLock = {
  id: bigint
  term: number
  amount: number
  amountRaw: bigint
  startedAt: number
  unlocksAt: number
  pending: number
}

type Action = {
  kind: 'approve' | 'lock' | 'claim' | 'unlock' | 'break'
  lockId?: bigint
  status: 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'
  hash?: string
  error?: string
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

const walletErrorMessage = (error: unknown) => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? Number((error as { code?: number }).code) : null
  if (code === 4001) return 'You rejected the request in your wallet.'
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 180 ? `${message.slice(0, 180)}…` : message
}

const formatCountdown = (seconds: number) => {
  if (seconds <= 0) return 'Unlocked'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h left`
  if (hours > 0) return `${hours}h ${minutes}m left`
  return `${Math.max(1, minutes)}m left`
}

export default function DiamondHands({ walletAddress, provider, chainId, switching, onSwitchToMainnet }: Props) {
  const [refreshKey, setRefreshKey] = useState(0)
  const stats = useDiamondStats(refreshKey)
  const history = useDiamondHistory(refreshKey)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [term, setTerm] = useState(2)
  const [amount, setAmount] = useState('')
  const [wifBalance, setWifBalance] = useState<bigint>(0n)
  const [allowance, setAllowance] = useState<bigint>(0n)
  const [locks, setLocks] = useState<UserLock[]>([])
  const [userStatus, setUserStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [action, setAction] = useState<Action | null>(null)
  const [confirmBreak, setConfirmBreak] = useState<bigint | null>(null)

  const onMainnet = chainId === ROBINHOOD_MAINNET.id
  const live = Boolean(DIAMOND_ADDRESS)
  const canTransact = live && onMainnet && Boolean(walletAddress && provider)

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000)
    return () => window.clearInterval(interval)
  }, [])

  const loadUser = useCallback(async () => {
    if (!walletAddress) return
    setUserStatus((current) => (current === 'ready' ? 'ready' : 'loading'))
    try {
      const [balance] = await readContract(erc20Interface, WIF_ADDRESS, 'balanceOf', [walletAddress])
      setWifBalance(balance as bigint)
      if (live) {
        const [[allowed], [ids]] = await Promise.all([
          readContract(erc20Interface, WIF_ADDRESS, 'allowance', [walletAddress, DIAMOND_ADDRESS]),
          readContract(diamondInterface, DIAMOND_ADDRESS, 'getOwnerLockIds', [walletAddress]),
        ])
        setAllowance(allowed as bigint)
        const rows = await Promise.all((ids as bigint[]).map(async (id) => {
          const [record, [pending]] = await Promise.all([
            readContract(diamondInterface, DIAMOND_ADDRESS, 'locks', [id]),
            readContract(diamondInterface, DIAMOND_ADDRESS, 'pendingReward', [id]),
          ])
          if (!record.open) return null
          return {
            id,
            term: Number(record.term),
            amount: toWif(record.amount as bigint),
            amountRaw: record.amount as bigint,
            startedAt: Number(record.startedAt),
            unlocksAt: Number(record.unlocksAt),
            pending: toWif(pending as bigint),
          } satisfies UserLock
        }))
        setLocks(rows.filter((row): row is UserLock => row !== null).sort((a, b) => a.unlocksAt - b.unlocksAt))
      }
      setUserStatus('ready')
    } catch {
      setUserStatus('error')
    }
  }, [walletAddress, live])

  useEffect(() => {
    void loadUser()
  }, [loadUser, refreshKey])

  const parsedAmount = useMemo(() => {
    try {
      return amount ? parseUnits(amount, WIF_DECIMALS) : 0n
    } catch {
      return 0n
    }
  }, [amount])

  const selectedTerm = LOCK_TERMS[term]
  const insufficient = parsedAmount > wifBalance
  const amountValid = parsedAmount > 0n && !insufficient
  const needsApproval = parsedAmount > allowance
  const busy = action?.status === 'awaiting-wallet' || action?.status === 'pending'
  const unlockDate = new Date(Date.now() + selectedTerm.days * 86_400_000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const myLocked = locks.reduce((total, row) => total + row.amount, 0)
  const myPending = locks.reduce((total, row) => total + row.pending, 0)

  const send = async (kind: Action['kind'], to: string, data: string, lockId?: bigint) => {
    if (!provider || !walletAddress) return false
    setAction({ kind, lockId, status: 'awaiting-wallet' })
    try {
      // Estimate first: a doomed transaction fails here with a reason, before the wallet asks to sign.
      let gas: string | undefined
      try {
        const estimate = BigInt(await provider.request({ method: 'eth_estimateGas', params: [{ from: walletAddress, to, data }] }) as string)
        gas = `0x${((estimate * 12n) / 10n).toString(16)}`
      } catch (error) {
        throw new Error(`This transaction would fail: ${walletErrorMessage(error)}`)
      }
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: walletAddress, to, data, gas }] }) as string
      setAction({ kind, lockId, status: 'pending', hash })
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }) as { status?: string } | null
        if (receipt) {
          if (receipt.status === '0x0') throw new Error('The transaction reverted onchain.')
          setAction({ kind, lockId, status: 'confirmed', hash })
          setRefreshKey((key) => key + 1)
          return true
        }
        await sleep(1_500)
      }
      throw new Error('Timed out waiting for confirmation. Check the explorer.')
    } catch (error) {
      setAction((current) => ({ kind, lockId, status: 'failed', hash: current?.hash, error: walletErrorMessage(error) }))
      return false
    }
  }

  const approveAndLock = async () => {
    if (!amountValid) return
    if (needsApproval) {
      const approved = await send('approve', WIF_ADDRESS, erc20Interface.encodeFunctionData('approve', [DIAMOND_ADDRESS, parsedAmount]))
      if (!approved) return
      setAllowance(parsedAmount)
    }
    const locked = await send('lock', DIAMOND_ADDRESS, diamondInterface.encodeFunctionData('lock', [parsedAmount, term]))
    if (locked) setAmount('')
  }

  const actionLabel = (kind: Action['kind']) => ({
    approve: ['Approve $WIF in your wallet', 'Confirming approval…', 'Approval confirmed'],
    lock: ['Confirm the lock in your wallet', 'Locking your $WIF…', 'Locked. Diamond hands.'],
    claim: ['Confirm the claim in your wallet', 'Claiming rewards…', 'Rewards claimed'],
    unlock: ['Confirm the unlock in your wallet', 'Unlocking…', 'Unlocked with rewards'],
    break: ['Confirm in your wallet', 'Breaking the lock…', 'Lock broken. Fee burned and shared.'],
  })[kind]

  const renderActionStatus = (scope: 'form' | bigint) => {
    if (!action) return null
    const inScope = scope === 'form' ? action.kind === 'approve' || action.kind === 'lock' : action.lockId === scope
    if (!inScope) return null
    const [approveText, pendingText, doneText] = actionLabel(action.kind)
    if (action.status === 'failed') {
      return <div className="notice notice--error" role="alert"><strong>Transaction failed</strong><span>{action.error}</span></div>
    }
    if (action.status === 'confirmed') {
      return (
        <a className="receipt" href={action.hash ? explorerTx(action.hash) : undefined} target="_blank" rel="noreferrer">
          <span className="receipt-check">{icon('check', 22)}</span>
          <span className="receipt-copy"><small>Confirmed on Robinhood Chain</small><strong>{doneText}</strong></span>
          <span className="receipt-link">Receipt {icon('arrowUpRight', 14)}</span>
        </a>
      )
    }
    return (
      <div className="tx-progress" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <div>
          <small>{action.status === 'awaiting-wallet' ? 'Waiting for your wallet' : 'Confirming onchain'}</small>
          <strong>{action.status === 'awaiting-wallet' ? approveText : pendingText}</strong>
        </div>
      </div>
    )
  }

  const statValue = (value: number) => (stats.status === 'ready' ? formatWif(value, true) : stats.status === 'not-deployed' ? '—' : '…')

  return (
    <div className="view diamond" key="diamond">
      <section className="diamond-hero">
        <div className="diamond-hero-copy">
          <p className="eyebrow">Diamond Hands · $WIF</p>
          <h1>Lock your $WIF. Paper hands pay the holders.</h1>
          <p>Break a lock early and half your fee is burned, the other half goes to everyone still holding. The longer you lock, the bigger your share.</p>
        </div>
        <div className="flywheel-stats">
          <div><small>$WIF locked</small><strong>{statValue(stats.totalLocked)}</strong></div>
          <div><small>Burned by paper hands</small><strong>{statValue(stats.totalBurned)}</strong></div>
          <div><small>Paid to holders</small><strong>{statValue(stats.totalDistributed)}</strong></div>
          <div><small>Open locks</small><strong>{stats.status === 'ready' ? stats.openLocks.toLocaleString() : stats.status === 'not-deployed' ? '—' : '…'}</strong></div>
        </div>
      </section>

      {!live && (
        <div className="notice notice--warn">
          <strong>The lock contract is not deployed yet.</strong>
          <span>Locking turns on as soon as the RixorDiamondHands address is configured. Your $WIF balance below is read live from Robinhood Chain.</span>
        </div>
      )}
      {live && walletAddress && !onMainnet && (
        <div className="notice notice--warn notice--action">
          <div><strong>Switch to Robinhood Chain.</strong><span>Diamond Hands runs on Robinhood Chain mainnet, where $WIF lives.</span></div>
          <button type="button" className="btn btn--dark btn--sm" onClick={onSwitchToMainnet} disabled={switching}>{switching ? 'Switching…' : 'Switch network'}</button>
        </div>
      )}

      <div className="diamond-grid">
        <section className="card lock-card">
          <header className="panel-head">
            <div><small className="kicker">New lock</small><h2>Commit your $WIF</h2></div>
            <a className="text-btn" href={explorerAddress(WIF_ADDRESS)} target="_blank" rel="noreferrer">$WIF {icon('arrowUpRight', 12)}</a>
          </header>

          <div className="amount-field">
            <div className="amount-field-head">
              <label htmlFor="wif-amount">Amount</label>
              <span className={insufficient ? 'is-error' : ''}>
                {walletAddress ? `${formatWif(toWif(wifBalance))} $WIF in wallet` : 'Connect a wallet'}
              </span>
            </div>
            <div className={`amount-input ${insufficient ? 'is-error' : ''}`}>
              <input id="wif-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} />
              <span>$WIF</span>
            </div>
            <div className="chip-row">
              {[25, 50, 75, 100].map((percent) => (
                <button
                  key={percent}
                  type="button"
                  className="chip"
                  disabled={wifBalance === 0n}
                  onClick={() => setAmount(formatUnits((wifBalance * BigInt(percent)) / 100n, WIF_DECIMALS))}
                >
                  {percent === 100 ? 'Max' : `${percent}%`}
                </button>
              ))}
            </div>
            {insufficient && <div className="field-error">That is more $WIF than this wallet holds.</div>}
          </div>

          <div className="term-grid term-grid--wif" role="radiogroup" aria-label="Lock term">
            {LOCK_TERMS.map((option) => (
              <button key={option.id} type="button" role="radio" aria-checked={term === option.id} className={`term ${term === option.id ? 'is-active' : ''}`} onClick={() => setTerm(option.id)}>
                <span className="term-top"><strong>{option.label}</strong><em>{option.weightBps / 10_000}x</em></span>
                <small>Up to {option.maxFeeBps / 100}% fee</small>
              </button>
            ))}
          </div>

          <dl className="rows">
            <div><dt>Unlocks</dt><dd>{unlockDate}</dd></div>
            <div><dt>Paper-hands fee</dt><dd>{selectedTerm.maxFeeBps / 100}% today, falling to 0%</dd></div>
            <div><dt>Reward weight</dt><dd>{selectedTerm.weightBps / 10_000}x your amount</dd></div>
            <div><dt>If you break early</dt><dd>50% burned · 50% to holders</dd></div>
          </dl>

          {renderActionStatus('form')}

          <button
            type="button"
            className="btn btn--lime btn--block btn--lg"
            disabled={!canTransact || !amountValid || busy}
            onClick={() => void approveAndLock()}
          >
            {!walletAddress ? 'Connect a wallet to lock'
              : !live ? 'Locking opens at launch'
                : !onMainnet ? 'Switch to Robinhood Chain'
                  : needsApproval && amountValid ? 'Approve & lock $WIF'
                    : 'Lock $WIF'}
          </button>
          {needsApproval && amountValid && canTransact && <p className="fine-print">Two wallet steps: approve this amount of $WIF, then lock it.</p>}
        </section>

        <section className="card list-card my-locks">
          <header className="panel-head">
            <div><small className="kicker">Your locks</small><h2>{formatWif(myLocked)} $WIF held</h2></div>
            {myPending > 0 && <span className="tag tag--lime">+{formatWif(myPending)} earned</span>}
          </header>
          {action?.lockId !== undefined && !locks.some((row) => row.id === action.lockId) && renderActionStatus(action.lockId)}
          {!walletAddress ? (
            <div className="empty"><span>Connect a wallet to see your locks.</span></div>
          ) : userStatus === 'loading' ? (
            <div className="empty"><span className="spinner" aria-hidden="true" /><span>Reading Robinhood Chain…</span></div>
          ) : userStatus === 'error' ? (
            <div className="empty"><strong>Could not read your locks.</strong><span>The public RPC may be busy. Try again shortly.</span></div>
          ) : locks.length === 0 ? (
            <div className="empty"><strong>No open locks.</strong><span>Locks you open appear here with a live countdown and the fee you would pay to break them.</span></div>
          ) : (
            <ul className="lock-list">
              {locks.map((row) => {
                const remaining = row.unlocksAt - now
                const progress = Math.min(100, Math.max(0, ((now - row.startedAt) / Math.max(1, row.unlocksAt - row.startedAt)) * 100))
                const feeBps = currentFeeBps(row.term, row.startedAt, row.unlocksAt, now)
                const fee = (row.amount * feeBps) / 10_000
                const matured = remaining <= 0
                const rowBusy = busy && action?.lockId === row.id
                // With no other open lock there is nobody to pay, so the contract burns the whole fee.
                const othersHolding = stats.status === 'ready' ? stats.openLocks > 1 : true
                const toBurn = othersHolding ? fee / 2 : fee + row.pending
                const toHolders = othersHolding ? fee / 2 + row.pending : 0
                return (
                  <li key={String(row.id)} className="lock-row">
                    <div className="lock-row-top">
                      <span className={`plan-badge ${matured ? 'is-matured' : ''}`}>{LOCK_TERMS[row.term]?.short}</span>
                      <div className="lock-row-main">
                        <strong>{formatWif(row.amount)} $WIF</strong>
                        <span>{formatCountdown(remaining)} · lock #{String(row.id)}</span>
                      </div>
                      <div className="lock-row-side">
                        <strong>{matured ? '0%' : `${(feeBps / 100).toFixed(2)}%`}</strong>
                        <span>fee now</span>
                      </div>
                    </div>
                    <span className="progress progress--sm"><i style={{ width: `${progress}%` }} /></span>
                    <div className="lock-row-actions">
                      <span className="lock-reward">{icon('coins', 14)} {formatWif(row.pending)} earned</span>
                      <div>
                        {row.pending > 0 && !matured && (
                          <button type="button" className="btn btn--ghost btn--sm" disabled={!canTransact || busy} onClick={() => void send('claim', DIAMOND_ADDRESS, diamondInterface.encodeFunctionData('claim', [row.id]), row.id)}>Claim</button>
                        )}
                        {matured ? (
                          <button type="button" className="btn btn--lime btn--sm" disabled={!canTransact || busy} onClick={() => void send('unlock', DIAMOND_ADDRESS, diamondInterface.encodeFunctionData('unlock', [row.id]), row.id)}>Unlock</button>
                        ) : (
                          <button type="button" className="btn btn--ghost btn--sm btn--paper" disabled={!canTransact || busy} onClick={() => setConfirmBreak(confirmBreak === row.id ? null : row.id)}>Paper hand</button>
                        )}
                      </div>
                    </div>
                    {confirmBreak === row.id && !matured && !rowBusy && action?.status !== 'confirmed' && (
                      <div className="break-confirm">
                        <dl className="rows">
                          <div className="is-loss"><dt>Fee ({(feeBps / 100).toFixed(2)}%)</dt><dd>−{formatWif(fee)} $WIF</dd></div>
                          <div><dt>Burned forever</dt><dd>{formatWif(toBurn)} $WIF</dd></div>
                          <div><dt>Paid to holders</dt><dd>{formatWif(toHolders)} $WIF</dd></div>
                          <div><dt>You get back</dt><dd>{formatWif(row.amount - fee)} $WIF</dd></div>
                        </dl>
                        {row.pending > 0 && <p className="fine-print">Your {formatWif(row.pending)} unclaimed $WIF reward is forfeited. Claim it first if you want it.</p>}
                        {!othersHolding && <p className="fine-print">You hold the only open lock, so the whole fee is burned.</p>}
                        <div className="btn-pair">
                          <button type="button" className="btn btn--ghost" onClick={() => setConfirmBreak(null)}>Keep holding</button>
                          <button type="button" className="btn btn--danger" onClick={() => { setConfirmBreak(null); void send('break', DIAMOND_ADDRESS, diamondInterface.encodeFunctionData('breakLock', [row.id]), row.id) }}>Break lock</button>
                        </div>
                      </div>
                    )}
                    {renderActionStatus(row.id)}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <DiamondBoard history={history} walletAddress={walletAddress} />

      <p className="fine-print fine-print--center">
        {live
          ? <>RixorDiamondHands <a href={explorerAddress(DIAMOND_ADDRESS)} target="_blank" rel="noreferrer">{shortAddr(DIAMOND_ADDRESS)}</a> on Robinhood Chain. No owner, no admin keys, no protocol fee. </>
          : 'RixorDiamondHands has no owner, no admin keys and no protocol fee. '}
        $WIF comes with no promise of value or return.
      </p>
    </div>
  )
}

export function DiamondBoard({ history, walletAddress }: { history: ReturnType<typeof useDiamondHistory>; walletAddress?: string | null }) {
  if (!DIAMOND_ADDRESS) return null
  const me = walletAddress?.toLowerCase()

  return (
    <div className="split">
      <section className="card list-card">
        <header className="panel-head">
          <div><small className="kicker">Leaderboard</small><h2>Diamondest hands</h2></div>
          {icon('trophy', 20)}
        </header>
        {history.status === 'loading' ? (
          <div className="empty"><span className="spinner" aria-hidden="true" /></div>
        ) : history.leaderboard.length === 0 ? (
          <div className="empty"><span>No locks yet. The first holder takes the top spot.</span></div>
        ) : (
          <ol className="board">
            {history.leaderboard.map((row, index) => (
              <li key={row.owner} className={row.owner.toLowerCase() === me ? 'is-me' : ''}>
                <span className="board-rank">{index + 1}</span>
                <a href={explorerAddress(row.owner)} target="_blank" rel="noreferrer">{shortAddr(row.owner)}{row.owner.toLowerCase() === me ? ' (you)' : ''}</a>
                <strong>{formatWif(row.locked, true)} $WIF</strong>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card list-card">
        <header className="panel-head">
          <div><small className="kicker">Live</small><h2>Diamonds & paper</h2></div>
          {icon('flame', 20)}
        </header>
        {history.status === 'loading' ? (
          <div className="empty"><span className="spinner" aria-hidden="true" /></div>
        ) : history.events.length === 0 ? (
          <div className="empty"><span>Every lock, claim and paper-hand exit shows up here.</span></div>
        ) : (
          <ul className="feed">
            {history.events.map((event) => (
              <li key={event.key}>
                <span className={`feed-icon feed-icon--${event.kind}`}>
                  {icon(event.kind === 'locked' ? 'lock' : event.kind === 'broken' ? 'flame' : event.kind === 'claimed' ? 'coins' : 'check', 16)}
                </span>
                <span className="feed-copy">
                  <strong>
                    {event.kind === 'locked' ? `Locked for ${LOCK_TERMS[event.term ?? 0]?.label}`
                      : event.kind === 'broken' ? 'Paper-handed'
                        : event.kind === 'claimed' ? 'Claimed rewards' : 'Unlocked'}
                  </strong>
                  <span>{shortAddr(event.owner)}</span>
                </span>
                <span className="feed-amount">
                  <strong>{formatWif(event.amount, true)} $WIF</strong>
                  {event.kind === 'broken'
                    ? <span className="is-loss">{formatWif(event.burned, true)} burned</span>
                    : <a href={explorerTx(event.txHash)} target="_blank" rel="noreferrer">Tx {icon('arrowUpRight', 12)}</a>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
