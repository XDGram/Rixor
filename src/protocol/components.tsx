import { useCallback, useState, type ReactNode } from 'react'
import type { ContractTransactionResponse } from 'ethers'
import { icon } from '../ui'
import { describeError } from './chain'
import { shortAddr } from './model'

// ------------------------------------------------------------------ transactions

export type TxState = {
  key: string
  status: 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'
  step: string
  hash?: string
  error?: string
}

export type TxStep = { label: string; send: () => Promise<ContractTransactionResponse> }

/** Runs one or more transactions in order. Only real, mined receipts are reported as confirmed. */
export function useTx(onSettled: () => void | Promise<void>, onFailure?: () => void) {
  const [tx, setTx] = useState<TxState | null>(null)
  const busy = tx?.status === 'awaiting-wallet' || tx?.status === 'pending'

  const run = useCallback(async (key: string, steps: TxStep[], doneLabel: string) => {
    let last: string | undefined
    try {
      for (const step of steps) {
        setTx({ key, status: 'awaiting-wallet', step: step.label })
        const sent = await step.send()
        last = sent.hash
        setTx({ key, status: 'pending', step: step.label, hash: sent.hash })
        const receipt = await sent.wait()
        if (!receipt || receipt.status !== 1) throw new Error('The transaction reverted.')
      }
      // Refresh first so the confirmation and the on-screen numbers always agree.
      await onSettled()
      setTx({ key, status: 'confirmed', step: doneLabel, hash: last })
      return true
    } catch (e) {
      onFailure?.()
      setTx({ key, status: 'failed', step: doneLabel, hash: last, error: describeError(e) })
      await onSettled()
      return false
    }
  }, [onSettled, onFailure])

  const clear = useCallback(() => setTx(null), [])
  return { tx, busy, run, clear }
}

export function TxNotice({ tx, for: key }: { tx: TxState | null; for: string }) {
  if (!tx || tx.key !== key) return null
  if (tx.status === 'failed') {
    return <div className="notice notice--error" role="alert"><strong>Not completed</strong><span>{tx.error}</span></div>
  }
  if (tx.status === 'confirmed') {
    return (
      <div className="receipt">
        <span className="receipt-check">{icon('check', 22)}</span>
        <span className="receipt-copy"><small>Confirmed on the fork demo chain</small><strong>{tx.step}</strong></span>
        {tx.hash && <span className="receipt-link">{shortAddr(tx.hash)}</span>}
      </div>
    )
  }
  return (
    <div className="tx-progress" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <div>
        <small>{tx.status === 'awaiting-wallet' ? 'Signing' : 'Confirming on the fork demo chain'}</small>
        <strong>{tx.step}</strong>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ layout helpers

export function Sheet(props: { id: string; kicker: string; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby={props.id} onMouseDown={(e) => e.stopPropagation()}>
        <span className="sheet-handle" aria-hidden="true" />
        <header className="sheet-head">
          <div>
            <small className="kicker">{props.kicker}</small>
            <h2 id={props.id}>{props.title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">{icon('close')}</button>
        </header>
        {props.children}
      </section>
    </div>
  )
}

export function Brand() {
  return (
    <span className="brand" aria-label="Rixor">
      <svg className="brand-mark" viewBox="0 0 36 36" role="presentation" aria-hidden="true">
        <path d="M4 5h14.2c7.5 0 12.8 4.7 12.8 11.2 0 4.1-2 7.6-5.5 9.6l-4.7-5.1c2.1-.9 3.4-2.4 3.4-4.5 0-2.8-2.2-4.7-5.5-4.7H9.8L4 5Z" />
        <path d="M4 31V21.1l12.7-9.2 5.1 5.4L4 31Z" />
        <path d="M15.6 22.6l5.3-4 10.2 12.4h-8.6l-6.9-8.4Z" />
      </svg>
      <span className="brand-word">Rixor</span>
    </span>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <span>{children}</span>}
      {action}
    </div>
  )
}
