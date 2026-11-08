import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, loadModules, arrangeCli, deferred } from './behaviors-runtime-fixture'

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  runtime.startBehaviorsRuntime()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_chain_settings', JSON.stringify({ enabled: true, seedMode: 'label', label: 'poise' }))
  return {
    db, runtime, run,
    lockPath: join(dirname(process.env.POISE_DB!), '.poise-vaquum-behavior-chain-runtime-lock.sqlite3'),
    reported: () => vi.mocked(console.error).mock.calls.map(([line]) => String(line)).filter((line) => line.includes('behavior chain failed')),
    warnings: () => vi.mocked(console.warn).mock.calls.map(([line]) => String(line)).filter((line) => line.includes('behavior chain sweep')),
    observations: () => vi.mocked(console.log).mock.calls.map(([line]) => String(line)).filter((line) => line.includes('behavior chain sweep overlap ended')),
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
    const { db, runtime, run, lockPath, reported, warnings, observations } = await arrangeChainSweep()
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await holders[name](lockPath, async () => {
      await runtime.runEnabledBehaviorsOnce()

      expect(run).not.toHaveBeenCalled()
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      expect(reported()).toEqual([])
      expect(warnings()).toEqual([])
      expect(runtime.getBehaviorChainRuntimeHealth().filter((entry) => entry.error)).toEqual([])
      expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', runtimeError: null })
    })

    await runtime.runEnabledBehaviorsOnce()
    expect(run).toHaveBeenCalled()
    expect(observations()).toEqual([expect.stringContaining('skipped ticks: 1')])
  })

  it.each(holderNames)('reports overdue overlap once per episode while %s holds its lock', async (name) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const began = Date.parse('2026-11-08T12:00:00Z')
    vi.setSystemTime(began)
    const { runtime, run, lockPath, reported, warnings, observations } = await arrangeChainSweep()
    const budget = 2 * runtime.BEHAVIOR_TICK_MS

    await holders[name](lockPath, async () => {
      // Frequent check-slot retries must not turn a skip count into a deadline.
      for (const elapsed of [0, 1_000, 2_000, budget - 1, budget]) {
        vi.setSystemTime(began + elapsed)
        await runtime.runEnabledBehaviorsOnce()
        expect(warnings()).toEqual([])
        expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', runtimeError: null })
      }
      vi.setSystemTime(began + budget + 1)
      expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
        status: 'degraded', runtimeError: expect.stringContaining('chain sweep overlap'),
      })
      for (const elapsed of [budget + 1, budget + 1_001, budget + 2_001]) {
        vi.setSystemTime(began + elapsed)
        await runtime.runEnabledBehaviorsOnce()
      }
      expect(warnings()).toEqual([expect.stringContaining('Vaquum')])
      expect(run).not.toHaveBeenCalled()
      expect(reported()).toEqual([])
      expect(runtime.getBehaviorChainRuntimeHealth()).toEqual([])
    })

    // A failed completion ends the episode without turning its failure healthy.
    run.mockRejectedValueOnce(new Error('boom'))
    await runtime.runEnabledBehaviorsOnce()
    const failed = runtime.getBehaviorChainRuntimeHealth()
    expect(failed).toEqual([{ organization: 'vaquum', lastSweepAt: Date.now(), error: 'boom' }])
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'degraded', runtimeError: 'boom' })
    expect(observations()).toEqual([expect.stringContaining('skipped ticks: 8; elapsed: 122001ms')])

    const next = Date.now() + 1
    await holders[name](lockPath, async () => {
      vi.setSystemTime(next)
      await runtime.runEnabledBehaviorsOnce()
      expect(warnings()).toHaveLength(1)
      vi.setSystemTime(next + budget + 1)
      await runtime.runEnabledBehaviorsOnce()
      expect(warnings()).toEqual([expect.stringContaining('Vaquum'), expect.stringContaining('Vaquum')])
      expect(runtime.getBehaviorChainRuntimeHealth()).toEqual(failed)
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getBehaviorChainRuntimeHealth()).toEqual([{ organization: 'vaquum', lastSweepAt: Date.now(), error: null }])
    expect(observations()).toEqual([
      expect.stringContaining('skipped ticks: 8; elapsed: 122001ms'),
      expect.stringContaining('skipped ticks: 2; elapsed: 120001ms'),
    ])
  })

  it.each(holderNames)('keeps overlap clocks and warnings separate by organization with %s', async (name) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const began = Date.parse('2026-11-08T12:00:00Z')
    vi.setSystemTime(began)
    const { db, runtime, lockPath, warnings, observations } = await arrangeChainSweep()
    db.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('beta', ?, 1, 'ready', 'ready', 'poise-user')`).run(join(dirname(lockPath), 'beta.sqlite'))
    const betaLock = join(dirname(lockPath), '.poise-beta-behavior-chain-runtime-lock.sqlite3')
    const budget = 2 * runtime.BEHAVIOR_TICK_MS

    await holders[name](lockPath, async () => {
      await runtime.runEnabledBehaviorsOnce()
      await holders[name](betaLock, async () => {
        vi.setSystemTime(began + 1_000)
        await runtime.runEnabledBehaviorsOnce()
        vi.setSystemTime(began + budget + 1)
        await runtime.runEnabledBehaviorsOnce()
        expect(warnings()).toEqual([expect.stringContaining('Vaquum')])
        expect(runtime.withBehaviorOrganization('beta', () => runtime.getBehaviorsRuntimeHealth()))
          .toMatchObject({ status: 'ok', runtimeError: null })
        vi.setSystemTime(began + budget + 1_001)
        await runtime.runEnabledBehaviorsOnce()
        expect(warnings()).toEqual([expect.stringContaining('Vaquum'), expect.stringContaining('beta')])
      })
      await runtime.runEnabledBehaviorsOnce()
      expect(observations()).toEqual([expect.stringContaining('ended for beta: skipped ticks: 3')])
      expect(runtime.withBehaviorOrganization('Vaquum', () => runtime.getBehaviorsRuntimeHealth()))
        .toMatchObject({ status: 'degraded', runtimeError: expect.stringContaining('chain sweep overlap') })
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(warnings()).toHaveLength(2)
    expect(observations()).toHaveLength(2)
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', runtimeError: null })
  })

  it('reports a blocked sweep through health despite completed scheduler ticks, then recovers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'))
    const { runtime, run, warnings, observations } = await arrangeChainSweep()
    const held = deferred<void>()
    run.mockReturnValueOnce(held.promise)
    const sweep = runtime.runEnabledBehaviorsOnce()
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      for (let tick = 1; tick <= 4; tick++) {
        await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_TICK_MS)
        await vi.waitFor(() => {
          const health = runtime.getBehaviorsRuntimeHealth()
          expect(health.lastTickAt).not.toBeNull()
          expect(Date.parse(health.lastTickCompletedAt!)).toBeGreaterThanOrEqual(Date.parse(health.lastTickAt!))
        })
      }
      expect(run).toHaveBeenCalledOnce()
      expect(warnings()).toHaveLength(1)
      expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
        status: 'degraded', runtimeError: expect.stringContaining('chain sweep overlap'),
      })
    } finally {
      held.resolve()
      await sweep
    }
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', runtimeError: null })
    expect(observations()).toEqual([expect.stringContaining('skipped ticks: 4')])
  })

  it('reports another sweep error as a failure and keeps it through a skipped sweep', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const began = Date.parse('2026-11-08T12:00:00Z')
    vi.setSystemTime(began)
    const { runtime, run, lockPath, reported, warnings } = await arrangeChainSweep()
    run.mockRejectedValue(new Error('boom'))

    await runtime.runEnabledBehaviorsOnce()

    expect(reported()[0]).toContain('behavior chain failed for Vaquum: boom')
    expect(runtime.getBehaviorChainRuntimeHealth()).toEqual([{ organization: 'vaquum', lastSweepAt: expect.any(Number), error: 'boom' }])
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'degraded', runtimeError: 'boom' })

    await holders['another SQLite connection'](lockPath, async () => {
      const held = runtime.getBehaviorChainRuntimeHealth()
      for (const elapsed of [1_000, 121_001, 122_001]) {
        vi.setSystemTime(began + elapsed)
        await runtime.runEnabledBehaviorsOnce()

        expect(runtime.getBehaviorChainRuntimeHealth()).toEqual(held)
        expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'degraded', runtimeError: 'boom' })
      }
      expect(warnings()).toHaveLength(1)
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
