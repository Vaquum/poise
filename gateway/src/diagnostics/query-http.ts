import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LogPolicy } from './store.js'
import { EVENT_ID, LoggingQueryError, parseLoggingQuery } from './query-parser.js'
import type { LoggingQueryPool } from './query-pool.js'
import { LOGGING_QUERY_MS, type LoggingRead } from './query-types.js'
import type { HandoffCandidate } from './query-handoff.js'

interface QueryHost {
  pool: LoggingQueryPool
  path: string | null
  policy: LogPolicy
  workspace: string
  isAdmin: boolean
  now: number
  audit: (scope: string, operation: string) => void
  handoffs?: (candidates: HandoffCandidate[], signal: AbortSignal) => Promise<string[]>
}

export async function serveLogging(req: IncomingMessage, res: ServerResponse, url: URL, route: string, host: QueryHost): Promise<void> {
  let release: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = new AbortController()
  const finish = () => { clearTimeout(timer); abort.abort(); release?.(); release = null }
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
    const request: LoggingRead = { path, policy: host.policy, now: host.now, access, operation, filter, eventId }
    if (host.handoffs && operation !== 'health') {
      timer = setTimeout(() => {
        // The budget can expire mid-stream: a stalled half-sent response is
        // destroyed instead of only releasing the pool timeout that would do it.
        if (res.headersSent && !res.writableFinished) res.destroy()
        else answer(503, { error: 'logging_query_timeout', message: 'The diagnostic query exceeded its two-second response budget.' })
        finish()
      }, LOGGING_QUERY_MS)
      const candidates = await host.pool.read({ ...request, operation: 'handoffs' }, host.workspace, abort.signal, () => abort.abort())
      let snapshot: { high: number; candidates: HandoffCandidate[] }
      try { snapshot = JSON.parse(candidates.reply.body) as typeof snapshot } finally { candidates.release() }
      const warnings: string[] = []
      try {
        for (let start = 0; start < snapshot.candidates.length; start += 10) {
          const batch = snapshot.candidates.slice(start, start + 10)
          const confirmed = await host.handoffs(batch, abort.signal)
          if (!Array.isArray(confirmed) || confirmed.some(id => !batch.some(candidate => candidate.id === id))) throw new Error('Invalid handoff evidence response')
          warnings.push(...confirmed)
        }
      } catch {
        // Missing owner evidence retains source severity for the whole snapshot.
        warnings.length = 0
      }
      request.classification = { high: snapshot.high, warnings }
    }
    const lease = await host.pool.read(request, host.workspace, abort.signal,
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
