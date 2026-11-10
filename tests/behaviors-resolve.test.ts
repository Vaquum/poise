import { describe, expect, it } from 'vitest'
import { mocks, HEAD_SHA, arrangeCli, loadModules, resetLogCache } from './behaviors-runtime-fixture'
import type { ReviewActivityFixture } from './behaviors-runtime-fixture'

const RESOLVE = '--resolve-nonblocking-conversations-if-ready'

function resolveCalls(): unknown[][] {
  return mocks.runFile.mock.calls.filter(([, args]: any[]) => args[0] === RESOLVE)
}

async function enableResolve(reviewActivity: ReviewActivityFixture = {}) {
  arrangeCli(false, false, {
    unresolvedConversationCount: 2,
    reviewerLatestState: 'APPROVED',
    reviewerLatestCommit: HEAD_SHA,
    ...reviewActivity,
  })
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.behaviors.startBehaviorsRuntime()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_resolve_unblocking_enabled', '1')
  return loaded
}

describe('resolve-unblocking run lineage', () => {
  it('resolves an independent PR within one second while issue history is unavailable, retaining its original worker', async () => {
    const { behaviors, database } = await enableResolve({ resolveResolvedCount: 2 })
    const target = 'Vaquum/poise-test#500'
    const claimId = database.claimSeenOwned('review-new-issues', target)!
    expect(database.markBehaviorLaunchIntentOwned({ key: 'review-new-issues', target, claimId,
      launchBehavior: 'issue_review', repo: 'Vaquum/poise-test', pr: 500, requestedAt: new Date().toISOString(),
      expectedHead: '', actor: 'review-bot', source: 'poise:review-new-issues', correlationId: claimId })).toBe(true)
    database.setMeta('behavior_review_new_issues_enabled', '1')
    const original = mocks.runFile.getMockImplementation()!
    let failRead!: (error: Error) => void
    const unread = new Promise<never>((_, reject) => { failRead = reject })
    mocks.runFile.mockImplementation((command, args, ...rest) => command === 'agent-interface' && args[0] === '--logs'
      ? unread : original(command, args, ...rest))
    await resetLogCache()
    const tick = behaviors.runEnabledBehaviorsOnce()
    try {
      await expect.poll(() => resolveCalls().length, { timeout: 1000 }).toBe(1)
      expect(database.db.prepare("SELECT outcome FROM behavior_runs WHERE behavior='resolve-unblocking'").get())
        .toEqual({ outcome: 'resolved' })
      expect(database.listBehaviorLaunchClaims('review-new-issues')[0]!.claimId).toBe(claimId)
    } finally {
      failRead(new Error('Command timed out after 30000ms'))
      await tick
    }
    expect(database.listBehaviorLaunchClaims('review-new-issues')[0]).toMatchObject({
      claimId, launchQuarantine: 'unreadable', launchQuarantineMayRun: true,
    })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('review-new-issues operation failed:'), expect.anything())
  })

  it('correlates the durable run with its firing and retains the resolve disposition', async () => {
    const { behaviors, database } = await enableResolve({ resolveResolvedCount: 2 })
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(1)
    const runs = database.db.prepare('SELECT id, behavior, status, outcome, completed_at FROM behavior_runs').all() as
      Array<{ id: string, behavior: string, status: string, outcome: string, completed_at: string }>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ behavior: 'resolve-unblocking', status: 'completed', outcome: 'resolved' })
    expect(Date.parse(runs[0]!.completed_at)).not.toBeNaN()
    const admission = mocks.captureAdmission.mock.calls[0][0]
    expect(admission.nativeId).toBe(runs[0]!.id)
    expect(admission.admissionKey).toBe(runs[0]!.id)
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      nativeId: runs[0]!.id, state: 'completed', outcome: 'resolved',
    }))
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it.each([
    { name: 'waiting', activity: { resolveResolvedCount: 0, resolveUnresolvedCount: 2 }, outcome: 'waiting' },
    { name: 'settled no-op', activity: { resolveResolvedCount: 0, resolveUnresolvedCount: 0 }, outcome: 'no_op' },
  ])('excludes a $name poll from runs while its firing keeps the disposition', async ({ activity, outcome }) => {
    const { behaviors, database } = await enableResolve(activity)
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(1)
    expect(database.db.prepare('SELECT * FROM behavior_runs').all()).toEqual([])
    const admission = mocks.captureAdmission.mock.calls[0][0]
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      nativeId: admission.nativeId, state: 'completed', outcome,
    }))
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('records supersession on the firing without a run row or a failure', async () => {
    const { behaviors, database } = await enableResolve({ resolveSuperseded: true })
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(1)
    expect(database.db.prepare('SELECT * FROM behavior_runs').all()).toEqual([])
    const admission = mocks.captureAdmission.mock.calls[0][0]
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      nativeId: admission.nativeId, state: 'superseded', outcome: 'superseded',
    }))
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
})
