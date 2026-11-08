// Rixor fork-demo backend entry point.
//
// First boot (empty STATE_DIR): build a genesis from a private local fork of Robinhood Chain mainnet, start a
// standalone demo chain from it, deploy and seed. Later boots: resume the same chain from STATE_DIR.
// The demo chain id differs from Robinhood Chain mainnet, so nothing signed here is valid on a real network.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Wallet } from './deps.mjs'
import { config } from './config.mjs'
import { startAnvil, stopAnvil } from './anvil.mjs'
import { buildGenesis } from './genesis.mjs'
import { deployAndSeed, generateKeys } from './seed.mjs'
import { createApi } from './server.mjs'

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`)

async function main() {
  mkdirSync(config.stateDir, { recursive: true })
  const statePath = join(config.stateDir, 'chain-state.json')
  const keysPath = join(config.stateDir, 'keys.json')
  const manifestPath = join(config.stateDir, 'manifest.json')
  const firstBoot = !existsSync(manifestPath)

  let keys
  if (firstBoot) {
    keys = generateKeys()
    writeFileSync(keysPath, JSON.stringify(keys, null, 2))
    chmodSync(keysPath, 0o600)
    const { genesis, forkBlock, forkTimestamp } = await buildGenesis({
      upstreamRpc: config.upstreamRpc,
      upstreamChainId: config.upstreamChainId,
      chainId: config.chainId,
      anvilPort: config.anvilPort,
      faucetAddress: new Wallet(keys.faucet).address,
      reserveWif: config.demo.faucetReserve,
      log,
    })
    writeFileSync(statePath, JSON.stringify(genesis))
    writeFileSync(join(config.stateDir, 'fork-origin.json'), JSON.stringify({ forkBlock, forkTimestamp }, null, 2))
  } else {
    keys = JSON.parse(readFileSync(keysPath, 'utf8'))
  }

  // The demo chain: standalone (no upstream), persisted to STATE_DIR every 10 s and on shutdown.
  const anvil = await startAnvil(
    ['--state', statePath, '--state-interval', '10', '--chain-id', String(config.chainId), '--balance', '0', '--silent'],
    { port: config.anvilPort, chainId: config.chainId, log },
  )

  // Anvil's clock restarts at wall-clock time. If demo time was advanced before a restart, continue from the
  // last block's timestamp so chain time never moves backwards.
  const last = await anvil.provider.send('eth_getBlockByNumber', ['latest', false])
  const lastTs = Number(last.timestamp)
  const clock = { offset: 0 }
  if (lastTs >= Math.floor(Date.now() / 1000)) {
    await anvil.provider.send('anvil_setTime', [lastTs + 1])
    clock.offset = lastTs + 1 - Math.floor(Date.now() / 1000)
    log(`clock: resumed demo time at ${lastTs + 1}`)
  }

  let manifest
  if (firstBoot) {
    const origin = JSON.parse(readFileSync(join(config.stateDir, 'fork-origin.json'), 'utf8'))
    const seeded = await deployAndSeed({ provider: anvil.provider, keys, demo: config.demo, log })
    manifest = {
      environment: 'fork-demo',
      label: 'Rixor fork demo: a private copy of Robinhood Chain mainnet state. Not mainnet. Assets here have no value.',
      chainId: config.chainId,
      upstream: { name: 'Robinhood Chain mainnet', chainId: config.upstreamChainId, forkBlock: origin.forkBlock, forkTimestamp: origin.forkTimestamp },
      startBlock: 0,
      contracts: seeded.contracts,
      safes: seeded.safes,
      tokens: [{ address: seeded.contracts.wif, symbol: 'WIF', name: 'World is Flat', decimals: 18, unit: seeded.params.unit, cap: seeded.params.cap, provisional: true }],
      params: { minHoldSeconds: seeded.params.minHoldSeconds, provisional: true, note: 'Demo parameters only. Production unit sizes, caps and budgets are not approved.' },
      demoAccounts: seeded.demoAccounts,
      seeds: seeded.seeds,
      features: { faucet: true, timeControl: config.timeControl, faucetWif: config.faucetWif, faucetEth: config.faucetEth, maxTimeAdvance: config.maxTimeAdvance },
      createdAt: new Date().toISOString(),
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    // Persist immediately so a crash right after seeding cannot lose the deployment.
    await anvil.provider.send('anvil_dumpState', []).then((raw) => raw).catch(() => null)
  } else {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  }

  const server = createApi({ config, anvilUrl: anvil.url, provider: anvil.provider, manifest, keys, clock, log })
  server.listen(config.port, '0.0.0.0', () => log(`Rixor fork-demo backend listening on :${config.port} (chain ${config.chainId})`))

  const shutdown = async (sig) => {
    log(`${sig}: saving chain state and stopping`)
    server.close()
    await stopAnvil(anvil.child)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  anvil.child.on('exit', (code) => { log(`anvil exited (${code}); exiting so the platform restarts the service`); process.exit(1) })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
