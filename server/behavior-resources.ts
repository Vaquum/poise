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
import { statfsSync } from 'node:fs'
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

/** Synchronous free capacity at one admission boundary. Disposable behavior
 *  roots and provider history live under home while bounded spool uses the
 *  temporary filesystem, so disk headroom is the tighter of the two. Probes
 *  run synchronously at each decision, so a reading is never a stale cache;
 *  any failure reads as unavailable and must block admission explicitly. */
export function measureBehaviorHeadroom(read: { freeMemory?: () => number, diskFree?: (path: string) => number } = {}): BehaviorResourceHeadroom {
  const freeMemory = read.freeMemory ?? freemem
  const diskFree = read.diskFree ?? ((path: string) => {
    const stats = statfsSync(path)
    return stats.bavail * stats.bsize
  })
  let freeMemoryBytes: number
  try {
    freeMemoryBytes = freeMemory()
  } catch (error) {
    throw new Error(`behavior resource measurement unavailable: free memory read failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Number.isSafeInteger(freeMemoryBytes) || freeMemoryBytes < 0) throw new Error('behavior resource measurement unavailable: free memory read is invalid')
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
