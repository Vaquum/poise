import { describe, expect, it, vi } from 'vitest'
import { CheckSemaphore } from '../server/check-semaphore'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, arrangeCli, fixture, deferred, recordCompletedInitialReview, agentLog, resetLogCache } from './behaviors-runtime-fixture'

// This file pins sweep-deadline and cursor behavior under load, not the
// shared launch budget: an open budget lets every eligible PR launch, and
// behaviors-check-slots pins the default budget instead.
function openLaunchBudget(runtime: { setBehaviorCheckSlots(slots: CheckSemaphore): void }): void {
  runtime.setBehaviorCheckSlots(new CheckSemaphore(() => 64))
}

// Provider maintenance is unrelated to this regression: preparation resolves
// immediately so the sweep's own deadline handling is what the tests observe.
vi.mock('../server/provider-clis', () => ({
  prepareModelClis: vi.fn(async () => ({})),
  prepareProviderCli: vi.fn(async () => ({ status: 'ok' })),
}))

const secondPr = { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }

// Caller's GitHub client reports a 403/429 as `GitHub <status> rate-limit:
// <headers> body=<text>` on stderr, and runFile rejects with that stderr
// attached to a bare `Command failed` error.
function cliFailure(stderr: string): Error {
  return Object.assign(new Error('Command failed (1): github-interface'), { stderr })
}

function quotaExhaustedStderr(resetEpoch: number): string {
  return `error: GitHub 403 rate-limit: {'x-ratelimit-resource': 'core', 'x-ratelimit-limit': '5000', `
    + `'x-ratelimit-remaining': '0', 'x-ratelimit-used': '5000', 'x-ratelimit-reset': '${resetEpoch}'} body={\n`
    + `\t"message": "API rate limit exceeded for user ID 265471408.",\n\t"status": "403"\n}`
}

function addressedCalls(): unknown[][] {
  return mocks.runFile.mock.calls.filter(([command, args]: any[]) =>
    command === 'github-interface' && args[0] === '--requested-changes-addressed'
    && args.includes('--requests-json')
    && (JSON.parse(args[args.indexOf('--requests-json') + 1]) as Array<{ repository: string, number: number }>)
      .some(request => request.repository === pr.repo && request.number === 17))
}

// Keep the quota failure on its own PR record in the real batch envelope.
function failAddressedRecord(original: NonNullable<ReturnType<typeof mocks.runFile.getMockImplementation>>, failure: () => Error) {
  mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
    const result = await original(command, args, options)
    if (command !== 'github-interface' || args[0] !== '--requested-changes-addressed' || !args.includes('--requests-json')) return result
    const packet = JSON.parse(result.stdout)
    return { ...result, stdout: JSON.stringify({ ...packet,
      records: (packet.records as Array<Record<string, unknown>>).map(record => {
        if (record.repository !== pr.repo || record.pull_number !== 17) return record
        const error = failure()
        return { repository: record.repository, pull_number: 17,
          error: 'stderr' in error ? `${error.message}\n${String(error.stderr)}` : error.message }
      }),
    }) }
  })
}

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
  it('does not turn metadata-only clean completion into another approval dispatch', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user'); db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { response: false })
    await runtime.runEnabledBehaviorsOnce()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('rotates past three slow front claims before retrying the same full batch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const open = Array.from({ length: 10 }, (_, index) => ({
      ...pr, number: 17 + index, url: `https://github.com/${pr.repo}/pull/${17 + index}`,
    }))
    const { database: db, behaviors: runtime } = await startApproving(open)
    openLaunchBudget(runtime)
    expect(runtime.BEHAVIOR_OPERATION_TIMEOUT_MS).toBe(55_000)
    for (const number of [17, 18, 19]) {
      expect(db.claimPrOperationOwned(`${pr.repo}#${number}`, 600_000)).not.toBeNull()
    }
    const claim = db.claimPrOperationOwned
    let attempts: number[] = []
    let firstThree = deferred<void>()
    vi.spyOn(db, 'claimPrOperationOwned').mockImplementation((target, leaseMs) => {
      const number = Number(target.slice(target.lastIndexOf('#') + 1))
      if (!attempts.includes(number)) {
        attempts.push(number)
        if (attempts.length === 3) firstThree.resolve()
      }
      return claim(target, leaseMs)
    })
    const readGates = () => ({
      changes: { entered: deferred<void>(), release: deferred<void>() },
      activity: { entered: deferred<void>(), release: deferred<void>() },
    })
    let gates = readGates()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args.includes('--requests-json')) {
        const gate = args[0] === '--requested-changes-addressed' ? gates.changes
          : args[0] === '--review-activity-since' ? gates.activity : null
        if (gate) { gate.entered.resolve(); await gate.release.promise }
      }
      return original(command, args, options)
    })
    const lastFastLaunch = deferred<void>()
    mocks.spawnDetached.mockImplementation(async (_command: string, args: string[]) => {
      if (args[1] === '#26') lastFastLaunch.resolve()
    })
    const spendReadBudget = async () => {
      // Each read stays within its 30-second CLI limit, leaving five seconds
      // of the real sweep budget for the unchanged ten-second claim waits.
      await gates.changes.entered.promise
      await vi.advanceTimersByTimeAsync(25_000)
      gates.changes.release.resolve()
      await gates.activity.entered.promise
      await vi.advanceTimersByTimeAsync(25_000)
      gates.activity.release.resolve()
    }
    try {
      const first = runtime.runEnabledBehaviorsOnce()
      await spendReadBudget()
      await firstThree.promise
      await vi.advanceTimersByTimeAsync(9_000)
      await first
      expect(attempts).toEqual([17, 18, 19])
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
      expect(db.getMeta('behavior_approve_prs_cursor')).toBe(`${pr.repo}#19`)

      // The same peer claims remain held on the next sweep.
      attempts = []
      firstThree = deferred<void>()
      gates = readGates()
      const second = runtime.runEnabledBehaviorsOnce()
      await spendReadBudget()
      await firstThree.promise
      expect(attempts.slice(0, 3)).toEqual([20, 21, 22])
      await lastFastLaunch.promise
      await vi.advanceTimersByTimeAsync(9_000)
      await second
      expect(mocks.spawnDetached.mock.calls.map(([, args]) => Number(args[1].slice(1))).sort((a, b) => a - b))
        .toEqual([20, 21, 22, 23, 24, 25, 26])
    } finally {
      gates.changes.release.resolve()
      gates.activity.release.resolve()
    }
  })

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

  it('retains one cycle failure and the original Call when the deadline leaves another PR unread', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const startedAt = Date.now()
    const open = Array.from({ length: 11 }, (_, index) => ({
      ...pr, number: 17 + index, url: `https://github.com/${pr.repo}/pull/${17 + index}`,
    }))
    const { database: db, behaviors: runtime } = await startApproving(open)
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'agent-interface' && args[0] === '--diagnostics') return {
        stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '',
      }
      const result = await original(command, args, options)
      if (command !== 'github-interface' || args[0] !== '--requested-changes-addressed' || !args.includes('--requests-json')) return result
      const packet = JSON.parse(result.stdout)
      // Only #17 in the first batch has an author response. #27 is still
      // eligible, but its batch must not be read before the deadline expires.
      return { ...result, stdout: JSON.stringify({ ...packet,
        records: (packet.records as Array<{ pull_number: number }>).map((record) =>
          record.pull_number > 17 && record.pull_number < 27
            ? { ...record, status: false, commits_after_request: 0, author_commits_after_request: 0, response_count: 0 } : record),
      }) }
    })
    const preparing = deferred<void>(), prepared = deferred<void>()
    const launched = deferred<void>(), released = deferred<void>()
    const { prepareModelClis } = await import('../server/provider-clis')
    vi.mocked(prepareModelClis).mockImplementationOnce(async () => {
      preparing.resolve()
      await prepared.promise
      return {}
    })
    const callId = 'b'.repeat(32)
    mocks.spawnDetached.mockImplementation(async (_command: string, args: string[]) => {
      if (args[1] !== '#17') return
      fixture.agentLogs.push(agentLog({ id: callId, behavior: 'pr_approve',
        correlation_id: args[args.indexOf('--correlation-id') + 1], expected_head: HEAD_SHA }))
      launched.resolve()
      await released.promise
    })
    const logging = await import('../server/logging')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    logging.startLogging()
    try {
      const run = runtime.runEnabledBehaviorsOnce()
      await preparing.promise
      // Preparation pauses the work clock: the retained deadline must come
      // from that clock, rather than startedAt + the 55-second work budget.
      await vi.advanceTimersByTimeAsync(3_000)
      prepared.resolve()
      await launched.promise
      const claim = db.listBehaviorLaunchClaims('approve-prs')[0]!
      expect(claim.launchCorrelationId).toBe(fixture.agentLogs[0]!.correlation_id)
      await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_OPERATION_TIMEOUT_MS)
      released.resolve()
      await run

      const events = () => {
        logging.loggingRuntime()!.flush()
        return logging.loggingRuntime()!.query((store) => store.query({ workspace: logging.loggingWorkspace(), operator: false })).events
          .filter((event) => event.operation === 'application.behaviors')
      }
      expect(events()).toEqual([expect.objectContaining({
        severity: 'error', occurrences: 1, behavior: 'approve-prs', phase: 'launch', exitCode: null,
        message: 'The operation was aborted due to timeout',
        context: expect.objectContaining({ organization: 'Vaquum', deadline: startedAt + 58_000,
          exceptionName: 'TimeoutError', exceptionCode: 23,
          progress: { eligiblePrs: 11, checksPending: 1, changeChecksRead: 10, activityChecksRead: 1, launched: 1, publication: 'unverified' } }),
      })])
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      expect(runtime.getBehaviorsRuntimeHealth().busy).toEqual([])
      expect(runtime.getBehaviorsRuntimeHealth().failures).toContainEqual(expect.objectContaining({
        behavior: 'approve-prs', error: 'The operation was aborted due to timeout',
      }))
      const requests = () => mocks.runFile.mock.calls.filter(([command, args]) =>
        command === 'github-interface' && args[0] === '--requested-changes-addressed' && args.includes('--requests-json'))
        .flatMap(([, args]) => JSON.parse(args[args.indexOf('--requests-json') + 1]) as Array<{ number: number }>)
      expect(requests().some((request) => request.number === 27)).toBe(false)

      // The next sweep reconciles the original running Call. The unread PR
      // stays behind its existing retry gate until its next eligible sweep.
      const retryAt = Date.now() + 60_000
      db.setMeta(`behavior_approve_prs_failure:${pr.repo}#27:check`, JSON.stringify({
        kind: 'operation', consecutiveFailures: 1, lastFailureAtMs: Date.now(), nextRetryAtMs: retryAt, error: 'check timed out',
      }))
      await resetLogCache()
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      expect(requests().some((request) => request.number === 27)).toBe(false)
      expect(db.listBehaviorLaunchClaims('approve-prs')).toContainEqual(expect.objectContaining({
        claimId: claim.claimId, launchCorrelationId: claim.launchCorrelationId, launchCallId: callId,
      }))
      vi.setSystemTime(retryAt + 1)
      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached.mock.calls.map(([, args]) => args[1])).toEqual(['#17', '#27'])
      expect(db.listBehaviorLaunchClaims('approve-prs')).toContainEqual(expect.objectContaining({
        claimId: claim.claimId, launchCorrelationId: claim.launchCorrelationId, launchCallId: callId,
      }))
      expect(fixture.agentLogs).toEqual([expect.objectContaining({ id: callId, correlation_id: claim.claimId, status: 'running' })])
      expect(events()).toHaveLength(1)
    } finally {
      prepared.resolve()
      released.resolve()
      await logging.stopLogging()
    }
  })

  it('retains one actionable cycle failure when eligible work cannot be established', async () => {
    const { behaviors: runtime } = await startApproving([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'agent-interface' && args[0] === '--diagnostics') return {
        stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '',
      }
      if (command === 'github-datastore' && args[0] === 'view') throw new Error('eligible pull requests unreadable')
      return original(command, args, options)
    })
    const logging = await import('../server/logging')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    logging.startLogging()
    try {
      const { withNoticeDiagnosticIdentity } = await import('../server/logging-context')
      // A check-slot release can wake a sweep from an earlier PR's context.
      await withNoticeDiagnosticIdentity({ correlationId: 'c'.repeat(32), behavior: 'review-new-prs',
        target: `${pr.repo}#99`, repository: pr.repo, account: 'review-bot', phase: 'prior-work' },
      () => runtime.runEnabledBehaviorsOnce())
      logging.loggingRuntime()!.flush()
      const { events } = logging.loggingRuntime()!.query((store) => store.query({ workspace: logging.loggingWorkspace(), operator: false }))
      expect(events.filter((event) => event.operation === 'application.behaviors')).toEqual([expect.objectContaining({
        severity: 'error', occurrences: 1, behavior: 'approve-prs', phase: 'listing', message: 'eligible pull requests unreadable',
        context: expect.objectContaining({ organization: 'Vaquum', deadline: expect.any(Number),
          progress: { eligiblePrs: null, checksPending: null, changeChecksRead: 0, activityChecksRead: 0, launched: 0, publication: 'unverified' } }),
      })])
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
    } finally { await logging.stopLogging() }
  })

  it('keeps a timed-out activity read pending on the retained cycle failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'agent-interface' && args[0] === '--diagnostics') return {
        stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '',
      }
      const result = await original(command, args, options)
      if (command !== 'github-interface' || args[0] !== '--review-activity-since' || !args.includes('--requests-json')) return result
      const packet = JSON.parse(result.stdout)
      return { ...result, stdout: JSON.stringify({ ...packet,
        records: (packet.records as Array<Record<string, unknown>>).map((record) =>
          record.pull_number === 17
            ? { repository: record.repository, pull_number: 17, error: 'Command timed out after 30000ms: github-interface' }
            : record),
      }) }
    })
    const launched = deferred<void>(), released = deferred<void>()
    mocks.spawnDetached.mockImplementation(async (_command: string, args: string[]) => {
      if (args[1] !== '#18') return
      launched.resolve()
      await released.promise
    })
    const logging = await import('../server/logging')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    logging.startLogging()
    try {
      const run = runtime.runEnabledBehaviorsOnce()
      await launched.promise
      await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_OPERATION_TIMEOUT_MS)
      released.resolve()
      await run
      logging.loggingRuntime()!.flush()
      const { events } = logging.loggingRuntime()!.query((store) => store.query({ workspace: logging.loggingWorkspace(), operator: false }))
      expect(JSON.parse(db.getMeta(`behavior_approve_prs_failure:${pr.repo}#17:check`)!).error).toContain('timed out')
      expect(events.filter((event) => event.operation === 'application.behaviors'
        && event.message === 'The operation was aborted due to timeout')).toEqual([expect.objectContaining({
        severity: 'error', behavior: 'approve-prs', phase: 'launch',
        context: expect.objectContaining({
          progress: { eligiblePrs: 2, checksPending: 1, changeChecksRead: 2, activityChecksRead: 1, launched: 1, publication: 'unverified' } }),
      })])
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    } finally {
      released.resolve()
      await logging.stopLogging()
    }
  })

  it('keeps a launch-preparation failure on its PR claim instead of the cycle', async () => {
    const { database: db, behaviors: runtime } = await startApproving([pr])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'agent-interface' && args[0] === '--diagnostics') return {
        stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '',
      }
      return original(command, args, options)
    })
    const { prepareModelClis } = await import('../server/provider-clis')
    vi.mocked(prepareModelClis).mockRejectedValueOnce(new Error('provider preparation failed'))
    const logging = await import('../server/logging')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    logging.startLogging()
    try {
      await runtime.runEnabledBehaviorsOnce()
      logging.loggingRuntime()!.flush()
      const { events } = logging.loggingRuntime()!.query((store) => store.query({ workspace: logging.loggingWorkspace(), operator: false }))
      const stored = JSON.parse(db.getMeta(`behavior_approve_prs_failure:${pr.repo}#17:check`)!)
      expect(stored.error).toContain('provider preparation failed')
      const diagnostic = events.find((event) => event.operation === 'application.behaviors' && event.message.includes('provider preparation failed'))
      expect(diagnostic).toMatchObject({
        behavior: 'approve-prs', target: `${pr.repo}#17`, correlationId: stored.correlationId,
      })
      const { behaviorEvidence } = await import('../server/notification-evidence')
      const joined = await behaviorEvidence({ failures: [{ behavior: 'approve-prs', target: `${pr.repo}#17:check`, error: stored.error, correlationId: stored.correlationId }], deadLetters: [] })
      expect((joined.failures[0] as { evidenceStatus?: string })?.evidenceStatus).toBe('retained')
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
    } finally { await logging.stopLogging() }
  })

  it('still fires prepared approvals when a slow check pushes the sweep past its deadline, and resumes the rest next pass', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const open = Array.from({ length: 12 }, (_, index) => ({
      ...pr, number: 17 + index, url: `https://github.com/${pr.repo}/pull/${17 + index}`,
    }))
    const { behaviors: runtime } = await startApproving(open)
    openLaunchBudget(runtime)
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

  it.each(['changed', 'unavailable', 'malformed'] as const)('records a %s head read after the sweep deadline', async (headRead) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr, secondPr])
    const original = mocks.runFile.getMockImplementation()!
    const fire = deferred<void>()
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--head-sha' && String(args[1]) === '#18') {
        fire.resolve()
        // The launch lookup settles after the sweep deadline; its outcome
        // must still be recorded under the lifecycle signal.
        await new Promise<void>((resolve) => setTimeout(resolve, 57_000))
        if (headRead === 'unavailable') throw new Error('head lookup unavailable')
        return {
          stdout: JSON.stringify({ action: 'head_sha', repository: secondPr.repo, pull_number: 18,
            head_sha: headRead === 'changed' ? NEXT_HEAD_SHA : 'not-a-sha' }),
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
    const failure = db.getMeta(`behavior_approve_prs_failure:${secondPr.repo}#18:check`)
    if (headRead === 'changed') {
      expect(failure).toBeNull()
      const admission = mocks.captureAdmission.mock.calls.find(([input]) => input.number === 18)![0]
      expect(mocks.captureOutcome).toHaveBeenCalledWith({
        nativeId: admission.nativeId, state: 'superseded', activity: 'settled', stateSource: 'native',
        outcome: 'superseded', completedAt: expect.any(String),
      })
    } else {
      const stored = JSON.parse(failure!)
      expect(stored.error).toContain(headRead === 'unavailable' ? 'head lookup unavailable' : '--head-sha returned malformed state')
      expect(stored.consecutiveFailures).toBe(1)
      expect(stored.nextRetryAtMs - stored.lastFailureAtMs).toBe(60_000)
      expect(mocks.captureOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'superseded' }))
    }
  })

  it('retries a quota-exhausted check at the reset instead of the hour-long backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr])
    const original = mocks.runFile.getMockImplementation()!
    failAddressedRecord(original, () => {
      return new Error('github-interface --requested-changes-addressed returned malformed state')
    })

    // Three hard failures build the count, so the quota failure below lands
    // on an eight-minute backoff under the old clock.
    const key = `behavior_approve_prs_failure:${pr.repo}#17:check`
    for (let attempt = 0; attempt < 3; attempt++) {
      await runtime.runEnabledBehaviorsOnce()
      const stored = JSON.parse(db.getMeta(key)!)
      vi.setSystemTime(new Date(stored.nextRetryAtMs + 1))
    }

    let reset = 0
    failAddressedRecord(original, () => {
      reset = Math.floor(Date.now() / 1000) + 120
      return cliFailure(quotaExhaustedStderr(reset))
    })
    await runtime.runEnabledBehaviorsOnce()
    const stored = JSON.parse(db.getMeta(key)!)
    expect(stored.consecutiveFailures).toBe(4)
    expect(stored.nextRetryAtMs).toBe(reset * 1000)

    // No check runs before the reset; the first tick after it approves.
    const calls = addressedCalls().length
    vi.setSystemTime(new Date(reset * 1000 - 1000))
    await runtime.runEnabledBehaviorsOnce()
    expect(addressedCalls()).toHaveLength(calls)
    mocks.runFile.mockImplementation(original)
    vi.setSystemTime(new Date(reset * 1000 + 1))
    await runtime.runEnabledBehaviorsOnce()
    expect(addressedCalls()).toHaveLength(calls + 1)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0]?.[1]).toContain('#17')
  })

  it('holds a quota-exhausted check until a distant reset instead of retrying inside the blocked window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr])
    const original = mocks.runFile.getMockImplementation()!
    let reset = 0
    failAddressedRecord(original, () => {
      reset = Math.floor(Date.now() / 1000) + 3000
      return cliFailure(quotaExhaustedStderr(reset))
    })

    await runtime.runEnabledBehaviorsOnce()
    const key = `behavior_approve_prs_failure:${pr.repo}#17:check`
    const stored = JSON.parse(db.getMeta(key)!)
    expect(stored.consecutiveFailures).toBe(1)
    expect(stored.nextRetryAtMs).toBe(reset * 1000)

    const calls = addressedCalls().length
    vi.setSystemTime(new Date(reset * 1000 - 60_000))
    await runtime.runEnabledBehaviorsOnce()
    expect(addressedCalls()).toHaveLength(calls)
    mocks.runFile.mockImplementation(original)
    vi.setSystemTime(new Date(reset * 1000 + 1))
    await runtime.runEnabledBehaviorsOnce()
    expect(addressedCalls()).toHaveLength(calls + 1)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0]?.[1]).toContain('#17')
  })

  it('retries a non-exhausted 403 on backoff instead of its distant reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr])
    const original = mocks.runFile.getMockImplementation()!
    failAddressedRecord(original, () => {
      const reset = Math.floor(Date.now() / 1000) + 3600
      return cliFailure(`error: GitHub 403 rate-limit: {'x-ratelimit-resource': 'core', `
        + `'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '${reset}'} body={\n`
        + `\t"message": "Resource not accessible by integration.",\n\t"status": "403"\n}`)
    })

    await runtime.runEnabledBehaviorsOnce()
    const key = `behavior_approve_prs_failure:${pr.repo}#17:check`
    const stored = JSON.parse(db.getMeta(key)!)
    expect(stored.consecutiveFailures).toBe(1)
    expect(stored.nextRetryAtMs - stored.lastFailureAtMs).toBe(60_000)

    mocks.runFile.mockImplementation(original)
    vi.setSystemTime(new Date(stored.nextRetryAtMs + 1))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0]?.[1]).toContain('#17')
  })

  it('retries a quota error with a past reset no sooner than a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await startApproving([pr])
    const original = mocks.runFile.getMockImplementation()!
    failAddressedRecord(original, () => {
      return new Error('github-interface --requested-changes-addressed returned malformed state')
    })

    const key = `behavior_approve_prs_failure:${pr.repo}#17:check`
    await runtime.runEnabledBehaviorsOnce()
    const first = JSON.parse(db.getMeta(key)!)
    expect(first.nextRetryAtMs - first.lastFailureAtMs).toBe(60_000)
    vi.setSystemTime(new Date(first.nextRetryAtMs + 1))

    failAddressedRecord(original, () => {
      return cliFailure(quotaExhaustedStderr(Math.floor(Date.now() / 1000) - 30))
    })
    await runtime.runEnabledBehaviorsOnce()
    const stored = JSON.parse(db.getMeta(key)!)
    expect(stored.consecutiveFailures).toBe(2)
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
