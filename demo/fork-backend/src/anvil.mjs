import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { JsonRpcProvider } from 'ethers'

const require = createRequire(import.meta.url)

export function anvilBin() {
  if (process.env.ANVIL_BIN) return { cmd: process.env.ANVIL_BIN, pre: [] }
  // The npm package ships a launcher script that runs the platform binary.
  const pkg = require.resolve('@foundry-rs/anvil/package.json')
  return { cmd: process.execPath, pre: [join(dirname(pkg), 'bin.mjs')] }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Starts anvil bound to localhost only. Resolves once its RPC answers. */
export async function startAnvil(args, { port, chainId, log }) {
  const { cmd, pre } = anvilBin()
  const child = spawn(cmd, [...pre, '--host', '127.0.0.1', '--port', String(port), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  child.stdout.on('data', (d) => log?.(`[anvil] ${String(d).trim()}`))
  child.stderr.on('data', (d) => log?.(`[anvil:err] ${String(d).trim()}`))
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, chainId, { batchMaxCount: 1, polling: false, staticNetwork: chainId !== undefined })
  let exited = null
  child.on('exit', (code) => { exited = code })
  for (let i = 0; i < 120; i++) {
    if (exited !== null) throw new Error(`anvil exited with code ${exited}`)
    try {
      await provider.send('eth_chainId', [])
      return { child, provider, url: `http://127.0.0.1:${port}` }
    } catch {
      await sleep(500)
    }
  }
  child.kill('SIGKILL')
  throw new Error('anvil did not start')
}

export async function stopAnvil(child) {
  if (!child || child.exitCode !== null) return
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill('SIGTERM') // anvil dumps --state on graceful shutdown
    setTimeout(() => { child.kill('SIGKILL'); resolve() }, 15000)
  })
}
