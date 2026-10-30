import { db } from '../db'
import './control-store'

// The Switchboard's durable state (docs/Switchboard.md): which chat it is,
// how far it has read every other chat, its checks and the items it posted.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_switchboard (
    instance TEXT PRIMARY KEY, session TEXT, created_at INTEGER,
    paused INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
    next_check_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, error TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_switchboard_cursors (
    instance TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY(instance, session)
  );
  CREATE TABLE IF NOT EXISTS chat_switchboard_checks (
    id TEXT PRIMARY KEY, instance TEXT NOT NULL, session TEXT NOT NULL, reason TEXT NOT NULL, chats TEXT NOT NULL,
    waiting INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'outstanding',
    finished_at INTEGER, outcome TEXT, tokens INTEGER
  );
  CREATE INDEX IF NOT EXISTS chat_switchboard_checks_state ON chat_switchboard_checks(instance, state, created_at);
  CREATE TABLE IF NOT EXISTS chat_switchboard_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL,
    source TEXT NOT NULL, source_seq INTEGER NOT NULL, kind TEXT NOT NULL,
    text TEXT NOT NULL, detail TEXT, options TEXT,
    source_title TEXT NOT NULL, source_agent TEXT NOT NULL, source_model TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    answer TEXT, answered_at INTEGER, resolved_reason TEXT, resolved_at INTEGER,
    explain_state TEXT NOT NULL DEFAULT 'none', explain_attempt INTEGER NOT NULL DEFAULT 0,
    explain_requested_at INTEGER, explanation TEXT, explained_at INTEGER, explain_error TEXT,
    UNIQUE(instance, source, source_seq, kind)
  );
  CREATE INDEX IF NOT EXISTS chat_switchboard_items_source ON chat_switchboard_items(instance, source, id);
`)

/** Items kept besides open decisions, newest first. */
export const RETAINED_ITEMS = 2_000
/** Transcript events that are news; streaming chunks of them count once, status churn never. */
const MEANINGFUL = ['turn.started', 'turn.finished', 'text.delta', 'tool.started', 'tool.finished', 'diff', 'plan.updated',
  'question.asked', 'question.answered', 'permission.requested', 'permission.resolved', 'steer.sent', 'error', 'session.closed']
const MEANINGFUL_SQL = MEANINGFUL.map(type => `'${type}'`).join(', ')
const OPEN_DECISION = `kind = 'decision' AND answer IS NULL AND resolved_at IS NULL`

export interface Board {
  instance: string, session: string | null, created_at: number | null,
  paused: number, revision: number, next_check_at: number, failures: number, error: string | null
}
export function board(instance: string): Board {
  db.prepare('INSERT OR IGNORE INTO chat_switchboard(instance) VALUES(?)').run(instance)
  return db.prepare('SELECT * FROM chat_switchboard WHERE instance = ?').get(instance) as Board
}
/** Every change the pane must see goes through here, inside its transaction.
 *  The row is never deleted, so the revision only ever grows. */
export function bump(instance: string): number {
  board(instance)
  return (db.prepare('UPDATE chat_switchboard SET revision = revision + 1 WHERE instance = ? RETURNING revision').get(instance) as { revision: number }).revision
}
export function setSession(instance: string, session: string | null, now: number): void {
  board(instance)
  db.prepare('UPDATE chat_switchboard SET session = ?, created_at = ?, next_check_at = 0, failures = 0, error = NULL WHERE instance = ?')
    .run(session, session ? now : null, instance)
}
export function setPaused(instance: string, paused: boolean): void {
  db.prepare('UPDATE chat_switchboard SET paused = ? WHERE instance = ?').run(paused ? 1 : 0, instance)
}
export function setError(instance: string, error: string | null): void {
  board(instance)
  db.prepare('UPDATE chat_switchboard SET error = ? WHERE instance = ?').run(error, instance)
}
export function setNextCheck(instance: string, at: number): void {
  db.prepare('UPDATE chat_switchboard SET next_check_at = ? WHERE instance = ?').run(at, instance)
}
/** Consecutive checks the Switchboard did not finish; returns the new count. */
export function recordFailure(instance: string): number {
  return (db.prepare('UPDATE chat_switchboard SET failures = failures + 1 WHERE instance = ? RETURNING failures').get(instance) as { failures: number }).failures
}
export function clearFailures(instance: string): void {
  db.prepare('UPDATE chat_switchboard SET failures = 0 WHERE instance = ?').run(instance)
}
export function isSwitchboardSession(session: string): boolean {
  return !!db.prepare('SELECT 1 FROM chat_switchboard WHERE session = ?').get(session)
}

export function cursors(instance: string): Map<string, number> {
  const rows = db.prepare('SELECT session, seq FROM chat_switchboard_cursors WHERE instance = ?').all(instance) as Array<{ session: string, seq: number }>
  return new Map(rows.map(row => [row.session, row.seq]))
}
/** Cursors only move forward. */
export function advanceCursor(instance: string, session: string, seq: number): void {
  db.prepare(`INSERT INTO chat_switchboard_cursors VALUES(?, ?, ?) ON CONFLICT(instance, session) DO UPDATE SET seq = MAX(seq, excluded.seq)`).run(instance, session, seq)
}
export function setCursor(instance: string, session: string, seq: number): void {
  db.prepare(`INSERT INTO chat_switchboard_cursors VALUES(?, ?, ?) ON CONFLICT(instance, session) DO UPDATE SET seq = excluded.seq`).run(instance, session, seq)
}
export function forgetCursor(instance: string, session: string): void {
  db.prepare('DELETE FROM chat_switchboard_cursors WHERE instance = ? AND session = ?').run(instance, session)
}

// ── The chats' own transcripts, read and never written ──────────────────

/** The newest meaningful event after `afterSeq`, or null when there is none. */
export function newsAfter(session: string, afterSeq: number): number | null {
  const row = db.prepare(`SELECT MAX(seq) AS seq FROM chat_events WHERE session_id = ? AND seq > ? AND json_extract(event, '$.type') IN (${MEANINGFUL_SQL})`)
    .get(session, afterSeq) as { seq: number | null }
  return row.seq
}
/** Where a fresh Switchboard starts reading a chat: just before its `turns`-th most recent turn. */
export function recentTurnsFrom(session: string, turns: number): number {
  const row = db.prepare(`SELECT seq FROM chat_events WHERE session_id = ? AND json_extract(event, '$.type') = 'turn.started' ORDER BY seq DESC LIMIT 1 OFFSET ?`)
    .get(session, turns - 1) as { seq: number } | undefined
  if (row) return row.seq - 1
  const first = db.prepare(`SELECT MIN(seq) AS seq FROM chat_events WHERE session_id = ?`).get(session) as { seq: number | null }
  return Math.max(0, (first.seq ?? 1) - 1)
}
export function turnsSince(session: string, seq: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM chat_events WHERE session_id = ? AND seq > ? AND json_extract(event, '$.type') = 'turn.started'`)
    .get(session, seq) as { n: number }).n
}

// ── Checks ──────────────────────────────────────────────────────────────

export interface CheckChat { sessionId: string, fromSeq: number, toSeq: number }
export interface Check { id: string, session: string, reason: string, chats: CheckChat[], waiting: number, created_at: number }
export function insertCheck(instance: string, check: Check): void {
  db.prepare('INSERT INTO chat_switchboard_checks(id, instance, session, reason, chats, waiting, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(check.id, instance, check.session, check.reason, JSON.stringify(check.chats.map(({ sessionId, fromSeq, toSeq }) => ({ sessionId, fromSeq, toSeq }))), check.waiting, check.created_at)
  // Only the recent past is shown; older finished checks are not evidence anyone reads.
  db.prepare(`DELETE FROM chat_switchboard_checks WHERE instance = ? AND state <> 'outstanding'
    AND id NOT IN (SELECT id FROM chat_switchboard_checks WHERE instance = ? ORDER BY created_at DESC LIMIT 50)`).run(instance, instance)
}
export function outstandingCheck(instance: string): Check | undefined {
  const row = db.prepare(`SELECT id, session, reason, chats, waiting, created_at FROM chat_switchboard_checks WHERE instance = ? AND state = 'outstanding'
    ORDER BY created_at DESC LIMIT 1`).get(instance) as (Omit<Check, 'chats'> & { chats: string }) | undefined
  return row ? { ...row, chats: JSON.parse(row.chats) as CheckChat[] } : undefined
}
export function finishCheck(instance: string, id: string, state: 'committed' | 'abandoned', outcome: string, now: number): boolean {
  return db.prepare(`UPDATE chat_switchboard_checks SET state = ?, outcome = ?, finished_at = ? WHERE instance = ? AND id = ? AND state = 'outstanding'`)
    .run(state, outcome, now, instance, id).changes === 1
}
/** What the turn that ran a check cost, as its native usage reported it. */
export function recordCheckTokens(instance: string, id: string, tokens: number): void {
  db.prepare('UPDATE chat_switchboard_checks SET tokens = ? WHERE instance = ? AND id = ?').run(tokens, instance, id)
}
export function lastCommitted(instance: string): { at: number, tokens: number | null } | undefined {
  return db.prepare(`SELECT finished_at AS at, tokens FROM chat_switchboard_checks WHERE instance = ? AND state = 'committed'
    ORDER BY finished_at DESC LIMIT 1`).get(instance) as { at: number, tokens: number | null } | undefined
}

// ── Items ───────────────────────────────────────────────────────────────

export interface ItemRow {
  id: number, instance: string, source: string, source_seq: number, kind: string, text: string, detail: string | null, options: string | null,
  source_title: string, source_agent: string, source_model: string, created_at: number,
  answer: string | null, answered_at: number | null, resolved_reason: string | null, resolved_at: number | null,
  explain_state: 'none' | 'pending' | 'ready' | 'failed', explain_attempt: number, explain_requested_at: number | null,
  explanation: string | null, explained_at: number | null, explain_error: string | null,
}
export interface NewItem {
  source: string, sourceSeq: number, kind: string, text: string, detail: string | null, options: unknown[] | null,
  sourceTitle: string, sourceAgent: string, sourceModel: string,
}
export function findItem(instance: string, source: string, sourceSeq: number, kind: string): number | undefined {
  return (db.prepare('SELECT id FROM chat_switchboard_items WHERE instance = ? AND source = ? AND source_seq = ? AND kind = ?')
    .get(instance, source, sourceSeq, kind) as { id: number } | undefined)?.id
}
/** Returns the item's id and whether it already existed: the first post of a source event and kind wins. */
export function insertItem(instance: string, item: NewItem, now: number): { id: number, duplicate: boolean } {
  const existing = db.prepare('SELECT id FROM chat_switchboard_items WHERE instance = ? AND source = ? AND source_seq = ? AND kind = ?')
    .get(instance, item.source, item.sourceSeq, item.kind) as { id: number } | undefined
  if (existing) return { id: existing.id, duplicate: true }
  const id = Number(db.prepare(`INSERT INTO chat_switchboard_items(instance, source, source_seq, kind, text, detail, options, source_title, source_agent, source_model, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(instance, item.source, item.sourceSeq, item.kind, item.text, item.detail,
    item.options ? JSON.stringify(item.options) : null, item.sourceTitle, item.sourceAgent, item.sourceModel, now).lastInsertRowid)
  db.prepare(`DELETE FROM chat_switchboard_items WHERE instance = ? AND NOT (${OPEN_DECISION})
    AND id NOT IN (SELECT id FROM chat_switchboard_items WHERE instance = ? ORDER BY id DESC LIMIT ?)`).run(instance, instance, RETAINED_ITEMS)
  return { id, duplicate: false }
}
export function openDecisions(instance: string, source?: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM chat_switchboard_items WHERE instance = ? AND (? IS NULL OR source = ?) AND ${OPEN_DECISION}`)
    .get(instance, source ?? null, source ?? null) as { n: number }).n
}
export function item(instance: string, id: number): ItemRow | undefined {
  return db.prepare('SELECT * FROM chat_switchboard_items WHERE instance = ? AND id = ?').get(instance, id) as ItemRow | undefined
}
/** Every open decision, and each chat's newest `perChat` items, newest first. */
export function items(instance: string, perChat = 5): ItemRow[] {
  return db.prepare(`SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY id DESC) AS position FROM chat_switchboard_items WHERE instance = ?
    ) WHERE position <= ? OR (${OPEN_DECISION}) ORDER BY id DESC`).all(instance, perChat) as ItemRow[]
}
export function sourceItems(instance: string, source: string, limit = 10): ItemRow[] {
  return db.prepare('SELECT * FROM chat_switchboard_items WHERE instance = ? AND source = ? ORDER BY id DESC LIMIT ?').all(instance, source, limit) as ItemRow[]
}
export function setAnswer(instance: string, id: number, answer: unknown, now: number): boolean {
  return db.prepare(`UPDATE chat_switchboard_items SET answer = ?, answered_at = ? WHERE instance = ? AND id = ? AND ${OPEN_DECISION}`)
    .run(JSON.stringify(answer), now, instance, id).changes === 1
}
export function resolveItem(instance: string, id: number, reason: string, now: number): boolean {
  return db.prepare(`UPDATE chat_switchboard_items SET resolved_reason = ?, resolved_at = ? WHERE instance = ? AND id = ? AND ${OPEN_DECISION}`)
    .run(reason, now, instance, id).changes === 1
}
export function requestExplanation(instance: string, id: number, attempt: number, now: number): void {
  db.prepare(`UPDATE chat_switchboard_items SET explain_state = 'pending', explain_attempt = ?, explain_requested_at = ?, explain_error = NULL
    WHERE instance = ? AND id = ?`).run(attempt, now, instance, id)
}
export function saveExplanation(instance: string, id: number, explanation: { changed: string, matters: string, uncertain: string }, now: number): boolean {
  return db.prepare(`UPDATE chat_switchboard_items SET explain_state = 'ready', explanation = ?, explained_at = ?, explain_error = NULL
    WHERE instance = ? AND id = ? AND explain_state = 'pending'`).run(JSON.stringify(explanation), now, instance, id).changes === 1
}
export function failExplanation(instance: string, id: number, attempt: number, error: string): boolean {
  return db.prepare(`UPDATE chat_switchboard_items SET explain_state = 'failed', explain_error = ?
    WHERE instance = ? AND id = ? AND explain_state = 'pending' AND explain_attempt = ?`).run(error, instance, id, attempt).changes === 1
}
export function failPendingExplanations(instance: string, error: string): void {
  db.prepare(`UPDATE chat_switchboard_items SET explain_state = 'failed', explain_error = ? WHERE instance = ? AND explain_state = 'pending'`).run(error, instance)
}
export function pendingExplanations(instance: string): Array<Pick<ItemRow, 'id' | 'explain_attempt' | 'explain_requested_at'>> {
  return db.prepare(`SELECT id, explain_attempt, explain_requested_at FROM chat_switchboard_items WHERE instance = ? AND explain_state = 'pending'`)
    .all(instance) as Array<Pick<ItemRow, 'id' | 'explain_attempt' | 'explain_requested_at'>>
}

// ── ChatControl's inbox: read here; only the Switchboard's own pending rows are withdrawn ──

export function inboxState(instance: string, recipient: string, eventKey: string): 'pending' | 'admitted' | undefined {
  const row = db.prepare('SELECT state FROM chat_control_inbox WHERE instance = ? AND recipient = ? AND event_key = ?')
    .get(instance, recipient, eventKey) as { state: 'pending' | 'admitted' } | undefined
  return row?.state
}
export function admittedEventKey(instance: string, recipient: string, turnId: string): string | undefined {
  const row = db.prepare('SELECT event_key FROM chat_control_inbox WHERE instance = ? AND recipient = ? AND turn_id = ?')
    .get(instance, recipient, turnId) as { event_key: string } | undefined
  return row?.event_key
}
/** A check Poise queued and no turn has admitted yet. */
export function withdraw(instance: string, recipient: string, eventKey: string): boolean {
  return db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND recipient = ? AND event_key = ? AND state = 'pending'`)
    .run(instance, recipient, eventKey).changes === 1
}
export function deliveryPaused(instance: string, session: string): boolean {
  return !!db.prepare('SELECT 1 FROM chat_control_paused WHERE instance = ? AND session = ?').get(instance, session)
}
