import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APEX, CURRENT_IMAGE_ID, events, OLD_IMAGE_ID, startHarness, workspaceHost, type Harness, type Reply } from './harness.js'

const FORM = 'application/x-www-form-urlencoded'

function csrfOf(reply: Reply): string {
  return /name="csrf" value="([^"]+)"/.exec(reply.body)?.[1] ?? ''
}

describe('admin', () => {
  let h: Harness
  let root: string
  let csrf: string
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => h.request({
    host: APEX, method: 'POST', path,
    headers: { cookie: root, origin: `https://${APEX}`, 'content-type': FORM, ...headers },
    body: new URLSearchParams(fields).toString(),
  })

  beforeEach(async () => {
    h = await startHarness()
    root = (await h.signIn('root')).apexCookie
    csrf = csrfOf(await h.request({ host: APEX, path: '/admin', headers: { cookie: root } }))
  })
  afterEach(async () => {
    await h.close()
  })

  it('is for admins only', async () => {
    const signedOut = await h.request({ host: APEX, path: '/admin' })
    expect(signedOut.status).toBe(302)
    expect(signedOut.headers.location).toBe('/auth/login?next=%2Fadmin')

    const alice = (await h.signIn('alice')).apexCookie
    expect((await h.request({ host: APEX, path: '/admin', headers: { cookie: alice } })).status).toBe(403)
    const aliceCsrf = csrfOf(await h.request({ host: APEX, path: '/', headers: { cookie: alice } }))
    const attempt = await h.request({
      host: APEX, method: 'POST', path: '/admin/allow',
      headers: { cookie: alice, origin: `https://${APEX}`, 'content-type': FORM },
      body: new URLSearchParams({ csrf: aliceCsrf, login: 'mallory' }).toString(),
    })
    expect(attempt.status).toBe(403)
    expect(h.store.isOnAllowList('mallory')).toBe(false)
  })

  it('lists people with their workspace state and image', async () => {
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
    const page = await h.request({ host: APEX, path: '/admin', headers: { cookie: root } })
    expect(page.status).toBe(200)
    expect(page.body).toMatch(/<strong>Alice<\/strong>[\s\S]*running[\s\S]*<code>111111111111 \(current\)<\/code>/)
    expect(page.body).toMatch(/<strong>bob<\/strong>[\s\S]*exited[\s\S]*<code>000000000000 \(outdated\)<\/code>/)
    expect(page.body).toMatch(/<strong>root<\/strong> <span class="muted">admin<\/span>[\s\S]*not created/)
  })

  it('shows the Docker Engine error instead of hiding the workspace column', async () => {
    await h.docker.close()
    const page = await h.request({ host: APEX, path: '/admin', headers: { cookie: root } })
    expect(page.status).toBe(200)
    expect(page.body).toContain('Docker Engine: Docker Engine GET /images/poise-runtime:latest/json')
    expect(events(h.logs, 'admin.docker.failed')).toHaveLength(1)
  })

  it('requires the CSRF token and the apex origin on every change', async () => {
    const dockerCallsBefore = h.docker.calls.length
    expect((await post('/admin/allow', { login: 'mallory' })).status).toBe(403)
    expect((await post('/admin/allow', { csrf: 'wrong', login: 'mallory' })).status).toBe(403)
    expect((await post('/admin/allow', { csrf, login: 'mallory' }, { origin: `https://${workspaceHost('alice')}` })).status).toBe(403)
    const noOrigin = await h.request({
      host: APEX, method: 'POST', path: '/admin/allow',
      headers: { cookie: root, 'content-type': FORM },
      body: new URLSearchParams({ csrf, login: 'mallory' }).toString(),
    })
    expect(noOrigin.status).toBe(403)
    expect((await post('/admin/workspaces/start', { handle: 'root' })).status).toBe(403)
    expect(h.store.isOnAllowList('mallory')).toBe(false)
    expect(h.docker.calls).toHaveLength(dockerCallsBefore)
  })

  it('adds and removes allowed logins, and removal ends access at once', async () => {
    expect((await h.signIn('mallory')).reply.status).toBe(403)
    const added = await post('/admin/allow', { csrf, login: 'Mallory' })
    expect(added.status).toBe(303)
    expect(added.headers.location).toBe('/admin')
    expect(h.store.listAllowed()).toContainEqual({ handle: 'mallory', source: 'admin', addedBy: 'root', addedAt: expect.any(Number) })
    const mallory = await h.openWorkspace('mallory')

    expect((await post('/admin/allow/remove', { csrf, login: 'mallory' })).status).toBe(303)
    expect(h.store.isOnAllowList('mallory')).toBe(false)
    expect((await h.request({ host: workspaceHost('mallory'), path: '/api/state', headers: { cookie: mallory.workspaceCookie } })).status).toBe(403)
    expect((await h.request({ host: APEX, path: '/', headers: { cookie: mallory.apexCookie } })).body).toContain('Sign in with GitHub')
    expect(events(h.logs, 'admin.allow')).toEqual(['admin.allow.added', 'admin.allow.removed'])
  })

  it('refuses invalid and reserved logins, and leaves POISE_ALLOWED_USERS entries to the environment', async () => {
    expect((await post('/admin/allow', { csrf, login: 'not a login' })).status).toBe(400)
    expect((await post('/admin/allow', { csrf, login: 'www' })).status).toBe(400)
    const fromEnv = await post('/admin/allow/remove', { csrf, login: 'alice' })
    expect(fromEnv.status).toBe(409)
    expect(fromEnv.body).toContain('POISE_ALLOWED_USERS')
    expect((await post('/admin/allow/remove', { csrf, login: 'nobody' })).status).toBe(404)
  })

  it('starts, stops and restarts a workspace through the Docker Engine', async () => {
    await h.openWorkspace('alice')
    expect((await post('/admin/workspaces/start', { csrf, handle: 'alice' })).status).toBe(303)
    expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)

    expect((await post('/admin/workspaces/stop', { csrf, handle: 'alice' })).status).toBe(303)
    expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(false)

    expect((await post('/admin/workspaces/restart', { csrf, handle: 'alice' })).status).toBe(303)
    expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)
    expect((await post('/admin/workspaces/restart', { csrf, handle: 'alice' })).status).toBe(303)

    expect(h.docker.calls.map((call) => `${call.method} ${call.path.split('?')[0]}`).filter((call) => /start|stop|restart/.test(call))).toEqual([
      'POST /containers/poise-ws-alice/start',
      'POST /containers/poise-ws-alice/stop',
      'POST /containers/poise-ws-alice/start',
      'POST /containers/poise-ws-alice/restart',
    ])
    expect(h.logs.filter((entry) => entry.event === 'admin.workspace.action').map((entry) => entry.action)).toEqual(['start', 'stop', 'restart', 'restart'])
    expect(events(h.logs, 'workspace.container')).toEqual([
      'workspace.container.created',
      'workspace.container.started',
      'workspace.container.stopped',
      'workspace.container.started',
      'workspace.container.restarted',
    ])
  })

  it('disables anyone at once, organisation members included, and enables them again', async () => {
    await h.close()
    h = await startHarness({ env: { POISE_ALLOWED_ORGS: 'acme' } })
    root = (await h.signIn('root')).apexCookie
    csrf = csrfOf(await h.request({ host: APEX, path: '/admin', headers: { cookie: root } }))
    const carol = await h.openWorkspace('carol')
    const workspace = workspaceHost('carol')
    expect((await h.request({ host: workspace, path: '/api/state', headers: { cookie: carol.workspaceCookie } })).status).toBe(200)
    // carol came in through her organisation, so the allow list cannot remove her.
    expect((await post('/admin/allow/remove', { csrf, login: 'carol' })).status).toBe(404)
    h.docker.addContainer({
      name: 'poise-ws-carol', imageId: CURRENT_IMAGE_ID, imageRef: 'poise-runtime:latest', running: true,
      labels: { 'poise.managed': 'true', 'poise.workspace': 'carol' }, networks: new Set(['poise-net-carol']), spec: {},
    })
    const deviceToken = h.store.createDeviceCode(null, 60_000, 5)
    h.store.decideDeviceCode(deviceToken.userCode, 'carol', true)
    const issued = h.store.pollDeviceCode(deviceToken.deviceCode, 5)
    const token = issued.issued ? issued.token : ''

    expect((await post('/admin/users/disable', { csrf, handle: 'carol' })).status).toBe(303)
    expect(h.store.getUser('carol')).toMatchObject({ disabledBy: 'root' })
    expect((await h.request({ host: workspace, path: '/api/state', headers: { cookie: carol.workspaceCookie } })).status).toBe(401)
    expect((await h.request({ host: APEX, path: '/', headers: { cookie: carol.apexCookie } })).body).toContain('Sign in with GitHub')
    expect((await h.request({ host: workspace, path: '/api/link/hello', headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
    expect(h.docker.containers.get('poise-ws-carol')?.running).toBe(false)
    expect(h.logs.find((entry) => entry.event === 'workspace.container.stopped')).toMatchObject({ handle: 'carol', reason: 'disabled' })
    const page = await h.request({ host: APEX, path: '/admin', headers: { cookie: root } })
    expect(page.body).toMatch(/<strong>carol<\/strong>[\s\S]*disabled by root/)

    // Signing in again is refused, even though she is still an organisation member.
    const refused = await h.signIn('carol')
    expect(refused.reply.status).toBe(403)
    expect(refused.reply.body).toContain('carol has been disabled by an admin')
    expect((await post('/admin/workspaces/start', { csrf, handle: 'carol' })).status).toBe(409)

    expect((await post('/admin/users/enable', { csrf, handle: 'carol' })).status).toBe(303)
    expect(h.store.getUser('carol')?.disabledAt).toBeNull()
    expect((await h.signIn('carol')).reply.status).toBe(302)
    // Her old device stays revoked: Poise Link pairs again.
    expect((await h.request({ host: workspace, path: '/api/link/hello', headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
    expect(events(h.logs, 'admin.user')).toEqual(['admin.user.disabled', 'admin.user.enabled'])
  })

  it('checks the disabled flag on every request, not only when disabling', async () => {
    await h.openWorkspace('alice')
    h.store.disableUser('alice', 'root')
    // Credentials minted after the disable (none can be, short of a bug) are refused by the flag itself.
    const { id, session } = h.store.createApexSession('alice', 60_000)
    const { id: workspaceId } = h.store.createWorkspaceSession(session, 'alice')
    expect((await h.request({ host: APEX, path: '/', headers: { cookie: `poise_gw=${id}` } })).body).toContain('Sign in with GitHub')
    expect((await h.request({ host: workspaceHost('alice'), path: '/api/state', headers: { cookie: `poise_ws=${workspaceId}` } })).status).toBe(403)
    expect(h.workspace.requests).toHaveLength(0)
  })

  it('does not let an admin disable themselves', async () => {
    const reply = await post('/admin/users/disable', { csrf, handle: 'root' })
    expect(reply.status).toBe(409)
    expect(h.store.getUser('root')?.disabledAt).toBeNull()
  })

  it('reports a failed action with the Docker Engine\'s reason', async () => {
    await h.openWorkspace('alice')
    const stop = await post('/admin/workspaces/stop', { csrf, handle: 'alice' }, { accept: 'text/html' })
    expect(stop.status).toBe(502)
    expect(stop.body).toContain('Could not stop the workspace of Alice: poise-ws-alice does not exist')
    expect((await post('/admin/workspaces/start', { csrf, handle: 'nobody' })).status).toBe(404)
  })
})
