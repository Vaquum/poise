import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CheckSemaphore } from '../server/check-semaphore'
import { behaviorDiagnosticGroups } from '../src/behavior-diagnostics'
import type { BehaviorDiagnostics } from '../src/behaviors'
import { mocks, pr, HEAD_SHA, loadModules, arrangeCli, fixture, deferred, agentLog, resetLogCache, datastoreHealthOutput } from './behaviors-runtime-fixture'

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

  it.each(['preparation', 'owned', 'launch', 'missing', 'conflicting', 'uncertain writes', 'unreadable', 'unscheduled'])(
    'retains sweep deadline progress with %s evidence and resumes owned work on the scheduled tick', async (evidence) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
      const startedAt = Date.now()
      const open = evidence === 'preparation' ? [pr] : [pr, secondPr]
      const { database: db, behaviors: runtime } = await startReviewing(open)
      if (evidence === 'unscheduled') await runtime.stopBehaviorsRuntime()
      let releasePeer: (() => void) | undefined
      if (evidence === 'launch') {
        const slots = new CheckSemaphore(() => 3)
        runtime.setBehaviorCheckSlots(slots)
        releasePeer = slots.tryAcquire('behavior') ?? undefined
        expect(releasePeer).toBeTypeOf('function')
      }
      const betaPr = { ...pr, repo: 'beta/poise-test', number: 19, url: 'https://github.com/beta/poise-test/pull/19' }
      const betaPath = join(fixture.tempRoot, 'beta.sqlite')
      if (evidence === 'owned') {
        db.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
          VALUES ('beta', ?, 1, 'ready', 'ready', 'poise-user')`).run(betaPath)
        db.recordSeen('review-new-prs', '__snapshot_v3__:org:beta')
      }
      const original = mocks.runFile.getMockImplementation()!
      const slowEntered = deferred<void>(), fastPrepared = deferred<void>(), betaLaunched = deferred<void>()
      let timedOut = false
      mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
        if (command === 'agent-interface' && args[0] === '--diagnostics') return {
          stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '',
        }
        if (command === 'agent-interface' && args[0] === '--logs' && timedOut && evidence === 'unreadable'
          && mocks.spawnDetached.mock.calls.length > 0) {
          throw new Error('launch evidence unreadable')
        }
        if (command === 'github-datastore' && args[0] === '--db') {
          if (args[2] !== 'health') return { stdout: JSON.stringify([betaPr]), stderr: '' }
          const result = datastoreHealthOutput()
          return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), database: betaPath }) }
        }
        if (evidence !== 'launch' && !timedOut && command === 'github-interface' && args[0] === '--head-sha' && String(args[1]) === '#17') {
          slowEntered.resolve()
          const signal = (options as { signal?: AbortSignal } | undefined)?.signal
          if (signal?.aborted) throw signal.reason
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
        const result = await original(command, args, options)
        if (command === 'github-interface' && args[0] === '--requested-changes-addressed'
          && String(args[1]) === '#18') {
          fastPrepared.resolve()
        }
        return result
      })
      const preparing = deferred<void>(), prepared = deferred<void>(), resumed = deferred<void>()
      const firstLaunch = deferred<void>(), releaseLaunch = deferred<void>()
      const { prepareModelClis } = await import('../server/provider-clis')
      vi.mocked(prepareModelClis).mockImplementationOnce(async () => {
        preparing.resolve(); await prepared.promise; return {}
      })
      const callId = 'b'.repeat(32)
      mocks.spawnDetached.mockImplementation(async (_command: string, args: string[]) => {
        const beta = args[1] === '#19'
        const call = agentLog({ id: beta ? 'c'.repeat(32) : args[1] === '#17' ? 'd'.repeat(32) : callId,
          repo: beta ? betaPr.repo : pr.repo, pr_id: args[1].slice(1),
          correlation_id: args[args.indexOf('--correlation-id') + 1],
          ...(evidence === 'uncertain writes' ? { status: 'failed', error: 'publication outcome uncertain', review_id: 91 } : {}) })
        if (evidence !== 'missing') fixture.agentLogs.push(call)
        if (evidence === 'conflicting') fixture.agentLogs.push({ ...call, id: 'e'.repeat(32) })
        if (beta) betaLaunched.resolve()
        if (evidence === 'launch' ? mocks.spawnDetached.mock.calls.length === 2 : args[1] === '#17') resumed.resolve()
        if (evidence === 'launch') { firstLaunch.resolve(); await releaseLaunch.promise }
      })
      const logging = await import('../server/logging')
      vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      logging.startLogging()
      try {
        const run = runtime.withBehaviorOrganization('Vaquum', () => runtime.runEnabledBehaviorsOnce())
        await preparing.promise
        // Provider preparation moves the effective work deadline by three seconds.
        await vi.advanceTimersByTimeAsync(3_000)
        prepared.resolve()
        if (evidence !== 'launch') await slowEntered.promise
        if (open.length > 1) await fastPrepared.promise
        if (evidence === 'launch') await firstLaunch.promise
        if (evidence === 'owned') {
          const other = runtime.withBehaviorOrganization('beta', () => runtime.runEnabledBehaviorsOnce())
          await betaLaunched.promise
          await other
          expect(mocks.spawnDetached.mock.calls.map(([, args]) => args[1])).toEqual(['#19'])
        }
        const pump = () => new Promise<void>((resolve) => setImmediate(resolve))
        for (let i = 0; i < 20; i++) await pump()
        timedOut = true
        await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_OPERATION_TIMEOUT_MS)
        releaseLaunch.resolve()
        await run

        const claim = db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.launchRepo === pr.repo)
        const originalCallId = evidence === 'launch' && claim?.launchPr === 17 ? 'd'.repeat(32) : callId
        logging.loggingRuntime()!.flush()
        const { events } = logging.loggingRuntime()!.query((store) => store.query({ workspace: logging.loggingWorkspace(), operator: false }))
        const proven = evidence === 'owned' || evidence === 'launch'
        const launched = evidence === 'unscheduled' ? 0 : open.length - 1
        expect(events.filter((event) => event.operation === 'application.behaviors')).toEqual([expect.objectContaining({
          severity: proven ? 'warning' : 'error', occurrences: 1, behavior: 'review-new-prs', phase: evidence === 'launch' ? 'launch' : 'preparation',
          target: null, repository: null, account: null, exitCode: null, message: 'The operation was aborted due to timeout',
          context: expect.objectContaining({ organization: 'Vaquum', deadline: startedAt + 58_000,
            exceptionName: 'TimeoutError', exceptionCode: 23,
            progress: expect.objectContaining({ eligiblePrs: open.length, checksPending: evidence === 'launch' ? 0 : 1,
              prepared: evidence === 'launch' ? 2 : open.length - 1, launched, publication: 'unverified',
              cursor: `${pr.repo}#${open.length > 1 ? 18 : 17}`, disposition: proven ? 'deferred' : 'unresolved',
              continuationAt: evidence === 'unscheduled' ? null : startedAt + 60_000,
              ownershipError: evidence === 'unreadable' ? 'launch evidence unreadable' : null,
              launches: claim ? [expect.objectContaining({ target: claim.target, claimId: claim.claimId,
                correlationId: claim.launchCorrelationId, expectedHead: HEAD_SHA,
                callId: evidence === 'missing' || evidence === 'unreadable' ? null
                  : evidence === 'conflicting' ? expect.stringMatching(/^(b{32}|e{32})$/) : originalCallId,
                ownership: proven || evidence === 'unscheduled' ? 'owned' : 'unresolved' })] : [] }) }),
        })])
        const sweep = runtime.getBehaviorsRuntimeHealth().failures
          .find((failure) => failure.behavior === 'review-new-prs' && !failure.target)
        expect(sweep?.error).toMatch(/aborted due to timeout/)
        expect(mocks.spawnDetached).toHaveBeenCalledTimes(launched + (evidence === 'owned' ? 1 : 0))
        if (!proven) return

        // The real ticker must reconcile the original Call and reconsider the unfinished PR.
        await resetLogCache()
        if (evidence === 'launch') {
          await vi.advanceTimersByTimeAsync(1_500)
          releasePeer!()
          await vi.advanceTimersByTimeAsync(500)
        } else await vi.advanceTimersByTimeAsync(2_000)
        await resumed.promise
        await vi.advanceTimersByTimeAsync(5_000)
        await vi.waitFor(() => expect(runtime.getBehaviorsRuntimeHealth().busy).toEqual([]))
        expect(mocks.spawnDetached.mock.calls.map(([, args]) => args[1]).sort())
          .toEqual(evidence === 'owned' ? ['#17', '#18', '#19'] : ['#17', '#18'])
        expect(db.listBehaviorLaunchClaims('review-new-prs')).toContainEqual(expect.objectContaining({
          claimId: claim!.claimId, launchCorrelationId: claim!.launchCorrelationId, launchCallId: originalCallId,
        }))
        expect(db.getMeta('behavior_review_new_prs_failure')).toBe('')
      } finally {
        prepared.resolve()
        releaseLaunch.resolve()
        releasePeer?.()
        await logging.stopLogging()
      }
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
