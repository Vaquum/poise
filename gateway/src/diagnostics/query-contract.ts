import type { LogEvent, Severity } from './contract.js'

export interface LogAccess { workspace: string | null; operator: boolean }
export interface LogFilter {
  severities?: Severity[]
  from?: string
  to?: string
  source?: string
  component?: string
  workspace?: string
  account?: string
  repository?: string
  callId?: string
  correlationId?: string
  incidentId?: string
  search?: string
  cursor?: string
  after?: string
  limit?: number
}
export interface Coverage {
  id: string
  source: string
  workspace: string | null
  status: 'connected' | 'unavailable' | 'partial' | 'not-configured'
  currentStatus?: 'connected' | 'unavailable' | 'partial' | 'not-configured' | 'initializing'
  optional?: boolean
  historyIncomplete?: boolean
  dropped?: number
  rejected?: number
  lossActive?: boolean
  observedAt: string | null
  ingestedAt: string | null
  availableFrom: string | null
  error: string | null
  gaps: Array<{ from: string; to: string | null; reason: string }>
}

/** A legacy partial record cannot establish whether its source has recovered. */
export function currentCoverageStatus(source: Coverage): NonNullable<Coverage['currentStatus']> {
  return source.currentStatus ?? (source.status === 'partial' ? 'initializing' : source.status)
}
export interface LogPolicy { retentionMs: number; maxBytes: number; maxEvents: number }

export interface LoggingPage {
  version: 1
  events: Array<LogEvent & { occurrences: number }>
  total: number
  countKind: 'events'
  nextCursor: string | null
  watermark: string
  coverage: Coverage[]
  bounds: { from: string | null; to: string | null; retentionAfter: string }
  policy: LogPolicy
}
