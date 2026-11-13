import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunFileOptions } from '../server/process'
import { completedReviewCall } from './review-response-fixture'
import { arrangeCli, fixture, HEAD_SHA, loadModules, mocks, pr } from './behaviors-runtime-fixture'

let logging: typeof import('../server/logging') | null = null
afterEach(async () => { await logging?.stopLogging(); logging = null; vi.unstubAllEnvs() })

const RESOLVE = 'resolve-nonblocking-conversations-if-ready'
const TARGET = `${pr.repo}#${pr.number}`
const CHECK = `${TARGET}:check`
const MARKER = ' (no conversation was resolved before this failure)'
const LIMIT = 'error: GitHub 403: You have exceeded a secondary rate limit. retry-after: 300'

async function start(primitive = RESOLVE, script = "setInterval(() => {}, 1000)", timeout = false) {
  arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
  const { database, behaviors } = await loadModules()
  const behavior = primitive === RESOLVE ? 'resolve-unblocking' : 'merge-prs'
  behaviors.startBehaviorsRuntime()
  database.setMeta('me', 'poise-user')
  database.setMeta(`behavior_${behavior.replaceAll('-', '_')}_enabled`, '1')
  fixture.agentLogs = [{ ...completedReviewCall(pr.repo, pr.number, HEAD_SHA, 'review-bot') }]
  vi.stubEnv('CALLER_BIN_ROOT', fixture.tempRoot)
  writeFileSync(join(fixture.tempRoot, 'github-interface'), `#!${process.execPath}\n${script}\n`, { mode: 0o700 })
  const original = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation((command: string, args: string[], options: RunFileOptions) => {
    if (command === 'github-interface' && args[0] === `--${primitive}`) {
      return mocks.realRunFile!(command, args, timeout ? { ...options, timeoutMs: 500 } : options)
    }
    if (command === 'github-interface' && args[0] === '--merge-candidates') return Promise.resolve({
      stdout: JSON.stringify({ action: 'merge_candidates', actor: 'review-bot', graphql_cost: 1, records: [{
        repository: pr.repo, number: pr.number, head_sha: HEAD_SHA, author: pr.author,
        ready: primitive !== 'update-branch-if-behind', behind: primitive === 'update-branch-if-behind',
        approved_at: '2026-10-22T00:00:00Z', queue_entry_id: null, error: null,
      }] }), stderr: '',
    })
    if (command === 'agent-interface' && args[0] === '--diagnostics') return Promise.resolve({
      stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '',
    })
    return original(command, args, options)
  })
  logging = await import('../server/logging')
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  logging.startLogging()
  return { database, behaviors }
}

function failureScript(stderr: string): string {
  return `process.stdout.write('private-output'); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1`
}

function events() {
  const runtime = logging!.loggingRuntime()!
  while (runtime.health().queued) expect(runtime.flush()).toBe(true)
  return runtime.query((store) => store.query({ workspace: logging!.loggingWorkspace(), operator: false }, { limit: 100 })).events
}

it('persists one Error per real timeout and distinguishes identical attempts in the same incident', async () => {
  const { database, behaviors } = await start(RESOLVE, undefined, true)
  await behaviors.runEnabledBehaviorsOnce()
  expect(events()).toHaveLength(1)
  for (const prefix of ['failure', 'recovery']) {
    const key = `behavior_resolve_unblocking_${prefix}:${CHECK}`
    database.setMeta(key, JSON.stringify({ ...JSON.parse(database.getMeta(key)!), nextRetryAtMs: 1 }))
  }
  await behaviors.runEnabledBehaviorsOnce()
  const recorded = events()
  const admissions = mocks.captureAdmission.mock.calls.map(([value]) => value)
  expect(recorded).toHaveLength(2)
  expect(new Set(recorded.map((event) => event.id)).size).toBe(2)
  expect(new Set(recorded.map((event) => event.incidentId)).size).toBe(1)
  expect(new Set(recorded.map((event) => event.correlationId))).toEqual(new Set(admissions.map((value) => value.nativeId)))
  for (const event of recorded) expect(event).toMatchObject({
    operation: `github-interface.${RESOLVE}`, behavior: 'resolve-unblocking', repository: pr.repo, target: TARGET,
    severity: 'error', phase: 'command', exitCode: null, signal: 'SIGKILL', timeoutMs: 30_000,
    context: { primitive: RESOLVE, nativeId: event.correlationId, killed: true, safeRetry: false, sideEffects: 'uncertain' },
  })
  expect(mocks.captureOutcome.mock.calls.map(([value]) => value.state)).toEqual(['held', 'held'])
  const runs = database.db.prepare('SELECT status, note FROM behavior_runs').all() as Array<{ status: string, note: string }>
  expect(runs).toHaveLength(2)
  expect(runs.every((run) => run.status === 'failed' && run.note.includes('side_effects=uncertain'))).toBe(true)
})

it.each([true, false])('uses Warning only with original no-action proof and recorded safe retry (marked=%s)', async (marked) => {
  const { database, behaviors } = await start(RESOLVE, failureScript(LIMIT + (marked ? MARKER : '')))
  await behaviors.runEnabledBehaviorsOnce()
  const failure = JSON.parse(database.getMeta(`behavior_resolve_unblocking_failure:${CHECK}`)!)
  const recovery = JSON.parse(database.getMeta(`behavior_resolve_unblocking_recovery:${CHECK}`)!)
  expect(events()).toEqual([expect.objectContaining({ severity: marked ? 'warning' : 'error', exitCode: 1,
    stderr: LIMIT + (marked ? MARKER : ''), correlationId: recovery.nativeId,
    context: expect.objectContaining({ safeRetry: marked, recovery: { code: 'rate_limit', nextRetryAtMs: failure.nextRetryAtMs,
      sideEffects: marked ? 'none' : 'uncertain' } }),
  })])
  expect(recovery.nextRetryAtMs).toBeGreaterThan(failure.lastFailureAtMs)
  expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({ nativeId: recovery.nativeId,
    state: marked ? 'failed' : 'held', activity: marked ? 'settled' : 'unknown' }))
})

it.each(['merge-if-ready', 'update-branch-if-behind'])('persists one policy refusal with original process evidence for %s', async (primitive) => {
  const stderr = 'error: GitHub 405: Merge method is not allowed\nAuthorization: Bearer private-credential\n' + 'detail\n'.repeat(4000)
  const { database, behaviors } = await start(primitive, failureScript(stderr))
  await behaviors.runEnabledBehaviorsOnce()
  const admission = mocks.captureAdmission.mock.calls[0]![0]
  expect(events()).toEqual([expect.objectContaining({ operation: `github-interface.${primitive}`, severity: 'error',
    behavior: 'merge-prs', target: TARGET, account: 'review-bot', phase: 'command', exitCode: 1, signal: null,
    correlationId: admission.nativeId, truncated: true, stderr: expect.stringContaining('GitHub 405'),
    context: expect.objectContaining({ primitive, nativeId: admission.nativeId, retry: expect.objectContaining({ nextRetryAt: expect.any(String) }) }),
  })])
  expect(Buffer.byteLength(events()[0]!.stderr!)).toBeLessThanOrEqual(16_384)
  for (const secret of ['private-credential', 'private-output']) expect(JSON.stringify(events())).not.toContain(secret)
  expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({ nativeId: admission.nativeId, state: 'unknown', activity: 'unknown' }))
  expect(database.db.prepare('SELECT status, note FROM behavior_runs WHERE id = ?').get(admission.nativeId))
    .toMatchObject({ status: 'failed', note: expect.stringContaining(`op=${primitive}`) })
})

it.each([RESOLVE, 'merge-if-ready'])('retains unverified successful command output as a validation Error (%s)', async (primitive) => {
  const { behaviors } = await start(primitive, "process.stdout.write('{}')")
  await behaviors.runEnabledBehaviorsOnce()
  expect(events()).toEqual([expect.objectContaining({ severity: 'error', phase: 'validation', exitCode: null,
    operation: `github-interface.${primitive}`, target: TARGET })])
})

it('retains the original command failure when recovery bookkeeping independently throws', async () => {
  const { behaviors } = await start(RESOLVE, failureScript(LIMIT + MARKER))
  mocks.captureOutcome.mockImplementationOnce(() => { throw new Error('ledger bookkeeping rejected') })
  await behaviors.runEnabledBehaviorsOnce()
  const recorded = events()
  expect(recorded.filter((event) => event.operation === `github-interface.${RESOLVE}`)).toEqual([
    expect.objectContaining({ severity: 'error', exitCode: 1, stderr: LIMIT + MARKER }),
  ])
  expect(recorded.some((event) => event.message === 'ledger bookkeeping rejected')).toBe(true)
})

it('retains an independent wrapper failure after a validated command', async () => {
  const { behaviors } = await start()
  const original = mocks.runFile.getMockImplementation()!
  arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA, resolveResolvedCount: 1 })
  const successful = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation((command: string, args: string[], options: RunFileOptions) =>
    args[0] === `--${RESOLVE}` ? successful(command, args, options) : original(command, args, options))
  mocks.captureOutcome.mockImplementationOnce(() => { throw new Error('outcome observer failed') })
  await behaviors.runEnabledBehaviorsOnce()
  expect(events()).toEqual([expect.objectContaining({ message: 'outcome observer failed', severity: 'error',
    phase: 'bookkeeping', exitCode: null, target: TARGET })])
})

it('retains the failed command through cancellation before the outer log point', async () => {
  const { database, behaviors } = await start(RESOLVE, failureScript(LIMIT + MARKER))
  const original = mocks.runFile.getMockImplementation()!
  let stopping: Promise<void> | undefined
  mocks.runFile.mockImplementation(async (command: string, args: string[], options: RunFileOptions) => {
    try { return await original(command, args, options) }
    catch (error) { stopping = behaviors.stopBehaviorsRuntime(); throw error }
  })
  await behaviors.runEnabledBehaviorsOnce()
  await stopping
  expect(events()).toEqual([expect.objectContaining({ severity: 'error', exitCode: 1, stderr: LIMIT + MARKER,
    context: expect.objectContaining({ safeRetry: false }) })])
  expect(JSON.parse(database.getMeta(`behavior_resolve_unblocking_recovery:${CHECK}`)!))
    .toMatchObject({ sideEffects: 'none', nativeId: events()[0]!.correlationId })
})
