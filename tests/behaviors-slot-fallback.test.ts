import { describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '../server/agent'
import type { ReviewerTripKind } from '../server/behaviors'
import { mocks, pr, loadModules, resetLogCache, arrangeCli, agentLog, fixture } from './behaviors-runtime-fixture'

const RATE_LIMIT_ERROR = 'codex review failed: Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)'

function modelOf(call: unknown[]): string {
  const args = call[1] as string[]
  return args[args.indexOf('--model') + 1]
}

describe('reviewer trip classification', () => {
  const trips: Array<{ name: string, error: string, code?: string, expected: ReviewerTripKind }> = [
    { name: 'codex 429 reconnect loop', error: RATE_LIMIT_ERROR, expected: 'rate_limit' },
    { name: 'status 429', error: 'API error (status 429 Too Many Requests)', expected: 'rate_limit' },
    { name: 'http_status 429', error: '{"http_status": 429}', expected: 'rate_limit' },
    { name: 'rate-limit words', error: 'Provider rate-limited this run for over a minute', expected: 'rate_limit' },
    { name: 'provider error code', error: 'codex review failed: turn errored', code: 'review_provider_error', expected: 'provider' },
    { name: 'provider exit code', error: 'codex review failed: provider exited', code: 'review_provider_exit', expected: 'provider' },
    { name: 'budget exhausted code', error: 'Review reached its total time limit; needs attention', code: 'review_budget_exhausted', expected: 'budget' },
    { name: '402 stays an account trip', error: 'API error (status 402 Payment Required)', expected: 'balance' },
  ]

  const holds: Array<{ name: string, error: string, code?: string }> = [
    { name: 'GitHub 429', error: 'error: GitHub 429: rate limit exceeded for resource' },
    { name: 'GitHub 403 rate-limit', error: 'error: GitHub 403 rate-limit: {headers}' },
    { name: 'line 429', error: 'verdict failed at line 429' },
    { name: 'pull number 429', error: 'failed to fetch https://api.github.com/repos/o/r/pulls/429' },
    { name: 'ordinary failure', error: 'max turns reached' },
    { name: 'model at capacity', error: 'Selected model is at capacity. Please try a different model.', code: 'provider_capacity' },
    { name: 'empty', error: '' },
  ]

  it.each(trips)('trips on $name', async ({ error, code, expected }) => {
    const { behaviors } = await loadModules()
    expect(behaviors.reviewerTripKind({ error, error_code: code } as LogEntry)).toBe(expected)
  })

  it.each(holds)('does not trip on $name', async ({ error, code }) => {
    const { behaviors } = await loadModules()
    expect(behaviors.reviewerTripKind({ error, error_code: code } as LogEntry)).toBeNull()
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
})
