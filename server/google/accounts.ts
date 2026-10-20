import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { db, getMeta, setMeta } from '../db'
import { HttpError } from '../http'

const CONFIG = 'google:config'
const PREFIX = 'google:account:'
const STATE = 'google:state:'
const EPOCH = 'google:connections-epoch'
const connectionEpoch = () => Number(getMeta(EPOCH) ?? '0')
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file']
export interface GoogleAccount { id: string, email: string, connected: boolean }
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
  const config = read<Config>(CONFIG)
  if (!config) throw new HttpError(422, 'Configure the Google OAuth client in Settings → Accounts first.')
  return config
}
export function googleAccountSettings() {
  const config = read<Config>(CONFIG)
  return { configured: !!config, clientId: config?.clientId ?? '', origin: config?.origin ?? '', accounts: googleAccounts() }
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
  return (db.prepare('SELECT value FROM meta WHERE key LIKE ? ORDER BY key').all(`${PREFIX}%`) as Array<{ value: string }>).map(row => {
    const a = parseStored<StoredAccount>(row.value)
    return { id: a.id, email: a.email, connected: a.connected }
  })
}
function account(id: string): StoredAccount {
  const a = read<StoredAccount>(PREFIX + id)
  if (!a?.connected) throw new HttpError(422, 'Reconnect this Google account in Settings → Accounts.')
  return a
}
export function googleConnectionVersion(id: string): string { return `${connectionEpoch()}:${account(id).connectionVersion}` }
export function disconnectGoogle(id: string): void {
  const a = account(id)
  // Other grants can share Google's refresh token. Forget this connection without revoking them.
  db.transaction(() => {
    setMeta(EPOCH, String(connectionEpoch() + 1))
    setMeta(PREFIX + id, JSON.stringify({ id: a.id, email: a.email, connected: false }))
  }).immediate()
}
async function tokenRequest(values: Record<string, string>): Promise<{ access_token: string, refresh_token?: string, expires_in: number, scope?: string }> {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values), signal: AbortSignal.timeout(30_000), redirect: 'error' })
  if (!response.ok) throw new HttpError(502, 'Google rejected the sign-in or refresh token. Reconnect the account.')
  const data = await providerJson<{ access_token?: string, refresh_token?: string, expires_in?: number, scope?: string }>(response)
  if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in! <= 0 || (data.refresh_token !== undefined && typeof data.refresh_token !== 'string') || (data.scope !== undefined && typeof data.scope !== 'string')) throw new HttpError(502, 'Google returned an invalid token response.')
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in!, scope: data.scope }
}
export function beginGoogleLogin(req: IncomingMessage, input: Record<string, unknown>): { url: string } {
  const config = googleConfig()
  if (req.headers.origin !== config.origin) throw new HttpError(403, 'The configured Google origin must match this Poise browser.')
  if (typeof input.browserSecret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(input.browserSecret)) throw new HttpError(400, 'A private browser binding is required for Google sign-in.')
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
  db.prepare('DELETE FROM meta WHERE key LIKE ? AND json_extract(value, \'$.expires\') < ?').run(`${STATE}%`, Date.now())
  setMeta(STATE + hash(state), JSON.stringify({ browser: hash(input.browserSecret), verifier, expires: Date.now() + 600_000, epoch: connectionEpoch(), clientId: config.clientId, origin: config.origin }))
  const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.origin + '/', response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state, code_challenge: hash(verifier), code_challenge_method: 'S256' })
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }
}
export async function completeGoogleLogin(req: IncomingMessage, input: Record<string, unknown>): Promise<void> {
  if (typeof input.state !== 'string' || typeof input.code !== 'string' || input.state.length > 256 || input.code.length > 4096) throw new HttpError(400, 'Google sign-in code and state are required.')
  const config = googleConfig(), key = STATE + hash(input.state)
  const pending = read<{ browser: string, verifier: string, expires: number, epoch: number, clientId: string, origin: string }>(key)
  const browserSecret = typeof input.browserSecret === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(input.browserSecret) ? input.browserSecret : ''
  if (!pending || !browserSecret || hash(browserSecret) !== pending.browser || Date.now() >= pending.expires || pending.epoch !== connectionEpoch() || pending.clientId !== config.clientId || pending.origin !== config.origin || req.headers.origin !== config.origin) throw new HttpError(403, 'Google sign-in expired or belongs to another browser. Connect again.')
  const removed = db.prepare('DELETE FROM meta WHERE key = ?').run(key)
  if (!removed.changes) throw new HttpError(403, 'Google sign-in was already used.')
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code: input.code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.origin + '/', code_verifier: pending.verifier })
  if (!tokens.scope?.split(' ').includes(SCOPES[2])) throw new HttpError(403, 'Google Drive file access was not granted.')
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' })
  if (!response.ok) throw new HttpError(502, 'Google account identity could not be verified.')
  const identity = await providerJson<{ sub?: string, email?: string, email_verified?: boolean }>(response)
  if (typeof identity.sub !== 'string' || typeof identity.email !== 'string' || !identity.sub || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.sub) || !identity.email || identity.email_verified !== true) throw new HttpError(403, 'Google did not return a verified account identity.')
  const previous = read<StoredAccount>(PREFIX + identity.sub)
  const refreshToken = tokens.refresh_token ?? (previous?.clientId === config.clientId ? previous.refreshToken : '')
  if (!refreshToken) throw new HttpError(422, 'Google did not grant offline access. Connect again and grant consent.')
  db.transaction(() => {
    if (pending.epoch !== connectionEpoch()) throw new HttpError(409, 'Google connections changed during sign-in. Connect again.')
    setMeta(PREFIX + identity.sub, JSON.stringify({ id: identity.sub, email: identity.email, connected: true, connectionVersion: randomUUID(), clientId: config.clientId, refreshToken, accessToken: tokens.access_token, expires: Date.now() + tokens.expires_in * 1000 }))
  }).immediate()
}
const refreshes = new Map<string, Promise<string>>()
export async function googleAccessToken(id: string): Promise<string> {
  const a = account(id)
  if (a.expires > Date.now() + 60_000) return a.accessToken
  const pending = refreshes.get(id)
  if (pending) return pending
  const operation = (async () => {
    const config = googleConfig()
    if (a.clientId !== config.clientId) throw new HttpError(422, 'Reconnect this Google account with the configured OAuth client.')
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: config.clientId, client_secret: config.clientSecret })
    // A disconnect while refreshing must never resurrect credentials.
    const changed = db.prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?').run(JSON.stringify({ ...a, accessToken: t.access_token, refreshToken: t.refresh_token ?? a.refreshToken, expires: Date.now() + t.expires_in * 1000 }), PREFIX + id, JSON.stringify(a))
    if (!changed.changes) throw new HttpError(409, 'Google connection changed during refresh. Try again.')
    return t.access_token
  })()
  refreshes.set(id, operation)
  try { return await operation } finally { refreshes.delete(id) }
}
