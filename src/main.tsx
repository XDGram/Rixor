import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import LiteApp from './lite/LiteApp'
import './styles.css'

// The hackathon demo is Rixor Lite (src/lite): one contract, lock one token, earn $WIF, on Robinhood Chain mainnet.
//
// The full multi-token protocol (tiers, challenges, the in-browser simulation and the testnet mode in src/protocol)
// is not part of the demo. It is kept in the repository and hidden: it loads only with ?full in the address.
// The older ETH-savings experience (src/App.tsx) stays unmounted.
const FullApp = lazy(() => import('./protocol/RixorApp'))
const full = new URLSearchParams(window.location.search).has('full')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{full ? <Suspense fallback={null}><FullApp /></Suspense> : <LiteApp />}</StrictMode>,
)
