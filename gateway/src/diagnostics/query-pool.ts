import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { LoggingQueryError } from './query-parser.js'
import { LOGGING_QUERY_MS, type LoggingRead, type LoggingReply, type WorkerReply } from './query-types.js'

interface Lease { reply: LoggingReply; release: () => void }
interface Pending {
  id: number
  principal: string
  request: LoggingRead
  resolve: (lease: Lease) => void
  reject: (error: Error) => void
  released: boolean
  signal: AbortSignal
  abort: () => void
  timer: ReturnType<typeof setTimeout>
  onTimeout: () => void
}

/** One read worker; admission includes response backpressure, not just SQLite execution. */
export class LoggingQueryPool {
  private worker: Worker | null = null
  private retiring: Promise<void> | null = null
  private queue: Pending[] = []
  private active: Pending | null = null
  private readonly leases = new Set<Pending>()
  private readonly principals = new Map<string, number>()
  private sequence = 0
  private pumping = false
  private closed = false
  private developmentDirectory: string | null = null
  private asset: URL | null = null

  constructor(private readonly options: { workerUrl?: URL } = {}) {}

  read(request: LoggingRead, principal: string, signal: AbortSignal, onTimeout: () => void): Promise<Lease> {
    if (this.closed) return Promise.reject(new LoggingQueryError(503, 'logging_unavailable', 'The diagnostic query service is stopping.'))
    if (signal.aborted) return Promise.reject(new LoggingQueryError(503, 'logging_abandoned', 'The diagnostic request was abandoned.'))
    if (this.leases.size >= 17 || this.queue.length >= 16 || (this.principals.get(principal) ?? 0) >= 2) {
      return Promise.reject(new LoggingQueryError(429, 'logging_busy', 'Diagnostic reads are busy. Retry shortly.'))
    }
    return new Promise<Lease>((resolve, reject) => {
      const job: Pending = {
        id: ++this.sequence, principal, request, resolve, reject, released: false, signal,
        abort: () => this.cancel(job, new LoggingQueryError(503, 'logging_abandoned', 'The diagnostic request was abandoned.')),
        timer: setTimeout(() => {
          this.cancel(job, new LoggingQueryError(503, 'logging_query_timeout', 'The diagnostic query exceeded its two-second response budget.'))
          onTimeout()
        }, LOGGING_QUERY_MS), onTimeout,
      }
      this.leases.add(job)
      this.principals.set(principal, (this.principals.get(principal) ?? 0) + 1)
      signal.addEventListener('abort', job.abort, { once: true })
      this.queue.push(job)
      void this.pump()
    })
  }

  private release(job: Pending): void {
    if (job.released) return
    job.released = true
    clearTimeout(job.timer)
    job.signal.removeEventListener('abort', job.abort)
    this.leases.delete(job)
    const count = (this.principals.get(job.principal) ?? 1) - 1
    if (count) this.principals.set(job.principal, count)
    else this.principals.delete(job.principal)
  }

  private cancel(job: Pending, error: Error): void {
    if (job.released) return
    this.queue = this.queue.filter((candidate) => candidate !== job)
    if (this.active === job) { this.active = null; this.retire() }
    job.reject(error)
    this.release(job)
    void this.pump()
  }

  private retire(): void {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    const previous = this.retiring
    this.retiring = (async () => { if (previous) await previous; await worker.terminate() })()
  }

  private async workerAsset(): Promise<URL> {
    if (this.options.workerUrl) return this.options.workerUrl
    if (this.asset) return this.asset
    const built = new URL('./query-worker.js', import.meta.url)
    if (existsSync(built)) return built
    const source = new URL('./query-worker.ts', import.meta.url)
    if (process.env.NODE_ENV === 'production' || !existsSync(source)) throw new Error('The diagnostic query worker asset is missing')
    const cache = fileURLToPath(new URL('../../node_modules/.cache/', import.meta.url))
    mkdirSync(cache, { recursive: true })
    this.developmentDirectory ??= mkdtempSync(join(cache, 'logging-query-'))
    const output = join(this.developmentDirectory, 'worker.mjs')
    // Development only. Production ships the built worker and needs no compiler.
    try {
      const { build } = await import('esbuild')
      await build({ entryPoints: [fileURLToPath(source)], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
      this.asset = pathToFileURL(output)
      return this.asset
    } finally {
      if (this.closed) rmSync(this.developmentDirectory, { recursive: true, force: true })
    }
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.retiring) { await this.retiring; this.retiring = null }
    if (this.worker) return this.worker
    const asset = await this.workerAsset()
    if (this.closed) throw new Error('The diagnostic query service is stopping')
    const worker = new Worker(asset, { resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 } })
    this.worker = worker
    worker.on('message', (message: WorkerReply) => {
      const job = this.active
      if (this.worker !== worker || !job || message.id !== job.id || job.released) return
      this.active = null
      worker.unref()
      if ('error' in message) {
        job.reject(new LoggingQueryError(message.error.status, message.error.code, message.error.message))
        this.release(job)
      } else job.resolve({ reply: message.reply, release: () => this.release(job) })
      void this.pump()
    })
    const failed = () => {
      if (this.worker !== worker) return
      const job = this.active
      if (job) this.cancel(job, new LoggingQueryError(503, 'logging_unavailable', 'The bounded diagnostic query worker stopped.'))
      else this.retire()
    }
    worker.on('error', failed)
    worker.on('exit', failed)
    worker.unref()
    return worker
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.active || this.closed) return
    this.pumping = true
    try {
      while (!this.active && this.queue.length && !this.closed) {
        const job = this.queue.shift()!
        if (job.released) continue
        this.active = job
        try {
          const worker = await this.ensureWorker()
          if (job.released || this.closed || this.active !== job) continue
          worker.ref()
          worker.postMessage({ id: job.id, request: job.request })
        } catch {
          this.cancel(job, new LoggingQueryError(503, 'logging_unavailable', 'The diagnostic query worker could not start.'))
        }
      }
    } finally {
      this.pumping = false
      if (!this.active && this.queue.length && !this.closed) void this.pump()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const job of [...this.leases]) {
      job.onTimeout()
      this.cancel(job, new LoggingQueryError(503, 'logging_unavailable', 'The diagnostic query service is stopping.'))
    }
    this.retire()
    if (this.retiring) await this.retiring
    if (this.developmentDirectory) rmSync(this.developmentDirectory, { recursive: true, force: true })
  }
}
