import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnostic, diagnosticFailure, diagnosticPage, fatalDiagnostic, loggingRuntime, startLogging, stopLogging } from '../server/logging'
import { runFile } from '../server/process'
import * as processes from '../server/process'

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
  await vi.waitFor(() => expect(JSON.parse(readFileSync(join(directory, 'logging.db.caller'), 'utf8'))).toMatchObject({ streamId: 'a'.repeat(32), cursor: 3 }))
  expect(run).toHaveBeenCalledWith('agent-interface', ['--diagnostics', '0', '3'], expect.any(Object))
  expect(loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false })).events.some((event) => event.message === 'later precise cause')).toBe(true)
  expect(loggingRuntime()!.health().rejected).toBeGreaterThan(0)
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
