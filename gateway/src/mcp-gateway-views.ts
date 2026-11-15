import { createHmac, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from './context.js'
import { diagnosticConfig } from './diagnostics/config.js'
import type { LogEvent } from './diagnostics/contract.js'
import type { Coverage, LoggingPage, LogFilter } from './diagnostics/query-contract.js'
import { LoggingQueryError, validateLoggingFilter } from './diagnostics/query-parser.js'
import type { LoggingRead } from './diagnostics/query-types.js'
import { HttpError } from './http.js'
import { listDevices } from './link.js'
import { isMcpLoggingKind, mcpWorkspaceAllowed, type McpGatewayView, type McpGrantScope,
  type McpLoggingArguments, type McpLoggingKind, type McpRead } from './mcp-contract.js'
import type { User } from './store.js'

type GatewayRead = { op: 'view'; id: McpGatewayView }
  | { op: 'event'; kind: McpLoggingKind; id: string }
  | { op: 'list'; args: McpLoggingArguments }

export function gatewayMcpRead(read: McpRead): GatewayRead | null {
  if (read.name === 'poise_get') {
    if (read.arguments.kind === 'gateway') return { op: 'view', id: read.arguments.id }
    if (isMcpLoggingKind(read.arguments.kind)) return { op: 'event', kind: read.arguments.kind, id: read.arguments.id }
  }
  if ((read.name === 'poise_list' || read.name === 'poise_changes') && read.arguments.kind !== 'chat' && read.arguments.kind !== 'document') {
    return { op: 'list', args: read.arguments }
  }
  return null
}

export const instanceLoggingRead = (read: GatewayRead): boolean => read.op === 'view' ? read.id === 'instance-logging-health'
  : (read.op === 'event' ? read.kind : read.args.kind) === 'instance-logging'

function cursor(grant: McpGrantScope, binding: readonly unknown[]) {
  const signature = (value: string) => createHmac('sha256', grant.grantId).update(JSON.stringify(binding)).update('.').update(value).digest()
  return {
    seal(value: string | null) {
      if (value === null) return null
      const payload = Buffer.from(value).toString('base64url')
      return payload + '.' + signature(payload).toString('base64url')
    },
    open(token: string | undefined): string | undefined {
      if (!token) return undefined
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, 'invalid_logging_cursor')
      const [payload, received] = token.split('.')
      const actual = Buffer.from(received, 'base64url')
      if (actual.length !== 32 || !timingSafeEqual(signature(payload), actual)) throw new HttpError(400, 'invalid_logging_cursor')
      return Buffer.from(payload, 'base64url').toString()
    },
  }
}

function diagnostic(event: LogEvent, link: string) {
  const { id, incidentId, eventTime, ingestedAt, severity, source, component, operation, phase, workspace,
    repository, pr, behavior, callId, correlationId, message, truncated } = event
  return { id, incidentId, eventTime, ingestedAt, severity, source, component, operation, phase, workspace, repository,
    pr, behavior, callId, correlationId, message: message.slice(0, 800), truncated: truncated || message.length > 800,
    link: link + '&event=' + encodeURIComponent(id) }
}

function coverage(sources: Coverage[]) {
  return sources.slice(0, 16).map(({ id, source, workspace, status, currentStatus, observedAt, availableFrom,
    historyIncomplete, gaps, dropped, rejected }) => ({ id, source, workspace, status, currentStatus, observedAt, availableFrom,
    historyIncomplete, dropped, rejected, gaps: gaps.slice(0, 8), moreGaps: gaps.length > 8 }))
}

export async function readGatewayMcp(ctx: Context, owner: User, grant: McpGrantScope, selection: GatewayRead) {
  const operator = instanceLoggingRead(selection)
  if (operator ? grant.operatorLogs !== true || grant.repository !== undefined || !ctx.isAdmin(owner.handle) : !mcpWorkspaceAllowed(grant)) {
    throw new HttpError(403, 'logging_or_device_scope_required')
  }
  const now = ctx.deps.now(), observedAt = new Date(now).toISOString(), origin = ctx.workspaceOrigin(owner.handle)
  const base = { workspace: owner.handle, owner: owner.login }
  if (selection.op === 'view' && selection.id === 'link-devices') {
    const devices = listDevices(ctx, owner.handle)
    const value = devices.slice(0, 20).map(({ id, label, state, connected, createdAt, lastUsedAt }) =>
      ({ id, label: label?.slice(0, 160) ?? null, state, connected, createdAt, lastUsedAt }))
    return { ...base, lookup: { observedAt, coverage: devices.length > value.length ? 'partial' : 'complete',
      source: 'Gateway Poise Link device inventory', record: { kind: 'gateway', id: selection.id, value },
      link: origin + '/?view=settings&settings=link' } }
  }
  const access = { workspace: owner.handle, operator }
  const link = origin + '/?view=observe&part=logging' + (operator ? '&scope=instance' : '')
  let scopeCursor: ReturnType<typeof cursor> | undefined
  let filter: LogFilter = {}
  if (selection.op === 'list') {
    const { kind, repository, since, until, limit, afterWatermark } = selection.args
    const scoped = ['mcp-logging-v1', grant.resource, grant.ownerId, grant.handle, kind, repository, since, until, limit]
    scopeCursor = cursor(grant, scoped)
    const after = scopeCursor.open(afterWatermark)
    const continuation = selection.args.cursor ? cursor(grant, [...scoped, after ?? null]).open(selection.args.cursor) : undefined
    filter = validateLoggingFilter({ limit, ...(repository ? { repository } : {}), ...(since ? { from: since } : {}),
      ...(until ? { to: until } : {}), ...(after ? { after } : {}), ...(continuation ? { cursor: continuation } : {}) }, access)
  }
  const request: LoggingRead = { path: join(ctx.deps.config.dataDir, 'logging.db'), policy: diagnosticConfig(process.env).policy,
    now, operation: selection.op === 'view' ? 'health' : selection.op, access, filter,
    ...(selection.op === 'event' ? { eventId: selection.id } : {}) }
  if (operator) ctx.deps.log.info('logging.query', { actor: owner.login, source: 'mcp', scope: 'instance', operation: request.operation, at: observedAt })
  try {
    const abort = new AbortController()
    const lease = await ctx.loggingQueries.read(request, owner.handle, abort.signal, () => abort.abort())
    try {
      if (operator && !ctx.isAdmin(owner.handle)) throw new HttpError(403, 'operator_access_removed')
      const result = JSON.parse(lease.reply.body)
      if (selection.op === 'event') {
        const event = lease.reply.status === 200 ? result.event as LogEvent : null
        if (event && (event.id !== selection.id || !operator && (event.workspace !== owner.handle || event.visibility === 'operator'))) {
          throw new HttpError(502, 'invalid_diagnostic_scope')
        }
        return { ...base, lookup: { observedAt, source: 'Gateway Logging', bounds: result.bounds,
          coverage: lease.reply.status === 410 ? 'expired' : event ? 'complete' : 'unavailable',
          record: event ? diagnostic(event, link) : null } }
      }
      if (selection.op === 'view') {
        const { collection, bounds, policy } = result
        return { ...base, lookup: { observedAt, source: 'Gateway Logging collection health', coverage: collection.status,
          record: { kind: 'gateway', id: selection.id, value: { bounds, policy, status: collection.status, currentStatus: collection.currentStatus,
            lossObserved: collection.lossObserved, checkedAt: collection.checkedAt, sources: coverage(collection.sources),
            moreSources: collection.sources.length > 16 } }, link } }
      }
      const page = result as LoggingPage
      if (lease.reply.status !== 200 || !Array.isArray(page.events) || page.events.length > selection.args.limit
        || page.events.some(event => (!operator && (event.workspace !== owner.handle || event.visibility === 'operator'))
          || (filter.repository && event.repository !== filter.repository))) throw new HttpError(502, 'invalid_diagnostics_page')
      const continuation = cursor(grant, ['mcp-logging-v1', grant.resource, grant.ownerId, grant.handle, selection.args.kind,
        selection.args.repository, selection.args.since, selection.args.until, selection.args.limit, filter.after ?? null])
      const coverageStatus = (filter.to && filter.to <= page.bounds.retentionAfter) ? 'expired'
        : !page.coverage.length || page.coverage.length > 16 || page.coverage.some(row => row.status !== 'connected' || row.gaps.length > 0 || row.historyIncomplete)
          || (filter.from && filter.from < page.bounds.retentionAfter) ? 'partial' : 'complete'
      return { ...base, page: { observedAt, source: 'Gateway Logging', coverage: coverageStatus, sources: coverage(page.coverage),
        bounds: page.bounds, policy: page.policy, countKind: page.countKind, total: page.total,
        items: page.events.map(event => ({ ...diagnostic(event, link), occurrences: event.occurrences })),
        watermark: scopeCursor!.seal(page.watermark), nextCursor: continuation.seal(page.nextCursor) } }
    } finally { lease.release() }
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (error instanceof LoggingQueryError && error.status === 400) throw new HttpError(400, 'invalid_logging_cursor')
    return { ...base, coverage: 'unavailable', observedAt, source: 'Gateway Logging', reason: 'Retained diagnostics could not be read' }
  }
}
