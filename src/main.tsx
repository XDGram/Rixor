import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root'
import './styles.css'

// src/Root.tsx switches between the LIVE side (the real, onchain HOOKR lock) and the DEMO side (the broader product
// in a simulation with demo data). The older ETH-savings experience (src/App.tsx) stays unmounted.
createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
