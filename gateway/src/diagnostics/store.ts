import Database from 'better-sqlite3'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { scopePrefix, SEVERITIES, type LogEvent } from './contract.js'

import type { LogAccess, LogFilter, Coverage, LogPolicy, LoggingPage } from './query-contract.js'
export type { LogAccess, LogFilter, Coverage, LogPolicy } from './query-contract.js'
export function projectCoverage(value: Coverage, access: LogAccess): Coverage {
  return access.operator || value.workspace === access.workspace ? value : {
    ...value, id: 'shared_' + createHash('sha256').update(value.id).digest('hex').slice(0, 16), error: value.error ? 'Source unavailable; an operator can inspect the cause.' : null,
    gaps: value.gaps.map((gap) => ({ ...gap, reason: 'Shared source collection gap' })),
  }
}
export const DEFAULT_LOG_POLICY: LogPolicy = { retentionMs: 30 * 86_400_000, maxBytes: 64 * 1024 * 1024, maxEvents: 50_000 }
export const MAX_COVERAGE_SOURCES = 256
export const MAX_COVERAGE_RECORD_BYTES = 64 * 1024
// Coverage rows and their SQLite page/index overhead cannot consume event headroom.
const COVERAGE_PAGE_RESERVE_BYTES = 2 * MAX_COVERAGE_SOURCES * MAX_COVERAGE_RECORD_BYTES
interface EventRow { id: string; sort_time: string; payload: string }
interface Cursor { kind: 'page' | 'watermark' | 'delivery'; high: number; time?: string; id?: string; filter: string }

export class DiagnosticCursorError extends Error {}

export class DiagnosticEventError extends Error {
  constructor(readonly eventId: string, message: string, readonly record: LogEvent) { super(message) }
}

export class DiagnosticConflictError extends Error {
  constructor(readonly eventId: string, readonly record: LogEvent) { super('Conflicting immutable Logging event identity: ' + eventId) }
}

export class DiagnosticStore {
  private readonly db: Database.Database
  constructor(readonly path: string, readonly policy: LogPolicy = DEFAULT_LOG_POLICY, readonly now = Date.now, readonly readOnly = false) {
    if (!Object.values(policy).every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('Logging retention and storage limits must be positive integers')
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { readonly: readOnly, fileMustExist: readOnly })
    try {
      this.db.pragma('busy_timeout = 25')
      if (readOnly) {
        this.checkVersion()
        return
      }
      if (path !== ':memory:') chmodSync(path, 0o600)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('secure_delete = ON')
      this.db.pragma('cache_size = -2048')
      this.db.pragma('wal_autocheckpoint = 128')
      this.db.pragma('journal_size_limit = 8388608')
      const pageBytes = this.db.pragma('page_size', { simple: true }) as number
      this.db.pragma(`max_page_count = ${Math.ceil((policy.maxBytes * 2 + COVERAGE_PAGE_RESERVE_BYTES + 1024 * 1024) / pageBytes)}`)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS log_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, incident_id TEXT NOT NULL,
          sort_time TEXT NOT NULL, ingested_at TEXT NOT NULL,
          severity TEXT NOT NULL CHECK (severity IN ('critical','error','warning')),
          source TEXT NOT NULL, component TEXT NOT NULL, workspace TEXT, visibility TEXT NOT NULL CHECK (visibility IN ('workspace','operator','infrastructure')),
          account TEXT, repository TEXT, call_id TEXT, correlation_id TEXT, search TEXT NOT NULL,
          bytes INTEGER NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS log_scope_time ON log_events(workspace, sort_time DESC, id DESC);
        CREATE INDEX IF NOT EXISTS log_time ON log_events(sort_time DESC, id DESC);
        CREATE INDEX IF NOT EXISTS log_ingestion_seq ON log_events(ingested_at,seq);
        CREATE INDEX IF NOT EXISTS log_incident ON log_events(incident_id);
        CREATE INDEX IF NOT EXISTS log_call ON log_events(call_id);
        CREATE TABLE IF NOT EXISTS log_coverage (id TEXT PRIMARY KEY, workspace TEXT, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS log_expired (id TEXT PRIMARY KEY, workspace TEXT, visibility TEXT NOT NULL CHECK (visibility IN ('workspace','operator','infrastructure')), expired_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS log_expired_order ON log_expired(expired_at DESC,id DESC);
        CREATE TABLE IF NOT EXISTS log_usage (id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL, bytes INTEGER NOT NULL);
        INSERT OR IGNORE INTO log_usage SELECT 1,COUNT(*),COALESCE(SUM(bytes),0) FROM log_events;
        CREATE TRIGGER IF NOT EXISTS log_usage_insert AFTER INSERT ON log_events BEGIN
          UPDATE log_usage SET count=count+1,bytes=bytes+NEW.bytes WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS log_usage_delete AFTER DELETE ON log_events BEGIN
          UPDATE log_usage SET count=count-1,bytes=bytes-OLD.bytes WHERE id=1;
        END;
        CREATE TABLE IF NOT EXISTS log_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO log_meta VALUES ('version','1');
      `)
      this.db.prepare("INSERT OR IGNORE INTO log_meta VALUES ('cursor_key',?)").run(randomBytes(32).toString('hex'))
      this.checkVersion()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private checkVersion(): void {
    const version = this.db.prepare("SELECT value FROM log_meta WHERE key='version'").get() as { value: string } | undefined
    if (version?.value !== '1') throw new Error(`Unsupported Logging store version ${version?.value ?? 'missing'}`)
  }

  append(events: readonly LogEvent[]): number {
    if (events.length > 100) throw new Error('Logging ingestion batch exceeds 100 events')
    return this.db.transaction(() => {
      let inserted = 0
      this.prune()
      for (const event of events) {
        if (event.version !== 1 || !SEVERITIES.includes(event.severity)) throw new DiagnosticEventError(event.id, 'Invalid Logging event version or severity', event)
        const payload = JSON.stringify(event)
        const payloadBytes = Buffer.byteLength(payload)
        if (payloadBytes > 64 * 1024) throw new DiagnosticEventError(event.id, 'Logging event exceeds 64 KiB', event)
        const prefix = scopePrefix(event.workspace, event.visibility)
        if (!/^evt_[a-f0-9]{16}_[a-f0-9]{64}$/.test(event.id) || event.id.split('_')[1] !== prefix
          || !new RegExp(`^inc_${prefix}_[a-f0-9]{64}$`).test(event.incidentId)) throw new DiagnosticEventError(event.id, 'Logging event identity is outside its authorized scope', event)
        if (this.db.prepare('SELECT 1 FROM log_expired WHERE id=?').get(event.id)) continue
        if (Date.parse(event.ingestedAt) < this.now() - this.policy.retentionMs) {
          this.db.prepare('INSERT OR IGNORE INTO log_expired VALUES (?,?,?,?)').run(event.id, event.workspace, event.visibility,
            new Date(Date.parse(event.ingestedAt) + this.policy.retentionMs).toISOString())
          continue
        }
        const existing = this.db.prepare('SELECT payload FROM log_events WHERE id=?').get(event.id) as { payload: string } | undefined
        if (existing) {
          if (!isDeepStrictEqual({ ...JSON.parse(existing.payload), ingestedAt: null }, { ...event, ingestedAt: null })) throw new DiagnosticConflictError(event.id, event)
          continue
        }
        const search = [event.message, event.target, event.id, event.incidentId, event.callId, event.correlationId,
          event.requestId, event.operation, event.repository, event.account].filter(Boolean).join('\n').toLowerCase()
        // Account for the searchable projection and a conservative index allowance.
        const bytes = payloadBytes + Buffer.byteLength(search) + 1024
        if (bytes > this.policy.maxBytes) throw new DiagnosticEventError(event.id, 'Logging event exceeds the configured storage budget', event)
        this.evict(bytes)
        inserted += this.db.prepare(`INSERT OR IGNORE INTO log_events
          (id,incident_id,sort_time,ingested_at,severity,source,component,workspace,visibility,account,repository,call_id,correlation_id,search,bytes,payload)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.id, event.incidentId, event.eventTime ?? event.ingestedAt,
          event.ingestedAt, event.severity, event.source, event.component, event.workspace, event.visibility,
          event.account, event.repository, event.callId, event.correlationId, search, bytes, payload).changes
      }
      this.prune()
      return inserted
    })()
  }

  prune(reserve = 0): void {
    if (reserve > this.policy.maxBytes) throw new Error('Logging event exceeds the configured storage budget')
    const cutoff = new Date(this.now() - this.policy.retentionMs).toISOString()
    this.db.prepare("INSERT OR IGNORE INTO log_expired SELECT id,workspace,visibility,strftime('%Y-%m-%dT%H:%M:%fZ',ingested_at,?) FROM log_events WHERE ingested_at < ?").run(`+${this.policy.retentionMs / 1000} seconds`, cutoff)
    this.db.prepare('DELETE FROM log_events WHERE ingested_at < ?').run(cutoff)
    this.db.prepare('DELETE FROM log_expired WHERE expired_at < ?').run(cutoff)
    this.evict(reserve)
    this.db.prepare('DELETE FROM log_expired WHERE id IN (SELECT id FROM log_expired ORDER BY expired_at DESC,id DESC LIMIT -1 OFFSET ?)').run(Math.max(1, Math.min(this.policy.maxEvents * 2, Math.floor(this.policy.maxBytes / 1024))))
  }

  private evict(reserve: number): void {
    let { count, bytes } = this.db.prepare('SELECT count,bytes FROM log_usage WHERE id=1').get() as { count: number; bytes: number }

    while (bytes + reserve > this.policy.maxBytes || count + (reserve ? 1 : 0) > this.policy.maxEvents) {
      const oldest = this.db.prepare('SELECT id,workspace,visibility,sort_time,bytes FROM log_events ORDER BY ingested_at,seq LIMIT 1').get() as { id: string; workspace: string | null; visibility: string; sort_time: string; bytes: number } | undefined
      if (!oldest) break
      this.db.prepare('INSERT OR IGNORE INTO log_expired VALUES (?,?,?,?)').run(oldest.id, oldest.workspace, oldest.visibility, new Date(this.now()).toISOString())
      this.db.prepare('DELETE FROM log_events WHERE id=?').run(oldest.id)
      bytes -= oldest.bytes
      count--
    }
  }

  coverage(value: Coverage): void {
    if (!value.id || value.id.length > 256 || (value.workspace !== null && value.workspace.length > 512)) throw new Error('Logging coverage identity exceeds its bound')
    const payload = JSON.stringify({ ...value, gaps: value.gaps.slice(-32).map((gap) => ({ ...gap, reason: gap.reason.slice(0, 128) })) })
    if (Buffer.byteLength(payload) > MAX_COVERAGE_RECORD_BYTES) throw new Error('Logging coverage exceeds its bound')
    this.db.transaction(() => {
      const count = (this.db.prepare('SELECT COUNT(*) AS count FROM log_coverage').get() as { count: number }).count
      if (count >= MAX_COVERAGE_SOURCES && !this.db.prepare('SELECT 1 FROM log_coverage WHERE id=?').get(value.id)) throw new Error('Logging coverage source limit of 256 reached')
      this.db.prepare('INSERT INTO log_coverage VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,payload=excluded.payload').run(value.id, value.workspace, payload)
    }).immediate()
  }

  readCoverage(access: LogAccess): Coverage[] {
    const rows = this.db.prepare('SELECT payload FROM log_coverage WHERE workspace=? OR workspace IS NULL').all(access.workspace) as Array<{ payload: string }>
    return rows.map(({ payload }) => projectCoverage(JSON.parse(payload) as Coverage, access))
  }

  query(access: LogAccess, filter: LogFilter = {}): LoggingPage {
    const levels = filter.severities ?? [...SEVERITIES]
    if (!Array.isArray(levels) || !levels.every((level) => SEVERITIES.includes(level))) throw new Error('Select only Critical, Error and Warning')
    const limit = filter.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Logging page size must be between 1 and 100')
    if (filter.workspace && !access.operator && filter.workspace !== access.workspace) throw new Error('Logging workspace scope is forbidden')
    const clauses = ['ingested_at >= ?', levels.length ? `severity IN (${levels.map(() => '?').join(',')})` : '0']
    const values: Array<string | number | null> = [new Date(this.now() - this.policy.retentionMs).toISOString(), ...levels]
    clauses.push(access.operator ? "(visibility IN ('operator','infrastructure') OR (workspace=? AND visibility='workspace'))"
      : "workspace=? AND visibility IN ('workspace','infrastructure')")
    values.push(access.workspace)
    const columns = { source: 'source', component: 'component', workspace: 'workspace', account: 'account', repository: 'repository',
      callId: 'call_id', correlationId: 'correlation_id', incidentId: 'incident_id' }
    for (const [key, column] of Object.entries(columns)) {
      const value = filter[key as keyof typeof columns]
      if (value !== undefined) {
        if (typeof value !== 'string' || value.length > 512) throw new Error(`Invalid Logging ${key}`)
        clauses.push(`${column}=?`); values.push(value)
      }
    }
    for (const [key, sign] of [['from', '>='], ['to', '<']] as const) {
      if (filter[key] !== undefined) {
        const at = Date.parse(filter[key])
        if (!Number.isFinite(at)) throw new Error(`Invalid Logging ${key} time`)
        clauses.push(`sort_time ${sign} ?`); values.push(new Date(at).toISOString())
      }
    }
    if (filter.search) {
      if (filter.search.length > 256) throw new Error('Logging search exceeds 256 characters')
      clauses.push("search LIKE ? ESCAPE '\\'"); values.push('%' + filter.search.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%')
    }
    const filterHash = createHash('sha256').update(JSON.stringify([access, clauses, values.slice(1)])).digest('hex')
    const after = filter.after ? this.openToken(filter.after, 'watermark', filterHash) : null
    if (after) { clauses.push('seq>?'); values.push(after.high) }
    const fingerprint = createHash('sha256').update(JSON.stringify([filterHash, after?.high ?? null])).digest('hex')
    const cursor = filter.cursor ? this.openToken(filter.cursor, 'page', fingerprint) : null
    const high = cursor?.high ?? (this.db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='log_events'),0) AS high").get() as { high: number }).high
    clauses.push('seq<=?'); values.push(high)
    const where = clauses.join(' AND ')
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM log_events WHERE ${where}`).get(...values) as { count: number }).count
    const pageWhere = cursor ? where + ' AND (sort_time < ? OR (sort_time = ? AND id < ?))' : where
    const pageValues = cursor ? [...values, cursor.time, cursor.time, cursor.id, limit + 1] : [...values, limit + 1]
    const rows = this.db.prepare(`SELECT id,sort_time,payload FROM log_events WHERE ${pageWhere} ORDER BY sort_time DESC,id DESC LIMIT ?`).all(...pageValues) as EventRow[]
    const page = rows.slice(0, limit)
    const occurrenceCounts = new Map<string, number>()
    const countIncident = this.db.prepare('SELECT COUNT(*) AS count FROM log_events WHERE incident_id=? AND ingested_at>=?')
    const retentionAfter = new Date(this.now() - this.policy.retentionMs).toISOString()
    const events = page.map((row) => {
      const event = JSON.parse(row.payload) as LogEvent
      let occurrences = occurrenceCounts.get(event.incidentId)
      if (occurrences === undefined) {
        occurrences = (countIncident.get(event.incidentId, retentionAfter) as { count: number }).count
        occurrenceCounts.set(event.incidentId, occurrences)
      }
      return { ...event, occurrences }
    })
    const last = page.at(-1)
    return { version: 1, events, total, countKind: 'events', nextCursor: rows.length > limit && last
      ? this.sealToken({ kind: 'page', high, time: last.sort_time, id: last.id, filter: fingerprint }) : null,
    watermark: this.sealToken({ kind: 'watermark', high, filter: filterHash }),
    coverage: this.readCoverage(access), bounds: this.bounds(access), policy: this.policy }
  }

  delivery(access: LogAccess, cursor: string | null = null, limit = 3) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('Diagnostic delivery limit is 1..3')
    const filter = createHash('sha256').update(JSON.stringify(access)).digest('hex')
    const after = cursor ? this.openToken(cursor, 'delivery', filter).high : 0
    const predicate = access.operator ? "(visibility IN ('operator','infrastructure') OR (workspace=? AND visibility='workspace'))"
      : "workspace=? AND visibility IN ('workspace','infrastructure')"
    const rows = this.db.prepare(`SELECT seq,payload FROM log_events WHERE ${predicate} AND seq>? AND ingested_at>=? ORDER BY seq LIMIT ?`)
      .all(access.workspace, after, new Date(this.now() - this.policy.retentionMs).toISOString(), limit + 1) as Array<{ seq: number; payload: string }>
    const page = rows.slice(0, limit)
    return { version: 1, events: page.map((row) => JSON.parse(row.payload) as LogEvent),
      cursor: this.sealToken({ kind: 'delivery', high: page.at(-1)?.seq ?? after, filter }), hasMore: rows.length > limit }
  }

  checkpoint(key: string): string | null {
    if (!/^[a-zA-Z0-9:._-]{1,256}$/.test(key)) throw new Error('Invalid diagnostic checkpoint key')
    return (this.db.prepare('SELECT value FROM log_meta WHERE key=?').get('checkpoint:' + key) as { value: string } | undefined)?.value ?? null
  }

  /** Discovery includes stopped containers; removed IDs can never resume a log stream. */
  reconcileDockerCheckpoints(containerIds: readonly string[]): void {
    if (containerIds.length > 128 || containerIds.some((id) => !/^[a-zA-Z0-9._-]{1,240}$/.test(id))) throw new Error('Invalid Docker checkpoint inventory')
    const keys = containerIds.map((id) => 'checkpoint:docker-log:' + id)
    this.db.prepare(`DELETE FROM log_meta WHERE key GLOB 'checkpoint:docker-log:*'${keys.length ? ` AND key NOT IN (${keys.map(() => '?').join(',')})` : ''}`).run(...keys)
  }

  resetCheckpoint(key: string): void {
    this.checkpoint(key)
    this.db.prepare('DELETE FROM log_meta WHERE key=?').run('checkpoint:' + key)
  }

  commitDelivery(events: readonly LogEvent[], key: string, cursor: string): number {
    this.checkpoint(key)
    if (cursor.length > 1024) throw new Error('Diagnostic checkpoint exceeds its bound')
    return this.db.transaction(() => {
      let inserted = 0
      for (let i = 0; i < events.length; i += 100) inserted += this.append(events.slice(i, i + 100))
      this.db.prepare('INSERT INTO log_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('checkpoint:' + key, cursor)
      return inserted
    })()
  }

  private key(): Buffer {
    const row = this.db.prepare("SELECT value FROM log_meta WHERE key='cursor_key'").get() as { value: string } | undefined
    if (!row || !/^[a-f0-9]{64}$/.test(row.value)) throw new Error('Logging cursor key is unavailable')
    return Buffer.from(row.value, 'hex')
  }

  private sealToken(value: Cursor): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
  }

  private openToken(value: string, kind: Cursor['kind'], filter: string): Cursor {
    try {
      if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding')
      const bytes = Buffer.from(value, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.key(), bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      const token = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as Cursor
      if (token.kind !== kind || token.filter !== filter || !Number.isSafeInteger(token.high) || token.high < 0
        || (kind === 'page' && (typeof token.time !== 'string' || !Number.isFinite(Date.parse(token.time))
          || typeof token.id !== 'string' || !/^evt_[a-f0-9]{16}_[a-f0-9]{64}$/.test(token.id)))) throw new Error('Invalid token')
      return token
    } catch { throw new DiagnosticCursorError('Logging cursor does not match these filters or authorization') }
  }

  bounds(access: LogAccess) {
    const predicate = access.operator ? "WHERE (visibility IN ('operator','infrastructure') OR (workspace=? AND visibility='workspace')) AND ingested_at>=?"
      : "WHERE workspace=? AND visibility IN ('workspace','infrastructure') AND ingested_at>=?"
    const parameters = [access.workspace, new Date(this.now() - this.policy.retentionMs).toISOString()]
    const row = this.db.prepare(`SELECT MIN(sort_time) AS from_time,MAX(sort_time) AS to_time FROM log_events ${predicate}`).get(...parameters) as { from_time: string | null; to_time: string | null }
    return { from: row.from_time, to: row.to_time, retentionAfter: new Date(this.now() - this.policy.retentionMs).toISOString() }
  }

  lookup(access: LogAccess, id: string): { status: 'found'; event: LogEvent } | { status: 'expired' | 'unavailable' } {
    if (!/^evt_[a-f0-9]{16}_[a-f0-9]{64}$/.test(id)) throw new Error('Invalid Logging event identifier')
    const row = (access.operator ? this.db.prepare("SELECT payload FROM log_events WHERE id=? AND (visibility IN ('operator','infrastructure') OR (workspace=? AND visibility='workspace'))").get(id, access.workspace)
      : this.db.prepare("SELECT payload FROM log_events WHERE id=? AND workspace=? AND visibility IN ('workspace','infrastructure')").get(id, access.workspace)) as { payload: string } | undefined
    if (row) {
      const event = JSON.parse(row.payload) as LogEvent
      const age = this.now() - Date.parse(event.ingestedAt)
      return age <= this.policy.retentionMs ? { status: 'found', event } : { status: age <= this.policy.retentionMs * 2 ? 'expired' : 'unavailable' }
    }
    const cutoff = new Date(this.now() - this.policy.retentionMs).toISOString()
    const expired = (access.operator
      ? this.db.prepare("SELECT 1 FROM log_expired WHERE id=? AND (visibility IN ('operator','infrastructure') OR (workspace=? AND visibility='workspace')) AND expired_at>=?").get(id, access.workspace, cutoff)
      : this.db.prepare("SELECT 1 FROM log_expired WHERE id=? AND workspace=? AND visibility IN ('workspace','infrastructure') AND expired_at>=?").get(id, access.workspace, cutoff))
    return { status: expired ? 'expired' : 'unavailable' }
  }

  close(): void { this.db.close() }
}
