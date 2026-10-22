import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, NEXT_HEAD_SHA, loadModules, arrangeCli, fixture } from './behaviors-runtime-fixture'

// Provider maintenance is unrelated to this regression: preparation resolves
// immediately so the sweep's own deadline handling is what the tests observe.
vi.mock('../server/provider-clis', () => ({
  prepareModelClis: vi.fn(async () => ({})),
  prepareProviderCli: vi.fn(async () => ({ status: 'ok' })),
}))

const secondPr = { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }

async function startApproving(open: typeof fixture.listedPrs) {
  fixture.listedPrs = open
  arrangeCli(true)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_approve_prs_enabled', '1')
  loaded.behaviors.startBehaviorsRuntime()
  return loaded
}

describe('approve-prs under load', () => {
  it('approves the other PRs when one PR check times out, and retries the timed-out check within minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed' && String(args[1]) === '#17') {
        throw new Error('Command timed out after 30000ms: github-interface')
      }
      return original(command, args, options)
    })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0]?.[1]).toContain('#18')

    // Repeat the timeout past the old hour-long horizon: every retry stays minutes away.
    const key = `behavior_approve_prs_failure:${pr.repo}#17:check`
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
    const { database: db, behaviors: runtime } = await startApproving([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed' && String(args[1]) === '#17') {
        throw new Error('github-interface --requested-changes-addressed returned malformed state')
      }
      return original(command, args, options)
    })

    const key = `behavior_approve_prs_failure:${pr.repo}#17:check`
    for (let attempt = 0; attempt < 9; attempt++) {
      await runtime.runEnabledBehaviorsOnce()
      const stored = JSON.parse(db.getMeta(key)!)
      vi.setSystemTime(new Date(stored.nextRetryAtMs + 1))
    }
    const stored = JSON.parse(db.getMeta(key)!)
    expect(stored.consecutiveFailures).toBe(9)
    expect(stored.nextRetryAtMs - stored.lastFailureAtMs).toBe(60 * 60_000)
  })

  it('still fires prepared approvals when a slow check pushes the sweep past its deadline, and resumes the rest next pass', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { behaviors: runtime } = await startApproving([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    let slowEntered = false
    let fireEntered = false
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed' && String(args[1]) === '#17') {
        slowEntered = true
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        if (signal?.aborted) throw signal.reason
        // A check that never answers until the sweep deadline aborts it, as a
        // loaded machine does to a real CLI call.
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      if (command === 'github-interface' && args[0] === '--head-sha' && String(args[1]) === '#18') {
        fireEntered = true
        // The approval is prepared and its launch is in flight when the sweep
        // deadline fires; the head lookup answers just after.
        await new Promise<void>((resolve) => setTimeout(resolve, 57_000))
      }
      return original(command, args, options)
    })

    const run = runtime.runEnabledBehaviorsOnce()
    // Real I/O (checkout directories, lock files) drains while the fake clock
    // stays put, so the fast PR is inside its launch before the deadline fires.
    const pump = () => new Promise<void>((resolve) => setImmediate(resolve))
    for (let i = 0; i < 1000 && !(slowEntered && fireEntered); i++) await pump()
    expect(slowEntered && fireEntered).toBe(true)
    for (let i = 0; i < 20; i++) await pump()
    await vi.advanceTimersByTimeAsync(59_000)
    for (let i = 0; i < 100 && mocks.spawnDetached.mock.calls.length === 0; i++) await pump()
    await run

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0]?.[1]).toContain('#18')
    const sweep = runtime.getBehaviorsRuntimeHealth().failures
      .find((failure) => failure.behavior === 'approve-prs' && !failure.target)
    expect(sweep?.error).toMatch(/aborted due to timeout/)

    // The next sweep prepares the rest: the timed-out PR is approved next pass.
    mocks.runFile.mockImplementation(original)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1]?.[1]).toContain('#17')
  })

  it('records a launch failure instead of dropping it when the sweep deadline already expired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    let slowEntered = false
    let fireEntered = false
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed' && String(args[1]) === '#17') {
        slowEntered = true
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        if (signal?.aborted) throw signal.reason
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      if (command === 'github-interface' && args[0] === '--head-sha' && String(args[1]) === '#18') {
        fireEntered = true
        // The head lookup answers after the sweep deadline with a new head: a
        // genuine launch failure, not an abort.
        await new Promise<void>((resolve) => setTimeout(resolve, 57_000))
        return {
          stdout: JSON.stringify({ action: 'head_sha', repository: secondPr.repo, pull_number: 18, head_sha: NEXT_HEAD_SHA }),
          stderr: '',
        }
      }
      return original(command, args, options)
    })

    const run = runtime.runEnabledBehaviorsOnce()
    const pump = () => new Promise<void>((resolve) => setImmediate(resolve))
    for (let i = 0; i < 1000 && !(slowEntered && fireEntered); i++) await pump()
    expect(slowEntered && fireEntered).toBe(true)
    for (let i = 0; i < 20; i++) await pump()
    await vi.advanceTimersByTimeAsync(59_000)
    await run

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    const stored = JSON.parse(db.getMeta(`behavior_approve_prs_failure:${secondPr.repo}#18:check`)!)
    expect(stored.error).toMatch(/head changed/)
    expect(stored.consecutiveFailures).toBe(1)
    expect(stored.nextRetryAtMs - stored.lastFailureAtMs).toBe(60_000)
  })

  it('keeps retrying the sweep within minutes after repeated sweep timeouts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr])
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
    const stored = JSON.parse(db.getMeta('behavior_approve_prs_failure')!)
    expect(stored.consecutiveFailures).toBe(8)
    expect(stored.nextRetryAtMs - stored.lastFailureAtMs).toBeLessThanOrEqual(3 * 60_000)
  })
})
