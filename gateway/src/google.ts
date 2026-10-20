import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pagePrincipal } from './auth.js'
import type { Context } from './context.js'
import { header, HttpError, readBody, redirect, sendJson } from './http.js'
import { GOOGLE_SCOPES, googleIdentity, GoogleGrantExpired, googleTokenRequest } from './google-provider.js'
import { GoogleCipherError, GoogleVault } from './google-vault.js'
import type { Session, User } from './store.js'

const FLOW_TTL = 10 * 60_000, OPERATION_TTL = 20 * 60_000
const hash = (value: string) => createHash('sha256').update(value).digest('base64url')
const secret = () => randomBytes(32).toString('base64url')
const PURPOSES = ['accounts', 'connect', 'callback', 'disconnect', 'sync', 'publish', 'review', 'import'] as const
type Purpose = typeof PURPOSES[number]
interface Grant { accessToken: string; refreshToken: string; expires: number }
interface Account { id: string; email: string; state: 'connected' | 'expired' | 'disconnected'; version: string; clientId: string; grant: string | null }
interface Operation { session: string; purpose: Purpose; expires: number }
interface Principal { owner: User; session: Session; parent: Session; operation: Operation; key: string }
export interface GoogleCompletion { outcome: 'connected' | 'cancelled' | 'failed'; accountId?: string; message?: string }
interface Flow {
  handle: string; session: string; parent: string; browser: string; verifier: string; client: string;
  epoch: number; expires: number; expected: string | null; versions: Record<string, string>;
  stage: 'created' | 'started' | 'exchanging' | 'ready'; result?: string;
}
interface Result extends GoogleCompletion { email?: string; grant?: Grant }

function field(input: Record<string, unknown>, name: string, pattern = /^[A-Za-z0-9_-]{1,128}$/): string {
  const value = input[name]
  if (typeof value !== 'string' || !pattern.test(value)) throw new HttpError(400, `A valid Google ${name} is required.`)
  return value
}
function parseObject(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { throw new HttpError(400, 'A Google action object is required.') }
  throw new HttpError(400, 'A Google action object is required.')
}

export class GoogleConnections {
  private readonly vault: GoogleVault
  private readonly refreshes = new Map<string, Promise<string>>()
  constructor(private readonly ctx: Context) { this.vault = new GoogleVault(join(ctx.deps.config.dataDir, 'google-connections.sqlite3'), ctx.deps.keys.privateKey) }
  close(): void { this.vault.close() }
  private now(): number { return this.ctx.deps.now() }
  private configuration() {
    const config = this.ctx.deps.config.google
    if (!config) throw new HttpError(422, 'Google connections are unavailable. Ask the Poise operator to enable Google.')
    return config
  }
  private fingerprint(): string { const c = this.configuration(); return hash(c.clientId + '\0' + c.clientSecret) }
  private session(ownerId: number, sessionHash: string): { owner: User; session: Session; parent: Session } {
    const session = this.ctx.deps.store.sessionByHash(sessionHash)
    const parent = session?.parentHash ? this.ctx.deps.store.sessionByHash(session.parentHash) : null
    const owner = session ? this.ctx.deps.store.getUser(session.handle) : null
    if (!session || session.kind !== 'workspace' || session.host !== session.handle || !parent || parent.kind !== 'apex' || parent.handle !== session.handle || !owner || owner.githubId !== ownerId || !this.ctx.isAllowed(owner)) throw new HttpError(401, 'The sign-in that started this Google action has ended. Sign in again.')
    return { owner, session, parent }
  }
  private current(p: Principal): void {
    if (p.operation.expires <= this.now() || !this.vault.get<Operation>('operation', p.owner.githubId, p.key)) throw new HttpError(401, 'This Google action expired. Review the destination before trying again.')
    this.session(p.owner.githubId, p.operation.session)
  }
  private admitted(token: string): { owner: User; session: Session; parent: Session; jti: string } {
    try {
      if (token.length > 4096) throw new Error('size')
      const parts = token.split('.')
      if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw new Error('shape')
      const h = parseObject(Buffer.from(parts[0], 'base64url').toString('utf8'))
      if (h.alg !== 'EdDSA' || h.typ !== 'JWT' || Buffer.from(parts[2], 'base64url').length !== 64 || !verify(null, Buffer.from(parts[0] + '.' + parts[1]), createPublicKey(this.ctx.deps.keys.privateKey), Buffer.from(parts[2], 'base64url'))) throw new Error('signature')
      const c = parseObject(Buffer.from(parts[1], 'base64url').toString('utf8'))
      const now = this.now() / 1000
      if (c.iss !== 'poise-gateway' || c.scope !== 'browser' || typeof c.aud !== 'string' || !/^workspace:[a-z0-9-]{1,39}$/.test(c.aud) || typeof c.sub !== 'string' || typeof c.iat !== 'number' || typeof c.exp !== 'number' || !Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.exp <= c.iat || c.exp - c.iat > 120 || c.iat > now + 5 || c.exp <= now || typeof c.jti !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(c.jti) || typeof c.sid !== 'string' || !/^[a-f0-9]{64}$/.test(c.sid)) throw new Error('claims')
      const owner = this.ctx.deps.store.getUser(c.aud.slice('workspace:'.length))
      if (!owner || owner.login.toLowerCase() !== c.sub.toLowerCase()) throw new Error('owner')
      return { ...this.session(owner.githubId, c.sid), jti: c.jti }
    } catch { throw new HttpError(401, 'A current browser sign-in is required for this Google action.') }
  }
  private open(token: string, input: Record<string, unknown>) {
    const identity = this.admitted(token)
    if (!PURPOSES.includes(input.purpose as Purpose)) throw new HttpError(400, 'A known Google operation purpose is required.')
    return this.vault.transaction(() => {
      this.vault.prune(this.now())
      const owner = identity.owner.githubId
      if (this.vault.get('admission', owner, identity.jti)) throw new HttpError(401, 'This Google request was already admitted.')
      if (this.vault.count('operation', owner) >= 10) throw new HttpError(429, 'Too many Google actions are active. Wait for one to finish.')
      const operationToken = secret(), expiresAt = this.now() + OPERATION_TTL
      this.vault.put('operation', owner, hash(operationToken), { session: identity.session.idHash, purpose: input.purpose, expires: expiresAt }, expiresAt)
      this.vault.put('admission', owner, identity.jti, {}, expiresAt)
      return { operationToken, expiresAt, settings: this.settings(owner) }
    })
  }
  private principal(token: string): Principal {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'A private Google operation is required.')
    const key = hash(token), found = this.vault.find<Operation>('operation', key)
    if (!found || found.value.expires <= this.now()) throw new HttpError(401, 'This Google action expired. Review the destination before trying again.')
    return { ...this.session(found.owner, found.value.session), operation: found.value, key }
  }
  private settings(owner: number) {
    const clientId = this.ctx.deps.config.google?.clientId
    const accounts = this.vault.list<Account>('account', owner).map(a => {
      if (a.state === 'connected' && a.grant) {
        try { this.vault.unseal<Grant>(a.grant, `account:${owner}:${a.id}`) }
        catch (error) { if (!(error instanceof GoogleCipherError)) throw error; a = { ...a, state: 'expired', grant: null, version: randomUUID() }; this.vault.put('account', owner, a.id, a) }
      }
      const connected = !!clientId && clientId === a.clientId && a.state === 'connected' && !!a.grant
      return { id: a.id, email: a.email, connected, state: a.state === 'disconnected' ? 'disconnected' : connected ? 'connected' : 'expired', connectionVersion: `${this.vault.epoch(owner)}:${a.version}` }
    })
    return { configured: !!clientId, accounts }
  }
  private begin(p: Principal, input: Record<string, unknown>) {
    const browser = field(input, 'browserSecret', /^[A-Za-z0-9_-]{43,128}$/)
    const expected = input.accountId === undefined ? null : field(input, 'accountId')
    return this.vault.transaction(() => {
      this.current(p); this.vault.prune(this.now())
      if (this.vault.count('flow', p.owner.githubId) >= 10) throw new HttpError(429, 'Too many Google sign-ins are pending. Finish one or wait ten minutes.')
      const state = secret(), key = hash(state), verifier = randomBytes(48).toString('base64url')
      const versions = Object.fromEntries(this.vault.list<Account>('account', p.owner.githubId).map(a => [a.id, a.version]))
      const flow: Flow = { handle: p.owner.handle, session: p.session.idHash, parent: p.parent.idHash, browser: hash(browser), verifier: this.vault.seal(verifier, `verifier:${p.owner.githubId}:${key}`), client: this.fingerprint(), epoch: this.vault.epoch(p.owner.githubId), expires: this.now() + FLOW_TTL, expected, versions, stage: 'created' }
      this.vault.put('flow', p.owner.githubId, key, flow, flow.expires)
      // Only the gateway later adds the client and PKCE challenge to Google's URL.
      return { url: `${this.ctx.apexOrigin}/auth/google/start?state=${state}` }
    })
  }
  private flow(state: string): { owner: number; value: Flow; key: string } {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new HttpError(403, 'Google sign-in expired or belongs to another browser. Connect again.')
    const key = hash(state), found = this.vault.find<Flow>('flow', key)
    if (!found || found.value.expires <= this.now() || found.value.epoch !== this.vault.epoch(found.owner) || found.value.client !== this.fingerprint()) throw new HttpError(403, 'Google sign-in expired or connections changed. Connect again.')
    this.session(found.owner, found.value.session)
    return { ...found, key }
  }
  start(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const principal = pagePrincipal(this.ctx, req, res, url)
    if (!principal) return
    const state = url.searchParams.get('state') ?? '', config = this.configuration()
    const verifier = this.vault.transaction(() => {
      const f = this.flow(state)
      if (principal.user.githubId !== f.owner || principal.session.idHash !== f.value.parent || f.value.stage !== 'created') throw new HttpError(403, 'This Google sign-in belongs to another login or was already started.')
      const value = this.vault.unseal<string>(f.value.verifier, `verifier:${f.owner}:${f.key}`)
      this.vault.put('flow', f.owner, f.key, { ...f.value, stage: 'started' }, f.value.expires)
      return value
    })
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: this.ctx.apexOrigin + '/auth/google/callback', response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state, code_challenge: hash(verifier), code_challenge_method: 'S256' })
    redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302, { 'referrer-policy': 'no-referrer' })
  }
  async callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const principal = this.ctx.apexPrincipal(req), state = url.searchParams.get('state') ?? ''
    const f = this.vault.transaction(() => {
      const found = this.flow(state)
      if (!principal || principal.user.githubId !== found.owner || principal.session.idHash !== found.value.parent || found.value.stage !== 'started') throw new HttpError(403, 'Google sign-in could not be verified in this login. Connect again.')
      this.vault.put('flow', found.owner, found.key, { ...found.value, stage: 'exchanging' }, found.value.expires)
      return found
    })
    const config = this.configuration()
    let result: Result
    if (url.searchParams.get('error') === 'access_denied') result = { outcome: 'cancelled' }
    else if (url.searchParams.has('error')) result = { outcome: 'failed', message: 'Google did not complete sign-in. Connect again.' }
    else {
      try {
        const code = url.searchParams.get('code')
        if (!code || code.length > 4096) throw new HttpError(400, 'Google returned no usable sign-in code.')
        const verifier = this.vault.unseal<string>(f.value.verifier, `verifier:${f.owner}:${f.key}`)
        const tokens = await googleTokenRequest({ grant_type: 'authorization_code', code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: this.ctx.apexOrigin + '/auth/google/callback', code_verifier: verifier })
        this.flow(state)
        if (!tokens.scope?.split(' ').includes(GOOGLE_SCOPES[2])) throw new HttpError(403, 'Google Drive file access was not granted.')
        const identity = await googleIdentity(tokens.access_token)
        this.flow(state)
        if (f.value.expected && identity.id !== f.value.expected) throw new HttpError(403, 'Choose the same Google account when reconnecting.')
        const previous = this.vault.get<Account>('account', f.owner, identity.id)
        const prior = previous?.clientId === config.clientId && previous.grant ? this.vault.unseal<Grant>(previous.grant, `account:${f.owner}:${identity.id}`) : null
        const refreshToken = tokens.refresh_token ?? prior?.refreshToken
        if (!refreshToken) throw new HttpError(422, 'Google did not grant offline access. Connect again and grant consent.')
        result = { outcome: 'connected', accountId: identity.id, email: identity.email, grant: { accessToken: tokens.access_token, refreshToken, expires: this.now() + tokens.expires_in * 1000 } }
      } catch (error) {
        result = { outcome: 'failed', message: error instanceof HttpError ? error.message : 'Google sign-in could not be completed. Connect again.' }
      }
    }
    this.vault.transaction(() => {
      const current = this.flow(state)
      if (current.value.stage !== 'exchanging') throw new HttpError(409, 'Google sign-in changed while completing.')
      this.vault.put('flow', f.owner, f.key, { ...current.value, stage: 'ready', verifier: '', result: this.vault.seal(result, `result:${f.owner}:${f.key}`) }, f.value.expires)
    })
    redirect(res, `${this.ctx.workspaceOrigin(f.value.handle)}/?google_state=${state}`, 302, { 'referrer-policy': 'no-referrer' })
  }
  private finish(p: Principal, input: Record<string, unknown>): GoogleCompletion {
    const state = field(input, 'state', /^[A-Za-z0-9_-]{43}$/), browser = field(input, 'browserSecret', /^[A-Za-z0-9_-]{43,128}$/)
    return this.vault.transaction(() => {
      this.current(p)
      const f = this.flow(state)
      if (f.owner !== p.owner.githubId || f.value.parent !== p.parent.idHash || f.value.browser !== hash(browser) || f.value.stage !== 'ready' || !f.value.result) throw new HttpError(403, 'Google sign-in belongs to another browser or is not ready.')
      const result = this.vault.unseal<Result>(f.value.result, `result:${f.owner}:${f.key}`)
      if (result.outcome === 'connected' && result.accountId && result.email && result.grant) {
        const id = result.accountId, existing = this.vault.get<Account>('account', f.owner, id)
        if (existing?.version !== (Object.hasOwn(f.value.versions, id) ? f.value.versions[id] : undefined)) throw new HttpError(409, 'This Google connection changed during sign-in. Connect again.')
        const clientId = this.configuration().clientId
        const connected = (a: Account) => a.state === 'connected' && a.clientId === clientId && !!a.grant
        if ((!existing || !connected(existing)) && this.vault.list<Account>('account', f.owner).filter(connected).length >= 10) throw new HttpError(429, 'At most ten Google accounts can be connected.')
        this.vault.put('account', f.owner, id, { id, email: result.email, state: 'connected', clientId, version: randomUUID(), grant: this.vault.seal(result.grant, `account:${f.owner}:${id}`) } satisfies Account)
      } else if (result.outcome === 'connected') throw new HttpError(422, 'Google sign-in returned no usable connection. Connect again.')
      this.vault.remove('flow', f.owner, f.key)
      return { outcome: result.outcome, ...(result.accountId ? { accountId: result.accountId } : {}), ...(result.message ? { message: result.message } : {}) }
    })
  }
  private disconnect(p: Principal, input: Record<string, unknown>) {
    const id = field(input, 'accountId')
    return this.vault.transaction(() => {
      this.current(p)
      const a = this.vault.get<Account>('account', p.owner.githubId, id)
      if (!a) throw new HttpError(404, 'This Google account is not connected here.')
      this.vault.bump(p.owner.githubId)
      this.vault.put('account', p.owner.githubId, id, { ...a, state: 'disconnected', version: randomUUID(), grant: null })
      return this.settings(p.owner.githubId)
    })
  }
  private async token(p: Principal, input: Record<string, unknown>): Promise<{ accessToken: string }> {
    const id = field(input, 'accountId'), config = this.configuration(), owner = p.owner.githubId, fingerprint = this.fingerprint()
    const a = this.vault.get<Account>('account', owner, id)
    if (!a || a.state !== 'connected' || !a.grant || a.clientId !== config.clientId) throw new HttpError(422, 'Reconnect this Google account in Accounts.')
    const version = `${this.vault.epoch(owner)}:${a.version}`
    if (input.connectionVersion !== version) throw new HttpError(409, 'The Google connection changed. Review the destination again.')
    const grant = this.vault.unseal<Grant>(a.grant, `account:${owner}:${id}`)
    const unchanged = () => {
      this.current(p)
      if (this.fingerprint() !== fingerprint) throw new HttpError(409, 'Google configuration changed during this action. Connect again.')
      const live = this.vault.get<Account>('account', owner, id)
      if (!live || `${this.vault.epoch(owner)}:${live.version}` !== version || live.state !== 'connected') throw new HttpError(409, 'The Google connection changed during this action.')
    }
    unchanged()
    if (grant.expires > this.now() + 60_000 && input.forceRefresh !== true) return { accessToken: grant.accessToken }
    const key = `${owner}:${id}:${version}`
    let operation = this.refreshes.get(key)
    if (!operation) {
      operation = (async () => {
        try {
          const tokens = await googleTokenRequest({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: config.clientId, client_secret: config.clientSecret })
          this.vault.transaction(() => {
            unchanged()
            const replacement = { ...a, grant: this.vault.seal({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? grant.refreshToken, expires: this.now() + tokens.expires_in * 1000 }, `account:${owner}:${id}`) }
            if (!this.vault.replace('account', owner, id, a, replacement)) throw new HttpError(409, 'The Google grant changed during refresh.')
          })
          return tokens.access_token
        } catch (error) {
          this.vault.transaction(() => {
            unchanged()
            if (error instanceof GoogleGrantExpired && !this.vault.replace('account', owner, id, a, { ...a, state: 'expired', version: randomUUID(), grant: null })) throw new HttpError(409, 'The Google grant changed during refresh.')
          })
          throw error
        }
      })()
      this.refreshes.set(key, operation)
    }
    try {
      const accessToken = await operation
      unchanged()
      return { accessToken }
    } finally { if (this.refreshes.get(key) === operation) this.refreshes.delete(key) }
  }
  async api(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (header(req, 'origin') || header(req, 'content-type').split(';')[0] !== 'application/json') throw new HttpError(403, 'Google delegation is available only to the workspace server.')
    const authorization = header(req, 'authorization')
    if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'A private Google delegation is required.')
    const token = authorization.slice(7), input = parseObject((await readBody(req, 16 * 1024)).toString('utf8'))
    if (input.action === 'open') { sendJson(res, 200, this.open(token, input)); return }
    // Cleanup is harmless after a login ends and discloses no account information.
    if (input.action === 'close') {
      const found = /^[A-Za-z0-9_-]{43}$/.test(token) ? this.vault.find<Operation>('operation', hash(token)) : null
      if (found) this.vault.remove('operation', found.owner, hash(token))
      sendJson(res, 200, { ok: true }); return
    }
    const p = this.principal(token), action = input.action
    const allowed = action === 'settings' || (action === 'begin' && p.operation.purpose === 'connect') || (action === 'finish' && p.operation.purpose === 'callback') || (action === 'disconnect' && p.operation.purpose === 'disconnect') || (action === 'token' && ['sync', 'publish', 'review', 'import'].includes(p.operation.purpose))
    if (!allowed) throw new HttpError(403, 'This Google action was not admitted for that purpose.')
    const result = action === 'settings' ? this.settings(p.owner.githubId) : action === 'begin' ? this.begin(p, input) : action === 'finish' ? this.finish(p, input) : action === 'disconnect' ? this.disconnect(p, input) : await this.token(p, input)
    this.current(p)
    sendJson(res, 200, result)
  }
}

export const api = (ctx: Context, req: IncomingMessage, res: ServerResponse) => ctx.googleConnections.api(req, res)
export const start = (ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) => ctx.googleConnections.start(req, res, url)
export const callback = (ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) => ctx.googleConnections.callback(req, res, url)
