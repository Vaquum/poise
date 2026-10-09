import type { IncomingMessage, ServerResponse } from 'node:http'
import { pagePrincipal, postPrincipal } from './auth.js'
import { isGitHubName, RESERVED_HANDLES } from './config.js'
import type { Context, Principal } from './context.js'
import { HttpError, readForm, redirect, sendHtml } from './http.js'
import { errorMessage } from './log.js'
import { adminPage, type AdminWorkspaceView } from './pages.js'
import type { AllowedLogin, User, WorkspaceRecord } from './store.js'

export type WorkspaceAction = 'start' | 'stop' | 'restart'

/** Everything the admin page and Settings → Admin show. */
export interface AdminOverview {
  users: User[]
  allowed: AllowedLogin[]
  admins: string[]
  allowedOrgs: string[]
  /** Per handle; null when the Docker Engine could not be asked. */
  workspaces: Map<string, AdminWorkspaceView> | null
  records: Map<string, WorkspaceRecord>
  access: Map<string, string>
  dockerError: string | null
}

/** How a person gets in today, as the admin page shows it. */
function accessOf(ctx: Context, user: User): string {
  const { config, store } = ctx.deps
  if (user.disabledAt !== null) return `disabled by ${user.disabledBy ?? 'an admin'}`
  if (ctx.isAdmin(user.handle)) return 'admin'
  if (store.isOnAllowList(user.handle)) return 'allow list'
  if (user.accessOrg !== null && config.allowedOrgs.includes(user.accessOrg)) return `member of ${user.accessOrg}`
  return 'no access'
}

export function requireAdmin(principal: Principal): void {
  if (!principal.isAdmin) throw new HttpError(403, 'Only admins can open the admin pages.')
}

export async function adminOverview(ctx: Context): Promise<AdminOverview> {
  const { config, docker, log, store } = ctx.deps
  let workspaces: Map<string, AdminWorkspaceView> | null = null
  let dockerError: string | null = null
  try {
    const [imageId, containers] = await Promise.all([docker.imageId(config.runtimeImage), docker.listManagedContainers()])
    workspaces = new Map()
    for (const container of containers) {
      const handle = container.Labels['poise.workspace']
      if (!handle) continue
      const age = imageId === null ? '' : container.ImageID === imageId ? ' (current)' : ' (outdated)'
      workspaces.set(handle, { state: container.State, image: `${container.ImageID.replace(/^sha256:/, '').slice(0, 12)}${age}` })
    }
    if (imageId === null) dockerError = `the runtime image ${config.runtimeImage} is not on this Docker host`
  } catch (error) {
    dockerError = errorMessage(error)
    log.error('admin.docker.failed', { error: dockerError })
  }
  const users = store.listUsers()
  const records = new Map<string, WorkspaceRecord>()
  const access = new Map<string, string>()
  for (const user of users) {
    const record = store.getWorkspace(user.handle)
    if (record) records.set(user.handle, record)
    access.set(user.handle, accessOf(ctx, user))
  }
  return { users, allowed: store.listAllowed(), admins: config.admins, allowedOrgs: config.allowedOrgs, workspaces, records, access, dockerError }
}

export async function overview(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const principal = pagePrincipal(ctx, req, res, url)
  if (!principal) return
  requireAdmin(principal)
  sendHtml(res, 200, adminPage({ csrf: principal.session.csrf, ...await adminOverview(ctx) }), ctx.pageHeaders)
}

export function allowLogin(ctx: Context, principal: Principal, input: string): void {
  const login = input.trim()
  if (!isGitHubName(login)) throw new HttpError(400, `"${login}" is not a valid GitHub login.`)
  const handle = login.toLowerCase()
  if (RESERVED_HANDLES.has(handle)) throw new HttpError(400, `${handle} is a reserved handle and can never sign in.`)
  if (ctx.deps.store.addAllowed(handle, principal.user.login)) {
    ctx.deps.log.info('admin.allow.added', { login: handle, by: principal.user.login })
  }
}

export function disallowLogin(ctx: Context, principal: Principal, input: string): void {
  const handle = input.trim().toLowerCase()
  const outcome = ctx.deps.store.removeAllowed(handle)
  if (outcome === 'missing') throw new HttpError(404, `${handle} is not on the allow list.`)
  if (outcome === 'env') {
    throw new HttpError(409, `${handle} comes from POISE_ALLOWED_USERS. Remove it there and restart the gateway.`)
  }
  ctx.deps.log.info('admin.allow.removed', { login: handle, by: principal.user.login })
}

export async function actOnWorkspace(ctx: Context, principal: Principal, action: WorkspaceAction, handle: string): Promise<void> {
  const { log, orchestrator, store } = ctx.deps
  const user = store.getUser(handle)
  if (!user) throw new HttpError(404, `Nobody with the handle "${handle}" has signed in.`)
  if (user.disabledAt !== null && action !== 'stop') {
    throw new HttpError(409, `${user.login} is disabled. Enable them before starting their workspace.`)
  }
  log.info('admin.workspace.action', { action, handle, by: principal.user.login })
  try {
    if (action === 'start') await orchestrator.ensureStarted(handle, user.login)
    else if (action === 'stop') await orchestrator.stop(handle)
    else await orchestrator.restart(handle, user.login)
  } catch (error) {
    log.error('admin.workspace.action.failed', { action, handle, error: errorMessage(error) })
    throw new HttpError(502, `Could not ${action} the workspace of ${user.login}: ${errorMessage(error)}`)
  }
}

/**
 * Disabling cuts a person off at once, whichever way they got in: sessions end, paired devices are
 * revoked, sign-in is refused and their workspace stops. Enabling lets them sign in and pair again.
 */
export async function setUserDisabled(ctx: Context, principal: Principal, disable: boolean, handle: string): Promise<void> {
  const { log, orchestrator, store } = ctx.deps
  const user = store.getUser(handle)
  if (!user) throw new HttpError(404, `Nobody with the handle "${handle}" has signed in.`)
  if (!disable) {
    if (store.enableUser(handle)) log.info('admin.user.enabled', { login: user.login, by: principal.user.login })
    return
  }
  if (handle === principal.user.handle) throw new HttpError(409, 'You cannot disable yourself.')
  if (store.disableUser(handle, principal.user.login)) {
    log.info('admin.user.disabled', { login: user.login, by: principal.user.login })
  }
  try {
    await orchestrator.stopForDisabled(handle)
  } catch (error) {
    log.error('admin.user.disable.stop.failed', { handle, error: errorMessage(error) })
    throw new HttpError(502, `${user.login} is disabled, but their workspace could not be stopped: ${errorMessage(error)}`)
  }
}

async function adminForm(ctx: Context, req: IncomingMessage): Promise<{ principal: Principal; form: URLSearchParams }> {
  const principal = postPrincipal(ctx, req)
  if (!principal.isAdmin) throw new HttpError(403, 'Only admins can change this.')
  const form = await readForm(req)
  ctx.verifyForm(req, form, principal.session, ctx.apexOrigin)
  return { principal, form }
}

export async function allow(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { principal, form } = await adminForm(ctx, req)
  allowLogin(ctx, principal, form.get('login') ?? '')
  redirect(res, '/admin', 303)
}

export async function disallow(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { principal, form } = await adminForm(ctx, req)
  disallowLogin(ctx, principal, form.get('login') ?? '')
  redirect(res, '/admin', 303)
}

export function workspaceAction(action: WorkspaceAction) {
  return async (ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { principal, form } = await adminForm(ctx, req)
    await actOnWorkspace(ctx, principal, action, form.get('handle') ?? '')
    redirect(res, '/admin', 303)
  }
}

export function setDisabled(disable: boolean) {
  return async (ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { principal, form } = await adminForm(ctx, req)
    await setUserDisabled(ctx, principal, disable, form.get('handle') ?? '')
    redirect(res, '/admin', 303)
  }
}
