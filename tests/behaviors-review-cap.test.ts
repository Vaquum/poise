import { describe, expect, it } from 'vitest'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, arrangeCli, recordCompletedInitialReview } from './behaviors-runtime-fixture'

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
