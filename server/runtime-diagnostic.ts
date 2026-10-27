// Bootstrap runs before Poise can collect its own process errors.
import { spawn } from 'node:child_process'
import { constants as fsConstants, accessSync, realpathSync, statfsSync, writeSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { environmentSecrets, normalize, redact, type DiagnosticInput, type LogEvent } from '../gateway/src/diagnostics/contract'
import { lineRedactor } from '../gateway/src/diagnostics/redaction.mjs'
import { diagnosticConfig } from '../gateway/src/diagnostics/config'
import { DiagnosticStore } from '../gateway/src/diagnostics/store'

interface CaptureOptions { path?: string; workspace?: string; timeoutMs?: number; killAfterMs?: number; write?: (event: LogEvent) => void; quiet?: boolean }
function resolved(command: string): string | null {
  for (const path of isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, command))) {
    try { accessSync(path, fsConstants.X_OK); return realpathSync(path) }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) return null }
  }
  return null
}
function forward(fd: number, value: string | Buffer): string | null {
  try { writeSync(fd, typeof value === 'string' ? Buffer.from(value) : value); return null }
  catch (error) { return String((error as NodeJS.ErrnoException).code ?? 'DIAGNOSTIC_OUTPUT_UNAVAILABLE') }
}
function publish(event: LogEvent): void {
  const line = JSON.stringify({ poiseDiagnostic: event }) + '\n'
  try { writeSync(3, line) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; writeSync(2, line) }
}

/** Preserve installer status; neither diagnostic storage nor reporting controls installation. */
export async function captureRuntimeCommand(command: string, args: string[], options: CaptureOptions = {}): Promise<number> {
  const started = Date.now(); const at = new Date(started).toISOString()
  const timeoutMs = options.timeoutMs ?? 15 * 60_000
  const workspace = options.workspace ?? process.env.POISE_WORKSPACE_HANDLE ?? 'local'
  const secrets = environmentSecrets()
  const executable = resolved(command)
  const redactStderr = lineRedactor(secrets); const redactStdout = lineRedactor(secrets)
  let stderr = Buffer.alloc(0); let pending = Buffer.alloc(0); let discarding = false; let truncated = false; let nativeWarning = false
  let stdoutPending = Buffer.alloc(0); let stdoutDiscarding = false; let stdoutForwarded = 0
  let timedOut = false; let interrupted: NodeJS.Signals | null = null
  let spawnError: NodeJS.ErrnoException | null = null; let captureError: string | null = null
  const addLine = (line: Buffer) => {
    const text = stripVTControlCharacters(line.toString())
    nativeWarning ||= /^(?:npm\s+warn\b|warning:|warn(?:ing)?[:\s])/im.test(text)
    const safe = redactStderr(text)
    const bytes = Buffer.concat([stderr, Buffer.from(safe + '\n')])
    if (bytes.length > 16 * 1024) truncated = true
    stderr = bytes.subarray(Math.max(0, bytes.length - 16 * 1024))
  }
  const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const forwardStdout = (line: Buffer) => {
    const safe = Buffer.from(redactStdout(line.toString()) + '\n')
    if (stdoutForwarded + safe.length > 64 * 1024) { captureError = 'Bootstrap stdout forwarding exceeded 64 KiB; content excluded'; return }
    stdoutForwarded += safe.length
    if (!options.quiet) captureError = forward(1, safe) ?? captureError
  }
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid) return
    try { process.kill(-child.pid, value) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') captureError = redact(String(error), secrets) }
  }
  let escalation: Promise<void> | null = null
  const escalate = () => {
    // Closing the direct child's stdio does not establish group termination.
    escalation ??= new Promise<void>((resolve) => setTimeout(() => { signal('SIGKILL'); resolve() }, options.killAfterMs ?? 30_000))
  }
  const timer = setTimeout(() => {
    timedOut = true; signal('SIGTERM')
    escalate()
  }, timeoutMs)
  const interrupt = (value: NodeJS.Signals) => {
    if (timedOut || interrupted) return
    interrupted = value; clearTimeout(timer); signal(value); escalate()
  }
  const onTerm = () => interrupt('SIGTERM'); const onInt = () => interrupt('SIGINT')
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt)
  let result: { code: number | null; signal: NodeJS.Signals | null }
  try {
    result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        let remaining = chunk
        while (remaining.length) {
          const end = remaining.indexOf(10); const part = end < 0 ? remaining : remaining.subarray(0, end)
          if (!stdoutDiscarding && stdoutPending.length + part.length > 64 * 1024) { stdoutDiscarding = true; stdoutPending = Buffer.alloc(0); redactStdout('Authorization:'); captureError = 'Oversized bootstrap stdout line excluded' }
          if (!stdoutDiscarding) stdoutPending = Buffer.concat([stdoutPending, part])
          if (end < 0) return
          remaining = remaining.subarray(end + 1)
          if (!stdoutDiscarding) forwardStdout(stdoutPending)
          stdoutPending = Buffer.alloc(0); stdoutDiscarding = false
        }
      })
      child.stdout?.on('error', (error: Error) => { captureError = redact(error.message, secrets) })
      child.stderr?.on('data', (chunk: Buffer) => {
        let remaining = chunk
        while (remaining.length) {
          const end = remaining.indexOf(10); const part = end < 0 ? remaining : remaining.subarray(0, end)
          if (!discarding && pending.length + part.length > 64 * 1024) { captureError = 'Oversized bootstrap stderr line excluded'; truncated = true; discarding = true; pending = Buffer.alloc(0); addLine(Buffer.from('Authorization: [oversized stderr line excluded]')) }
          if (!discarding) pending = Buffer.concat([pending, part])
          if (end < 0) return
          remaining = remaining.subarray(end + 1)
          if (!discarding) addLine(pending)
          pending = Buffer.alloc(0); discarding = false
        }
      })
      child.stderr?.on('error', (error: Error) => { captureError = redact(error.message, secrets) })
      child.once('error', (error: NodeJS.ErrnoException) => { spawnError = error })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    clearTimeout(timer)
    if (escalation) await escalation
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt)
  }
  if (pending.length && !discarding) addLine(pending)
  if (stdoutPending.length && !stdoutDiscarding) forwardStdout(stdoutPending)
  const failedSpawn = spawnError as NodeJS.ErrnoException | null
  const interruptedBy = interrupted as NodeJS.Signals | null
  const code = timedOut ? 124 : interruptedBy ? 128 + constants.signals[interruptedBy] : failedSpawn ? failedSpawn.code === 'ENOENT' ? 127 : 126 : result.code ?? 128 + (result.signal ? constants.signals[result.signal] ?? 0 : 0)
  if (!options.quiet && stderr.length) captureError = forward(2, stderr) ?? captureError
  if (code !== 0 || nativeWarning || captureError) {
    let resources: Record<string, unknown>
    try {
      const stats = statfsSync(process.cwd())
      resources = { cwdFilesystem: process.cwd(), freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize,
        freeInodes: stats.ffree, totalInodes: stats.files, measuredAt: new Date().toISOString(), affectedFilesystem: null }
    } catch (error) { resources = { measurementUnavailable: redact(String(error), secrets) } }
    const event = normalize({ id: 'bootstrap:' + at + ':' + command, time: at, source: captureError && code === 0 ? 'collection' : 'poise',
      component: 'provider-bootstrap', operation: 'provider.bootstrap', phase: 'installer_command', level: code !== 0 ? 'error' : 'warning',
      workspace, visibility: 'workspace', container: process.env.HOSTNAME ?? null, release: process.env.POISE_RELEASE || null,
      message: failedSpawn?.message ?? (captureError && code === 0 ? 'Bootstrap diagnostic forwarding was incomplete' : timedOut ? 'Provider bootstrap command exceeded its deadline' : interruptedBy ? `Provider bootstrap command interrupted by ${interruptedBy}` : code !== 0 ? `Provider bootstrap command exited ${code}` : 'Provider bootstrap emitted a native warning'),
      stderr: stderr.toString(), truncated, exitCode: failedSpawn ? null : result.code, signal: result.signal, errno: failedSpawn?.errno ?? failedSpawn?.code ?? null, timeoutMs,
      context: { configuredExecutable: command, resolvedExecutable: executable, elapsedMs: Date.now() - started, timedOut, interruptedBy,
        captureError, processErrorCode: failedSpawn?.code ?? null, providerStarted: child.pid !== undefined }, resources }, Date.now(), secrets)!
    persistRuntimeDiagnostic(event, options)
  }
  return code
}

function persistRuntimeDiagnostic(event: LogEvent, options: CaptureOptions): void {
  const workspace = event.workspace
  const secrets = environmentSecrets()
  const path = options.path ?? join(process.env.POISE_DB ? dirname(process.env.POISE_DB) : join(homedir(), '.poise'), 'logging.db')
  let store: DiagnosticStore | null = null
  try { store = new DiagnosticStore(path, diagnosticConfig(process.env).policy); store.append([event]) }
  catch (error) {
    const gap = normalize({ source: 'collection', level: 'warning', workspace, operation: 'bootstrap.persistence_unavailable',
      message: error instanceof Error ? error.message : String(error), context: { eventId: event.id } }, Date.now(), secrets)!
    try { (options.write ?? publish)(gap) } catch { forward(2, 'Poise bootstrap diagnostic reporting is unavailable\n') }
  } finally {
    try { store?.close() }
    catch (error) {
      const gap = normalize({ source: 'collection', level: 'warning', workspace, operation: 'bootstrap.close_failed',
        message: error instanceof Error ? error.message : String(error) }, Date.now(), secrets)!
      try { (options.write ?? publish)(gap) } catch { forward(2, 'Poise bootstrap diagnostic reporting is unavailable\n') }
    }
  }
  try { (options.write ?? publish)(event) } catch { forward(2, 'Poise bootstrap diagnostic reporting is unavailable\n') }
}

/** Supervisor observations share bootstrap persistence without controlling process lifecycle. */
export function recordRuntimeDiagnostic(input: DiagnosticInput, options: CaptureOptions = {}): string | null {
  try {
    const event = normalize({ ...input, source: input.source ?? 'poise',
      time: input.time === undefined ? new Date().toISOString() : input.time,
      workspace: options.workspace ?? process.env.POISE_WORKSPACE_HANDLE ?? 'local', visibility: 'workspace',
      container: input.container === undefined ? process.env.HOSTNAME ?? null : input.container,
      release: input.release === undefined ? process.env.POISE_RELEASE ?? null : input.release }, Date.now(), environmentSecrets())
    if (event) persistRuntimeDiagnostic(event, options)
    return event?.id ?? null
  } catch { forward(2, 'poise-runtime: diagnostic reporting unavailable.\n'); return null }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2)
  if (!command) { forward(2, 'runtime-diagnostic requires an installer command\n'); process.exitCode = 126 }
  else process.exitCode = await captureRuntimeCommand(command, args)
}
