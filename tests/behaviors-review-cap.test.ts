import { describe, expect, it } from 'vitest'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, restartModules, resetLogCache, arrangeCli, agentLog, fixture, recordCompletedInitialReview } from './behaviors-runtime-fixture'

// The review-round cap: Approve Pull Requests files the capped round's
// findings as one follow-up issue and approves instead of requesting changes
// again. Rounds are completed change-request rounds read from the durable
// launch ledger, so the count survives restarts.

function recordCompletedApprovalRound(
  db: Parameters<typeof recordCompletedInitialReview>[0],
  options: { target: string, headSha: string, callId: string },
): void {
  const claimId = db.claimSeenOwned('approve-prs', options.target)
  if (!claimId) throw new Error('could not arrange approval claim')
  const marked = db.markBehaviorLaunchIntentOwned({
    key: 'approve-prs', target: options.target, claimId, launchBehavior: 'pr_approve',
    repo: pr.repo, pr: pr.number, requestedAt: new Date().toISOString(),
    expectedHead: options.headSha, actor: 'review-bot',
    source: 'poise:approve-prs', correlationId: claimId,
  })
  const linked = db.linkBehaviorLaunchCallOwned('approve-prs', options.target, claimId, options.callId)
  const completed = db.completeBehaviorLaunchOwned({
    key: 'approve-prs', target: options.target, claimId,
    action: 'requested_changes', outcome: 'changes_requested',
    completedAt: new Date().toISOString(), headSha: options.headSha,
  })
  if (!marked || !linked || !completed) throw new Error('could not arrange completed approval round')
}

describe('review-round cap', () => {
  it('is off unless set', async () => {
    const { behaviors: runtime } = await loadModules()
    expect(runtime.getReviewCap()).toBeNull()
  })

  it('stores and clears the cap', async () => {
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.setReviewCap(5)
    expect(runtime.getReviewCap()).toBe(5)
    expect(db.getMeta('behavior_approve_prs_review_cap')).toBe('5')
    runtime.setReviewCap(null)
    expect(runtime.getReviewCap()).toBeNull()
  })

  it('rejects out-of-range caps', async () => {
    const { behaviors: runtime } = await loadModules()
    for (const value of [0, 1, 11, 100, 2.5, Number.NaN, '5', true, {}, []]) {
      expect(runtime.isValidReviewCap(value)).toBe(false)
    }
    expect(runtime.isValidReviewCap(null)).toBe(true)
    expect(runtime.isValidReviewCap(2)).toBe(true)
    expect(runtime.isValidReviewCap(10)).toBe(true)
  })

  it('reads an invalid stored cap as off', async () => {
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('behavior_approve_prs_review_cap', '1')
    expect(runtime.getReviewCap()).toBeNull()
    db.setMeta('behavior_approve_prs_review_cap', 'banana')
    expect(runtime.getReviewCap()).toBeNull()
  })

  it('counts no rounds on a fresh pull request', async () => {
    const { database: db, behaviors: runtime } = await loadModules()
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(0)
    expect(runtime.reviewRoundNumber(pr.repo, pr.number)).toBe(1)
  })

  it('counts the initial panel once and every follow-up after it', async () => {
    const { database: db } = await loadModules()
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: HEAD_SHA })
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(1)
    // A parallel initial panel on the same head is still one round.
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: HEAD_SHA, target: `${pr.repo}#${pr.number}:secondary`, callId: 'd'.repeat(32) })
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(1)
    // A follow-up round on a new head adds a round.
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1/head=${NEXT_HEAD_SHA}`,
      headSha: NEXT_HEAD_SHA, callId: 'e'.repeat(32),
    })
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(2)
  })

  it('counts follow-ups on an unchanged head', async () => {
    const { database: db } = await loadModules()
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: HEAD_SHA })
    // Author replies re-arm the trigger without a new commit, so two
    // completed follow-ups can share one head — and both are rounds.
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1/head=${HEAD_SHA}`,
      headSha: HEAD_SHA, callId: 'e'.repeat(32),
    })
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T11:00:00Z/r=2/head=${HEAD_SHA}`,
      headSha: HEAD_SHA, callId: 'f'.repeat(32),
    })
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(3)
  })

  it('ignores clean, failed and quarantined runs', async () => {
    const { database: db } = await loadModules()
    recordCompletedInitialReview(db, { outcome: 'clean', headSha: HEAD_SHA })
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(0)
    // A change request that never completed (its claim is still held) adds no round.
    const target = `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1/head=${NEXT_HEAD_SHA}`
    const claimId = db.claimSeenOwned('approve-prs', target)
    if (!claimId) throw new Error('could not arrange approval claim')
    db.markBehaviorLaunchIntentOwned({
      key: 'approve-prs', target, claimId, launchBehavior: 'pr_approve', repo: pr.repo, pr: pr.number,
      requestedAt: new Date().toISOString(), expectedHead: NEXT_HEAD_SHA, actor: 'review-bot',
      source: 'poise:approve-prs', correlationId: claimId,
    })
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(0)
  })

  it('passes no cap flag while the cap is off', async () => {
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: 'b'.repeat(40) })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    const args = mocks.spawnDetached.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--pr-approve', '#17']))
    expect(args).not.toContain('--review-cap-reached')
  })

  it('passes no cap flag below the cap', async () => {
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    runtime.setReviewCap(5)
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: 'b'.repeat(40) })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    const args = mocks.spawnDetached.mock.calls[0][1] as string[]
    expect(args).not.toContain('--review-cap-reached')
  })

  it('passes the cap flag on the capped round', async () => {
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    runtime.setReviewCap(2)
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: 'b'.repeat(40) })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--pr-approve', '#17', '--review-cap-reached', '--review-round', '2', '--review-cap', '2',
    ]))
  })

  it('passes the round-5 flag with four retained negative rounds', async () => {
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    runtime.setReviewCap(5)
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: 'b'.repeat(40) })
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1/head=${'c'.repeat(40)}`,
      headSha: 'c'.repeat(40), callId: 'd'.repeat(32),
    })
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T11:00:00Z/r=2/head=${'e'.repeat(40)}`,
      headSha: 'e'.repeat(40), callId: 'f'.repeat(32),
    })
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T12:00:00Z/r=3/head=${'f'.repeat(40)}`,
      headSha: 'f'.repeat(40), callId: 'a'.repeat(32),
    })
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(4)

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--pr-approve', '#17', '--review-cap-reached', '--review-round', '5', '--review-cap', '5',
    ]))
  })

  it('pins the capped round on approval replay admission', async () => {
    arrangeCli(false, false, {
      reviewerLatestState: 'DISMISSED',
      reviewerLatestCommit: HEAD_SHA,
      reviewerReviewsSinceItems: [{ id: 91, state: 'DISMISSED', commit: HEAD_SHA }],
    })
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    runtime.setReviewCap(5)
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: 'b'.repeat(40) })
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1/head=${'c'.repeat(40)}`,
      headSha: 'c'.repeat(40), callId: 'd'.repeat(32),
    })
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T11:00:00Z/r=2/head=${'e'.repeat(40)}`,
      headSha: 'e'.repeat(40), callId: 'f'.repeat(32),
    })
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T12:00:00Z/r=3/head=${'f'.repeat(40)}`,
      headSha: 'f'.repeat(40), callId: 'a'.repeat(32),
    })

    await expect(runtime.admitReplay('pr_approve', pr.repo, pr.number)).resolves.toMatchObject({
      author: pr.author, reviewCapReached: { reviewRound: 5, reviewCap: 5 },
    })
  })

  it('leaves replay uncapped below the cap', async () => {
    arrangeCli(false, false, {
      reviewerLatestState: 'DISMISSED',
      reviewerLatestCommit: HEAD_SHA,
      reviewerReviewsSinceItems: [{ id: 91, state: 'DISMISSED', commit: HEAD_SHA }],
    })
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    runtime.setReviewCap(10)
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: 'b'.repeat(40) })

    const admission = await runtime.admitReplay('pr_approve', pr.repo, pr.number)
    expect(admission).toMatchObject({ author: pr.author })
    expect(admission).not.toHaveProperty('reviewCapReached')
  })

  it('counts a completed round on a stale head exactly once across restarts', async () => {
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    runtime.setReviewCap(5)
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: 'b'.repeat(40) })
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1/head=${'c'.repeat(40)}`,
      headSha: 'c'.repeat(40), callId: 'd'.repeat(32),
    })
    recordCompletedApprovalRound(db, {
      target: `${pr.repo}#${pr.number}@req=2026-07-10T11:00:00Z/r=2/head=${'e'.repeat(40)}`,
      headSha: 'e'.repeat(40), callId: 'f'.repeat(32),
    })
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(3)

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).not.toContain('--review-cap-reached')
    const claim = db.listBehaviorLaunchClaims('approve-prs')[0]

    // Caller posts its change request on the expected head; the author
    // pushes before verification finishes.
    fixture.agentLogs = [agentLog({
      id: 'a'.repeat(32), behavior: 'pr_approve', status: 'completed',
      action: 'requested_changes', outcome: 'changes_requested',
      head_sha: claim.launchExpectedHead, expected_head: claim.launchExpectedHead,
      review_id: 91, actor: claim.launchActor, source: claim.launchSource,
      correlation_id: claim.launchCorrelationId,
      started_at: new Date().toISOString(),
      started_at_precise: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })]
    await resetLogCache()
    arrangeCli(true, false, { headSha: NEXT_HEAD_SHA })
    await runtime.runEnabledBehaviorsOnce()
    expect(db.countReviewRounds(pr.repo, pr.number)).toBe(4)
    const completed = db.db.prepare(
      'SELECT launch_completed_at AS completedAt, launch_call_id AS callId FROM behavior_seen WHERE key = ? AND target = ?',
    ).get('approve-prs', claim.target) as { completedAt: string, callId: string }

    const restarted = await restartModules()
    restarted.behaviors.startBehaviorsRuntime()
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(restarted.database.countReviewRounds(pr.repo, pr.number)).toBe(4)
    expect(restarted.database.db.prepare(
      'SELECT launch_completed_at AS completedAt, launch_call_id AS callId FROM behavior_seen WHERE key = ? AND target = ?',
    ).get('approve-prs', claim.target)).toEqual(completed)
    expect(restarted.database.listBehaviorDeadLetters()).toEqual([])
    // Any follow-on approval launch after the fourth round is the capped
    // round 5, never another change request.
    for (const [, args] of mocks.spawnDetached.mock.calls.slice(1)) {
      expect(args).toEqual(expect.arrayContaining(
        ['--review-cap-reached', '--review-round', '5', '--review-cap', '5']))
    }
  })

  it('stays capped past the cap', async () => {
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    runtime.setReviewCap(2)
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: 'b'.repeat(40) })
    recordCompletedInitialReview(db, {
      outcome: 'changes_requested', headSha: 'c'.repeat(40),
      target: `${pr.repo}#${pr.number}@head=${'c'.repeat(40)}`, callId: 'f'.repeat(32),
    })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--review-cap-reached', '--review-round', '3', '--review-cap', '2',
    ]))
  })
})
