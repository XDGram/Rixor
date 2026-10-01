import fs from 'node:fs'
import path from 'node:path'
import solc from 'solc'

const root = process.cwd()
const sourcePath = path.join(root, 'contracts', 'RixorSavings.sol')
const source = fs.readFileSync(sourcePath, 'utf8')

const input = {
  language: 'Solidity',
  sources: {
    'RixorSavings.sol': { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
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

const contract = output.contracts['RixorSavings.sol'].RixorSavings
const artifactsDir = path.join(root, 'artifacts')
fs.mkdirSync(artifactsDir, { recursive: true })

const artifact = {
  contractName: 'RixorSavings',
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
}

fs.writeFileSync(
  path.join(artifactsDir, 'RixorSavings.json'),
  JSON.stringify(artifact, null, 2),
)

console.log('Compiled RixorSavings -> artifacts/RixorSavings.json')
