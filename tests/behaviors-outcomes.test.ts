import { describe, expect, it, vi } from 'vitest'
import checkoutSuperseded from './fixtures/review-checkout-superseded.json'
import { REVIEW_BUDGET_STOPPED } from '../server/behavior-diagnostics'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, restartModules, resetLogCache, arrangeCli, agentLog, launchReviewBeforeCrash, launchApprovalBeforeCrash, fixture, datastoreHealthOutput } from './behaviors-runtime-fixture'

describe('review outcome evidence and registration', () => {
  it('settles a receipted partial change request without quarantining or clearing its coverage', async () => {
    const launched = await launchReviewBeforeCrash()
    fixture.agentLogs = [agentLog({ started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      actor: launched.actor, source: launched.source, correlation_id: launched.correlationId,
      status: 'completed', action: 'requested_changes', outcome: 'incomplete', head_sha: launched.expectedHead,
      review_id: 91, artifact: { review_response: { coverage: 'incomplete' } } })]
    await resetLogCache()
    await launched.behaviors.runEnabledBehaviorsOnce()
    expect(launched.database.db.prepare('SELECT launch_action, launch_outcome, launch_quarantine FROM behavior_seen WHERE key = ? AND target = ?')
      .get('review-new-prs', launched.target)).toMatchObject({ launch_action: 'requested_changes', launch_outcome: 'changes_requested', launch_quarantine: null })
    expect(fixture.agentLogs[0]).toMatchObject({ outcome: 'incomplete', artifact: { review_response: { coverage: 'incomplete' } } })
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, state: 'completed', activity: 'settled', outcome: 'incomplete',
    }))
  })

  it('releases a held launch from a published partial review without losing its coverage disposition', async () => {
    const launched = await launchReviewBeforeCrash()
    const callId = 'f'.repeat(32)
    fixture.agentLogs = [agentLog({ id: callId,
      started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      status: 'failed', action: 'not_started', outcome: 'preflight_failed', model: 'opus-5-xhigh',
      review_policy: 'bounded-v1', error_code: 'review_provider_blocked', error: 'account blocked',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId })]
    await resetLogCache()
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).not.toBeNull()
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    mocks.captureOutcome.mockClear()
    fixture.agentLogs = [agentLog({ id: callId,
      started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      status: 'completed', action: 'requested_changes', outcome: 'incomplete',
      head_sha: launched.expectedHead, review_id: 91,
      artifact: { review_response: { coverage: 'incomplete' } },
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId })]
    await resetLogCache()
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).toBeNull()
    expect(modules.database.db.prepare('SELECT launch_action, launch_outcome FROM behavior_seen WHERE key = ? AND target = ?')
      .get('review-new-prs', launched.target)).toMatchObject({ launch_action: 'requested_changes', launch_outcome: 'changes_requested' })
    expect(modules.database.listBehaviorDeadLetters()).toEqual([])
    expect(modules.database.countReviewRounds(pr.repo, pr.number)).toBe(1)
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, callId, state: 'completed', activity: 'settled', outcome: 'incomplete',
    }))
  })

  it('adopts a verified partial replay for a held review without granting it clearance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
    const launched = await launchReviewBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'f'.repeat(32), started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      status: 'failed', action: 'not_started', outcome: 'preflight_failed', model: 'opus-5-xhigh',
      review_policy: 'bounded-v1', error_code: 'review_provider_blocked', error: 'account blocked',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId,
    })]
    await resetLogCache()
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).not.toBeNull()
    vi.setSystemTime(Date.now() + 2_000)
    fixture.agentLogs.push(agentLog({
      id: 'e'.repeat(32), model: 'opus-5-xhigh', status: 'completed',
      action: 'requested_changes', outcome: 'incomplete', head_sha: HEAD_SHA,
      artifact: { review_response: { coverage: 'incomplete' } },
      source: 'poise:replay', correlation_id: 'explicit-replay', review_id: 91,
    }))
    await resetLogCache()
    arrangeCli(false, false, { reviewerReviewIdsSince: [91] })
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).toBeNull()
    expect(modules.database.db.prepare('SELECT launch_action, launch_outcome, launch_source FROM behavior_seen WHERE key = ? AND target = ?')
      .get('review-new-prs', launched.target)).toMatchObject({ launch_action: 'requested_changes', launch_outcome: 'changes_requested', launch_source: 'poise:replay' })
    expect(modules.database.listBehaviorDeadLetters()).toEqual([])
    expect(modules.database.latestApprovalBasisLaunch(pr.repo, pr.number)).toBeNull()
  })

  it.each(['unclaimed', 'pending', 'incomplete', 'unavailable', 'stopped'] as const)(
    'retains the legacy publication refusal across head changes, ticks and restart (%s)', async (evidence) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-13T12:00:00Z'))
      const launched = await launchReviewBeforeCrash()
      const call = agentLog({ id: 'c'.repeat(32), status: 'failed', action: null, outcome: null,
        review_id: null, review_policy: 'bounded-v1', error_code: 'review_budget_exhausted',
        error: 'Review reached its total time limit; needs attention; could not prove a safe recovery',
        model: 'opus-5-xhigh', started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
        expected_head: launched.expectedHead, actor: launched.actor, source: launched.source,
        correlation_id: launched.correlationId })
      fixture.agentLogs = [call]
      let { database: db, behaviors: runtime } = launched
      expect(db.linkBehaviorLaunchCallOwned('review-new-prs', launched.target, launched.correlationId, String(call.id))).toBe(true)
      const error = evidence === 'stopped' ? REVIEW_BUDGET_STOPPED : String(call.error)
      db.setBehaviorLaunchErrorOwned('review-new-prs', launched.target, launched.correlationId, error)
      db.recordBehaviorDeadLetter(db.listBehaviorLaunchClaims('review-new-prs')[0], error)
      db.completeSeenOwned('review-new-prs', launched.target, launched.correlationId)
      const failureKey = `behavior_review_new_prs_failure:${launched.target}`
      db.setMeta(failureKey, JSON.stringify({ kind: 'worker', consecutiveFailures: 2,
        firstFailureAtMs: Date.now() - 60_000, lastFailureAtMs: Date.now() - 60_000,
        nextRetryAtMs: Date.now() - 1, error: call.error, callId: call.id,
        diagnostic: { severity: 'warning', code: 'review_budget_exhausted' } }))
      await resetLogCache()
      await runtime.runEnabledBehaviorsOnce()
      const failure = db.getMeta(failureKey)
      const history = db.db.prepare('SELECT * FROM behavior_dead_letters').all()
      const held = db.getFailedBehaviorLaunch('review-new-prs', launched.target)
      const reviews = [
        { id: 91, state: 'DISMISSED', commit: HEAD_SHA },
        { id: 92, state: 'APPROVED', commit: NEXT_HEAD_SHA },
      ]
      arrangeCli(false, false, { headSha: NEXT_HEAD_SHA,
        ...(evidence === 'pending' ? { reviewerReviewIdsSince: [], reviewerPendingReviews: 1 }
          : evidence === 'incomplete' ? { reviewerReviewsSince: 2, reviewerLatestState: 'APPROVED', reviewerLatestCommit: NEXT_HEAD_SHA }
            : { reviewerReviewsSinceItems: reviews }) })
      if (evidence === 'unavailable') {
        const read = mocks.runFile.getMockImplementation()!
        mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
          if (command === 'github-interface' && args[0] === '--review-activity-since') throw new Error('review inventory unavailable')
          return read(command, args, options)
        })
      }
      await runtime.runEnabledBehaviorsOnce()
      const reason = evidence === 'pending' ? 'Pending publication: 1 pending reviews'
        : evidence === 'incomplete' ? 'Publication evidence incomplete: 2 reviews since Call start, review identities unavailable'
          : evidence === 'unavailable' ? 'Publication evidence unavailable: review inventory unavailable'
            : 'Unclaimed publication: 2 reviews not attributed to this Call'
      const verify = async () => {
        const snapshot = await (await import('../server/agent')).fetchAgentLogSnapshot()
        for (const observed of [snapshot, null]) {
          const incident = runtime.getBehaviorDiagnosticIncidents(observed).find((row) => row.callId === call.id)!
          expect(incident.error).toContain(reason)
          expect(incident.error).toContain(`Call ${call.id} (correlation ${launched.correlationId})`)
          expect(incident.error).toContain(`original head ${HEAD_SHA}; observed head ${NEXT_HEAD_SHA}`)
          expect(incident.diagnostic.severity).toBe('warning')
          if (evidence === 'stopped') expect(incident.nextRetryAt).toBeUndefined()
          if (evidence === 'unclaimed' || evidence === 'stopped') {
            for (const review of reviews) expect(incident.error).toContain(`${review.id} ${review.state} on ${review.commit}`)
          }
        }
        expect(db.getFailedBehaviorLaunch('review-new-prs', launched.target)).toEqual(held)
        expect(db.db.prepare('SELECT * FROM behavior_dead_letters').all()).toEqual(history)
        expect(db.getMeta(failureKey)).toBe(failure)
        expect(fixture.agentLogs).toEqual([call])
        expect(mocks.spawnDetached).toHaveBeenCalledOnce()
        const status = await import('../server/behavior-pr-status')
        const reply = await status.readPrStatus(50)
        expect(reply.rows[0].blocker.id).toBe('held')
        expect(reply.rows[0].blocker.details.join(' ')).toContain(reason)
      }
      await verify()
      ;({ database: db, behaviors: runtime } = await restartModules())
      await verify()
      runtime.startBehaviorsRuntime()
      await runtime.runEnabledBehaviorsOnce()
      await runtime.runEnabledBehaviorsOnce()
      await verify()
      if (evidence === 'unclaimed') {
        Object.assign(call, { action: 'not_started', outcome: 'preflight_failed', error_code: 'review_provider_exit' })
        await resetLogCache()
        await runtime.runEnabledBehaviorsOnce()
        expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
        expect(mocks.spawnDetached.mock.calls[1][1]).toEqual(expect.arrayContaining(['--expected-head', NEXT_HEAD_SHA]))
        expect(runtime.getBehaviorDiagnosticIncidents(null).map((row) => row.error).join(' ')).not.toContain('Legacy review retry held')
      }
    })

  it.each((['review-new-issues', 'review-new-prs', 'approve-prs'] as const).flatMap((key) =>
    (['active', 'failed'] as const).map((state) => ({ key, state }))))(
    'retires a confirmed closed $state $key quarantine and restores its original target on reopen', async ({ key, state }) => {
      arrangeCli()
      const { database: db, behaviors: runtime } = await loadModules()
      db.setMeta('me', 'poise-user')
      const issue = key === 'review-new-issues'
      const behavior = issue ? 'issue_review' : key === 'approve-prs' ? 'pr_approve' : 'pr_review'
      const suffix = key === 'approve-prs' ? `@head=${HEAD_SHA}:tertiary` : ':secondary'
      const error = 'original unreadable launch evidence'
      const seed = (number: number) => {
        const target = `${pr.repo}#${number}${suffix}`
        const claimId = db.claimSeenOwned(key, target)!
        db.markBehaviorLaunchIntentOwned({ key, target, claimId, launchBehavior: behavior, repo: pr.repo, pr: number,
          requestedAt: new Date(Date.now() - 60_000).toISOString(), expectedHead: issue ? '' : HEAD_SHA,
          actor: 'review-bot', source: `poise:${key}`, correlationId: claimId })
        db.linkBehaviorLaunchCallOwned(key, target, claimId, number.toString(16).padStart(32, '0'))
        db.quarantineBehaviorLaunchOwned(key, target, claimId, 'unreadable', error, true)
        const claim = db.listBehaviorLaunchClaims(key).find((claim) => claim.target === target)!
        const id = db.recordBehaviorDeadLetter(claim, error)
        if (state === 'failed') db.completeSeenOwned(key, target, claimId)
        return { ...claim, id }
      }
      const closed = seed(832)
      const open = seed(833)
      const unknown = seed(834)
      const { behaviorHeld } = await import('../server/alerts/producers')
      for (const claim of [closed, open, unknown]) behaviorHeld(key, `${pr.repo}#${claim.launchPr}`, false, error)
      let status = issue ? 'closed' : 'merged'
      const base = mocks.runFile.getMockImplementation()!
      mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
        if (command === 'github-datastore' && args.includes('--number')) {
          const number = Number(args[args.indexOf('--number') + 1])
          const rows = number === 834 ? [] : [{ ...pr, number, status: number === 832 ? status : 'open',
            created_at: new Date().toISOString(), url: `https://github.com/${pr.repo}/${issue ? 'issues' : 'pull'}/${number}` }]
          return { stdout: JSON.stringify(rows), stderr: '' }
        }
        return base(command, args, options)
      })
      const proof = () => db.db.prepare('SELECT * FROM behavior_seen WHERE key = ? AND target = ?').get(key, closed.target)
      const original = proof()
      const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
      journal.changeAdmission(0, 'draining')
      journal.changeAdmission(1, 'v2', [])
      runtime.startBehaviorsRuntime()
      await runtime.runEnabledBehaviorsOnce()
      expect(db.listBehaviorDeadLetters().map((row) => row.target).sort()).toEqual([open.target, unknown.target].sort())
      expect(proof()).toEqual(original)
      const history = db.db.prepare('SELECT * FROM behavior_dead_letters WHERE id = ?').get(closed.id)
      expect(history).toMatchObject({ retired_at: expect.any(String), resolution: 'superseded', error,
        correlation_id: closed.launchCorrelationId, call_id: closed.launchCallId })
      expect(db.db.prepare('SELECT resolved_at FROM alerts WHERE dedupe_key = ?').get(`behavior-held:${key}:${pr.repo}#832`))
        .toMatchObject({ resolved_at: expect.any(String) })

      // A late readable budget/preflight failure must not recreate the closed
      // incident, including issue review's direct budget dead-letter path.
      db.setMeta(`behavior_${key.replace(/-/g, '_')}_enabled`, '1')
      db.setMeta(`behavior_${key.replace(/-/g, '_')}_paused_until`, new Date(Date.now() + 3_600_000).toISOString())
      fixture.agentLogs = [agentLog({ id: closed.launchCallId, behavior, repo: pr.repo, pr_id: '832',
        started_at: closed.launchRequestedAt, started_at_precise: closed.launchRequestedAt,
        expected_head: closed.launchExpectedHead, actor: closed.launchActor, source: closed.launchSource,
        correlation_id: closed.launchCorrelationId, status: 'failed', action: 'not_started', outcome: 'preflight_failed',
        error_code: 'review_budget_exhausted', error: 'Review reached its total time limit; needs attention', review_policy: 'bounded-v1',
        diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'provider_execution',
          outcome: 'timed_out', stderr: '', stderr_truncated: false } })]
      await resetLogCache()
      await runtime.runEnabledBehaviorsOnce()
      expect(db.listBehaviorDeadLetters().some((row) => row.target === closed.target)).toBe(false)
      expect(runtime.getBehaviorsRuntimeHealth().failures.some((failure) => failure.target === closed.target)).toBe(false)
      expect(db.db.prepare('SELECT * FROM behavior_dead_letters WHERE id = ?').get(closed.id)).toEqual(history)
      expect(proof()).toMatchObject({ launch_correlation_id: closed.launchCorrelationId,
        launch_call_id: closed.launchCallId, launch_requested_at: closed.launchRequestedAt })

      db.setMeta(`behavior_${key.replace(/-/g, '_')}_enabled`, '0')
      status = 'open'
      await runtime.runEnabledBehaviorsOnce()
      expect(db.listBehaviorDeadLetters().filter((row) => row.target === closed.target)).toHaveLength(1)
      expect(db.listBehaviorDeadLetters().find((row) => row.target === closed.target)).toMatchObject({
        correlationId: closed.launchCorrelationId, callId: closed.launchCallId, actor: closed.launchActor, source: closed.launchSource,
      })
      const count = db.db.prepare('SELECT count(*) FROM behavior_dead_letters').pluck().get()
      await runtime.runEnabledBehaviorsOnce()
      expect(db.db.prepare('SELECT count(*) FROM behavior_dead_letters').pluck().get()).toBe(count)
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
    })

  it.each(['deadline', 'shutdown'] as const)('cancels closed-target reads on $0 across three organizations without late retirement', async (stop) => {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    for (const org of ['alpha', 'beta']) db.db.prepare(`
      INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES (?, ?, 1, 'ready', 'ready', 'poise-user')
    `).run(org, `${fixture.tempRoot}/${org}.sqlite`)
    for (const org of ['Vaquum', 'alpha', 'beta']) {
      for (let number = 1; number <= 7; number++) {
        const target = `${org}/repo#${number}`
        const claimId = db.claimSeenOwned('review-new-prs', target)!
        db.markBehaviorLaunchIntentOwned({ key: 'review-new-prs', target, claimId, launchBehavior: 'pr_review',
          repo: `${org}/repo`, pr: number, requestedAt: new Date().toISOString(), expectedHead: HEAD_SHA,
          actor: 'review-bot', source: 'poise:review-new-prs', correlationId: claimId })
        db.recordBehaviorDeadLetter(db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.target === target)!, 'held')
      }
    }
    const reads: Array<{ signal: AbortSignal, resolve: (value: { stdout: string, stderr: string }) => void }> = []
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: { signal: AbortSignal }) => {
      if (command !== 'github-datastore') throw new Error(`unexpected ${command}`)
      if (args.includes('health')) {
        const health = JSON.parse(datastoreHealthOutput().stdout)
        if (args[0] === '--db') health.database = args[1]
        return { stdout: JSON.stringify(health), stderr: '' }
      }
      return new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
        options.signal.throwIfAborted()
        reads.push({ signal: options.signal, resolve })
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    })
    runtime.startBehaviorsRuntime()
    if (stop === 'shutdown') (await import('../server/behavior-chain-journal')).behaviorChainJournal().changeAdmission(0, 'draining')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(reads).toHaveLength(15))
    const overlap = runtime.runEnabledBehaviorsOnce()
    await Promise.resolve()
    expect(reads).toHaveLength(15)
    if (stop === 'deadline') await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_OPERATION_TIMEOUT_MS)
    else await runtime.stopBehaviorsRuntime()
    await Promise.all([tick, overlap])
    for (const read of reads) {
      expect(read.signal.aborted).toBe(true)
      read.resolve({ stdout: JSON.stringify([{ ...pr, status: 'closed' }]), stderr: '' })
    }
    await Promise.resolve()
    expect(reads).toHaveLength(15)
    expect(db.listBehaviorDeadLetters(50)).toHaveLength(21)
    expect(db.db.prepare('SELECT count(*) FROM behavior_dead_letters WHERE retired_at IS NOT NULL').pluck().get()).toBe(0)
  })

  it('clears only confirmed closed meta failures and keeps pending resolver recovery visible', async () => {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    fixture.listedPrs = []
    fixture.closedPrs = [{ ...pr, status: 'merged' }]
    const ref = `${pr.repo}#${pr.number}`
    const pending = `${ref}:resolve:check`
    const ordinary = `${ref}:check`
    const unknown = `${pr.repo}#999:secondary:check`
    const failure = JSON.stringify({ kind: 'operation', error: 'original failure', consecutiveFailures: 1,
      lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 60_000 })
    for (const target of [pending, ordinary, unknown]) db.setMeta(`behavior_resolve_unblocking_failure:${target}`, failure)
    db.setMeta(`behavior_resolve_unblocking_recovery:${pending}`, JSON.stringify({ nativeId: 'original-resolver' }))
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(db.getMeta(`behavior_resolve_unblocking_failure:${ordinary}`)).toBe('')
    expect(db.getMeta(`behavior_resolve_unblocking_failure:${pending}`)).toBe(failure)
    expect(db.getMeta(`behavior_resolve_unblocking_failure:${unknown}`)).toBe(failure)
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    expect(runtime.getBehaviorsRuntimeHealth().failures.map((failure) => failure.target).sort()).toEqual([pending, unknown].sort())
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

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

  it.each([HEAD_SHA, NEXT_HEAD_SHA])('releases a checkout-superseded review and reviews the current head (%s)', async (head) => {
    const launched = await launchReviewBeforeCrash()
    fixture.agentLogs = [agentLog({
      ...checkoutSuperseded,
      id: 'd'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      head_sha: head,
      completed_at: new Date(Date.parse(launched.requestedAt) + 2_000).toISOString(),
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]
    arrangeCli(false, false, { headSha: head })
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    const argv = mocks.spawnDetached.mock.calls[1][1]
    expect(argv[argv.indexOf('--expected-head') + 1]).toBe(head)
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(0)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, state: 'superseded', stateSource: 'native',
    }))
  })

  it.each([null, 91])('settles a closed-target review with retained publication evidence (%s)', async (reviewId) => {
    const launched = await launchReviewBeforeCrash()
    const completedAt = new Date(Date.parse(launched.requestedAt) + 2_000).toISOString()
    fixture.agentLogs = [agentLog({ id: 'd'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'superseded', outcome: 'superseded', action: null, head_sha: HEAD_SHA,
      completed_at: completedAt, review_id: reviewId,
      error_code: 'review_target_closed', error: 'target MERGED; receipt state remains uncertain',
      expected_head: launched.expectedHead, actor: launched.actor,
      source: launched.source, correlation_id: launched.correlationId })]
    await resetLogCache()
    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.hasSeen('review-new-prs', launched.target)).toBe(true)
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toEqual([])
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(0)
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, callId: 'd'.repeat(32), state: 'superseded',
      activity: 'settled', outcome: 'review_target_closed', completedAt,
    }))
    expect(db.db.prepare('SELECT launch_call_id, launch_error FROM behavior_seen WHERE target = ?').get(launched.target))
      .toEqual({ launch_call_id: 'd'.repeat(32), launch_error: 'target MERGED; receipt state remains uncertain' })
  })

  it('quarantines a superseded review that posted instead of releasing it', async () => {
    const launched = await launchReviewBeforeCrash()
    fixture.agentLogs = [agentLog({
      id: 'd'.repeat(32),
      started_at: new Date(Date.parse(launched.requestedAt) + 1_000).toISOString(),
      started_at_precise: new Date(Date.parse(launched.requestedAt) + 1_001).toISOString(),
      status: 'superseded',
      outcome: 'superseded',
      head_sha: NEXT_HEAD_SHA,
      completed_at: new Date().toISOString(),
      review_id: 91,
      expected_head: launched.expectedHead,
      actor: launched.actor,
      source: launched.source,
      correlation_id: launched.correlationId,
    })]
    await resetLogCache()

    const { database: db, behaviors: runtime } = await restartModules()
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.hasSeen('review-new-prs', launched.target)).toBe(true)
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toHaveLength(1)
    expect(db.listBehaviorLaunchClaims('review-new-prs')[0]).toMatchObject({
      launchQuarantine: 'invalid_result',
      launchCallId: 'd'.repeat(32),
    })
    expect(db.listBehaviorDeadLetters()).toHaveLength(1)
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(0)
    expect(mocks.captureOutcome).not.toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, state: 'superseded',
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

  it('never settles a firing for a quarantined launch while its evidence is outstanding', async () => {
    const launched = await launchReviewBeforeCrash()
    const failed = agentLog({ id: 'f'.repeat(32), started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      status: 'failed', error: 'review behavior produced duplicate GitHub reviews; needs attention',
      error_code: 'review_contract_violation', review_policy: 'bounded-v1', model: 'opus-5-xhigh',
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId })
    fixture.agentLogs = [failed]
    await resetLogCache()
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).not.toBeNull()
    modules.database.db.prepare("UPDATE behavior_seen SET launch_quarantine = 'invalid_result' WHERE key = ? AND target = ?")
      .run('review-new-prs', launched.target)
    fixture.listedPrs = []
    fixture.closedPrs = [{ ...pr, status: 'merged' }]
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.listBehaviorDeadLetters()).toEqual([])
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)?.launchQuarantine).toBe('invalid_result')
    expect(mocks.captureOutcome).not.toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, state: 'superseded',
    }))
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

describe('publication attribution settlement', () => {

  // Held incidents recheck at most hourly; backdate the hold so the next
  // tick revisits the row instead of skipping it.
  function recheckDue(database: { db: { prepare(sql: string): { run(...params: string[]): unknown } } }): void {
    database.db.prepare('UPDATE behavior_dead_letters SET resolved_at = ? WHERE retired_at IS NULL')
      .run(new Date(Date.now() - 61 * 60_000).toISOString())
  }

  it.each(['review-new-prs', 'approve-prs'] as const)('settles a failed %s firing as obsolete once its pull request closes', async (behavior) => {
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    const failed = agentLog({ id: 'f'.repeat(32), started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      status: 'failed', error: 'review behavior produced duplicate GitHub reviews; needs attention',
      error_code: 'review_contract_violation', review_policy: 'bounded-v1', model: 'opus-5-xhigh',
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId })
    fixture.agentLogs = [failed]
    await resetLogCache()
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch(behavior, launched.target)).not.toBeNull()
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    const firings = () => mocks.captureOutcome.mock.calls.map(([outcome]) => outcome)
      .filter((outcome) => outcome.nativeId === launched.correlationId)
    expect(firings().some((firing) => firing.state === 'superseded')).toBe(false)

    // The pull request merges: the incident retires as superseded and the
    // firing follows, without inventing a completion.
    fixture.listedPrs = []
    fixture.closedPrs = [{ ...pr, status: 'merged' }]
    recheckDue(modules.database)
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.listBehaviorDeadLetters()).toEqual([])
    const incident = modules.database.db.prepare(
      'SELECT error, resolution, resolution_evidence, retired_at FROM behavior_dead_letters',
    ).get() as { error: string, resolution: string, resolution_evidence: string, retired_at: string }
    expect(incident.error).toBe(failed.error)
    expect(incident.resolution).toBe('superseded')
    expect(JSON.parse(incident.resolution_evidence)).toMatchObject({ open: false })
    expect(incident.retired_at).toEqual(expect.any(String))
    expect(firings().at(-1)).toMatchObject({ state: 'superseded', activity: 'unknown', outcome: 'review_target_closed',
      callId: failed.id, completedAt: expect.any(String), refs: [{ kind: 'caller', identity: failed.id }] })
    const launch = modules.database.db.prepare(
      'SELECT launch_error, launch_outcome, launch_action, launch_completed_at, launch_head_sha FROM behavior_seen WHERE key = ? AND target = ?',
    ).get(behavior, launched.target) as Record<string, string | null>
    expect(launch).toEqual({ launch_error: failed.error, launch_outcome: null, launch_action: null,
      launch_completed_at: null, launch_head_sha: null })
    expect(modules.database.latestApprovalBasisLaunch(pr.repo, pr.number)).toBeNull()

    // A settled firing reopens nothing: the next tick launches nothing new.
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('settles a firing whose closed-PR incident already retired before the upgrade', async () => {
    const launched = await launchReviewBeforeCrash()
    const failed = agentLog({ id: 'f'.repeat(32), started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      status: 'failed', error: 'review behavior produced duplicate GitHub reviews; needs attention',
      error_code: 'review_contract_violation', review_policy: 'bounded-v1', model: 'opus-5-xhigh',
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId })
    fixture.agentLogs = [failed]
    await resetLogCache()
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).not.toBeNull()
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)

    // The incident retired before this settlement existed: reconcile
    // excludes it, so only the historical path can settle the firing.
    const retiredAt = new Date().toISOString()
    modules.database.db.prepare(`
      UPDATE behavior_dead_letters
      SET retired_at = ?, resolution = 'superseded',
        resolution_evidence = ?, resolved_at = ?
      WHERE retired_at IS NULL
    `).run(retiredAt, JSON.stringify({ open: false, checkedAt: retiredAt }), retiredAt)
    expect(modules.database.listBehaviorDeadLetters()).toEqual([])
    mocks.captureOutcome.mockClear()

    fixture.listedPrs = []
    fixture.closedPrs = [{ ...pr, status: 'merged' }]
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, callId: failed.id, state: 'superseded',
      activity: 'unknown', outcome: 'review_target_closed', completedAt: retiredAt,
    }))
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('settles a historical firing past a large retired backlog without starvation', async () => {
    const launched = await launchReviewBeforeCrash()
    const failed = agentLog({ id: 'f'.repeat(32), started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      status: 'failed', error: 'review behavior produced duplicate GitHub reviews; needs attention',
      error_code: 'review_contract_violation', review_policy: 'bounded-v1', model: 'opus-5-xhigh',
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId })
    fixture.agentLogs = [failed]
    await resetLogCache()
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('review-new-prs', launched.target)).not.toBeNull()

    // Retire the incident, then bury it under more retired rows than any
    // fixed LIMIT would read: the failed-launch-driven scan still settles it.
    const retiredAt = new Date().toISOString()
    const evidence = JSON.stringify({ open: false, checkedAt: retiredAt })
    modules.database.db.prepare(`
      UPDATE behavior_dead_letters
      SET retired_at = ?, resolution = 'superseded',
        resolution_evidence = ?, resolved_at = ?
      WHERE retired_at IS NULL
    `).run(retiredAt, evidence, retiredAt)
    const insert = modules.database.db.prepare(`
      INSERT INTO behavior_dead_letters(
        id, behavior, target, repo, pr, actor, source, correlation_id,
        call_id, error, created_at, retired_at, resolution,
        resolution_evidence, resolved_at
      ) VALUES(?, 'review-new-prs', ?, ?, ?, 'review-bot', 'poise:review-new-prs',
        ?, ?, 'old failure', ?, ?, 'superseded', ?, ?)
    `)
    modules.database.db.transaction(() => {
      for (let index = 0; index < 250; index++) {
        const target = `Vaquum/old-repo#${1000 + index}`
        insert.run(`backlog-${index}`, target, 'Vaquum/old-repo', 1000 + index,
          `backlog-native-${index}`, 'a'.repeat(32), retiredAt, retiredAt, evidence, retiredAt)
      }
    })()
    mocks.captureOutcome.mockClear()

    fixture.listedPrs = []
    fixture.closedPrs = [{ ...pr, status: 'merged' }]
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, callId: failed.id, state: 'superseded',
      activity: 'unknown', outcome: 'review_target_closed', completedAt: retiredAt,
    }))
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('recovers a held %s launch into its launch record when the same call completes', async (behavior) => {
    const launched = behavior === 'review-new-prs' ? await launchReviewBeforeCrash() : await launchApprovalBeforeCrash()
    const failed = agentLog({ id: 'f'.repeat(32), started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      behavior: behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      status: 'failed', error: 'review behavior produced duplicate GitHub reviews; needs attention',
      error_code: 'review_contract_violation', review_policy: 'bounded-v1', model: 'opus-5-xhigh',
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId })
    fixture.agentLogs = [failed]
    await resetLogCache()
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch(behavior, launched.target)).not.toBeNull()

    // The same call's completion becomes readable: the launch record, the
    // firing, the incident and the approval basis settle together.
    const completedAt = new Date().toISOString()
    const action = behavior === 'review-new-prs' ? 'reviewed_clean' : 'approved'
    const outcome = behavior === 'review-new-prs' ? 'clean' : 'approved'
    fixture.agentLogs = [{ ...failed, status: 'completed', action, outcome,
      head_sha: launched.expectedHead, completed_at: completedAt, review_id: 91 }]
    await resetLogCache()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch(behavior, launched.target)).toBeNull()
    expect(modules.database.latestApprovalBasisLaunch(pr.repo, pr.number)).toEqual({
      callId: failed.id, completedAt, headSha: launched.expectedHead,
    })
    const incident = modules.database.db.prepare(
      'SELECT error, retired_at FROM behavior_dead_letters',
    ).get() as { error: string, retired_at: string }
    expect(incident.error).toBe(failed.error)
    expect(incident.retired_at).toEqual(expect.any(String))
    const firings = mocks.captureOutcome.mock.calls.map(([firing]) => firing)
      .filter((firing) => firing.nativeId === launched.correlationId)
    expect(firings.at(-1)).toMatchObject({ state: 'completed', activity: 'settled', outcome, callId: failed.id })
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('closing a panel settles only the failed firing and never invents worker termination', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_reviewers', '2')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    const targets = db.listBehaviorLaunchClaims('review-new-prs').map((claim) => claim.target).sort()
    expect(targets).toEqual([`${pr.repo}#${pr.number}`, `${pr.repo}#${pr.number}:secondary`].sort())
    const claims = db.listBehaviorLaunchClaims('review-new-prs')
    const primary = claims.find((claim) => claim.target === `${pr.repo}#${pr.number}`)!
    const secondary = claims.find((claim) => claim.target !== primary.target)!
    fixture.agentLogs = [
      agentLog({ id: 'f'.repeat(32), started_at: primary.launchRequestedAt, started_at_precise: primary.launchRequestedAt,
        status: 'failed', error: 'review behavior produced duplicate GitHub reviews; needs attention',
        error_code: 'review_contract_violation', review_policy: 'bounded-v1', model: 'opus-5-xhigh',
        expected_head: primary.launchExpectedHead, actor: primary.launchActor, source: primary.launchSource,
        correlation_id: primary.launchCorrelationId }),
      agentLog({ id: 'e'.repeat(32), started_at: secondary.launchRequestedAt, started_at_precise: secondary.launchRequestedAt,
        status: 'running', model: 'gpt-6-astra-ultra',
        expected_head: secondary.launchExpectedHead, actor: secondary.launchActor, source: secondary.launchSource,
        correlation_id: secondary.launchCorrelationId }),
    ]
    await resetLogCache()
    await runtime.runEnabledBehaviorsOnce()
    expect(db.getFailedBehaviorLaunch('review-new-prs', primary.target)).not.toBeNull()
    expect(db.listBehaviorDeadLetters()).toHaveLength(1)
    expect(db.listBehaviorLaunchClaims('review-new-prs').map((claim) => claim.target)).toEqual([secondary.target])

    // Closing settles the failed firing; the running sibling stays active.
    fixture.listedPrs = []
    fixture.closedPrs = [{ ...pr, status: 'merged' }]
    recheckDue(db)
    await runtime.runEnabledBehaviorsOnce()
    const firings = (nativeId: string) => mocks.captureOutcome.mock.calls.map(([outcome]) => outcome)
      .filter((outcome) => outcome.nativeId === nativeId)
    expect(firings(primary.launchCorrelationId).at(-1)).toMatchObject({ state: 'superseded', activity: 'unknown' })
    expect(firings(secondary.launchCorrelationId).some((firing) => firing.state === 'superseded')).toBe(false)
    expect(db.listBehaviorLaunchClaims('review-new-prs').map((claim) => claim.target)).toEqual([secondary.target])

    // Reopening invents no termination and leaks nothing into later admission.
    fixture.listedPrs = [pr]
    fixture.closedPrs = []
    await runtime.runEnabledBehaviorsOnce()
    expect(db.listBehaviorLaunchClaims('review-new-prs').map((claim) => claim.target)).toEqual([secondary.target])
    arrangeCli(false, false, { headSha: NEXT_HEAD_SHA })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
    expect(mocks.spawnDetached.mock.calls[2][1]).toEqual(expect.arrayContaining(['--expected-head', NEXT_HEAD_SHA]))
  })

  it('keeps reviewing other pull requests while one firing settles as obsolete', async () => {
    const launched = await launchReviewBeforeCrash()
    const failed = agentLog({ id: 'f'.repeat(32), started_at: launched.requestedAt, started_at_precise: launched.requestedAt,
      status: 'failed', error: 'review behavior produced duplicate GitHub reviews; needs attention',
      error_code: 'review_contract_violation', review_policy: 'bounded-v1', model: 'opus-5-xhigh',
      expected_head: launched.expectedHead, actor: launched.actor, source: launched.source, correlation_id: launched.correlationId })
    fixture.agentLogs = [failed]
    await resetLogCache()
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
    fixture.listedPrs = [{ ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18' }]
    fixture.closedPrs = [{ ...pr, status: 'merged' }]
    recheckDue(modules.database)
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.listBehaviorDeadLetters()).toEqual([])
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
      nativeId: launched.correlationId, state: 'superseded', activity: 'unknown',
    }))
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1][1]).toContain('#18')
  })
})
