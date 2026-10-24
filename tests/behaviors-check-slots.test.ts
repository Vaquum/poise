import { describe, expect, it } from 'vitest'
import { mocks, pr, loadModules, arrangeCli } from './behaviors-runtime-fixture'

async function arrangeReviewRun() {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
  loaded.database.setMeta('behavior_review_new_prs_enabled', '1')
  loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
  loaded.behaviors.startBehaviorsRuntime()
  return loaded
}

async function arrangeApproveRun() {
  arrangeCli(true)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_approve_prs_enabled', '1')
  loaded.behaviors.startBehaviorsRuntime()
  return loaded
}

function saturateBackground(runtime: { getBehaviorCheckSlots(): { tryAcquire(lane: 'background'): (() => void) | null } }): Array<() => void> {
  const slots = runtime.getBehaviorCheckSlots()
  const held = [slots.tryAcquire('background'), slots.tryAcquire('background'), slots.tryAcquire('background')]
  if (held.some((release) => !release)) throw new Error('could not saturate the background budget')
  return held as Array<() => void>
}

describe('shared check slots for behavior launches', () => {
  it('skips review candidates silently when the shared budget is full', async () => {
    const { behaviors: runtime } = await arrangeReviewRun()
    const held = saturateBackground(runtime)
    try {
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
      expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
        status: 'ok',
        checkSlots: { cap: 4, running: 3, personRunning: 0, backgroundRunning: 3, queued: 0, callerLaunches: 0 },
        failures: [],
      })
      expect(mocks.captureOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'no_op' }))
    } finally {
      for (const release of held) release()
    }
  })

  it('sheds contended review launches with a recorded reason and a closed attempt', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_reviewers', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    runtime.startBehaviorsRuntime()
    const slots = runtime.getBehaviorCheckSlots()
    const held = [slots.tryAcquire('background'), slots.tryAcquire('background')]
    if (held.some((release) => !release)) throw new Error('could not hold two background slots')
    try {
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      const failures = runtime.getBehaviorsRuntimeHealth().failures
      expect(failures).toHaveLength(2)
      for (const failure of failures) {
        expect(failure).toMatchObject({ behavior: 'review-new-prs', error: 'all 4 shared check slots are busy; will retry' })
      }
      const closed = mocks.captureOutcome.mock.calls.filter((call) => (call[0] as { outcome?: string }).outcome === 'no_op')
      expect(closed).toHaveLength(2)
    } finally {
      for (const release of held) release!()
    }
  })

  it('holds a review launch slot until its worker exits', async () => {
    const { database: db, behaviors: runtime } = await arrangeReviewRun()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toHaveLength(1)
    expect(runtime.getBehaviorCheckSlots().stats()).toMatchObject({ running: 1, backgroundRunning: 1 })
    const onExit = mocks.spawnDetached.mock.calls[0][2].onExit as (result: { code: number | null, signal: null }) => void
    await onExit({ code: 0, signal: null })
    expect(runtime.getBehaviorCheckSlots().stats()).toMatchObject({ running: 0, backgroundRunning: 0 })
  })

  it('sheds an approval launch with a visible reason when the shared budget is full', async () => {
    const { behaviors: runtime } = await arrangeApproveRun()
    const held = saturateBackground(runtime)
    try {
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
      expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({
        behavior: 'approve-prs',
        target: `${pr.repo}#${pr.number}:check`,
        error: 'all 4 shared check slots are busy; will retry',
      })])
    } finally {
      for (const release of held) release()
    }
  })
})
