import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { RESERVED_HANDLES } from './config.js'
import {
  APEX_COOKIE, APEX_SESSION_TTL_MS, OAUTH_COOKIE, OAUTH_STATE_TTL_MS, TICKET_TTL_MS,
  type Context, type Principal,
} from './context.js'
import { cookieValues } from './cookies.js'
import type { GitHubIdentity, OrgMembership } from './github.js'
import { classifyHost } from './hosts.js'
import { HttpError, readForm, redirect, safeEqual, sendHtml } from './http.js'
import { errorMessage } from './log.js'
import { homePage, messagePage, signInPage, signOutPage } from './pages.js'

export type ReturnTo = { kind: 'apex'; path: string } | { kind: 'workspace'; handle: string; path: string }

type Access =
  | { allowed: true; via: 'admin' | 'allow list' | 'organisation'; org: string | null }
  | { allowed: false; reason: string; message: string }

/** A path on the current host: no scheme or authority, no backslashes, no control characters. */
export function isSafePath(value: string): boolean {
  if (value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return false
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false
  return new URL(value, 'https://gateway.invalid').origin === 'https://gateway.invalid'
}

/** Where to go after sign-in: an apex path or a URL on a workspace host of this gateway, nothing else. */
export function parseReturnTo(ctx: Context, value: string): ReturnTo | null {
  if (value.startsWith('/')) return isSafePath(value) ? { kind: 'apex', path: value } : null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== `${ctx.scheme}:` || url.username || url.password || url.port) return null
  const path = `${url.pathname}${url.search}`
  if (!isSafePath(path)) return null
  const host = classifyHost(url.host, ctx.deps.config.domain)
  if (host.kind === 'apex') return { kind: 'apex', path }
  if (host.kind === 'workspace') return { kind: 'workspace', handle: host.handle, path }
  return null
}

/** The signed-in principal for a page, or null after answering with a redirect to sign-in. */
export function pagePrincipal(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Principal | null {
  const principal = ctx.apexPrincipal(req)
  if (!principal) redirect(res, `/auth/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`)
  return principal
}

/** The signed-in principal for a form post; a post without one is refused. */
export function postPrincipal(ctx: Context, req: IncomingMessage): Principal {
  const principal = ctx.apexPrincipal(req)
  if (!principal) throw new HttpError(403, 'Sign in first.')
  return principal
}

export function home(ctx: Context, req: IncomingMessage, res: ServerResponse): void {
  const principal = ctx.apexPrincipal(req)
  if (!principal) {
    sendHtml(res, 200, signInPage(), ctx.pageHeaders)
    return
  }
  const workspaceOrigin = ctx.workspaceOrigin(principal.user.handle)
  sendHtml(res, 200, homePage({
    user: principal.user,
    isAdmin: principal.isAdmin,
    workspaceHref: `/auth/login?next=${encodeURIComponent(`${workspaceOrigin}/`)}`,
    workspaceHost: new URL(workspaceOrigin).host,
    csrf: principal.session.csrf,
  }), ctx.pageHeaders)
}

export function login(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const next = url.searchParams.get('next')
  const returnTo = next === null ? null : parseReturnTo(ctx, next)
  if (next !== null && returnTo === null) {
    throw new HttpError(400, 'The address to return to after signing in is not an address of this Poise.')
  }
  const principal = ctx.apexPrincipal(req)
  if (principal) {
    continueTo(ctx, res, principal, returnTo)
    return
  }
  const state = ctx.deps.store.createOAuthState(next, OAUTH_STATE_TTL_MS)
  const scopes = ctx.deps.config.allowedOrgs.length > 0 ? ['read:user', 'read:org'] : ['read:user']
  redirect(res, ctx.deps.github.authorizeUrl(state, `${ctx.apexOrigin}/auth/callback`, scopes), 302, {
    'set-cookie': ctx.cookie(OAUTH_COOKIE, state, OAUTH_STATE_TTL_MS / 1000, '/auth'),
  })
}

/** Sends a signed-in person on: to an apex path, or into their own workspace through a single-use ticket. */
function continueTo(ctx: Context, res: ServerResponse, principal: Principal, returnTo: ReturnTo | null, headers: OutgoingHttpHeaders = {}): void {
  if (returnTo === null) {
    redirect(res, '/', 302, headers)
    return
  }
  if (returnTo.kind === 'apex') {
    redirect(res, returnTo.path, 302, headers)
    return
  }
  if (returnTo.handle !== principal.user.handle) {
    ctx.deps.log.warn('session.ticket.refused', { login: principal.user.login, host: returnTo.handle, reason: 'not the owner' })
    sendHtml(res, 403, messagePage(
      'Not your workspace',
      `${returnTo.handle}.${ctx.deps.config.domain} belongs to someone else. You are signed in as ${principal.user.login}.`,
      { href: '/', label: 'Go to your own workspace' },
    ), { ...ctx.pageHeaders, ...headers })
    return
  }
  const ticket = ctx.deps.store.createTicket(principal.session, returnTo.handle, TICKET_TTL_MS)
  const target = new URL('/_poise/session', ctx.workspaceOrigin(returnTo.handle))
  target.searchParams.set('ticket', ticket)
  target.searchParams.set('next', returnTo.path)
  redirect(res, target.href, 302, headers)
}

async function decideAccess(ctx: Context, login: string, membership: (org: string) => Promise<OrgMembership>): Promise<Access> {
  const { config, store } = ctx.deps
  const handle = login.toLowerCase()
  if (RESERVED_HANDLES.has(handle)) {
    return {
      allowed: false,
      reason: 'reserved handle',
      message: `The GitHub login ${login} cannot sign in here: ${handle}.${config.domain} is one of this Poise's own addresses.`,
    }
  }
  if (config.admins.includes(handle)) return { allowed: true, via: 'admin', org: null }
  if (store.isOnAllowList(handle)) return { allowed: true, via: 'allow list', org: null }
  const hidden: string[] = []
  for (const org of config.allowedOrgs) {
    const state = await membership(org)
    if (state === 'active') return { allowed: true, via: 'organisation', org }
    if (state === 'restricted') hidden.push(org)
  }
  if (hidden.length > 0) {
    return {
      allowed: false,
      reason: `membership hidden by ${hidden.join(', ')}`,
      message: `GitHub did not share your membership of ${hidden.join(', ')} with Poise; the organisation may restrict OAuth Apps. Ask an admin.`,
    }
  }
  return { allowed: false, reason: 'not allowed', message: `${login} is not allowed to use this Poise. Ask an admin to add you.` }
}

export async function callback(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { github, log, store } = ctx.deps
  const clearState = ctx.cookie(OAUTH_COOKIE, '', 0, '/auth')
  const refuse = (status: number, title: string, message: string): void => {
    sendHtml(res, status, messagePage(title, message, { href: '/auth/login', label: 'Sign in again' }), {
      ...ctx.pageHeaders,
      'set-cookie': clearState,
    })
  }

  const state = url.searchParams.get('state') ?? ''
  if (!state || !cookieValues(req.headers.cookie, OAUTH_COOKIE).some((value) => safeEqual(value, state))) {
    log.warn('auth.state.mismatch', {})
    refuse(400, 'Sign-in could not be verified', 'This sign-in did not start in this browser. Start again.')
    return
  }
  const pending = store.consumeOAuthState(state)
  if (!pending) {
    log.warn('auth.state.expired', {})
    refuse(400, 'Sign-in could not be verified', 'This sign-in took too long or was already used. Start again.')
    return
  }
  const githubError = url.searchParams.get('error')
  if (githubError) {
    log.info('auth.cancelled', { error: githubError })
    refuse(403, 'Sign-in was cancelled', 'GitHub did not complete the sign-in.')
    return
  }
  const code = url.searchParams.get('code')
  if (!code) {
    refuse(400, 'Sign-in could not be verified', 'GitHub returned no sign-in code.')
    return
  }

  let identity: GitHubIdentity
  let access: Access
  try {
    // The token exists only inside this block: it reads the login and memberships and is never stored.
    const token = await github.exchangeCode(code, `${ctx.apexOrigin}/auth/callback`)
    identity = await github.user(token)
    access = await decideAccess(ctx, identity.login, (org) => github.orgMembership(token, org))
  } catch (error) {
    log.error('auth.github.failed', { error: errorMessage(error) })
    refuse(502, 'GitHub sign-in failed', errorMessage(error))
    return
  }
  if (!access.allowed) {
    log.warn('auth.refused', { login: identity.login, reason: access.reason })
    refuse(403, 'Not allowed', access.message)
    return
  }

  const handle = identity.login.toLowerCase()
  const existing = store.getUser(handle)
  if (existing && existing.githubId !== identity.id) {
    // GitHub logins can be renamed and then claimed by someone else; the workspace stays with the original account.
    log.error('auth.refused', {
      login: identity.login,
      reason: 'the handle is bound to another GitHub account',
      githubId: identity.id,
      boundGithubId: existing.githubId,
    })
    refuse(403, 'Not allowed', `The handle ${handle} already belongs to a different GitHub account. Ask an admin.`)
    return
  }

  const user = store.saveSignIn({ handle, login: identity.login, githubId: identity.id, accessOrg: access.org })
  const { id, session } = store.createApexSession(handle, APEX_SESSION_TTL_MS)
  log.info('auth.signed_in', { login: identity.login, via: access.via })
  const returnTo = pending.returnTo === null ? null : parseReturnTo(ctx, pending.returnTo)
  continueTo(ctx, res, { session, user, isAdmin: ctx.isAdmin(handle) }, returnTo, {
    'set-cookie': [clearState, ctx.cookie(APEX_COOKIE, id, APEX_SESSION_TTL_MS / 1000)],
  })
}

export function logoutPage(ctx: Context, req: IncomingMessage, res: ServerResponse): void {
  const principal = ctx.apexPrincipal(req)
  if (!principal) {
    redirect(res, '/')
    return
  }
  sendHtml(res, 200, signOutPage('/auth/logout', principal.session.csrf), ctx.pageHeaders)
}

export async function logout(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req)
  const principal = ctx.apexPrincipal(req)
  const clear = ctx.cookie(APEX_COOKIE, '', 0)
  if (!principal) {
    redirect(res, '/', 303, { 'set-cookie': clear })
    return
  }
  ctx.verifyForm(req, form, principal.session, ctx.apexOrigin)
  ctx.deps.store.deleteSession(principal.session.idHash)
  ctx.deps.log.info('auth.signed_out', { login: principal.user.login })
  redirect(res, '/', 303, { 'set-cookie': clear })
}
