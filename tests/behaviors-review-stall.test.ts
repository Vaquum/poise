import { describe, expect, it, vi } from 'vitest'
import { behaviorDiagnosticGroups } from '../src/behavior-diagnostics'
import type { BehaviorDiagnostics } from '../src/behaviors'
import { mocks, pr, loadModules, arrangeCli, fixture } from './behaviors-runtime-fixture'

// Provider maintenance is unrelated to this regression: preparation resolves
// immediately so the sweep's own deadline handling is what the tests observe.
vi.mock('../server/provider-clis', () => ({
  prepareModelClis: vi.fn(async () => ({})),
  prepareProviderCli: vi.fn(async () => ({ status: 'ok' })),
}))

const secondPr = { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }

async function startReviewing(open: typeof fixture.listedPrs) {
  fixture.listedPrs = open
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

describe('review-new-prs under load', () => {
  it('reviews the other PRs when one PR check times out, and retries the timed-out check within minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startReviewing([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--head-sha' && String(args[1]) === '#17') {
        throw new Error('Command timed out after 30000ms: github-interface')
      }
      return original(command, args, options)
    })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0]?.[1]).toContain('#18')

    // Repeat the timeout past the old hour-long horizon: every retry stays minutes away.
    const key = `behavior_review_new_prs_failure:${pr.repo}#17:check`
    for (let attempt = 0; attempt < 8; attempt++) {
      const stored = JSON.parse(db.getMeta(key)!)
      vi.setSystemTime(new Date(stored.nextRetryAtMs + 1))
      await runtime.runEnabledBehaviorsOnce()
    }
    const stored = JSON.parse(db.getMeta(key)!)
    expect(stored.consecutiveFailures).toBe(9)
    expect(stored.nextRetryAtMs - stored.lastFailureAtMs).toBeLessThanOrEqual(3 * 60_000)
  })

  it('keeps the hour-long backoff for hard check failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startReviewing([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--head-sha' && String(args[1]) === '#17') {
        throw new Error('github-interface --head-sha returned malformed state')
      }
      return original(command, args, options)
    })

    const key = `behavior_review_new_prs_failure:${pr.repo}#17:check`
    for (let attempt = 0; attempt < 9; attempt++) {
      await runtime.runEnabledBehaviorsOnce()
      const stored = JSON.parse(db.getMeta(key)!)
      vi.setSystemTime(new Date(stored.nextRetryAtMs + 1))
    }
    const stored = JSON.parse(db.getMeta(key)!)
    expect(stored.consecutiveFailures).toBe(9)
    expect(stored.nextRetryAtMs - stored.lastFailureAtMs).toBe(60 * 60_000)
  })

  it('still reviews prepared PRs when a slow check pushes the sweep past its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { behaviors: runtime } = await startReviewing([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    let slowEntered = false
    let fastPrepared = false
    let resolveSlowEntered!: () => void
    let resolveFastPrepared!: () => void
    const slowEnteredPromise = new Promise<void>((resolve) => { resolveSlowEntered = resolve })
    const fastPreparedPromise = new Promise<void>((resolve) => { resolveFastPrepared = resolve })
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--head-sha' && String(args[1]) === '#17') {
        slowEntered = true
        resolveSlowEntered()
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        if (signal?.aborted) throw signal.reason
        // A check that never answers until the sweep deadline aborts it, as a
        // loaded machine does to a real CLI call.
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      const result = await original(command, args, options)
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed'
        && String(args[1]) === '#18') {
        fastPrepared = true
        resolveFastPrepared()
      }
      return result
    })

    const run = runtime.runEnabledBehaviorsOnce()
    // Real I/O (checkout directories, lock files) drains while the fake clock
    // stays put, so the fast PR is fully prepared before the deadline fires.
    const pump = () => new Promise<void>((resolve) => setImmediate(resolve))
    await Promise.all([slowEnteredPromise, fastPreparedPromise])
    expect(slowEntered && fastPrepared).toBe(true)
    for (let i = 0; i < 20; i++) await pump()
    await vi.advanceTimersByTimeAsync(56_000)
    for (let i = 0; i < 100 && mocks.spawnDetached.mock.calls.length === 0; i++) await pump()
    await run

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0]?.[1]).toContain('#18')
    const sweep = runtime.getBehaviorsRuntimeHealth().failures
      .find((failure) => failure.behavior === 'review-new-prs' && !failure.target)
    expect(sweep?.error).toMatch(/aborted due to timeout/)
  })

  it('keeps retrying the sweep within minutes after repeated sweep timeouts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startReviewing([pr])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args[0] === 'view') {
        throw new Error('Command timed out after 30000ms: github-datastore')
      }
      return original(command, args, options)
    })

    for (let attempt = 0; attempt < 8; attempt++) {
      vi.setSystemTime(new Date(Date.now() + 61_000))
      await runtime.runEnabledBehaviorsOnce()
    }
    const stored = JSON.parse(db.getMeta('behavior_review_new_prs_failure')!)
    expect(stored.consecutiveFailures).toBe(8)
    expect(stored.nextRetryAtMs - stored.lastFailureAtMs).toBeLessThanOrEqual(3 * 60_000)
  })

  it('tells the rail plainly that review is stalled when sweeps time out', () => {
    const diagnostics: BehaviorDiagnostics = { status: 'degraded', agentLogsError: null,
      datastore: { status: 'healthy', checkedAt: '', ageSeconds: 1, lastSuccessAt: '', error: null },
      identity: { status: 'valid', actor: 'bit-mis', error: null },
      failures: [{ org: 'autonomio', behavior: 'review-new-prs', kind: 'operation', consecutiveFailures: 31,
        lastFailureAt: '2026-10-21T22:40:35.257Z', nextRetryAt: '2026-10-21T22:43:35.257Z',
        error: 'The operation was aborted due to timeout' }],
      deadLetters: [], holds: [] }
    const groups = behaviorDiagnosticGroups(diagnostics)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.message).toMatch(/stalled/)
  })
})
