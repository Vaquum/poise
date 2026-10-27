import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { BEHAVIOR_KEYS } from '../src/behavior-types'
import {
  DEFAULT_LEDGER_POLICY, LEDGER_STALE_MS, LEDGER_STATES, LedgerError,
  type LedgerActivity, type LedgerAdmission, type LedgerCaller, type LedgerChange, type LedgerGap,
  type LedgerHealth, type LedgerObservation, type LedgerPending, type LedgerPolicy, type LedgerRead,
  type LedgerRecord, type LedgerReference, type LedgerReply, type LedgerResult, type LedgerSlot, type LedgerState,
} from './behavior-ledger-contract'

interface Row { creation_seq: number; id: string; parent_id: string | null; native_id: string | null; payload: string; source_at: string | null; native_override: number; bytes: number }
interface Cursor { version: 1; generation: string; kind: 'list' | 'changes'; position: number; boundary: number; watermark: number; parent: string | null; repository?: string | null; number?: number | null }
interface Journal { version: 1; epoch: string; closed: boolean; health: LedgerHealth }
const ID = /^[a-f0-9]{64}$/
const CALL = /^[a-f0-9]{32}$/
const NATIVE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/
const SHA = /^[a-f0-9]{40}$/
const SLOTS: readonly LedgerSlot[] = ['primary', 'secondary', 'tertiary']
const PRECEDENCE: readonly LedgerState[] = ['running', 'held', 'unknown', 'pending', 'failed', 'superseded', 'completed']
const OUTCOMES = new Set(['clean', 'changes_requested', 'approved', 'commented', 'preflight_failed', 'resolved', 'waiting', 'no_op', 'merged', 'already_merged', 'updated', 'not_ready', 'superseded', 'rerun_requested', 'read_failed', 'spawn_failed', 'adopted', 'enqueued', 'review_target_closed'])
const TERMINAL = new Set<LedgerState>(['completed', 'failed', 'superseded'])
const DIRECT = new Set(['resolve-unblocking', 'merge-prs', 'rerun-grey-ci'])
const cliBehavior = { 'review-new-prs': 'pr_review', 'approve-prs': 'pr_approve', 'review-new-issues': 'issue_review' } as const
const hash = () => createHash('sha256').update(randomUUID()).digest('hex')
const iso = (value: string | null | undefined): boolean => value == null || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)))
const safeId = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const recordOf = (row: Row): LedgerRecord => JSON.parse(row.payload) as LedgerRecord
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const emptyHealth = (): LedgerHealth => ({ status: 'unavailable', unavailableReason: null, coverageStart: null, observedAt: null, callerObservedAt: null,
  pending: 0, dropped: 0, gaps: [], generation: null, retainedFrom: null, changeLowerBound: null, lastSequence: null, instances: null, changes: null })

/** Synchronous I/O belongs exclusively to the observer worker. */
export class BehaviorLedgerStore {
  private db: Database.Database | null = null
  private readonly policy: LedgerPolicy
  private readonly epoch = randomUUID()
  private readonly journalPath: string | null
  private closed = false
  private journalAvailable = true
  private data = emptyHealth()
  private cursorKey = ''
  private initialized = false
  private budgetScanTime = 0
  private instanceCount = 0
  private instanceBytes = 0
  private changeBytes = 0
  private pendingRows = new Map<string, LedgerPending>()

  get budgetScanMs(): number { return this.budgetScanTime }

  constructor(readonly path: string, policy: Partial<LedgerPolicy> = {}, private readonly now: () => number = Date.now) {
    this.policy = { ...DEFAULT_LEDGER_POLICY, ...policy }
    this.journalPath = path === ':memory:' ? null : path + '.coverage.json'
    this.loadJournal()
    this.data.coverageStart ??= this.time()
    this.openDatabase()
    this.persistJournal(this.currentHealth())
  }

  private lastOpenAttempt = 0

  private ensureOpen(): void {
    // A failed open retries on later operations so the ledger recovers by
    // itself once storage is back; attempts stay at most one per second.
    if (this.db || this.closed) return
    const now = this.now()
    if (now - this.lastOpenAttempt < 1000) return
    this.lastOpenAttempt = now
    this.openDatabase()
  }

  private openDatabase(): void {
    try {
      if (!Object.values(this.policy).every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid ledger policy')
      if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      this.db = new Database(this.path, { timeout: 0 })
      this.db.pragma('busy_timeout = 0')
      const existingMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_meta'").get()
      if (existingMeta) {
        const existingVersion = this.db.prepare("SELECT value FROM ledger_meta WHERE key='version'").get() as { value: string } | undefined
        if (existingVersion?.value !== '1') throw new Error('Unsupported ledger schema')
      } else if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        throw new Error('Unrecognized ledger schema')
      }
      this.db.pragma('journal_mode = DELETE')
      this.db.pragma('temp_store = MEMORY')
      this.db.pragma('cache_size = -2048')
      const page = this.db.pragma('page_size', { simple: true }) as number
      this.db.pragma(`max_page_count = ${Math.floor(this.policy.maxPagesBytes / page)}`)
      if (this.path !== ':memory:') chmodSync(this.path, 0o600)
      this.db.exec(`CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ledger_instances (
          creation_seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,parent_id TEXT,
          admission_key TEXT UNIQUE,native_id TEXT UNIQUE,payload TEXT NOT NULL,updated_at TEXT NOT NULL,
          source_at TEXT,native_override INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL,
          terminal INTEGER NOT NULL DEFAULT 0,no_write INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS ledger_parent ON ledger_instances(parent_id,creation_seq);
        CREATE INDEX IF NOT EXISTS ledger_updated ON ledger_instances(updated_at);
        CREATE INDEX IF NOT EXISTS ledger_retention ON ledger_instances(parent_id,updated_at);
        CREATE INDEX IF NOT EXISTS ledger_sourced ON ledger_instances(source_at);
        CREATE INDEX IF NOT EXISTS ledger_pressure ON ledger_instances(no_write DESC,terminal DESC,creation_seq ASC) WHERE parent_id IS NULL;
        CREATE TABLE IF NOT EXISTS ledger_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,op TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,bytes INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS ledger_change_created ON ledger_changes(created_at);
        CREATE INDEX IF NOT EXISTS ledger_change_id ON ledger_changes(id);
        INSERT OR IGNORE INTO ledger_meta VALUES('version','1');`)
      const version = this.db.prepare("SELECT value FROM ledger_meta WHERE key='version'").get() as { value: string }
      if (version.value !== '1') throw new Error('Unsupported ledger schema')
      this.db.prepare("INSERT OR IGNORE INTO ledger_meta VALUES('generation',?)").run(randomBytes(16).toString('hex'))
      this.db.prepare("INSERT OR IGNORE INTO ledger_meta VALUES('cursor_key',?)").run(randomBytes(32).toString('hex'))
      this.db.prepare("INSERT OR IGNORE INTO ledger_meta VALUES('change_floor','0')").run()
      const priorGeneration = this.data.generation
      this.data.generation = this.meta('generation')
      if (priorGeneration !== null && priorGeneration !== this.data.generation) {
        this.data.coverageStart = this.time()
        this.gap('unavailable')
      }
      this.cursorKey = this.meta('cursor_key')
      this.initialized = true
      this.refreshUsage()
      this.db.transaction(() => {
        // A detached direct command has no passive Caller row after its observer dies.
        this.pendingRows.clear()
        for (const row of this.rows('SELECT * FROM ledger_instances WHERE native_id IS NOT NULL')) {
          const record = recordOf(row)
          if (DIRECT.has(record.behavior) && !TERMINAL.has(record.state)) {
            this.put({ ...record, state: 'unknown', activity: 'unknown' }, row, true)
            if (record.parentId) this.aggregate(record.parentId)
          } else this.trackPending(row.native_id, record)
        }
        this.prune()
      })()
      this.data.observedAt = this.time()
    } catch {
      // No gap: a failed open holds captures for retry instead of losing
      // them, and health names the cause until the store reopens.
      this.db?.close(); this.db = null
    }
  }

  private time(): string { return new Date(this.now()).toISOString() }
  private meta(key: string): string {
    return (this.connection().prepare('SELECT value FROM ledger_meta WHERE key=?').get(key) as { value: string }).value
  }
  private connection(): Database.Database {
    if (!this.db || this.closed) throw new LedgerError(503, 'ledger_unavailable')
    return this.db
  }
  private rows(sql: string, ...args: (string | number | null)[]): Row[] { return this.connection().prepare(sql).all(...args) as Row[] }
  private row(nativeId: string): Row | undefined { return this.connection().prepare('SELECT * FROM ledger_instances WHERE native_id=?').get(nativeId) as Row | undefined }
  private byId(id: string): Row | undefined { return this.connection().prepare('SELECT * FROM ledger_instances WHERE id=?').get(id) as Row | undefined }
  private gap(reason: LedgerGap['reason'], count = 0): void {
    this.data.dropped += count
    const last = this.data.gaps.at(-1)
    if (!last || last.reason !== reason) this.data.gaps.push({ since: this.time(), until: this.time(), reason })
    else last.until = this.time()
    this.data.gaps = this.data.gaps.slice(-16)
  }
  private loadJournal(): void {
    if (!this.journalPath || !existsSync(this.journalPath)) return
    try {
      if (statSync(this.journalPath).size > 8192) throw new Error('Oversized ledger coverage')
      const prior = JSON.parse(readFileSync(this.journalPath, 'utf8')) as Journal
      if (prior.version !== 1 || !prior.health || !Array.isArray(prior.health.gaps) || prior.health.gaps.length > 16
        || !Number.isSafeInteger(prior.health.dropped) || prior.health.dropped < 0) throw new Error('Invalid ledger coverage')
      this.data = { ...emptyHealth(), ...prior.health, pending: 0 }
      if (!prior.closed) this.gap('unclean_restart')
    } catch { this.gap('unavailable'); this.journalAvailable = false }
  }
  private persistJournal(health: LedgerHealth): void {
    if (!this.journalPath) return
    const temporary = this.journalPath + '.' + this.epoch + '.tmp'
    try {
      const journal: Journal = { version: 1, epoch: this.epoch, closed: this.closed, health }
      const payload = JSON.stringify(journal)
      if (Buffer.byteLength(payload) > 8192) throw new Error('Ledger coverage limit')
      writeFileSync(temporary, payload, { mode: 0o600 })
      renameSync(temporary, this.journalPath)
      this.journalAvailable = true
    } catch { this.journalAvailable = false }
  }
  loss(count = 1): void { this.gap('capture_loss', count); this.persistJournal(this.currentHealth()) }

  capture(observation: LedgerObservation): void {
    // A failed capture stays unaccounted here: storage failures are held for
    // retry by the observer, and poison is shed with loss accounting there.
    this.ensureOpen()
    try {
      if (observation.type === 'loss') {
        if (!Number.isSafeInteger(observation.count) || observation.count < 1) throw new LedgerError(400, 'invalid_observation')
        this.loss(observation.count); return
      }
      const usage = { instances: this.instanceCount, instanceBytes: this.instanceBytes, changeBytes: this.changeBytes }
      try {
        this.connection().transaction(() => {
          if (observation.type === 'admit') this.admit(observation)
          else if (observation.type === 'result') this.result(observation)
          else if (observation.type === 'caller') this.caller(observation)
          else if (observation.type === 'heartbeat') this.staleActivities()
          this.prune()
        })()
      } catch (error) {
        // The transaction rolled back; restore the incremental counters so
        // a failed capture leaves usage and pending exactly as they were.
        this.instanceCount = usage.instances
        this.instanceBytes = usage.instanceBytes
        this.changeBytes = usage.changeBytes
        this.rebuildPending()
        throw error
      }
      this.data.observedAt = this.time()
    } finally { this.persistJournal(this.currentHealth()) }
  }

  private validateAdmission(input: LedgerAdmission): void {
    const account = (value: string | null) => value === null || ACCOUNT.test(value)
    if (!BEHAVIOR_KEYS.includes(input.behavior) || !NATIVE.test(input.nativeId)
      || typeof input.admissionKey !== 'string' || !input.admissionKey || Buffer.byteLength(input.admissionKey) > 1024
      || !account(input.owner) || !account(input.actor) || !REPO.test(input.repository) || input.repository.length > 140
      || !safeId(input.number) || !(input.head === null || SHA.test(input.head)) || !iso(input.startedAt)
      || ![ `poise:${input.behavior}`, 'poise:manual-review', 'poise:replay' ].includes(input.source)
      || (input.source === 'poise:manual-review' && input.behavior !== 'review-new-prs')
      || (input.source === 'poise:replay' && DIRECT.has(input.behavior))
      || (input.slot !== undefined && !SLOTS.includes(input.slot))) throw new LedgerError(400, 'invalid_observation')
    if (input.plannedSlots && (input.plannedSlots.length > 3 || new Set(input.plannedSlots).size !== input.plannedSlots.length
      || input.plannedSlots.some((slot) => !SLOTS.includes(slot)))) throw new LedgerError(400, 'invalid_observation')
    if (input.workflow && (!safeId(input.workflow.id) || !safeId(input.workflow.runId) || !safeId(input.workflow.attempt)
      || !/^[a-z_]{1,64}$/.test(input.workflow.event))) throw new LedgerError(400, 'invalid_observation')
  }
  private admit(input: LedgerAdmission): void {
    this.validateAdmission(input)
    const existing = this.row(input.nativeId)
    if (existing) {
      const record = recordOf(existing)
      if (record.behavior !== input.behavior || record.target.repository !== input.repository || record.target.number !== input.number
        || record.source !== input.source || record.actor !== input.actor || record.head !== input.head) throw new LedgerError(400, 'invalid_observation')
      return
    }
    let root = this.connection().prepare('SELECT * FROM ledger_instances WHERE admission_key=?').get(input.admissionKey) as Row | undefined
    const now = this.time()
    if (!root) {
      const id = hash()
      const plannedSlots = input.plannedSlots ?? (DIRECT.has(input.behavior) ? [] : [input.slot ?? 'primary'])
      const record: LedgerRecord = { id, kind: 'firing', parentId: null, behavior: input.behavior, source: input.source,
        owner: input.owner, actor: input.actor, target: { repository: input.repository, number: input.number,
          ...(input.workflow ? { workflow: { ...input.workflow } } : {}) }, head: plannedSlots.length > 1 ? null : input.head,
        slot: null, plannedSlots: [...plannedSlots], state: 'pending', stateSource: 'native', activity: 'unknown', outcome: null,
        createdAt: now, startedAt: input.startedAt ?? null, completedAt: null, observedAt: now, revision: 0,
        refs: [], replayOf: null, omittedAttempts: 0 }
      this.insert(record, input.admissionKey, null)
      root = this.byId(id)!
    }
    const parent = recordOf(root)
    if (parent.behavior !== input.behavior || parent.source !== input.source || parent.target.repository !== input.repository
      || parent.target.number !== input.number || parent.owner !== input.owner) throw new LedgerError(400, 'invalid_observation')
    const direct = DIRECT.has(input.behavior)
    const record: LedgerRecord = { ...parent, id: hash(), kind: 'attempt', parentId: parent.id, head: input.head,
      slot: direct ? null : input.slot ?? 'primary', actor: input.actor, plannedSlots: [], state: direct ? 'running' : 'pending', stateSource: 'native', activity: direct ? 'running' : 'unknown', outcome: null,
      createdAt: now, startedAt: input.startedAt ?? null, completedAt: null, observedAt: now, revision: 0, omittedAttempts: 0,
      refs: [{ kind: 'correlation', identity: input.nativeId, availability: 'available' }] }
    this.insert(record, null, input.nativeId)
    this.capAttempts(parent.id)
    this.aggregate(parent.id)
  }
  private refreshUsage(): void {
    // The only full-table scan: runs once per open, then every mutation
    // maintains the counters incrementally so reads and captures stay flat.
    const instances = this.connection().prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM ledger_instances').get() as { count: number; bytes: number }
    const changes = this.connection().prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM ledger_changes').get() as { bytes: number }
    this.instanceCount = instances.count
    this.instanceBytes = instances.bytes
    this.changeBytes = changes.bytes
  }
  private trackPending(nativeId: string | null, record: LedgerRecord, into: Map<string, LedgerPending> = this.pendingRows): void {
    if (nativeId === null) return
    if (!DIRECT.has(record.behavior) && (record.activity !== 'settled' || !TERMINAL.has(record.state))) {
      into.set(nativeId, { nativeId, callId: record.refs.find((ref) => ref.kind === 'caller')?.identity ?? null })
    } else into.delete(nativeId)
  }
  private rebuildPending(): void {
    // Rebuild into a fresh map so a failed scan keeps the previous one.
    const rebuilt = new Map<string, LedgerPending>()
    for (const row of this.rows('SELECT * FROM ledger_instances WHERE native_id IS NOT NULL')) this.trackPending(row.native_id, recordOf(row), rebuilt)
    this.pendingRows = rebuilt
  }
  private insert(record: LedgerRecord, admissionKey: string | null, nativeId: string | null): void {
    this.checkRecord(record)
    const rowBytes = encodedBytes(record) + 512
    this.connection().prepare(`INSERT INTO ledger_instances(id,parent_id,admission_key,native_id,payload,updated_at,source_at,bytes)
      VALUES(?,?,?,?,?,?,?,?)`).run(record.id, record.parentId, admissionKey, nativeId, JSON.stringify(record), this.time(), this.time(), rowBytes)
    this.instanceCount++
    this.instanceBytes += rowBytes
    this.put(record, this.byId(record.id)!, true)
  }
  private checkRecord(record: LedgerRecord): void {
    if (encodedBytes(record.target) > 512 || encodedBytes(record) > 4096 || record.refs.length > 8
      || record.refs.some((ref) => encodedBytes(ref) > 256)) throw new LedgerError(400, 'invalid_observation')
  }
  private put(record: LedgerRecord, row: Row, force = false, nativeOverride = row.native_override, sourceAt = row.source_at): void {
    const before = recordOf(row)
    const semantic = (value: LedgerRecord) => ({ ...value, revision: 0, observedAt: '' })
    if (!force && JSON.stringify(semantic(before)) === JSON.stringify(semantic(record))) {
      this.connection().prepare('UPDATE ledger_instances SET source_at=? WHERE id=?').run(sourceAt, record.id)
      return
    }
    this.checkRecord(record)
    const change = this.connection().prepare("INSERT INTO ledger_changes(id,op,payload,created_at,bytes) VALUES(?,'upsert','',?,0)")
      .run(record.id, this.time())
    record.revision = Number(change.lastInsertRowid)
    this.checkRecord(record)
    const payload = JSON.stringify(record)
    const encoded = JSON.stringify({ sequence: record.revision, op: 'upsert', record })
    const changeRowBytes = Buffer.byteLength(encoded) + 256
    this.connection().prepare('UPDATE ledger_changes SET payload=?,bytes=? WHERE seq=?').run(encoded, changeRowBytes, record.revision)
    this.changeBytes += changeRowBytes
    const terminal = TERMINAL.has(record.state) ? 1 : 0
    const noWrite = directNoWrite(record) ? 1 : 0
    const rowBytes = Buffer.byteLength(payload) + 512
    this.connection().prepare('UPDATE ledger_instances SET payload=?,updated_at=?,source_at=?,native_override=?,bytes=?,terminal=?,no_write=? WHERE id=?')
      .run(payload, this.time(), sourceAt, nativeOverride, rowBytes, terminal, noWrite, record.id)
    this.instanceBytes += rowBytes - row.bytes
    this.trackPending(row.native_id, record)
  }

  private validateRefs(refs: LedgerReference[]): void {
    if (refs.length > 8 || refs.some((ref) => !['caller', 'correlation', 'review', 'comment', 'workflow', 'intent', 'logging', 'queue'].includes(ref.kind)
      || !['available', 'unavailable', 'unknown'].includes(ref.availability) || typeof ref.identity !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,159}$/.test(ref.identity) || encodedBytes(ref) > 256
      || (ref.kind === 'caller' && !CALL.test(ref.identity)))) throw new LedgerError(400, 'invalid_observation')
  }
  private result(input: LedgerResult): void {
    if (!NATIVE.test(input.nativeId) || !LEDGER_STATES.includes(input.state)
      || !['running', 'settled', 'unknown'].includes(input.activity)
      || (input.outcome != null && !OUTCOMES.has(input.outcome)) || (input.callId && !CALL.test(input.callId))
      || (input.head != null && !SHA.test(input.head)) || !iso(input.completedAt)) throw new LedgerError(400, 'invalid_observation')
    if (input.refs) this.validateRefs(input.refs)
    const row = this.row(input.nativeId)
    if (!row) return
    const record = recordOf(row)
    const refs = [...record.refs]
    for (const ref of [...(input.refs ?? []), ...(input.callId ? [{ kind: 'caller' as const, identity: input.callId, availability: 'available' as const }] : [])]) {
      const index = refs.findIndex((current) => current.kind === ref.kind && current.identity === ref.identity)
      if (index < 0) refs.push(ref); else refs[index] = ref
    }
    this.put({ ...record, state: input.state, stateSource: input.stateSource ?? 'native', activity: input.activity,
      outcome: input.outcome === undefined ? record.outcome : input.outcome, head: input.head === undefined ? record.head : input.head,
      completedAt: input.completedAt === undefined ? record.completedAt : input.completedAt, refs, observedAt: this.time() }, row, false,
    input.stateSource === 'caller_observed' ? row.native_override : 1, this.time())
    if (record.parentId) this.aggregate(record.parentId)
  }

  private caller(input: LedgerCaller): void {
    if (!NATIVE.test(input.nativeId) || (input.callId !== null && !CALL.test(input.callId))) throw new LedgerError(400, 'invalid_observation')
    const row = this.row(input.nativeId)
    if (!row) return
    const record = recordOf(row)
    if (DIRECT.has(record.behavior)) return
    if (row.native_override === 1 && TERMINAL.has(record.state) && record.activity === 'settled') return
    const knownCall = record.refs.find((ref) => ref.kind === 'caller')?.identity
    const exact = input.callId !== null && (!knownCall || knownCall === input.callId)
      && input.repository === record.target.repository && input.number === record.target.number && input.actor?.toLowerCase() === record.actor?.toLowerCase()
      && input.source === record.source && input.behavior === cliBehavior[record.behavior as keyof typeof cliBehavior]
      && (input.expectedHead ?? null) === record.head && iso(input.startedAt) && input.startedAt !== null
      && (record.startedAt === null || Date.parse(input.startedAt) >= Date.parse(record.startedAt)) && iso(input.completedAt)
    let state: LedgerState = 'unknown'
    let activity: LedgerActivity = 'unknown'
    let outcome: LedgerRecord['outcome'] = null
    if (exact && (input.status === 'running' || input.status === 'in_progress')) activity = 'running'
    if (exact && !input.uncertain && !input.interrupted) {
      if (input.status === 'pending' || input.status === 'queued') state = 'pending'
      else if (input.status === 'running' || input.status === 'in_progress') state = 'running'
      else if (input.status === 'superseded') { state = 'superseded'; activity = 'settled'; outcome = 'superseded' }
      else if (['failed', 'error', 'cancelled', 'canceled', 'timed_out', 'timeout'].includes(input.status ?? '')) { state = 'failed'; activity = 'settled' }
      else if (input.status === 'completed' && completedPair(record, input)) {
        state = 'completed'; activity = 'settled'; outcome = input.outcome as LedgerRecord['outcome']
      }
    }
    const refs = [...record.refs]
    if (exact && input.callId && !knownCall) refs.push({ kind: 'caller', identity: input.callId, availability: 'available' })
    const native = row.native_override === 1 && record.state !== 'unknown'
    this.put({ ...record, state: native ? record.state : state, stateSource: native ? 'native' : 'caller_observed',
      activity: activity === 'running' ? 'running' : input.uncertain || input.interrupted || native && record.activity === 'unknown' ? 'unknown' : native && TERMINAL.has(record.state) && record.activity === 'settled' ? 'settled' : activity,
      outcome: native ? record.outcome : outcome, refs, observedAt: this.time(), startedAt: exact ? input.startedAt : record.startedAt,
      completedAt: native ? record.completedAt : exact ? input.completedAt : null }, row, false, native ? 1 : 0, this.time())
    this.data.callerObservedAt = this.time()
    if (record.parentId) this.aggregate(record.parentId)
  }

  private aggregate(id: string): void {
    const row = this.byId(id)
    if (!row) return
    const root = recordOf(row)
    const children = this.rows('SELECT * FROM ledger_instances WHERE parent_id=? ORDER BY creation_seq DESC', id).map(recordOf)
    const selected = root.plannedSlots.length ? root.plannedSlots.map((slot) => children.find((child) => child.slot === slot)) : [children[0]]
    const latest = children[0]
    // Closure ends the target's panel, including slots never admitted. A
    // later admission or a delayed observation of an older closure cannot
    // supersede work started after the target reopened.
    const closed = children.find((child) => child.outcome === 'review_target_closed'
      && child.state === 'superseded' && child.completedAt !== null
      && (child === latest || (latest?.startedAt !== null && latest?.startedAt !== undefined
        && Date.parse(child.completedAt) > Date.parse(latest.startedAt))))
    const states = selected.map((child) => child?.state === 'superseded' && root.behavior === 'review-new-prs' && root.source === 'poise:review-new-prs' ? 'pending' : child?.state ?? 'pending')
    const state = closed ? 'superseded' : PRECEDENCE.find((candidate) => states.includes(candidate)) ?? 'pending'
    // Older uncertain attempts still count as caused work; a retry cannot prove they stopped.
    const activity: LedgerActivity = children.some((child) => child.activity === 'running') ? 'running'
      : (!closed && selected.some((child) => !child)) || children.some((child) => child.activity !== 'settled') ? 'unknown' : 'settled'
    const required = closed ? children : selected
    const completions = required.flatMap((child) => child?.completedAt ? [child.completedAt] : [])
    const completedAt = completions.length === required.length
      ? completions.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null : null
    this.put({ ...root, state, activity, stateSource: latest?.stateSource ?? root.stateSource,
      outcome: closed ? 'review_target_closed' : selected.length === 1 ? selected[0]?.outcome ?? null : null,
      completedAt: TERMINAL.has(state) && activity === 'settled' ? completedAt : null,
      observedAt: this.time(), head: root.plannedSlots.length > 1 ? null : latest?.head ?? root.head }, row)
  }
  private staleActivities(): void {
    const cutoff = new Date(this.now() - LEDGER_STALE_MS).toISOString()
    const roots = new Set<string>()
    for (const row of this.budgetScan(() => this.rows('SELECT * FROM ledger_instances WHERE native_id IS NOT NULL AND source_at < ?', cutoff))) {
      const record = recordOf(row)
      if (record.activity === 'unknown' || (TERMINAL.has(record.state) && record.activity === 'settled')) continue
      this.put({ ...record, activity: 'unknown' }, row)
      if (record.parentId) roots.add(record.parentId)
    }
    for (const id of roots) this.aggregate(id)
  }

  private remove(row: Row): void {
    const record = recordOf(row)
    if (!record.parentId) for (const child of this.rows('SELECT * FROM ledger_instances WHERE parent_id=?', row.id)) this.remove(child)
    if (!TERMINAL.has(record.state) || record.activity !== 'settled') this.gap('eviction')
    this.connection().prepare('DELETE FROM ledger_instances WHERE id=?').run(row.id)
    if (row.native_id !== null) this.pendingRows.delete(row.native_id)
    this.instanceCount--
    this.instanceBytes -= row.bytes
    const change = this.connection().prepare("INSERT INTO ledger_changes(id,op,payload,created_at,bytes) VALUES(?,'remove','',?,0)").run(row.id, this.time())
    const sequence = Number(change.lastInsertRowid)
    const payload = JSON.stringify({ sequence, op: 'remove', id: row.id, revision: sequence })
    const changeRowBytes = Buffer.byteLength(payload) + 256
    this.connection().prepare('UPDATE ledger_changes SET payload=?,bytes=? WHERE seq=?').run(payload, changeRowBytes, sequence)
    this.changeBytes += changeRowBytes
  }
  private capAttempts(id: string): void {
    const rows = this.rows('SELECT * FROM ledger_instances WHERE parent_id=? ORDER BY creation_seq DESC', id)
    if (rows.length <= this.policy.maxAttempts) return
    const latestSlots = new Set<string | null>()
    const victims: Row[] = []
    for (const row of rows) {
      const slot = recordOf(row).slot
      if (!latestSlots.has(slot)) { latestSlots.add(slot); continue }
      victims.push(row)
    }
    const count = rows.length - this.policy.maxAttempts
    for (const row of victims.slice(-count)) this.remove(row)
    const root = this.byId(id)!
    const record = recordOf(root)
    this.put({ ...record, omittedAttempts: record.omittedAttempts + Math.min(count, victims.length) }, root)
  }
  private usage(): { instances: number; changes: number; bytes: number } {
    // Change sequences stay contiguous: inserts append and retention only
    // drops a bottom prefix, so the count is last minus floor with no scan.
    return { instances: this.instanceCount, changes: this.lastSequence() - Number(this.meta('change_floor')),
      bytes: this.instanceBytes + this.changeBytes }
  }
  private budgetScan<T>(query: () => T): T {
    const startedAt = performance.now()
    try { return query() } finally { this.budgetScanTime += performance.now() - startedAt }
  }
  private trimChanges(): void {
    const cutoff = new Date(this.now() - this.policy.retentionMs).toISOString()
    const floor = Number(this.meta('change_floor'))
    const expired = this.budgetScan(() => this.connection().prepare('SELECT seq FROM ledger_changes INDEXED BY ledger_change_created WHERE created_at < ? ORDER BY seq DESC LIMIT 1')
      .get(cutoff)) as { seq: number } | undefined
    // The newest maxChanges sequences end at last, so anything at or below
    // last minus maxChanges is over the cap without counting rows.
    const target = Math.max(expired?.seq ?? floor, this.lastSequence() - this.policy.maxChanges, floor)
    if (target > floor) this.dropChangesThrough(target)
  }
  private dropChangesThrough(sequence: number): void {
    const floor = Number(this.meta('change_floor'))
    if (sequence > floor) {
      const removed = this.budgetScan(() => this.connection().prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM ledger_changes WHERE seq>? AND seq<=?')
        .get(floor, sequence)) as { bytes: number }
      this.changeBytes -= removed.bytes
    }
    this.connection().prepare('DELETE FROM ledger_changes WHERE seq<=?').run(sequence)
    this.connection().prepare("UPDATE ledger_meta SET value=? WHERE key='change_floor'").run(String(Math.max(floor, sequence)))
  }
  private prune(): void {
    const cutoff = new Date(this.now() - this.policy.retentionMs).toISOString()
    for (const row of this.budgetScan(() => this.rows('SELECT * FROM ledger_instances WHERE parent_id IS NULL AND updated_at < ?', cutoff))) this.remove(row)
    this.trimChanges()
    let usage = this.usage()
    while (usage.instances > this.policy.maxInstances || usage.bytes > this.policy.maxBytes) {
      // Preserve panel work ahead of repetitive terminal direct no-write firings.
      const victim = this.budgetScan(() => this.rows('SELECT * FROM ledger_instances INDEXED BY ledger_pressure WHERE parent_id IS NULL ORDER BY no_write DESC,terminal DESC,creation_seq ASC LIMIT 1'))[0]
      if (usage.instances > this.policy.maxInstances || !usage.changes || (victim && recordOf(victim).state === 'completed' && directNoWrite(recordOf(victim)))) {
        if (!victim) break
        this.remove(victim)
      } else {
        const first = this.connection().prepare('SELECT min(seq) AS seq FROM ledger_changes').get() as { seq: number }
        this.dropChangesThrough(first.seq)
      }
      this.trimChanges(); usage = this.usage()
    }
  }

  pending(): LedgerPending[] {
    if (!this.db || this.closed) return []
    return [...this.pendingRows.values()]
  }
  health(): LedgerHealth {
    this.ensureOpen()
    const health = this.currentHealth()
    // Reads alone must observe recovery: re-probe the journal while it is down.
    if (!this.journalAvailable) {
      this.persistJournal(health)
      if (this.journalAvailable) return this.currentHealth()
    }
    return health
  }

  private currentHealth(): LedgerHealth {
    if (this.db && !this.closed && this.initialized) {
      try {
        const usage = this.usage()
        this.data.instances = usage.instances; this.data.changes = usage.changes
        const first = this.connection().prepare('SELECT min(updated_at) AS first FROM ledger_instances').get() as { first: string | null }
        this.data.retainedFrom = first.first
        this.data.changeLowerBound = Number(this.meta('change_floor'))
        this.data.lastSequence = this.lastSequence()
      } catch { return { ...this.data, status: 'unavailable', unavailableReason: 'store_unavailable', gaps: [...this.data.gaps] } }
    }
    const stale = !this.data.observedAt || this.now() - Date.parse(this.data.observedAt) > LEDGER_STALE_MS
    const status: LedgerHealth['status'] = this.closed ? 'stopped' : !this.db || !this.journalAvailable ? 'unavailable'
      : stale ? 'stale' : this.data.dropped > 0 || this.data.gaps.length > 0 ? 'incomplete' : 'ok'
    const unavailableReason = this.closed || status !== 'unavailable' ? null
      : !this.db ? 'store_unavailable' : !this.journalAvailable ? 'journal_unavailable' : 'store_unavailable'
    return { ...this.data, status, unavailableReason, gaps: [...this.data.gaps] }
  }
  private lastSequence(): number {
    const row = this.connection().prepare("SELECT seq FROM sqlite_sequence WHERE name='ledger_changes'").get() as { seq: number } | undefined
    return row?.seq ?? 0
  }
  private cursor(input: Omit<Cursor, 'version' | 'generation'>): string {
    const payload = Buffer.from(JSON.stringify({ version: 1, generation: this.data.generation, ...input })).toString('base64url')
    return payload + '.' + createHmac('sha256', this.cursorKey).update(payload).digest('base64url')
  }
  private parseCursor(value: string, kind: Cursor['kind'], parent: string | null, repository: string | null = null, number: number | null = null): Cursor {
    try {
      if (value.length > 4096) throw new Error('Cursor bound')
      const [payload, signature, extra] = value.split('.')
      const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Cursor
      if (cursor.generation !== this.data.generation) throw new LedgerError(410, 'resync_required')
      const expected = createHmac('sha256', this.cursorKey).update(payload).digest()
      const actual = Buffer.from(signature ?? '', 'base64url')
      const cursorRepository = cursor.repository ?? null
      const cursorNumber = cursor.number ?? null
      if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)
        || cursor.version !== 1 || cursor.kind !== kind || cursor.parent !== parent
        || cursorRepository !== repository || cursorNumber !== number
        || ![cursor.position, cursor.boundary, cursor.watermark].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid cursor')
      if (cursor.watermark < Number(this.meta('change_floor')) || cursor.position > (kind === 'changes' ? this.lastSequence() : cursor.boundary)
        || cursor.watermark > this.lastSequence()) throw new LedgerError(410, 'resync_required')
      return { ...cursor, repository: cursorRepository, number: cursorNumber }
    } catch (error) {
      if (error instanceof LedgerError) throw error
      throw new LedgerError(400, 'invalid_cursor')
    }
  }
  read(request: LedgerRead): { status: number; body: LedgerReply } {
    this.ensureOpen()
    const envelope = (extra: Omit<LedgerReply, 'version' | 'health'> = {}): LedgerReply => ({ version: 1, health: this.health(), ...extra })
    if (request.operation === 'health') return { status: 200, body: envelope() }
    try {
      const body = this.connection().transaction(() => {
        const limit = request.operation === 'get' ? 1 : request.limit ?? 50
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new LedgerError(400, 'invalid_limit')
        if (request.operation === 'get') {
          if (!ID.test(request.id)) throw new LedgerError(400, 'invalid_id')
          const row = this.byId(request.id)
          if (row) return envelope({ record: recordOf(row) })
          const removed = this.connection().prepare("SELECT 1 FROM ledger_changes WHERE id=? AND op='remove' LIMIT 1").get(request.id)
          throw new LedgerError(removed ? 410 : 404, removed ? 'record_expired' : 'record_not_found')
        }
        if (request.operation === 'changes') {
          const cursor = this.parseCursor(request.cursor, 'changes', null)
          if (cursor.position < Number(this.meta('change_floor'))) throw new LedgerError(410, 'resync_required')
          const rows = this.connection().prepare('SELECT payload FROM ledger_changes WHERE seq>? ORDER BY seq ASC LIMIT ?').all(cursor.position, limit + 1) as { payload: string }[]
          const changes = rows.slice(0, limit).map((row) => JSON.parse(row.payload) as LedgerChange)
          const position = changes.at(-1)?.sequence ?? cursor.position
          return envelope({ changes, hasMore: rows.length > limit,
            nextCursor: this.cursor({ kind: 'changes', position, boundary: 0, watermark: position, parent: null }) })
        }
        const parent = request.parent ?? null
        if (parent !== null && !ID.test(parent)) throw new LedgerError(400, 'invalid_parent')
        const repository = request.repository ?? null
        const targetNumber = request.number ?? null
        if ((repository === null) !== (targetNumber === null)) throw new LedgerError(400, 'invalid_query')
        if (repository !== null && (!REPO.test(repository) || repository.length > 140)) throw new LedgerError(400, 'invalid_query')
        if (targetNumber !== null && !safeId(targetNumber)) throw new LedgerError(400, 'invalid_query')
        const maximum = this.connection().prepare("SELECT seq FROM sqlite_sequence WHERE name='ledger_instances'").get() as { seq: number } | undefined
        const cursor = request.cursor ? this.parseCursor(request.cursor, 'list', parent, repository, targetNumber)
          : { version: 1 as const, generation: this.data.generation!, kind: 'list' as const, position: 0, boundary: maximum?.seq ?? 0, watermark: this.lastSequence(), parent, repository, number: targetNumber }
        const conditions = ['creation_seq>?', 'creation_seq<=?']
        const args: (string | number)[] = [cursor.position, cursor.boundary]
        if (parent !== null) { conditions.push('parent_id=?'); args.push(parent) }
        if (repository !== null && targetNumber !== null) {
          conditions.push(`json_extract(payload,'$.target.repository')=? COLLATE NOCASE`, `json_extract(payload,'$.target.number')=?`)
          args.push(repository, targetNumber)
        }
        const rows = this.rows(`SELECT * FROM ledger_instances WHERE ${conditions.join(' AND ')} ORDER BY creation_seq ASC LIMIT ?`,
          ...[...args, limit + 1])
        const selected = rows.slice(0, limit)
        const nextCursor = rows.length > limit ? this.cursor({ ...cursor, position: selected.at(-1)!.creation_seq }) : null
        return envelope({ records: selected.map(recordOf), nextCursor,
          watermark: this.cursor({ kind: 'changes', position: cursor.watermark, boundary: 0, watermark: cursor.watermark, parent: null }) })
      })()
      return { status: 200, body }
    } catch (error) {
      const failure = error instanceof LedgerError ? error : new LedgerError(503, 'ledger_unavailable')
      return { status: failure.status, body: envelope({ error: failure.code }) }
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.persistJournal(this.currentHealth())
    this.db?.close()
    this.db = null
  }
}

function directNoWrite(record: LedgerRecord): boolean {
  return DIRECT.has(record.behavior) && record.state === 'completed'
    && ['waiting', 'no_op', 'not_ready', 'already_merged'].includes(record.outcome ?? '')
}
function completedPair(record: LedgerRecord, row: LedgerCaller): boolean {
  if (!row.completedAt || !iso(row.completedAt) || Date.parse(row.completedAt) < Date.parse(row.startedAt!)) return false
  if (record.behavior === 'review-new-issues') return row.action === 'commented' && row.outcome === 'commented' && row.head === null
  if (row.head !== record.head) return false
  return row.action === 'requested_changes' && row.outcome === 'changes_requested'
    || record.behavior === 'review-new-prs' && row.action === 'reviewed_clean' && row.outcome === 'clean'
    || record.behavior === 'approve-prs' && row.action === 'approved' && row.outcome === 'approved'
}
