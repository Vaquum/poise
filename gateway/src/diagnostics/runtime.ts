import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { environmentSecrets, normalize, redact, SOURCES, type DiagnosticInput, type LogEvent } from './contract.js'
import { DEFAULT_LOG_POLICY, DiagnosticConflictError, DiagnosticEventError, DiagnosticStore, MAX_COVERAGE_SOURCES, type Coverage, type LogPolicy } from './store.js'
import { currentCoverageStatus } from './query-contract.js'

// Covers 256 sources with 32 Unicode gap reasons and bounded source errors.
export const MAX_COVERAGE_JOURNAL_BYTES = 8 * 1024 * 1024

interface Journal {
  version: 1
  writtenAt: string
  stopped: boolean
  dropped: number
  droppedSince: string | null
  rejected?: number
  lossActive?: boolean
  sinkError: string | null
  coverageError?: string | null
  reportError?: string | null
  sinkSince: string | null
  sources: Coverage[]
}
export interface RuntimeOptions {
  path: string
  workspace?: string
  policy?: LogPolicy
  maxQueueBytes?: number
  maxQueueEvents?: number
  now?: () => number
  secrets?: readonly string[]
  report?: (line: string) => void
}

/** Failure domains stay separate: bad queries cannot manufacture sink outages. */
export class DiagnosticRuntime {
  private store: DiagnosticStore | null = null
  private queue: Array<{ event: LogEvent; bytes: number }> = []
  private queuedBytes = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private scheduled = false
  private retryAt = 0
  private sinkError: string | null = null
  private sinkSince: string | null = null
  private coverageError: string | null = null
  private journalError: string | null = null
  private reportError: string | null = null
  private rejected = 0
  private lossActive = false
  private lossSequence = 0
  private lastRejected: string | null = null
  private lastSuccess: string | null = null
  private journalAt = 0
  private dropped = 0
  private droppedSince: string | null = null
  private stopped = false
  private draining = false
  private readonly runId = randomUUID()
  private sourceSequence = 0
  private readonly sources = new Map<string, Coverage>()
  private readonly now: () => number
  private readonly secrets: readonly string[]
  private readonly report: (line: string) => void
  private readonly policy: LogPolicy

  constructor(private readonly options: RuntimeOptions) {
    this.now = options.now ?? Date.now
    this.secrets = options.secrets ?? environmentSecrets()
    this.policy = options.policy ?? DEFAULT_LOG_POLICY
    this.report = options.report ?? ((line) => process.stderr.write(line + '\n'))
    const path = this.journalPath()
    if (path && existsSync(path)) {
      try {
        if (statSync(path).size > MAX_COVERAGE_JOURNAL_BYTES) throw new Error('Coverage journal exceeds 8 MiB')
        const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal
        if (journal.version !== 1 || !Array.isArray(journal.sources) || journal.sources.length > MAX_COVERAGE_SOURCES
          || !Number.isFinite(Date.parse(journal.writtenAt)) || !Number.isSafeInteger(journal.dropped) || journal.dropped < 0) throw new Error('Invalid collection coverage journal')
        this.rejected = Number.isSafeInteger(journal.rejected) && journal.rejected! >= 0 ? journal.rejected! : 0
        this.lossActive = journal.lossActive === true
        this.dropped = journal.dropped
        this.droppedSince = journal.droppedSince ?? null
        this.reportError = journal.reportError ?? null
        this.coverageError = journal.coverageError ?? null
        this.sinkError = journal.sinkError ?? null
        this.sinkSince = journal.sinkSince ?? null
        for (const source of journal.sources) {
          if (!source.id || !source.source || !Array.isArray(source.gaps)) throw new Error('Invalid source in coverage journal')
          const gaps = source.gaps.slice(journal.stopped ? -32 : -31).map((gap) => ({ ...gap, reason: this.safe(gap.reason, 128) }))
          // An existing open outage already covers the unobserved restart interval.
          if (!journal.stopped && !gaps.some((gap) => gap.to === null)) gaps.push({ from: journal.writtenAt, to: this.iso(), reason: 'Collector observation unavailable during restart; completeness is unknown' })
          this.sources.set(source.id, { ...source, status: source.status === 'not-configured' ? 'not-configured' : source.error ? 'unavailable' : 'partial',
            currentStatus: source.status === 'not-configured' ? 'not-configured' : 'initializing', historyIncomplete: source.historyIncomplete || source.gaps.length >= 32, gaps })
        }
      } catch (error) { this.journalError = this.message(error); this.notify('logging.coverage.unavailable', this.journalError) }
    }
  }

  private iso(): string { return new Date(this.now()).toISOString() }
  private journalPath(): string | null { return this.options.path === ':memory:' ? null : this.options.path + '.coverage.json' }
  private safe(value: string, limit = 2048): string { return redact(value, this.secrets).slice(0, limit) }
  private coverageId(value: string): string {
    // Redaction can collapse distinct labels; retain an opaque, stable identity.
    return this.safe(value, 256) === value ? value : 'source_' + createHash('sha256').update(value).digest('hex')
  }
  private sourceName(value: string): string { return SOURCES.find((source) => source === value) ?? this.safe(value, 128) }
  private message(error: unknown): string { return this.safe(error instanceof Error ? error.message : String(error)) }

  private notify(event: string, message: string): void {
    try { this.report(JSON.stringify({ level: 'error', event, message })); this.reportError = null }
    catch (error) { this.reportError = this.message(error) }
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.flush(), 1000)
    this.timer.unref()
    this.schedule()
  }

  emit(input: DiagnosticInput): string | null {
    if (this.stopped || this.draining) return null
    try {
      const event = normalize({ ...input, time: input.time === undefined ? this.iso() : input.time }, this.now(), this.secrets)
      return event ? this.enqueue(event) : null
    } catch (error) { this.reject(error); return null }
  }

  /** Accept only an already normalized event from a trusted source adapter. */
  ingest(event: LogEvent): string | null {
    if (this.stopped || this.draining) return null
    return this.enqueue(event)
  }

  private enqueue(event: LogEvent): string | null {
    const existing = this.queue.find((entry) => entry.event.id === event.id)
    if (existing) {
      if (isDeepStrictEqual({ ...existing.event, ingestedAt: null }, { ...event, ingestedAt: null })) return event.id
      this.reject(new Error('Conflicting immutable Logging delivery: ' + event.id))
      this.warning('identity.conflict', event.id, event.workspace, 'Contradictory delivery rejected; the original occurrence is preserved')
      return null
    }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (this.queue.length >= (this.options.maxQueueEvents ?? 1000) || this.queuedBytes + bytes > (this.options.maxQueueBytes ?? 2 * 1024 * 1024)) {
      this.dropped++; this.droppedSince ??= this.iso(); this.recordLoss(); return null
    }
    this.queue.push({ event, bytes }); this.queuedBytes += bytes
    this.schedule()
    return event.id
  }

  private warning(operation: string, id: string, workspace: string | null, message: string): void {
    const event = normalize({ id: operation + ':' + id, time: null, source: 'collection', operation, level: 'warning', workspace, message,
      context: { rejectedEventId: id } }, this.now(), this.secrets)
    if (event && Buffer.byteLength(JSON.stringify(event)) * 2 + 1024 <= this.policy.maxBytes) this.enqueue(event)
  }

  private reject(error: unknown): void {
    this.rejected++; this.lastRejected = this.message(error)
    this.notify('logging.record.rejected', this.lastRejected)
    this.recordLoss()
  }

  private recordLoss(): void {
    this.lossSequence++
    const changed = !this.lossActive
    this.lossActive = true
    this.saveJournal(changed)
  }

  unconfigured(id: string, source: string, workspace: string | null, reason: string): void {
    id = this.coverageId(id)
    if (!this.sources.has(id) && this.sources.size >= MAX_COVERAGE_SOURCES) { this.reject(new Error('Collection source bound reached')); return }
    this.sources.set(id, { id, source: this.sourceName(source), workspace, status: 'not-configured', currentStatus: 'not-configured', optional: true, observedAt: null, ingestedAt: null,
      availableFrom: null, error: this.safe(reason), gaps: [] })
    this.saveJournal()
  }

  observe(id: string, source: string, workspace: string | null, error: string | null = null): void {
    id = this.coverageId(id)
    if (!this.sources.has(id) && this.sources.size >= MAX_COVERAGE_SOURCES) { this.reject(new Error('Collection source limit of 256 reached')); return }
    const previous = this.sources.get(id)
    const at = this.iso()
    const reason = error === null ? null : this.safe(error)
    let gaps = [...(previous?.gaps ?? [])]
    if (reason && !gaps.some((gap) => gap.to === null)) gaps.push({ from: at, to: null, reason: this.safe(reason, 128) })
    if (!reason) gaps = gaps.map((gap) => gap.to === null ? { ...gap, to: at } : gap)
    this.sources.set(id, { ...previous, id, source: this.sourceName(source), workspace, optional: false, status: reason ? 'unavailable' : gaps.length || previous?.historyIncomplete ? 'partial' : 'connected',
      currentStatus: reason ? 'unavailable' : 'connected',
      observedAt: reason ? previous?.observedAt ?? null : at, ingestedAt: previous?.ingestedAt ?? null,
      availableFrom: previous?.availableFrom ?? (reason ? null : at), error: reason, gaps: gaps.slice(-32), historyIncomplete: previous?.historyIncomplete || gaps.length > 32 })
    if (reason && previous?.error !== reason) this.emit({ source: 'collection', component: source, level: 'warning', operation: 'source.unavailable',
      id: `coverage:${this.runId}:${++this.sourceSequence}`, workspace, message: reason, context: { source, coverageId: id } })
    this.saveJournal()
  }

  partial(id: string, source: string, workspace: string | null, reason: string, currentStatus: 'partial' | 'initializing' = 'partial'): void {
    this.observe(id, source, workspace)
    const value = this.sources.get(this.coverageId(id))
    if (value) { value.status = 'partial'; value.currentStatus = currentStatus; value.error = this.safe(reason) }
    this.saveJournal()
  }

  mergeHistory(id: string, history: { incomplete: boolean; gaps: Coverage['gaps']; dropped: number; rejected: number; lossActive?: boolean; availableFrom: string | null }): void {
    const source = this.sources.get(this.coverageId(id))
    if (!source) return // Admission failure is already reported by observe/deliver.
    const liveLossChanged = source.lossActive !== history.lossActive
    const gaps = new Map(source.gaps.map((gap) => [gap.from + ':' + gap.reason, gap]))
    for (const gap of history.gaps) {
      const safe = { ...gap, reason: this.safe(gap.reason, 128) }
      gaps.set(safe.from + ':' + safe.reason, safe)
    }
    const ordered = [...gaps.values()].sort((a, b) => a.from.localeCompare(b.from))
    source.historyIncomplete = source.historyIncomplete || history.incomplete || ordered.length > 32
    source.gaps = ordered.slice(-32)
    source.dropped = Math.max(source.dropped ?? 0, history.dropped)
    source.rejected = Math.max(source.rejected ?? 0, history.rejected)
    source.lossActive = history.lossActive
    if (history.availableFrom && (!source.availableFrom || history.availableFrom < source.availableFrom)) source.availableFrom = history.availableFrom
    if (source.currentStatus === 'connected' && (source.historyIncomplete || source.gaps.length)) source.status = 'partial'
    this.saveJournal(liveLossChanged)
  }

  health() {
    const required = [...this.sources.values()].filter((source) => !source.optional)
    const partial = this.dropped > 0 || this.rejected > 0 || this.journalError || this.coverageError || this.reportError
      || required.some((source) => source.status !== 'connected')
    const observations = required.map(currentCoverageStatus)
    const currentStatus = this.sinkError ? 'unavailable' : this.lossActive || required.some((source) => source.lossActive === true) || this.journalError || this.coverageError || this.reportError
      || observations.some((status) => status !== 'connected' && status !== 'initializing') ? 'partial'
      : this.lastSuccess === null || observations.includes('initializing') ? 'initializing' : 'connected'
    return { status: this.sinkError ? 'unavailable' : partial ? 'partial' : this.lastSuccess === null ? 'initializing' : 'connected', currentStatus,
      error: this.sinkError, unavailableSince: this.sinkSince, coverageError: this.coverageError, journalError: this.journalError,
      reportError: this.reportError, rejected: this.rejected, lossActive: this.lossActive || required.some((source) => source.lossActive === true)
        ? true : required.some((source) => source.lossActive === undefined && ((source.dropped ?? 0) > 0 || (source.rejected ?? 0) > 0)) ? undefined : false,
      lastRejected: this.lastRejected, checkedAt: this.iso(), lastSuccessfulWriteAt: this.lastSuccess,
      queued: this.queue.length, queuedBytes: this.queuedBytes, dropped: this.dropped, droppedSince: this.droppedSince,
      sources: [...this.sources.values()], policy: this.policy }
  }

  private connection(): DiagnosticStore {
    if (this.store) return this.store
    try { this.store = new DiagnosticStore(this.options.path, this.policy, this.now); return this.store }
    catch (error) { this.sinkFailure(error); throw error }
  }

  query<T>(read: (store: DiagnosticStore) => T): T {
    const store = this.connection()
    try { return read(store) }
    catch (error) {
      if (typeof (error as { code?: unknown } | null)?.code === 'string' && String((error as { code: string }).code).startsWith('SQLITE_')) this.sinkFailure(error)
      throw error
    }
  }

  /** Quarantine permanent record failures while keeping the source checkpoint atomic with accepted evidence. */
  deliver(events: readonly LogEvent[], key: string, cursor: string, source?: Pick<Coverage, 'id' | 'source' | 'workspace'>): number {
    const originals = new Set(events)
    const remaining = [...events]
    const rejected: Error[] = []
    for (;;) {
      try { this.query((store) => store.commitDelivery(remaining, key, cursor)); break }
      catch (error) {
        if (!(error instanceof DiagnosticEventError || error instanceof DiagnosticConflictError)) throw error
        const index = remaining.indexOf(error.record)
        if (index < 0) throw error
        const [event] = remaining.splice(index, 1)
        rejected.push(error)
        if (event.source !== 'collection' || event.operation !== 'record.rejected') {
          const warning = normalize({ id: 'record.rejected:' + event.id + ':' + createHash('sha256').update(this.message(error)).digest('hex'), time: null, source: 'collection', operation: 'record.rejected',
            level: 'warning', workspace: event.workspace, message: this.message(error), context: { rejectedEventId: event.id } }, this.now(), this.secrets)
          if (warning) remaining.push(warning)
        }
      }
    }
    for (const error of rejected) this.reject(error)
    this.persistCoverage(this.connection(), remaining.filter((event) => originals.has(event)), source)
    this.saveJournal(rejected.length > 0)
    return rejected.length
  }

  flush(): boolean {
    if (this.stopped || this.now() < this.retryAt) return false
    const lossSequence = this.lossSequence
    const batch = this.queue.slice(0, 100)
    let store: DiagnosticStore
    try {
      store = this.connection()
      store.append(batch.map(({ event }) => event))
    } catch (error) {
      if (error instanceof DiagnosticConflictError || error instanceof DiagnosticEventError) {
        const rejected = this.queue.filter(({ event }) => event.id === error.eventId)
        this.queue = this.queue.filter(({ event }) => event.id !== error.eventId)
        for (const entry of rejected) this.queuedBytes -= entry.bytes
        this.reject(error)
        if (!rejected.some(({ event }) => event.source === 'collection' && event.operation === 'record.rejected')) this.warning('record.rejected', error.eventId, rejected[0]?.event.workspace ?? null, this.message(error))
        this.schedule()
        return rejected.length > 0
      }
      this.sinkFailure(error); this.retryAt = this.now() + 5000; this.saveJournal(); return false
    }
    // The event transaction committed. Coverage failure must not replay or stall it.
    for (const { bytes } of batch) this.queuedBytes -= bytes
    this.queue.splice(0, batch.length)
    const recovered = this.sinkError
    const unavailableSince = this.sinkSince
    this.sinkError = null; this.sinkSince = null; this.retryAt = 0; this.lastSuccess = this.iso()
    this.persistCoverage(store, batch.map(({ event }) => event))
    if (recovered) {
      const event = normalize({ id: 'sink-recovered:' + this.runId + ':' + this.iso(), source: 'collection', level: 'warning', operation: 'sink.recovered',
        workspace: this.options.workspace ?? null, time: this.iso(), message: 'Diagnostic collection recovered after an unavailable interval',
        context: { previousError: recovered, unavailableSince, recoveredAt: this.iso(), dropped: this.dropped } }, this.now(), this.secrets)
      if (event) this.enqueue(event)
    }
    const recoveredLoss = this.lossActive && lossSequence === this.lossSequence && !this.queue.length && !this.coverageError && !this.reportError
    if (recoveredLoss) this.lossActive = false
    this.saveJournal(recoveredLoss)
    if (this.queue.length) this.schedule()
    return batch.length > 0
  }

  private persistCoverage(store: DiagnosticStore, events: readonly LogEvent[], delivered?: Pick<Coverage, 'id' | 'source' | 'workspace'>): void {
    try {
      const id = delivered ? this.coverageId(delivered.id) : null
      if (events.length && delivered && id && !this.sources.has(id)) {
        if (this.sources.size >= MAX_COVERAGE_SOURCES) this.reject(new Error('Collection source limit of 256 reached'))
        else this.sources.set(id, { id, source: this.sourceName(delivered.source), workspace: delivered.workspace, status: 'partial', currentStatus: 'initializing',
          observedAt: null, ingestedAt: null, availableFrom: null, error: null, gaps: [] })
      }
      for (const source of this.sources.values()) {
        if (events.length && (id !== null ? source.id === id : events.some((event) => event.source === source.source && event.workspace === source.workspace))) source.ingestedAt = this.iso()
      }
      // Record every committed source before a fallible coverage write can stop persistence.
      for (const source of this.sources.values()) store.coverage(source)
      this.coverageError = null
    } catch (error) {
      const message = this.message(error)
      if (message !== this.coverageError) this.notify('logging.coverage.unavailable', message)
      this.coverageError = message
    }
  }

  private sinkFailure(error: unknown): void {
    const message = this.message(error)
    this.sinkSince ??= this.iso()
    if (message !== this.sinkError) this.notify('logging.unavailable', message)
    this.sinkError = message
  }

  private schedule(): void {
    if (this.scheduled || this.stopped || this.draining) return
    this.scheduled = true
    setImmediate(() => { this.scheduled = false; if (!this.stopped) this.flush() })
  }

  private saveJournal(force = false): void {
    const path = this.journalPath()
    if (!path || (!force && this.now() - this.journalAt < 1000)) return
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const journal: Journal = { version: 1, writtenAt: this.iso(), stopped: this.stopped, dropped: this.dropped, rejected: this.rejected, lossActive: this.lossActive, droppedSince: this.droppedSince,
        sinkError: this.sinkError, coverageError: this.coverageError, reportError: this.reportError, sinkSince: this.sinkSince, sources: [...this.sources.values()] }
      const payload = JSON.stringify(journal)
      if (Buffer.byteLength(payload) > MAX_COVERAGE_JOURNAL_BYTES) throw new Error('Coverage journal exceeds 8 MiB')
      writeFileSync(path + '.tmp', payload, { mode: 0o600 }); renameSync(path + '.tmp', path)
      this.journalAt = this.now(); this.journalError = null
    } catch (error) {
      const message = this.message(error)
      if (message !== this.journalError) this.notify('logging.journal.unavailable', message)
      this.journalError = message
    }
  }

  stop(): void {
    if (this.stopped) return
    if (this.timer) clearInterval(this.timer)
    this.timer = null; this.draining = true
    const deadline = Date.now() + 2000
    while (this.queue.length && Date.now() < deadline) if (!this.flush()) break
    if (this.queue.length) { this.dropped += this.queue.length; this.droppedSince ??= this.iso(); this.recordLoss() }
    this.queue = []; this.queuedBytes = 0; this.stopped = true; this.draining = false
    this.saveJournal(true)
    try { this.store?.close() } catch (error) { this.sinkFailure(error) }
    this.store = null
  }
}
