import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pagePrincipal, postPrincipal } from './auth.js'
import { signAssertion } from './assertion.js'
import type { Context } from './context.js'
import { header, HttpError, readBody, readForm, redirect, safeEqual, sendHtml, sendJson } from './http.js'
import { MCP_READ_PATH, MCP_RESPONSE_BYTES, MCP_SCOPE, MCP_TOOLS, parseMcpRead, type McpGrantScope, type McpRead } from './mcp-contract.js'
import { McpGrants, type McpGrant } from './mcp-grants.js'
import { html, page } from './pages.js'
import { hashSecret, newSecret, type User } from './store.js'

interface Authorization { client: string; redirect: string; challenge: string; state: string }
interface Code extends Authorization { scope: Omit<McpGrantScope, 'grantId'>; expires: number }
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
const INSTRUCTIONS = 'Use poise_describe to identify the authorized workspace and its available tools.'

export class McpGateway {
  readonly grants: McpGrants
  private readonly codes = new Map<string, Code>()
  private readonly reads = new Map<string, { minute: number; count: number; active: number }>()
  constructor(private readonly ctx: Context) {
    this.grants = new McpGrants(join(ctx.deps.config.dataDir, 'mcp.db'), ctx.deps.now)
  }
  close(): void { this.grants.close() }
  private get resource(): string { return `${this.ctx.apexOrigin}/mcp` }
  private owner(grant: McpGrant | Omit<McpGrantScope, 'grantId'>): User {
    const owner = this.ctx.deps.store.getUser(grant.handle)
    if (!owner || owner.githubId !== grant.ownerId || grant.resource !== this.resource || !this.ctx.isAllowed(owner)) throw new HttpError(401, 'invalid_grant')
    return owner
  }
  private authorization(params: URLSearchParams): Authorization {
    for (const key of params.keys()) if (params.getAll(key).length !== 1 || !['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource'].includes(key)) throw new HttpError(400, 'invalid_request')
    const client = params.get('client_id') ?? '', redirect = params.get('redirect_uri') ?? '', challenge = params.get('code_challenge') ?? ''
    if (!this.grants.redirects(client).includes(redirect) || params.get('response_type') !== 'code'
      || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      || params.get('scope') !== MCP_SCOPE || params.get('resource') !== this.resource || (params.get('state')?.length ?? 0) > 512) throw new HttpError(400, 'invalid_request')
    return { client, redirect, challenge, state: params.get('state') ?? '' }
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try { await this.route(req, res, url) } catch (error) {
      if (!(error instanceof HttpError)) throw error
      sendJson(res, error.status, { error: error.message }, error.status === 401 ? {
        'www-authenticate': `Bearer resource_metadata="${this.ctx.apexOrigin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
      } : {})
    }
  }
  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { ctx } = this
    if (header(req, 'origin') && header(req, 'origin') !== ctx.apexOrigin) throw new HttpError(403, 'origin_not_allowed')
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' && req.method === 'GET') return sendJson(res, 200, {
      resource: this.resource, authorization_servers: [ctx.apexOrigin], scopes_supported: [MCP_SCOPE], bearer_methods_supported: ['header'],
    })
    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') return sendJson(res, 200, {
      issuer: ctx.apexOrigin, authorization_endpoint: `${ctx.apexOrigin}/mcp/authorize`, token_endpoint: `${ctx.apexOrigin}/mcp/token`,
      registration_endpoint: `${ctx.apexOrigin}/mcp/register`, revocation_endpoint: `${ctx.apexOrigin}/mcp/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [MCP_SCOPE],
    })
    if (url.pathname === '/mcp/register' && req.method === 'POST') {
      if (header(req, 'content-type').split(';')[0] !== 'application/json') throw new HttpError(415, 'invalid_request')
      const text = (await readBody(req, 16 * 1024)).toString()
      let body: unknown
      try { body = JSON.parse(text) } catch { throw new HttpError(400, 'invalid_request') }
      if (!body || typeof body !== 'object' || !('redirect_uris' in body) || !Array.isArray(body.redirect_uris)
        || !body.redirect_uris.length || body.redirect_uris.length > 5
        || ('token_endpoint_auth_method' in body && body.token_endpoint_auth_method !== 'none')) throw new HttpError(400, 'invalid_client_metadata')
      const redirects = body.redirect_uris.map((value: unknown) => {
        if (typeof value !== 'string' || value.length > 1024) throw new HttpError(400, 'invalid_redirect_uri')
        let parsed: URL
        try { parsed = new URL(value) } catch { throw new HttpError(400, 'invalid_redirect_uri') }
        if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== 'https:'
          && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))) throw new HttpError(400, 'invalid_redirect_uri')
        return value
      })
      const client = this.grants.register(redirects)
      return sendJson(res, 201, { client_id: client, redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
    }
    if (url.pathname === '/mcp/authorize' && req.method === 'GET') {
      const authorization = this.authorization(url.searchParams)
      const principal = pagePrincipal(ctx, req, res, url)
      if (!principal) return
      return sendHtml(res, 200, page('Connect Poise', html`<div class="card"><h1>Connect this agent to Poise?</h1>
        <p>Grant read access to ${principal.user.login}'s workspace at ${ctx.workspaceOrigin(principal.user.handle)}.</p>
        <p>Client ${authorization.client}. Return to ${authorization.redirect}. Allowed tool: poise_describe (workspace identity and capabilities only).</p>
        <form method="post" action="/mcp/authorize"><input type="hidden" name="csrf" value="${principal.session.csrf}">
        <input type="hidden" name="request" value="${url.searchParams.toString()}">
        <button name="decision" value="approve">Allow read access</button><button name="decision" value="deny">Deny</button></form></div>`), ctx.pageHeaders)
    }
    if (url.pathname === '/mcp/authorize' && req.method === 'POST') {
      const principal = postPrincipal(ctx, req), form = await readForm(req)
      ctx.verifyForm(req, form, principal.session, ctx.apexOrigin)
      const auth = this.authorization(new URLSearchParams(form.get('request') ?? ''))
      const target = new URL(auth.redirect)
      if (auth.state) target.searchParams.set('state', auth.state)
      if (form.get('decision') === 'deny') target.searchParams.set('error', 'access_denied')
      else {
        if (form.get('decision') !== 'approve') throw new HttpError(400, 'invalid_request')
        for (const [key, value] of this.codes) if (value.expires <= ctx.deps.now()) this.codes.delete(key)
        if (this.codes.size >= 256) throw new HttpError(429, 'too_many_requests')
        const code = newSecret()
        this.codes.set(hashSecret(code), { ...auth, expires: ctx.deps.now() + 60_000,
          scope: { resource: this.resource, handle: principal.user.handle, ownerId: principal.user.githubId } })
        target.searchParams.set('code', code)
      }
      return redirect(res, target.href, 303)
    }
    if (url.pathname === '/mcp/token' && req.method === 'POST') {
      const form = await readForm(req), client = form.get('client_id') ?? ''
      if (form.get('scope') !== null && form.get('scope') !== MCP_SCOPE) throw new HttpError(400, 'invalid_scope')
      if (form.get('grant_type') === 'authorization_code') {
        const key = hashSecret(form.get('code') ?? ''), code = this.codes.get(key)
        this.codes.delete(key)
        const verifier = form.get('code_verifier') ?? ''
        if (!code || code.expires <= ctx.deps.now() || client !== code.client || form.get('redirect_uri') !== code.redirect
          || form.get('resource') !== code.scope.resource || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
          || !safeEqual(Buffer.from(hashSecret(verifier), 'hex').toString('base64url'), code.challenge)) throw new HttpError(400, 'invalid_grant')
        this.owner(code.scope)
        return sendJson(res, 200, this.grants.create(code.scope, client))
      }
      if (form.get('grant_type') === 'refresh_token') {
        const grant = this.grants.find(form.get('refresh_token') ?? '', 'refresh')
        if (!grant || grant.clientId !== client || (form.has('resource') && form.get('resource') !== grant.resource)) throw new HttpError(400, 'invalid_grant')
        this.owner(grant)
        return sendJson(res, 200, this.grants.refresh(grant))
      }
      throw new HttpError(400, 'unsupported_grant_type')
    }
    if (url.pathname === '/mcp/revoke' && req.method === 'POST') {
      const form = await readForm(req), token = form.get('token') ?? ''
      const grant = this.grants.find(token, 'refresh') ?? this.grants.find(token, 'access')
      if (grant && grant.clientId === form.get('client_id')) this.grants.revoke(grant.ownerId, grant.grantId)
      return sendJson(res, 200, {})
    }
    if (url.pathname === '/mcp/grants') {
      if (req.method === 'GET') {
        const principal = pagePrincipal(ctx, req, res, url)
        if (!principal) return
        const grants = this.grants.list(principal.user.githubId)
        return sendHtml(res, 200, page('Connected agents', html`<div class="card"><h1>Connected agents</h1><p>Read grants for ${principal.user.login}'s workspace.</p>
          ${grants.map(grant => html`<div><p>Client ${grant.clientId} · ${grant.revokedAt ? 'Revoked' : grant.expiresAt <= ctx.deps.now() ? 'Expired' : 'Active'} · expires ${new Date(grant.expiresAt).toISOString()}</p>
            <form method="post" action="/mcp/grants"><input type="hidden" name="csrf" value="${principal.session.csrf}">
            <input type="hidden" name="id" value="${grant.grantId}"><button>Revoke</button></form></div>`)}</div>`), ctx.pageHeaders)
      }
      if (req.method === 'POST') {
        const principal = postPrincipal(ctx, req), form = await readForm(req)
        ctx.verifyForm(req, form, principal.session, ctx.apexOrigin)
        this.grants.revoke(principal.user.githubId, form.get('id') ?? '')
        return redirect(res, '/mcp/grants', 303)
      }
    }
    if (url.pathname !== '/mcp') throw new HttpError(404, 'not_found')
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header(req, 'authorization'))?.[1]
    const grant = token ? this.grants.find(token, 'access') : null
    if (!grant) throw new HttpError(401, 'invalid_token')
    const owner = this.owner(grant)
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); throw new HttpError(405, 'method_not_allowed') }
    if (header(req, 'content-type').split(';')[0] !== 'application/json') throw new HttpError(415, 'invalid_request')
    if (header(req, 'mcp-protocol-version') && !VERSIONS.includes(header(req, 'mcp-protocol-version'))) throw new HttpError(400, 'unsupported_protocol_version')
    const text = (await readBody(req, 16 * 1024)).toString()
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new HttpError(400, 'invalid_request') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_request')
    const rpc = value as Record<string, unknown>, id = rpc.id
    if (rpc.jsonrpc !== '2.0' || (id !== undefined && typeof id !== 'string' && typeof id !== 'number')) throw new HttpError(400, 'invalid_request')
    if (id === undefined) {
      if (rpc.method !== 'notifications/initialized' && rpc.method !== 'notifications/cancelled') throw new HttpError(400, 'unsupported_notification')
      res.writeHead(202); res.end(); return
    }
    const result = (body: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id, result: body })
    if (rpc.method === 'initialize') return result({ protocolVersion: VERSIONS.includes(String((rpc.params as { protocolVersion?: unknown } | undefined)?.protocolVersion))
      ? (rpc.params as { protocolVersion: string }).protocolVersion : VERSIONS[0], capabilities: { tools: {} },
      serverInfo: { name: 'poise', version: '1.0.0' }, instructions: INSTRUCTIONS })
    if (rpc.method === 'ping') return result({})
    if (rpc.method === 'tools/list') return result({ tools: MCP_TOOLS })
    if (rpc.method !== 'tools/call') return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported method' } })
    let read: McpRead
    try {
      const params = rpc.params as Record<string, unknown> | undefined
      read = parseMcpRead(params && { name: params.name, arguments: params.arguments })
    } catch (error) { return result({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'invalid tool request' }] }) }
    const minute = Math.floor(ctx.deps.now() / 60_000)
    for (const [key, value] of this.reads) if (value.minute !== minute && !value.active) this.reads.delete(key)
    const rate = this.reads.get(grant.grantId) ?? { minute, count: 0, active: 0 }
    if (rate.minute !== minute) Object.assign(rate, { minute, count: 0 })
    if (rate.active >= 2 || rate.count >= 60) throw new HttpError(429, 'too_many_requests')
    rate.active++; rate.count++; this.reads.set(grant.grantId, rate)
    try {
      const body = await this.dispatch(owner, grant, read)
      // Revocation/access changes during an upstream read must also withhold its result.
      if (!this.grants.find(token!, 'access')) throw new HttpError(401, 'invalid_token')
      this.owner(grant)
      return result({ content: [{ type: 'text', text: JSON.stringify(body) }] })
    } finally { rate.active-- }
  }
  private async dispatch(owner: User, grant: McpGrant, read: McpRead): Promise<Record<string, unknown>> {
    const { ctx } = this
    await ctx.deps.orchestrator.ensureStarted(owner.handle, owner.login)
    const target = ctx.deps.upstream(owner.handle), payload = JSON.stringify(read)
    const scope: McpGrantScope = { resource: grant.resource, ownerId: grant.ownerId, handle: grant.handle, grantId: grant.grantId }
    const identity = signAssertion(ctx.deps.keys.privateKey, { handle: owner.handle, login: owner.login, scope: 'mcp', mcp: scope }, ctx.deps.now())
    const text = await new Promise<string>((resolve, reject) => {
      const upstream = http.request({ ...target, method: 'POST', path: MCP_READ_PATH, agent: ctx.agent, headers: {
        host: new URL(ctx.workspaceOrigin(owner.handle)).host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-poise-identity': identity,
      } }, response => {
        const chunks: Buffer[] = []; let bytes = 0
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MCP_RESPONSE_BYTES) upstream.destroy(new Error('MCP workspace response exceeds its bound')); else chunks.push(chunk) })
        response.on('error', reject)
        response.on('end', () => response.statusCode === 200 ? resolve(Buffer.concat(chunks).toString()) : reject(new HttpError(503, 'workspace_read_unavailable')))
      })
      const deadline = setTimeout(() => upstream.destroy(new HttpError(504, 'workspace_read_timeout')), 35_000)
      upstream.on('close', () => clearTimeout(deadline)); upstream.on('error', reject); upstream.end(payload)
    })
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, 'invalid_workspace_response')
    const body = value as Record<string, unknown>
    if (body.workspace !== owner.handle) throw new HttpError(502, 'wrong_workspace_response')
    if (body.owner !== owner.login || !body.capabilities || typeof body.capabilities !== 'object'
      || !('tools' in body.capabilities) || !Array.isArray(body.capabilities.tools)
      || body.capabilities.tools.length !== 1 || body.capabilities.tools[0] !== 'poise_describe') throw new HttpError(502, 'invalid_workspace_capabilities')
    // Project only the connection contract, even if an upstream returns additional data.
    return { workspace: owner.handle, owner: owner.login, capabilities: { tools: ['poise_describe'] } }
  }
}

export function isMcpPath(path: string): boolean {
  return path === '/mcp' || path.startsWith('/mcp/') || path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-authorization-server'
}
