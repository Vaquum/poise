import { describe, expect, it, vi } from 'vitest'
import { BehaviorLedgerStore } from '../server/behavior-ledger-store'
import type { LedgerResult } from '../server/behavior-ledger-contract'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, restartModules, arrangeCli, fixture } from './behaviors-runtime-fixture'

const CHECK_17 = `${pr.repo}#17:check`
const SECONDARY_LIMIT_BODY = '{"message": "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}'

function secondaryLimitError(marked: boolean): Error {
  const stderr = `error: GitHub 403 rate-limit: {'x-ratelimit-resource': 'core', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '58', 'x-ratelimit-used': '4942', 'x-ratelimit-reset': '1792870000', 'retry-after': '300'} body=${SECONDARY_LIMIT_BODY}${marked ? ' (no conversation was resolved before this failure)' : ''}`
  return Object.assign(new Error('Command failed (1): github-interface'), { stdout: '', stderr })
}

type ResolveScriptResult = 'delegate' | { stdout: string } | { error: unknown }
type ResolveScript = (pullNumber: number) => ResolveScriptResult | Promise<ResolveScriptResult>

function scriptResolve(handler: ResolveScript): void {
  const base = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
    if (command === 'github-interface' && args[0] === '--resolve-nonblocking-conversations-if-ready') {
      const outcome = await handler(Number(String(args[1]).replace(/^#/, '')))
      if (outcome === 'delegate') return base(command, args, options)
      if ('error' in outcome) throw outcome.error
      return { stdout: outcome.stdout, stderr: '' }
    }
    return base(command, args, options)
  })
}

function resolveCalls(): any[][] {
  return mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--resolve-nonblocking-conversations-if-ready')
}

function failureRow(db: { getMeta(key: string): string | null }, target: string): Record<string, unknown> | null {
  const raw = db.getMeta(`behavior_resolve_unblocking_failure:${target}`)
  return raw ? JSON.parse(raw) : null
}

function recoveryRow(db: { getMeta(key: string): string | null }, target: string): Record<string, unknown> | null {
  const raw = db.getMeta(`behavior_resolve_unblocking_recovery:${target}`)
  return raw ? JSON.parse(raw) : null
}

function expireBackoff(db: { getMeta(key: string): string | null, setMeta(key: string, value: string): void }, target: string): void {
  const key = `behavior_resolve_unblocking_failure:${target}`
  const stored = JSON.parse(db.getMeta(key)!) as Record<string, unknown>
  db.setMeta(key, JSON.stringify({ ...stored, nextRetryAtMs: 1 }))
  const recoveryKey = `behavior_resolve_unblocking_recovery:${target}`
  const recovery = db.getMeta(recoveryKey)
  if (recovery) db.setMeta(recoveryKey, JSON.stringify({ ...JSON.parse(recovery), nextRetryAtMs: 1 }))
}

function admissionsFor(pullNumber: number): Array<{ nativeId: string }> {
  return mocks.captureAdmission.mock.calls.map(([admission]) => admission)
    .filter((admission) => admission.behavior === 'resolve-unblocking' && admission.number === pullNumber)
}

function outcomesFor(nativeId: string): Array<Omit<LedgerResult, 'type'>> {
  return mocks.captureOutcome.mock.calls.map(([outcome]) => outcome)
    .filter((outcome) => outcome.nativeId === nativeId)
}

async function startResolveRuntime() {
  fixture.listedPrs = [pr, { ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` }]
  const { database: db, behaviors: runtime } = await loadModules()
  runtime.startBehaviorsRuntime()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_resolve_unblocking_enabled', '1')
  return { db, runtime }
}

describe('resolve-unblocking rate-limit recovery', () => {
  it.each([1, 0])('preserves a settled receipt when a late successful result resolves %s threads', async (resolved) => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA,
      resolveResolvedCount: resolved, resolveUnresolvedCount: 0 })
    const { db, runtime } = await startResolveRuntime()
    scriptResolve((number) => {
      if (number !== 17) return 'delegate'
      const receipt = recoveryRow(db, CHECK_17)!
      db.db.prepare('UPDATE behavior_runs SET note = ? WHERE id = ?')
        .run(JSON.stringify({ target: CHECK_17, ...receipt, disposition: 'superseded' }), receipt.nativeId)
      db.setMeta(`behavior_resolve_unblocking_recovery:${CHECK_17}`, '')
      return 'delegate'
    })
    await runtime.runEnabledBehaviorsOnce()
    const [original] = admissionsFor(17)
    if (resolved) {
      const run = db.db.prepare('SELECT note FROM behavior_runs WHERE id = ?').get(original!.nativeId) as { note: string }
      expect(JSON.parse(run.note)).toMatchObject({ nativeId: original!.nativeId, disposition: 'superseded' })
    } else {
      expect(db.db.prepare('SELECT id FROM behavior_runs WHERE id = ?').get(original!.nativeId)).toBeUndefined()
      const receipt = db.getMeta(`behavior_resolve_unblocking_recovery:${CHECK_17}:receipt:${original!.nativeId}`)
      expect(JSON.parse(receipt!)).toMatchObject({ nativeId: original!.nativeId, disposition: 'superseded' })
    }
  })

  it.each(['uncertain', 'none'])('does not settle a newer %s owner from an older successful response', async (sideEffects) => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA, resolveResolvedCount: 1 })
    const { db, runtime } = await startResolveRuntime()
    const newerId = 'e'.repeat(32)
    scriptResolve((number) => {
      if (number !== 17) return 'delegate'
      const pending = recoveryRow(db, CHECK_17)!
      db.setMeta(`behavior_resolve_unblocking_recovery:${CHECK_17}`, JSON.stringify({ ...pending,
        nativeId: newerId, code: 'newer-attempt', sideEffects, previous: [pending] }))
      return 'delegate'
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: newerId, code: 'newer-attempt' })
    expect(outcomesFor(newerId)).toEqual([])
  })

  it('defers an absent-target lifecycle read until its persisted secondary-limit deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T09:00:00Z'))
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    scriptResolve((number) => number === 17 ? { error: secondaryLimitError(true) } : 'delegate')
    const { db, runtime } = await startResolveRuntime()
    await runtime.runEnabledBehaviorsOnce()
    fixture.listedPrs = [fixture.listedPrs[1]!]
    arrangeCli(false, false, { state: 'MERGED', unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    vi.setSystemTime(new Date('2026-10-27T09:01:01Z'))
    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()
    const lifecycle = () => mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--review-activity-since' && args[1] === '#17')
    expect(lifecycle()).toEqual([])
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nextRetryAtMs: Date.parse('2026-10-27T09:05:00Z') })
    vi.setSystemTime(new Date('2026-10-27T09:05:01Z'))
    await runtime.runEnabledBehaviorsOnce()
    expect(lifecycle()).toHaveLength(1)
    expect(recoveryRow(db, CHECK_17)).toBeNull()
  })

  it('bounds retained uncertainty before admitting another mutation without dropping evidence', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    const { db, runtime } = await startResolveRuntime()
    const entries = Array.from({ length: 32 }, (_, index) => ({ nativeId: `retained-${index}`, code: 'unknown',
      nextRetryAtMs: 1, sideEffects: 'uncertain', head: HEAD_SHA, unresolvedBefore: 1, at: new Date().toISOString() }))
    const latest = entries.pop()!
    const receipt = { ...latest, previous: entries }
    db.setMeta(`behavior_resolve_unblocking_recovery:${CHECK_17}`, JSON.stringify(receipt))
    await runtime.runEnabledBehaviorsOnce()
    expect(resolveCalls().map(([, args]) => args[1])).not.toContain('#17')
    expect(admissionsFor(17)).toEqual([])
    expect(recoveryRow(db, CHECK_17)).toEqual(receipt)
    expect(failureRow(db, CHECK_17)).toMatchObject({ error: expect.stringContaining('needs reconciliation') })
  })

  it.each(['newer-attempt', 'settled'] as const)('fences a late failure after %s takes ownership', async (replacement) => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    const { db, runtime } = await startResolveRuntime()
    const newerId = 'e'.repeat(32)
    scriptResolve((number) => {
      if (number !== 17) return 'delegate'
      const pending = recoveryRow(db, CHECK_17)!
      if (replacement === 'newer-attempt') {
        db.setMeta(`behavior_resolve_unblocking_recovery:${CHECK_17}`, JSON.stringify({ ...pending,
          nativeId: newerId, code: 'newer-attempt', nextRetryAtMs: Date.now() + 777_000, previous: [pending] }))
      } else {
        db.db.prepare('UPDATE behavior_runs SET note = ? WHERE id = ?')
          .run(JSON.stringify({ ...pending, disposition: 'superseded', observedHead: HEAD_SHA }), pending.nativeId)
        db.setMeta(`behavior_resolve_unblocking_recovery:${CHECK_17}`, '')
        mocks.captureOutcome({ nativeId: pending.nativeId, state: 'superseded', activity: 'unknown', stateSource: 'native', outcome: 'superseded' })
      }
      return { error: new Error('late response lost') }
    })
    await runtime.runEnabledBehaviorsOnce()
    const [original] = admissionsFor(17)
    if (replacement === 'newer-attempt') {
      expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: newerId, code: 'newer-attempt',
        previous: [expect.objectContaining({ nativeId: original!.nativeId, code: 'unknown' })] })
      expect(failureRow(db, CHECK_17)).toBeNull()
    } else {
      expect(recoveryRow(db, CHECK_17)).toBeNull()
      expect(outcomesFor(original!.nativeId)).toEqual([expect.objectContaining({ state: 'superseded', activity: 'unknown' })])
      const run = db.db.prepare('SELECT note FROM behavior_runs WHERE id = ?').get(original!.nativeId) as { note: string }
      expect(JSON.parse(run.note)).toMatchObject({ disposition: 'superseded', lateFailure: { error: 'late response lost' } })
    }
  })

  it.each(['disabled', 'access'] as const)('retains an admitted invocation when %s prevents a target failure row', async (mode) => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    const { db, runtime } = await startResolveRuntime()
    scriptResolve((number) => {
      if (number !== 17) return 'delegate'
      if (mode === 'disabled') db.setMeta('behavior_resolve_unblocking_enabled', '0')
      return { error: new Error(mode === 'access' ? 'GitHub 404: Not Found' : 'response lost') }
    })
    await runtime.runEnabledBehaviorsOnce()
    const [admission] = admissionsFor(17)
    expect(admission).toBeDefined()
    expect(failureRow(db, CHECK_17)).toBeNull()
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: admission!.nativeId, sideEffects: 'uncertain', actor: 'review-bot' })
    expect(outcomesFor(admission!.nativeId)).toEqual([expect.objectContaining({ state: 'held', activity: 'unknown' })])
    const recovered = await restartModules()
    expect(recoveryRow(recovered.database, CHECK_17)).toMatchObject({ nativeId: admission!.nativeId, sideEffects: 'uncertain' })
  })

  it.each(['shutdown', 'deadline'] as const)('persists an admitted receipt before Caller and retains it through %s', async (mode) => {
    if (mode === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    const { db, runtime } = await startResolveRuntime()
    let stopping: Promise<void> | undefined
    let observedAdmission = false
    scriptResolve(async (number) => {
      if (number !== 17) return 'delegate'
      const [admission] = admissionsFor(17)
      expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: admission!.nativeId, code: 'admitted',
        actor: 'review-bot', head: HEAD_SHA, sideEffects: 'uncertain' })
      const row = db.db.prepare('SELECT note FROM behavior_runs WHERE id = ?').get(admission!.nativeId) as { note: string }
      expect(JSON.parse(row.note)).toMatchObject({ nativeId: admission!.nativeId, actor: 'review-bot', head: HEAD_SHA })
      observedAdmission = true
      if (mode === 'shutdown') stopping = runtime.stopBehaviorsRuntime()
      else await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_OPERATION_TIMEOUT_MS + 1)
      return { error: new Error(`Caller interrupted by ${mode}`) }
    })
    await runtime.runEnabledBehaviorsOnce()
    await stopping
    if (mode === 'deadline') vi.useRealTimers()
    expect(observedAdmission).toBe(true)
    const [admission] = admissionsFor(17)
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: admission!.nativeId, sideEffects: 'uncertain' })
    const ledger = new BehaviorLedgerStore(':memory:')
    try {
      const native = mocks.captureAdmission.mock.calls.map(([value]) => value).find((value) => value.nativeId === admission!.nativeId)
      ledger.capture({ type: 'admit', ...native })
      for (const result of outcomesFor(admission!.nativeId)) ledger.capture({ type: 'result', ...result })
      expect(ledger.read({ operation: 'list' }).body.records![0]).toMatchObject({ state: 'held', activity: 'unknown', completedAt: null })
    } finally { ledger.close() }
    const restarted = await restartModules()
    expect(recoveryRow(restarted.database, CHECK_17)).toMatchObject({ nativeId: admission!.nativeId })
  })

  it('keeps partial-write uncertainty when same-head thread churn leaves the count unchanged', async () => {
    const threads = new Set(['A', 'B'])
    arrangeCli(false, false, { unresolvedConversationCount: 2, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    scriptResolve((number) => {
      if (number !== 17) return 'delegate'
      threads.delete('A')
      threads.add('C')
      return { error: new Error('response lost after applying thread A') }
    })
    const { db, runtime } = await startResolveRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect([...threads]).toEqual(['B', 'C'])
    const [admission] = admissionsFor(17)
    expireBackoff(db, CHECK_17)
    arrangeCli(false, false, { unresolvedConversationCount: threads.size, reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA, activeChangeRequestAuthors: ['octocat'] })
    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()
    expect(resolveCalls()).toHaveLength(0)
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: admission!.nativeId, sideEffects: 'uncertain' })
    expect(outcomesFor(admission!.nativeId)).toEqual([expect.objectContaining({ state: 'held', activity: 'unknown' })])
    expect(failureRow(db, CHECK_17)).toMatchObject({ kind: 'worker' })
  })

  it.each(['OPEN', 'MERGED'] as const)('requires positive closure evidence for an absent target (%s)', async (state) => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    scriptResolve((number) => number === 17 ? { error: new Error('response lost') } : 'delegate')
    const { db, runtime } = await startResolveRuntime()
    await runtime.runEnabledBehaviorsOnce()
    const [admission] = admissionsFor(17)
    expireBackoff(db, CHECK_17)
    fixture.listedPrs = [fixture.listedPrs[1]!]
    arrangeCli(false, false, { state, unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()
    if (state === 'OPEN') {
      expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: admission!.nativeId })
      expect(failureRow(db, CHECK_17)).not.toBeNull()
      expect(outcomesFor(admission!.nativeId)).toHaveLength(1)
    } else {
      expect(recoveryRow(db, CHECK_17)).toBeNull()
      expect(outcomesFor(admission!.nativeId)).toEqual([expect.objectContaining({ state: 'held' }),
        expect.objectContaining({ state: 'superseded', activity: 'unknown' })])
      const run = db.db.prepare('SELECT note FROM behavior_runs WHERE id = ?').get(admission!.nativeId) as { note: string }
      expect(JSON.parse(run.note)).toMatchObject({ nativeId: admission!.nativeId, disposition: 'superseded', code: 'unknown' })
    }
  })

  it('preserves an earlier uncertain write when a newer invocation fails before mutation', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 2, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    scriptResolve((number) => number === 17 ? { error: new Error('response lost after partial resolution') } : 'delegate')
    const { db, runtime } = await startResolveRuntime()
    await runtime.runEnabledBehaviorsOnce()
    const [original] = admissionsFor(17)
    expireBackoff(db, CHECK_17)
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    scriptResolve((number) => number === 17 ? { error: secondaryLimitError(true) } : 'delegate')
    await runtime.runEnabledBehaviorsOnce()
    const admissions = admissionsFor(17)
    expect(admissions).toHaveLength(2)
    expect(outcomesFor(original!.nativeId)).toEqual([expect.objectContaining({ state: 'held', activity: 'unknown' })])
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: admissions[1]!.nativeId, sideEffects: 'none',
      previous: [expect.objectContaining({ nativeId: original!.nativeId, sideEffects: 'uncertain' })] })
  })

  it('does not treat draft status as recovered while threads remain', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    scriptResolve((number) => number === 17 ? { error: new Error('response lost') } : 'delegate')
    const { db, runtime } = await startResolveRuntime()
    await runtime.runEnabledBehaviorsOnce()
    const [admission] = admissionsFor(17)
    expireBackoff(db, CHECK_17)
    arrangeCli(false, false, { draft: true, unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    await runtime.runEnabledBehaviorsOnce()
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: admission!.nativeId })
    expect(outcomesFor(admission!.nativeId)).toHaveLength(1)
    expect(failureRow(db, CHECK_17)).toMatchObject({ kind: 'worker', error: expect.stringContaining('draft') })
  })

  it('persists the stated five-minute retry deadline across restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T09:00:00Z'))
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    scriptResolve((number) => number === 17 ? { error: secondaryLimitError(true) } : 'delegate')
    const { db, runtime } = await startResolveRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(failureRow(db, CHECK_17)).toMatchObject({ nextRetryAtMs: Date.parse('2026-10-27T09:05:00Z') })
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nextRetryAtMs: Date.parse('2026-10-27T09:05:00Z') })
    const restarted = await restartModules()
    expect(recoveryRow(restarted.database, CHECK_17)).toMatchObject({ nextRetryAtMs: Date.parse('2026-10-27T09:05:00Z') })
    vi.setSystemTime(new Date('2026-10-27T09:01:01Z'))
    mocks.runFile.mockClear()
    restarted.behaviors.startBehaviorsRuntime()
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(resolveCalls().map(([, args]) => args[1])).not.toContain('#17')
  })

  it('settles a secondary limit before any mutation while another target resolves', async () => {
    arrangeCli(false, false, {
      unresolvedConversationCount: 1,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
      activeChangeRequestAuthors: [],
      resolveResolvedCount: 1,
    })
    scriptResolve((pullNumber) => pullNumber === 17 ? { error: secondaryLimitError(true) } : 'delegate')
    const { db, runtime } = await startResolveRuntime()

    await runtime.runEnabledBehaviorsOnce()

    // The unrelated target still resolves.
    expect(runtime.getResolveUnblockingLastFired()).toEqual({ at: expect.any(String), target: `${pr.repo}#18` })
    // The admitted invocation keeps its typed failure with GitHub's stated backoff.
    const failure = failureRow(db, CHECK_17)!
    expect(failure).toMatchObject({ kind: 'operation', diagnostic: { severity: 'info', code: 'rate_limit' } })
    expect(failure.nextRetryAtMs as number).toBeGreaterThan(failure.lastFailureAtMs as number)
    // Target, typed failure, backoff and side-effect certainty are retained.
    const recovery = recoveryRow(db, CHECK_17)!
    expect(recovery).toMatchObject({ code: 'rate_limit', nextRetryAtMs: failure.nextRetryAtMs, sideEffects: 'none', head: HEAD_SHA, unresolvedBefore: 1 })
    const [admission] = admissionsFor(17)
    expect(recovery.nativeId).toBe(admission!.nativeId)
    expect(failure.correlationId).toBe(admission!.nativeId)
    const [run] = db.db.prepare('SELECT behavior, status, note FROM behavior_runs WHERE note LIKE ?').all(`%${CHECK_17}%`) as Array<{ behavior: string, status: string, note: string }>
    expect(run).toMatchObject({ behavior: 'resolve-unblocking', status: 'failed' })
    expect(run!.note).toContain(`target=${CHECK_17}`)
    expect(run!.note).toContain('code=rate_limit')
    expect(run!.note).toContain(`retry=${new Date(failure.nextRetryAtMs as number).toISOString()}`)
    expect(run!.note).toContain('side_effects=none')
    // Proven no action settles the firing terminally.
    expect(outcomesFor(admission!.nativeId)).toEqual([expect.objectContaining({
      state: 'failed', activity: 'settled', completedAt: expect.any(String),
    })])

    // After the retry deadline, fresh evidence clears the record without resolving anything.
    expireBackoff(db, CHECK_17)
    arrangeCli(false, false, {
      unresolvedConversationCount: 0,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
      activeChangeRequestAuthors: [],
    })
    mocks.runFile.mockClear()
    const outcomesBefore = mocks.captureOutcome.mock.calls.length
    await runtime.runEnabledBehaviorsOnce()

    expect(resolveCalls()).toHaveLength(0)
    expect(failureRow(db, CHECK_17)).toBeNull()
    expect(recoveryRow(db, CHECK_17)).toBeNull()
    expect(mocks.captureOutcome.mock.calls.length).toBe(outcomesBefore)
  })

  it('reconciles an ambiguous response from later thread evidence while another target resolves', async () => {
    arrangeCli(false, false, {
      unresolvedConversationCount: 1,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
      activeChangeRequestAuthors: [],
      resolveResolvedCount: 1,
    })
    scriptResolve((pullNumber) => pullNumber === 17 ? { stdout: '{}' } : 'delegate')
    const { db, runtime } = await startResolveRuntime()

    await runtime.runEnabledBehaviorsOnce()

    expect(runtime.getResolveUnblockingLastFired()).toEqual({ at: expect.any(String), target: `${pr.repo}#18` })
    const failure = failureRow(db, CHECK_17)!
    expect(failure).toMatchObject({ kind: 'operation', diagnostic: { code: 'unknown' } })
    const recovery = recoveryRow(db, CHECK_17)!
    expect(recovery).toMatchObject({ code: 'unknown', sideEffects: 'uncertain', head: HEAD_SHA, unresolvedBefore: 1 })
    const [admission] = admissionsFor(17)
    const [held] = outcomesFor(admission!.nativeId)
    expect(held).toMatchObject({ state: 'held', activity: 'unknown' })
    expect(held!.completedAt).toBeUndefined()
    const [run] = db.db.prepare('SELECT status, note FROM behavior_runs WHERE note LIKE ?').all(`%${CHECK_17}%`) as Array<{ status: string, note: string }>
    expect(run).toMatchObject({ status: 'failed' })
    expect(run!.note).toContain('side_effects=uncertain')

    // After the retry deadline, empty threads recover the retained firing without a mutation.
    expireBackoff(db, CHECK_17)
    arrangeCli(false, false, {
      unresolvedConversationCount: 0,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
      activeChangeRequestAuthors: [],
    })
    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()

    expect(resolveCalls()).toHaveLength(0)
    expect(outcomesFor(admission!.nativeId)).toEqual([
      expect.objectContaining({ state: 'held', activity: 'unknown' }),
      expect.objectContaining({ state: 'completed', activity: 'settled', outcome: 'no_op', head: HEAD_SHA, completedAt: expect.any(String) }),
    ])
    expect(failureRow(db, CHECK_17)).toBeNull()
    expect(recoveryRow(db, CHECK_17)).toBeNull()
  })

  it('retains earlier uncertainty when a later invocation still leaves unresolved work', async () => {
    arrangeCli(false, false, {
      unresolvedConversationCount: 1,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
      activeChangeRequestAuthors: [],
      resolveResolvedCount: 1,
    })
    scriptResolve((pullNumber) => pullNumber === 17 ? { stdout: '{}' } : 'delegate')
    const { db, runtime } = await startResolveRuntime()

    await runtime.runEnabledBehaviorsOnce()
    const [admission] = admissionsFor(17)
    expect(outcomesFor(admission!.nativeId)).toEqual([expect.objectContaining({ state: 'held' })])

    // A moved head keeps the counts ambiguous, and a change request needs a person:
    // the diagnostic becomes a user-action disposition, not a resolve call.
    expireBackoff(db, CHECK_17)
    arrangeCli(false, false, {
      unresolvedConversationCount: 1,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: NEXT_HEAD_SHA,
      activeChangeRequestAuthors: ['octocat'],
      headSha: NEXT_HEAD_SHA,
    })
    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()

    expect(resolveCalls()).toHaveLength(0)
    expect(failureRow(db, CHECK_17)).toMatchObject({
      kind: 'worker',
      diagnostic: { severity: 'warning', code: 'held_result' },
      error: expect.stringContaining('changes requested by octocat'),
    })
    expect(failureRow(db, CHECK_17)!.error).toContain('left conversation state uncertain')
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ sideEffects: 'uncertain', nativeId: admission!.nativeId })
    expect(outcomesFor(admission!.nativeId)).toHaveLength(1)

    // A later invocation with unresolved work cannot settle the older write.
    expireBackoff(db, CHECK_17)
    arrangeCli(false, false, {
      unresolvedConversationCount: 1,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: NEXT_HEAD_SHA,
      activeChangeRequestAuthors: [],
      headSha: NEXT_HEAD_SHA,
      resolveUnresolvedCount: 1,
      resolveBlockers: ['required_checks_not_green'],
    })
    scriptResolve(() => 'delegate')
    await runtime.runEnabledBehaviorsOnce()

    expect(resolveCalls().map(([, args]) => args[1])).toContain('#17')
    expect(outcomesFor(admission!.nativeId)).toEqual([expect.objectContaining({ state: 'held', activity: 'unknown' })])
    expect(admissionsFor(17)).toHaveLength(2)
    expect(failureRow(db, CHECK_17)).toMatchObject({ kind: 'worker' })
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: admission!.nativeId, sideEffects: 'uncertain' })
  })

  it('treats a secondary limit without the no-action marker as uncertain', async () => {
    arrangeCli(false, false, {
      unresolvedConversationCount: 1,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
      activeChangeRequestAuthors: [],
      resolveResolvedCount: 1,
    })
    scriptResolve((pullNumber) => pullNumber === 17 ? { error: secondaryLimitError(false) } : 'delegate')
    const { db, runtime } = await startResolveRuntime()

    await runtime.runEnabledBehaviorsOnce()

    expect(runtime.getResolveUnblockingLastFired()).toEqual({ at: expect.any(String), target: `${pr.repo}#18` })
    expect(failureRow(db, CHECK_17)).toMatchObject({ kind: 'operation', diagnostic: { code: 'rate_limit' } })
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ code: 'rate_limit', sideEffects: 'uncertain' })
    const [admission] = admissionsFor(17)
    expect(outcomesFor(admission!.nativeId)).toEqual([expect.objectContaining({ state: 'held', activity: 'unknown' })])
  })

  it.each([
    { name: 'safe no-effect', marked: true, sideEffects: 'none' },
    { name: 'uncertain mutation', marked: false, sideEffects: 'uncertain' },
  ])('retains a bounded actionable cause for a $name failure', async ({ marked, sideEffects }) => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    const message = `GitHub 403 rate-limit: quota exhausted for this test ${marked ? '(no conversation was resolved before this failure)' : ''}`
    scriptResolve((number) => number === 17 ? { error: Object.assign(new Error(message), { stderr: message }) } : 'delegate')
    const { db, runtime } = await startResolveRuntime()
    await runtime.runEnabledBehaviorsOnce()
    const recovery = recoveryRow(db, CHECK_17)!
    expect(recovery).toMatchObject({ sideEffects, head: HEAD_SHA, actor: 'review-bot' })
    expect(typeof recovery.cause).toBe('string')
    expect((recovery.cause as string).length).toBeGreaterThan(0)
    expect((recovery.cause as string).length).toBeLessThanOrEqual(300)
    expect(recovery.cause).toContain('quota exhausted for this test')
    const [admission] = admissionsFor(17)
    expect(recovery.nativeId).toBe(admission!.nativeId)
    const run = db.db.prepare('SELECT note FROM behavior_runs WHERE id = ?').get(admission!.nativeId) as { note: string }
    expect(run.note).toContain(`side_effects=${sideEffects}`)
    expect(run.note).toContain('cause=')
    expect(run.note).toContain('quota exhausted for this test')
  })

  it('preserves original head, actor and correlation through a direct supersession', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA, resolveSuperseded: true })
    const { db, runtime } = await startResolveRuntime()
    await runtime.runEnabledBehaviorsOnce()
    const [admission] = admissionsFor(17)
    expect(admission).toMatchObject({ head: HEAD_SHA, actor: 'review-bot' })
    expect(outcomesFor(admission!.nativeId)).toEqual([expect.objectContaining({
      state: 'superseded', activity: 'settled', outcome: 'superseded', head: NEXT_HEAD_SHA,
    })])
    const receiptRaw = db.getMeta(`behavior_resolve_unblocking_recovery:${CHECK_17}:receipt:${admission!.nativeId}`)
    expect(receiptRaw).toBeTruthy()
    const receipt = JSON.parse(receiptRaw!)
    expect(receipt).toMatchObject({ nativeId: admission!.nativeId, head: HEAD_SHA, actor: 'review-bot',
      disposition: 'superseded', targetDisposition: 'superseded', observedHead: NEXT_HEAD_SHA })
    expect(receipt.observedHead).not.toBe(receipt.head)
    expect(recoveryRow(db, CHECK_17)).toBeNull()
    expect(db.db.prepare('SELECT id FROM behavior_runs WHERE id = ?').get(admission!.nativeId)).toBeUndefined()
  })

  it('preserves a late superseded receipt without disturbing its newer owner', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    const { db, runtime } = await startResolveRuntime()
    const newerId = 'e'.repeat(32)
    scriptResolve((number) => {
      if (number !== 17) return 'delegate'
      const pending = recoveryRow(db, CHECK_17)!
      db.setMeta(`behavior_resolve_unblocking_recovery:${CHECK_17}`, JSON.stringify({ ...pending,
        nativeId: newerId, code: 'newer-attempt', previous: [pending] }))
      return { stdout: JSON.stringify({ action: 'resolved_nonblocking_conversations_if_ready',
        repository: pr.repo, pull_number: 17, outcome: 'superseded',
        head_sha: HEAD_SHA, current_head_sha: NEXT_HEAD_SHA }) }
    })
    await runtime.runEnabledBehaviorsOnce()
    const [original] = admissionsFor(17)
    expect(recoveryRow(db, CHECK_17)).toMatchObject({ nativeId: newerId, code: 'newer-attempt' })
    expect(outcomesFor(newerId)).toEqual([])
    expect(outcomesFor(original!.nativeId)).toEqual([expect.objectContaining({
      state: 'superseded', activity: 'settled', outcome: 'superseded', head: NEXT_HEAD_SHA,
    })])
    const receipt = JSON.parse(db.getMeta(
      `behavior_resolve_unblocking_recovery:${CHECK_17}:receipt:${original!.nativeId}`)!)
    expect(receipt).toMatchObject({ nativeId: original!.nativeId, head: HEAD_SHA, actor: 'review-bot',
      disposition: 'superseded', targetDisposition: 'superseded', observedHead: NEXT_HEAD_SHA })
  })

  it('preserves the failure cause through a later merge supersession', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA })
    scriptResolve((number) => number === 17 ? { error: new Error('response lost after partial resolution') } : 'delegate')
    const { db, runtime } = await startResolveRuntime()
    await runtime.runEnabledBehaviorsOnce()
    const [admission] = admissionsFor(17)
    const before = recoveryRow(db, CHECK_17)!
    expect(before).toMatchObject({ nativeId: admission!.nativeId, sideEffects: 'uncertain' })
    expect(before.cause).toContain('response lost after partial resolution')
    expireBackoff(db, CHECK_17)
    fixture.listedPrs = [fixture.listedPrs[1]!]
    arrangeCli(false, false, { state: 'MERGED', unresolvedConversationCount: 1, reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA, headSha: NEXT_HEAD_SHA })
    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()
    expect(recoveryRow(db, CHECK_17)).toBeNull()
    const run = db.db.prepare('SELECT note FROM behavior_runs WHERE id = ?').get(admission!.nativeId) as { note: string }
    const receipt = JSON.parse(run.note)
    expect(receipt).toMatchObject({ nativeId: admission!.nativeId, head: HEAD_SHA, actor: 'review-bot',
      disposition: 'superseded', targetDisposition: 'superseded', observedHead: NEXT_HEAD_SHA,
      sideEffects: 'uncertain', cause: expect.stringContaining('response lost after partial resolution') })
    expect(outcomesFor(admission!.nativeId)).toEqual([expect.objectContaining({ state: 'held' }),
      expect.objectContaining({ state: 'superseded', head: NEXT_HEAD_SHA })])
  })
})
