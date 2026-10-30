// Audits the dependencies for CI's static job and tells a transport failure
// (the npm registry not answering) from a genuine finding, so retrying one
// is a re-run, not a code change. Either way the audit fails: untested or
// vulnerable dependencies never pass.
import { spawnSync } from 'node:child_process'

const human = spawnSync('npm', ['audit', '--audit-level=high'], { stdio: 'inherit' })
if (human.error) {
  console.error(`::error title=npm audit inconclusive::npm did not run: ${human.error.message}`)
  process.exit(1)
}
if (human.status === 0) process.exit(0)

const probe = spawnSync('npm', ['audit', '--audit-level=high', '--json'],
  { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
if (probe.error) {
  console.error(`::error title=npm audit inconclusive::npm did not run: ${probe.error.message}`)
  process.exit(1)
}
let report
try {
  report = JSON.parse(probe.stdout)
} catch {
  console.error('::error title=npm audit inconclusive::the audit failed and its report did not parse; see the output above')
  process.exit(1)
}
const vulnerabilities = report?.metadata?.vulnerabilities
if (report && typeof report === 'object' && vulnerabilities && typeof vulnerabilities === 'object') {
  const found = ['critical', 'high'].map((level) => `${vulnerabilities[level] ?? 0} ${level}`).join(', ')
  console.error(`::error title=npm audit found advisories::${found}; see the output above`)
  process.exit(1)
}
const problem = report?.error
if (report && typeof report === 'object' && problem && typeof problem === 'object') {
  const detail = [problem.code, problem.summary, problem.detail]
    .filter((part) => typeof part === 'string' && part).join(' — ') || 'the registry request failed'
  console.error(`::error title=npm audit service unavailable::${detail}. Re-run the failed jobs to retry.`)
  process.exit(1)
}
console.error('::error title=npm audit inconclusive::the audit failed without a report; see the output above')
process.exit(1)
