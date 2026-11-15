import { environmentSecrets } from '../gateway/src/diagnostics/redaction.mjs'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { CALLER_COMMANDS, callerBinRoot } from '../scripts/caller.mjs'
import {
  CALL_PID, abortWorkerCall, claimSignal, createCallSlot, killGroup, restoreError, startChild,
  type ChildOutcome, type ChildRequest, type ChildTermination, type ProcessWorkerReply, type ProcessWorkerRequest, type RunningChild, type SerializedError,
} from './process-child'

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
export const MAX_PROCESS_ARG_BYTES = 64 * 1024
export const CLAUDE_SUBSCRIPTION_CLI = fileURLToPath(new URL(
  '../scripts/claude-subscription.mjs',
  import.meta.url,
))
// Resolved like the subscription wrapper so it names the shipped file both
// from the source tree (server/process.ts) and the production bundle
// (dist/server.js): the runtime image copies scripts/ beside dist/.
export const AGENT_RIPGREP_CONFIG = fileURLToPath(new URL(
  '../scripts/agent-tools.ripgreprc',
  import.meta.url,
))
// Bounds Go runtimes only; every other child ignores it.
export const AGENT_GOMAXPROCS = '2'

export function assertProcessArgSize(value: string, label = 'argument'): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_PROCESS_ARG_BYTES) {
    throw new Error(`${label} too large (max ${MAX_PROCESS_ARG_BYTES} UTF-8 bytes)`)
  }
}

function assertProcessArgs(args: readonly string[]): void {
  args.forEach((value, index) => assertProcessArgSize(value, `argument ${index + 1}`))
}

export interface ExpectedFailure {
  /** Exit codes that are an expected probe outcome for this call, not an
   *  error. Timeouts, aborts, spawn failures and output-limit kills never
   *  match: they reject before any exit code exists. */
  codes: readonly number[]
  /** When present, only stderr matching one of these is expected; the same
   *  code with any other stderr still reports. */
  stderr?: RegExp | readonly RegExp[]
  /** Validate structured probe output before suppressing its process fault. */
  stdout?: (stdout: string) => boolean
}

export interface RunFileOptions {
  cwd?: string
  /** Variables overlaid on the scrubbed parent environment. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
  killSignal?: NodeJS.Signals
  signal?: AbortSignal
  /** The caller owns failure diagnostics (including shared-read episodes).
   *  Failures still reject with their complete evidence. */
  reportFailure?: boolean
  /** Declare this call a probe: a matching exit rejects with `expected: true`
   *  and is not reported to the process-failure observer. */
  expected?: ExpectedFailure
  /** Identity for a response read; argv and response bodies stay excluded. */
  callId?: string
  readerPurpose?: string
}

/** True when the runFile rejection was a declared expected probe outcome. */
export function isExpectedFailure(error: unknown): boolean {
  return (error as { expected?: unknown })?.expected === true
}

function stderrMatches(matcher: ExpectedFailure['stderr'], stderr: string): boolean {
  if (!matcher) return true
  const patterns = Array.isArray(matcher) ? matcher : [matcher]
  return patterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(stderr)
  })
}

export interface RunFileResult {
  stdout: string
  stderr: string
}

// Start from a small, exact base rather than trying to recognize every secret
// spelling. Paths/locales needed to launch a CLI survive; application,
// credential, URL/URI, JWT, AUTH, loader-injection, and proxy variables do not.
const SAFE_BASE_ENV = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Known non-secret integration paths used by agent-interface.
  'AGENT_INTERFACE_ROOT',
  'AGENT_INTERFACE_DATA_DIR',
  // Non-secret tool configuration a user may set: an inherited value always
  // wins over the agent tool defaults applied below.
  'GOMAXPROCS',
  'RIPGREP_CONFIG_PATH',
])

const NETWORK_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]

// A Claude subscription is resolved from Claude Code's own credential store
// (the macOS Keychain on macOS). Explicit provider credentials can override
// that account and route work through metered API billing, so subscription-
// backed calls remove every such override at the process boundary and force
// the monitored wrapper, which also neutralizes provider settings loaded by
// Claude Code itself.
export function claudeSubscriptionEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    throw new Error('Claude subscription isolation requires macOS, Linux, or WSL')
  }
  return {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CLI: CLAUDE_SUBSCRIPTION_CLI,
  }
}

const GITHUB_ENV = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  ...NETWORK_ENV,
]

const MODEL_ENV = [
  'POISE_NATIVE_CONTROL',
  'POISE_NATIVE_NODE',
  'POISE_NATIVE_PREPARE',
  // Non-secret agent-interface controls. These preserve configured wrapper
  // binaries, debate recursion, and Claude's command guard rather than
  // silently falling back to raw provider executables.
  'AGENT_INTERFACE_CLI',
  'AGENT_INTERFACE_BASH_ALLOW',
  // The voice guide /content writes in (a file path).
  'AGENT_INTERFACE_VOICE_GUIDE',
  'CLAUDE_CLI',
  'CLAUDE_CODE_SHELL_PREFIX',
  'CODEX_CLI',
  'CURSOR_AGENT_CLI',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'CURSOR_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'XAI_BASE_URL',
  // Model backends can use cloud workload credentials and config.
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_CONFIG_DIR',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  ...NETWORK_ENV,
]

// Direct Claude Code invocations need their configured credential location,
// command guard, and network route, but never inherit provider credentials.
// Callers additionally pass claudeSubscriptionEnvironment() to make that
// subscription-only intent explicit and resilient to future allowlist edits.
const CLAUDE_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_SHELL_PREFIX',
  ...NETWORK_ENV,
]

// Direct Codex invocations need their configured home and network route, but
// never inherit API-key overrides. Issue-review invocations inherit the same
// proxy route through agent-interface; the native sign-in verification must
// match it instead of stripping proxy variables and failing behind a proxy.
const CODEX_ENV = [
  'CODEX_HOME',
  ...NETWORK_ENV,
]

// Browser launchers on Linux and WSL rely on these non-secret desktop/session
// coordinates. Keep them out of ordinary status/model workers and inherit them
// only for Poise's exact Claude.ai login command.
const CLAUDE_LOGIN_ENV = new Set([
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'DESKTOP_SESSION',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
])

// The GitHub accounts Caller acts as: the person's own account and the agent
// account (Settings → GitHub). A running Poise sets them from its settings at
// every spawn (setCallerAccounts); without that — a script, an isolated test —
// inherited values pass like any other allowlisted variable.
export const CALLER_ACCOUNT_ENV = ['GITHUB_INTERFACE_USER', 'GITHUB_INTERFACE_AGENT_USER'] as const
export type CallerAccounts = Partial<Record<typeof CALLER_ACCOUNT_ENV[number], string>>
const CALLER_ACCOUNT_COMMANDS: ReadonlySet<string> = new Set(['github-interface', 'agent-interface'])
let callerAccounts: (() => CallerAccounts) | null = null

/** Read at every spawn, so each Caller process gets the accounts saved at that
 *  moment. An account that is not set is removed, never inherited. */
export function setCallerAccounts(source: (() => CallerAccounts) | null): void {
  callerAccounts = source
}

// Credentials are inherited only by the binaries that intentionally consume
// them. A caller can still pass a one-off value explicitly through options.env.
const COMMAND_ENV = new Map<string, ReadonlySet<string>>([
  ['gh', new Set(GITHUB_ENV)],
  ['github-interface', new Set([...GITHUB_ENV, ...CALLER_ACCOUNT_ENV])],
  ['agent-interface', new Set([...GITHUB_ENV, ...MODEL_ENV, ...CALLER_ACCOUNT_ENV])],
  ['claude', new Set(CLAUDE_ENV)],
  ['claude-subscription', new Set(CLAUDE_ENV)],
  ['claude-subscription.mjs', new Set(CLAUDE_ENV)],
  ['codex', new Set(CODEX_ENV)],
  ['codex.js', new Set(CODEX_ENV)],
])

function commandName(command: string): string {
  return basename(command).replace(/\.(?:exe|cmd|bat|com)$/i, '').toLowerCase()
}

// Caller's CLIs run from the in-tree Caller (or the installation
// CALLER_BIN_ROOT names), never from whatever copy PATH happens to find: a
// bare name resolves to that directory, so a Caller that is not set up fails
// naming it. Caller's own processes get the directory first on PATH, so the
// CLIs Caller starts by name resolve there too.
function resolveCommand(command: string): string {
  return CALLER_COMMANDS.includes(command) ? join(callerBinRoot(), command) : command
}

function withCallerOnPath(env: NodeJS.ProcessEnv): void {
  const bin = callerBinRoot()
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const rest = (env[key] || '').split(delimiter).filter((entry) => entry && entry !== bin)
  env[key] = [bin, ...rest].join(delimiter)
}

function isClaudeSubscriptionLogin(command: string, args: readonly string[]): boolean {
  const name = commandName(command)
  return (name === 'claude-subscription' || name === 'claude-subscription.mjs')
    && args.length === 3
    && args[0] === 'auth'
    && args[1] === 'login'
    && args[2] === '--claudeai'
}

// The chat runtime launches long-lived agents through a worker gate rather
// than runFile, but their environment must be scrubbed by exactly the same
// allowlists as every other child: the gate inherits this and passes it on.
export function scrubbedChildEnvironment(
  command: string,
  overrides: NodeJS.ProcessEnv = {},
  args: readonly string[] = [],
): NodeJS.ProcessEnv {
  return childEnvironment(command, overrides, args)
}

function withoutInherited(env: NodeJS.ProcessEnv, key: string): void {
  for (const inheritedKey of Object.keys(env)) {
    if (inheritedKey.toUpperCase() === key.toUpperCase()) delete env[inheritedKey]
  }
}

function childEnvironment(
  command: string,
  overrides: NodeJS.ProcessEnv = {},
  args: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const commandEnv = COMMAND_ENV.get(commandName(command))
  const loginEnvironment = isClaudeSubscriptionLogin(command, args)
    ? CLAUDE_LOGIN_ENV
    : undefined
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase()
    if (
      SAFE_BASE_ENV.has(normalized)
      || commandEnv?.has(normalized)
      || loginEnvironment?.has(normalized)
    ) {
      env[key] = value
    }
  }
  if (CALLER_COMMANDS.includes(commandName(command))) withCallerOnPath(env)
  if (callerAccounts && CALLER_ACCOUNT_COMMANDS.has(commandName(command))) {
    const accounts = callerAccounts()
    for (const key of CALLER_ACCOUNT_ENV) {
      withoutInherited(env, key)
      const value = accounts[key]
      if (value) env[key] = value
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    // Avoid case-variant duplicates on Windows and make an explicit undefined
    // reliably remove an inherited variable on every platform.
    withoutInherited(env, key)
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  applyAgentToolDefaults(env, overrides)
  applyTestOffload(env)
  return env
}

// Agent tool-performance defaults: external ripgrep searches run two threads
// and Go tools observe GOMAXPROCS=2. Both only affect the tools that read
// them, and an inherited or explicitly passed value always wins; an explicit
// undefined removes the variable instead of restoring the default.
function applyAgentToolDefaults(env: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv): void {
  const removed = new Set(
    Object.keys(overrides)
      .filter((key) => overrides[key] === undefined)
      .map((key) => key.toUpperCase()),
  )
  for (const [key, value] of [['GOMAXPROCS', AGENT_GOMAXPROCS], ['RIPGREP_CONFIG_PATH', AGENT_RIPGREP_CONFIG]] as const) {
    if (removed.has(key)) continue
    if (!Object.keys(env).some((present) => present.toUpperCase() === key)) env[key] = value
  }
}

// Agents' test suites leave the workspace for disposable test boxes (docs/Operating.md, "Agents'
// test suites"): every Python and Node process under what Poise starts asks these hooks first, and only
// a test runner does anything but carry on. Off until the gateway installs them into the home volume.
function applyTestOffload(env: NodeJS.ProcessEnv): void {
  const hooks = join(homedir(), '.poise', 'test-offload')
  // One read: the release installer may remove relay to disable offload at any moment.
  let installed: string
  try {
    installed = readFileSync(join(hooks, 'relay'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // Older installed relays have only URL/key. Keep their nine-minute command budget.
  const limit = installed.trimEnd().split('\n')[2] ?? '540'
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 3540) {
    throw new Error('POISE_TEST_LIMIT_SECONDS must be a whole number from 1 to 3540')
  }
  env.PYTHONPATH = [hooks, env.PYTHONPATH].filter(Boolean).join(delimiter)
  env.NODE_OPTIONS = [`--require "${join(hooks, 'hook.cjs')}"`, env.NODE_OPTIONS].filter(Boolean).join(' ')
  // The relay gets time to report exhaustion and request cleanup before the shell stops it.
  env.BASH_DEFAULT_TIMEOUT_MS ??= String((Number(limit) + 60) * 1000)
  env.BASH_MAX_TIMEOUT_MS ??= '3600000'
}

function abortError(signal: AbortSignal, killSignal: NodeJS.Signals): Error {
  const error = new Error('The operation was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  return Object.assign(error, {
    code: 'ABORT_ERR',
    killed: true,
    signal: killSignal,
  })
}

/** Whether `error` is an aborted operation: a runFile abort, a
 *  `throwIfAborted`, or a guarded worker stopped by its signal. */
export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && ((error as { name?: unknown }).name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR')
}

export interface ProcessFailureEvidence {
  command: string
  executable: string
  operation: string
  cwd: string | null
  elapsedMs: number
  timeoutMs: number
  stderrAllowed: boolean
  secrets: string[]
  callId?: string
  readerPurpose?: string
}
const processFailures = new WeakMap<Error, ProcessFailureEvidence>()
/** Original child evidence, including when its handler owns reporting. */
export function processFailureEvidence(error: unknown): ProcessFailureEvidence | undefined {
  return error instanceof Error ? processFailures.get(error) : undefined
}
let processFailureObserver: ((error: Error, evidence: ProcessFailureEvidence) => void) | null = null
export function setProcessFailureObserver(observer: typeof processFailureObserver): void { processFailureObserver = observer }

// Run a short-lived CLI with production-safe bounds (process-child.ts starts,
// reads and stops it). The child starts in the process worker once that is
// ready: on Linux, libuv forks and then blocks the calling thread until the
// child execs, and under CPU contention that wait held the event loop for
// hundreds of milliseconds per burst of calls. Until the worker is ready, after
// it has failed, and on Windows, children start on this thread as before.
export function runFile(
  command: string,
  args: readonly string[],
  options: RunFileOptions = {},
): Promise<RunFileResult> {
  assertProcessArgs(args)
  const timeout = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error('timeoutMs must be a positive integer')
  }
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) {
    throw new Error('maxOutputBytes must be a positive integer')
  }
  const killSignal = options.killSignal ?? 'SIGKILL'
  if (options.signal?.aborted) {
    return Promise.reject(Object.assign(abortError(options.signal, killSignal), {
      stdout: '',
      stderr: '',
    }))
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const observe = (error: Error) => {
      const evidence = { command, executable: resolveCommand(command),
        operation: command + (['auth', 'api', 'sync', 'health', 'build-user', '--refresh-models', '--pr-review',
          '--requested-changes-addressed', '--review-activity-since', '--head-sha', '--local-checkout-path', '--checkout-repo'].includes(args[0]) ? '.' + args[0].replace(/^--/, '') : ''),
        cwd: options.cwd ?? null, elapsedMs: Date.now() - startedAt, timeoutMs: timeout,
        callId: options.callId, readerPurpose: options.readerPurpose,
        stderrAllowed: !(command === 'gh' && args[0] === 'auth' && args[1] === 'token'),
        secrets: environmentSecrets(options.env ?? {}) }
      processFailures.set(error, evidence)
      if (!processFailureObserver || options.reportFailure === false || options.signal?.aborted || args[0] === '--diagnostics') return
      try {
        processFailureObserver(error, evidence)
      } catch (failure) {
        process.stderr.write(JSON.stringify({ level: 'error', event: 'logging.process_observer.failed', message: failure instanceof Error ? failure.message : 'observer failure' }) + '\n')
      }
    }
    const child = runChild({
      file: resolveCommand(command),
      args: [...args],
      cwd: options.cwd,
      env: childEnvironment(command, options.env, args),
      maxBuffer,
      timeoutMs: timeout,
      killSignal,
      ...(process.platform === 'win32' ? { killEnv: childEnvironment('taskkill.exe') } : {}),
    })

    const onAbort = () => child.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    void child.outcome.then(({ code, signal, stdout, stderr, termination }) => {
      options.signal?.removeEventListener('abort', onAbort)
      if (termination) {
        const terminalError = Object.assign(terminationError(termination, command, timeout, killSignal, options.signal), { stdout, stderr })
        observe(terminalError)
        reject(terminalError)
        return
      }
      if (code !== 0) {
        const expected = code !== null
          && (options.expected?.codes.includes(code) ?? false)
          && stderrMatches(options.expected?.stderr, stderr)
          && (options.expected?.stdout?.(stdout) ?? true)
        const error = Object.assign(
          new Error(`Command failed (${code ?? signal ?? 'unknown'}): ${command}`),
          {
            code,
            killed: false,
            signal,
            stdout,
            stderr,
            ...(expected ? { expected: true as const } : {}),
          },
        )
        if (!expected) observe(error)
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function terminationError(termination: ChildTermination, command: string, timeout: number, killSignal: NodeJS.Signals, signal?: AbortSignal): Error {
  switch (termination.kind) {
    case 'timeout':
      return Object.assign(new Error(`Command timed out after ${timeout}ms: ${command}`), { code: null, killed: true, signal: killSignal })
    case 'maxBuffer':
      return Object.assign(new Error(`${termination.stream} maxBuffer length exceeded`), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true,
        signal: killSignal,
      })
    case 'abort':
      return abortError(signal!, killSignal)
    case 'error':
      return termination.error
    case 'interrupted':
      return Object.assign(new Error(`Command interrupted, the process worker stopped: ${command}`), { code: null, killed: true, signal: killSignal })
  }
}

interface WorkerCall {
  resolve: (outcome: ChildOutcome) => void
  killSignal: NodeJS.Signals
  slot: Int32Array
  aborted: boolean
  /** This abort signalled the group before anything else could. */
  abortSignalled: boolean
}

interface ProcessWorker {
  worker: Worker
  ready: boolean
  calls: Map<number, WorkerCall>
}

let processWorker: ProcessWorker | null = null
let processWorkerStart: Promise<boolean> | null = null
let nextWorkerCall = 1

function runChild(request: ChildRequest): RunningChild {
  void processWorkerReady()
  const state = processWorker
  if (!state?.ready) return startChild(request)
  const id = nextWorkerCall++
  const slot = createCallSlot()
  const call: WorkerCall = { resolve: () => {}, killSignal: request.killSignal, slot, aborted: false, abortSignalled: false }
  const outcome = new Promise<ChildOutcome>((resolve) => { call.resolve = resolve })
  state.calls.set(id, call)
  try {
    state.worker.postMessage({ type: 'run', id, request, slot } satisfies ProcessWorkerRequest)
  } catch {
    // Nothing started: a request the worker cannot take starts here instead.
    state.calls.delete(id)
    return startChild(request)
  }
  return {
    // An abort taken here before the outcome arrived wins over an exit the
    // worker saw first, as an abort before the child's close always has; and
    // one that signalled the group first wins over the worker's later reason.
    outcome: outcome.then((result) => call.aborted && (call.abortSignalled || !result.termination)
      ? { ...result, termination: { kind: 'abort' } } : result),
    abort: () => {
      if (call.aborted) return
      call.aborted = true
      // Stop the group now, as an in-thread abort does: a teardown may exit
      // before the worker reads the message below. The wait for a spawn()
      // under way is bounded by the call's own timeout.
      call.abortSignalled = abortWorkerCall(slot, call.killSignal, request.timeoutMs)
      state.worker.postMessage({ type: 'abort', id } satisfies ProcessWorkerRequest)
    },
  }
}

function restoreOutcome(outcome: ChildOutcome<SerializedError>): ChildOutcome {
  const { termination, ...rest } = outcome
  if (!termination) return rest
  return { ...rest, termination: termination.kind === 'error' ? { kind: 'error', error: restoreError(termination.error) } : termination }
}

/** Starts the process worker once: true while it is ready to take runFile's
 *  children, false when it could not start or has stopped. */
export function processWorkerReady(): Promise<boolean> {
  if (process.platform === 'win32') return Promise.resolve(false)
  return processWorkerStart ??= startProcessWorker()
}

/** Stops the process worker as a fault would: the children it runs are stopped
 *  as interrupted, and later calls start on this thread. The fallback tests use it. */
export async function stopProcessWorker(): Promise<void> {
  await processWorker?.worker.terminate()
}

async function startProcessWorker(): Promise<boolean> {
  let asset: { url: URL, dir: string | null }
  try {
    asset = await processWorkerAsset()
  } catch (error) {
    console.error('[process] the process worker is unavailable; CLI calls start on the main thread:', error)
    processWorkerStart = Promise.resolve(false)
    return false
  }
  const removeAsset = () => {
    if (asset.dir) void rm(asset.dir, { recursive: true, force: true }).catch((error: unknown) => console.error('[process] could not remove the process worker build:', error))
  }
  return await new Promise<boolean>((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(asset.url)
    } catch (error) {
      console.error('[process] the process worker did not start; CLI calls start on the main thread:', error)
      removeAsset()
      processWorkerStart = Promise.resolve(false)
      resolve(false)
      return
    }
    worker.unref()
    const state: ProcessWorker = { worker, ready: false, calls: new Map() }
    processWorker = state
    worker.on('message', (message: ProcessWorkerReply) => {
      if (message.type === 'ready') {
        state.ready = true
        removeAsset()
        resolve(true)
        return
      }
      const call = state.calls.get(message.id)
      if (!call) return
      state.calls.delete(message.id)
      call.resolve(restoreOutcome(message.outcome))
    })
    // A worker fault never stops CLI calls: later ones start on this thread,
    // and the ones it was running are stopped and reported as interrupted.
    const retire = (reason: unknown) => {
      if (processWorker !== state) return
      processWorker = null
      processWorkerStart = Promise.resolve(false)
      if (!state.ready) removeAsset()
      resolve(false)
      console.error('[process] the process worker stopped; CLI calls start on the main thread:', reason)
      for (const call of state.calls.values()) {
        const pid = Atomics.load(call.slot, CALL_PID)
        if (pid && claimSignal(call.slot)) killGroup(pid, call.killSignal)
        call.resolve({ code: null, signal: null, stdout: '', stderr: '', termination: { kind: 'interrupted' } })
      }
      state.calls.clear()
    }
    worker.once('error', retire)
    worker.once('exit', (code) => retire(new Error(`exited with code ${code}`)))
  })
}

// The production bundle ships dist/process-worker.js beside dist/server.js.
// From the source tree (development, tests) the worker is bundled once, as
// agent.ts does for its parse worker.
async function processWorkerAsset(): Promise<{ url: URL, dir: string | null }> {
  const built = new URL('./process-worker.js', import.meta.url)
  if (existsSync(built)) return { url: built, dir: null }
  const source = new URL('./process-worker.ts', import.meta.url)
  if (process.env.NODE_ENV === 'production' || !existsSync(source)) {
    throw new Error('The process worker asset is missing')
  }
  const dir = await mkdtemp(join(tmpdir(), 'poise-process-worker-'))
  try {
    const output = join(dir, 'worker.mjs')
    const { build } = await import('esbuild')
    await build({ entryPoints: [fileURLToPath(source)], outfile: output, bundle: true,
      platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    return { url: pathToFileURL(output), dir }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export interface DetachedSpawnOptions {
  cwd?: string
  /** Variables overlaid on the scrubbed parent environment. */
  env?: NodeJS.ProcessEnv
  /** Observe termination after a successful spawn (including late failure). */
  onExit?: (result: DetachedProcessExit) => void | Promise<void>
}

export interface DetachedProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

let callerLaunches = 0
let behaviorCallerLaunches = 0
export const BEHAVIOR_CALL_SOURCES = ['poise:review-new-prs', 'poise:approve-prs', 'poise:review-new-issues', 'poise:behavior-chain'] as const

/** Caller (`agent-interface`) processes this server launched detached and
 *  has not yet seen exit: every behavior run, manual review, replay, card
 *  chat and /content call it started. */
export function runningCallerLaunches(behaviorOnly = false): number {
  return behaviorOnly ? behaviorCallerLaunches : callerLaunches
}

// Resolve only after the OS accepted the launch. In particular, ENOENT and
// invalid cwd errors are observed and rejected instead of becoming an
// unhandled ChildProcess error that can terminate the Poise server.
export function spawnDetached(
  command: string,
  args: readonly string[],
  options: DetachedSpawnOptions = {},
): Promise<void> {
  assertProcessArgs(args)
  const caller = commandName(command) === 'agent-interface'
  const sourceIndex = args.indexOf('--source')
  const behavior = caller && sourceIndex >= 0 && (BEHAVIOR_CALL_SOURCES as readonly string[]).includes(args[sourceIndex + 1] ?? '')
  return new Promise((resolve, reject) => {
    let launched = false
    let exitReported = false
    const child = spawn(resolveCommand(command), [...args], {
      cwd: options.cwd,
      env: childEnvironment(command, options.env),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })

    const reportExit = (result: DetachedProcessExit) => {
      if (!launched || exitReported || !options.onExit) return
      exitReported = true
      try {
        void Promise.resolve(options.onExit(result)).catch((error: unknown) => {
          console.error('[process] detached exit callback failed:', error)
        })
      } catch (error) {
        console.error('[process] detached exit callback failed:', error)
      }
    }

    child.on('error', (error) => {
      if (!launched) reject(error)
      else reportExit({ code: null, signal: null, error })
    })
    child.once('spawn', () => {
      launched = true
      if (caller) callerLaunches += 1
      if (behavior) behaviorCallerLaunches += 1
      child.unref()
      resolve()
    })
    child.once('exit', (code, signal) => {
      if (caller && launched) callerLaunches -= 1
      if (behavior && launched) behaviorCallerLaunches -= 1
      reportExit({ code, signal })
    })
  })
}
