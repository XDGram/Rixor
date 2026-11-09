import { BrowserProvider, Contract, Interface, NonceManager, Wallet, type Eip1193Provider, type JsonRpcApiProvider, type Signer } from 'ethers'
import lockerAbi from './abi/RixorLocker.json'
import challengesAbi from './abi/RixorChallenges.json'
import rewardsAbi from './abi/RixorRewards.json'
import type { Manifest } from './env'
import { MODE } from './envtext'
import { fmtDate } from './model'

export const ERC20_ABI = [
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]
export const LOCKER_ABI = lockerAbi
export const CHALLENGES_ABI = challengesAbi
export const REWARDS_ABI = rewardsAbi
export const lockerIface = new Interface(lockerAbi)
export const challengesIface = new Interface(challengesAbi)
export const rewardsIface = new Interface(rewardsAbi)

export type Contracts = { locker: Contract; challenges: Contract; rewards: Contract; wif: Contract; token: (address: string) => Contract }

export function contractsFor(manifest: Manifest, runner: JsonRpcApiProvider | Signer): Contracts {
  return {
    locker: new Contract(manifest.contracts.locker, LOCKER_ABI, runner),
    challenges: new Contract(manifest.contracts.challenges, CHALLENGES_ABI, runner),
    rewards: new Contract(manifest.contracts.rewards, REWARDS_ABI, runner),
    wif: new Contract(manifest.contracts.wif, ERC20_ABI, runner),
    // Approvals always go to the exact token being locked (never a fixed token).
    token: (address: string) => new Contract(address, ERC20_ABI, runner),
  }
}

// ------------------------------------------------------------------ wallets

export type WalletKind = 'demo' | 'browser'
export type ConnectedWallet = { kind: WalletKind; address: string; signer: Signer; resetNonce?: () => void }

/**
 * The visitor's demo wallet: a throwaway key generated on this device for the browser simulation only.
 * It signs for the simulation's chain id (not Robinhood Chain), holds only demo assets, and is never shown.
 */
export function demoWalletFrom(key: string, provider: JsonRpcApiProvider): ConnectedWallet {
  const wallet = new Wallet(key, provider)
  const signer = new NonceManager(wallet)
  return { kind: 'demo', address: wallet.address, signer, resetNonce: () => signer.reset() }
}

/**
 * The visitor's own browser wallet, for testnet mode. Bound to `chainId`: ethers refuses to send if the wallet is on
 * another network, so a transaction can never land on the wrong chain. The wallet does the signing and the gas
 * estimation (no gas limits are set anywhere in this app).
 */
export async function browserWalletFrom(eip1193: Eip1193Provider, address: string, chainId: number): Promise<ConnectedWallet> {
  const provider = new BrowserProvider(eip1193, chainId)
  const signer = await provider.getSigner(address)
  return { kind: 'browser', address: await signer.getAddress(), signer }
}

/** TEST tokens on testnet expose a public, rate-limited faucet. */
export const TEST_FAUCET_ABI = ['function faucet() returns (uint256)', 'function lastFaucet(address) view returns (uint256)']
/** RixorTestToken.FAUCET_COOLDOWN: one faucet claim per token per address per day. */
export const FAUCET_COOLDOWN = 86_400
const testTokenIface = new Interface(['error FaucetCooldown(uint256 availableAt)', 'error MainnetNotAllowed()'])

// ------------------------------------------------------------------ errors

const FRIENDLY: Record<string, string> = {
  IsPaused: 'The protocol is paused. New locks and challenge actions are on hold; exits still work.',
  EmergencyActive: 'Emergency mode is active. Only exits, refunds and settled claims are available.',
  InvalidAmount: 'That amount is outside the allowed range.',
  InvalidTier: 'Choose Flexible, Committed or Diamond.',
  InvalidTerm: 'That term is outside what this token allows (30 to 90 days for Class A, 30 to 60 days for Class B).',
  TierNotAllowed: 'Diamond is not available for this token (Class B: Flexible and Committed only).',
  NeedsSync: 'Rewards for this token need more catching up. Try again; nothing is lost.',
  NotReady: 'This stream has not finished yet, so its refund is not final.',
  TokenStopped: 'Rewards for this token have stopped (released or emergency).',
  InvalidDuration: 'Streams last 7 to 90 days.',
  TokenReleasedAlready: 'This token is already released.',
  InvalidRiskClass: 'Invalid risk class.',
  CapExceeded: 'This token has reached its total lock cap.',
  LocksNotEnabled: 'New locks are disabled for this token.',
  NotListed: 'This token is not supported by the Locker.',
  IncompatibleToken: 'The token transfer did not deliver the exact amount.',
  TransferFailed: 'The token transfer failed. Check your balance and approval.',
  NotPositionOwner: 'That position belongs to another wallet.',
  PositionClosed: 'That position is already closed.',
  StillLocked: 'Diamond positions cannot exit before the end of their term.',
  FeeTooHigh: 'The exit fee changed. Review it and try again.',
  InvalidParams: 'Some challenge settings are invalid.',
  InvalidToken: 'One of the chosen tokens cannot be used.',
  InvalidTiming: 'The join deadline, minimum hold or end time is invalid.',
  ChallengeNotFound: 'That challenge does not exist.',
  JoinClosed: 'The join window for this challenge has closed.',
  ChallengeEnded: 'This challenge has already ended.',
  TokenNotAllowed: 'That position\'s token is not allowed in this challenge (or it was released).',
  TierTooLow: 'This challenge needs a higher tier.',
  PositionEndsTooEarly: 'Your position\'s term ends before the challenge ends.',
  BelowMinimumUnits: 'That position is below this challenge\'s minimum size.',
  AlreadyJoined: 'This wallet has already joined this challenge.',
  LaneOccupied: 'That position is already committed to another running challenge of this kind.',
  ChallengeFull: 'This challenge is full.',
  NotEnded: 'This challenge has not ended yet.',
  Cancelled: 'This challenge was cancelled by an emergency. Sponsors can request refunds.',
  AlreadySettled: 'This challenge is already settled.',
  NotSettled: 'This challenge has not been settled yet.',
  NotSuccessful: 'This challenge did not succeed, so there are no rewards to claim.',
  NotQualified: 'This wallet did not qualify for a reward.',
  AlreadyClaimed: 'You have already claimed this reward.',
  ClaimWindowClosed: 'The 30-day claim window has closed.',
  ClaimWindowOpen: 'Unclaimed rewards return to sponsors only after the claim window closes.',
  NotRefundable: 'Refunds are only available for failed or cancelled challenges.',
  NothingToRefund: 'This wallet did not sponsor this challenge.',
  AlreadyRefunded: 'Your contribution was already refunded.',
  NothingToSweep: 'This wallet did not sponsor this challenge.',
  AlreadySwept: 'You already received your share of unclaimed rewards.',
  NotLockerOwner: 'Only the protocol Safe can create Season challenges.',
  Reentrancy: 'Unexpected re-entry was blocked.',
}

export function describeError(error: unknown): string {
  const e = error as { data?: string; info?: { error?: { data?: string } }; error?: { data?: string }; shortMessage?: string; message?: string; code?: string }
  if (e?.code === 'ACTION_REJECTED') return 'You rejected the request in your wallet.'
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try {
      const parsed = testTokenIface.parseError(data)
      if (parsed?.name === 'FaucetCooldown') return `This faucet allows one claim per day. It is available again at ${fmtDate(Number(parsed.args[0]))}.`
      if (parsed?.name === 'MainnetNotAllowed') return 'TEST tokens cannot be used on Robinhood Chain mainnet.'
    } catch { /* not a TEST token error */ }
    for (const iface of [challengesIface, lockerIface, rewardsIface]) {
      try {
        const parsed = iface.parseError(data)
        if (parsed) return FRIENDLY[parsed.name] ?? parsed.name
      } catch { /* try next */ }
    }
  }
  const msg = e?.shortMessage ?? e?.message ?? 'Something went wrong.'
  if (/insufficient funds/i.test(msg)) {
    return MODE === 'testnet'
      ? 'Your wallet does not have enough Robinhood Chain testnet ETH to pay for gas. Get some from the official faucet (faucet.testnet.chain.robinhood.com) and try again.'
      : 'This demo wallet cannot pay for that. Use "Get demo tokens".'
  }
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg
}
