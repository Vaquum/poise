// `runningCallerCalls` in /api/service/health: the Caller calls running in
// this workspace that a restart of the container would cut. Detached launches
// (behavior runs, manual reviews and replays, card chats, /content) are
// counted from spawn to exit where this server spawns them; the /consensus
// debate runs inside its request and is counted around it here. A release
// switch restarts only the server, so calls an earlier server started keep
// running unseen by this count: Caller's own records, with each process still
// alive, count those. Chat turns are `activeChatTurns`.

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { BEHAVIOR_CALL_SOURCES, runningCallerLaunches } from '../process'
import { callerDatabase } from '../caller-store'
import { diagnosticFailure } from '../logging'

let debates = 0

export async function countDebate<T>(run: () => Promise<T>): Promise<T> {
  debates += 1
  try {
    return await run()
  } finally {
    debates -= 1
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** How long one service-health read waits on Caller's records: an uncontended
 *  open-select-close costs under 2 ms at 13 rows, so 100 ms keeps generous
 *  headroom while bounding a contended health handler to a tenth of its
 *  former worst case. Unknown stays safe: health reports idle false. */
export const CALLER_CALLS_READ_TIMEOUT_MS = 100

export class CallerReceiptStoreError extends Error {
  readonly code: string | null
  readonly kind: 'integrity' | 'contention' | 'unavailable'
  readonly firstObservedAt = new Date().toISOString()

  constructor(readonly dataDir: string | undefined, cause: unknown) {
    const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : null
    const kind = /^SQLITE_(?:CORRUPT|NOTADB)(?:_|$)/.test(code ?? '') ? 'integrity'
      : /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(code ?? '') ? 'contention' : 'unavailable'
    super(`Caller receipt store ${kind} failure${code ? ` (${code})` : ''}`, { cause })
    this.name = 'CallerReceiptStoreError'
    this.code = code
    this.kind = kind
  }
}

let failure: CallerReceiptStoreError | null = null
let failureRecorded = false

/** Caller calls recorded as running whose process is alive, whichever server
 *  started them; null when the records exist but cannot be read. */
function callerActivity(dataDir: string | undefined, behaviorOnly: boolean, resources: boolean): { live: number, pendingResources: number | null } | null {
  let activity: { live: number, pendingResources: number | null, cause?: unknown } | null = null
  try {
    activity = callerDatabase(dataDir, path => readCallerActivity(path, behaviorOnly, resources))
    if (activity.pendingResources === null) throw activity.cause
    failure = null
    failureRecorded = false
    return activity
  } catch (cause) {
    const next = new CallerReceiptStoreError(dataDir, cause)
    if (!failure || failure.dataDir !== dataDir || failure.kind !== next.kind || failure.code !== next.code) {
      failure = next
      failureRecorded = false
    }
    // The independent diagnostic store retains the first observation even
    // when Caller cannot open its own receipts. Health remains bounded/unknown.
    if (!failureRecorded) failureRecorded = diagnosticFailure(`caller.receipts.${failure.kind}`, failure,
      { dataDir, firstObservedAt: failure.firstObservedAt }, { level: failure.kind === 'contention' ? 'warning' : 'error' }) !== null
    return activity
  }
}

function readCallerActivity(path: string, behaviorOnly: boolean, resources: boolean): { live: number, pendingResources: number | null, cause?: unknown } {
  if (!path || !existsSync(path)) return { live: 0, pendingResources: 0 }
  let db: InstanceType<typeof Database> | undefined
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: CALLER_CALLS_READ_TIMEOUT_MS })
    db.exec('BEGIN')
    // A turn Poise runs itself is recorded with an external runner and no process.
    const rows = db.prepare("select pid from calls where status = 'running' and pid is not null and runner is null"
      + (behaviorOnly ? ` and (source is null or source in (${BEHAVIOR_CALL_SOURCES.map(() => '?').join(',')}))` : ''))
      .all(...(behaviorOnly ? BEHAVIOR_CALL_SOURCES : [])) as Array<{ pid: unknown }>
    const live = rows.filter(({ pid }) => Number.isSafeInteger(Number(pid)) && Number(pid) > 0 && alive(Number(pid))).length
    let pendingResources = 0
    if (resources) {
      try {
        const pending = db.prepare("select count(*) as count from calls where source='poise:behavior-chain' and (resources_settled_at is null or resource_cleanup is not null)").get() as { count: number }
        pendingResources = pending.count
      } catch (cause) { return { live, pendingResources: null, cause } }
    }
    return { live, pendingResources }
  } finally {
    db?.close()
  }
}

/** Rechecked by managed work at its existing final admission boundaries. */
export function requireCallerReceipts(): void {
  callerActivity(process.env.AGENT_INTERFACE_DATA_DIR, false, true)
  if (failure) throw failure
}

export function liveCallerCalls(dataDir = process.env.AGENT_INTERFACE_DATA_DIR, behaviorOnly = false): number | null {
  return callerActivity(dataDir, behaviorOnly, false)?.live ?? null
}

/** The Caller calls a restart would cut. `known` is false while Caller's
 *  records cannot be read; `count` then holds this server's own launches. */
export function runningCallerCalls(behaviorOnly = false): { count: number, pendingResources: number, known: boolean } {
  const activity = callerActivity(process.env.AGENT_INTERFACE_DATA_DIR, behaviorOnly, true)
  return { count: Math.max(runningCallerLaunches(behaviorOnly) + (behaviorOnly ? 0 : debates), activity?.live ?? 0),
    pendingResources: activity?.pendingResources ?? 0, known: activity !== null && activity.pendingResources !== null }
}
