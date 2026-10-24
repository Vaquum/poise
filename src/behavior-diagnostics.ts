import { evidenceAttachment, keepKnownEvidence, type EvidenceAttachment } from '../gateway/src/diagnostics/evidence-contract'
import { materialFailureCause } from '../gateway/src/diagnostics/material-cause'
import type { BehaviorDiagnostics } from './behaviors'
import { classifyBehaviorDiagnostic, diagnosticClassification, failureCause, isTimeoutCause, type DiagnosticClassification } from './behavior-failure-cause'

/** One line of a group's details, with what it is about. */
export interface DiagnosticEntry extends EvidenceAttachment {
  callId?: string | null
  correlationId?: string | null
  /** The behavior and target the line is about; both null for a condition of
   *  Poise as a whole (agent log, datastore, identity, runtime). */
  behavior: string | null
  target: string | null
  /** When it last happened, when known. */
  at: string | null
  /** When the next check runs, for a failing behavior with one scheduled. */
  next: string | null
  detail: string
}

export interface BehaviorDiagnosticGroup extends DiagnosticClassification {
  scope: string
  message: string
  details: string[]
  entries: DiagnosticEntry[]
}

// The PR behaviors a repository hold gates, in Behaviors-view row order.
// (src/behaviors.ts imports this module, so the list cannot come from there.)
const HELD_PR_BEHAVIORS = ['review-new-prs', 'approve-prs', 'resolve-unblocking', 'rerun-grey-ci', 'merge-prs']

export function targetRef(target: string): string {
  return target.match(/^[^#]+#\d+/)?.[0] ?? target
}

function diagnosticMessage(code: string, cause: string): string {
  if (code === 'unknown' && isTimeoutCause(cause)) {
    return 'The sweep is stalled under load. Poise retries automatically.'
  }
  return ({
    head_changed: 'PR updated. Poise will reconsider the latest revision.',
    provider_capacity: 'The model is busy. Poise will try again.',
    rate_limit: 'The service is limiting requests. Poise will try again.',
    upstream_unavailable: 'The service is temporarily unavailable. Poise will check again.',
    network_interruption: 'The connection was interrupted. Poise will try again.',
    held_result: 'The review outcome needs verification before retry.',
    invalid_agent_result: 'Poise could not reconcile the worker result.',
    review_contract_violation: 'The model did not produce a usable review.',
    review_recovery_failed: 'The review needs attention after recovery failed.',
  } as Record<string, string>)[code] ?? cause
}

export function behaviorDiagnosticGroups(diagnostics: BehaviorDiagnostics): BehaviorDiagnosticGroup[] {
  const groups = new Map<string, BehaviorDiagnosticGroup>()
  const add = (classification: DiagnosticClassification, scope: string, message: string, detail: string,
    about: Omit<DiagnosticEntry, 'detail'> = { behavior: null, target: null, at: null, next: null }) => {
    const key = JSON.stringify([classification.severity, classification.code, scope, message])
    const entry = { ...about, detail }
    const existing = groups.get(key)
    if (existing) {
      if (!existing.details.includes(detail)) existing.details.push(detail)
      const identity = (row: DiagnosticEntry) => JSON.stringify([row.behavior, row.target, row.callId, row.correlationId, row.at, row.next, row.detail])
      if (!existing.entries.some((row) => identity(row) === identity(entry))) existing.entries.push(entry)
    } else groups.set(key, { ...classification, scope, message, details: [detail], entries: [entry] })
  }
  for (const [scope, error] of [
    ['Agent log', diagnostics.agentLogsError], ['Datastore', diagnostics.datastore.error], ['Identity', diagnostics.identity.error],
  ]) {
    if (error) add(classifyBehaviorDiagnostic(error), scope!, failureCause(error), error)
  }
  const failureCauses = new Map<string, DiagnosticClassification>()
  for (const failure of diagnostics.failures) {
    const error = failure.error ?? 'Failure cause unavailable'
    let classification = failure.diagnostic ? diagnosticClassification(failure.diagnostic.code)
      : classifyBehaviorDiagnostic(error, { held: failure.kind === 'worker' })
    const cause = failureCause(error)
    const stronger = diagnostics.deadLetters.find((letter) => letter.diagnostic && letter.behavior === failure.behavior
      && !!failure.callId && letter.callId === failure.callId && failureCause(letter.error) === cause
      && diagnosticClassification(letter.diagnostic.code).severity !== 'info')
    if (classification.severity === 'info' && stronger?.diagnostic) classification = diagnosticClassification(stronger.diagnostic.code)
    const ref = targetRef(failure.target ?? '')
    const scope = (classification.code === 'github_access' ? ref.split('#')[0] : ref)
      || `${failure.org ?? ''} ${failure.behavior}`.trim()
    if (failure.callId) failureCauses.set(JSON.stringify([failure.behavior, failure.callId, cause]), classification)
    if (failure.recovered === true && !stronger) continue
    const message = classification.code === 'github_access'
      ? `GitHub target is unavailable to ${diagnostics.identity.actor || 'the reviewer'}; check repository access.`
      : diagnosticMessage(classification.code, cause)
    const detail = `${failure.org ? `${failure.org}: ` : ''}${failure.behavior}${failure.target ? ` ${failure.target}` : ''}: ${failure.consecutiveFailures} consecutive ${failure.kind} failure(s) — ${cause}`
    add(classification, scope, message, detail, { behavior: failure.behavior, target: failure.target ?? null, at: failure.lastFailureAt || null, next: failure.nextRetryAt || null, callId: failure.callId, correlationId: failure.correlationId, ...evidenceAttachment(failure) })
  }
  // One held state per repository the agent account cannot read, however
  // many behaviors it holds. No notice joins it: entries carry every held
  // behavior so each behavior's row counts it, with no target to match a
  // notice subject.
  for (const hold of diagnostics.holds) {
    const cause = failureCause(hold.error)
    const message = `agent account has no access to ${hold.repo}`
    const detail = `${hold.org ? `${hold.org}: ` : ''}PR behaviors held for ${hold.repo} — ${cause}`
    for (const behavior of HELD_PR_BEHAVIORS) {
      add({ severity: 'warning', code: 'github_access' }, hold.repo, message, detail,
        { behavior, target: null, at: hold.heldAt || null, next: hold.nextRecheckAt || null })
    }
  }
  for (const letter of diagnostics.deadLetters) {
    const ref = targetRef(letter.target)
    const cause = failureCause(letter.error)
    // A retryable no-action attempt can also have an audit incident. Its
    // classified failure already shows it; stronger current evidence stays visible.
    const classification = letter.diagnostic ? diagnosticClassification(letter.diagnostic.code)
      : classifyBehaviorDiagnostic(letter.error, { held: true })
    const existing = letter.callId ? failureCauses.get(JSON.stringify([letter.behavior, letter.callId, cause])) : undefined
    if (existing && (!letter.diagnostic || (existing.code === classification.code && existing.severity === classification.severity))) continue
    add(classification, ref, diagnosticMessage(classification.code, cause),
      `${letter.behavior} ${letter.target}: ${cause} (${letter.attemptCount ?? 1} attempts)`,
      { behavior: letter.behavior, target: letter.target, at: letter.createdAt || null, next: null, callId: letter.callId, correlationId: letter.correlationId, ...evidenceAttachment(letter) })
  }
  if (diagnostics.runtimeError) {
    add(diagnosticClassification('runtime_unhealthy'), 'Behaviors', diagnostics.runtimeError, 'Poise runtime needs repair.')
  } else if (groups.size === 0 && diagnostics.status === 'degraded') {
    add(diagnosticClassification('runtime_status_unknown'), 'Behaviors', 'Runtime health needs checking.', 'Last-known runtime status is degraded; the cause is unavailable.')
  }
  // Availability cannot replace health evidence from the last successful read.
  if (diagnostics.apiError) {
    const error = diagnostics.apiError
    add(diagnosticClassification(error.code), 'Behaviors', `Status could not be refreshed (${error.message}).`, error.message)
  }
  return [...groups.values()]
}

/** Current immutable attempt/cause identity is the only key for a known browser reference. */
export function retainDiagnosticEvidence(next: BehaviorDiagnostics, previous: BehaviorDiagnostics | null): BehaviorDiagnostics {
  type Row = { behavior: string; target?: string; error?: string; callId?: string | null; correlationId?: string | null } & EvidenceAttachment
  const identity = (row: Row) => row.callId || row.correlationId
    ? JSON.stringify([row.behavior, row.target, row.callId, row.correlationId, materialFailureCause(failureCause(row.error ?? ''))]) : null
  const prior = new Map([...previous?.failures ?? [], ...previous?.deadLetters ?? []].flatMap((row) => {
    const key = identity(row)
    return key ? [[key, row] as const] : []
  }))
  const retain = <T extends Row>(row: T): T => ({ ...row, ...keepKnownEvidence(row, prior.get(identity(row) ?? '')) })
  return { ...next, failures: next.failures.map(retain), deadLetters: next.deadLetters.map(retain) }
}
