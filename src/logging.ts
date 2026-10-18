import type { LogEvent, Severity } from '../gateway/src/diagnostics/contract'
import type { Coverage, LogFilter, LogPolicy, LoggingPage as CanonicalLoggingPage } from '../gateway/src/diagnostics/query-contract'
import { readLoggingTime } from '../gateway/src/diagnostics/query-time'
import { workspaceMode } from './workspace-mode'
import { GITHUB_QUOTA_REFRESH_MS } from './github-quota'

export const LOGGING_LEVELS: readonly Severity[] = ['critical', 'error', 'warning']
export const LOGGING_SOURCES = ['poise', 'caller', 'gateway', 'docker', 'kernel', 'ingress', 'collection'] as const
export const loggingEventId = (value: string): boolean => /^evt_[a-f0-9]{16}_[a-f0-9]{64}$/.test(value)
export const loggingIncidentId = (value: string): boolean => /^inc_[a-f0-9]{16}_[a-f0-9]{64}$/.test(value)
export const loggingCallId = (value: string): boolean => /^[a-f0-9]{32}$/.test(value)
export type LoggingPage = CanonicalLoggingPage
export type LoggingEvent = LogEvent & { occurrences?: number }
export type LoggingQuery = LogFilter & { scope?: 'workspace' | 'instance' }
export interface LoggingAccess { endpoint: string; isAdmin: boolean; owner: string }
export interface LoggingHealth {
  version: 1
  status: string
  collection: { status: string; checkedAt: string; sources: Coverage[]; lossObserved: boolean }
  query: { status: string }
  bounds?: LoggingPage['bounds']
  policy: LogPolicy
}
export class LoggingApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly data?: unknown) { super(message) }
}

const refreshReaders = new Set<() => void>()
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleDiagnosticTick(): void {
  if (refreshTimer || !refreshReaders.size) return
  const now = Date.now()
  const next = Math.ceil((now + 1) / GITHUB_QUOTA_REFRESH_MS) * GITHUB_QUOTA_REFRESH_MS
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    for (const reader of refreshReaders) queueMicrotask(() => { if (refreshReaders.has(reader)) reader() })
    scheduleDiagnosticTick()
  }, next - now)
}

/** The fixed diagnostic cadence is independent of the general 1/5-minute view refresh setting. */
export function subscribeDiagnosticRefresh(reader: () => void): () => void {
  refreshReaders.add(reader)
  scheduleDiagnosticTick()
  return () => {
    refreshReaders.delete(reader)
    if (!refreshReaders.size && refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const protocol = (): never => { throw new LoggingApiError(503, 'logging_incompatible', 'The diagnostic response is incompatible or incomplete.') }
const aborted = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError') }
const time = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value))
function bounds(value: unknown): value is LoggingPage['bounds'] {
  return object(value) && time(value.retentionAfter) && (value.from === null || time(value.from)) && (value.to === null || time(value.to))
}
function coverage(value: unknown): boolean {
  return object(value) && typeof value.id === 'string' && typeof value.source === 'string' && (value.workspace === null || typeof value.workspace === 'string')
    && ['connected', 'unavailable', 'partial', 'not-configured'].includes(String(value.status)) && (value.error === null || typeof value.error === 'string')
    && ['observedAt', 'ingestedAt', 'availableFrom'].every((key) => value[key] === null || time(value[key]))
    && Array.isArray(value.gaps) && value.gaps.length <= 32 && value.gaps.every((gap) => object(gap) && time(gap.from) && (gap.to === null || time(gap.to)) && typeof gap.reason === 'string')
}
function policy(value: unknown): boolean {
  return object(value) && ['retentionMs', 'maxBytes', 'maxEvents'].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) > 0)
}
export function loggingErrorBounds(error: LoggingApiError): LoggingPage['bounds'] | null {
  return object(error.data) && bounds(error.data.bounds) ? error.data.bounds : null
}

export async function loggingAccess(signal: AbortSignal): Promise<LoggingAccess> {
  const mode = await workspaceMode()
  aborted(signal)
  if (!mode.service) return { endpoint: '/api/logging', isAdmin: false, owner: 'local' }
  const response = await fetch('/_poise/api/account', { cache: 'no-store', credentials: 'same-origin', signal })
  const data: unknown = await response.json()
  aborted(signal)
  if (!response.ok) throw new LoggingApiError(response.status, 'logging_access_unavailable', 'Your workspace access could not be read.')
  if (!object(data) || typeof data.isAdmin !== 'boolean' || typeof data.handle !== 'string') return protocol()
  return { endpoint: '/_poise/api/logging', isAdmin: data.isAdmin, owner: data.handle }
}

export function loggingParameters(query: LoggingQuery): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (key === 'severities') {
      const levels = value as Severity[]
      for (const level of levels.length ? levels : ['']) params.append('severity', level)
    } else params.set(key, String(value))
  }
  return params
}

async function read(access: LoggingAccess, suffix: string, query: LoggingQuery, signal: AbortSignal, health = false): Promise<unknown> {
  aborted(signal)
  const response = await fetch(access.endpoint + suffix + '?' + loggingParameters(query), { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' }, signal })
  const body: unknown = await response.json()
  aborted(signal)
  if (!response.ok && !(health && response.status === 503 && object(body) && body.version === 1 && object(body.collection))) {
    throw new LoggingApiError(response.status, object(body) && typeof body.error === 'string' ? body.error : 'logging_request_failed',
      object(body) && typeof body.message === 'string' ? body.message : 'The diagnostic request failed.', body)
  }
  return body
}

export function loggingRecord(value: unknown, occurrences = false): LoggingEvent {
  if (!object(value) || value.version !== 1 || typeof value.id !== 'string' || !loggingEventId(value.id)
    || typeof value.incidentId !== 'string' || !loggingIncidentId(value.incidentId) || !LOGGING_LEVELS.includes(value.severity as Severity)
    || !['workspace', 'operator', 'infrastructure'].includes(String(value.visibility)) || typeof value.ingestedAt !== 'string' || !Number.isFinite(Date.parse(value.ingestedAt))
    || (value.eventTime !== null && (typeof value.eventTime !== 'string' || !Number.isFinite(Date.parse(value.eventTime))))
    || !object(value.context) || !object(value.resources) || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.cause) || value.cause.length > 8 || value.cause.some((cause) => typeof cause !== 'string')) return protocol()
  for (const key of ['source', 'sourceLevel', 'component', 'operation', 'message']) if (typeof value[key] !== 'string') return protocol()
  for (const key of ['phase', 'target', 'workspace', 'instance', 'container', 'release', 'account', 'repository', 'pr', 'behavior', 'reviewer', 'callId', 'requestId', 'correlationId', 'stderr', 'stack']) {
    if (value[key] !== null && typeof value[key] !== 'string') return protocol()
  }
  for (const key of ['exitCode', 'timeoutMs']) if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return protocol()
  for (const key of ['signal', 'errno']) if (value[key] !== null && typeof value[key] !== 'string' && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return protocol()
  if (occurrences && (!Number.isSafeInteger(value.occurrences) || Number(value.occurrences) < 0)) return protocol()
  return value as unknown as LoggingEvent
}

export async function loggingPage(access: LoggingAccess, query: LoggingQuery, signal: AbortSignal): Promise<LoggingPage> {
  const body = await read(access, '', query, signal)
  if (!object(body) || body.version !== 1 || body.countKind !== 'events' || !Number.isSafeInteger(body.total) || Number(body.total) < 0
    || !Array.isArray(body.events) || body.events.length > 100 || !Array.isArray(body.coverage) || body.coverage.length > 256
    || !body.coverage.every(coverage) || !bounds(body.bounds) || !policy(body.policy) || typeof body.watermark !== 'string' || body.watermark.length > 1024
    || (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || body.nextCursor.length > 1024))) return protocol()
  body.events.forEach((event) => loggingRecord(event, true))
  return body as unknown as LoggingPage
}

export async function loggingEvent(access: LoggingAccess, id: string, scope: LoggingQuery['scope'], signal: AbortSignal): Promise<{ event: LoggingEvent; bounds: LoggingPage['bounds'] }> {
  if (!loggingEventId(id)) throw new LoggingApiError(400, 'invalid_logging_link', 'The diagnostic event link is invalid.')
  const body = await read(access, '/events/' + encodeURIComponent(id), { scope }, signal)
  if (!object(body) || body.version !== 1 || !bounds(body.bounds)) return protocol()
  return { event: loggingRecord(body.event), bounds: body.bounds as unknown as LoggingPage['bounds'] }
}

export async function loggingHealth(access: LoggingAccess, scope: LoggingQuery['scope'], signal: AbortSignal): Promise<LoggingHealth> {
  const body = await read(access, '/health', { scope }, signal, true)
  if (!object(body) || body.version !== 1 || !['connected', 'partial', 'unavailable', 'stopped', 'stale'].includes(String(body.status))
    || !object(body.collection) || !object(body.query) || !time(body.collection.checkedAt) || typeof body.collection.lossObserved !== 'boolean'
    || !['connected', 'partial', 'unavailable', 'stopped', 'stale'].includes(String(body.collection.status)) || !['connected', 'unavailable'].includes(String(body.query.status))
    || !Array.isArray(body.collection.sources) || body.collection.sources.length > 256 || !body.collection.sources.every(coverage)
    || (body.bounds !== undefined && !bounds(body.bounds)) || !policy(body.policy)) return protocol()
  return body as unknown as LoggingHealth
}

export async function loggingExport(access: LoggingAccess, query: LoggingQuery, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(access.endpoint + '/export?' + loggingParameters(query), { cache: 'no-store', credentials: 'same-origin', signal })
  if (!response.ok) {
    const body: unknown = await response.json()
    throw new LoggingApiError(response.status, object(body) && typeof body.error === 'string' ? body.error : 'logging_export_failed',
      object(body) && typeof body.message === 'string' ? body.message : 'The diagnostic export failed.')
  }
  const blob = await response.blob()
  aborted(signal)
  if (blob.size > 8 * 1024 * 1024) return protocol()
  return blob
}

export type LoggingLink = { event?: string; incident?: string; from?: string; to?: string }
export function parseLoggingLink(search: string): LoggingLink | null {
  const params = new URLSearchParams(search)
  if (params.get('view') !== 'logging') return null
  for (const key of ['view', 'event', 'incident', 'from', 'to']) if (params.getAll(key).length > 1) throw new Error('The diagnostic link contains duplicate fields.')
  const event = params.get('event') ?? undefined
  const incident = params.get('incident') ?? undefined
  if ((event && incident) || (params.has('event') && (!event || !loggingEventId(event))) || (params.has('incident') && (!incident || !loggingIncidentId(incident)))) throw new Error('The diagnostic target link is invalid.')
  const from = params.has('from') ? readLoggingTime(params.get('from')!) : undefined
  const to = params.has('to') ? readLoggingTime(params.get('to')!) : undefined
  if (from && to && from >= to) throw new Error('The linked interval is reversed.')
  if (!event && !incident && !from && !to) return null
  return { event, incident, from, to }
}

export function loggingHref(target: LoggingLink): string | null {
  if (!target.event && !target.incident) return null
  const params = new URLSearchParams({ view: 'logging' })
  for (const key of ['event', 'incident', 'from', 'to'] as const) if (target[key] !== undefined) params.set(key, target[key])
  try { parseLoggingLink('?' + params); return '/?' + params }
  catch { return null }
}

export function loggingPullRequest(event: Pick<LogEvent, 'repository' | 'pr'>): string | null {
  const parts = event.repository?.split('/')
  if (!parts || parts.length !== 2 || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(parts[0])
    || !/^[a-z0-9_.-]{1,100}$/i.test(parts[1]) || ['.', '..'].includes(parts[1]) || !event.pr || !/^[1-9]\d*$/.test(event.pr)
    || !Number.isSafeInteger(Number(event.pr))) return null
  return `https://github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/pull/${event.pr}`
}
