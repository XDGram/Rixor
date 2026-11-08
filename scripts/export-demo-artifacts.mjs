#!/usr/bin/env node
// Copies the ABI and creation bytecode of the V2 contracts from Foundry's `out/` into
//   src/protocol/abi/              (ABI only, used by the frontend)
//   src/protocol/sim/artifacts/    (creation bytecode, deployed by the in-browser EVM)
// Run after `npm run forge -- build`. The files are generated; never edit them by hand.
// (demo/fork-backend is the superseded Gate 1 Docker backend; it keeps its Gate 1 artifacts and is not updated.)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contracts = ['RixorLocker', 'RixorChallenges', 'RixorRewards']
const frontendDir = join(ROOT, 'src', 'protocol', 'abi')
const simDir = join(ROOT, 'src', 'protocol', 'sim', 'artifacts')
mkdirSync(frontendDir, { recursive: true })
mkdirSync(simDir, { recursive: true })

for (const name of contracts) {
  const built = JSON.parse(readFileSync(join(ROOT, 'out', `${name}.sol`, `${name}.json`), 'utf8'))
  writeFileSync(join(frontendDir, `${name}.json`), JSON.stringify(built.abi, null, 2) + '\n')
  // The in-browser EVM deploys the exact compiled creation bytecode.
  writeFileSync(join(simDir, `${name}.json`), JSON.stringify({ contractName: name, bytecode: built.bytecode.object }) + '\n')
  console.log(`exported ${name}`)
}
