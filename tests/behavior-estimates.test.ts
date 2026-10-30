import { describe, expect, it } from 'vitest'
import { estimateBehaviorRun, readBehaviorEstimates, ESTIMATE_MIN_SAMPLES, ESTIMATE_WINDOW_MS } from '../server/behavior-estimates'
import type { LogEntry } from '../server/agent'

let seq = 0
function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  seq += 1
  return {
    id: `id${seq}`, pr_id: '1', repo: 'acme/api', actor: 'review-bot', model: 'opus',
    behavior: 'pr_review', session_id: null, prompt: '', started_at: new Date(0).toISOString(),
    time_elapsed: '1s', status: 'completed', outcome: 'clean', head_sha: null, expected_head: null,
    source: 'poise:review-new-prs', correlation_id: null, action: 'reviewed_clean', response: null, error: '',
    ...overrides,
  } as LogEntry
}

const NOW = Date.parse('2026-10-24T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

// A completed sample of `durationMs`, finished `agoMs` ago.
function sample(durationMs: number, agoMs: number, overrides: Partial<LogEntry> = {}): LogEntry {
  return entry({
    status: 'completed',
    started_at: iso(NOW - agoMs - durationMs),
    started_at_precise: iso(NOW - agoMs - durationMs),
    completed_at: iso(NOW - agoMs),
    ...overrides,
  })
}

const MIN = 60_000
const cohort = [1 * MIN, 2 * MIN, 3 * MIN, 4 * MIN, 5 * MIN].map((duration) => sample(duration, MIN))

describe('turn estimates', () => {
  it('estimates the remaining median from similar runs', () => {
    const running = entry({ status: 'running', started_at: iso(NOW - MIN), started_at_precise: iso(NOW - MIN), completed_at: null })
    expect(estimateBehaviorRun(cohort, running, NOW)).toEqual({
      remainingMs: 2 * MIN,
      basis: { medianMs: 3 * MIN, p90Ms: 5 * MIN },
      samples: 5,
    })
  })

  it('keeps different behaviors and models apart', () => {
    const running = entry({ status: 'running', behavior: 'pr_approve', model: 'opus', started_at: iso(NOW - MIN), completed_at: null })
    // Five pr_review samples and four pr_approve ones: no estimate.
    const history = [...cohort, ...[1, 2, 3, 4].map((n) => sample(n * MIN, MIN, { behavior: 'pr_approve' }))]
    expect(estimateBehaviorRun(history, running, NOW)).toBeNull()
    const otherModel = entry({ status: 'running', behavior: 'pr_review', model: 'sonnet', started_at: iso(NOW - MIN), completed_at: null })
    expect(estimateBehaviorRun(cohort, otherModel, NOW)).toBeNull()
    expect(estimateBehaviorRun(
      [...cohort, ...[1, 2, 3, 4, 5].map((n) => sample(n * MIN, MIN, { behavior: 'pr_approve' }))],
      running, NOW,
    )).toEqual({ remainingMs: 2 * MIN, basis: { medianMs: 3 * MIN, p90Ms: 5 * MIN }, samples: 5 })
    expect(ESTIMATE_MIN_SAMPLES).toBe(5)
  })

  it('measures launch to completion on the precise clock', () => {
    // started_at is coarse; the precise start is the launch.
    const precise = sample(2 * MIN, MIN, { started_at: iso(NOW - 10 * MIN) })
    const history = [precise, ...[1, 3, 4, 5].map((n) => sample(n * MIN, MIN))]
    const running = entry({ status: 'running', started_at: iso(NOW - MIN), started_at_precise: iso(NOW - MIN), completed_at: null })
    expect(estimateBehaviorRun(history, running, NOW)).toEqual({
      remainingMs: 2 * MIN, basis: { medianMs: 3 * MIN, p90Ms: 5 * MIN }, samples: 5,
    })
    // No completion, failed, superseded or unreadable rows are samples.
    const bad = [
      entry({ status: 'completed', completed_at: null }),
      entry({ status: 'failed', completed_at: iso(NOW - MIN), error: 'boom' }),
      entry({ status: 'superseded', completed_at: iso(NOW - MIN) }),
      entry({ status: 'completed', started_at_precise: 'not-a-time', completed_at: iso(NOW - MIN) }),
    ]
    expect(estimateBehaviorRun(bad, running, NOW)).toBeNull()
  })

  it('needs five samples and forgets the 30-day cutoff', () => {
    const running = entry({ status: 'running', started_at: iso(NOW - MIN), completed_at: null })
    expect(estimateBehaviorRun(cohort.slice(0, 4), running, NOW)).toBeNull()
    expect(ESTIMATE_WINDOW_MS).toBe(30 * 24 * 60 * MIN)
    const old = sample(MIN, ESTIMATE_WINDOW_MS + MIN)
    expect(estimateBehaviorRun([...cohort.slice(0, 4), old], running, NOW)).toBeNull()
    expect(estimateBehaviorRun([...cohort.slice(0, 4), sample(MIN, ESTIMATE_WINDOW_MS - MIN)], running, NOW)).not.toBeNull()
  })

  it('overruns past the 90th percentile instead of counting below zero', () => {
    const running = entry({ status: 'running', started_at: iso(NOW - 5 * MIN), started_at_precise: iso(NOW - 5 * MIN), completed_at: null })
    expect(estimateBehaviorRun(cohort, running, NOW)).toEqual({ overrun: true, basis: { medianMs: 3 * MIN, p90Ms: 5 * MIN } })
    const near = entry({ status: 'running', started_at: iso(NOW - (5 * MIN - 1)), started_at_precise: iso(NOW - (5 * MIN - 1)), completed_at: null })
    expect(estimateBehaviorRun(cohort, near, NOW)).toEqual({
      remainingMs: 0, basis: { medianMs: 3 * MIN, p90Ms: 5 * MIN }, samples: 5,
    })
  })

  it('reads every running behavior run, oldest first, skipping other rows', () => {
    const first = entry({ status: 'running', started_at: iso(NOW - 2 * MIN), completed_at: null })
    const second = entry({ status: 'running', started_at: iso(NOW - MIN), completed_at: null })
    const foreign = entry({ status: 'running', behavior: 'mergeable', started_at: iso(NOW - 3 * MIN), completed_at: null })
    const done = entry({ status: 'completed', started_at: iso(NOW - 4 * MIN), completed_at: iso(NOW - 3 * MIN) })
    const estimates = readBehaviorEstimates(cohort, [second, foreign, done, first], NOW)
    expect(estimates.map((row) => row.id)).toEqual([first.id, second.id])
    expect(estimates[0]).toMatchObject({ behavior: 'pr_review', model: 'opus', estimate: { remainingMs: MIN, samples: 5 } })
    expect(estimates[1]).toMatchObject({ estimate: { remainingMs: 2 * MIN, samples: 5 } })
  })
})
