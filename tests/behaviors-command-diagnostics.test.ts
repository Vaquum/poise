import { mkdirSync, writeFileSync } from 'node:fs'
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
const APPROVAL_CHECKS = [
  ['requested-changes-addressed', 'changes-addressed'],
  ['review-activity-since', 'review-activity'],
  ['head-sha', 'head-check'],
  ['local-checkout-path', 'checkout'],
  ['checkout-repo', 'checkout'],
] as const

async function start(primitive = RESOLVE, script = "setInterval(() => {}, 1000)", timeout = false) {
  const approval = APPROVAL_CHECKS.some(([check]) => check === primitive)
  if (approval) arrangeCli(true)
  else arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
  const { database, behaviors } = await loadModules()
  const behavior = approval ? 'approve-prs' : primitive === RESOLVE ? 'resolve-unblocking' : 'merge-prs'
  behaviors.startBehaviorsRuntime()
  database.setMeta('me', 'poise-user')
  database.setMeta(`behavior_${behavior.replaceAll('-', '_')}_enabled`, '1')
  fixture.agentLogs = [{ ...completedReviewCall(pr.repo, pr.number, HEAD_SHA, 'review-bot') }]
  vi.stubEnv('CALLER_BIN_ROOT', fixture.tempRoot)
  const missingCheckout = primitive === 'checkout-repo'
    ? "if (process.argv[2] === '--local-checkout-path') { process.stderr.write('error: checkout not found under /fake/dev: ' + process.argv[3] + '/' + process.argv[4] + '\\n'); process.exit(1) }\n"
    : ''
  writeFileSync(join(fixture.tempRoot, 'github-interface'), `#!${process.execPath}\n${missingCheckout}${script}\n`, { mode: 0o700 })
  const original = mocks.runFile.getMockImplementation()!
  let failing = true
  mocks.runFile.mockImplementation((command: string, args: string[], options: RunFileOptions) => {
    if (primitive === 'checkout-repo' && command === 'github-interface' && args[0] === '--local-checkout-path') {
      return mocks.realRunFile!(command, args, options)
    }
    if (failing && command === 'github-interface' && args[0] === `--${primitive}`) {
      return mocks.realRunFile!(command, args, timeout ? { ...options, timeoutMs: 500 } : options)
    }
    if (primitive === 'checkout-repo') {
      if (command === 'github-interface' && args[0] === '--checkout-repo') {
        mkdirSync(args[3]!, { recursive: true })
        return Promise.resolve({ stdout: JSON.stringify({ action: 'checkout_repo', repository: pr.repo, path: args[3] }), stderr: '' })
      }
      if (command === 'git') return Promise.resolve({
        stdout: args[0] === 'remote' ? `https://github.com/${pr.repo}.git` : args[0] === 'rev-parse' ? HEAD_SHA : '', stderr: '',
      })
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
  return { database, behaviors, resume: () => { failing = false } }
}

function failureScript(stderr: string): string {
  return `process.stdout.write('private-output'); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1`
}

function events() {
  const runtime = logging!.loggingRuntime()!
  while (runtime.health().queued) expect(runtime.flush()).toBe(true)
  return runtime.query((store) => store.query({ workspace: logging!.loggingWorkspace(), operator: false }, { limit: 100 })).events
}

it.each(APPROVAL_CHECKS)('retains one attributed approval timeout and retries normally (%s)', async (primitive, phase) => {
  const script = "process.stdout.write('private-output'); process.stderr.write('delayed read\\nAuthorization: Bearer private-credential\\n'); setInterval(() => {}, 1000)"
  const { database, behaviors, resume } = await start(primitive, script, true)
  await behaviors.runEnabledBehaviorsOnce()
  const retry = behaviors.getBehaviorFailureState('approve-prs', CHECK)!
  expect(retry).toMatchObject({ kind: 'operation', consecutiveFailures: 1, correlationId: expect.any(String) })
  expect(Date.parse(retry.nextRetryAt) - Date.parse(retry.lastFailureAt)).toBe(60_000)
  const recorded = events()
  expect(recorded).toEqual([expect.objectContaining({
    operation: `github-interface.${primitive}`, behavior: 'approve-prs', phase, severity: 'error',
    exitCode: null, signal: 'SIGKILL', timeoutMs: 500, correlationId: retry.correlationId,
    stderr: expect.stringContaining('delayed read'),
    context: expect.objectContaining({ killed: true, elapsedMs: expect.any(Number),
      executable: join(fixture.tempRoot, 'github-interface'), configuredCommand: 'github-interface' }),
  })])
  expect(Number(recorded[0]!.context.elapsedMs)).toBeGreaterThanOrEqual(500)
  if (phase === 'head-check' || phase === 'checkout') {
    expect(recorded[0]).toMatchObject({ repository: pr.repo, target: TARGET,
      context: { expectedHead: HEAD_SHA, retry } })
  } else {
    expect(recorded[0]).toMatchObject({ repository: null, target: null, context: {
      targets: [{ target: TARGET, ...(primitive === 'review-activity-since' ? { expectedHead: HEAD_SHA } : {}) }],
      retry: [{ target: TARGET, nextRetryAt: retry.nextRetryAt, consecutiveFailures: 1 }],
    } })
  }
  for (const secret of ['private-output', 'private-credential', '--requests-json', '--token-user', '--path', 'checkout not found']) {
    expect(JSON.stringify(recorded)).not.toContain(secret)
  }
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
  expect(database.listBehaviorLaunchClaims('approve-prs')).toEqual([])
  expect(database.db.prepare("SELECT target FROM behavior_seen WHERE key = 'pr-operation'").all()).toEqual([])
  expect(behaviors.getBehaviorCheckSlots().stats()).toMatchObject({ running: 0, behaviorRunning: 0 })
  const calls = mocks.runFile.mock.calls.filter(([, args]) => args[0] === `--${primitive}`).length
  await behaviors.runEnabledBehaviorsOnce()
  expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === `--${primitive}`)).toHaveLength(calls)
  expect(events()).toHaveLength(1)
  resume()
  const key = `behavior_approve_prs_failure:${CHECK}`
  database.setMeta(key, JSON.stringify({ ...JSON.parse(database.getMeta(key)!), nextRetryAtMs: 1 }))
  await behaviors.runEnabledBehaviorsOnce()
  expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
  expect(mocks.spawnDetached.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--expected-head', HEAD_SHA]))
  if (primitive === 'checkout-repo') {
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--checkout-repo')).toHaveLength(2)
    expect(mocks.spawnDetached.mock.calls[0]![1]).toEqual(expect.arrayContaining([
      '--pwd', join(fixture.tempRoot, 'review-checkouts', HEAD_SHA, pr.repo.toLowerCase()),
    ]))
  }
  expect(behaviors.getBehaviorFailureState('approve-prs', CHECK)).toBeNull()
  expect(events()).toHaveLength(1)
})

it('keeps distinct failed approval batches under the same sweep correlation and across sweeps', async () => {
  const { database, behaviors } = await start('requested-changes-addressed', undefined, true)
  fixture.listedPrs = Array.from({ length: 11 }, (_, index) => ({ ...pr, number: 17 + index,
    url: `https://github.com/${pr.repo}/pull/${17 + index}` }))
  await behaviors.runEnabledBehaviorsOnce()
  expect(events()).toHaveLength(2)
  expect(new Set(events().map((event) => event.correlationId)).size).toBe(1)
  for (const pull of fixture.listedPrs) {
    const key = `behavior_approve_prs_failure:${pull.repo}#${pull.number}:check`
    database.setMeta(key, JSON.stringify({ ...JSON.parse(database.getMeta(key)!), nextRetryAtMs: 1 }))
  }
  await behaviors.runEnabledBehaviorsOnce()
  const recorded = events()
  expect(recorded).toHaveLength(4)
  expect(new Set(recorded.map((event) => event.id)).size).toBe(4)
  expect(new Set(recorded.map((event) => event.correlationId)).size).toBe(2)
  expect(recorded.every((event) => event.operation === 'github-interface.requested-changes-addressed' && event.severity === 'error')).toBe(true)
})

it.each(['requested-changes-addressed', 'review-activity-since'])('keeps a full batch diagnostic under the context cap (%s)', async (primitive) => {
  const { behaviors } = await start(primitive, failureScript('E'.repeat(300)))
  const repo = `Vaquum/${'r'.repeat(130)}`
  fixture.listedPrs = Array.from({ length: 10 }, (_, index) => ({ ...pr, repo, number: 17 + index,
    url: `https://github.com/${repo}/pull/${17 + index}` }))
  await behaviors.runEnabledBehaviorsOnce()
  const recorded = events()
  expect(recorded).toHaveLength(1)
  const event = recorded[0]!
  expect(event.operation).toBe(`github-interface.${primitive}`)
  expect(event.context.targets).toHaveLength(10)
  expect(event.context.retry).toHaveLength(10)
  expect(event.context).toMatchObject({ elapsedMs: expect.any(Number) })
  expect(event.context.truncated).not.toBe(true)
  expect(Buffer.byteLength(JSON.stringify(event.context))).toBeLessThanOrEqual(8192)
  for (const entry of event.context.retry as Array<Record<string, unknown>>) {
    expect(Object.keys(entry).sort()).toEqual(['consecutiveFailures', 'nextRetryAt', 'target'])
    expect(entry).toMatchObject({ consecutiveFailures: 1, nextRetryAt: expect.any(String) })
  }
  if (primitive === 'review-activity-since') {
    for (const target of event.context.targets as Array<Record<string, unknown>>) {
      expect(target).toMatchObject({ expectedHead: HEAD_SHA })
    }
  }
})

it.each(['requested-changes-addressed', 'head-sha', 'local-checkout-path', 'checkout-repo'])('keeps the original approval process failure when retry bookkeeping throws (%s)', async (primitive) => {
  const { database, behaviors } = await start(primitive, failureScript('original read failure'))
  const setMeta = database.setMeta
  vi.spyOn(database, 'setMeta').mockImplementation((key, value) => {
    if (key === `behavior_approve_prs_failure:${CHECK}`) throw new Error('retry bookkeeping failed')
    return setMeta(key, value)
  })
  await behaviors.runEnabledBehaviorsOnce()
  const recorded = events()
  expect(recorded.filter((event) => event.operation === `github-interface.${primitive}`)).toEqual([
    expect.objectContaining({ severity: 'error', exitCode: 1, stderr: 'original read failure', context: expect.objectContaining({ retry: null }) }),
  ])
  expect(recorded.some((event) => event.message === 'retry bookkeeping failed')).toBe(true)
})

it('retains an independent approval launch failure after a successful head check', async () => {
  const { behaviors, resume } = await start('head-sha')
  resume()
  mocks.spawnDetached.mockRejectedValueOnce(new Error('approval launch failed'))
  await behaviors.runEnabledBehaviorsOnce()
  expect(events()).toEqual([expect.objectContaining({ operation: 'application.behaviors', severity: 'error',
    message: 'approval launch failed', target: TARGET, phase: 'launch', exitCode: null,
    context: expect.objectContaining({ expectedHead: HEAD_SHA, retry: expect.objectContaining({ consecutiveFailures: 1 }) }),
  })])
})

it.each(['requested-changes-addressed', 'head-sha', 'local-checkout-path', 'checkout-repo'])('keeps a failed approval read if shutdown interrupts its handler (%s)', async (primitive) => {
  const { behaviors } = await start(primitive, failureScript('original read failure'))
  const original = mocks.runFile.getMockImplementation()!
  let stopping: Promise<void> | undefined
  mocks.runFile.mockImplementation(async (command: string, args: string[], options: RunFileOptions) => {
    try { return await original(command, args, options) }
    catch (error) {
      if (command === 'github-interface' && args[0] === `--${primitive}`) stopping = behaviors.stopBehaviorsRuntime()
      throw error
    }
  })
  await behaviors.runEnabledBehaviorsOnce()
  await stopping
  expect(events()).toEqual([expect.objectContaining({ operation: `github-interface.${primitive}`,
    severity: 'error', exitCode: 1, stderr: 'original read failure', context: expect.objectContaining({ retry: null }) })])
})

it.each(['local-checkout-path', 'checkout-repo'])('retains distinct failed checkout attempts (%s)', async (primitive) => {
  const { database, behaviors } = await start(primitive, failureScript('checkout failed'))
  await behaviors.runEnabledBehaviorsOnce()
  const key = `behavior_approve_prs_failure:${CHECK}`
  database.setMeta(key, JSON.stringify({ ...JSON.parse(database.getMeta(key)!), nextRetryAtMs: 1 }))
  await behaviors.runEnabledBehaviorsOnce()
  const recorded = events()
  expect(recorded).toHaveLength(2)
  expect(new Set(recorded.map((event) => event.id)).size).toBe(2)
  expect(new Set(recorded.map((event) => event.correlationId)).size).toBe(2)
  for (const event of recorded) expect(event).toMatchObject({
    operation: `github-interface.${primitive}`, phase: 'checkout', severity: 'error', stderr: 'checkout failed',
  })
  expect(behaviors.getBehaviorFailureState('approve-prs', CHECK)).toMatchObject({ consecutiveFailures: 2 })
})

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
