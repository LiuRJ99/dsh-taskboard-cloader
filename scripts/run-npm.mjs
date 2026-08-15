// Run npm-cli.js with stdio inherit (sandbox-safe spawn form).
// Usage: node .run-npm.mjs <npm args...>
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const exe = process.execPath
// npm ships inside the node installation
const candidates = [
  `${exe.replace(/node\.exe$/, '')}node_modules/npm/bin/npm-cli.js`,
]

let cli = candidates.find(p => existsSync(p))
if (!cli) {
  // mise layout: node.exe sits directly in the version dir
  const { dirname, join } = await import('node:path')
  const dir = dirname(exe)
  cli = [join(dir, 'node_modules/npm/bin/npm-cli.js'), join(dir, '../lib/node_modules/npm/bin/npm-cli.js')].find(p => existsSync(p))
}
if (!cli) {
  console.error('npm-cli.js not found near', exe)
  process.exit(1)
}

const child = spawn(exe, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
