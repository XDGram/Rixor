import { useEffect, useMemo, useRef, useState } from 'react'

type WalletKind = 'evm' | 'solana'

type WalletSession = {
  kind: WalletKind
  address: string
  name: string
}

type EvmProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
}

type SolanaProvider = {
  isPhantom?: boolean
  isBackpack?: boolean
  publicKey?: { toString: () => string }
  connect: () => Promise<{ publicKey: { toString: () => string } }>
  signMessage: (message: Uint8Array, encoding?: string) => Promise<unknown>
}

type DetectedWallet = {
  id: string
  name: string
  kind: WalletKind
  provider: EvmProvider | SolanaProvider
}

export default function App() {
  const [lightMode, setLightMode] = useState(false)
  const [amount, setAmount] = useState('1000')
  const [plan, setPlan] = useState<'flexible' | 'locked'>('flexible')
  const [openHowCard, setOpenHowCard] = useState<string | null>(null)
  const [howInView, setHowInView] = useState(false)
  const [plansInView, setPlansInView] = useState(false)
  const [securityInView, setSecurityInView] = useState(false)
  const [activeSection, setActiveSection] = useState<'save' | 'how' | 'plans' | 'security'>('save')
  const [navCompact, setNavCompact] = useState(false)
  const [planTerm, setPlanTerm] = useState<'flexible' | '30' | '90' | '180' | '365'>('90')
  const [planAmount, setPlanAmount] = useState(2500)
  const [walletModalOpen, setWalletModalOpen] = useState(false)
  const [walletConnecting, setWalletConnecting] = useState<string | null>(null)
  const [walletError, setWalletError] = useState('')
  const [walletSession, setWalletSession] = useState<WalletSession | null>(null)
  const [detectedWallets, setDetectedWallets] = useState<DetectedWallet[]>([])
  const [connectedEvmProvider, setConnectedEvmProvider] = useState<EvmProvider | null>(null)
  const [evmChainId, setEvmChainId] = useState<number | null>(null)
  const [networkSwitching, setNetworkSwitching] = useState<number | null>(null)
  const [nativeBalance, setNativeBalance] = useState<string>('0.0000')
  const savingsPanelRef = useRef<HTMLElement>(null)
  const howSectionRef = useRef<HTMLElement>(null)
  const plansSectionRef = useRef<HTMLElement>(null)
  const securitySectionRef = useRef<HTMLElement>(null)
  const apy = plan === 'flexible' ? 3.8 : 6.8
  const projected = useMemo(() => {
    const parsed = Number(amount.replace(/,/g, '')) || 0
    return (parsed * apy) / 100
  }, [amount, apy])

  const shortAddress = (address: string) => {
    if (address.length <= 12) return address
    return address.slice(0, 6) + '…' + address.slice(-4)
  }

  const ownershipMessage = (address: string, kind: WalletKind) => [
    'Rixor wallet verification',
    '',
    'Sign this message to confirm you own this wallet.',
    'This does not create a transaction or move funds.',
    '',
    'Wallet: ' + address,
    'Network: ' + (kind === 'evm' ? 'EVM' : 'Solana'),
  ].join('\n')

  const connectEvmWallet = async (wallet: DetectedWallet) => {
    setWalletConnecting(wallet.id)
    setWalletError('')

    try {
      const ethereum = wallet.provider as EvmProvider

      const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[]
      const address = accounts?.[0]
      if (!address) throw new Error('No wallet account was returned.')

      await ethereum.request({
        method: 'personal_sign',
        params: [ownershipMessage(address, 'evm'), address],
      })

      setWalletSession({ kind: 'evm', address, name: wallet.name })
      setConnectedEvmProvider(ethereum)
      const chainId = await ethereum.request({ method: 'eth_chainId' }) as string
      setEvmChainId(Number.parseInt(chainId, 16))
      setWalletModalOpen(false)
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'EVM wallet connection failed.')
    } finally {
      setWalletConnecting(null)
    }
  }

  const connectSolanaWallet = async (wallet: DetectedWallet) => {
    setWalletConnecting(wallet.id)
    setWalletError('')

    try {
      const solana = wallet.provider as SolanaProvider

      const response = await solana.connect()
      const address = response.publicKey.toString()
      const message = new TextEncoder().encode(ownershipMessage(address, 'solana'))
      await solana.signMessage(message, 'utf8')

      setWalletSession({ kind: 'solana', address, name: wallet.name })
      setWalletModalOpen(false)
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Solana wallet connection failed.')
    } finally {
      setWalletConnecting(null)
    }
  }

  const disconnectWallet = () => {
    setWalletSession(null)
    setConnectedEvmProvider(null)
    setEvmChainId(null)
    setNativeBalance('0.0000')
    setWalletError('')
    setWalletModalOpen(false)
  }

  const evmNetworks = [
    {
      id: 11155111,
      hexId: '0xaa36a7',
      name: 'Sepolia',
      shortName: 'Sepolia',
      rpcUrl: 'https://rpc.sepolia.org',
      explorerUrl: 'https://sepolia.etherscan.io',
    },
    {
      id: 46630,
      hexId: '0xb626',
      name: 'Robinhood Chain Testnet',
      shortName: 'Robinhood Testnet',
      rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
      explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    },
  ] as const

  const currentEvmNetwork = evmNetworks.find((network) => network.id === evmChainId)

  const formatNativeBalance = (hexBalance: string) => {
    try {
      const wei = BigInt(hexBalance)
      const whole = wei / 1_000_000_000_000_000_000n
      const fraction = wei % 1_000_000_000_000_000_000n
      const fractionText = fraction.toString().padStart(18, '0').slice(0, 4)
      return `${whole.toString()}.${fractionText}`
    } catch {
      return '0.0000'
    }
  }

  const refreshNativeBalance = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm') {
      setNativeBalance('0.0000')
      return
    }

    try {
      const balance = await connectedEvmProvider.request({
        method: 'eth_getBalance',
        params: [walletSession.address, 'latest'],
      }) as string
      setNativeBalance(formatNativeBalance(balance))
    } catch {
      setNativeBalance('0.0000')
    }
  }

  const switchEvmNetwork = async (networkId: number) => {
    if (!connectedEvmProvider) return
    const network = evmNetworks.find((item) => item.id === networkId)
    if (!network) return

    setNetworkSwitching(networkId)
    setWalletError('')

    try {
      await connectedEvmProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: network.hexId }],
      })
      setEvmChainId(network.id)
      window.setTimeout(() => {
        void refreshNativeBalance()
      }, 250)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? Number((error as { code?: number }).code)
        : null

      if (code === 4902) {
        try {
          await connectedEvmProvider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: network.hexId,
              chainName: network.name,
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              rpcUrls: [network.rpcUrl],
              blockExplorerUrls: [network.explorerUrl],
            }],
          })
          setEvmChainId(network.id)
          window.setTimeout(() => {
            void refreshNativeBalance()
          }, 250)
        } catch (addError) {
          setWalletError(addError instanceof Error ? addError.message : 'Could not add this testnet.')
        }
      } else {
        setWalletError(error instanceof Error ? error.message : 'Network switch failed.')
      }
    } finally {
      setNetworkSwitching(null)
    }
  }

  useEffect(() => {
    if (!connectedEvmProvider?.on || walletSession?.kind !== 'evm') return

    const handleChainChanged = (...args: unknown[]) => {
      const chainId = args[0]
      if (typeof chainId === 'string') {
        setEvmChainId(Number.parseInt(chainId, 16))
      }
    }

    connectedEvmProvider.on('chainChanged', handleChainChanged)
    return () => {
      connectedEvmProvider.removeListener?.('chainChanged', handleChainChanged)
    }
  }, [connectedEvmProvider, walletSession?.kind])

  useEffect(() => {
    if (walletSession?.kind !== 'evm' || !connectedEvmProvider) return
    void refreshNativeBalance()
  }, [walletSession?.address, walletSession?.kind, connectedEvmProvider, evmChainId])

  useEffect(() => {
    const wallets = new Map<string, DetectedWallet>()

    const addWallet = (wallet: DetectedWallet) => {
      if (!wallet.provider) return
      wallets.set(wallet.id, wallet)
      setDetectedWallets(Array.from(wallets.values()))
    }

    const onEip6963 = (event: Event) => {
      const detail = (event as CustomEvent<{
        info?: { uuid?: string; name?: string; rdns?: string }
        provider?: EvmProvider
      }>).detail

      if (!detail?.provider) return
      const id = detail.info?.uuid || detail.info?.rdns || detail.info?.name || 'evm-injected'
      addWallet({
        id: 'evm:' + id,
        name: detail.info?.name || 'EVM Wallet',
        kind: 'evm',
        provider: detail.provider,
      })
    }

    window.addEventListener('eip6963:announceProvider', onEip6963)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    const browser = window as unknown as {
      ethereum?: EvmProvider & {
        isMetaMask?: boolean
        isCoinbaseWallet?: boolean
        providers?: Array<EvmProvider & { isMetaMask?: boolean; isCoinbaseWallet?: boolean }>
      }
      solana?: SolanaProvider
      phantom?: { solana?: SolanaProvider }
      backpack?: SolanaProvider
    }

    const injectedProviders = browser.ethereum?.providers?.length
      ? browser.ethereum.providers
      : browser.ethereum
        ? [browser.ethereum]
        : []

    injectedProviders.forEach((provider, index) => {
      const name = provider.isMetaMask
        ? 'MetaMask'
        : provider.isCoinbaseWallet
          ? 'Coinbase Wallet'
          : injectedProviders.length > 1
            ? 'EVM Wallet ' + (index + 1)
            : 'Browser EVM Wallet'

      addWallet({
        id: 'evm:legacy:' + name + ':' + index,
        name,
        kind: 'evm',
        provider,
      })
    })

    const phantom = browser.phantom?.solana || (browser.solana?.isPhantom ? browser.solana : undefined)
    if (phantom) {
      addWallet({
        id: 'solana:phantom',
        name: 'Phantom',
        kind: 'solana',
        provider: phantom,
      })
    }

    if (browser.backpack || browser.solana?.isBackpack) {
      addWallet({
        id: 'solana:backpack',
        name: 'Backpack',
        kind: 'solana',
        provider: browser.backpack || browser.solana!,
      })
    }

    return () => {
      window.removeEventListener('eip6963:announceProvider', onEip6963)
    }
  }, [])

  const focusSavingsPanel = () => {
    savingsPanelRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })

    window.setTimeout(() => {
      savingsPanelRef.current?.focus({ preventScroll: true })
    }, 550)
  }

  const scrollToHowItWorks = () => {
    document.getElementById('how-it-works')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  const scrollToPlans = () => {
    document.getElementById('plans')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  const scrollToSecurity = () => {
    document.getElementById('security')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  const toggleHowCard = (card: string) => {
    setOpenHowCard((current) => current === card ? null : card)
  }

  useEffect(() => {
    const section = howSectionRef.current
    if (!section) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        setHowInView(entry.isIntersecting)
      },
      {
        threshold: 0.16,
        rootMargin: '0px 0px -8% 0px',
      },
    )

    observer.observe(section)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const section = plansSectionRef.current
    if (!section) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        setPlansInView(entry.isIntersecting)
      },
      {
        threshold: 0.18,
        rootMargin: '0px 0px -10% 0px',
      },
    )

    observer.observe(section)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const section = securitySectionRef.current
    if (!section) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        setSecurityInView(entry.isIntersecting)
      },
      {
        threshold: 0.2,
        rootMargin: '0px 0px -12% 0px',
      },
    )

    observer.observe(section)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const updateNavState = () => {
      setNavCompact(window.scrollY > 90)

      const sections = [
        { id: 'save', element: document.getElementById('save') },
        { id: 'how', element: document.getElementById('how-it-works') },
        { id: 'plans', element: document.getElementById('plans') },
        { id: 'security', element: document.getElementById('security') },
      ] as const

      const probe = window.innerHeight * 0.34
      let current: 'save' | 'how' | 'plans' | 'security' = 'save'

      for (const section of sections) {
        if (!section.element) continue
        const rect = section.element.getBoundingClientRect()
        if (rect.top <= probe && rect.bottom > probe) {
          current = section.id
          break
        }
      }

      setActiveSection(current)
    }

    updateNavState()
    window.addEventListener('scroll', updateNavState, { passive: true })
    window.addEventListener('resize', updateNavState)

    return () => {
      window.removeEventListener('scroll', updateNavState)
      window.removeEventListener('resize', updateNavState)
    }
  }, [])

  const planOptions = [
    { id: 'flexible', label: 'Flexible', apy: 3.8, days: 365, access: 'Withdraw anytime' },
    { id: '30', label: '30 days', apy: 5.2, days: 30, access: '30-day lock' },
    { id: '90', label: '90 days', apy: 6.8, days: 90, access: '90-day lock' },
    { id: '180', label: '180 days', apy: 8.1, days: 180, access: '180-day lock' },
    { id: '365', label: '1 year', apy: 9.4, days: 365, access: '1-year lock' },
  ] as const

  const selectedPlan = planOptions.find((option) => option.id === planTerm) ?? planOptions[2]
  const selectedPlanIndex = planOptions.findIndex((option) => option.id === planTerm)
  const planEarnings = planTerm === 'flexible'
    ? (planAmount * selectedPlan.apy) / 100
    : (planAmount * selectedPlan.apy * selectedPlan.days) / 36500
  const maturityDate = useMemo(() => {
    if (planTerm === 'flexible') return 'Anytime'
    const date = new Date()
    date.setDate(date.getDate() + selectedPlan.days)
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }, [planTerm, selectedPlan.days])

  const actionArrow = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 74 74"
      height="34"
      width="34"
      aria-hidden="true"
    >
      <circle strokeWidth="3" stroke="currentColor" r="35.5" cy="37" cx="37" />
      <path
        fill="currentColor"
        d="M25 35.5C24.1716 35.5 23.5 36.1716 23.5 37C23.5 37.8284 24.1716 38.5 25 38.5V35.5ZM49.0607 38.0607C49.6464 37.4749 49.6464 36.5251 49.0607 35.9393L39.5147 26.3934C38.9289 25.8076 37.9792 25.8076 37.3934 26.3934C36.8076 26.9792 36.8076 27.9289 37.3934 28.5147L45.8787 37L37.3934 45.4853C36.8076 46.0711 36.8076 47.0208 37.3934 47.6066C37.9792 48.1924 38.9289 48.1924 39.5147 47.6066L49.0607 38.0607ZM25 38.5L48 38.5V35.5L25 35.5V38.5Z"
      />
    </svg>
  )

  if (walletSession) {
    return (
      <main className={`carbon-stage dashboard-stage ${lightMode ? 'light-mode' : 'dark-mode'}`}>
        <div className="carbon-layer carbon-base" aria-hidden="true" />
        <div className="carbon-layer carbon-spotlight" aria-hidden="true" />
        <div className="carbon-layer carbon-vignette" aria-hidden="true" />
        <div className="carbon-layer carbon-grain" aria-hidden="true" />

        <header className="dashboard-topbar">
          <button className="dashboard-brand" type="button" onClick={disconnectWallet}>
            RIXOR
          </button>

          <div className="dashboard-topbar-actions">
            <label className="switch" aria-label={lightMode ? 'Switch to dark mode' : 'Switch to light mode'}>
              <input
                type="checkbox"
                className="checkbox"
                checked={lightMode}
                onChange={(event) => setLightMode(event.target.checked)}
              />
              <div className="slider" />
            </label>

            <button className="dashboard-wallet" type="button" onClick={() => setWalletModalOpen(true)}>
              <span className="dashboard-wallet-dot" />
              <span className="dashboard-wallet-identity">
                <small>
                  {walletSession.name}
                  {walletSession.kind === 'evm' && currentEvmNetwork ? ` · ${currentEvmNetwork.shortName}` : ''}
                </small>
                <strong>{shortAddress(walletSession.address)}</strong>
              </span>
              {walletSession.kind === 'evm' && (
                <span className="dashboard-wallet-native">
                  <small>WALLET BALANCE</small>
                  <strong>{nativeBalance} ETH</strong>
                </span>
              )}
            </button>
          </div>
        </header>

        {walletSession.kind === 'evm' && (
          <div className="dashboard-wallet-balance-strip">
            <span>
              <small>CONNECTED WALLET</small>
              <strong>{shortAddress(walletSession.address)}</strong>
            </span>
            <span>
              <small>NETWORK</small>
              <strong>{currentEvmNetwork?.shortName ?? (evmChainId ? `Chain ${evmChainId}` : 'Detecting…')}</strong>
            </span>
            <span>
              <small>NATIVE BALANCE</small>
              <strong>{nativeBalance} ETH</strong>
              </span>
          </div>
        )}

        {walletModalOpen && (
          <div className="wallet-modal-backdrop" role="presentation" onMouseDown={() => setWalletModalOpen(false)}>
            <section
              className="wallet-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="wallet-modal-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="wallet-modal-head">
                <div>
                  <span>RIXOR ACCESS</span>
                  <h2 id="wallet-modal-title">Wallet connected</h2>
                </div>
                <button type="button" className="wallet-modal-close" onClick={() => setWalletModalOpen(false)} aria-label="Close wallet dialog">
                  ×
                </button>
              </div>

              <div className="wallet-connected-view">
                <span className="wallet-connected-dot" />
                <div>
                  <small>{walletSession.name.toUpperCase()}</small>
                  <strong>{shortAddress(walletSession.address)}</strong>
                  {walletSession.kind === 'evm' && (
                    <span className="wallet-connected-balance">{nativeBalance} ETH</span>
                  )}
                </div>
                <button type="button" onClick={disconnectWallet}>Disconnect</button>
              </div>
            </section>
          </div>
        )}

        <section className="dashboard-shell" aria-labelledby="dashboard-title">
          <div className="dashboard-intro">
            <div>
              <span className="dashboard-kicker">YOUR SAVINGS</span>
              <h1 id="dashboard-title">Good to have you here.</h1>
              <p>Your wallet is connected. Your onchain savings will live here.</p>
            </div>

            {walletSession.kind === 'evm' ? (
              <div className="dashboard-network-switcher" aria-label="EVM testnet">
                {evmNetworks.map((network) => (
                  <button
                    key={network.id}
                    type="button"
                    className={`dashboard-network-option ${evmChainId === network.id ? 'is-active' : ''}`}
                    onClick={() => switchEvmNetwork(network.id)}
                    disabled={networkSwitching !== null}
                  >
                    <span className="dashboard-network-status" />
                    <span>{network.shortName}</span>
                    {networkSwitching === network.id && <em>Switching…</em>}
                  </button>
                ))}
                {!currentEvmNetwork && evmChainId !== null && (
                  <span className="dashboard-network-unsupported">Unsupported network</span>
                )}
              </div>
            ) : (
              <span className="dashboard-network-pill">Solana connected</span>
            )}
          </div>

          {walletSession.kind === 'evm' && walletError && (
            <p className="dashboard-network-error">{walletError}</p>
          )}

          <div className="dashboard-hero-grid">
            <div className="dashboard-summary">
              <div className="dashboard-total-card dashboard-soft-card">
                <span className="dashboard-card-label">RIXOR USDG SAVINGS</span>
                <strong>0.00 <em>USDG</em></strong>
                <p>No savings position yet.</p>

                <div className="dashboard-actions dashboard-actions--compact">
                  <button type="button" className="dashboard-action dashboard-action--primary">
                    <span>Add money</span>
                    {actionArrow}
                  </button>
                  <button type="button" className="dashboard-action">
                    <span>Start a plan</span>
                    {actionArrow}
                  </button>
                  <button type="button" className="dashboard-action">
                    <span>Withdraw</span>
                    {actionArrow}
                  </button>
                </div>
              </div>

              <div className="dashboard-metric-grid">
                <article className="dashboard-metric-card dashboard-soft-card">
                  <div className="dashboard-metric-title">
                    <span className="dashboard-metric-icon">↗</span>
                    <strong>Earned</strong>
                    <em>0%</em>
                  </div>
                  <div className="dashboard-metric-data">
                    <p>0.00 <small>USDG</small></p>
                    <div className="dashboard-range"><span style={{ width: '0%' }} /></div>
                  </div>
                </article>

                <article className="dashboard-metric-card dashboard-soft-card">
                  <div className="dashboard-metric-title">
                    <span className="dashboard-metric-icon">◎</span>
                    <strong>Available</strong>
                    <em>Ready</em>
                  </div>
                  <div className="dashboard-metric-data">
                    <p>0.00 <small>USDG</small></p>
                    <div className="dashboard-range"><span style={{ width: '0%' }} /></div>
                  </div>
                </article>
              </div>
            </div>

            <div className="rixor-wallet-stage">
              <div className="rixor-wallet-copy">
                <span>SAVINGS POCKET</span>
                <h2>Choose how your money sits.</h2>
                <p>Hover the pocket to explore the plans available to you.</p>
              </div>

              <div className="rixor-wallet" aria-label="Rixor savings plan wallet">
                <div className="rixor-wallet-back" />

                <div className="rixor-plan-card rixor-plan-card--year">
                  <div className="rixor-plan-card-inner">
                    <div className="rixor-plan-card-top">
                      <span>1 Year</span>
                      <div className="rixor-plan-chip">9.4%</div>
                    </div>
                    <div className="rixor-plan-card-bottom">
                      <div>
                        <span className="rixor-plan-label">PLAN</span>
                        <span className="rixor-plan-value">Highest rate</span>
                      </div>
                      <strong>365D</strong>
                    </div>
                  </div>
                </div>

                <div className="rixor-plan-card rixor-plan-card--ninety">
                  <div className="rixor-plan-card-inner">
                    <div className="rixor-plan-card-top">
                      <span>90 Day</span>
                      <div className="rixor-plan-chip">6.8%</div>
                    </div>
                    <div className="rixor-plan-card-bottom">
                      <div>
                        <span className="rixor-plan-label">PLAN</span>
                        <span className="rixor-plan-value">Balanced lock</span>
                      </div>
                      <strong>90D</strong>
                    </div>
                  </div>
                </div>

                <div className="rixor-plan-card rixor-plan-card--flex">
                  <div className="rixor-plan-card-inner">
                    <div className="rixor-plan-card-top">
                      <span>Flexible</span>
                      <div className="rixor-plan-chip">3.8%</div>
                    </div>
                    <div className="rixor-plan-card-bottom">
                      <div>
                        <span className="rixor-plan-label">ACCESS</span>
                        <span className="rixor-plan-value">Withdraw anytime</span>
                      </div>
                      <strong>LIVE</strong>
                    </div>
                  </div>
                </div>

                <div className="rixor-pocket">
                  <svg className="rixor-pocket-svg" viewBox="0 0 280 160" fill="none" aria-hidden="true">
                    <path
                      d="M 0 20 C 0 10, 5 10, 10 10 C 20 10, 25 25, 40 25 L 240 25 C 255 25, 260 10, 270 10 C 275 10, 280 10, 280 20 L 280 120 C 280 155, 260 160, 240 160 L 40 160 C 20 160, 0 155, 0 120 Z"
                    />
                    <path
                      d="M 8 22 C 8 16, 12 16, 15 16 C 23 16, 27 29, 40 29 L 240 29 C 253 29, 257 16, 265 16 C 268 16, 272 16, 272 22 L 272 120 C 272 150, 255 152, 240 152 L 40 152 C 25 152, 8 152, 8 120 Z"
                      className="rixor-pocket-stitch"
                    />
                  </svg>
                  <div className="rixor-pocket-content">
                    <div className="rixor-pocket-balance">
                      <span className="rixor-balance-stars">••••••</span>
                      <span className="rixor-balance-real">0.00 USDG</span>
                    </div>
                    <small>Total savings</small>
                    <span className="rixor-eye" aria-hidden="true">◉</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="dashboard-lower-grid">
            <article className="dashboard-panel dashboard-soft-card">
              <div className="dashboard-panel-head">
                <div>
                  <span>ACTIVE PLANS</span>
                  <h2>Your savings plans</h2>
                </div>
              </div>
              <div className="dashboard-empty-plan">
                <span className="dashboard-empty-orb">+</span>
                <div>
                  <strong>No active plans yet.</strong>
                  <p>Choose Flexible, 90 Day or 1 Year when you are ready to put USDG to work.</p>
                </div>
                <button type="button">Start a plan</button>
              </div>
            </article>

            <article className="dashboard-panel dashboard-soft-card">
              <div className="dashboard-panel-head">
                <div>
                  <span>ACTIVITY</span>
                  <h2>Recent movement</h2>
                </div>
              </div>
              <div className="dashboard-empty-activity">
                <span />
                <p>Your deposits, plan starts and withdrawals will appear here.</p>
              </div>
            </article>
          </div>

          <div className="dashboard-footnote">
            <span className="dashboard-footnote-dot" />
            <p>
              Connected as {shortAddress(walletSession.address)}. Balances remain at zero until
              Rixor's onchain contracts are wired into this dashboard.
            </p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main
      className={`carbon-stage ${lightMode ? 'light-mode' : 'dark-mode'}`}
      aria-label="Rixor theme background preview"
    >
      <div className="carbon-layer carbon-base" aria-hidden="true" />
      <div className="carbon-layer carbon-spotlight" aria-hidden="true" />
      <div className="carbon-layer carbon-vignette" aria-hidden="true" />
      <div className="carbon-layer carbon-grain" aria-hidden="true" />

      {walletModalOpen && (
        <div className="wallet-modal-backdrop" role="presentation" onMouseDown={() => setWalletModalOpen(false)}>
          <section
            className="wallet-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="wallet-modal-head">
              <div>
                <span>RIXOR ACCESS</span>
                <h2 id="wallet-modal-title">Connect your wallet</h2>
              </div>
              <button type="button" className="wallet-modal-close" onClick={() => setWalletModalOpen(false)} aria-label="Close wallet dialog">
                ×
              </button>
            </div>

            <>
                <p className="wallet-modal-copy">
                  Your wallet is your Rixor account. Rixor checks this browser for compatible
                  wallets, then asks you to sign a free ownership message. No funds move here.
                </p>

                <div className="wallet-options">
                  {detectedWallets.map((wallet) => {
                    const gradientId = 'solana-gradient-' + wallet.id.replace(/[^a-z0-9]/gi, '-')

                    return (
                      <button
                        key={wallet.id}
                        type="button"
                        className="wallet-option"
                        onClick={() => wallet.kind === 'evm' ? connectEvmWallet(wallet) : connectSolanaWallet(wallet)}
                        disabled={walletConnecting !== null}
                      >
                        <span className={`wallet-option-mark ${wallet.kind === 'evm' ? 'wallet-option-mark--eth' : 'wallet-option-mark--sol'}`} aria-hidden="true">
                          {wallet.kind === 'evm' ? (
                            <svg viewBox="0 0 256 417" role="presentation">
                              <path d="M127.9 0L125.1 9.5V279.1L127.9 281.9L255.8 206.3Z" fill="currentColor" opacity=".72" />
                              <path d="M127.9 0L0 206.3L127.9 281.9V154.1Z" fill="currentColor" />
                              <path d="M127.9 306.1L126.3 308V414.6L127.9 417L255.9 230.5Z" fill="currentColor" opacity=".72" />
                              <path d="M127.9 417V306.1L0 230.5Z" fill="currentColor" />
                              <path d="M127.9 281.9L255.8 206.3L127.9 154.1Z" fill="currentColor" opacity=".35" />
                              <path d="M0 206.3L127.9 281.9V154.1Z" fill="currentColor" opacity=".72" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 397 311" role="presentation">
                              <defs>
                                <linearGradient id={gradientId} x1="360" y1="17" x2="141" y2="335" gradientUnits="userSpaceOnUse">
                                  <stop stopColor="#00FFA3" />
                                  <stop offset="1" stopColor="#DC1FFF" />
                                </linearGradient>
                              </defs>
                              <path d="M64.8 237.9c2.6-2.6 6.2-4.1 9.9-4.1h317.5c6.2 0 9.3 7.5 4.9 11.9l-62.7 62.7c-2.6 2.6-6.2 4.1-9.9 4.1H7c-6.2 0-9.3-7.5-4.9-11.9l62.7-62.7Z" fill={`url(#${gradientId})`} />
                              <path d="M64.8 4.1C67.4 1.5 71 0 74.7 0h317.5c6.2 0 9.3 7.5 4.9 11.9l-62.7 62.7c-2.6 2.6-6.2 4.1-9.9 4.1H7C.8 78.7-2.3 71.2 2.1 66.8L64.8 4.1Z" fill={`url(#${gradientId})`} />
                              <path d="M332.4 120.4c-2.6-2.6-6.2-4.1-9.9-4.1H5c-6.2 0-9.3 7.5-4.9 11.9l62.7 62.7c2.6 2.6 6.2 4.1 9.9 4.1h317.5c6.2 0 9.3-7.5 4.9-11.9l-62.7-62.7Z" fill={`url(#${gradientId})`} />
                            </svg>
                          )}
                        </span>
                        <span>
                          <strong>{wallet.name}</strong>
                          <small>{wallet.kind === 'evm' ? 'EVM wallet detected' : 'Solana wallet detected'}</small>
                        </span>
                        <em>{walletConnecting === wallet.id ? 'Connecting…' : 'Detected'}</em>
                      </button>
                    )
                  })}

                  {detectedWallets.length === 0 && (
                    <div className="wallet-empty-state">
                      <span>No compatible wallet detected.</span>
                      <small>
                        Install an EVM wallet such as MetaMask or a Solana wallet such as Phantom,
                        then reopen this panel.
                      </small>
                    </div>
                  )}
                </div>

                {walletError && <p className="wallet-error">{walletError}</p>}
                <p className="wallet-modal-foot">Rixor never asks for your seed phrase or private key.</p>
            </>
          </section>
        </div>
      )}

      <header className={`top-shell ${navCompact ? 'is-compact' : ''}`}>
        <div className="tab-container" aria-label="Primary navigation">
          <input type="radio" name="tab" id="tab1" className="tab tab--1" checked={activeSection === 'save'} readOnly />
          <label className="tab_label" htmlFor="tab1" onClick={focusSavingsPanel}>Save</label>

          <input type="radio" name="tab" id="tab2" className="tab tab--2" checked={activeSection === 'how'} readOnly />
          <label className="tab_label" htmlFor="tab2" onClick={scrollToHowItWorks}>How it works</label>

          <input type="radio" name="tab" id="tab3" className="tab tab--3" checked={activeSection === 'plans'} readOnly />
          <label className="tab_label" htmlFor="tab3" onClick={scrollToPlans}>Plans</label>

          <input type="radio" name="tab" id="tab4" className="tab tab--4" checked={activeSection === 'security'} readOnly />
          <label className="tab_label" htmlFor="tab4" onClick={scrollToSecurity}>Security</label>

          <div className="indicator" />
        </div>

        <div className="theme-toggle-wrap">
          <label className="switch" aria-label={lightMode ? 'Switch to dark mode' : 'Switch to light mode'}>
            <input
              type="checkbox"
              className="checkbox"
              checked={lightMode}
              onChange={(event) => setLightMode(event.target.checked)}
            />
            <div className="slider" />
          </label>
        </div>
      </header>

      <section id="save" className="hero-copy-shell" aria-labelledby="hero-title">
        <div className="hero-layout">
          <div className="hero-copy">
          <div className="hero-kicker hero-enter hero-enter--1">ONCHAIN SAVINGS</div>

          <h1 id="hero-title" className="hero-title">
            <span className="hero-line hero-line--one hero-bounce hero-bounce--1">MAKE ROOM</span>
            <span className="hero-line hero-line--two hero-bounce hero-bounce--2">FOR MORE<span className="hero-period">.</span></span>
          </h1>

          <div className="hero-bottom-row hero-enter hero-enter--3">
            <p className="hero-description">
              Save in USDG with flexible access or lock in longer for higher returns.
            </p>

            <div className="hero-actions">
              <button className="hero-primary" type="button" onClick={focusSavingsPanel}>
                <span>Start saving</span>
                {actionArrow}
              </button>
              <button className="hero-secondary" type="button" onClick={scrollToHowItWorks}>
                <span>How it works</span>
                {actionArrow}
              </button>
            </div>
          </div>
          </div>

          <div className="hero-ball-flight" aria-hidden="true">
            <div className="hero-ball hero-ball--1" />
            <div className="hero-ball hero-ball--2" />
            <div className="hero-ball hero-ball--3" />
            <div className="hero-ball-shadow hero-ball-shadow--1" />
            <div className="hero-ball-shadow hero-ball-shadow--2" />
            <div className="hero-ball-shadow hero-ball-shadow--3" />
          </div>

          <aside
            ref={savingsPanelRef}
            className="savings-panel savings-panel--reveal"
            aria-label="Rixor savings preview"
            tabIndex={-1}
          >
            <div className="panel-head">
              <div>
                <span className="panel-eyebrow">SAVE USDG</span>
                <h2>Choose your plan</h2>
              </div>
              <span className="panel-chip">USDG</span>
            </div>

            <div className="amount-block">
              <label htmlFor="save-amount">Amount</label>
              <div className="amount-input-row">
                <span className="currency">$</span>
                <input
                  id="save-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                />
              </div>
              <span className="balance-line">Balance: 0.00 USDG</span>
            </div>

            <div className="plan-cards">
              <button type="button" className={`plan-card ${plan === 'flexible' ? 'active' : ''}`} onClick={() => setPlan('flexible')}>
                <span>Flexible</span>
                <strong>3.8% APY</strong>
                <small>Withdraw anytime</small>
              </button>
              <button type="button" className={`plan-card ${plan === 'locked' ? 'active' : ''}`} onClick={() => setPlan('locked')}>
                <span>Locked</span>
                <strong>6.8% APY</strong>
                <small>Higher return</small>
              </button>
            </div>

            <div className="earnings-row">
              <span>Estimated earnings</span>
              <strong>+{projected.toFixed(2)} USDG / year</strong>
            </div>

            <button className="connect-wallet" type="button" onClick={() => {
              setWalletError('')
              setWalletModalOpen(true)
            }}>
              <span>Connect Wallet</span>
            </button>
          </aside>
        </div>
      </section>

      <section
        id="how-it-works"
        ref={howSectionRef}
        className={`how-section ${howInView ? 'is-visible' : ''}`}
        aria-labelledby="how-title"
      >
        <div className="how-heading">
          <span className="how-kicker">HOW RIXOR WORKS</span>
          <h2 id="how-title">One balance. Your timeline.</h2>
          <p>
            Bring funds in from the wallet you already use, convert them into a single USDG
            savings balance, then choose how long you want that money to work.
          </p>
        </div>

        <div className="how-intro-flow" aria-label="Rixor savings flow">
          <div className="how-intro-copy">
            <span className="how-intro-label">THE SIMPLE VERSION</span>
            <h3>Your money moves through one clear path.</h3>
            <p>
              Connect your wallet, fund Rixor, move into USDG savings, then choose whether
              to stay flexible or lock for longer. From there, Rixor keeps the position,
              progress and next action visible in one place.
            </p>
          </div>

          <div className="how-flow-illustration" aria-hidden="true">
            <span className="flow-node">Wallet</span>
            <svg viewBox="0 0 120 34" role="presentation">
              <path d="M4 17C32 17 43 4 68 4C90 4 94 17 114 17" />
              <path d="M105 9L114 17L105 25" />
            </svg>
            <span className="flow-node flow-node--accent">USDG</span>
            <svg viewBox="0 0 120 34" role="presentation">
              <path d="M4 17C32 17 43 30 68 30C90 30 94 17 114 17" />
              <path d="M105 9L114 17L105 25" />
            </svg>
            <span className="flow-node">Plan</span>
          </div>
        </div>

        <div className="how-grid">
          <article className={`how-card how-card--connect ${openHowCard === 'connect' ? 'is-open' : ''}`} tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">01</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Connect</h3>
              <p className="how-card-lead">Start with the wallet you already have.</p>
              <p className="how-card-more">
                Connect an EVM or Solana wallet and sign a simple ownership message. Rixor
                reads your public address only — never your seed phrase or private key.
              </p>
              <button className="how-card-action" type="button" onClick={() => toggleHowCard('connect')}>
                <span>{openHowCard === 'connect' ? 'Close' : 'Explore'}</span>
                {actionArrow}
              </button>
            </div>
            <div className="how-visual how-visual--wallet" aria-hidden="true">
              <div className="wallet-shell">
                <span className="wallet-mark">R</span>
                <span className="wallet-line wallet-line--wide" />
                <span className="wallet-line" />
              </div>
              <span className="wallet-pulse" />
            </div>
          </article>

          <article className={`how-card how-card--convert ${openHowCard === 'convert' ? 'is-open' : ''}`} tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">02</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Convert</h3>
              <p className="how-card-lead">Different assets in. One savings balance out.</p>
              <p className="how-card-more">
                Supported deposits are valued and brought into one USDG-denominated balance,
                so your savings stay simple even when the funds came from different networks.
              </p>
              <button className="how-card-action" type="button" onClick={() => toggleHowCard('convert')}>
                <span>{openHowCard === 'convert' ? 'Close' : 'See flow'}</span>
                {actionArrow}
              </button>
            </div>
            <div className="how-visual how-visual--convert" aria-hidden="true">
              <div className="asset-stack">
                <span>ETH</span>
                <span>SOL</span>
                <span>USDC</span>
              </div>
              <span className="flow-line" />
              <div className="usdg-orb">USDG</div>
            </div>
          </article>

          <article className={`how-card how-card--choose how-card--wide ${openHowCard === 'choose' ? 'is-open' : ''}`} tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">03</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Choose</h3>
              <p className="how-card-lead">Flexible when you need it. Locked when you don’t.</p>
              <p className="how-card-more">
                Keep funds accessible with Flexible savings, or choose a fixed term when
                you’re comfortable committing for longer. You review the amount, term and
                illustrative rate before anything moves.
              </p>
              <button className="how-card-action" type="button" onClick={() => toggleHowCard('choose')}>
                <span>{openHowCard === 'choose' ? 'Close' : 'Compare'}</span>
                {actionArrow}
              </button>
            </div>
            <div className="how-visual how-visual--plans" aria-hidden="true">
              <div className="mini-plan mini-plan--active">
                <span>Flexible</span>
                <strong>3.8%</strong>
              </div>
              <div className="mini-plan">
                <span>90 days</span>
                <strong>6.8%</strong>
              </div>
            </div>
          </article>

          <article className={`how-card how-card--track ${openHowCard === 'track' ? 'is-open' : ''}`} tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">04</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Track</h3>
              <p className="how-card-lead">Know what your money is doing.</p>
              <p className="how-card-more">
                Follow plan balances, earnings, maturity dates and activity from one place.
                Locked plans show the time remaining; Flexible plans stay available.
              </p>
              <button className="how-card-action" type="button" onClick={() => toggleHowCard('track')}>
                <span>{openHowCard === 'track' ? 'Close' : 'View progress'}</span>
                {actionArrow}
              </button>
            </div>
            <div className="how-visual how-visual--track" aria-hidden="true">
              <div className="track-meta">
                <span>Travel fund</span>
                <strong>1,000 USDG</strong>
              </div>
              <div className="track-bar"><span /></div>
              <div className="track-foot">
                <span>42 days left</span>
                <span>+34.20</span>
              </div>
            </div>
          </article>

          <article className={`how-card how-card--review ${openHowCard === 'review' ? 'is-open' : ''}`} tabIndex={0}>
            <div className="how-card-top">
              <span className="how-step">05</span>
              <span className="how-dot" />
            </div>
            <div className="how-card-copy">
              <h3>Review</h3>
              <p className="how-card-lead">Review first. Confirm second.</p>
              <p className="how-card-more">
                Before a money-moving action is confirmed, Rixor shows the important details
                in plain language so you know exactly what you’re agreeing to.
              </p>
              <button className="how-card-action" type="button" onClick={() => toggleHowCard('review')}>
                <span>{openHowCard === 'review' ? 'Close' : 'Preview'}</span>
                {actionArrow}
              </button>
            </div>
            <div className="how-visual how-visual--review" aria-hidden="true">
              <div className="review-sheet">
                <span>90-day plan</span>
                <strong>1,000 USDG</strong>
                <div className="review-row"><span>Rate</span><b>6.8%</b></div>
                <div className="review-confirm">Confirm plan</div>
              </div>
            </div>
          </article>
        </div>

        <div className="how-close">
          <span>Built for saving, not watching charts.</span>
          <p>Put money aside, choose a timeline, and keep the progress clear.</p>
        </div>
      </section>

      <section
        id="plans"
        ref={plansSectionRef}
        className={`plans-section ${plansInView ? 'is-visible' : ''}`}
        aria-labelledby="plans-title"
      >
        <div className="plans-heading">
          <span className="plans-kicker">PLANS</span>
          <h2 id="plans-title">Choose the pace.</h2>
          <p>
            Keep access flexible or lock your USDG for longer. Move the amount, switch the
            timeline, and see what the plan could look like before you start.
          </p>
        </div>

        <div className="plans-shell">
          <div className="plans-config">
            <div className="plans-config-head">
              <div>
                <span>Plan type</span>
                <strong>{selectedPlan.label}</strong>
              </div>
              <span className="plans-apy-chip">{selectedPlan.apy}% APY</span>
            </div>

            <div className="glass-radio-group plans-radio-group">
              {planOptions.map((option) => (
                <label key={option.id} className={planTerm === option.id ? 'is-active' : ''}>
                  <input
                    type="radio"
                    name="savings-plan"
                    value={option.id}
                    checked={planTerm === option.id}
                    onChange={() => setPlanTerm(option.id)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
              <div className={'plans-glider plans-glider--' + selectedPlanIndex} />
            </div>

            <div className="plans-amount-card">
              <div className="plans-amount-head">
                <div>
                  <span className="plans-amount-label">Savings amount</span>
                  <span className="plans-amount-sub">Set how much USDG you want in this plan.</span>
                </div>
                <span className="plans-status">USDG</span>
              </div>

              <div className="plans-live-value">
                <span className="plans-currency">$</span>
                <strong>{planAmount.toLocaleString()}</strong>
              </div>

              <div className="plans-slider-wrap">
                <div
                  className="plans-slider-tooltip"
                  style={{ left: String(((planAmount - 500) / 9500) * 100) + '%' }}
                >
                  {'$'}{planAmount.toLocaleString()}
                </div>
                <div className="plans-track">
                  <div
                    className="plans-track-fill"
                    style={{ width: String(((planAmount - 500) / 9500) * 100) + '%' }}
                  />
                </div>
                <input
                  className="plans-range"
                  type="range"
                  min="500"
                  max="10000"
                  step="500"
                  value={planAmount}
                  onChange={(event) => setPlanAmount(Number(event.target.value))}
                  aria-label="Savings amount"
                />
              </div>

              <div className="plans-scale">
                <span>$500</span>
                <span>$5,000</span>
                <span>$10,000</span>
              </div>
            </div>
          </div>

          <aside className="plans-preview" aria-label="Selected savings plan preview">
            <div className="plans-preview-top">
              <span>YOUR PLAN</span>
              <span className="plans-preview-dot" />
            </div>

            <div className="plans-preview-rate">
              <strong>{selectedPlan.apy}%</strong>
              <span>illustrative APY</span>
            </div>

            <div className="plans-preview-list">
              <div>
                <span>Deposit</span>
                <strong>{planAmount.toLocaleString()} USDG</strong>
              </div>
              <div>
                <span>Access</span>
                <strong>{selectedPlan.access}</strong>
              </div>
              <div>
                <span>{planTerm === 'flexible' ? 'Estimated / year' : 'At maturity'}</span>
                <strong>+{planEarnings.toFixed(2)} USDG</strong>
              </div>
              <div>
                <span>Maturity</span>
                <strong>{maturityDate}</strong>
              </div>
            </div>

            {planTerm !== 'flexible' && (
              <p className="plans-warning">
                Early withdrawal keeps your principal intact but forfeits 50% of interest
                earned so far.
              </p>
            )}

            <p className="plans-disclaimer">Illustrative rate. Not guaranteed.</p>

            <button className="plans-action" type="button" onClick={focusSavingsPanel}>
              <span>Start this plan</span>
              {actionArrow}
            </button>
          </aside>
        </div>
      </section>

      <section
        id="security"
        ref={securitySectionRef}
        className={`security-section ${securityInView ? 'is-visible' : ''}`}
        aria-labelledby="security-title"
      >
        <div className="security-heading">
          <span className="security-kicker">SECURITY</span>
          <h2 id="security-title">Your money. Your keys. Your decision.</h2>
          <p>
            Rixor is designed to keep the boundary clear: your wallet stays yours, and every
            important action stays visible before you confirm it.
          </p>
        </div>

        <div className="security-visual" aria-label="Wallet protection boundary">
          <div className="security-side security-side--wallet">
            <span className="security-side-label">YOUR WALLET</span>
            <div className="security-wallet-card">
              <span className="security-wallet-mark">R</span>
              <div>
                <strong>Private keys</strong>
                <span>Stay with you</span>
              </div>
            </div>
          </div>

          <div className="security-boundary" aria-hidden="true">
            <span className="security-boundary-line" />
            <span className="security-lock">
              <span className="security-lock-shackle" />
              <span className="security-lock-body">✓</span>
            </span>
            <span className="security-signal security-signal--one">PUBLIC ADDRESS</span>
            <span className="security-signal security-signal--two">APPROVAL</span>
          </div>

          <div className="security-side security-side--rixor">
            <span className="security-side-label">RIXOR</span>
            <div className="security-rules">
              <div>
                <span>01</span>
                <strong>Read public address</strong>
              </div>
              <div>
                <span>02</span>
                <strong>Show action details</strong>
              </div>
              <div>
                <span>03</span>
                <strong>Wait for confirmation</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="security-grid">
          <article className="security-card">
            <span className="security-card-index">01</span>
            <h3>Wallet stays yours.</h3>
            <p>
              Connecting Rixor does not hand over your seed phrase or private key. The wallet
              remains the place where ownership stays.
            </p>
          </article>

          <article className="security-card">
            <span className="security-card-index">02</span>
            <h3>Review before action.</h3>
            <p>
              Amounts, plan terms and important effects are surfaced before a money-moving
              action is confirmed.
            </p>
          </article>

          <article className="security-card">
            <span className="security-card-index">03</span>
            <h3>Rules stay visible.</h3>
            <p>
              Access, maturity and early-withdrawal effects stay readable so the plan does not
              hide its conditions from you.
            </p>
          </article>
        </div>

        <div className="security-close">
          <span>Clear boundaries. Clear decisions.</span>
          <p>That is the standard Rixor is built around.</p>
        </div>
      </section>
    </main>
  )
}
