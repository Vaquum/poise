import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, NEXT_HEAD_SHA, loadModules, arrangeCli, fixture, deferred } from './behaviors-runtime-fixture'

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
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed' && args.includes('--requests-json')) {
        const packet = JSON.parse((await original(command, args, options)).stdout)
        return {
          stdout: JSON.stringify({
            ...packet,
            records: (packet.records as Array<Record<string, unknown>>).map((record) =>
              record.pull_number === 17
                ? { repository: record.repository, pull_number: 17, error: 'Command timed out after 30000ms: github-interface' }
                : record),
          }),
          stderr: '',
        }
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
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed' && args.includes('--requests-json')) {
        const packet = JSON.parse((await original(command, args, options)).stdout)
        return {
          stdout: JSON.stringify({
            ...packet,
            records: (packet.records as Array<Record<string, unknown>>).map((record) =>
              record.pull_number === 17
                ? { repository: record.repository, pull_number: 17, error: 'github-interface --requested-changes-addressed returned malformed state' }
                : record),
          }),
          stderr: '',
        }
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
    const open = Array.from({ length: 12 }, (_, index) => ({
      ...pr, number: 17 + index, url: `https://github.com/${pr.repo}/pull/${17 + index}`,
    }))
    const { behaviors: runtime } = await startApproving(open)
    const original = mocks.runFile.getMockImplementation()!
    const fire = deferred<void>()
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--head-sha' && String(args[1]) === '#26') {
        fire.resolve()
        // The last prepared approval's launch is in flight when the sweep
        // deadline fires; the head lookup answers just after.
        await new Promise<void>((resolve) => setTimeout(resolve, 57_000))
      }
      return original(command, args, options)
    })

    const run = runtime.runEnabledBehaviorsOnce()
    // Await the actual final launch entry: event-loop iterations do not
    // bound checkout and lock I/O under load.
    await fire.promise
    await vi.advanceTimersByTimeAsync(59_000)
    await run

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(10)
    const sweep = runtime.getBehaviorsRuntimeHealth().failures
      .find((failure) => failure.behavior === 'approve-prs' && !failure.target)
    expect(sweep?.error).toMatch(/aborted due to timeout/)

    // The next sweep prepares the rest: the timed-out chunk is approved next pass.
    mocks.runFile.mockImplementation(original)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(12)
    const resumed = mocks.spawnDetached.mock.calls.slice(10).map(([, args]) => args[1])
    expect(resumed.sort()).toEqual(['#27', '#28'])
  })

  it('records a launch failure instead of dropping it when the sweep deadline already expired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    const fire = deferred<void>()
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--head-sha' && String(args[1]) === '#18') {
        fire.resolve()
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
    await fire.promise
    await vi.advanceTimersByTimeAsync(59_000)
    await run

    // #17's pipeline never stalls behind #18's slow launch.
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0]?.[1]).toContain('#17')
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
