import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { advanceWork, type WorkActionReceipt, type WorkDecision, type WorkObservation } from './work-rehearsal'

const MAX_RECORD_BYTES = 16 * 1024
interface Projection { observation: WorkObservation, receipt: WorkActionReceipt | null }

/** Explicitly opened on a rehearsal database only. No import opens Poise's database. */
export class WorkRehearsal {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS v2_rehearsal_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        work_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS v2_rehearsal_no_update BEFORE UPDATE ON v2_rehearsal_events BEGIN SELECT RAISE(ABORT, 'rehearsal events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS v2_rehearsal_no_delete BEFORE DELETE ON v2_rehearsal_events BEGIN SELECT RAISE(ABORT, 'rehearsal events are immutable'); END;
      CREATE INDEX IF NOT EXISTS v2_rehearsal_work ON v2_rehearsal_events(work_id, seq);
      CREATE TABLE IF NOT EXISTS v2_rehearsal_current (
        work_id TEXT PRIMARY KEY, observation TEXT NOT NULL, receipt TEXT
      );
    `)
  }

  private append(work: string, event: string, kind: string, value: unknown, at: number): boolean {
    const payload = JSON.stringify(value)
    if (!Number.isSafeInteger(at) || at < 0 || !work || !event || Buffer.byteLength(work) > 256 || Buffer.byteLength(event) > 512 || Buffer.byteLength(payload) > MAX_RECORD_BYTES) throw new Error('invalid or oversized rehearsal record')
    const existing = this.db.prepare('SELECT work_id, kind, payload, at FROM v2_rehearsal_events WHERE event_id = ?')
      .get(event) as { work_id: string, kind: string, payload: string, at: number } | undefined
    if (existing) {
      if ((kind !== 'proposal' && existing.at !== at) || existing.work_id !== work || existing.kind !== kind || existing.payload !== payload) throw new Error('rehearsal event identity conflicts with its durable record')
      return false
    }
    this.db.prepare('INSERT INTO v2_rehearsal_events(event_id, work_id, kind, payload, at) VALUES (?, ?, ?, ?, ?)')
      .run(event, work, kind, payload, at)
    return true
  }

  observe(event: string, observation: WorkObservation): void {
    this.db.transaction(() => {
      if (!this.append(observation.id, event, 'observation', observation, observation.checkedAt)) return
      const current = this.read(observation.id)
      if (!Number.isSafeInteger(observation.revision) || observation.revision < 1
        || !Number.isSafeInteger(observation.checkedAt) || observation.checkedAt < 0
        || (current && observation.revision <= current.observation.revision)) throw new Error('observation revision must advance')
      this.db.prepare(`INSERT INTO v2_rehearsal_current(work_id, observation) VALUES (?, ?)
        ON CONFLICT(work_id) DO UPDATE SET observation = excluded.observation`)
        .run(observation.id, JSON.stringify(observation))
    }).immediate()
  }

  importReceipt(work: string, event: string, receipt: WorkActionReceipt): void {
    this.db.transaction(() => {
      const current = this.read(work)
      if (!current || !Number.isSafeInteger(receipt.basisRevision) || receipt.basisRevision < 1 || receipt.basisRevision > current.observation.revision
        || !Number.isSafeInteger(receipt.requestedAt) || receipt.requestedAt < 0 || receipt.requestedAt > receipt.at || !receipt.reference) throw new Error('receipt needs its recorded observation and native reference')
      if (!this.append(work, event, 'receipt', receipt, receipt.at)) return
      const prior = current.receipt
      if (prior?.attempt === receipt.attempt && (prior.action !== receipt.action || prior.head !== receipt.head
        || prior.issueBodyRevision !== receipt.issueBodyRevision || prior.basisRevision !== receipt.basisRevision || prior.requestedAt !== receipt.requestedAt)) throw new Error('native attempt identity or settlement conflicts')
      // Late native facts remain in immutable history without replacing newer ownership or backoff.
      if (prior && (receipt.basisRevision < prior.basisRevision || receipt.requestedAt < prior.requestedAt
        || (prior.attempt === receipt.attempt && receipt.at < prior.at))) return
      if (prior?.attempt === receipt.attempt && prior.state === 'finished' && receipt.state !== 'finished') throw new Error('native attempt settlement conflicts')
      if (prior && ['running', 'uncertain'].includes(prior.state) && prior.attempt !== receipt.attempt) {
        throw new Error('an unsettled attempt cannot be replaced')
      }
      if (prior && prior.attempt !== receipt.attempt && prior.basisRevision === receipt.basisRevision
        && prior.requestedAt === receipt.requestedAt) throw new Error('native attempt order is ambiguous')
      this.db.prepare('UPDATE v2_rehearsal_current SET receipt = ? WHERE work_id = ?').run(JSON.stringify(receipt), work)
    }).immediate()
  }

  read(work: string): Projection | null {
    const row = this.db.prepare('SELECT observation, receipt FROM v2_rehearsal_current WHERE work_id = ?')
      .get(work) as { observation: string, receipt: string | null } | undefined
    return row ? { observation: JSON.parse(row.observation) as WorkObservation,
      receipt: row.receipt === null ? null : JSON.parse(row.receipt) as WorkActionReceipt } : null
  }

  history(work: string, limit = 20): Array<{ seq: number, kind: string, payload: string, at: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('history limit must be 1 to 100')
    return this.db.prepare('SELECT seq, kind, payload, at FROM v2_rehearsal_events WHERE work_id = ? ORDER BY seq DESC LIMIT ?')
      .all(work, limit) as Array<{ seq: number, kind: string, payload: string, at: number }>
  }

  propose(work: string, now: number): WorkDecision {
    return this.db.transaction(() => {
      const current = this.read(work)
      if (!current) throw new Error('work has no recorded observation')
      const decision = advanceWork(current.observation, current.receipt, now)
      const identity = createHash('sha256').update(JSON.stringify([work, current.observation.revision, current.receipt, decision])).digest('hex')
      this.append(work, `proposal:${identity}`, 'proposal', decision, now)
      return decision
    }).immediate()
  }
}
