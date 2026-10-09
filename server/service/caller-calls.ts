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
import { join } from 'node:path'
import { runningCallerLaunches } from '../process'

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

/** Caller calls recorded as running whose process is alive, whichever server started them. */
export function liveCallerCalls(dataDir = process.env.AGENT_INTERFACE_DATA_DIR): number {
  const path = dataDir ? join(dataDir, 'calls.sqlite3') : ''
  if (!path || !existsSync(path)) return 0
  let db: InstanceType<typeof Database> | undefined
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1_000 })
    // A turn Poise runs itself is recorded with an external runner and no process.
    const rows = db.prepare("select pid from calls where status = 'running' and pid is not null and runner is null").all() as Array<{ pid: unknown }>
    return rows.filter(({ pid }) => Number.isSafeInteger(Number(pid)) && Number(pid) > 0 && alive(Number(pid))).length
  } catch {
    // Unreadable records count nothing; this server's own launches are still counted.
    return 0
  } finally {
    db?.close()
  }
}

export function runningCallerCalls(): number {
  return Math.max(runningCallerLaunches() + debates, liveCallerCalls())
}
