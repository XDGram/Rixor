import { useEffect, useMemo, useRef, useState } from 'react'
import rixorSavingsArtifact from './contracts/RixorSavingsArtifact.json'
import { Interface, decodeBytes32String, encodeBytes32String, formatEther } from 'ethers'

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

type ActivePlan = {
  id: string
  goal: string
  principalAsset: string
  principalAmount: number
  planType: number
  apy: number
  rewardAsset: string
  termLabel: string
  accessLabel: string
  startedAt: number
  maturesAt: number | null
  progress: number
  accruedReward: number
  status: 'active' | 'matured'
  txHash?: string
}

type ActivityItem = {
  id: string
  type: 'deposit' | 'plan_started' | 'withdrawal' | 'reward'
  title: string
  amount: number
  asset: string
  timestamp: number
  network: string
  status: 'confirmed' | 'pending' | 'failed'
  txHash?: string
}

type PlanHistoryItem = {
  id: string
  goal: string
  principalAmount: number
  principalAsset: string
  termLabel: string
  rewardAsset: string
  startedAt: number
  closedAt: number
  earlyExit: boolean
  earlyExitFee: number
  earlyExitFeeBps: number
  amountReturned: number
  txHash?: string
}

const MAX_EARLY_EXIT_FEE_BPS = [0, 200, 400, 600, 800] as const

const getEarlyExitQuote = (plan: ActivePlan, now = Date.now()) => {
  if (!plan.maturesAt || plan.planType === 0 || now >= plan.maturesAt) {
    return { earlyExit: false, feeBps: 0, feeAmount: 0, amountReturned: plan.principalAmount }
  }

  const maxFeeBps = MAX_EARLY_EXIT_FEE_BPS[plan.planType] ?? 0
  const duration = Math.max(1, plan.maturesAt - plan.startedAt)
  const remaining = Math.max(0, plan.maturesAt - now)
  const feeBps = Math.ceil((maxFeeBps * remaining) / duration)
  const feeAmount = (plan.principalAmount * feeBps) / 10_000

  return {
    earlyExit: true,
    feeBps,
    feeAmount,
    amountReturned: plan.principalAmount - feeAmount,
  }
}

export default function App() {
  const rixorInterface = useMemo(() => new Interface(rixorSavingsArtifact.abi), [])
  const deployedSepoliaAddress = '0x1B644D969D0b755770033AC332BaCCeFBdbc18bA'
  const deployedRobinhoodTestnetAddress = '0xeFddb13d2d3a88E65C0e935603eA26a849f6239b'
  const [lightMode, setLightMode] = useState(() => window.localStorage.getItem('rixor:theme') === 'light')
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
  const [dashboardView, setDashboardView] = useState(true)
  const [pendingWalletAction, setPendingWalletAction] = useState<'dashboard' | 'start-plan' | null>(null)
  const [pendingPlanTerm, setPendingPlanTerm] = useState<'flexible' | '30' | '90' | '180' | '365' | null>(null)
  const [detectedWallets, setDetectedWallets] = useState<DetectedWallet[]>([])
  const [connectedEvmProvider, setConnectedEvmProvider] = useState<EvmProvider | null>(null)
  const [evmChainId, setEvmChainId] = useState<number | null>(null)
  const [networkSwitching, setNetworkSwitching] = useState<number | null>(null)
  const [nativeBalance, setNativeBalance] = useState<string>('0.0000')
  const [nativeBalanceStatus, setNativeBalanceStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [nativeBalanceError, setNativeBalanceError] = useState('')
  const [deployStatus, setDeployStatus] = useState<'idle' | 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'>('idle')
  const [deployTxHash, setDeployTxHash] = useState('')
  const [deployError, setDeployError] = useState('')
  const [addMoneyOpen, setAddMoneyOpen] = useState(false)
  const [addMoneyStep, setAddMoneyStep] = useState<'amount' | 'review'>('amount')
  const [addMoneyAmount, setAddMoneyAmount] = useState('')
  const [addMoneyTxStatus, setAddMoneyTxStatus] = useState<'idle' | 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'>('idle')
  const [addMoneyTxHash, setAddMoneyTxHash] = useState('')
  const [addMoneyTxError, setAddMoneyTxError] = useState('')
  const [contractAvailableBalance, setContractAvailableBalance] = useState('0.0000')
  const [startPlanOpen, setStartPlanOpen] = useState(false)
  const [startPlanStep, setStartPlanStep] = useState<'setup' | 'review'>('setup')
  const [startPlanTerm, setStartPlanTerm] = useState<'flexible' | '30' | '90' | '180' | '365'>('90')
  const [startPlanAmount, setStartPlanAmount] = useState('')
  const [startPlanGoal, setStartPlanGoal] = useState<'emergency' | 'school' | 'rent' | 'long-term' | 'custom'>('emergency')
  const [rewardAsset, setRewardAsset] = useState<'same' | 'usdg'>('same')
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [withdrawStep, setWithdrawStep] = useState<'setup' | 'review'>('setup')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [startPlanTxStatus, setStartPlanTxStatus] = useState<'idle' | 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'>('idle')
  const [startPlanTxHash, setStartPlanTxHash] = useState('')
  const [startPlanTxError, setStartPlanTxError] = useState('')
  const [withdrawTxStatus, setWithdrawTxStatus] = useState<'idle' | 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'>('idle')
  const [withdrawTxHash, setWithdrawTxHash] = useState('')
  const [withdrawTxError, setWithdrawTxError] = useState('')
  const [activePlans, setActivePlans] = useState<ActivePlan[]>([])
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([])
  const [activityExpanded, setActivityExpanded] = useState(false)
  const [planHistory, setPlanHistory] = useState<PlanHistoryItem[]>([])
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [planWithdrawReviewOpen, setPlanWithdrawReviewOpen] = useState(false)
  const [planWithdrawTxStatus, setPlanWithdrawTxStatus] = useState<'idle' | 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'>('idle')
  const [planWithdrawTxHash, setPlanWithdrawTxHash] = useState('')
  const [planWithdrawTxError, setPlanWithdrawTxError] = useState('')
  const [planTopUpOpen, setPlanTopUpOpen] = useState(false)
  const [planTopUpAmount, setPlanTopUpAmount] = useState('')
  const [planTopUpTxStatus, setPlanTopUpTxStatus] = useState<'idle' | 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'>('idle')
  const [planTopUpTxHash, setPlanTopUpTxHash] = useState('')
  const [planTopUpTxError, setPlanTopUpTxError] = useState('')
  const [planExtendOpen, setPlanExtendOpen] = useState(false)
  const [planExtendTerm, setPlanExtendTerm] = useState<'30' | '90' | '180' | '365'>('90')
  const [planExtendTxStatus, setPlanExtendTxStatus] = useState<'idle' | 'awaiting-wallet' | 'pending' | 'confirmed' | 'failed'>('idle')
  const [planExtendTxHash, setPlanExtendTxHash] = useState('')
  const [planExtendTxError, setPlanExtendTxError] = useState('')
  const [ethUsdPrice, setEthUsdPrice] = useState<number | null>(null)
  const savingsPanelRef = useRef<HTMLElement>(null)
  const howSectionRef = useRef<HTMLElement>(null)
  const plansSectionRef = useRef<HTMLElement>(null)
  const securitySectionRef = useRef<HTMLElement>(null)
  const reconnectAttemptedRef = useRef(false)
  const apy = plan === 'flexible' ? 3.8 : 6.8
  const projected = useMemo(() => {
    const parsed = Number(amount.replace(/,/g, '')) || 0
    return (parsed * apy) / 100
  }, [amount, apy])

  const shortAddress = (address: string) => {
    if (address.length <= 12) return address
    return address.slice(0, 6) + '…' + address.slice(-4)
  }

  const connectEvmWallet = async (wallet: DetectedWallet) => {
    setWalletConnecting(wallet.id)
    setWalletError('')

    try {
      const ethereum = wallet.provider as EvmProvider

      const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[]
      const address = accounts?.[0]
      if (!address) throw new Error('No wallet account was returned.')

      setWalletSession({ kind: 'evm', address, name: wallet.name })
      setDashboardView(true)
      setConnectedEvmProvider(ethereum)
      window.localStorage.setItem('rixor:wallet-session', JSON.stringify({ id: wallet.id, kind: 'evm', address, name: wallet.name }))
      const chainId = await ethereum.request({ method: 'eth_chainId' }) as string
      setEvmChainId(Number.parseInt(chainId, 16))
      setWalletModalOpen(false)
      if (pendingWalletAction === 'start-plan') {
        setStartPlanStep('setup')
        if (pendingPlanTerm) setStartPlanTerm(pendingPlanTerm)
        setStartPlanAmount('')
        setStartPlanOpen(true)
      }
      setPendingWalletAction(null)
      setPendingPlanTerm(null)
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

      setWalletSession({ kind: 'solana', address, name: wallet.name })
      setDashboardView(true)
      setWalletModalOpen(false)
      setPendingWalletAction(null)
      setPendingPlanTerm(null)
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : 'Solana wallet connection failed.')
    } finally {
      setWalletConnecting(null)
    }
  }

  const disconnectWallet = () => {
    reconnectAttemptedRef.current = true
    window.localStorage.removeItem('rixor:wallet-session')
    setWalletSession(null)
    setDashboardView(true)
    setConnectedEvmProvider(null)
    setEvmChainId(null)
    setNativeBalance('0.0000')
    setWalletError('')
    setWalletModalOpen(false)
    setPendingWalletAction(null)
    setPendingPlanTerm(null)
  }

  const evmNetworks = [
    {
      id: 11155111,
      hexId: '0xaa36a7',
      name: 'Sepolia',
      shortName: 'Sepolia',
      rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
      balanceRpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
      explorerUrl: 'https://sepolia.etherscan.io',
    },
    {
      id: 46630,
      hexId: '0xb626',
      name: 'Robinhood Chain Testnet',
      shortName: 'Robinhood Testnet',
      rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
      balanceRpcUrls: [
        'https://rpc.testnet.chain.robinhood.com',
        'https://rpc.testnet.chain.robinhood.com/rpc',
        'https://robinhood-sepolia-rpc.publicnode.com',
      ],
      explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    },
  ] as const

  const currentEvmNetwork = evmNetworks.find((network) => network.id === evmChainId)
  const renderChainIcon = (chainId?: number | null) => chainId === 46630 ? (
    <span className="chain-mark chain-mark--robinhood" aria-hidden="true">
      <img src="/images/robinhood-chain-feather.jpg" alt="" />
    </span>
  ) : (
    <span className="chain-mark chain-mark--sepolia" aria-hidden="true">
      <svg viewBox="0 0 32 52" role="presentation">
        <path d="M16 0 0 26.5 16 36 32 26.5 16 0Z" fill="currentColor" opacity=".92" />
        <path d="M16 38.8 0 29.6 16 52 32 29.6 16 38.8Z" fill="currentColor" opacity=".58" />
        <path d="M16 5.8v24.1l11.5-4.3L16 5.8Z" fill="rgba(255,255,255,.22)" />
      </svg>
    </span>
  )

  const renderRixorBrand = (compact = false) => (
    <span className={`rixor-brand-lockup ${compact ? 'is-compact' : ''}`} aria-label="Rixor">
      <svg className="rixor-brand-mark" viewBox="0 0 36 36" role="presentation" aria-hidden="true">
        <path d="M4 5h14.2c7.5 0 12.8 4.7 12.8 11.2 0 4.1-2 7.6-5.5 9.6l-4.7-5.1c2.1-.9 3.4-2.4 3.4-4.5 0-2.8-2.2-4.7-5.5-4.7H9.8L4 5Z" />
        <path d="M4 31V21.1l12.7-9.2 5.1 5.4L4 31Z" />
        <path d="M15.6 22.6l5.3-4 10.2 12.4h-8.6l-6.9-8.4Z" />
      </svg>
      <span className="rixor-brand-word">RIXOR</span>
    </span>
  )
  const deploymentAdminAddress = '0x844c0e2b7e282156f3b5d006ad40dba3b28e5867'
  const isDeploymentAdmin = walletSession?.kind === 'evm'
    && walletSession.address.toLowerCase() === deploymentAdminAddress
  const currentRixorContractAddress = evmChainId === 11155111
    ? deployedSepoliaAddress
    : evmChainId === 46630
      ? deployedRobinhoodTestnetAddress
      : undefined
  const addMoneyParsed = Number(addMoneyAmount || 0)
  const addMoneyValid = addMoneyParsed > 0 && addMoneyParsed <= Number(nativeBalance)
  const addMoneyInsufficient = addMoneyParsed > Number(nativeBalance) && addMoneyParsed > 0

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

  const parseEthToWei = (value: string) => {
    const normalized = value.trim()
    if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Enter a valid ETH amount.')
    const [whole, fraction = ''] = normalized.split('.')
    if (fraction.length > 18) throw new Error('ETH supports up to 18 decimal places.')
    return (BigInt(whole) * 1_000_000_000_000_000_000n) + BigInt((fraction.padEnd(18, '0') || '0'))
  }

  const readBalanceFromRpc = async (address: string) => {
    if (!currentEvmNetwork) return null

    for (const rpcUrl of currentEvmNetwork.balanceRpcUrls) {
      try {
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getBalance',
            params: [address, 'latest'],
          }),
        })
        const rpcResult = await response.json() as { result?: string }
        if (rpcResult.result) return rpcResult.result
      } catch {
        // Try the next testnet RPC.
      }
    }

    return null
  }

  const setGasSafeDepositMax = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm' || !currentRixorContractAddress) return

    try {
      const rawBalance = await readBalanceFromRpc(walletSession.address)
      if (!rawBalance) throw new Error('Could not read your testnet balance.')

      const balanceWei = BigInt(rawBalance)
      let reserveWei = 200_000_000_000_000n // 0.0002 ETH minimum reserve for testnet gas.

      try {
        const [gasHex, gasPriceHex] = await Promise.all([
          connectedEvmProvider.request({
            method: 'eth_estimateGas',
            params: [{ from: walletSession.address, to: currentRixorContractAddress, value: '0x1' }],
          }) as Promise<string>,
          connectedEvmProvider.request({ method: 'eth_gasPrice' }) as Promise<string>,
        ])
        const dynamicReserve = BigInt(gasHex) * BigInt(gasPriceHex) * 2n
        if (dynamicReserve > reserveWei) reserveWei = dynamicReserve
      } catch {
        // The fixed minimum reserve remains intentionally conservative for testnet.
      }

      if (balanceWei <= reserveWei) throw new Error('Keep some test ETH in your wallet for gas.')
      const safeAmount = Number(formatEther(balanceWei - reserveWei))
      setAddMoneyAmount(safeAmount.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''))
      setAddMoneyTxError('')
    } catch (error) {
      setAddMoneyTxError(error instanceof Error ? error.message : 'Could not calculate a gas-safe maximum.')
    }
  }

  const refreshNativeBalance = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm') {
      setNativeBalance('0.0000')
      setNativeBalanceStatus('idle')
      setNativeBalanceError('')
      return
    }

    setNativeBalanceStatus('loading')
    setNativeBalanceError('')

    try {
      const chainHex = await connectedEvmProvider.request({ method: 'eth_chainId' }) as string
      const liveChainId = Number.parseInt(chainHex, 16)
      if (liveChainId !== evmChainId) setEvmChainId(liveChainId)

      const accounts = await connectedEvmProvider.request({ method: 'eth_accounts' }) as string[]
      const activeAddress = accounts?.[0] || walletSession.address
      if (activeAddress && activeAddress.toLowerCase() !== walletSession.address.toLowerCase()) {
        setWalletSession((current) => current?.kind === 'evm'
          ? { ...current, address: activeAddress }
          : current)
      }

      const walletBalance = await connectedEvmProvider.request({
        method: 'eth_getBalance',
        params: [activeAddress, 'latest'],
      }) as string

      let balance = walletBalance

      const rpcBalance = await readBalanceFromRpc(activeAddress)
      if (rpcBalance) balance = rpcBalance

      setNativeBalance(formatNativeBalance(balance))
      setNativeBalanceStatus('ready')
    } catch (error) {
      const rpcBalance = await readBalanceFromRpc(walletSession.address)
      if (rpcBalance) {
        setNativeBalance(formatNativeBalance(rpcBalance))
        setNativeBalanceStatus('ready')
        return
      }

      setNativeBalanceStatus('error')
      setNativeBalanceError(error instanceof Error ? error.message : 'Could not read the testnet wallet balance.')
    }
  }

  const refreshContractAvailableBalance = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm' || !currentRixorContractAddress) {
      setContractAvailableBalance('0.0000')
      return
    }

    try {
      // availableBalance(address) => 0xa0821be3
      const encodedAddress = walletSession.address.replace(/^0x/, '').padStart(64, '0')
      const result = await connectedEvmProvider.request({
        method: 'eth_call',
        params: [{
          to: currentRixorContractAddress,
          data: `0xa0821be3${encodedAddress}`,
        }, 'latest'],
      }) as string
      setContractAvailableBalance(formatNativeBalance(result))
    } catch {
      setContractAvailableBalance('0.0000')
    }
  }

  const refreshOnchainPlans = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm' || !currentRixorContractAddress || !currentEvmNetwork) {
      setActivePlans([])
      setActivityItems([])
      setPlanHistory([])
      return
    }

    try {
      const idsCall = rixorInterface.encodeFunctionData('getUserPlanIds', [walletSession.address])
      const idsResult = await connectedEvmProvider.request({
        method: 'eth_call',
        params: [{ to: currentRixorContractAddress, data: idsCall }, 'latest'],
      }) as string
      const decodedIds = rixorInterface.decodeFunctionResult('getUserPlanIds', idsResult)[0] as bigint[]

      const termLabels = ['Flexible', '30 days', '90 days', '180 days', '1 year']
      const accessLabels = ['Anytime', 'Locked 30 days', 'Locked 90 days', 'Locked 180 days', 'Locked 1 year']
      const apys = [3.8, 5.2, 6.8, 8.1, 9.4]

      const loadedPlans = await Promise.all(decodedIds.map(async (planId) => {
        const planCall = rixorInterface.encodeFunctionData('plans', [planId])
        const planResult = await connectedEvmProvider.request({
          method: 'eth_call',
          params: [{ to: currentRixorContractAddress, data: planCall }, 'latest'],
        }) as string
        const decoded = rixorInterface.decodeFunctionResult('plans', planResult)

        const principalWei = decoded[2] as bigint
        const planType = Number(decoded[3])
        const rewardPreference = Number(decoded[4])
        const goalBytes = decoded[5] as string
        const startedAtSeconds = Number(decoded[6])
        const maturesAtSeconds = Number(decoded[7])
        const status = Number(decoded[8])
        const startedAt = startedAtSeconds * 1000
        const maturesAt = maturesAtSeconds > 0 ? maturesAtSeconds * 1000 : null
        const now = Date.now()
        const progress = maturesAt
          ? Math.min(100, Math.max(0, ((now - startedAt) / Math.max(1, maturesAt - startedAt)) * 100))
          : 0

        let goal = 'Savings goal'
        try {
          goal = decodeBytes32String(goalBytes).replace(/-/g, ' ')
        } catch {
          // Keep the generic label when an older plan contains a non-text bytes32 goal.
        }

        return {
          rawStatus: status,
          plan: {
            id: planId.toString(),
            goal,
            principalAsset: 'ETH',
            principalAmount: Number(formatEther(principalWei)),
            planType,
            apy: apys[planType] ?? 0,
            rewardAsset: rewardPreference === 1 ? 'USDG' : 'ETH',
            termLabel: termLabels[planType] ?? 'Plan',
            accessLabel: accessLabels[planType] ?? 'Onchain',
            startedAt,
            maturesAt,
            progress,
            accruedReward: 0,
            status: (maturesAt && now >= maturesAt ? 'matured' : 'active') as 'active' | 'matured',
          } satisfies ActivePlan,
        }
      }))

      setActivePlans(loadedPlans.filter((item) => item.rawStatus === 0).map((item) => item.plan))

      if (evmChainId === 11155111 || evmChainId === 46630) {
        const planCreatedTopic = rixorInterface.getEvent('PlanCreated')!.topicHash
        const planWithdrawnTopic = rixorInterface.getEvent('PlanWithdrawn')!.topicHash
        const earlyExitFeeTopic = rixorInterface.getEvent('EarlyExitFeeCharged')!.topicHash
        const depositedTopic = rixorInterface.getEvent('Deposited')!.topicHash
        const availableWithdrawnTopic = rixorInterface.getEvent('AvailableWithdrawn')!.topicHash
        const paddedUser = `0x${walletSession.address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
        const fromBlock = evmChainId === 11155111 ? '0xb47c03' : '0x0'
        type RixorLog = { data: string; topics: string[]; transactionHash: string; blockNumber: string; logIndex: string }
        const readLogs = (topic: string) => connectedEvmProvider.request({
          method: 'eth_getLogs',
          params: [{ address: currentRixorContractAddress, fromBlock, toBlock: 'latest', topics: [topic, paddedUser] }],
        }) as Promise<RixorLog[]>

        const [logs, withdrawnLogs, earlyExitFeeLogs, depositLogs, availableWithdrawalLogs] = await Promise.all([
          readLogs(planCreatedTopic),
          readLogs(planWithdrawnTopic),
          readLogs(earlyExitFeeTopic),
          readLogs(depositedTopic),
          readLogs(availableWithdrawnTopic),
        ])

        const blockTimestampCache = new Map<string, number>()
        const getLogTimestamp = async (blockNumber: string) => {
          const cached = blockTimestampCache.get(blockNumber)
          if (cached) return cached
          const block = await connectedEvmProvider.request({
            method: 'eth_getBlockByNumber',
            params: [blockNumber, false],
          }) as { timestamp?: string } | null
          const timestamp = block?.timestamp ? Number.parseInt(block.timestamp, 16) * 1000 : Date.now()
          blockTimestampCache.set(blockNumber, timestamp)
          return timestamp
        }

        const planActivity = logs.map((log) => {
          const parsed = rixorInterface.parseLog({ data: log.data, topics: log.topics })
          const principal = parsed ? Number(formatEther(parsed.args.principal as bigint)) : 0
          const planType = parsed ? Number(parsed.args.planType) : 0
          const startedAt = parsed ? Number(parsed.args.startedAt) * 1000 : Date.now()
          return {
            id: `plan-${log.transactionHash}-${log.logIndex}`,
            type: 'plan_started' as const,
            title: `${termLabels[planType] ?? 'Savings'} plan started`,
            amount: principal,
            asset: 'ETH',
            timestamp: startedAt,
            network: currentEvmNetwork.shortName,
            status: 'confirmed' as const,
            txHash: log.transactionHash,
          }
        })

        const createdPlanMetadata = new Map(logs.map((log) => {
          const parsed = rixorInterface.parseLog({ data: log.data, topics: log.topics })
          const planId = parsed ? (parsed.args.planId as bigint).toString() : '0'
          return [planId, {
            principal: parsed ? Number(formatEther(parsed.args.principal as bigint)) : 0,
          }] as const
        }))

        const earlyExitFees = new Map(earlyExitFeeLogs.map((log) => {
          const parsed = rixorInterface.parseLog({ data: log.data, topics: log.topics })
          const planId = parsed ? (parsed.args.planId as bigint).toString() : '0'
          return [planId, {
            amount: parsed ? Number(formatEther(parsed.args.feeAmount as bigint)) : 0,
            bps: parsed ? Number(parsed.args.feeBps) : 0,
          }] as const
        }))

        const historyRows = await Promise.all(withdrawnLogs.map(async (log) => {
          const parsed = rixorInterface.parseLog({ data: log.data, topics: log.topics })
          const planId = parsed ? (parsed.args.planId as bigint).toString() : '0'
          const principalReturned = parsed ? Number(formatEther(parsed.args.principalReturned as bigint)) : 0
          const earlyExit = parsed ? Boolean(parsed.args.earlyExit) : false
          const sourcePlan = loadedPlans.find((item) => item.plan.id === planId)?.plan
          const fee = earlyExitFees.get(planId) ?? { amount: 0, bps: 0 }
          const originalPrincipal = createdPlanMetadata.get(planId)?.principal ?? (principalReturned + fee.amount)
          const closedAt = await getLogTimestamp(log.blockNumber)

          return {
            id: planId,
            goal: sourcePlan?.goal ?? 'Savings goal',
            principalAmount: originalPrincipal,
            principalAsset: 'ETH',
            termLabel: sourcePlan?.termLabel ?? 'Plan',
            rewardAsset: sourcePlan?.rewardAsset ?? 'ETH',
            startedAt: sourcePlan?.startedAt ?? closedAt,
            closedAt,
            earlyExit,
            earlyExitFee: fee.amount,
            earlyExitFeeBps: fee.bps,
            amountReturned: principalReturned,
            txHash: log.transactionHash,
          } satisfies PlanHistoryItem
        }))

        setPlanHistory(historyRows.sort((a, b) => b.closedAt - a.closedAt))

        const withdrawalActivity: ActivityItem[] = historyRows.map((item) => ({
          id: `withdraw-${item.id}-${item.txHash ?? item.closedAt}`,
          type: 'withdrawal',
          title: `${item.termLabel} plan withdrawn`,
          amount: item.amountReturned,
          asset: item.principalAsset,
          timestamp: item.closedAt,
          network: currentEvmNetwork.shortName,
          status: 'confirmed',
          txHash: item.txHash,
        }))

        const depositActivity: ActivityItem[] = await Promise.all(depositLogs.map(async (log) => {
          const parsed = rixorInterface.parseLog({ data: log.data, topics: log.topics })
          return {
            id: `deposit-${log.transactionHash}-${log.logIndex}`,
            type: 'deposit',
            title: 'Money added to Rixor',
            amount: parsed ? Number(formatEther(parsed.args.amount as bigint)) : 0,
            asset: 'ETH',
            timestamp: await getLogTimestamp(log.blockNumber),
            network: currentEvmNetwork.shortName,
            status: 'confirmed',
            txHash: log.transactionHash,
          }
        }))

        const availableWithdrawalActivity: ActivityItem[] = await Promise.all(availableWithdrawalLogs.map(async (log) => {
          const parsed = rixorInterface.parseLog({ data: log.data, topics: log.topics })
          return {
            id: `available-withdraw-${log.transactionHash}-${log.logIndex}`,
            type: 'withdrawal',
            title: 'Available balance withdrawn',
            amount: parsed ? Number(formatEther(parsed.args.amount as bigint)) : 0,
            asset: 'ETH',
            timestamp: await getLogTimestamp(log.blockNumber),
            network: currentEvmNetwork.shortName,
            status: 'confirmed',
            txHash: log.transactionHash,
          }
        }))

        setActivityItems([
          ...planActivity,
          ...withdrawalActivity,
          ...depositActivity,
          ...availableWithdrawalActivity,
        ].sort((a, b) => b.timestamp - a.timestamp))
      } else {
        setActivityItems([])
        setPlanHistory([])
      }
    } catch (error) {
      console.error('Could not hydrate Rixor plans', error)
    }
  }

  const openAddMoney = () => {
    setAddMoneyAmount('')
    setAddMoneyStep('amount')
    setAddMoneyTxStatus('idle')
    setAddMoneyTxHash('')
    setAddMoneyTxError('')
    setAddMoneyOpen(true)
  }

  const depositToRixor = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm') return
    if (!currentRixorContractAddress) {
      setAddMoneyTxError('Rixor testnet contract is not deployed on this network yet.')
      return
    }

    try {
      const value = parseEthToWei(addMoneyAmount)
      if (value <= 0n) throw new Error('Enter an amount above 0.')

      setAddMoneyTxError('')
      setAddMoneyTxStatus('awaiting-wallet')

      if (!currentEvmNetwork) throw new Error('Switch to a supported testnet first.')
      await connectedEvmProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: currentEvmNetwork.hexId }],
      })

      const confirmedChainHex = await connectedEvmProvider.request({ method: 'eth_chainId' }) as string
      const confirmedChainId = Number.parseInt(confirmedChainHex, 16)
      if (confirmedChainId !== currentEvmNetwork.id) {
        throw new Error(`Switch your wallet to ${currentEvmNetwork.shortName} before depositing.`)
      }

      const accounts = await connectedEvmProvider.request({ method: 'eth_accounts' }) as string[]
      const depositFrom = accounts?.[0]
      if (!depositFrom) throw new Error('No active EVM wallet account found.')

      const hash = await connectedEvmProvider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: depositFrom,
          to: currentRixorContractAddress,
          value: `0x${value.toString(16)}`,
        }],
      }) as string

      setAddMoneyTxHash(hash)
      setAddMoneyTxStatus('pending')

      let receipt: { status?: string } | null = null
      for (let attempt = 0; attempt < 80; attempt += 1) {
        receipt = await connectedEvmProvider.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }) as { status?: string } | null
        if (receipt) break
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
      }

      if (!receipt) throw new Error('Transaction is still pending. Check the explorer for status.')
      if (receipt.status !== '0x1') throw new Error('The deposit transaction reverted.')

      setAddMoneyTxStatus('confirmed')
      await Promise.all([refreshNativeBalance(), refreshContractAvailableBalance(), refreshOnchainPlans()])
    } catch (error) {
      setAddMoneyTxStatus('failed')
      setAddMoneyTxError(error instanceof Error ? error.message : 'Deposit transaction failed.')
    }
  }

  const waitForReceipt = async (hash: string) => {
    if (!connectedEvmProvider) return null
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const receipt = await connectedEvmProvider.request({
        method: 'eth_getTransactionReceipt',
        params: [hash],
      }) as { status?: string } | null
      if (receipt) return receipt
      await new Promise((resolve) => window.setTimeout(resolve, 1500))
    }
    return null
  }

  const createSavingsPlan = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm' || !currentRixorContractAddress) return
    if (!startPlanValid) return

    try {
      setStartPlanTxError('')
      setStartPlanTxHash('')
      setStartPlanTxStatus('awaiting-wallet')

      if (!currentEvmNetwork) throw new Error('Switch to a supported testnet first.')
      await connectedEvmProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: currentEvmNetwork.hexId }],
      })

      const confirmedChainHex = await connectedEvmProvider.request({ method: 'eth_chainId' }) as string
      if (Number.parseInt(confirmedChainHex, 16) !== currentEvmNetwork.id) {
        throw new Error(`Switch your wallet to ${currentEvmNetwork.shortName} before starting a plan.`)
      }

      const accounts = await connectedEvmProvider.request({ method: 'eth_accounts' }) as string[]
      const from = accounts?.[0]
      if (!from) throw new Error('No active EVM wallet account found.')

      const termMap: Record<typeof startPlanTerm, number> = {
        flexible: 0,
        '30': 1,
        '90': 2,
        '180': 3,
        '365': 4,
      }
      const rewardPreference = rewardAsset === 'same' ? 0 : 1
      const amountWei = parseEthToWei(startPlanAmount)
      const goalBytes = encodeBytes32String(startPlanGoal)
      const data = rixorInterface.encodeFunctionData('createPlan', [
        amountWei,
        termMap[startPlanTerm],
        rewardPreference,
        goalBytes,
      ])

      const hash = await connectedEvmProvider.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: currentRixorContractAddress, data }],
      }) as string

      setStartPlanTxHash(hash)
      setStartPlanTxStatus('pending')

      const receipt = await waitForReceipt(hash)
      if (!receipt) throw new Error('Plan transaction is still pending. Check the explorer for status.')
      if (receipt.status !== '0x1') throw new Error('Plan creation reverted.')

      setStartPlanTxStatus('confirmed')
      await Promise.all([refreshContractAvailableBalance(), refreshOnchainPlans()])
    } catch (error) {
      setStartPlanTxStatus('failed')
      setStartPlanTxError(error instanceof Error ? error.message : 'Plan creation failed.')
    }
  }

  const withdrawAvailableFromRixor = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm' || !currentRixorContractAddress) return

    try {
      const amountWei = parseEthToWei(withdrawAmount)
      if (amountWei <= 0n) throw new Error('Enter an amount above 0.')

      setWithdrawTxError('')
      setWithdrawTxHash('')
      setWithdrawTxStatus('awaiting-wallet')

      if (!currentEvmNetwork) throw new Error('Switch to a supported testnet first.')
      await connectedEvmProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: currentEvmNetwork.hexId }],
      })

      const accounts = await connectedEvmProvider.request({ method: 'eth_accounts' }) as string[]
      const from = accounts?.[0]
      if (!from) throw new Error('No active EVM wallet account found.')

      const data = rixorInterface.encodeFunctionData('withdrawAvailable', [amountWei])
      const hash = await connectedEvmProvider.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: currentRixorContractAddress, data }],
      }) as string

      setWithdrawTxHash(hash)
      setWithdrawTxStatus('pending')

      const receipt = await waitForReceipt(hash)
      if (!receipt) throw new Error('Withdrawal is still pending. Check the explorer for status.')
      if (receipt.status !== '0x1') throw new Error('Withdrawal reverted.')

      setWithdrawTxStatus('confirmed')
      await Promise.all([refreshNativeBalance(), refreshContractAvailableBalance(), refreshOnchainPlans()])
    } catch (error) {
      setWithdrawTxStatus('failed')
      setWithdrawTxError(error instanceof Error ? error.message : 'Withdrawal failed.')
    }
  }

  const withdrawSelectedPlanFromRixor = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm' || !currentRixorContractAddress || !selectedActivePlan) return

    try {
      setPlanWithdrawTxError('')
      setPlanWithdrawTxHash('')
      setPlanWithdrawTxStatus('awaiting-wallet')

      if (!currentEvmNetwork) throw new Error('Switch to a supported testnet first.')
      await connectedEvmProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: currentEvmNetwork.hexId }],
      })

      const confirmedChainHex = await connectedEvmProvider.request({ method: 'eth_chainId' }) as string
      if (Number.parseInt(confirmedChainHex, 16) !== currentEvmNetwork.id) {
        throw new Error(`Switch your wallet to ${currentEvmNetwork.shortName} before withdrawing this plan.`)
      }

      const accounts = await connectedEvmProvider.request({ method: 'eth_accounts' }) as string[]
      const from = accounts?.[0]
      if (!from) throw new Error('No active EVM wallet account found.')

      const data = rixorInterface.encodeFunctionData('withdrawPlan', [BigInt(selectedActivePlan.id)])
      const hash = await connectedEvmProvider.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: currentRixorContractAddress, data }],
      }) as string

      setPlanWithdrawTxHash(hash)
      setPlanWithdrawTxStatus('pending')

      const receipt = await waitForReceipt(hash)
      if (!receipt) throw new Error('Plan withdrawal is still pending. Check the explorer for status.')
      if (receipt.status !== '0x1') throw new Error('Plan withdrawal reverted.')

      setPlanWithdrawTxStatus('confirmed')
      await Promise.all([refreshNativeBalance(), refreshContractAvailableBalance()])
    } catch (error) {
      setPlanWithdrawTxStatus('failed')
      setPlanWithdrawTxError(error instanceof Error ? error.message : 'Plan withdrawal failed.')
    }
  }

  const topUpSelectedPlan = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm' || !currentRixorContractAddress || !selectedActivePlan) return
    const amountWei = parseEthToWei(planTopUpAmount)
    if (amountWei <= 0n) return

    try {
      setPlanTopUpTxError('')
      setPlanTopUpTxHash('')
      setPlanTopUpTxStatus('awaiting-wallet')
      if (!currentEvmNetwork) throw new Error('Switch to a supported testnet first.')
      await connectedEvmProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: currentEvmNetwork.hexId }] })
      const accounts = await connectedEvmProvider.request({ method: 'eth_accounts' }) as string[]
      const from = accounts?.[0]
      if (!from) throw new Error('No active EVM wallet account found.')
      const data = rixorInterface.encodeFunctionData('topUpPlan', [BigInt(selectedActivePlan.id), amountWei])
      const hash = await connectedEvmProvider.request({ method: 'eth_sendTransaction', params: [{ from, to: currentRixorContractAddress, data }] }) as string
      setPlanTopUpTxHash(hash)
      setPlanTopUpTxStatus('pending')
      const receipt = await waitForReceipt(hash)
      if (!receipt) throw new Error('Plan top-up is still pending. Check the explorer for status.')
      if (receipt.status !== '0x1') throw new Error('Plan top-up reverted.')
      setPlanTopUpTxStatus('confirmed')
      await Promise.all([refreshContractAvailableBalance(), refreshOnchainPlans()])
    } catch (error) {
      setPlanTopUpTxStatus('failed')
      setPlanTopUpTxError(error instanceof Error ? error.message : 'Plan top-up failed.')
    }
  }

  const extendSelectedPlan = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm' || !currentRixorContractAddress || !selectedActivePlan) return
    const planTypeMap = { '30': 1, '90': 2, '180': 3, '365': 4 } as const

    try {
      setPlanExtendTxError('')
      setPlanExtendTxHash('')
      setPlanExtendTxStatus('awaiting-wallet')
      if (!currentEvmNetwork) throw new Error('Switch to a supported testnet first.')
      await connectedEvmProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: currentEvmNetwork.hexId }] })
      const accounts = await connectedEvmProvider.request({ method: 'eth_accounts' }) as string[]
      const from = accounts?.[0]
      if (!from) throw new Error('No active EVM wallet account found.')
      const data = rixorInterface.encodeFunctionData('extendPlan', [BigInt(selectedActivePlan.id), planTypeMap[planExtendTerm]])
      const hash = await connectedEvmProvider.request({ method: 'eth_sendTransaction', params: [{ from, to: currentRixorContractAddress, data }] }) as string
      setPlanExtendTxHash(hash)
      setPlanExtendTxStatus('pending')
      const receipt = await waitForReceipt(hash)
      if (!receipt) throw new Error('Plan extension is still pending. Check the explorer for status.')
      if (receipt.status !== '0x1') throw new Error('Plan extension reverted.')
      setPlanExtendTxStatus('confirmed')
      await refreshOnchainPlans()
    } catch (error) {
      setPlanExtendTxStatus('failed')
      setPlanExtendTxError(error instanceof Error ? error.message : 'Plan extension failed.')
    }
  }

  const deployRixorContract = async () => {
    if (!connectedEvmProvider || walletSession?.kind !== 'evm') return
    if (!isDeploymentAdmin) {
      setDeployError('Only the Rixor deployment wallet can deploy protocol contracts.')
      return
    }

    const targetNetwork = currentEvmNetwork
    if (!targetNetwork) return
    const configuredAddress = targetNetwork.id === 11155111
      ? deployedSepoliaAddress
      : deployedRobinhoodTestnetAddress
    if (configuredAddress) return

    try {
      setDeployError('')
      setDeployTxHash('')
      setDeployStatus('awaiting-wallet')

      try {
        await connectedEvmProvider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: targetNetwork.hexId,
            chainName: targetNetwork.name,
            nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: targetNetwork.balanceRpcUrls,
            blockExplorerUrls: [targetNetwork.explorerUrl],
          }],
        })
      } catch {
        // Some wallets reject re-adding a built-in network. We still force-switch and verify below.
      }

      await connectedEvmProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: targetNetwork.hexId }],
      })

      const confirmedChainHex = await connectedEvmProvider.request({ method: 'eth_chainId' }) as string
      const confirmedChainId = Number.parseInt(confirmedChainHex, 16)
      if (confirmedChainId !== targetNetwork.id) {
        throw new Error(`Wallet did not switch to ${targetNetwork.shortName}. Deployment cancelled.`)
      }

      const accounts = await connectedEvmProvider.request({ method: 'eth_accounts' }) as string[]
      const deployFrom = accounts?.[0]
      if (!deployFrom) throw new Error('No active EVM wallet account found.')

      let deploymentBalanceHex: string | null = null
      for (const rpcUrl of targetNetwork.balanceRpcUrls) {
        try {
          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_getBalance',
              params: [deployFrom, 'latest'],
            }),
          })
          const result = await response.json() as { result?: string }
          if (result.result) {
            deploymentBalanceHex = result.result
            break
          }
        } catch {
          // Try the next RPC for the selected supported testnet.
        }
      }

      if (!deploymentBalanceHex) throw new Error(`Could not read your ${targetNetwork.shortName} test ETH balance. Deployment cancelled.`)
      if (BigInt(deploymentBalanceHex) === 0n) throw new Error(`This wallet has no ${targetNetwork.shortName} test ETH for deployment gas.`)

      const chainHexImmediatelyBeforeSend = await connectedEvmProvider.request({ method: 'eth_chainId' }) as string
      if (chainHexImmediatelyBeforeSend.toLowerCase() !== targetNetwork.hexId.toLowerCase()) {
        throw new Error(`Wallet left ${targetNetwork.shortName} before deployment. Current chain is ${chainHexImmediatelyBeforeSend}. Deployment cancelled.`)
      }

      setEvmChainId(confirmedChainId)

      const hash = await connectedEvmProvider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: deployFrom,
          chainId: targetNetwork.hexId,
          data: rixorSavingsArtifact.bytecode,
        }],
      }) as string

      setDeployTxHash(hash)
      setDeployStatus('pending')

      let receipt: { status?: string; contractAddress?: string } | null = null
      for (let attempt = 0; attempt < 120; attempt += 1) {
        receipt = await connectedEvmProvider.request({
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }) as { status?: string; contractAddress?: string } | null
        if (receipt) break
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
      }

      if (!receipt) throw new Error('Deployment is still pending. Check the explorer for status.')
      if (receipt.status !== '0x1' || !receipt.contractAddress) throw new Error('Contract deployment failed.')

      setDeployStatus('confirmed')
      await refreshContractAvailableBalance()
    } catch (error) {
      setDeployStatus('failed')
      const providerError = error as {
        message?: string
        code?: number | string
        data?: { message?: string } | string
      }
      const dataMessage = typeof providerError?.data === 'object' && providerError.data !== null
        ? providerError.data.message
        : typeof providerError?.data === 'string'
          ? providerError.data
          : ''
      const message = providerError?.message || dataMessage || 'Contract deployment failed.'
      const code = providerError?.code !== undefined ? ` (code ${String(providerError.code)})` : ''
      setDeployError(`${message}${code}`)
    }
  }

  const switchEvmNetwork = async (networkId: number) => {
    if (!connectedEvmProvider) return
    const network = evmNetworks.find((item) => item.id === networkId)
    if (!network) return

    setNetworkSwitching(networkId)
    setWalletError('')
    setDeployStatus('idle')
    setDeployTxHash('')
    setDeployError('')

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

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0]
      if (!Array.isArray(accounts)) return

      const nextAddress = typeof accounts[0] === 'string' ? accounts[0] : null
      if (!nextAddress) {
        disconnectWallet()
        return
      }

      setWalletSession((current) => current?.kind === 'evm'
        ? { ...current, address: nextAddress }
        : current)
    }

    connectedEvmProvider.on('chainChanged', handleChainChanged)
    connectedEvmProvider.on('accountsChanged', handleAccountsChanged)
    return () => {
      connectedEvmProvider.removeListener?.('chainChanged', handleChainChanged)
      connectedEvmProvider.removeListener?.('accountsChanged', handleAccountsChanged)
    }
  }, [connectedEvmProvider, walletSession?.kind])

  useEffect(() => {
    if (walletSession?.kind !== 'evm' || !connectedEvmProvider) return
    void Promise.all([refreshNativeBalance(), refreshContractAvailableBalance(), refreshOnchainPlans()])
  }, [walletSession?.address, walletSession?.kind, connectedEvmProvider, evmChainId, currentRixorContractAddress])

  useEffect(() => {
    setDeployStatus('idle')
    setDeployTxHash('')
    setDeployError('')
  }, [evmChainId])

  useEffect(() => {
    if (walletSession?.kind !== 'evm' || !connectedEvmProvider) return

    const refreshBalances = () => {
      void Promise.all([refreshNativeBalance(), refreshContractAvailableBalance(), refreshOnchainPlans()])
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshBalances()
    }

    window.addEventListener('focus', refreshBalances)
    document.addEventListener('visibilitychange', handleVisibility)
    const interval = window.setInterval(refreshBalances, 10_000)

    return () => {
      window.removeEventListener('focus', refreshBalances)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.clearInterval(interval)
    }
  }, [walletSession?.address, walletSession?.kind, connectedEvmProvider, evmChainId, currentRixorContractAddress])

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

  useEffect(() => {
    window.localStorage.setItem('rixor:theme', lightMode ? 'light' : 'dark')
  }, [lightMode])

  useEffect(() => {
    window.localStorage.removeItem('rixor:testnet-contracts')
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadEthUsd = async () => {
      try {
        const response = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot')
        if (!response.ok) return
        const payload = await response.json() as { data?: { amount?: string } }
        const price = Number(payload.data?.amount)
        if (!cancelled && Number.isFinite(price) && price > 0) setEthUsdPrice(price)
      } catch {
        // USD loss estimate is optional; ETH values remain authoritative.
      }
    }

    void loadEthUsd()
    const interval = window.setInterval(loadEthUsd, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (!walletSession || !dashboardView) return

    const updateAmbientChainPosition = () => {
      const scrollY = window.scrollY
      const viewportHeight = Math.max(window.innerHeight, 1)
      const sectionProgress = scrollY / viewportHeight
      document.documentElement.style.setProperty('--chain-parallax-y', `${Math.min(sectionProgress * 24, 110)}px`)
      document.documentElement.style.setProperty('--chain-parallax-rotate', `${Math.max(-3, Math.min(3, sectionProgress * 0.55 - 1.5))}deg`)
    }

    updateAmbientChainPosition()
    window.addEventListener('scroll', updateAmbientChainPosition, { passive: true })
    window.addEventListener('resize', updateAmbientChainPosition)

    return () => {
      window.removeEventListener('scroll', updateAmbientChainPosition)
      window.removeEventListener('resize', updateAmbientChainPosition)
      document.documentElement.style.removeProperty('--chain-parallax-y')
      document.documentElement.style.removeProperty('--chain-parallax-rotate')
    }
  }, [walletSession, dashboardView])

  useEffect(() => {
    if (walletSession || reconnectAttemptedRef.current || detectedWallets.length === 0) return

    let saved: { id?: string; kind?: WalletKind; address?: string; name?: string } | null = null
    try {
      saved = JSON.parse(window.localStorage.getItem('rixor:wallet-session') || 'null')
    } catch {
      window.localStorage.removeItem('rixor:wallet-session')
      return
    }

    if (!saved || saved.kind !== 'evm' || !saved.address) return
    const wallet = detectedWallets.find((item) => item.kind === 'evm' && (item.id === saved?.id || item.name === saved?.name))
    if (!wallet) return

    reconnectAttemptedRef.current = true
    const ethereum = wallet.provider as EvmProvider

    void (async () => {
      try {
        const accounts = await ethereum.request({ method: 'eth_accounts' }) as string[]
        const address = accounts?.[0]
        if (!address || address.toLowerCase() !== saved!.address!.toLowerCase()) {
          window.localStorage.removeItem('rixor:wallet-session')
          return
        }

        setWalletSession({ kind: 'evm', address, name: wallet.name })
        setConnectedEvmProvider(ethereum)
        const chainId = await ethereum.request({ method: 'eth_chainId' }) as string
        setEvmChainId(Number.parseInt(chainId, 16))
      } catch {
        window.localStorage.removeItem('rixor:wallet-session')
      }
    })()
  }, [detectedWallets, walletSession])

  const focusSavingsPanel = () => {
    savingsPanelRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })

    window.setTimeout(() => {
      savingsPanelRef.current?.focus({ preventScroll: true })
    }, 550)
  }

  const openWalletFor = (
    action: 'dashboard' | 'start-plan' = 'dashboard',
    term?: 'flexible' | '30' | '90' | '180' | '365',
  ) => {
    if (walletSession) {
      setDashboardView(true)
      if (action === 'start-plan') {
        setStartPlanStep('setup')
        if (term) setStartPlanTerm(term)
        setStartPlanAmount('')
        setStartPlanGoal('emergency')
        setRewardAsset('same')
        setStartPlanOpen(true)
      }
      return
    }

    setWalletError('')
    setPendingWalletAction(action)
    setPendingPlanTerm(term ?? null)
    setWalletModalOpen(true)
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

  const openPublicSection = (sectionId: 'home' | 'how-it-works' | 'plans' | 'security') => {
    setDashboardView(false)
    window.setTimeout(() => {
      if (sectionId === 'home') {
        window.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
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
    { id: 'flexible', label: 'Flexible', apy: 3.8, days: 365, access: 'Withdraw anytime', earlyExitMax: 0 },
    { id: '30', label: '30 days', apy: 5.2, days: 30, access: '30-day lock', earlyExitMax: 2 },
    { id: '90', label: '90 days', apy: 6.8, days: 90, access: '90-day lock', earlyExitMax: 4 },
    { id: '180', label: '180 days', apy: 8.1, days: 180, access: '180-day lock', earlyExitMax: 6 },
    { id: '365', label: '1 year', apy: 9.4, days: 365, access: '1-year lock', earlyExitMax: 8 },
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

  const startPlanSelected = planOptions.find((option) => option.id === startPlanTerm) ?? planOptions[2]
  const startPlanParsed = Number(startPlanAmount || 0)
  const startPlanAvailableBalance = Number(contractAvailableBalance)
  const startPlanInsufficient = startPlanParsed > startPlanAvailableBalance && startPlanParsed > 0
  const startPlanValid = startPlanParsed > 0 && startPlanParsed <= startPlanAvailableBalance
  const startPlanProjected = startPlanTerm === 'flexible'
    ? (startPlanParsed * startPlanSelected.apy) / 100
    : (startPlanParsed * startPlanSelected.apy * startPlanSelected.days) / 36500
  const startPlanMaturity = useMemo(() => {
    if (startPlanTerm === 'flexible') return 'Anytime'
    const date = new Date()
    date.setDate(date.getDate() + startPlanSelected.days)
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }, [startPlanTerm, startPlanSelected.days])

  const openStartPlan = () => {
    setStartPlanStep('setup')
    setStartPlanTerm('90')
    setStartPlanAmount('')
    setStartPlanGoal('emergency')
    setRewardAsset('same')
    setStartPlanOpen(true)
  }

  const openWithdraw = () => {
    setSelectedPlanId(null)
    setWithdrawStep('setup')
    setWithdrawAmount('')
    setWithdrawOpen(true)
  }

  const rixorAvailableBalance = Number(contractAvailableBalance)
  const withdrawSourceBalance = rixorAvailableBalance
  const withdrawParsed = Number(withdrawAmount || 0)
  const withdrawInsufficient = withdrawParsed > withdrawSourceBalance && withdrawParsed > 0
  const withdrawValid = withdrawParsed > 0 && withdrawParsed <= withdrawSourceBalance

  const selectedActivePlan = activePlans.find((planItem) => planItem.id === selectedPlanId) ?? null
  const selectedPlanExitQuote = selectedActivePlan ? getEarlyExitQuote(selectedActivePlan) : null
  const selectedPlanFeeUsd = selectedPlanExitQuote && ethUsdPrice
    ? selectedPlanExitQuote.feeAmount * ethUsdPrice
    : null
  const planTopUpParsed = Number(planTopUpAmount || 0)
  const planTopUpValid = planTopUpParsed > 0 && planTopUpParsed <= Number(contractAvailableBalance)
  const extensionOptions = selectedActivePlan
    ? planOptions.filter((option, index) => option.id !== 'flexible' && index > selectedActivePlan.planType)
    : []

  const formatPlanDate = (timestamp: number | null) => {
    if (!timestamp) return 'Flexible'
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  const formatActivityDate = (timestamp: number) => new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

  const savingsGoals = [
    { id: 'emergency', title: 'Emergency fund', copy: 'Keep access close while still earning.', suggested: 'flexible' },
    { id: 'school', title: 'School fees', copy: 'Match your lock period to when tuition is due.', suggested: '90' },
    { id: 'rent', title: 'Rent', copy: 'Build toward a known payment date.', suggested: '180' },
    { id: 'long-term', title: 'Long-term', copy: 'Use a longer lock when you do not need the money soon.', suggested: '365' },
    { id: 'custom', title: 'Something else', copy: 'Choose your own timeline and access level.', suggested: '30' },
  ] as const

  const selectedGoal = savingsGoals.find((goal) => goal.id === startPlanGoal) ?? savingsGoals[0]

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

  if (walletSession && selectedActivePlan) {
    return (
      <main className={`carbon-stage plan-detail-stage ${lightMode ? 'light-mode' : 'dark-mode'}`}>
        <div className="carbon-layer carbon-base" aria-hidden="true" />
        <div className="carbon-layer carbon-spotlight" aria-hidden="true" />
        <div className="carbon-layer carbon-vignette" aria-hidden="true" />
        <div className="carbon-layer carbon-grain" aria-hidden="true" />

        <header className="plan-detail-topbar">
          <button type="button" className="plan-detail-back" onClick={() => setSelectedPlanId(null)}>
            <span>←</span>
            Back to dashboard
          </button>
          <span className="plan-detail-brand">{renderRixorBrand(true)}</span>
          <div className="plan-detail-network">
            <div className="chain-inline-label">
              {currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}
              <small>{currentEvmNetwork?.shortName ?? 'EVM testnet'}</small>
            </div>
            <strong>{shortAddress(walletSession.address)}</strong>
          </div>
        </header>

        <section className="plan-detail-shell">
          <div className="plan-detail-hero">
            <span>{selectedActivePlan.status === 'matured' ? 'MATURED PLAN' : 'ACTIVE PLAN'}</span>
            <h1>{selectedActivePlan.goal}</h1>
            <p>{selectedActivePlan.termLabel} · {selectedActivePlan.apy}% rate · rewards in $RIXOR</p>
          </div>

          <div className="plan-detail-grid">
            <article className="plan-detail-primary">
              <span>PRINCIPAL</span>
              <strong>{selectedActivePlan.principalAmount.toFixed(4)} <em>{selectedActivePlan.principalAsset}</em></strong>

              <div className="plan-detail-progress-head">
                <div>
                  <small>PLAN PROGRESS</small>
                  <strong>{Math.round(selectedActivePlan.progress)}%</strong>
                </div>
                <div>
                  <small>{selectedActivePlan.maturesAt ? 'MATURITY' : 'ACCESS'}</small>
                  <strong>{selectedActivePlan.maturesAt ? formatPlanDate(selectedActivePlan.maturesAt) : selectedActivePlan.accessLabel}</strong>
                </div>
              </div>

              <div className="plan-detail-progress-track">
                <span style={{ width: `${Math.min(100, Math.max(0, selectedActivePlan.progress))}%` }} />
              </div>
            </article>

            <aside className="plan-detail-summary">
              <div><small>STARTED</small><strong>{formatPlanDate(selectedActivePlan.startedAt)}</strong></div>
              <div><small>TERM</small><strong>{selectedActivePlan.termLabel}</strong></div>
              <div><small>ACCESS</small><strong>{selectedActivePlan.accessLabel}</strong></div>
              <div><small>RATE</small><strong>{selectedActivePlan.apy}%</strong></div>
              <div><small>REWARD ASSET</small><strong>$RIXOR</strong></div>
              <div><small>ACCRUED REWARD</small><strong>{selectedActivePlan.accruedReward.toFixed(4)} RIXOR</strong></div>
            </aside>
          </div>

          <div className="plan-detail-actions-grid">
            <button
              type="button"
              onClick={() => {
                setPlanWithdrawTxStatus('idle')
                setPlanWithdrawTxHash('')
                setPlanWithdrawTxError('')
                setPlanWithdrawReviewOpen(true)
              }}
            >
              <span>Withdraw</span>
              <small>Review the effect before exiting this plan.</small>
            </button>
            <button
              type="button"
              onClick={() => {
                setPlanTopUpOpen(true)
                setPlanExtendOpen(false)
                setPlanTopUpAmount('')
                setPlanTopUpTxStatus('idle')
                setPlanTopUpTxHash('')
                setPlanTopUpTxError('')
              }}
            >
              <span>Add more</span>
              <small>Add from your available Rixor balance into this plan.</small>
            </button>
            <button
              type="button"
              disabled={extensionOptions.length === 0}
              onClick={() => {
                const nextOption = extensionOptions[0]
                if (!nextOption || nextOption.id === 'flexible') return
                setPlanExtendTerm(nextOption.id)
                setPlanExtendOpen(true)
                setPlanTopUpOpen(false)
                setPlanExtendTxStatus('idle')
                setPlanExtendTxHash('')
                setPlanExtendTxError('')
              }}
            >
              <span>Extend plan</span>
              <small>{extensionOptions.length ? 'Restart the lock on a longer term.' : 'This plan is already on the longest term.'}</small>
            </button>
          </div>

          {planTopUpOpen && (
            <div className="plan-action-panel">
              <div className="plan-action-panel-head">
                <div><span>ADD MORE</span><h2>Increase this plan.</h2></div>
                <button type="button" onClick={() => setPlanTopUpOpen(false)}>×</button>
              </div>
              <div className="plan-action-input-row">
                <div>
                  <small>AVAILABLE</small>
                  <strong>{contractAvailableBalance} ETH</strong>
                </div>
                <label>
                  <input value={planTopUpAmount} onChange={(event) => setPlanTopUpAmount(event.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0.00" />
                  <span className="asset-suffix">ETH</span>
                </label>
              </div>
              {(planTopUpTxStatus === 'awaiting-wallet' || planTopUpTxStatus === 'pending') && (
                <div className="rixor-deposit-loading" role="status" aria-live="polite">
                  <div className="rixor-deposit-loader" aria-hidden="true" />
                  <div><small>{planTopUpTxStatus === 'awaiting-wallet' ? 'WALLET APPROVAL' : 'ONCHAIN CONFIRMATION'}</small><strong>{planTopUpTxStatus === 'awaiting-wallet' ? 'Approve the plan top-up' : 'Adding to your plan…'}</strong><span>{planTopUpParsed.toFixed(4)} ETH · Plan #{selectedActivePlan.id}</span></div>
                </div>
              )}
              {planTopUpTxStatus === 'confirmed' ? (
                <a className="rixor-deposit-receipt" href={planTopUpTxHash && currentEvmNetwork ? `${currentEvmNetwork.explorerUrl}/tx/${planTopUpTxHash}` : undefined} target="_blank" rel="noreferrer">
                  <div className="rixor-receipt-machine"><div className="rixor-receipt-card"><div className="rixor-receipt-card-line"/><div className="rixor-receipt-card-dots"/></div><div className="rixor-receipt-terminal"><div className="rixor-receipt-slot"/><div className="rixor-receipt-screen"><span>{planTopUpParsed.toFixed(4)}</span><small>ETH</small></div><div className="rixor-receipt-keys"/><div className="rixor-receipt-keys second"/></div></div>
                  <div className="rixor-receipt-copy"><small>TOP-UP CONFIRMED</small><strong>{planTopUpParsed.toFixed(4)} ETH added</strong><span>Your plan principal has been updated</span></div>
                  <svg viewBox="0 0 451.846 451.847" aria-hidden="true"><path d="M345.441 248.292L151.154 442.573c-12.359 12.365-32.397 12.365-44.75 0-12.354-12.354-12.354-32.391 0-44.744L278.318 225.92 106.409 54.017c-12.354-12.359-12.354-32.394 0-44.748 12.354-12.359 32.391-12.359 44.75 0l194.287 194.284c6.177 6.18 9.262 14.271 9.262 22.366 0 8.099-3.091 16.196-9.267 22.373z"/></svg>
                </a>
              ) : planTopUpTxStatus !== 'awaiting-wallet' && planTopUpTxStatus !== 'pending' && (
                <button type="button" className="plan-action-confirm" disabled={!planTopUpValid} onClick={topUpSelectedPlan}>Add to plan</button>
              )}
              {planTopUpTxStatus === 'failed' && <div className="plan-review-error"><strong>Top-up failed</strong><span>{planTopUpTxError}</span></div>}
            </div>
          )}

          {planExtendOpen && (
            <div className="plan-action-panel">
              <div className="plan-action-panel-head">
                <div><span>EXTEND PLAN</span><h2>Choose a longer lock.</h2></div>
                <button type="button" onClick={() => setPlanExtendOpen(false)}>×</button>
              </div>
              <div className="plan-extension-options">
                {extensionOptions.map((option) => option.id !== 'flexible' && (
                  <button key={option.id} type="button" className={planExtendTerm === option.id ? 'is-active' : ''} onClick={() => setPlanExtendTerm(option.id)}>
                    <strong>{option.label}</strong><small>Up to {option.earlyExitMax}% early-exit fee</small>
                  </button>
                ))}
              </div>
              {(planExtendTxStatus === 'awaiting-wallet' || planExtendTxStatus === 'pending') && (
                <div className="rixor-deposit-loading" role="status" aria-live="polite">
                  <div className="rixor-deposit-loader" aria-hidden="true" />
                  <div><small>{planExtendTxStatus === 'awaiting-wallet' ? 'WALLET APPROVAL' : 'ONCHAIN CONFIRMATION'}</small><strong>{planExtendTxStatus === 'awaiting-wallet' ? 'Approve the extension' : 'Extending your plan…'}</strong><span>New term · {planOptions.find((option) => option.id === planExtendTerm)?.label}</span></div>
                </div>
              )}
              {planExtendTxStatus === 'confirmed' ? (
                <a className="rixor-deposit-receipt" href={planExtendTxHash && currentEvmNetwork ? `${currentEvmNetwork.explorerUrl}/tx/${planExtendTxHash}` : undefined} target="_blank" rel="noreferrer">
                  <div className="rixor-receipt-machine"><div className="rixor-receipt-card"><div className="rixor-receipt-card-line"/><div className="rixor-receipt-card-dots"/></div><div className="rixor-receipt-terminal"><div className="rixor-receipt-slot"/><div className="rixor-receipt-screen"><span>{planOptions.find((option) => option.id === planExtendTerm)?.label}</span></div><div className="rixor-receipt-keys"/><div className="rixor-receipt-keys second"/></div></div>
                  <div className="rixor-receipt-copy"><small>EXTENSION CONFIRMED</small><strong>Plan term updated</strong><span>The new lock starts from this confirmation</span></div>
                  <svg viewBox="0 0 451.846 451.847" aria-hidden="true"><path d="M345.441 248.292L151.154 442.573c-12.359 12.365-32.397 12.365-44.75 0-12.354-12.354-12.354-32.391 0-44.744L278.318 225.92 106.409 54.017c-12.354-12.359-12.354-32.394 0-44.748 12.354-12.359 32.391-12.359 44.75 0l194.287 194.284c6.177 6.18 9.262 14.271 9.262 22.366 0 8.099-3.091 16.196-9.267 22.373z"/></svg>
                </a>
              ) : planExtendTxStatus !== 'awaiting-wallet' && planExtendTxStatus !== 'pending' && (
                <button type="button" className="plan-action-confirm" onClick={extendSelectedPlan}>Extend plan</button>
              )}
              {planExtendTxStatus === 'failed' && <div className="plan-review-error"><strong>Extension failed</strong><span>{planExtendTxError}</span></div>}
            </div>
          )}

          {planWithdrawReviewOpen && (
            <div className="plan-exit-review">
              <div className="plan-exit-review-head">
                <div>
                  <span>EXIT PLAN</span>
                  <h2>Withdraw this plan?</h2>
                  <p>Review the exact early-exit cost before returning funds to {shortAddress(walletSession.address)}.</p>
                </div>
                  <strong className="amount-with-asset"><span>{selectedPlanExitQuote?.amountReturned.toFixed(4)}</span><em>ETH</em></strong>
              </div>

              <div className="plan-exit-review-meta">
                <div><small>PLAN</small><strong>{selectedActivePlan.termLabel}</strong></div>
                <div><small>GOAL</small><strong>{selectedActivePlan.goal}</strong></div>
                <div><small>NETWORK</small><strong>{currentEvmNetwork?.shortName ?? 'Unknown'}</strong></div>
                <div><small>EXIT</small><strong>{selectedPlanExitQuote?.earlyExit ? 'Early withdrawal' : 'Standard withdrawal'}</strong></div>
                <div><small>PRINCIPAL</small><strong>{selectedActivePlan.principalAmount.toFixed(4)} ETH</strong></div>
                <div><small>EARLY EXIT FEE</small><strong>{selectedPlanExitQuote?.earlyExit ? `${((selectedPlanExitQuote.feeBps ?? 0) / 100).toFixed(2)}% · ${(selectedPlanExitQuote.feeAmount ?? 0).toFixed(6)} ETH` : '0%'}</strong></div>
                <div>
                  <small>LOSS VALUE</small>
                  <strong className={selectedPlanExitQuote?.earlyExit ? 'plan-exit-loss' : ''}>
                    {selectedPlanExitQuote?.earlyExit
                      ? (selectedPlanFeeUsd !== null ? `−$${selectedPlanFeeUsd.toFixed(2)} USD` : 'USD price loading…')
                      : '$0.00 USD'}
                  </strong>
                </div>
                <div><small>YOU RECEIVE</small><strong>{selectedPlanExitQuote?.amountReturned.toFixed(6)} ETH</strong></div>
              </div>

              {selectedPlanExitQuote?.earlyExit && (
                <div className="plan-decision-warning">
                  <strong>Your fee is already decreasing.</strong>
                  <p>The early-withdrawal fee falls continuously as this plan approaches maturity and reaches 0% at maturity.</p>
                </div>
              )}

              {(planWithdrawTxStatus === 'awaiting-wallet' || planWithdrawTxStatus === 'pending') && (
                <div className="rixor-deposit-loading" role="status" aria-live="polite">
                  <div className="rixor-deposit-loader" aria-hidden="true" />
                  <div>
                    <small>{planWithdrawTxStatus === 'awaiting-wallet' ? 'WALLET APPROVAL' : 'ONCHAIN CONFIRMATION'}</small>
                    <strong>{planWithdrawTxStatus === 'awaiting-wallet' ? 'Approve the plan withdrawal' : 'Closing plan onchain…'}</strong>
                    <span>{selectedPlanExitQuote?.amountReturned.toFixed(4)} ETH expected · Plan #{selectedActivePlan.id}</span>
                  </div>
                </div>
              )}

              {planWithdrawTxStatus === 'failed' && (
                <div className="plan-review-error">
                  <strong>Withdrawal failed</strong>
                  <span>{planWithdrawTxError}</span>
                </div>
              )}

              {planWithdrawTxStatus === 'confirmed' && (
                <>
                  <a className="rixor-deposit-receipt" href={planWithdrawTxHash && currentEvmNetwork ? `${currentEvmNetwork.explorerUrl}/tx/${planWithdrawTxHash}` : undefined} target="_blank" rel="noreferrer">
                    <div className="rixor-receipt-machine"><div className="rixor-receipt-card"><div className="rixor-receipt-card-line"/><div className="rixor-receipt-card-dots"/></div><div className="rixor-receipt-terminal"><div className="rixor-receipt-slot"/><div className="rixor-receipt-screen"><span>{selectedPlanExitQuote?.amountReturned.toFixed(4)}</span><small>ETH</small></div><div className="rixor-receipt-keys"/><div className="rixor-receipt-keys second"/></div></div>
                    <div className="rixor-receipt-copy"><small>PLAN WITHDRAWN</small><strong>{selectedPlanExitQuote?.amountReturned.toFixed(6)} ETH returned</strong><span className={selectedPlanExitQuote?.earlyExit ? 'plan-exit-loss-copy' : ''}>{selectedPlanExitQuote?.earlyExit ? `−${(selectedPlanExitQuote.feeAmount ?? 0).toFixed(6)} ETH${selectedPlanFeeUsd !== null ? ` · −$${selectedPlanFeeUsd.toFixed(2)}` : ''} early-exit loss` : 'No early-exit fee'} · moved to Plan History</span></div>
                    <svg viewBox="0 0 451.846 451.847" aria-hidden="true"><path d="M345.441 248.292L151.154 442.573c-12.359 12.365-32.397 12.365-44.75 0-12.354-12.354-12.354-32.391 0-44.744L278.318 225.92 106.409 54.017c-12.354-12.359-12.354-32.394 0-44.748 12.354-12.359 32.391-12.359 44.75 0l194.287 194.284c6.177 6.18 9.262 14.271 9.262 22.366 0 8.099-3.091 16.196-9.267 22.373z"/></svg>
                  </a>
                  <button
                    type="button"
                    className="plan-exit-return"
                    onClick={async () => {
                      await refreshOnchainPlans()
                      setPlanWithdrawReviewOpen(false)
                      setSelectedPlanId(null)
                    }}
                  >
                    Return to dashboard
                  </button>
                </>
              )}

              {planWithdrawTxStatus !== 'awaiting-wallet' && planWithdrawTxStatus !== 'pending' && planWithdrawTxStatus !== 'confirmed' && (
                <div className="plan-exit-review-actions">
                  <button type="button" onClick={() => setPlanWithdrawReviewOpen(false)}>Keep plan</button>
                  <button type="button" onClick={withdrawSelectedPlanFromRixor}>Confirm withdrawal</button>
                </div>
              )}
            </div>
          )}

          <div className="plan-detail-chain-note">
            <span className="dashboard-footnote-dot" />
            <p>This page is designed to hydrate from onchain contract state and events for {shortAddress(walletSession.address)}. No private account database is required for the source of truth.</p>
          </div>
        </section>
      </main>
    )
  }

  if (walletSession && withdrawOpen) {
    return (
      <main className={`carbon-stage withdraw-page-stage ${lightMode ? 'light-mode' : 'dark-mode'}`}>
        <div className="carbon-layer carbon-base" aria-hidden="true" />
        <div className="carbon-layer carbon-spotlight" aria-hidden="true" />
        <div className="carbon-layer carbon-vignette" aria-hidden="true" />
        <div className="carbon-layer carbon-grain" aria-hidden="true" />

        <header className="withdraw-page-topbar">
          <button type="button" className="withdraw-page-back" onClick={() => setWithdrawOpen(false)}>
            <span>←</span>
            Back to dashboard
          </button>
          <span className="withdraw-page-brand">{renderRixorBrand(true)}</span>
          <div className="withdraw-page-network">
            <div className="chain-inline-label">
              {currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}
              <small>{currentEvmNetwork?.shortName ?? 'EVM testnet'}</small>
            </div>
            <strong>{shortAddress(walletSession.address)}</strong>
          </div>
        </header>

        <section className="withdraw-page-shell">
          {withdrawStep === 'setup' ? (
            <>
              <div className="withdraw-page-hero">
                <span>WITHDRAW</span>
                <h1>Withdraw your available balance.</h1>
                <p>This page only withdraws ETH already sitting in your Rixor available balance. To exit a savings plan, open that specific plan from Active Plans and withdraw it there.</p>
              </div>

              <div className="withdraw-available-banner">
                <div>
                  <small>AVAILABLE TO WITHDRAW</small>
                  <strong>{rixorAvailableBalance.toFixed(4)} ETH</strong>
                </div>
                <span>{currentEvmNetwork?.shortName ?? 'Testnet'} · {shortAddress(walletSession.address)}</span>
              </div>

              <div className="withdraw-page-layout">
                <section className="withdraw-builder-card">
                  <div className="withdraw-section-head">
                    <div>
                      <span>AMOUNT</span>
                      <h2>How much do you want back?</h2>
                    </div>
                    <p><strong>{withdrawSourceBalance.toFixed(4)} ETH</strong> available in Rixor</p>
                  </div>

                  <div className={`withdraw-amount-input ${withdrawInsufficient ? 'is-insufficient' : ''}`}>
                    <input
                      inputMode="decimal"
                      value={withdrawAmount}
                      onChange={(event) => setWithdrawAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                      placeholder="0.00"
                      aria-label="Amount to withdraw"
                    />
                    <span className="asset-suffix">ETH</span>
                  </div>

                  <div className="withdraw-quick-amounts">
                    {[25, 50, 75].map((percent) => (
                      <button
                        key={percent}
                        type="button"
                        disabled={withdrawSourceBalance <= 0}
                        onClick={() => setWithdrawAmount(((withdrawSourceBalance * percent) / 100).toFixed(4))}
                      >
                        {percent}%
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={withdrawSourceBalance <= 0}
                      onClick={() => setWithdrawAmount(withdrawSourceBalance.toFixed(4))}
                    >
                      Max
                    </button>
                  </div>

                  {withdrawSourceBalance <= 0 && (
                    <div className="withdraw-empty-state">
                      <strong>Nothing available here yet.</strong>
                      <span>This will populate from your real Rixor positions once the testnet contract is connected.</span>
                    </div>
                  )}

                  {withdrawInsufficient && (
                    <div className="withdraw-inline-error">
                      <strong>Not available</strong>
                      <span>Choose an amount within this source balance.</span>
                    </div>
                  )}

                  <div className="withdraw-destination-card">
                    <div>
                      <small>DESTINATION</small>
                      <strong>{shortAddress(walletSession.address)}</strong>
                    </div>
                    <span>Connected wallet</span>
                  </div>
                </section>

                <aside className="withdraw-summary-card">
                  <span className="withdraw-summary-kicker">WITHDRAWAL SUMMARY</span>
                  <h2>Available balance</h2>

                  <div className="withdraw-summary-amount">
                    <strong>{withdrawAmount || '0.00'}</strong>
                    <span className="asset-suffix">ETH</span>
                  </div>

                  <div className="withdraw-summary-list">
                    <div><span>Principal returned</span><strong>{(withdrawParsed || 0).toFixed(4)} ETH</strong></div>
                    <div><span>Plan impact</span><strong>None</strong></div>
                    <div><span>Destination</span><strong>{shortAddress(walletSession.address)}</strong></div>
                  </div>

                  <button
                    type="button"
                    className="withdraw-review-button"
                    disabled={!withdrawValid}
                    onClick={() => setWithdrawStep('review')}
                  >
                    Review withdrawal
                    {actionArrow}
                  </button>
                </aside>
              </div>
            </>
          ) : (
            <div className="withdraw-review-page">
              <div className="withdraw-page-hero">
                <span>FINAL CHECK</span>
                <h1>Know what leaves. Know what returns.</h1>
                <p>The destination, principal, and any reward impact are shown before the testnet transaction can be signed.</p>
              </div>

              <div className="withdraw-review-stage">
                <div className="withdraw-review-machine" aria-hidden="true">
                  <div className="review-machine-card"><div className="review-machine-card-line"/><div className="review-machine-card-dots"/></div>
                  <div className="review-machine-terminal"><div className="review-machine-slot"/><div className="review-machine-screen"><span>{withdrawParsed.toFixed(4)}</span><small>ETH</small></div><div className="review-machine-keys"/><div className="review-machine-keys second"/></div>
                  <span className="withdraw-review-machine-label">WITHDRAWAL</span>
                </div>
                <div className="withdraw-review-main refined">
                  <span>YOU RECEIVE</span>
                  <strong className="amount-with-asset"><span>{withdrawParsed.toFixed(4)}</span><em>ETH</em></strong>
                  <p>Returned directly to {shortAddress(walletSession.address)}</p>
                  <div className="withdraw-review-meta-grid">
                    <div><small>SOURCE</small><strong>Available balance</strong></div>
                    <div><small>NETWORK</small><strong>{currentEvmNetwork?.shortName ?? 'Unknown'}</strong></div>
                    <div><small>PRINCIPAL</small><strong>{withdrawParsed.toFixed(4)} ETH</strong></div>
                    <div><small>PLAN IMPACT</small><strong>None</strong></div>
                  </div>
                </div>
              </div>

              <div className="withdraw-review-note">
                <strong>Testnet safety</strong>
                <p>This sends a real testnet withdrawal from your Rixor available balance back to the connected wallet. Savings-plan exits are handled from the selected Plan Detail page.</p>
              </div>

              {(withdrawTxStatus === 'awaiting-wallet' || withdrawTxStatus === 'pending') && (
                <div className="rixor-deposit-loading" role="status" aria-live="polite">
                  <div className="rixor-deposit-loader" aria-hidden="true" />
                  <div>
                    <small>{withdrawTxStatus === 'awaiting-wallet' ? 'WALLET APPROVAL' : 'ONCHAIN CONFIRMATION'}</small>
                    <strong>{withdrawTxStatus === 'awaiting-wallet' ? 'Approve the withdrawal in your wallet' : 'Sending ETH back to your wallet…'}</strong>
                    <span>{withdrawParsed.toFixed(4)} ETH · {currentEvmNetwork?.shortName ?? 'Testnet'}</span>
                  </div>
                </div>
              )}

              {withdrawTxStatus === 'confirmed' && (
                <a className="rixor-deposit-receipt" href={withdrawTxHash && currentEvmNetwork ? `${currentEvmNetwork.explorerUrl}/tx/${withdrawTxHash}` : undefined} target="_blank" rel="noreferrer">
                  <div className="rixor-receipt-machine"><div className="rixor-receipt-card"><div className="rixor-receipt-card-line"/><div className="rixor-receipt-card-dots"/></div><div className="rixor-receipt-terminal"><div className="rixor-receipt-slot"/><div className="rixor-receipt-screen"><span>{withdrawParsed.toFixed(4)}</span><small>ETH</small></div><div className="rixor-receipt-keys"/><div className="rixor-receipt-keys second"/></div></div>
                  <div className="rixor-receipt-copy"><small>WITHDRAWAL CONFIRMED</small><strong>{withdrawParsed.toFixed(4)} ETH returned</strong><span>Sent back to your connected wallet</span></div>
                  <svg viewBox="0 0 451.846 451.847" aria-hidden="true"><path d="M345.441 248.292L151.154 442.573c-12.359 12.365-32.397 12.365-44.75 0-12.354-12.354-12.354-32.391 0-44.744L278.318 225.92 106.409 54.017c-12.354-12.359-12.354-32.394 0-44.748 12.354-12.359 32.391-12.359 44.75 0l194.287 194.284c6.177 6.18 9.262 14.271 9.262 22.366 0 8.099-3.091 16.196-9.267 22.373z"/></svg>
                </a>
              )}

              {withdrawTxStatus !== 'confirmed' && withdrawTxStatus !== 'awaiting-wallet' && withdrawTxStatus !== 'pending' && <div className="withdraw-review-actions">
                <button type="button" onClick={() => setWithdrawStep('setup')}>Back and edit</button>
                <button
                  type="button"
                  onClick={withdrawAvailableFromRixor}
                  disabled={!currentRixorContractAddress || !withdrawValid}
                >
                  Withdraw on testnet
                </button>
              </div>}

              {(withdrawTxHash || withdrawTxError) && (
                <div className={`add-money-tx-state ${withdrawTxStatus === 'confirmed' ? 'is-confirmed' : ''} ${withdrawTxStatus === 'failed' ? 'is-failed' : ''}`}>
                  {withdrawTxHash && currentEvmNetwork ? (
                    <a href={`${currentEvmNetwork.explorerUrl}/tx/${withdrawTxHash}`} target="_blank" rel="noreferrer">View transaction ↗</a>
                  ) : null}
                  {withdrawTxError && <span>{withdrawTxError}</span>}
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    )
  }

  if (walletSession && startPlanOpen) {
    return (
      <main className={`carbon-stage plan-page-stage ${lightMode ? 'light-mode' : 'dark-mode'}`}>
        <div className="carbon-layer carbon-base" aria-hidden="true" />
        <div className="carbon-layer carbon-spotlight" aria-hidden="true" />
        <div className="carbon-layer carbon-vignette" aria-hidden="true" />
        <div className="carbon-layer carbon-grain" aria-hidden="true" />

        <header className="plan-page-topbar">
          <button type="button" className="plan-page-back" onClick={() => setStartPlanOpen(false)}>
            <span>←</span>
            Back to dashboard
          </button>
          <span className="plan-page-brand">{renderRixorBrand(true)}</span>
          <div className="plan-page-network">
            <small>{currentEvmNetwork?.shortName ?? 'EVM testnet'}</small>
            <strong>{shortAddress(walletSession.address)}</strong>
          </div>
        </header>

        <section className="plan-page-shell">
          {startPlanStep === 'setup' ? (
            <>
              <div className="plan-page-hero">
                <span>BUILD A SAVINGS PLAN</span>
                <h1>What are you saving for?</h1>
                <p>Start with the goal, then choose how much access you want and how long the money can stay untouched.</p>
              </div>

              <div className="plan-goal-grid">
                {savingsGoals.map((goal) => (
                  <button
                    key={goal.id}
                    type="button"
                    className={`plan-goal-card ${startPlanGoal === goal.id ? 'is-active' : ''}`}
                    onClick={() => {
                      setStartPlanGoal(goal.id)
                      setStartPlanTerm(goal.suggested)
                    }}
                  >
                    <span className="plan-goal-mark">{startPlanGoal === goal.id ? '✓' : '○'}</span>
                    <div>
                      <span className="plan-goal-tag">
                        {goal.id === 'emergency' ? 'Quick access' :
                          goal.id === 'school' ? 'Known date' :
                            goal.id === 'rent' ? 'Planned bill' :
                              goal.id === 'long-term' ? 'Higher yield' : 'Your rules'}
                      </span>
                      <strong>{goal.title}</strong>
                      <p>{goal.copy}</p>
                      <small>
                        Suggested · {planOptions.find((item) => item.id === goal.suggested)?.label}
                      </small>
                    </div>
                  </button>
                ))}
              </div>

              <div className="plan-page-layout">
                <section className="plan-builder-panel">
                  <div className="plan-section-head">
                    <div>
                      <span>1 · CHOOSE ACCESS</span>
                      <h2>Pick a timeline</h2>
                    </div>
                    <p>Suggested for {selectedGoal.title}: <strong>{planOptions.find((item) => item.id === selectedGoal.suggested)?.label}</strong></p>
                  </div>

                  <div className="plan-page-options">
                    {planOptions.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`plan-page-option ${startPlanTerm === option.id ? 'is-active' : ''}`}
                        onClick={() => setStartPlanTerm(option.id)}
                      >
                        <div className="plan-page-option-top">
                          <span>{option.label}</span>
                          {selectedGoal.suggested === option.id && <em>Suggested</em>}
                        </div>
                        <strong>{option.apy}%</strong>
                        <small>{option.access}{option.earlyExitMax ? ` · up to ${option.earlyExitMax}% early-exit fee` : ''}</small>
                      </button>
                    ))}
                  </div>

                  <div className="plan-section-head plan-section-head--amount">
                    <div>
                      <span>2 · SET AMOUNT</span>
                      <h2>How much do you want to save?</h2>
                    </div>
                    <p><strong>{nativeBalance} ETH</strong> available on {currentEvmNetwork?.shortName ?? 'this chain'}</p>
                  </div>

                  <div className={`plan-page-amount ${startPlanInsufficient ? 'is-insufficient' : ''}`}>
                    <input
                      inputMode="decimal"
                      value={startPlanAmount}
                      onChange={(event) => setStartPlanAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                      placeholder="0.00"
                      aria-label="Amount to save"
                    />
                    <span className="asset-suffix">ETH</span>
                  </div>

                  <div className="plan-page-quick-amounts">
                    {[25, 50, 75].map((percent) => (
                      <button
                        key={percent}
                        type="button"
                        disabled={startPlanAvailableBalance <= 0}
                        onClick={() => setStartPlanAmount(((startPlanAvailableBalance * percent) / 100).toFixed(4))}
                      >
                        {percent}%
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={startPlanAvailableBalance <= 0}
                      onClick={() => setStartPlanAmount(contractAvailableBalance)}
                    >
                      Max
                    </button>
                  </div>

                  {startPlanInsufficient && (
                    <div className="plan-page-inline-error">
                      <strong>Not available</strong>
                      <span>Top up this wallet before creating the plan.</span>
                    </div>
                  )}

                  <div className="plan-section-head plan-section-head--reward">
                    <div>
                      <span>3 · REWARDS</span>
                      <h2>Rewards are paid in $RIXOR.</h2>
                    </div>
                  </div>

                  <div className="plan-reward-grid">
                    <div className="plan-reward-card is-active">
                      <div className="plan-reward-topline">
                        <span>Rixor reward token</span>
                        <em>Only reward asset</em>
                      </div>
                      <strong>Earn $RIXOR</strong>
                      <p>Your saved principal remains ETH. Plan rewards vest separately in $RIXOR and are paid from the protocol rewards treasury.</p>
                    </div>
                  </div>
                </section>

                <aside className="plan-decision-panel">
                  <span className="plan-decision-kicker">YOUR PLAN</span>
                  <h2>{selectedGoal.title}</h2>
                  <div className="plan-decision-amount">
                    <strong>{startPlanAmount || '0.00'}</strong>
                    <span>ETH</span>
                  </div>

                  <div className="plan-decision-list">
                    <div><span>Timeline</span><strong>{startPlanSelected.label}</strong></div>
                    <div><span>Rate</span><strong>{startPlanSelected.apy}%</strong></div>
                    <div><span>Access</span><strong>{startPlanSelected.access}</strong></div>
                    <div><span>Maturity</span><strong>{startPlanMaturity}</strong></div>
                    <div><span>Rewards</span><strong>$RIXOR</strong></div>
                  </div>

                  <div className="plan-decision-estimate">
                    <small>ESTIMATED REWARD VALUE</small>
                    <strong>Paid in $RIXOR at settlement</strong>
                    <p>Reward value accrues through the plan and is settled in $RIXOR. Rates are not guaranteed.</p>
                  </div>

                  {startPlanTerm !== 'flexible' && (
                    <div className="plan-decision-warning">
                      <strong>Locked plan</strong>
                      <p>Early withdrawal starts at a maximum {startPlanSelected.earlyExitMax}% fee and declines continuously to 0% at maturity.</p>
                    </div>
                  )}

                  <button
                    type="button"
                    className="plan-page-review-button"
                    disabled={!startPlanValid}
                    onClick={() => setStartPlanStep('review')}
                  >
                    Review this plan
                    {actionArrow}
                  </button>
                </aside>
              </div>
            </>
          ) : (
            <div className="plan-review-page is-refined">
              <div className="plan-review-hero-row">
                <div className="plan-page-hero plan-page-hero--review">
                  <span>FINAL CHECK</span>
                  <h1>Make it official.</h1>
                  <p>Review the plan once, then approve a single transaction on the selected testnet.</p>
                </div>
                <div className="plan-review-network-pill">
                  {currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}
                  <small>{currentEvmNetwork?.shortName ?? 'Testnet'}</small>
                  <strong>{shortAddress(walletSession.address)}</strong>
                </div>
              </div>

              <div className="plan-review-stage">
                <div className="plan-review-machine" aria-hidden="true">
                  <div className="plan-review-machine-card">
                    <div className="plan-review-machine-line" />
                    <div className="plan-review-machine-dots" />
                  </div>
                  <div className="plan-review-machine-terminal">
                    <div className="plan-review-machine-slot" />
                    <div className="plan-review-machine-screen">
                      <span>{Number(startPlanAmount || 0).toFixed(4)}</span>
                      <small>ETH</small>
                    </div>
                    <div className="plan-review-machine-keys" />
                    <div className="plan-review-machine-keys second" />
                  </div>
                  <span className="plan-review-machine-label">{startPlanSelected.label.toUpperCase()}</span>
                </div>

                <div className="plan-review-primary">
                  <span>{selectedGoal.title.toUpperCase()}</span>
                    <strong className="amount-with-asset"><span>{Number(startPlanAmount || 0).toFixed(4)}</span><em>ETH</em></strong>
                  <p>{startPlanSelected.label} · {startPlanSelected.apy}% rate · rewards in $RIXOR</p>

                  <div className="plan-review-meta-grid">
                    <div><small>ACCESS</small><strong>{startPlanSelected.access}</strong></div>
                    <div><small>MATURITY</small><strong>{startPlanMaturity}</strong></div>
                    <div><small>REWARD</small><strong>$RIXOR</strong></div>
                    <div><small>EST. REWARD*</small><strong>Settled in $RIXOR</strong></div>
                  </div>
                </div>
              </div>

              <div className="plan-review-explainer refined">
                <div>
                  <span className="dashboard-footnote-dot" />
                  <div>
                    <strong>Your principal stays ETH. Rewards are separate.</strong>
                    <p>$RIXOR is the only reward asset. Rewards vest over the plan and are funded from a dedicated $RIXOR rewards treasury, with protocol revenue and real yield intended to replenish that treasury over time.</p>
                  </div>
                </div>
                <small>{currentRixorContractAddress ? `Contract ${shortAddress(currentRixorContractAddress)}` : 'Contract unavailable'}</small>
              </div>

              {(startPlanTxStatus === 'awaiting-wallet' || startPlanTxStatus === 'pending') && (
                <div className="plan-review-loading" role="status" aria-live="polite">
                  <div className="plan-review-loader" aria-hidden="true" />
                  <div>
                    <small>{startPlanTxStatus === 'awaiting-wallet' ? 'WALLET APPROVAL' : 'ONCHAIN CONFIRMATION'}</small>
                    <strong>{startPlanTxStatus === 'awaiting-wallet' ? 'Approve your savings plan' : 'Creating your plan…'}</strong>
                    <span>{Number(startPlanAmount || 0).toFixed(4)} ETH · {startPlanSelected.label}</span>
                  </div>
                </div>
              )}

              {startPlanTxStatus === 'failed' && (
                <div className="plan-review-error">
                  <strong>Plan creation failed</strong>
                  <span>{startPlanTxError || 'The transaction did not complete.'}</span>
                </div>
              )}

              {startPlanTxStatus === 'confirmed' ? (
                <a className="rixor-deposit-receipt" href={startPlanTxHash && currentEvmNetwork ? `${currentEvmNetwork.explorerUrl}/tx/${startPlanTxHash}` : undefined} target="_blank" rel="noreferrer">
                  <div className="rixor-receipt-machine"><div className="rixor-receipt-card"><div className="rixor-receipt-card-line"/><div className="rixor-receipt-card-dots"/></div><div className="rixor-receipt-terminal"><div className="rixor-receipt-slot"/><div className="rixor-receipt-screen"><span>{Number(startPlanAmount || 0).toFixed(4)}</span><small>ETH</small></div><div className="rixor-receipt-keys"/><div className="rixor-receipt-keys second"/></div></div>
                  <div className="rixor-receipt-copy"><small>PLAN CONFIRMED</small><strong>{Number(startPlanAmount || 0).toFixed(4)} ETH committed</strong><span>{startPlanSelected.label} plan is now active</span></div>
                  <svg viewBox="0 0 451.846 451.847" aria-hidden="true"><path d="M345.441 248.292L151.154 442.573c-12.359 12.365-32.397 12.365-44.75 0-12.354-12.354-12.354-32.391 0-44.744L278.318 225.92 106.409 54.017c-12.354-12.359-12.354-32.394 0-44.748 12.354-12.359 32.391-12.359 44.75 0l194.287 194.284c6.177 6.18 9.262 14.271 9.262 22.366 0 8.099-3.091 16.196-9.267 22.373z"/></svg>
                </a>
              ) : startPlanTxStatus !== 'awaiting-wallet' && startPlanTxStatus !== 'pending' && (
                <div className="plan-review-actions plan-review-actions--page refined">
                  <button type="button" onClick={() => setStartPlanStep('setup')}>Back and edit</button>
                  <button
                    type="button"
                    className="plan-review-confirm"
                    onClick={createSavingsPlan}
                    disabled={!currentRixorContractAddress || !startPlanValid}
                  >
                    <span>Confirm & start plan</span>
                    <small>{Number(startPlanAmount || 0).toFixed(4)} ETH</small>
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    )
  }

  if (walletSession && dashboardView) {
    return (
      <main className={`carbon-stage dashboard-stage ${lightMode ? 'light-mode' : 'dark-mode'}`}>
        <div className="carbon-layer carbon-base" aria-hidden="true" />
        <div className="carbon-layer carbon-spotlight" aria-hidden="true" />
        <div className="carbon-layer carbon-vignette" aria-hidden="true" />
        <div className="carbon-layer carbon-grain" aria-hidden="true" />

        {walletSession.kind === 'evm' && currentEvmNetwork && (
          <div className={`dashboard-chain-ambient dashboard-chain-ambient--${currentEvmNetwork.id === 46630 ? 'robinhood' : 'sepolia'}`} aria-hidden="true">
            {currentEvmNetwork.id === 46630 ? (
              <img
                src={lightMode ? '/images/robinhood-chain-feather.jpg' : '/images/robinhood-chain-feather-transparent.png'}
                alt=""
                className="dashboard-robinhood-ambient-mark"
              />
            ) : (
              <svg className="dashboard-ambient-eth-mark" viewBox="0 0 784.37 1277.39" role="presentation">
                <polygon fill="#B9D700" points="392.07,0 383.5,29.11 383.5,873.74 392.07,882.29 784.13,650.54" />
                <polygon fill="#CFEF00" points="392.07,0 0,650.54 392.07,882.29 392.07,472.33" />
                <polygon fill="#8FA500" points="392.07,956.52 387.24,962.41 387.24,1263.28 392.07,1277.38 784.37,724.89" />
                <polygon fill="#CFEF00" points="392.07,1277.38 392.07,956.52 0,724.89" />
                <polygon fill="#718000" points="392.07,882.29 784.13,650.54 392.07,472.33" />
                <polygon fill="#A9C300" points="0,650.54 392.07,882.29 392.07,472.33" />
              </svg>
            )}
          </div>
        )}

        <header className="dashboard-topbar">
          <button className="dashboard-brand" type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            {renderRixorBrand()}
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
              {walletSession.kind === 'evm' && currentEvmNetwork
                ? renderChainIcon(currentEvmNetwork.id)
                : <span className="dashboard-wallet-dot" />}
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
              <strong className="dashboard-network-value">
                {currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}
                {currentEvmNetwork?.shortName ?? (evmChainId ? `Chain ${evmChainId}` : 'Detecting…')}
              </strong>
            </span>
            <span>
              <small>{currentEvmNetwork ? `${currentEvmNetwork.shortName.toUpperCase()} WALLET BALANCE` : 'TESTNET WALLET BALANCE'}</small>
              <strong>{nativeBalanceStatus === 'loading' ? 'Refreshing…' : `${nativeBalance} ETH`}</strong>
            </span>
            <button
              type="button"
              className="dashboard-balance-refresh"
              onClick={() => void Promise.all([refreshNativeBalance(), refreshContractAvailableBalance()])}
            >
              Refresh
            </button>
          </div>
        )}

        {walletSession.kind === 'evm' && nativeBalanceStatus === 'error' && (
          <div className="dashboard-balance-read-error">
            <strong>Could not read {currentEvmNetwork?.shortName ?? 'testnet'} balance.</strong>
            <span>{nativeBalanceError || 'Try Refresh or reconnect the wallet.'}</span>
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
                {walletSession.kind === 'evm' && currentEvmNetwork
                  ? renderChainIcon(currentEvmNetwork.id)
                  : <span className="wallet-connected-dot" />}
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

        {addMoneyOpen && (
          <div className="wallet-modal-backdrop add-money-backdrop" role="presentation" onMouseDown={() => setAddMoneyOpen(false)}>
            <section
              className={`add-money-modal ${addMoneyStep === 'review' ? 'is-review' : ''}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-money-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="add-money-head">
                <div>
                  <span>TESTNET FUNDING</span>
                  <h2 id="add-money-title">{addMoneyStep === 'amount' ? 'Add money' : 'Review deposit'}</h2>
                </div>
                <button type="button" className="wallet-modal-close" onClick={() => setAddMoneyOpen(false)} aria-label="Close add money dialog">
                  ×
                </button>
              </div>

              {walletSession.kind !== 'evm' ? (
                <div className="add-money-disabled">
                  <strong>EVM wallet required.</strong>
                  <p>Testnet deposits are being built on Sepolia and Robinhood Chain Testnet first.</p>
                </div>
              ) : addMoneyStep === 'amount' ? (
                <>
                  <div className="add-money-chain-summary">
                    <div className="add-money-chain-copy">
                      <span>AVAILABLE ON THIS CHAIN</span>
                      <h3 className="chain-title-with-logo">{currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}{currentEvmNetwork?.shortName ?? 'Unsupported network'}</h3>
                      <p>This is the amount available from your connected wallet on this network.</p>
                    </div>
                    <div className="add-money-chain-balance">
                      <small>YOU CAN ADD UP TO</small>
                      <strong className="amount-with-asset"><span>{nativeBalance}</span><em>ETH</em></strong>
                    </div>
                  </div>

                  <div className="add-money-asset-card dashboard-soft-card">
                    <div className="add-money-asset-top">
                      <div className="add-money-chain-icon">{currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}</div>
                      <div>
                        <span>FUNDING ASSET</span>
                        <strong>ETH</strong>
                      </div>
                      <em>Testnet</em>
                    </div>
                    <p>Native testnet ETH is the principal asset for this first Rixor contract version.</p>
                  </div>

                  <div className="add-money-amount-card dashboard-soft-card">
                    <div className="add-money-amount-head">
                      <div>
                        <label htmlFor="add-money-amount">Amount to add</label>
                        <small>From {currentEvmNetwork?.shortName ?? 'current chain'}</small>
                      </div>
                      <span className={`add-money-available-pill ${addMoneyInsufficient ? 'is-insufficient' : ''}`}>
                        {nativeBalance} ETH available
                      </span>
                    </div>
                    <div className={`add-money-input-wrap ${addMoneyInsufficient ? 'is-insufficient' : ''}`}>
                      <input
                        id="add-money-amount"
                        inputMode="decimal"
                        value={addMoneyAmount}
                        onChange={(event) => setAddMoneyAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                        placeholder="0.00"
                      />
                      <span className="asset-suffix">ETH</span>
                    </div>
                    <div className="dashboard-range add-money-range">
                      <span
                        style={{
                          width: `${Math.min(
                            100,
                            Number(nativeBalance) > 0 ? (Number(addMoneyAmount || 0) / Number(nativeBalance)) * 100 : 0,
                          )}%`,
                        }}
                      />
                    </div>

                    {addMoneyInsufficient && (
                      <div className="add-money-inline-error">
                        <span>Not available</span>
                        <strong>Top up this wallet first</strong>
                      </div>
                    )}

                    <div className="add-money-quick-amounts" aria-label="Quick amount selection">
                      {[25, 50, 75].map((percent) => (
                        <button
                          key={percent}
                          type="button"
                          disabled={Number(nativeBalance) <= 0}
                          onClick={() => setAddMoneyAmount(((Number(nativeBalance) * percent) / 100).toFixed(4))}
                        >
                          {percent}%
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={Number(nativeBalance) <= 0}
                        onClick={() => void setGasSafeDepositMax()}
                      >
                        Max (keep gas)
                      </button>
                    </div>

                    <div className="add-money-balance-line">
                      <span>
                        <small>CHAIN BALANCE</small>
                        <strong>{nativeBalance} ETH</strong>
                      </span>
                      <span>
                        <small>AFTER THIS</small>
                        <strong>{Math.max(0, Number(nativeBalance) - Number(addMoneyAmount || 0)).toFixed(4)} ETH</strong>
                      </span>
                    </div>
                  </div>

                  {!currentEvmNetwork && (
                    <p className="add-money-warning">Switch to Sepolia or Robinhood Testnet before continuing.</p>
                  )}
                  {addMoneyAmount && !addMoneyValid && !addMoneyInsufficient && (
                    <p className="add-money-warning">Enter an amount above 0 and within your wallet balance.</p>
                  )}

                  <button
                    type="button"
                    className="add-money-continue"
                    disabled={!currentEvmNetwork || !addMoneyValid}
                    onClick={() => setAddMoneyStep('review')}
                  >
                    <span>Review deposit</span>
                    {actionArrow}
                  </button>
                </>
              ) : (
                <>
                  <div className="add-money-review-shell">
                    <div className="add-money-review-visual" aria-hidden="true">
                      <div className="review-machine-card">
                        <div className="review-machine-card-line" />
                        <div className="review-machine-card-dots" />
                      </div>
                      <div className="review-machine-terminal">
                        <div className="review-machine-slot" />
                        <div className="review-machine-screen">
                          <span>{Number(addMoneyAmount || 0).toFixed(4)}</span>
                          <small>ETH</small>
                        </div>
                        <div className="review-machine-keys" />
                        <div className="review-machine-keys second" />
                      </div>
                      <span className="review-visual-label">READY TO DEPOSIT</span>
                    </div>

                    <div className="add-money-review-copy">
                      <span>REVIEW DEPOSIT</span>
                      <strong className="amount-with-asset"><span>{Number(addMoneyAmount || 0).toFixed(4)}</span><em>ETH</em></strong>
                      <p>One wallet approval will move this testnet ETH into your Rixor available balance.</p>
                    </div>
                  </div>

                  <div className="add-money-review-meta">
                    <div><small>NETWORK</small><strong className="chain-meta-value">{currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}{currentEvmNetwork?.shortName ?? 'Unknown'}</strong></div>
                    <div><small>FROM</small><strong>{shortAddress(walletSession.address)}</strong></div>
                    <div><small>ASSET</small><strong>ETH</strong></div>
                    <div><small>WALLET AFTER</small><strong>{Math.max(0, Number(nativeBalance) - Number(addMoneyAmount || 0)).toFixed(4)} ETH</strong></div>
                  </div>

                  <div className="add-money-review-note">
                    <span className="dashboard-footnote-dot" />
                    <p>
                      {currentRixorContractAddress
                        ? `Contract: ${shortAddress(currentRixorContractAddress)}. Your wallet will ask you to approve the testnet transaction.`
                        : 'Deployment is the only remaining blocker for this network. No funds will be sent to a placeholder address.'}
                    </p>
                  </div>

                  {(addMoneyTxStatus === 'awaiting-wallet' || addMoneyTxStatus === 'pending') && (
                    <div className="rixor-deposit-loading" role="status" aria-live="polite">
                      <div className="rixor-deposit-loader" aria-hidden="true" />
                      <div>
                        <small>{addMoneyTxStatus === 'awaiting-wallet' ? 'WALLET APPROVAL' : 'ONCHAIN CONFIRMATION'}</small>
                        <strong>{addMoneyTxStatus === 'awaiting-wallet' ? 'Approve the deposit in your wallet' : 'Adding money to Rixor…'}</strong>
                        <span>{Number(addMoneyAmount || 0).toFixed(4)} ETH · {currentEvmNetwork?.shortName ?? 'Testnet'}</span>
                      </div>
                    </div>
                  )}

                  {addMoneyTxStatus === 'failed' && (
                    <div className="add-money-tx-state is-failed">
                      <strong>Deposit failed</strong>
                      {addMoneyTxError && <span>{addMoneyTxError}</span>}
                    </div>
                  )}

                  {addMoneyTxStatus === 'confirmed' && (
                    <a
                      className="rixor-deposit-receipt"
                      href={addMoneyTxHash && currentEvmNetwork ? `${currentEvmNetwork.explorerUrl}/tx/${addMoneyTxHash}` : undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <div className="rixor-receipt-machine">
                        <div className="rixor-receipt-card">
                          <div className="rixor-receipt-card-line" />
                          <div className="rixor-receipt-card-dots" />
                        </div>
                        <div className="rixor-receipt-terminal">
                          <div className="rixor-receipt-slot" />
                          <div className="rixor-receipt-screen">
                            <span>{Number(addMoneyAmount || 0).toFixed(4)}</span>
                            <small>ETH</small>
                          </div>
                          <div className="rixor-receipt-keys" />
                          <div className="rixor-receipt-keys second" />
                        </div>
                      </div>
                      <div className="rixor-receipt-copy">
                        <small>DEPOSIT CONFIRMED</small>
                        <strong>{Number(addMoneyAmount || 0).toFixed(4)} ETH added</strong>
                        <span>Now available in your Rixor balance</span>
                      </div>
                      <svg viewBox="0 0 451.846 451.847" aria-hidden="true">
                        <path d="M345.441 248.292L151.154 442.573c-12.359 12.365-32.397 12.365-44.75 0-12.354-12.354-12.354-32.391 0-44.744L278.318 225.92 106.409 54.017c-12.354-12.359-12.354-32.394 0-44.748 12.354-12.359 32.391-12.359 44.75 0l194.287 194.284c6.177 6.18 9.262 14.271 9.262 22.366 0 8.099-3.091 16.196-9.267 22.373z" />
                      </svg>
                    </a>
                  )}

                  {addMoneyTxStatus !== 'confirmed' && addMoneyTxStatus !== 'awaiting-wallet' && addMoneyTxStatus !== 'pending' && (
                    <div className="add-money-review-actions">
                      <button type="button" className="add-money-back" onClick={() => setAddMoneyStep('amount')}>
                        Back
                      </button>
                      <button
                        type="button"
                        className="add-money-submit is-ready"
                        disabled={!currentRixorContractAddress}
                        onClick={depositToRixor}
                      >
                        <span>Confirm deposit</span>
                        <small>{Number(addMoneyAmount || 0).toFixed(4)} ETH</small>
                      </button>
                    </div>
                  )}
                </>
              )}
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
                    {renderChainIcon(network.id)}
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
                <span className="dashboard-card-label">AVAILABLE IN RIXOR</span>
                <strong className="amount-with-asset"><span>{contractAvailableBalance}</span><em>ETH</em></strong>
                <p>{currentRixorContractAddress ? 'Available contract balance for this wallet.' : 'Testnet contract not deployed on this network yet.'}</p>

                {currentEvmNetwork && !currentRixorContractAddress && isDeploymentAdmin && (
                  <div className="dashboard-contract-setup">
                    <div>
                      <small>TESTNET CONTRACT</small>
                      <strong>{currentEvmNetwork.shortName}</strong>
                      <span>Wallet-signed deployment targets only this selected testnet. Gas is paid with test ETH on this network.</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void deployRixorContract()}
                      disabled={deployStatus === 'awaiting-wallet' || deployStatus === 'pending' || deployStatus === 'confirmed'}
                    >
                      {deployStatus === 'awaiting-wallet'
                        ? 'Approve in wallet…'
                        : deployStatus === 'pending'
                          ? 'Deploying…'
                          : deployStatus === 'confirmed'
                            ? 'Deployed'
                            : `Deploy on ${currentEvmNetwork.shortName}`}
                    </button>
                    {deployTxHash && (
                      <a href={`${currentEvmNetwork.explorerUrl}/tx/${deployTxHash}`} target="_blank" rel="noreferrer">
                        View deployment ↗
                      </a>
                    )}
                    {deployError && <p>{deployError}</p>}
                  </div>
                )}

                {currentRixorContractAddress && (
                  <div className="dashboard-contract-live">
                    <span>Contract live</span>
                    <a href={`${currentEvmNetwork?.explorerUrl}/address/${currentRixorContractAddress}`} target="_blank" rel="noreferrer">
                      {shortAddress(currentRixorContractAddress)} ↗
                    </a>
                    <span className="dashboard-contract-latest">Protocol contract active</span>
                  </div>
                )}

                <div className="dashboard-actions dashboard-actions--compact">
                  <button type="button" className="dashboard-action dashboard-action--primary" onClick={openAddMoney}>
                    <span>Add money</span>
                    {actionArrow}
                  </button>
                  <button type="button" className="dashboard-action" onClick={openStartPlan}>
                    <span>Start a plan</span>
                    {actionArrow}
                  </button>
                  <button type="button" className="dashboard-action" onClick={openWithdraw}>
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
                    <p>0.00 <small>Rewards</small></p>
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
                    <p>{contractAvailableBalance} <small>ETH</small></p>
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
                      <span className="rixor-balance-real">{contractAvailableBalance} ETH</span>
                    </div>
                    <small>Available savings</small>
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
              {activePlans.length === 0 ? (
                <div className="dashboard-empty-plan">
                  <span className="dashboard-empty-orb">+</span>
                  <div>
                    <strong>No active plans yet.</strong>
                    <p>When you create a plan onchain, it will appear here automatically for this wallet.</p>
                  </div>
                  <button type="button" onClick={openStartPlan}>Start a plan</button>
                </div>
              ) : (
                <div className="dashboard-plan-list">
                  {activePlans.map((planItem) => (
                    <button
                      key={planItem.id}
                      type="button"
                      className="dashboard-plan-row"
                      onClick={() => setSelectedPlanId(planItem.id)}
                    >
                      <div className="dashboard-plan-row-main">
                        <span className="dashboard-plan-status-dot" />
                        <div>
                          <small>{planItem.goal.toUpperCase()}</small>
                          <strong>{planItem.principalAmount.toFixed(4)} {planItem.principalAsset}</strong>
                          <span>{planItem.termLabel} · {planItem.apy}% rate</span>
                        </div>
                      </div>
                      <div className="dashboard-plan-row-progress">
                        <span>{Math.round(planItem.progress)}%</span>
                        <div><i style={{ width: `${Math.min(100, Math.max(0, planItem.progress))}%` }} /></div>
                      </div>
                      <div className="dashboard-plan-row-meta">
                        <small>{planItem.maturesAt ? 'MATURITY' : 'ACCESS'}</small>
                        <strong>{planItem.maturesAt ? formatPlanDate(planItem.maturesAt) : planItem.accessLabel}</strong>
                      </div>
                      <span className="dashboard-plan-row-arrow">→</span>
                    </button>
                  ))}
                </div>
              )}
            </article>

            <article className={`dashboard-panel dashboard-soft-card dashboard-activity-panel ${activityExpanded ? 'is-expanded' : ''}`}>
              <div className="dashboard-panel-head">
                <div>
                  <span>ACTIVITY</span>
                  <h2>Recent movement</h2>
                </div>
                {activityItems.length > 3 && (
                  <button
                    type="button"
                    className="dashboard-activity-toggle"
                    onClick={() => setActivityExpanded((current) => !current)}
                  >
                    {activityExpanded ? 'Show less' : 'View more'}
                  </button>
                )}
              </div>
              {activityItems.length === 0 ? (
                <div className="dashboard-empty-activity">
                  <span />
                  <p>Your confirmed onchain deposits, plan starts, withdrawals, and rewards will appear here for this wallet.</p>
                </div>
              ) : (
                <div className="dashboard-activity-viewport">
                  <div className="dashboard-activity-list">
                  {(activityExpanded ? activityItems : activityItems.slice(0, 3)).map((item) => (
                    <div className="dashboard-activity-row" key={item.id}>
                      <span className={`dashboard-activity-icon dashboard-activity-icon--${item.type}`}>
                        {item.type === 'deposit' ? '↓' : item.type === 'withdrawal' ? '↑' : item.type === 'reward' ? '↗' : '◎'}
                      </span>
                      <div className="dashboard-activity-copy">
                        <strong>{item.title}</strong>
                        <span>{item.network} · {formatActivityDate(item.timestamp)}</span>
                      </div>
                      <div className="dashboard-activity-amount">
                        <strong>{item.amount.toFixed(4)} {item.asset}</strong>
                        <span className={`dashboard-activity-status is-${item.status}`}>{item.status}</span>
                      </div>
                      {item.txHash ? (
                        <a
                          href={`${currentEvmNetwork?.explorerUrl ?? ''}/tx/${item.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="dashboard-activity-link"
                        >
                          ↗
                        </a>
                      ) : (
                        <span className="dashboard-activity-link is-disabled">↗</span>
                      )}
                    </div>
                  ))}
                  </div>
                </div>
              )}
            </article>
          </div>

          <article className={`dashboard-panel dashboard-soft-card dashboard-history-panel ${historyExpanded ? 'is-expanded' : ''}`}>
            <div className="dashboard-panel-head">
              <div>
                <span>PLAN HISTORY</span>
                <h2>Completed & withdrawn</h2>
              </div>
              <div className="dashboard-history-head-actions">
                <small>{planHistory.length} closed</small>
                {planHistory.length > 3 && (
                  <button
                    type="button"
                    className="dashboard-history-toggle"
                    onClick={() => setHistoryExpanded((current) => !current)}
                  >
                    {historyExpanded ? 'Show less' : 'View more'}
                  </button>
                )}
              </div>
            </div>

            {planHistory.length === 0 ? (
              <div className="dashboard-history-empty">
                <span>✓</span>
                <div>
                  <strong>No closed plans yet.</strong>
                  <p>When you withdraw or close a plan, its final amount and exit details will stay here.</p>
                </div>
              </div>
            ) : (
              <div className="dashboard-history-viewport">
                <div className="dashboard-history-list">
                {(historyExpanded ? planHistory : planHistory.slice(0, 3)).map((item) => (
                  <div className="dashboard-history-row" key={`${item.id}-${item.txHash ?? item.closedAt}`}>
                    <div className="dashboard-history-main">
                      <span className="dashboard-history-mark">✓</span>
                      <div>
                        <small>{item.goal.toUpperCase()}</small>
                        <strong>{item.amountReturned.toFixed(4)} {item.principalAsset} returned</strong>
                        <span>{item.termLabel}{item.earlyExitFee > 0 ? ` · ${item.earlyExitFee.toFixed(4)} ETH early-exit fee` : ''}</span>
                      </div>
                    </div>
                    <div className="dashboard-history-meta">
                      <small>STARTED</small>
                      <strong>{formatPlanDate(item.startedAt)}</strong>
                    </div>
                    <div className="dashboard-history-meta">
                      <small>EXIT</small>
                      <strong>{formatPlanDate(item.closedAt)}</strong>
                      <span>{item.earlyExit ? 'Early withdrawal' : 'Completed'}</span>
                    </div>
                    {item.txHash && currentEvmNetwork ? (
                      <a className="dashboard-history-link" href={`${currentEvmNetwork.explorerUrl}/tx/${item.txHash}`} target="_blank" rel="noreferrer">↗</a>
                    ) : (
                      <span className="dashboard-history-link is-disabled">↗</span>
                    )}
                  </div>
                ))}
                </div>
              </div>
            )}
          </article>

          <div className="dashboard-footnote">
            <span className="dashboard-footnote-dot" />
            <p>
              Connected as {shortAddress(walletSession.address)}. {currentRixorContractAddress
                ? 'Rixor available balance is read directly from the active testnet contract.'
                : isDeploymentAdmin
                  ? 'This supported testnet does not have a configured Rixor contract yet.'
                  : 'Rixor is not available on this network yet.'}
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

      {!walletSession && <header className={`top-shell ${navCompact ? 'is-compact' : ''}`}>
        <button className="top-brand" type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Rixor home">
          {renderRixorBrand()}
        </button>
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
      </header>}

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
              Save supported assets with flexible access or lock in longer for higher returns.
            </p>

            <div className="hero-actions">
              <button className="hero-primary" type="button" onClick={() => walletSession ? setDashboardView(true) : openWalletFor('dashboard')}>
                <span>{walletSession ? 'Dashboard' : 'Start saving'}</span>
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
                <span className="panel-eyebrow">SAVE YOUR ASSET</span>
                <h2>Choose your plan</h2>
              </div>
              <span className="panel-chip">REWARDS FLEXIBLE</span>
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
              <span className="balance-line">Balance: 0.0000 ETH</span>
            </div>

            <div className="plan-cards">
              <button type="button" className={`plan-card ${plan === 'flexible' ? 'active' : ''}`} onClick={() => { setPlan('flexible'); openWalletFor('start-plan', 'flexible') }}>
                <span>Flexible</span>
                <strong>3.8% rate</strong>
                <small>Withdraw anytime</small>
              </button>
              <button type="button" className={`plan-card ${plan === 'locked' ? 'active' : ''}`} onClick={() => { setPlan('locked'); openWalletFor('start-plan', '90') }}>
                <span>Locked</span>
                <strong>6.8% rate</strong>
                <small>Higher return</small>
              </button>
            </div>

            <div className="earnings-row">
              <span>Estimated earnings</span>
              <strong>+{projected.toFixed(4)} ETH / year</strong>
            </div>

            <button className="connect-wallet" type="button" onClick={() => walletSession ? setDashboardView(true) : openWalletFor('dashboard')}>
              <span>{walletSession ? 'Open dashboard' : 'Connect Wallet'}</span>
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
            Bring funds in from the wallet you already use, keep the asset you chose to save,
            then choose how long you want that money to work and how rewards should be paid.
          </p>
        </div>

        <div className="how-intro-flow" aria-label="Rixor savings flow">
          <div className="how-intro-copy">
            <span className="how-intro-label">THE SIMPLE VERSION</span>
            <h3>Your money moves through one clear path.</h3>
            <p>
              Connect your wallet, fund Rixor, choose whether to stay flexible or lock for longer,
              then choose how you want rewards paid. From there, Rixor keeps the position,
              progress and next action visible in one place.
            </p>
          </div>

          <div className="how-flow-illustration" aria-hidden="true">
            <span className="flow-node">Wallet</span>
            <svg viewBox="0 0 120 34" role="presentation">
              <path d="M4 17C32 17 43 4 68 4C90 4 94 17 114 17" />
              <path d="M105 9L114 17L105 25" />
            </svg>
            <span className="flow-node flow-node--accent">SAVE</span>
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
              <button className="how-card-action" type="button" onClick={() => openWalletFor('dashboard')}>
                <span>Connect wallet</span>
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
                Supported deposits stay tied to the asset you chose to save. Reward payout is a
                separate choice, so USDG can be used for rewards without changing your principal.
              </p>
              <button className="how-card-action" type="button" onClick={() => openWalletFor('dashboard')}>
                <span>Connect wallet</span>
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
              <div className="usdg-orb">ASSET</div>
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
              <button className="how-card-action" type="button" onClick={() => openWalletFor('dashboard')}>
                <span>Connect wallet</span>
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
              <button className="how-card-action" type="button" onClick={() => openWalletFor('dashboard')}>
                <span>Connect wallet</span>
                {actionArrow}
              </button>
            </div>
            <div className="how-visual how-visual--track" aria-hidden="true">
              <div className="track-meta">
                <span>Travel fund</span>
                <strong>1.0000 ETH</strong>
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
              <button className="how-card-action" type="button" onClick={() => openWalletFor('dashboard')}>
                <span>Connect wallet</span>
                {actionArrow}
              </button>
            </div>
            <div className="how-visual how-visual--review" aria-hidden="true">
              <div className="review-sheet">
                <span>90-day plan</span>
                <strong>1.0000 ETH</strong>
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
            Keep access flexible or lock your savings for longer. Your principal stays in ETH,
            while every plan reward is paid separately in $RIXOR.
          </p>
        </div>

        <div className="plans-reward-model">
          <span>HOW $RIXOR REWARDS WORK</span>
          <strong>Rewards vest while you stay committed.</strong>
          <p>
            Rixor uses a dedicated $RIXOR rewards treasury for plan payouts. At launch, that treasury
            funds saver rewards from a fixed allocation rather than unlimited minting. As the protocol
            begins generating real yield and revenue, those sources are intended to replenish the rewards
            treasury over time. Your ETH principal remains separate from the $RIXOR reward.
          </p>
        </div>

        <div className="plans-shell">
          <div className="plans-config">
            <div className="plans-config-head">
              <div>
                <span>Plan type</span>
                <strong>{selectedPlan.label}</strong>
              </div>
              <span className="plans-apy-chip">{selectedPlan.apy}% rate</span>
            </div>

            <div className="glass-radio-group plans-radio-group">
              {planOptions.map((option) => (
                <label
                  key={option.id}
                  className={planTerm === option.id ? 'is-active' : ''}
                  onClick={(event) => {
                    event.preventDefault()
                    setPlanTerm(option.id)
                    openWalletFor('start-plan', option.id)
                  }}
                >
                  <input
                    type="radio"
                    name="savings-plan"
                    value={option.id}
                    checked={planTerm === option.id}
                    onChange={() => undefined}
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
                  <span className="plans-amount-sub">Set how much of your saved asset you want in this plan.</span>
                </div>
                <span className="plans-status">ETH TESTNET</span>
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
                <span>APY</span>
            </div>

            <div className="plans-preview-list">
              <div>
                <span>Deposit</span>
                <strong>{planAmount.toLocaleString()} ETH</strong>
              </div>
              <div>
                <span>Access</span>
                <strong>{selectedPlan.access}</strong>
              </div>
              <div>
                <span>{planTerm === 'flexible' ? 'Estimated / year' : 'At maturity'}</span>
                <strong>$RIXOR reward</strong>
              </div>
              <div>
                <span>Maturity</span>
                <strong>{maturityDate}</strong>
              </div>
            </div>

            {planTerm !== 'flexible' && (
              <p className="plans-warning">
                Early withdrawal starts at a maximum {selectedPlan.earlyExitMax}% fee and declines
                continuously to 0% at maturity.
              </p>
            )}

            <p className="plans-disclaimer">Illustrative rate. Not guaranteed.</p>

            <button className="plans-action" type="button" onClick={() => openWalletFor('start-plan', planTerm)}>
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
              <span className="security-wallet-mark" aria-hidden="true">
                <svg className="security-eth-mark" viewBox="0 0 784.37 1277.39" role="presentation">
                  <polygon fill="#343434" points="392.07,0 383.5,29.11 383.5,873.74 392.07,882.29 784.13,650.54" />
                  <polygon fill="#8C8C8C" points="392.07,0 0,650.54 392.07,882.29 392.07,472.33" />
                  <polygon fill="#3C3C3B" points="392.07,956.52 387.24,962.41 387.24,1263.28 392.07,1277.38 784.37,724.89" />
                  <polygon fill="#8C8C8C" points="392.07,1277.38 392.07,956.52 0,724.89" />
                  <polygon fill="#141414" points="392.07,882.29 784.13,650.54 392.07,472.33" />
                  <polygon fill="#393939" points="0,650.54 392.07,882.29 392.07,472.33" />
                </svg>
              </span>
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
