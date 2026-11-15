import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context, Principal } from './context.js'
import { header, HttpError } from './http.js'
import { diagnosticConfig } from './diagnostics/config.js'
import { serveLogging } from './diagnostics/query-http.js'
import type { HandoffCandidate } from './diagnostics/query-handoff.js'

/** Authentication and owner-host validation are the workspace API's existing browser guards. */
export async function gatewayLogging(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal): Promise<void> {
  const origin = header(req, 'origin')
  if (origin && origin !== ctx.workspaceOrigin(principal.user.handle)) throw new HttpError(403, 'This request was not sent from this workspace.')
  await serveLogging(req, res, url, url.pathname.slice('/_poise/api/logging'.length), {
    pool: ctx.loggingQueries, path: join(ctx.deps.config.dataDir, 'logging.db'), policy: diagnosticConfig(process.env).policy,
    workspace: principal.user.handle, isAdmin: principal.isAdmin, now: ctx.deps.now(),
    audit: (scope, operation) => ctx.deps.log.info('logging.query', { actor: principal.user.login, scope, operation, at: new Date(ctx.deps.now()).toISOString() }),
    handoffs: (candidates, signal) => ownerHandoffs(ctx, principal, candidates, signal),
  })
}

/** One owner only, with the existing browser assertion and bounded response. */
function ownerHandoffs(ctx: Context, principal: Principal, candidates: HandoffCandidate[], signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const target = ctx.deps.upstream(principal.user.handle)
    const path = '/api/behavior-chains?' + new URLSearchParams({ handoffs: JSON.stringify(candidates) })
    const request = http.request({ host: target.host, port: target.port, path, method: 'GET', agent: ctx.agent, signal,
      headers: { host: new URL(ctx.workspaceOrigin(principal.user.handle)).host, accept: 'application/json',
        'x-poise-identity': ctx.assertion(principal.user, 'browser', principal.session) } }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 64 * 1024) { response.destroy(new Error('Owner handoff evidence exceeds its bounded read budget')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Owner handoff evidence is unavailable')
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!body || typeof body !== 'object' || !('warnings' in body) || !Array.isArray(body.warnings)
            || body.warnings.some(id => typeof id !== 'string' || !candidates.some(candidate => candidate.id === id))) throw new Error('Invalid owner handoff evidence')
          resolve(body.warnings)
        } catch (error) { reject(error) }
      })
    })
    request.setTimeout(500, () => request.destroy(new Error('Owner handoff evidence is unavailable')))
    request.on('error', reject)
    request.end()
  })
}
