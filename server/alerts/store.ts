// Alerts: what the workspace has to tell its owner while the browser is
// closed (docs/Service-architecture.md, "Snippets and Poise Link"). Poise Link
// shows each one as a desktop notification, once.
//
// An alert is raised under a dedupe key and stays the only one for that key
// until it is resolved, so a condition that persists alerts once, and alerts
// again only after it has cleared. Alerts are kept for 30 days.

import { EventEmitter } from 'node:events'
import { ALERT_ID_EPOCH_KEY, db, getMeta } from '../db'

export const ALERT_KINDS = ['sign_in_needed', 'behavior_held', 'datastore_sync_failing', 'chat_waiting', 'chat_turn_finished'] as const
export type AlertKind = typeof ALERT_KINDS[number]

export const ALERT_RETENTION_MS = 30 * 24 * 60 * 60_000

export interface AlertInput {
  kind: AlertKind
  /** One alert per key while it is unresolved. */
  dedupeKey: string
  title: string
  body: string
  /** The page in this workspace the alert opens, as a path. */
  path: string
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
    INSERT INTO alerts(kind, title, body, url, created_at, dedupe_key)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) WHERE resolved_at IS NULL DO NOTHING
  `).run(input.kind, input.title, input.body, input.path, createdAt, input.dedupeKey)
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
