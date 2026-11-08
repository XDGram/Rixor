import fs from 'node:fs'
import path from 'node:path'
import solc from 'solc'

const root = process.cwd()

// [source file, contract name, also copy the ABI artifact into the frontend?]
const targets = [
  ['RixorSavings.sol', 'RixorSavings', true],
  ['RixorConvictionVault.sol', 'RixorConvictionVault', true],
  ['testnet/RixorMockPriceOracle.sol', 'RixorMockPriceOracle', true],
  ['test/MockBurnableToken.sol', 'MockBurnableToken', false],
]

const sources = Object.fromEntries(
  [...new Set(targets.map(([file]) => file))].map((file) => [
    file,
    { content: fs.readFileSync(path.join(root, 'contracts', file), 'utf8') },
  ]),
)

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'shanghai',
    viaIR: true,
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
      },
    },
  },
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = output.errors ?? []
const fatal = errors.filter((item) => item.severity === 'error')

for (const item of errors) {
  console[item.severity === 'error' ? 'error' : 'warn'](item.formattedMessage)
}

if (fatal.length) process.exit(1)

const artifactsDir = path.join(root, 'artifacts')
const frontendArtifactDir = path.join(root, 'src', 'contracts')
fs.mkdirSync(artifactsDir, { recursive: true })
fs.mkdirSync(frontendArtifactDir, { recursive: true })

for (const [file, name, frontend] of targets) {
  const contract = output.contracts[file][name]
  const artifact = {
    contractName: name,
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  }
  const serialized = JSON.stringify(artifact, null, 2)
  fs.writeFileSync(path.join(artifactsDir, `${name}.json`), serialized)
  if (frontend) fs.writeFileSync(path.join(frontendArtifactDir, `${name}Artifact.json`), serialized)
  console.log(`Compiled ${name}${frontend ? ' (+ frontend artifact)' : ''}`)
}
