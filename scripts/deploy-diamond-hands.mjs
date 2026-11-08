import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import 'dotenv/config'
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from 'ethers'

// $WIF (World is Flat) on Robinhood Chain mainnet, verified onchain: name "World is Flat",
// symbol "WIF", 18 decimals, exposes burn(uint256).
const WIF_MAINNET = '0x5173b8eA6923c2d40267890D45C46a3480954773'

const networks = {
  'robinhood-mainnet': {
    chainId: 4663,
    rpcUrl: process.env.RIXOR_ROBINHOOD_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robin.etherscan.io',
    token: WIF_MAINNET,
  },
  'robinhood-testnet': {
    chainId: 46630,
    rpcUrl: process.env.RIXOR_ROBINHOOD_RPC_URL || 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
    // No $WIF on testnet: pass a burnable test token with RIXOR_DIAMOND_TOKEN.
    token: process.env.RIXOR_DIAMOND_TOKEN,
  },
}

const networkName = process.argv[2]
const network = networks[networkName]
if (!network) {
  console.error('Usage: npm run contract:deploy:diamond -- robinhood-mainnet|robinhood-testnet')
  process.exit(1)
}
if (!network.token) {
  console.error('Set RIXOR_DIAMOND_TOKEN to the burnable token address for this network.')
  process.exit(1)
}

const privateKey = process.env.RIXOR_DEPLOYER_PRIVATE_KEY
if (!privateKey) {
  console.error('Missing RIXOR_DEPLOYER_PRIVATE_KEY in environment/.env')
  process.exit(1)
}

const artifactPath = path.join(process.cwd(), 'artifacts', 'RixorDiamondHands.json')
if (!fs.existsSync(artifactPath)) {
  console.error('Missing artifact. Run npm run contract:compile first.')
  process.exit(1)
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
const provider = new JsonRpcProvider(network.rpcUrl, network.chainId)
const wallet = new Wallet(privateKey, provider)

const token = new Contract(network.token, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], provider)
const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()])
console.log(`Token ${network.token}: ${symbol}, ${decimals} decimals`)

console.log(`Deploying RixorDiamondHands to ${networkName} from ${wallet.address}...`)
const contract = await new ContractFactory(artifact.abi, artifact.bytecode, wallet).deploy(network.token)
const deployTx = contract.deploymentTransaction()
console.log(`Deployment tx: ${network.explorer}/tx/${deployTx.hash}`)
await contract.waitForDeployment()
const receipt = await deployTx.wait()

const address = await contract.getAddress()
console.log(`RixorDiamondHands deployed: ${address} (block ${receipt.blockNumber})`)
console.log(`Explorer: ${network.explorer}/address/${address}`)
console.log('Set these for the frontend (Vercel env vars or .env):')
console.log(`  VITE_RIXOR_DIAMOND_ADDRESS=${address}`)
console.log(`  VITE_RIXOR_DIAMOND_FROM_BLOCK=${receipt.blockNumber}`)
