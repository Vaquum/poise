import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APEX, CURRENT_IMAGE_ID, events, OLD_IMAGE_ID, startHarness, workspaceHost, type Harness, type Reply } from './harness.js'

const ROOT = workspaceHost('root')
const ALICE = workspaceHost('alice')

/** A call to the gateway's API on a workspace host, as Settings makes it from that host's own page. */
function api(h: Harness, host: string, cookie: string, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Reply> {
  return h.request({
    host,
    method: body === undefined ? 'GET' : 'POST',
    path: `/_poise/api/${path}`,
    headers: {
      cookie,
      'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { origin: `https://${host}`, 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

interface AdminUser {
  handle: string
  login: string
  admin: boolean
  access: string
  disabled: boolean
  workspace: { state: string; image: string | null } | null
  lastError: string | null
}

interface AdminAnswer {
  users: AdminUser[]
  allowed: Array<{ handle: string; source: string; addedBy: string | null }>
  admins: string[]
  allowedOrgs: string[]
  dockerError: string | null
}

describe('the gateway API on a workspace host', () => {
  let h: Harness
  let root: string
  beforeEach(async () => {
    h = await startHarness()
    root = (await h.openWorkspace('root')).workspaceCookie
  })
  afterEach(async () => {
    await h.close()
  })

  it('tells Settings who is signed in and whether they are an admin', async () => {
    const alice = await h.openWorkspace('Alice')
    expect((await api(h, ROOT, root, 'account')).json()).toMatchObject({ login: 'root', isAdmin: true, workspaceHost: ROOT })
    expect((await api(h, ALICE, alice.workspaceCookie, 'account')).json()).toMatchObject({ login: 'Alice', isAdmin: false, workspaceHost: ALICE })
    expect(h.workspace.requests).toHaveLength(0)
  })

  it('refuses device tokens, other people, unknown paths, wrong methods and pages from elsewhere', async () => {
    const alice = await h.openWorkspace('Alice')
    expect((await api(h, ROOT, root, 'account', undefined, { authorization: 'Bearer anything' })).status).toBe(401)
    expect((await api(h, ROOT, alice.workspaceCookie, 'account')).status).toBe(403)
    expect((await api(h, ROOT, '', 'account')).status).toBe(401)
    expect((await api(h, ROOT, root, 'account', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await api(h, ROOT, root, 'nothing-here')).status).toBe(404)
    expect((await api(h, ROOT, root, '__proto__')).status).toBe(404)
    const wrongMethod = await api(h, ROOT, root, 'account', {})
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.allow).toBe('GET')
    expect(wrongMethod.json()).toMatchObject({ error: 'method_not_allowed' })
    const malformed = await h.request({
      host: ROOT, method: 'POST', path: '/_poise/api/admin/allow',
      headers: { cookie: root, origin: `https://${ROOT}`, 'content-type': 'application/json' },
      body: '{"login":',
    })
    expect(malformed.status).toBe(400)
    expect((await api(h, ROOT, root, 'admin/allow', { login: 42 })).status).toBe(400)
    // A WebSocket upgrade under /_poise/ is never proxied either.
    expect(h.workspace.requests).toHaveLength(0)
  })

  it('cuts off a person removed from the allow list at once', async () => {
    h.store.addAllowed('mallory', 'root')
    const mallory = await h.openWorkspace('mallory')
    expect((await api(h, workspaceHost('mallory'), mallory.workspaceCookie, 'devices')).status).toBe(200)
    h.store.removeAllowed('mallory')
    expect((await api(h, workspaceHost('mallory'), mallory.workspaceCookie, 'devices')).status).toBe(403)
  })

  describe('admin', () => {
    it('is for admins only, from their own workspace page', async () => {
      const alice = await h.openWorkspace('Alice')
      expect((await api(h, ALICE, alice.workspaceCookie, 'admin')).status).toBe(403)
      expect((await api(h, ALICE, alice.workspaceCookie, 'admin/allow', { login: 'mallory' })).status).toBe(403)
      expect((await api(h, ROOT, root, 'admin/allow', { login: 'mallory' }, { origin: `https://${ALICE}` })).status).toBe(403)
      expect((await api(h, ROOT, root, 'admin/allow', { login: 'mallory' }, { origin: `https://${APEX}` })).status).toBe(403)
      expect(h.store.isOnAllowList('mallory')).toBe(false)
    })

    it('lists people with their access, workspace state and image', async () => {
      await h.openWorkspace('Alice')
      await h.openWorkspace('bob')
      h.docker.addContainer({
        name: 'poise-ws-alice', imageId: CURRENT_IMAGE_ID, imageRef: 'poise-runtime:latest', running: true,
        labels: { 'poise.managed': 'true', 'poise.workspace': 'alice' }, networks: new Set(['poise-net-alice']), spec: {},
      })
      h.docker.addContainer({
        name: 'poise-ws-bob', imageId: OLD_IMAGE_ID, imageRef: 'poise-runtime:latest', running: false,
        labels: { 'poise.managed': 'true', 'poise.workspace': 'bob' }, networks: new Set(['poise-net-bob']), spec: {},
      })
      const reply = await api(h, ROOT, root, 'admin')
      expect(reply.status).toBe(200)
      const answer = reply.json<AdminAnswer>()
      expect(answer.users.find((user) => user.handle === 'alice')).toMatchObject({
        login: 'Alice', admin: false, access: 'allow list', disabled: false, workspace: { state: 'running', image: '111111111111 (current)' },
      })
      expect(answer.users.find((user) => user.handle === 'bob')).toMatchObject({ workspace: { state: 'exited', image: '000000000000 (outdated)' } })
      expect(answer.users.find((user) => user.handle === 'root')).toMatchObject({ admin: true, access: 'admin', workspace: { state: 'not created', image: null } })
      expect(answer).toMatchObject({ admins: ['root'], allowedOrgs: [], dockerError: null })
      expect(answer.allowed.map((entry) => `${entry.handle}:${entry.source}`)).toEqual(['alice:env', 'bob:env'])
    })

    it('says why the workspace column is unknown when the Docker Engine cannot be asked', async () => {
      await h.docker.close()
      const answer = (await api(h, ROOT, root, 'admin')).json<AdminAnswer>()
      expect(answer.dockerError).toContain('Docker Engine GET /images/poise-runtime:latest/json')
      expect(answer.users.every((user) => user.workspace === null)).toBe(true)
    })

    it('adds and removes allowed logins, and answers with the updated list', async () => {
      const added = await api(h, ROOT, root, 'admin/allow', { login: ' Mallory ' })
      expect(added.status).toBe(200)
      expect(added.json<AdminAnswer>().allowed).toContainEqual(expect.objectContaining({ handle: 'mallory', source: 'admin', addedBy: 'root' }))
      expect((await api(h, ROOT, root, 'admin/allow', { login: 'not a login' })).status).toBe(400)
      expect((await api(h, ROOT, root, 'admin/allow', { login: 'www' })).status).toBe(400)
      const fromEnv = await api(h, ROOT, root, 'admin/allow/remove', { login: 'alice' })
      expect(fromEnv.status).toBe(409)
      expect(fromEnv.json()).toMatchObject({ message: expect.stringContaining('POISE_ALLOWED_USERS') })
      const removed = await api(h, ROOT, root, 'admin/allow/remove', { login: 'mallory' })
      expect(removed.status).toBe(200)
      expect(removed.json<AdminAnswer>().allowed.map((entry) => entry.handle)).not.toContain('mallory')
      expect(events(h.logs, 'admin.allow')).toEqual(['admin.allow.added', 'admin.allow.removed'])
    })

    it('starts, stops and restarts a workspace, and reports a failure with the Docker Engine\'s reason', async () => {
      await h.openWorkspace('alice')
      expect((await api(h, ROOT, root, 'admin/workspaces/stop', { handle: 'alice' })).json()).toMatchObject({
        message: 'Could not stop the workspace of Alice: poise-ws-alice does not exist',
      })
      expect((await api(h, ROOT, root, 'admin/workspaces/start', { handle: 'alice' })).status).toBe(200)
      expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)
      expect((await api(h, ROOT, root, 'admin/workspaces/stop', { handle: 'alice' })).status).toBe(200)
      expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(false)
      const restarted = await api(h, ROOT, root, 'admin/workspaces/restart', { handle: 'alice' })
      expect(restarted.status).toBe(200)
      expect(restarted.json<AdminAnswer>().users.find((user) => user.handle === 'alice')?.workspace?.state).toBe('running')
      expect((await api(h, ROOT, root, 'admin/workspaces/start', { handle: 'nobody' })).status).toBe(404)
      expect(h.logs.filter((entry) => entry.event === 'admin.workspace.action').map((entry) => entry.action)).toEqual(['stop', 'start', 'stop', 'restart'])
    })

    it('disables a person at once and enables them again, but never the admin themselves', async () => {
      const alice = await h.openWorkspace('alice')
      const disabled = await api(h, ROOT, root, 'admin/users/disable', { handle: 'alice' })
      expect(disabled.status).toBe(200)
      expect(disabled.json<AdminAnswer>().users.find((user) => user.handle === 'alice')).toMatchObject({ disabled: true, access: 'disabled by root' })
      expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie: alice.workspaceCookie } })).status).toBe(401)
      expect((await api(h, ROOT, root, 'admin/workspaces/start', { handle: 'alice' })).status).toBe(409)
      expect((await api(h, ROOT, root, 'admin/users/enable', { handle: 'alice' })).status).toBe(200)
      expect(h.store.getUser('alice')?.disabledAt).toBeNull()
      expect((await api(h, ROOT, root, 'admin/users/disable', { handle: 'root' })).status).toBe(409)
      expect(h.store.getUser('root')?.disabledAt).toBeNull()
    })
  })
})

describe('the pages before the workspace', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('offers only the workspace and sign-out once signed in, in Poise\'s typeface', async () => {
    const signedOut = await h.request({ host: APEX, path: '/' })
    expect(signedOut.body).toContain('Sign in with GitHub')
    expect(signedOut.body).toContain('<link rel="stylesheet" href="https://rsms.me/inter/inter.css">')
    expect(signedOut.headers['content-security-policy']).toContain("style-src 'unsafe-inline' https://rsms.me; font-src https://rsms.me;")

    const { apexCookie } = await h.signIn('Alice')
    const home = await h.request({ host: APEX, path: '/', headers: { cookie: apexCookie } })
    expect(home.body).toContain('Open your workspace')
    expect(home.body).toContain('action="/auth/logout"')
    for (const gone of ['href="/link"', 'href="/link/devices"', 'href="/admin"', 'Pair Poise Link', 'Paired devices']) {
      expect(home.body).not.toContain(gone)
    }
    const rootHome = await h.request({ host: APEX, path: '/', headers: { cookie: (await h.signIn('root')).apexCookie } })
    expect(rootHome.body).not.toContain('href="/admin"')
  })

  it('points an admin whose workspace will not start at the admin page, and nobody else', async () => {
    const navigate = { 'sec-fetch-mode': 'navigate', accept: 'text/html' }
    h.workspace.reachable = false
    h.docker.images.clear()
    for (const login of ['root', 'Alice']) {
      const { workspaceCookie } = await h.openWorkspace(login)
      const host = workspaceHost(login.toLowerCase())
      await h.request({ host, path: '/', headers: { ...navigate, cookie: workspaceCookie } })
      await h.orchestrator.startInProgress(login.toLowerCase())
      const page = await h.request({ host, path: '/', headers: { ...navigate, cookie: workspaceCookie } })
      expect(page.status).toBe(503)
      expect(page.body).toContain('The last start failed')
      if (login === 'root') expect(page.body).toContain(`<a href="https://${APEX}/admin">admin page</a>`)
      else expect(page.body).not.toContain('/admin')
      await h.orchestrator.startInProgress(login.toLowerCase())
    }
  })
})
