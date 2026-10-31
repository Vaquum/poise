import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
  CLAUDE_AUTH_POLL_MS,
  CLAUDE_AUTH_RETRY_BASE_MS,
  CLAUDE_AUTH_RETRY_MAX_MS,
  ClaudeAuthMonitor,
  type ClaudeAuthClock,
  type ClaudeAuthRunFile,
  type ClaudeAuthTimer,
} from '../server/claude-auth'
import { CLAUDE_SUBSCRIPTION_CLI } from '../server/process'

const VALID_STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'private@example.com',
  orgId: 'private-org',
  subscriptionType: 'max',
})

const OK = { stdout: 'OK\n', stderr: '' }

interface FakeTimer {
  callback: () => void
  delayMs: number
  cleared: boolean
  unrefSpy: ReturnType<typeof vi.fn>
  unref(): void
}

class FakeClock implements ClaudeAuthClock {
  nowMs = Date.parse('2026-07-15T12:00:00.000Z')
  readonly timers: FakeTimer[] = []

  now(): number { return this.nowMs }

  setTimeout(callback: () => void, delayMs: number): ClaudeAuthTimer {
    const unrefSpy = vi.fn()
    const timer: FakeTimer = {
      callback,
      delayMs,
      cleared: false,
      unrefSpy,
      unref: () => { unrefSpy() },
    }
    this.timers.push(timer)
    return timer
  }

  clearTimeout(timer: ClaudeAuthTimer): void {
    ;(timer as FakeTimer).cleared = true
  }

  advance(ms: number): void { this.nowMs += ms }

  fire(timer: FakeTimer): void {
    this.advance(timer.delayMs)
    timer.callback()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function validRun(): ReturnType<typeof vi.fn<ClaudeAuthRunFile>> {
  return vi.fn<ClaudeAuthRunFile>(async (_command, args) => (
    args[0] === 'auth' ? { stdout: VALID_STATUS, stderr: '' } : OK
  ))
}

let originalClaudeCli: string | undefined

beforeEach(() => {
  originalClaudeCli = process.env.CLAUDE_CLI
  delete process.env.CLAUDE_CLI
})

afterEach(() => {
  if (originalClaudeCli === undefined) delete process.env.CLAUDE_CLI
  else process.env.CLAUDE_CLI = originalClaudeCli
})

describe('Claude subscription authentication monitor', () => {
  it('verifies Claude.ai with a live subscription canary and exposes only sanitized fields', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })

    const snapshot = await monitor.check({ forceLive: true })

    expect(snapshot).toEqual({
      status: 'authenticated',
      reason: null,
      checkedAt: '2026-07-15T12:00:00.000Z',
      verifiedAt: '2026-07-15T12:00:00.000Z',
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      loginInProgress: false,
    })
    expect(Object.keys(snapshot)).toEqual([
      'status',
      'reason',
      'checkedAt',
      'verifiedAt',
      'authMethod',
      'subscriptionType',
      'loginInProgress',
    ])
    expect(run).toHaveBeenNthCalledWith(1, CLAUDE_SUBSCRIPTION_CLI, ['auth', 'status', '--json'], expect.objectContaining({
      env: expect.objectContaining({
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_BASE_URL: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        CLAUDE_CLI: CLAUDE_SUBSCRIPTION_CLI,
      }),
    }))
    expect(run).toHaveBeenNthCalledWith(2, CLAUDE_SUBSCRIPTION_CLI, [
      '--print',
      '--model',
      'haiku',
      '--effort',
      'low',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
      '--no-session-persistence',
      'Reply with exactly OK.',
    ], expect.objectContaining({
      env: expect.objectContaining({ POISE_CLAUDE_CANARY: '1' }),
    }))
    expect(JSON.stringify(snapshot)).not.toContain('private@example.com')
    expect(JSON.stringify(snapshot)).not.toContain('private-org')
  })

  it.each([
    { loggedIn: false, authMethod: 'claude.ai', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'claude.ai' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'thirdParty' },
  ])('requires reauthentication for a non-subscription local status: %j', async (status) => {
    const run = vi.fn<ClaudeAuthRunFile>().mockResolvedValue({
      stdout: JSON.stringify(status),
      stderr: '',
    })
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })

    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({
      status: 'reauth_required',
      authMethod: null,
      subscriptionType: null,
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it('catches an expired credential that local auth status falsely reports as logged in', async () => {
    const expired = Object.assign(new Error('API Error: 401 authentication_error: OAuth token has expired'), {
      stderr: '401 authentication_error',
    })
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(expired)
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })

    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({
      status: 'reauth_required',
      verifiedAt: null,
      loginInProgress: false,
    })
  })

  it('does not repeat an expired-token canary on every local-status poll', async () => {
    const clock = new FakeClock()
    const status = { stdout: VALID_STATUS, stderr: '' }
    const expired = new Error('401 authentication_error: OAuth token expired')
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(expired)
      .mockResolvedValue(status)
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })

    await monitor.check({ forceLive: true })
    for (let poll = 0; poll < 3; poll += 1) {
      clock.advance(CLAUDE_AUTH_POLL_MS)
      await monitor.check()
    }

    expect(monitor.snapshot().status).toBe('reauth_required')
    expect(run).toHaveBeenCalledTimes(5)

    clock.advance(CLAUDE_AUTH_RETRY_MAX_MS - (3 * CLAUDE_AUTH_POLL_MS))
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(7)
  })

  it('classifies transient canary failures as degraded and retries the live check', async () => {
    const clock = new FakeClock()
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })

    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({ status: 'degraded' })
    await expect(monitor.check()).resolves.toMatchObject({ status: 'degraded' })
    expect(run).toHaveBeenCalledTimes(3)

    clock.advance(CLAUDE_AUTH_RETRY_BASE_MS)
    await expect(monitor.check()).resolves.toMatchObject({ status: 'authenticated' })
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('backs repeated transient canaries off exponentially', async () => {
    const clock = new FakeClock()
    const status = { stdout: VALID_STATUS, stderr: '' }
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(new Error('502 first'))
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(new Error('502 second'))
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })

    await monitor.check({ forceLive: true })
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(3)

    clock.advance(CLAUDE_AUTH_RETRY_BASE_MS)
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(5)

    clock.advance(CLAUDE_AUTH_RETRY_BASE_MS)
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(6)

    clock.advance(CLAUDE_AUTH_RETRY_BASE_MS)
    await expect(monitor.check()).resolves.toMatchObject({ status: 'authenticated' })
    expect(run).toHaveBeenCalledTimes(8)
  })

  it('preserves a known sign-in requirement across inconclusive checks', async () => {
    const loggedOut = {
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      stderr: '',
    }
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce(loggedOut)
      .mockRejectedValueOnce(new Error('temporary status failure'))
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })

    await expect(monitor.check()).resolves.toMatchObject({ status: 'reauth_required' })
    await expect(monitor.check()).resolves.toMatchObject({ status: 'reauth_required' })
    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({
      status: 'reauth_required',
      authMethod: null,
      subscriptionType: null,
    })
  })

  it('keeps local CLI failures unavailable without turning them into login prompts', async () => {
    const run = vi.fn<ClaudeAuthRunFile>().mockRejectedValue(new Error('spawn claude ENOENT'))
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })

    await expect(monitor.check({ forceLive: true })).resolves.toMatchObject({
      status: 'unavailable',
      authMethod: null,
    })
  })

  it('parses a logged-out JSON status even when the CLI exits nonzero', async () => {
    const error = Object.assign(new Error('Command failed'), {
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      stderr: '',
    })
    const run = vi.fn<ClaudeAuthRunFile>().mockRejectedValue(error)
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })

    await expect(monitor.check()).resolves.toMatchObject({ status: 'reauth_required' })
  })

  it('never re-proves a healthy sign-in on a timer', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })
    await monitor.check({ forceLive: true })
    expect(run).toHaveBeenCalledTimes(2)

    clock.advance(24 * 60 * 60_000)
    await monitor.check()
    expect(run).toHaveBeenCalledTimes(3)
    expect(monitor.snapshot().status).toBe('authenticated')
    await expect(monitor.requireReady()).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('marks degraded when a forced canary returns 502', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })
    await monitor.check({ forceLive: true })
    run.mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))

    await monitor.check({ forceLive: true })
    expect(monitor.snapshot().status).toBe('degraded')
  })

  it('starts an unrefed sixty-second local-status poll and stops it', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })

    monitor.start()
    await monitor.check({ forceLive: true })
    const firstTimer = clock.timers[0]
    expect(firstTimer.delayMs).toBe(CLAUDE_AUTH_POLL_MS)
    expect(firstTimer.unrefSpy).toHaveBeenCalledOnce()

    clock.fire(firstTimer)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(clock.timers).toHaveLength(2))
    await monitor.stop()
    expect(clock.timers.at(-1)?.cleared).toBe(true)
  })

  it('coalesces concurrent forced checks into one status and one canary', async () => {
    const status = deferred<{ stdout: string, stderr: string }>()
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockImplementationOnce(() => status.promise)
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })

    const first = monitor.check({ forceLive: true })
    const second = monitor.check({ forceLive: true })
    expect(run).toHaveBeenCalledOnce()
    status.resolve({ stdout: VALID_STATUS, stderr: '' })

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'authenticated' },
      { status: 'authenticated' },
    ])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs one exact Claude.ai login and verifies it before becoming ready', async () => {
    const login = deferred<{ stdout: string, stderr: string }>()
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
        stderr: '',
      })
      .mockImplementationOnce(() => login.promise)
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })
    await monitor.check()

    expect(monitor.startLogin()).toMatchObject({ status: 'signing_in', loginInProgress: true })
    expect(monitor.startLogin()).toMatchObject({ status: 'signing_in', loginInProgress: true })
    expect(run).toHaveBeenNthCalledWith(2, CLAUDE_SUBSCRIPTION_CLI, ['auth', 'login', '--claudeai'], expect.objectContaining({
      timeoutMs: CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
    }))
    login.resolve({ stdout: 'Login successful.', stderr: '' })

    await vi.waitFor(() => expect(monitor.snapshot()).toMatchObject({
      status: 'authenticated',
      loginInProgress: false,
      verifiedAt: '2026-07-15T12:00:00.000Z',
    }))
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('does not open a login flow while authentication is healthy', async () => {
    const run = validRun()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })
    await monitor.check({ forceLive: true })

    expect(monitor.startLogin()).toMatchObject({
      status: 'authenticated',
      loginInProgress: false,
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('aborts an active check and clears its timer during stop', async () => {
    let observedSignal: AbortSignal | undefined
    const run = vi.fn<ClaudeAuthRunFile>((_command, _args, options) => new Promise((_, reject) => {
      observedSignal = options?.signal
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })
    monitor.start()

    await monitor.stop()

    expect(observedSignal?.aborted).toBe(true)
    expect(clock.timers[0].cleared).toBe(true)
    expect(monitor.snapshot()).toMatchObject({ status: 'unavailable', loginInProgress: false })
  })

  it('aborts login on stop without leaving the sign-in state stuck', async () => {
    let loginSignal: AbortSignal | undefined
    const run = vi.fn<ClaudeAuthRunFile>((_command, args, options) => {
      if (args[0] !== 'auth' || args[1] !== 'login') {
        return Promise.resolve({
          stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
          stderr: '',
        })
      }
      return new Promise((_, reject) => {
        loginSignal = options?.signal
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })
    await monitor.check()
    monitor.startLogin()

    await monitor.stop()

    expect(loginSignal?.aborted).toBe(true)
    expect(monitor.snapshot()).toMatchObject({ status: 'unavailable', loginInProgress: false })
  })

  it('does not let a stale pre-login check overwrite the verified login result', async () => {
    const stale = deferred<{ stdout: string, stderr: string }>()
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ stdout: 'Login successful.', stderr: '' })
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })

    void monitor.check({ forceLive: true })
    monitor.startLogin()
    stale.resolve({
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      stderr: '',
    })

    await vi.waitFor(() => expect(monitor.snapshot()).toMatchObject({
      status: 'authenticated',
      loginInProgress: false,
    }))
    expect(run).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['worker exit', { code: 1, signal: null }],
    ['generic error', new Error('worker failed')],
    ['GitHub failure', new Error('gh: HTTP 502 Bad Gateway')],
    ['GitHub auth failure', new Error('gh: HTTP 401 Bad credentials')],
    ['GitHub rate limit', new Error('GitHub 429 rate-limit: API rate limit exceeded')],
    ['max turns', 'max turns reached'],
    ['output budget', { code: 1, error: new Error('max output bytes exceeded') }],
    ['timeout', new Error('worker timed out')],
    ['stopped worker', { code: null, signal: 'SIGTERM' }],
    ['stop error', { code: null, signal: 'SIGTERM', error: new Error('aborted') }],
  ])('ignores unattributable noise %s without probing', async (_label, failure) => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })
    await monitor.check({ forceLive: true })
    const verified = monitor.snapshot()
    run.mockClear()

    monitor.observeProcessFailure(failure)

    expect(monitor.snapshot()).toEqual(verified)
    await expect(monitor.requireReady()).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['expired OAuth credential', new Error('401 authentication_error: OAuth token expired'), 'reauth_required', 'CLAUDE_AUTH_REQUIRED'],
    ['invalid API key', new Error('401 invalid API key'), 'reauth_required', 'CLAUDE_AUTH_REQUIRED'],
    ['usage limit', new Error('429 rate_limit_error: usage limit reached, resets tomorrow'), 'quota_exhausted', 'CLAUDE_AUTH_NOT_READY'],
    ['quota wording', new Error('Request failed: quota exhausted for this billing window'), 'quota_exhausted', 'CLAUDE_AUTH_NOT_READY'],
  ])('closes the shared gate reactively on %s, without probing', async (_label, failure, status, code) => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })
    await monitor.check({ forceLive: true })
    run.mockClear()

    monitor.observeProcessFailure(failure)

    expect(monitor.snapshot().status).toBe(status)
    await expect(monitor.requireReady()).rejects.toMatchObject({ statusCode: 503, code, authStatus: status })
    expect(run).not.toHaveBeenCalled()
  })

  it('never lets a late quota error clear a confirmed sign-in requirement', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })
    await monitor.check({ forceLive: true })
    monitor.observeProcessFailure(new Error('401 authentication_error: OAuth token expired'))
    expect(monitor.snapshot().status).toBe('reauth_required')

    monitor.observeProcessFailure(new Error('429 usage limit reached'))

    expect(monitor.snapshot()).toMatchObject({ status: 'reauth_required', authMethod: null, subscriptionType: null })
    // The asymmetry holds the other way: a dead credential always surfaces.
    const quota = new ClaudeAuthMonitor({ runFile: validRun(), canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })
    await quota.check({ forceLive: true })
    quota.observeProcessFailure(new Error('429 usage limit reached'))
    expect(quota.snapshot().status).toBe('quota_exhausted')
    quota.observeProcessFailure(new Error('401 authentication_error: OAuth token expired'))
    expect(quota.snapshot().status).toBe('reauth_required')
  })

  it('keeps a reactive downgrade when a healthy poll lands after it', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })
    await monitor.check({ forceLive: true })
    let resolveStatus!: (value: { stdout: string, stderr: string }) => void
    run.mockImplementationOnce(() => new Promise<{ stdout: string, stderr: string }>((resolve) => { resolveStatus = resolve }))
    const pending = monitor.check()
    monitor.observeProcessFailure(new Error('401 authentication_error: OAuth token expired'))
    resolveStatus({ stdout: VALID_STATUS, stderr: '' })
    await pending

    expect(monitor.snapshot().status).toBe('reauth_required')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('keeps the sign-in identity on quota exhaustion and recovers when the canary succeeds', async () => {
    const run = validRun()
    const clock = new FakeClock()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock })
    await monitor.check({ forceLive: true })
    monitor.observeProcessFailure(new Error('429 usage limit reached'))

    expect(monitor.snapshot()).toMatchObject({ status: 'quota_exhausted', authMethod: 'claude.ai', subscriptionType: 'max' })
    clock.advance(CLAUDE_AUTH_RETRY_BASE_MS)
    await monitor.check()
    expect(monitor.snapshot().status).toBe('authenticated')
  })

  it('does not let a late worker failure erase a verified sign-in requirement', async () => {
    const run = vi.fn<ClaudeAuthRunFile>().mockResolvedValue({
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      stderr: '',
    })
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })
    await monitor.check()
    run.mockClear()

    monitor.observeProcessFailure({ code: 1, signal: null, error: new Error('late exit') })

    expect(monitor.snapshot().status).toBe('reauth_required')
    await expect(monitor.requireReady()).rejects.toMatchObject({
      statusCode: 503,
      code: 'CLAUDE_AUTH_REQUIRED',
      authStatus: 'reauth_required',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('ignores late worker exits after stop', async () => {
    const run = validRun()
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })
    monitor.start()
    await monitor.check({ forceLive: true })
    await monitor.stop()
    run.mockClear()

    monitor.observeProcessFailure({ code: 1, signal: null, error: new Error('late exit') })
    await Promise.resolve()

    expect(run).not.toHaveBeenCalled()
    expect(monitor.snapshot().status).toBe('unavailable')
  })

  it('tells its listeners each status it decides, once per change', async () => {
    const loggedOut = { stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }), stderr: '' }
    const run = vi.fn<ClaudeAuthRunFile>()
      .mockResolvedValueOnce(loggedOut)
      .mockResolvedValueOnce(loggedOut)
      .mockResolvedValueOnce({ stdout: VALID_STATUS, stderr: '' })
      .mockResolvedValueOnce(OK)
    const monitor = new ClaudeAuthMonitor({ runFile: run, canaryModel: async () => ({ selector: 'haiku', effort: 'low' }), clock: new FakeClock() })
    const heard: string[] = []
    const stop = monitor.onStatus((status) => heard.push(status))

    await monitor.check()
    await monitor.check()
    await monitor.check({ forceLive: true })
    expect(heard).toEqual(['reauth_required', 'authenticated'])

    stop()
    await monitor.stop()
    expect(monitor.snapshot().status).toBe('unavailable')
    expect(heard).toEqual(['reauth_required', 'authenticated'])
  })
})
