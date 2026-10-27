import { describe, expect, it } from 'vitest'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, arrangeCli, fixture } from './behaviors-runtime-fixture'

const CHECK_17 = `${pr.repo}#17:check`
const SECONDARY_LIMIT_BODY = '{"message": "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}'

function secondaryLimitError(marked: boolean): Error {
  const stderr = `error: GitHub 403 rate-limit: {'x-ratelimit-resource': 'core', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '58', 'x-ratelimit-used': '4942', 'x-ratelimit-reset': '1792870000', 'retry-after': '300'} body=${SECONDARY_LIMIT_BODY}${marked ? ' (no conversation was resolved before this failure)' : ''}`
  return Object.assign(new Error('Command failed (1): github-interface'), { stdout: '', stderr })
}

type ResolveScript = (pullNumber: number) => 'delegate' | { stdout: string } | { error: unknown }

function scriptResolve(handler: ResolveScript): void {
  const base = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
    if (command === 'github-interface' && args[0] === '--resolve-nonblocking-conversations-if-ready') {
      const outcome = handler(Number(String(args[1]).replace(/^#/, '')))
      if (outcome === 'delegate') return base(command, args, options)
      if ('error' in outcome) throw outcome.error
      return { stdout: outcome.stdout, stderr: '' }
    }
    return base(command, args, options)
  })
}

function resolveCalls(): unknown[][] {
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
}

function admissionsFor(pullNumber: number): Array<{ nativeId: string }> {
  return mocks.captureAdmission.mock.calls.map(([admission]) => admission)
    .filter((admission) => admission.behavior === 'resolve-unblocking' && admission.number === pullNumber)
}

function outcomesFor(nativeId: string): Array<Record<string, unknown>> {
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

  it('holds an uncertain target that needs a person until a reconciled retry supersedes it', async () => {
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

    // Once eligible again, a reconciled retry runs and its authoritative result
    // settles the retained firing as superseded.
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
    expect(outcomesFor(admission!.nativeId)).toEqual([
      expect.objectContaining({ state: 'held', activity: 'unknown' }),
      expect.objectContaining({ state: 'superseded', activity: 'settled', completedAt: expect.any(String) }),
    ])
    expect(admissionsFor(17)).toHaveLength(2)
    expect(failureRow(db, CHECK_17)).toBeNull()
    expect(recoveryRow(db, CHECK_17)).toBeNull()
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
})
