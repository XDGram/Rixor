import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import 'dotenv/config'
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers'

const networks = {
  sepolia: {
    chainId: 11155111,
    rpcUrl: process.env.RIXOR_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
  },
  robinhood: {
    chainId: 46630,
    rpcUrl: process.env.RIXOR_ROBINHOOD_RPC_URL || 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
  },
}

const networkName = process.argv[2]
const network = networks[networkName]
if (!network) {
  console.error('Usage: npm run contract:deploy -- sepolia|robinhood')
  process.exit(1)
}

const privateKey = process.env.RIXOR_DEPLOYER_PRIVATE_KEY
if (!privateKey) {
  console.error('Missing RIXOR_DEPLOYER_PRIVATE_KEY in environment/.env')
  process.exit(1)
}

const artifactPath = path.join(process.cwd(), 'artifacts', 'RixorSavings.json')
if (!fs.existsSync(artifactPath)) {
  console.error('Missing artifact. Run npm run contract:compile first.')
  process.exit(1)
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
const provider = new JsonRpcProvider(network.rpcUrl, network.chainId)
const wallet = new Wallet(privateKey, provider)

console.log(`Deploying RixorSavings to ${networkName} from ${wallet.address}...`)
const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet)
const contract = await factory.deploy()
console.log(`Deployment tx: ${contract.deploymentTransaction().hash}`)
await contract.waitForDeployment()

const address = await contract.getAddress()
console.log(`RixorSavings deployed: ${address}`)
console.log(`Explorer: ${network.explorer}/address/${address}`)
console.log(`Frontend env: ${networkName === 'sepolia' ? 'VITE_RIXOR_SEPOLIA_ADDRESS' : 'VITE_RIXOR_ROBINHOOD_TESTNET_ADDRESS'}=${address}`)
