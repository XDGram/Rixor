#!/usr/bin/env node
// Runs the pinned Foundry `forge` binary (from the @foundry-rs npm packages) and PROPAGATES ITS EXIT CODE.
//
// The upstream wrapper (node_modules/@foundry-rs/forge/bin.mjs, 1.7.1) spawns the binary but never waits for its
// exit status, so it always exits 0: failing tests or a reverting script would look like success to npm and CI.
// Every npm script in this repository uses this wrapper instead.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch
const os = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[process.platform] ?? process.platform
const bin = join(ROOT, 'node_modules', '@foundry-rs', `forge-${os}-${arch}`, 'bin', process.platform === 'win32' ? 'forge.exe' : 'forge')
if (!existsSync(bin)) {
  console.error(`forge binary not found at ${bin}. Run npm install (the @foundry-rs packages are pinned in package.json).`)
  process.exit(1)
}
const r = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' })
if (r.error) { console.error(r.error.message); process.exit(1) }
process.exit(r.status ?? (r.signal ? 1 : 0))
