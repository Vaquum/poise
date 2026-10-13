// The cause a behavior failure shows in Behaviors' diagnostics. A provider's
// or GitHub's JSON error reads by its message, not by whichever line of it
// holds a brace: a Grok balance error showed as "Internal error: {" or "}".

const JSON_MESSAGE = /\{[\s\S]*?"message"\s*:\s*("(?:[^"\\]|\\.)*")/

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

// Startup item errors are not terminal turn failures. Read the complete event
// stream before bounding it, and prefer the last authoritative failed turn.
export function terminalProviderMessage(error: string): string | null {
  let terminal: string | null = null
  let providerError: string | null = null
  for (const line of error.split('\n')) {
    const start = line.indexOf('{')
    if (start < 0) continue
    let event: Record<string, unknown> | null
    try { event = record(JSON.parse(line.slice(start))) } catch { continue }
    if (!event) continue
    const message = event.type === 'turn.failed' ? record(event.error)?.message : event.message
    if (typeof message !== 'string' || !message.trim()) continue
    if (event.type === 'turn.failed') terminal = message.trim()
    else if (event.type === 'error') providerError = message.trim()
  }
  return terminal ?? providerError
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info'
export interface DiagnosticClassification { severity: DiagnosticSeverity; code: string }
export interface DiagnosticOptions { errorCode?: string | null; held?: boolean }

// Colour expresses who can correct the condition, not a process exit code.
export function diagnosticClassification(code: string): DiagnosticClassification {
  const severity: DiagnosticSeverity = ['invalid_agent_result', 'runtime_unhealthy'].includes(code)
    ? 'error' : ['head_changed', 'provider_capacity', 'rate_limit', 'upstream_unavailable', 'network_interruption'].includes(code)
      ? 'info' : 'warning'
  return { severity, code }
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

export function failureCause(error: string): string {
  const terminal = terminalProviderMessage(error)
  if (terminal) return terminal.slice(0, 300)
  const json = JSON_MESSAGE.exec(error)
  if (json) {
    let message = ''
    try {
      message = String(JSON.parse(json[1])).trim()
    } catch {
      // Not a JSON string after all: the lines below say what they can.
    }
    if (message) {
      const before = error.slice(0, json.index).split('\n').pop()?.trim().replace(/^error:\s*/i, '') ?? ''
      return `${before ? `${before} ` : ''}${message}`.slice(0, 300)
    }
  }
  const lines = error.trim().split('\n').filter((line) => line.trim())
  const cause = [...lines].reverse().find((line) => /(?:Error|Timeout|review_packet_too_large):?/.test(line))
    ?? lines[lines.length - 1] ?? error
  return cause.trim().slice(0, 300)
}
