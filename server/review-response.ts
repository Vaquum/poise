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
  actor: string, callId: string, model: string, context?: string, startedAt: number, completedAt: number }, now: number): value is ReviewResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const assessment = response.assessment as Record<string, unknown> | null
  return response.repository === target.repository && response.pull_number === target.number && response.head_sha === target.head
    && response.reviewer === target.actor && response.invocation_id === target.callId && response.model === target.model
    && typeof response.context_sha === 'string' && /^[0-9a-f]{64}$/.test(response.context_sha)
    && (target.context === undefined || response.context_sha === target.context)
    && Number.isFinite(target.startedAt) && Number.isFinite(target.completedAt) && target.completedAt <= now
    && typeof response.completed_at === 'number' && Number.isSafeInteger(response.completed_at)
    && target.startedAt <= response.completed_at && response.completed_at <= target.completedAt
    && !!assessment && Object.keys(assessment).sort().join(',') === 'limitations,reviewed_context,verdict'
    && (['verdict', 'reviewed_context', 'limitations'] as const).every((key) => typeof assessment[key] === 'string'
      && assessment[key].trim().length >= (key === 'limitations' ? 4 : 20) && assessment[key].trim().length <= 4000)
    && assessment.verdict !== 'Reviewed: no blocking findings.'
}

export function callReviewResponse(call: LogEntry, now: number): ReviewResponse | null {
  const value = call.artifact?.review_response
  return call.status === 'completed' && ['reviewed_clean', 'approved'].includes(call.action || '')
    && call.repo !== null && call.pr_id !== null && call.head_sha !== null && call.actor !== null && call.expected_head === call.head_sha
    && !!call.source?.startsWith('poise:') && !!call.correlation_id && typeof call.review_id === 'number' && call.review_id > 0
    && validReviewResponse(value, { repository: call.repo, number: Number(call.pr_id), head: call.head_sha,
      actor: call.actor, callId: call.id, model: call.model, startedAt: Date.parse(call.started_at_precise || call.started_at),
      completedAt: Date.parse(call.completed_at || '') }, now) ? value : null
}
