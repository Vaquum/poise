import { chainBasis } from '../server/behavior-chain-store'
import type { LogEntry } from '../server/agent-log-parse'

export function completedReviewCall(repository: string, number: number, head: string, actor: string): LogEntry {
  const now = Date.now()
  const id = chainBasis([repository, number]).slice(0, 32)
  return { id, repo: repository, pr_id: String(number), actor, model: 'fixture', behavior: 'pr_review',
    session_id: null, prompt: '', started_at: new Date(now - 2000).toISOString(), completed_at: new Date(now).toISOString(),
    time_elapsed: '2s', status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 91,
    head_sha: head, expected_head: head, source: 'poise:review-new-prs', correlation_id: `review-${id}`, response: null, error: '',
    artifact: { review_response: { repository, pull_number: number, reviewer: actor, model: 'fixture',
      invocation_id: id, head_sha: head, context_sha: 'b'.repeat(64), completed_at: now - 1000,
      assessment: { verdict: 'The changed validation has no remaining blocking defects.',
        reviewed_context: 'Inspected the immutable diff and affected callers.', limitations: 'No live provider calls.' } } } }
}
