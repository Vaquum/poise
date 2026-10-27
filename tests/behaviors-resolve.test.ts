import { describe, expect, it } from 'vitest'
import { mocks, HEAD_SHA, arrangeCli, loadModules } from './behaviors-runtime-fixture'
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
  ])('retains a $name poll with its disposition instead of discarding it', async ({ activity, outcome }) => {
    const { behaviors, database } = await enableResolve(activity)
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(1)
    const runs = database.db.prepare('SELECT id, status, outcome FROM behavior_runs').all() as Array<{ id: string }>
    expect(runs).toEqual([{ id: expect.any(String), status: 'completed', outcome }])
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      nativeId: runs[0]!.id, state: 'completed', outcome,
    }))
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('records supersession as a non-failure with its disposition', async () => {
    const { behaviors, database } = await enableResolve({ resolveSuperseded: true })
    await behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(1)
    const runs = database.db.prepare('SELECT id, status, outcome FROM behavior_runs').all() as Array<{ id: string }>
    expect(runs).toEqual([{ id: expect.any(String), status: 'completed', outcome: 'superseded' }])
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      nativeId: runs[0]!.id, state: 'superseded', outcome: 'superseded',
    }))
    expect(behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
})
