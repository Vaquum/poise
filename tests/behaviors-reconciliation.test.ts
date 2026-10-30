import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, restartModules, resetLogCache, agentLog, launchReviewBeforeCrash, launchApprovalBeforeCrash, fixture } from './behaviors-runtime-fixture'

describe('durable launch reconciliation', () => {

  it('links a unique running review call after restart and renews without duplicate launch', async () => {
    const launched = await launchReviewBeforeCrash()
    const callId = 'a'.repeat(32)
    fixture.agentLogs = [agentLog({
      id: callId,
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'running',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, lease_until, launch_call_id, launch_error
      FROM behavior_seen WHERE key = 'review-new-prs' AND target = ?
    `).get(launched.target)).toMatchObject({
      claim_id: expect.any(String),
      lease_until: expect.any(Number),
      launch_call_id: callId,
      launch_error: null,
    })
    const leaseUntil = db.db.prepare(`
      SELECT lease_until FROM behavior_seen WHERE key = 'review-new-prs' AND target = ?
    `).pluck().get(launched.target) as number
    expect(leaseUntil).toBeGreaterThan(Date.now())

    fixture.agentLogs = []
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, launch_call_id, launch_error
      FROM behavior_seen WHERE key = 'review-new-prs' AND target = ?
    `).get(launched.target)).toMatchObject({
      claim_id: expect.any(String),
      launch_call_id: callId,
      launch_error: 'awaiting linked agent call visibility',
    })
    expect(db.listBehaviorDeadLetters()).toEqual([])
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('quarantines only the corrupt %s launch across restart and registration expiry', async (behavior) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = behavior === 'review-new-prs'
      ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    fixture.agentLogs = [agentLog({
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      status: 'completed', // Missing the terminal outcome: parser quarantines this row.
      actor: launched.actor, source: launched.source, expected_head: launched.expectedHead,
      correlation_id: launched.correlationId,
    })]
    vi.setSystemTime(Date.now() + 6 * 60_000)
    fixture.listedPrs.push({ ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` })
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
    expect(db.listBehaviorLaunchClaims(behavior).find((claim) => claim.target === launched.target)).toMatchObject({
      claimId: launched.correlationId,
      launchError: expect.stringContaining('agent log row quarantined'),
    })
    expect(db.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: launched.target })])
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('reconciles healthy exact results beside an unidentified row without releasing a missing launch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    fixture.listedPrs.push({ ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` })
    await launched.behaviors.runEnabledBehaviorsOnce()
    fixture.agentLogs = [agentLog({
      status: 'completed', action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA,
      actor: launched.actor, source: launched.source, expected_head: launched.expectedHead,
      correlation_id: launched.correlationId,
    }), { corrupt: true }]
    vi.setSystemTime(Date.now() + 6 * 60_000)
    fixture.listedPrs.push({ ...pr, number: 19, url: `https://github.com/${pr.repo}/pull/19` })
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(db.listBehaviorLaunchClaims('review-new-prs').map((claim) => claim.target)).toEqual([
      `${pr.repo}#18`, `${pr.repo}#19`,
    ])
    expect(db.listBehaviorLaunchClaims('review-new-prs')[0].launchError).toContain('agent log row quarantined')
    expect(db.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: `${pr.repo}#18` })])
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(mocks.spawnDetached.mock.calls[2][1]).toContain('#19')
  })

  it.each(['id', 'correlation_id'] as const)('holds an apparent success when a quarantined row duplicates its %s', async (duplicateField) => {
    const launched = await launchReviewBeforeCrash()
    const completed = agentLog({
      status: 'completed', action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA,
      actor: launched.actor, source: launched.source, expected_head: launched.expectedHead,
      correlation_id: launched.correlationId,
    })
    fixture.agentLogs = [completed, {
      id: 'b'.repeat(32), correlation_id: 'another-correlation',
      repo: 'other/unrelated', pr_id: '999', behavior: 'issue_review',
      [duplicateField]: completed[duplicateField],
    }]
    fixture.listedPrs.push({ ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` })
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.target === launched.target)).toMatchObject({
      launchQuarantine: 'invalid_result',
      launchError: 'completed agent evidence conflicts with another record for the same launch',
    })
    expect(db.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: launched.target })])
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('alerts once per held cause and renews a dismissed alert when the cause changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    const alerts = () => launched.database.db.prepare('SELECT kind, title, dedupe_key AS key, resolved_at AS resolved FROM alerts ORDER BY id').all()
    fixture.agentLogs = [agentLog({
      status: 'failed', error: 'model unavailable',
      actor: launched.actor, source: launched.source, expected_head: launched.expectedHead,
      correlation_id: launched.correlationId,
    })]
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.listBehaviorDeadLetters()).toHaveLength(1)
    expect(alerts()).toEqual([{
      kind: 'behavior_held', title: `Review New Pull Requests failed on ${launched.target}`,
      key: `behavior-held:review-new-prs:${launched.target}`, resolved: null,
    }])

    // Its retry fails too: a second dead letter for the same incident, still one alert.
    vi.setSystemTime(Date.now() + launched.behaviors.BEHAVIOR_RETRY_BASE_MS)
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    const retry = launched.database.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.target === launched.target)!
    expect(retry.launchCorrelationId).not.toBe(launched.correlationId)
    fixture.agentLogs.push(agentLog({
      id: '8'.repeat(32), status: 'failed', error: 'model unavailable',
      actor: retry.launchActor, source: retry.launchSource, expected_head: retry.launchExpectedHead,
      correlation_id: retry.launchCorrelationId,
    }))
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.listBehaviorDeadLetters()).toHaveLength(2)
    expect(alerts()).toHaveLength(1)
    launched.database.db.prepare('UPDATE alerts SET dismissed_at = ? WHERE resolved_at IS NULL').run(new Date().toISOString())
    vi.setSystemTime(Date.now() + launched.behaviors.BEHAVIOR_RETRY_MAX_MS)
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    const changed = launched.database.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.target === launched.target)!
    fixture.agentLogs.push(agentLog({
      id: '9'.repeat(32), status: 'failed', error: 'Input exceeds the maximum length of 1048576 characters',
      error_code: 'review_packet_too_large', action: 'not_started', outcome: 'preflight_failed',
      actor: changed.launchActor, source: changed.launchSource, expected_head: changed.launchExpectedHead,
      correlation_id: changed.launchCorrelationId,
    }))
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(alerts()).toHaveLength(2)
    const fresh = launched.database.db.prepare('SELECT body, dismissed_at FROM alerts WHERE resolved_at IS NULL').get()
    expect(fresh).toEqual({ body: 'Input exceeds the maximum length of 1048576 characters Open Behaviors in Poise for details.', dismissed_at: null })
  })

  it('requires an unambiguous failed call before recovering a no-action failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    fixture.agentLogs = [agentLog({
      status: 'failed', error: 'model unavailable',
      actor: launched.actor, source: launched.source, expected_head: launched.expectedHead,
      correlation_id: launched.correlationId,
    })]
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.listBehaviorDeadLetters()).toHaveLength(1)
    fixture.agentLogs.push({ id: fixture.agentLogs[0].id, corrupt: true })
    await resetLogCache()
    vi.setSystemTime(Date.now() + launched.behaviors.BEHAVIOR_RETRY_BASE_MS)
    fixture.listedPrs.push({ ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` })
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
    expect(launched.database.hasSeen('review-new-prs', launched.target)).toBe(true)
  })

  it('retires a false dead letter when its exact durable call completes', async () => {
    const launched = await launchReviewBeforeCrash()
    const callId = '7'.repeat(32)
    expect(launched.database.linkBehaviorLaunchCallOwned(
      'review-new-prs', launched.target, launched.correlationId, callId,
    )).toBe(true)
    const claim = launched.database.listBehaviorLaunchClaims('review-new-prs')[0]
    launched.database.recordBehaviorDeadLetter(claim, 'transient log miss')
    expect(launched.database.completeSeenOwned(
      'review-new-prs', launched.target, launched.correlationId,
    )).toBe(true)
    fixture.agentLogs = [agentLog({
      id: callId,
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      completed_at: new Date(Date.parse(launched.requestedAt) + 2_000).toISOString(),
      status: 'completed',
      action: 'requested_changes',
      outcome: 'changes_requested',
      head_sha: launched.expectedHead,
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    await runtime.runEnabledBehaviorsOnce()

    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(db.db.prepare(`
      SELECT retired_at FROM behavior_dead_letters WHERE call_id = ?
    `).pluck().get(callId)).toEqual(expect.any(String))
  })

  it('caps an unknown worker state by local launch time despite a future timestamp', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = await launchReviewBeforeCrash()
    const requestedAt = new Date(Date.now() - (2 * 60 * 60_000) - 10_000).toISOString()
    launched.database.db.prepare(`
      UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
      WHERE key = 'review-new-prs' AND target = ?
    `).run(requestedAt, Date.now() - 1, launched.target)
    fixture.agentLogs = [agentLog({
      id: '9'.repeat(32),
      started_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      started_at_precise: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      status: 'unexpected',
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    mocks.observeAuthFailure.mockImplementation(() => { mocks.authStatus = 'degraded' })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.observeAuthFailure).toHaveBeenCalledOnce()
    expect(mocks.authStatus).toBe('degraded')
    expect(db.hasSeen('review-new-prs', launched.target)).toBe(true)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date(Date.now() + runtime.BEHAVIOR_RETRY_BASE_MS))
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.listBehaviorDeadLetters()).toEqual([
      expect.objectContaining({
        behavior: 'review-new-prs',
        target: launched.target,
        error: expect.stringContaining('exceeded 7200000ms running limit'),
      }),
    ])
  })

  it('turns a completed approval found after restart into a terminal claim', async () => {
    const launched = await launchApprovalBeforeCrash()
    const callId = 'b'.repeat(32)
    fixture.agentLogs = [agentLog({
      id: callId,
      behavior: 'pr_approve',
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      completed_at: new Date(Date.parse(launched.requestedAt) + 2_000).toISOString(),
      status: 'completed',
      action: 'approved',
      outcome: 'approved',
      head_sha: launched.expectedHead,
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
      response: 'approved',
    })]

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.db.prepare(`
      SELECT claim_id, lease_until, launch_call_id, launch_error
      FROM behavior_seen WHERE key = 'approve-prs' AND target = ?
    `).get(launched.target)).toEqual({
      claim_id: '',
      lease_until: null,
      launch_call_id: callId,
      launch_error: null,
    })
  })
})
