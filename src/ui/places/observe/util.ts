// What Observe's parts share: the scope, Board's choice of organization
// (poise-current-filters), times on Poise's clock, the state capsule, links to
// GitHub, Board and the other parts, and reading an answer's error.
import { effectiveTimezone, getOrganizations } from '../../../config'
import { fullTime, shortTime } from '../../../clock'
import { getSelectedOrganization, setSelectedOrganization } from '../../../organizations'
import { esc } from '../../dom'
import { placeHref, type Part } from '../../address'
import type { StateKey } from './chains'

// ---------- Scope: one organization, or all, the same choice as Board's and Overview's ----------
export const readyOrganizations = (): string[] => getOrganizations().filter((org) => org.status === 'ready').map((org) => org.login)
/** The saved scope, when it is still an organization that is ready; otherwise all of them. */
export function savedScope(): string {
  const org = getSelectedOrganization()
  return readyOrganizations().includes(org) ? org : ''
}
export function saveScope(org: string): void { setSelectedOrganization(org) }

// ---------- Times on Poise's clock, in the zone from General ----------
export const clockTime = (at: number | string, now = Date.now()): string => {
  try { return shortTime(at, effectiveTimezone(), now) } catch { return '—' }
}
export const exactTime = (at: number | string): string => {
  try { return fullTime(at, effectiveTimezone()) } catch { return '' }
}

// ---------- Small markup ----------
export const capsule = (state: StateKey | '' = ''): string => `<span class="sc"${state ? ` data-state="${state}"` : ''}></span>`
export const github = (...parts: Array<string | number>): string => `https://github.com/${parts.map((p) => String(p).split('/').map(encodeURIComponent).join('/')).join('/')}`
export const external = (href: string, html: string, cls = 'lnk', ref = 'gh.link'): string =>
  `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-ref="${ref}">${html}</a>`

/** Its work on Board: the card of `owner/name#number`, with a route back to Observe. */
export const onBoard = (item: string): string => placeHref('board', { item, back: 'observe' })

/** Another part of Observe, keeping the route back to where Observe was opened from. */
export function partHref(part: Part, params: Record<string, string | null | undefined>, back: string | null): string {
  return placeHref('observe', { part, ...params, back })
}

/** The server's reason from a failed answer, or its status. */
export async function failureOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: unknown, message?: unknown }
    if (typeof body.error === 'string' && body.error) return typeof body.message === 'string' && body.message ? body.message : body.error
  } catch { /* not JSON: its text below */ }
  // A page in place of an answer (a proxy's error page, say) says nothing a person can use.
  const page = /^\s*</.test(text) || (response.headers.get('content-type') ?? '').includes('text/html')
  return text && !page ? `${response.status}: ${text.slice(0, 200)}` : `HTTP ${response.status}`
}

/** A GET whose failure carries the server's reason. */
export async function readJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(await failureOf(response))
  return response.json()
}

/** A POST of JSON whose failure carries the server's reason. */
export async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!response.ok) throw new Error(await failureOf(response))
  return response.json().catch(() => ({}))
}

export const aborted = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError'
export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
