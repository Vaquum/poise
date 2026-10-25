// The backstop for a bare `npx playwright test`: the workspace browser lock
// for runs that did not come through scripts/with-e2e-lock.mjs (which holds
// it from before the webServer build). A run under the wrapper carries
// POISE_E2E_LOCK_ID naming the held lock, and leaves releasing to the
// wrapper. CI shards run concurrently by design and skip the lock, as does
// --list, which starts no browsers.
import { acquireE2ERunLock, currentE2ELockHolder, releaseE2ERunLock } from '../fixtures/e2e-run-lock.mjs'

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.CI || process.argv.includes('--list')) return undefined
  const adopted = process.env.POISE_E2E_LOCK_ID
  if (adopted && currentE2ELockHolder()?.token === adopted) return async () => {}
  const lock = await acquireE2ERunLock({
    onWait: (holderPid) => console.error(`Waiting for the workspace browser lock (held by pid ${holderPid})…`),
  })
  return async () => {
    releaseE2ERunLock(lock)
  }
}
