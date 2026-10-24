import { randomUUID } from 'node:crypto'
import { db, getMeta, setMeta } from '../db'
import { HttpError } from '../http'
import type { ChatActor, ChatHold, PersonActor, TimerSummary, TimerView } from './protocol'

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_control_children (
    child TEXT PRIMARY KEY, manager TEXT NOT NULL, instance TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_work_bindings (
    instance TEXT NOT NULL, target TEXT NOT NULL, session TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(instance, target)
  );
  CREATE TABLE IF NOT EXISTS chat_control_inbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL,
    recipient TEXT NOT NULL, sender TEXT NOT NULL, event_key TEXT NOT NULL,
    body TEXT NOT NULL, created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', turn_id TEXT,
    UNIQUE(instance, recipient, event_key)
  );
  CREATE INDEX IF NOT EXISTS chat_control_pending ON chat_control_inbox(instance, state, recipient, seq);
  CREATE INDEX IF NOT EXISTS chat_control_pending_seq ON chat_control_inbox(instance, state, seq);
  CREATE TABLE IF NOT EXISTS chat_control_watches (
    id TEXT PRIMARY KEY, instance TEXT NOT NULL, owner TEXT NOT NULL,
    targets TEXT NOT NULL, instruction TEXT NOT NULL, interval_ms INTEGER NOT NULL,
    next_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS chat_control_observations (
    instance TEXT NOT NULL, target TEXT NOT NULL, fingerprint TEXT NOT NULL,
    checked_at INTEGER NOT NULL, PRIMARY KEY(instance, target)
  );
  CREATE TABLE IF NOT EXISTS chat_control_paused (
    instance TEXT NOT NULL, session TEXT NOT NULL, PRIMARY KEY(instance, session)
  );
  CREATE TABLE IF NOT EXISTS chat_control_timers (
    id TEXT PRIMARY KEY, instance TEXT NOT NULL, target TEXT NOT NULL,
    set_by_kind TEXT NOT NULL CHECK (set_by_kind IN ('person','chat')),
    set_by_session TEXT, set_by_title TEXT, set_by_role TEXT,
    label TEXT NOT NULL, message TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('once','every')),
    interval_ms INTEGER NOT NULL, next_at INTEGER, not_before INTEGER,
    state TEXT NOT NULL CHECK (state IN ('active','held','tripped','done','cancelled','expired')),
    reason TEXT, failures INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS chat_control_timers_due ON chat_control_timers(instance, state, next_at);
  CREATE INDEX IF NOT EXISTS chat_control_timers_target ON chat_control_timers(instance, target, state);
  CREATE INDEX IF NOT EXISTS chat_control_timers_setter ON chat_control_timers(instance, set_by_session);
  CREATE TABLE IF NOT EXISTS chat_control_holds (
    instance TEXT NOT NULL, session TEXT NOT NULL,
    cause TEXT NOT NULL CHECK (cause IN ('stopped','held')), since INTEGER NOT NULL,
    PRIMARY KEY (instance, session)
  );
`)

// Sender snapshots for attribution: which chat sent each inbox row, frozen
// when it was sent. Rows written before this slice read both as NULL.
try {
  db.transaction(() => {
    const cols = db.prepare('PRAGMA table_info(chat_control_inbox)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'sender_title')) db.exec('ALTER TABLE chat_control_inbox ADD COLUMN sender_title TEXT')
    if (!cols.some((c) => c.name === 'sender_role')) db.exec('ALTER TABLE chat_control_inbox ADD COLUMN sender_role TEXT')
    if (!cols.some((c) => c.name === 'timer_id')) db.exec('ALTER TABLE chat_control_inbox ADD COLUMN timer_id TEXT')
    if (!cols.some((c) => c.name === 'timer_missed')) db.exec('ALTER TABLE chat_control_inbox ADD COLUMN timer_missed INTEGER NOT NULL DEFAULT 0')
    if (!cols.some((c) => c.name === 'admitted_at')) db.exec('ALTER TABLE chat_control_inbox ADD COLUMN admitted_at INTEGER')
  }).immediate()
} catch (error) {
  // A concurrent process added the column first; anything else stops startup.
  if (!(error instanceof Error) || !error.message.includes('duplicate column name')) throw error
}

// After the columns exist: one pending delivery per timer is a database
// guarantee, and the admitted window plus turn_id serve retention, the
// exactly-once check and timerForTurn.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS chat_control_inbox_timer_pending ON chat_control_inbox(instance, timer_id)
    WHERE state = 'pending' AND timer_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS chat_control_inbox_timer_window ON chat_control_inbox(instance, admitted_at) WHERE timer_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS chat_control_inbox_turn ON chat_control_inbox(turn_id);
`)

export interface WorkTarget { url: string, repo: string, kind: 'issues' | 'pull', number: number }
export function workTarget(value: string): WorkTarget {
  if (Buffer.byteLength(value) > 1024) throw new HttpError(400, 'a GitHub work target may contain at most 1024 UTF-8 bytes')
  const match = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(value)
  if (!match || !Number.isSafeInteger(Number(match[3]))) throw new HttpError(400, 'target must be an exact GitHub issue or pull request URL')
  const repo = match[1].toLowerCase()
  const kind = match[2] as WorkTarget['kind']
  const number = Number(match[3])
  return { url: `https://github.com/${repo}/${kind}/${number}`, repo, kind, number }
}

export interface Binding { target: string, session: string, created_at: number }
export function bindings(instance: string): Binding[] {
  return db.prepare('SELECT target, session, created_at FROM chat_work_bindings WHERE instance = ? ORDER BY target').all(instance) as Binding[]
}
export function bindingIsCurrent(instance: string, binding: Binding): boolean {
  return !!db.prepare('SELECT 1 FROM chat_work_bindings WHERE instance = ? AND target = ? AND session = ? AND created_at = ?')
    .get(instance, binding.target, binding.session, binding.created_at)
}
/** The sender every work-monitor notice carries. */
export const WORK_MONITOR_SENDER = 'Poise work monitor'
/** Event-key prefixes the work monitor's notices carry, one per watched facet. */
const NOTICE_PREFIXES = ['ci:', 'behavior:', 'merge:', 'reviews:', 'ci-degraded:']
/** One observation key per watched facet of a bound target, plus the
 *  degraded-read marker and the reviews seen-set sidecar, which carries
 *  no notices. A new owner starts from no baseline on all of them, so
 *  current blockers wake it even when the old owner saw them. */
const OBSERVATION_PREFIXES = [...NOTICE_PREFIXES, 'reviews-seen:', 'reviews-cursor:']
function resetTargetObservations(instance: string, url: string): void {
  db.prepare(`DELETE FROM chat_control_observations WHERE instance = ? AND target IN (${OBSERVATION_PREFIXES.map(() => '?').join(', ')})`)
    .run(instance, ...OBSERVATION_PREFIXES.map(prefix => `${prefix}${url}`))
  const seenPrefix = `reviews-seen:${url}:`
  db.prepare('DELETE FROM chat_control_observations WHERE instance = ? AND substr(target, 1, length(?)) = ?')
    .run(instance, seenPrefix, seenPrefix)
}
export const bindWork = db.transaction((instance: string, session: string, target: string): Binding => {
  const canonical = workTarget(target).url
  const existing = db.prepare('SELECT target, session, created_at FROM chat_work_bindings WHERE instance = ? AND target = ?').get(instance, canonical) as Binding | undefined
  if (existing && existing.session !== session) throw new HttpError(409, `${canonical} is owned by chat ${existing.session}; its owner must release it first`)
  if (existing) return existing
  const result = { target: canonical, session, created_at: Date.now() }
  resetTargetObservations(instance, canonical)
  db.prepare('INSERT INTO chat_work_bindings VALUES(?, ?, ?, ?)').run(instance, canonical, session, result.created_at)
  return result
})
export function unbindWork(instance: string, session: string, target: string): void {
  const canonical = workTarget(target).url
  const owner = bindings(instance).find(b => b.target === canonical)
  if (owner && owner.session !== session) throw new HttpError(409, `only chat ${owner.session} can release this work`)
  db.prepare('DELETE FROM chat_work_bindings WHERE instance = ? AND target = ? AND session = ?').run(instance, canonical, session)
}
/** Move every work binding from one chat to another: a handoff's ownership
 *  transfer. The new owner starts from no observation baseline; the old
 *  owner's still-pending work-monitor notices for those targets, and its
 *  session-keyed stall notices, are dropped, so they never wake it stale
 *  after the transfer. */
export const moveBindings = db.transaction((instance: string, from: string, to: string): Binding[] => {
  const moved = db.prepare('SELECT target, session, created_at FROM chat_work_bindings WHERE instance = ? AND session = ?')
    .all(instance, from) as Binding[]
  for (const binding of moved) {
    db.prepare('UPDATE chat_work_bindings SET session = ?, created_at = ? WHERE instance = ? AND target = ? AND session = ?')
      .run(to, Date.now(), instance, binding.target, from)
    resetTargetObservations(instance, binding.target)
    // The colon after the URL keeps `…/pull/1` from matching `…/pull/12`;
    // LIKE wildcards in the URL itself are escaped.
    const escaped = binding.target.replace(/[\\%_]/g, ch => `\\${ch}`)
    for (const prefix of NOTICE_PREFIXES) {
      db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND recipient = ? AND sender = ? AND state = 'pending'
        AND event_key LIKE ? ESCAPE '\\'`).run(instance, from, WORK_MONITOR_SENDER, `${prefix}${escaped}:%`)
    }
  }
  // Session-keyed stall notices name the old worker's group and episode,
  // not the work: the source stays open but unbound, so its pending ones
  // drop instead of waking it after the transfer.
  const session = from.replace(/[\\%_]/g, ch => `\\${ch}`)
  db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND recipient = ? AND sender = ? AND state = 'pending'
    AND (event_key LIKE ? ESCAPE '\\' OR event_key LIKE ? ESCAPE '\\')`)
    .run(instance, from, WORK_MONITOR_SENDER, `stall:${session}:%`, `stall-done:${session}:%`)
  return moved.map(binding => ({ ...binding, session: to }))
})
/** Release every work binding a chat holds. Closing settles work rather
 *  than starting it, and a closed chat never receives monitor notices, so
 *  its targets become claimable by the replacement chat. */
export function releaseBindings(instance: string, session: string): void {
  db.prepare('DELETE FROM chat_work_bindings WHERE instance = ? AND session = ?').run(instance, session)
}

export function addChild(instance: string, manager: string, child: string): void {
  db.prepare('INSERT INTO chat_control_children VALUES(?, ?, ?)').run(child, manager, instance)
}
export function children(instance: string): Array<{ child: string, manager: string }> {
  return db.prepare('SELECT child, manager FROM chat_control_children WHERE instance = ?').all(instance) as Array<{ child: string, manager: string }>
}

export interface InternalMessage {
  seq: number, recipient: string, sender: string, event_key: string, body: string, created_at: number,
  state: 'pending' | 'admitted', turn_id: string | null, sender_title: string | null, sender_role: 'manager' | null,
  timer_id: string | null, timer_missed: number
}
const INBOX_COLUMNS = 'seq, recipient, sender, event_key, body, created_at, state, turn_id, sender_title, sender_role, timer_id, timer_missed'
export function message(instance: string, recipient: string, sender: string, body: string, eventKey: string = randomUUID(), from?: { title: string, role?: 'manager' }): boolean {
  if (!body.trim() || Buffer.byteLength(body) > 32 * 1024) throw new HttpError(400, 'an internal message needs 1–32768 UTF-8 bytes')
  return db.prepare(`INSERT INTO chat_control_inbox(instance, recipient, sender, event_key, body, created_at, sender_title, sender_role)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(instance, recipient, event_key) DO NOTHING`).run(instance, recipient, sender, eventKey, body, Date.now(), from?.title ?? null, from?.role ?? null).changes > 0
}
export function inbox(instance: string, recipient: string, after = 0): InternalMessage[] {
  return db.prepare(`SELECT ${INBOX_COLUMNS} FROM chat_control_inbox
    WHERE instance = ? AND recipient = ? AND seq > ? ORDER BY seq LIMIT 100`).all(instance, recipient, after) as InternalMessage[]
}
/** Per recipient, two candidates: the oldest pending ordinary row and the
 *  oldest pending timer row. A hold excludes the recipient from both: while
 *  a chat is held, its timers skip their firings and turns other chats
 *  would start in it wait. Page by 100 recipients, retaining both candidates
 *  at the boundary. The tick picks at most one row per recipient. */
export function pending(instance: string, afterRecipient = '', now = Date.now()): InternalMessage[] {
  const page = db.prepare(`WITH candidates AS (
      SELECT ${INBOX_COLUMNS} FROM chat_control_inbox
      WHERE instance = ? AND state = 'pending' AND timer_id IS NULL
        AND seq IN (SELECT MIN(seq) FROM chat_control_inbox WHERE instance = ? AND state = 'pending' AND timer_id IS NULL GROUP BY recipient)
        AND recipient IN (SELECT id FROM chat_sessions WHERE status = 'idle')
        AND recipient NOT IN (SELECT session FROM chat_control_paused WHERE instance = ?)
        AND recipient NOT IN (SELECT session FROM chat_control_holds WHERE instance = ?)
      UNION ALL
      SELECT ${INBOX_COLUMNS} FROM chat_control_inbox i
      WHERE i.instance = ? AND i.state = 'pending' AND i.timer_id IS NOT NULL
        AND i.seq = (SELECT MIN(seq) FROM chat_control_inbox
          WHERE instance = ? AND state = 'pending' AND timer_id IS NOT NULL AND recipient = i.recipient
          AND timer_id IN (SELECT id FROM chat_control_timers WHERE instance = ? AND state = 'active'
            AND (not_before IS NULL OR not_before <= ?)))
        AND i.recipient IN (SELECT id FROM chat_sessions WHERE status IN ('idle','interrupted','error','closed'))
        AND i.timer_id IN (SELECT id FROM chat_control_timers WHERE instance = ? AND state = 'active'
          AND (not_before IS NULL OR not_before <= ?))
        AND i.recipient NOT IN (SELECT session FROM chat_control_holds WHERE instance = ?)
    ), recipients AS (
      SELECT recipient FROM candidates GROUP BY recipient
      ORDER BY CASE WHEN recipient > ? THEN 0 ELSE 1 END, recipient LIMIT 100
    ) SELECT ${INBOX_COLUMNS} FROM candidates WHERE recipient IN (SELECT recipient FROM recipients)
      ORDER BY CASE WHEN recipient > ? THEN 0 ELSE 1 END, recipient, seq`)
    .all(instance, instance, instance, instance, instance, instance, instance, now, instance, now, instance, afterRecipient, afterRecipient) as InternalMessage[]
  return page
}
export function pauseDelivery(instance: string, session: string): void {
  db.prepare('INSERT OR IGNORE INTO chat_control_paused VALUES(?, ?)').run(instance, session)
}
export function resumeDelivery(instance: string, session: string): void {
  db.prepare('DELETE FROM chat_control_paused WHERE instance = ? AND session = ?').run(instance, session)
}
export function internalTurn(turnId: string): boolean {
  return !!db.prepare('SELECT 1 FROM chat_control_inbox WHERE turn_id = ?').get(turnId)
}
export interface Watch { id: string, owner: string, targets: string, instruction: string, interval_ms: number, next_at: number, enabled: number }
export function watches(instance: string, owner?: string): Watch[] {
  return db.prepare('SELECT id, owner, targets, instruction, interval_ms, next_at, enabled FROM chat_control_watches WHERE instance = ? AND (? IS NULL OR owner = ?)')
    .all(instance, owner ?? null, owner ?? null) as Watch[]
}
export function addWatch(instance: string, owner: string, targets: string[], minutes: number, instruction: string): string {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new HttpError(400, 'intervalMinutes must be an integer from 1 to 1440')
  if (!targets.length || targets.length > 20 || new Set(targets).size !== targets.length || targets.includes(owner)) throw new HttpError(400, 'supervision needs 1–20 distinct other chats')
  if (!instruction.trim() || Buffer.byteLength(instruction) > 8192) throw new HttpError(400, 'supervision needs an instruction of at most 8192 UTF-8 bytes')
  const id = randomUUID()
  db.prepare('INSERT INTO chat_control_watches VALUES(?, ?, ?, ?, ?, ?, ?, 1)').run(id, instance, owner, JSON.stringify(targets), instruction, minutes * 60_000, Date.now() + minutes * 60_000)
  return id
}
export function stopWatch(instance: string, owner: string, id: string): void {
  if (!db.prepare('UPDATE chat_control_watches SET enabled = 0 WHERE id = ? AND instance = ? AND owner = ?').run(id, instance, owner).changes) throw new HttpError(404, 'unknown supervision owned by this chat')
}
export const fireWatch = db.transaction((instance: string, watch: Watch, body: string, now: number): void => {
  const changed = db.prepare('UPDATE chat_control_watches SET next_at = ? WHERE id = ? AND instance = ? AND enabled = 1 AND next_at = ?')
    .run(now + watch.interval_ms, watch.id, instance, watch.next_at).changes
  if (changed) message(instance, watch.owner, 'Poise supervision', body, `watch:${watch.id}:${watch.next_at}`)
})

export function observation(instance: string, target: string): { fingerprint: string, checked_at: number } | undefined {
  return db.prepare('SELECT fingerprint, checked_at FROM chat_control_observations WHERE instance = ? AND target = ?').get(instance, target) as { fingerprint: string, checked_at: number } | undefined
}
export function saveObservation(instance: string, target: string, fingerprint: string, now: number): void {
  db.prepare(`INSERT INTO chat_control_observations VALUES(?, ?, ?, ?) ON CONFLICT(instance, target)
    DO UPDATE SET fingerprint = excluded.fingerprint, checked_at = excluded.checked_at`).run(instance, target, fingerprint, now)
}
export function deleteObservation(instance: string, target: string): void {
  db.prepare('DELETE FROM chat_control_observations WHERE instance = ? AND target = ?').run(instance, target)
}
export interface ForgottenTimers { /** Timers that targeted the deleted chat. */ targets: Array<{ id: string }>, /** Timers the deleted chat set, by surviving target. */ setters: Array<{ id: string, target: string }> }
export const forgetSession = db.transaction((instance: string, session: string, now: number = Date.now()): ForgottenTimers => {
  db.prepare('DELETE FROM chat_work_bindings WHERE instance = ? AND session = ?').run(instance, session)
  db.prepare('UPDATE chat_control_watches SET enabled = 0 WHERE instance = ? AND owner = ?').run(instance, session)
  db.prepare('DELETE FROM chat_control_children WHERE instance = ? AND (child = ? OR manager = ?)').run(instance, session, session)
  // A deleted chat's undelivered messages go with it; delivered ones stay
  // in the recipients' transcripts.
  db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND sender = ? AND state = 'pending'`).run(instance, session)
  const targets = (db.prepare(`SELECT id FROM chat_control_timers WHERE instance = ? AND target = ?
    AND state IN ('active','held','tripped')`).all(instance, session) as Array<{ id: string }>)
  for (const timer of targets) {
    db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id = ? AND state = 'pending'`).run(instance, timer.id)
    db.prepare(`UPDATE chat_control_timers SET state = 'done', reason = 'target_deleted', next_at = NULL,
      updated_at = ?, ended_at = ? WHERE id = ?`).run(now, now, timer.id)
  }
  const setters = (db.prepare(`SELECT id, target FROM chat_control_timers WHERE instance = ? AND set_by_kind = 'chat'
    AND set_by_session = ? AND state IN ('active','held','tripped')`).all(instance, session) as Array<{ id: string, target: string }>)
  for (const timer of setters) {
    db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id = ? AND state = 'pending'`).run(instance, timer.id)
    db.prepare(`UPDATE chat_control_timers SET state = 'cancelled', reason = 'creator_deleted', next_at = NULL,
      updated_at = ?, ended_at = ? WHERE id = ?`).run(now, now, timer.id)
  }
  db.prepare('DELETE FROM chat_control_holds WHERE instance = ? AND session = ?').run(instance, session)
  return { targets, setters }
})

// ── Durable timers ─────────────────────────────────────────────────────

/** Bounds every timer keeps. There is no daily cap: the 5-minute minimum,
 *  the live-timer caps, the person's holds and the trip bound the cost. */
export const TIMER_LIMITS = {
  labelChars: 80, messageBytes: 8192, delayMinutes: [1, 10080] as [number, number], everyMinutes: [5, 1440] as [number, number],
  perChat: 5, perInstance: 100, tripAfter: 3, waitingLongMs: 3_600_000, personGraceMs: 60_000, keepAdmittedMs: 604_800_000,
} as const

export type TimerState = 'active' | 'held' | 'tripped' | 'done' | 'cancelled' | 'expired'
export type TimerReason = NonNullable<TimerSummary['reason']>
export type WaitingFor = NonNullable<NonNullable<TimerSummary['pending']>['waitingFor']>
const LIVE_STATES = "('active','held','tripped')"
const ENDED_STATES = "('done','cancelled','expired')"

export interface TimerRow {
  id: string, instance: string, target: string, set_by_kind: 'person' | 'chat',
  set_by_session: string | null, set_by_title: string | null, set_by_role: string | null,
  label: string, message: string, kind: 'once' | 'every', interval_ms: number,
  next_at: number | null, not_before: number | null, state: TimerState, reason: TimerReason | null,
  failures: number, skipped: number, created_at: number, updated_at: number, ended_at: number | null,
}
const TIMER_COLUMNS = 'id, instance, target, set_by_kind, set_by_session, set_by_title, set_by_role, label, message, kind, interval_ms, next_at, not_before, state, reason, failures, skipped, created_at, updated_at, ended_at'

function previewOf(message: string): string {
  const points = Array.from(message)
  return points.length > 200 ? `${points.slice(0, 200).join('')}…` : message
}

function setterOf(row: TimerRow): ChatActor | PersonActor {
  if (row.set_by_kind === 'person' || !row.set_by_session) return { kind: 'person' }
  return { kind: 'chat', sessionId: row.set_by_session, title: row.set_by_title ?? '',
    ...(row.set_by_role === 'manager' ? { role: 'manager' as const } : {}) }
}

function summaryOf(row: TimerRow, pending?: { since: string, missed: number }): TimerSummary {
  const minutes = Math.round(row.interval_ms / 60_000)
  return {
    id: row.id, sessionId: row.target, label: row.label, preview: previewOf(row.message),
    schedule: row.kind === 'once' ? { kind: 'once', delayMinutes: minutes } : { kind: 'every', minutes },
    nextAt: row.next_at === null ? null : new Date(row.next_at).toISOString(),
    notBefore: row.not_before === null ? null : new Date(row.not_before).toISOString(),
    state: row.state, ...(row.reason ? { reason: row.reason } : {}),
    setBy: setterOf(row), failures: row.failures, skipped: row.skipped,
    ...(pending ? { pending } : {}), createdAt: new Date(row.created_at).toISOString(),
  }
}

/** The timer's pending delivery row, if it has one. */
export function timerPendingRow(instance: string, timerId: string): { seq: number, timer_missed: number, created_at: number, event_key: string } | undefined {
  return db.prepare(`SELECT seq, timer_missed, created_at, event_key FROM chat_control_inbox
    WHERE instance = ? AND timer_id = ? AND state = 'pending'`).get(instance, timerId) as
    { seq: number, timer_missed: number, created_at: number, event_key: string } | undefined
}

function viewOf(row: TimerRow): TimerView {
  const pending = timerPendingRow(row.instance, row.id)
  return { ...summaryOf(row, pending ? { since: new Date(pending.created_at).toISOString(), missed: pending.timer_missed } : undefined),
    message: row.message }
}

export function timerById(instance: string, id: string): TimerView | null {
  const row = db.prepare(`SELECT ${TIMER_COLUMNS} FROM chat_control_timers WHERE instance = ? AND id = ?`).get(instance, id) as TimerRow | undefined
  return row ? viewOf(row) : null
}

function timerRowById(instance: string, id: string): TimerRow | undefined {
  return db.prepare(`SELECT ${TIMER_COLUMNS} FROM chat_control_timers WHERE instance = ? AND id = ?`).get(instance, id) as TimerRow | undefined
}

/** The raw row, for the tick's wait evaluation. */
export function timerRow(instance: string, id: string): TimerRow | null {
  return timerRowById(instance, id) ?? null
}

/** Why a target's timers are held: its own hold first, else the workspace hold. */
export function holdReasonFor(instance: string, target: string): TimerReason | null {
  const hold = db.prepare('SELECT cause FROM chat_control_holds WHERE instance = ? AND session = ?').get(instance, target) as { cause: string } | undefined
  if (hold?.cause === 'held') return 'person_held'
  if (hold?.cause === 'stopped') return 'person_stopped'
  return allTimersHeld(instance).held ? 'all_held' : null
}

export function createTimer(instance: string, input: { sessionId: string, label: string, message: string, delayMinutes?: number, everyMinutes?: number },
  setBy: ChatActor | PersonActor, now: number): TimerView {
  const label = input.label.trim()
  if (![...label].length || [...label].length > TIMER_LIMITS.labelChars) throw new HttpError(400, 'label needs 1–80 characters')
  if (!input.message.trim() || Buffer.byteLength(input.message) > TIMER_LIMITS.messageBytes) throw new HttpError(400, 'message needs 1–8192 UTF-8 bytes')
  const delayMinutes = input.delayMinutes, everyMinutes = input.everyMinutes
  const delays = delayMinutes !== undefined, everies = everyMinutes !== undefined
  const delayOk = delayMinutes !== undefined && Number.isInteger(delayMinutes) && delayMinutes >= 1 && delayMinutes <= 10080
  const everyOk = everyMinutes !== undefined && Number.isInteger(everyMinutes) && everyMinutes >= 5 && everyMinutes <= 1440
  if ((delays ? 1 : 0) + (everies ? 1 : 0) !== 1 || (delays && !delayOk) || (everies && !everyOk)) {
    throw new HttpError(400, 'use exactly one of delayMinutes (1–10080) or everyMinutes (5–1440)')
  }
  const kind = everies ? 'every' : 'once'
  const intervalMs = (everies ? everyMinutes! : delayMinutes!) * 60_000
  const perChat = (db.prepare(`SELECT COUNT(*) AS n FROM chat_control_timers WHERE instance = ? AND target = ? AND state IN ${LIVE_STATES}`)
    .get(instance, input.sessionId) as { n: number }).n
  if (perChat >= TIMER_LIMITS.perChat) throw new HttpError(400, `this chat already has ${TIMER_LIMITS.perChat} timers`)
  if (setBy.kind === 'chat') {
    const perInstance = (db.prepare(`SELECT COUNT(*) AS n FROM chat_control_timers WHERE instance = ? AND set_by_kind = 'chat' AND state IN ${LIVE_STATES}`)
      .get(instance) as { n: number }).n
    if (perInstance >= TIMER_LIMITS.perInstance) throw new HttpError(400, `this Poise instance already has ${TIMER_LIMITS.perInstance} timers`)
  }
  const reason = holdReasonFor(instance, input.sessionId)
  const id = randomUUID()
  db.prepare(`INSERT INTO chat_control_timers(id, instance, target, set_by_kind, set_by_session, set_by_title, set_by_role,
      label, message, kind, interval_ms, next_at, state, reason, failures, skipped, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`)
    .run(id, instance, input.sessionId, setBy.kind, setBy.kind === 'chat' ? setBy.sessionId : null,
      setBy.kind === 'chat' ? setBy.title : null, setBy.kind === 'chat' ? (setBy.role ?? null) : null,
      label, input.message, kind, intervalMs, now + intervalMs, reason ? 'held' : 'active', reason, now, now)
  return timerById(instance, id)!
}

function timerForChange(instance: string, id: string, by: ChatActor | PersonActor): TimerRow {
  const row = timerRowById(instance, id)
  if (!row) throw new HttpError(404, 'unknown timer in this Poise instance')
  if (row.set_by_kind === 'person' && by.kind !== 'person') throw new HttpError(403, 'only the person can change a timer the person set')
  return row
}

export function cancelTimer(instance: string, id: string, by: ChatActor | PersonActor, now: number): TimerView {
  const row = timerForChange(instance, id, by)
  if (row.state === 'done' || row.state === 'cancelled' || row.state === 'expired') return viewOf(row)
  const remove = db.transaction(() => {
    db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id = ? AND state = 'pending'`).run(instance, id)
    db.prepare(`UPDATE chat_control_timers SET state = 'cancelled', reason = ?, next_at = NULL, updated_at = ?, ended_at = ?
      WHERE id = ?`).run(by.kind === 'person' ? 'cancelled_by_person' : 'cancelled_by_manager', now, now, id)
  })
  remove()
  return timerById(instance, id)!
}

export function rearmTimer(instance: string, id: string, by: ChatActor | PersonActor, now: number): TimerView {
  const row = timerForChange(instance, id, by)
  if (row.state !== 'tripped') throw new HttpError(400, 'only a tripped timer can be re-armed')
  db.transaction(() => {
    // A firing orphaned before trips cleaned up never delivers stale.
    db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id = ? AND state = 'pending'`).run(instance, id)
    db.prepare(`UPDATE chat_control_timers SET state = 'active', reason = NULL, failures = 0, not_before = NULL,
      next_at = ?, updated_at = ? WHERE id = ?`).run(now + row.interval_ms, now, id)
  })()
  return timerById(instance, id)!
}

/** Live timers, plus timers that ended in the last 24 hours. */
export function timers(instance: string, target: string | undefined, now: number): TimerView[] {
  const rows = (target === undefined
    ? db.prepare(`SELECT ${TIMER_COLUMNS} FROM chat_control_timers WHERE instance = ?
        AND (state IN ${LIVE_STATES} OR ended_at >= ?) ORDER BY created_at, id`).all(instance, now - 86_400_000)
    : db.prepare(`SELECT ${TIMER_COLUMNS} FROM chat_control_timers WHERE instance = ? AND target = ?
        AND (state IN ${LIVE_STATES} OR ended_at >= ?) ORDER BY created_at, id`).all(instance, target, now - 86_400_000)) as TimerRow[]
  return rows.map(viewOf)
}

/** Live summaries for one chat's session record. */
export function timerSummaries(instance: string, target: string): TimerSummary[] {
  const rows = db.prepare(`SELECT ${TIMER_COLUMNS} FROM chat_control_timers WHERE instance = ? AND target = ?
    AND state IN ${LIVE_STATES} ORDER BY created_at, id`).all(instance, target) as TimerRow[]
  return rows.map((row) => {
    const pending = timerPendingRow(instance, row.id)
    return summaryOf(row, pending ? { since: new Date(pending.created_at).toISOString(), missed: pending.timer_missed } : undefined)
  })
}

export function timerForTurn(instance: string, turnId: string): TimerView | null {
  const row = db.prepare(`SELECT ${TIMER_COLUMNS.split(',').map(c => `t.${c.trim()}`).join(', ')} FROM chat_control_timers t
    JOIN chat_control_inbox i ON i.timer_id = t.id WHERE t.instance = ? AND i.turn_id = ?`).get(instance, turnId) as TimerRow | undefined
  return row ? viewOf(row) : null
}

// ── Holds ────────────────────────────────────────────────────────────

export function holdChat(instance: string, session: string, cause: 'stopped' | 'held', now: number): void {
  const existing = db.prepare('SELECT cause FROM chat_control_holds WHERE instance = ? AND session = ?').get(instance, session) as { cause: string } | undefined
  if (!existing) db.prepare('INSERT INTO chat_control_holds VALUES(?, ?, ?, ?)').run(instance, session, cause, now)
  // An explicit Hold upgrades a Stop's hold; a later Stop never turns `held` into `stopped`.
  else if (cause === 'held' && existing.cause === 'stopped') {
    db.prepare('UPDATE chat_control_holds SET cause = ?, since = ? WHERE instance = ? AND session = ?').run(cause, now, instance, session)
  }
}

export function releaseChatHold(instance: string, session: string, only?: 'stopped'): void {
  if (only) db.prepare('DELETE FROM chat_control_holds WHERE instance = ? AND session = ? AND cause = ?').run(instance, session, only)
  else db.prepare('DELETE FROM chat_control_holds WHERE instance = ? AND session = ?').run(instance, session)
}

export function holds(instance: string): ChatHold[] {
  return (db.prepare('SELECT session, cause, since FROM chat_control_holds WHERE instance = ? ORDER BY session').all(instance) as
    Array<{ session: string, cause: 'stopped' | 'held', since: number }>)
    .map((row) => ({ sessionId: row.session, cause: row.cause, since: new Date(row.since).toISOString() }))
}

const allHeldKey = (instance: string): string => `chat_timers_hold:${instance}`

export function setAllTimersHeld(instance: string, held: boolean, now: number): void {
  setMeta(allHeldKey(instance), JSON.stringify({ held, since: held ? now : null }))
}

export function allTimersHeld(instance: string): { held: boolean, since: number | null } {
  try {
    const raw = getMeta(allHeldKey(instance))
    if (!raw) return { held: false, since: null }
    const parsed = JSON.parse(raw) as { held?: unknown, since?: unknown }
    return { held: parsed.held === true, since: typeof parsed.since === 'number' ? parsed.since : null }
  } catch { return { held: false, since: null } }
}

// ── Tick primitives ──────────────────────────────────────────────────

/** Every live timer, oldest first. */
export function liveTimers(instance: string): TimerView[] {
  const rows = db.prepare(`SELECT ${TIMER_COLUMNS} FROM chat_control_timers WHERE instance = ? AND state IN ${LIVE_STATES}
    ORDER BY created_at, id`).all(instance) as TimerRow[]
  return rows.map(viewOf)
}

/** Occurrences due at `now`: how many, the latest due time, and the next
 *  phase point after now. A one-shot has one occurrence and no next. */
export function occurrencesDue(kind: 'once' | 'every', intervalMs: number, nextAt: number | null, now: number): { count: number, latestDue: number, next: number | null } | null {
  if (nextAt === null || nextAt > now) return null
  if (kind === 'once') return { count: 1, latestDue: nextAt, next: null }
  const count = Math.floor((now - nextAt) / intervalMs) + 1
  return { count, latestDue: nextAt + (count - 1) * intervalMs, next: nextAt + count * intervalMs }
}

/** One transaction advances `next_at` and inserts or updates the timer's
 *  single pending row. A row already waiting absorbs the new occurrences
 *  into its collapsed count. */
export const fireTimer = db.transaction((instance: string, id: string, now: number): { seq: number, missed: number, dueAt: number } | null => {
  const row = timerRowById(instance, id)
  if (!row || row.state !== 'active') return null
  const due = occurrencesDue(row.kind, row.interval_ms, row.next_at, now)
  if (!due) return null
  db.prepare('UPDATE chat_control_timers SET next_at = ?, updated_at = ? WHERE id = ?').run(due.next, now, id)
  // A backward clock clamp can revisit an admitted due timestamp. The
  // transaction owns admission; a fresh firing identity must not collide
  // with that earlier occurrence's retained row. Keep due time last.
  const eventKey = `timer:${id}:${randomUUID()}:${due.latestDue}`
  const sender = row.set_by_kind === 'chat' && row.set_by_session ? row.set_by_session : 'Poise timer'
  const existing = timerPendingRow(instance, id)
  if (existing) {
    db.prepare(`UPDATE chat_control_inbox SET timer_missed = timer_missed + ?, event_key = ? WHERE seq = ?`)
      .run(due.count, eventKey, existing.seq)
    return { seq: existing.seq, missed: existing.timer_missed + due.count, dueAt: due.latestDue }
  }
  const inserted = db.prepare(`INSERT INTO chat_control_inbox(instance, recipient, sender, event_key, body, created_at,
      sender_title, sender_role, timer_id, timer_missed)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(instance, row.target, sender, eventKey, row.message, now,
      row.set_by_kind === 'chat' ? row.set_by_title : null, row.set_by_role === 'manager' ? 'manager' : null, id, due.count - 1)
  return { seq: Number(inserted.lastInsertRowid), missed: due.count - 1, dueAt: due.latestDue }
})

/** Skip a held timer's due occurrences: no row, `skipped` grows, a pending
 *  row is deleted and counted, a fired or due one-shot expires, and the
 *  timer carries the hold's reason until the hold is gone. */
export const applyTimerHold = db.transaction((instance: string, id: string, reason: TimerReason, now: number):
  { state: TimerState, became: 'held' | 'expired' | 'already' } => {
  const row = timerRowById(instance, id)
  if (!row || (row.state !== 'active' && row.state !== 'held')) return { state: row?.state ?? 'done', became: 'already' }
  const pending = timerPendingRow(instance, id)
  if (pending) db.prepare(`DELETE FROM chat_control_inbox WHERE seq = ?`).run(pending.seq)
  const due = occurrencesDue(row.kind, row.interval_ms, row.next_at, now)
  const skipped = row.skipped + (due?.count ?? 0) + (pending ? 1 : 0)
  // A fired one-shot (`next_at` NULL) holds nothing back: expiring it now
  // keeps the release from resurrecting a timer with no row and no schedule.
  if (row.kind === 'once' && (due || row.next_at === null)) {
    db.prepare(`UPDATE chat_control_timers SET state = 'expired', reason = 'skipped_while_held', next_at = NULL,
      skipped = ?, updated_at = ?, ended_at = ? WHERE id = ?`).run(skipped, now, now, id)
    return { state: 'expired', became: 'expired' }
  }
  if (row.kind === 'every' && due) db.prepare('UPDATE chat_control_timers SET next_at = ? WHERE id = ?').run(due.next, id)
  const became = row.state === 'active' ? 'held' as const : 'already' as const
  db.prepare('UPDATE chat_control_timers SET state = ?, reason = ?, skipped = ?, updated_at = ? WHERE id = ?')
    .run('held', reason, skipped, now, id)
  return { state: 'held', became }
})

export function releaseTimerHold(instance: string, id: string, now: number): boolean {
  const changed = db.prepare(`UPDATE chat_control_timers SET state = 'active', reason = NULL, updated_at = ?
    WHERE id = ? AND instance = ? AND state = 'held'`).run(now, id, instance).changes
  return changed === 1
}

/** Account a finished timer turn. `exempt` is #356's scheduled wake-up,
 *  which never backs off or trips. A one-shot ends on its first turn. */
export function recordTimerTurn(instance: string, id: string, outcome: 'ok' | 'fail', now: number, exempt = false):
  { state: TimerState, failures: number, tripped: boolean, ended: boolean } {
  const row = timerRowById(instance, id)
  if (!row) return { state: 'done', failures: 0, tripped: false, ended: true }
  // A turn that finishes after its timer ended changes nothing: the ending
  // already recorded and noted it. Only live timers record outcomes.
  if (row.state !== 'active' && row.state !== 'held') return { state: row.state, failures: row.failures, tripped: false, ended: false }
  if (outcome === 'ok') {
    if (row.kind === 'once') {
      db.prepare(`UPDATE chat_control_timers SET state = 'done', reason = 'completed', failures = 0, updated_at = ?, ended_at = ?
        WHERE id = ?`).run(now, now, id)
      return { state: 'done', failures: 0, tripped: false, ended: true }
    }
    db.prepare('UPDATE chat_control_timers SET failures = 0, not_before = NULL, updated_at = ? WHERE id = ?').run(now, id)
    return { state: row.state, failures: 0, tripped: false, ended: false }
  }
  const failures = row.failures + 1
  if (exempt) {
    db.prepare('UPDATE chat_control_timers SET failures = ?, updated_at = ? WHERE id = ?').run(failures, now, id)
    return { state: row.state, failures, tripped: false, ended: false }
  }
  if (row.kind === 'once') {
    db.prepare(`UPDATE chat_control_timers SET state = 'done', reason = 'turn_failed', failures = ?, updated_at = ?, ended_at = ?
      WHERE id = ?`).run(failures, now, now, id)
    return { state: 'done', failures, tripped: false, ended: true }
  }
  if (failures >= TIMER_LIMITS.tripAfter) {
    db.transaction(() => {
      // A firing queued while the third turn ran dies with the trip: leaving
      // it would block the chat's other timers and deliver stale on re-arm.
      db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id = ? AND state = 'pending'`).run(instance, id)
      db.prepare(`UPDATE chat_control_timers SET state = 'tripped', reason = 'failed_3_times', failures = ?, next_at = NULL,
        updated_at = ? WHERE id = ?`).run(failures, now, id)
    })()
    return { state: 'tripped', failures, tripped: true, ended: false }
  }
  db.prepare('UPDATE chat_control_timers SET failures = ?, not_before = ?, updated_at = ? WHERE id = ?')
    .run(failures, now + row.interval_ms * 2 ** failures, now, id)
  return { state: row.state, failures, tripped: false, ended: false }
}

/** A clock that moved backward clamps a `next_at` more than one interval
 *  ahead back to `now + interval`. */
export function clampTimerClocks(instance: string, now: number): number {
  return db.prepare(`UPDATE chat_control_timers SET next_at = ? + interval_ms, updated_at = ?
    WHERE instance = ? AND state IN ('active','held') AND next_at IS NOT NULL AND next_at > ? + interval_ms`)
    .run(now, now, instance, now).changes
}

export interface SweptTimers { targets: Array<{ id: string, target: string }>, setters: Array<{ id: string, target: string }> }

/** End timers whose target is gone, purged or foreign, and timers set by a
 *  chat that is gone; drop hold rows of chats that no longer exist. */
export const sweepStaleTimers = db.transaction((instance: string, now: number): SweptTimers => {
  const targets = db.prepare(`SELECT t.id, t.target FROM chat_control_timers t WHERE t.instance = ? AND t.state IN ${LIVE_STATES}
    AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id = t.target AND s.instance = t.instance)`)
    .all(instance) as Array<{ id: string, target: string }>
  for (const timer of targets) {
    db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id = ? AND state = 'pending'`).run(instance, timer.id)
    db.prepare(`UPDATE chat_control_timers SET state = 'done', reason = 'target_deleted', next_at = NULL,
      updated_at = ?, ended_at = ? WHERE id = ?`).run(now, now, timer.id)
  }
  const setters = db.prepare(`SELECT t.id, t.target FROM chat_control_timers t WHERE t.instance = ? AND t.state IN ${LIVE_STATES}
    AND t.set_by_kind = 'chat' AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id = t.set_by_session AND s.instance = t.instance)`)
    .all(instance) as Array<{ id: string, target: string }>
  for (const timer of setters) {
    db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id = ? AND state = 'pending'`).run(instance, timer.id)
    db.prepare(`UPDATE chat_control_timers SET state = 'cancelled', reason = 'creator_deleted', next_at = NULL,
      updated_at = ?, ended_at = ? WHERE id = ?`).run(now, now, timer.id)
  }
  db.prepare(`DELETE FROM chat_control_holds WHERE instance = ?
    AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id = session AND s.instance = ?)`).run(instance, instance)
  return { targets, setters }
})

/** Bounded retention: an ended timer goes 30 days after `ended_at` with its
 *  inbox rows; a live timer's admitted rows go after 7 days once their
 *  turns finish. Open-turn mappings remain available for outcome accounting. */
export const retainTimers = db.transaction((instance: string, now: number): { timers: number, rows: number } => {
  const ended = db.prepare(`SELECT id FROM chat_control_timers WHERE instance = ? AND state IN ${ENDED_STATES}
    AND ended_at <= ? ORDER BY ended_at LIMIT 100`).all(instance, now - 30 * 86_400_000) as Array<{ id: string }>
  for (const timer of ended) {
    db.prepare('DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id = ?').run(instance, timer.id)
    db.prepare('DELETE FROM chat_control_timers WHERE id = ?').run(timer.id)
  }
  const rows = db.prepare(`DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id IS NOT NULL AND state = 'admitted'
    AND admitted_at <= ? AND timer_id IN (SELECT id FROM chat_control_timers WHERE instance = ? AND state IN ${LIVE_STATES})
    AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.instance = chat_control_inbox.instance
      AND s.open_turn_id = chat_control_inbox.turn_id) LIMIT 500`)
    .run(instance, now - 7 * 86_400_000, instance).changes
  return { timers: ended.length, rows: Number(rows) }
})

/** Pending timer rows with their timers, for delivery waits and warnings. */
export function timerPendingWaits(instance: string): Array<{ seq: number, timer_id: string, recipient: string, timer_missed: number, created_at: number }> {
  return db.prepare(`SELECT i.seq, i.timer_id, i.recipient, i.timer_missed, i.created_at FROM chat_control_inbox i
    JOIN chat_control_timers t ON t.id = i.timer_id
    WHERE i.instance = ? AND i.state = 'pending' AND i.timer_id IS NOT NULL AND t.state = 'active'
    ORDER BY i.seq`).all(instance) as Array<{ seq: number, timer_id: string, recipient: string, timer_missed: number, created_at: number }>
}
