import {
  claudeSubscriptionEnvironment,
  CLAUDE_SUBSCRIPTION_CLI,
  runFile as defaultRunFile,
  type RunFileOptions,
  type RunFileResult,
} from './process'
import { canaryClaudeModel, loadCatalog } from './models'
import { HttpError } from './http'

export const CLAUDE_AUTH_POLL_MS = 60_000
export const CLAUDE_AUTH_LOGIN_TIMEOUT_MS = 10 * 60_000
export const CLAUDE_AUTH_RETRY_BASE_MS = 60_000
export const CLAUDE_AUTH_RETRY_MAX_MS = 60 * 60_000

const STATUS_TIMEOUT_MS = 30_000
const LIVE_TIMEOUT_MS = 90_000
const MAX_AUTH_OUTPUT_BYTES = 64 * 1024
const LIVE_PROMPT = 'Reply with exactly OK.'
const CLAUDE_COMMAND = CLAUDE_SUBSCRIPTION_CLI

export type ClaudeAuthStatus =
  | 'checking'
  | 'authenticated'
  | 'reauth_required'
  | 'quota_exhausted'
  | 'signing_in'
  | 'degraded'
  | 'unavailable'

export interface ClaudeAuthSnapshot {
  status: ClaudeAuthStatus
  reason: string | null
  checkedAt: string | null
  verifiedAt: string | null
  authMethod: string | null
  subscriptionType: string | null
  loginInProgress: boolean
}

export type ClaudeAuthRunFile = (
  command: string,
  args: readonly string[],
  options?: RunFileOptions,
) => Promise<RunFileResult>

export type ClaudeAuthTimer = number | { unref?: () => void }

export interface ClaudeAuthClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): ClaudeAuthTimer
  clearTimeout(timer: ClaudeAuthTimer): void
}

export interface ClaudeAuthMonitorOptions {
  runFile?: ClaudeAuthRunFile
  clock?: ClaudeAuthClock
  /** Resolves the canary's Claude model row; production reads the live catalog. */
  canaryModel?: () => Promise<{ selector: string, effort: string }>
}

export interface ClaudeAuthCheckOptions {
  forceLive?: boolean
}

const systemClock: ClaudeAuthClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

const REASONS: Record<ClaudeAuthStatus, string | null> = {
  checking: 'Checking Claude subscription authentication.',
  authenticated: null,
  reauth_required: 'Claude subscription sign-in is required.',
  quota_exhausted: 'Claude subscription is signed in but out of quota; launches are held until more quota is available.',
  signing_in: 'Waiting for Claude subscription sign-in.',
  degraded: 'Claude subscription authentication could not be verified.',
  unavailable: 'Claude CLI authentication is unavailable.',
}

interface LocalAuthStatus {
  ready: boolean
  authMethod: string | null
  subscriptionType: string | null
}

export class ClaudeAuthReadinessError extends HttpError {
  readonly code: 'CLAUDE_AUTH_REQUIRED' | 'CLAUDE_AUTH_NOT_READY'
  readonly authStatus: ClaudeAuthStatus

  constructor(status: ClaudeAuthStatus) {
    const required = status === 'reauth_required'
    super(503, required
      ? 'Claude subscription sign-in is required'
      : 'Claude subscription authentication is not ready')
    this.name = 'ClaudeAuthReadinessError'
    this.code = required ? 'CLAUDE_AUTH_REQUIRED' : 'CLAUDE_AUTH_NOT_READY'
    this.authStatus = status
  }
}

export function sanitizeSubscriptionType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,31}$/.test(normalized)
    ? normalized
    : null
}

/** What `claude auth status --json` says when Claude Code is signed in to a
 *  Claude subscription: the only sign-in Poise runs Claude on. */
export function claudeSubscriptionReady(status: Record<string, unknown>): boolean {
  return status.loggedIn === true
    && status.authMethod === 'claude.ai'
    && status.apiProvider === 'firstParty'
}

function parseStatusJson(raw: string): LocalAuthStatus | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = value as Record<string, unknown>
  const ready = claudeSubscriptionReady(status)
  return {
    ready,
    authMethod: ready ? 'claude.ai' : null,
    subscriptionType: ready ? sanitizeSubscriptionType(status.subscriptionType) : null,
  }
}

function failureText(error: unknown): string {
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return ''
  const record = error as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['message', 'stderr', 'stdout']) {
    const value = record[key]
    if (typeof value === 'string') parts.push(value)
    else if (Buffer.isBuffer(value)) parts.push(value.toString('utf8'))
  }
  if (record.error && record.error !== error) parts.push(failureText(record.error))
  return parts.join('\n')
}

function errorStdout(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const value = (error as Record<string, unknown>).stdout
  if (typeof value === 'string') return value
  return Buffer.isBuffer(value) ? value.toString('utf8') : null
}

function isDefinitiveAuthFailure(error: unknown): boolean {
  const text = failureText(error)
  // GitHub-attributed failures (a gh 401 from inside an agent turn) say
  // nothing about the Claude subscription.
  if (!text || /github/i.test(text) || /\bgh:/i.test(text)) return false
  return /(?:\b401\b|authentication[_ ]error|invalid\s+(?:x-)?api[- ]?key)/i.test(text)
    || /(?:oauth|token|credential)[^\n]{0,80}\bexpired\b/i.test(text)
    || /\bexpired\b[^\n]{0,80}(?:oauth|token|credential)/i.test(text)
}

/** Quota or credit exhaustion, as distinct from sign-in state. A saturated
 *  subscription stays signed in: launches hold without demanding a re-login. */
function isQuotaExhaustion(error: unknown): boolean {
  const text = failureText(error)
  if (!text || /github/i.test(text) || /\bgh:/i.test(text)) return false
  return /\b429\b/.test(text)
    || /rate[\s_-]*limit/i.test(text)
    || /quota/i.test(text)
    || /usage[\s_-]*limit/i.test(text)
    || /credits?\b[^\n]{0,40}(?:exhausted|depleted|insufficient)/i.test(text)
    || /out of[^\n]{0,20}credits?/i.test(text)
}

async function defaultCanaryModel(): Promise<{ selector: string, effort: string }> {
  const model = canaryClaudeModel(await loadCatalog())
  if (!model) throw new Error('the model catalog names no Claude model for the sign-in check')
  return { selector: model.selector, effort: model.effort }
}

export class ClaudeAuthMonitor {
  private readonly run: ClaudeAuthRunFile
  private readonly clock: ClaudeAuthClock
  private readonly canaryModel: () => Promise<{ selector: string, effort: string }>
  private currentStatus: ClaudeAuthStatus = 'checking'
  private readonly statusListeners = new Set<(status: ClaudeAuthStatus) => void>()
  private checkedAtMs: number | null = null
  private verifiedAtMs: number | null = null
  private authMethod: string | null = null
  private subscriptionType: string | null = null
  private started = false
  private lifecycleGeneration = 0
  private stateGeneration = 0
  private timer: ClaudeAuthTimer | null = null
  private checkPromise: Promise<ClaudeAuthSnapshot> | null = null
  private checkAbort: AbortController | null = null
  private loginPromise: Promise<ClaudeAuthSnapshot> | null = null
  private loginAbort: AbortController | null = null
  private loginInProgress = false
  private forceLiveRequested = false
  private stopped = false
  private liveFailureCount = 0
  private nextLiveAttemptAtMs: number | null = null

  constructor(options: ClaudeAuthMonitorOptions = {}) {
    this.run = options.runFile ?? defaultRunFile
    this.clock = options.clock ?? systemClock
    this.canaryModel = options.canaryModel ?? defaultCanaryModel
  }

  // Every status the monitor decides passes through here, so a listener
  // hears each change exactly once.
  private get status(): ClaudeAuthStatus {
    return this.currentStatus
  }

  private set status(next: ClaudeAuthStatus) {
    if (next === this.currentStatus) return
    this.currentStatus = next
    for (const listener of this.statusListeners) listener(next)
  }

  /** Calls `listener` with each new status; returns the unsubscribe. */
  onStatus(listener: (status: ClaudeAuthStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  snapshot(): ClaudeAuthSnapshot {
    return {
      status: this.status,
      reason: REASONS[this.status],
      checkedAt: this.checkedAtMs === null ? null : new Date(this.checkedAtMs).toISOString(),
      verifiedAt: this.verifiedAtMs === null ? null : new Date(this.verifiedAtMs).toISOString(),
      authMethod: this.authMethod,
      subscriptionType: this.subscriptionType,
      loginInProgress: this.loginInProgress,
    }
  }

  start(): void {
    if (this.started) return
    this.stopped = false
    this.started = true
    this.lifecycleGeneration += 1
    this.stateGeneration += 1
    this.liveFailureCount = 0
    this.nextLiveAttemptAtMs = null
    this.status = 'checking'
    const lifecycle = this.lifecycleGeneration
    void this.check({ forceLive: true })
    this.schedulePoll(lifecycle)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.started = false
    this.lifecycleGeneration += 1
    this.stateGeneration += 1
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.forceLiveRequested = false
    this.liveFailureCount = 0
    this.nextLiveAttemptAtMs = null
    this.loginInProgress = false
    this.checkAbort?.abort()
    this.loginAbort?.abort()
    const pending = [this.checkPromise, this.loginPromise].filter(
      (value): value is Promise<ClaudeAuthSnapshot> => value !== null,
    )
    this.status = 'unavailable'
    this.authMethod = null
    this.subscriptionType = null
    await Promise.allSettled(pending)
  }

  check(options: ClaudeAuthCheckOptions = {}): Promise<ClaudeAuthSnapshot> {
    if (this.stopped) return Promise.resolve(this.snapshot())
    if (options.forceLive) this.forceLiveRequested = true
    if (this.loginInProgress) return Promise.resolve(this.snapshot())
    if (this.checkPromise) {
      const active = this.checkPromise
      return active.then(() => {
        if (this.forceLiveRequested && !this.loginInProgress) return this.check()
        return this.snapshot()
      })
    }
    return this.beginCheck(this.stateGeneration, false)
  }

  startLogin(): ClaudeAuthSnapshot {
    if (this.stopped) return this.snapshot()
    if (this.status === 'authenticated' || this.loginInProgress) return this.snapshot()
    const staleCheck = this.checkPromise
    this.stateGeneration += 1
    const generation = this.stateGeneration
    this.forceLiveRequested = false
    this.liveFailureCount = 0
    this.nextLiveAttemptAtMs = null
    this.checkAbort?.abort()
    this.loginInProgress = true
    this.status = 'signing_in'
    const controller = new AbortController()
    this.loginAbort = controller

    const operation = (async () => {
      try {
        await this.run(
          CLAUDE_COMMAND,
          ['auth', 'login', '--claudeai'],
          {
            env: claudeSubscriptionEnvironment(),
            timeoutMs: CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
            maxOutputBytes: MAX_AUTH_OUTPUT_BYTES,
            signal: controller.signal,
          },
        )
        await staleCheck?.catch(() => undefined)
        if (generation !== this.stateGeneration) return this.snapshot()
        this.forceLiveRequested = true
        return await this.beginCheck(generation, true)
      } catch (error) {
        if (generation === this.stateGeneration) {
          this.status = isDefinitiveAuthFailure(error) ? 'reauth_required' : 'unavailable'
        }
        return this.snapshot()
      }
    })()
    this.loginPromise = operation
    const finish = () => {
      if (this.loginPromise === operation) this.loginPromise = null
      if (this.loginAbort === controller) this.loginAbort = null
      if (generation === this.stateGeneration) this.loginInProgress = false
    }
    void operation.then(finish, finish)
    return this.snapshot()
  }

  async requireReady(): Promise<void> {
    if (this.status === 'authenticated') return
    if (!this.stopped && this.status !== 'reauth_required' && this.status !== 'quota_exhausted' && !this.loginInProgress) {
      await this.check({
        forceLive: this.status === 'degraded' || this.status === 'unavailable',
      })
    }
    const current = this.snapshot().status
    if (current !== 'authenticated') throw new ClaudeAuthReadinessError(current)
  }

  /** Classify a real Claude failure observed elsewhere: a failed agent call
   *  on a Claude model, a dead launch. Callers guarantee Claude attribution
   *  (the auth/quota patterns alone cannot tell providers apart); anything
   *  that matches neither pattern is ignored. Only ever downgrades — the
   *  scheduled checks own every upgrade back — and never disturbs a login.
   *  A confirmed dead credential outranks quota: a late quota error from an
   *  already-running process cannot prove the current credential works. */
  observeProcessFailure(resultOrError: unknown): void {
    if (this.stopped || this.loginInProgress) return
    if (isDefinitiveAuthFailure(resultOrError)) {
      if (this.status === 'reauth_required') return
      this.status = 'reauth_required'
      this.authMethod = null
      this.subscriptionType = null
      this.liveFailureCount = 0
      this.checkedAtMs = this.clock.now()
      this.nextLiveAttemptAtMs = this.clock.now() + CLAUDE_AUTH_RETRY_MAX_MS
      // Invalidate in-flight polls: their local evidence predates this
      // failure and must not overwrite it.
      this.stateGeneration += 1
      return
    }
    if (isQuotaExhaustion(resultOrError)) {
      if (this.status === 'quota_exhausted' || this.status === 'reauth_required') return
      this.status = 'quota_exhausted'
      this.liveFailureCount = 0
      this.checkedAtMs = this.clock.now()
      this.nextLiveAttemptAtMs = this.clock.now() + CLAUDE_AUTH_RETRY_BASE_MS
      this.stateGeneration += 1
    }
  }

  private schedulePoll(lifecycle: number): void {
    if (!this.started || lifecycle !== this.lifecycleGeneration) return
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    const timer = this.clock.setTimeout(() => {
      if (this.timer === timer) this.timer = null
      if (!this.started || lifecycle !== this.lifecycleGeneration) return
      void this.check().finally(() => this.schedulePoll(lifecycle))
    }, CLAUDE_AUTH_POLL_MS)
    this.timer = timer
    if (typeof timer === 'object' && timer !== null) timer.unref?.()
  }

  private beginCheck(generation: number, preserveSigningIn: boolean): Promise<ClaudeAuthSnapshot> {
    if (this.checkPromise) return this.checkPromise
    const controller = new AbortController()
    this.checkAbort = controller
    let operation!: Promise<ClaudeAuthSnapshot>
    operation = this.performCheck(generation, controller.signal, preserveSigningIn)
      .catch(() => {
        if (generation === this.stateGeneration) {
          if (this.status !== 'reauth_required' && this.status !== 'unavailable') {
            this.status = this.status === 'authenticated' || this.status === 'degraded'
              ? 'degraded'
              : 'unavailable'
          }
        }
        return this.snapshot()
      })
      .finally(() => {
        if (this.checkPromise === operation) this.checkPromise = null
        if (this.checkAbort === controller) this.checkAbort = null
      })
    this.checkPromise = operation
    return operation
  }

  private async performCheck(
    generation: number,
    signal: AbortSignal,
    preserveSigningIn: boolean,
  ): Promise<ClaudeAuthSnapshot> {
    const previousStatus = this.status
    let local: LocalAuthStatus | null = null
    let localError: unknown
    try {
      const result = await this.run(
        CLAUDE_COMMAND,
        ['auth', 'status', '--json'],
        {
          env: claudeSubscriptionEnvironment(),
          timeoutMs: STATUS_TIMEOUT_MS,
          maxOutputBytes: MAX_AUTH_OUTPUT_BYTES,
          signal,
        },
      )
      local = parseStatusJson(result.stdout)
    } catch (error) {
      localError = error
      const stdout = errorStdout(error)
      if (stdout !== null) local = parseStatusJson(stdout)
    }

    if (generation !== this.stateGeneration) return this.snapshot()
    this.checkedAtMs = this.clock.now()
    if (!local) {
      this.forceLiveRequested = false
      if (isDefinitiveAuthFailure(localError)) {
        this.status = 'reauth_required'
        this.authMethod = null
        this.subscriptionType = null
        this.liveFailureCount = 0
        this.nextLiveAttemptAtMs = this.clock.now() + CLAUDE_AUTH_RETRY_MAX_MS
      } else if (previousStatus === 'reauth_required') {
        this.status = 'reauth_required'
      } else if (previousStatus === 'authenticated' || previousStatus === 'degraded') {
        this.status = 'degraded'
      } else if (!preserveSigningIn) {
        this.status = 'unavailable'
      } else {
        this.status = 'unavailable'
      }
      return this.snapshot()
    }
    if (!local.ready) {
      this.forceLiveRequested = false
      this.status = 'reauth_required'
      this.authMethod = null
      this.subscriptionType = null
      this.liveFailureCount = 0
      this.nextLiveAttemptAtMs = null
      return this.snapshot()
    }

    this.authMethod = local.authMethod
    this.subscriptionType = local.subscriptionType
    const now = this.clock.now()
    const retryDue = this.nextLiveAttemptAtMs === null || now >= this.nextLiveAttemptAtMs
    // A healthy sign-in is never re-proved on a timer: the free status poll
    // watches for logout, and real failures downgrade reactively. The canary
    // runs once at boot, while unhealthy, or when explicitly forced.
    const liveWanted = this.forceLiveRequested
      || this.verifiedAtMs === null
      || previousStatus === 'degraded'
      || previousStatus === 'unavailable'
      || previousStatus === 'reauth_required'
      || previousStatus === 'quota_exhausted'
      || preserveSigningIn
    const liveRequired = liveWanted && (retryDue || preserveSigningIn)

    if (!liveRequired) {
      this.forceLiveRequested = false
      this.status = previousStatus === 'reauth_required' || previousStatus === 'quota_exhausted'
        ? previousStatus
        : previousStatus === 'degraded'
          ? 'degraded'
          : 'authenticated'
      if (this.status === 'reauth_required') {
        this.authMethod = null
        this.subscriptionType = null
      }
      return this.snapshot()
    }

    try {
      const canary = await this.canaryModel()
      await this.run(
        CLAUDE_COMMAND,
        [
          '--print',
          '--model',
          canary.selector,
          '--effort',
          canary.effort,
          '--permission-mode',
          'dontAsk',
          '--tools',
          '',
          '--no-session-persistence',
          LIVE_PROMPT,
        ],
        {
          // The canary verifies recovery, so the wrapper's retry breaker
          // exempts it even right after a failure.
          env: { ...claudeSubscriptionEnvironment(), POISE_CLAUDE_CANARY: '1' },
          timeoutMs: LIVE_TIMEOUT_MS,
          maxOutputBytes: MAX_AUTH_OUTPUT_BYTES,
          signal,
        },
      )
      if (generation === this.stateGeneration) {
        this.verifiedAtMs = this.clock.now()
        this.status = 'authenticated'
        this.liveFailureCount = 0
        this.nextLiveAttemptAtMs = null
      }
    } catch (error) {
      if (generation === this.stateGeneration) {
        if (isDefinitiveAuthFailure(error)) {
          this.status = 'reauth_required'
          this.authMethod = null
          this.subscriptionType = null
          this.liveFailureCount = 0
          // Local status can continue reporting a stale, apparently valid
          // Claude.ai session after OAuth expiry. Keep polling that status,
          // but do not turn the known 401 into a once-per-minute live probe.
          // A user-initiated login resets this deadline and verifies at once.
          this.nextLiveAttemptAtMs = this.clock.now() + CLAUDE_AUTH_RETRY_MAX_MS
        } else if (isQuotaExhaustion(error)) {
          // Still signed in: keep the identity, hold launches, and re-probe
          // on a backoff so recovery is noticed without hammering.
          this.liveFailureCount += 1
          const delay = Math.min(
            CLAUDE_AUTH_RETRY_BASE_MS * (2 ** Math.min(this.liveFailureCount - 1, 20)),
            CLAUDE_AUTH_RETRY_MAX_MS,
          )
          this.nextLiveAttemptAtMs = this.clock.now() + delay
          this.status = 'quota_exhausted'
        } else {
          this.liveFailureCount += 1
          const delay = Math.min(
            CLAUDE_AUTH_RETRY_BASE_MS * (2 ** Math.min(this.liveFailureCount - 1, 20)),
            CLAUDE_AUTH_RETRY_MAX_MS,
          )
          this.nextLiveAttemptAtMs = this.clock.now() + delay
          this.status = previousStatus === 'reauth_required' && !preserveSigningIn
            ? 'reauth_required'
            : 'degraded'
          if (this.status === 'reauth_required') {
            this.authMethod = null
            this.subscriptionType = null
          }
        }
      }
    } finally {
      if (generation === this.stateGeneration) this.forceLiveRequested = false
    }
    return this.snapshot()
  }
}

export const claudeAuth = new ClaudeAuthMonitor()
