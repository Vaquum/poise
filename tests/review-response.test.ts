import { expect, it } from 'vitest'
import type { BehaviorChain, ChainInvocation } from '../server/behavior-chain-store'
import { chainReviewResponse, type ChainObservation } from '../server/behavior-chain-decision'
import { callReviewResponse, validReviewResponse } from '../server/review-response'
import { parseAgentLogList } from '../server/agent-log-parse'
import { completedReviewCall } from './review-response-fixture'

const NOW = 1_800_000_000_000
const target = { repository: 'example/repo', number: 7, head: 'a'.repeat(40), actor: 'reviewer',
  callId: 'c'.repeat(32), model: 'fixture', context: 'b'.repeat(64), startedAt: NOW - 2000, completedAt: NOW - 100 }
const response = { repository: target.repository, pull_number: 7, head_sha: target.head, reviewer: target.actor,
  invocation_id: target.callId, model: target.model, context_sha: target.context, completed_at: NOW - 1000,
  coverage: 'complete', assessment: { verdict: 'The changed validation rejects stale review coverage correctly.',
    reviewed_context: 'Inspected the immutable PR diff, callers and negative cases.', limitations: 'No live provider calls.' } }

it('decodes incomplete native notes and findings with a pinned review receipt', () => {
  const call = completedReviewCall('example/repo', 7, target.head, 'reviewer')
  const partial = { ...call, outcome: 'incomplete', action: 'requested_changes', artifact: { review_response: { coverage: 'incomplete' } } }
  expect(parseAgentLogList([partial]).quarantined).toEqual([])
  expect(parseAgentLogList([{ ...partial, status: 'failed', action: null, error_code: 'review_incomplete', error: 'Coverage incomplete' }]).quarantined).toEqual([])
  for (const behavior of ['pr_review', 'pr_approve']) {
    const note = { ...partial, behavior, action: 'reviewed_clean' }
    const logs = parseAgentLogList([note])
    expect(logs.quarantined).toEqual([])
    expect(logs.entries[0]).toMatchObject({ review_id: 91, action: 'reviewed_clean', outcome: 'incomplete' })
    expect(callReviewResponse(logs.entries[0]!, Date.now())).toBeNull()
    for (const change of [{ action: 'approved' }, { review_id: null }, { artifact: {} }, { expected_head: 'b'.repeat(40) }]) {
      expect(parseAgentLogList([{ ...note, ...change }]).quarantined).toHaveLength(1)
    }
  }
})

it('requires the substantive response from the original invocation and actual final context', () => {
  expect(validReviewResponse(response, target, NOW)).toBe(true)
  for (const invalid of [null, {}, { ...response, assessment: null }, { ...response, completed_at: NOW + 1 },
    { ...response, completed_at: NOW - 3000 }, { ...response, invocation_id: 'd'.repeat(32) },
    { ...response, context_sha: 'd'.repeat(64) }, { ...response, head_sha: 'd'.repeat(40) },
    { ...response, model: 'unconfigured-model' },
    ...['incomplete', null, undefined, true, {}].map(coverage => ({ ...response, coverage })),
    { ...response, assessment: { ...response.assessment, verdict: 'Reviewed: no blocking findings.' } }]) {
    expect(validReviewResponse(invalid, target, NOW)).toBe(false)
  }
})

it('accepts only the configured recovery identity for the same invocation', () => {
  const recovered = { ...response, model: 'configured-recovery' }
  expect(validReviewResponse(recovered, target, NOW)).toBe(false)
  expect(validReviewResponse(recovered, { ...target, recoveryModel: 'configured-recovery' }, NOW)).toBe(true)
  expect(validReviewResponse({ ...response, assessment: { ...response.assessment, verdict: ' Reviewed: no blocking findings. ' } }, target, NOW)).toBe(false)
  expect(validReviewResponse({ ...response, assessment: { ...response.assessment, limitations: '😀'.repeat(4000) } }, target, NOW)).toBe(true)
})

it('accepts a resumed finalization under its publisher identity and window', () => {
  const resumed = { ...response, invocation_id: 'd'.repeat(32), completed_at: NOW - 5000 }
  const link = { callId: 'd'.repeat(32), startedAt: NOW - 6000 }
  expect(validReviewResponse(resumed, target, NOW)).toBe(false)
  expect(validReviewResponse(resumed, { ...target, resumedFrom: link }, NOW)).toBe(true)
  // The pair stays bound: neither window launders the other.
  expect(validReviewResponse(resumed, { ...target, resumedFrom: { ...link, callId: 'e'.repeat(32) } }, NOW)).toBe(false)
  expect(validReviewResponse(resumed, { ...target, resumedFrom: { ...link, startedAt: NOW - 4000 } }, NOW)).toBe(false)
  expect(validReviewResponse({ ...resumed, completed_at: NOW + 1 }, { ...target, resumedFrom: link }, NOW)).toBe(false)
})

it('resolves a resumed chain response through its publisher marker and window', () => {
  const retained = { ...response, invocation_id: 'd'.repeat(32), completed_at: NOW - 1500 }
  const chain = { repository: 'example/repo' } as unknown as BehaviorChain
  const invocation = { callId: 'e'.repeat(32), model: 'fixture', actor: 'reviewer', admittedAt: NOW - 500,
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] },
    evidence: { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 91, completedAt: NOW - 100,
      artifact: { review_response: retained,
        review_resume: { publication_call: 'd'.repeat(32), publisher_started_at: new Date(NOW - 2000).toISOString() } } } } as unknown as ChainInvocation
  const observation = { checkedAt: NOW,
    pull: { number: 7, head: target.head, reviewContext: 'b'.repeat(64), merged: false,
      reviewReceipts: [{ id: 91, head: target.head, state: 'COMMENTED', invocation: 'd'.repeat(32),
        response: retained, submittedAt: NOW - 500 }] } } as unknown as ChainObservation
  expect(chainReviewResponse(chain, invocation, observation, NOW)).toBe(retained)
  const unlink = structuredClone(invocation) as unknown as ChainInvocation
  delete (unlink.evidence as unknown as Record<string, Record<string, unknown>>).artifact.review_resume
  expect(chainReviewResponse(chain, unlink, observation, NOW)).toBeNull()
})

it('resolves a resumed call response through its publication link', () => {
  const call = completedReviewCall('example/repo', 7, target.head, 'reviewer')
  expect(callReviewResponse(call, Date.now())).not.toBeNull()
  const started = Date.parse(call.started_at)
  const retained = call.artifact?.review_response as Record<string, unknown>
  const resumedCall = { ...call, started_at: new Date(started + 1500).toISOString(),
    artifact: { review_response: { ...retained, invocation_id: 'd'.repeat(32), completed_at: started + 1000 },
      review_resume: { publication_call: 'd'.repeat(32), publisher_started_at: call.started_at } } }
  expect(callReviewResponse(resumedCall, Date.now())).not.toBeNull()
  const unlink = { ...resumedCall, artifact: { review_response: resumedCall.artifact.review_response } }
  expect(callReviewResponse(unlink, Date.now())).toBeNull()
})
