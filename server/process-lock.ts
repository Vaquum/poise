import { diagnosticFailure } from './logging'
import Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

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
async function acquireProcessLock(options: ProcessLockOptions): Promise<LockDatabase> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const began = performance.now()
  const deadline = Date.now() + timeoutMs
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
    try {
      lock = new Database(options.path, { timeout: 0 })
      await chmod(options.path, 0o600)
      lock.exec('BEGIN IMMEDIATE')
      return lock
    } catch (error) {
      try { if (lock?.open) lock.close() } catch { /* preserve acquisition error */ }
      if (!isSqliteContention(error)) {
        throw lockError(
          options,
          options.unavailableMessage ?? 'process lock is unavailable',
          error,
          performance.now() - began,
        )
      }
      if (Date.now() >= deadline) {
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
  const lock = await acquireProcessLock(options)
  try {
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
