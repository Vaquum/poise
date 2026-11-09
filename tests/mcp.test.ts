import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { signAssertion } from '../gateway/src/assertion'
import { createGateway, type Gateway } from '../gateway/src/gateway'
import { send, startHarness, type Harness } from '../gateway/tests/harness'
import { enforceApiRequest, httpStatus } from '../server/http'
import { handleMcpRead } from '../server/mcp'
import { readServiceConfig } from '../server/service/config'

const endpoint = 'https://poise.test/mcp'
let h: Harness
let gateway: Gateway
let workspace: http.Server
let gatewayPort: number
let workspacePort: number
let workspaceReads: number
let beforeRead: (() => void) | undefined

beforeEach(async () => {
  vi.stubEnv('POISE_MODE', 'service')
  h = await startHarness({ env: { POISE_MCP_ENABLED: '1' } })
  workspaceReads = 0
  beforeRead = undefined
  workspace = http.createServer(async (req, res) => {
    // Both owners use the production guard and handler, with separate workspace identities.
    const bob = req.headers.host === 'bob.poise.test'
    const service = readServiceConfig({ POISE_MODE: 'service', POISE_WORKSPACE_HANDLE: bob ? 'bob' : 'alice',
      POISE_WORKSPACE_OWNER: bob ? 'bob' : 'Alice', POISE_WORKSPACE_OWNER_ID: bob ? '1002' : '1001',
      POISE_PUBLIC_ORIGIN: `https://${bob ? 'bob' : 'alice'}.poise.test`, POISE_GATEWAY_PUBLIC_KEY: h.keys.publicKeyBase64 })
    Object.defineProperty(req.socket, 'remoteAddress', { value: '172.18.0.2', configurable: true })
    try {
      const authority = enforceApiRequest(req, { service })
      expect(req.headers['x-poise-identity']).toBeUndefined()
      workspaceReads++
      beforeRead?.()
      await handleMcpRead(req, res, service, authority)
    } catch (error) { res.statusCode = httpStatus(error, 400); res.end(JSON.stringify({ error: String(error) })) }
  })
  await new Promise<void>(resolve => workspace.listen(0, '127.0.0.1', resolve))
  workspacePort = (workspace.address() as AddressInfo).port
  gateway = createGateway({ ...h.context.deps, upstream: () => ({ host: '127.0.0.1', port: workspacePort }) })
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  gatewayPort = (gateway.server.address() as AddressInfo).port
})

afterEach(async () => {
  await gateway.close()
  await h.close()
  await new Promise<void>(resolve => workspace.close(() => resolve()))
  vi.unstubAllEnvs()
})

const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname !== 'poise.test') {
    // The only other network peer is this test's fake GitHub OAuth service.
    expect(url.origin).toBe(h.github.url)
    return fetch(input, init)
  }
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
  const reply = await send(gatewayPort, { host: url.host, path: `${url.pathname}${url.search}`, method: init?.method,
    headers, ...(init?.body ? { body: String(init.body) } : {}) })
  const responseHeaders = new Headers()
  for (const [key, value] of Object.entries(reply.headers)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(key, entry)
  }
  return new Response(reply.status === 202 ? null : reply.body, { status: reply.status, headers: responseHeaders })
}

/** A fresh SDK client performs discovery/registration; its owner signs in through fake GitHub. */
async function connect(login: string) {
  let clientInformation: OAuthClientInformationMixed | undefined, tokens: OAuthTokens | undefined
  let verifier = '', authorizationUrl: URL | undefined
  const redirectUrl = 'http://127.0.0.1:19876/callback'
  const provider: OAuthClientProvider = {
    redirectUrl,
    clientMetadata: { redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'poise:read' },
    clientInformation: () => clientInformation, saveClientInformation: value => { clientInformation = value },
    tokens: () => tokens, saveTokens: value => { tokens = value },
    codeVerifier: () => verifier, saveCodeVerifier: value => { verifier = value },
    state: () => 'fixture-state', redirectToAuthorization: value => { authorizationUrl = value },
  }
  const client = new Client({ name: 'poise-connection-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: provider, fetch: fetcher })
  await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError)
  expect(clientInformation?.client_id).toBeTruthy()
  expect(authorizationUrl).toBeDefined()
  const path = `${authorizationUrl!.pathname}${authorizationUrl!.search}`
  const anonymous = await fetcher(authorizationUrl!, { redirect: 'manual' })
  expect(anonymous.status).toBe(302)
  expect(anonymous.headers.get('location')).toBe(`/auth/login?next=${encodeURIComponent(path)}`)
  const signedIn = await h.signIn(login, path)
  expect(signedIn.reply.headers.location).toBe(path)
  const page = await fetcher(authorizationUrl!, { headers: { cookie: signedIn.apexCookie } })
  expect(page.status).toBe(200)
  expect(await page.text()).toContain(`${login}'s workspace`)
  const csrf = h.store.findSession(signedIn.apexCookie.slice('poise_gw='.length))!.csrf
  const approved = await fetcher(new URL('/mcp/authorize', endpoint), { method: 'POST', headers: {
    cookie: signedIn.apexCookie, origin: new URL(endpoint).origin, 'content-type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ request: authorizationUrl!.searchParams.toString(), csrf, decision: 'approve' }) })
  expect(approved.status).toBe(303)
  const callback = new URL(approved.headers.get('location')!)
  expect(callback.searchParams.get('state')).toBe('fixture-state')
  await transport.finishAuth(callback.searchParams.get('code')!)
  await transport.close()
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: provider, fetch: fetcher }))
  expect(tokens?.access_token).toBeTruthy()
  return { client, provider }
}

async function describe(client: Client) {
  const result = await client.callTool({ name: 'poise_describe', arguments: {} })
  expect(result.isError).not.toBe(true)
  const content = result.content as { type: string; text: string }[]
  expect(content[0].type).toBe('text')
  return JSON.parse(content[0].text) as unknown
}

it('connects a fresh MCP client after anonymous registrations fill the pending pool, retaining consented clients', async () => {
  async function fillPool() {
    for (let index = 0; index < 256; index++) {
      const registration = await fetcher(new URL('/mcp/register', endpoint), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [`http://127.0.0.1:19876/anonymous-${index}`] }) })
      expect(registration.status).toBe(201)
    }
  }
  await fillPool()
  const alice = await connect('Alice')
  try {
    await fillPool()
    const bob = await connect('bob')
    try {
      expect((await bob.client.listTools()).tools.map(tool => tool.name)).toEqual(['poise_describe'])
      expect(await describe(bob.client)).toEqual({ workspace: 'bob', owner: 'bob', capabilities: { tools: ['poise_describe'] } })
      expect(await describe(alice.client)).toEqual({ workspace: 'alice', owner: 'Alice', capabilities: { tools: ['poise_describe'] } })
      expect(gateway.context.mcp.grants.redirects((await alice.provider.clientInformation())!.client_id)).toEqual(['http://127.0.0.1:19876/callback'])
      expect(workspaceReads).toBe(2)
      const unsupported = await bob.client.callTool({ name: 'poise_work', arguments: { repository: 'private/work', issue: 1 } })
      expect(unsupported.isError).toBe(true)
      expect(workspaceReads).toBe(2)
      const tokens = (await alice.provider.tokens())!
      expect((await h.request({ host: 'alice.poise.test', path: '/api/workspace', headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401)
      expect((await h.request({ host: 'poise.test', path: '/admin', headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(302)
    } finally { await bob.client.close() }
  } finally { await alice.client.close() }
})

it('rejects forged, expired, wrong-audience, cross-owner and wrong-scope workspace assertions', async () => {
  const mcp = { resource: endpoint, ownerId: 1001, handle: 'alice', grantId: randomUUID() }
  const subject = { handle: 'alice', login: 'Alice', scope: 'mcp' as const, mcp }
  const valid = signAssertion(h.keys.privateKey, subject, Date.now())
  const invalid = [
    { token: `${valid.slice(0, -5)}abcde`, status: 401 },
    { token: signAssertion(h.keys.privateKey, subject, Date.now() - 180_000), status: 401 },
    { token: signAssertion(h.keys.privateKey, { ...subject, handle: 'bob' }, Date.now()), status: 401 },
    { token: signAssertion(h.keys.privateKey, { ...subject, mcp: { ...mcp, resource: 'https://other.test/mcp' } }, Date.now()), status: 401 },
    { token: signAssertion(h.keys.privateKey, { ...subject, mcp: { ...mcp, ownerId: 1002 } }, Date.now()), status: 401 },
    { token: signAssertion(h.keys.privateKey, { ...subject, mcp: undefined }, Date.now()), status: 401 },
    ...(['browser', 'link', 'admin'] as const).map(scope => ({ token: signAssertion(h.keys.privateKey, { ...subject, scope }, Date.now()), status: 403 })),
    { token: '', status: 401 },
  ]
  for (const { token, status } of invalid) {
    const reply = await send(workspacePort, { host: 'alice.poise.test', path: '/api/mcp/read', method: 'POST',
      headers: { 'x-poise-identity': token, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'poise_describe' }) })
    expect(reply.status).toBe(status)
  }
  for (const path of ['/api/workspace', '/api/link/hello', '/api/service/health', '/api/chat/control', '/ws/terminal']) {
    const reply = await send(workspacePort, { host: 'alice.poise.test', path, headers: { 'x-poise-identity': valid } })
    expect(reply.status).toBe(403)
  }
  expect(workspaceReads).toBe(0)
})

it('withholds an in-flight workspace response when its owner revokes the grant', async () => {
  const connection = await connect('Alice')
  try {
    const tokens = (await connection.provider.tokens())!
    const grant = gateway.context.mcp.grants.find(tokens.access_token, 'access')!
    beforeRead = () => gateway.context.mcp.grants.revoke(grant.ownerId, grant.grantId)
    const response = await fetcher(endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'poise_describe' } }) })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'invalid_token' })
    expect(workspaceReads).toBe(1)
    expect(gateway.context.mcp.grants.find(tokens.refresh_token!, 'refresh')).toBeNull()
  } finally { await connection.client.close() }
})
