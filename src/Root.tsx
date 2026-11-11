// Rixor has two sides, and the app never lets them blur:
//
//   LIVE  (src/lite)      Real and onchain: lock HOOKR in the single RixorLite contract on Robinhood Chain mainnet,
//                         earn and claim real $WIF. Every number on it is read from the chain.
//   DEMO  (src/protocol)  The broader product (several tokens, tiers, challenges, portfolio, activity), running in a
//                         simulation on the visitor's device with demo tokens. Every page of it is tagged "Demo".
//
// The two sides share nothing: the demo uses a throwaway demo wallet inside the simulation, and the live side uses
// the visitor's own wallet. A balance, transaction or claim from one side is never shown on the other.
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import LiteApp from './lite/LiteApp'

const DemoApp = lazy(() => import('./protocol/RixorApp'))
type View = 'live' | 'demo'
const readView = (): View => { const q = new URLSearchParams(window.location.search); return q.get('view') === 'demo' || q.has('full') ? 'demo' : 'live' }

export default function Root() {
  const [view, setView] = useState<View>(readView)
  useEffect(() => {
    const onPop = () => setView(readView())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = useCallback((next: View, hash = '') => {
    const url = new URL(window.location.href)
    url.searchParams.delete('full')
    if (next === 'demo') url.searchParams.set('view', 'demo'); else url.searchParams.delete('view')
    url.hash = hash
    window.history.pushState(null, '', url)
    setView(next)
    window.scrollTo({ top: 0 })
  }, [])

  const envSwitch = (
    <div className="seg env-seg" role="tablist" aria-label="Live or demo">
      <button type="button" role="tab" aria-selected={view === 'live'} className={view === 'live' ? 'is-active' : ''} onClick={() => go('live')}><span className="dot-live" /> Live</button>
      <button type="button" role="tab" aria-selected={view === 'demo'} className={view === 'demo' ? 'is-active' : ''} onClick={() => go('demo')}>Demo</button>
    </div>
  )
  if (view === 'demo') return <Suspense fallback={null}><DemoApp envSwitch={envSwitch} goLive={() => go('live')} /></Suspense>
  return <LiteApp envSwitch={envSwitch} goDemo={(hash) => go('demo', hash)} />
}
