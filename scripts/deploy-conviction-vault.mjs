// Deploys RixorConvictionVault to Robinhood Chain TESTNET only.
//
// $WIF is not deployed on Robinhood Chain Testnet (verified: no contract code at the mainnet
// $WIF address on chain 46630), so this script never assumes a token. You must pass the
// address of an existing burnable ERC-20 on testnet in RIXOR_VAULT_TOKEN.
//
// There is also no verified $WIF price feed. On testnet you can either pass an existing
// oracle (RIXOR_VAULT_ORACLE) or explicitly opt in to a MOCK oracle with
// RIXOR_VAULT_MOCK_ORACLE_PRICE, whose price is set by hand and tracks no market.
//
// Mainnet deployment is intentionally not supported here.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import 'dotenv/config'
import { Contract, ContractFactory, JsonRpcProvider, Wallet, id, isAddress, parseUnits } from 'ethers'

const TESTNET = {
  chainId: 46630,
  rpcUrl: process.env.RIXOR_ROBINHOOD_RPC_URL || 'https://rpc.testnet.chain.robinhood.com',
  explorer: 'https://explorer.testnet.chain.robinhood.com',
}
const WIF_MAINNET = '0x5173b8ea6923c2d40267890d45c46a3480954773'

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

if (process.argv[2] && process.argv[2] !== 'robinhood-testnet') {
  fail('Only robinhood-testnet is supported. Mainnet deployment is deliberately disabled.')
}

const privateKey = process.env.RIXOR_DEPLOYER_PRIVATE_KEY
if (!privateKey) fail('Missing RIXOR_DEPLOYER_PRIVATE_KEY (a dedicated testnet key).')

const tokenAddress = (process.env.RIXOR_VAULT_TOKEN || '').trim()
if (!isAddress(tokenAddress)) fail('Set RIXOR_VAULT_TOKEN to an existing burnable ERC-20 on Robinhood Chain Testnet.')
if (tokenAddress.toLowerCase() === WIF_MAINNET) fail('That is the mainnet $WIF address. It has no contract on testnet.')

const load = (name) => {
  const file = path.join(process.cwd(), 'artifacts', `${name}.json`)
  if (!fs.existsSync(file)) fail('Missing artifacts. Run npm run contract:compile first.')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const provider = new JsonRpcProvider(TESTNET.rpcUrl, TESTNET.chainId)
const network = await provider.getNetwork()
if (Number(network.chainId) !== TESTNET.chainId) fail(`RPC reports chain ${network.chainId}, expected ${TESTNET.chainId}.`)

const code = await provider.getCode(tokenAddress)
if (code === '0x') fail(`No contract at ${tokenAddress} on Robinhood Chain Testnet.`)
if (!code.includes(id('burn(uint256)').slice(2, 10))) fail('Token does not expose burn(uint256); the vault burns half of every fee.')
const token = new Contract(tokenAddress, ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], provider)
const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()])
console.log(`Token ${tokenAddress}: ${symbol}, ${decimals} decimals`)

const wallet = new Wallet(privateKey, provider)
let oracleAddress = (process.env.RIXOR_VAULT_ORACLE || '').trim()
if (!oracleAddress) {
  const mockPrice = process.env.RIXOR_VAULT_MOCK_ORACLE_PRICE
  if (!mockPrice) fail('Set RIXOR_VAULT_ORACLE, or opt in to a MOCK oracle with RIXOR_VAULT_MOCK_ORACLE_PRICE (e.g. 1.0).')
  console.warn('WARNING: deploying RixorMockPriceOracle. Its price is set by hand and tracks no market.')
  const oracleArtifact = load('RixorMockPriceOracle')
  const oracle = await new ContractFactory(oracleArtifact.abi, oracleArtifact.bytecode, wallet).deploy(parseUnits(mockPrice, 18))
  await oracle.waitForDeployment()
  oracleAddress = await oracle.getAddress()
  console.log(`Mock oracle: ${TESTNET.explorer}/address/${oracleAddress}`)
} else if (!isAddress(oracleAddress)) {
  fail('RIXOR_VAULT_ORACLE is not an address.')
}

const maxPriceAge = Number(process.env.RIXOR_VAULT_MAX_PRICE_AGE || 86_400)
const vaultArtifact = load('RixorConvictionVault')
console.log(`Deploying RixorConvictionVault from ${wallet.address}...`)
const vault = await new ContractFactory(vaultArtifact.abi, vaultArtifact.bytecode, wallet).deploy(tokenAddress, oracleAddress, maxPriceAge)
const receipt = await vault.deploymentTransaction().wait()
const vaultAddress = await vault.getAddress()

console.log(`RixorConvictionVault: ${TESTNET.explorer}/address/${vaultAddress} (block ${receipt.blockNumber})`)
console.log('Frontend env (Vercel or .env):')
console.log(`  VITE_RIXOR_VAULT_ADDRESS=${vaultAddress}`)
console.log(`  VITE_RIXOR_VAULT_FROM_BLOCK=${receipt.blockNumber}`)
console.log(`  VITE_RIXOR_VAULT_MOCK_ORACLE=${process.env.RIXOR_VAULT_ORACLE ? 'false' : 'true'}`)
