import type { IncomingMessage, ServerResponse } from 'node:http'
import { pagePrincipal, postPrincipal } from './auth.js'
import { isGitHubName, RESERVED_HANDLES } from './config.js'
import type { Context, Principal } from './context.js'
import { HttpError, readForm, redirect, sendHtml } from './http.js'
import { errorMessage } from './log.js'
import { adminPage, type AdminWorkspaceView } from './pages.js'
import type { WorkspaceRecord } from './store.js'

export type WorkspaceAction = 'start' | 'stop' | 'restart'

export async function overview(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const principal = pagePrincipal(ctx, req, res, url)
  if (!principal) return
  if (!principal.isAdmin) throw new HttpError(403, 'Only admins can open the admin pages.')
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
  for (const user of users) {
    const record = store.getWorkspace(user.handle)
    if (record) records.set(user.handle, record)
  }
  sendHtml(res, 200, adminPage({
    csrf: principal.session.csrf,
    users,
    allowed: store.listAllowed(),
    admins: config.admins,
    allowedOrgs: config.allowedOrgs,
    workspaces,
    records,
    dockerError,
  }), ctx.pageHeaders)
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
  const login = (form.get('login') ?? '').trim()
  if (!isGitHubName(login)) throw new HttpError(400, `"${login}" is not a valid GitHub login.`)
  const handle = login.toLowerCase()
  if (RESERVED_HANDLES.has(handle)) throw new HttpError(400, `${handle} is a reserved handle and can never sign in.`)
  if (ctx.deps.store.addAllowed(handle, principal.user.login)) {
    ctx.deps.log.info('admin.allow.added', { login: handle, by: principal.user.login })
  }
  redirect(res, '/admin', 303)
}

export async function disallow(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { principal, form } = await adminForm(ctx, req)
  const handle = (form.get('login') ?? '').trim().toLowerCase()
  const outcome = ctx.deps.store.removeAllowed(handle)
  if (outcome === 'missing') throw new HttpError(404, `${handle} is not on the allow list.`)
  if (outcome === 'env') {
    throw new HttpError(409, `${handle} comes from POISE_ALLOWED_USERS. Remove it there and restart the gateway.`)
  }
  ctx.deps.log.info('admin.allow.removed', { login: handle, by: principal.user.login })
  redirect(res, '/admin', 303)
}

export function workspaceAction(action: WorkspaceAction) {
  return async (ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { principal, form } = await adminForm(ctx, req)
    const { log, orchestrator, store } = ctx.deps
    const handle = form.get('handle') ?? ''
    const user = store.getUser(handle)
    if (!user) throw new HttpError(404, `Nobody with the handle "${handle}" has signed in.`)
    log.info('admin.workspace.action', { action, handle, by: principal.user.login })
    try {
      if (action === 'start') await orchestrator.ensureStarted(handle, user.login)
      else if (action === 'stop') await orchestrator.stop(handle)
      else await orchestrator.restart(handle, user.login)
    } catch (error) {
      log.error('admin.workspace.action.failed', { action, handle, error: errorMessage(error) })
      throw new HttpError(502, `Could not ${action} the workspace of ${user.login}: ${errorMessage(error)}`)
    }
    redirect(res, '/admin', 303)
  }
}
