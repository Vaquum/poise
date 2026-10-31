import { SEVERITIES, type Severity } from './contract.js'
import type { LogAccess, LogFilter } from './store.js'
import { readLoggingTime } from './query-time.js'

export class LoggingQueryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const invalid = (message: string): never => { throw new LoggingQueryError(400, 'invalid_logging_query', message) }
const fields = ['from', 'to', 'source', 'component', 'workspace', 'account', 'repository', 'callId', 'correlationId', 'incidentId', 'search', 'cursor', 'after'] as const
export const EVENT_ID = /^evt_[a-f0-9]{16}_[a-f0-9]{64}$/
export const INCIDENT_ID = /^inc_[a-f0-9]{16}_[a-f0-9]{64}$/

/** Zoned, real civil timestamps only; Date.parse alone rolls invalid calendar days forward. */
export function loggingTime(value: string): string {
  try { return readLoggingTime(value) }
  catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid timestamp.') }
}

/** Shared by the HTTP and JSON operator adapters before the canonical scoped store query. */
export function validateLoggingFilter(value: unknown, access: LogAccess): LogFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Filters must be an object.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => ![...fields, 'severities', 'limit'].includes(key))) return invalid('Unknown Logging filter.')
  const filter: LogFilter = {}
  if (input.severities !== undefined) {
    if (!Array.isArray(input.severities) || !input.severities.every((level) => SEVERITIES.includes(level as Severity))) return invalid('Select only critical, error and warning.')
    filter.severities = SEVERITIES.filter((level) => (input.severities as unknown[]).includes(level))
  }
  for (const key of fields) {
    const raw = input[key]
    if (raw === undefined) continue
    const limit = key === 'search' ? 256 : key === 'cursor' || key === 'after' ? 1024 : 512
    if (typeof raw !== 'string' || raw.length > limit || /[\x00-\x1f\x7f]/.test(raw)) return invalid(`Invalid Logging ${key}.`)
    if (!raw && key !== 'search') return invalid(`${key} cannot be empty.`)
    filter[key] = key === 'from' || key === 'to' ? loggingTime(raw) : raw
  }
  if (filter.search === '') delete filter.search
  if (filter.from && filter.to && filter.from >= filter.to) return invalid('from must be before to.')
  if (filter.source && !/^[a-z][a-z0-9._-]{0,127}$/.test(filter.source)) return invalid('Invalid source name.')
  if (filter.workspace && !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(filter.workspace)) return invalid('Invalid workspace handle.')
  if (filter.workspace && !access.operator && filter.workspace !== access.workspace) throw new LoggingQueryError(403, 'logging_forbidden', 'This workspace belongs to someone else.')
  if (filter.incidentId && !INCIDENT_ID.test(filter.incidentId)) return invalid('Invalid incident identifier.')
  if (input.limit !== undefined) {
    if (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100) return invalid('limit must be between 1 and 100.')
    filter.limit = Number(input.limit)
  }
  return filter
}

export function parseLoggingQuery(params: URLSearchParams, principal: { workspace: string; isAdmin: boolean }) {
  const allowed = new Set<string>([...fields, 'severity', 'limit', 'scope'])
  for (const key of params.keys()) {
    if (!allowed.has(key)) return invalid('Unknown Logging parameter.')
    if (key !== 'severity' && params.getAll(key).length !== 1) return invalid(`Duplicate ${key} parameter.`)
  }
  const scope = params.get('scope') ?? 'workspace'
  if (scope !== 'workspace' && scope !== 'instance') return invalid('scope must be workspace or instance.')
  if (scope === 'instance' && !principal.isAdmin) throw new LoggingQueryError(403, 'logging_forbidden', 'Instance diagnostics require administrator access.')
  const access: LogAccess = { workspace: principal.workspace, operator: scope === 'instance' }
  const input: Record<string, unknown> = {}
  for (const key of fields) if (params.has(key)) input[key] = params.get(key)
  if (params.has('severity')) {
    const values = params.getAll('severity')
    input.severities = values.length === 1 && values[0] === '' ? [] : values
  }
  if (params.has('limit')) {
    const raw = params.get('limit')!
    if (!/^[1-9]\d{0,2}$/.test(raw)) return invalid('limit must be between 1 and 100.')
    input.limit = Number(raw)
  }
  return { scope, access, filter: validateLoggingFilter(input, access) }
}
