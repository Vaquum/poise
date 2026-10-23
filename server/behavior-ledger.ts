import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AgentLogSnapshot, LogEntry } from './agent'
import type {
  LedgerAdmission, LedgerCaller, LedgerHealth, LedgerObservation, LedgerPending, LedgerPolicy,
  LedgerRead, LedgerReadReply, LedgerReadTiming, LedgerReply, LedgerResult, LedgerWorkerReply, LedgerWorkerRequest,
} from './behavior-ledger-contract'

interface Options {
  path?: string
  workerPath?: string
  policy?: Partial<LedgerPolicy>
  captureLimit?: number
  captureBytes?: number
  readLimit?: number
  readTimeoutMs?: number
  stallTimeoutMs?: number
}
interface Job {
  id: number
  operation: LedgerWorkerRequest['operation']
  observation?: LedgerObservation
  request?: LedgerRead
  bytes: number
  resolve?: (reply: LedgerReadReply) => void
  timer?: ReturnType<typeof setTimeout>
  enqueuedAt?: number
  dispatchedAt?: number
}
const emptyHealth = (): LedgerHealth => ({
  status: 'unavailable', unavailableReason: 'worker_unavailable', coverageStart: null, observedAt: null, callerObservedAt: null,
  pending: 0, dropped: 0, gaps: [], generation: null, retainedFrom: null,
  changeLowerBound: null, lastSequence: null, instances: null, changes: null,
})
const CAPTURE_RETRY_MS = 250

/** Capture never awaits or performs filesystem/SQLite work on the behavior thread. */
export class BehaviorLedgerObserver {
  private worker: Worker | null = null
  private initializing: Promise<void> | null = null
  private ready = false
  private closed = false
  private stopping = false
  private stopTimedOut = false
  private stopPromise: Promise<void> | null = null
  private failed = false
  private sequence = 0
  private queue: Job[] = []
  private active: Job | null = null
  private captures = 0
  private captureBytes = 0
  private reads = 0
  private unreportedLoss = 0
  private retryAt = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private health = emptyHealth()
  private pending = new Map<string, string | null>()
  private admitted = new Map<string, string | null>()
  private callerProjections = new Map<string, string>()
  private developmentDirectory: string | null = null

  constructor(private readonly options: Options = {}) {}

  start(): Promise<void> {
    this.initializing ??= this.initialize().catch(() => { this.fail() })
    return this.initializing
  }

  private async asset(): Promise<URL> {
    if (this.options.workerPath) return pathToFileURL(this.options.workerPath)
    const built = new URL('./behavior-ledger-worker.js', import.meta.url)
    if (existsSync(built)) return built
    const source = new URL('./behavior-ledger-worker.ts', import.meta.url)
    if (process.env.NODE_ENV === 'production' || !existsSync(source)) throw new Error('ledger_worker_missing')
    const cache = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url))
    mkdirSync(cache, { recursive: true })
    this.developmentDirectory = mkdtempSync(join(cache, 'behavior-ledger-'))
    const output = join(this.developmentDirectory, 'worker.mjs')
    const { build } = await import('esbuild')
    await build({ entryPoints: [fileURLToPath(source)], outfile: output, bundle: true,
      platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    return pathToFileURL(output)
  }

  private async initialize(): Promise<void> {
    const asset = await this.asset()
    if (this.closed) { this.removeDevelopmentAsset(); return }
    const configured = process.env.POISE_DB
    const path = this.options.path ?? (configured === ':memory:' ? ':memory:'
      : join(configured ? dirname(resolve(configured)) : join(homedir(), '.poise'), 'behavior-ledger.db'))
    const worker = new Worker(asset, {
      workerData: { path, policy: this.options.policy },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
    })
    this.worker = worker
    await new Promise<void>((resolveReady, rejectReady) => {
      // The startup wait bounds its caller; elapsed time does not prove worker failure.
      const timer = setTimeout(resolveReady, 2_000)
      worker.on('message', (message: LedgerWorkerReply | { ready: true; health: LedgerHealth; pending: LedgerPending[] }) => {
        if (this.worker !== worker) return
        try {
          if (!message || typeof message !== 'object' || !Array.isArray(message.pending)) throw new Error('Invalid ledger worker reply')
          if ('ready' in message) {
            if (!message.health || !Array.isArray(message.health.gaps)) throw new Error('Invalid ledger worker health')
            clearTimeout(timer)
            this.ready = true
            this.health = message.health
            this.setPending(message.pending)
            resolveReady()
            this.pump()
            return
          }
          if (!message.body?.health || !Array.isArray(message.body.health.gaps)) throw new Error('Invalid ledger worker health')
          this.receive(message)
        } catch {
          clearTimeout(timer)
          rejectReady(new Error('ledger_worker_protocol'))
          this.fail()
        }
      })
      const fail = () => { clearTimeout(timer); rejectReady(new Error('ledger_worker_stopped')); this.fail() }
      worker.on('error', fail)
      worker.on('exit', () => {
        if (this.worker === worker) this.worker = null
        if (this.stopping) this.closed = true
        fail()
        this.removeDevelopmentAsset()
      })
    })
  }

  capture(observation: LedgerObservation): void {
    try {
      if (this.closed || this.stopping) return
      const serialized = JSON.stringify(observation)
      const bytes = Buffer.byteLength(serialized)
      if (bytes > 4_096 || this.failed) { this.lose(1); return }
      const captured = JSON.parse(serialized) as LedgerObservation
      // Overflow waits for the drain while the worker makes progress and
      // spills only once captures sit undrained past the stall budget.
      if ((this.captures >= (this.options.captureLimit ?? 1_000)
        || this.captureBytes + bytes > (this.options.captureBytes ?? 2 * 1024 * 1024))
        && (!this.ready || this.stalled())) {
        this.lose(1)
        return
      }
      this.captures++
      this.captureBytes += bytes
      if (captured.type === 'admit' && ['review-new-prs', 'approve-prs', 'review-new-issues'].includes(captured.behavior)) {
        this.admitted.set(captured.nativeId, null)
      }
      this.queue.push({ id: ++this.sequence, operation: 'capture', observation: captured, bytes, enqueuedAt: Date.now() })
      this.pump()
    } catch { this.lose(1) }
  }

  private oldestCaptureAt(): number {
    let oldest = Infinity
    for (const job of [...(this.active ? [this.active] : []), ...this.queue]) {
      if (job.operation === 'capture' && job.enqueuedAt !== undefined && job.enqueuedAt < oldest) oldest = job.enqueuedAt
    }
    return oldest
  }

  private stalled(): boolean {
    // Idle is not stalled: a fresh burst is always accepted, and sustained
    // overload or a wedged worker spills once the oldest capture outwaits the budget.
    return this.captures > 0
      && Date.now() - this.oldestCaptureAt() > (this.options.stallTimeoutMs ?? 10_000)
  }

  private lose(count: number): void { this.unreportedLoss += count }

  private projectedHealth(): LedgerHealth {
    const health = { ...this.health, pending: this.captures, dropped: this.health.dropped + this.unreportedLoss }
    if (this.closed || this.stopping) { health.status = 'stopped'; health.unavailableReason = null }
    else if (this.failed) { health.status = 'unavailable'; health.unavailableReason = 'worker_unavailable' }
    else if (health.pending || health.dropped || health.gaps.length) {
      if (health.status === 'ok') health.status = 'incomplete'
    }
    return health
  }

  private unavailable(request: LedgerRead, error = 'ledger_unavailable'): { status: number; body: LedgerReply } {
    const health = this.projectedHealth()
    if (health.status !== 'stopped') {
      health.status = 'unavailable'
      // A read that misses its budget with no deeper cause names the miss
      // itself; unavailable never surfaces without a reason.
      health.unavailableReason ??= 'read_timeout'
    }
    return { status: request.operation === 'health' ? 200 : 503,
      body: { version: 1, health, ...(request.operation === 'health' ? {} : { error }) } }
  }

  read(request: LedgerRead): Promise<LedgerReadReply> {
    if (this.failed || this.closed || this.stopping) return Promise.resolve(this.unavailable(request))
    if (this.reads >= (this.options.readLimit ?? 16)) return Promise.resolve({ status: 429,
      body: { version: 1, health: this.projectedHealth(), error: 'ledger_busy' } })
    this.reads++
    return new Promise((resolveReply) => {
      const job: Job = { id: ++this.sequence, operation: 'read', request, bytes: 0, resolve: resolveReply, enqueuedAt: performance.now() }
      job.timer = setTimeout(() => {
        if (!job.resolve) return
        // A late active reply still owns its bounded worker slot until it arrives.
        if (this.active !== job) this.reads--
        const timing = this.readTiming(job)
        timing.timeout = this.active === job ? 'active' : 'queued'
        if (timing.timeout === 'queued' && this.active?.dispatchedAt !== undefined) {
          timing.blocking = { kind: this.active.observation?.type ?? this.active.operation,
            elapsedMs: performance.now() - this.active.dispatchedAt }
        }
        job.resolve({ ...this.unavailable(request, 'ledger_read_timeout'), timing })
        job.resolve = undefined
        this.queue = this.queue.filter((candidate) => candidate !== job)
      }, this.options.readTimeoutMs ?? 2_000)
      this.queue.push(job)
      this.pump()
    })
  }

  private setPending(rows: LedgerPending[]): void {
    this.pending = new Map(rows.map((row) => [row.nativeId, row.callId]))
    for (const nativeId of this.callerProjections.keys()) {
      if (!this.pending.has(nativeId) && !this.admitted.has(nativeId)) this.callerProjections.delete(nativeId)
    }
  }

  private readTiming(job: Job): LedgerReadTiming {
    const now = performance.now()
    return { queueMs: (job.dispatchedAt ?? now) - job.enqueuedAt!,
      ...(job.dispatchedAt === undefined ? {} : { activeMs: now - job.dispatchedAt }) }
  }

  private receive(message: LedgerWorkerReply): void {
    const job = this.active
    if (!job || message.id !== job.id) return
    this.active = null
    this.health = message.body.health
    this.setPending(message.pending)
    if (job.operation === 'capture') {
      if (message.status >= 500 && job.observation?.type !== 'loss' && !this.stopTimedOut) {
        // Storage-side failure: hold the job at the head for retry instead
        // of consuming it, so an outage delays captures without losing them.
        job.dispatchedAt = undefined
        this.queue.unshift(job)
        this.retryAt = Date.now() + CAPTURE_RETRY_MS
        this.pump(true)
        return
      }
      this.captures--
      this.captureBytes -= job.bytes
      if (job.observation?.type === 'admit') this.admitted.delete(job.observation.nativeId)
      if (job.observation?.type === 'loss') {
        if (message.status < 400) this.unreportedLoss = Math.max(0, this.unreportedLoss - job.observation.count)
        else { this.fail(); return }
      } else if (message.status >= 400) this.lose(1)
    }
    if (job.operation === 'read') this.reads--
    if (job.operation === 'close') this.closed = true
    if (job.resolve) {
      clearTimeout(job.timer)
      job.resolve({ status: message.status, body: { ...message.body, health: this.projectedHealth() },
        ...(job.operation === 'read' ? { timing: { ...this.readTiming(job), worker: message.timing } } : {}) })
    }
    this.pump(job.operation === 'capture')
  }

  private pump(preferRead = false): void {
    if (!this.ready || this.closed || this.failed || this.active || !this.worker) return
    // A loss marker has a reserved slot; dropping it would hide capture loss.
    if (this.unreportedLoss && !this.queue.some((job) => job.observation?.type === 'loss')) {
      this.queue.unshift({ id: ++this.sequence, operation: 'capture', bytes: 0, enqueuedAt: Date.now(),
        observation: { type: 'loss', count: this.unreportedLoss } })
      this.captures++
    }
    // Read deadlines include queue wait; permit a turn without starving capture.
    const readIndex = preferRead ? this.queue.findIndex((job) => job.operation === 'read') : -1
    const job = readIndex < 0 ? this.queue[0] : this.queue[readIndex]
    if (!job) { this.worker.unref(); return }
    if (job.operation === 'capture' && Date.now() < this.retryAt) {
      // A failing store backs capture dispatch off; reads still flow.
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump() }, this.retryAt - Date.now())
        this.retryTimer.unref()
      }
      return
    }
    if (readIndex < 0) this.queue.shift()
    else this.queue.splice(readIndex, 1)
    this.active = job
    job.dispatchedAt = performance.now()
    this.worker.ref()
    try { this.worker.postMessage({ id: job.id, operation: job.operation,
      observation: job.observation, request: job.request } satisfies LedgerWorkerRequest) }
    catch { this.fail() }
  }

  private fail(): void {
    if (this.failed) return
    this.failed = true
    this.ready = false
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const worker = this.worker
    const jobs = [...(this.active ? [this.active] : []), ...this.queue]
    this.active = null
    this.queue = []
    this.lose(jobs.filter((job) => job.operation === 'capture' && job.observation?.type !== 'loss').length)
    this.captures = 0
    this.captureBytes = 0
    this.admitted.clear()
    this.callerProjections.clear()
    for (const job of jobs) {
      if (job.operation === 'read') this.reads--
      if (!job.resolve) continue
      clearTimeout(job.timer)
      job.resolve(this.unavailable(job.request ?? { operation: 'health' }))
    }
    // Forced isolate termination can abort the whole process inside a
    // native SQLite error. Close cooperatively after its current request.
    if (worker) {
      worker.ref()
      if (this.unreportedLoss) worker.postMessage({ id: ++this.sequence, operation: 'capture',
        observation: { type: 'loss', count: this.unreportedLoss } } satisfies LedgerWorkerRequest)
      worker.postMessage({ id: ++this.sequence, operation: 'close' } satisfies LedgerWorkerRequest)
    } else this.removeDevelopmentAsset()
  }

  private removeDevelopmentAsset(): void {
    if (!this.developmentDirectory) return
    rmSync(this.developmentDirectory, { recursive: true, force: true })
    this.developmentDirectory = null
  }

  private captureCaller(nativeId: string, observation: LedgerCaller): void {
    // Snapshots repeat unchanged Caller evidence while the store ignores
    // semantic duplicates, so only changed projections reach the worker queue.
    // Static running evidence then lapses under the documented staleness
    // decay instead of re-emitting on a timer.
    const projection = JSON.stringify(observation)
    if (this.callerProjections.get(nativeId) === projection) return
    this.callerProjections.set(nativeId, projection)
    this.capture(observation)
  }

  observe(snapshot: AgentLogSnapshot): void {
    try {
      const pending = new Map([...this.pending, ...this.admitted])
      if (!pending.size) return
      const byCall = new Map([...pending].flatMap(([nativeId, callId]) => callId ? [[callId, nativeId] as const] : []))
      const related = new Map<string, { row: LogEntry; duplicate: boolean }>()
      // Keep at most one bounded source projection per known pending identity.
      for (const row of snapshot.entries) {
        const nativeId = row.correlation_id && pending.has(row.correlation_id) ? row.correlation_id : byCall.get(row.id)
        if (!nativeId) continue
        const prior = related.get(nativeId)
        if (!prior) related.set(nativeId, { row, duplicate: false })
        else {
          prior.duplicate = true
          if (/^(running|in_progress)$/.test(row.status)) prior.row = row
        }
      }
      const calls = new Map<string, number>()
      for (const { row } of related.values()) calls.set(row.id, 0)
      for (const row of snapshot.entries) {
        if (calls.has(row.id)) calls.set(row.id, calls.get(row.id)! + 1)
      }
      const quarantinedCalls = new Set<string>()
      const quarantinedCorrelations = new Set<string>()
      let unattributed = false
      for (const item of snapshot.quarantined) {
        if (item.id && calls.has(item.id)) quarantinedCalls.add(item.id)
        if (item.correlationId && pending.has(item.correlationId)) quarantinedCorrelations.add(item.correlationId)
        if (!item.id && !item.correlationId) unattributed = true
      }
      for (const [nativeId, { row, duplicate }] of related) {
        const correlationMatches = row.correlation_id === nativeId
        const quarantined = !correlationMatches || duplicate || (calls.get(row.id) ?? 0) > 1
          || quarantinedCalls.has(row.id) || quarantinedCorrelations.has(nativeId) || unattributed
        const observation: LedgerCaller = {
          type: 'caller', nativeId, callId: row.id, repository: row.repo,
          number: row.pr_id ? Number(row.pr_id) : null, actor: row.actor, source: row.source,
          behavior: row.behavior, expectedHead: row.expected_head, head: row.head_sha,
          status: correlationMatches ? row.status : null, action: row.action, outcome: row.outcome,
          startedAt: row.started_at_precise ?? row.started_at, completedAt: row.completed_at ?? null,
          uncertain: quarantined, mayRun: correlationMatches && /^(running|in_progress)$/.test(row.status),
          interrupted: row.error_code === 'interrupted',
        }
        this.captureCaller(nativeId, observation)
      }
      for (const [nativeId, callId] of pending) {
        if (related.has(nativeId)) continue
        this.captureCaller(nativeId, { type: 'caller', nativeId, callId, repository: null, number: null, actor: null,
          source: null, behavior: null, expectedHead: null, head: null, status: null,
          action: null, outcome: null, startedAt: null, completedAt: null, uncertain: true, mayRun: false })
      }
    } catch { this.lose(1) }
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true
      this.stopPromise = this.finishStop()
    }
    return this.stopPromise
  }

  private async finishStop(): Promise<void> {
    if (!this.initializing && !this.worker) { this.closed = true; return }
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!this.failed) await Promise.race([
      new Promise<void>((resolveClose) => {
        this.queue.push({ id: ++this.sequence, operation: 'close', bytes: 0, resolve: () => resolveClose() })
        this.pump()
      }),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, 2_000)
        timer.unref()
      }),
    ])
    clearTimeout(timer)
    if (this.closed || this.failed) return
    // The caller's budget does not prove the native request ended. Keep
    // that worker referenced until it replies and closes its own SQLite.
    this.stopTimedOut = true
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.retryAt = 0
    const queued = this.queue
    this.queue = queued.filter((job) => job.operation === 'close')
    for (const job of queued) {
      if (job.operation === 'capture') {
        this.captures--
        this.captureBytes -= job.bytes
        if (job.observation?.type !== 'loss') this.lose(1)
        if (job.observation?.type === 'admit') this.admitted.delete(job.observation.nativeId)
      }
      if (job.operation !== 'read') continue
      this.reads--
      clearTimeout(job.timer)
      job.resolve?.(this.unavailable(job.request ?? { operation: 'health' }))
    }
    this.pump()
  }
}

let observer: BehaviorLedgerObserver | null = null
export function startBehaviorLedger(options: Options = {}): Promise<void> {
  observer ??= new BehaviorLedgerObserver(options)
  return observer.start()
}
export async function stopBehaviorLedger(): Promise<void> {
  const previous = observer
  observer = null
  await previous?.stop()
}
export function captureBehaviorAdmission(input: Omit<LedgerAdmission, 'type'>): void {
  observer?.capture({ ...input, type: 'admit' })
}
export function captureBehaviorOutcome(input: Omit<LedgerResult, 'type'>): void {
  observer?.capture({ ...input, type: 'result' })
}
export function observeAgentSnapshot(snapshot: AgentLogSnapshot): void { observer?.observe(snapshot) }
export function behaviorLedgerHeartbeat(): void { observer?.capture({ type: 'heartbeat' }) }
export function readBehaviorLedger(request: LedgerRead): Promise<LedgerReadReply> {
  return observer ? observer.read(request) : Promise.resolve({ status: request.operation === 'health' ? 200 : 503,
    body: { version: 1, health: emptyHealth(), ...(request.operation === 'health' ? {} : { error: 'ledger_unavailable' }) } })
}
