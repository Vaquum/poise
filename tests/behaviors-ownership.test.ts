import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LedgerAdmission, LedgerResult } from '../server/behavior-ledger-contract'
import { mocks, pr, HEAD_SHA, loadModules, arrangeCli, agentLog, fixture } from './behaviors-runtime-fixture'

describe('launch ownership and resolution', () => {

  it('never overlaps initial review and approval for the same PR', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T11:40:00.000Z'))
    arrangeCli(false, false, { requestedReviewers: ['review-bot'] })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_approve_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-review')
    expect(mocks.runFile.mock.calls.some(
      ([command, args]) => command === 'github-interface'
        && args[0] === '--review-activity-since',
    )).toBe(false)

    const reviewRow = db.db.prepare(`
      SELECT
        launch_requested_at AS requestedAt,
        launch_correlation_id AS correlationId,
        launch_expected_head AS expectedHead,
        launch_actor AS actor,
        launch_source AS source
      FROM behavior_seen
      WHERE key = 'review-new-prs' AND target = ?
    `).get(`${pr.repo}#${pr.number}`) as {
      requestedAt: string
      correlationId: string
      expectedHead: string
      actor: string
      source: string
    }
    const reviewExit = (mocks.spawnDetached.mock.calls[0][2] as {
      onExit: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    }).onExit
    reviewExit({ code: 0, signal: null })
    fixture.agentLogs = [agentLog({
      id: 'd'.repeat(32),
      started_at: reviewRow.requestedAt,
      started_at_precise: new Date(Date.parse(reviewRow.requestedAt) + 1).toISOString(),
      completed_at: '2026-07-15T11:45:00.000Z',
      status: 'completed',
      action: 'reviewed_clean',
      outcome: 'clean',
      head_sha: HEAD_SHA,
      expected_head: reviewRow.expectedHead,
      actor: reviewRow.actor,
      source: reviewRow.source,
      correlation_id: reviewRow.correlationId,
      response: 'reviewed-clean',
    })]
    vi.setSystemTime(new Date('2026-07-15T11:45:00.000Z'))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('--pr-approve')
  })

  it('does not infer a clean outcome from a legacy process exit', async () => {
    arrangeCli(false, false, { requestedReviewers: ['review-bot'] })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    const target = `${pr.repo}#${pr.number}@legacy-head`
    const claimId = db.claimSeenOwned('review-new-prs', target)!
    db.markBehaviorLaunchIntentOwned({
      key: 'review-new-prs',
      target,
      claimId,
      launchBehavior: 'pr_review',
      repo: pr.repo,
      pr: pr.number,
      requestedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      expectedHead: HEAD_SHA,
      actor: 'review-bot',
      source: 'poise:review-new-prs',
      correlationId: claimId,
    })
    db.completeSeenOwned('review-new-prs', target, claimId)

    await runtime.setEnabled('review-new-prs', false)
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('coalesces sibling-process lock contention without opening a breaker', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.lockContention = true

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])

    mocks.lockContention = false
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('requires a fresh live auth gate before a scheduled worker launch', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.requireAuth.mockImplementation((options?: { liveWithinMs?: number }) => {
      if (options?.liveWithinMs === 60_000) {
        mocks.authStatus = 'degraded'
        throw new Error('fresh Claude canary failed')
      }
    })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.requireAuth).toHaveBeenCalledWith({ liveWithinMs: 60_000 })
    expect(mocks.authStatus).toBe('degraded')
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('keeps one durable in-flight worker per PR', async () => {
    const secondPr = {
      repo: 'Vaquum/poise-second',
      number: 18,
      url: 'https://github.com/Vaquum/poise-second/pull/18',
      status: 'open',
      author: 'poise-user',
      draft: 0,
    }
    fixture.listedPrs = [pr, secondPr]
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached).toHaveBeenCalledWith(
      'agent-interface',
      expect.arrayContaining(['--pr-review', `#${pr.number}`]),
      expect.any(Object),
    )
    expect(mocks.spawnDetached).toHaveBeenCalledWith(
      'agent-interface',
      expect.arrayContaining(['--pr-review', `#${secondPr.number}`]),
      expect.any(Object),
    )
  })

  it('keeps GitHub-only unblocking active during a Claude auth outage', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 1 })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    mocks.authStatus = 'reauth_required'

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile).toHaveBeenCalledWith(
      'github-interface',
      [
        '--resolve-nonblocking-conversations-if-ready',
        `#${pr.number}`,
        '--username',
        'review-bot',
        '--expected-head',
        HEAD_SHA,
        '--token-user',
        'review-bot',
      ],
      expect.any(Object),
    )
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('does not retain idle resolution polls as successful runs', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, resolveUnresolvedCount: 1 })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')

    for (let tick = 0; tick < 3; tick++) await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--resolve-nonblocking-conversations-if-ready')).toHaveLength(3)
    expect(db.db.prepare('SELECT * FROM behavior_runs').all()).toEqual([])
    expect(runtime.getResolveUnblockingLastFired()).toBeNull()
    expect(mocks.captureAdmission).toHaveBeenCalledTimes(3)
    expect(new Set(mocks.captureAdmission.mock.calls.map(([admission]) => admission.nativeId)).size).toBe(3)
    expect(mocks.captureOutcome.mock.calls.map(([result]) => result)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({
      state: 'completed', outcome: 'waiting', activity: 'settled',
    })))
  })

  it.each(['absent', 'healthy', 'failed'] as const)('preserves resolution execution with %s real ledger capture', async (mode) => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, resolveUnresolvedCount: 1 })
    const { database: db, behaviors: runtime } = await loadModules()
    const { BehaviorLedgerObserver } = await vi.importActual<typeof import('../server/behavior-ledger')>('../server/behavior-ledger')
    const observer = mode === 'absent' ? null : new BehaviorLedgerObserver({ path: mode === 'failed'
      ? join(fixture.tempRoot, 'cache.db', 'behavior-ledger.db') : join(fixture.tempRoot, 'behavior-ledger.db') })
    try {
      if (observer) {
        await observer.start()
        mocks.captureAdmission.mockImplementation((input: Omit<LedgerAdmission, 'type'>) => observer.capture({ ...input, type: 'admit' }))
        mocks.captureOutcome.mockImplementation((input: Omit<LedgerResult, 'type'>) => observer.capture({ ...input, type: 'result' }))
      }
      db.setMeta('me', 'poise-user')
      db.setMeta('behavior_resolve_unblocking_enabled', '1')
      await runtime.runEnabledBehaviorsOnce()

      expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--resolve-nonblocking-conversations-if-ready')
        .map(([command, args]) => [command, args])).toEqual([['github-interface', [
        '--resolve-nonblocking-conversations-if-ready', '#17', '--username', 'review-bot',
        '--expected-head', HEAD_SHA, '--token-user', 'review-bot',
      ]]])
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
      expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs')).toEqual([])
      expect(db.db.prepare('SELECT * FROM behavior_runs').all()).toEqual([])
      expect(db.db.prepare('SELECT key, target FROM behavior_seen').all()).toEqual([])
      expect(db.db.prepare("SELECT key FROM meta WHERE key LIKE 'behavior_%_failure%' AND value <> ''").all()).toEqual([])
      const { readBehaviorMetrics } = await import('../server/behavior-metrics')
      expect(readBehaviorMetrics([], { since: null, until: null }, null).behaviors['resolve-unblocking'])
        .toEqual({ totalRuns: 0, durationMinutes: 0, successRate: null })

      if (observer) {
        const reply = await observer.read({ operation: 'list' })
        if (mode === 'healthy') {
          expect(reply.status).toBe(200)
          expect(reply.body.records).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'firing', behavior: 'resolve-unblocking', state: 'completed', outcome: 'waiting' }),
            expect.objectContaining({ kind: 'attempt', head: HEAD_SHA, state: 'completed', activity: 'settled' }),
          ]))
        } else {
          expect(reply.status).toBe(503)
          expect(reply.body.health.status).toBe('unavailable')
          expect(reply.body.health.dropped).toBeGreaterThan(0)
          expect(reply.body.records).toBeUndefined()
        }
      }
    } finally {
      await observer?.stop()
    }
  })

  it.each([
    { resolveResolvedCount: 1, status: 'completed' },
    { resolveError: true, status: 'failed' },
  ])('retains actual resolution results as $status runs', async ({ status, ...result }) => {
    arrangeCli(false, false, { unresolvedConversationCount: 1, ...result })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    expect(db.db.prepare('SELECT behavior, status FROM behavior_runs').all())
      .toEqual([{ behavior: 'resolve-unblocking', status }])
  })
})
