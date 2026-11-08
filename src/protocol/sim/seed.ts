// First-visit setup of the isolated demo chain. Every step is a real transaction executed by the
// in-browser EVM against the mainnet snapshot; nothing is precomputed or mocked.
import { Contract, ContractFactory, Interface, Wallet, getAddress, parseUnits, type Log, type LogDescription, type Provider } from 'ethers'
import lockerAbi from '../abi/RixorLocker.json'
import challengesAbi from '../abi/RixorChallenges.json'
import rewardsAbi from '../abi/RixorRewards.json'
import lockerArtifact from './artifacts/RixorLocker.json'
import challengesArtifact from './artifacts/RixorChallenges.json'
import rewardsArtifact from './artifacts/RixorRewards.json'
import type { Snapshot, SimChain } from './engine'

export const DEMO_PARAMS = {
  // Provisional demo values. Not approved production parameters.
  memeUnit: '10000',
  memeCap: '50000000',
  minHoldSeconds: 3600,
  faucetWif: '1000000',
  faucetMeme: '500000',
}

/** Candidate tokens listed in the SIMULATION's Locker for testing. Not approved for production listing. */
export const SIM_LISTINGS = [
  { symbol: 'HOOKR', riskClass: 1 },
  { symbol: 'TORCH', riskClass: 2 },
] as const

const ERC20 = new Interface([
  'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])
const SAFE = new Interface([
  'function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)',
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)',
  'function nonce() view returns (uint256)', 'function getThreshold() view returns (uint256)', 'function VERSION() view returns (string)',
])
const ZERO = '0x0000000000000000000000000000000000000000'
const DAY = 86400

/** Moves copied tokens from a large mainnet holder inside the isolated chain (anvil-style impersonation). */
export async function faucetTransfer(chain: SimChain, provider: Provider, snapshot: Snapshot, to: string, whole: string, symbol = 'WIF') {
  const meme = symbol === 'WIF' ? null : snapshot.memeTokens?.[symbol]
  if (symbol !== 'WIF' && !meme) throw new Error(`${symbol} is not in this snapshot.`)
  const tokenAddr = meme ? meme.address : snapshot.contracts.WIF
  const reserves = meme ? meme.reserves : snapshot.reserves
  const amount = parseUnits(whole, 18)
  const token = new Contract(tokenAddr, ERC20, provider)
  for (const reserve of reserves) {
    const bal = (await token.balanceOf(reserve)) as bigint
    if (bal >= amount) {
      await chain.apply({ k: 'imp', from: reserve, to: tokenAddr, data: ERC20.encodeFunctionData('transfer', [to, amount]), ts: chain.now(), label: `Demo faucet (${symbol})` })
      return amount
    }
  }
  throw new Error(`The demo ${symbol} faucet reserve is exhausted. Reset the demo to start over.`)
}

async function deploySafe(provider: Provider, deployer: Wallet, snapshot: Snapshot, owners: string[], salt: number) {
  const init = SAFE.encodeFunctionData('setup', [owners, 2, ZERO, '0x', snapshot.contracts.fallbackHandler, ZERO, 0, ZERO])
  const factory = new Contract(snapshot.contracts.factory, SAFE, deployer)
  const proxy = (await factory.createProxyWithNonce.staticCall(snapshot.contracts.singletonL2, init, salt)) as string
  await (await factory.createProxyWithNonce(snapshot.contracts.singletonL2, init, salt)).wait()
  const safe = new Contract(proxy, SAFE, provider)
  if (Number(await safe.getThreshold()) !== 2) throw new Error('Safe setup failed')
  return { address: getAddress(proxy), version: (await safe.VERSION()) as string }
}

async function safeExec(relayer: Wallet, safeAddress: string, signers: Wallet[], to: string, data: string) {
  const safe = new Contract(safeAddress, SAFE, relayer)
  const hash = (await safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, ZERO, ZERO, await safe.nonce())) as string
  const sigs = '0x' + signers.slice(0, 2).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
    .map((w) => { const s = w.signingKey.sign(hash); return s.r.slice(2) + s.s.slice(2) + s.v.toString(16).padStart(2, '0') }).join('')
  await (await safe.execTransaction(to, 0, data, 0, 0, 0, 0, ZERO, ZERO, sigs)).wait()
}

export type SeedResult = {
  contracts: { locker: string; challenges: string; rewards: string; wif: string; ownerSafe: string; guardianSafe: string }
  tokens: { address: string; symbol: string; name: string; riskClass: number }[]
  safeVersion: string
  sponsorBot: string
  lockerBots: string[]
  seeds: number[]
}

/** Deploys the V2 contracts with two 2-of-3 Safes, funds WIF streams and creates labelled demo activity. */
export async function seedChain(chain: SimChain, provider: Provider, snapshot: Snapshot, onStep?: (label: string) => void): Promise<SeedResult> {
  // Throwaway keys used only to sign the setup transactions below; they are not stored anywhere.
  const fresh = () => Wallet.createRandom().connect(provider) as unknown as Wallet
  const deployer = fresh()
  const ownerSigners = [fresh(), fresh(), fresh()]
  const guardianSigners = [fresh(), fresh(), fresh()]
  const sponsor = fresh()
  const bots = [fresh(), fresh(), fresh()]
  const wifAddr = snapshot.contracts.WIF
  const memes = SIM_LISTINGS.map((l) => {
    const m = snapshot.memeTokens?.[l.symbol]
    if (!m) throw new Error(`Snapshot is missing ${l.symbol}`)
    return { address: getAddress(m.address), symbol: l.symbol, name: m.name, riskClass: l.riskClass }
  })
  const [hookr, torch] = memes

  onStep?.('Creating the demo Safes (Safe v1.5.0)')
  const ownerSafe = await deploySafe(provider, deployer, snapshot, ownerSigners.map((w) => w.address), 1)
  const guardianSafe = await deploySafe(provider, deployer, snapshot, guardianSigners.map((w) => w.address), 2)

  onStep?.('Deploying RixorLocker, RixorRewards and RixorChallenges')
  const unit = parseUnits(DEMO_PARAMS.memeUnit, 18)
  const cap = parseUnits(DEMO_PARAMS.memeCap, 18)
  const listings = memes.map((m) => ({ token: m.address, unitAmount: unit, maxTotalLocked: cap, riskClass: m.riskClass }))
  const locker = await new ContractFactory(lockerAbi, lockerArtifact.bytecode, deployer).deploy(ownerSafe.address, guardianSafe.address, listings)
  await locker.waitForDeployment()
  const lockerAddr = await locker.getAddress()
  const rewards = await new ContractFactory(rewardsAbi, rewardsArtifact.bytecode, deployer).deploy(lockerAddr, wifAddr)
  await rewards.waitForDeployment()
  const rewardsAddr = await rewards.getAddress()
  const challenges = await new ContractFactory(challengesAbi, challengesArtifact.bytecode, deployer).deploy(lockerAddr, wifAddr, DEMO_PARAMS.minHoldSeconds)
  await challenges.waitForDeployment()
  const challengesAddr = await challenges.getAddress()

  onStep?.('Funding demo WIF reward streams')
  await faucetTransfer(chain, provider, snapshot, sponsor.address, '1500000')
  await faucetTransfer(chain, provider, snapshot, ownerSafe.address, '600000')
  const wif = (w: Wallet) => new Contract(wifAddr, ERC20, w)
  const rw = new Contract(rewardsAddr, rewardsAbi, sponsor)
  await (await wif(sponsor).approve(rewardsAddr, parseUnits('210000', 18))).wait()
  await (await rw.fund(hookr.address, parseUnits('140000', 18), 14)).wait()
  await (await rw.fund(torch.address, parseUnits('70000', 18), 14)).wait()

  onStep?.('Creating demo seed challenges')
  for (const b of bots) {
    await faucetTransfer(chain, provider, snapshot, b.address, '400000', 'HOOKR')
    await faucetTransfer(chain, provider, snapshot, b.address, '400000', 'TORCH')
  }
  const now = chain.now()
  const params = (title: string, description: string, joinIn: number, endIn: number, minTier: number, minUnits: number) => ({
    tokens: [hookr.address, torch.address], minTier, minUnitsPerEntry: minUnits, joinDeadline: now + joinIn, endTime: now + endIn,
    goalPoints: 0n, maxParticipants: 200, title, description,
  })
  const ch = (w: Wallet) => new Contract(challengesAddr, challengesAbi, w)
  await (await wif(sponsor).approve(challengesAddr, parseUnits('250000', 18))).wait()
  await (await ch(sponsor).createChallenge(params(
    'Hold the line (demo seed)',
    'Demo challenge created when this simulation started. Lock HOOKR or TORCH and keep the position open until the end to share the pool.',
    2 * DAY, 5 * DAY, 0, 1,
  ), parseUnits('250000', 18))).wait()
  const seasonPool = parseUnits('500000', 18)
  await safeExec(deployer, ownerSafe.address, ownerSigners, wifAddr, ERC20.encodeFunctionData('approve', [challengesAddr, seasonPool]))
  await safeExec(deployer, ownerSafe.address, ownerSigners, challengesAddr, new Interface(challengesAbi).encodeFunctionData('createSeason', [
    params('Season preview (demo seed)', 'Demo Season challenge funded by the demo owner Safe through a 2-of-3 Safe transaction. Committed or Diamond positions only. Not an approved Season budget.', 2 * DAY, 7 * DAY, 1, 2),
    seasonPool,
  ]))

  onStep?.('Demo lockers joining')
  const plan = [
    { token: hookr, amount: '300000', tier: 2, days: 90, season: true },
    { token: torch, amount: '200000', tier: 1, days: 60, season: true },
    { token: hookr, amount: '100000', tier: 0, days: 0, season: false },
  ]
  const lockerIface = new Interface(lockerAbi)
  for (let i = 0; i < bots.length; i++) {
    const p = plan[i]
    const amt = parseUnits(p.amount, 18)
    await (await new Contract(p.token.address, ERC20, bots[i]).approve(lockerAddr, amt)).wait()
    const rc = await (await new Contract(lockerAddr, lockerAbi, bots[i]).lock(p.token.address, amt, p.tier, p.days)).wait()
    const ev = rc!.logs.map((l: Log) => { try { return lockerIface.parseLog(l) } catch { return null } }).find((e: LogDescription | null) => e?.name === 'Locked')
    const positionId = ev!.args.positionId as bigint
    await (await ch(bots[i]).join(1, positionId, ZERO)).wait()
    if (p.season) await (await ch(bots[i]).join(2, positionId, ZERO)).wait()
  }

  return {
    contracts: { locker: lockerAddr, challenges: challengesAddr, rewards: rewardsAddr, wif: wifAddr, ownerSafe: ownerSafe.address, guardianSafe: guardianSafe.address },
    tokens: memes,
    safeVersion: ownerSafe.version,
    sponsorBot: sponsor.address,
    lockerBots: bots.map((b) => b.address),
    seeds: [1, 2],
  }
}
