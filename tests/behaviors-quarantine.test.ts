import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, restartModules, resetLogCache, arrangeCli, agentLog, launchReviewBeforeCrash, launchApprovalBeforeCrash, fixture } from './behaviors-runtime-fixture'

describe('durable behavior quarantine', () => {
  it.each(['review-new-prs', 'approve-prs'] as const)('retains later corruption of an already failed %s launch after logs are revised', async (behavior) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    const failed = agentLog({
      id: 'b'.repeat(32), behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      model: 'opus-5-xhigh', status: 'failed', error: 'provider unavailable',
      actor: launched.actor, source: launched.source, expected_head: launched.expectedHead,
      correlation_id: launched.correlationId,
    })
    fixture.agentLogs = [failed]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.getFailedBehaviorLaunch(behavior, launched.target)).not.toBeNull()
    fixture.agentLogs = [{ ...failed, status: 'completed', completed_at: new Date().toISOString(), error: '' }]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.getFailedBehaviorLaunch(behavior, launched.target)?.launchQuarantine).toBe('invalid_result')
    fixture.agentLogs = [failed]
    await resetLogCache()
    arrangeCli(behavior === 'approve-prs', false, { headSha: NEXT_HEAD_SHA })
    vi.setSystemTime(Date.now() + 60_000)
    const loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime()
    fixture.listedPrs.push({ ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` })
    await loaded.behaviors.runEnabledBehaviorsOnce()
    fixture.agentLogs = []
    await resetLogCache()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
    expect(loaded.database.getFailedBehaviorLaunch(behavior, launched.target)?.launchQuarantine).toBe('invalid_result')
    expect(loaded.database.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it('keeps an invalid reviewer incident visible through exit callbacks, read failures, and sibling completion', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const loaded = await loadModules()
    const db = loaded.database
    const runtime = loaded.behaviors
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_reviewers', '2')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    await runtime.runEnabledBehaviorsOnce()
    const claims = db.listBehaviorLaunchClaims('review-new-prs')
    const primary = claims.find((claim) => claim.target === `${pr.repo}#${pr.number}`)!
    const secondary = claims.find((claim) => claim.target.endsWith(':secondary'))!
    fixture.agentLogs = [agentLog({
      id: 'b'.repeat(32), status: 'completed', actor: primary.launchActor, source: primary.launchSource,
      correlation_id: primary.launchCorrelationId, expected_head: primary.launchExpectedHead,
    }), agentLog({
      id: 'c'.repeat(32), status: 'running', actor: secondary.launchActor, source: secondary.launchSource,
      correlation_id: secondary.launchCorrelationId, expected_head: secondary.launchExpectedHead,
    })]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    const error = db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.target === primary.target)!.launchError
    const launch = mocks.spawnDetached.mock.calls.find(([, args]) => !(args as string[]).includes('--reviewer-slot')
      || (args as string[])[(args as string[]).indexOf('--reviewer-slot') + 1] === 'primary')!
    launch[2].onExit({ code: 1, signal: null, error: new Error('late process exit') })
    const cli = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, ...rest) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('shared log temporarily unavailable')
      return cli(command, args, ...rest)
    })
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    mocks.runFile.mockImplementation(cli)
    await resetLogCache()
    vi.setSystemTime(Date.now() + 1_000)
    fixture.agentLogs[1] = { ...fixture.agentLogs[1], status: 'completed', action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA, completed_at: new Date().toISOString() }
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toEqual([
      expect.objectContaining({ target: primary.target, launchQuarantine: 'invalid_result', launchError: error }),
    ])
    expect(runtime.getBehaviorsRuntimeHealth().deadLetters).toEqual([
      expect.objectContaining({ target: primary.target, error }),
    ])
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it.each((['review-new-prs', 'approve-prs'] as const).flatMap((behavior) =>
    (['completed', 'superseded', 'missing-error', 'wrong-head', 'wrong-pair'] as const)
      .map((result) => [behavior, result] as const)))('keeps %s %s ambiguity through changed inputs and rewritten logs', async (behavior, result) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    const action = behavior === 'review-new-prs' ? 'reviewed_clean' : 'approved'
    const outcome = behavior === 'review-new-prs' ? 'clean' : 'approved'
    const status = result === 'missing-error' ? 'failed' : result === 'superseded' ? 'superseded' : 'completed'
    const invalid = agentLog({
      id: 'b'.repeat(32), behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      model: 'opus-5-xhigh', status, error: '',
      ...(result === 'wrong-head' ? { action, outcome, head_sha: NEXT_HEAD_SHA } : {}),
      ...(result === 'wrong-pair' ? { action: 'requested_changes', outcome: 'clean', head_sha: HEAD_SHA } : {}),
      actor: launched.actor, source: launched.source, expected_head: launched.expectedHead,
      correlation_id: launched.correlationId,
    })
    fixture.agentLogs = [invalid]
    await resetLogCache()
    let loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    const held = loaded.database.listBehaviorLaunchClaims(behavior).find((claim) => claim.target === launched.target)!
    expect(held.launchQuarantine).toBe('invalid_result')
    expect(held.launchCallId).toBe(invalid.id)

    fixture.listedPrs.push({ ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` })
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
    arrangeCli(behavior === 'approve-prs', false, { headSha: NEXT_HEAD_SHA })
    loaded.database.setMeta('models', JSON.stringify({
      [behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve']: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' },
    }))
    fixture.agentLogs = [{ ...invalid, status: 'completed', action, outcome, head_sha: HEAD_SHA, completed_at: new Date().toISOString() }]
    await resetLogCache()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(loaded.database.listBehaviorDeadLetters()).toEqual([expect.objectContaining({ target: launched.target })])
    fixture.agentLogs = [{ ...invalid, status: 'failed', action: null, outcome: null, head_sha: null, error: 'provider exited before reporting an action' }]
    await resetLogCache()
    vi.setSystemTime(Date.now() + 60_000)
    await loaded.behaviors.runEnabledBehaviorsOnce()
    fixture.agentLogs = []
    await resetLogCache()
    vi.setSystemTime(Date.now() + 6 * 60_000)
    loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached.mock.calls.filter(([, args]) => (args as string[]).includes('#17'))).toHaveLength(1)
    expect(loaded.database.listBehaviorLaunchClaims(behavior).find((claim) => claim.target === launched.target)).toMatchObject({
      launchQuarantine: 'invalid_result', launchError: held.launchError,
      launchCallId: invalid.id, launchCorrelationId: launched.correlationId,
    })
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('restores normal %s reconciliation when exact failed evidence returns after rotation', async (behavior) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    fixture.agentLogs = [{ corrupt: true }]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.listBehaviorLaunchClaims(behavior)[0].launchQuarantine).toBe('unreadable')
    fixture.agentLogs = []
    await resetLogCache()
    vi.setSystemTime(Date.now() + 6 * 60_000)
    const loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    const actual = agentLog({
      id: 'b'.repeat(32), behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve', actor: launched.actor, source: launched.source,
      expected_head: HEAD_SHA, correlation_id: launched.correlationId,
      status: 'failed', error: 'provider exited before reporting an action',
    })
    fixture.agentLogs = [actual]
    await resetLogCache()
    vi.setSystemTime(Date.now() + 60_000)
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(loaded.database.listBehaviorLaunchClaims(behavior)).toEqual([])
    expect(loaded.database.getFailedBehaviorLaunch(behavior, launched.target)?.launchQuarantine).toBeNull()
    expect(loaded.database.listBehaviorDeadLetters()).toMatchObject([{ error: 'provider exited before reporting an action' }])
    fixture.agentLogs = [{ ...actual, status: 'completed', action: behavior === 'review-new-prs' ? 'reviewed_clean' : 'approved', outcome: behavior === 'review-new-prs' ? 'clean' : 'approved', head_sha: HEAD_SHA, completed_at: new Date().toISOString() }]
    await resetLogCache()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(loaded.database.listBehaviorLaunchClaims(behavior)).toEqual([])
    expect(loaded.database.listBehaviorDeadLetters()).toEqual([])
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('applies the ordinary %s running limit after its log feed recovers', async (behavior) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, options)
    })
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.listBehaviorLaunchClaims(behavior)[0].launchQuarantine).toBe('unreadable')
    mocks.runFile.mockImplementation(original)
    await resetLogCache()
    fixture.agentLogs = [agentLog({
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      actor: launched.actor, source: launched.source, expected_head: HEAD_SHA,
      correlation_id: launched.correlationId, status: 'running',
    })]
    await resetLogCache()
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.listBehaviorLaunchClaims(behavior)).toEqual([])
    expect(launched.database.getFailedBehaviorLaunch(behavior, launched.target)).toMatchObject({
      launchQuarantine: null, launchCallId: fixture.agentLogs[0].id,
      launchError: 'behavior launch exceeded 7200000ms running limit',
    })
    expect(launched.database.listBehaviorDeadLetters()).toMatchObject([{ error: 'behavior launch exceeded 7200000ms running limit' }])
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it.each(['unknown-status', 'duplicate-call', 'quarantined-duplicate'] as const)('does not clear unreadable evidence from a %s record', async (conflict) => {
    const launched = await launchReviewBeforeCrash()
    fixture.agentLogs = [{ corrupt: true }]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    const call = agentLog({ actor: launched.actor, source: launched.source, correlation_id: launched.correlationId,
      status: conflict === 'unknown-status' ? 'not-a-status' : 'running' })
    fixture.agentLogs = conflict === 'unknown-status' ? [call] : [call, {
      ...call, ...(conflict === 'quarantined-duplicate' ? { actor: 42 } : { id: 'a'.repeat(32) }),
    }]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.listBehaviorLaunchClaims('review-new-prs')[0].launchQuarantine).toBe('unreadable')
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it.each((['review-new-prs', 'approve-prs'] as const).flatMap((behavior) =>
    (['active', 'closed'] as const).flatMap((state) =>
      (['call-id', 'correlation', 'quarantined-call-id'] as const).map((identity) => [behavior, state, identity] as const))))(
    'retains contradictory completed evidence for an unreadable %s %s launch sharing %s after rotation', async (behavior, state, identity) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
      const failed = agentLog({ behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
        actor: launched.actor, source: launched.source, correlation_id: launched.correlationId,
        status: 'failed', error: 'provider exited without action' })
      if (state === 'closed') {
        fixture.agentLogs = [failed]
        await resetLogCache()
        await launched.behaviors.runEnabledBehaviorsOnce()
      }
      const original = mocks.runFile.getMockImplementation()!
      mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
        if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
        return original(command, args, options)
      })
      await resetLogCache()
      await launched.behaviors.runEnabledBehaviorsOnce()
      mocks.runFile.mockImplementation(original)
      await resetLogCache()
      const completed = { ...failed, id: identity === 'correlation' ? 'e'.repeat(32) : failed.id, status: 'completed', error: '',
        action: behavior === 'review-new-prs' ? 'reviewed_clean' : 'approved',
        outcome: behavior === 'review-new-prs' ? 'clean' : 'approved',
        head_sha: HEAD_SHA, completed_at: new Date().toISOString() }
      const duplicate = identity === 'quarantined-call-id' ? { ...failed, status: 'running', actor: 42 } : failed
      fixture.agentLogs = behavior === 'review-new-prs' ? [duplicate, completed] : [completed, duplicate]
      await resetLogCache()
      await launched.behaviors.runEnabledBehaviorsOnce()
      const held = state === 'closed' ? launched.database.getFailedBehaviorLaunch(behavior, launched.target)
        : launched.database.listBehaviorLaunchClaims(behavior)[0]
      expect(held?.launchQuarantine).toBe('invalid_result')
      fixture.agentLogs = [failed]
      await resetLogCache()
      vi.setSystemTime(Date.now() + 60_000)
      const loaded = await restartModules()
      loaded.behaviors.startBehaviorsRuntime()
      await loaded.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      expect(loaded.database.listBehaviorDeadLetters()).toHaveLength(1)
    },
  )

  it.each((['review-new-prs', 'approve-prs'] as const).flatMap((behavior) =>
    (['id', 'correlation'] as const).map((field) => [behavior, field] as const)))('retains a sole completed %s record contradicting its linked %s', async (behavior, field) => {
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    const call = agentLog({ behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      actor: launched.actor, source: launched.source, correlation_id: launched.correlationId, status: 'running' })
    fixture.agentLogs = [call]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, options)
    })
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    mocks.runFile.mockImplementation(original)
    await resetLogCache()
    fixture.agentLogs = [{ ...call, status: 'completed', error: '', completed_at: new Date().toISOString(), head_sha: HEAD_SHA,
      action: behavior === 'review-new-prs' ? 'reviewed_clean' : 'approved', outcome: behavior === 'review-new-prs' ? 'clean' : 'approved',
      ...(field === 'id' ? { id: 'e'.repeat(32) } : { correlation_id: 'different-correlation' }),
    }]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.listBehaviorLaunchClaims(behavior)[0]).toMatchObject({ launchCallId: call.id, launchQuarantine: 'invalid_result' })
    fixture.agentLogs = [{ ...call, status: 'failed', error: 'provider exited without action' }]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.listBehaviorLaunchClaims(behavior)[0].launchQuarantine).toBe('invalid_result')
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it.each(['actor', 'source', 'expected-head', 'start', 'head'] as const)('retains a closed unreadable PR launch when completed evidence has the wrong %s', async (field) => {
    const launched = await launchReviewBeforeCrash()
    const failed = agentLog({ actor: launched.actor, source: launched.source, correlation_id: launched.correlationId,
      status: 'failed', error: 'provider exited without action' })
    fixture.agentLogs = [failed]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'agent-interface' && args[0] === '--logs') throw new Error('temporary feed outage')
      return original(command, args, options)
    })
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    mocks.runFile.mockImplementation(original)
    await resetLogCache()
    const completed = { ...failed, status: 'completed', error: '', action: 'reviewed_clean', outcome: 'clean',
      head_sha: HEAD_SHA, completed_at: new Date().toISOString(),
      ...(field === 'actor' ? { actor: 'another-bot' } : {}),
      ...(field === 'source' ? { source: 'poise:another-source' } : {}),
      ...(field === 'expected-head' ? { expected_head: NEXT_HEAD_SHA } : {}),
      ...(field === 'start' ? { started_at: '2020-01-01T00:00:00Z', started_at_precise: '2020-01-01T00:00:00Z' } : {}),
      ...(field === 'head' ? { head_sha: NEXT_HEAD_SHA } : {}),
    }
    fixture.agentLogs = [completed]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.getFailedBehaviorLaunch('review-new-prs', launched.target)?.launchQuarantine).toBe('invalid_result')
    expect(launched.database.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('keeps %s held after corrupt row rotation and restart', async (behavior) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'b'.repeat(32), behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      status: 'completed', actor: launched.actor, source: launched.source,
      expected_head: launched.expectedHead, correlation_id: launched.correlationId,
    })]
    await resetLogCache()
    let loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    fixture.agentLogs = []
    await resetLogCache()
    vi.setSystemTime(Date.now() + 6 * 60_000)
    loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    vi.setSystemTime(Date.now() + 60_000)
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })
  it('keeps an invalid approval held after its head changes', async () => {
    const launched = await launchApprovalBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'b'.repeat(32), behavior: 'pr_approve', status: 'completed',
      action: 'approved', outcome: 'clean', head_sha: HEAD_SHA,
      actor: launched.actor, source: launched.source,
      expected_head: launched.expectedHead, correlation_id: launched.correlationId,
    })]
    await resetLogCache()
    let loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    arrangeCli(true, false, { headSha: NEXT_HEAD_SHA })
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })
})
