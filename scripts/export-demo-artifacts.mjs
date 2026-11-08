#!/usr/bin/env node
// Copies the ABI and creation bytecode of the Gate 1 contracts from Foundry's `out/` into
//   demo/fork-backend/artifacts/   (deployed by the fork backend)
//   src/protocol/abi/              (ABI only, used by the frontend)
//   src/protocol/sim/artifacts/    (creation bytecode, deployed by the in-browser EVM)
// Run after `npm run forge -- build`. The files are generated; never edit them by hand.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contracts = ['RixorLocker', 'RixorChallenges']
const backendDir = join(ROOT, 'demo', 'fork-backend', 'artifacts')
const frontendDir = join(ROOT, 'src', 'protocol', 'abi')
const simDir = join(ROOT, 'src', 'protocol', 'sim', 'artifacts')
mkdirSync(backendDir, { recursive: true })
mkdirSync(frontendDir, { recursive: true })
mkdirSync(simDir, { recursive: true })

for (const name of contracts) {
  const built = JSON.parse(readFileSync(join(ROOT, 'out', `${name}.sol`, `${name}.json`), 'utf8'))
  const artifact = { contractName: name, abi: built.abi, bytecode: built.bytecode.object, compiler: 'solc 0.8.30, shanghai, 200 runs' }
  writeFileSync(join(backendDir, `${name}.json`), JSON.stringify(artifact, null, 2) + '\n')
  writeFileSync(join(frontendDir, `${name}.json`), JSON.stringify(built.abi, null, 2) + '\n')
  // The in-browser EVM deploys the exact compiled creation bytecode.
  writeFileSync(join(simDir, `${name}.json`), JSON.stringify({ contractName: name, bytecode: built.bytecode.object }) + '\n')
  console.log(`exported ${name}`)
}
