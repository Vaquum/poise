// Resource-aware admission for atomic behaviors (#731).
//
// A bounded memory/disk budget admits parallel behaviors by measured cost
// instead of treating every slot as equally cheap. The reservation held by
// one admitted native behavior covers its whole tree, including provider
// children and build/test descendants; the box-level headroom probe charges
// every descendant implicitly because it measures actual free capacity.
// Actual deletion and process teardown stay with #729's Caller sweep, which
// proves ownership before removing anything; this module only gates
// admission. Live breach termination is the #730 follow-up, not this change.
//
// Configuration is environment-only, so no Settings surface changes and
// production defaults are preserved: unset budgets are unbounded and every
// admission path below behaves exactly as before, running no probes.
import { readFileSync, statfsSync } from 'node:fs'
import { freemem, homedir, tmpdir } from 'node:os'

export interface BehaviorResourceBudget { memoryBytes: number | null, diskBytes: number | null }
export interface BehaviorResourceReservation { memoryBytes: number, diskBytes: number }
export interface BehaviorResourceAdmission { budget: BehaviorResourceBudget, reservation: BehaviorResourceReservation }
export interface BehaviorResourceHeadroom { freeMemoryBytes: number, freeDiskBytes: number, diskPath: string }

function budgetBytes(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive byte count, got ${JSON.stringify(raw)}`)
  return value
}

function reservationBytes(env: NodeJS.ProcessEnv, name: string): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return 0
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative byte count, got ${JSON.stringify(raw)}`)
  return value
}

/** Configured admission, or null when both budgets are unbounded. A bounded
 *  budget with no reservation would silently admit without limit, so that
 *  combination is an explicit configuration error instead. */
export function readBehaviorResourceAdmission(env: NodeJS.ProcessEnv = process.env): BehaviorResourceAdmission | null {
  const budget: BehaviorResourceBudget = { memoryBytes: budgetBytes(env, 'POISE_BEHAVIOR_MEMORY_BUDGET_BYTES'),
    diskBytes: budgetBytes(env, 'POISE_BEHAVIOR_DISK_BUDGET_BYTES') }
  const reservation: BehaviorResourceReservation = { memoryBytes: reservationBytes(env, 'POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES'),
    diskBytes: reservationBytes(env, 'POISE_BEHAVIOR_DISK_RESERVATION_BYTES') }
  if (budget.memoryBytes === null && budget.diskBytes === null) return null
  if (budget.memoryBytes !== null && reservation.memoryBytes <= 0) throw new Error('POISE_BEHAVIOR_MEMORY_BUDGET_BYTES is set but POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES reserves nothing; set an explicit per-behavior reservation')
  if (budget.diskBytes !== null && reservation.diskBytes <= 0) throw new Error('POISE_BEHAVIOR_DISK_BUDGET_BYTES is set but POISE_BEHAVIOR_DISK_RESERVATION_BYTES reserves nothing; set an explicit per-behavior reservation')
  return { budget, reservation }
}

/** Captured in the immutable request, never reconstructed from a later env. */
export interface BehaviorExecutionLimits { version: 1, memoryBytes: number | null, diskBytes: number | null }

export function executionLimits(resources: BehaviorResourceAdmission): BehaviorExecutionLimits {
  return { version: 1, memoryBytes: resources.budget.memoryBytes === null ? null : resources.reservation.memoryBytes,
    diskBytes: resources.budget.diskBytes === null ? null : resources.reservation.diskBytes }
}

export function validateExecutionLimits(value: BehaviorExecutionLimits, reservation: BehaviorResourceReservation | null | undefined): void {
  if (value.version !== 1 || Object.keys(value).some(key => !['version', 'memoryBytes', 'diskBytes'].includes(key))
    || !reservation || value.memoryBytes === null && value.diskBytes === null
    || (['memoryBytes', 'diskBytes'] as const).some(key => value[key] !== null
      && (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0 || value[key] !== reservation[key]))) {
    throw new Error('behavior execution limits differ from the original resource reservation')
  }
}

export interface ExecutionResourceGuard {
  version: 1
  limits: BehaviorExecutionLimits
  state: 'starting' | 'measured' | 'stopped'
  memoryModel: string
  peakMemoryBytes: number
  peakDiskBytes: number
  samples: number
  partialSamples: number
  lastCompleteAt: number | null
  longestUnavailableSeconds: number
  failure: null | { code: string, dimension: string, ceiling: number | null, observed: number | null,
    observedAt: number, observedMonotonic: number, message: string, signalMonotonic?: number, noWrite?: boolean }
}

export function parseExecutionResourceGuard(value: unknown): ExecutionResourceGuard | null {
  if (value == null) return null // Historical admissions are unenforced.
  if (typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 8192) throw new Error('invalid native execution guard')
  const row = value as ExecutionResourceGuard
  if (row.version !== 1 || !row.limits || Object.keys(row).sort().join() !==
    ['version', 'limits', 'state', 'memoryModel', 'peakMemoryBytes', 'peakDiskBytes', 'samples', 'partialSamples', 'lastCompleteAt', 'longestUnavailableSeconds', 'failure'].sort().join()
    || !['starting', 'measured', 'stopped'].includes(row.state) || !['unmeasured', 'pss', 'rss', 'pss+rss'].includes(row.memoryModel)
    || [row.peakMemoryBytes, row.peakDiskBytes, row.samples, row.partialSamples].some(n => !Number.isSafeInteger(n) || n < 0)
    || row.lastCompleteAt !== null && (!Number.isFinite(row.lastCompleteAt) || row.lastCompleteAt <= 0)
    || !Number.isFinite(row.longestUnavailableSeconds) || row.longestUnavailableSeconds < 0
    || (row.state === 'stopped') !== (row.failure !== null)) throw new Error('invalid native execution guard')
  validateExecutionLimits(row.limits, { memoryBytes: row.limits.memoryBytes ?? 0, diskBytes: row.limits.diskBytes ?? 0 })
  const failure = row.failure
  if (failure && (Object.keys(failure).filter(key => !['signalMonotonic', 'noWrite'].includes(key)).sort().join() !== ['code', 'dimension', 'ceiling', 'observed', 'observedAt', 'observedMonotonic', 'message'].sort().join()
    || !['resource_memory_exceeded', 'resource_disk_exceeded', 'resource_measurement_unavailable'].includes(failure.code)
    || typeof failure.message !== 'string' || !failure.message || failure.message.length > 2000
    || !Number.isFinite(failure.observedAt) || failure.observedAt <= 0 || !Number.isFinite(failure.observedMonotonic) || failure.observedMonotonic < 0
    || failure.signalMonotonic !== undefined && (!Number.isFinite(failure.signalMonotonic) || failure.signalMonotonic < failure.observedMonotonic)
    || failure.noWrite !== undefined && typeof failure.noWrite !== 'boolean'
    || (failure.code === 'resource_measurement_unavailable'
      ? failure.dimension !== 'coverage' || failure.ceiling !== null || failure.observed !== null
      : !['memoryBytes', 'diskBytes'].includes(failure.dimension) || failure.ceiling !== row.limits[failure.dimension as 'memoryBytes' | 'diskBytes']
        || !Number.isSafeInteger(failure.observed) || Number(failure.observed) <= Number(failure.ceiling)))) throw new Error('invalid native execution guard failure')
  return row
}

/** Remaining memory under this process's cgroup v2 limit, or unbounded when
 *  no limit is set or no cgroup files exist (developer machines). Behaviors
 *  run inside the memory-limited workspace container, where os.freemem()
 *  reports host-wide free memory and would overstate the allowance the
 *  container limit will actually enforce. */
function cgroupAllowance(read: (name: string) => string | null): number {
  let maxRaw: string | null
  let currentRaw: string | null
  try {
    maxRaw = read('memory.max')
    if (maxRaw === null || maxRaw.trim() === 'max') return Number.POSITIVE_INFINITY
    currentRaw = read('memory.current')
  } catch (error) {
    throw new Error(`behavior resource measurement unavailable: cgroup memory read failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const max = maxRaw.trim() ? Number(maxRaw.trim()) : Number.NaN
  const current = currentRaw?.trim() ? Number(currentRaw.trim()) : Number.NaN
  if (!Number.isSafeInteger(max) || max < 0 || !Number.isSafeInteger(current) || current < 0) {
    throw new Error('behavior resource measurement unavailable: cgroup memory read is invalid')
  }
  return Math.max(0, max - current)
}

/** Synchronous free capacity at one admission boundary. Disposable behavior
 *  roots and provider history live under home while bounded spool uses the
 *  temporary filesystem, so disk headroom is the tighter of the two. Probes
 *  run synchronously at each decision, so a reading is never a stale cache;
 *  any failure reads as unavailable and must block admission explicitly. */
export function measureBehaviorHeadroom(read: { freeMemory?: () => number, diskFree?: (path: string) => number, cgroupFile?: (name: string) => string | null } = {}): BehaviorResourceHeadroom {
  const freeMemory = read.freeMemory ?? freemem
  const diskFree = read.diskFree ?? ((path: string) => {
    const stats = statfsSync(path)
    return stats.bavail * stats.bsize
  })
  const cgroupFile = read.cgroupFile ?? ((name: string) => {
    try { return readFileSync(`/sys/fs/cgroup/${name}`, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  })
  let freeMemoryBytes: number
  try {
    freeMemoryBytes = freeMemory()
  } catch (error) {
    throw new Error(`behavior resource measurement unavailable: free memory read failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Number.isSafeInteger(freeMemoryBytes) || freeMemoryBytes < 0) throw new Error('behavior resource measurement unavailable: free memory read is invalid')
  freeMemoryBytes = Math.min(freeMemoryBytes, cgroupAllowance(cgroupFile))
  let freeDiskBytes = Number.POSITIVE_INFINITY
  let diskPath = ''
  for (const path of [homedir(), tmpdir()]) {
    let free: number
    try {
      free = diskFree(path)
    } catch (error) {
      throw new Error(`behavior resource measurement unavailable: disk read of ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Number.isSafeInteger(free) || free < 0) throw new Error(`behavior resource measurement unavailable: disk read of ${path} is invalid`)
    if (free < freeDiskBytes) { freeDiskBytes = free; diskPath = path }
  }
  return { freeMemoryBytes, freeDiskBytes, diskPath }
}

/** Durable-budget shortfall for one more reservation, or null when it fits. */
export function budgetShortfall(budget: BehaviorResourceBudget, reserved: BehaviorResourceReservation, reservation: BehaviorResourceReservation): string | null {
  const over: string[] = []
  if (budget.memoryBytes !== null && reserved.memoryBytes + reservation.memoryBytes > budget.memoryBytes) over.push(`memory needs ${reserved.memoryBytes + reservation.memoryBytes} of ${budget.memoryBytes} bytes`)
  if (budget.diskBytes !== null && reserved.diskBytes + reservation.diskBytes > budget.diskBytes) over.push(`disk needs ${reserved.diskBytes + reservation.diskBytes} of ${budget.diskBytes} bytes`)
  return over.length ? `shared native resource budget is exhausted: ${over.join('; ')}` : null
}

/** Measured-headroom shortfall for one more reservation, or null when it fits. */
export function headroomShortfall(headroom: BehaviorResourceHeadroom, reservation: BehaviorResourceReservation): string | null {
  const over: string[] = []
  if (headroom.freeMemoryBytes < reservation.memoryBytes) over.push(`only ${headroom.freeMemoryBytes} bytes of free memory for a ${reservation.memoryBytes} byte reservation`)
  if (headroom.freeDiskBytes < reservation.diskBytes) over.push(`only ${headroom.freeDiskBytes} bytes free on ${headroom.diskPath} for a ${reservation.diskBytes} byte reservation`)
  return over.length ? `insufficient behavior resource headroom: ${over.join('; ')}` : null
}
