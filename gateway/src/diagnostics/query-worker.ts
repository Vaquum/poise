import { joinEvidence } from './query-evidence.js'
import { parentPort } from 'node:worker_threads'
import { readFileSync, statSync } from 'node:fs'
import { DiagnosticCursorError, DiagnosticStore, projectCoverage, type Coverage } from './store.js'
import { MAX_COVERAGE_JOURNAL_BYTES } from './runtime.js'
import { LoggingQueryError } from './query-parser.js'
import { LOGGING_EXPORT_EVENTS, LOGGING_RESPONSE_BYTES, type LoggingRead, type LoggingReply, type WorkerReply } from './query-types.js'

function json(status: number, body: unknown): LoggingReply {
  const payload = JSON.stringify(body)
  if (Buffer.byteLength(payload) > LOGGING_RESPONSE_BYTES) throw new LoggingQueryError(503, 'logging_unavailable', 'The diagnostic response exceeds its bounded read budget.')
  return { status, body: payload, contentType: 'application/json; charset=utf-8' }
}

function checkEvents(events: Array<{ version: number }>): void {
  if (events.some((event) => event.version !== 1)) throw new LoggingQueryError(503, 'logging_unavailable', 'The retained diagnostic version is unsupported.')
}

function health(request: LoggingRead): LoggingReply {
  let collection: { status: string; sources: Coverage[]; lossObserved: boolean; checkedAt: string } = {
    status: 'unavailable', sources: [], lossObserved: false, checkedAt: new Date(request.now).toISOString(),
  }
  try {
    const path = request.path + '.coverage.json'
    if (statSync(path).size > MAX_COVERAGE_JOURNAL_BYTES) throw new Error('Coverage journal exceeds its limit')
    const journal = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number; sources: Coverage[]; writtenAt: string; stopped: boolean; sinkError: string | null;
      dropped: number; rejected: number; coverageError?: string | null; reportError?: string | null;
    }
    if (journal.version !== 1 || !Array.isArray(journal.sources) || journal.sources.length > 256 || !Number.isFinite(Date.parse(journal.writtenAt))) throw new Error('Unsupported coverage journal')
    const sources = journal.sources.filter((source) => source.workspace === null || source.workspace === request.access.workspace)
      .map((source) => projectCoverage(source, request.access))
    const lossObserved = journal.dropped > 0 || journal.rejected > 0 || !!journal.coverageError || !!journal.reportError
    collection = { checkedAt: journal.writtenAt, sources, lossObserved,
      status: journal.sinkError ? 'unavailable' : journal.stopped ? 'stopped' : request.now - Date.parse(journal.writtenAt) > 60_000 ? 'stale'
        : lossObserved || sources.some((source) => source.status !== 'connected') ? 'partial' : 'connected' }
  } catch {
    // An unread journal is an explicit independent failure, never a healthy empty source list.
    collection.status = 'unavailable'
  }
  let db: DiagnosticStore | null = null
  try {
    db = new DiagnosticStore(request.path, request.policy, () => request.now, true)
    return json(200, { version: 1, status: collection.status === 'unavailable' ? 'partial' : collection.status,
      collection, query: { status: 'connected' }, bounds: db.bounds(request.access), policy: request.policy })
  } catch {
    return json(503, { version: 1, error: 'logging_unavailable', message: 'Retained diagnostics cannot be read.', status: 'unavailable', collection, query: { status: 'unavailable' }, policy: request.policy })
  } finally { db?.close() }
}

function exportEvents(db: DiagnosticStore, request: LoggingRead): LoggingReply {
  const maxEvents = request.filter.limit ?? LOGGING_EXPORT_EVENTS
  const first = db.query(request.access, { ...request.filter, limit: 1 })
  checkEvents(first.events)
  const { events: firstEvents, ...metadata } = first
  const lines = firstEvents.map((event) => JSON.stringify({ type: 'event', event }) + '\n')
  let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0)
  let cursor = first.nextCursor
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadata)) + 4096
  if (bytes + metadataBytes > LOGGING_RESPONSE_BYTES) throw new LoggingQueryError(503, 'logging_unavailable', 'Export metadata exceeds its bounded read budget.')
  while (cursor && lines.length < maxEvents) {
    const before = cursor
    const page = db.query(request.access, { ...request.filter, cursor: before, limit: Math.min(100, maxEvents - lines.length) })
    checkEvents(page.events)
    let included = 0
    for (const event of page.events) {
      const line = JSON.stringify({ type: 'event', event }) + '\n'
      if (bytes + Buffer.byteLength(line) + metadataBytes > LOGGING_RESPONSE_BYTES) break
      lines.push(line); bytes += Buffer.byteLength(line); included++
    }
    if (included < page.events.length) {
      cursor = included ? db.query(request.access, { ...request.filter, cursor: before, limit: included }).nextCursor : before
      break
    }
    cursor = page.nextCursor
  }
  const header = JSON.stringify({ type: 'metadata', ...metadata, nextCursor: cursor, resumeCursor: cursor, exported: lines.length, truncated: cursor !== null }) + '\n'
  const body = header + lines.join('')
  if (Buffer.byteLength(body) > LOGGING_RESPONSE_BYTES) throw new LoggingQueryError(503, 'logging_unavailable', 'Export exceeds its bounded read budget.')
  return { status: 200, contentType: 'application/x-ndjson; charset=utf-8', body }
}

export function executeLoggingRead(request: LoggingRead): LoggingReply {
  if (request.operation === 'health') return health(request)
  const db = new DiagnosticStore(request.path, request.policy, () => request.now, true)
  try {
    if (request.operation === 'evidence') return json(200, joinEvidence(db, request.access, request.selectors ?? []))
    if (request.operation === 'event') {
      const found = db.lookup(request.access, request.eventId!)
      const bounds = db.bounds(request.access)
      if (found.status === 'found') { checkEvents([found.event]); return json(200, { version: 1, event: found.event, bounds }) }
      return found.status === 'expired'
        ? json(410, { error: 'logging_event_expired', message: 'Diagnostic evidence has expired.', bounds })
        : json(404, { error: 'logging_event_unavailable', message: 'Diagnostic evidence is unavailable.', bounds })
    }
    if (request.operation === 'export') return exportEvents(db, request)
    const page = db.query(request.access, request.filter)
    checkEvents(page.events)
    return json(200, page)
  } finally { db.close() }
}

if (parentPort) {
  const port = parentPort
  port.on('message', ({ id, request }: { id: number; request: LoggingRead }) => {
    let message: WorkerReply
    try { message = { id, reply: executeLoggingRead(request) } }
    catch (error) {
      const failure = error instanceof LoggingQueryError ? error : error instanceof DiagnosticCursorError
        ? new LoggingQueryError(400, 'invalid_logging_query', error.message)
        : new LoggingQueryError(503, 'logging_unavailable', 'Retained diagnostics cannot be read.')
      message = { id, error: { status: failure.status, code: failure.code, message: failure.message } }
    }
    port.postMessage(message)
  })
}
