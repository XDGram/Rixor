// Rixor token list: metadata only. It never grants support.
//
// A token is shown as "Supported" only when the Locker the app is connected to reports it as listed with
// locks enabled (an on-chain read). Everything here is display information and the watchlist that wallet
// detection checks balances for. No production Locker is deployed, so on Robinhood Chain mainnet no token is
// supported yet; inside the browser simulation, the simulation's own Locker lists HOOKR and TORCH for testing.
//
// Statuses below come from the vetting reports (scripts/vet-token.mjs plus manual source review, Nov 2026).

export type ListStatus = 'under_review' | 'unsupported' | 'reward'

export type ListedToken = {
  address: string
  symbol: string
  name: string
  decimals: number
  status: ListStatus
  /** Proposed risk class if it were listed (A: all tiers, B: no Diamond). Not an approval. */
  proposedClass?: 'A' | 'B'
  /** Short, plain reason shown next to the token. */
  note: string
  /** Disclosures a holder should see before locking (market-level facts, not Locker behaviour). */
  disclosures?: string[]
}

export const ROBINHOOD_CHAIN = {
  chainId: 4663,
  hexChainId: '0x1237',
  name: 'Robinhood Chain',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
}

export const TOKEN_LIST: ListedToken[] = [
  {
    address: '0x5173b8eA6923c2d40267890D45C46a3480954773', symbol: 'WIF', name: 'WIF', decimals: 18, status: 'reward',
    note: 'Reward and prize token. Not needed to lock, and not lockable itself.',
  },
  {
    address: '0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c', symbol: 'HOOKR', name: 'Hookr.fun', decimals: 18, status: 'under_review', proposedClass: 'A',
    note: 'Class A candidate. Testing only; not approved for listing.',
    disclosures: ['Token code: Uniswap UERC20 (Solady). Like every Solady token, it pre-approves Permit2 for all holders; only sign Permit2 messages you trust.'],
  },
  {
    address: '0x000050E18ffa3F8F7aD170Eb9CeF160eb3Ed1111', symbol: 'TORCH', name: 'Torch', decimals: 18, status: 'under_review', proposedClass: 'B',
    note: 'Class B candidate (no Diamond). Testing only; not approved for listing.',
    disclosures: ['Buying TORCH from a pool costs a fixed 2% buy tax. Locking and exiting in Rixor are not taxed.'],
  },
  {
    address: '0x51250B135174Ca09450EC01c4afF73CF69DBb590', symbol: 'NOVAAI', name: 'NovaAI', decimals: 18, status: 'under_review',
    note: 'Awaiting formal source verification.',
  },
  {
    address: '0xf9e990CCb47806AC9268922BD21Dc9a91C8e8899', symbol: 'DOPE', name: 'Doge Pepe', decimals: 18, status: 'under_review',
    note: 'Conditional: token age and launch-window holder pattern still under review.',
  },
  {
    address: '0x30de7AE4c9578D110a97367EDe9F7765Cdce06ea', symbol: 'PANGEA', name: 'Pangea', decimals: 18, status: 'under_review',
    note: 'Cross-chain token: mint paths need review.',
  },
  {
    address: '0xaCC8De336F5D2366FA7334383D8FaB73499F582A', symbol: 'FOREVER', name: 'Forever', decimals: 18, status: 'under_review',
    note: 'Too young to review yet.',
  },
  {
    address: '0xC60bA256B44334A0Cd2C7242E98B88f031abB006', symbol: 'V4', name: 'Programmable', decimals: 18, status: 'under_review',
    note: 'Holder clusters need review.',
  },
  {
    address: '0x255979302fD6a5E2Ff6dce0D8b018F51e06e243A', symbol: 'UNIWALL', name: 'Uniwall', decimals: 18, status: 'unsupported',
    note: 'Not compatible: transfers can be restricted.',
  },
  {
    address: '0x4db7374E966097be94C6680d49156D580F097Bbf', symbol: 'TIBBIR', name: 'Ribbita', decimals: 18, status: 'unsupported',
    note: 'Not compatible: charges a fee on transfers.',
  },
  {
    address: '0x0B7C6c138dc75622f4200d157B13FB93e6BD94FA', symbol: 'MOW', name: 'MowCat', decimals: 18, status: 'unsupported',
    note: 'Not supported: highly concentrated funding clusters.',
  },
  {
    address: '0x67c51C928d5D8383f3A58FC591A4E6f6463949ed', symbol: 'AnsemCat', name: 'Ansem Cat', decimals: 18, status: 'unsupported',
    note: 'Not supported: highly concentrated holders.',
  },
]

export const listEntry = (address: string) => TOKEN_LIST.find((t) => t.address.toLowerCase() === address.toLowerCase())
