import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, loadModules, arrangeCli } from './behaviors-runtime-fixture'

const slowLockSetup = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, chmod: async (...args: Parameters<typeof actual.chmod>) => {
    if (args[0] === slowLockSetup.path) await new Promise((resolve) => setTimeout(resolve, 1100))
    return await actual.chmod(...args)
  } }
})

async function arrangeChainSweep() {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database: db, behaviors: runtime } = await loadModules()
  const { BehaviorChainRuntime } = await import('../server/behavior-chain-runtime')
  const run = vi.spyOn(BehaviorChainRuntime.prototype, 'run').mockResolvedValue()
  runtime.startBehaviorsRuntime()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_chain_settings', JSON.stringify({ enabled: true, seedMode: 'label', label: 'poise' }))
  return {
    db, runtime, run,
    lockPath: join(dirname(process.env.POISE_DB!), '.poise-vaquum-behavior-chain-runtime-lock.sqlite3'),
    reported: () => vi.mocked(console.error).mock.calls.map(([line]) => String(line)).filter((line) => line.includes('behavior chain failed')),
  }
}

// The two ways an overlap reaches the lock: the local queue, and SQLite itself.
const holders = {
  'a sweep in this process': async (path: string, held: () => Promise<void>) => {
    const { withProcessLock } = await import('../server/process-lock')
    await withProcessLock({ path }, held)
  },
  'another SQLite connection': async (path: string, held: () => Promise<void>) => {
    const holder = new Database(path)
    holder.exec('BEGIN IMMEDIATE')
    try { await held() } finally { holder.close() }
  },
}
const holderNames = Object.keys(holders) as (keyof typeof holders)[]

describe('behavior chain sweep lock', () => {
  it.each(holderNames)('skips only the chain sweep, reporting nothing, while %s holds its lock', async (name) => {
    const { db, runtime, run, lockPath, reported } = await arrangeChainSweep()
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await holders[name](lockPath, async () => {
      await runtime.runEnabledBehaviorsOnce()

      expect(run).not.toHaveBeenCalled()
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      expect(reported()).toEqual([])
      expect(runtime.getBehaviorChainRuntimeHealth().filter((entry) => entry.error)).toEqual([])
      expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', runtimeError: null })
    })

    await runtime.runEnabledBehaviorsOnce()
    expect(run).toHaveBeenCalled()
  })

  it('reports another sweep error as a failure and keeps it through a skipped sweep', async () => {
    const { runtime, run, lockPath, reported } = await arrangeChainSweep()
    run.mockRejectedValue(new Error('boom'))

    await runtime.runEnabledBehaviorsOnce()

    expect(reported()[0]).toContain('behavior chain failed for Vaquum: boom')
    expect(runtime.getBehaviorChainRuntimeHealth()).toEqual([{ organization: 'vaquum', lastSweepAt: expect.any(Number), error: 'boom' }])
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'degraded', runtimeError: 'boom' })

    await holders['another SQLite connection'](lockPath, async () => {
      const held = runtime.getBehaviorChainRuntimeHealth()
      await new Promise((resolve) => setTimeout(resolve, 2))
      await runtime.runEnabledBehaviorsOnce()

      expect(runtime.getBehaviorChainRuntimeHealth()).toEqual(held)
      expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'degraded', runtimeError: 'boom' })
    })
  })

  it('reports an unusable lock as a failure', async () => {
    const { runtime, run, lockPath, reported } = await arrangeChainSweep()
    mkdirSync(lockPath)

    await runtime.runEnabledBehaviorsOnce()

    expect(run).not.toHaveBeenCalled()
    expect(reported()[0]).toContain('process lock is unavailable')
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'degraded', runtimeError: 'process lock is unavailable' })
  })

  it('delays the sweep rather than losing it when lock setup is slow and nothing holds the lock', async () => {
    const { runtime, run, lockPath, reported } = await arrangeChainSweep()
    slowLockSetup.path = lockPath

    try {
      await runtime.runEnabledBehaviorsOnce()
    } finally {
      slowLockSetup.path = ''
    }

    expect(run).toHaveBeenCalled()
    expect(reported()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', runtimeError: null })
  })
})

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
