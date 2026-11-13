import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CheckSemaphore } from '../server/check-semaphore'
import type { RunFileOptions } from '../server/process'
import { completedReviewCall } from './review-response-fixture'
import { arrangeCli, fixture, HEAD_SHA, NEXT_HEAD_SHA, loadModules, mocks, pr } from './behaviors-runtime-fixture'

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

async function startReviewCheck(phase: string, primitive: string, slot = 'secondary') {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T18:00:00Z'))
  arrangeCli(false)
  fixture.listedPrs = [pr, { ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` }]
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
  loaded.database.setMeta('behavior_review_new_prs_enabled', '1')
  loaded.database.setMeta('behavior_review_new_prs_reviewers', '3')
  loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
  loaded.behaviors.setBehaviorCheckSlots(new CheckSemaphore(() => 64))
  loaded.behaviors.startBehaviorsRuntime()
  vi.stubEnv('CALLER_BIN_ROOT', fixture.tempRoot)
  writeFileSync(join(fixture.tempRoot, 'github-interface'), `#!${process.execPath}
process.stdout.write('private-output')
process.stderr.write('delayed review check\\nAuthorization: Bearer private-credential')
setInterval(() => {}, 1000)
`, { mode: 0o700 })
  const { diagnosticIdentity } = await import('../server/logging-context')
  const checks: Array<{ correlationId: string; phase: string; slot: string; expectedHead: unknown }> = []
  const state = { failures: 2, head: HEAD_SHA, onFailure: undefined as (() => void) | undefined }
  const original = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, args: string[], options: RunFileOptions) => {
    if (command === 'agent-interface' && args[0] === '--diagnostics') return {
      stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '',
    }
    const context = diagnosticIdentity()
    if (command === 'github-interface' && args[0] === `--${primitive}` && args[1] === `#${pr.number}`
      && context?.phase === phase && context.progress?.slot === slot && state.failures > 0) {
      expect(options.timeoutMs).toBe(30_000)
      checks.push({ correlationId: context.correlationId, phase, slot, expectedHead: context.progress.expectedHead })
      state.failures--
      try { return await mocks.realRunFile!(command, args, { ...options, timeoutMs: 500 }) }
      catch (error) { state.onFailure?.(); throw error }
    }
    const result = await original(command, args, options)
    if (command === 'github-interface' && ['--head-sha', '--requested-changes-addressed'].includes(args[0])) {
      return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), head_sha: state.head }) }
    }
    return result
  })
  logging = await import('../server/logging')
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  logging.startLogging()
  return { ...loaded, state, checks, checkTarget: `${TARGET}${slot === 'primary' ? '' : `:${slot}`}:check` }
}

it.each([
  ['preparation', 'head-sha', null],
  ['preparation', 'requested-changes-addressed', HEAD_SHA],
  ['revalidation', 'head-sha', HEAD_SHA],
])('identifies delayed %s %s checks and retries the current head once per admitted slot', async (phase, primitive, expectedHead) => {
  const { database, behaviors, state, checks, checkTarget } = await startReviewCheck(phase!, primitive!)
  const launches = () => mocks.spawnDetached.mock.calls.map(([, args]) => args as string[])
  for (let attempt = 0; attempt < 2; attempt++) {
    await behaviors.runEnabledBehaviorsOnce()
    // The failed secondary never launches; its two siblings and the other PR's full panel do.
    expect(launches().filter((args) => args.includes('#17'))).toHaveLength(2)
    expect(launches().filter((args) => args.includes('#18'))).toHaveLength(3)
    const retry = behaviors.getBehaviorFailureState('review-new-prs', checkTarget)!
    const recorded = events()
    expect(recorded).toHaveLength(attempt + 1)
    expect(recorded[0]!.id).not.toBe(recorded[1]?.id)
    expect(new Set(recorded.map((event) => event.incidentId)).size).toBe(1)
    expect(new Set(recorded.map((event) => event.correlationId)).size).toBe(attempt + 1)
    expect(recorded[0]!.stderr).not.toContain('private-credential')
    expect(JSON.stringify(recorded)).not.toContain('private-output')
    const latest = recorded.find((event) => event.correlationId === checks.at(-1)!.correlationId)!
    expect(latest).toMatchObject({ operation: `github-interface.${primitive}`, severity: 'error',
      behavior: 'review-new-prs', target: TARGET, repository: pr.repo, account: 'review-bot', phase,
      timeoutMs: 30_000, exitCode: null, signal: 'SIGKILL', stderr: expect.stringContaining('delayed review check'),
      context: { primitive, slot: 'secondary', expectedHead, killed: true, retry: { nextRetryAt: retry.nextRetryAt } },
    })
    expect(checks.at(-1)).toMatchObject({ expectedHead, correlationId: retry.correlationId })
    expect(database.listBehaviorLaunchClaims('review-new-prs').some((claim) => claim.target === checkTarget.slice(0, -6))).toBe(false)
    if (phase === 'revalidation') expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: retry.correlationId, outcome: 'preflight_failed', state: 'failed', activity: 'settled',
    }))
    vi.setSystemTime(new Date(Date.parse(retry.nextRetryAt) - 1))
    await behaviors.runEnabledBehaviorsOnce()
    expect(checks).toHaveLength(attempt + 1)
    expect(launches()).toHaveLength(5)
    expect(events()).toHaveLength(attempt + 1)
    vi.setSystemTime(new Date(retry.nextRetryAt))
  }
  state.head = NEXT_HEAD_SHA
  await behaviors.runEnabledBehaviorsOnce()
  expect(launches()).toHaveLength(6)
  expect(launches().at(-1)).toEqual(expect.arrayContaining(['#17', '--expected-head', NEXT_HEAD_SHA, '--model', 'gpt-6-astra-ultra']))
  expect(behaviors.getBehaviorFailureState('review-new-prs', checkTarget)).toBeNull()
  await behaviors.runEnabledBehaviorsOnce()
  expect(launches()).toHaveLength(6)
})

it.each(['preparation', 'revalidation'])('retains a confirmed %s child timeout through cancellation', async (phase) => {
  const { behaviors, state } = await startReviewCheck(phase, 'head-sha', 'primary')
  let stopping: Promise<void> | undefined
  state.onFailure = () => { stopping = behaviors.stopBehaviorsRuntime() }
  await behaviors.runEnabledBehaviorsOnce()
  await stopping
  const recorded = events()
  expect(recorded.filter((event) => event.operation === 'github-interface.head-sha')).toEqual([expect.objectContaining({ severity: 'error', phase,
    signal: 'SIGKILL', stderr: expect.stringContaining('delayed review check'), context: expect.objectContaining({ retry: null }) })])
  for (const event of recorded.filter((event) => event.operation !== 'github-interface.head-sha')) {
    expect(event.context.exceptionName).toBe('AbortError')
  }
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})

it('retains the original revalidation failure and retry when ledger bookkeeping throws', async () => {
  const { behaviors, checkTarget } = await startReviewCheck('revalidation', 'head-sha')
  mocks.captureOutcome.mockImplementation((value) => {
    if (value.outcome === 'preflight_failed') throw new Error('review ledger bookkeeping rejected')
  })
  await behaviors.runEnabledBehaviorsOnce()
  const retry = behaviors.getBehaviorFailureState('review-new-prs', checkTarget)!
  expect(events().filter((event) => event.operation === 'github-interface.head-sha')).toEqual([
    expect.objectContaining({ severity: 'error', signal: 'SIGKILL', stderr: expect.stringContaining('delayed review check'),
      context: expect.objectContaining({ retry: expect.objectContaining({ nextRetryAt: retry.nextRetryAt }) }) }),
  ])
  expect(events().some((event) => event.message === 'review ledger bookkeeping rejected')).toBe(true)
})

it('keeps bookkeeping errors after a successful revalidation separate from child failures', async () => {
  const { behaviors, state } = await startReviewCheck('revalidation', 'head-sha')
  state.failures = 0
  const { diagnosticIdentity } = await import('../server/logging-context')
  const original = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, args: string[], options: RunFileOptions) => {
    const result = await original(command, args, options)
    if (args[0] === '--head-sha' && diagnosticIdentity()?.phase === 'revalidation') {
      return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), head_sha: NEXT_HEAD_SHA }) }
    }
    return result
  })
  mocks.captureOutcome.mockImplementation((value) => {
    if (value.outcome === 'no_op') throw new Error('head deferral bookkeeping rejected')
  })
  await behaviors.runEnabledBehaviorsOnce()
  expect(events().some((event) => event.message === 'head deferral bookkeeping rejected')).toBe(true)
  expect(events().some((event) => event.operation === 'github-interface.head-sha')).toBe(false)
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})
