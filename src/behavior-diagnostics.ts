import type { BehaviorDiagnostics } from './behaviors'
import { classifyBehaviorDiagnostic, diagnosticClassification, failureCause, type DiagnosticClassification } from './behavior-failure-cause'

export interface BehaviorDiagnosticGroup extends DiagnosticClassification {
  scope: string
  message: string
  details: string[]
}

function targetRef(target: string): string {
  return target.match(/^[^#]+#\d+/)?.[0] ?? target
}

function diagnosticMessage(code: string, cause: string): string {
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
  const add = (classification: DiagnosticClassification, scope: string, message: string, detail: string) => {
    const key = JSON.stringify([classification.severity, classification.code, scope, message])
    const existing = groups.get(key)
    if (existing) {
      if (!existing.details.includes(detail)) existing.details.push(detail)
    } else groups.set(key, { ...classification, scope, message, details: [detail] })
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
    const detail = `${failure.org ? `${failure.org}: ` : ''}${failure.behavior}${failure.target ? ` ${failure.target}` : ''}: ${failure.consecutiveFailures} consecutive ${failure.kind} failure(s) — ${cause}${failure.nextRetryAt ? `; next check ${failure.nextRetryAt}` : ''}`
    add(classification, scope, message, detail)
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
      `${letter.behavior} ${letter.target}: ${cause} (${letter.attemptCount ?? 1} attempts)`)
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
