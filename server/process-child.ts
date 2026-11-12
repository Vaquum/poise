import { spawn, type ChildProcess } from 'node:child_process'

// One runFile child: started, read and stopped exactly as runFile always has.
// server/process.ts runs it in the process worker (process-worker.ts), so the
// request and the outcome hold only values a worker message can carry.

export interface ChildRequest {
  file: string
  args: string[]
  cwd?: string
  env: NodeJS.ProcessEnv
  maxBuffer: number
  timeoutMs: number
  killSignal: NodeJS.Signals
  /** Windows only: taskkill's scrubbed environment. */
  killEnv?: NodeJS.ProcessEnv
}

/** Why the child was stopped rather than left to exit; the first reason wins. */
export type ChildTermination<E = Error> =
  | { kind: 'timeout' }
  | { kind: 'maxBuffer', stream: 'stdout' | 'stderr' }
  | { kind: 'abort' }
  | { kind: 'error', error: E }
  /** The process worker stopped while the child ran. */
  | { kind: 'interrupted' }

export interface ChildOutcome<E = Error> {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  termination?: ChildTermination<E>
}

export interface RunningChild {
  outcome: Promise<ChildOutcome>
  abort: () => void
}

export interface SerializedError {
  name: string
  message: string
  stack?: string
  props: Record<string, unknown>
}

export type ProcessWorkerRequest =
  | { type: 'run', id: number, request: ChildRequest }
  | { type: 'abort', id: number }

export type ProcessWorkerReply =
  | { type: 'ready' }
  | { type: 'spawned', id: number, pid: number }
  | { type: 'done', id: number, outcome: ChildOutcome<SerializedError> }

// The fields Node's process errors carry; anything else may not cross a worker message.
const ERROR_PROPS = ['code', 'errno', 'syscall', 'path', 'spawnargs', 'killed', 'signal'] as const

export function serializeError(error: Error): SerializedError {
  const props: Record<string, unknown> = {}
  for (const key of ERROR_PROPS) {
    if (key in error) props[key] = (error as unknown as Record<string, unknown>)[key]
  }
  return { name: error.name, message: error.message, stack: error.stack, props }
}

export function restoreError(serialized: SerializedError): Error {
  const error = Object.assign(new Error(serialized.message), serialized.props)
  if (serialized.name !== 'Error') error.name = serialized.name
  if (serialized.stack !== undefined) error.stack = serialized.stack
  return error
}

export async function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals, killEnv?: NodeJS.ProcessEnv): Promise<void> {
  const pid = child.pid
  if (!pid) return

  if (process.platform !== 'win32') {
    // runFile children are process-group leaders. Negative pid targets the
    // complete group, including grandchildren that inherited it.
    try { process.kill(-pid, signal) }
    catch {
      // The group may have exited between the deadline and this call. A direct
      // kill is a safe fallback if group creation or lookup failed.
      try { child.kill(signal) } catch { /* already gone */ }
    }
    return
  }

  // Windows has no process-group signal equivalent. taskkill /T walks the
  // descendant tree; /F is the only dependable hard-deadline behavior.
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(fallback)
      resolve()
    }
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      env: killEnv,
      stdio: 'ignore',
      windowsHide: true,
    })
    const fallback = setTimeout(finish, 2_000)
    killer.once('error', finish)
    killer.once('close', finish)
  })
  try { child.kill(signal) } catch { /* taskkill already reaped it */ }
}

// spawn keeps argv separate from the shell. POSIX children lead an isolated
// process group so timeout, abort, and output-limit termination includes their
// complete descendant tree.
export function startChild(request: ChildRequest, spawned?: (pid: number) => void): RunningChild {
  let abort = () => {}
  const outcome = new Promise<ChildOutcome>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(request.file, request.args, {
        cwd: request.cwd,
        env: request.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      // A child spawn cannot start rejects through the outcome, as runFile's
      // always has, instead of leaving the outcome unsettled.
      resolve({ code: null, signal: null, stdout: '', stderr: '', termination: { kind: 'error', error: error as Error } })
      return
    }
    if (child.pid) spawned?.(child.pid)
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let termination: ChildTermination | undefined
    let terminating: Promise<void> | undefined
    let finishing = false

    const requestTermination = (reason: ChildTermination) => {
      if (termination || finishing) return
      termination = reason
      terminating = terminateProcessTree(child, request.killSignal, request.killEnv)
    }

    const collect = (stream: 'stdout' | 'stderr', value: Buffer | string) => {
      if (termination || finishing) return
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const chunks = stream === 'stdout' ? stdoutChunks : stderrChunks
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes
      const remaining = request.maxBuffer - used
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
        if (stream === 'stdout') stdoutBytes = request.maxBuffer
        else stderrBytes = request.maxBuffer
        requestTermination({ kind: 'maxBuffer', stream })
        return
      }
      chunks.push(chunk)
      if (stream === 'stdout') stdoutBytes += chunk.byteLength
      else stderrBytes += chunk.byteLength
    }

    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (finishing) return
      finishing = true
      clearTimeout(timeoutHandle)
      await terminating
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
        ...(termination ? { termination } : {}),
      })
    }

    abort = () => requestTermination({ kind: 'abort' })
    child.stdout?.on('data', (chunk) => collect('stdout', chunk))
    child.stderr?.on('data', (chunk) => collect('stderr', chunk))
    child.stdout?.on('error', (error) => requestTermination({ kind: 'error', error }))
    child.stderr?.on('error', (error) => requestTermination({ kind: 'error', error }))
    child.once('error', (error) => {
      if (child.pid) {
        requestTermination({ kind: 'error', error })
        return
      }
      termination = { kind: 'error', error }
      void finish(null, null)
    })
    child.once('close', (code, signal) => { void finish(code, signal) })

    const timeoutHandle = setTimeout(() => requestTermination({ kind: 'timeout' }), request.timeoutMs)
  })
  return { outcome, abort: () => abort() }
}
