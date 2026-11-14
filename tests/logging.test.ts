import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { diagnostic, diagnosticFailure, diagnosticPage, fatalDiagnostic, loggingRuntime, startLogging, stopLogging } from '../server/logging'
import { runFile } from '../server/process'
import * as processes from '../server/process'
import { credentialVariables } from './fixtures/cli-isolation'
import { fetchAgentLogSnapshot, fetchAgentResponse, fetchRunningAgentLogSnapshot, resetAgentLogCache } from '../server/agent'
import { withNoticeDiagnosticIdentity } from '../server/logging-context'

let directory = ''
afterEach(async () => { await stopLogging(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }) })
function start(blocked = false) {
  directory = mkdtempSync(join(tmpdir(), 'poise-logging-source-'))
  if (blocked) writeFileSync(join(directory, 'logging.db'), 'not a database')
  vi.stubEnv('POISE_DB', join(directory, 'cache.db'))
  vi.stubEnv('POISE_WORKSPACE_HANDLE', 'alice')
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  startLogging()
}

describe('independent application capture', () => {
  it('keeps typed History absence out of Error and retains Call ID and purpose for required or broken reads', async () => {
    start()
    vi.stubEnv('CALLER_BIN_ROOT', directory)
    const callId = 'a'.repeat(32)
    const state = join(directory, 'response-state')
    writeFileSync(state, 'absent')
    writeFileSync(join(directory, 'agent-interface'), `#!${process.execPath}
const { readFileSync } = require('node:fs')
const mode = readFileSync(${JSON.stringify(state)}, 'utf8')
if (mode === 'available') process.stdout.write('original response\\n')
else if (mode === 'missing') { process.stderr.write('promised response file is missing'); process.exitCode = 1 }
else {
  process.stdout.write(JSON.stringify({ id: mode === 'wrong-call' ? 'b'.repeat(32) : process.argv[3],
    disposition: 'unavailable', reason: 'The Call ended without a response' }))
  process.exitCode = 3
}
`, { mode: 0o755 })
    const events = () => {
      loggingRuntime()!.flush()
      return loggingRuntime()!.query(db => db.query({ workspace: 'alice', operator: false }, { source: 'poise' })).events
    }
    await expect(fetchAgentResponse(callId, 'history')).resolves.toEqual({ id: callId,
      disposition: 'unavailable', reason: 'The Call ended without a response' })
    expect(events()).toEqual([])
    await expect(fetchAgentResponse(callId, 'content-finalization')).rejects.toMatchObject({ code: 3 })
    expect(events()).toContainEqual(expect.objectContaining({ severity: 'error', callId,
      context: expect.objectContaining({ readerPurpose: 'content-finalization' }) }))
    for (const mode of ['wrong-call', 'missing']) {
      writeFileSync(state, mode)
      await expect(fetchAgentResponse(callId, 'history')).rejects.toThrow('Command failed')
    }
    const history = events().filter(event => event.context.readerPurpose === 'history')
    expect(history).toHaveLength(2)
    expect(history.every(event => event.severity === 'error' && event.callId === callId)).toBe(true)
    expect(history.some(event => event.stderr === 'promised response file is missing')).toBe(true)
    writeFileSync(state, 'available')
    await expect(fetchAgentResponse(callId, 'history')).resolves.toEqual({ id: callId, body: 'original response\n' })
  })

  it('retains one history episode across failed shared reads, with bounded first evidence and explicit recovery', async () => {
    start()
    resetAgentLogCache()
    vi.stubEnv('CALLER_BIN_ROOT', directory)
    const state = join(directory, 'history-state')
    writeFileSync(state, 'first precise timeout cause\nAuthorization: Bearer private-secret\n' + 'detail\n'.repeat(4000))
    writeFileSync(join(directory, 'agent-interface'), `#!${process.execPath}
const { readFileSync } = require('node:fs')
const failure = readFileSync(${JSON.stringify(state)}, 'utf8')
if (process.argv.includes('--status') || !failure) process.stdout.write('[]')
else { process.stderr.write(failure); process.exitCode = 1 }
`, { mode: 0o755 })
    await withNoticeDiagnosticIdentity({ correlationId: 'first-waiter', behavior: 'review-new-issues',
      repository: 'acme/first', target: 'acme/first#1', account: 'first-account' },
    () => Promise.all(Array.from({ length: 7 }, () => fetchAgentLogSnapshot().catch(error => error))))
    const events = () => {
      loggingRuntime()!.flush()
      return loggingRuntime()!.query(db => db.query({ workspace: 'alice', operator: false }, { source: 'poise' })).events
    }
    const first = events().filter(event => event.operation === 'agent.logs.history')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ occurrences: 1, exitCode: 1, truncated: true, repository: null, target: null, account: null,
      stderr: expect.stringContaining('first precise timeout cause'), context: { failedReads: 1, timeoutMs: 30_000 } })
    expect(Buffer.byteLength(first[0]!.stderr!)).toBeLessThanOrEqual(16_384)
    expect(JSON.stringify(first)).not.toContain('private-secret')
    expect(events().some(event => event.operation === 'agent-interface')).toBe(false)

    await fetchRunningAgentLogSnapshot()
    expect(events().some(event => event.operation === 'agent.logs.history.recovered')).toBe(false)
    writeFileSync(state, 'second read cause')
    await expect(withNoticeDiagnosticIdentity({ correlationId: 'later-waiter', behavior: 'approve-prs',
      repository: 'acme/second', target: 'acme/second#2', account: 'second-account' },
    () => fetchAgentLogSnapshot())).rejects.toThrow('Command failed (1)')
    const repeated = events().filter(event => event.operation === 'agent.logs.history')
    expect(repeated).toHaveLength(2)
    expect(repeated.every(event => event.incidentId === first[0]!.incidentId && event.occurrences === 2)).toBe(true)
    writeFileSync(state, '')
    await fetchAgentLogSnapshot()
    expect(events().find(event => event.operation === 'agent.logs.history.recovered')).toMatchObject({
      correlationId: first[0]!.correlationId, context: { failedReads: 2, firstFailureAt: first[0]!.context.firstFailureAt },
    })
    writeFileSync(state, 'new episode')
    await expect(fetchAgentLogSnapshot({ fresh: true })).rejects.toThrow('Command failed (1)')
    expect(events().find(event => event.operation === 'agent.logs.history' && event.incidentId !== first[0]!.incidentId))
      .toMatchObject({ occurrences: 1, context: { failedReads: 1 } })
    writeFileSync(state, '')
    await fetchAgentLogSnapshot({ fresh: true })
    resetAgentLogCache()
  })

  it.each([0, 8, 9])('persists completeness for an exception with %i underlying causes', (length) => {
    start()
    let error = new Error('cause-' + length)
    for (let i = length - 1; i >= 0; i--) error = new Error('cause-' + i, { cause: error })
    diagnosticFailure('chain.failed', error)
    loggingRuntime()!.flush()
    expect(diagnosticPage(null).events.find((record) => record.operation === 'chain.failed')).toMatchObject({
      message: 'cause-0', cause: Array.from({ length: Math.min(length, 8) }, (_, i) => 'cause-' + (i + 1)), truncated: length > 8,
    })
  })

  it('loses the chain to flags a harness names like credentials until the test isolation removes them', () => {
    // Claude Code exports these to every command it runs.
    vi.stubEnv('CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', '1')
    vi.stubEnv('USE_STAGING_OAUTH', '0')
    vi.stubEnv('USE_LOCAL_OAUTH', '0')
    start()
    const recorded = (operation: string) => {
      diagnosticFailure(operation, new Error('cause-0', { cause: new Error('cause-1') }))
      loggingRuntime()!.flush()
      return diagnosticPage(null).events.find((record) => record.operation === operation)
    }
    expect(recorded('chain.harness')).toMatchObject({ message: 'cause-[redacted]', cause: ['cause-[redacted]'] })
    // As tests/home-isolation.ts removes them before any test runs.
    for (const name of credentialVariables(process.env)) vi.stubEnv(name, undefined)
    expect(recorded('chain.isolated')).toMatchObject({ message: 'cause-0', cause: ['cause-1'] })
  })

  it('marks a cyclic exception chain incomplete without repeating the outer error', () => {
    start()
    const inner = new Error('inner failure')
    const error = new Error('outer failure', { cause: inner })
    inner.cause = error
    diagnosticFailure('cyclic.failed', error)
    loggingRuntime()!.flush()
    expect(diagnosticPage(null).events.find((record) => record.operation === 'cyclic.failed')).toMatchObject({
      cause: ['inner failure'], truncated: true,
    })
  })

  it('retains exact process evidence without prompts, response artifacts or credentials', async () => {
    start()
    diagnosticFailure('provider.failed', Object.assign(new Error('provider rejection'), { stderr: 'fatal: exact cause\nAuthorization: Bearer opaque-secret', code: 7 }),
      { prompt: 'private-prompt', responses: ['private-response'], phase: 'launch', account: 'octocat' })
    loggingRuntime()!.flush()
    const page = diagnosticPage(null)
    const event = page.events.find((record) => record.operation === 'provider.failed')!
    expect(event).toMatchObject({ account: 'octocat', phase: 'launch', exitCode: 7, stderr: expect.stringContaining('fatal: exact cause'), context: { phase: 'launch' } })
    for (const secret of ['opaque-secret', 'private-prompt', 'private-response']) expect(JSON.stringify(page)).not.toContain(secret)
    expect(loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { account: 'octocat' })).total).toBe(1)
    expect(diagnosticPage(page.cursor).events.some((record) => record.id === event.id)).toBe(false)
    await stopLogging(); startLogging(); loggingRuntime()!.flush()
    expect(diagnosticPage(null).events.some((record) => record.id === event.id)).toBe(true)
  })

  it('captures actual command outcomes and excludes argv/stdout', async () => {
    start()
    await expect(runFile(process.execPath, ['-e', "process.stdout.write('private-output');process.stderr.write('precise stderr');process.exit(9)", 'private-argument'])).rejects.toThrow('Command failed')
    loggingRuntime()!.flush()
    const page = loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }))
    expect(page.events.some((event) => event.exitCode === 9 && event.stderr === 'precise stderr')).toBe(true)
    for (const value of ['private-output', 'private-argument']) expect(JSON.stringify(page)).not.toContain(value)
  })

  it.each(['head-sha', 'requested-changes-addressed'])('retains the %s child identity through nested scheduler contexts', async (primitive) => {
    start()
    vi.stubEnv('CALLER_BIN_ROOT', directory)
    writeFileSync(join(directory, 'github-interface'), `#!${process.execPath}\nprocess.stderr.write('precise probe failure');process.exit(1)`, { mode: 0o755 })
    const outer = { correlationId: 'a'.repeat(32), behavior: 'review-new-prs', repository: 'acme/repo', target: 'acme/repo#17', account: 'bot', phase: 'sweep' }
    const inner = { ...outer, phase: 'preparation', progress: { primitive, slot: 'secondary', expectedHead: 'b'.repeat(40) } }
    try {
      await withNoticeDiagnosticIdentity(outer, () => withNoticeDiagnosticIdentity(inner,
        () => runFile('github-interface', [`--${primitive}`, '#17'])))
      expect.fail('the child must fail')
    } catch (error) { diagnosticFailure('scheduler.review', error) }
    loggingRuntime()!.flush()
    const events = diagnosticPage(null).events.filter((event) => [
      `github-interface.${primitive}`, 'scheduler.review',
    ].includes(event.operation))
    expect(events).toHaveLength(2)
    for (const event of events) expect(event).toMatchObject({ correlationId: outer.correlationId, phase: 'preparation',
      target: outer.target, exitCode: 1, stderr: 'precise probe failure', context: { progress: inner.progress } })
  })

  it('keeps the sweep identity when a target attached to the shared sweep TimeoutError', async () => {
    start()
    const outer = { correlationId: 'a'.repeat(32), behavior: 'review-new-prs', repository: null, target: null, account: null, phase: 'preparation' }
    const inner = { ...outer, repository: 'acme/repo', target: 'acme/repo#17', account: 'bot',
      progress: { primitive: 'head-sha', slot: 'primary', expectedHead: null } }
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    try {
      await withNoticeDiagnosticIdentity(outer, () => withNoticeDiagnosticIdentity(inner,
        () => Promise.reject(timeout)))
      expect.fail('the sweep must time out')
    } catch (error) { diagnosticFailure('application.behaviors', error) }
    loggingRuntime()!.flush()
    const events = diagnosticPage(null).events.filter((event) => event.operation === 'application.behaviors')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ correlationId: outer.correlationId, phase: 'preparation',
      target: null, repository: null, account: null, context: { exceptionName: 'TimeoutError' } })
    expect(events[0]!.context.progress).toBeUndefined()
  })

  it('distinguishes a TimeoutError code from an actual subprocess exit with the same code', async () => {
    start()
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(timeout.code).toBe(23)
    diagnosticFailure('cycle.timeout', timeout)
    await expect(runFile(process.execPath, ['-e', 'process.exit(23)'])).rejects.toThrow('Command failed (23)')
    loggingRuntime()!.flush()
    const { events } = loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }))
    expect(events.find((event) => event.operation === 'cycle.timeout')).toMatchObject({
      exitCode: null, context: { exceptionName: 'TimeoutError', exceptionCode: 23 },
    })
    expect(events.find((event) => event.operation === process.execPath)).toMatchObject({ exitCode: 23 })
  })

  it.each([
    ['github-interface', 'error: GitHub 500: Internal Server Error', 'warning'],
    ['github-interface', 'httpx.ConnectError: connection reset', 'warning'],
    ['github-datastore', 'GraphQL request failed: HTTP 503', 'warning'],
    ['github-interface', 'error: GitHub 401: Bad credentials', 'error'],
    ['github-interface', 'error: GitHub 403: Resource not accessible', 'error'],
    ['github-datastore', 'datastore health stale: age 300s exceeds maximum 120s', 'error'],
    ['github-interface', 'fatal: No space left on device', 'error'],
    ['github-interface', '', 'error'],
  ])('retains %s failure evidence at %s (%s)', async (command, stderr, severity) => {
    start()
    writeFileSync(join(directory, command), `#!${process.execPath}\nprocess.stdout.write('private-output');process.stderr.write(${JSON.stringify(stderr)});process.exit(1)`, { mode: 0o755 })
    vi.stubEnv('CALLER_BIN_ROOT', directory)
    await expect(runFile(command, ['private-argument'])).rejects.toThrow('Command failed (1)')
    loggingRuntime()!.flush()
    const page = loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { source: 'poise' }))
    expect(page.events.find((event) => event.operation === command)).toMatchObject({ severity, exitCode: 1, stderr })
    for (const value of ['private-output', 'private-argument']) expect(JSON.stringify(page)).not.toContain(value)
  })

  it('bounds and redacts captured GitHub stderr without losing failure status', async () => {
    start()
    vi.stubEnv('CALLER_BIN_ROOT', directory)
    const stderr = 'error: GitHub 503: upstream unavailable\nAuthorization: Bearer private-api-credential\n' + 'detail\n'.repeat(4000)
    writeFileSync(join(directory, 'github-interface'), `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)});process.exit(1)`, { mode: 0o755 })
    await expect(runFile('github-interface', [])).rejects.toThrow('Command failed (1)')
    loggingRuntime()!.flush()
    const event = loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { source: 'poise' })).events.find((event) => event.operation === 'github-interface')!
    expect(event).toMatchObject({ exitCode: 1, truncated: true, stderr: expect.stringContaining('GitHub 503') })
    expect(Buffer.byteLength(event.stderr!)).toBeLessThanOrEqual(16_384)
    expect(JSON.stringify(event)).not.toContain('private-api-credential')
  })

  it('reports a failed sink independently and leaves source work operational', async () => {
    start(true)
    expect(() => diagnostic({ source: 'poise', level: 'error', operation: 'read', message: 'cause' })).not.toThrow()
    loggingRuntime()!.flush()
    expect(loggingRuntime()!.health().status).toBe('unavailable')
    await expect(runFile(process.execPath, ['-e', 'process.exit(0)'])).resolves.toMatchObject({ stdout: '' })
    expect(readFileSync(join(directory, 'logging.db.coverage.json'), 'utf8')).toContain('application')
    expect(loggingRuntime()!.health().queuedBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
  })
})


it('preserves a Critical crash record behind more than one queued batch', () => {
  start()
  for (let i = 0; i < 150; i++) diagnostic({ id: 'pending-' + i, source: 'poise', operation: 'pending.error', level: 'error', message: 'pending cause' })
  fatalDiagnostic(new Error('exact fatal cause'))
  const page = loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { severities: ['critical'] }))
  expect(page.total).toBe(1); expect(page.events[0].message).toBe('exact fatal cause')
})

it('keeps application startup operational when its Caller checkpoint cannot be read', () => {
  directory = mkdtempSync(join(tmpdir(), 'poise-logging-checkpoint-'))
  mkdirSync(join(directory, 'logging.db.caller'))
  vi.stubEnv('POISE_DB', join(directory, 'cache.db'))
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  expect(() => startLogging()).not.toThrow()
  expect(loggingRuntime()!.health().sources.some((source) => source.source === 'caller' && source.error)).toBe(true)
})

it('checkpoints Caller completions after quarantining evidence above the local storage budget', async () => {
  const run = vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), cursor: 3, hasMore: false, backfillPending: false,
    events: [{ id: 'a'.repeat(32), error: 'source failure', diagnostic: { version: 1, severity: 'error', stderr: 'x'.repeat(16000) } }, { id: 'b'.repeat(32), error: 'later precise cause' }] }), stderr: '' })
  vi.stubEnv('POISE_LOG_MAX_BYTES', '8192')
  vi.stubEnv('POISE_LOG_QUEUE_EVENTS', '1')
  start()
  vi.mocked(process.stderr.write).mockImplementation(() => { throw new Error('fixture forwarding unavailable') })
  await vi.waitFor(() => expect(JSON.parse(readFileSync(join(directory, 'logging.db.caller'), 'utf8'))).toMatchObject({ streamId: 'a'.repeat(32), cursor: 3 }), { timeout: 5000 })
  expect(run).toHaveBeenCalledWith('agent-interface', ['--diagnostics', '0', '3'], expect.any(Object))
  expect(loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false })).events.some((event) => event.message === 'later precise cause')).toBe(true)
  expect(loggingRuntime()!.health().rejected).toBeGreaterThan(0)
})

it('preserves the Caller checkpoint on sink failure and durably accepts its replay before recovery', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), cursor: 3,
    hasMore: false, backfillPending: false, events: [{ id: 'b'.repeat(32), error: 'replayed Caller cause' }] }), stderr: '' })
  start()
  loggingRuntime()!.query(() => undefined)
  const control = new Database(join(directory, 'logging.db'))
  try {
    control.exec("CREATE TRIGGER fail_caller BEFORE INSERT ON log_events WHEN NEW.source='caller' BEGIN SELECT RAISE(FAIL, 'fixture durable sink unavailable'); END")
    for (let i = 0; i < 150; i++) diagnostic({ id: 'pending-' + i, level: 'error', operation: 'pending.failure', message: 'pending cause' })
    await vi.waitFor(() => expect(loggingRuntime()!.health().sources.find(source => source.id === 'caller')?.error).toContain('checkpoint waits for durable ingestion'))
    expect(() => readFileSync(join(directory, 'logging.db.caller'))).toThrow()
    expect(loggingRuntime()!.query(db => db.query({ workspace: 'alice', operator: false }, { source: 'caller' })).total).toBe(0)
    control.exec('DROP TRIGGER fail_caller')
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(() => {
      expect(loggingRuntime()!.health().sources.find(source => source.id === 'caller')?.error).toBeNull()
      expect(JSON.parse(readFileSync(join(directory, 'logging.db.caller'), 'utf8')).cursor).toBe(3)
    })
    expect(loggingRuntime()!.query(db => db.query({ workspace: 'alice', operator: false }, { source: 'caller' })).events).toEqual([
      expect.objectContaining({ message: 'replayed Caller cause' }),
    ])
    expect(loggingRuntime()!.health().sources.find(source => source.id === 'caller')).toMatchObject({
      status: 'partial', currentStatus: 'connected', error: null, gaps: [expect.objectContaining({ to: expect.any(String) })],
    })
  } finally { await stopLogging(); control.close(); vi.useRealTimers() }
})

it('redacts bare encoded and decoded Git credentials supplied only through command-specific configuration', async () => {
  start()
  const secret = 'git-overlay-private-credential'
  const encoded = Buffer.from('x-access-token:' + secret).toString('base64')
  await expect(runFile(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(encoded + '\n' + secret)});process.exit(9)`],
    { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: Basic ' + encoded } })).rejects.toThrow('Command failed')
  loggingRuntime()!.flush()
  const page = loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }))
  expect(page.events.some((event) => event.exitCode === 9 && event.stderr?.includes('[redacted]'))).toBe(true)
  for (const value of [secret, encoded]) expect(JSON.stringify(page)).not.toContain(value)
})

it('preserves recorded source identity and explicit unknowns during historical Caller backfill', () => {
  vi.stubEnv('POISE_RELEASE', 'current-release'); vi.stubEnv('HOSTNAME', 'current-container')
  start()
  diagnostic({ id: 'old-source', source: 'caller', level: 'error', operation: 'source.identity', message: 'old cause', instance: 'old-instance', container: 'old-container', release: 'old-release' })
  diagnostic({ id: 'unknown-source', source: 'caller', level: 'error', operation: 'source.identity', message: 'unknown cause', instance: null, container: null, release: null })
  loggingRuntime()!.flush()
  const events = loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { source: 'caller' })).events
  expect(events.find((event) => event.message === 'old cause')).toMatchObject({ instance: 'old-instance', container: 'old-container', release: 'old-release' })
  expect(events.find((event) => event.message === 'unknown cause')).toMatchObject({ instance: null, container: null, release: null })
})

it('closes the active forwarding outage after a subsequent successful write', () => {
  start()
  const length = vi.spyOn(process.stderr, 'writableLength', 'get').mockReturnValue(256 * 1024)
  diagnostic({ level: 'error', operation: 'forward.first', message: 'first cause' })
  expect(loggingRuntime()!.health().sources.find((source) => source.id === 'forwarding')?.error).toContain('backpressured')
  length.mockReturnValue(0)
  diagnostic({ level: 'error', operation: 'forward.recovered', message: 'next cause' })
  const source = loggingRuntime()!.health().sources.find((source) => source.id === 'forwarding')!
  expect(source.error).toBeNull(); expect(source.gaps.every((gap) => gap.to !== null)).toBe(true)
})

it('isolates synchronous and native stderr transport failures from application work', async () => {
  start()
  const write = vi.mocked(process.stderr.write)
  write.mockImplementationOnce(() => { throw new Error('fixture writer failed') })
  expect(diagnostic({ level: 'error', operation: 'write.failure', message: 'source cause' })).toEqual(expect.any(String))
  expect(loggingRuntime()!.health().sources.some((source) => source.id === 'capture' && source.error)).toBe(true)
  expect(() => process.stderr.emit('error', Object.assign(new Error('fixture pipe closed'), { code: 'EPIPE' }))).not.toThrow()
  expect(loggingRuntime()!.health().sources.find((source) => source.id === 'forwarding')?.error).toContain('EPIPE')
  await expect(runFile(process.execPath, ['-e', 'process.exit(0)'])).resolves.toMatchObject({ stdout: '' })
  loggingRuntime()!.flush()
  expect(loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { search: 'source cause' })).total).toBe(1)
})


it('resets a saved Caller cursor when its database identity changes and retains low new completions', async () => {
  const firstStream = 'a'.repeat(32); const secondStream = 'b'.repeat(32)
  const run = vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId: firstStream, cursor: 100, events: [], hasMore: false, backfillPending: false }), stderr: '' })
  const checkpoint = () => JSON.parse(readFileSync(join(directory, 'logging.db.caller'), 'utf8')) as { streamId: string; cursor: number }
  start(); await vi.waitFor(() => expect(checkpoint()).toMatchObject({ streamId: firstStream, cursor: 100 })); await stopLogging()
  run.mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId: secondStream, cursor: 100, events: [], hasMore: false, backfillPending: false }), stderr: '' })
  startLogging(); await vi.waitFor(() => expect(checkpoint()).toMatchObject({ streamId: secondStream, cursor: 0 })); await stopLogging()
  run.mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId: secondStream, cursor: 1, events: [{ id: 'c'.repeat(32), error: 'new database precise cause' }], hasMore: false, backfillPending: false }), stderr: '' })
  startLogging(); await vi.waitFor(() => expect(checkpoint()).toMatchObject({ streamId: secondStream, cursor: 1 }))
  expect(run).toHaveBeenLastCalledWith('agent-interface', ['--diagnostics', '0', '3'], expect.any(Object))
  expect(loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false })).events.some((event) => event.message === 'new database precise cause')).toBe(true)
  expect(loggingRuntime()!.health().sources.find((source) => source.id === 'caller')?.gaps.length).toBeGreaterThan(0)
})

it('replays a legacy unbound Caller checkpoint instead of applying it to an unknown database', async () => {
  directory = mkdtempSync(join(tmpdir(), 'poise-legacy-caller-'))
  vi.stubEnv('POISE_DB', join(directory, 'cache.db')); writeFileSync(join(directory, 'logging.db.caller'), '100')
  const run = vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId: 'd'.repeat(32), cursor: 0, events: [], hasMore: false, backfillPending: false }), stderr: '' })
  vi.spyOn(process.stderr, 'write').mockReturnValue(true); startLogging()
  await vi.waitFor(() => expect(JSON.parse(readFileSync(join(directory, 'logging.db.caller'), 'utf8'))).toMatchObject({ streamId: 'd'.repeat(32), cursor: 0 }))
  expect(run).toHaveBeenCalledWith('agent-interface', ['--diagnostics', '0', '3'], expect.any(Object))
})


it('retains the first Caller ingestion time without requiring another failure', async () => {
  const streamId = 'e'.repeat(32)
  const base = { version: 1, streamId, cursor: 1, hasMore: false, backfillPending: false }
  const run = vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ ...base, events: [] }), stderr: '' })
    .mockResolvedValueOnce({ stdout: JSON.stringify({ ...base, events: [{ id: 'f'.repeat(32), error: 'first precise Caller cause' }] }), stderr: '' })
  start()
  await vi.waitFor(() => expect(JSON.parse(readFileSync(join(directory, 'logging.db.caller'), 'utf8')).cursor).toBe(1))
  const ingestedAt = loggingRuntime()!.health().sources.find((source) => source.id === 'caller')?.ingestedAt
  expect(ingestedAt).toEqual(expect.any(String))
  expect(loggingRuntime()!.query((db) => db.readCoverage({ workspace: 'alice', operator: false })).find((source) => source.id === 'caller')?.ingestedAt).toBe(ingestedAt)
  await stopLogging(); startLogging()
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  expect(loggingRuntime()!.health().sources.find((source) => source.id === 'caller')?.ingestedAt).toBe(ingestedAt)
  expect(loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { source: 'caller' })).total).toBe(1)
})

it('retains failed Caller verdict rows before acknowledging their completion page', async () => {
  const streamId = '7'.repeat(32)
  const base = { version: 1, streamId, cursor: 3, hasMore: false, backfillPending: false }
  const events = ['changes_requested', 'clean', 'approved'].map((outcome, i) => ({
    id: String(i + 1).repeat(32), status: 'failed', outcome, diagnostic: null, behavior: 'review', error: 'Receipt validation failed for ' + outcome,
  }))
  const run = vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ ...base, events: [] }), stderr: '' })
    .mockResolvedValueOnce({ stdout: JSON.stringify({ ...base, events }), stderr: '' })
  start()
  await vi.waitFor(() => expect(JSON.parse(readFileSync(join(directory, 'logging.db.caller'), 'utf8'))).toMatchObject({ streamId, cursor: 3 }))
  const retained = () => loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { source: 'caller' })).events
  expect(retained()).toHaveLength(3)
  for (const event of events) expect(retained()).toContainEqual(expect.objectContaining({
    callId: event.id, severity: 'error', message: event.error, context: expect.objectContaining({ outcome: event.outcome, evidenceIncomplete: true }),
  }))
  await stopLogging(); startLogging()
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  expect(run).toHaveBeenLastCalledWith('agent-interface', ['--diagnostics', '3', '3'], expect.any(Object))
  expect(retained()).toHaveLength(3)
})

it('acknowledges empty Caller operation metadata and continues with later completions', async () => {
  const streamId = '8'.repeat(32)
  const run = vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId, cursor: 3, hasMore: false, backfillPending: false,
    events: [{ id: '4'.repeat(32), behavior: 'review', error: 'empty operation cause', diagnostic: { version: 1, operation: '' } },
      { id: '5'.repeat(32), behavior: '', error: 'empty behavior cause', diagnostic: { version: 1, operation: '' } },
      { id: '6'.repeat(32), error: 'later completion cause' }] }), stderr: '' })
  start()
  await vi.waitFor(() => expect(JSON.parse(readFileSync(join(directory, 'logging.db.caller'), 'utf8'))).toMatchObject({ streamId, cursor: 3 }))
  const records = loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { source: 'caller' })).events
  expect(records).toHaveLength(3)
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ message: 'empty operation cause', operation: 'review' }),
    expect.objectContaining({ message: 'empty behavior cause', operation: 'call.failed' }),
    expect.objectContaining({ message: 'later completion cause' }),
  ]))
  await stopLogging(); startLogging()
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  expect(run).toHaveBeenLastCalledWith('agent-interface', ['--diagnostics', '3', '3'], expect.any(Object))
  expect(loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { source: 'caller' })).total).toBe(3)
})


it.each([{ hasMore: true, backfillPending: false }, { hasMore: false, backfillPending: true }, { hasMore: true, backfillPending: true }])('clears pending Caller coverage without inventing loss for %j', async (pending) => {
  const base = { version: 1, streamId: '9'.repeat(32), cursor: 1 }
  const run = vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ ...base, ...pending,
    events: [{ id: '1'.repeat(32), error: 'retained precise cause' }] }), stderr: '' })
  start()
  await vi.waitFor(() => expect(JSON.parse(readFileSync(join(directory, 'logging.db.caller'), 'utf8')).cursor).toBe(1))
  expect(loggingRuntime()!.health().sources.find((source) => source.id === 'caller')).toMatchObject({ status: 'partial', gaps: [] })
  expect(loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { source: 'collection', search: 'Caller historical backfill' })).total).toBe(0)
  await stopLogging()
  run.mockResolvedValue({ stdout: JSON.stringify({ ...base, hasMore: false, backfillPending: false, events: [] }), stderr: '' })
  startLogging()
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  loggingRuntime()!.flush()
  expect(loggingRuntime()!.health().sources.find((source) => source.id === 'caller')).toMatchObject({ status: 'connected', error: null, gaps: [] })
  expect(loggingRuntime()!.query((db) => db.readCoverage({ workspace: 'alice', operator: false })).find((source) => source.id === 'caller')).toMatchObject({ status: 'connected', error: null, gaps: [] })
  expect(loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false }, { source: 'caller' })).total).toBe(1)
})

it('delivers current recovered observation independently of historical coverage through the actual producer', async () => {
  vi.stubEnv('POISE_MODE', 'service')
  vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId: 'd'.repeat(32), cursor: 0, hasMore: false, backfillPending: false, events: [] }), stderr: '' })
  start()
  await vi.waitFor(() => expect(loggingRuntime()!.health().sources.find((source) => source.source === 'caller')?.currentStatus).toBe('connected'))
  const runtime = loggingRuntime()!
  runtime.observe('application', 'poise', 'alice', 'previous transport failure'); runtime.flush()
  runtime.observe('application', 'poise', 'alice'); runtime.flush()
  const page = diagnosticPage(null)
  expect(page.coverage).toMatchObject({ status: 'partial', currentStatus: 'connected' })
  expect(page.coverage.sources.find((source) => source.source === 'poise')).toMatchObject({ status: 'partial', currentStatus: 'connected' })
  expect(runtime.health().sources.find((source) => source.source === 'poise')?.gaps).toHaveLength(1)
  runtime.partial('caller', 'caller', 'alice', 'Backfill pending')
  expect(diagnosticPage(null).coverage.currentStatus).toBe('partial')
})
