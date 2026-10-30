import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, loadModules, restartModules, arrangeCli, datastoreHealthOutput, fixture } from './behaviors-runtime-fixture'

describe('scan health and dependency recovery', () => {

  it('preserves stale health evidence from exit 1, blocks work and recovers without resetting claims', async () => {
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime()
    const stdout = JSON.stringify({
      action: 'health', status: 'stale', healthy: false, database: '/legacy/github.sqlite',
      max_age_seconds: 120, age_seconds: 3600, last_success_at: '2026-10-02T12:46:25Z',
    })
    mocks.runFile.mockRejectedValue(Object.assign(new Error('Command failed (1): github-datastore'), { code: 1, stdout, stderr: '' }))
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'degraded', datastore: { status: 'unavailable', ageSeconds: 3600,
        lastSuccessAt: '2026-10-02T12:46:25Z', error: expect.stringContaining('Datastore stale') },
      failures: [{ error: expect.stringContaining('age 3600s exceeds 120s') }],
    })
    expect(mocks.runFile).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    arrangeCli(false)
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [], datastore: { status: 'healthy' } })
  })

  it('never accepts healthy output from a command that failed', async () => {
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime()
    mocks.runFile.mockRejectedValue(Object.assign(new Error('Command failed (1): github-datastore'), {
      code: 1, ...datastoreHealthOutput(),
    }))
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getBehaviorsRuntimeHealth().datastore.status).toBe('unavailable')
    expect(mocks.runFile).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('retries a failed scan immediately so dependency recovery clears health', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    mocks.runFile.mockRejectedValue(new Error('502 Bad Gateway'))
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime()

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile).toHaveBeenCalledOnce()
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'degraded',
      failures: [{
        behavior: 'resolve-unblocking',
        kind: 'operation',
        consecutiveFailures: 1,
        lastFailureAt: '2026-07-15T12:00:00.000Z',
        nextRetryAt: '2026-07-15T12:01:00.000Z',
      }],
    })

    arrangeCli(false)
    await runtime.runEnabledBehaviorsOnce()

    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'ok',
      failures: [],
    })
  })

  it.each(['review-new-prs', 'approve-prs', 'resolve-unblocking'] as const)(
    'isolates %s eligibility errors through restart and clears them after a successful no-op',
    async (behavior) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-02T12:00:00Z'))
      fixture.listedPrs = [pr, { ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` }]
      arrangeCli(behavior === 'approve-prs', false, behavior === 'resolve-unblocking'
        ? {
            unresolvedConversationCount: 1,
            reviewerLatestState: 'APPROVED',
            reviewerLatestCommit: HEAD_SHA,
            activeChangeRequestAuthors: [],
          }
        : { unresolvedConversationCount: 0 })
      const original = mocks.runFile.getMockImplementation()!
      const check = behavior === 'resolve-unblocking' ? '--review-activity-since' : '--requested-changes-addressed'
      mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
        // A per-action refusal, not a repository denial: a 404 here would hold
        // the repository both pull requests share instead of isolating #17.
        if (command === 'github-interface' && args[0] === check && args[1] === '#17') throw new Error('GitHub 403: Must have admin rights to Repository.')
        if (command === 'github-interface' && args[0] === check && args.includes('--requests-json')) {
          const packet = JSON.parse((await original(command, args, options)).stdout)
          return {
            stdout: JSON.stringify({
              ...packet,
              records: (packet.records as Array<Record<string, unknown>>).map((record) =>
                record.pull_number === 17
                  ? { repository: record.repository, pull_number: 17, error: 'GitHub 403: Must have admin rights to Repository.' }
                  : record),
            }),
            stderr: '',
          }
        }
        return original(command, args, options)
      })
      let modules = await loadModules()
      modules.behaviors.startBehaviorsRuntime()
      modules.database.setMeta('me', 'poise-user')
      modules.database.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
      modules.database.setMeta('behavior_review_new_prs_keyver', '3')
      modules.database.recordSeen('review-new-prs', '__snapshot_v3__')
      await modules.behaviors.runEnabledBehaviorsOnce()
      expect(modules.behaviors.getBehaviorsRuntimeHealth()).toMatchObject({
        status: 'ok', running: true,
        failures: [{ behavior, kind: 'operation', target: `${pr.repo}#17:check`, consecutiveFailures: 1, error: 'GitHub 403: Must have admin rights to Repository.', nextRetryAt: '2026-10-02T12:01:00.000Z' }],
      })
      if (behavior === 'resolve-unblocking') {
        expect(mocks.runFile.mock.calls.some(([, args]) => args[0] === '--resolve-nonblocking-conversations-if-ready' && args[1] === '#18')).toBe(true)
      } else {
        expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      }
      await modules.behaviors.runEnabledBehaviorsOnce()
      modules = await restartModules()
      modules.behaviors.startBehaviorsRuntime()
      await modules.behaviors.runEnabledBehaviorsOnce()
      const attempts = mocks.runFile.mock.calls.filter(([, args]) => args[0] === check
        && (args[1] === '#17' || (args.includes('--requests-json')
          && (JSON.parse(args[args.indexOf('--requests-json') + 1]) as Array<{ number: number }>)
            .some((request) => request.number === 17))))
      expect(attempts).toHaveLength(1)
      // Recovery may prove no action is needed; that still clears the check error.
      arrangeCli(behavior === 'review-new-prs')
      vi.setSystemTime(Date.now() + 60_000)
      await modules.behaviors.runEnabledBehaviorsOnce()
      expect(modules.behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [] })
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(behavior === 'resolve-unblocking' ? 0 : 1)
    },
  )

  it('persists a useful cause for a multiline approve-prs check failure through restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'))
    arrangeCli(true)
    const original = mocks.runFile.getMockImplementation()!
    const stderr = 'error: GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', '
      + '\'x-ratelimit-reset\': \'1800000000\'} body={\n\t"message": "API rate limit exceeded for user ID 42.",\n\t"status": "403"\n}'
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed') {
        throw Object.assign(new Error('Command failed (1): github-interface'), { code: 1, stdout: '', stderr })
      }
      return original(command, args, options)
    })
    let modules = await loadModules()
    modules.behaviors.startBehaviorsRuntime()
    modules.database.setMeta('me', 'poise-user')
    modules.database.setMeta('behavior_approve_prs_enabled', '1')
    modules.database.setMeta('behavior_review_new_prs_keyver', '3')
    modules.database.recordSeen('review-new-prs', '__snapshot_v3__')
    await modules.behaviors.runEnabledBehaviorsOnce()
    const failure = { behavior: 'approve-prs', kind: 'operation', target: `${pr.repo}#17:check`, consecutiveFailures: 1,
      error: 'Command failed (1): github-interface: GitHub 403 rate-limit '
        + '{\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', \'x-ratelimit-reset\': \'1800000000\'}: '
        + 'API rate limit exceeded for user ID 42.',
      diagnostic: { severity: 'info', code: 'rate_limit' }, nextRetryAt: '2026-10-02T12:01:00.000Z' }
    expect(modules.behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', running: true, failures: [failure] })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ failures: [failure] })
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--requested-changes-addressed')).toHaveLength(1)
    arrangeCli(false)
    vi.setSystemTime(Date.now() + 60_000)
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.behaviors.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [] })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('isolates a missing checkout during %s without blocking another repository', async (behavior) => {
    fixture.listedPrs = [pr, { ...pr, repo: 'Vaquum/healthy', number: 18, url: 'https://github.com/Vaquum/healthy/pull/18' }]
    arrangeCli(behavior === 'approve-prs')
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && args[0] === '--local-checkout-path' && args[2] === 'poise-test') throw new Error('checkout unavailable')
      return original(command, args, options)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.listBehaviorLaunchClaims(behavior)).toMatchObject([{ launchRepo: 'Vaquum/healthy', launchPr: 18 }])
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'ok', failures: [{ behavior, kind: 'operation', target: `${pr.repo}#17:check`, error: 'checkout unavailable' }],
    })
  })

  it.each(['review-new-prs', 'approve-prs', 'resolve-unblocking'] as const)('preserves %s check history while another operation owns the PR', async (behavior) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'))
    arrangeCli(behavior === 'approve-prs', false, behavior === 'resolve-unblocking'
      ? {
          unresolvedConversationCount: 1,
          reviewerLatestState: 'APPROVED',
          reviewerLatestCommit: HEAD_SHA,
          activeChangeRequestAuthors: [],
        }
      : { unresolvedConversationCount: 0 })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    const failureKey = `behavior_${behavior.replace(/-/g, '_')}_failure:${pr.repo}#17:check`
    const failure = JSON.stringify({ kind: 'operation', consecutiveFailures: 2, lastFailureAtMs: Date.now() - 120_000, nextRetryAtMs: Date.now() - 1, error: 'previous check failed' })
    db.setMeta(failureKey, failure)
    const blocker = db.claimPrOperationOwned(`${pr.repo}#17`, 65_000)!
    const claim = vi.spyOn(db, 'claimPrOperationOwned')
    const cycle = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(claim).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(10_100)
    await cycle
    expect(db.getMeta(failureKey)).toBe(failure)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    db.releasePrOperationOwned(blocker)
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && args[0] === (behavior === 'resolve-unblocking' ? '--review-activity-since' : '--requested-changes-addressed')) throw new Error('check still failing')
      return original(command, args, options)
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(JSON.parse(db.getMeta(failureKey)!)).toMatchObject({ consecutiveFailures: 3, error: 'check still failing', nextRetryAtMs: Date.now() + 240_000 })
  })

  it('clears an approval check diagnostic without resetting its worker retry', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    const state = { kind: 'operation', consecutiveFailures: 2, lastFailureAtMs: Date.now() - 120_000, nextRetryAtMs: Date.now() - 1 }
    const prefix = 'behavior_approve_prs_failure'
    const workerTarget = `${pr.repo}#17@head=${HEAD_SHA}`
    db.setMeta(`${prefix}:${pr.repo}#17:check`, JSON.stringify(state))
    const workerFailure = JSON.stringify({ ...state, kind: 'worker', nextRetryAtMs: Date.now() + 60_000 })
    db.setMeta(`${prefix}:${workerTarget}`, workerFailure)
    await runtime.runEnabledBehaviorsOnce()
    expect(db.getMeta(`${prefix}:${pr.repo}#17:check`)).toBe('')
    expect(db.getMeta(`${prefix}:${workerTarget}`)).toBe(workerFailure)
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({ status: 'ok', failures: [{ target: workerTarget, kind: 'worker', consecutiveFailures: 2 }] })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('treats a typed resolver head supersession as a safe no-op', async () => {
    arrangeCli(false, false, {
      resolveSuperseded: true,
      unresolvedConversationCount: 1,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
      activeChangeRequestAuthors: [],
    })
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime()

    await runtime.runEnabledBehaviorsOnce()

    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'ok',
      failures: [],
    })
    expect(runtime.getResolveUnblockingLastFired()).toBeNull()
  })

  it('logs the exact resolver blockers for unresolved conversations', async () => {
    arrangeCli(false, false, {
      resolveUnresolvedCount: 1,
      unresolvedConversationCount: 1,
      resolveBlockers: ['commit_status_failed'],
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
      activeChangeRequestAuthors: [],
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime()

    await runtime.runEnabledBehaviorsOnce()

    expect(log).toHaveBeenCalledWith(
      `[behaviors] resolve-unblocking waiting on ${pr.repo}#${pr.number}: commit_status_failed`,
    )
  })

  it('clears a recovered scan failure when the scan launches a worker', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.setMeta('behavior_review_new_prs_failure', JSON.stringify({
      kind: 'operation',
      consecutiveFailures: 4,
      lastFailureAtMs: Date.now(),
      nextRetryAtMs: Date.now() + 3_600_000,
    }))

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('preserves an existing breaker when shutdown aborts a behavior scan', async () => {
    mocks.runFile.mockImplementation(async (
      _command: string,
      _args: string[],
      options?: { signal?: AbortSignal },
    ) => await new Promise((_, reject) => {
      const signal = options?.signal
      if (!signal) return reject(new Error('missing operation signal'))
      const onAbort = () => reject(signal.reason)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }))
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    db.setMeta('behavior_resolve_unblocking_failure', JSON.stringify({
      kind: 'operation',
      consecutiveFailures: 2,
      lastFailureAtMs: Date.now() - 120_000,
      nextRetryAtMs: Date.now() - 1,
    }))
    runtime.startBehaviorsRuntime()

    const cycle = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.runFile).toHaveBeenCalledOnce())
    await runtime.stopBehaviorsRuntime()
    await cycle

    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({
        behavior: 'resolve-unblocking',
        kind: 'operation',
        consecutiveFailures: 2,
      }),
    ])
  })
})
