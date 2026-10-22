// The cause a behavior failure shows in Behaviors' diagnostics. A provider's
// or GitHub's JSON error reads by its message, not by whichever line of it
// holds a brace: a Grok balance error showed as "Internal error: {" or "}".

import { terminalProviderMessage } from '../gateway/src/diagnostics/material-cause'
export { failureCause, terminalProviderMessage } from '../gateway/src/diagnostics/material-cause'

export type DiagnosticSeverity = 'error' | 'warning' | 'info'
export interface DiagnosticClassification { severity: DiagnosticSeverity; code: string }
export interface DiagnosticOptions { errorCode?: string | null; held?: boolean }

/** Audited finite taxonomy. Dynamic codes use the explicit unknown row, retaining their original code. */
export const DIAGNOSTIC_PLACEMENT = {
  invalid_agent_result: { rail: 'error', logging: 'error' }, runtime_unhealthy: { rail: 'error', logging: 'error' },
  head_changed: { rail: 'info', logging: 'excluded' }, provider_capacity: { rail: 'info', logging: 'warning' },
  rate_limit: { rail: 'info', logging: 'warning' }, upstream_unavailable: { rail: 'info', logging: 'warning' }, network_interruption: { rail: 'info', logging: 'warning' },
  held_result: { rail: 'warning', logging: 'source' }, unknown: { rail: 'warning', logging: 'source' },
  review_provider_blocked: { rail: 'warning', logging: 'warning' }, authentication: { rail: 'warning', logging: 'warning' }, github_access: { rail: 'warning', logging: 'warning' },
  review_packet_too_large: { rail: 'warning', logging: 'error' }, model_output_limit: { rail: 'warning', logging: 'error' },
  review_contract_violation: { rail: 'warning', logging: 'error' }, review_recovery_failed: { rail: 'warning', logging: 'error' }, review_budget_exhausted: { rail: 'warning', logging: 'error' },
  runtime_status_unknown: { rail: 'warning', logging: 'warning' },
} as const satisfies Record<string, { rail: DiagnosticSeverity; logging: 'excluded' | 'source' | 'warning' | 'error' }>
export type KnownDiagnosticCode = keyof typeof DIAGNOSTIC_PLACEMENT
export const DIAGNOSTIC_SCOPES = ['Agent log', 'Datastore', 'Identity', 'Behaviors runtime', 'Behaviors API dynamic code'] as const
// Colour expresses who can correct the condition, independently of technical severity.
export function diagnosticClassification(code: string): DiagnosticClassification {
  const placement = Object.prototype.hasOwnProperty.call(DIAGNOSTIC_PLACEMENT, code)
    ? DIAGNOSTIC_PLACEMENT[code as KnownDiagnosticCode] : DIAGNOSTIC_PLACEMENT.unknown
  return { severity: placement.rail, code }
}

// Load timeouts: the sweep deadline ("The operation was aborted due to
// timeout"), a slow CLI ("Command timed out after …") or lock contention
// ("timed out waiting for process lock"). Callers scope it to the failures it
// describes: operation retries and unknown diagnostics, never held worker results.
export function isTimeoutCause(error: string): boolean {
  return /aborted due to timeout|timed out/i.test(error)
}

// Warning rules are an allowlist of observable transient outcomes. Neither a
// retry count nor text saying "warning" can downgrade unknown or held evidence.
export function classifyBehaviorDiagnostic(error: string, options: DiagnosticOptions = {}): DiagnosticClassification {
  const blockingCode = ['invalid_agent_result', 'review_provider_blocked', 'review_packet_too_large',
    'review_contract_violation', 'review_recovery_failed', 'review_budget_exhausted', 'model_output_limit']
    .includes(options.errorCode ?? '')
  if (options.held || blockingCode) return diagnosticClassification(blockingCode ? options.errorCode! : 'held_result')
  if (options.errorCode === 'authentication_failed') return diagnosticClassification('authentication')
  if (options.errorCode && !['overloaded', 'rate_limit', 'server_error', 'authentication_failed'].includes(options.errorCode)) {
    return diagnosticClassification('unknown')
  }
  const cause = terminalProviderMessage(error) ?? error
  if (/^Selected model is at capacity\.(?: Please try a different model\.)?$/.test(cause.trim()) || options.errorCode === 'overloaded') {
    return diagnosticClassification('provider_capacity')
  }
  if (/pull-request head or base changed (?:while building review packet|before checkout|during checkout)\b|pull-request head changed(?: [a-z ]+)?: expected [a-f0-9]{40}, got [a-f0-9]{40}\b/.test(cause)) {
    return diagnosticClassification('head_changed')
  }
  if (/\b(?:GitHub|HTTP|http_status["']?\s*[:=]|unexpected status|status)\s*["']?\s*429\b/.test(cause)
    || options.errorCode === 'rate_limit') return diagnosticClassification('rate_limit')
  if (/\b(?:GitHub|HTTP|http_status["']?\s*[:=]|unexpected status|status)\s*["']?\s*5\d\d\b/.test(cause)
    || options.errorCode === 'server_error') return diagnosticClassification('upstream_unavailable')
  if (/\b(?:httpx\.(?:ReadTimeout|ConnectTimeout|ConnectError)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/.test(cause)) {
    return diagnosticClassification('network_interruption')
  }
  if (/GitHub (?:403|404)\b|Could not resolve to a Repository|['"]type['"]:\s*['"]NOT_FOUND['"]/.test(cause)) {
    return diagnosticClassification('github_access')
  }
  if (/\b(?:GitHub|HTTP)\s*(?:401|403)\b/.test(cause) || options.errorCode === 'authentication_failed') {
    return diagnosticClassification('authentication')
  }
  return diagnosticClassification('unknown')
}
