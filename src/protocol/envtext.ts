// Wording that depends on which environment the app is running against. Set once per mode by RixorApp.
// The protocol code, contracts and views are identical in every mode; only these words change.
export type Mode = 'simulation' | 'testnet' | 'mainnet'

const TEXT = {
  simulation: {
    where: 'in the browser simulation',
    whereShort: 'browser simulation',
    wallet: 'demo wallet',
    bal: 'demo',
    chain: 'demo chain',
    listingTitle: 'Simulation listing · candidate token',
    listingBody: (s: string) => `${s} is listed in this browser simulation's Locker for testing. No real ${s} is used.`,
    events: 'Read from RixorLocker, RixorRewards and RixorChallenges events emitted inside this browser simulation. These are not Robinhood Chain transactions.',
    params: 'provisional demo value',
  },
  testnet: {
    where: 'on Robinhood Chain testnet',
    whereShort: 'Robinhood Chain testnet',
    wallet: 'wallet',
    bal: 'TEST',
    chain: 'testnet',
    listingTitle: 'Testnet listing · TEST token',
    listingBody: (s: string) => `${s} is a valueless TEST token listed in the testnet Locker for the demo. It represents no real asset.`,
    events: 'Read from RixorLocker, RixorRewards and RixorChallenges events on Robinhood Chain testnet.',
    params: 'testnet value',
  },
  mainnet: {
    where: 'on Robinhood Chain mainnet',
    whereShort: 'Robinhood Chain mainnet',
    wallet: 'wallet',
    bal: 'real',
    chain: 'mainnet',
    listingTitle: 'Mainnet listing · real token',
    listingBody: (s: string) => `${s} is listed in the Rixor Locker on Robinhood Chain mainnet. Locking moves your real ${s}; rewards are paid in the official WIF. The contracts are tested but not audited.`,
    events: 'Read from RixorLocker, RixorRewards and RixorChallenges events on Robinhood Chain mainnet.',
    params: 'mainnet value',
  },
}

export let ENV = TEXT.simulation
export let MODE: Mode = 'simulation'
export function setMode(mode: Mode) {
  MODE = mode
  ENV = TEXT[mode]
}
