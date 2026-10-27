import { HttpError } from './http.js'

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file']
export interface GoogleTokens { access_token: string; refresh_token?: string; expires_in: number; scope?: string }
export class GoogleGrantExpired extends HttpError {
  constructor() { super(422, 'Google sign-in has ended. Reconnect this account.') }
}
async function provider(url: string, init: RequestInit): Promise<{ response: Response; data: Record<string, unknown> }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.body) throw new Error('empty')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 64 * 1024) { await reader.cancel(); throw new Error('oversize') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('malformed')
    return { response, data: data as Record<string, unknown> }
  } catch { throw new HttpError(502, 'Google could not complete this request. Try again.') }
}
export async function googleTokenRequest(values: Record<string, string>): Promise<GoogleTokens> {
  const { response, data } = await provider('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) })
  if (!response.ok) {
    if (data.error === 'invalid_grant') throw new GoogleGrantExpired()
    throw new HttpError(502, 'Google could not complete sign-in. Try again.')
  }
  if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384 || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400 || (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 16384)) || (data.scope !== undefined && typeof data.scope !== 'string')) throw new HttpError(502, 'Google returned an invalid sign-in response.')
  return data as unknown as GoogleTokens
}
export async function googleIdentity(accessToken: string): Promise<{ id: string; email: string }> {
  const { response, data } = await provider('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!response.ok || typeof data.sub !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.sub) || typeof data.email !== 'string' || !data.email || data.email.length > 320 || data.email_verified !== true) throw new HttpError(403, 'Google did not return a verified account identity.')
  return { id: data.sub, email: data.email }
}
