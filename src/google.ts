import type { GoogleChangeReview, GoogleDocumentView } from '../server/google/types'

export interface GoogleAccountView { id: string, email: string, connected: boolean }
export interface GoogleSettings { configured: boolean, clientId: string, origin: string, accounts: GoogleAccountView[] }
export async function googleCall<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `Google action answered ${response.status}.`)
  return data
}
export const googlePath = (slug: string, action = '') => `/api/editor/doc/${encodeURIComponent(slug)}/google${action ? '/' + action : ''}`
export const escapeGoogleHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export const GOOGLE_CHANGED = 'poise:google-published'
let connectionResult: string | null = null
export function takeGoogleConnectionResult(): string | null { const value = connectionResult; connectionResult = null; return value }
export async function googleDocument(slug: string): Promise<GoogleDocumentView> {
  const data = await googleCall<GoogleDocumentView>(googlePath(slug, 'sync'), {})
  if (!Array.isArray(data.publications) || typeof data.version !== 'string') throw new Error('The Google publication response is unreadable.')
  return data
}
export const googleReview = (slug: string, accountId: string) => googleCall<GoogleChangeReview>(googlePath(slug, 'review'), { accountId })

/** OAuth returns through the normal app page; exchange from this same-origin browser tab only. The gateway intentionally strips cookies. */
export async function finishGoogleConnection(): Promise<boolean> {
  const url = new URL(location.href), state = url.searchParams.get('state')
  if (!state || (!url.searchParams.has('code') && !url.searchParams.has('error'))) return false
  const code = url.searchParams.get('code'), error = url.searchParams.get('error')
  for (const key of ['code', 'state', 'scope', 'authuser', 'prompt', 'error', 'error_description', 'hd']) url.searchParams.delete(key)
  url.searchParams.set('settings', 'accounts')
  history.replaceState(null, '', url)
  try {
    if (error) throw new Error('Google sign-in was cancelled or refused. Connect again in Settings → Accounts.')
    const browserSecret = sessionStorage.getItem('poise-google-login-secret')
    sessionStorage.removeItem('poise-google-login-secret')
    if (!browserSecret) throw new Error('Google sign-in belongs to another browser tab or has expired. Connect again.')
    await googleCall('/api/google/callback', { code, state, browserSecret })
    connectionResult = 'Google account connected.'
  } catch (error) { connectionResult = (error as Error).message }
  return true
}
