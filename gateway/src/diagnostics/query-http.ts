import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LogPolicy } from './store.js'
import { EVENT_ID, LoggingQueryError, parseLoggingQuery } from './query-parser.js'
import type { LoggingQueryPool } from './query-pool.js'
import type { LoggingRead } from './query-types.js'

interface QueryHost {
  pool: LoggingQueryPool
  path: string | null
  policy: LogPolicy
  workspace: string
  isAdmin: boolean
  now: number
  audit: (scope: string, operation: string) => void
}

export async function serveLogging(req: IncomingMessage, res: ServerResponse, url: URL, route: string, host: QueryHost): Promise<void> {
  let release: (() => void) | null = null
  const abort = new AbortController()
  const finish = () => { abort.abort(); release?.(); release = null }
  res.once('finish', finish)
  res.once('close', finish)
  req.once('aborted', finish)
  const answer = (status: number, body: unknown) => {
    if (res.destroyed || res.headersSent) return
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '1' } : {}), ...(status === 405 ? { allow: 'GET' } : {}) })
    res.end(payload)
  }
  try {
    if (res.destroyed || req.aborted) { finish(); return }
    if (req.method !== 'GET') throw new LoggingQueryError(405, 'logging_method_not_allowed', 'Use GET for diagnostic reads.')
    if ((req.url?.length ?? 0) > 8192) throw new LoggingQueryError(400, 'invalid_logging_query', 'The diagnostic URL is too long.')
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) throw new LoggingQueryError(400, 'invalid_logging_query', 'Diagnostic reads do not accept a request body.')
    const { access, filter, scope } = parseLoggingQuery(url.searchParams, host)
    let operation: LoggingRead['operation']
    let eventId: string | undefined
    if (route === '' || route === '/') operation = 'list'
    else if (route === '/health') operation = 'health'
    else if (route === '/export') operation = 'export'
    else if (route.startsWith('/events/')) {
      operation = 'event'
      eventId = route.slice('/events/'.length)
      if (!EVENT_ID.test(eventId)) throw new LoggingQueryError(400, 'invalid_logging_query', 'Invalid diagnostic event identifier.')
    } else throw new LoggingQueryError(404, 'logging_route_unavailable', 'There is nothing at this address.')
    if ((operation === 'event' || operation === 'health') && [...url.searchParams.keys()].some((key) => key !== 'scope')) {
      throw new LoggingQueryError(400, 'invalid_logging_query', 'Detail and health reads accept only scope.')
    }
    const path = host.path
    if (!path) throw new LoggingQueryError(503, 'logging_unavailable', 'Diagnostic collection has not started.')
    if (scope === 'instance') host.audit(scope, operation)
    const lease = await host.pool.read({ path, policy: host.policy, now: host.now, access, operation, filter, eventId }, host.workspace, abort.signal,
      () => { if (res.headersSent && !res.writableFinished) res.destroy() })
    release = lease.release
    if (res.destroyed || abort.signal.aborted) { release(); return }
    const { reply } = lease
    res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': Buffer.byteLength(reply.body), 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...(operation === 'export' && reply.status === 200 ? { 'content-disposition': 'attachment; filename="poise-diagnostics.ndjson"' } : {}) })
    res.end(reply.body)
  } catch (error) {
    const failure = error instanceof LoggingQueryError ? error : new LoggingQueryError(503, 'logging_unavailable', 'Retained diagnostics cannot be read.')
    answer(failure.status, { error: failure.code, message: failure.message })
  }
}
