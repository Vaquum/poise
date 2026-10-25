import { diagnosticFailure } from './logging'
import Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const DEFAULT_TIMEOUT_MS = 10_000
const RETRY_MIN_MS = 8
const RETRY_JITTER_MS = 17

export class ProcessLockError extends Error {
  readonly code = 'PROCESS_LOCK_UNAVAILABLE'
  readonly statusCode = 503

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProcessLockError'
  }
}

export interface ProcessLockOptions {
  path: string
  timeoutMs?: number
  unavailableMessage?: string
  timeoutMessage?: string
  errorFactory?: (message: string, cause: unknown) => Error
  /** Abandon the wait when signalled; the callback never runs without ownership. */
  signal?: AbortSignal
}

type LockDatabase = InstanceType<typeof Database>

interface LocalLockWaiter { enter: () => boolean }
const localLocks = new Map<string, LocalLockWaiter[]>()

// Only the local owner polls SQLite. Queued peers must not repeatedly open
// databases on the controller thread while that owner awaits filesystem I/O.
function reserveLocalLock(options: ProcessLockOptions, began: number, deadline: number): Promise<() => void> {
  options.signal?.throwIfAborted()
  const key = resolve(options.path)
  const previous = localLocks.get(key)
  const queue = previous ?? []
  const release = () => {
    while (queue.length > 0) {
      if (queue.shift()!.enter()) return
    }
    localLocks.delete(key)
  }
  if (!previous) {
    localLocks.set(key, queue)
    return Promise.resolve(release)
  }
  return new Promise((accept, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const cancel = (error: unknown) => {
      const index = queue.indexOf(waiter)
      if (index < 0) return
      queue.splice(index, 1)
      cleanup()
      reject(error)
    }
    const timeout = () => {
      cleanup()
      try {
        reject(lockError(options, options.timeoutMessage ?? 'timed out waiting for process lock',
          Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }), performance.now() - began))
      } catch (error) { reject(error) }
    }
    const onAbort = () => cancel(options.signal?.reason)
    const waiter: LocalLockWaiter = { enter: () => {
      if (options.signal?.aborted) { cleanup(); reject(options.signal.reason); return false }
      // I/O may finish in a microtask before an overdue timer can run.
      if (Date.now() >= deadline) { timeout(); return false }
      cleanup()
      accept(release)
      return true
    } }
    const timer = setTimeout(() => {
      const index = queue.indexOf(waiter)
      if (index < 0) return
      queue.splice(index, 1)
      timeout()
    }, Math.max(0, deadline - Date.now()))
    queue.push(waiter)
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isSqliteContention(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string'
    && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function lockError(options: ProcessLockOptions, message: string, cause: unknown, elapsedMs: number): Error {
  if ((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) >= 1000 || !isSqliteContention(cause)) diagnosticFailure('process_lock.acquire', cause,
    { lockPath: options.path, phase: 'acquisition', elapsedMs: Math.round(elapsedMs), waitLimitMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, holderPid: null, holderIdentityVerified: false }, { level: 'warning' })
  return options.errorFactory?.(message, cause) ?? new ProcessLockError(message, { cause })
}

// SQLite supplies an OS-backed lock with automatic crash release. Holding an
// IMMEDIATE transaction across the callback makes its read/compare/write work
// indivisible from every process using the same lock path. Acquisition errors
// fail closed: the callback is never invoked without ownership.
async function acquireProcessLock(options: ProcessLockOptions, began: number, deadline: number): Promise<LockDatabase> {
  options.signal?.throwIfAborted()
  try {
    await mkdir(dirname(options.path), { recursive: true })
  } catch (error) {
    throw lockError(
      options,
      options.unavailableMessage ?? 'process lock is unavailable',
      error,
      performance.now() - began,
    )
  }
  options.signal?.throwIfAborted()

  while (true) {
    let lock: LockDatabase | undefined
    let expired = false
    try {
      lock = new Database(options.path, { timeout: 0 })
      await chmod(options.path, 0o600)
      options.signal?.throwIfAborted()
      if ((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) > 0 && Date.now() >= deadline) {
        expired = true
        throw new Error('process lock acquisition exceeded its deadline')
      }
      lock.exec('BEGIN IMMEDIATE')
      return lock
    } catch (error) {
      try { if (lock?.open) lock.close() } catch { /* preserve acquisition error */ }
      if (options.signal?.aborted) throw options.signal.reason
      if (!expired && !isSqliteContention(error)) {
        throw lockError(
          options,
          options.unavailableMessage ?? 'process lock is unavailable',
          error,
          performance.now() - began,
        )
      }
      if (expired || Date.now() >= deadline) {
        throw lockError(
          options,
          options.timeoutMessage ?? 'timed out waiting for process lock',
          error,
          performance.now() - began,
        )
      }
      if (options.signal) await abortableDelay(RETRY_MIN_MS + Math.random() * RETRY_JITTER_MS, options.signal)
      else await delay(RETRY_MIN_MS + Math.random() * RETRY_JITTER_MS)
    }
  }
}

export async function withProcessLock<T>(
  options: ProcessLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const began = performance.now()
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const release = await reserveLocalLock(options, began, deadline)
  try {
    return await withReservedProcessLock(options, operation, began, deadline)
  } finally {
    release()
  }
}

async function withReservedProcessLock<T>(options: ProcessLockOptions, operation: () => Promise<T>, began: number, deadline: number): Promise<T> {
  const lock = await acquireProcessLock(options, began, deadline)
  try {
    options.signal?.throwIfAborted()
    const result = await operation()
    // This connection only reserves the lock; the callback commits its own
    // file/database. An empty COMMIT can request an exclusive lock and fail
    // after that durable write if another acquirer is reading the schema.
    // ROLLBACK releases the same reservation without an unnecessary upgrade.
    lock.exec('ROLLBACK')
    return result
  } catch (error) {
    if (lock.inTransaction) {
      try { lock.exec('ROLLBACK') }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'operation and process-lock rollback failed')
      }
    }
    throw error
  } finally {
    if (lock.open) lock.close()
  }
}
