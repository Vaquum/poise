// Runs its child under the workspace browser lock: `npm run test:e2e` goes
// through here so the webServer build, which starts before any Playwright
// setup runs, is serialized with every other local browser run. CI shards
// run concurrently by design and skip the lock. The child inherits
// POISE_E2E_LOCK_ID, which tells the Playwright setup the lock is already
// held for this run; the name carries no credential that
// removeCredentialVariables strips from the runner's environment.
import { spawn } from 'node:child_process'
import { acquireE2ERunLock, releaseE2ERunLock } from '../tests/fixtures/e2e-run-lock.mjs'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/with-e2e-lock.mjs <command> [args...]')
  process.exit(2)
}

const lock = process.env.CI
  ? null
  : await acquireE2ERunLock({
    onWait: (holderPid) => console.error(`Waiting for the workspace browser lock (held by pid ${holderPid})…`),
  })
const child = spawn(command, args, {
  stdio: 'inherit',
  env: { ...process.env, ...(lock ? { POISE_E2E_LOCK_ID: lock.token } : {}) },
})
const forwarders = new Map()
for (const signal of ['SIGINT', 'SIGTERM']) {
  const forward = () => {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
  forwarders.set(signal, forward)
  process.on(signal, forward)
}
const result = await new Promise((resolve) => {
  child.on('error', () => resolve({ code: 1, signal: null }))
  child.on('exit', (exitCode, signal) => resolve({ code: exitCode ?? 1, signal }))
})
if (lock) releaseE2ERunLock(lock)
if (result.signal) {
  for (const [name, forward] of forwarders) process.removeListener(name, forward)
  try {
    process.kill(process.pid, result.signal)
  } catch {
    /* fall through */
  }
  process.exit(1)
} else {
  process.exit(result.code)
}
