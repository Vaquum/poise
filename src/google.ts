import type { GoogleChangeReview, GoogleDocumentView } from '../server/google/types'
import type { GoogleCompletion } from '../server/google/service'

export interface GoogleAccountView { id: string; email: string; connected: boolean; state?: 'connected' | 'expired' | 'disconnected' }
export interface GoogleSettings { configured: boolean; accounts: GoogleAccountView[] }
export async function googleCall<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `Google action answered ${response.status}.`)
  return data
}
export const googlePath = (slug: string, action = '') => `/api/editor/doc/${encodeURIComponent(slug)}/google${action ? '/' + action : ''}`
export const escapeGoogleHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export const GOOGLE_CHANGED = 'poise:google-published'
const FLOW_KEY = 'poise-google-flow', LEGACY_SECRET = 'poise-google-login-secret'
const SLUG = /^[A-Za-z0-9._-]{1,200}$/
interface ReturnTo { place: 'accounts' | 'publish'; slug?: string }
interface Flow { secret: string; state: string; createdAt: number; returnTo: ReturnTo; expectedAccountId?: string }
export interface GooglePublishReturn { slug: string; accountId?: string; message: string }
let connectionResult: string | null = null, publishReturn: GooglePublishReturn | null = null
let navigationGuard: (() => Promise<() => void>) | null = null
export function setGoogleNavigationGuard(guard: () => Promise<() => void>): void { navigationGuard = guard }
export function takeGoogleConnectionResult(): string | null { const value = connectionResult; connectionResult = null; return value }
export function setGoogleConnectionResult(message: string): void { connectionResult = message }
export function takeGooglePublishReturn(): GooglePublishReturn | null { const value = publishReturn; publishReturn = null; return value }
export function onGoogleNavigationReturn(callback: () => void): void {
  const restored = (event: PageTransitionEvent) => {
    if (!event.persisted) return
    window.removeEventListener('pageshow', restored)
    callback()
  }
  window.addEventListener('pageshow', restored)
}
export async function googleDocument(slug: string): Promise<GoogleDocumentView> {
  const data = await googleCall<GoogleDocumentView>(googlePath(slug, 'sync'), {})
  if (!Array.isArray(data.publications) || typeof data.version !== 'string') throw new Error('The Google publication response is unreadable.')
  return data
}
export const googleReview = (slug: string, accountId: string) => googleCall<GoogleChangeReview>(googlePath(slug, 'review'), { accountId })

/** All connection entry points share the Editor save barrier and the same browser flow. */
export async function beginGoogleConnection(options: { accountId?: string; slug?: string; assertCurrent?: () => void; beforeNavigate?: () => Promise<void> } = {}): Promise<void> {
  let release: (() => void) | undefined, navigating = false, stored = false
  try {
    release = await navigationGuard?.()
    await options.beforeNavigate?.()
    options.assertCurrent?.()
    if (options.slug && !SLUG.test(options.slug)) throw new Error('This draft cannot be restored after Google sign-in.')
    const flow: Flow = { secret: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''), state: '', createdAt: Date.now(), returnTo: options.slug ? { place: 'publish', slug: options.slug } : { place: 'accounts' }, ...(options.accountId ? { expectedAccountId: options.accountId } : {}) }
    // Writing before admission detects unavailable storage before leaving a saved draft.
    try { sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow)); stored = true; sessionStorage.removeItem(LEGACY_SECRET) }
    catch { throw new Error('Browser storage is unavailable. Allow tab storage, then connect again.') }
    const result = await googleCall<{ url: string }>('/api/google/connect', { browserSecret: flow.secret, ...(options.accountId ? { accountId: options.accountId } : {}) })
    options.assertCurrent?.()
    const target = new URL(result.url), state = target.searchParams.get('state')
    const apex = new URL(location.origin); apex.hostname = apex.hostname.split('.').slice(1).join('.') || apex.hostname
    const google = target.origin === 'https://accounts.google.com' && target.pathname === '/o/oauth2/v2/auth'
    const gateway = target.origin === apex.origin && target.pathname === '/auth/google/start'
    if ((!google && !gateway) || target.username || target.password || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('Google returned an invalid sign-in address.')
    sessionStorage.setItem(FLOW_KEY, JSON.stringify({ ...flow, state }))
    location.assign(target.href)
    navigating = true
    // Back/forward cache may revive the original page without rebuilding its Editor.
    if (release) onGoogleNavigationReturn(release)
  } catch (error) {
    if (stored) sessionStorage.removeItem(FLOW_KEY)
    throw error
  } finally { if (!navigating) release?.() }
}

/** State and possession of the retained flow proof authorize one verified completion. */
export async function finishGoogleConnection(): Promise<'accounts' | 'publish' | null> {
  const url = new URL(location.href), central = url.searchParams.has('google_state')
  const state = url.searchParams.get(central ? 'google_state' : 'state')
  if (!state || (!central && !url.searchParams.has('code') && !url.searchParams.has('error'))) return null
  const code = url.searchParams.get('code'), error = url.searchParams.get('error')
  for (const key of ['google_state', 'code', 'state', 'scope', 'authuser', 'prompt', 'error', 'error_description', 'hd']) url.searchParams.delete(key)
  history.replaceState(null, '', url)
  let destination: 'accounts' | 'publish' = 'accounts'
  try {
    const raw = sessionStorage.getItem(FLOW_KEY)
    let flow: Flow | null = null
    if (raw) {
      try { flow = JSON.parse(raw) as Flow } catch { throw new Error('Google sign-in context is unreadable. Connect again.') }
      if (!flow || flow.state !== state || typeof flow.secret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(flow.secret) || !Number.isFinite(flow.createdAt) || flow.createdAt > Date.now() || Date.now() - flow.createdAt >= 600_000 || !flow.returnTo || !['accounts', 'publish'].includes(flow.returnTo.place) || (flow.returnTo.place === 'publish' && (typeof flow.returnTo.slug !== 'string' || !SLUG.test(flow.returnTo.slug)))) throw new Error('Google sign-in context has expired. Connect again.')
    }
    const browserSecret = flow?.secret ?? (!central ? sessionStorage.getItem(LEGACY_SECRET) : null)
    sessionStorage.removeItem(FLOW_KEY); sessionStorage.removeItem(LEGACY_SECRET)
    if (!browserSecret) throw new Error('Google sign-in belongs to another browser tab or has expired. Connect again.')
    const result = await googleCall<GoogleSettings & { connection: GoogleCompletion }>('/api/google/callback', { state, browserSecret, ...(!central ? error ? { error } : { code } : {}) })
    const completion = result.connection
    if (!completion || !['connected', 'cancelled', 'failed'].includes(completion.outcome) || (completion.outcome === 'connected' && (typeof completion.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(completion.accountId)))) throw new Error('Google did not confirm this connection. Connect again.')
    if (completion.outcome === 'connected' && flow?.expectedAccountId && completion.accountId !== flow.expectedAccountId) throw new Error('Google returned a different account. Reconnect the expected account.')
    connectionResult = completion.outcome === 'connected' ? 'Google account connected.' : completion.outcome === 'cancelled' ? 'Google sign-in cancelled.' : completion.message || 'Google sign-in could not be completed. Connect again.'
    if (flow?.returnTo.place === 'publish' && flow.returnTo.slug) {
      publishReturn = { slug: flow.returnTo.slug, ...(completion.outcome === 'connected' ? { accountId: completion.accountId } : {}), message: connectionResult }
      destination = 'publish'
    }
  } catch (error) {
    connectionResult = (error as Error).message
    try { sessionStorage.removeItem(FLOW_KEY); sessionStorage.removeItem(LEGACY_SECRET) }
    catch { connectionResult = 'Browser storage is unavailable. Allow tab storage, then connect again.' }
  }
  if (destination === 'accounts') url.searchParams.set('settings', 'accounts')
  else url.searchParams.delete('settings')
  history.replaceState(null, '', url)
  return destination
}
