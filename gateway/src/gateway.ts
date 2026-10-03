import http, { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import * as admin from './admin.js'
import * as auth from './auth.js'
import { Context, type GatewayDeps } from './context.js'
import { classifyHost } from './hosts.js'
import { header, HttpError, sendHtml, sendJson } from './http.js'
import * as link from './link.js'
import { errorMessage } from './log.js'
import { messagePage } from './pages.js'
import { rejectUpgrade } from './proxy.js'
import { workspaceRequest, workspaceUpgrade } from './workspace.js'

type Handler = (ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>

const APEX_ROUTES: Record<string, Record<string, Handler>> = {
  '/': { GET: auth.home, HEAD: auth.home },
  '/auth/login': { GET: auth.login },
  '/auth/callback': { GET: auth.callback },
  '/auth/logout': { GET: auth.logoutPage, POST: auth.logout },
  '/link': { GET: link.approvalPage, POST: link.decide },
  '/link/devices': { GET: link.devices },
  '/link/devices/revoke': { POST: link.revoke },
  '/link/device/code': { POST: link.deviceCode },
  '/link/device/token': { POST: link.deviceToken },
  '/admin': { GET: admin.overview },
  '/admin/allow': { POST: admin.allow },
  '/admin/allow/remove': { POST: admin.disallow },
  '/admin/workspaces/start': { POST: admin.workspaceAction('start') },
  '/admin/workspaces/stop': { POST: admin.workspaceAction('stop') },
  '/admin/workspaces/restart': { POST: admin.workspaceAction('restart') },
  '/admin/users/disable': { POST: admin.setDisabled(true) },
  '/admin/users/enable': { POST: admin.setDisabled(false) },
}

export interface Gateway {
  server: http.Server
  close(): Promise<void>
}

function wantsHtml(req: IncomingMessage): boolean {
  return header(req, 'accept').includes('text/html')
}

function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://gateway.invalid')
  } catch {
    throw new HttpError(400, 'The request target is not a valid URL.')
  }
}

function answer(ctx: Context, req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
  if (wantsHtml(req)) sendHtml(res, status, messagePage(STATUS_CODES[status] ?? 'Error', message), ctx.pageHeaders)
  else sendJson(res, status, { error: (STATUS_CODES[status] ?? 'error').toLowerCase().replaceAll(' ', '_'), message })
}

function fail(ctx: Context, req: IncomingMessage, res: ServerResponse, error: unknown): void {
  if (!(error instanceof HttpError)) {
    // Never the query string: it can carry sign-in tickets.
    ctx.deps.log.error('request.failed', {
      method: req.method,
      host: req.headers.host,
      path: (req.url ?? '').split('?')[0],
      error: errorMessage(error),
    })
  }
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (error instanceof HttpError) answer(ctx, req, res, error.status, error.message)
  else answer(ctx, req, res, 500, 'Something went wrong. The gateway log has the details.')
}

/** The address Caddy uses inside the deployment; no public host ever matches it. */
function isInternalAddress(ctx: Context, req: IncomingMessage): boolean {
  return (req.headers.host ?? '').toLowerCase() === `gateway:${ctx.deps.config.port}`
}

/** Caddy's on-demand TLS check: certificates only for the apex and the hosts of known people. */
function tlsAsk(ctx: Context, res: ServerResponse, url: URL): void {
  const host = classifyHost(url.searchParams.get('domain') ?? '', ctx.deps.config.domain)
  const known = host.kind === 'apex' || (host.kind === 'workspace' && ctx.deps.store.getUser(host.handle) !== null)
  res.writeHead(known ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(known ? 'ok\n' : 'unknown host\n')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = requestUrl(req)
  const host = classifyHost(req.headers.host, ctx.deps.config.domain)
  if (host.kind === 'apex') {
    const route = APEX_ROUTES[url.pathname]
    if (!route) return answer(ctx, req, res, 404, 'There is nothing at this address.')
    const handler = route[req.method ?? '']
    if (!handler) {
      res.setHeader('allow', Object.keys(route).join(', '))
      return answer(ctx, req, res, 405, 'That method is not allowed here.')
    }
    return handler(ctx, req, res, url)
  }
  if (host.kind === 'workspace') {
    const owner = ctx.deps.store.getUser(host.handle)
    if (owner) return workspaceRequest(ctx, req, res, url, owner)
  } else if (isInternalAddress(ctx, req) && url.pathname === '/_gateway/tls-ask' && req.method === 'GET') {
    return tlsAsk(ctx, res, url)
  }
  answer(ctx, req, res, 404, 'There is nothing at this address.')
}

async function upgrade(ctx: Context, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const host = classifyHost(req.headers.host, ctx.deps.config.domain)
  const owner = host.kind === 'workspace' ? ctx.deps.store.getUser(host.handle) : null
  if (!owner) {
    rejectUpgrade(socket, 404, { error: 'not_found' })
    return
  }
  await workspaceUpgrade(ctx, req, socket, head, owner)
}

export function createGateway(deps: GatewayDeps): Gateway {
  const ctx = new Context(deps)
  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((error: unknown) => {
      try {
        fail(ctx, req, res, error)
      } catch (failure) {
        // Answering failed too: a rejection escaping here would stop the gateway for everyone.
        deps.log.error('request.failure.unanswered', { error: errorMessage(failure) })
        res.destroy()
      }
    })
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // A browser dropping its connection mid-handshake is routine, not a gateway failure.
    socket.on('error', () => socket.destroy())
    upgrade(ctx, req, socket, head).catch((error: unknown) => {
      deps.log.error('upgrade.failed', { host: req.headers.host, path: (req.url ?? '').split('?')[0], error: errorMessage(error) })
      rejectUpgrade(socket, 500, { error: 'internal_error' })
    })
  })
  // Outlive Caddy's two-minute upstream keep-alive, so the gateway never closes a connection Caddy is about to reuse.
  server.keepAliveTimeout = 130_000
  return {
    server,
    close: () => new Promise<void>((resolve, reject) => {
      ctx.agent.destroy()
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}
