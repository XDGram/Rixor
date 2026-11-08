import { useState } from 'react'
import { fmtToken, shortAddr } from '../model'
import type { Ctx } from '../ctx'
import { discoverWallets, detectHoldings, requestAccount, switchToRobinhood, type Holding, type Holdings, type WalletOption } from '../wallet'
import { ROBINHOOD_CHAIN } from '../tokenlist'

const GROUPS: { key: Holding['group']; title: string; empty: string }[] = [
  { key: 'supported', title: 'Supported on Robinhood Chain', empty: 'None yet: no Rixor Locker is deployed on Robinhood Chain.' },
  { key: 'under_review', title: 'Under review', empty: 'You hold none of the tokens under review.' },
  { key: 'unsupported', title: 'Unsupported', empty: 'You hold none of the tokens marked unsupported.' },
]

/**
 * Read-only detection of the visitor's real Robinhood Chain holdings. Connecting shares only an address: no
 * signature, no transaction, no keys. Balances come from one Multicall3 call to the public RPC.
 */
export function HoldingsCard({ ctx }: { ctx: Ctx }) {
  const [wallets, setWallets] = useState<WalletOption[] | null>(null)
  const [chosen, setChosen] = useState<WalletOption | null>(null)
  const [account, setAccount] = useState<{ address: string; chainId: number } | null>(null)
  const [holdings, setHoldings] = useState<Holdings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const simSymbols = new Set(ctx.snapshot.tokens.map((t) => t.symbol))

  const find = async () => {
    setError(null)
    const list = await discoverWallets()
    setWallets(list)
    if (list.length === 1) void connect(list[0])
  }
  const connect = async (w: WalletOption) => {
    setBusy(true)
    setError(null)
    try {
      setChosen(w)
      const acc = await requestAccount(w)
      setAccount(acc)
      setHoldings(await detectHoldings(acc.address, import.meta.env.VITE_RIXOR_LOCKER_4663 || undefined))
    } catch (e) {
      const code = (e as { code?: number })?.code
      setError(code === 4001 ? 'You declined the connection in your wallet.' : e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }
  const refresh = async () => {
    if (!account) return
    setBusy(true)
    try { setHoldings(await detectHoldings(account.address, import.meta.env.VITE_RIXOR_LOCKER_4663 || undefined)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const doSwitch = async () => {
    if (!chosen) return
    try { await switchToRobinhood(chosen); setAccount(await requestAccount(chosen)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <section className="card">
      <header className="panel-head">
        <div><small className="kicker">Your real wallet · read-only</small><h2>Meme tokens you hold on Robinhood Chain</h2></div>
        {account && <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void refresh()}>{busy ? 'Reading…' : 'Refresh'}</button>}
      </header>
      {!account && (
        <>
          <p className="figure-sub">Connect a Robinhood Chain wallet to see which of your meme tokens Rixor supports. Rixor reads your public balances only: no signature, no transaction, and never your keys or seed phrase.</p>
          {wallets === null && <button type="button" className="btn btn--lime btn--block" disabled={busy} onClick={() => void find()}>Connect wallet (read-only)</button>}
          {wallets !== null && wallets.length === 0 && <div className="notice notice--warn"><strong>No browser wallet found</strong><span>Open this page in a wallet's browser, or install a browser wallet, then try again. The simulation below works without one.</span></div>}
          {wallets !== null && wallets.length > 1 && (
            <div className="chip-row">{wallets.map((w) => <button key={w.id} type="button" className="chip" disabled={busy} onClick={() => void connect(w)}>{w.name}</button>)}</div>
          )}
        </>
      )}
      {error && <div className="notice notice--error" role="alert"><span>{error}</span></div>}
      {account && (
        <dl className="rows">
          <div><dt>Address</dt><dd className="mono">{shortAddr(account.address)}</dd></div>
          <div><dt>Wallet network</dt><dd>{account.chainId === ROBINHOOD_CHAIN.chainId ? 'Robinhood Chain' : <>Chain {account.chainId} <button type="button" className="text-btn" onClick={() => void doSwitch()}>Switch to Robinhood Chain</button></>}</dd></div>
          {holdings && <div><dt>ETH (gas)</dt><dd>{fmtToken(holdings.eth, 18)} ETH</dd></div>}
          {holdings && <div><dt>Read at</dt><dd>Robinhood Chain block {holdings.block.toLocaleString('en-US')}</dd></div>}
        </dl>
      )}
      {holdings && (
        <>
          {GROUPS.map((g) => {
            const rows = holdings.tokens.filter((t) => t.group === g.key && (t.balance > 0n || g.key === 'supported'))
            return (
              <div className="sheet-section" key={g.key}>
                <small className="kicker">{g.title}</small>
                {rows.filter((t) => t.balance > 0n).length === 0 ? <p className="fine-print">{g.empty}</p> : (
                  <ul className="token-list">
                    {rows.filter((t) => t.balance > 0n).map((t) => (
                      <li key={t.address}>
                        <div className="token-line">
                          <span className="token-mark">{t.symbol.slice(0, 1)}</span>
                          <span className="token-line-copy">
                            <strong>{t.symbol} <span className={`tag ${g.key === 'unsupported' ? 'tag--outline' : ''}`}>{g.key === 'supported' ? 'Supported' : g.key === 'under_review' ? 'Under review' : 'Unsupported'}</span></strong>
                            <span>{t.note}{simSymbols.has(t.symbol) ? ' Try it in the simulation below.' : ''}</span>
                          </span>
                          <span className="token-line-side"><strong>{fmtToken(t.balance, t.decimals, { compact: true })}</strong><span>{t.symbol}</span></span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
          {holdings.tokens.find((t) => t.group === 'reward' && t.balance > 0n) && (
            <p className="fine-print">You also hold {fmtToken(holdings.tokens.find((t) => t.group === 'reward')!.balance, 18, { compact: true })} WIF, the reward token. WIF is never needed to lock.</p>
          )}
          <p className="fine-print">{holdings.supportedSource} Only tokens on the Rixor token list are checked, so other tokens you hold are not shown here. Locking real tokens is not available until contracts are deployed and tokens are approved.</p>
        </>
      )}
    </section>
  )
}
