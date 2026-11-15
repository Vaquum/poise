import type { LogEvent } from './contract.js'

/** Only the retained, typed no-submission receipt can enter this read. */
export interface HandoffCandidate {
  id: string
  callId: string
  correlationId: string
  repository: string
  pr: string
  behavior: 'pr_review' | 'pr_approve'
  head: string
  actor: string
  completedAt: number
}

export function parseHandoffCandidates(value: unknown): HandoffCandidate[] {
  if (!Array.isArray(value) || !value.length || value.length > 10 || value.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true
    const row = item as Record<string, unknown>
    return typeof row.id !== 'string' || !/^evt_[a-f0-9]{16}_[a-f0-9]{64}$/.test(row.id)
      || typeof row.callId !== 'string' || !/^[a-f0-9]{32}$/i.test(row.callId)
      || typeof row.correlationId !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(row.correlationId)
      || typeof row.repository !== 'string' || !/^[^/\s]{1,100}\/[^/\s]{1,100}$/.test(row.repository)
      || typeof row.pr !== 'string' || !/^[1-9][0-9]{0,9}$/.test(row.pr)
      || row.behavior !== 'pr_review' && row.behavior !== 'pr_approve'
      || typeof row.head !== 'string' || !/^[a-f0-9]{40}$/i.test(row.head)
      || typeof row.actor !== 'string' || !/^[a-z0-9-]{1,39}$/i.test(row.actor)
      || !Number.isSafeInteger(row.completedAt) || Number(row.completedAt) < 0
  })) throw new Error('Invalid bounded review handoff selectors')
  return value as HandoffCandidate[]
}

export function handoffCandidate(event: LogEvent): HandoffCandidate | null {
  if (event.severity !== 'error' || event.source !== 'caller' || event.visibility !== 'workspace'
    || event.operation !== 'provider.review.handoff' || event.phase !== 'analysis'
    || event.context.submission !== 'none' || event.context.errorCode !== 'review_budget_exhausted'
    || !event.callId || !/^[a-f0-9]{32}$/i.test(event.callId) || !event.correlationId
    || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(event.correlationId)
    || !event.repository || !event.pr || !/^[1-9][0-9]*$/.test(event.pr) || !event.account
    || event.behavior !== 'pr_review' && event.behavior !== 'pr_approve'
    || typeof event.context.expectedHead !== 'string' || !/^[a-f0-9]{40}$/i.test(event.context.expectedHead)
    || !event.eventTime || !Number.isFinite(Date.parse(event.eventTime))) return null
  return { id: event.id, callId: event.callId, correlationId: event.correlationId, repository: event.repository,
    pr: event.pr, behavior: event.behavior, head: event.context.expectedHead, actor: event.account, completedAt: Date.parse(event.eventTime) }
}
