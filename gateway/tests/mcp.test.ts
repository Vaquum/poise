import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { McpGrants } from '../src/mcp-grants.js'
import { MCP_TOOLS } from '../src/mcp-contract.js'
import { loadConfig } from '../src/config.js'
import { APEX, startHarness, type Harness } from './harness.js'

let h: Harness
beforeEach(async () => { h = await startHarness({ env: { POISE_MCP_ENABLED: '1' } }) })
afterEach(async () => { await h.close() })
const verifier = 'a'.repeat(43)
const challenge = createHash('sha256').update(verifier).digest('base64url')
const resource = `https://${APEX}/mcp`
const redirectUri = 'http://127.0.0.1:19876/callback'

function form(path: string, values: Record<string, string>, cookie?: string) {
  return h.request({ host: APEX, path, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
    ...(cookie ? { cookie, origin: `https://${APEX}` } : {}) }, body: new URLSearchParams(values).toString() })
}
async function register() {
  const reply = await h.request({ host: APEX, path: '/mcp/register', method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) })
  expect(reply.status).toBe(201)
  return String(reply.json().client_id)
}
async function authorize(login = 'Alice', overrides: Record<string, string> = {}) {
  const client = await register()
  const params = new URLSearchParams({ client_id: client, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', resource, scope: 'poise:read', response_type: 'code', state: 'client-state', ...overrides })
  const path = `/mcp/authorize?${params}`
  const anonymous = await h.request({ host: APEX, path })
  expect(anonymous.status).toBe(302)
  expect(anonymous.headers.location).toBe(`/auth/login?next=${encodeURIComponent(path)}`)
  const { apexCookie } = await h.signIn(login, path)
  const page = await h.request({ host: APEX, path, headers: { cookie: apexCookie } })
  expect(page.status).toBe(200)
  expect(page.body).toContain('Allow read access')
  const csrf = h.store.findSession(apexCookie.slice('poise_gw='.length))!.csrf
  const reply = await form('/mcp/authorize', { request: params.toString(), csrf, decision: 'approve' }, apexCookie)
  expect(reply.status).toBe(303)
  const target = new URL(String(reply.headers.location))
  expect(target.searchParams.get('state')).toBe('client-state')
  return { client, code: target.searchParams.get('code')!, apexCookie, csrf, params }
}
async function connect(login = 'Alice') {
  const authorization = await authorize(login)
  const token = await form('/mcp/token', { grant_type: 'authorization_code', client_id: authorization.client,
    code: authorization.code, redirect_uri: redirectUri, resource, code_verifier: verifier })
  expect(token.status).toBe(200)
  return { ...authorization, access: String(token.json().access_token), refresh: String(token.json().refresh_token) }
}
function rpc(access: string, method = 'tools/list', params?: unknown) {
  return h.request({ host: APEX, path: '/mcp', method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
}

it('is absent by default and validates enablement explicitly', async () => {
  expect(() => loadConfig({ POISE_MCP_ENABLED: 'yes' })).toThrow('POISE_MCP_ENABLED')
  expect(loadConfig({ POISE_DOMAIN: 'poise.test', POISE_GITHUB_CLIENT_ID: 'fixture', POISE_GITHUB_CLIENT_SECRET: 'fixture',
    POISE_ADMINS: 'root', POISE_GATEWAY_CONTAINER: 'poise-gateway', POISE_RUNTIME_IMAGE: 'poise-runtime:latest' }).mcpEnabled).toBe(false)
  h.config.mcpEnabled = false
  for (const path of ['/mcp', '/mcp/authorize', '/mcp/grants', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
    expect((await h.request({ host: APEX, path })).status).toBe(404)
  }
})

it('completes discovery, existing GitHub sign-in, explicit owner consent, PKCE and MCP initialization', async () => {
  const unauthorized = await h.request({ host: APEX, path: '/mcp', method: 'POST' })
  expect(unauthorized.status).toBe(401)
  expect(unauthorized.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp')
  const metadata = await h.request({ host: APEX, path: '/.well-known/oauth-protected-resource/mcp' })
  expect(metadata.json()).toMatchObject({ resource, authorization_servers: [`https://${APEX}`], scopes_supported: ['poise:read'] })
  const issuer = await h.request({ host: APEX, path: '/.well-known/oauth-authorization-server' })
  expect(issuer.json()).toMatchObject({ code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
  const grant = await connect()
  expect((await rpc(grant.access)).json()).toMatchObject({ result: { tools: MCP_TOOLS } })
  expect((await rpc(grant.access, 'initialize', { protocolVersion: '2025-11-25' })).json()).toMatchObject({ result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } })
  expect((await form('/mcp/token', { grant_type: 'authorization_code', client_id: grant.client, code: grant.code, redirect_uri: redirectUri, resource, code_verifier: verifier })).status).toBe(400)
  const listed = await h.request({ host: APEX, path: '/mcp/grants', headers: { cookie: grant.apexCookie } })
  expect(listed.body).toContain(grant.client); expect(listed.body).toContain('Revoke')
  expect(listed.body).not.toContain(grant.access); expect(listed.body).not.toContain(grant.refresh)
})

it('rejects wrong audience, PKCE, expiry, unsupported scope and tools without workspace reads', async () => {
  const client = await register()
  for (const changes of [{ resource: 'https://other.test/mcp' }, { scope: 'poise:write' }, { code_challenge_method: 'plain' }]) {
    const params = new URLSearchParams({ client_id: client, redirect_uri: redirectUri, response_type: 'code', scope: 'poise:read', resource, code_challenge: challenge, code_challenge_method: 'S256', ...changes })
    expect((await h.request({ host: APEX, path: `/mcp/authorize?${params}` })).status).toBe(400)
  }
  for (const changes of [{ resource: 'https://other.test/mcp' }, { code_verifier: 'wrong'.repeat(12) }]) {
    const auth = await authorize()
    expect((await form('/mcp/token', { grant_type: 'authorization_code', client_id: auth.client, code: auth.code, redirect_uri: redirectUri, resource, code_verifier: verifier, ...changes })).status).toBe(400)
  }
  const grant = await connect()
  expect((await rpc(grant.access, 'tools/call', { name: 'terminal', arguments: {} })).json()).toMatchObject({ result: { isError: true } })
  expect((await rpc(grant.access, 'tools/call', { name: 'poise_work', arguments: { repository: 'fixtures/work', issue: 1, scope: 'write' } })).json()).toMatchObject({ result: { isError: true } })
  expect(h.workspace.requests).toHaveLength(0)
  h.advance(10 * 60_000 + 1)
  expect((await rpc(grant.access)).status).toBe(401)
  const renewed = await form('/mcp/token', { grant_type: 'refresh_token', client_id: grant.client, refresh_token: grant.refresh, resource })
  expect(renewed.status).toBe(200)
  expect((await form('/mcp/token', { grant_type: 'refresh_token', client_id: grant.client, refresh_token: grant.refresh, resource })).status).toBe(400)
  h.advance(30 * 86_400_000)
  expect((await form('/mcp/token', { grant_type: 'refresh_token', client_id: grant.client, refresh_token: String(renewed.json().refresh_token), resource })).status).toBe(400)
})

it('requires a live owner consent and rejects expired authorization codes and malformed registrations', async () => {
  const auth = await authorize()
  const request = auth.params.toString()
  for (const [cookie, csrf] of [[undefined, auth.csrf], [auth.apexCookie, 'forged']] as const) {
    expect((await form('/mcp/authorize', { request, csrf, decision: 'approve' }, cookie)).status).toBe(403)
  }
  const denied = await form('/mcp/authorize', { request, csrf: auth.csrf, decision: 'deny' }, auth.apexCookie)
  expect(new URL(String(denied.headers.location)).searchParams.get('error')).toBe('access_denied')
  expect(new URL(String(denied.headers.location)).searchParams.has('code')).toBe(false)
  h.advance(60_001)
  expect((await form('/mcp/token', { grant_type: 'authorization_code', client_id: auth.client, code: auth.code,
    redirect_uri: redirectUri, resource, code_verifier: verifier })).status).toBe(400)
  for (const body of ['{', JSON.stringify({ redirect_uris: ['not a URL'] }), JSON.stringify({ redirect_uris: ['http://other.test/callback'] })]) {
    expect((await h.request({ host: APEX, path: '/mcp/register', method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(400)
  }
})

it('isolates two owners, persists hash-only grants and revokes access and refresh immediately', async () => {
  const alice = await connect(), bob = await connect('bob')
  const grant = h.context.mcp.grants.find(alice.access, 'access')!
  expect(grant).toMatchObject({ ownerId: 1001, handle: 'alice', resource, clientId: alice.client })
  expect(JSON.stringify(grant)).not.toContain(alice.access)
  expect(JSON.stringify(grant)).not.toContain(alice.refresh)
  const reopened = new McpGrants(`${h.config.dataDir}/mcp.db`, () => Date.now())
  expect(reopened.find(alice.access, 'access')?.ownerId).toBe(1001); reopened.close()
  const bobPage = await h.request({ host: APEX, path: '/mcp/grants', headers: { cookie: bob.apexCookie } })
  expect(bobPage.body).not.toContain(alice.client)
  await form('/mcp/grants', { id: grant.grantId, csrf: bob.csrf }, bob.apexCookie)
  expect((await rpc(alice.access)).status).toBe(200)
  expect((await form('/mcp/grants', { id: grant.grantId, csrf: 'forged' }, alice.apexCookie)).status).toBe(403)
  await form('/mcp/grants', { id: grant.grantId, csrf: alice.csrf }, alice.apexCookie)
  expect((await rpc(alice.access)).status).toBe(401)
  expect((await form('/mcp/token', { grant_type: 'refresh_token', client_id: alice.client, refresh_token: alice.refresh, resource })).status).toBe(400)
  expect((await rpc(bob.access)).status).toBe(200)
  h.store.disableUser('bob', 'root')
  expect((await rpc(bob.access)).status).toBe(401)
})

it('retains a consented registration past its original deadline while its grant lives', async () => {
  const client = await register()
  h.advance(20 * 86_400_000)
  const params = new URLSearchParams({ client_id: client, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', resource, scope: 'poise:read', response_type: 'code', state: 's1' })
  const path = `/mcp/authorize?${params}`
  const { apexCookie } = await h.signIn('Alice', path)
  const page = await h.request({ host: APEX, path, headers: { cookie: apexCookie } })
  expect(page.status).toBe(200)
  const csrf = h.store.findSession(apexCookie.slice('poise_gw='.length))!.csrf
  const approved = await form('/mcp/authorize', { request: params.toString(), csrf, decision: 'approve' }, apexCookie)
  expect(approved.status).toBe(303)
  const code = new URL(String(approved.headers.location)).searchParams.get('code')!
  const token = await form('/mcp/token', { grant_type: 'authorization_code', client_id: client,
    code, redirect_uri: redirectUri, resource, code_verifier: verifier })
  expect(token.status).toBe(200)
  h.advance(15 * 86_400_000)
  const retryParams = new URLSearchParams({ client_id: client, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', resource, scope: 'poise:read', response_type: 'code', state: 's2' })
  const retryPath = `/mcp/authorize?${retryParams}`
  const retrySignIn = await h.signIn('Alice', retryPath)
  const retryPage = await h.request({ host: APEX, path: retryPath, headers: { cookie: retrySignIn.apexCookie } })
  expect(retryPage.status).toBe(200)
  expect(retryPage.body).toContain('Allow read access')
})

it('retains a first-time grant evicted between consent and code exchange', async () => {
  const client = await register()
  const params = new URLSearchParams({ client_id: client, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', resource, scope: 'poise:read', response_type: 'code', state: 's1' })
  const path = `/mcp/authorize?${params}`
  const { apexCookie } = await h.signIn('Alice', path)
  const csrf = h.store.findSession(apexCookie.slice('poise_gw='.length))!.csrf
  const approved = await form('/mcp/authorize', { request: params.toString(), csrf, decision: 'approve' }, apexCookie)
  expect(approved.status).toBe(303)
  const code = new URL(String(approved.headers.location)).searchParams.get('code')!
  for (let index = 0; index < 256; index++) await register()
  const token = await form('/mcp/token', { grant_type: 'authorization_code', client_id: client,
    code, redirect_uri: redirectUri, resource, code_verifier: verifier })
  expect(token.status).toBe(200)
  expect(h.context.mcp.grants.redirects(client)).toEqual([redirectUri])
  const retryParams = new URLSearchParams({ client_id: client, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', resource, scope: 'poise:read', response_type: 'code', state: 's2' })
  const retryPath = `/mcp/authorize?${retryParams}`
  const retrySignIn = await h.signIn('Alice', retryPath)
  const retryPage = await h.request({ host: APEX, path: retryPath, headers: { cookie: retrySignIn.apexCookie } })
  expect(retryPage.status).toBe(200)
  expect(retryPage.body).toContain('Allow read access')
})

