import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, restartModules, resetLogCache, arrangeCli, agentLog, launchReviewBeforeCrash, launchApprovalBeforeCrash, fixture } from './behaviors-runtime-fixture'

describe('review outcome evidence and registration', () => {

  it.each(['valid', 'head', 'actor', 'source', 'receipt', 'pending', 'unclaimed', 'missing-inventory', 'running', 'quarantine', 'late-quarantine', 'ambiguous', 'claimed-sibling'])('explicit operator retry preserves publication and ownership guards (%s)', async (variant) => {
    const launched = await launchReviewBeforeCrash()
    const failed = agentLog({ id: 'f'.repeat(32), started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      status: 'failed', error: 'review behavior must produce exactly one atomic clean or change-request review',
      error_code: 'review_contract_violation', review_policy: 'bounded-v1', model: 'opus-5-xhigh',
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId })
    fixture.agentLogs = [failed]
    await resetLogCache()
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).not.toBeNull()
    if (variant === 'actor') failed.actor = 'another-account'
    if (variant === 'source') failed.source = 'another-system'
    if (variant === 'receipt') failed.review_id = 91
    if (variant === 'quarantine') modules.database.db.prepare("UPDATE behavior_seen SET launch_quarantine = 'unreadable' WHERE target = ?").run(launched.target)
    if (variant === 'ambiguous') fixture.agentLogs.push({ ...failed, id: 'e'.repeat(32) })
    await resetLogCache()
    if (variant === 'running') fixture.agentLogs.push(agentLog({ id: 'e'.repeat(32), correlation_id: 'running-sibling' }))
    await resetLogCache()
    if (variant === 'claimed-sibling') fixture.agentLogs.push(agentLog({ id: 'e'.repeat(32), correlation_id: 'completed-sibling',
      status: 'completed', action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA, review_id: 91 }))
    await resetLogCache()
    arrangeCli(false, false, { headSha: variant === 'head' ? NEXT_HEAD_SHA : HEAD_SHA,
      ...(variant === 'missing-inventory' ? {} : { reviewerReviewIdsSince: ['unclaimed', 'claimed-sibling'].includes(variant) ? [91] : [] }),
      reviewerPendingReviews: variant === 'pending' ? 1 : 0 })
    if (variant === 'late-quarantine') {
      const implementation = mocks.runFile.getMockImplementation()!
      mocks.runFile.mockImplementation(async (...args: any[]) => {
        const result = await implementation(...args)
        if (args[1][0] === '--review-activity-since') modules.database.db.prepare("UPDATE behavior_seen SET launch_quarantine = 'unreadable' WHERE target = ?").run(launched.target)
        return result
      })
    }
    if (variant === 'valid' || variant === 'claimed-sibling') {
      await expect(modules.behaviors.retryFailedPrReviews([failed.id])).resolves.toEqual({ ok: true, targets: [launched.target] })
      expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).toBeNull()
      expect(modules.database.getMeta(`behavior_operator_retry:${failed.id}`)).toContain(launched.correlationId)
      expect(modules.database.listBehaviorDeadLetters()).toEqual([])
      await modules.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
      await expect(modules.behaviors.retryFailedPrReviews([failed.id])).rejects.toThrow()
    } else {
      await expect(modules.behaviors.retryFailedPrReviews([failed.id])).rejects.toThrow()
      expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).not.toBeNull()
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    }
  })

  it.each(['valid', 'head', 'actor', 'source', 'model', 'receipt', 'old', 'ambiguous', 'claimed', 'newest-claimed', 'posted-original'])('reconciles a held review only from a verified explicit replay (%s)', async (variant) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
    const launched = await launchReviewBeforeCrash()
    const failed = agentLog({
      id: 'f'.repeat(32), started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      status: 'failed', action: 'not_started', outcome: 'preflight_failed', model: 'opus-5-xhigh',
      review_policy: 'bounded-v1', error_code: 'review_provider_blocked', error: 'account blocked',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })
    if (variant === 'posted-original') Object.assign(failed, { action: null, outcome: null })
    fixture.agentLogs = [failed]
    await resetLogCache()
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).not.toBeNull()
    vi.setSystemTime(Date.now() + 2_000)
    const replay = agentLog({
      id: 'e'.repeat(32), model: 'opus-5-xhigh', status: 'completed',
      action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA,
      source: 'poise:replay', correlation_id: 'explicit-replay', review_id: 91,
    })
    if (variant === 'head') replay.head_sha = NEXT_HEAD_SHA
    if (variant === 'actor') replay.actor = 'another-account'
    if (variant === 'source') replay.source = 'another-system'
    if (variant === 'model') replay.model = 'gpt-6-astra-ultra'
    if (variant === 'old') Object.assign(replay, { started_at: launched.requestedAt, started_at_precise: launched.requestedAt })
    fixture.agentLogs.push(replay)
    await resetLogCache()
    if (variant === 'newest-claimed') {
      vi.setSystemTime(Date.now() + 1_000)
      fixture.agentLogs.push(agentLog({ ...replay, id: 'd'.repeat(32), correlation_id: 'newer-replay', review_id: 92,
        started_at: new Date().toISOString(), started_at_precise: new Date().toISOString(), completed_at: new Date().toISOString() }))
      await resetLogCache()
    }
    if (variant === 'ambiguous') fixture.agentLogs.push({ ...replay, id: 'd'.repeat(32) })
    await resetLogCache()
    arrangeCli(false, false, { reviewerReviewIdsSince: variant === 'receipt' ? [] : variant === 'newest-claimed' ? [91, 92] : [91] })
    modules = await restartModules()
    if (variant === 'claimed' || variant === 'newest-claimed') {
      modules.database.recordSeen('review-new-prs', 'another-slot')
      modules.database.db.prepare('UPDATE behavior_seen SET launch_call_id = ? WHERE target = ?').run(variant === 'claimed' ? replay.id : 'd'.repeat(32), 'another-slot')
    }
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    if (variant === 'valid' || variant === 'newest-claimed') {
      expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).toBeNull()
      expect(modules.database.latestApprovalBasisLaunch(pr.repo, pr.number)).toEqual({
        callId: replay.id, completedAt: replay.completed_at, headSha: HEAD_SHA,
      })
      expect(modules.database.listBehaviorDeadLetters()).toEqual([])
      modules = await restartModules()
      modules.database.setMeta('behavior_approve_prs_enabled', '1')
      modules.behaviors.startBehaviorsRuntime()
      await modules.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
      expect(mocks.spawnDetached.mock.calls[1][1]).toContain('--pr-approve')
    } else {
      expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).not.toBeNull()
      expect(modules.database.latestApprovalBasisLaunch(pr.repo, pr.number)).toBeNull()
    }
  })

  it.each(['model_output_limit', 'review_recovery_failed', 'review_contract_violation', 'review_provider_blocked', 'stopped'])('holds %s across restarts, without blocking another PR or a new head', async (code) => {
    const behavior = 'approve-prs' as 'review-new-prs' | 'approve-prs'
    const launched = behavior === 'review-new-prs'
      ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'f'.repeat(32),
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      status: 'failed', action: null, outcome: null, model: 'opus-5-xhigh', review_policy: 'bounded-v1',
      error_code: code, error: 'Review needs attention',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })]
    await resetLogCache()
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.hasSeen(behavior, launched.target)).toBe(true)
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    expect(modules.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.observeAuthFailure).not.toHaveBeenCalled()
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    fixture.listedPrs = [pr, { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
    arrangeCli(behavior === 'approve-prs', false, { headSha: NEXT_HEAD_SHA })
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
  })

  it('recovers a terminal failed approval only after GitHub proves no reviewer action', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchApprovalBeforeCrash()
    const callId = '1'.repeat(32)
    fixture.agentLogs = [agentLog({
      id: callId,
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      error: 'legacy preflight timeout',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(db.hasSeen('approve-prs', launched.target)).toBe(true)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    arrangeCli(true, false, { reviewerReviewsSince: 1 })
    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    arrangeCli(true, false, { reviewerReviewsSince: 0, reviewerPendingReviews: 0 })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('releases a superseded review without degradation and reviews the current head', async () => {
    const launched = await launchReviewBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'd'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'failed',
      error: 'pull-request head changed during behavior execution',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, state: 'superseded', stateSource: 'native',
    }))
  })

  it('waits through bounded registration grace before retrying a missing call', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, launch_error FROM behavior_seen
      WHERE key = 'review-new-prs' AND target = ?
    `).get(launched.target)).toMatchObject({
      claim_id: expect.any(String),
      launch_error: 'awaiting agent call registration',
    })

    db.db.prepare(`
      UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
      WHERE key = 'review-new-prs' AND target = ?
    `).run(
      new Date(Date.now() - runtime.BEHAVIOR_REGISTRATION_GRACE_MS - 1_000).toISOString(),
      Date.now() - 1,
      launched.target,
    )
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('retains an ambiguous post-watermark review registration without retrying', async () => {
    const launched = await launchReviewBeforeCrash()
    const after = Date.parse(launched.requestedAt) + 1_000
    fixture.agentLogs = [
      agentLog({
        id: 'd'.repeat(32),
        started_at: new Date(after).toISOString(),
        started_at_precise: new Date(after).toISOString(),
        status: 'running',
        correlation_id: launched.correlationId,
      }),
      agentLog({
        id: 'e'.repeat(32),
        started_at: new Date(after + 1_000).toISOString(),
        started_at_precise: new Date(after + 1_000).toISOString(),
        completed_at: new Date(after + 2_000).toISOString(),
        status: 'completed',
        action: 'reviewed_clean',
        outcome: 'clean',
        head_sha: launched.expectedHead,
        response: 'clean',
        correlation_id: launched.correlationId,
      }),
    ]
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, lease_until, launch_call_id, launch_error
      FROM behavior_seen WHERE key = 'review-new-prs' AND target = ?
    `).get(launched.target)).toMatchObject({
      claim_id: '',
      lease_until: null,
      launch_call_id: null,
      launch_error: expect.stringContaining('ambiguous correlation id matched'),
    })
  })
})
