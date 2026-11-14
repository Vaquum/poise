import { environmentSecrets, normalize, redact, scopePrefix, type DiagnosticInput, type LogEvent } from './contract.js'
import { issueReviewSuperseded } from './caller-outcome.js'

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
const text = (value: unknown) => typeof value === 'string' ? value : null
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Prompts, output and arguments are never read from the Caller row. */
export function callerDiagnostic(value: unknown, workspace: string): DiagnosticInput | null {
  const row = object(value)
  if (!row || !text(row.id) || !/^[a-f0-9]{32}$/.test(String(row.id))) return null
  if (row.outcome === 'superseded' || issueReviewSuperseded(row) || ['stopped', 'stopping'].includes(String(row.error_code))) return null
  const raw = object(row.diagnostic)
  const rawContext = object(raw?.context) ?? raw
  // A planned handoff is terminal evidence, not a prior preparation warning.
  // Its source stays Error until the separate work read confirms a successor.
  const handoff = raw?.version === 1 && raw.source === 'caller' && raw.operation === 'provider.review'
    && raw.phase === 'analysis' && raw.outcome === 'handoff' && rawContext?.submission === 'none'
    && row.status === 'failed' && row.error_code === 'review_budget_exhausted'
    && ['pr_review', 'pr_approve'].includes(String(row.behavior)) && !row.evidence_unavailable
  const priorWarning = !handoff && raw?.version === 1 && raw.severity === 'warning' && row.status === 'failed'
    ? { version: 1, severity: 'warning', operation: text(raw.operation), phase: text(raw.phase),
      message: text(raw.message), stderr: text(raw.stderr), stderr_truncated: raw.stderr_truncated === true } : null
  const diagnostic = raw && raw.version === 1 && !priorWarning ? raw : null
  const context = object(diagnostic?.context) ?? diagnostic ?? {}
  const unavailable = text(row.evidence_unavailable)
  const error = text(row.error) ?? unavailable ?? ''
  const detail = text(context.message)
  const message = error || detail || 'Caller reported a process failure without a cause'
  if (/pull-request head or base changed (?:while building review packet|before checkout|during checkout)\b|pull-request head changed(?: [a-z ]+)?: expected [a-f0-9]{40}, got [a-f0-9]{40}/.test(error)) return null
  // Review verdicts alone are routine; recorded failure evidence takes precedence.
  if (!diagnostic && !error && !row.error_code && !priorWarning) return null
  const repository = text(row.repo)
  const pr = text(row.pr_id)
  const heldRepair = row.behavior === 'repair_pr' && row.status === 'failed'
    && row.action === 'not_started' && row.outcome === 'preflight_failed' && row.head_sha == null
    && (row.error_code === 'atomic_work_blocked' || row.error_code === 'atomic_work_failed'
      && error === 'repair did not answer every unresolved review finding')
  // Only the complete original flat pre-POST refusal can override Caller Error.
  const approvalWait = row.behavior === 'pr_approve' && row.status === 'failed'
    && row.error_code === 'approval_blocked_unresolved_conversations'
    && row.action === 'not_started' && row.outcome === 'preflight_failed' && row.head_sha === null
    && row.evidence_unavailable == null && row.resource_error == null && row.ownership_error == null
    && row.review_id == null && row.review_comments == null && row.receipts == null
    && raw?.version === 1 && raw.source === 'caller' && raw.severity === 'error'
    && raw.operation === 'provider.review' && raw.phase === 'submitting' && raw.outcome === 'exit'
    && raw.submission === 'blocked' && typeof raw.stderr === 'string' && raw.stderr_truncated === false
    && raw.context == null && raw.filesystem == null && raw.observed_head == null
    && ['exit_code', 'signal', 'errno', 'timeout_seconds'].every(key => raw[key] == null)
  const transient = (!row.error_code || row.error_code === 'review_submission_failed')
    && /\b(?:GitHub|HTTP)\s*5\d\d\b|\b(?:httpx\.(?:ReadTimeout|ConnectTimeout|ConnectError)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/.test(error)
  return {
    id: 'caller:' + row.id, time: text(row.completed_at), source: unavailable && !row.error && !diagnostic ? 'collection' : 'caller', component: text(row.behavior) ?? 'agent-interface',
    level: handoff ? 'error' : approvalWait ? 'warning' : unavailable && !row.error && !diagnostic ? 'warning' : diagnostic?.severity === 'warning' ? 'warning' : diagnostic?.severity === 'error' ? 'error' : heldRepair || transient || ['overloaded', 'rate_limit', 'authentication_failed', 'interrupted'].includes(String(row.error_code)) ? 'warning' : 'error',
    operation: handoff ? 'provider.review.handoff' : unavailable && !row.error && !diagnostic ? 'caller.evidence_unavailable' : text(diagnostic?.operation) || text(row.behavior) || 'call.failed', phase: text(diagnostic?.phase), workspace,
    repository, pr, target: repository && pr ? `${repository}#${pr}` : repository,
    account: text(row.actor), reviewer: text(row.actor), behavior: text(row.behavior), callId: String(row.id),
    correlationId: text(row.correlation_id), container: text(context.container), release: text(context.release),
    message, cause: detail?.trim() && detail !== message ? [detail] : [],
    stderr: text(diagnostic?.stderr), stack: text(context.stack), truncated: diagnostic?.stderr_truncated === true,
    exitCode: number(context.exit_code), signal: number(context.signal) ?? text(context.signal),
    timeoutMs: number(context.timeout_seconds) === null ? null : Number(context.timeout_seconds) * 1000,
    errno: number(context.errno) ?? text(context.errno), resources: object(diagnostic?.filesystem) ?? {},
    context: { model: text(row.model), errorCode: text(row.error_code), outcome: text(row.outcome), action: text(row.action),
      ...(handoff ? { submission: 'none' } : approvalWait ? { submission: 'blocked' } : {}),
      expectedHead: text(row.expected_head), observedHead: text(row.head_sha), executable: text(context.executable),
      resolvedExecutable: text(context.resolved_executable), cwd: text(context.cwd), elapsedMs: number(context.elapsed_ms),
      startedAt: text(row.started_at_precise) ?? text(row.started_at), source: text(row.source),
      inputBytes: number(context.actual_input_bytes), inputLimitBytes: number(context.input_limit_bytes),
      ...(priorWarning ? { priorWarning } : {}),
      providerStarted: typeof context.provider_started === 'boolean' ? context.provider_started : null,
      evidenceIncomplete: !diagnostic || !!row.evidence_unavailable },
  }
}

/** Workspace log envelopes keep their IDs through the authenticated collection boundary. */
export function workspaceEnvelope(value: unknown, workspace: string, now: number, secrets: readonly string[]): LogEvent {
  secrets = [...environmentSecrets(), ...secrets]
  const row = object(value)
  if (!row || row.version !== 1 || row.workspace !== workspace || row.visibility !== 'workspace'
    || !['critical', 'error', 'warning'].includes(String(row.severity)) || typeof row.id !== 'string'
    || !/^evt_[a-f0-9]{16}_[a-f0-9]{64}$/.test(row.id)
    || row.id.split('_')[1] !== scopePrefix(workspace, 'workspace') || typeof row.incidentId !== 'string'
    || !new RegExp('^inc_' + scopePrefix(workspace, 'workspace') + '_[a-f0-9]{64}$').test(row.incidentId)) throw new Error('Workspace diagnostic envelope has an invalid identity or scope')
  if (typeof row.message !== 'string' || typeof row.operation !== 'string' || typeof row.source !== 'string') throw new Error('Workspace diagnostic envelope is missing its cause or source')
  const event = normalize({
    id: row.id, time: text(row.eventTime), source: row.source, component: text(row.component) ?? undefined,
    level: String(row.severity), operation: row.operation, phase: text(row.phase), target: text(row.target), workspace,
    visibility: 'workspace', message: row.message, instance: text(row.instance), container: text(row.container), release: text(row.release),
    account: text(row.account), repository: text(row.repository), pr: text(row.pr), behavior: text(row.behavior), reviewer: text(row.reviewer),
    callId: text(row.callId), requestId: text(row.requestId), correlationId: text(row.correlationId),
    cause: Array.isArray(row.cause) ? row.cause.filter((cause): cause is string => typeof cause === 'string') : [],
    stderr: text(row.stderr), stack: text(row.stack), truncated: row.truncated === true,
    exitCode: number(row.exitCode), signal: number(row.signal) ?? text(row.signal), timeoutMs: number(row.timeoutMs),
    errno: number(row.errno) ?? text(row.errno), context: object(row.context) ?? {}, resources: object(row.resources) ?? {},
  }, now, secrets)
  if (!event) throw new Error('Workspace diagnostic envelope has no qualifying severity')
  return { ...event, id: row.id, incidentId: row.incidentId, sourceLevel: redact(text(row.sourceLevel) ?? event.sourceLevel, secrets).slice(0, 64) }
}

/** Native levels remain authoritative except for verified Link stream closes. */
export function nativeDiagnostic(value: unknown, source: 'ingress' | 'kernel' | 'docker', id: string, workspace: string | null): DiagnosticInput {
  const row = object(value)
  if (!row) return { id, source: 'collection', level: 'warning', workspace, operation: 'record.unreadable', message: `${source} supplied an unreadable record; content was excluded` }
  const request = object(row.request), uri = text(request?.uri)?.split('?')[0]
  const linkEvents = uri === undefined ? request?.route === '/api/link/events' : uri === '/api/link/events'
  // Caddy emits this warning only after writing the upstream response headers.
  const routineClose = source === 'ingress' && row.level === 'warn' && request?.method === 'GET' && linkEvents
    && row.logger === 'http.handlers.reverse_proxy' && row.msg === 'aborting with incomplete response' && row.error === 'reading: context canceled'
  const clock = row.__REALTIME_TIMESTAMP !== undefined ? Number(row.__REALTIME_TIMESTAMP) / 1000
    : typeof row.ts === 'number' ? row.ts * 1000 : null
  const time = clock === null ? text(row.time) ?? text(row.timestamp) ?? null
    : Number.isFinite(clock) && clock >= 0 && clock <= 8.64e15 ? new Date(clock).toISOString() : 'invalid source timestamp'
  return { id, time, source, level: routineClose ? 'info' : typeof row.level === 'string' || typeof row.level === 'number' ? row.level : typeof row.PRIORITY === 'string' || typeof row.PRIORITY === 'number' ? row.PRIORITY : 'unknown',
    workspace, visibility: workspace ? 'infrastructure' : 'operator', operation: text(row.event) ?? text(row.logger) ?? source + '.diagnostic',
    message: (text(row.message) ?? text(row.msg) ?? text(row.MESSAGE) ?? 'Source supplied no message').replace(/\?[^\s'"]+/g, '?[query omitted]'),
    stderr: text(row.error)?.replace(/\?[^\s'"]+/g, '?[query omitted]'),
    requestId: text(row.request_id), container: text(row.container), release: text(row.release),
    context: { method: request?.method ?? row.method ?? null, route: linkEvents ? '/api/link/events' : uri?.startsWith('/api/') ? uri.split('/').slice(0, 3).join('/') : null,
      durationMs: number(row.duration) === null ? null : Number(row.duration) * 1000,
      upstream: text(row.upstream), errno: text(row.errno), sourceCursor: text(row.__CURSOR) },
  }
}

/** The entrypoint emits only these fatal checks before application logging can start. */
export function supervisorDiagnostic(line: string, id: string, workspace: string): DiagnosticInput | null {
  const unavailable = /^poise-runtime: diagnostic (?:helper|reporting) unavailable[.:]/.test(line)
  const missing = /^poise-runtime: missing environment:/.test(line)
  const bootstrap = /^poise-runtime: POISE_SKIP_CLI_BOOTSTRAP must be 0 or 1,/.test(line)
  const home = /^poise-runtime: .+ must be writable by uid \d+, the workspace user\.$/.test(line)
  if (!unavailable && !missing && !bootstrap && !home) return null
  return { id, source: unavailable ? 'collection' : 'poise', component: 'workspace-supervisor', workspace, visibility: 'workspace',
    operation: unavailable ? 'supervisor.capture_unavailable' : 'workspace.entrypoint', phase: 'entrypoint', level: unavailable ? 'warning' : 'error',
    message: bootstrap ? 'POISE_SKIP_CLI_BOOTSTRAP must be 0 or 1; the configured value was excluded' : line }
}
