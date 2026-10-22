// At-most-once command execution across sockets and server restarts.
// A durable pending marker precedes every mutation. An orphaned marker is
// an explicitly unknown outcome, NEVER permission to execute it again.
import { createHash } from 'node:crypto'
import { db } from '../db'
import type { ServerFrame } from './protocol'

type Ack = Extract<ServerFrame, { kind: 'ack' }>
interface Receipt { fingerprint: string, ack: string | null }
interface Active { fingerprint: string, promise: Promise<Ack> }
const active = new Map<string, Active>()
const MAX_ACTIVE = 128

db.exec(`CREATE TABLE IF NOT EXISTS chat_command_receipts (
  instance TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  ack TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (instance, request_id)
)`)

// The control operation each receipt recorded, and the time index the
// Manager budget counts through. Receipts written before this slice read
// the operation as NULL.
try {
  db.transaction(() => {
    const cols = db.prepare('PRAGMA table_info(chat_command_receipts)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'operation')) db.exec('ALTER TABLE chat_command_receipts ADD COLUMN operation TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS chat_command_receipts_time ON chat_command_receipts(instance, created_at)')
  }).immediate()
} catch (error) {
  // A concurrent process added the column first; anything else stops startup.
  if (!(error instanceof Error) || !error.message.includes('duplicate column name')) throw error
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('command nesting exceeds 64 levels')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']'
  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort().map(k => JSON.stringify(k) + ':' + canonical(record[k], depth + 1)).join(',') + '}'
  }
  throw new Error('command must contain only JSON values')
}

function failure(id: string, code: string, error: string): Ack {
  return { kind: 'ack', id, ok: false, code, error }
}

const reserve = db.transaction((instance: string, id: string, fingerprint: string, createdAt: string, operation: string | null): { fresh: boolean, receipt: Receipt } => {
  const result = db.prepare(`INSERT INTO chat_command_receipts (instance, request_id, fingerprint, ack, created_at, operation)
    VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT(instance, request_id) DO NOTHING`)
    .run(instance, id, fingerprint, createdAt, operation)
  const receipt = db.prepare('SELECT fingerprint, ack FROM chat_command_receipts WHERE instance = ? AND request_id = ?')
    .get(instance, id) as Receipt
  return { fresh: result.changes === 1, receipt }
})

/** Records contain a hash, not another copy of the prompt. Keep completed
 * receipts rather than evicting an old request ID and accidentally making
 * a delayed replay a new mutation. Transcripts and receipts are local data. */
export function executeCommandOnce(
  instance: string,
  id: string,
  command: unknown,
  execute: () => Promise<Ack>,
  options?: { now?: () => number, operation?: string },
): Promise<Ack> {
  let fingerprint: string
  try { fingerprint = createHash('sha256').update(canonical(command)).digest('hex') }
  catch (error) { return Promise.resolve(failure(id, 'invalid', error instanceof Error ? error.message : 'invalid command')) }
  const key = JSON.stringify([instance, id])
  const running = active.get(key)
  if (running) {
    return running.fingerprint === fingerprint ? running.promise
      : Promise.resolve(failure(id, 'request_id_conflict', 'this request ID was already used for a different command'))
  }
  if (active.size >= MAX_ACTIVE) return Promise.resolve(failure(id, 'overloaded', 'too many commands are in flight; nothing was executed'))
  let reserved: ReturnType<typeof reserve>
  try { reserved = reserve.immediate(instance, id, fingerprint, new Date((options?.now ?? Date.now)()).toISOString(), options?.operation ?? null) }
  catch { return Promise.resolve(failure(id, 'receipt_unavailable', 'could not reserve the command safely; nothing was executed')) }
  if (reserved.receipt.fingerprint !== fingerprint) {
    return Promise.resolve(failure(id, 'request_id_conflict', 'this request ID was already used for a different command'))
  }
  if (!reserved.fresh) {
    if (reserved.receipt.ack !== null) {
      try { return Promise.resolve(JSON.parse(reserved.receipt.ack) as Ack) }
      catch { /* corrupted receipt: do not run the command */ }
    }
    return Promise.resolve(failure(id, 'command_in_doubt',
      'the server stopped before confirming this command; its outcome is unknown and it was not replayed. Check the session before trying a new action.'))
  }
  // Deferring execute until the next microtask publishes the in-flight
  // promise before any user code can cause another command to arrive.
  const promise = Promise.resolve().then(execute).then(ack => {
    try {
      db.prepare('UPDATE chat_command_receipts SET ack = ? WHERE instance = ? AND request_id = ? AND fingerprint = ?')
        .run(JSON.stringify(ack), instance, id, fingerprint)
      return ack
    } catch {
      return failure(id, 'command_in_doubt', 'the command may have completed, but its receipt could not be saved; it will not be replayed automatically')
    }
  }, () => failure(id, 'command_in_doubt', 'the command failed before an outcome could be recorded; it will not be replayed automatically'))
    .finally(() => active.delete(key))
  active.set(key, { fingerprint, promise })
  return promise
}

/** Receipts recorded in one scope since an ISO time, optionally only some operations, with the oldest counted one. Read-only; uses (instance, created_at). */
export function countReceiptsSince(scope: string, sinceIso: string, operations?: { only?: string[], except?: string[] }): { count: number, oldest: string | null } {
  if (operations?.only && operations.only.length === 0) return { count: 0, oldest: null }
  let sql = 'SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM chat_command_receipts WHERE instance = ? AND created_at >= ?'
  const args: string[] = [scope, sinceIso]
  if (operations?.only?.length) { sql += ` AND operation IN (${operations.only.map(() => '?').join(',')})`; args.push(...operations.only) }
  if (operations?.except?.length) { sql += ` AND (operation IS NULL OR operation NOT IN (${operations.except.map(() => '?').join(',')}))`; args.push(...operations.except) }
  return db.prepare(sql).get(...args) as { count: number, oldest: string | null }
}

export function hasReceipt(scope: string, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM chat_command_receipts WHERE instance = ? AND request_id = ?').get(scope, id)
}
