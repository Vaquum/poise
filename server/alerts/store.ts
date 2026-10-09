// Alerts: what the workspace has to tell its owner while the browser is
// closed (docs/Service-architecture.md, "Snippets and Poise Link"). Poise Link
// shows each one as a desktop notification, once. While the browser is open,
// the page shows the unresolved ones as notices (./notices.ts).
//
// An alert is raised under a dedupe key and stays the only one for that key
// until it is resolved, so a condition that persists alerts once, and alerts
// again only after it has cleared. Alerts are kept for 30 days.

import { EventEmitter } from 'node:events'
import { ALERT_ID_EPOCH_KEY, db, getMeta } from '../db'

export const ALERT_KINDS = ['sign_in_needed', 'behavior_held', 'datastore_sync_failing', 'chat_waiting', 'chat_turn_finished', 'pr_ready'] as const
export type AlertKind = typeof ALERT_KINDS[number]

/** Where the alert's notice in the page takes the person: a view, a Settings
 *  tab, a Chat session, or a pull request on GitHub. */
export type AlertTarget =
  | { view: 'behaviors' }
  | { settings: 'general' | 'accounts' }
  | { chat: string }
  | { pullRequest: string }

const PULL_REQUEST_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/

export function isAlertTarget(value: unknown): value is AlertTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  const keys = Object.keys(target)
  if (keys.length !== 1) return false
  if ('view' in target) return target.view === 'behaviors'
  if ('settings' in target) return target.settings === 'general' || target.settings === 'accounts'
  if ('chat' in target) return typeof target.chat === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(target.chat)
  if ('pullRequest' in target) return typeof target.pullRequest === 'string' && PULL_REQUEST_URL.test(target.pullRequest)
  return false
}

export const ALERT_RETENTION_MS = 30 * 24 * 60 * 60_000

export interface AlertInput {
  kind: AlertKind
  /** One alert per key while it is unresolved. */
  dedupeKey: string
  title: string
  body: string
  /** The page in this workspace the alert opens, as a path. */
  path: string
  /** Where its notice in the page opens; none, and the notice only informs. */
  target?: AlertTarget
}

export interface Alert {
  /** `<epoch>-<seq>`: the event-stream id and the alert's own. */
  id: string
  seq: number
  kind: AlertKind
  title: string
  body: string
  path: string
  createdAt: string
}

interface AlertRow {
  id: number
  kind: AlertKind
  title: string
  body: string
  url: string
  created_at: string
}

/** Emits `recorded` once the work that raised alerts has finished: a
 *  listener reads them back from the table, so an alert raised inside a
 *  transaction that is rolled back is never announced. */
export const alertEvents = new EventEmitter()

const EPOCH = /^[0-9a-f]{12}$/
const PUBLIC_ID = /^([0-9a-f]{12})-([1-9][0-9]{0,15})$/

function epoch(): string {
  const value = getMeta(ALERT_ID_EPOCH_KEY)
  if (!value || !EPOCH.test(value)) throw new Error(`the alert id prefix (${ALERT_ID_EPOCH_KEY}) is missing or invalid`)
  return value
}

/** The seq an id this database issued names, or null for any other id. */
export function alertSeq(id: string): number | null {
  const match = PUBLIC_ID.exec(id)
  if (!match || match[1] !== epoch()) return null
  const seq = Number(match[2])
  return Number.isSafeInteger(seq) ? seq : null
}

function fromRow(row: AlertRow, prefix: string): Alert {
  return { id: `${prefix}-${row.id}`, seq: row.id, kind: row.kind, title: row.title, body: row.body, path: row.url, createdAt: row.created_at }
}

let announceQueued = false
function announce(): void {
  if (announceQueued) return
  announceQueued = true
  setImmediate(() => {
    announceQueued = false
    alertEvents.emit('recorded')
  })
}

function assertInput(input: AlertInput): void {
  if (!ALERT_KINDS.includes(input.kind)) throw new Error(`unknown alert kind: ${String(input.kind)}`)
  if (!input.dedupeKey || input.dedupeKey.length > 512) throw new Error('an alert needs a dedupe key of at most 512 characters')
  if (!input.title.trim()) throw new Error('an alert needs a title')
  if (!input.path.startsWith('/') || input.path.startsWith('//')) throw new Error(`an alert opens a path in this workspace, not "${input.path}"`)
  if (input.target !== undefined && !isAlertTarget(input.target)) throw new Error(`an alert's notice cannot open ${JSON.stringify(input.target)}`)
}

export function pruneAlerts(now = Date.now()): number {
  return db.prepare('DELETE FROM alerts WHERE created_at < ?').run(new Date(now - ALERT_RETENTION_MS).toISOString()).changes
}

/** Records an alert unless one for the same key is still unresolved.
 *  Returns the new alert, or null when it was a duplicate. */
export function raiseAlert(input: AlertInput, now = Date.now()): Alert | null {
  assertInput(input)
  pruneAlerts(now)
  const createdAt = new Date(now).toISOString()
  const info = db.prepare(`
    INSERT INTO alerts(kind, title, body, url, created_at, dedupe_key, target)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) WHERE resolved_at IS NULL DO NOTHING
  `).run(input.kind, input.title, input.body, input.path, createdAt, input.dedupeKey, input.target ? JSON.stringify(input.target) : null)
  if (info.changes !== 1) return null
  announce()
  const seq = Number(info.lastInsertRowid)
  return { id: `${epoch()}-${seq}`, seq, kind: input.kind, title: input.title, body: input.body, path: input.path, createdAt }
}

/** The condition behind `dedupeKey` has cleared: the next raise alerts again. */
export function resolveAlert(dedupeKey: string, now = Date.now()): boolean {
  return db.prepare('UPDATE alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL')
    .run(new Date(now).toISOString(), dedupeKey).changes === 1
}

/** Alerts recorded after `seq` and inside the retention window, oldest first:
 *  the first `limit` of them, or with `newest` the last `limit`. */
export function alertsAfter(seq: number, limit: number, options: { newest?: boolean, now?: number } = {}): Alert[] {
  const cutoff = new Date((options.now ?? Date.now()) - ALERT_RETENTION_MS).toISOString()
  const rows = db.prepare(`
    SELECT id, kind, title, body, url, created_at FROM alerts
    WHERE id > ? AND created_at >= ?
    ORDER BY id ${options.newest ? 'DESC' : 'ASC'} LIMIT ?
  `).all(seq, cutoff, limit) as AlertRow[]
  if (options.newest) rows.reverse()
  const prefix = epoch()
  return rows.map((row) => fromRow(row, prefix))
}

/** The newest alert's seq, 0 when there is none. */
export function latestAlertSeq(): number {
  return (db.prepare('SELECT COALESCE(MAX(id), 0) AS seq FROM alerts').get() as { seq: number }).seq
}

/** An unresolved alert as its notice in the page needs it. */
export interface OpenAlert {
  id: string
  seq: number
  kind: AlertKind
  title: string
  body: string
  createdAt: string
  dedupeKey: string
  target: AlertTarget | null
  dismissedAt: string | null
  silencedAt: string | null
}

interface OpenAlertRow {
  id: number
  kind: AlertKind
  title: string
  body: string
  created_at: string
  dedupe_key: string
  target: string | null
  dismissed_at: string | null
  silenced_at: string | null
}

function storedTarget(raw: string | null): AlertTarget | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    return isAlertTarget(value) ? value : null
  } catch {
    return null
  }
}

/** The unresolved alerts inside the retention window, newest first; with
 *  `kind`, only those of that kind. */
export function openAlerts(options: { kind?: AlertKind, now?: number } = {}): OpenAlert[] {
  const cutoff = new Date((options.now ?? Date.now()) - ALERT_RETENTION_MS).toISOString()
  const rows = db.prepare(`
    SELECT id, kind, title, body, created_at, dedupe_key, target, dismissed_at, silenced_at FROM alerts
    WHERE resolved_at IS NULL AND created_at >= ? AND (? IS NULL OR kind = ?)
    ORDER BY id DESC
  `).all(cutoff, options.kind ?? null, options.kind ?? null) as OpenAlertRow[]
  const prefix = epoch()
  return rows.map((row) => ({
    id: `${prefix}-${row.id}`,
    seq: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    dedupeKey: row.dedupe_key,
    target: storedTarget(row.target),
    dismissedAt: row.dismissed_at,
    silencedAt: row.silenced_at,
  }))
}

/** The person put the notice of unresolved alert `seq` away. False when there
 *  is no such unresolved alert. */
export function dismissAlert(seq: number, now = Date.now()): boolean {
  return db.prepare('UPDATE alerts SET dismissed_at = ? WHERE id = ? AND resolved_at IS NULL')
    .run(new Date(now).toISOString(), seq).changes === 1
}

/** The person asked to hear no more about unresolved alert `seq`: its
 *  condition stays silenced, beyond the alert's own 30 days, until
 *  forgetSilence. False when there is no such unresolved alert. */
export function silenceAlert(seq: number, now = Date.now()): boolean {
  const at = new Date(now).toISOString()
  return db.transaction(() => {
    const row = db.prepare('SELECT dedupe_key FROM alerts WHERE id = ? AND resolved_at IS NULL').get(seq) as { dedupe_key: string } | undefined
    if (!row) return false
    db.prepare('UPDATE alerts SET silenced_at = ? WHERE id = ?').run(at, seq)
    db.prepare('INSERT INTO alert_silences(dedupe_key, silenced_at) VALUES(?, ?) ON CONFLICT(dedupe_key) DO NOTHING').run(row.dedupe_key, at)
    return true
  })()
}

/** Whether the person silenced the condition behind `dedupeKey`. */
export function silenced(dedupeKey: string): boolean {
  return !!db.prepare('SELECT 1 FROM alert_silences WHERE dedupe_key = ?').get(dedupeKey)
}

/** The silenced conditions whose dedupe key starts with `prefix`. */
export function silencedKeys(prefix: string): string[] {
  return (db.prepare('SELECT dedupe_key FROM alert_silences WHERE substr(dedupe_key, 1, ?) = ?').all(prefix.length, prefix) as Array<{ dedupe_key: string }>)
    .map((row) => row.dedupe_key)
}

/** The condition's subject is gone: a later one under the same key alerts. */
export function forgetSilence(dedupeKey: string): void {
  db.prepare('DELETE FROM alert_silences WHERE dedupe_key = ?').run(dedupeKey)
}

/** The kind of alert `seq`, unresolved or not; null when there is none. */
export function alertKind(seq: number): AlertKind | null {
  const row = db.prepare('SELECT kind FROM alerts WHERE id = ?').get(seq) as { kind: AlertKind } | undefined
  return row?.kind ?? null
}
