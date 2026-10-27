import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, loadModules, arrangeCli } from './behaviors-runtime-fixture'

describe('behavior lock contention', () => {
  it('defers explicitly with its cause when another process holds the behavior lock', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.lockContention = true

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    const deferral = runtime.readBehaviorDeferral('review-new-prs')
    expect(deferral?.code).toBe('BEHAVIOR_PROCESS_LOCK_BUSY')
    expect(deferral?.message).toMatch(/already running in another process/)

    mocks.lockContention = false
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('releases the atomic claim when launch intent throws mid-claim', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T11:40:00.000Z'))
    try {
      arrangeCli(false)
      mocks.spawnDetached.mockResolvedValue(undefined)
      const { database: db, behaviors: runtime } = await loadModules()
      runtime.startBehaviorsRuntime()
      db.setMeta('me', 'poise-user')
      db.setMeta('behavior_review_new_prs_keyver', '3')
      db.setMeta('behavior_review_new_prs_enabled', '1')
      db.recordSeen('review-new-prs', '__snapshot_v3__')
      // Sabotage launch-intent writes only: the atomic claim (INSERT with
      // NULL intent) still succeeds, then markLaunchIntent throws mid-claim.
      db.db.exec(`
        CREATE TRIGGER claim_intent_boom BEFORE UPDATE ON behavior_seen
        WHEN NEW.key = 'review-new-prs' AND NEW.launch_requested_at IS NOT NULL
          AND OLD.launch_requested_at IS NULL
        BEGIN SELECT RAISE(ABORT, 'boom'); END
      `)

      await runtime.runEnabledBehaviorsOnce()

      expect(mocks.spawnDetached).not.toHaveBeenCalled()
      // The sabotaged intent throw was recorded for this exact target,
      // proving the tick reached the claim phase.
      const failures = db.db.prepare(`
        SELECT key, value FROM meta WHERE key LIKE '%failure%' AND value <> ''
      `).all() as { key: string, value: string }[]
      expect(failures.some((f) => f.key.includes('review_new_prs') && f.value.includes('boom'))).toBe(true)
      // The claim row is gone: released, not held until the 2h lease expires.
      const row = db.db.prepare(`
        SELECT claim_id AS claimId FROM behavior_seen
        WHERE key = 'review-new-prs' AND target = ?
      `).get(`${pr.repo}#${pr.number}`) as { claimId: string } | undefined
      expect(row).toBeUndefined()

      db.db.exec('DROP TRIGGER claim_intent_boom')
      vi.setSystemTime(new Date('2026-07-15T12:10:00.000Z'))
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
