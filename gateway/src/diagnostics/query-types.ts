import type { EvidenceSelector } from './query-evidence.js'
import type { LogAccess, LogFilter, LogPolicy } from './store.js'

export const LOGGING_RESPONSE_BYTES = 8 * 1024 * 1024
export const LOGGING_EXPORT_EVENTS = 1000
export const LOGGING_QUERY_MS = 2000
export interface LoggingRead {
  path: string
  policy: LogPolicy
  now: number
  access: LogAccess
  operation: 'list' | 'event' | 'health' | 'export' | 'evidence'
  filter: LogFilter
  selectors?: EvidenceSelector[]
  eventId?: string
}
export interface LoggingReply { status: number; contentType: string; body: string }
export type WorkerReply = { id: number; reply: LoggingReply } | { id: number; error: { status: number; code: string; message: string } }
