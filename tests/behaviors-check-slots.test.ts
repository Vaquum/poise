import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, loadModules, arrangeCli, datastoreHealthOutput, fixture } from './behaviors-runtime-fixture'

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

async function arrangeTwoOrgApproveRun() {
  arrangeCli(true)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  const { database: db, behaviors: runtime } = loaded
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_approve_prs_enabled', '1')
  const betaPath = join(fixture.tempRoot, 'beta.sqlite')
  db.db.prepare(`
    INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
    VALUES ('beta', ?, 1, 'ready', 'ready', 'poise-user')
  `).run(betaPath)
  const betaPr = { ...pr, repo: 'beta/poise-test', number: 17, url: 'https://github.com/beta/poise-test/pull/17' }
  const rows = new Map<string, typeof betaPr[]>([['Vaquum', []], ['beta', [betaPr]]])
  const original = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
    if (command !== 'github-datastore') return original(command, args, options)
    const explicit = args[0] === '--db'
    const scoped = explicit ? args.slice(2) : args
    if (scoped[0] === 'health') {
      const response = datastoreHealthOutput()
      const health = JSON.parse(response.stdout)
      health.database = explicit ? args[1] : join(fixture.tempRoot, 'github.sqlite')
      return { ...response, stdout: JSON.stringify(health) }
    }
    return { stdout: JSON.stringify(rows.get(explicit ? 'beta' : 'Vaquum')), stderr: '' }
  })
  runtime.startBehaviorsRuntime()
  return { ...loaded, betaPr }
}

function saturateBehaviorBudget(runtime: { getBehaviorCheckSlots(): { tryAcquire(lane: 'behavior'): (() => void) | null } }): Array<() => void> {
  const slots = runtime.getBehaviorCheckSlots()
  const held = [slots.tryAcquire('behavior'), slots.tryAcquire('behavior'), slots.tryAcquire('behavior')]
  if (held.some((release) => !release)) throw new Error('could not saturate the behavior budget')
  return held as Array<() => void>
}

describe('shared check slots for behavior launches', () => {
  it('skips review candidates silently when the shared budget is full', async () => {
    const { behaviors: runtime } = await arrangeReviewRun()
    const held = saturateBehaviorBudget(runtime)
    try {
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
      expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
        status: 'ok',
        checkSlots: { cap: 4, running: 3, personRunning: 0, backgroundRunning: 0, behaviorRunning: 3, queued: 0, callerLaunches: 0 },
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
    const held = [slots.tryAcquire('behavior'), slots.tryAcquire('behavior')]
    if (held.some((release) => !release)) throw new Error('could not hold two behavior slots')
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
    expect(runtime.getBehaviorCheckSlots().stats()).toMatchObject({ running: 1, behaviorRunning: 1 })
    const onExit = mocks.spawnDetached.mock.calls[0][2].onExit as (result: { code: number | null, signal: null }) => void
    await onExit({ code: 0, signal: null })
    expect(runtime.getBehaviorCheckSlots().stats()).toMatchObject({ running: 0, behaviorRunning: 0 })
  })

  it('sheds an approval launch with a visible reason when the shared budget is full', async () => {
    const { behaviors: runtime } = await arrangeApproveRun()
    const held = saturateBehaviorBudget(runtime)
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

  it('starts an approval while worker turns hold every chat slot', async () => {
    const { behaviors: runtime } = await arrangeApproveRun()
    const slots = runtime.getBehaviorCheckSlots()
    // Worker turns fill the whole background share of the default budget...
    const held = [slots.tryAcquire('background'), slots.tryAcquire('background')]
    if (held.some((release) => !release)) throw new Error('could not hold the chat share')
    const third = slots.tryAcquire('background')
    expect(third).toBeNull()
    third?.()
    try {
      // ...and the approval still launches within one sweep.
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    } finally {
      for (const release of held) release!()
    }
  })

  it('retries a slot-busy deferral when a slot frees, without growing backoff', async () => {
    const { behaviors: runtime } = await arrangeApproveRun()
    const slots = runtime.getBehaviorCheckSlots()
    const held = [slots.tryAcquire('behavior'), slots.tryAcquire('behavior'), slots.tryAcquire('behavior')]
    if (held.some((release) => !release)) throw new Error('could not saturate the behavior budget')
    try {
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
      const first = runtime.getBehaviorsRuntimeHealth().failures
      expect(first).toEqual([expect.objectContaining({
        behavior: 'approve-prs',
        target: `${pr.repo}#${pr.number}:check`,
        error: 'all 4 shared check slots are busy; will retry',
        consecutiveFailures: 1,
      })])
      expect(Date.parse(first[0].nextRetryAt)).toBeLessThanOrEqual(Date.now())
      // A second sweep retries at once instead of waiting out a backoff...
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
      expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({
        behavior: 'approve-prs',
        consecutiveFailures: 1,
      })])
    } finally {
      for (const release of held) release!()
    }
    // ...and a freed slot wakes a sweep without waiting for the next tick.
    await vi.waitFor(() => expect(mocks.spawnDetached).toHaveBeenCalledOnce(), { timeout: 10_000 })
  }, 30_000)

  it('wakes every organization when a slot frees, not just the release context', async () => {
    const { behaviors: runtime, betaPr } = await arrangeTwoOrgApproveRun()
    const slots = runtime.getBehaviorCheckSlots()
    const held = [slots.tryAcquire('behavior'), slots.tryAcquire('behavior'), slots.tryAcquire('behavior')]
    if (held.some((release) => !release)) throw new Error('could not saturate the behavior budget')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({
      behavior: 'approve-prs',
      target: `${betaPr.repo}#${betaPr.number}:check`,
    })])
    // The release happens inside Vaquum's sweep context; the retry must
    // still reach beta's deferred launch instead of re-scanning Vaquum.
    runtime.withBehaviorOrganization('Vaquum', () => {
      for (const release of held) release!()
    })
    await vi.waitFor(() => expect(mocks.spawnDetached).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  }, 30_000)

  it('keeps a slot-busy retry across a nested organization sweep', async () => {
    const { behaviors: runtime } = await arrangeTwoOrgApproveRun()
    const slots = runtime.getBehaviorCheckSlots()
    const held = [slots.tryAcquire('behavior'), slots.tryAcquire('behavior'), slots.tryAcquire('behavior')]
    if (held.some((release) => !release)) throw new Error('could not saturate the behavior budget')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    // A later organization sweep with no deferred work of its own, as the
    // staggered fan-out runs one, must not erase beta's pending retry.
    await runtime.withBehaviorOrganization('Vaquum', () => runtime.runEnabledBehaviorsOnce())
    for (const release of held) release!()
    await vi.waitFor(() => expect(mocks.spawnDetached).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  }, 30_000)
})
