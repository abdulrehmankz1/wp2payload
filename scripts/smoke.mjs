// Smoke test for the built CLI: asserts output, not just exit codes (AC-01, AC-02).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const failures = []
const printed = run('--version').trim()
if (printed !== version) failures.push(`--version printed "${printed}", expected "${version}"`)
if (!/^\s+doctor\b/m.test(run('--help'))) failures.push('--help does not list the doctor command')

if (failures.length) {
  for (const f of failures) console.error(`✖ ${f}`)
  process.exit(1)
}
console.log(`✔ smoke: version ${version}, help lists doctor`)
