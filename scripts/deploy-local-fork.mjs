#!/usr/bin/env node
// LOCAL FORK DRY RUN of the V2 deployment. Nothing is sent to any real network.
//
//   npm run deploy:local-fork            (RH_MAINNET_RPC_URL overrides the public RPC used as the fork source)
//
// 1. Starts a throwaway anvil fork of Robinhood Chain mainnet with chain id 31337 (so the deploy script's
//    real-chain guards stay armed and LocalForkSafes refuses to run anywhere else).
// 2. Creates two throwaway 2-of-3 Safe v1.5.0 proxies on the fork (script/LocalForkSafes.s.sol).
// 3. Runs the real deployment script (script/DeployRixorV2.s.sol) with deploy/config/local-fork.json, then the
//    read-only verifier (script/VerifyRixorV2.s.sol).
// 4. Smoke journey on the fork with impersonated large holders: lock HOOKR and TORCH, fund a WIF stream, claim,
//    exit. No transaction sets a gas limit: every one uses the node's eth_estimateGas, including TORCH's first
//    exit out of the Locker, which needs ~81k gas remaining for TORCH's pool probe.
// Senders are anvil's unlocked default accounts; no private key is read or printed.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, JsonRpcProvider, parseEther, parseUnits, formatUnits } from 'ethers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = process.env.RH_MAINNET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const PORT = 8700 + Math.floor(Math.random() * 200)
const LOCAL = `http://127.0.0.1:${PORT}`
const FORGE = join(ROOT, 'scripts/forge.mjs') // propagates forge's exit code (the npm wrapper does not)
const ANVIL = join(ROOT, 'node_modules/@foundry-rs/anvil/bin.mjs')
const HOOKR = '0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c'
const TORCH = '0x000050E18ffa3F8F7aD170Eb9CeF160eb3Ed1111'
const WIF = '0x5173b8eA6923c2d40267890D45C46a3480954773'
const HOLDERS = { [HOOKR]: '0xA522e716e1750702F775416f2Aa3Df620D9A1831', [TORCH]: '0x9eAc2DD9A2cEE409575901f50C8B3e5Bd7eE1b2d', [WIF]: '0x1089a7C3915c9F067615909DBd07697C21c32156' }
const ERC20 = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function forge(args, env = {}) {
  const r = spawnSync(process.execPath, [FORGE, ...args], { cwd: ROOT, env: { ...process.env, RIXOR_EXPECTED_CHAIN_ID: '31337', ...env }, encoding: 'utf8' })
  if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error(`forge ${args[1]} failed`) }
  return r.stdout
}
const logged = (out, label) => out.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`))?.[1]

const anvil = spawn(process.execPath, [ANVIL, '--fork-url', UPSTREAM, '--chain-id', '31337', '--port', String(PORT), '--silent'], { stdio: 'ignore' })
const provider = new JsonRpcProvider(LOCAL, 31337, { staticNetwork: true, cacheTimeout: -1 })
try {
  for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break } catch { if (i > 60) throw new Error('anvil did not start'); await sleep(500) } }
  const [deployer] = await provider.send('eth_accounts', [])
  const unlocked = ['--rpc-url', LOCAL, '--broadcast', '--unlocked', '--sender', deployer, '--slow']
  rmSync(join(ROOT, 'deployments', '31337.json'), { force: true })
  mkdirSync(join(ROOT, 'deployments'), { recursive: true })

  const safesOut = forge(['script', 'script/LocalForkSafes.s.sol', ...unlocked])
  const ownerSafe = logged(safesOut, 'LOCAL owner Safe')
  const guardianSafe = logged(safesOut, 'LOCAL guardian Safe')
  check('local fork Safes created (2-of-3, Safe v1.5.0)', ownerSafe && guardianSafe, `${ownerSafe} / ${guardianSafe}`)

  const env = { RIXOR_CONFIG: 'deploy/config/local-fork.json', RIXOR_OWNER_SAFE: ownerSafe, RIXOR_GUARDIAN_SAFE: guardianSafe }
  const deployOut = forge(['script', 'script/DeployRixorV2.s.sol', ...unlocked], env)
  const manifest = JSON.parse(readFileSync(join(ROOT, 'deployments', '31337.json'), 'utf8'))
  check('DeployRixorV2 deployed Locker, Rewards, Challenges and wrote the manifest', manifest.locker && manifest.rewards && manifest.challenges && /RixorLocker\s+0x/.test(deployOut))

  const verifyOut = forge(['script', 'script/VerifyRixorV2.s.sol', '--rpc-url', LOCAL], { RIXOR_DEPLOYMENT: 'deployments/31337.json' })
  check('VerifyRixorV2: wiring, roles, code hash and listings', /verification passed/.test(verifyOut))

  // Guards: the deploy script must refuse an EOA owner, and refuse to list the reward token.
  const refuse = (extraEnv) => spawnSync(process.execPath, [FORGE, 'script', 'script/DeployRixorV2.s.sol', '--rpc-url', LOCAL], { cwd: ROOT, env: { ...process.env, RIXOR_EXPECTED_CHAIN_ID: '31337', ...env, ...extraEnv }, encoding: 'utf8' })
  // anvil's default account is EIP-7702-delegated on Robinhood mainnet (23 bytes of code): it must still be refused.
  check('guard: EIP-7702-delegated EOA owner rejected', refuse({ RIXOR_OWNER_SAFE: deployer }).status !== 0)
  check('guard: plain EOA owner rejected', refuse({ RIXOR_OWNER_SAFE: '0x00000000000000000000000000000000000Be111' }).status !== 0)
  check('guard: non-Safe contract owner rejected', refuse({ RIXOR_OWNER_SAFE: WIF }).status !== 0)
  check('guard: guardian sharing every owner signer rejected', refuse({ RIXOR_GUARDIAN_SAFE: logged(safesOut, 'LOCAL shared-signer Safe') }).status !== 0)
  check('guard: unsupported chain id refused', spawnSync(process.execPath, [FORGE, 'script', 'script/DeployRixorV2.s.sol', '--rpc-url', UPSTREAM], { cwd: ROOT, env: { ...process.env, RIXOR_EXPECTED_CHAIN_ID: '4663', ...env }, encoding: 'utf8' }).status !== 0, 'mainnet without the written-authorisation sentence')
  check('guard: chain pin mismatch refused', refuse({ RIXOR_EXPECTED_CHAIN_ID: '46630' }).status !== 0, 'local RPC with RIXOR_EXPECTED_CHAIN_ID=46630')

  // ------------------------------------------------------------------ smoke journey (impersonated holders)
  const lockerAbi = JSON.parse(readFileSync(join(ROOT, 'src/protocol/abi/RixorLocker.json'), 'utf8'))
  const rewardsAbi = JSON.parse(readFileSync(join(ROOT, 'src/protocol/abi/RixorRewards.json'), 'utf8'))
  const as = async (addr) => { await provider.send('anvil_impersonateAccount', [addr]); await provider.send('anvil_setBalance', [addr, '0x' + parseEther('1').toString(16)]); return provider.getSigner(addr) }
  const hookrHolder = await as(HOLDERS[HOOKR])
  const torchHolder = await as(HOLDERS[TORCH])
  const wifHolder = await as(HOLDERS[WIF])
  const unit = parseUnits('100000', 18)

  // No gasLimit anywhere below: ethers asks the node (eth_estimateGas) for every transaction.
  await (await new Contract(WIF, ERC20, wifHolder).approve(manifest.rewards, parseUnits('70000', 18))).wait()
  await (await new Contract(manifest.rewards, rewardsAbi, wifHolder).fund(HOOKR, parseUnits('70000', 18), 7)).wait()
  check('fund a 7-day HOOKR stream with real WIF bytecode', (await new Contract(manifest.rewards, rewardsAbi, provider).streamCount()) === 1n)

  await (await new Contract(HOOKR, ERC20, hookrHolder).approve(manifest.locker, unit)).wait()
  await (await new Contract(manifest.locker, lockerAbi, hookrHolder).lock(HOOKR, unit, 1, 60)).wait()
  await (await new Contract(TORCH, ERC20, torchHolder).approve(manifest.locker, unit)).wait()
  const torchBefore = await new Contract(TORCH, ERC20, provider).balanceOf(HOLDERS[TORCH])
  const rc = await (await new Contract(manifest.locker, lockerAbi, torchHolder).lock(TORCH, unit, 0, 0)).wait()
  check('lock HOOKR (Committed, Class B) and TORCH (Flexible) from holders, exact amounts', (await new Contract(TORCH, ERC20, provider).balanceOf(manifest.locker)) === unit && rc.status === 1)

  await provider.send('evm_increaseTime', [3 * 86400]); await provider.send('evm_mine', [])
  const torchLocker = new Contract(manifest.locker, lockerAbi, torchHolder)
  const torchId = (await torchLocker.positionsOf(HOLDERS[TORCH]))[0]
  const estimate = await torchLocker.exit.estimateGas(torchId, 0)
  const exitRc = await (await torchLocker.exit(torchId, 0)).wait()
  check('TORCH first exit with the node\'s gas estimate (no hard-coded limit)', exitRc.status === 1 && estimate >= 81_000n,
    `estimate ${estimate} gas, used ${exitRc.gasUsed}`)
  check('TORCH exit returns the exact principal (no buy tax on Locker transfers)', (await new Contract(TORCH, ERC20, provider).balanceOf(HOLDERS[TORCH])) === torchBefore)

  const hookrRewards = new Contract(manifest.rewards, rewardsAbi, hookrHolder)
  const hookrId = (await new Contract(manifest.locker, lockerAbi, provider).positionsOf(HOLDERS[HOOKR]))[0]
  const wifBefore = await new Contract(WIF, ERC20, provider).balanceOf(HOLDERS[HOOKR])
  await (await hookrRewards.claim([hookrId], 2000)).wait()
  const got = (await new Contract(WIF, ERC20, provider).balanceOf(HOLDERS[HOOKR])) - wifBefore
  check('claim WIF stream rewards for the HOOKR position', got > 0n, `${formatUnits(got, 18)} WIF`)
} catch (e) {
  check('dry run completed', false, e.message)
} finally {
  anvil.kill('SIGTERM')
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed (local fork only; nothing sent to any real network)`)
  process.exit(failed ? 1 : 0)
}
