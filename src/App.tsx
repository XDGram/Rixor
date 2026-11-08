import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { icon, networkGlyph } from './ui'
import DiamondHands, { DiamondBoard } from './DiamondHands'
import { DIAMOND_ADDRESS, LOCK_TERMS, ROBINHOOD_MAINNET, WIF_ADDRESS, explorerAddress, formatWif, shortAddr, useDiamondHistory, useDiamondStats } from './wif'
import rixorSavingsArtifact from './contracts/RixorSavingsArtifact.json'
import { Interface, decodeBytes32String, encodeBytes32String, formatEther, formatUnits } from 'ethers'

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
  const [lightMode, setLightMode] = useState(() => window.localStorage.getItem('rixor:theme-v2') !== 'dark')
  const [navCompact, setNavCompact] = useState(false)
  const [planTerm, setPlanTerm] = useState<'flexible' | '30' | '90' | '180' | '365'>('90')
  const [walletModalOpen, setWalletModalOpen] = useState(false)
  const [walletConnecting, setWalletConnecting] = useState<string | null>(null)
  const [walletError, setWalletError] = useState('')
  const [walletSession, setWalletSession] = useState<WalletSession | null>(null)
  const [dashboardView, setDashboardView] = useState(true)
  const [dashboardNavTab, setDashboardNavTab] = useState<'home' | 'diamond'>('diamond')
  const [pendingWalletAction, setPendingWalletAction] = useState<'dashboard' | 'start-plan' | null>(null)
  const [pendingPlanTerm, setPendingPlanTerm] = useState<'flexible' | '30' | '90' | '180' | '365' | null>(null)
  const [detectedWallets, setDetectedWallets] = useState<DetectedWallet[]>([])
  const [connectedEvmProvider, setConnectedEvmProvider] = useState<EvmProvider | null>(null)
  const [evmChainId, setEvmChainId] = useState<number | null>(null)
  const [networkSwitching, setNetworkSwitching] = useState<number | null>(null)
  const [nativeBalance, setNativeBalance] = useState<string>('0.0000')
  const [nativeBalanceStatus, setNativeBalanceStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [nativeBalanceError, setNativeBalanceError] = useState('')
  const diamondStats = useDiamondStats()
  const diamondHistory = useDiamondHistory()
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
  const reconnectAttemptedRef = useRef(false)

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
        setStartPlanTxStatus('idle')
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

  const switchDashboardSection = (next: 'home' | 'diamond') => {
    setDashboardNavTab(next)
    window.scrollTo({ top: 0, behavior: 'auto' })
  }

  const evmNetworks = [
    {
      id: ROBINHOOD_MAINNET.id,
      hexId: ROBINHOOD_MAINNET.hexId,
      name: ROBINHOOD_MAINNET.name,
      shortName: ROBINHOOD_MAINNET.shortName,
      rpcUrl: ROBINHOOD_MAINNET.rpcUrl,
      balanceRpcUrls: [ROBINHOOD_MAINNET.rpcUrl],
      explorerUrl: ROBINHOOD_MAINNET.explorerUrl,
    },
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
      shortName: 'Robinhood Chain Testnet',
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
  const renderChainIcon = (chainId?: number | null) => networkGlyph(chainId)

  const renderRixorBrand = () => (
    <span className="brand" aria-label="Rixor">
      <svg className="brand-mark" viewBox="0 0 36 36" role="presentation" aria-hidden="true">
        <path d="M4 5h14.2c7.5 0 12.8 4.7 12.8 11.2 0 4.1-2 7.6-5.5 9.6l-4.7-5.1c2.1-.9 3.4-2.4 3.4-4.5 0-2.8-2.2-4.7-5.5-4.7H9.8L4 5Z" />
        <path d="M4 31V21.1l12.7-9.2 5.1 5.4L4 31Z" />
        <path d="M15.6 22.6l5.3-4 10.2 12.4h-8.6l-6.9-8.4Z" />
      </svg>
      <span className="brand-word">Rixor</span>
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

    return () => {
      window.removeEventListener('eip6963:announceProvider', onEip6963)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('rixor:theme-v2', lightMode ? 'light' : 'dark')
  }, [lightMode])

  useEffect(() => {
    const sheetOpen = walletModalOpen || addMoneyOpen
    document.body.classList.toggle('no-scroll', sheetOpen)
    if (!sheetOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setWalletModalOpen(false)
      setAddMoneyOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('no-scroll')
    }
  }, [walletModalOpen, addMoneyOpen])

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

  const openWalletFor = (
    action: 'dashboard' | 'start-plan' = 'dashboard',
    term?: 'flexible' | '30' | '90' | '180' | '365',
  ) => {
    if (walletSession) {
      setDashboardView(true)
      if (action === 'start-plan') {
        setStartPlanStep('setup')
        setStartPlanTxStatus('idle')
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

  const scrollToSection = (sectionId: string) => {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const openPublicSection = (sectionId: 'home' | 'how-it-works' | 'plans' | 'security') => {
    setDashboardView(false)
    window.setTimeout(() => {
      if (sectionId === 'home') {
        window.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      scrollToSection(sectionId)
    }, 60)
  }

  useEffect(() => {
    const updateNavState = () => setNavCompact(window.scrollY > 12)
    updateNavState()
    window.addEventListener('scroll', updateNavState, { passive: true })
    return () => window.removeEventListener('scroll', updateNavState)
  }, [])

  const planOptions = [
    { id: 'flexible', label: 'Flexible', apy: 3.8, days: 365, access: 'Withdraw anytime', earlyExitMax: 0 },
    { id: '30', label: '30 days', apy: 5.2, days: 30, access: '30-day lock', earlyExitMax: 2 },
    { id: '90', label: '90 days', apy: 6.8, days: 90, access: '90-day lock', earlyExitMax: 4 },
    { id: '180', label: '180 days', apy: 8.1, days: 180, access: '180-day lock', earlyExitMax: 6 },
    { id: '365', label: '1 year', apy: 9.4, days: 365, access: '1-year lock', earlyExitMax: 8 },
  ] as const

  const selectedPlan = planOptions.find((option) => option.id === planTerm) ?? planOptions[2]
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

  const resetStartPlanTx = () => {
    setStartPlanTxStatus('idle')
    setStartPlanTxHash('')
    setStartPlanTxError('')
  }

  const openStartPlan = () => {
    resetStartPlanTx()
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
    setWithdrawTxStatus('idle')
    setWithdrawTxHash('')
    setWithdrawTxError('')
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

  const fmtEth = (value: number, digits = 4) => (Number.isFinite(value) ? value : 0).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  const fmtUsd = (value: number) => value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  const explorerTx = (hash: string) => (hash && currentEvmNetwork ? `${currentEvmNetwork.explorerUrl}/tx/${hash}` : undefined)
  const isBusy = (status: string) => status === 'awaiting-wallet' || status === 'pending'
  const termShort = ['Flex', '30D', '90D', '180D', '1Y']
  const savedInPlans = activePlans.reduce((total, item) => total + item.principalAmount, 0)
  const sepoliaContractUrl = `https://sepolia.etherscan.io/address/${deployedSepoliaAddress}`
  const robinhoodContractUrl = `https://explorer.testnet.chain.robinhood.com/address/${deployedRobinhoodTestnetAddress}`

  const renderTxProgress = (status: string, approveTitle: string, pendingTitle: string, detail: string) => (
    isBusy(status) ? (
      <div className="tx-progress" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <div>
          <small>{status === 'awaiting-wallet' ? 'Waiting for your wallet' : 'Confirming onchain'}</small>
          <strong>{status === 'awaiting-wallet' ? approveTitle : pendingTitle}</strong>
          <span>{detail}</span>
        </div>
      </div>
    ) : null
  )

  const renderTxError = (title: string, message: string) => (
    <div className="notice notice--error" role="alert">
      <strong>{title}</strong>
      <span>{message || 'The transaction did not complete.'}</span>
    </div>
  )

  const renderReceipt = (hash: string, kicker: string, title: string, detail: ReactNode, loss = false) => (
    <a className="receipt" href={explorerTx(hash)} target="_blank" rel="noreferrer">
      <span className="receipt-check">{icon('check', 22)}</span>
      <span className="receipt-copy">
        <small>{kicker}</small>
        <strong>{title}</strong>
        <span className={loss ? 'is-loss' : ''}>{detail}</span>
      </span>
      <span className="receipt-link">Receipt {icon('arrowUpRight', 14)}</span>
    </a>
  )

  const renderRows = (rows: Array<[string, ReactNode, string?]>) => (
    <dl className="rows">
      {rows.map(([label, value, className]) => (
        <div key={label} className={className}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )

  const renderAmountField = (options: {
    id: string
    label: string
    value: string
    onChange: (value: string) => void
    balance: number
    balanceLabel: string
    insufficient: boolean
    insufficientCopy: ReactNode
    onMax?: () => void
    maxLabel?: string
  }) => (
    <div className="amount-field">
      <div className="amount-field-head">
        <label htmlFor={options.id}>{options.label}</label>
        <span className={options.insufficient ? 'is-error' : ''}>{options.balanceLabel}</span>
      </div>
      <div className={`amount-input ${options.insufficient ? 'is-error' : ''}`}>
        <input
          id={options.id}
          inputMode="decimal"
          autoComplete="off"
          value={options.value}
          onChange={(event) => options.onChange(event.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0.00"
        />
        <span>ETH</span>
      </div>
      <div className="chip-row" aria-label="Quick amounts">
        {[25, 50, 75].map((percent) => (
          <button
            key={percent}
            type="button"
            className="chip"
            disabled={options.balance <= 0}
            onClick={() => options.onChange(((options.balance * percent) / 100).toFixed(4))}
          >
            {percent}%
          </button>
        ))}
        <button
          type="button"
          className="chip"
          disabled={options.balance <= 0}
          onClick={() => (options.onMax ? options.onMax() : options.onChange(String(options.balance)))}
        >
          {options.maxLabel ?? 'Max'}
        </button>
      </div>
      {options.insufficient && <div className="field-error">{options.insufficientCopy}</div>}
    </div>
  )

  const renderNetPill = () => walletSession && (
    <span className="net-pill">
      {currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}
      <span className="net-pill-name">{currentEvmNetwork?.shortName ?? 'Testnet'}</span>
      <b>{shortAddress(walletSession.address)}</b>
    </span>
  )

  const renderFlowBar = (onBack: () => void) => (
    <header className={`flow-bar ${navCompact ? 'is-scrolled' : ''}`}>
      <div className="container flow-bar-inner">
        <button type="button" className="back-btn" onClick={onBack} aria-label="Back to dashboard">
          {icon('arrowLeft')}
          <span>Dashboard</span>
        </button>
        <span className="flow-bar-brand">{renderRixorBrand()}</span>
        {renderNetPill()}
      </div>
    </header>
  )

  const renderSheet = (options: { id: string; kicker: string; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) => (
    <div className="sheet-backdrop" role="presentation" onMouseDown={options.onClose}>
      <section
        className={`sheet ${options.wide ? 'sheet--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={options.id}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="sheet-handle" aria-hidden="true" />
        <header className="sheet-head">
          <div>
            <small className="kicker">{options.kicker}</small>
            <h2 id={options.id}>{options.title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={options.onClose} aria-label="Close">
            {icon('close')}
          </button>
        </header>
        {options.children}
      </section>
    </div>
  )

  const renderWalletSheet = () => {
    if (!walletModalOpen) return null

    if (walletSession) {
      return renderSheet({
        id: 'wallet-sheet-title',
        kicker: 'Your wallet',
        title: 'Connected',
        onClose: () => setWalletModalOpen(false),
        children: (
          <>
            <div className="wallet-identity">
              {walletSession.kind === 'evm' && currentEvmNetwork ? renderChainIcon(currentEvmNetwork.id) : <span className="dot-live" />}
              <div>
                <small>{walletSession.name}</small>
                <strong>{shortAddress(walletSession.address)}</strong>
                {walletSession.kind === 'evm' && <span>{nativeBalance} ETH in wallet</span>}
              </div>
            </div>
            {walletSession.kind === 'evm' && (
              <div className="sheet-section">
                <small className="kicker">Network</small>
                <div className="net-switch net-switch--block">
                  {evmNetworks.map((network) => (
                    <button
                      key={network.id}
                      type="button"
                      className={evmChainId === network.id ? 'is-active' : ''}
                      onClick={() => switchEvmNetwork(network.id)}
                      disabled={networkSwitching !== null}
                    >
                      {renderChainIcon(network.id)}
                      <span>{networkSwitching === network.id ? 'Switching…' : network.shortName}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="sheet-actions">
              <button type="button" className="btn btn--ghost" onClick={() => openPublicSection('home')}>About Rixor</button>
              <button type="button" className="btn btn--dark" onClick={disconnectWallet}>Disconnect</button>
            </div>
          </>
        ),
      })
    }

    return renderSheet({
      id: 'wallet-sheet-title',
      kicker: 'Rixor access',
      title: 'Connect a wallet',
      onClose: () => setWalletModalOpen(false),
      children: (
        <>
          <p className="sheet-copy">
            Your wallet is your Rixor account. Connecting shares your public address only. No funds move until you approve a transaction.
          </p>
          <div className="wallet-list">
            {detectedWallets.map((wallet) => (
              <button
                key={wallet.id}
                type="button"
                className="wallet-option"
                onClick={() => connectEvmWallet(wallet)}
                disabled={walletConnecting !== null}
              >
                <span className="wallet-option-mark" aria-hidden="true">
                  <svg viewBox="0 0 256 417" role="presentation">
                    <path d="M127.9 0L125.1 9.5V279.1L127.9 281.9L255.8 206.3Z" fill="currentColor" opacity=".7" />
                    <path d="M127.9 0L0 206.3L127.9 281.9V154.1Z" fill="currentColor" />
                    <path d="M127.9 306.1L126.3 308V414.6L127.9 417L255.9 230.5Z" fill="currentColor" opacity=".7" />
                    <path d="M127.9 417V306.1L0 230.5Z" fill="currentColor" />
                  </svg>
                </span>
                <span className="wallet-option-copy">
                  <strong>{wallet.name}</strong>
                  <small>EVM wallet detected</small>
                </span>
                <em>{walletConnecting === wallet.id ? 'Connecting…' : 'Connect'}</em>
              </button>
            ))}
            {detectedWallets.length === 0 && (
              <div className="empty">
                <strong>No wallet found in this browser.</strong>
                <span>Install an EVM wallet such as MetaMask, Coinbase Wallet, Rabby or Zerion, or open Rixor inside your wallet's built-in browser.</span>
              </div>
            )}
          </div>
          {walletError && renderTxError('Could not connect', walletError)}
          <p className="sheet-foot">{icon('lock', 14)} Rixor never asks for your seed phrase or private key.</p>
        </>
      ),
    })
  }

  const renderAddMoneySheet = () => {
    if (!addMoneyOpen || !walletSession) return null
    const amountValue = Number(addMoneyAmount || 0)
    const walletAfter = Math.max(0, Number(nativeBalance) - amountValue)

    return renderSheet({
      id: 'add-money-title',
      kicker: 'Testnet funding',
      title: addMoneyStep === 'amount' ? 'Add money' : 'Review deposit',
      onClose: () => setAddMoneyOpen(false),
      children: walletSession.kind !== 'evm' ? (
        <div className="empty">
          <strong>EVM wallet required.</strong>
          <span>Deposits run on Sepolia and Robinhood Chain Testnet.</span>
        </div>
      ) : addMoneyStep === 'amount' ? (
        <>
          <div className="source-card">
            {currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}
            <div>
              <small>From your wallet on</small>
              <strong>{currentEvmNetwork?.shortName ?? 'Unsupported network'}</strong>
            </div>
            <span className="source-card-balance">{nativeBalance} ETH</span>
          </div>

          {renderAmountField({
            id: 'add-money-amount',
            label: 'Amount',
            value: addMoneyAmount,
            onChange: setAddMoneyAmount,
            balance: Number(nativeBalance),
            balanceLabel: `${nativeBalance} ETH available`,
            insufficient: addMoneyInsufficient,
            insufficientCopy: 'That is more than this wallet holds. Top up the wallet first.',
            onMax: () => void setGasSafeDepositMax(),
            maxLabel: 'Max (keep gas)',
          })}

          {renderRows([
            ['Asset', 'Testnet ETH'],
            ['Wallet after deposit', `${fmtEth(walletAfter)} ETH`],
            ['Lands in', 'Your Rixor available balance'],
          ])}

          {!currentEvmNetwork && <div className="notice">Switch to Sepolia or Robinhood Chain Testnet before continuing.</div>}

          <button
            type="button"
            className="btn btn--dark btn--block btn--lg"
            disabled={!currentEvmNetwork || !addMoneyValid}
            onClick={() => setAddMoneyStep('review')}
          >
            Review deposit {icon('arrowRight')}
          </button>
        </>
      ) : (
        <>
          <div className="review-figure">
            <small>You deposit</small>
            <strong>{fmtEth(amountValue)} <em>ETH</em></strong>
            {ethUsdPrice && <span>≈ {fmtUsd(amountValue * ethUsdPrice)}</span>}
          </div>

          {renderRows([
            ['Network', <span className="inline-chain">{currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}{currentEvmNetwork?.shortName ?? 'Unknown'}</span>],
            ['From', shortAddress(walletSession.address)],
            ['Wallet after', `${fmtEth(walletAfter)} ETH`],
            ['Contract', currentRixorContractAddress ? shortAddress(currentRixorContractAddress) : 'Not deployed here'],
          ])}

          <p className="fine-print">
            {currentRixorContractAddress
              ? 'Your wallet will ask you to approve one testnet transaction.'
              : 'Rixor is not deployed on this network. No funds will be sent to a placeholder address.'}
          </p>

          {renderTxProgress(addMoneyTxStatus, 'Approve the deposit in your wallet', 'Adding money to Rixor…', `${fmtEth(amountValue)} ETH · ${currentEvmNetwork?.shortName ?? 'Testnet'}`)}
          {addMoneyTxStatus === 'failed' && renderTxError('Deposit failed', addMoneyTxError)}
          {addMoneyTxStatus === 'confirmed' && (
            <>
              {renderReceipt(addMoneyTxHash, 'Deposit confirmed', `${fmtEth(amountValue)} ETH added`, 'Now in your Rixor available balance')}
              <button type="button" className="btn btn--dark btn--block btn--lg" onClick={() => setAddMoneyOpen(false)}>Done</button>
            </>
          )}

          {!isBusy(addMoneyTxStatus) && addMoneyTxStatus !== 'confirmed' && (
            <div className="btn-pair">
              <button type="button" className="btn btn--ghost btn--lg" onClick={() => setAddMoneyStep('amount')}>Back</button>
              <button type="button" className="btn btn--lime btn--lg" disabled={!currentRixorContractAddress} onClick={depositToRixor}>
                Confirm deposit
              </button>
            </div>
          )}
        </>
      ),
    })
  }

  const renderOutlineNumeral = (text: string, label: string, width = 560) => (
    <svg className="outline-numeral" viewBox={`0 0 ${width} 320`} role="img" aria-label={label}>
      {Array.from({ length: 22 }, (_, index) => 22 - index).map((depth) => (
        <text key={depth} x={70 - depth * 1.7} y={250 + depth * 1.7} className={depth === 22 ? 'num-back' : 'num-mid'}>{text}</text>
      ))}
      <text x="70" y="250" className="num-front">{text}</text>
    </svg>
  )

  if (walletSession && selectedActivePlan) {
    const quote = selectedPlanExitQuote
    const progress = Math.min(100, Math.max(0, selectedActivePlan.progress))
    const extendLabel = planOptions.find((option) => option.id === planExtendTerm)?.label ?? ''

    return (
      <main className={`app flow ${lightMode ? 'theme-light' : 'theme-dark'}`}>
        {renderFlowBar(() => setSelectedPlanId(null))}

        <div className="container flow-body">
          <section className="flow-hero">
            <p className="eyebrow">{selectedActivePlan.status === 'matured' ? 'Matured plan' : 'Active plan'} · #{selectedActivePlan.id}</p>
            <h1>{selectedActivePlan.goal}</h1>
            <p>{selectedActivePlan.termLabel} · {selectedActivePlan.accessLabel}</p>
          </section>

          <div className="flow-grid">
            <div className="flow-main">
              <section className="card principal-card">
                <small className="label">Principal</small>
                <p className="figure">{fmtEth(selectedActivePlan.principalAmount)} <em>{selectedActivePlan.principalAsset}</em></p>
                {ethUsdPrice && <span className="figure-sub">≈ {fmtUsd(selectedActivePlan.principalAmount * ethUsdPrice)}</span>}

                <div className="progress-block">
                  <div className="progress-head">
                    <span>{Math.round(progress)}% of term complete</span>
                    <span>{selectedActivePlan.maturesAt ? `Matures ${formatPlanDate(selectedActivePlan.maturesAt)}` : selectedActivePlan.accessLabel}</span>
                  </div>
                  <div className="progress"><i style={{ width: `${progress}%` }} /></div>
                </div>
              </section>

              <div className="action-tiles">
                <button
                  type="button"
                  className={planWithdrawReviewOpen ? 'is-active' : ''}
                  onClick={() => {
                    setPlanWithdrawTxStatus('idle')
                    setPlanWithdrawTxHash('')
                    setPlanWithdrawTxError('')
                    setPlanWithdrawReviewOpen(true)
                    setPlanTopUpOpen(false)
                    setPlanExtendOpen(false)
                  }}
                >
                  {icon('arrowUp')}
                  <strong>Withdraw</strong>
                  <small>See the exact exit cost first.</small>
                </button>
                <button
                  type="button"
                  className={planTopUpOpen ? 'is-active' : ''}
                  onClick={() => {
                    setPlanTopUpOpen(true)
                    setPlanExtendOpen(false)
                    setPlanWithdrawReviewOpen(false)
                    setPlanTopUpAmount('')
                    setPlanTopUpTxStatus('idle')
                    setPlanTopUpTxHash('')
                    setPlanTopUpTxError('')
                  }}
                >
                  {icon('plus')}
                  <strong>Add more</strong>
                  <small>From your available balance.</small>
                </button>
                <button
                  type="button"
                  className={planExtendOpen ? 'is-active' : ''}
                  disabled={extensionOptions.length === 0}
                  onClick={() => {
                    const nextOption = extensionOptions[0]
                    if (!nextOption || nextOption.id === 'flexible') return
                    setPlanExtendTerm(nextOption.id)
                    setPlanExtendOpen(true)
                    setPlanTopUpOpen(false)
                    setPlanWithdrawReviewOpen(false)
                    setPlanExtendTxStatus('idle')
                    setPlanExtendTxHash('')
                    setPlanExtendTxError('')
                  }}
                >
                  {icon('clock')}
                  <strong>Extend</strong>
                  <small>{extensionOptions.length ? 'Restart on a longer lock.' : 'Already on the longest term.'}</small>
                </button>
              </div>

              {planTopUpOpen && (
                <section className="card action-panel">
                  <header className="panel-head">
                    <div><small className="kicker">Add more</small><h2>Increase this plan</h2></div>
                    <button type="button" className="icon-btn" onClick={() => setPlanTopUpOpen(false)} aria-label="Close">{icon('close')}</button>
                  </header>
                  {renderAmountField({
                    id: 'plan-top-up',
                    label: 'Amount to add',
                    value: planTopUpAmount,
                    onChange: setPlanTopUpAmount,
                    balance: rixorAvailableBalance,
                    balanceLabel: `${contractAvailableBalance} ETH available in Rixor`,
                    insufficient: planTopUpParsed > rixorAvailableBalance,
                    insufficientCopy: 'More than your available Rixor balance. Add money first.',
                    onMax: () => setPlanTopUpAmount(contractAvailableBalance),
                  })}
                  {renderTxProgress(planTopUpTxStatus, 'Approve the top-up', 'Adding to your plan…', `${fmtEth(planTopUpParsed)} ETH · Plan #${selectedActivePlan.id}`)}
                  {planTopUpTxStatus === 'failed' && renderTxError('Top-up failed', planTopUpTxError)}
                  {planTopUpTxStatus === 'confirmed'
                    ? renderReceipt(planTopUpTxHash, 'Top-up confirmed', `${fmtEth(planTopUpParsed)} ETH added`, 'Your plan principal is updated')
                    : !isBusy(planTopUpTxStatus) && (
                      <button type="button" className="btn btn--dark btn--block btn--lg" disabled={!planTopUpValid} onClick={topUpSelectedPlan}>Add to plan</button>
                    )}
                </section>
              )}

              {planExtendOpen && (
                <section className="card action-panel">
                  <header className="panel-head">
                    <div><small className="kicker">Extend</small><h2>Choose a longer lock</h2></div>
                    <button type="button" className="icon-btn" onClick={() => setPlanExtendOpen(false)} aria-label="Close">{icon('close')}</button>
                  </header>
                  <div className="term-grid term-grid--compact">
                    {extensionOptions.map((option) => option.id !== 'flexible' && (
                      <button key={option.id} type="button" className={`term ${planExtendTerm === option.id ? 'is-active' : ''}`} onClick={() => setPlanExtendTerm(option.id)}>
                        <strong>{option.label}</strong>
                        <small>Up to {option.earlyExitMax}% exit fee</small>
                      </button>
                    ))}
                  </div>
                  <p className="fine-print">The new lock starts when the extension confirms, so the early-exit fee resets to the new term's maximum.</p>
                  {renderTxProgress(planExtendTxStatus, 'Approve the extension', 'Extending your plan…', `New term · ${extendLabel}`)}
                  {planExtendTxStatus === 'failed' && renderTxError('Extension failed', planExtendTxError)}
                  {planExtendTxStatus === 'confirmed'
                    ? renderReceipt(planExtendTxHash, 'Extension confirmed', `Now a ${extendLabel} plan`, 'The new lock started at confirmation')
                    : !isBusy(planExtendTxStatus) && (
                      <button type="button" className="btn btn--dark btn--block btn--lg" onClick={extendSelectedPlan}>Extend to {extendLabel}</button>
                    )}
                </section>
              )}

              {planWithdrawReviewOpen && quote && (
                <section className="card action-panel exit-panel">
                  <header className="panel-head">
                    <div><small className="kicker">Exit plan</small><h2>Withdraw this plan?</h2></div>
                    {planWithdrawTxStatus !== 'confirmed' && (
                      <button type="button" className="icon-btn" onClick={() => setPlanWithdrawReviewOpen(false)} aria-label="Close">{icon('close')}</button>
                    )}
                  </header>

                  <div className="review-figure review-figure--left">
                    <small>You receive</small>
                    <strong>{fmtEth(quote.amountReturned, 6)} <em>ETH</em></strong>
                    <span>Sent to {shortAddress(walletSession.address)}</span>
                  </div>

                  {renderRows([
                    ['Principal', `${fmtEth(selectedActivePlan.principalAmount, 6)} ETH`],
                    ['Exit type', quote.earlyExit ? 'Early withdrawal' : 'Standard withdrawal'],
                    ['Early-exit fee', quote.earlyExit ? `${(quote.feeBps / 100).toFixed(2)}% · ${fmtEth(quote.feeAmount, 6)} ETH` : '0%', quote.earlyExit ? 'is-loss' : ''],
                    ['Loss in USD', quote.earlyExit ? (selectedPlanFeeUsd !== null ? `−${fmtUsd(selectedPlanFeeUsd)}` : 'Loading price…') : '$0.00', quote.earlyExit ? 'is-loss' : ''],
                    ['Network', currentEvmNetwork?.shortName ?? 'Unknown'],
                  ])}

                  {quote.earlyExit && (
                    <div className="notice notice--warn">
                      <strong>This fee keeps falling.</strong>
                      <span>It declines every second and reaches 0% on {formatPlanDate(selectedActivePlan.maturesAt)}.</span>
                    </div>
                  )}

                  {renderTxProgress(planWithdrawTxStatus, 'Approve the plan withdrawal', 'Closing plan onchain…', `${fmtEth(quote.amountReturned)} ETH expected · Plan #${selectedActivePlan.id}`)}
                  {planWithdrawTxStatus === 'failed' && renderTxError('Withdrawal failed', planWithdrawTxError)}

                  {planWithdrawTxStatus === 'confirmed' && (
                    <>
                      {renderReceipt(
                        planWithdrawTxHash,
                        'Plan withdrawn',
                        `${fmtEth(quote.amountReturned, 6)} ETH returned`,
                        quote.earlyExit
                          ? `−${fmtEth(quote.feeAmount, 6)} ETH${selectedPlanFeeUsd !== null ? ` · −${fmtUsd(selectedPlanFeeUsd)}` : ''} early-exit fee`
                          : 'No early-exit fee · moved to history',
                        quote.earlyExit,
                      )}
                      <button
                        type="button"
                        className="btn btn--dark btn--block btn--lg"
                        onClick={async () => {
                          await refreshOnchainPlans()
                          setPlanWithdrawReviewOpen(false)
                          setSelectedPlanId(null)
                        }}
                      >
                        Back to dashboard
                      </button>
                    </>
                  )}

                  {!isBusy(planWithdrawTxStatus) && planWithdrawTxStatus !== 'confirmed' && (
                    <div className="btn-pair">
                      <button type="button" className="btn btn--ghost btn--lg" onClick={() => setPlanWithdrawReviewOpen(false)}>Keep plan</button>
                      <button type="button" className={`btn btn--lg ${quote.earlyExit ? 'btn--danger' : 'btn--lime'}`} onClick={withdrawSelectedPlanFromRixor}>Confirm withdrawal</button>
                    </div>
                  )}
                </section>
              )}
            </div>

            <aside className="flow-side">
              <section className="card">
                <small className="kicker">Plan details</small>
                {renderRows([
                  ['Started', formatPlanDate(selectedActivePlan.startedAt)],
                  ['Term', selectedActivePlan.termLabel],
                  ['Access', selectedActivePlan.accessLabel],
                  ['Exit fee today', quote?.earlyExit ? `${(quote.feeBps / 100).toFixed(2)}%` : '0%'],
                  ['Illustrative rate', `${selectedActivePlan.apy}%`],
                  ['Rewards', '$RIXOR · not live yet'],
                ])}
              </section>
              <p className="fine-print">
                Everything on this page is read from the Rixor contract and its events for {shortAddress(walletSession.address)}. Rates are illustrative; the testnet contract does not pay rewards.
              </p>
            </aside>
          </div>
        </div>
      </main>
    )
  }

  if (walletSession && withdrawOpen) {
    return (
      <main className={`app flow ${lightMode ? 'theme-light' : 'theme-dark'}`}>
        {renderFlowBar(() => setWithdrawOpen(false))}

        <div className="container flow-body">
          {withdrawStep === 'setup' ? (
            <>
              <section className="flow-hero">
                <p className="eyebrow">Withdraw</p>
                <h1>Move your available balance back to your wallet.</h1>
                <p>This only touches ETH that is not in a plan. To exit a plan, open it from your dashboard.</p>
              </section>

              <div className="flow-grid">
                <section className="card flow-main">
                  {renderAmountField({
                    id: 'withdraw-amount',
                    label: 'Amount',
                    value: withdrawAmount,
                    onChange: setWithdrawAmount,
                    balance: withdrawSourceBalance,
                    balanceLabel: `${contractAvailableBalance} ETH available`,
                    insufficient: withdrawInsufficient,
                    insufficientCopy: 'More than your available Rixor balance.',
                    onMax: () => setWithdrawAmount(contractAvailableBalance),
                  })}
                  {withdrawSourceBalance <= 0 && (
                    <div className="empty empty--inline">
                      <strong>Nothing available to withdraw.</strong>
                      <span>Your available balance is empty. ETH inside plans stays there until you exit the plan.</span>
                    </div>
                  )}
                  <div className="source-card">
                    {icon('arrowDown')}
                    <div>
                      <small>Destination</small>
                      <strong>{shortAddress(walletSession.address)}</strong>
                    </div>
                    <span className="source-card-balance">Connected wallet</span>
                  </div>
                </section>

                <aside className="flow-side">
                  <section className="card summary-card">
                    <small className="kicker">Summary</small>
                    <p className="figure figure--md">{fmtEth(withdrawParsed)} <em>ETH</em></p>
                    {renderRows([
                      ['From', 'Available balance'],
                      ['Plans affected', 'None'],
                      ['Fee', '0%'],
                    ])}
                    <button type="button" className="btn btn--dark btn--block btn--lg" disabled={!withdrawValid} onClick={() => setWithdrawStep('review')}>
                      Review withdrawal {icon('arrowRight')}
                    </button>
                  </section>
                </aside>
              </div>
            </>
          ) : (
            <div className="review-page">
              <section className="flow-hero">
                <p className="eyebrow">Final check</p>
                <h1>Know what leaves. Know what returns.</h1>
              </section>

              <section className="card review-card">
                <div className="review-figure">
                  <small>You receive</small>
                  <strong>{fmtEth(withdrawParsed)} <em>ETH</em></strong>
                  {ethUsdPrice && <span>≈ {fmtUsd(withdrawParsed * ethUsdPrice)}</span>}
                </div>
                {renderRows([
                  ['From', 'Rixor available balance'],
                  ['To', shortAddress(walletSession.address)],
                  ['Network', currentEvmNetwork?.shortName ?? 'Unknown'],
                  ['Plans affected', 'None'],
                ])}

                {renderTxProgress(withdrawTxStatus, 'Approve the withdrawal in your wallet', 'Sending ETH back to your wallet…', `${fmtEth(withdrawParsed)} ETH · ${currentEvmNetwork?.shortName ?? 'Testnet'}`)}
                {withdrawTxStatus === 'failed' && renderTxError('Withdrawal failed', withdrawTxError)}
                {withdrawTxStatus === 'confirmed' && (
                  <>
                    {renderReceipt(withdrawTxHash, 'Withdrawal confirmed', `${fmtEth(withdrawParsed)} ETH returned`, 'Sent to your connected wallet')}
                    <button type="button" className="btn btn--dark btn--block btn--lg" onClick={() => setWithdrawOpen(false)}>Back to dashboard</button>
                  </>
                )}
                {!isBusy(withdrawTxStatus) && withdrawTxStatus !== 'confirmed' && (
                  <div className="btn-pair">
                    <button type="button" className="btn btn--ghost btn--lg" onClick={() => setWithdrawStep('setup')}>Edit</button>
                    <button type="button" className="btn btn--lime btn--lg" onClick={withdrawAvailableFromRixor} disabled={!currentRixorContractAddress || !withdrawValid}>
                      Withdraw
                    </button>
                  </div>
                )}
              </section>
              <p className="fine-print">This sends a real testnet transaction. Plan exits are handled from each plan's own page.</p>
            </div>
          )}
        </div>
      </main>
    )
  }

  if (walletSession && startPlanOpen) {
    const planAmountValue = Number(startPlanAmount || 0)

    return (
      <main className={`app flow ${lightMode ? 'theme-light' : 'theme-dark'}`}>
        {renderFlowBar(() => setStartPlanOpen(false))}

        <div className="container flow-body">
          {startPlanStep === 'setup' ? (
            <>
              <section className="flow-hero">
                <p className="eyebrow">New savings plan</p>
                <h1>What are you saving for?</h1>
                <p>Start with the goal. We will suggest a timeline, and you choose the final terms.</p>
              </section>

              <div className="goal-scroller" role="radiogroup" aria-label="Savings goal">
                {savingsGoals.map((goal) => (
                  <button
                    key={goal.id}
                    type="button"
                    role="radio"
                    aria-checked={startPlanGoal === goal.id}
                    className={`goal ${startPlanGoal === goal.id ? 'is-active' : ''}`}
                    onClick={() => {
                      setStartPlanGoal(goal.id)
                      setStartPlanTerm(goal.suggested)
                    }}
                  >
                    <strong>{goal.title}</strong>
                    <span>{goal.copy}</span>
                    <small>Suggested · {planOptions.find((item) => item.id === goal.suggested)?.label}</small>
                  </button>
                ))}
              </div>

              <div className="flow-grid">
                <section className="card flow-main">
                  <div className="step-head">
                    <span className="step-num">1</span>
                    <div><h2>Pick a timeline</h2><p>Longer locks carry a higher maximum early-exit fee.</p></div>
                  </div>
                  <div className="term-grid" role="radiogroup" aria-label="Plan term">
                    {planOptions.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={startPlanTerm === option.id}
                        className={`term ${startPlanTerm === option.id ? 'is-active' : ''}`}
                        onClick={() => setStartPlanTerm(option.id)}
                      >
                        <span className="term-top">
                          <strong>{option.label}</strong>
                          {selectedGoal.suggested === option.id && <em>Suggested</em>}
                        </span>
                        <small>{option.earlyExitMax ? `Up to ${option.earlyExitMax}% exit fee` : 'No exit fee'}</small>
                      </button>
                    ))}
                  </div>

                  <div className="step-head">
                    <span className="step-num">2</span>
                    <div><h2>Set the amount</h2><p>Plans are funded from your Rixor available balance.</p></div>
                  </div>
                  {renderAmountField({
                    id: 'start-plan-amount',
                    label: 'Amount to save',
                    value: startPlanAmount,
                    onChange: setStartPlanAmount,
                    balance: startPlanAvailableBalance,
                    balanceLabel: `${contractAvailableBalance} ETH available in Rixor`,
                    insufficient: startPlanInsufficient,
                    insufficientCopy: 'More than your available Rixor balance.',
                    onMax: () => setStartPlanAmount(contractAvailableBalance),
                  })}
                  {startPlanAvailableBalance <= 0 && (
                    <div className="empty empty--inline empty--action">
                      <div>
                        <strong>Your Rixor balance is empty.</strong>
                        <span>Add testnet ETH from your wallet first, then come back to fund the plan.</span>
                      </div>
                      <button type="button" className="btn btn--dark btn--sm" onClick={() => { setStartPlanOpen(false); openAddMoney() }}>Add money</button>
                    </div>
                  )}

                  <div className="step-head">
                    <span className="step-num">3</span>
                    <div><h2>Rewards</h2><p>Your principal stays ETH. $RIXOR rewards are planned but not live on testnet.</p></div>
                  </div>
                </section>

                <aside className="flow-side">
                  <section className="card summary-card is-sticky">
                    <small className="kicker">Your plan</small>
                    <h3>{selectedGoal.title}</h3>
                    <p className="figure figure--md">{fmtEth(planAmountValue)} <em>ETH</em></p>
                    {renderRows([
                      ['Timeline', startPlanSelected.label],
                      ['Access', startPlanSelected.access],
                      ['Maturity', startPlanMaturity],
                      ['Max exit fee', startPlanSelected.earlyExitMax ? `${startPlanSelected.earlyExitMax}%, falling to 0%` : 'None'],
                      ['Illustrative rate', `${startPlanSelected.apy}%`],
                    ])}
                    <button type="button" className="btn btn--dark btn--block btn--lg" disabled={!startPlanValid} onClick={() => setStartPlanStep('review')}>
                      Review plan {icon('arrowRight')}
                    </button>
                  </section>
                </aside>
              </div>
            </>
          ) : (
            <div className="review-page">
              <section className="flow-hero">
                <p className="eyebrow">Final check</p>
                <h1>Make it official.</h1>
              </section>

              <section className="card review-card">
                <div className="review-figure">
                  <small>{selectedGoal.title}</small>
                  <strong>{fmtEth(planAmountValue)} <em>ETH</em></strong>
                  <span>{startPlanSelected.label} · {startPlanSelected.access}</span>
                </div>
                {renderRows([
                  ['Maturity', startPlanMaturity],
                  ['Max early-exit fee', startPlanSelected.earlyExitMax ? `${startPlanSelected.earlyExitMax}% at start, 0% at maturity` : 'None'],
                  ['Network', <span className="inline-chain">{currentEvmNetwork && renderChainIcon(currentEvmNetwork.id)}{currentEvmNetwork?.shortName ?? 'Testnet'}</span>],
                  ['Contract', currentRixorContractAddress ? shortAddress(currentRixorContractAddress) : 'Unavailable'],
                  ['Rewards', '$RIXOR · not live yet'],
                ])}

                {renderTxProgress(startPlanTxStatus, 'Approve your savings plan', 'Creating your plan…', `${fmtEth(planAmountValue)} ETH · ${startPlanSelected.label}`)}
                {startPlanTxStatus === 'failed' && renderTxError('Plan creation failed', startPlanTxError)}
                {startPlanTxStatus === 'confirmed' && (
                  <>
                    {renderReceipt(startPlanTxHash, 'Plan confirmed', `${fmtEth(planAmountValue)} ETH committed`, `${startPlanSelected.label} plan is now active`)}
                    <button type="button" className="btn btn--dark btn--block btn--lg" onClick={() => setStartPlanOpen(false)}>Back to dashboard</button>
                  </>
                )}
                {!isBusy(startPlanTxStatus) && startPlanTxStatus !== 'confirmed' && (
                  <div className="btn-pair">
                    <button type="button" className="btn btn--ghost btn--lg" onClick={() => setStartPlanStep('setup')}>Edit</button>
                    <button type="button" className="btn btn--lime btn--lg" onClick={createSavingsPlan} disabled={!currentRixorContractAddress || !startPlanValid}>
                      Start plan
                    </button>
                  </div>
                )}
              </section>
              <p className="fine-print">One wallet approval moves this amount from your available balance into a new plan. Displayed rates are illustrative.</p>
            </div>
          )}
        </div>
      </main>
    )
  }

  if (walletSession && dashboardView) {
    const isEvm = walletSession.kind === 'evm'

    return (
      <main className={`app dashboard ${lightMode ? 'theme-light' : 'theme-dark'}`}>
        <header className={`app-bar ${navCompact ? 'is-scrolled' : ''}`}>
          <div className="container app-bar-inner">
            <button className="brand-btn" type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Rixor dashboard">
              {renderRixorBrand()}
            </button>

            <nav className="seg seg--nav" aria-label="Dashboard sections">
              <button type="button" aria-current={dashboardNavTab === 'diamond' ? 'page' : undefined} className={dashboardNavTab === 'diamond' ? 'is-active' : ''} onClick={() => switchDashboardSection('diamond')}>Diamond Hands</button>
              <button type="button" aria-current={dashboardNavTab === 'home' ? 'page' : undefined} className={dashboardNavTab === 'home' ? 'is-active' : ''} onClick={() => switchDashboardSection('home')}>ETH Savings</button>
            </nav>

            <div className="app-bar-actions">
              <button type="button" className="icon-btn" onClick={() => setLightMode(!lightMode)} aria-label={lightMode ? 'Switch to dark mode' : 'Switch to light mode'}>
                {icon(lightMode ? 'moon' : 'sun')}
              </button>
              <button className="wallet-btn" type="button" onClick={() => setWalletModalOpen(true)}>
                {isEvm && currentEvmNetwork ? renderChainIcon(currentEvmNetwork.id) : <span className="dot-live" />}
                <span className="wallet-btn-copy">
                  {isEvm && <small>{nativeBalance} ETH</small>}
                  <b>{shortAddress(walletSession.address)}</b>
                </span>
              </button>
            </div>
          </div>
        </header>

        {renderWalletSheet()}
        {renderAddMoneySheet()}

        <div className="container app-body">
          {dashboardNavTab === 'home' ? (
            <div className="view" key="home">
              <section className="card balance-card">
                <div className="balance-card-top">
                  <div>
                    <small className="label">Available in Rixor</small>
                    <p className="figure figure--xl">{contractAvailableBalance} <em>ETH</em></p>
                    <p className="figure-sub">
                      {ethUsdPrice ? `≈ ${fmtUsd(rixorAvailableBalance * ethUsdPrice)} · ` : ''}
                      {currentRixorContractAddress ? 'Read live from the contract' : 'Rixor is not on this network yet'}
                    </p>
                  </div>
                  {isEvm ? (
                    <div className="net-switch" aria-label="Network">
                      {evmNetworks.map((network) => (
                        <button
                          key={network.id}
                          type="button"
                          className={evmChainId === network.id ? 'is-active' : ''}
                          onClick={() => switchEvmNetwork(network.id)}
                          disabled={networkSwitching !== null}
                        >
                          {renderChainIcon(network.id)}
                          <span>{networkSwitching === network.id ? 'Switching…' : network.shortName}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="tag">Solana connected</span>
                  )}
                </div>

                <div className="action-row">
                  <button type="button" className="btn btn--dark btn--lg" onClick={openAddMoney}>{icon('plus')} Add money</button>
                  <button type="button" className="btn btn--lime btn--lg" onClick={openStartPlan}>Start a plan</button>
                  <button type="button" className="btn btn--ghost btn--lg" onClick={openWithdraw}>{icon('arrowUp')} Withdraw</button>
                </div>
              </section>

              {isEvm && !currentEvmNetwork && evmChainId !== null && (
                <div className="notice notice--warn"><strong>Unsupported network.</strong><span>Switch to Sepolia or Robinhood Chain Testnet to use Rixor.</span></div>
              )}
              {isEvm && walletError && renderTxError('Network', walletError)}
              {isEvm && nativeBalanceStatus === 'error' && (
                <div className="notice notice--error"><strong>Could not read your {currentEvmNetwork?.shortName ?? 'testnet'} balance.</strong><span>{nativeBalanceError || 'Try refresh or reconnect the wallet.'}</span></div>
              )}

              <div className="stat-grid">
                <div className="stat">
                  <small>Saved in plans</small>
                  <strong>{fmtEth(savedInPlans)} <em>ETH</em></strong>
                  <span>{activePlans.length} active {activePlans.length === 1 ? 'plan' : 'plans'}</span>
                </div>
                <div className="stat">
                  <small>Wallet balance</small>
                  <strong>{nativeBalanceStatus === 'loading' ? '…' : nativeBalance} <em>ETH</em></strong>
                  <button type="button" className="text-btn" onClick={() => void Promise.all([refreshNativeBalance(), refreshContractAvailableBalance(), refreshOnchainPlans()])}>
                    {icon('refresh', 14)} Refresh
                  </button>
                </div>
                <div className="stat">
                  <small>Rewards earned</small>
                  <strong>0.0000 <em>$RIXOR</em></strong>
                  <span>Not live on testnet</span>
                </div>
                <div className="stat">
                  <small>Plans closed</small>
                  <strong>{planHistory.length}</strong>
                  <span>{planHistory.filter((item) => item.earlyExit).length} early</span>
                </div>
              </div>

              {currentEvmNetwork && !currentRixorContractAddress && isDeploymentAdmin && (
                <section className="card admin-card">
                  <div>
                    <small className="kicker">Admin · testnet contract</small>
                    <h2>Deploy on {currentEvmNetwork.shortName}</h2>
                    <p>Wallet-signed deployment for this testnet only. Gas is paid in test ETH.</p>
                    {deployError && <p className="field-error">{deployError}</p>}
                  </div>
                  <div className="admin-card-actions">
                    <button
                      type="button"
                      className="btn btn--dark"
                      onClick={() => void deployRixorContract()}
                      disabled={deployStatus === 'awaiting-wallet' || deployStatus === 'pending' || deployStatus === 'confirmed'}
                    >
                      {deployStatus === 'awaiting-wallet' ? 'Approve in wallet…' : deployStatus === 'pending' ? 'Deploying…' : deployStatus === 'confirmed' ? 'Deployed' : 'Deploy contract'}
                    </button>
                    {deployTxHash && <a className="text-btn" href={`${currentEvmNetwork.explorerUrl}/tx/${deployTxHash}`} target="_blank" rel="noreferrer">View deployment {icon('arrowUpRight', 14)}</a>}
                  </div>
                </section>
              )}

              <section className="card list-card">
                <header className="panel-head">
                  <div><small className="kicker">Active plans</small><h2>Your savings plans</h2></div>
                  {activePlans.length > 0 && <button type="button" className="btn btn--sm btn--ghost" onClick={openStartPlan}>{icon('plus', 16)} New</button>}
                </header>
                {activePlans.length === 0 ? (
                  <div className="empty empty--action">
                    <div>
                      <strong>No active plans yet.</strong>
                      <span>Plans you create onchain appear here automatically for this wallet.</span>
                    </div>
                    <button type="button" className="btn btn--lime btn--sm" onClick={openStartPlan}>Start a plan</button>
                  </div>
                ) : (
                  <div className="plan-list">
                    {activePlans.map((planItem) => {
                      const progress = Math.min(100, Math.max(0, planItem.progress))
                      return (
                        <button key={planItem.id} type="button" className="plan-row" onClick={() => setSelectedPlanId(planItem.id)}>
                          <span className={`plan-badge ${planItem.status === 'matured' ? 'is-matured' : ''}`}>{termShort[planItem.planType] ?? '—'}</span>
                          <span className="plan-row-main">
                            <strong>{planItem.goal}</strong>
                            <span>{planItem.maturesAt ? `${planItem.status === 'matured' ? 'Matured' : 'Matures'} ${formatPlanDate(planItem.maturesAt)}` : planItem.accessLabel}</span>
                          </span>
                          <span className="plan-row-amount">
                            <strong>{fmtEth(planItem.principalAmount)} ETH</strong>
                            <span className="progress progress--sm"><i style={{ width: `${progress}%` }} /></span>
                          </span>
                          {icon('arrowRight')}
                        </button>
                      )
                    })}
                  </div>
                )}
              </section>

              <div className="split">
                <section className="card list-card">
                  <header className="panel-head">
                    <div><small className="kicker">Activity</small><h2>Recent movement</h2></div>
                    {activityItems.length > 4 && (
                      <button type="button" className="text-btn" onClick={() => setActivityExpanded((current) => !current)}>{activityExpanded ? 'Show less' : 'View all'}</button>
                    )}
                  </header>
                  {activityItems.length === 0 ? (
                    <div className="empty"><span>Confirmed deposits, plan starts and withdrawals for this wallet will appear here.</span></div>
                  ) : (
                    <ul className="feed">
                      {(activityExpanded ? activityItems : activityItems.slice(0, 4)).map((item) => (
                        <li key={item.id}>
                          <span className={`feed-icon feed-icon--${item.type}`}>
                            {icon(item.type === 'deposit' ? 'arrowDown' : item.type === 'withdrawal' ? 'arrowUp' : item.type === 'reward' ? 'arrowUpRight' : 'lock', 16)}
                          </span>
                          <span className="feed-copy">
                            <strong>{item.title}</strong>
                            <span>{formatActivityDate(item.timestamp)} · {item.network}</span>
                          </span>
                          <span className="feed-amount">
                            <strong>{item.type === 'withdrawal' ? '−' : item.type === 'deposit' ? '+' : ''}{fmtEth(item.amount)} {item.asset}</strong>
                            {item.txHash && currentEvmNetwork
                              ? <a href={`${currentEvmNetwork.explorerUrl}/tx/${item.txHash}`} target="_blank" rel="noreferrer">Tx {icon('arrowUpRight', 12)}</a>
                              : <span className={`status status--${item.status}`}>{item.status}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="card list-card">
                  <header className="panel-head">
                    <div><small className="kicker">Plan history</small><h2>Completed & withdrawn</h2></div>
                    {planHistory.length > 4 && (
                      <button type="button" className="text-btn" onClick={() => setHistoryExpanded((current) => !current)}>{historyExpanded ? 'Show less' : 'View all'}</button>
                    )}
                  </header>
                  {planHistory.length === 0 ? (
                    <div className="empty"><span>When you close a plan, its final amount and exit details stay here.</span></div>
                  ) : (
                    <ul className="feed">
                      {(historyExpanded ? planHistory : planHistory.slice(0, 4)).map((item) => (
                        <li key={`${item.id}-${item.txHash ?? item.closedAt}`}>
                          <span className="feed-icon feed-icon--closed">{icon('check', 16)}</span>
                          <span className="feed-copy">
                            <strong>{item.goal} · {item.termLabel}</strong>
                            <span>{formatPlanDate(item.startedAt)} → {formatPlanDate(item.closedAt)}</span>
                          </span>
                          <span className="feed-amount">
                            <strong>{fmtEth(item.amountReturned)} {item.principalAsset}</strong>
                            {item.earlyExitFee > 0
                              ? <span className="is-loss">−{fmtEth(item.earlyExitFee)} fee</span>
                              : <span>{item.earlyExit ? 'Early exit' : 'Completed'}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              <p className="fine-print fine-print--center">
                {currentRixorContractAddress && currentEvmNetwork ? (
                  <>Balances and plans are read from the Rixor contract <a href={`${currentEvmNetwork.explorerUrl}/address/${currentRixorContractAddress}`} target="_blank" rel="noreferrer">{shortAddress(currentRixorContractAddress)}</a> on {currentEvmNetwork.shortName}. Testnet only.</>
                ) : 'Rixor is available on Sepolia and Robinhood Chain Testnet.'}
              </p>
            </div>
          ) : (
            <DiamondHands
              walletAddress={isEvm ? walletSession.address : null}
              provider={connectedEvmProvider}
              chainId={evmChainId}
              switching={networkSwitching !== null}
              onSwitchToMainnet={() => void switchEvmNetwork(ROBINHOOD_MAINNET.id)}
            />
          )}
        </div>

        <nav className="tabbar" aria-label="Dashboard sections">
          <button type="button" className={dashboardNavTab === 'diamond' ? 'is-active' : ''} aria-current={dashboardNavTab === 'diamond' ? 'page' : undefined} onClick={() => switchDashboardSection('diamond')}>
            {icon('diamond', 20)}<span>Diamond</span>
          </button>
          <button
            type="button"
            className="tabbar-cta"
            aria-label={dashboardNavTab === 'diamond' ? 'New lock' : 'Add money'}
            onClick={() => {
              if (dashboardNavTab === 'home') {
                openAddMoney()
                return
              }
              const field = document.getElementById('wif-amount')
              field?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              window.setTimeout(() => field?.focus({ preventScroll: true }), 400)
            }}
          >
            {icon('plus', 22)}
          </button>
          <button type="button" className={dashboardNavTab === 'home' ? 'is-active' : ''} aria-current={dashboardNavTab === 'home' ? 'page' : undefined} onClick={() => switchDashboardSection('home')}>
            {icon('home', 20)}<span>Savings</span>
          </button>
        </nav>
      </main>
    )
  }

  const feeCurveY = (feePercent: number) => 132 - (feePercent / 8) * 104
  const showcaseMax = selectedPlan.earlyExitMax
  const launchApp = () => {
    setDashboardNavTab('diamond')
    if (walletSession) setDashboardView(true)
    else openWalletFor('dashboard')
  }
  const diamondLive = Boolean(DIAMOND_ADDRESS)
  const liveValue = (value: number) => (diamondStats.status === 'ready' ? formatWif(value, true) : diamondStats.status === 'not-deployed' ? '—' : '…')
  const sepoliaSavingsUrl = sepoliaContractUrl

  return (
    <main className="site">
      {renderWalletSheet()}

      <header className={`site-nav ${navCompact ? 'is-scrolled' : ''}`}>
        <div className="container site-nav-inner">
          <button className="brand-btn" type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Rixor home">
            {renderRixorBrand()}
          </button>
          <nav className="site-links" aria-label="Sections">
            <button type="button" onClick={() => scrollToSection('flywheel')}>Flywheel</button>
            <button type="button" onClick={() => scrollToSection('terms')}>Terms</button>
            <button type="button" onClick={() => scrollToSection('leaderboard')}>Leaderboard</button>
            <button type="button" onClick={() => scrollToSection('security')}>Security</button>
          </nav>
          <button type="button" className="btn btn--dark btn--sm" onClick={launchApp}>
            {walletSession ? 'Open app' : 'Launch app'}
          </button>
        </div>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="container hero-grid">
          <div className="hero-copy">
            <span className="tag tag--outline">
              <span className={diamondLive ? 'dot-live' : 'dot-soon'} />
              {diamondLive ? 'Live on Robinhood Chain' : 'Built on Robinhood Chain'} · $WIF
            </span>
            <h1 id="hero-title">Diamond hands, <span>enforced onchain.</span></h1>
            <p>
              Lock $WIF for a week or a year. Selling early costs a paper-hands fee that shrinks every second. Half of it is burned, the other half is paid to everyone still holding.
            </p>
            <div className="hero-actions">
              <button type="button" className="btn btn--lime btn--lg" onClick={launchApp}>
                Lock $WIF {icon('arrowRight')}
              </button>
              <button type="button" className="btn btn--ghost btn--lg" onClick={() => scrollToSection('flywheel')}>How it works</button>
            </div>
            <p className="hero-note">{icon('info', 14)} No owner, no admin keys, no protocol fee.</p>
          </div>

          <div className="hero-visual" aria-hidden="true">
            <div className="phone">
              <div className="phone-screen">
                <div className="phone-status"><span>9:41</span><span className="phone-notch" /><span>●●●</span></div>
                <div className="mock-head"><span>Your lock · 90 days</span></div>
                <div className="mock-balance">1,250,000 <em>$WIF</em></div>
                <div className="mock-delta">▲ 4,820 $WIF earned from paper hands</div>
                <div className="mock-ring">
                  <svg viewBox="0 0 120 120">
                    <circle cx="60" cy="60" r="50" className="mock-ring-track" />
                    <circle cx="60" cy="60" r="50" className="mock-ring-fill" strokeDasharray="314" strokeDashoffset="113" />
                  </svg>
                  <span><b>64%</b><small>held</small></span>
                </div>
                <div className="mock-list">
                  <div className="mock-row"><span className="mock-badge">FEE</span><span className="mock-row-copy"><b>Paper-hands fee today</b><i style={{ width: '36%' }} /></span><span className="mock-amount">5.4%</span></div>
                  <div className="mock-row"><span className="mock-badge">32D</span><span className="mock-row-copy"><b>Until unlock</b><i style={{ width: '64%' }} /></span><span className="mock-amount">0% fee</span></div>
                </div>
                <div className="mock-actions"><span className="is-lime">Claim</span><span className="is-paper">Paper hand</span></div>
              </div>
            </div>
            <div className="float-card float-card--fee">
              <small>Paper hand exits</small>
              <strong>50% burned</strong>
              <span>through $WIF's own burn()</span>
            </div>
            <div className="float-card float-card--ok">
              <span className="receipt-check">{icon('coins', 16)}</span>
              <span><small>The other 50%</small><strong>paid to diamond hands</strong></span>
            </div>
          </div>
        </div>
      </section>

      <section className="live-strip" aria-label="Live flywheel stats">
        <div className="container">
          <div className="live-strip-head">
            <span className={diamondLive ? 'dot-live' : 'dot-soon'} />
            {diamondLive ? 'Live from Robinhood Chain' : 'Live stats appear here once the lock contract is deployed'}
          </div>
          <div className="live-grid">
            <div><small>$WIF locked</small><strong>{liveValue(diamondStats.totalLocked)}</strong></div>
            <div><small>Burned by paper hands</small><strong>{liveValue(diamondStats.totalBurned)}</strong></div>
            <div><small>Paid to holders</small><strong>{liveValue(diamondStats.totalDistributed)}</strong></div>
            <div><small>Open locks</small><strong>{diamondStats.status === 'ready' ? diamondStats.openLocks.toLocaleString() : diamondStats.status === 'not-deployed' ? '—' : '…'}</strong></div>
          </div>
        </div>
      </section>

      <section className="flywheel" id="flywheel" aria-labelledby="flywheel-title">
        <div className="container">
          <p className="eyebrow">The flywheel</p>
          <h2 id="flywheel-title" className="section-title">Patience gets paid. Panic gets burned.</h2>
          <div className="loop">
            {[
              ['lock', 'Lock', 'Commit $WIF for 7 days to 1 year. Longer locks earn up to 3x reward weight.'],
              ['flame', 'Someone paper-hands', 'Breaking a lock early costs up to 25%, shrinking to 0% as the unlock nears.'],
              ['coins', 'Burn + reward', 'Half the fee is burned forever. Half is shared with every open lock, by weight.'],
              ['loop', 'Claim & relock', 'Holders claim $WIF anytime and lock again for a bigger share. Supply keeps shrinking.'],
            ].map(([glyph, title, copy], index) => (
              <article key={title} className="loop-step">
                <span className="loop-index">0{index + 1}</span>
                <span className="loop-icon">{icon(glyph as 'lock', 22)}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
            <span className="loop-center" aria-hidden="true">{icon('loop', 28)}</span>
          </div>
        </div>
      </section>

      <section className="lime-band" aria-labelledby="split-title">
        <div className="container lime-grid">
          <div className="lime-art">
            {renderOutlineNumeral('50/50', 'Fifty fifty', 900)}
            <span className="lime-art-label">every exit fee</span>
          </div>
          <div className="lime-copy">
            <p className="eyebrow eyebrow--onlime">Split</p>
            <h2 id="split-title" className="section-title">Every paper-hands fee splits 50/50</h2>
            <p>
              Half is burned through $WIF's own burn function, so total supply drops with every early exit. The other half, plus any rewards the seller forfeits, is streamed to everyone still locked. If nobody else is holding, the whole fee is burned.
            </p>
            <button type="button" className="info-link" onClick={() => scrollToSection('terms')}>{icon('info', 14)} See fees and weights for each term</button>
            <button type="button" className="btn btn--dark btn--lg" onClick={launchApp}>Lock $WIF</button>
          </div>
        </div>
      </section>

      <section className="compare" id="terms" aria-labelledby="terms-title">
        <div className="container">
          <h2 id="terms-title" className="section-title section-title--center">Pick how diamond your hands are</h2>
          <div className="compare-card">
            <div className="compare-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Lock</th>
                    <th scope="col" className="is-rixor">Reward weight</th>
                    <th scope="col">Max paper-hands fee</th>
                    <th scope="col">Fee at halfway</th>
                  </tr>
                </thead>
                <tbody>
                  {LOCK_TERMS.map((option) => (
                    <tr key={option.id}>
                      <th scope="row">{option.label}</th>
                      <td className="is-rixor">{option.weightBps / 10_000}x</td>
                      <td>{option.maxFeeBps / 100}%</td>
                      <td>{option.maxFeeBps / 200}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="compare-note">
            The fee falls in a straight line from its maximum on day one to 0% at unlock. After unlock you withdraw your $WIF plus rewards with no fee. Rewards come only from other holders' exit fees; nothing is minted.
          </p>
        </div>
      </section>

      <section className="board-section" id="leaderboard" aria-labelledby="board-title">
        <div className="container">
          <p className="eyebrow">Leaderboard</p>
          <h2 id="board-title" className="section-title">Who has the diamondest hands?</h2>
          {diamondLive ? (
            <div className="board-wrap"><DiamondBoard history={diamondHistory} walletAddress={walletSession?.address} /></div>
          ) : (
            <div className="board-teaser">
              <span className="loop-icon">{icon('trophy', 22)}</span>
              <div>
                <strong>The board opens with the first lock.</strong>
                <span>Every lock, claim and paper-hand exit is read from contract events on Robinhood Chain. No database.</span>
              </div>
              <button type="button" className="btn btn--lime" onClick={launchApp}>Be first</button>
            </div>
          )}
        </div>
      </section>

      <section className="showcase" id="plans" aria-labelledby="plans-title">
        <div className="container showcase-grid">
          <div className="showcase-visual" aria-hidden="true">
            <div className="phone phone--dark">
              <div className="phone-screen">
                <div className="phone-status"><span>9:41</span><span className="phone-notch" /><span>●●●</span></div>
                <div className="mock-head"><span>{selectedPlan.label} plan</span></div>
                <div className="mock-balance">{showcaseMax}% <em>max fee</em></div>
                <div className="mock-delta">▼ falls to 0% by {maturityDate === 'Anytime' ? 'design' : maturityDate}</div>
                <svg className="fee-chart" viewBox="0 0 300 150" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="feeFill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#c8ff00" stopOpacity=".35" />
                      <stop offset="100%" stopColor="#c8ff00" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  {[28, 54, 80, 106, 132].map((y) => <line key={y} x1="0" x2="300" y1={y} y2={y} className="fee-grid" />)}
                  <path d={`M0 ${feeCurveY(showcaseMax)} L300 132 L300 150 L0 150 Z`} fill="url(#feeFill)" />
                  <path d={`M0 ${feeCurveY(showcaseMax)} L300 132`} className="fee-line" />
                  <circle cx="0" cy={feeCurveY(showcaseMax)} r="4" className="fee-dot" />
                  <circle cx="300" cy="132" r="4" className="fee-dot" />
                </svg>
                <div className="mock-axis"><span>Day 0</span><span>{planTerm === 'flexible' ? 'Any day' : `Day ${selectedPlan.days}`}</span></div>
                <div className="mock-range">
                  {planOptions.map((option, index) => (
                    <span key={option.id} className={option.id === planTerm ? 'is-active' : ''}>{termShort[index]}</span>
                  ))}
                </div>
                <div className="mock-foot"><span>Access</span><b>{selectedPlan.access}</b></div>
              </div>
            </div>
          </div>

          <div className="showcase-copy">
            <p className="eyebrow">Also in Rixor · testnet</p>
            <h2 id="plans-title" className="section-title">ETH savings plans with exit fees you can read</h2>
            <p>The same idea for everyday saving: put testnet ETH toward a goal, choose Flexible or a 30-day to 1-year lock, and see the exact early-exit fee before you sign. Runs on Sepolia and Robinhood Chain Testnet.</p>

            <div className="seg seg--wrap" role="radiogroup" aria-label="Plan term">
              {planOptions.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={planTerm === option.id} className={planTerm === option.id ? 'is-active' : ''} onClick={() => setPlanTerm(option.id)}>
                  {option.label}
                </button>
              ))}
            </div>

            {renderRows([
              ['Access', selectedPlan.access],
              ['Max early-exit fee', showcaseMax ? `${showcaseMax}%, falling to 0%` : 'None'],
              ['Matures', maturityDate],
            ])}

            <button type="button" className="btn btn--ghost btn--lg" onClick={() => openWalletFor('start-plan', planTerm)}>
              {walletSession ? `Start a ${selectedPlan.label.toLowerCase()} plan` : 'Try ETH savings'}
            </button>
          </div>
        </div>
      </section>

      <section className="commitments" id="security" aria-labelledby="security-title">
        <div className="container">
          <h2 id="security-title" className="section-title section-title--center">Rixor Commitments</h2>
          <div className="commitments-cta">
            <a className="btn btn--outline-light" href={diamondLive ? explorerAddress(DIAMOND_ADDRESS) : 'https://github.com/XDGram/Rixor/blob/main/contracts/RixorDiamondHands.sol'} target="_blank" rel="noreferrer">Read the contract</a>
          </div>
          <div className="commitment-grid">
            <article>
              <svg viewBox="0 0 120 120" className="line-art" aria-hidden="true">
                <path d="M60 14 102 38v44L60 106 18 82V38Z" /><path d="M18 38l42 24 42-24M60 62v44" />
                <path d="M39 26l42 24M81 26 39 50M32 59v24M88 59v24M46 67v24M74 67v24" />
              </svg>
              <h3>No admin keys</h3>
              <p>The lock contract has no owner, no upgrade path and no protocol fee. Only you can move your $WIF.</p>
            </article>
            <article>
              <svg viewBox="0 0 120 120" className="line-art" aria-hidden="true">
                <path d="M30 16h46l18 18v70H30Z" /><path d="M76 16v18h18" />
                <path d="M42 50h40M42 62h40M42 74h22" /><circle cx="78" cy="84" r="14" /><path d="m71 84 5 5 9-10" />
              </svg>
              <h3>See the cost first</h3>
              <p>The exact fee, what gets burned, what goes to holders and what you get back are shown before your wallet opens.</p>
            </article>
            <article>
              <svg viewBox="0 0 120 120" className="line-art" aria-hidden="true">
                <path d="M60 18 98 36 60 54 22 36Z" /><path d="M22 36v14l38 18 38-18V36" />
                <path d="M22 58v14l38 18 38-18V58" /><path d="M22 80v14l38 18 38-18V80" />
              </svg>
              <h3>Burns are real</h3>
              <p>Burned $WIF goes through the token's own burn function, so total supply drops onchain. Nothing is minted.</p>
            </article>
            <article>
              <svg viewBox="0 0 120 120" className="line-art" aria-hidden="true">
                <path d="M60 12c22 10 36 10 40 10 0 40-12 70-40 86C32 92 20 62 20 22c4 0 18 0 40-10Z" />
                <path d="M60 28c14 6 24 7 27 7-1 28-9 50-27 61-18-11-26-33-27-61 3 0 13-1 27-7Z" />
              </svg>
              <h3>Honest about risk</h3>
              <p>$WIF has no promise of value or return. The contract is open source and tested, but not audited. Lock only what you can leave alone.</p>
            </article>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="container footer-grid">
          <div>
            {renderRixorBrand()}
            <p>Diamond hands for $WIF, and ETH savings with clear terms.</p>
          </div>
          <div className="footer-links">
            <a href={explorerAddress(WIF_ADDRESS)} target="_blank" rel="noreferrer">$WIF token {icon('arrowUpRight', 12)}</a>
            {diamondLive && <a href={explorerAddress(DIAMOND_ADDRESS)} target="_blank" rel="noreferrer">Lock contract {shortAddr(DIAMOND_ADDRESS)} {icon('arrowUpRight', 12)}</a>}
            <a href={sepoliaSavingsUrl} target="_blank" rel="noreferrer">Savings contract (Sepolia) {icon('arrowUpRight', 12)}</a>
            <a href={robinhoodContractUrl} target="_blank" rel="noreferrer">Savings contract (Robinhood Chain Testnet) {icon('arrowUpRight', 12)}</a>
          </div>
          <p className="footer-legal">
            Rixor is an independent project built for the world is flat hackathon. It is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. $WIF comes with no promise of value or return. ETH savings run on public testnets only, and their displayed rates are illustrative.
          </p>
        </div>
      </footer>
    </main>
  )
}
