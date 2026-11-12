// Small helpers Overview's parts share: the clock in Settings' time zone,
// JSON reads that keep the service's own reason, and reads that run only
// while the tab is in front.
import { shortTime } from '../../../clock'
import { effectiveTimezone } from '../../../config'
import { noticeFeed } from '../../../notices'

/** "19:38" today, "20 Oct 17:05" another day: Chat's clock, in Settings' zone. */
export function clockAt(at: string | number | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined || !Number.isFinite(typeof at === 'number' ? at : Date.parse(at))) return ''
  try { return shortTime(at, effectiveTimezone(), now) } catch { return '' }
}

/** "now", "4m", "3h", "2d": how long ago, as the rest of Poise says it. */
export function ago(at: string | number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - (typeof at === 'number' ? at : Date.parse(at))) / 60_000))
  if (!Number.isFinite(minutes) || minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** A stable element id for any string. */
export function slug(id: string): string {
  let hash = 2166136261
  for (const character of id) { hash ^= character.codePointAt(0)!; hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(36)
}

export function uid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** An error that carries the service's answer, for actions that read it. */
export class ServiceError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> | null) { super(message) }
}

/** Reads JSON; a refusal throws with the service's own reason. */
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) throw new ServiceError(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`, response.status, body)
  return body as T
}

export const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** What a part of Overview needs of its place (router.ts' PlaceContext): the
 *  signal that aborts when the place leaves, and timers that stop with it. */
export interface PartContext {
  signal: AbortSignal
  every(ms: number, fn: () => void): void
  after(ms: number, fn: () => void): void
}

/** Runs `read` now and every `ms` while the tab is in front, and again when it
 *  comes back to the front; it stops when the place leaves. */
export function whileVisible(ctx: PartContext, ms: number, read: () => void): void {
  read()
  ctx.every(ms, () => { if (document.visibilityState === 'visible') read() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') read() }, { signal: ctx.signal })
}

/** The last read of a part: what was read, the failure if the latest failed, and when. */
export interface Read<T> { data: T | null, error: string, at: number }
export const unread = <T>(): Read<T> => ({ data: null, error: '', at: 0 })

/** A failed read also shows as a local notice, as classic's reads report
 *  theirs; it clears when the part reads again, or when the place leaves. */
export function reportRead(ctx: PartContext, source: string, title: string, read: Read<unknown>): void {
  if (ctx.signal.aborted) return
  noticeFeed.reportReadErrors(source, read.error ? [{ key: source, title, body: read.at ? `${read.error} Last read at ${clockAt(read.at)}.` : read.error }] : [])
  if (!cleared.has(source)) { cleared.add(source); ctx.signal.addEventListener('abort', () => { cleared.delete(source); noticeFeed.reportReadErrors(source, []) }) }
}
const cleared = new Set<string>()

/** A part's read state in words: nothing while it is fine. */
export function readLine(name: string, read: Read<unknown>): string {
  if (!read.error) return ''
  return `${name} could not be read: ${read.error.replace(/\.$/, '')}. ${read.at ? `Last read at ${clockAt(read.at)}.` : 'Not read yet.'}`
}
