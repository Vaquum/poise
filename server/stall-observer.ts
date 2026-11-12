// Where the server's main thread goes when it stalls: garbage collection
// pauses, slow SQLite calls with the code that made them (statements,
// including the BEGIN and COMMIT of every transaction, compiles and exec),
// how long the file-I/O threads queue a trivial request, and the process's
// memory. Always on and read-only: GET /api/health/stalls reads it, and
// nothing triggers, writes or exports a profile. Only calls of SLOW_MS or
// more are kept, with SQL literals masked.
import Database from 'better-sqlite3'
import { stat } from 'node:fs/promises'
import { PerformanceObserver, constants, performance } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import { eventLoopDelayStats } from './event-loop-delay'

const SLOW_MS = 50
const RECENT = 100
const TOTALS = 300
const PROBE_MS = 2_000

type Kind = 'gc' | 'sqlite' | 'threadpool'
interface Stall { at: string, kind: Kind, what: string, ms: number, site: string }
interface Total { kind: Kind, what: string, site: string, count: number, totalMs: number, maxMs: number, lastAt: string }

const recent: Stall[] = []
const totals = new Map<string, Total>()
let installedAt: string | null = null
let probe = { lastMs: 0, maxMs: 0, maxAt: null as string | null }

const GC_KINDS: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weak callbacks',
}

/** SQL text with its literals masked: what ran, never the values it carried. */
export function maskSql(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, '?').replace(/\b\d+(?:\.\d+)?\b/g, '?').replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** The first frames below the timed call, outside SQLite's binding: who made it. */
function callSite(below: (...args: never[]) => unknown): string {
  const holder: { stack?: string } = {}
  Error.captureStackTrace(holder, below)
  return (holder.stack ?? '').split('\n').slice(1)
    .filter((line) => !/better-sqlite3|node:internal/.test(line))
    .slice(0, 3)
    .map((line) => line.trim().replace(/^at /, '').replace(/\(?(?:file:\/\/)?[^\s()]*\/([^/\s()]+:\d+):\d+\)?$/, '($1)'))
    .join(' < ')
}

export function recordStall(kind: Kind, what: string, ms: number, site = ''): void {
  if (ms < SLOW_MS) return
  const at = new Date().toISOString()
  recent.push({ at, kind, what, ms: Math.round(ms), site })
  if (recent.length > RECENT) recent.shift()
  const key = `${kind}\u0000${what}\u0000${site}`
  let total = totals.get(key)
  if (!total) {
    if (totals.size >= TOTALS) {
      let least: string | null = null
      for (const [k, t] of totals) if (least === null || t.totalMs < totals.get(least)!.totalMs) least = k
      if (least !== null) totals.delete(least)
    }
    total = { kind, what, site, count: 0, totalMs: 0, maxMs: 0, lastAt: at }
    totals.set(key, total)
  }
  total.count += 1
  total.totalMs += ms
  total.maxMs = Math.max(total.maxMs, ms)
  total.lastAt = at
}

function timed<F extends (...args: never[]) => unknown>(original: F, what: (self: unknown, args: unknown[]) => string): F {
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const started = performance.now()
    try {
      return (original as unknown as (...a: unknown[]) => unknown).apply(this, args)
    } finally {
      const ms = performance.now() - started
      if (ms >= SLOW_MS) recordStall('sqlite', what(this, args), ms, callSite(wrapper))
    }
  }
  return wrapper as unknown as F
}

/** Install once, in the production server before its modules open databases. */
export function installStallObserver(): void {
  if (installedAt) return
  installedAt = new Date().toISOString()
  const scratch = new Database(':memory:')
  const statement = Object.getPrototypeOf(scratch.prepare('SELECT 1')) as Record<'run' | 'get' | 'all', (...args: never[]) => unknown>
  scratch.close()
  for (const method of ['run', 'get', 'all'] as const) {
    statement[method] = timed(statement[method], (self) => maskSql(String((self as { source?: unknown }).source ?? '')))
  }
  const database = Database.prototype as unknown as Record<'prepare' | 'exec', (...args: never[]) => unknown>
  database.prepare = timed(database.prepare, (_, args) => `prepare ${maskSql(String(args[0]))}`)
  database.exec = timed(database.exec, (_, args) => `exec ${maskSql(String(args[0]))}`)
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      recordStall('gc', GC_KINDS[(entry as unknown as { detail?: { kind?: number } }).detail?.kind ?? -1] ?? 'gc', entry.duration)
    }
  }).observe({ entryTypes: ['gc'] })
  const timer = setInterval(() => {
    const started = performance.now()
    void stat('/').catch(() => undefined).finally(() => {
      const ms = performance.now() - started
      probe.lastMs = Math.round(ms)
      if (ms >= probe.maxMs) probe = { lastMs: probe.lastMs, maxMs: Math.round(ms), maxAt: new Date().toISOString() }
      recordStall('threadpool', 'a trivial file read waited', ms)
    })
  }, PROBE_MS)
  timer.unref()
}

const mb = (bytes: number) => Math.round(bytes / 1_048_576)

export function stallSnapshot() {
  const memory = process.memoryUsage()
  const heap = getHeapStatistics()
  return {
    installedAt,
    slowMs: SLOW_MS,
    eventLoop: eventLoopDelayStats(),
    threadpoolProbe: probe,
    memoryMb: { rss: mb(memory.rss), heapUsed: mb(memory.heapUsed), heapTotal: mb(memory.heapTotal), heapLimit: mb(heap.heap_size_limit), external: mb(memory.external), arrayBuffers: mb(memory.arrayBuffers) },
    totals: [...totals.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 40)
      .map((total) => ({ ...total, totalMs: Math.round(total.totalMs), maxMs: Math.round(total.maxMs) })),
    recent: recent.slice(-50).reverse(),
  }
}
