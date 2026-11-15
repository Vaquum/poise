import { expect, it } from 'vitest'
import { parseAgentLogRow, type LogEntry } from '../server/agent-log-parse'
import { yieldedFinalization, yieldedReview, type ReviewCheckpoint } from '../server/review-continuation'

function checkpoint(): ReviewCheckpoint {
  return { root_call: 'a'.repeat(32), basis: 'b'.repeat(64), generation: 1, unit: 1, required_units: 1,
    attempts: 1, spent_ms: 1, allowance_ms: 1000, last_progress_at: 1, progress_call: 'c'.repeat(32) }
}

function link(): Record<string, unknown> {
  return { root_call: 'a'.repeat(32), basis: 'b'.repeat(64), generation: 1, slot: 'primary' }
}

function call(artifact: Record<string, unknown>, error_code: string | null, extra?: Record<string, unknown>): LogEntry {
  return { behavior: 'pr_review', status: 'failed', action: 'not_started', outcome: 'incomplete', error_code,
    head_sha: null, review_id: null, review_comments: null, receipts: null, artifact, ...extra } as unknown as LogEntry
}

it('yields analysis checkpoints only before a response is retained', () => {
  const base = { phase: 'reviewing', review_checkpoint: checkpoint(), review_resume: link() }
  expect(yieldedReview(call(base, 'review_continuation_required'))).toEqual(checkpoint())
  expect(yieldedReview(call({ ...base, review_response: {} }, 'review_continuation_required'))).toBeNull()
  expect(yieldedReview(call(base, 'review_continuation_held'))).toBeNull()
})

it('yields finalization checkpoints only with a retained response', () => {
  const base = { phase: 'reviewing', review_checkpoint: checkpoint(), review_resume: link(), review_response: { verdict: true } }
  expect(yieldedFinalization(call(base, 'review_continuation_required'))).toEqual(checkpoint())
  expect(yieldedFinalization(call({ ...base, review_response: undefined }, 'review_continuation_required'))).toBeNull()
  expect(yieldedFinalization(call(base, 'review_continuation_held'))).toBeNull()
  expect(yieldedFinalization(call(base, 'review_continuation_required', { behavior: 'review-issue' }))).toBeNull()
  expect(yieldedFinalization(call(base, 'review_continuation_required', { status: 'completed' }))).toBeNull()
  expect(yieldedFinalization(call(base, 'review_continuation_required', { review_id: 91 }))).toEqual(checkpoint())
})

it('admits an interrupted finalization with a retained response as a resumable entry', () => {
  const row = {
    id: 'a'.repeat(32), model: 'test-model', prompt: 'review', time_elapsed: '1s',
    started_at: new Date(1000).toISOString(), completed_at: new Date(2000).toISOString(),
    status: 'failed', outcome: 'incomplete', action: null,
    behavior: 'pr_review', source: 'poise:behavior-chain', repo: 'octo/demo', pr_id: '7',
    actor: 'reviewer', correlation_id: 'corr-1',
    head_sha: 'd'.repeat(40), expected_head: 'd'.repeat(40),
    error: 'finalization timed out', error_code: 'review_continuation_required',
    review_id: null, review_comments: null, receipts: null,
    artifact: { phase: 'submitting_review', review_checkpoint: checkpoint(), review_resume: link(), review_response: { verdict: true } },
  }
  const parsed = parseAgentLogRow(row, 0)
  expect(parsed).toHaveProperty('entry')
  if (!('entry' in parsed)) throw new Error('expected a resumable entry, got quarantine')
  expect(yieldedFinalization(parsed.entry)).toEqual(checkpoint())
})
