import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { db, getMeta, setMeta } from '../db'
import { HttpError } from '../http'
import { isServiceMode } from '../service/config'
import { googleRequest, serviceConnectionVersion, type GoogleCompletion } from './service'

const CONFIG = 'google:config'
const PREFIX = 'google:account:'
const STATE = 'google:state:'
const EPOCH = 'google:connections-epoch'
const connectionEpoch = () => Number(getMeta(EPOCH) ?? '0')
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file']
export interface GoogleAccount { id: string, email: string, connected: boolean, state?: 'connected' | 'expired' | 'disconnected' }
interface StoredAccount extends GoogleAccount { refreshToken: string, accessToken: string, expires: number, clientId: string, connectionVersion: string }
interface Config { clientId: string, clientSecret: string, origin: string }
const hash = (value: string) => createHash('sha256').update(value).digest('base64url')
function parseStored<T>(raw: string): T {
  try { return JSON.parse(raw) as T } catch { throw new HttpError(500, 'Saved Google connection state is unreadable.') }
}
function read<T>(key: string): T | null { const raw = getMeta(key); return raw ? parseStored<T>(raw) : null }
async function providerJson<T>(response: Response): Promise<T> {
  try { return await response.json() as T } catch { throw new HttpError(502, 'Google returned an unreadable response.') }
}
export function googleConfig(): Config {
  const config = localEnvironment() ?? read<Config>(CONFIG)
  if (!config) throw new HttpError(422, 'Google connections are unavailable. Ask the Poise operator to enable Google.')
  return config
}
function localEnvironment(): Config | null {
  const clientId = process.env.POISE_GOOGLE_CLIENT_ID, clientSecret = process.env.POISE_GOOGLE_CLIENT_SECRET, origin = process.env.POISE_GOOGLE_ORIGIN
  if (!clientId && !clientSecret && !origin) return null
  if (!clientId || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret || clientSecret.length > 4096 || !origin) throw new Error('POISE_GOOGLE_CLIENT_ID, POISE_GOOGLE_CLIENT_SECRET and POISE_GOOGLE_ORIGIN must configure the local Google connection together.')
  let url: URL
  try { url = new URL(origin) } catch { throw new Error('POISE_GOOGLE_ORIGIN must be the local loopback origin.') }
  if (url.origin !== origin || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('POISE_GOOGLE_ORIGIN must be the local HTTP loopback origin.')
  return { clientId, clientSecret, origin }
}
export function validateGoogleEnvironment(service: boolean): void { if (!service) localEnvironment() }
export function googleAccountSettings() {
  const context = googleRequest()
  const configured = context ? context.settings.configured : !!(localEnvironment() ?? read<Config>(CONFIG))
  return { configured, accounts: googleAccounts() }
}
export function configureGoogle(input: Record<string, unknown>): void {
  if (typeof input.clientId !== 'string' || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(input.clientId)) throw new HttpError(400, 'Enter the Google web OAuth client ID.')
  if (typeof input.origin !== 'string') throw new HttpError(400, 'Enter this Poise origin.')
  let origin: URL
  try { origin = new URL(input.origin) } catch { throw new HttpError(400, 'Invalid Poise origin.') }
  if (origin.origin !== input.origin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new HttpError(400, 'Use an HTTPS origin, or HTTP on localhost.')
  const previous = read<Config>(CONFIG)
  const secret = typeof input.clientSecret === 'string' && input.clientSecret ? input.clientSecret : previous?.clientId === input.clientId ? previous.clientSecret : ''
  if (!secret || secret.length > 4096) throw new HttpError(400, 'Enter the Google OAuth client secret.')
  if (previous && previous.clientId !== input.clientId && googleAccounts().some(a => a.connected)) throw new HttpError(409, 'Disconnect the Google accounts before changing the OAuth client.')
  db.transaction(() => {
    setMeta(CONFIG, JSON.stringify({ clientId: input.clientId, clientSecret: secret, origin: origin.origin }))
    setMeta(EPOCH, String(connectionEpoch() + 1))
  }).immediate()
}
export function googleAccounts(): GoogleAccount[] {
  const context = googleRequest(), config = context ? null : localEnvironment() ?? read<Config>(CONFIG)
  const local = (db.prepare('SELECT value FROM meta WHERE key LIKE ? ORDER BY key').all(`${PREFIX}%`) as Array<{ value: string }>).map(row => {
    const a = parseStored<StoredAccount>(row.value)
    const changedClient = !context && a.connected && a.clientId !== config?.clientId
    return { id: a.id, email: a.email, connected: a.connected && !changedClient, ...(changedClient ? { state: 'expired' as const } : a.state ? { state: a.state } : {}) }
  })
  if (context) {
    const central = context.settings.accounts.map(({ id, email, connected, state }) => ({ id, email, connected, state }))
    return [...central, ...local.filter(a => !central.some(b => b.id === a.id)).map(a => ({ ...a, connected: false, state: 'disconnected' as const }))]
  }
  if (isServiceMode()) throw new HttpError(401, 'Google connections require your current browser sign-in.')
  return local
}
function account(id: string): StoredAccount {
  const a = read<StoredAccount>(PREFIX + id)
  if (!a?.connected) throw new HttpError(422, 'Reconnect this Google account in Settings → Accounts.')
  if (a.clientId !== googleConfig().clientId) throw new HttpError(422, 'Reconnect this Google account with the configured Google app.')
  return a
}
export async function googleConnectionVersion(id: string): Promise<string> { return googleRequest() ? serviceConnectionVersion(id) : `${connectionEpoch()}:${account(id).connectionVersion}` }
export async function disconnectGoogle(id: string): Promise<void> {
  const context = googleRequest()
  if (context) { await context.call('disconnect', { accountId: id }); await context.reload(); return }
  const a = read<StoredAccount>(PREFIX + id)
  if (!a) throw new HttpError(404, 'This Google account is not connected here.')
  // Other grants can share Google's refresh token. Forget this connection without revoking them.
  db.transaction(() => {
    setMeta(EPOCH, String(connectionEpoch() + 1))
    setMeta(PREFIX + id, JSON.stringify({ id: a.id, email: a.email, connected: false }))
  }).immediate()
}
async function tokenRequest(values: Record<string, string>): Promise<{ access_token: string, refresh_token?: string, expires_in: number, scope?: string }> {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values), signal: AbortSignal.timeout(30_000), redirect: 'error' })
  if (!response.ok) {
    const failure = await providerJson<{ error?: string }>(response)
    throw new HttpError(failure.error === 'invalid_grant' ? 422 : 502, failure.error === 'invalid_grant' ? 'Google sign-in has ended. Reconnect this account.' : 'Google could not complete sign-in. Try again.')
  }
  const data = await providerJson<{ access_token?: string, refresh_token?: string, expires_in?: number, scope?: string }>(response)
  if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in! <= 0 || (data.refresh_token !== undefined && typeof data.refresh_token !== 'string') || (data.scope !== undefined && typeof data.scope !== 'string')) throw new HttpError(502, 'Google returned an invalid token response.')
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in!, scope: data.scope }
}
export async function beginGoogleLogin(req: IncomingMessage, input: Record<string, unknown>): Promise<{ url: string }> {
  const context = googleRequest()
  if (context) return context.call('begin', input)
  const config = googleConfig()
  if (req.headers.origin !== config.origin) throw new HttpError(403, 'The configured Google origin must match this Poise browser.')
  if (typeof input.browserSecret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(input.browserSecret)) throw new HttpError(400, 'A private browser binding is required for Google sign-in.')
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
  db.prepare('DELETE FROM meta WHERE key LIKE ? AND json_extract(value, \'$.expires\') < ?').run(`${STATE}%`, Date.now())
  const expected = input.accountId
  if (expected !== undefined && (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(expected))) throw new HttpError(400, 'A valid Google account is required.')
  setMeta(STATE + hash(state), JSON.stringify({ browser: hash(input.browserSecret), verifier, expires: Date.now() + 600_000, epoch: connectionEpoch(), clientId: config.clientId, origin: config.origin, client: hash(config.clientId + '\0' + config.clientSecret), expected }))
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.origin + '/', response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state, code_challenge: hash(verifier), code_challenge_method: 'S256' })
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }
}
export async function completeGoogleLogin(req: IncomingMessage, input: Record<string, unknown>): Promise<GoogleCompletion> {
  const context = googleRequest()
  if (context) { const result = await context.call<GoogleCompletion>('finish', input); await context.reload(); return result }
  if (typeof input.state !== 'string' || input.state.length > 256 || (input.error === undefined && (typeof input.code !== 'string' || input.code.length > 4096))) throw new HttpError(400, 'Google sign-in code and state are required.')
  const config = googleConfig(), key = STATE + hash(input.state)
  const pending = read<{ browser: string, verifier: string, expires: number, epoch: number, clientId: string, origin: string, client: string, expected?: string }>(key)
  const browserSecret = typeof input.browserSecret === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(input.browserSecret) ? input.browserSecret : ''
  if (!pending || !browserSecret || hash(browserSecret) !== pending.browser || Date.now() >= pending.expires || pending.epoch !== connectionEpoch() || pending.clientId !== config.clientId || pending.client !== hash(config.clientId + '\0' + config.clientSecret) || pending.origin !== config.origin || req.headers.origin !== config.origin) throw new HttpError(403, 'Google sign-in expired or belongs to another browser. Connect again.')
  const removed = db.prepare('DELETE FROM meta WHERE key = ?').run(key)
  if (!removed.changes) throw new HttpError(403, 'Google sign-in was already used.')
  if (input.error !== undefined) return input.error === 'access_denied' ? { outcome: 'cancelled' } : { outcome: 'failed', message: 'Google did not complete sign-in. Connect again.' }
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code: input.code as string, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.origin + '/', code_verifier: pending.verifier })
  if (!tokens.scope?.split(' ').includes(SCOPES[2])) throw new HttpError(403, 'Google Drive file access was not granted.')
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' })
  if (!response.ok) throw new HttpError(502, 'Google account identity could not be verified.')
  const identity = await providerJson<{ sub?: string, email?: string, email_verified?: boolean }>(response)
  if (typeof identity.sub !== 'string' || typeof identity.email !== 'string' || !identity.sub || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.sub) || !identity.email || identity.email_verified !== true) throw new HttpError(403, 'Google did not return a verified account identity.')
  if (pending.expected && pending.expected !== identity.sub) throw new HttpError(403, 'Choose the same Google account when reconnecting.')
  const previous = read<StoredAccount>(PREFIX + identity.sub)
  const refreshToken = tokens.refresh_token ?? (previous?.clientId === config.clientId ? previous.refreshToken : '')
  if (!refreshToken) throw new HttpError(422, 'Google did not grant offline access. Connect again and grant consent.')
  db.transaction(() => {
    const current = googleConfig()
    if (pending.epoch !== connectionEpoch() || pending.client !== hash(current.clientId + '\0' + current.clientSecret) || pending.origin !== current.origin) throw new HttpError(409, 'Google connections changed during sign-in. Connect again.')
    const connected = googleAccounts().filter(a => a.connected)
    if (!connected.some(a => a.id === identity.sub) && connected.length >= 10) throw new HttpError(429, 'At most ten Google accounts can be connected.')
    setMeta(PREFIX + identity.sub, JSON.stringify({ id: identity.sub, email: identity.email, connected: true, connectionVersion: randomUUID(), clientId: config.clientId, refreshToken, accessToken: tokens.access_token, expires: Date.now() + tokens.expires_in * 1000 }))
  }).immediate()
  return { outcome: 'connected', accountId: identity.sub }
}
const refreshes = new Map<string, Promise<string>>()
export async function googleAccessToken(id: string, forceRefresh = false): Promise<string> {
  const context = googleRequest()
  if (context) {
    const a = context.settings.accounts.find(a => a.id === id && a.connected)
    if (!a) throw new HttpError(422, 'Reconnect this Google account in Accounts.')
    const result = await context.call<{ accessToken: string }>('token', { accountId: id, connectionVersion: a.connectionVersion, ...(forceRefresh ? { forceRefresh: true } : {}) })
    if (typeof result.accessToken !== 'string' || !result.accessToken || result.accessToken.length > 16384) throw new HttpError(502, 'Google returned no usable access token.')
    return result.accessToken
  }
  if (isServiceMode()) throw new HttpError(401, 'Google connections require your current browser sign-in.')
  const a = account(id)
  if (a.expires > Date.now() + 60_000 && !forceRefresh) return a.accessToken
  const pending = refreshes.get(id)
  if (pending) return pending
  const operation = (async () => {
    const config = googleConfig()
    const fingerprint = hash(config.clientId + '\0' + config.clientSecret + '\0' + config.origin)
    if (a.clientId !== config.clientId) throw new HttpError(422, 'Reconnect this Google account with the configured OAuth client.')
    let t: Awaited<ReturnType<typeof tokenRequest>>
    try { t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: config.clientId, client_secret: config.clientSecret }) }
    catch (error) {
      if (error instanceof HttpError && error.statusCode === 422) db.prepare('UPDATE meta SET value=? WHERE key=? AND value=?').run(JSON.stringify({ id: a.id, email: a.email, connected: false, state: 'expired' }), PREFIX + id, JSON.stringify(a))
      throw error
    }
    const current = googleConfig()
    if (fingerprint !== hash(current.clientId + '\0' + current.clientSecret + '\0' + current.origin)) throw new HttpError(409, 'Google configuration changed during refresh. Connect again.')
    // A disconnect while refreshing must never resurrect credentials.
    const changed = db.prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?').run(JSON.stringify({ ...a, accessToken: t.access_token, refreshToken: t.refresh_token ?? a.refreshToken, expires: Date.now() + t.expires_in * 1000 }), PREFIX + id, JSON.stringify(a))
    if (!changed.changes) throw new HttpError(409, 'Google connection changed during refresh. Try again.')
    return t.access_token
  })()
  refreshes.set(id, operation)
  try { return await operation } finally { refreshes.delete(id) }
}
