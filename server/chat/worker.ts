// Registered workers: how the chat runtime spawns anything that can write to
// a checkout — native agents and mutating git helpers alike.
//
// Every such process runs under scripts/chat-worker-gate.mjs, a detached
// process-group leader that waits for `GO` on a control descriptor. The
// lifecycle is: spawn gate → record (pid, pgid, ident) in the checkout lease
// and in Poise's own `chat_workers` table → GO → the gate spawns the command
// in its group. A crash before GO leaves nothing running; a crash after it
// leaves a registered group the lease keeps blocking until it is dead, and
// the gate itself tears the group down when its control descriptor closes.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { CLAUDE_SUBSCRIPTION_CLI, runFile, scrubbedChildEnvironment } from '../process'

// Next to the subscription wrapper: that path is right both from the source
// tree (server/process.ts) and from the production bundle (dist/server.js),
// which this file's own location is not.
export const WORKER_GATE = join(dirname(CLAUDE_SUBSCRIPTION_CLI), 'chat-worker-gate.mjs')

const KILL_GRACE_MS = 5_000
const KILL_WAIT_MS = 5_000

export interface WorkerHandle {
  child: ChildProcess
  pid: number
  pgid: number
  ident: string
  command: string
  /** Let the gate start the command. Idempotent. */
  go(): void
  /** SIGTERM the group, SIGKILL after the grace period; resolves only once
   *  no process of the group is left, and rejects when something survives —
   *  a caller must never treat a rejected terminate as a freed checkout. */
  terminate(graceMs?: number): Promise<void>
  /** Resolves with the gate's exit when it ends on its own. The gate exits
   *  only after settling its descendants, so this also means the group is
   *  empty unless the gate itself was killed. */
  exited: Promise<{ code: number | null, signal: NodeJS.Signals | null }>
  /** True while anything in the worker's process group is alive. */
  readonly alive: boolean
}

export interface SpawnWorkerOptions {
  cwd: string
  /** Overlaid on the scrubbed environment computed for `command`. */
  env?: NodeJS.ProcessEnv
  /** Which allowlist to scrub with; defaults to `command`. */
  envCommand?: string
  ident?: string
}

/** Spawn the gate for `command`; nothing runs until `go()`. */
export function spawnWorker(command: string, args: readonly string[], options: SpawnWorkerOptions): WorkerHandle {
  const ident = options.ident ?? randomUUID()
  const env = scrubbedChildEnvironment(options.envCommand ?? command, options.env, args)
  const child = spawn(process.execPath, [WORKER_GATE, '--lease-worker', ident, '--', command, ...args], {
    cwd: options.cwd,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const control = child.stdio[3] as import('node:stream').Writable | null
  if (!child.pid || !control) {
    try { child.kill('SIGKILL') } catch { /* never started */ }
    throw new Error('could not spawn the worker gate')
  }
  const pid = child.pid
  let goSent = false
  let exitInfo: { code: number | null, signal: NodeJS.Signals | null } | null = null
  const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve({ code, signal }) })
    child.once('error', () => { if (!exitInfo) { exitInfo = { code: null, signal: null }; resolve(exitInfo) } })
  })
  control.on('error', () => { /* the gate is gone; exit handling covers it */ })
  const handle: WorkerHandle = {
    child,
    pid,
    pgid: pid,
    ident,
    command,
    go() {
      if (goSent) return
      goSent = true
      try { control.write('GO\n') } catch { /* gate died before GO; exit handling covers it */ }
    },
    async terminate(graceMs = KILL_GRACE_MS) {
      // The group was created by this handle in this process, so signalling
      // it is signalling our own worker — never a pid recovered from a table.
      if (!pgidAlive(pid)) return
      signalGroup(pid, 'SIGTERM')
      if (await waitUntilDead(pid, graceMs)) return
      signalGroup(pid, 'SIGKILL')
      if (await waitUntilDead(pid, KILL_WAIT_MS)) return
      throw new Error(`worker group ${pid} (${command}) is still alive after SIGKILL`)
    },
    exited,
    get alive() { return exitInfo === null || pgidAlive(pid) },
  }
  return handle
}

async function waitUntilDead(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (pgidAlive(pgid)) {
    if (Date.now() >= deadline) return false
    await delay(25)
  }
  return true
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal) } catch { /* group already gone */ }
}

/** `kill(pid, 0)`: only ESRCH proves death. Success, EPERM and any
 *  unexpected error all read as alive — liveness fails closed. */
export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error: any) {
    return error?.code !== 'ESRCH'
  }
}

/** A live process group counts as a live worker even when its leader died. */
export function pgidAlive(pgid: number | null | undefined): boolean {
  if (!pgid || !Number.isSafeInteger(pgid) || pgid <= 1) return false
  try { process.kill(-pgid, 0); return true } catch (error: any) {
    return error?.code !== 'ESRCH'
  }
}

/** Whether `pid` still runs `scriptFile` from any Poise scripts directory
 *  (any installed release, the image, or a checkout) carrying `--<flag>
 *  <ident>` as its own argument. The install directory is deliberately not
 *  part of the identity: after a release switch the surviving relay and
 *  gate still run from the previous release's directory, and the new
 *  server must verify them to adopt them. The random ident — minted at
 *  spawn, stored server-side, matched exactly with whitespace on both
 *  sides — is what defeats pid reuse; the `/scripts/` parent keeps a
 *  same-named script elsewhere from verifying. Anything else (pid reuse,
 *  unreadable table) is "no". */
export async function scriptIdentityMatches(pid: number, ident: string, scriptFile: string, flag: string): Promise<boolean> {
  if (!pidAlive(pid) || !/^[A-Za-z0-9-]{8,64}$/.test(ident)) return false
  try {
    const { stdout } = await runFile('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 })
    const line = stdout.trim()
    const flagIndex = line.indexOf(` --${flag} ${ident} `)
    if (flagIndex < 0) return false
    const head = line.slice(0, flagIndex)
    return head.includes(`/scripts/${scriptFile} `) || head.endsWith(`/scripts/${scriptFile}`)
  } catch {
    return false
  }
}

export interface GroupMember {
  pid: number
  ppid: number
  command: string
}

/** Every live process in `pgid`'s group: pid, parent pid and full command
 *  line. `ps -eo` with `=`-suppressed headers is the same on macOS and
 *  Linux (the worker gate lists groups the same way), as is the `stat`
 *  column. Zombies are skipped: an exited child lingers in the table until
 *  its parent reaps it, but it is finished — listing it would withhold its
 *  completion wake. Null when the table cannot be read — callers skip
 *  group decisions, never invent them. */
export async function groupMembers(pgid: number): Promise<GroupMember[] | null> {
  if (!pgid || !Number.isSafeInteger(pgid) || pgid <= 1) return null
  let stdout: string
  try {
    ({ stdout } = await runFile('ps', ['-eo', 'pid=,pgid=,ppid=,stat=,command='], { timeoutMs: 5_000, maxOutputBytes: 4 * 1024 * 1024 }))
  } catch {
    return null
  }
  const members: GroupMember[] = []
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5) continue
    const [pid, listed, ppid] = fields.slice(0, 3).map(Number)
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(listed) || !Number.isSafeInteger(ppid)) continue
    if (listed !== pgid || fields[3].startsWith('Z')) continue
    members.push({ pid, ppid, command: fields.slice(4).join(' ') })
  }
  return members
}

export type WorkerGateStatus = 'verified' | 'gone' | 'unknown'

/** Whether the recorded gate still owns `pid`: `verified` when its command
 *  line is the gate script carrying `--lease-worker <ident>` as its own
 *  argument (the same identity scriptIdentityMatches checks, so a gate
 *  surviving a release switch still verifies), `gone` when the pid is dead
 *  or another process (pid reuse), `unknown` when the process table itself
 *  cannot be read. Callers that act on death must retry on `unknown`,
 *  never treat it as `gone`. */
export async function workerGateStatus(pid: number, ident: string): Promise<WorkerGateStatus> {
  if (!pidAlive(pid) || !/^[A-Za-z0-9-]{8,64}$/.test(ident)) return 'gone'
  let stdout: string
  try {
    ({ stdout } = await runFile('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }))
  } catch {
    return 'unknown'
  }
  const line = stdout.trim()
  const flagIndex = line.indexOf(` --lease-worker ${ident} `)
  if (flagIndex < 0) return 'gone'
  const head = line.slice(0, flagIndex)
  return head.includes('/scripts/chat-worker-gate.mjs ') || head.endsWith('/scripts/chat-worker-gate.mjs') ? 'verified' : 'gone'
}

/** Whether `pid` is still the gate we recorded: its command line must be
 *  the gate script carrying `--lease-worker <ident>` as its own argument.
 *  Anything else (pid reuse, unreadable table) is "no". */
export async function workerIdentityMatches(pid: number, ident: string): Promise<boolean> {
  return scriptIdentityMatches(pid, ident, 'chat-worker-gate.mjs', 'lease-worker')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
