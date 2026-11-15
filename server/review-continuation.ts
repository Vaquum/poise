import type { LogEntry } from './agent-log-parse'

export interface ReviewCheckpoint {
  root_call: string
  basis: string
  generation: number
  unit: number
  required_units: number
  attempts: number
  spent_ms: number
  allowance_ms: number
  last_progress_at: number
  progress_call: string
}

const callId = /^[a-f0-9]{32}$/
const digest = /^[a-f0-9]{64}$/

/** A compact per-Call snapshot. The mutable root and the retained source
 * evidence remain Caller-owned. */
export function parseReviewCheckpoint(artifact: Record<string, unknown> | null | undefined): ReviewCheckpoint | null {
  if (artifact?.review_checkpoint === undefined) return null
  const value = artifact.review_checkpoint as ReviewCheckpoint | null
  const link = artifact.review_resume as Pick<ReviewCheckpoint, 'root_call' | 'basis' | 'generation'> | undefined
  if (!value || !link || Object.keys(value).length !== 10 || typeof value.root_call !== 'string' || !callId.test(value.root_call)
    || typeof value.progress_call !== 'string' || !callId.test(value.progress_call)
    || typeof value.basis !== 'string' || !digest.test(value.basis)
    || ![value.generation, value.required_units, value.attempts, value.allowance_ms, value.last_progress_at]
      .every(number => Number.isSafeInteger(number) && number > 0)
    || ![value.unit, value.spent_ms].every(number => Number.isSafeInteger(number) && number >= 0)
    || value.unit > value.required_units || value.required_units > 257
    || value.root_call !== link.root_call || value.basis !== link.basis || value.generation !== link.generation) {
    throw new Error('review checkpoint conflicts with its Caller claim')
  }
  return value
}

export function reviewContinuationCode(code: string | null | undefined): boolean {
  return code === 'review_continuation_required' || code === 'review_continuation_held'
}

export function reviewContinuationNoWrite(call: { behavior: unknown, status: unknown, action: unknown, outcome: unknown,
  head_sha: unknown, review_id?: unknown, review_comments?: unknown, receipts?: unknown, artifact?: Record<string, unknown> | null }): boolean {
  return (call.behavior === 'pr_review' || call.behavior === 'pr_approve') && call.status === 'failed'
    && call.action === 'not_started' && (call.outcome === 'incomplete' || call.outcome === 'preflight_failed')
    && call.head_sha == null && call.review_id == null && call.review_comments == null && call.receipts == null
    && call.artifact?.phase === 'reviewing' && call.artifact.review_response == null
}

/** A checkpoint written before a worker died is usable only after Caller
 * proves the failed Call never reached the submission reservation. */
export function yieldedReview(call: LogEntry): ReviewCheckpoint | null {
  if (!reviewContinuationNoWrite(call)
    || (call.error_code !== 'review_continuation_required' && call.error_code !== 'interrupted')) return null
  const checkpoint = parseReviewCheckpoint(call.artifact)
  if (call.error_code === 'interrupted' && checkpoint?.progress_call !== call.id) return null
  return checkpoint
}

/** A checkpoint whose analysis finished but whose finalization was interrupted
 * by a transient failure. Unlike yieldedReview, the retained response is
 * required: resuming reuses the analysis instead of repeating it. The Caller
 * verdict already rules out uncertain writes (those hold instead), and calls
 * without a retained response keep the analysis path, so the two shapes are
 * disjoint. */
export function yieldedFinalization(call: LogEntry): ReviewCheckpoint | null {
  if (call.error_code !== 'review_continuation_required') return null
  if (call.behavior !== 'pr_review' && call.behavior !== 'pr_approve') return null
  if (call.status !== 'failed') return null
  const response = call.artifact?.review_response
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null
  return parseReviewCheckpoint(call.artifact)
}

export function resumeReviewArgument(checkpoint: ReviewCheckpoint): string {
  return `${checkpoint.root_call}:${checkpoint.generation}`
}

export function reviewContinuationArgs(slot: string, checkpoint?: ReviewCheckpoint): string[] {
  return ['--review-slot', slot, '--review-units-per-call', '6',
    ...(checkpoint ? ['--resume-review', resumeReviewArgument(checkpoint)] : [])]
}
