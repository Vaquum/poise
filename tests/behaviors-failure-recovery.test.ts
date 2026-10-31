import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, restartModules, resetLogCache, arrangeCli, agentLog, launchReviewBeforeCrash, launchApprovalBeforeCrash, fixture } from './behaviors-runtime-fixture'

function modelOf(call: unknown[]): string {
  const args = call[1] as string[]
  return args[args.indexOf('--model') + 1]
}

describe('worker failure classification and recovery', () => {

  it('recovers a failed review only after GitHub proves no reviewer action', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'c'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      error: 'model unavailable',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    mocks.observeAuthFailure.mockImplementation(() => { mocks.authStatus = 'degraded' })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.authStatus).toBe('degraded')
    expect(db.hasSeen('review-new-prs', launched.target)).toBe(true)

    mocks.authStatus = 'authenticated'
    arrangeCli(false, false, { reviewerReviewsSince: 1 })
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      reviewerReviewsSince: 0,
      reviewerPendingReviews: 0,
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      '--expected-head',
      NEXT_HEAD_SHA,
    ]))
    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({
        behavior: 'review-new-prs',
        target: launched.target,
        error: 'model unavailable',
      }),
    ])
  })

  it.each([HEAD_SHA, NEXT_HEAD_SHA])('recovers a closed legacy review when Caller later proves preflight no-action, head=%s', async (headSha) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const launched = await launchReviewBeforeCrash()
    const call = agentLog({
      id: 'c'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', error: 'codex review produced no submitted verdict',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })
    fixture.agentLogs = [call]
    await resetLogCache()
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    arrangeCli(false, false, { reviewerReviewsSince: 3 })
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)?.launchCallId).toBe(call.id)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    mocks.observeAuthFailure.mockClear()
    // Caller now exposes an exact, typed proof that this failed run never posted.
    // Other reviewers' actions must not turn that proof into an indefinite hold.
    Object.assign(call, { action: 'not_started', outcome: 'preflight_failed' })
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    arrangeCli(false, false, { headSha, reviewerReviewsSince: 3 })
    vi.setSystemTime(Date.now() + modules.behaviors.BEHAVIOR_RETRY_BASE_MS)
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toEqual(expect.arrayContaining(['--expected-head', headSha]))
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })


  it.each(['review_provider_exit', 'review_provider_error'])('releases a typed provider %s no-action failure for safe retry', async (code) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    const call = agentLog({
      id: 'c'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', error: 'codex review failed: provider exited',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })
    fixture.agentLogs = [call]
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    arrangeCli(false, false, { reviewerReviewsSince: 3 })
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)?.launchCallId).toBe(call.id)
    Object.assign(call, { action: 'not_started', outcome: 'preflight_failed', error_code: code, review_policy: 'bounded-v1' })
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    arrangeCli(false, false, { reviewerReviewsSince: 3 })
    vi.setSystemTime(Date.now() + modules.behaviors.BEHAVIOR_RETRY_BASE_MS)
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['httpx.ReadTimeout', 'network_interruption'],
    ['Selected model is at capacity. Please try a different model.', 'provider_capacity'],
    ['error: pull-request head or base changed while building review packet', 'head_changed'],
  ])('retries a no-action approval and classifies %s as automatic', async (error, code) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchApprovalBeforeCrash()
    const callId = 'e'.repeat(32)
    fixture.agentLogs = [agentLog({
      id: callId,
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      action: 'not_started',
      outcome: 'preflight_failed',
      error,
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(db.hasSeen('approve-prs', launched.target)).toBe(false)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toContainEqual(expect.objectContaining({
      target: launched.target, diagnostic: { severity: 'info', code },
    }))
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({
        behavior: 'approve-prs',
        target: launched.target,
        callId,
        error,
      }),
    ])

    fixture.agentLogs = []
    await resetLogCache()
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('rehydrates a truncated warning only from the exact Caller attempt, preserving its retry clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const launched = await launchApprovalBeforeCrash()
    const error = 'codex review produced no submitted verdict: {"type":"item.completed","item":{"type":"error","message":"Code Mode disabled"}}\n'
      + '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}'
    const call = agentLog({ id: 'e'.repeat(32), behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', action: 'not_started', outcome: 'preflight_failed', error,
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId })
    fixture.agentLogs = [call]
    await resetLogCache()
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    const key = `behavior_approve_prs_failure:${launched.target}`
    const stored = JSON.parse(db.getMeta(key)!)
    const { diagnostic: _diagnostic, ...legacy } = stored
    legacy.error = error.slice(0, 120)
    db.setMeta(key, JSON.stringify(legacy))
    call.correlation_id = 'unrelated-attempt'
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(JSON.parse(db.getMeta(key)!)).toEqual(legacy)
    call.correlation_id = launched.correlationId
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(JSON.parse(db.getMeta(key)!)).toEqual({ ...stored,
      diagnostic: { severity: 'info', code: 'provider_capacity' },
      error: 'Selected model is at capacity. Please try a different model.' })
  })

  it('binds a legacy failure summary to the newest attempt instead of overwriting it with an older cause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const launched = await launchReviewBeforeCrash()
    const old = agentLog({ id: 'd'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', action: 'not_started', outcome: 'preflight_failed', error: 'Older invalid result',
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId })
    fixture.agentLogs = [old]
    await resetLogCache()
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    const current = db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.target === launched.target)!
    expect(current).toBeDefined()
    const latest = agentLog({ id: 'e'.repeat(32),
      started_at: current.launchRequestedAt, status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error: 'Selected model is at capacity. Please try a different model.',
      expected_head: current.launchExpectedHead, actor: current.launchActor, source: current.launchSource,
      correlation_id: current.launchCorrelationId })
    fixture.agentLogs = [latest, old]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    const key = `behavior_review_new_prs_failure:${launched.target}`
    const stored = JSON.parse(db.getMeta(key)!)
    expect(stored.consecutiveFailures).toBe(2)
    const legacy = { ...stored }
    delete legacy.diagnostic
    delete legacy.callId
    legacy.error = 'truncated legacy cause'
    db.setMeta(key, JSON.stringify(legacy))
    await runtime.runEnabledBehaviorsOnce()
    expect(JSON.parse(db.getMeta(key)!)).toEqual(stored)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toContainEqual(expect.objectContaining({
      error: latest.error, callId: latest.id, diagnostic: { severity: 'info', code: 'provider_capacity' },
    }))
  })

  it('hides an old transient approval warning only after later authoritative completion, retaining held evidence and history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const launched = await launchApprovalBeforeCrash()
    const { database: db, behaviors: runtime } = launched
    const key = `behavior_approve_prs_failure:${launched.target}`
    db.setMeta(key, JSON.stringify({ kind: 'worker', consecutiveFailures: 1,
      lastFailureAtMs: Date.now() - 1_000, nextRetryAtMs: Date.now() + 60_000,
      error: 'Selected model is at capacity.', callId: 'd'.repeat(32), diagnostic: { severity: 'info', code: 'provider_capacity' } }))
    expect(runtime.getBehaviorsRuntimeHealth().failures).toHaveLength(1)
    const target = `${pr.repo}#${pr.number}@head=${NEXT_HEAD_SHA}`
    const claimId = db.claimSeenOwned('approve-prs', target)!
    expect(db.markBehaviorLaunchIntentOwned({ key: 'approve-prs', target, claimId,
      launchBehavior: 'pr_approve', repo: pr.repo, pr: pr.number, requestedAt: new Date().toISOString(),
      expectedHead: NEXT_HEAD_SHA, actor: launched.actor, source: launched.source, correlationId: claimId })).toBe(true)
    expect(db.completeBehaviorLaunchOwned({ key: 'approve-prs', target, claimId,
      action: 'approved', outcome: 'approved', completedAt: new Date().toISOString(), headSha: NEXT_HEAD_SHA })).toBe(true)
    // Recovery requires the failed attempt's recorded actor, never today's settings.
    expect(runtime.getBehaviorsRuntimeHealth().failures[0]?.recovered).not.toBe(true)
    const failed = db.listBehaviorLaunchClaims('approve-prs').find((claim) => claim.target === launched.target)!
    expect(db.linkBehaviorLaunchCallOwned('approve-prs', launched.target, failed.claimId, 'd'.repeat(32))).toBe(true)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ recovered: true })])
    expect(db.getMeta(key)).not.toBeNull()
    // An audit can be recreated after completion during log reconciliation.
    // It must not turn an already recovered no-action attempt into an error.
    vi.setSystemTime(new Date(Date.now() + 1_000))
    const original = db.listBehaviorLaunchClaims('approve-prs').find((claim) => claim.target === launched.target)!
    db.recordBehaviorDeadLetter(original, 'Selected model is at capacity.', 'd'.repeat(32))
    const { behaviorDiagnosticGroups } = await import('../src/behavior-diagnostics')
    expect(behaviorDiagnosticGroups({ ...runtime.getBehaviorsRuntimeHealth(), agentLogsError: null })).toEqual([])
    expect(db.listBehaviorDeadLetters()).toHaveLength(1)
    db.db.prepare("UPDATE behavior_seen SET launch_quarantine = 'unreadable' WHERE key = 'approve-prs' AND target = ?").run(launched.target)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({
      diagnostic: { severity: 'warning', code: 'held_result' },
    })])
  })

  it('supersedes a held approval firing once its request is replaced, linking the replacement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchApprovalBeforeCrash()
    const args: string[] = mocks.spawnDetached.mock.calls[0][1]
    const error = 'codex review produced no submitted verdict: cannot validate since-diff positions: p must look like p2'
    const failedCall = agentLog({
      id: 'e'.repeat(32),
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      action: 'not_started',
      outcome: 'preflight_failed',
      error,
      error_code: 'review_contract_violation',
      review_policy: 'bounded-v1',
      model: args[args.indexOf('--model') + 1],
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })
    fixture.agentLogs = [failedCall]
    await resetLogCache()
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    // The malformed verdict dead-letters the firing and holds its ledger record.
    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({ behavior: 'approve-prs', target: launched.target, callId: failedCall.id, error }),
    ])
    expect(mocks.captureOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ nativeId: launched.correlationId, state: 'held' }))

    // The head moves; a replacement approval request launches for the new head.
    arrangeCli(true, false, { headSha: NEXT_HEAD_SHA }, {
      commits_after_request: 0,
      author_commits_after_request: 0,
      author_pr_comments_after_request: 1,
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toEqual(expect.arrayContaining(['--expected-head', NEXT_HEAD_SHA]))
    const replacement = db.listBehaviorLaunchClaims('approve-prs').find((claim) => claim.target !== launched.target)!
    expect(replacement.launchExpectedHead).toBe(NEXT_HEAD_SHA)

    // The replacement runs; an hour later the reconcile pass settles the obsolete firing.
    fixture.agentLogs = [failedCall, agentLog({
      id: 'f'.repeat(32),
      behavior: 'pr_approve',
      status: 'running',
      model: args[args.indexOf('--model') + 1],
      expected_head: NEXT_HEAD_SHA,
      actor: replacement.launchActor,
      source: 'poise:approve-prs',
      correlation_id: replacement.launchCorrelationId,
      started_at: new Date(Date.parse(replacement.launchRequestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(replacement.launchRequestedAt) + 1_001).toISOString(),
    })]
    await resetLogCache()
    vi.setSystemTime(new Date(Date.now() + 61 * 60_000))
    await runtime.runEnabledBehaviorsOnce()

    expect(db.listBehaviorDeadLetters()).toEqual([])
    const row = db.db.prepare(
      'SELECT resolution, resolution_evidence, error FROM behavior_dead_letters',
    ).get() as { resolution: string, resolution_evidence: string, error: string }
    expect(row.resolution).toBe('superseded')
    expect(row.error).toBe(error)
    expect(JSON.parse(row.resolution_evidence).replacedBy).toMatchObject({
      correlationId: replacement.launchCorrelationId,
      expectedHead: NEXT_HEAD_SHA,
    })
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, state: 'superseded', activity: 'unknown', outcome: 'superseded',
      refs: expect.arrayContaining([
        expect.objectContaining({ kind: 'correlation', identity: replacement.launchCorrelationId }),
      ]),
    }))
    // The obsolete input stays fenced: its failed launch is retained, and
    // nothing relaunches the old head.
    expect(db.getFailedBehaviorLaunch('approve-prs', launched.target)?.launchCallId).toBe(failedCall.id)
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it.each([{ receipts: null }, { receipts: [] }])('classifies the first issue-review timeout from its recorded posting state: %j', async ({ receipts }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    arrangeCli(false)
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args[0] === 'view' && args[1] === 'issue') {
        return { stdout: JSON.stringify([{ ...pr, url: `https://github.com/${pr.repo}/issues/${pr.number}`, title: 'Review retry diagnostics',
          created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
          updated_at: new Date(Date.now() - 20 * 60_000).toISOString(), comments_count: 0 }]), stderr: '' }
      }
      if (command === 'github-interface' && args[0] === '--sub-issues') {
        return { stdout: JSON.stringify({ action: 'sub_issues', repository: pr.repo, issue_number: pr.number, sub_issues: [] }), stderr: '' }
      }
      return original(command, args, options)
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_issues_enabled', '1')
    db.setMeta('behavior_review_new_issues_repos', JSON.stringify([{ repo: pr.repo, since: new Date(Date.now() - 60 * 60_000).toISOString() }]))
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    const claim = db.listBehaviorLaunchClaims('review-new-issues')[0]!
    expect(claim).toBeDefined()
    fixture.agentLogs = [agentLog({ id: 'e'.repeat(32), behavior: 'issue_review', repo: pr.repo, pr_id: String(pr.number),
      actor: claim.launchActor, source: claim.launchSource, correlation_id: claim.launchCorrelationId,
      started_at: claim.launchRequestedAt, status: 'failed', action: null, outcome: null, expected_head: null,
      error: 'httpx.ReadTimeout', receipts: receipts ? [] : null })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toContainEqual(expect.objectContaining({
      behavior: 'review-new-issues', diagnostic: receipts ? { severity: 'warning', code: 'held_result' }
        : { severity: 'info', code: 'network_interruption' },
    }))
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('holds an oversized %s packet across restart until the head changes', async (behavior) => {
    const launched = behavior === 'review-new-prs'
      ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'f'.repeat(32),
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'review_packet_too_large', error: 'remaining review input is too large',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })]
    await resetLogCache()
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.hasSeen(behavior, launched.target)).toBe(true)
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    expect(modules.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    fixture.listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
    arrangeCli(behavior === 'approve-prs', false, { headSha: NEXT_HEAD_SHA })
    // The push behind the new head moves the datastore rows too.
    fixture.listedPrs = fixture.listedPrs.map((row) => ({ ...row, updated_at: '2026-07-15T12:00:01Z' }))
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
  })

  it('falls a budget-exhausted approval to the next slot on the same head', async () => {
    const launched = await launchApprovalBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'e'.repeat(32),
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      action: null,
      outcome: null,
      model: 'opus-5-xhigh',
      review_policy: 'bounded-v1',
      error_code: 'review_budget_exhausted',
      error: 'Review reached its total time limit; needs attention',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    // No push, no replay, no backoff wait: the next slot relaunches the same head.
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(modelOf(mocks.spawnDetached.mock.calls[1])).toBe('gpt-6-astra-ultra')
    expect(mocks.spawnDetached.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--expected-head', HEAD_SHA]))
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ target: 'reviewer:opus-5-xhigh' }),
    ])
    expect(db.listBehaviorDeadLetters()).toEqual([])
  })

  it('falls a 429 approval to the next slot on the same head without a push or a replay', async () => {
    const launched = await launchApprovalBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'e'.repeat(32),
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      action: 'not_started',
      outcome: 'preflight_failed',
      model: 'opus-5-xhigh',
      review_policy: 'bounded-v1',
      error_code: 'review_provider_error',
      error: 'codex review failed: Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(modelOf(mocks.spawnDetached.mock.calls[1])).toBe('gpt-6-astra-ultra')
    expect(mocks.spawnDetached.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--expected-head', HEAD_SHA]))
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ target: 'reviewer:opus-5-xhigh' }),
    ])
    expect(db.listBehaviorDeadLetters()).toEqual([])
  })

  it('holds a budget-exhausted approval when the submission is uncertain', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchApprovalBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'e'.repeat(32),
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      action: null,
      outcome: null,
      model: 'opus-5-xhigh',
      review_policy: 'bounded-v1',
      error_code: 'review_budget_exhausted',
      error: 'Review reached its total time limit; needs attention; could not prove a safe recovery: review activity unavailable',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])

    // Even past any backoff, an uncertain submission never retries itself.
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.getFailedBehaviorLaunch('approve-prs', launched.target)?.launchCallId).toBe('e'.repeat(32))
    expect(db.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it('allows an explicit model change after a bounded no-action failure', async () => {
    const launched = await launchApprovalBeforeCrash()
    // An output limit still holds: only provider failures before a verdict —
    // a rate limit, a dead provider, an exhausted budget — trip and fall
    // through the slots.
    fixture.agentLogs = [agentLog({
      id: 'f'.repeat(32), behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', action: null, outcome: null, model: 'opus-5-xhigh',
      review_policy: 'bounded-v1', error_code: 'model_output_limit', error: 'Review needs attention',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })]
    await resetLogCache()
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    modules.database.setMeta('models', JSON.stringify({ pr_approve: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } }))
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    const args = mocks.spawnDetached.mock.calls[1][1]
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-6-astra-ultra')
    expect(args[args.indexOf('--recovery-model') + 1]).toBe('opus-5-xhigh')
  })

  it('resumes a whole failed panel atomically through its normal scheduler', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
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
    const claims = loaded.database.listBehaviorLaunchClaims('review-new-prs')
    expect(claims).toHaveLength(3)
    fixture.agentLogs = claims.map((claim, index) => agentLog({ id: String(index + 1).repeat(32), status: 'failed',
      started_at: claim.launchRequestedAt, started_at_precise: claim.launchRequestedAt,
      source: claim.launchSource, correlation_id: claim.launchCorrelationId,
      actor: claim.launchActor, expected_head: claim.launchExpectedHead,
      model: claim.target.endsWith(':tertiary') ? 'grok-4.6-xhigh' : claim.target.endsWith(':secondary') ? 'gpt-6-astra-ultra' : 'opus-5-xhigh',
      error: 'review behavior must produce exactly one atomic clean or change-request review',
      error_code: 'review_contract_violation', review_policy: 'bounded-v1' }))
    await resetLogCache()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(loaded.database.listBehaviorDeadLetters()).toHaveLength(3)
    arrangeCli(false, false, { reviewerReviewIdsSince: [] })
    await expect(loaded.behaviors.retryFailedPrReviews(fixture.agentLogs.map((row) => row.id))).resolves.toEqual({
      ok: true, targets: expect.arrayContaining(claims.map((claim) => claim.target)) })
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(6)
    expect(loaded.database.listBehaviorDeadLetters()).toEqual([])
  })

  it('defers a review launch whose head moved during preparation without spawning a doomed worker', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    // The pull request moves between the preparation head read and the
    // launch-phase re-verification: the first --head-sha answers the
    // prepared head, later ones the pushed head.
    const inner = mocks.runFile.getMockImplementation()!
    let headReads = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && args[0] === '--head-sha') {
        headReads += 1
        if (headReads > 1) {
          const cwdParts = String(options?.cwd || '').split('/')
          const repository = `${cwdParts[cwdParts.length - 2]}/${cwdParts[cwdParts.length - 1]}`
          return { stdout: JSON.stringify({ action: 'head_sha', repository, pull_number: pr.number, head_sha: NEXT_HEAD_SHA }), stderr: '' }
        }
      }
      return inner(command, args, options)
    })
    const loaded = await loadModules()
    loaded.behaviors.startBehaviorsRuntime()
    loaded.database.setMeta('me', 'poise-user')
    loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
    loaded.database.setMeta('behavior_review_new_prs_enabled', '1')
    loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
    await loaded.behaviors.runEnabledBehaviorsOnce()

    const target = `${pr.repo}#${pr.number}`
    // No worker spawns against the stale head: the preparation ends as a
    // retained no-op, with no failure and no dead letter behind it.
    expect(headReads).toBe(2)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      state: 'completed', activity: 'settled', outcome: 'no_op', head: HEAD_SHA,
    }))
    expect(loaded.database.hasSeen('review-new-prs', target)).toBe(false)
    expect(loaded.behaviors.getBehaviorFailureState('review-new-prs', target)).toBeNull()
    expect(loaded.behaviors.getBehaviorFailureState('review-new-prs', `${target}:check`)).toBeNull()
    expect(loaded.database.listBehaviorDeadLetters()).toEqual([])

    // The next tick prepares fresh on the new head and launches normally.
    arrangeCli(false, false, { headSha: NEXT_HEAD_SHA })
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--expected-head', NEXT_HEAD_SHA]))
  })
})
