import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import RixorApp from './protocol/RixorApp'
import './styles.css'

// The active product is the multi-token conviction-locking protocol (src/protocol).
// The previous ETH-savings / Diamond Hands / simulation experience (src/App.tsx, src/DiamondHands.tsx,
// src/vault, src/pricing) is preserved in the repository but no longer mounted.
createRoot(document.getElementById('root')!).render(
  <StrictMode><RixorApp /></StrictMode>,
)
