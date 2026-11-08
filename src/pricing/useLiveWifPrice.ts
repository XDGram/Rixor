import { useEffect, useState } from 'react'
import { readLiveWifPrice, type LiveWifPrice } from './livePrice'

/** LIVE MARKET DATA, DISPLAY ONLY. Refreshes once a minute. */
export const useLiveWifPrice = () => {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data: LiveWifPrice | null; error?: string }>({ status: 'loading', data: null })

  useEffect(() => {
    let cancelled = false
    const load = () => readLiveWifPrice()
      .then((data) => { if (!cancelled) setState({ status: 'ready', data }) })
      .catch((error: unknown) => {
        if (!cancelled) setState((current) => ({ status: current.data ? 'ready' : 'error', data: current.data, error: error instanceof Error ? error.message : String(error) }))
      })
    void load()
    const interval = window.setInterval(load, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  return state
}
