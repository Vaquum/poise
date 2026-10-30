import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context, Principal } from './context.js'
import { header, HttpError } from './http.js'
import { diagnosticConfig } from './diagnostics/config.js'
import { serveLogging } from './diagnostics/query-http.js'

/** Authentication and owner-host validation are the workspace API's existing browser guards. */
export async function gatewayLogging(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL, principal: Principal): Promise<void> {
  const origin = header(req, 'origin')
  if (origin && origin !== ctx.workspaceOrigin(principal.user.handle)) throw new HttpError(403, 'This request was not sent from this workspace.')
  await serveLogging(req, res, url, url.pathname.slice('/_poise/api/logging'.length), {
    pool: ctx.loggingQueries, path: join(ctx.deps.config.dataDir, 'logging.db'), policy: diagnosticConfig(process.env).policy,
    workspace: principal.user.handle, isAdmin: principal.isAdmin, now: ctx.deps.now(),
    audit: (scope, operation) => ctx.deps.log.info('logging.query', { actor: principal.user.login, scope, operation, at: new Date(ctx.deps.now()).toISOString() }),
  })
}
