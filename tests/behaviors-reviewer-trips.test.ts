import { describe, expect, it } from 'vitest'
import type { LogEntry } from '../server/agent'
import { mocks, pr, HEAD_SHA, loadModules, resetLogCache, arrangeCli, agentLog, fixture } from './behaviors-runtime-fixture'

const BALANCE_ERROR = 'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}'
const SIGNIN_ERROR = 'Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.'

function modelOf(call: unknown[]): string {
  const args = call[1] as string[]
  return args[args.indexOf('--model') + 1]
}

async function startPrReviews(models: Record<string, string>) {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database: db, behaviors: runtime } = await loadModules()
  runtime.startBehaviorsRuntime()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_review_new_prs_keyver', '3')
  db.setMeta('behavior_review_new_prs_enabled', '1')
  db.setMeta('behavior_review_new_prs_reviewers', '1')
  db.setMeta('models', JSON.stringify({ pr_review: models }))
  db.recordSeen('review-new-prs', '__snapshot_v3__')
  return { db, runtime }
}

function failedLog(
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

function expireBackoff(db: { getMeta: (key: string) => string | null, setMeta: (key: string, value: string) => void }, key: string, target: string): void {
  const meta = `behavior_${key}_failure:${target}`
  const stored = JSON.parse(db.getMeta(meta)!)
  db.setMeta(meta, JSON.stringify({ ...stored, nextRetryAtMs: Date.now() - 1 }))
}

describe('reviewer account trips', () => {
  const accountFailures: Array<{ name: string, error: string, extras: Record<string, unknown> }> = [
    {
      name: 'a 402 balance-exhausted preflight',
      error: BALANCE_ERROR,
      extras: { error_code: 'review_provider_blocked', review_policy: 'bounded-v1', action: 'not_started', outcome: 'preflight_failed' },
    },
    { name: 'a not-signed-in failure', error: SIGNIN_ERROR, extras: {} },
  ]

  it.each(accountFailures)('trips the reviewer on $name and falls back to the next reviewer', async ({ error, extras }) => {
    const { db, runtime } = await startPrReviews({
      default: 'grok-4.6-xhigh', fallback: 'gpt-6-astra-ultra',
      secondary: 'opus-5-xhigh', tertiary: 'gpt-6-astra-ultra',
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    expect(modelOf(mocks.spawnDetached.mock.calls[0])).toBe('grok-4.6-xhigh')

    const key = `${pr.repo}#${pr.number}`
    fixture.agentLogs = [failedLog(db, key, 'grok-4.6-xhigh', { error, ...extras })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()

    // One clear failure about the reviewer — not a dead letter for the target.
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({
        behavior: 'review-new-prs', target: 'reviewer:grok-4.6-xhigh', kind: 'operation',
        consecutiveFailures: 1,
        error: expect.stringContaining('grok-4.6-xhigh cannot review'),
      }),
    ])
    // The same tick relaunches the review with the next configured reviewer.
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#17')
    expect(modelOf(mocks.spawnDetached.mock.calls[1])).toBe('opus-5-xhigh')

    // Later reviews skip the tripped reviewer without further dead letters.
    fixture.listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(mocks.spawnDetached.mock.calls[2][1]).toContain('#18')
    expect(modelOf(mocks.spawnDetached.mock.calls[2])).toBe('opus-5-xhigh')
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toHaveLength(1)
  })

  it('waits while every reviewer is tripped, then retries and clears on success', async () => {
    const { db, runtime } = await startPrReviews({
      default: 'grok-4.6-xhigh', fallback: 'gpt-6-astra-ultra',
      secondary: 'grok-4.6-xhigh', tertiary: 'grok-4.6-xhigh',
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)

    const key = `${pr.repo}#${pr.number}`
    fixture.agentLogs = [failedLog(db, key, 'grok-4.6-xhigh', {
      error: BALANCE_ERROR, error_code: 'review_provider_blocked',
      review_policy: 'bounded-v1', action: 'not_started', outcome: 'preflight_failed',
    })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()

    // Tripped, released, and nothing to fall back to: the review waits.
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ target: 'reviewer:grok-4.6-xhigh' }),
    ])

    // Still waiting on the next tick: no launch, no new incident.
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    expect(db.listBehaviorDeadLetters()).toEqual([])

    // Once the backoff comes due, one launch probes the account again.
    expireBackoff(db, 'review_new_prs', 'reviewer:grok-4.6-xhigh')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(modelOf(mocks.spawnDetached.mock.calls[1])).toBe('grok-4.6-xhigh')

    // Its success clears the trip; the next review uses it again.
    const probe = db.listBehaviorLaunchClaims('review-new-prs')[0]
    fixture.agentLogs = [agentLog({
      id: '2'.repeat(32),
      model: 'grok-4.6-xhigh',
      started_at: probe.launchRequestedAt,
      started_at_precise: probe.launchRequestedAt,
      status: 'completed',
      completed_at: new Date().toISOString(),
      action: 'reviewed_clean',
      outcome: 'clean',
      head_sha: HEAD_SHA,
      expected_head: probe.launchExpectedHead,
      actor: probe.launchActor,
      source: probe.launchSource,
      correlation_id: probe.launchCorrelationId,
    })]
    await resetLogCache()
    fixture.listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(mocks.spawnDetached.mock.calls[2][1]).toContain('#18')
    expect(modelOf(mocks.spawnDetached.mock.calls[2])).toBe('grok-4.6-xhigh')
  })

  it('leaves an ordinary review failure on the per-target path without tripping', async () => {
    const { db, runtime } = await startPrReviews({
      default: 'opus-5-xhigh', fallback: 'gpt-6-astra-ultra',
      secondary: 'gpt-6-astra-ultra', tertiary: 'grok-4.6-xhigh',
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(modelOf(mocks.spawnDetached.mock.calls[0])).toBe('opus-5-xhigh')

    const key = `${pr.repo}#${pr.number}`
    fixture.agentLogs = [failedLog(db, key, 'opus-5-xhigh', { error: 'max turns reached' })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()

    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({ target: key, error: 'max turns reached' }),
    ])
    const failures = runtime.getBehaviorsRuntimeHealth().failures
    expect(failures).toEqual([expect.objectContaining({ target: key, kind: 'worker' })])
    expect(failures.some((failure) => failure.target?.startsWith('reviewer:'))).toBe(false)

    // After its backoff it runs again with the same reviewer.
    expireBackoff(db, 'review_new_prs', key)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(modelOf(mocks.spawnDetached.mock.calls[1])).toBe('opus-5-xhigh')
  })

  it('retires trips for reviewers no place configures, and keeps the rest', async () => {
    const { db, runtime } = await startPrReviews({
      default: 'opus-5-xhigh', fallback: 'gpt-6-astra-ultra',
      secondary: 'gpt-6-astra-ultra', tertiary: 'grok-4.6-xhigh',
    })
    for (const identity of ['retired-model-1-max', 'grok-4.6-xhigh']) {
      db.setMeta(`behavior_review_new_prs_failure:reviewer:${identity}`, JSON.stringify({
        kind: 'operation',
        consecutiveFailures: 1,
        lastFailureAtMs: Date.now(),
        nextRetryAtMs: Date.now() + 3_600_000,
        error: `${identity} cannot review delivery probe`,
      }))
    }
    await runtime.runEnabledBehaviorsOnce()
    const targets = runtime.getBehaviorsRuntimeHealth().failures.map((failure) => failure.target)
    expect(targets).toContain('reviewer:grok-4.6-xhigh')
    expect(targets).not.toContain('reviewer:retired-model-1-max')
  })

  const classifications: Array<{ name: string, error: string, expected: 'balance' | 'signin' | null }> = [
    { name: '402 balance JSON', error: BALANCE_ERROR, expected: 'balance' },
    { name: 'bare balance-exhausted text', error: 'Grok Build usage balance exhausted', expected: 'balance' },
    { name: '402 status text', error: 'API error (status 402 Payment Required)', expected: 'balance' },
    { name: 'http_status 402', error: '{"http_status": 402}', expected: 'balance' },
    { name: 'sign-in text', error: SIGNIN_ERROR, expected: 'signin' },
    { name: 'missing credentials', error: 'grok: missing credentials for Grok Build', expected: 'signin' },
    { name: 'ordinary failure', error: 'max turns reached', expected: null },
    { name: 'pull number 402', error: 'failed to fetch https://api.github.com/repos/o/r/pulls/402', expected: null },
    { name: 'issue reference 402', error: 'see #402 for context', expected: null },
    { name: 'line number 402', error: 'verdict failed at line 402', expected: null },
    { name: 'local latch', error: 'MUSE GUARD: Muse provider access is latched off locally', expected: null },
    { name: 'safeguards', error: 'safeguards flagged this message', expected: null },
    { name: 'empty', error: '', expected: null },
  ]

  it.each(classifications)('classifies $name', async ({ error, expected }) => {
    const { behaviors } = await loadModules()
    expect(behaviors.reviewAccountFailure({ error } as LogEntry)).toBe(expected)
  })

  it('probes a due trip with one launch while the other waiting targets hold', async () => {
    const { db, runtime } = await startPrReviews({
      default: 'grok-4.6-xhigh', fallback: 'gpt-6-astra-ultra',
      secondary: 'grok-4.6-xhigh', tertiary: 'grok-4.6-xhigh',
    })
    await runtime.runEnabledBehaviorsOnce()
    const key = `${pr.repo}#${pr.number}`
    fixture.agentLogs = [failedLog(db, key, 'grok-4.6-xhigh', {
      error: BALANCE_ERROR, error_code: 'review_provider_blocked',
      review_policy: 'bounded-v1', action: 'not_started', outcome: 'preflight_failed',
    })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)

    // Two reviews wait while the trip is due: exactly one probes.
    expireBackoff(db, 'review_new_prs', 'reviewer:grok-4.6-xhigh')
    fixture.listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toHaveLength(1)
    expect(modelOf(mocks.spawnDetached.mock.calls[1])).toBe('grok-4.6-xhigh')
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ target: 'reviewer:grok-4.6-xhigh', consecutiveFailures: 2 }),
    ])

    // The probe's failure re-trips instead of launching the waiter.
    const probe = db.listBehaviorLaunchClaims('review-new-prs')[0]
    fixture.agentLogs = [agentLog({
      id: '3'.repeat(32),
      model: 'grok-4.6-xhigh',
      pr_id: String(probe.launchPr),
      started_at: probe.launchRequestedAt,
      started_at_precise: probe.launchRequestedAt,
      status: 'failed',
      error: BALANCE_ERROR,
      error_code: 'review_provider_blocked',
      review_policy: 'bounded-v1',
      action: 'not_started',
      outcome: 'preflight_failed',
      expected_head: probe.launchExpectedHead,
      actor: probe.launchActor,
      source: probe.launchSource,
      correlation_id: probe.launchCorrelationId,
    })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ target: 'reviewer:grok-4.6-xhigh', consecutiveFailures: 3 }),
    ])
  })

  it('trips the recovery model on its 402 and holds the target', async () => {
    const { db, runtime } = await startPrReviews({
      default: 'opus-5-xhigh', fallback: 'gpt-6-astra-ultra',
      secondary: 'gpt-6-astra-ultra', tertiary: 'grok-4.6-xhigh',
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(modelOf(mocks.spawnDetached.mock.calls[0])).toBe('opus-5-xhigh')

    // Caller names the healthy primary in `model` and the refused recovery
    // in `recovery_model`.
    const key = `${pr.repo}#${pr.number}`
    fixture.agentLogs = [failedLog(db, key, 'opus-5-xhigh', {
      error: `grok-4.6-xhigh recovery failed; needs attention: ${BALANCE_ERROR}`,
      error_code: 'review_recovery_failed',
      review_policy: 'bounded-v1',
      recovery_model: 'grok-4.6-xhigh',
    })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()

    expect(db.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: key })])
    const failures = runtime.getBehaviorsRuntimeHealth().failures
    expect(failures).toEqual([
      expect.objectContaining({
        target: 'reviewer:grok-4.6-xhigh',
        error: expect.stringContaining('grok-4.6-xhigh cannot review'),
      }),
    ])
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)

    // The healthy primary keeps reviewing; only the recovery is gated.
    fixture.listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(modelOf(mocks.spawnDetached.mock.calls[1])).toBe('opus-5-xhigh')
  })

  it('clears only the recovery trip when a verdict comes from the recovery', async () => {
    const { db, runtime } = await startPrReviews({
      default: 'opus-5-xhigh', fallback: 'gpt-6-astra-ultra',
      secondary: 'gpt-6-astra-ultra', tertiary: 'grok-4.6-xhigh',
    })
    for (const identity of ['opus-5-xhigh', 'grok-4.6-xhigh']) {
      db.setMeta(`behavior_review_new_prs_failure:reviewer:${identity}`, JSON.stringify({
        kind: 'operation',
        consecutiveFailures: 1,
        lastFailureAtMs: Date.now(),
        nextRetryAtMs: Date.now() + 3_600_000,
        error: `${identity} cannot review delivery probe`,
      }))
    }
    await runtime.runEnabledBehaviorsOnce()
    expect(modelOf(mocks.spawnDetached.mock.calls[0])).toBe('gpt-6-astra-ultra')

    const probe = db.listBehaviorLaunchClaims('review-new-prs')[0]
    fixture.agentLogs = [agentLog({
      id: '4'.repeat(32),
      model: 'gpt-6-astra-ultra',
      recovery_model: 'grok-4.6-xhigh',
      started_at: probe.launchRequestedAt,
      started_at_precise: probe.launchRequestedAt,
      status: 'completed',
      completed_at: new Date().toISOString(),
      action: 'reviewed_clean',
      outcome: 'clean',
      head_sha: HEAD_SHA,
      expected_head: probe.launchExpectedHead,
      actor: probe.launchActor,
      source: probe.launchSource,
      correlation_id: probe.launchCorrelationId,
    })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures.map((failure) => failure.target))
      .toEqual(['reviewer:opus-5-xhigh'])
  })

  it('holds a target whose run posted before its account error, without tripping', async () => {
    const { db, runtime } = await startPrReviews({
      default: 'grok-4.6-xhigh', fallback: 'gpt-6-astra-ultra',
      secondary: 'opus-5-xhigh', tertiary: 'gpt-6-astra-ultra',
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(modelOf(mocks.spawnDetached.mock.calls[0])).toBe('grok-4.6-xhigh')

    const key = `${pr.repo}#${pr.number}`
    fixture.agentLogs = [failedLog(db, key, 'grok-4.6-xhigh', {
      error: BALANCE_ERROR, head_sha: HEAD_SHA, review_id: 91,
    })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()

    // Submitted work proves the account ran: the ordinary hold applies.
    expect(db.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: key })])
    const failures = runtime.getBehaviorsRuntimeHealth().failures
    expect(failures).toEqual([expect.objectContaining({ target: key, kind: 'worker' })])
    expect(failures.some((failure) => failure.target?.startsWith('reviewer:'))).toBe(false)
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
  })
})
