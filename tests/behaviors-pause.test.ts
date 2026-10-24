import { describe, expect, it } from 'vitest'
import { mocks, HEAD_SHA, arrangeCli, deferred, loadModules, restartModules } from './behaviors-runtime-fixture'

// A behavior paused until a time launches nothing new, while everything
// already launched runs on, the ledger keeps new work, and the saved
// on/off, claims, seen state and backoff are untouched.
const RESOLVE = '--resolve-nonblocking-conversations-if-ready'

function resolveCalls(): unknown[][] {
  return mocks.runFile.mock.calls.filter(([, args]: any[]) => args[0] === RESOLVE)
}

async function enableResolveUnblocking() {
  arrangeCli(false, false, {
    unresolvedConversationCount: 2,
    reviewerLatestState: 'APPROVED',
    reviewerLatestCommit: HEAD_SHA,
  })
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.behaviors.startBehaviorsRuntime()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_resolve_unblocking_enabled', '1')
  return loaded
}

async function enableReviewNewPrs() {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.behaviors.startBehaviorsRuntime()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
  loaded.database.setMeta('behavior_review_new_prs_enabled', '1')
  loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
  return loaded
}

describe('a behavior paused until a time', () => {
  it('holds a resolve whose pause arrives during preparation, then handles it on resume', async () => {
    const { behaviors } = await enableResolveUnblocking()
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(1)

    // The next sweep's pre-check batch gates: the pause lands while the
    // sweep is past its tick check but before its final admission.
    const base = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockReset()
    const reached = deferred<void>()
    const release = deferred<void>()
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: unknown) => {
      if (command === 'github-interface' && args[0] === '--review-activity-since') {
        reached.resolve()
        await release.promise
      }
      return (base as (...call: unknown[]) => unknown)(command, args, options)
    })
    const sweep = behaviors.runEnabledBehaviorsOnce()
    await reached.promise
    const pausing = behaviors.setPaused('resolve-unblocking', new Date(Date.now() + 60_000).toISOString(), 'person')
    release.resolve()
    await sweep
    await pausing
    expect(resolveCalls()).toEqual([])

    await behaviors.setPaused('resolve-unblocking', null, 'person')
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(1)
  })

  it('launches nothing while paused and keeps claims, seen state and backoff', async () => {
    const { behaviors, database } = await enableReviewNewPrs()
    const target = 'Vaquum/poise-test#17'
    const claimId = database.claimSeenOwned('review-new-prs', target)
    expect(claimId).toBeTruthy()
    const failure = JSON.stringify({ kind: 'operation', consecutiveFailures: 2,
      lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 60_000, error: 'boom' })
    database.setMeta('behavior_review_new_prs_failure:Vaquum/poise-test#17:check', failure)

    await behaviors.setPaused('review-new-prs', new Date(Date.now() + 60_000).toISOString(), 'api')
    expect(behaviors.isEnabled('review-new-prs')).toBe(true)
    expect(behaviors.isPaused('review-new-prs')).toBe(true)
    expect(behaviors.isRunnable('review-new-prs')).toBe(false)
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(database.hasSeen('review-new-prs', target)).toBe(true)
    expect(database.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(database.getMeta('behavior_review_new_prs_failure:Vaquum/poise-test#17:check')).toBe(failure)
    expect(behaviors.getPausedBy('review-new-prs')).toBe('api')
  })

  it('never turns on a behavior that was set off during the pause', async () => {
    const { behaviors } = await enableResolveUnblocking()
    await behaviors.setPaused('resolve-unblocking', new Date(Date.now() + 60_000).toISOString(), 'person')
    await behaviors.setEnabled('resolve-unblocking', false)
    const before = resolveCalls().length
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(before)

    await behaviors.setPaused('resolve-unblocking', null, 'person')
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(before)
    expect(behaviors.isEnabled('resolve-unblocking')).toBe(false)
    expect(behaviors.getPausedUntil('resolve-unblocking')).toBeNull()
  })

  it('treats a clear and an expiry at the boundary the same: the pause is gone', async () => {
    const { behaviors } = await enableResolveUnblocking()
    // Cleared just as it expires: the clear wins, the sweep launches.
    await behaviors.setPaused('resolve-unblocking', new Date(Date.now() + 50).toISOString(), 'person')
    await behaviors.setPaused('resolve-unblocking', null, 'person')
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(1)

    // Expired without a clear: the wall clock ends it, no write needed.
    const before = resolveCalls().length
    await behaviors.setPaused('resolve-unblocking', new Date(Date.now() + 30).toISOString(), 'person')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(behaviors.getPausedUntil('resolve-unblocking')).toBeNull()
    expect(behaviors.isPaused('resolve-unblocking')).toBe(false)
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(before + 1)
  })

  it('keeps the pause across a restart and launches once it expires', async () => {
    const loaded = await enableResolveUnblocking()
    await loaded.behaviors.setPaused('resolve-unblocking', new Date(Date.now() + 60_000).toISOString(), 'person')
    const restarted = await restartModules()
    restarted.behaviors.startBehaviorsRuntime()
    expect(restarted.behaviors.getPausedUntil('resolve-unblocking')).not.toBeNull()
    expect(restarted.behaviors.isEnabled('resolve-unblocking')).toBe(true)
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toEqual([])

    await restarted.behaviors.setPaused('resolve-unblocking', null, 'person')
    const resumed = await restartModules()
    resumed.behaviors.startBehaviorsRuntime()
    await resumed.behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(1)
  })
})
