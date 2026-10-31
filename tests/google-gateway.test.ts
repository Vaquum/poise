import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startHarness, APEX, workspaceHost, type Harness, type Reply } from '../gateway/tests/harness'
import { readServiceConfig } from '../server/service/config'

let h: Harness, workspace: Server, root: string
let database: typeof import('../server/db')
const saved = new Map<string, string | undefined>()
const actualFetch = globalThis.fetch
const physicalPeers = new WeakMap<Socket, string>()
let brokerAuthorizations: string[]
let verified: Array<{ identity: boolean; headerRemoved: boolean }>
let providerSubject = 'google-one', providerError: 'none' | 'partial' | 'unverified' = 'none'
const proof = () => randomBytes(32).toString('base64url')
beforeEach(async () => {
  vi.resetModules(); root = await mkdtemp(join(tmpdir(), 'google-gateway-composition-'))
  for (const key of ['POISE_DB', 'POISE_EDITOR_DIR']) saved.set(key, process.env[key])
  process.env.POISE_DB = join(root, 'local.db'); process.env.POISE_EDITOR_DIR = join(root, 'editor')
  database = await import('../server/db')
  const { handleGoogleApi } = await import('../server/google/api')
  // Import these through the same module graph as the real API after resetModules.
  const guard = await import('../server/http'), identity = await import('../server/service/request-identity')
  brokerAuthorizations = []; verified = []; providerSubject = 'google-one'; providerError = 'none'
  h = await startHarness({ env: { POISE_GOOGLE_CLIENT_ID: 'poise.apps.googleusercontent.com', POISE_GOOGLE_CLIENT_SECRET: 'private-central-secret' } })
  h.config.port = h.port
  const brokerApi = h.context.googleConnections.api.bind(h.context.googleConnections)
  vi.spyOn(h.context.googleConnections, 'api').mockImplementation(async (req, res) => { brokerAuthorizations.push(req.headers.authorization ?? ''); return brokerApi(req, res) })
  workspace = createServer((req, res) => {
    void (async () => {
      const handle = req.headers.host!.split('.')[0], owner = h.store.getUser(handle)!
      const service = readServiceConfig({ POISE_MODE: 'service', POISE_WORKSPACE_HANDLE: handle, POISE_WORKSPACE_OWNER: owner.login, POISE_PUBLIC_ORIGIN: `https://${workspaceHost(handle)}`, POISE_GATEWAY_PUBLIC_KEY: h.keys.publicKeyBase64 })!
      // The test transport is loopback; model the gateway's Docker-network peer so
      // the production service guard runs instead of the local maintenance exemption.
      const actualPeer = physicalPeers.get(req.socket) ?? req.socket.remoteAddress!
      physicalPeers.set(req.socket, actualPeer)
      Object.defineProperty(req.socket, 'remoteAddress', { value: '172.23.0.2' })
      try {
        guard.enforceApiRequest(req, { service })
        const delegated = identity.verifiedRequestIdentity(req)!
        expect(delegated.peer).toBe('172.23.0.2')
        expect(delegated.gatewayPort).toBe(h.port)
        expect(actualPeer.replace(/^::ffff:/, '')).toBe('127.0.0.1')
        // Translate only the simulated Docker address back to the real fixture
        // peer after proving capture; actual broker HTTP and Host routing run.
        delegated.peer = actualPeer
        verified.push({ identity: !!identity.verifiedRequestIdentity(req), headerRemoved: !req.headers['x-poise-identity'] })
        if (!await handleGoogleApi(req, res, req.url!, service)) { res.statusCode = 404; res.end('{}') }
      } catch (error) { res.statusCode = guard.httpStatus(error, 500); res.end(JSON.stringify({ error: (error as Error).message })) }
    })()
  })
  await new Promise<void>(resolve => workspace.listen(0, '127.0.0.1', resolve))
  const address = workspace.address(); if (!address || typeof address === 'string') throw new Error('fixture did not bind')
  h.context.deps.upstream = () => ({ host: '127.0.0.1', port: address.port })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url === `https://${APEX}/_gateway/google`) throw new Error('Public apex egress is blocked by isolation')
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'private-composition-access', refresh_token: 'private-composition-refresh', expires_in: 3600, scope: providerError === 'partial' ? 'email' : 'openid email https://www.googleapis.com/auth/drive.file' })
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: providerSubject, email: `${providerSubject}@example.test`, email_verified: providerError !== 'unverified' })
    return actualFetch(input, init)
  }))
})
afterEach(async () => {
  await new Promise<void>(resolve => workspace.close(() => resolve()))
  await h.close(); vi.unstubAllGlobals(); database.closeDatabase()
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await rm(root, { recursive: true, force: true })
})
async function user(login = 'Alice') {
  const cookies = await h.openWorkspace(login), handle = login.toLowerCase()
  await h.orchestrator.ensureStarted(handle, login)
  const api = (path: string, body?: unknown, origin = `https://${workspaceHost(handle)}`) => h.request({ host: workspaceHost(handle), path, method: body === undefined ? 'GET' : 'POST', headers: { cookie: cookies.workspaceCookie, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { api, cookies, handle }
}
async function flow(u: Awaited<ReturnType<typeof user>>, accountId?: string) {
  const browserSecret = proof(), begun = await u.api('/api/google/connect', { browserSecret, ...(accountId ? { accountId } : {}) })
  expect(begun.status, begun.body).toBe(200)
  const url = new URL(begun.json<{ url: string }>().url), state = url.searchParams.get('state')!
  const start = await h.request({ host: APEX, path: url.pathname + url.search, headers: { cookie: u.cookies.apexCookie } })
  expect(start.status, start.body).toBe(302)
  return { state, browserSecret }
}
async function callback(u: Awaited<ReturnType<typeof user>>, f: { state: string; browserSecret: string }, query = 'code=fake-code'): Promise<Reply> {
  const apex = await h.request({ host: APEX, path: `/auth/google/callback?state=${f.state}&${query}`, headers: { cookie: u.cookies.apexCookie } })
  expect(apex.status, apex.body).toBe(302)
  expect(apex.headers.location).toBe(`https://${workspaceHost(u.handle)}/?google_state=${f.state}`)
  return u.api('/api/google/callback', f)
}
it('composes Connect, central consent, callback receipt and activation through the actual proxy and workspace guard', async () => {
  const u = await user(), f = await flow(u)
  expect((await u.api('/api/google/accounts')).json()).toEqual({ configured: true, accounts: [] })
  const finished = await callback(u, f)
  expect(finished.status, finished.body).toBe(200)
  expect(finished.json()).toMatchObject({ connection: { outcome: 'connected', accountId: 'google-one' }, accounts: [{ id: 'google-one', connected: true }] })
  expect(finished.body).not.toMatch(/private-|accessToken|refreshToken|operationToken|connectionVersion|clientSecret|clientId/)
  expect((await u.api('/api/google/callback', f)).status).toBe(403)
  expect(verified.length).toBeGreaterThan(3)
  expect(verified.every(v => v.identity && v.headerRemoved)).toBe(true)
  expect(brokerAuthorizations.some(value => value.slice(7).split('.').length === 3)).toBe(true)
  expect(brokerAuthorizations.some(value => /^[A-Za-z0-9_-]{43}$/.test(value.slice(7)))).toBe(true)
})
it('preserves request identity across interleaved owners without accepting caller substitutes', async () => {
  const a = await user(), b = await user('bob')
  const [fa, fb] = await Promise.all([flow(a), flow(b)])
  providerSubject = 'shared-google'; expect((await callback(a, fa)).status).toBe(200)
  providerSubject = 'other-google'; expect((await callback(b, fb)).status).toBe(200)
  const [sa, sb] = await Promise.all([a.api('/api/google/accounts'), b.api('/api/google/accounts')])
  expect(sa.body).toContain('shared-google'); expect(sa.body).not.toContain('other-google')
  expect(sb.body).toContain('other-google'); expect(sb.body).not.toContain('shared-google')
  const admissions = () => brokerAuthorizations.filter(value => value.slice(7).split('.').length === 3).length
  const before = admissions()
  expect((await a.api('/api/google/connect', { browserSecret: proof(), authorization: 'caller-substitute' }, 'https://untrusted.test')).status).toBe(403)
  expect(admissions()).toBe(before)
})
it('refuses wrong proof and partial/unverified consent without activating a grant', async () => {
  const u = await user()
  for (const mode of ['partial', 'unverified'] as const) {
    providerError = mode
    const f = await flow(u), reply = await callback(u, f)
    expect(reply.json()).toMatchObject({ connection: { outcome: 'failed' }, accounts: [] })
  }
  providerError = 'none'
  const f = await flow(u)
  await h.request({ host: APEX, path: `/auth/google/callback?state=${f.state}&code=fake-code`, headers: { cookie: u.cookies.apexCookie } })
  expect((await u.api('/api/google/callback', { ...f, browserSecret: proof() })).status).toBe(403)
  expect((await u.api('/api/google/accounts')).json()).toEqual({ configured: true, accounts: [] })
  expect((await u.api('/api/google/callback', f)).json()).toMatchObject({ connection: { outcome: 'connected' } })
})
it('requires explicit central reconnect for legacy service metadata and refuses workspace client configuration', async () => {
  database.setMeta('google:config', JSON.stringify({ clientId: 'old.apps.googleusercontent.com', clientSecret: 'private-old-secret', origin: 'https://alice.poise.test' }))
  database.setMeta('google:account:google-one', JSON.stringify({ id: 'google-one', email: 'old@example.test', connected: true, refreshToken: 'private-old-refresh' }))
  const u = await user(), before = await u.api('/api/google/accounts')
  expect(before.json()).toMatchObject({ accounts: [{ id: 'google-one', connected: false, state: 'disconnected' }] })
  expect(before.body).not.toMatch(/private-|old.apps/)
  expect((await u.api('/api/google/config', { clientId: 'other', clientSecret: 'private-new-secret' })).status).toBe(404)
  const f = await flow(u, 'google-one')
  expect((await callback(u, f)).json()).toMatchObject({ accounts: [{ id: 'google-one', connected: true }] })
})
