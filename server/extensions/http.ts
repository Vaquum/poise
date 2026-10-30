// /api/extensions: the Extensions view's API. Responses never carry a secret
// value: a secret field says only whether it is set.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, readJson } from '../http'
import { checkServer } from './probe'
import { finishSignIn, signOut, startSignIn } from './oauth'
import { directoryEntryByName, directoryStatus, installSpec, searchDirectory, syncDirectory, uniqueName } from './registry'
import { ExtensionError, addEvent, createServer, deleteServer, listEvents, listServers, serverView, setDefault, setWorkspace, storedServer, storedServers, updateServer } from './store'
import { LOCAL_WORKSPACE, isWorkspace, parseImport, validateSpec, workspaceLabel, type Enablement, type ServerSpec, type Workspace } from './types'

export interface ExtensionsApiOptions {
  /** Workspaces chats have used, most recent first. */
  recentWorkspaces: () => string[]
  /** Starts a server's check in the background; tests replace it so nothing is launched. */
  check?: (id: string) => void
}

const SERVER = /^\/api\/extensions\/servers\/([0-9a-f-]{36})(\/enabled|\/check|\/events|\/sign-in|\/sign-out)?$/
// Columns of the grid: the most recently used workspaces, plus every one with a switch of its own.
const RECENT_WORKSPACES = 12

function workspaces(recent: string[]): Workspace[] {
  const ids = [...new Set(recent.filter(isWorkspace))].slice(0, RECENT_WORKSPACES)
  ids.push(LOCAL_WORKSPACE)
  for (const server of storedServers()) ids.push(...Object.keys(server.enabled.workspaces))
  return [...new Set(ids.filter(isWorkspace))].map((id) => ({ id, label: workspaceLabel(id) }))
}

function enablement(value: unknown): Enablement {
  if (value === undefined) return { default: false, workspaces: {} }
  if (!value || typeof value !== 'object') throw new ExtensionError(400, 'Say where the server is switched on.')
  const raw = value as { default?: unknown, workspaces?: unknown }
  const map = (raw.workspaces ?? {}) as Record<string, unknown>
  if (typeof map !== 'object' || Array.isArray(map)) throw new ExtensionError(400, 'Workspaces must map a workspace to on or off.')
  const workspaces: Record<string, boolean> = {}
  for (const [workspace, on] of Object.entries(map)) {
    if (!isWorkspace(workspace) || typeof on !== 'boolean') throw new ExtensionError(400, `${workspace} is not a workspace switch.`)
    workspaces[workspace] = on
  }
  return { default: raw.default === true, workspaces }
}

function secrets(value: unknown): Record<string, string | null> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExtensionError(400, 'Secrets must map a field to its value.')
  const out: Record<string, string | null> = {}
  for (const [slot, secret] of Object.entries(value as Record<string, unknown>)) {
    if (!/^(env|header):/.test(slot)) throw new ExtensionError(400, `${slot} is not a secret field.`)
    if (secret !== null && typeof secret !== 'string') throw new ExtensionError(400, `The value of ${slot.slice(slot.indexOf(':') + 1)} must be text.`)
    out[slot] = secret
  }
  return out
}

function spec(value: unknown): ServerSpec {
  try { return validateSpec(value) } catch (error) { throw new ExtensionError(400, (error as Error).message) }
}

function taken(name: string): boolean {
  return storedServers().some((server) => server.spec.name === name)
}

/** An edit keeps what the person cannot change: a directory server's
 *  command or endpoint comes from the registry. */
function edited(id: string, input: ServerSpec): ServerSpec {
  const current = storedServer(id).spec
  if (current.source === 'custom') return { ...input, source: 'custom' }
  const values = (fields: ServerSpec['env'], next: ServerSpec['env']) => (fields ?? []).map((field) => field.secret ? field : { ...field, value: next?.find((candidate) => candidate.name === field.name)?.value ?? field.value })
  return { ...current, name: input.name, title: input.title, ...(current.env ? { env: values(current.env, input.env) } : {}), ...(current.headers ? { headers: values(current.headers, input.headers) } : {}) }
}

function checkInBackground(id: string): void {
  void checkServer(id).catch((error) => addEvent(id, 'error', `Check failed: ${(error as Error).message}`))
}

export function createExtensionsApi(options: ExtensionsApiOptions) {
  const check = options.check ?? checkInBackground
  return async function handleExtensionsApi(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    const path = url.split('?')[0]
    if (path !== '/api/extensions' && !path.startsWith('/api/extensions/')) return false
    const send = (status: number, value: unknown): true => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(value))
      return true
    }
    const method = req.method || 'GET'
    const query = new URLSearchParams(url.split('?')[1] ?? '')
    const server = SERVER.exec(path)
    try {
      if (path === '/api/extensions' && method === 'GET') {
        return send(200, { servers: listServers(), workspaces: workspaces(options.recentWorkspaces()), directory: directoryStatus() })
      }
      if (path === '/api/extensions/servers' && method === 'POST') {
        const body = await readJson<{ spec?: unknown, secrets?: unknown, enabled?: unknown, install?: { entry?: unknown, option?: unknown, values?: unknown } }>(req)
        const enabled = enablement(body.enabled)
        let created
        if (body.install) {
          const { entry, option, values } = body.install
          if (typeof entry !== 'string' || typeof option !== 'string') throw new ExtensionError(400, 'Name the directory entry and the way to run it.')
          const found = directoryEntryByName(entry)
          const plan = installSpec(found, option, (values && typeof values === 'object' ? values : {}) as Record<string, string>, uniqueName(found.title, taken))
          created = createServer(spec(plan.spec), plan.secrets, enabled)
        } else {
          const given = spec(body.spec)
          if (given.source !== 'custom') throw new ExtensionError(400, 'Add directory servers from the directory.')
          const values = secrets(body.secrets)
          created = createServer(given, Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), enabled)
        }
        addEvent(created.id, 'info', `Added ${created.source === 'directory' ? `from the directory (${created.registry?.name} ${created.registry?.version})` : 'as a custom server'}`)
        check(created.id)
        return send(201, serverView(created.id))
      }
      if (path === '/api/extensions/import' && method === 'POST') {
        const body = await readJson<{ json?: unknown, enabled?: unknown }>(req)
        if (typeof body.json !== 'string') throw new ExtensionError(400, 'Paste the configuration.')
        const enabled = enablement(body.enabled)
        let parsed
        try { parsed = parseImport(body.json) } catch (error) { throw new ExtensionError(400, (error as Error).message) }
        const created = parsed.map(({ spec: definition, secrets: values }) => {
          const view = createServer({ ...definition, name: uniqueName(definition.name, taken) }, values, enabled)
          addEvent(view.id, 'info', 'Imported from a pasted configuration')
          check(view.id)
          return view
        })
        return send(201, { servers: created.map((view) => serverView(view.id)) })
      }
      if (server) {
        const [, id, action] = server
        if (!action && method === 'PUT') {
          const body = await readJson<{ spec?: unknown, secrets?: unknown }>(req)
          const view = updateServer(id, edited(id, spec(body.spec)), secrets(body.secrets))
          addEvent(id, 'info', 'Edited')
          check(id)
          return send(200, view)
        }
        if (!action && method === 'DELETE') { deleteServer(id); return send(200, { ok: true }) }
        if (action === '/enabled' && method === 'PUT') {
          const body = await readJson<{ workspace?: unknown, on?: unknown, default?: unknown }>(req)
          if (typeof body.default === 'boolean') {
            const view = setDefault(id, body.default, workspaces(options.recentWorkspaces()).map((workspace) => workspace.id))
            addEvent(id, 'info', `New workspaces ${body.default ? 'start with' : 'start without'} it`)
            return send(200, view)
          }
          if (!isWorkspace(body.workspace) || typeof body.on !== 'boolean') throw new ExtensionError(400, 'Name a workspace and whether the server is on there.')
          const view = setWorkspace(id, body.workspace, body.on)
          addEvent(id, 'info', `Switched ${body.on ? 'on' : 'off'} in ${workspaceLabel(body.workspace)}`)
          return send(200, view)
        }
        if (action === '/check' && method === 'POST') { check(id); return send(202, serverView(id)) }
        if (action === '/events' && method === 'GET') return send(200, { events: listEvents(id) })
        if (action === '/sign-in' && method === 'POST') return send(200, await startSignIn(id, (await readJson<{ origin?: unknown }>(req)).origin))
        if (action === '/sign-out' && method === 'POST') { signOut(id); check(id); return send(200, serverView(id)) }
      }
      if (path === '/api/extensions/oauth' && method === 'POST') {
        const { id } = await finishSignIn(await readJson(req))
        check(id)
        return send(200, serverView(id))
      }
      if (path === '/api/extensions/directory' && method === 'GET') {
        void syncDirectory().catch(() => undefined) // its error is part of the status
        const kind = query.get('kind')
        const limit = Math.min(Math.max(Number(query.get('limit')) || 48, 1), 200)
        const offset = Math.max(Number(query.get('offset')) || 0, 0)
        const found = searchDirectory(query.get('q') ?? '', kind === 'remote' || kind === 'local' ? kind : 'any', limit, offset)
        return send(200, { ...found, status: directoryStatus() })
      }
      if (path === '/api/extensions/directory/sync' && method === 'POST') {
        void syncDirectory({ force: true }).catch(() => undefined) // its error is part of the status
        return send(202, directoryStatus())
      }
      return send(405, { error: `${method} is not used here.` })
    } catch (error) {
      if (error instanceof ExtensionError) return send(error.status, { error: error.message })
      if (error instanceof HttpError) return send(error.statusCode, { error: error.message })
      return send(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
