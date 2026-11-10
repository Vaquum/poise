import { describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '../server/agent'
import type { ReviewerTripKind } from '../server/behaviors'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, restartModules, resetLogCache, arrangeCli, agentLog, recordCompletedInitialReview, fixture } from './behaviors-runtime-fixture'

const RATE_LIMIT_ERROR = 'codex review failed: Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)'
const GROK_ANALYSIS_LIMIT_ERROR = 'grok review reached its analysis time limit; handing off so the next model can run instead'

function modelOf(call: unknown[]): string {
  const args = call[1] as string[]
  return args[args.indexOf('--model') + 1]
}

describe('reviewer trip classification', () => {
  const trips: Array<{ name: string, error: string, code?: string, diagnostic?: { operation: string, phase: string }, expected: ReviewerTripKind }> = [
    { name: 'codex 429 reconnect loop', error: RATE_LIMIT_ERROR, expected: 'rate_limit' },
    { name: 'status 429', error: 'API error (status 429 Too Many Requests)', expected: 'rate_limit' },
    { name: 'http_status 429', error: '{"http_status": 429}', expected: 'rate_limit' },
    { name: 'rate-limit words', error: 'Provider rate-limited this run for over a minute', expected: 'rate_limit' },
    { name: 'transport handoff', error: 'Provider kept reconnecting for over a minute (codex); handing off so the next model can run instead: Reconnecting... 2/5 (stream disconnected before completion: idle timeout waiting for websocket)', code: 'review_provider_error', expected: 'provider' },
    { name: 'provider error code', error: 'codex review failed: turn errored', code: 'review_provider_error', expected: 'provider' },
    { name: 'provider exit code', error: 'codex review failed: provider exited', code: 'review_provider_exit', expected: 'provider' },
    { name: 'budget exhausted code', error: 'Review reached its total time limit; needs attention', code: 'review_budget_exhausted', expected: 'budget' },
    { name: 'provider-execution budget with diagnostic', error: 'Issue review reached its time limit; needs attention', code: 'review_budget_exhausted', diagnostic: { operation: 'provider.review', phase: 'provider_execution' }, expected: 'budget' },
    { name: 'Grok analysis ceiling', error: GROK_ANALYSIS_LIMIT_ERROR, code: 'review_budget_exhausted', expected: 'budget' },
    { name: '402 stays an account trip', error: 'API error (status 402 Payment Required)', expected: 'balance' },
  ]

  const holds: Array<{ name: string, error: string, code?: string, diagnostic?: { operation: string, phase: string } }> = [
    { name: 'GitHub 429', error: 'error: GitHub 429: rate limit exceeded for resource' },
    { name: 'GitHub 403 rate-limit', error: 'error: GitHub 403 rate-limit: {headers}' },
    { name: 'line 429', error: 'verdict failed at line 429' },
    { name: 'retry loop without quota evidence', error: 'codex review failed: Reconnecting... 5/5 (exceeded retry limit, stream disconnected)' },
    { name: 'pull number 429', error: 'failed to fetch https://api.github.com/repos/o/r/pulls/429' },
    { name: 'ordinary failure', error: 'max turns reached' },
    { name: 'model at capacity', error: 'Selected model is at capacity. Please try a different model.', code: 'provider_capacity' },
    { name: 'empty', error: '' },
    { name: 'inspection prompt exhaustion', error: 'Repository inspection exceeds the review prompt limit; needs attention', code: 'review_budget_exhausted' },
    { name: 'inspection round exhaustion', error: 'Repository inspection limit reached; needs attention', code: 'review_budget_exhausted' },
    { name: 'issue checkout budget', error: 'Issue review checkout reached its time limit; needs attention', code: 'review_budget_exhausted', diagnostic: { operation: 'issue.checkout', phase: 'checking_out' } },
    { name: 'issue preparation budget', error: 'Issue review preparation reached its time limit; needs attention', code: 'review_budget_exhausted', diagnostic: { operation: 'issue.prepare', phase: 'preparing_issue' } },
  ]

  it.each(trips)('trips on $name', async ({ error, code, diagnostic, expected }) => {
    const { behaviors } = await loadModules()
    expect(behaviors.reviewerTripKind({ error, error_code: code, diagnostic } as LogEntry)).toBe(expected)
  })

  it.each(holds)('does not trip on $name', async ({ error, code, diagnostic }) => {
    const { behaviors } = await loadModules()
    expect(behaviors.reviewerTripKind({ error, error_code: code, diagnostic } as LogEntry)).toBeNull()
  })

  it.each(['review_budget_exhausted', 'review_inspection_timeout', 'review_provider_error', 'review_provider_exit'])(
    'excludes local inspection evidence before every provider classifier (%s)', async code => {
      const { behaviors } = await loadModules()
      const call = { error: 'rate limit; not signed in; status 402 Payment Required', error_code: code,
        diagnostic: { operation: 'github-interface', phase: 'inspection', outcome: 'timed_out' } } as LogEntry
      expect(behaviors.reviewerTripKind(call)).toBeNull()
      for (const diagnostic of [undefined, { operation: 'provider.review', phase: 'inspection', outcome: 'timed_out' },
        { operation: 'github-interface', phase: 'provider_execution', outcome: 'timed_out' },
        { operation: 'github-interface', phase: 'inspection', outcome: 'exit' }]) {
        expect(behaviors.reviewerTripKind({ ...call, diagnostic } as LogEntry)).toBe('balance')
      }
    })
})

async function startPrReviews(slots: { primary: string, secondary: string, tertiary: string }) {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database: db, behaviors: runtime } = await loadModules()
  runtime.startBehaviorsRuntime()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_review_new_prs_keyver', '3')
  db.setMeta('behavior_review_new_prs_enabled', '1')
  db.setMeta('behavior_review_new_prs_reviewers', '1')
  db.setMeta('models', JSON.stringify({ slots, places: { pr_review: { slot: 'primary' } } }))
  db.recordSeen('review-new-prs', '__snapshot_v3__')
  return { db, runtime }
}

function failedPrLog(
  db: { listBehaviorLaunchClaims: (behavior: string) => Array<{ target: string, launchRequestedAt: string, launchExpectedHead: string, launchActor: string, launchSource: string, launchCorrelationId: string }> },
  target: string,
  model: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const claim = db.listBehaviorLaunchClaims('review-new-prs').find((row) => row.target === target)!
  return agentLog({
    id: '1'.repeat(32),
    model,
    started_at: claim.launchRequestedAt,
    started_at_precise: claim.launchRequestedAt,
    status: 'failed',
    expected_head: claim.launchExpectedHead,
    actor: claim.launchActor,
    source: claim.launchSource,
    correlation_id: claim.launchCorrelationId,
    ...overrides,
  })
}

describe('slot fallback on provider failure', () => {
  const failures: Array<{ name: string, overrides: Record<string, unknown> }> = [
    { name: 'a 429', overrides: { error: RATE_LIMIT_ERROR, error_code: 'review_provider_error', action: 'not_started', outcome: 'preflight_failed' } },
    { name: 'a provider error', overrides: { error: 'codex review failed: turn errored', error_code: 'review_provider_error', action: 'not_started', outcome: 'preflight_failed' } },
    { name: 'an exhausted budget', overrides: { error: 'Review reached its total time limit; needs attention', error_code: 'review_budget_exhausted', review_policy: 'bounded-v1' } },
    { name: 'the Grok analysis ceiling', overrides: { error: GROK_ANALYSIS_LIMIT_ERROR, error_code: 'review_budget_exhausted', review_policy: 'bounded-v1' } },
  ]

  it.each(failures)('moves a review to the next slot on $name before a verdict', async ({ overrides }) => {
    const { db, runtime } = await startPrReviews({
      primary: 'grok-4.6-xhigh', secondary: 'opus-5-xhigh', tertiary: 'gpt-6-astra-ultra',
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    expect(modelOf(mocks.spawnDetached.mock.calls[0])).toBe('grok-4.6-xhigh')

    const key = `${pr.repo}#${pr.number}`
    fixture.agentLogs = [failedPrLog(db, key, 'grok-4.6-xhigh', overrides)]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()

    // Tripped and released: the same tick relaunches with the next slot.
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(modelOf(mocks.spawnDetached.mock.calls[1])).toBe('opus-5-xhigh')
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ target: 'reviewer:grok-4.6-xhigh' }),
    ])
  })

  it('holds a target whose run posted before its 429, without tripping', async () => {
    const { db, runtime } = await startPrReviews({
      primary: 'grok-4.6-xhigh', secondary: 'opus-5-xhigh', tertiary: 'gpt-6-astra-ultra',
    })
    await runtime.runEnabledBehaviorsOnce()
    const key = `${pr.repo}#${pr.number}`
    fixture.agentLogs = [failedPrLog(db, key, 'grok-4.6-xhigh', {
      error: RATE_LIMIT_ERROR, error_code: 'review_provider_error',
      action: 'not_started', outcome: 'preflight_failed', review_id: 42,
    })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    expect(db.listBehaviorDeadLetters()).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures.map((failure) => failure.target)).not.toContain('reviewer:grok-4.6-xhigh')
  })

  it.each([
    { name: 'inspection prompt exhaustion', error: 'Repository inspection exceeds the review prompt limit; needs attention' },
    { name: 'inspection round exhaustion', error: 'Repository inspection limit reached; needs attention' },
  ])('holds its target on deterministic $name, without tripping the provider', async ({ error }) => {
    const { db, runtime } = await startPrReviews({
      primary: 'grok-4.6-xhigh', secondary: 'opus-5-xhigh', tertiary: 'gpt-6-astra-ultra',
    })
    await runtime.runEnabledBehaviorsOnce()
    const key = `${pr.repo}#${pr.number}`
    fixture.agentLogs = [failedPrLog(db, key, 'grok-4.6-xhigh', {
      error, error_code: 'review_budget_exhausted', review_policy: 'bounded-v1',
    })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()

    // Held, not fallen through: no second launch, no global trip, one dead letter.
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    expect(db.listBehaviorDeadLetters()).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
})

async function startApprovals(slots: { primary: string, secondary: string, tertiary: string }) {
  arrangeCli(true, false, { headSha: 'b'.repeat(40) }, {
    commits_after_request: 0,
    author_commits_after_request: 0,
    author_pr_comments_after_request: 1,
  })
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database: db, behaviors: runtime } = await loadModules()
  runtime.startBehaviorsRuntime()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_approve_prs_enabled', '1')
  db.setMeta('models', JSON.stringify({ slots, places: { pr_approve: { slot: 'primary' } } }))
  return { db, runtime }
}

function failedApproveLog(
  db: { listBehaviorLaunchClaims: (behavior: string) => Array<{ target: string, launchRequestedAt: string, launchExpectedHead: string, launchActor: string, launchSource: string, launchCorrelationId: string, launchPr: number, launchRepo: string }> },
  model: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const claim = db.listBehaviorLaunchClaims('approve-prs').find((row) => row.launchRepo === pr.repo && row.launchPr === pr.number)!
  return agentLog({
    id: '2'.repeat(32),
    behavior: 'pr_approve',
    model,
    started_at: claim.launchRequestedAt,
    started_at_precise: claim.launchRequestedAt,
    status: 'failed',
    expected_head: claim.launchExpectedHead,
    actor: claim.launchActor,
    source: claim.launchSource,
    correlation_id: claim.launchCorrelationId,
    ...overrides,
  })
}

describe('approval fallback through the slots', () => {
  const slots = { primary: 'gpt-6-astra-ultra', secondary: 'opus-5-xhigh', tertiary: 'grok-4.6-xhigh' }

  it.each([
    { name: 'a 429', overrides: { error: RATE_LIMIT_ERROR, error_code: 'review_provider_error', action: 'not_started', outcome: 'preflight_failed' } },
    { name: 'an exhausted budget', overrides: { error: 'Review reached its total time limit; needs attention', error_code: 'review_budget_exhausted', review_policy: 'bounded-v1' } },
  ])('moves an approval to the next slot on $name and records each slot in the ledger', async ({ overrides }) => {
    const { db, runtime } = await startApprovals(slots)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    expect(modelOf(mocks.spawnDetached.mock.calls[0])).toBe('gpt-6-astra-ultra')

    fixture.agentLogs = [failedApproveLog(db, 'gpt-6-astra-ultra', overrides)]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(modelOf(mocks.spawnDetached.mock.calls[1])).toBe('opus-5-xhigh')
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ target: 'reviewer:gpt-6-astra-ultra' }),
    ])
    const target = db.listBehaviorLaunchClaims('approve-prs')[0].target
    expect(mocks.captureAdmission).toHaveBeenCalledTimes(2)
    expect(mocks.captureAdmission.mock.calls[0][0]).toMatchObject({
      behavior: 'approve-prs', slot: 'primary', plannedSlots: ['primary'],
      admissionKey: JSON.stringify(['Vaquum', 'approve-prs', target]),
    })
    // The fallback opens its own firing, so the aggregate follows the slot
    // that ran instead of the failed slot before it.
    expect(mocks.captureAdmission.mock.calls[1][0]).toMatchObject({
      behavior: 'approve-prs', slot: 'secondary', plannedSlots: ['secondary'],
      admissionKey: JSON.stringify(['Vaquum', 'approve-prs', target, 'secondary']),
    })
  })

  it('waits instead of launching when every slot is tripped', async () => {
    const { db, runtime } = await startApprovals(slots)
    for (const identity of Object.values(slots)) {
      db.setMeta(`behavior_approve_prs_failure:reviewer:${identity}`, JSON.stringify({
        kind: 'operation', consecutiveFailures: 1, lastFailureAtMs: Date.now(),
        nextRetryAtMs: Date.now() + 3_600_000, error: `${identity} cannot review delivery probe`,
      }))
    }
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.listBehaviorLaunchClaims('approve-prs')).toEqual([])
  })

  it('moves a Random approval to an untried model on a 429 and records each draw in the ledger', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      arrangeCli(true, false, { headSha: 'b'.repeat(40) }, {
        commits_after_request: 0,
        author_commits_after_request: 0,
        author_pr_comments_after_request: 1,
      })
      mocks.spawnDetached.mockResolvedValue(undefined)
      const { database: db, behaviors: runtime } = await loadModules()
      runtime.startBehaviorsRuntime()
      db.setMeta('me', 'poise-user')
      db.setMeta('behavior_approve_prs_enabled', '1')
      db.setMeta('models', JSON.stringify({ slots, places: { pr_approve: { slot: 'random' } } }))

      await runtime.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
      const first = modelOf(mocks.spawnDetached.mock.calls[0])
      expect(Object.values(slots)).toContain(first)

      fixture.agentLogs = [failedApproveLog(db, first, {
        error: RATE_LIMIT_ERROR, error_code: 'review_provider_error', action: 'not_started', outcome: 'preflight_failed',
      })]
      await resetLogCache()
      await runtime.runEnabledBehaviorsOnce()

      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
      const second = modelOf(mocks.spawnDetached.mock.calls[1])
      expect(Object.values(slots)).toContain(second)
      expect(second).not.toBe(first)
      expect(db.listBehaviorDeadLetters()).toEqual([])
      const admissions = mocks.captureAdmission.mock.calls.map(([admission]) => admission)
      expect(admissions).toHaveLength(2)
      expect(admissions[0].slot).not.toBe(admissions[1].slot)
    } finally {
      random.mockRestore()
    }
  })

  it('holds a Random approval whose prepared model left every slot mid-flight', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      arrangeCli(true, false, { headSha: 'b'.repeat(40) }, {
        commits_after_request: 0,
        author_commits_after_request: 0,
        author_pr_comments_after_request: 1,
      })
      mocks.spawnDetached.mockResolvedValue(undefined)
      const { database: db, behaviors: runtime } = await loadModules()
      runtime.startBehaviorsRuntime()
      db.setMeta('me', 'poise-user')
      db.setMeta('behavior_approve_prs_enabled', '1')
      db.setMeta('models', JSON.stringify({
        slots: { primary: 'opus-5-xhigh', secondary: 'gpt-6-astra-ultra', tertiary: 'grok-4.6-xhigh' },
        places: { pr_approve: { slot: 'random' } },
      }))
      // The draw prepares opus-5-xhigh; a settings change swaps every slot
      // model before the pre-launch check runs.
      mocks.requireAuth.mockImplementationOnce(async () => {
        db.setMeta('models', JSON.stringify({
          slots: { primary: 'grok-4.6-high', secondary: 'gemini-3.8-flash-high', tertiary: 'muse-spark-1.3-contributor-max' },
          places: { pr_approve: { slot: 'random' } },
        }))
      })

      await runtime.runEnabledBehaviorsOnce()

      expect(mocks.spawnDetached).not.toHaveBeenCalled()
      expect(db.listBehaviorLaunchClaims('approve-prs')).toEqual([])
      expect(mocks.captureAdmission).not.toHaveBeenCalled()
    } finally {
      random.mockRestore()
    }
  })
})

it.each(['initial review', 'approval', 'dismissed approval'] as const)(
  'stops matching legacy %s timeouts across backoff, restart and other PR success', async (lane) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    const initial = lane === 'initial review'
    const dismissed = lane === 'dismissed approval'
    const behavior = initial ? 'review-new-prs' : 'approve-prs'
    const launchBehavior = initial ? 'pr_review' : 'pr_approve'
    const model = 'opus-5-xhigh'
    const key = `${pr.repo}#${pr.number}`
    const failureKey = `behavior_${behavior.replace(/-/g, '_')}_failure:`
    const arrange = (head = HEAD_SHA, responses = 1) => arrangeCli(!initial && !dismissed, false, {
      headSha: head, reviewerReviewIdsSince: [], latestActivityAt: new Date().toISOString(),
      ...(dismissed ? { reviewerLatestState: 'DISMISSED', reviewerLatestCommit: NEXT_HEAD_SHA } : {}),
    }, { commits_after_request: 0, author_commits_after_request: 0, author_pr_comments_after_request: !initial && !dismissed ? responses : 0,
      response_count: !initial && !dismissed ? responses : 0,
      ...(dismissed ? { reviewer_latest_state: 'DISMISSED' } : {}) })
    arrange()
    mocks.spawnDetached.mockResolvedValue(undefined)
    let { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
    db.setMeta('models', JSON.stringify({ slots: { primary: model, secondary: model, tertiary: model },
      places: { [launchBehavior]: { slot: 'primary' } } }))
    if (initial) {
      db.setMeta('behavior_review_new_prs_keyver', '3')
      db.recordSeen(behavior, '__snapshot_v3__')
      db.setMeta('behavior_review_new_prs_reviewers', '2')
      // An admitted sibling waits while the primary uses its two attempts.
      db.setMeta(`${failureKey}${key}:secondary`, JSON.stringify({ kind: 'operation', consecutiveFailures: 1,
        lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 86_400_000, error: 'sibling waiting' }))
    }
    const basis = (pull: typeof pr) => {
      if (dismissed) recordCompletedInitialReview(db, { pull, target: `${pull.repo}#${pull.number}:tertiary`,
        outcome: 'changes_requested', headSha: NEXT_HEAD_SHA, callId: String(pull.number).padStart(32, '0') })
    }
    basis(pr)
    runtime.startBehaviorsRuntime()
    const tick = async () => { await resetLogCache(); await runtime.runEnabledBehaviorsOnce() }
    const expireBackoff = () => vi.setSystemTime(Date.now() + 3_600_001)
    let receiptId = 100
    const receipt = (number = pr.number, overrides: Record<string, unknown> = {}) => {
      const claim = db.listBehaviorLaunchClaims(behavior).find((row) => row.launchPr === number)!
      return agentLog({ id: (++receiptId).toString(16).padStart(32, '0'), behavior: launchBehavior,
        repo: pr.repo, pr_id: String(number), model, status: 'failed',
        started_at: claim.launchRequestedAt, started_at_precise: claim.launchRequestedAt,
        completed_at: new Date().toISOString(), expected_head: claim.launchExpectedHead,
        actor: claim.launchActor, source: claim.launchSource, correlation_id: claim.launchCorrelationId,
        action: 'not_started', outcome: 'preflight_failed', review_policy: 'bounded-v1',
        error_code: 'review_budget_exhausted', error: 'Review reached its total time limit; needs attention', ...overrides })
    }
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    const first = receipt()
    const otherEvidence = [
      { model: 'gpt-6-astra-ultra' }, { expected_head: NEXT_HEAD_SHA }, { source: 'poise:replay' },
      { actor: 'other-bot' }, { behavior: initial ? 'pr_approve' : 'pr_review' }, { pr_id: '99' },
      { review_id: 91 }, { error: 'Review timed out; could not prove a safe recovery' },
      { correlation_id: 'duplicate' }, { correlation_id: 'duplicate' },
    ].map((change, index) => ({ ...first, id: (index + 200).toString(16).padStart(32, '0'),
      correlation_id: `other-${index}`, ...change }))
    fixture.agentLogs.push(first, ...otherEvidence)
    await tick()
    await tick()
    // Re-reading one failed receipt does not use up the second attempt.
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    fixture.agentLogs = fixture.agentLogs.filter((call) => !otherEvidence.some((row) => row.id === call.id))
    expireBackoff()
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    const heldTarget = db.listBehaviorLaunchClaims(behavior)[0].target
    const second = receipt(pr.number, { error: GROK_ANALYSIS_LIMIT_ERROR })
    fixture.agentLogs.push(second)
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(db.getFailedBehaviorLaunch(behavior, heldTarget)?.launchCallId).toBe(second.id)

    // The stopping timeout still re-trips the model so other PRs keep the backoff.
    const reviewerFailure = runtime.getBehaviorsRuntimeHealth().failures
      .find((failure) => failure.target === `reviewer:${model}`)
    expect(reviewerFailure?.callId).toBe(second.id)

    // A retained legacy clock must not advertise another automatic retry.
    db.setMeta(`${failureKey}${heldTarget}`, JSON.stringify({ kind: 'worker', consecutiveFailures: 2,
      lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 60_000, error: second.error, callId: second.id }))

    const visibleStop = async () => {
      const snapshot = await (await import('../server/agent')).fetchAgentLogSnapshot()
      for (const evidence of [snapshot, null]) {
        const incident = runtime.getBehaviorDiagnosticIncidents(evidence).find((row) => row.callId === second.id)!
        expect(incident.error).toContain('Automatic retries stopped after two review timeouts')
        expect(incident.diagnostic).toEqual({ severity: 'warning', code: 'review_budget_exhausted' })
        expect(incident.nextRetryAt).toBeUndefined()
      }
    }
    await visibleStop()
    expireBackoff()
    ;({ database: db, behaviors: runtime } = await restartModules())
    runtime.startBehaviorsRuntime()
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    await visibleStop()

    const readable = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('Caller history unavailable')
      return readable(command, args, options)
    })
    await tick()
    expect(runtime.getBehaviorDiagnosticIncidents(null).find((row) => row.callId === second.id)?.error)
      .toContain('Automatic retries stopped after two review timeouts')
    arrange()
    await tick()
    await visibleStop()

    // The same reviewer succeeds elsewhere, clearing its provider trip.
    if (initial) db.setMeta('behavior_review_new_prs_reviewers', '1')
    const other = { ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` }
    fixture.listedPrs = [pr, other]
    basis(other)
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(mocks.spawnDetached.mock.calls[2][1]).toEqual(expect.arrayContaining(['#18', '--model', model]))
    fixture.agentLogs.push(receipt(18, { status: 'completed', action: initial ? 'reviewed_clean' : 'approved',
      outcome: initial ? 'clean' : 'approved', head_sha: HEAD_SHA, error: '', error_code: undefined }))
    await tick()
    expect(runtime.getBehaviorsRuntimeHealth().failures.some((failure) => failure.target === `reviewer:${model}`)).toBe(false)
    fixture.listedPrs = [pr]
    await visibleStop()

    // A different slot or approval context cannot evade the PR/head/model stop.
    if (initial) {
      db.setMeta('behavior_review_new_prs_reviewers', '2')
      db.setMeta(`${failureKey}${key}:secondary`, '')
    } else if (dismissed) {
      const base = mocks.runFile.getMockImplementation()!
      mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
        const result = await base(command, args, options)
        if (args[0] !== '--review-activity-since') return result
        const data = JSON.parse(result.stdout)
        if (data.records) for (const row of data.records) row.review_context = 'f'.repeat(64)
        else data.review_context = 'f'.repeat(64)
        return { ...result, stdout: JSON.stringify(data) }
      })
    } else arrange(HEAD_SHA, 2)
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(db.getFailedBehaviorLaunch(behavior, heldTarget)?.launchCallId).toBe(second.id)
    const history = fixture.agentLogs
    fixture.agentLogs = []
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(runtime.getBehaviorDiagnosticIncidents(null).find((row) => row.callId === second.id)?.error)
      .toContain('Automatic retries stopped after two review timeouts')
    fixture.agentLogs = history

    // Verified explicit retry grants one successful launch, even if spawning fails first.
    arrange()
    if (initial) db.setMeta('behavior_review_new_prs_reviewers', '1')
    await resetLogCache()
    await expect(runtime.retryFailedPrReviews([second.id])).resolves.toEqual({ ok: true, targets: [heldTarget] })
    const retryKey = `behavior_operator_retry:${second.id}`
    mocks.spawnDetached.mockRejectedValueOnce(new Error('launcher unavailable'))
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(4)
    expect(db.getMeta(retryKey)).toContain(second.correlation_id)
    expireBackoff()
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(5)
    expect(db.getMeta(retryKey)).toBe('')
    fixture.agentLogs.push(receipt())
    await tick()
    expireBackoff()
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(5)

    // New input remains eligible; uncertain publication on it still holds.
    arrange('c'.repeat(40))
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(6)
    fixture.agentLogs.push(receipt(pr.number, { error: 'Review timed out; could not prove a safe recovery' }))
    await tick()
    expireBackoff()
    ;({ database: db, behaviors: runtime } = await restartModules())
    runtime.startBehaviorsRuntime()
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(6)
  },
)

it.each(['initial review', 'approval'] as const)(
  'materializes an upgrade stop with no retained claim and keeps it retryable', async (lane) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    const initial = lane === 'initial review'
    const behavior = initial ? 'review-new-prs' : 'approve-prs'
    const launchBehavior = initial ? 'pr_review' : 'pr_approve'
    const model = 'opus-5-xhigh'
    const arrange = (head = HEAD_SHA, responses = 1) => arrangeCli(!initial, false, {
      headSha: head, reviewerReviewIdsSince: [], latestActivityAt: new Date().toISOString(),
    }, { commits_after_request: 0, author_commits_after_request: 0,
      author_pr_comments_after_request: initial ? 0 : responses, response_count: initial ? 0 : responses })
    arrange()
    mocks.spawnDetached.mockResolvedValue(undefined)
    let { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
    db.setMeta('models', JSON.stringify({ slots: { primary: model, secondary: model, tertiary: model },
      places: { [launchBehavior]: { slot: 'primary' } } }))
    if (initial) {
      db.setMeta('behavior_review_new_prs_keyver', '3')
      db.recordSeen(behavior, '__snapshot_v3__')
      db.setMeta('behavior_review_new_prs_reviewers', '1')
    }
    runtime.startBehaviorsRuntime()
    const tick = async () => { await resetLogCache(); await runtime.runEnabledBehaviorsOnce() }
    const expireBackoff = () => vi.setSystemTime(Date.now() + 3_600_001)
    // Two matching automatic timeouts with no retained launch, as left by a
    // runtime that released its claims before the upgrade.
    const started = new Date().toISOString()
    const upgradeReceipt = (id: string, correlation: string) => agentLog({ id, behavior: launchBehavior,
      repo: pr.repo, pr_id: String(pr.number), model, status: 'failed',
      started_at: started, started_at_precise: started, completed_at: new Date().toISOString(),
      expected_head: HEAD_SHA, actor: 'review-bot', source: `poise:${behavior}`,
      correlation_id: correlation, action: 'not_started', outcome: 'preflight_failed',
      review_policy: 'bounded-v1', error_code: 'review_budget_exhausted',
      error: 'Review reached its total time limit; needs attention' })
    const firstId = 'a'.repeat(32)
    const secondId = 'b'.repeat(32)
    fixture.agentLogs.push(upgradeReceipt(firstId, 'upgrade-one'), upgradeReceipt(secondId, 'upgrade-two'))
    await tick()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    const snapshot = await (await import('../server/agent')).fetchAgentLogSnapshot()
    const incident = runtime.getBehaviorDiagnosticIncidents(snapshot).find((row) => row.callId === secondId)!
    expect(incident.error).toContain('Automatic retries stopped after two review timeouts')
    expect(incident.nextRetryAt).toBeUndefined()
    const heldTarget = incident.target
    expect(db.getFailedBehaviorLaunch(behavior, heldTarget)?.launchCallId).toBe(secondId)
    await resetLogCache()
    await expect(runtime.retryFailedPrReviews([secondId])).resolves.toEqual({ ok: true, targets: [heldTarget] })
    expireBackoff()
    await tick()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
  },
)

it('honors an explicit approval retry across a same-head target drift', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
  const behavior = 'approve-prs' as const
  const model = 'opus-5-xhigh'
  const arrange = (responses = 1) => arrangeCli(true, false, {
    headSha: HEAD_SHA, reviewerReviewIdsSince: [], latestActivityAt: new Date().toISOString(),
  }, { commits_after_request: 0, author_commits_after_request: 0,
    author_pr_comments_after_request: responses, response_count: responses })
  arrange(1)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database: db, behaviors: runtime } = await loadModules()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_approve_prs_enabled', '1')
  db.setMeta('models', JSON.stringify({ slots: { primary: model, secondary: model, tertiary: model },
    places: { pr_approve: { slot: 'primary' } } }))
  runtime.startBehaviorsRuntime()
  const tick = async () => { await resetLogCache(); await runtime.runEnabledBehaviorsOnce() }
  const expireBackoff = () => vi.setSystemTime(Date.now() + 3_600_001)
  await tick()
  expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
  const claim = db.listBehaviorLaunchClaims(behavior).find((row) => row.launchPr === pr.number)!
  const started = claim.launchRequestedAt
  const receipt = (id: string, correlation: string) => agentLog({ id, behavior: 'pr_approve',
    repo: pr.repo, pr_id: String(pr.number), model, status: 'failed', started_at: started,
    started_at_precise: started, completed_at: new Date().toISOString(), expected_head: claim.launchExpectedHead,
    actor: claim.launchActor, source: claim.launchSource, correlation_id: correlation,
    action: 'not_started', outcome: 'preflight_failed', review_policy: 'bounded-v1',
    error_code: 'review_budget_exhausted', error: 'Review reached its total time limit; needs attention' })
  const firstId = 'c'.repeat(32)
  const secondId = 'd'.repeat(32)
  // Rewrite the single active claim's history as two matching timeouts: the
  // scheduler holds the second launch, then retains it as the stop.
  fixture.agentLogs.push(receipt(firstId, claim.launchCorrelationId))
  await tick()
  expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
  expireBackoff()
  await tick()
  expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  const secondClaim = db.listBehaviorLaunchClaims(behavior).find((row) => row.launchPr === pr.number)!
  fixture.agentLogs.push({ ...receipt(secondId, secondClaim.launchCorrelationId),
    started_at: secondClaim.launchRequestedAt, started_at_precise: secondClaim.launchRequestedAt })
  await tick()
  expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  const heldTarget = secondClaim.target
  await resetLogCache()
  await expect(runtime.retryFailedPrReviews([secondId])).resolves.toEqual({ ok: true, targets: [heldTarget] })
  // A same-head author response derives a new approval target, but the
  // verified retry still permits the next launch.
  arrange(2)
  expireBackoff()
  await tick()
  expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
})

it('retries a budget stop after reviewer casing drift', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
  const behavior = 'review-new-prs' as const
  const model = 'opus-5-xhigh'
  arrangeCli(false, false, {
    headSha: HEAD_SHA, reviewerReviewIdsSince: [], latestActivityAt: new Date().toISOString(),
  }, { commits_after_request: 0, author_commits_after_request: 0,
    author_pr_comments_after_request: 0, response_count: 0 })
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database: db, behaviors: runtime } = await loadModules()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_review_new_prs_enabled', '1')
  db.setMeta('models', JSON.stringify({ slots: { primary: model, secondary: model, tertiary: model },
    places: { pr_review: { slot: 'primary' } } }))
  db.setMeta('behavior_review_new_prs_keyver', '3')
  db.recordSeen(behavior, '__snapshot_v3__')
  db.setMeta('behavior_review_new_prs_reviewers', '1')
  // Historical Caller receipts keep the old casing while the configured
  // reviewer now uses a different casing for the same account.
  db.setMeta('agentAccount', 'Review-Bot')
  runtime.startBehaviorsRuntime()
  const tick = async () => { await resetLogCache(); await runtime.runEnabledBehaviorsOnce() }
  const started = new Date().toISOString()
  const upgradeReceipt = (id: string, correlation: string) => agentLog({ id, behavior: 'pr_review',
    repo: pr.repo, pr_id: String(pr.number), model, status: 'failed',
    started_at: started, started_at_precise: started, completed_at: new Date().toISOString(),
    expected_head: HEAD_SHA, actor: 'review-bot', source: 'poise:review-new-prs',
    correlation_id: correlation, action: 'not_started', outcome: 'preflight_failed',
    review_policy: 'bounded-v1', error_code: 'review_budget_exhausted',
    error: 'Review reached its total time limit; needs attention' })
  const firstId = 'e'.repeat(32)
  const secondId = 'f'.repeat(31) + '0'
  fixture.agentLogs.push(upgradeReceipt(firstId, 'casing-one'), upgradeReceipt(secondId, 'casing-two'))
  await tick()
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
  const held = db.getFailedBehaviorLaunch(behavior, `${pr.repo}#${pr.number}`)
  expect(held?.launchCallId).toBe(secondId)
  expect(held?.launchActor).toBe('Review-Bot')
  await resetLogCache()
  await expect(runtime.retryFailedPrReviews([secondId])).resolves.toEqual({ ok: true, targets: [`${pr.repo}#${pr.number}`] })
})

it('heals a budget stop that lost its incident before the dead-letter write', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
  const behavior = 'review-new-prs' as const
  const model = 'opus-5-xhigh'
  arrangeCli(false, false, {
    headSha: HEAD_SHA, reviewerReviewIdsSince: [], latestActivityAt: new Date().toISOString(),
  }, { commits_after_request: 0, author_commits_after_request: 0,
    author_pr_comments_after_request: 0, response_count: 0 })
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database: db, behaviors: runtime } = await loadModules()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_review_new_prs_enabled', '1')
  db.setMeta('models', JSON.stringify({ slots: { primary: model, secondary: model, tertiary: model },
    places: { pr_review: { slot: 'primary' } } }))
  db.setMeta('behavior_review_new_prs_keyver', '3')
  db.recordSeen(behavior, '__snapshot_v3__')
  db.setMeta('behavior_review_new_prs_reviewers', '1')
  runtime.startBehaviorsRuntime()
  const tick = async () => { await resetLogCache(); await runtime.runEnabledBehaviorsOnce() }
  const started = new Date().toISOString()
  const upgradeReceipt = (id: string, correlation: string) => agentLog({ id, behavior: 'pr_review',
    repo: pr.repo, pr_id: String(pr.number), model, status: 'failed',
    started_at: started, started_at_precise: started, completed_at: new Date().toISOString(),
    expected_head: HEAD_SHA, actor: 'review-bot', source: 'poise:review-new-prs',
    correlation_id: correlation, action: 'not_started', outcome: 'preflight_failed',
    review_policy: 'bounded-v1', error_code: 'review_budget_exhausted',
    error: 'Review reached its total time limit; needs attention' })
  const firstId = '1'.repeat(31) + 'a'
  const secondId = '2'.repeat(31) + 'b'
  fixture.agentLogs.push(upgradeReceipt(firstId, 'heal-one'), upgradeReceipt(secondId, 'heal-two'))
  await tick()
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
  const heldTarget = `${pr.repo}#${pr.number}`
  expect(db.getFailedBehaviorLaunch(behavior, heldTarget)?.launchCallId).toBe(secondId)
  // A process exit between the hold upsert and the dead-letter insert leaves
  // the retained stop without its incident.
  db.db.prepare('DELETE FROM behavior_dead_letters WHERE behavior = ?').run(behavior)
  await tick()
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
  const snapshot = await (await import('../server/agent')).fetchAgentLogSnapshot()
  const incident = runtime.getBehaviorDiagnosticIncidents(snapshot).find((row) => row.callId === secondId)!
  expect(incident.error).toContain('Automatic retries stopped after two review timeouts')
  expect(incident.nextRetryAt).toBeUndefined()
  await resetLogCache()
  await expect(runtime.retryFailedPrReviews([secondId])).resolves.toEqual({ ok: true, targets: [heldTarget] })
})
