import { classifyBehaviorDiagnostic, diagnosticClassification, terminalProviderMessage } from '../src/behavior-failure-cause'
import type { fetchAgentLogSnapshot } from './agent'
import type { BehaviorDeadLetter, BehaviorLaunchClaim } from './db'

// Retained audit incidents outlive active failure summaries. Classify their
// exact validated Caller evidence independently; never alter retry ownership.
export function behaviorIncidentDiagnostics(incidents: BehaviorDeadLetter[], snapshot: Awaited<ReturnType<typeof fetchAgentLogSnapshot>> | null, launches: BehaviorLaunchClaim[] = []) {
  return incidents.map((incident) => {
    const matches = snapshot?.entries.filter((row) => row.id === incident.callId) ?? []
    const call = matches.length === 1 ? matches[0] : undefined
    const persisted = launches.filter((launch) => (!!incident.callId && launch.launchCallId === incident.callId)
      || (!!incident.correlationId && launch.launchCorrelationId === incident.correlationId))
    const launch = persisted.length === 1 ? persisted[0] : undefined
    const expectedBehavior = incident.behavior === 'review-new-prs' ? 'pr_review'
      : incident.behavior === 'approve-prs' ? 'pr_approve' : null
    const exact = call && expectedBehavior && call.behavior === expectedBehavior
      && call.repo === incident.repo && String(call.pr_id) === String(incident.pr)
      && !!incident.actor && call.actor?.toLowerCase() === incident.actor.toLowerCase()
      && incident.source === `poise:${incident.behavior}` && call.source === incident.source
      && !!incident.correlationId && call.correlation_id === incident.correlationId
      && snapshot?.entries.filter((row) => row.correlation_id === incident.correlationId).length === 1
      && !snapshot?.quarantined.some((row) => row.id === incident.callId || row.correlationId === incident.correlationId)
    const mismatch = exact && launch && (launch.launchExpectedHead !== call.expected_head
      || launch.launchActor.toLowerCase() !== call.actor?.toLowerCase() || launch.launchRepo !== call.repo
      || String(launch.launchPr) !== String(call.pr_id) || launch.launchBehavior !== call.behavior
      || launch.launchSource !== call.source || launch.launchCorrelationId !== call.correlation_id
      || (launch.launchCallId !== null && launch.launchCallId !== call.id))
    const fault = mismatch || launch?.launchQuarantine === 'invalid_result'
    const noAction = exact && !fault && !launch?.launchQuarantine && persisted.length <= 1
      && call.action === 'not_started' && call.outcome === 'preflight_failed'
      && /^[a-f0-9]{32}$/.test(incident.callId ?? '') && /^[a-f0-9]{40}$/.test(call.expected_head ?? '')
      && ['failed', 'error', 'cancelled', 'canceled', 'timed_out', 'timeout'].includes(call.status.toLowerCase())
      && !call.head_sha && call.review_id == null && call.receipts == null && !call.review_comments
    const error = behaviorErrorMessage(fault ? launch?.launchError || incident.error : exact ? call.error || incident.error : incident.error)
    return { ...incident, error, diagnostic: fault ? diagnosticClassification('invalid_agent_result') : classifyBehaviorDiagnostic(error, {
      held: !noAction, errorCode: exact ? call.error_code : null,
    }) }
  })
}

// Keep bounded, redacted CLI evidence in health instead of an opaque exit code.
export function behaviorErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  const detail = typeof stderr === 'string' ? stderr.trim().split('\n').at(-1)?.trim() : ''
  let result = terminalProviderMessage(typeof stderr === 'string' ? stderr : '')
    ?? terminalProviderMessage(message) ?? (detail ? `${message}: ${detail}` : message)
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(key) && value && value.length >= 8) {
      result = result.split(value).join('[redacted]')
    }
  }
  return result
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/]+@/g, '$1[redacted]@')
    .replace(/\b(Bearer|token)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 300)
}
