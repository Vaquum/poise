import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CheckSemaphore } from '../server/check-semaphore'
import type { RunFileOptions } from '../server/process'
import { completedReviewCall } from './review-response-fixture'
import { agentLog, arrangeCli, fixture, HEAD_SHA, NEXT_HEAD_SHA, loadModules, mocks, pr, resetLogCache } from './behaviors-runtime-fixture'

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

function branchUpdateDiagnostic(phase: string, submission = phase === 'update_branch' ? 'uncertain' : 'none') {
  const message = `${phase}: httpx.ReadTimeout: delayed request timed out`
  return 'caller_diagnostic: ' + JSON.stringify({ version: 1, source: 'caller', severity: 'error',
    operation: 'update_branch_if_behind', phase, outcome: phase === 'update_branch' ? 'unknown' : 'failed',
    submission, message, stderr: message, stderr_truncated: false })
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

it.each(['read_pull', 'read_readiness', 'recheck_pull', 'update_branch'])('attributes a terminal branch-update timeout at %s to its retry and ledger attempt', async (phase) => {
  const stderr = branchUpdateDiagnostic(phase)
  const { database, behaviors } = await start('update-branch-if-behind', failureScript(stderr))
  await behaviors.runEnabledBehaviorsOnce()
  const admission = mocks.captureAdmission.mock.calls[0]![0]
  const retry = behaviors.getBehaviorFailureState('merge-prs', TARGET)!
  const readOnly = phase !== 'update_branch'
  expect(retry).toMatchObject({ kind: 'operation', consecutiveFailures: 1, correlationId: admission.nativeId,
    error: expect.stringContaining(phase), diagnostic: { code: 'network_interruption' } })
  expect(Date.parse(retry.nextRetryAt) - Date.parse(retry.lastFailureAt)).toBe(60_000)
  expect(events()).toEqual([expect.objectContaining({
    operation: 'github-interface.update-branch-if-behind', severity: readOnly ? 'warning' : 'error', phase,
    target: TARGET, correlationId: admission.nativeId, exitCode: 1, signal: null, stderr,
    context: expect.objectContaining({ nativeId: admission.nativeId, retry, safeRetry: readOnly,
      sideEffects: readOnly ? 'none' : 'uncertain' }),
  })])
  expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({ nativeId: admission.nativeId,
    state: readOnly ? 'failed' : 'unknown', activity: readOnly ? 'settled' : 'unknown',
    ...(readOnly ? { outcome: 'read_failed', completedAt: expect.any(String) } : {}),
  }))
  const previousRun = database.db.prepare('SELECT status, note FROM behavior_runs WHERE id = ?').get(admission.nativeId)
  expect(previousRun).toMatchObject({ status: 'failed', note: expect.stringContaining(`phase=${phase}`) })
  await behaviors.runEnabledBehaviorsOnce()
  expect(mocks.captureAdmission).toHaveBeenCalledTimes(1)

  const original = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation((command: string, args: string[], options: RunFileOptions) => {
    if (command === 'github-interface' && args[0] === '--update-branch-if-behind') {
      expect(args).toEqual(expect.arrayContaining(['--expected-head', HEAD_SHA, '--token-user', 'review-bot']))
      return Promise.resolve({ stdout: JSON.stringify({ action: 'update_branch_if_behind', repository: pr.repo,
        pull_number: pr.number, head_sha: HEAD_SHA, outcome: 'updated' }), stderr: '' })
    }
    return original(command, args, options)
  })
  const key = `behavior_merge_prs_failure:${TARGET}`
  database.setMeta(key, JSON.stringify({ ...JSON.parse(database.getMeta(key)!), nextRetryAtMs: 1 }))
  await behaviors.runEnabledBehaviorsOnce()
  const successor = mocks.captureAdmission.mock.calls[1]![0]
  expect(successor.nativeId).not.toBe(admission.nativeId)
  expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({ nativeId: successor.nativeId,
    state: 'completed', activity: 'settled', outcome: 'updated' }))
  expect(mocks.captureOutcome.mock.calls.filter(([value]) => value.nativeId === admission.nativeId)).toHaveLength(1)
  expect(database.db.prepare('SELECT status, note FROM behavior_runs WHERE id = ?').get(admission.nativeId)).toEqual(previousRun)
  expect(behaviors.getBehaviorFailureState('merge-prs', TARGET)).toBeNull()
  expect(events()).toHaveLength(1)
})

it.each(['retry persistence', 'ledger bookkeeping', 'cancellation', 'disabled'])('retains a read-only branch-update Error after %s', async (blocker) => {
  const stderr = branchUpdateDiagnostic('read_readiness')
  const { database, behaviors } = await start('update-branch-if-behind', failureScript(stderr))
  let stopping: Promise<void> | undefined
  if (blocker === 'retry persistence') {
    const setMeta = database.setMeta
    vi.spyOn(database, 'setMeta').mockImplementation((key, value) => {
      if (key === `behavior_merge_prs_failure:${TARGET}`) throw new Error('retry bookkeeping failed')
      return setMeta(key, value)
    })
  } else if (blocker === 'ledger bookkeeping') {
    mocks.captureOutcome.mockImplementationOnce(() => { throw new Error('ledger bookkeeping failed') })
  } else {
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: RunFileOptions) => {
      try { return await original(command, args, options) }
      catch (error) {
        if (args[0] === '--update-branch-if-behind') {
          if (blocker === 'cancellation') stopping = behaviors.stopBehaviorsRuntime()
          else database.setMeta('behavior_merge_prs_enabled', '0')
        }
        throw error
      }
    })
  }
  await behaviors.runEnabledBehaviorsOnce()
  await stopping
  const recorded = events()
  expect(recorded.filter((event) => event.operation === 'github-interface.update-branch-if-behind')).toEqual([
    expect.objectContaining({ severity: 'error', phase: 'read_readiness', exitCode: 1, stderr,
      context: expect.objectContaining({ safeRetry: false, retry: null, sideEffects: 'none' }) }),
  ])
  if (blocker.includes('bookkeeping') || blocker === 'retry persistence') {
    expect(recorded.some((event) => event.message === (blocker === 'retry persistence' ? 'retry' : 'ledger') + ' bookkeeping failed')).toBe(true)
  }
  expect(behaviors.getBehaviorFailureState('merge-prs', TARGET)).toBeNull()
})

it.each(['uncertain', 'missing', 'malformed'])('requires valid terminal no-PUT proof for a read-stage Warning (%s)', async (proof) => {
  const stderr = proof === 'malformed' ? 'caller_diagnostic: {' : branchUpdateDiagnostic('read_pull', proof)
  const { behaviors } = await start('update-branch-if-behind', failureScript(stderr))
  await behaviors.runEnabledBehaviorsOnce()
  expect(events()).toEqual([expect.objectContaining({ severity: 'error', exitCode: 1, stderr,
    context: expect.objectContaining({ safeRetry: false, sideEffects: 'uncertain' }) })])
  expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({ state: 'unknown', activity: 'unknown' }))
})

it('keeps a killed branch-update process unknown despite read-stage output', async () => {
  const script = `process.stdout.write(JSON.stringify({ phase: 'read' })); setInterval(() => {}, 1000)`
  const { database, behaviors } = await start('update-branch-if-behind', script, true)
  await behaviors.runEnabledBehaviorsOnce()
  const commandIndex = mocks.runFile.mock.calls.findIndex(([, args]) => args[0] === '--update-branch-if-behind')
  await expect(mocks.runFile.mock.results[commandIndex]!.value).rejects.toMatchObject({ stdout: JSON.stringify({ phase: 'read' }), stderr: '' })
  const admission = mocks.captureAdmission.mock.calls[0]![0]
  const retry = behaviors.getBehaviorFailureState('merge-prs', TARGET)!
  expect(retry).toMatchObject({ kind: 'operation', consecutiveFailures: 1, correlationId: admission.nativeId })
  expect(Date.parse(retry.nextRetryAt) - Date.parse(retry.lastFailureAt)).toBe(60_000)
  expect(events()).toEqual([expect.objectContaining({
    operation: 'github-interface.update-branch-if-behind', behavior: 'merge-prs', severity: 'error',
    target: TARGET, correlationId: admission.nativeId, phase: 'command',
    exitCode: null, signal: 'SIGKILL', stderr: '',
    context: expect.objectContaining({ killed: true, nativeId: admission.nativeId, retry }),
  })])
  expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
    nativeId: admission.nativeId, state: 'unknown', activity: 'unknown',
  }))
  expect(database.db.prepare('SELECT status, note FROM behavior_runs WHERE id = ?').get(admission.nativeId))
    .toMatchObject({ status: 'failed', note: expect.stringContaining('op=update-branch-if-behind') })
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

async function startReviewCheck(phase: string, primitive: string, slot = 'secondary', delayUnattributed = false) {
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
      && state.failures > 0
      && ((context?.phase === phase && context.progress?.slot === slot) || (delayUnattributed && !context?.progress))) {
      expect(options.timeoutMs).toBe(30_000)
      checks.push({ correlationId: context?.correlationId ?? 'unattributed', phase, slot, expectedHead: context?.progress?.expectedHead })
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

it.each([
  ['packet-blocked hold', null],
  ['failed-launch recovery', HEAD_SHA],
])('attributes an early preparation head-sha timeout during %s to its slot with a recorded retry', async (kind, expectedHead) => {
  const { database, behaviors, state, checks, checkTarget } = await startReviewCheck('preparation', 'head-sha', 'secondary', true)
  state.failures = 1
  if (kind === 'packet-blocked hold') {
    database.setMeta(`packet_block:review-new-prs:${TARGET}`, HEAD_SHA)
  } else {
    const target = `${TARGET}:secondary`
    const claimId = database.claimSeenOwned('review-new-prs', target)!
    const callId = 'b'.repeat(32)
    expect(database.markBehaviorLaunchIntentOwned({ key: 'review-new-prs', target, claimId, launchBehavior: 'pr_review',
      repo: pr.repo, pr: pr.number, requestedAt: new Date(Date.now() - 10_000).toISOString(),
      expectedHead: HEAD_SHA, actor: 'review-bot', source: 'poise:review-new-prs', correlationId: claimId })
      && database.linkBehaviorLaunchCallOwned('review-new-prs', target, claimId, callId)
      && database.setBehaviorLaunchErrorOwned('review-new-prs', target, claimId, 'worker failed')
      && database.completeSeenOwned('review-new-prs', target, claimId)).toBe(true)
    fixture.agentLogs = [agentLog({ id: callId, correlation_id: claimId, expected_head: HEAD_SHA,
      status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'review_packet_too_large', error: 'remaining review input is too large' })]
    await resetLogCache()
  }
  const launches = () => mocks.spawnDetached.mock.calls.map(([, args]) => args as string[])
  await behaviors.runEnabledBehaviorsOnce()
  // The failed secondary never launches; a held packet also holds its siblings, while the other PR's panel proceeds.
  expect(launches().filter((args) => args.includes('#17'))).toHaveLength(kind === 'packet-blocked hold' ? 0 : 2)
  expect(launches().filter((args) => args.includes('#18'))).toHaveLength(3)
  const retry = behaviors.getBehaviorFailureState('review-new-prs', checkTarget)!
  expect(retry).toMatchObject({ consecutiveFailures: 1 })
  const recorded = events()
  expect(recorded).toHaveLength(1)
  expect(recorded[0]).toMatchObject({ operation: 'github-interface.head-sha', severity: 'error',
    behavior: 'review-new-prs', target: TARGET, repository: pr.repo, account: 'review-bot', phase: 'preparation',
    timeoutMs: 30_000, exitCode: null, signal: 'SIGKILL', stderr: expect.stringContaining('delayed review check'),
    context: { primitive: 'head-sha', slot: 'secondary', expectedHead, killed: true, retry: { nextRetryAt: retry.nextRetryAt } },
  })
  expect(recorded[0]!.correlationId).toBe(retry.correlationId)
  expect(checks.at(-1)).toMatchObject({ expectedHead, correlationId: retry.correlationId })
  vi.setSystemTime(new Date(Date.parse(retry.nextRetryAt) - 1))
  await behaviors.runEnabledBehaviorsOnce()
  expect(events()).toHaveLength(1)
  expect(launches().filter((args) => args.includes('#17'))).toHaveLength(kind === 'packet-blocked hold' ? 0 : 2)
  state.head = NEXT_HEAD_SHA
  vi.setSystemTime(new Date(retry.nextRetryAt))
  await behaviors.runEnabledBehaviorsOnce()
  expect(launches().filter((args) => args.includes('#17'))).toHaveLength(3)
  expect(launches().filter((args) => args.includes('#18'))).toHaveLength(3)
  expect(behaviors.getBehaviorFailureState('review-new-prs', checkTarget)).toBeNull()
})

it('defers a stalled review checkout with one Error and launches the same head on retry', async () => {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database, behaviors } = await loadModules()
  database.setMeta('me', 'poise-user')
  database.setMeta('behavior_review_new_prs_keyver', '3')
  database.setMeta('behavior_review_new_prs_enabled', '1')
  database.recordSeen('review-new-prs', '__snapshot_v3__')
  behaviors.startBehaviorsRuntime()
  vi.stubEnv('CALLER_BIN_ROOT', fixture.tempRoot)
  writeFileSync(join(fixture.tempRoot, 'github-interface'), `#!${process.execPath}
process.stdout.write('private-output')
process.stderr.write('delayed checkout\\nAuthorization: Bearer [REDACTED]\\n')
setInterval(() => {}, 1000)
`, { mode: 0o700 })
  const original = mocks.runFile.getMockImplementation()!
  let failing = true
  mocks.runFile.mockImplementation((command: string, args: string[], options: RunFileOptions) => {
    if (command === 'agent-interface' && args[0] === '--diagnostics') return Promise.resolve({
      stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '',
    })
    if (command === 'github-interface' && args[0] === '--local-checkout-path') {
      const error = Object.assign(new Error('Command failed (1): github-interface'),
        { code: 1, killed: false, signal: null, stdout: '',
          stderr: `error: checkout not found under /fake/dev: ${args[1]}/${args[2]}\n` })
      return Promise.reject(error)
    }
    if (failing && command === 'github-interface' && args[0] === '--checkout-repo') {
      expect(options.timeoutMs).toBe(30_000)
      return mocks.realRunFile!(command, args, { ...options, timeoutMs: 500 })
    }
    if (command === 'github-interface' && args[0] === '--checkout-repo') {
      mkdirSync(args[3]!, { recursive: true })
      return Promise.resolve({ stdout: JSON.stringify({ action: 'checkout_repo', repository: pr.repo, path: args[3] }), stderr: '' })
    }
    if (command === 'git') return Promise.resolve({
      stdout: args[0] === 'remote' ? `https://github.com/${pr.repo}.git` : args[0] === 'rev-parse' ? HEAD_SHA : '', stderr: '',
    })
    return original(command, args, options)
  })
  logging = await import('../server/logging')
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  logging.startLogging()
  const checkoutPath = join(fixture.tempRoot, 'review-checkouts', HEAD_SHA, pr.repo.toLowerCase())
  for (let attempt = 0; attempt < 2; attempt++) {
    await behaviors.runEnabledBehaviorsOnce()
    const retry = behaviors.getBehaviorFailureState('review-new-prs', CHECK)!
    const recorded = events()
    expect(retry).toMatchObject({ kind: 'operation', consecutiveFailures: 1, correlationId: expect.any(String) })
    expect(Date.parse(retry.nextRetryAt)).toBeLessThanOrEqual(Date.now())
    expect(recorded).toHaveLength(attempt + 1)
    expect(new Set(recorded.map((event) => event.id)).size).toBe(attempt + 1)
    expect(new Set(recorded.map((event) => event.correlationId)).size).toBe(attempt + 1)
    const latest = recorded.find((event) => event.correlationId === retry.correlationId)!
    expect(latest).toMatchObject({ operation: 'github-interface.checkout-repo', behavior: 'review-new-prs',
      phase: 'checkout', severity: 'error', repository: pr.repo, target: TARGET, account: 'review-bot',
      exitCode: null, signal: 'SIGKILL', timeoutMs: 30_000, correlationId: retry.correlationId,
      stderr: expect.stringContaining('delayed checkout'),
      context: expect.objectContaining({ slot: 'primary', expectedHead: HEAD_SHA, killed: true,
        executable: join(fixture.tempRoot, 'github-interface'), configuredCommand: 'github-interface',
        retry: expect.objectContaining({ consecutiveFailures: 1 }) }) })
    expect(Number(latest.context.elapsedMs)).toBeGreaterThanOrEqual(500)
    for (const secret of ['private-output', '--token-user', '--path', 'checkout not found']) {
      expect(JSON.stringify(recorded)).not.toContain(secret)
    }
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(database.listBehaviorLaunchClaims('review-new-prs')).toEqual([])
    expect(database.db.prepare("SELECT target FROM behavior_seen WHERE key = 'pr-operation'").all()).toEqual([])
    expect(behaviors.getBehaviorCheckSlots().stats()).toMatchObject({ running: 0, behaviorRunning: 0 })
    expect(existsSync(checkoutPath)).toBe(false)
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: retry.correlationId, outcome: 'preflight_failed', state: 'failed', activity: 'settled',
    }))
  }
  failing = false
  await behaviors.runEnabledBehaviorsOnce()
  expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
  expect(mocks.spawnDetached.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--expected-head', HEAD_SHA, '--pwd', checkoutPath]))
  expect(existsSync(checkoutPath)).toBe(true)
  expect(behaviors.getBehaviorFailureState('review-new-prs', CHECK)).toBeNull()
  expect(events()).toHaveLength(2)
})

it('keeps the checkout failure when claim release throws', async () => {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database, behaviors } = await loadModules()
  database.setMeta('me', 'poise-user')
  database.setMeta('behavior_review_new_prs_keyver', '3')
  database.setMeta('behavior_review_new_prs_enabled', '1')
  database.recordSeen('review-new-prs', '__snapshot_v3__')
  behaviors.startBehaviorsRuntime()
  vi.stubEnv('CALLER_BIN_ROOT', fixture.tempRoot)
  writeFileSync(join(fixture.tempRoot, 'github-interface'), `#!${process.execPath}\nprocess.stdout.write('private-output')\nprocess.stderr.write('original checkout failure\\n')\nprocess.exitCode = 1\n`, { mode: 0o700 })
  const original = mocks.runFile.getMockImplementation()!
  let checkoutFailed = false
  mocks.runFile.mockImplementation((command: string, args: string[], options: RunFileOptions) => {
    if (command === 'agent-interface' && args[0] === '--diagnostics') return Promise.resolve({
      stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '',
    })
    if (command === 'github-interface' && args[0] === '--local-checkout-path') {
      const error = Object.assign(new Error('Command failed (1): github-interface'),
        { code: 1, killed: false, signal: null, stdout: '',
          stderr: `error: checkout not found under /fake/dev: ${args[1]}/${args[2]}\n` })
      return Promise.reject(error)
    }
    if (command === 'github-interface' && args[0] === '--checkout-repo') {
      checkoutFailed = true
      return mocks.realRunFile!(command, args, options)
    }
    if (command === 'git') return Promise.resolve({
      stdout: args[0] === 'remote' ? `https://github.com/${pr.repo}.git` : args[0] === 'rev-parse' ? HEAD_SHA : '', stderr: '',
    })
    return original(command, args, options)
  })
  const realReleaseSeen = database.releaseSeenOwned.bind(database)
  const realReleaseOperation = database.releasePrOperationOwned.bind(database)
  let claimThrown = false, operationThrown = false
  vi.spyOn(database, 'releaseSeenOwned').mockImplementation(((...args: Parameters<typeof database.releaseSeenOwned>) => {
    if (checkoutFailed && !claimThrown) { claimThrown = true; throw new Error('claim release failed') }
    return realReleaseSeen(...args)
  }) as typeof database.releaseSeenOwned)
  vi.spyOn(database, 'releasePrOperationOwned').mockImplementation(((...args: Parameters<typeof database.releasePrOperationOwned>) => {
    if (checkoutFailed && !operationThrown) { operationThrown = true; throw new Error('operation release failed') }
    return realReleaseOperation(...args)
  }) as typeof database.releasePrOperationOwned)
  logging = await import('../server/logging')
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  logging.startLogging()
  await behaviors.runEnabledBehaviorsOnce()
  const recorded = events()
  const checkout = recorded.filter((event) => event.operation === 'github-interface.checkout-repo')
  expect(checkout).toEqual([expect.objectContaining({ behavior: 'review-new-prs',
    phase: 'checkout', severity: 'error', repository: pr.repo, target: TARGET, exitCode: 1,
    stderr: expect.stringContaining('original checkout failure'),
    context: expect.objectContaining({ slot: 'primary', expectedHead: HEAD_SHA }) })])
  expect(JSON.stringify(checkout)).not.toContain('private-output')
  expect(recorded.some((event) => event.message === 'claim release failed')).toBe(true)
  expect(recorded.some((event) => event.message === 'operation release failed')).toBe(true)
  const retry = behaviors.getBehaviorFailureState('review-new-prs', CHECK)!
  expect(retry).toMatchObject({ kind: 'operation', consecutiveFailures: 1, correlationId: checkout[0]!.correlationId })
  expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
    nativeId: retry.correlationId, outcome: 'preflight_failed', state: 'failed', activity: 'settled',
  }))
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
  expect(behaviors.getBehaviorCheckSlots().stats()).toMatchObject({ running: 0, behaviorRunning: 0 })
})
