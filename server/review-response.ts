import type { LogEntry } from './agent-log-parse'

export interface ReviewResponse extends Record<string, unknown> {
  repository: string
  pull_number: number
  head_sha: string
  context_sha: string
  reviewer: string
  model: string
  invocation_id: string
  completed_at: number
  assessment: { verdict: string, reviewed_context: string, limitations: string }
}

export function validReviewResponse(value: unknown, target: { repository: string, number: number, head: string,
  actor: string, callId: string, model: string, recoveryModel?: string | null, context?: string, startedAt: number, completedAt: number,
  allowIncomplete?: boolean, legacyNegative?: boolean, resumedFrom?: { callId: string, startedAt: number } }, now: number): value is ReviewResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const assessment = response.assessment as Record<string, unknown> | null
  // A resumed finalization keeps its publisher's invocation and completion;
  // the pair stays bound together so neither window can launder the other.
  const resumed = target.resumedFrom !== undefined && response.invocation_id === target.resumedFrom.callId ? target.resumedFrom : null
  const callId = resumed?.callId ?? target.callId
  const startedAt = resumed?.startedAt ?? target.startedAt
  return response.repository === target.repository && response.pull_number === target.number && response.head_sha === target.head
    && (response.coverage === 'complete' || target.allowIncomplete === true && response.coverage === 'incomplete'
      || target.legacyNegative === true && response.coverage === undefined)
    && response.reviewer === target.actor && response.invocation_id === callId && /^[0-9a-f]{32}$/.test(callId)
    && (response.model === target.model || (typeof target.recoveryModel === 'string' && response.model === target.recoveryModel))
    && typeof response.context_sha === 'string' && /^[0-9a-f]{64}$/.test(response.context_sha)
    && (target.context === undefined || response.context_sha === target.context)
    && Number.isFinite(startedAt) && Number.isFinite(target.completedAt) && target.completedAt <= now
    && typeof response.completed_at === 'number' && Number.isSafeInteger(response.completed_at)
    && startedAt <= response.completed_at && response.completed_at <= target.completedAt
    && !!assessment && Object.keys(assessment).sort().join(',') === 'limitations,reviewed_context,verdict'
    && (['verdict', 'reviewed_context', 'limitations'] as const).every((key) => typeof assessment[key] === 'string'
      && [...assessment[key].trim()].length >= (key === 'limitations' ? 4 : 20) && [...assessment[key].trim()].length <= 4000)
    && String(assessment.verdict).trim() !== 'Reviewed: no blocking findings.'
}

/** A retained finalization's publisher identity and window, when the Call
 * carries a well-formed publication link. */
export function resumeLink(artifact: Record<string, unknown> | null | undefined): { callId: string, startedAt: number } | undefined {
  const link = artifact?.review_resume as { publication_call?: unknown, publisher_started_at?: unknown } | undefined
  return typeof link?.publication_call === 'string' && typeof link?.publisher_started_at === 'string'
    && Number.isFinite(Date.parse(link.publisher_started_at))
    ? { callId: link.publication_call, startedAt: Date.parse(link.publisher_started_at) } : undefined
}

export function callReviewResponse(call: LogEntry, now: number): ReviewResponse | null {
  const value = call.artifact?.review_response
  const resumedFrom = resumeLink(call.artifact)
  return call.status === 'completed' && ['reviewed_clean', 'approved'].includes(call.action || '')
    && call.repo !== null && call.pr_id !== null && call.head_sha !== null && call.actor !== null && call.expected_head === call.head_sha
    && !!call.source?.startsWith('poise:') && !!call.correlation_id && typeof call.review_id === 'number' && call.review_id > 0
    && validReviewResponse(value, { repository: call.repo, number: Number(call.pr_id), head: call.head_sha,
      actor: call.actor, callId: call.id, model: call.model, recoveryModel: call.recovery_model, startedAt: Date.parse(call.started_at_precise || call.started_at),
      completedAt: Date.parse(call.completed_at || ''), resumedFrom }, now) ? value : null
}
