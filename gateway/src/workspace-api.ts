import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  actOnWorkspace, adminOverview, allowLogin, disallowLogin, requireAdmin, setUserDisabled, type AdminOverview,
} from './admin.js'
import type { Context, Principal } from './context.js'
import { header, HttpError, readBody, sendJson } from './http.js'
import { decideCode, listDevices, revokeDevice } from './link.js'
import { LINK_INSTALLER_URL, LINK_RELEASES_URL } from './pages.js'
import type { User } from './store.js'

/**
 * The gateway's JSON API on every workspace host, for the owner's own browser: Poise's Settings pairs
 * Poise Link and lists devices here and, for admins, manages who may sign in and every workspace. Poise
 * never sees these requests; the gateway answers them itself.
 */
export const WORKSPACE_API_PREFIX = '/_poise/api/'

const BODY_LIMIT_BYTES = 16 * 1024

interface Reply {
  status?: number
  body: unknown
  headers?: Record<string, string>
}

interface Route {
  method: 'GET' | 'POST'
  admin?: boolean
  run(ctx: Context, principal: Principal, body: Record<string, unknown>): Reply | Promise<Reply>
}

/** Only the owner's browser session: device tokens belong to /api/link/*, and nobody else's session reaches this. */
function browserPrincipal(ctx: Context, req: IncomingMessage, owner: User): Principal {
  if (/^bearer(\s|$)/i.test(header(req, 'authorization'))) {
    throw new HttpError(401, 'Device tokens are accepted only for /api/link/*.')
  }
  const sessions = ctx.workspaceSessions(req)
  const session = sessions.find((candidate) => candidate.host === owner.handle && candidate.handle === owner.handle)
  if (!session) {
    if (sessions.length > 0) throw new HttpError(403, 'This workspace belongs to someone else.')
    throw new HttpError(401, 'Sign in to use this workspace.')
  }
  if (!ctx.isAllowed(owner)) throw new HttpError(403, 'Your access to this Poise has been removed. Ask an admin.')
  return { session, user: owner, isAdmin: ctx.isAdmin(owner.handle) }
}

/**
 * Only the workspace's own pages may call this. A change must come from its exact origin, which a page on
 * any other host, a sibling workspace host included, cannot claim; cookies are SameSite=Lax, so a sibling
 * host's request would otherwise carry the session.
 */
function requireOwnPage(ctx: Context, req: IncomingMessage, owner: User, change: boolean): void {
  const site = header(req, 'sec-fetch-site').toLowerCase()
  if (site && site !== 'same-origin') throw new HttpError(403, 'Only this workspace\'s own pages may use this API.')
  if (change && header(req, 'origin') !== ctx.workspaceOrigin(owner.handle)) {
    throw new HttpError(403, 'This request was not sent from this workspace.')
  }
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (header(req, 'content-type').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Send this request as application/json.')
  }
  let value: unknown
  try {
    value = JSON.parse((await readBody(req, BODY_LIMIT_BYTES)).toString('utf8'))
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'The request body is not valid JSON.')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Send a JSON object.')
  return value as Record<string, unknown>
}

function text(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string.`)
  return value
}

function adminJson(view: AdminOverview) {
  return {
    users: view.users.map((user) => {
      const workspace = view.workspaces?.get(user.handle)
      return {
        handle: user.handle,
        login: user.login,
        admin: view.admins.includes(user.handle),
        access: view.access.get(user.handle) ?? '',
        lastLoginAt: user.lastLoginAt,
        disabled: user.disabledAt !== null,
        // null while the Docker Engine cannot be asked; dockerError says why.
        workspace: view.workspaces === null ? null : workspace ?? { state: 'not created', image: null },
        lastError: view.records.get(user.handle)?.lastError ?? null,
        // Bytes in their home volume, and whether that is over POISE_WORKSPACE_DISK_BUDGET; null until measured.
        disk: diskOf(view, user.handle),
      }
    }),
    allowed: view.allowed.map(({ handle, source, addedBy, addedAt }) => ({ handle, source, addedBy, addedAt })),
    admins: view.admins,
    allowedOrgs: view.allowedOrgs,
    dockerError: view.dockerError,
    disk: view.disk === null ? null : {
      measuredAt: view.disk.measuredAt,
      free: view.disk.free,
      total: view.disk.total,
      low: view.disk.low,
      budget: view.diskBudget,
    },
  }
}

function diskOf(view: AdminOverview, handle: string): { bytes: number; overBudget: boolean } | null {
  const bytes = view.disk?.workspaces.get(handle)
  return bytes === undefined ? null : { bytes, overBudget: view.diskBudget > 0 && bytes > view.diskBudget }
}

function adminChange(change: (ctx: Context, principal: Principal, body: Record<string, unknown>) => void | Promise<void>): Route {
  return {
    method: 'POST',
    admin: true,
    run: async (ctx, principal, body) => {
      await change(ctx, principal, body)
      return { body: adminJson(await adminOverview(ctx)) }
    },
  }
}

const ROUTES: Record<string, Route> = {
  account: {
    method: 'GET',
    run: (ctx, principal) => ({
      body: {
        login: principal.user.login,
        handle: principal.user.handle,
        isAdmin: principal.isAdmin,
        workspaceHost: new URL(ctx.workspaceOrigin(principal.user.handle)).host,
        apexOrigin: ctx.apexOrigin,
        link: { installer: LINK_INSTALLER_URL, releases: LINK_RELEASES_URL },
      },
    }),
  },
  devices: {
    method: 'GET',
    run: (ctx, principal) => ({ body: { devices: listDevices(ctx, principal.user.handle) } }),
  },
  'devices/pair': {
    method: 'POST',
    run: (ctx, principal, body): Reply => {
      const outcome = decideCode(ctx, principal, text(body, 'userCode'), text(body, 'decision'))
      if (outcome.ok) return { body: { decision: outcome.decision, message: outcome.message } }
      if (outcome.status === 429) {
        return {
          status: 429,
          body: { error: 'too_many_requests', message: outcome.message },
          headers: { 'retry-after': String(outcome.retryAfterSeconds) },
        }
      }
      return { status: 400, body: { error: 'invalid_code', message: outcome.message } }
    },
  },
  'devices/revoke': {
    method: 'POST',
    run: (ctx, principal, body) => {
      revokeDevice(ctx, principal, text(body, 'id'))
      return { body: { devices: listDevices(ctx, principal.user.handle) } }
    },
  },
  admin: {
    method: 'GET',
    admin: true,
    run: async (ctx) => ({ body: adminJson(await adminOverview(ctx)) }),
  },
  'admin/allow': adminChange((ctx, principal, body) => allowLogin(ctx, principal, text(body, 'login'))),
  'admin/allow/remove': adminChange((ctx, principal, body) => disallowLogin(ctx, principal, text(body, 'login'))),
  'admin/workspaces/start': adminChange((ctx, principal, body) => actOnWorkspace(ctx, principal, 'start', text(body, 'handle'))),
  'admin/workspaces/stop': adminChange((ctx, principal, body) => actOnWorkspace(ctx, principal, 'stop', text(body, 'handle'))),
  'admin/workspaces/restart': adminChange((ctx, principal, body) => actOnWorkspace(ctx, principal, 'restart', text(body, 'handle'))),
  'admin/users/disable': adminChange((ctx, principal, body) => setUserDisabled(ctx, principal, true, text(body, 'handle'))),
  'admin/users/enable': adminChange((ctx, principal, body) => setUserDisabled(ctx, principal, false, text(body, 'handle'))),
}

export async function workspaceApi(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL, owner: User): Promise<void> {
  const route = Object.hasOwn(ROUTES, url.pathname.slice(WORKSPACE_API_PREFIX.length))
    ? ROUTES[url.pathname.slice(WORKSPACE_API_PREFIX.length)]
    : undefined
  if (!route) throw new HttpError(404, 'There is nothing at this address.')
  const principal = browserPrincipal(ctx, req, owner)
  if (req.method !== route.method) {
    res.setHeader('allow', route.method)
    throw new HttpError(405, 'That method is not allowed here.')
  }
  const change = route.method === 'POST'
  requireOwnPage(ctx, req, owner, change)
  if (route.admin) requireAdmin(principal)
  const reply = await route.run(ctx, principal, change ? await readJsonObject(req) : {})
  sendJson(res, reply.status ?? 200, reply.body, reply.headers)
}
