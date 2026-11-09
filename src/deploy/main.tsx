import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DeployConsole } from './DeployConsole'
import './deploy.css'

createRoot(document.getElementById('root')!).render(<StrictMode><DeployConsole /></StrictMode>)
