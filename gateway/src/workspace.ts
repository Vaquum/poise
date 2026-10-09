import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { heldBindings, isSafePath } from './auth.js'
import { WORKSPACE_COOKIE, type Context } from './context.js'
import { header, HttpError, isNavigation, readForm, redirect, safeEqual, sendHtml, sendJson } from './http.js'
import { errorMessage } from './log.js'
import { messagePage, signOutPage, startingPage } from './pages.js'
import { forwardHeaders, isUnreachable, MAX_REQUEST_BODY_BYTES, proxyRequest, proxyUpgrade, rejectUpgrade, RequestTooLargeError } from './proxy.js'
import { deviceState, hashSecret, type Session, type User } from './store.js'
import { workspaceApi, WORKSPACE_API_PREFIX } from './workspace-api.js'

type Authentication =
  | { kind: 'ok'; scope: 'browser' | 'link' }
  | { kind: 'unauthenticated'; bearer: boolean; error: string; message: string }
  | { kind: 'forbidden'; message: string }

const ACCESS_REMOVED = 'Your access to this Poise has been removed. Ask an admin.'
const BODILESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE', 'TRACE'])

/**
 * Why a request's body framing is refused, if it is. A body on a bodiless method would reach the
 * workspace unframed and be read as a second request, smuggled past the gateway.
 */
function framingProblem(req: IncomingMessage): string | null {
  const transferEncoding = req.headers['transfer-encoding']
  if (transferEncoding !== undefined && transferEncoding.trim().toLowerCase() !== 'chunked') {
    return 'Only the chunked transfer coding is accepted.'
  }
  const hasBody = transferEncoding !== undefined || Number(req.headers['content-length'] ?? 0) > 0
  if (hasBody && BODILESS_METHODS.has(req.method ?? '')) return `A ${req.method} request cannot carry a body.`
  return null
}
const STARTING = { error: 'workspace_starting', message: 'Your workspace is starting. Try again in a moment.' }

/** /api/link/* exactly as written: no dot segments or backslashes that a URL parser would resolve elsewhere. */
export function isLinkPath(target: string): boolean {
  const path = target.split('?')[0]
  return path.startsWith('/api/link/') && new URL(path, 'http://gateway.invalid').pathname === path
}

function isOwnSession(session: Session, owner: User): boolean {
  return session.host === owner.handle && session.handle === owner.handle
}

function ownSession(ctx: Context, req: IncomingMessage, owner: User): Session | null {
  return ctx.workspaceSessions(req).find((session) => isOwnSession(session, owner)) ?? null
}

/**
 * Who is asking, judged only by credentials for this host: the owner's session or one of their devices.
 * Every unusable device token is a 401 with a reason, never a 403 or a redirect: Poise Link treats any
 * 401 as "sign out and pair again".
 */
function authenticate(ctx: Context, req: IncomingMessage, owner: User): Authentication {
  const { store } = ctx.deps
  const authorization = header(req, 'authorization')
  if (/^bearer(\s|$)/i.test(authorization)) {
    const refused = (error: string, message: string): Authentication => ({ kind: 'unauthenticated', bearer: true, error, message })
    if (!isLinkPath(req.url ?? '')) return refused('invalid_token', 'Device tokens are accepted only for /api/link/*.')
    const device = store.findDeviceByToken(authorization.slice('bearer'.length).trim())
    // A token paired with another workspace is as unknown here as one never issued.
    if (!device || device.handle !== owner.handle) return refused('device_unknown', 'This device token is not known here. Pair the device again.')
    const state = deviceState(device, ctx.deps.now())
    if (state === 'revoked') return refused('device_revoked', 'This device was revoked. Pair it again.')
    if (state === 'expired') return refused('device_expired', 'This device token has expired. Pair the device again.')
    if (owner.disabledAt !== null) return refused('user_disabled', 'This account has been disabled by an admin.')
    if (!ctx.isAllowed(owner)) return refused('access_removed', ACCESS_REMOVED)
    store.touchDevice(device.id)
    return { kind: 'ok', scope: 'link' }
  }
  const sessions = ctx.workspaceSessions(req)
  if (sessions.some((session) => isOwnSession(session, owner))) {
    return ctx.isAllowed(owner) ? { kind: 'ok', scope: 'browser' } : { kind: 'forbidden', message: ACCESS_REMOVED }
  }
  if (sessions.length > 0) return { kind: 'forbidden', message: 'This workspace belongs to someone else.' }
  return { kind: 'unauthenticated', bearer: false, error: 'unauthorized', message: 'Sign in to use this workspace.' }
}

function refuse(ctx: Context, req: IncomingMessage, res: ServerResponse, owner: User, auth: Exclude<Authentication, { kind: 'ok' }>): void {
  if (auth.kind === 'unauthenticated') {
    if (auth.bearer) {
      sendJson(res, 401, { error: auth.error, message: auth.message }, { 'www-authenticate': 'Bearer error="invalid_token"' })
    } else if (isNavigation(req)) {
      const back = `${ctx.workspaceOrigin(owner.handle)}${req.url ?? '/'}`
      redirect(res, `${ctx.apexOrigin}/auth/login?next=${encodeURIComponent(back)}`)
    } else {
      sendJson(res, 401, { error: auth.error, message: `${auth.message} Sign in at ${ctx.apexOrigin}/.` })
    }
    return
  }
  if (isNavigation(req)) {
    sendHtml(res, 403, messagePage('Not your workspace', auth.message, { href: `${ctx.apexOrigin}/`, label: 'Go to your own workspace' }), ctx.pageHeaders)
  } else {
    sendJson(res, 403, { error: 'forbidden', message: auth.message })
  }
}

/** Starts the workspace in the background and tells the caller to come back shortly. */
function starting(ctx: Context, req: IncomingMessage, res: ServerResponse, owner: User, problem: string | null): void {
  ctx.deps.orchestrator.startInBackground(owner.handle, owner.login)
  if (!isNavigation(req)) {
    sendJson(res, 503, STARTING, { 'retry-after': '2' })
    return
  }
  sendHtml(res, 503, startingPage({
    workspaceHost: `${owner.handle}.${ctx.deps.config.domain}`,
    lastError: ctx.deps.store.getWorkspace(owner.handle)?.lastError ?? null,
    problem,
    // Settings → Admin lives in the workspace; when it cannot start, the apex admin page still works.
    adminHref: ctx.isAdmin(owner.handle) ? `${ctx.apexOrigin}/admin` : null,
  }), { ...ctx.pageHeaders, 'retry-after': '2' })
}

function redeemTicket(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL, owner: User): void {
  const { log, store } = ctx.deps
  const next = url.searchParams.get('next') ?? '/'
  if (!isSafePath(next)) throw new HttpError(400, 'The address to continue to is not a path on this workspace.')
  const ticket = url.searchParams.get('ticket') ?? ''
  const reject = (reason: string): void => {
    log.warn('session.ticket.rejected', { handle: owner.handle, reason })
    sendHtml(res, 403, messagePage(
      'This sign-in link cannot be used',
      'It has expired, was already used, or belongs to another workspace.',
      { href: `${ctx.apexOrigin}/auth/login?next=${encodeURIComponent(`${ctx.workspaceOrigin(owner.handle)}${next}`)}`, label: 'Sign in again' },
    ), ctx.pageHeaders)
  }
  if (!ticket) return reject('no ticket')
  const result = store.consumeTicket(ticket)
  if (!result.ok) return reject(result.reason)
  if (result.host !== owner.handle || result.handle !== owner.handle) return reject('the ticket is for another workspace')
  if (!heldBindings(req).some((value) => safeEqual(hashSecret(value), result.bindHash))) {
    return reject('the ticket was issued to another browser')
  }
  const apexSession = store.sessionByHash(result.apexSessionHash)
  if (!apexSession) return reject('the apex session has ended')
  if (!ctx.isAllowed(owner)) return reject('access removed')
  const { id, session } = store.createWorkspaceSession(apexSession, owner.handle)
  log.info('session.workspace.created', { handle: owner.handle })
  redirect(res, next, 302, {
    'set-cookie': ctx.cookie(WORKSPACE_COOKIE, id, (session.expiresAt - ctx.deps.now()) / 1000),
    'referrer-policy': 'no-referrer',
  })
}

function signOutConfirmation(ctx: Context, req: IncomingMessage, res: ServerResponse, owner: User): void {
  const session = ownSession(ctx, req, owner)
  if (!session) {
    redirect(res, `${ctx.apexOrigin}/`)
    return
  }
  sendHtml(res, 200, signOutPage('/_poise/logout', session.csrf), ctx.pageHeaders)
}

async function signOut(ctx: Context, req: IncomingMessage, res: ServerResponse, owner: User): Promise<void> {
  const form = await readForm(req)
  const session = ownSession(ctx, req, owner)
  const clear = [ctx.cookie(WORKSPACE_COOKIE, '', 0), ctx.bindCookie('', 0)]
  if (!session) {
    redirect(res, `${ctx.apexOrigin}/`, 303, { 'set-cookie': clear })
    return
  }
  ctx.verifyForm(req, form, session, ctx.workspaceOrigin(owner.handle))
  // Ending only this host's session would sign the person straight back in from the apex session.
  ctx.deps.store.deleteSession(session.parentHash ?? session.idHash)
  ctx.deps.log.info('auth.signed_out', { login: owner.login, host: owner.handle })
  redirect(res, `${ctx.apexOrigin}/`, 303, { 'set-cookie': clear })
}

/** Paths under /_poise/ belong to the gateway on every workspace host. */
async function gatewayPath(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL, owner: User): Promise<void> {
  if (url.pathname.startsWith(WORKSPACE_API_PREFIX)) return workspaceApi(ctx, req, res, url, owner)
  if (url.pathname === '/_poise/session' && req.method === 'GET') return redeemTicket(ctx, req, res, url, owner)
  if (url.pathname === '/_poise/logout' && req.method === 'GET') return signOutConfirmation(ctx, req, res, owner)
  if (url.pathname === '/_poise/logout' && req.method === 'POST') return signOut(ctx, req, res, owner)
  throw new HttpError(404, 'There is nothing at this address.')
}

export async function workspaceRequest(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL, owner: User): Promise<void> {
  const problem = framingProblem(req)
  if (problem) throw new HttpError(400, problem)
  if (Number(req.headers['content-length'] ?? 0) > MAX_REQUEST_BODY_BYTES) {
    throw new HttpError(413, `A request body may be at most ${MAX_REQUEST_BODY_BYTES} bytes.`)
  }
  if (url.pathname === '/_poise' || url.pathname.startsWith('/_poise/')) return gatewayPath(ctx, req, res, url, owner)
  if (!req.url?.startsWith('/')) throw new HttpError(400, 'The request target must be a path.')
  const auth = authenticate(ctx, req, owner)
  if (auth.kind !== 'ok') return refuse(ctx, req, res, owner, auth)
  const { log, orchestrator } = ctx.deps
  const readiness = await orchestrator.readiness(owner.handle, owner.login)
  if (!readiness.ready) return starting(ctx, req, res, owner, readiness.problem)
  const headers = forwardHeaders(req, {
    assertion: ctx.assertion(owner, auth.scope),
    proto: ctx.scheme,
    dropAuthorization: auth.scope === 'link',
  })
  proxyRequest(req, res, ctx.deps.upstream(owner.handle), headers, ctx.agent, (error) => {
    // Runs inside a socket event: a throw here would escape every handler and stop the gateway.
    try {
      if (error instanceof RequestTooLargeError) {
        log.warn('proxy.body_too_large', { handle: owner.handle, limit: error.limit })
        // The rest of the body is never read: close the connection once the refusal is sent.
        sendJson(res, 413, { error: 'payload_too_large', message: `A request body may be at most ${error.limit} bytes.` }, { connection: 'close' })
        return
      }
      if (isUnreachable(error)) {
        orchestrator.markNotReady(owner.handle)
        log.warn('workspace.unreachable', { handle: owner.handle, error: error.message })
        starting(ctx, req, res, owner, null)
        return
      }
      log.error('proxy.failed', { handle: owner.handle, error: error.message })
      if (isNavigation(req)) {
        sendHtml(res, 502, messagePage('Your workspace did not answer', 'The connection to your workspace failed. Reload to try again.'), ctx.pageHeaders)
      } else {
        sendJson(res, 502, { error: 'bad_gateway', message: 'The connection to the workspace failed.' })
      }
    } catch (failure) {
      log.error('proxy.failure.unanswered', { handle: owner.handle, error: errorMessage(failure) })
      res.destroy()
    }
  })
}

export async function workspaceUpgrade(ctx: Context, req: IncomingMessage, socket: Duplex, head: Buffer, owner: User): Promise<void> {
  const path = (req.url ?? '').split('?')[0]
  if (!req.url?.startsWith('/') || path === '/_poise' || path.startsWith('/_poise/')) {
    rejectUpgrade(socket, 404, { error: 'not_found' })
    return
  }
  if (header(req, 'upgrade').toLowerCase() !== 'websocket') {
    rejectUpgrade(socket, 400, { error: 'unsupported_upgrade', message: 'Only WebSocket upgrades are proxied.' })
    return
  }
  const problem = framingProblem(req)
  if (problem) {
    rejectUpgrade(socket, 400, { error: 'bad_request', message: problem })
    return
  }
  const auth = authenticate(ctx, req, owner)
  if (auth.kind === 'unauthenticated') {
    rejectUpgrade(socket, 401, { error: auth.error, message: auth.message },
      auth.bearer ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {})
    return
  }
  if (auth.kind === 'forbidden') {
    rejectUpgrade(socket, 403, { error: 'forbidden', message: auth.message })
    return
  }
  const { log, orchestrator } = ctx.deps
  const readiness = await orchestrator.readiness(owner.handle, owner.login)
  if (!readiness.ready) {
    orchestrator.startInBackground(owner.handle, owner.login)
    rejectUpgrade(socket, 503, STARTING, { 'retry-after': '2' })
    return
  }
  const headers = forwardHeaders(req, {
    assertion: ctx.assertion(owner, auth.scope),
    proto: ctx.scheme,
    dropAuthorization: auth.scope === 'link',
  })
  proxyUpgrade(req, socket, head, ctx.deps.upstream(owner.handle), headers, (error) => {
    // Runs inside a socket event: a throw here would escape every handler and stop the gateway.
    try {
      if (isUnreachable(error)) {
        orchestrator.markNotReady(owner.handle)
        orchestrator.startInBackground(owner.handle, owner.login)
        log.warn('workspace.unreachable', { handle: owner.handle, error: error.message })
        rejectUpgrade(socket, 503, STARTING, { 'retry-after': '2' })
        return
      }
      log.error('proxy.upgrade.failed', { handle: owner.handle, error: error.message })
      rejectUpgrade(socket, 502, { error: 'bad_gateway', message: 'The connection to the workspace failed.' })
    } catch (failure) {
      log.error('proxy.failure.unanswered', { handle: owner.handle, error: errorMessage(failure) })
      socket.destroy()
    }
  })
}
