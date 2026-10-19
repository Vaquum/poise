import { diagnosticIdentity } from './logging-context'
import { diagnosticConfig } from '../gateway/src/diagnostics/config'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentInterfaceRoot } from '../scripts/caller.mjs'
import { environmentSecrets, normalize, type DiagnosticInput } from '../gateway/src/diagnostics/contract'
import { DiagnosticRuntime } from '../gateway/src/diagnostics/runtime'
import { diagnosticDeliveryPage } from '../gateway/src/diagnostics/workspace-delivery'
import { callerDiagnostic } from '../gateway/src/diagnostics/sources'
import { runFile, setProcessFailureObserver } from './process'

let active: DiagnosticRuntime | null = null
let timer: ReturnType<typeof setInterval> | null = null
let pass: Promise<void> | null = null
let abort: AbortController | null = null
let restoreConsole: (() => void) | null = null
let fatalListener: ((error: Error) => void) | null = null
let path = ''
let sequence = 0
let callerStream: string | null = null
let workspace = 'local'
let stderrFailed = false
const stderrFailure = (error: Error & { code?: unknown }) => {
  if (stderrFailed) return
  stderrFailed = true
  active?.observe('forwarding', 'collection', workspace, 'Structured stderr forwarding failed: ' + (typeof error.code === 'string' ? error.code : error.name))
}

export function loggingRuntime(): DiagnosticRuntime | null { return active }
export function loggingWorkspace(): string { return workspace }
export function loggingPath(): string | null { return active ? path : null }

export function diagnostic(input: Omit<DiagnosticInput, 'source' | 'workspace'> & { source?: string }, secrets: readonly string[] = []): string | null {
  if (!active) return null
  let accepted: string | null = null
  try {
    const event = normalize({ ...diagnosticIdentity(), ...input, time: input.time === undefined ? new Date().toISOString() : input.time,
      source: input.source ?? 'poise', workspace, visibility: 'workspace',
      instance: input.instance === undefined ? process.env.POISE_WORKSPACE_HANDLE ?? process.env.POISE_INSTANCE_LABEL ?? 'local' : input.instance,
      container: input.container === undefined ? process.env.POISE_MODE === 'service' ? process.env.HOSTNAME ?? null : null : input.container,
      release: input.release === undefined ? process.env.POISE_RELEASE || process.env.POISE_SOURCE_SHA || null : input.release }, Date.now(), [...environmentSecrets(), ...secrets])
    if (!event) return null
    accepted = active.ingest(event)
    if (!accepted) return null
    // Structured, redacted envelopes are the only workspace stdout admitted by the gateway.
    if (process.stderr.writableLength < 256 * 1024) {
      if (process.stderr.write(JSON.stringify({ poiseDiagnostic: event }) + '\n')) { stderrFailed = false; active.observe('forwarding', 'collection', workspace) }
    }
    else active.observe('forwarding', 'collection', workspace, 'Structured stderr forwarding is backpressured; durable backfill remains available')
    return accepted
  } catch (error) {
    active?.observe('capture', 'collection', workspace, 'Diagnostic capture failed: ' + (error instanceof Error ? error.name : 'capture failure'))
    return accepted
  }
}

export function diagnosticFailure(operation: string, error: unknown, context: Record<string, unknown> = {}, options: { level?: 'error' | 'warning'; secrets?: readonly string[]; stderr?: boolean } = {}): string | null {
  const value = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Operation failed without an Error')
  const fields = error as { stderr?: unknown; code?: unknown; signal?: unknown; errno?: unknown; killed?: unknown } | null
  const cause: string[] = []
  const seen = new Set<Error>([value])
  let underlying: unknown = value.cause
  while (underlying instanceof Error && !seen.has(underlying) && cause.length < 8) { seen.add(underlying); cause.push(underlying.message); underlying = underlying.cause }
  context = { ...diagnosticIdentity(error), ...context }
  const identity = (key: string) => typeof context[key] === 'string' ? context[key] as string : null
  return diagnostic({ level: options.level ?? 'error', operation, cause, truncated: underlying instanceof Error, account: identity('account'), repository: identity('repository'),
    callId: identity('callId'), correlationId: identity('correlationId'), requestId: identity('requestId'), behavior: identity('behavior'), target: identity('target'), phase: identity('phase'),
    timeoutMs: typeof context.timeoutMs === 'number' ? context.timeoutMs : null, message: value.message, stack: value.stack,
    stderr: options.stderr === false ? null : typeof fields?.stderr === 'string' ? fields.stderr : null,
    exitCode: typeof fields?.code === 'number' ? fields.code : null,
    signal: typeof fields?.signal === 'string' ? fields.signal : null,
    errno: typeof fields?.errno === 'string' || typeof fields?.errno === 'number' ? fields.errno : null,
    context: { ...context, code: typeof fields?.code === 'string' ? fields.code : null, killed: fields?.killed === true } }, options.secrets)
}

function saveCallerCheckpoint(): void {
  writeFileSync(path + '.caller.tmp', JSON.stringify({ version: 1, streamId: callerStream, cursor: sequence }), { mode: 0o600 })
  renameSync(path + '.caller.tmp', path + '.caller')
}

async function collectCaller(): Promise<void> {
  if (!active) return
  const runtime = active
  try {
    abort = new AbortController()
    const result = await runFile('agent-interface', ['--diagnostics', String(sequence), '3'], {
      cwd: agentInterfaceRoot(), timeoutMs: 10_000, maxOutputBytes: 512 * 1024, signal: abort.signal,
    })
    const page = JSON.parse(result.stdout) as { version: number; streamId: string; events: unknown[]; cursor: number; hasMore: boolean; backfillPending: boolean }
    if (page.version !== 1 || !Array.isArray(page.events) || page.events.length > 3 || !Number.isSafeInteger(page.cursor) || page.cursor < 0
      || typeof page.streamId !== 'string' || !/^[a-f0-9]{32}$/.test(page.streamId)
      || typeof page.hasMore !== 'boolean' || typeof page.backfillPending !== 'boolean') throw new Error('Caller diagnostic stream is incompatible')
    if (callerStream && callerStream !== page.streamId) {
      runtime.observe('caller', 'caller', workspace, 'Caller diagnostic database changed; bounded replay restarted with a historical collection gap')
      sequence = 0; callerStream = page.streamId; saveCallerCheckpoint()
      return
    }
    if (page.cursor < sequence) throw new Error('Caller diagnostic sequence moved backwards within one stream')
    callerStream = page.streamId
    const observePage = () => {
      if (page.hasMore || page.backfillPending) runtime.partial('caller', 'caller', workspace, 'Caller historical backfill is still pending')
      else runtime.observe('caller', 'caller', workspace)
    }
    observePage()
    for (const row of page.events) {
      const input = callerDiagnostic(row, workspace)
      if (input) {
        while (runtime.health().queued) if (!runtime.flush()) break
        if (!diagnostic(input)) throw new Error('Caller diagnostic delivery is buffered or unavailable')
        while (runtime.health().queued) if (!runtime.flush()) break
      }
    }
    while (runtime.health().queued) if (!runtime.flush()) break
    // Do not acknowledge a Caller completion until its durable local transaction succeeds.
    if (runtime.health().error || runtime.health().queued) throw new Error('Caller diagnostic checkpoint waits for durable ingestion')
    sequence = page.cursor
    saveCallerCheckpoint()
    observePage()
  } catch (error) {
    if (!abort?.signal.aborted) runtime.observe('caller', 'caller', workspace, error instanceof Error ? error.message : String(error))
  } finally { abort = null }
}

export function fatalDiagnostic(error: Error): void {
  diagnostic({ level: 'critical', operation: 'process.uncaught', message: error.message, stack: error.stack })
  active?.stop()
}

export function startLogging(options: { captureFatal?: boolean } = {}): void {
  if (active) return
  workspace = process.env.POISE_WORKSPACE_HANDLE ?? 'local'
  path = join(process.env.POISE_DB ? dirname(process.env.POISE_DB) : join(homedir(), '.poise'), 'logging.db')
  active = new DiagnosticRuntime({ path, workspace, ...diagnosticConfig(process.env) })
  stderrFailed = false
  process.stderr.on('error', stderrFailure)
  sequence = 0; callerStream = null
  try {
    if (existsSync(path + '.caller')) {
      const raw = readFileSync(path + '.caller', 'utf8').trim()
      if (/^\d{1,15}$/.test(raw)) throw new Error('Legacy Caller checkpoint has no stream identity; bounded source replay will restart')
      const checkpoint = JSON.parse(raw) as { version: number; streamId: string; cursor: number }
      if (checkpoint.version !== 1 || typeof checkpoint.streamId !== 'string' || !/^[a-f0-9]{32}$/.test(checkpoint.streamId)
        || !Number.isSafeInteger(checkpoint.cursor) || checkpoint.cursor < 0) throw new Error('Caller checkpoint is invalid; bounded source replay will restart')
      sequence = checkpoint.cursor; callerStream = checkpoint.streamId
    }
  } catch (error) { active.observe('caller', 'caller', workspace, error instanceof Error ? error.message : String(error)) }
  active.start()
  setProcessFailureObserver((error, evidence) => diagnosticFailure(evidence.operation, error, { executable: evidence.executable, configuredCommand: evidence.command, cwd: evidence.cwd, elapsedMs: evidence.elapsedMs, timeoutMs: evidence.timeoutMs }, { secrets: evidence.secrets, stderr: evidence.stderrAllowed }))
  active.observe('application', 'poise', workspace)
  if (process.env.POISE_MODE !== 'service') for (const source of ['docker', 'kernel', 'ingress']) {
    active.unconfigured(source, source, workspace, 'This local application has no configured ' + source + ' collector')
  }
  if (options.captureFatal) {
    fatalListener = (error) => {
      fatalDiagnostic(error)
      process.exit(1)
    }
    process.once('uncaughtException', fatalListener)
  }
  // Console is an owned technical source. Arbitrary payload objects/stdout are excluded.
  const error = console.error; const warn = console.warn
  const capture = (level: 'error' | 'warning', args: unknown[]) => {
    const header = typeof args[0] === 'string' && /^\[[a-z][\w-]*\]/i.test(args[0]) ? args[0] : null
    if (!header) { (level === 'error' ? error : warn)(...args); return }
    const failure = args.find((arg) => arg instanceof Error)
    if (failure) diagnosticFailure('application.' + (header?.match(/^\[([^\]]+)\]/)?.[1] ?? 'error'), failure, { componentMessage: header }, { level })
    else diagnostic({ level, operation: 'application.message', message: [header, ...args.slice(1).filter((arg) => typeof arg === 'string' || typeof arg === 'number')].join(' ') })
  }
  console.error = (...args: unknown[]) => capture('error', args)
  console.warn = (...args: unknown[]) => capture('warning', args)
  restoreConsole = () => { console.error = error; console.warn = warn }
  const run = () => { if (!pass) pass = collectCaller().finally(() => { pass = null }) }
  timer = setInterval(run, 15_000); timer.unref(); run()
}

export async function stopLogging(): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null; abort?.abort(); await pass
  setProcessFailureObserver(null)
  if (fatalListener) process.off('uncaughtException', fatalListener)
  fatalListener = null
  restoreConsole?.(); restoreConsole = null
  active?.stop()
  await new Promise<void>((resolve) => setImmediate(resolve))
  process.stderr.off('error', stderrFailure)
  active = null
}

/** Authenticated maintenance export; the HTTP owner supplies authorization. */
export function diagnosticPage(cursor: string | null) {
  if (!active) throw new Error('Diagnostic collection has not started')
  return diagnosticDeliveryPage(active, workspace, cursor)
}
