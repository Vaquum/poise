// Checks and OAuth sign-in, end to end on this machine: a remote MCP server
// behind a local authorization server (metadata, dynamic registration, PKCE,
// code exchange, refresh), and a local stdio server started from a fixture.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { db } from '../server/db'
import { createServer as addServer, deleteServer, listServers, readSecret, secretValues, serverView, writeSecret } from '../server/extensions/store'
import { checkServer } from '../server/extensions/probe'
import { accessToken, finishSignIn, startSignIn } from '../server/extensions/oauth'
import { extensionsFor } from '../server/extensions/delivery'
import { validateSpec } from '../server/extensions/types'

const everywhere = { default: true, workspaces: {} }
const ORIGIN = 'http://localhost:5173'
let http: Server
let base = ''
const issued = new Map<string, { challenge: string, redirect: string, client: string }>()
let tokenCount = 0
let refuseRefresh = false
let authorizePage = ''

const body = (req: IncomingMessage) => new Promise<string>((resolve) => { let text = ''; req.on('data', (chunk) => { text += chunk }); req.on('end', () => resolve(text)) })

beforeAll(async () => {
  http = createServer(async (req, res) => {
    const url = new URL(req.url!, base)
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: base, authorization_endpoint: authorizePage || `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
    }
    if (url.pathname === '/register') return json(201, { ...JSON.parse(await body(req)), client_id: 'poise-client-1' })
    if (url.pathname === '/authorize') {
      // The provider's sign-in page approves at once and sends the browser back.
      const code = `code-${issued.size + 1}`
      issued.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')!, client: url.searchParams.get('client_id')! })
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', code); back.searchParams.set('state', url.searchParams.get('state')!)
      res.writeHead(302, { location: back.href }); return res.end()
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await body(req))
      if (form.get('grant_type') === 'authorization_code') {
        const grant = issued.get(form.get('code')!)
        const verifier = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
        if (!grant || grant.challenge !== verifier || grant.redirect !== form.get('redirect_uri') || grant.client !== form.get('client_id')) return json(400, { error: 'invalid_grant' })
        issued.delete(form.get('code')!)
      } else if (form.get('grant_type') !== 'refresh_token' || refuseRefresh) return json(400, { error: 'invalid_grant' })
      tokenCount++
      return json(200, { access_token: `access-token-${tokenCount}`, refresh_token: `refresh-token-${tokenCount}`, token_type: 'Bearer', expires_in: 3600 })
    }
    if (url.pathname === '/mcp') {
      if (!/^Bearer access-token-\d+$/.test(req.headers.authorization ?? '')) {
        return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
      }
      const server = new McpServer({ name: 'acme', version: '1.0.0' })
      server.registerTool('whoami', { description: 'Who the token belongs to.' }, async () => ({ content: [{ type: 'text', text: 'acme user' }] }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await server.connect(transport)
      const text = await body(req)
      await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined)
      return
    }
    json(404, {})
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise((resolve) => http.close(resolve)) })
beforeEach(() => { db.exec('DELETE FROM extension_servers'); refuseRefresh = false; authorizePage = '' })

function expireTokens(id: string): void {
  const stored = JSON.parse(readSecret(id, 'oauth:tokens')!)
  writeSecret(id, 'oauth:tokens', JSON.stringify({ ...stored, obtainedAt: 0 }))
}

describe('OAuth sign-in for a remote server', () => {
  it('detects the challenge, signs in, connects, delivers the token and renews it', async () => {
    const id = addServer(validateSpec({ name: 'acme', title: 'Acme', source: 'custom', transport: 'http', url: `${base}/mcp` }), {}, everywhere).id
    expect(await checkServer(id)).toMatchObject({ state: 'signin' })
    expect(serverView(id).auth).toBe('oauth')
    expect((await extensionsFor({ repo: 'acme/app' })).notices).toEqual(['Extensions: Acme needs a sign-in, so this chat runs without it. Sign in in Extensions; the next turn picks it up.'])

    const { authorizationUrl } = await startSignIn(id, ORIGIN)
    const authorize = new URL(authorizationUrl)
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${base}/authorize`)
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/extensions/oauth`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    const back = new URL((await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location')!)
    await finishSignIn({ code: back.searchParams.get('code'), state: back.searchParams.get('state') })
    expect(serverView(id).signedIn).toBe(true)

    expect(await checkServer(id)).toMatchObject({ state: 'connected', toolCount: 1, tools: [{ name: 'whoami', description: 'Who the token belongs to.' }] })
    expect((await extensionsFor({ repo: 'acme/app' })).servers[0].headers).toEqual({ Authorization: 'Bearer access-token-1' })
    expect(JSON.stringify(listServers())).not.toContain('access-token')
    expect(secretValues()).toEqual(expect.arrayContaining(['access-token-1', 'refresh-token-1']))

    expireTokens(id)
    expect(await accessToken(id)).toBe('access-token-2')
    refuseRefresh = true
    expireTokens(id)
    expect(await accessToken(id)).toBeNull()
    expect(serverView(id).signedIn).toBe(false)
  })

  it('keeps a working sign-in until a new one completes', async () => {
    const id = addServer(validateSpec({ name: 'acme', title: 'Acme', source: 'custom', transport: 'http', url: `${base}/mcp`, auth: 'oauth' }), {}, everywhere).id
    const first = await startSignIn(id, ORIGIN)
    const back = new URL((await fetch(first.authorizationUrl, { redirect: 'manual' })).headers.get('location')!)
    await finishSignIn({ code: back.searchParams.get('code'), state: back.searchParams.get('state') })
    const working = await accessToken(id)
    const again = await startSignIn(id, ORIGIN)
    expect(serverView(id).signedIn).toBe(true)
    expect(await accessToken(id)).toBe(working)
    await expect(finishSignIn({ state: new URL(again.authorizationUrl).searchParams.get('state'), error: 'access_denied' })).rejects.toThrow(/not completed/)
    expect(await accessToken(id)).toBe(working)
  })

  it('asks for a token, not a sign-in, when a 401 comes without OAuth metadata', async () => {
    const plain = createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"token required"}') })
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
    try {
      const id = addServer(validateSpec({ name: 'plain', title: 'Plain', source: 'custom', transport: 'http', url: `http://127.0.0.1:${(plain.address() as AddressInfo).port}/mcp` }), {}, everywhere).id
      expect(await checkServer(id)).toMatchObject({ state: 'failed', error: 'The server needs credentials (401) and offers no OAuth sign-in. Add its token or headers under Edit.' })
      expect(serverView(id).auth).toBe('none')
    } finally { await new Promise((resolve) => plain.close(resolve)) }
  })

  it('accepts a returning sign-in once, only for a flow it started, from an origin it can return to', async () => {
    const id = addServer(validateSpec({ name: 'acme', title: 'Acme', source: 'custom', transport: 'http', url: `${base}/mcp`, auth: 'oauth' }), {}, everywhere).id
    await expect(startSignIn(id, 'http://evil.example.test')).rejects.toThrow(/HTTPS origin, or HTTP on localhost/)
    await expect(finishSignIn({ code: 'code-1', state: 'not-a-flow' })).rejects.toThrow(/unknown or already finished/)
    const { authorizationUrl } = await startSignIn(id, ORIGIN)
    const back = new URL((await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location')!)
    const returned = { code: back.searchParams.get('code'), state: back.searchParams.get('state') }
    await finishSignIn(returned)
    await expect(finishSignIn(returned)).rejects.toThrow(/unknown or already finished/)
    const denied = await startSignIn(id, ORIGIN)
    await expect(finishSignIn({ state: new URL(denied.authorizationUrl).searchParams.get('state'), error: 'access_denied' })).rejects.toThrow(/not completed \(access_denied\)/)
  })

  it('never sends the browser to a sign-in page that is not a web page', async () => {
    authorizePage = 'javascript:alert(document.domain)//'
    const id = addServer(validateSpec({ name: 'acme', title: 'Acme', source: 'custom', transport: 'http', url: `${base}/mcp`, auth: 'oauth' }), {}, everywhere).id
    // The SDK's metadata schema refuses it first; Poise's own check is the second guard.
    await expect(startSignIn(id, ORIGIN)).rejects.toThrow(/sign-in could not start|not an HTTPS address/)
    expect(readSecret(id, 'oauth:flow')).toBeNull()
  })
})

describe('checking a local server', () => {
  const fixture = join(process.cwd(), 'tests/fixtures/extensions/stdio-server.mjs')

  it('starts it with its environment and lists its tools', async () => {
    const id = addServer(validateSpec({ name: 'fixture', source: 'custom', transport: 'stdio', command: process.execPath, args: [fixture], env: [{ name: 'PROBE_TOKEN', secret: true }] }), { 'env:PROBE_TOKEN': 'probe-secret-123' }, everywhere).id
    const status = await checkServer(id)
    expect(status).toMatchObject({ state: 'connected', toolCount: 2 })
    expect(status.tools!.map((tool) => tool.name)).toEqual(['echo_token', 'ping'])
  }, 30_000)

  it('finishes quietly when the server is removed while it runs', async () => {
    const id = addServer(validateSpec({ name: 'fixture', source: 'custom', transport: 'stdio', command: process.execPath, args: [fixture] }), {}, everywhere).id
    const check = checkServer(id)
    deleteServer(id)
    await expect(check).resolves.toMatchObject({ state: 'connected' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM extension_events WHERE server_id = ?').get(id)).toEqual({ n: 0 })
  }, 30_000)

  it('reports why it failed, with its secrets scrubbed from the output', async () => {
    const id = addServer(validateSpec({ name: 'broken', source: 'custom', transport: 'stdio', command: process.execPath, args: ['-e', "process.stderr.write('bad token ' + process.env.PROBE_TOKEN + '\\n'); process.exit(3)"], env: [{ name: 'PROBE_TOKEN', secret: true }] }), { 'env:PROBE_TOKEN': 'probe-secret-456' }, everywhere).id
    const status = await checkServer(id)
    expect(status.state).toBe('failed')
    expect(status.error).toContain('bad token [redacted]')
    expect(JSON.stringify(serverView(id))).not.toContain('probe-secret-456')
  }, 30_000)
})
