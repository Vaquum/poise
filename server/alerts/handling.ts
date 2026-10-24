// The handling log: every handled action, append-only. A dismissal or an
// answer is recorded with its actor and timestamp even while the
// condition continues; a later clearing records another row. Retention is
// measured from the handling time, not from when the notice was created.

import { db } from '../db'

export const HANDLING_RETENTION_MS = 30 * 24 * 60 * 60_000
export const HANDLED_READ_LIMIT = 200

export type HandlingKind = 'notice' | 'behavior-firing' | 'caller-update'
export type HandlingActor = 'person' | 'api' | 'poise' | 'notices-service' | 'behaviors' | 'caller' | 'recovery'

export interface HandlingInput {
  kind: HandlingKind
  /** The behavior key, the alert kind, or the agent behavior, depending on kind. */
  source: string
  title: string
  startedAt: string
  finishedAt: string
  outcome: string
  error?: string | null
  actor: HandlingActor
  /** Idempotency key: the same action recorded twice writes one row. */
  ref: string
}

export interface HandlingRow {
  id: number
  kind: HandlingKind
  source: string
  title: string
  startedAt: string
  finishedAt: string
  outcome: string
  error: string | null
  actor: HandlingActor
  at: string
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

export function clipHandlingError(error: string | null | undefined): string | null {
  if (!error) return null
  return clip(error, 500)
}

/** Record one handled action. Recording the same ref twice keeps one row. */
export function recordHandling(input: HandlingInput, at = new Date().toISOString()): void {
  db.prepare(`
    INSERT OR IGNORE INTO handling_log (at, kind, source, title, started_at, finished_at, outcome, error, actor, ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(at, input.kind, input.source, input.title, input.startedAt, input.finishedAt,
    input.outcome, clipHandlingError(input.error), input.actor, input.ref)
}

/** The newest handled actions inside retention, newest first, optionally
 *  handled at or after `since`. */
export function listHandling(limit = HANDLED_READ_LIMIT, now = Date.now(), since?: string): HandlingRow[] {
  const cutoff = new Date(now - HANDLING_RETENTION_MS).toISOString()
  const rows = db.prepare(`
    SELECT id, kind, source, title, started_at, finished_at, outcome, error, actor, at
    FROM handling_log WHERE at >= ? AND (? IS NULL OR at >= ?) ORDER BY at DESC, id DESC LIMIT ?
  `).all(cutoff, since ?? null, since ?? null, limit) as Array<{ id: number, kind: HandlingKind, source: string, title: string, started_at: string,
    finished_at: string, outcome: string, error: string | null, actor: HandlingActor, at: string }>
  return rows.map((row) => ({ id: row.id, kind: row.kind, source: row.source, title: row.title,
    startedAt: row.started_at, finishedAt: row.finished_at, outcome: row.outcome,
    error: row.error, actor: row.actor, at: row.at }))
}

export function pruneHandling(now = Date.now()): number {
  return db.prepare('DELETE FROM handling_log WHERE at < ?').run(new Date(now - HANDLING_RETENTION_MS).toISOString()).changes
}
