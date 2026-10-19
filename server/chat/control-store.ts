import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { HttpError } from '../http'

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
export const bindWork = db.transaction((instance: string, session: string, target: string): Binding => {
  const canonical = workTarget(target).url
  const existing = db.prepare('SELECT target, session, created_at FROM chat_work_bindings WHERE instance = ? AND target = ?').get(instance, canonical) as Binding | undefined
  if (existing && existing.session !== session) throw new HttpError(409, `${canonical} is owned by chat ${existing.session}; its owner must release it first`)
  if (existing) return existing
  const result = { target: canonical, session, created_at: Date.now() }
  db.prepare('DELETE FROM chat_control_observations WHERE instance = ? AND target IN (?, ?)').run(instance, `ci:${canonical}`, `behavior:${canonical}`)
  db.prepare('INSERT INTO chat_work_bindings VALUES(?, ?, ?, ?)').run(instance, canonical, session, result.created_at)
  return result
})
export function unbindWork(instance: string, session: string, target: string): void {
  const canonical = workTarget(target).url
  const owner = bindings(instance).find(b => b.target === canonical)
  if (owner && owner.session !== session) throw new HttpError(409, `only chat ${owner.session} can release this work`)
  db.prepare('DELETE FROM chat_work_bindings WHERE instance = ? AND target = ? AND session = ?').run(instance, canonical, session)
}

export function addChild(instance: string, manager: string, child: string): void {
  db.prepare('INSERT INTO chat_control_children VALUES(?, ?, ?)').run(child, manager, instance)
}
export function children(instance: string): Array<{ child: string, manager: string }> {
  return db.prepare('SELECT child, manager FROM chat_control_children WHERE instance = ?').all(instance) as Array<{ child: string, manager: string }>
}

export interface InternalMessage {
  seq: number, recipient: string, sender: string, body: string, created_at: number,
  state: 'pending' | 'admitted', turn_id: string | null
}
export function message(instance: string, recipient: string, sender: string, body: string, eventKey: string = randomUUID()): void {
  if (!body.trim() || Buffer.byteLength(body) > 32 * 1024) throw new HttpError(400, 'an internal message needs 1–32768 UTF-8 bytes')
  db.prepare(`INSERT INTO chat_control_inbox(instance, recipient, sender, event_key, body, created_at)
    VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(instance, recipient, event_key) DO NOTHING`).run(instance, recipient, sender, eventKey, body, Date.now())
}
export function inbox(instance: string, recipient: string, after = 0): InternalMessage[] {
  return db.prepare(`SELECT seq, recipient, sender, body, created_at, state, turn_id FROM chat_control_inbox
    WHERE instance = ? AND recipient = ? AND seq > ? ORDER BY seq LIMIT 100`).all(instance, recipient, after) as InternalMessage[]
}
export function pending(instance: string, afterRecipient = ''): InternalMessage[] {
  const page = db.prepare(`SELECT seq, recipient, sender, body, created_at, state, turn_id FROM chat_control_inbox
    WHERE instance = ? AND state = 'pending'
      AND seq IN (SELECT MIN(seq) FROM chat_control_inbox WHERE instance = ? AND state = 'pending' GROUP BY recipient)
      AND recipient IN (SELECT id FROM chat_sessions WHERE status = 'idle')
      AND recipient NOT IN (SELECT session FROM chat_control_paused WHERE instance = ?)
    ORDER BY CASE WHEN recipient > ? THEN 0 ELSE 1 END, recipient LIMIT 100`).all(instance, instance, instance, afterRecipient) as InternalMessage[]
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
export const forgetSession = db.transaction((instance: string, session: string): void => {
  db.prepare('DELETE FROM chat_work_bindings WHERE instance = ? AND session = ?').run(instance, session)
  db.prepare('UPDATE chat_control_watches SET enabled = 0 WHERE instance = ? AND owner = ?').run(instance, session)
  db.prepare('DELETE FROM chat_control_children WHERE instance = ? AND (child = ? OR manager = ?)').run(instance, session, session)
})
