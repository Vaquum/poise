import { AsyncLocalStorage } from 'node:async_hooks'
import { request, type IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { HttpError, readBuffer } from '../http'
import type { ServiceConfig } from '../service/config'
import { verifiedRequestIdentity } from '../service/request-identity'

export interface BrokerAccount { id: string; email: string; connected: boolean; state: 'connected' | 'expired' | 'disconnected'; connectionVersion: string }
interface Settings { configured: boolean; accounts: BrokerAccount[] }
export interface GoogleCompletion { outcome: 'connected' | 'cancelled' | 'failed'; accountId?: string; message?: string }
type Purpose = 'accounts' | 'connect' | 'callback' | 'disconnect' | 'sync' | 'publish' | 'review' | 'import'
interface GoogleRequest { settings: Settings; call<T>(action: string, body?: Record<string, unknown>): Promise<T>; reload(): Promise<void> }
const requests = new AsyncLocalStorage<GoogleRequest | null>()
export const googleRequest = () => requests.getStore() ?? null

function settings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new HttpError(502, 'Google account status is unreadable.')
  const s = value as Partial<Settings>
  if (typeof s.configured !== 'boolean' || !Array.isArray(s.accounts) || s.accounts.length > 1000 || s.accounts.some(a => !a || typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(a.id) || typeof a.email !== 'string' || a.email.length > 320 || typeof a.connected !== 'boolean' || !['connected', 'expired', 'disconnected'].includes(a.state) || typeof a.connectionVersion !== 'string' || a.connectionVersion.length > 256)) throw new HttpError(502, 'Google account status is unreadable.')
  return s as Settings
}
async function broker<T>(origin: string, host: string, token: string, action: string, body: Record<string, unknown> = {}): Promise<T> {
  let response: { status: number; body: string }
  try {
    const payload = JSON.stringify({ ...body, action })
    response = await new Promise((resolve, reject) => {
      const outgoing = request(new URL('/_gateway/google', origin), { method: 'POST', headers: { Host: host, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, signal: AbortSignal.timeout(35_000) }, incoming => {
        void readBuffer(incoming, 1024 * 1024).then(bytes => resolve({ status: incoming.statusCode ?? 502, body: bytes.toString('utf8') }), reject)
      })
      outgoing.on('error', reject)
      outgoing.end(payload)
    })
  }
  catch { throw new HttpError(502, 'Google connections are temporarily unavailable. Try again.') }
  let data: unknown
  try { data = JSON.parse(response.body) } catch { throw new HttpError(502, 'Google connections returned an unreadable response.') }
  if (response.status < 200 || response.status >= 300) {
    const message = data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : 'Google connections are unavailable. Try again.'
    throw new HttpError(response.status, message)
  }
  return data as T
}
export async function withGoogleRequest<T>(req: IncomingMessage, service: ServiceConfig | null, purpose: Purpose, operation: () => Promise<T>): Promise<T> {
  if (!service) return requests.run(null, operation)
  const identity = verifiedRequestIdentity(req)
  if (!identity) throw new HttpError(401, 'Google connections require your current browser sign-in.')
  const peer = identity.peer.replace(/^::ffff:/, ''), family = isIP(peer), port = identity.gatewayPort
  if (!family || !port) throw new HttpError(503, 'Google connections require an updated gateway connection.')
  // The verified request arrived over this private connection. No public-host
  // hairpin or Docker DNS is required, including behind the VM isolation filter.
  const origin = `http://${family === 6 ? `[${peer}]` : peer}:${port}`, host = `gateway:${port}`
  const opened = await broker<{ operationToken: string; expiresAt: number; settings: unknown }>(origin, host, identity.token, 'open', { purpose })
  if (typeof opened.operationToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(opened.operationToken) || !Number.isFinite(opened.expiresAt) || opened.expiresAt <= Date.now() || opened.expiresAt > Date.now() + 20 * 60_000 + 5000) throw new HttpError(502, 'Google did not admit this operation.')
  const context: GoogleRequest = {
    settings: settings(opened.settings),
    call: async <R>(action: string, body?: Record<string, unknown>) => {
      if (Date.now() >= opened.expiresAt) throw new HttpError(401, 'This Google action expired. Review the destination before trying again.')
      return broker<R>(origin, host, opened.operationToken, action, body)
    },
    reload: async () => { context.settings = settings(await context.call('settings')) },
  }
  try { return await requests.run(context, operation) }
  finally {
    try { await broker(origin, host, opened.operationToken, 'close') }
    catch { console.warn('[google] Operation cleanup was unavailable; its fixed lease will expire.') }
  }
}
export async function serviceConnectionVersion(id: string): Promise<string> {
  const context = googleRequest()
  if (!context) throw new HttpError(401, 'Google connections require your current browser sign-in.')
  const current = settings(await context.call('settings')).accounts.find(a => a.id === id && a.connected)
  if (!current) throw new HttpError(422, 'Reconnect this Google account in Accounts.')
  return current.connectionVersion
}
