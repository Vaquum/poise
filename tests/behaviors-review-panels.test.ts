import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, loadModules, restartModules, resetLogCache, arrangeCli, agentLog, launchReviewBeforeCrash, launchApprovalBeforeCrash, fixture } from './behaviors-runtime-fixture'

describe('review panel scheduling and recovery', () => {

  it('reviews a new pull request with every reviewer Behaviors asks for, at once', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_reviewers', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    // Three launches for one head, at once — each its own claim with its own model.
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    const launches = mocks.spawnDetached.mock.calls.map((call) => call[1] as string[])
    expect(launches.map((args) => args[args.indexOf('--model') + 1]).sort()).toEqual(['gpt-6-astra-ultra', 'grok-4.6-xhigh', 'opus-5-xhigh'])
    expect(new Set(launches.map((args) => args[args.indexOf('--correlation-id') + 1])).size).toBe(3)
    const admissions = mocks.captureAdmission.mock.calls.map(([admission]) => admission)
    expect(admissions).toHaveLength(3)
    expect(new Set(admissions.map(({ admissionKey }) => admissionKey)).size).toBe(1)
    expect(new Set(admissions.map(({ nativeId }) => nativeId)).size).toBe(3)
    expect(admissions.every(({ plannedSlots }) => plannedSlots.join(',') === 'primary,secondary,tertiary')).toBe(true)
    for (const args of launches) {
      expect(args).toEqual(expect.arrayContaining(['--pr-review', `#${pr.number}`, '--expected-head', HEAD_SHA, '--source', 'poise:review-new-prs']))
    }
    const key = `${pr.repo}#${pr.number}`
    expect(db.listSeenTargets('review-new-prs').sort()).toEqual([key, `${key}:secondary`, `${key}:tertiary`, '__snapshot_v3__'].sort())

    // Nothing more on the next tick, and a wider panel later never revisits
    // a pull request the primary already handled.
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('isolates a %s max-turns failure while fresh work runs in the same cycle', async (behavior) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T06:00:00.000Z'))
    const launched = behavior === 'review-new-prs'
      ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'e'.repeat(32), behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      model: 'opus-5-xhigh',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed', error: 'max turns reached',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })]
    await resetLogCache()
    fixture.listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()

    await runtime.runEnabledBehaviorsOnce()

    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({ behavior, target: launched.target, error: 'max turns reached' }),
    ])
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
    expect(db.hasSeen(behavior, launched.target)).toBe(true)
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'ok',
      failures: [{ behavior, target: launched.target, kind: 'worker', error: 'max turns reached' }],
    })

    // Independent success must neither erase this retry delay nor extend it.
    await runtime.runEnabledBehaviorsOnce()
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS - 1))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    vi.setSystemTime(new Date(Date.now() + 1))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(mocks.spawnDetached.mock.calls[2][1]).toContain('#17')
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('ignores a persisted legacy %s worker cooldown after restart', async (behavior) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T06:00:00.000Z'))
    arrangeCli(behavior === 'approve-prs')
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: initial } = await loadModules()
    initial.setMeta('me', 'poise-user')
    initial.setMeta('behavior_review_new_prs_keyver', '3')
    initial.recordSeen('review-new-prs', '__snapshot_v3__')
    const prefix = behavior === 'review-new-prs' ? 'behavior_review_new_prs' : 'behavior_approve_prs'
    initial.setMeta(`${prefix}_enabled`, '1')
    initial.setMeta(`${prefix}_failure`, JSON.stringify({
      kind: 'worker', consecutiveFailures: 6,
      lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 3_600_000,
      error: 'unrelated old worker exhausted its turns',
    }))
    const { behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('#17')
  })

  it('records a completed sibling while the failed reviewer is waiting to retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T06:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_reviewers', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    const key = `${pr.repo}#${pr.number}`
    const claims = db.listBehaviorLaunchClaims('review-new-prs')
    fixture.agentLogs = claims.map((claim, index) => agentLog({
      id: String(index + 1).repeat(32),
      model: claim.target.endsWith(':tertiary') ? 'grok-4.6-xhigh' : claim.target.endsWith(':secondary') ? 'gpt-6-astra-ultra' : 'opus-5-xhigh',
      started_at: claim.launchRequestedAt, started_at_precise: claim.launchRequestedAt,
      expected_head: claim.launchExpectedHead, actor: claim.launchActor,
      source: claim.launchSource, correlation_id: claim.launchCorrelationId,
      ...(claim.target.endsWith(':tertiary') ? { status: 'failed', error: 'max turns reached' } : {}),
    }))
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({ target: `${key}:tertiary`, error: 'max turns reached' }),
    ])

    const secondary = fixture.agentLogs.find(row => row.model === 'gpt-6-astra-ultra')!
    Object.assign(secondary, {
      status: 'completed', completed_at: new Date().toISOString(),
      action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA, review_id: 91,
    })
    await resetLogCache()
    arrangeCli(false, false, { reviewerReviewIdsSince: [91] })
    await runtime.runEnabledBehaviorsOnce()

    expect(db.db.prepare(`
      SELECT claim_id, launch_outcome FROM behavior_seen
      WHERE key = 'review-new-prs' AND target = ?
    `).get(`${key}:secondary`)).toEqual({ claim_id: '', launch_outcome: 'clean' })
    expect(db.listBehaviorLaunchClaims('review-new-prs').map(claim => claim.target)).toEqual([key])
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
  })

  it('runs non-Claude panel members while Claude is unavailable and resumes only its missing slot', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_reviewers', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.authStatus = 'reauth_required'
    runtime.startBehaviorsRuntime()

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    const models = mocks.spawnDetached.mock.calls.map((call) => { const args = call[1] as string[]; return args[args.indexOf('--model') + 1] })
    expect(models.sort()).toEqual(['gpt-6-astra-ultra', 'grok-4.6-xhigh'])
    expect(db.hasSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(false)
    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    const resumed = mocks.spawnDetached.mock.calls[2][1] as string[]
    expect(resumed[resumed.indexOf('--model') + 1]).toBe('opus-5-xhigh')
  })

  it('resumes an admitted Claude secondary after the primary completes and a restart without widening the old panel', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T06:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    let modules = await loadModules()
    modules.database.setMeta('me', 'poise-user')
    modules.database.setMeta('behavior_review_new_prs_keyver', '3')
    modules.database.setMeta('behavior_review_new_prs_enabled', '1')
    modules.database.setMeta('behavior_review_new_prs_reviewers', '2')
    modules.database.setMeta('models', JSON.stringify({ pr_review: {
      default: 'gpt-6-astra-ultra', fallback: 'grok-4.6-xhigh',
      secondary: 'opus-5-xhigh', tertiary: 'grok-4.6-xhigh',
    } }))
    modules.database.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.authStatus = 'reauth_required'
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    const primary = modules.database.listBehaviorLaunchClaims('review-new-prs')[0]
    const completed = (claim: typeof primary, id: string, model: string) => agentLog({
      id, model, started_at: claim.launchRequestedAt, started_at_precise: claim.launchRequestedAt,
      expected_head: claim.launchExpectedHead, actor: claim.launchActor,
      source: claim.launchSource, correlation_id: claim.launchCorrelationId,
      status: 'completed', completed_at: new Date().toISOString(),
      action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA,
    })
    fixture.agentLogs = [completed(primary, '1'.repeat(32), 'gpt-6-astra-ultra')]
    await resetLogCache()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.listBehaviorLaunchClaims('review-new-prs')).toEqual([])
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    modules = await restartModules()
    mocks.authStatus = 'authenticated'
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    const secondaryArgs = mocks.spawnDetached.mock.calls[1][1] as string[]
    expect(secondaryArgs[secondaryArgs.indexOf('--model') + 1]).toBe('opus-5-xhigh')
    const secondary = modules.database.listBehaviorLaunchClaims('review-new-prs')[0]
    expect(secondary.target).toBe(`${pr.repo}#${pr.number}:secondary`)
    fixture.agentLogs.push(completed(secondary, '2'.repeat(32), 'opus-5-xhigh'))
    await resetLogCache()
    await modules.behaviors.runEnabledBehaviorsOnce()
    modules.database.setMeta('behavior_review_new_prs_reviewers', '3')
    await modules.behaviors.runEnabledBehaviorsOnce()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(modules.database.hasSeen('review-new-prs', `${pr.repo}#${pr.number}:tertiary`)).toBe(false)
  })

  it('does not send extra reviewers after a pull request the primary already reviewed', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)

    db.setMeta('behavior_review_new_prs_reviewers', '3')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)

    // A pull request opened after the change gets the whole panel.
    fixture.listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(4)
    expect(mocks.spawnDetached.mock.calls.slice(1).every((call) => (call[1] as string[]).includes('#18'))).toBe(true)
  })

  it('relaunches a dead reviewer once the siblings\' reviews are accounted for', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const loaded = await loadModules()
    loaded.behaviors.startBehaviorsRuntime()
    loaded.database.setMeta('me', 'poise-user')
    loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
    loaded.database.setMeta('behavior_review_new_prs_enabled', '1')
    loaded.database.setMeta('behavior_review_new_prs_reviewers', '3')
    loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)

    const key = `${pr.repo}#${pr.number}`
    const requestedAt = new Date(Date.now() - 10_000).toISOString()
    const claims = new Map<string, string>()
    for (const target of [key, `${key}:secondary`, `${key}:tertiary`]) {
      loaded.database.db.prepare(`
        UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
        WHERE key = 'review-new-prs' AND target = ?
      `).run(requestedAt, Date.now() - 1, target)
      const row = loaded.database.db.prepare(
        'SELECT launch_correlation_id AS correlationId FROM behavior_seen WHERE key = ? AND target = ?',
      ).get('review-new-prs', target) as { correlationId: string }
      claims.set(target, row.correlationId)
    }
    const startedAt = new Date(Date.parse(requestedAt) + 1_000).toISOString()
    const row = (id: string, target: string, model: string, overrides: Record<string, unknown>) => agentLog({
      id, model, started_at: startedAt, started_at_precise: startedAt,
      correlation_id: claims.get(target), actor: 'review-bot', source: 'poise:review-new-prs', expected_head: HEAD_SHA,
      ...overrides,
    })
    // The primary and the tertiary posted reviews 91 and 92; the secondary died without one.
    fixture.agentLogs = [
      row('1'.repeat(32), key, 'opus-5-xhigh', { status: 'completed', completed_at: new Date().toISOString(), action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA, review_id: 91 }),
      row('2'.repeat(32), `${key}:secondary`, 'gpt-6-astra-ultra', { status: 'failed', error: 'provider unavailable' }),
      row('3'.repeat(32), `${key}:tertiary`, 'grok-4.6-xhigh', { status: 'completed', completed_at: new Date().toISOString(), action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA, review_id: 92 }),
    ]
    await resetLogCache()

    // An unclaimed review since the launch could be the dead run's own: hold.
    const { database: db, behaviors: runtime } = await restartModules()
    arrangeCli(false, false, { reviewerReviewIdsSince: [91, 92, 93] })
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(db.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: `${key}:secondary`, error: 'provider unavailable' })])
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)

    // Every review since the launch belongs to a sibling: the secondary runs again.
    arrangeCli(false, false, { reviewerReviewIdsSince: [91, 92] })
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(4)
    const relaunch = mocks.spawnDetached.mock.calls[3][1] as string[]
    expect(relaunch[relaunch.indexOf('--model') + 1]).toBe('gpt-6-astra-ultra')
    expect(relaunch).toEqual(expect.arrayContaining(['--expected-head', HEAD_SHA]))
  })
})
