import { expect, it } from 'vitest'
import { validReviewResponse } from '../server/review-response'

const NOW = 1_800_000_000_000
const target = { repository: 'example/repo', number: 7, head: 'a'.repeat(40), actor: 'reviewer',
  callId: 'c'.repeat(32), model: 'fixture', context: 'b'.repeat(64), startedAt: NOW - 2000, completedAt: NOW - 100 }
const response = { repository: target.repository, pull_number: 7, head_sha: target.head, reviewer: target.actor,
  invocation_id: target.callId, model: target.model, context_sha: target.context, completed_at: NOW - 1000,
  assessment: { verdict: 'The changed validation rejects stale review coverage correctly.',
    reviewed_context: 'Inspected the immutable PR diff, callers and negative cases.', limitations: 'No live provider calls.' } }

it('requires the substantive response from the original invocation and actual final context', () => {
  expect(validReviewResponse(response, target, NOW)).toBe(true)
  for (const invalid of [null, {}, { ...response, assessment: null }, { ...response, completed_at: NOW + 1 },
    { ...response, completed_at: NOW - 3000 }, { ...response, invocation_id: 'd'.repeat(32) },
    { ...response, context_sha: 'd'.repeat(64) }, { ...response, head_sha: 'd'.repeat(40) },
    { ...response, assessment: { ...response.assessment, verdict: 'Reviewed: no blocking findings.' } }]) {
    expect(validReviewResponse(invalid, target, NOW)).toBe(false)
  }
})
