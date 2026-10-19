import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, arrangeCli, recordCompletedInitialReview, fixture, type ReviewActivityFixture } from './behaviors-runtime-fixture'

describe('approval eligibility and review activity', () => {

  it('starts a current-head follow-up for a public author reply without a newer commit', async () => {
    arrangeCli(true, false, { headSha: NEXT_HEAD_SHA }, {
      commits_after_request: 0,
      author_commits_after_request: 0,
      author_pr_comments_after_request: 1,
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--pr-approve', '#17', '--expected-head', NEXT_HEAD_SHA,
    ]))
    expect(db.hasSeen('approve-prs',
      `${pr.repo}#17@req=2026-07-10T10:00:00Z/r=1/head=${NEXT_HEAD_SHA}`)).toBe(true)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.runFile.mock.calls.some(([, args]) => args[0] === '--approve-pr')).toBe(false)
  })

  it('waits for a response when the latest change request has no author engagement', async () => {
    arrangeCli(true, false, {}, {
      status: false,
      commits_after_request: 0,
      author_commits_after_request: 0,
      author_pr_comments_after_request: 0,
      response_count: 0,
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('starts inspection when requested threads are resolved without a commit or reply', async () => {
    arrangeCli(true, false, {}, {
      commits_after_request: 0,
      author_commits_after_request: 0,
      author_pr_comments_after_request: 0,
      resolved_request_threads: 2,
      response_count: 2,
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--pr-approve', '#17', '--expected-head', HEAD_SHA,
    ]))
    expect(db.hasSeen('approve-prs',
      `${pr.repo}#17@req=2026-07-10T10:00:00Z/r=2/head=${HEAD_SHA}`)).toBe(true)
    expect(mocks.captureAdmission).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      behavior: 'approve-prs', nativeId: expect.any(String), plannedSlots: ['primary'],
      admissionKey: JSON.stringify(['Vaquum', 'approve-prs', `${pr.repo}#17@req=2026-07-10T10:00:00Z/r=2/head=${HEAD_SHA}`]),
    }))
    expect(mocks.runFile.mock.calls.some(([, args]) => args[0] === '--approve-pr')).toBe(false)
  })

  it.each([
    { resolved_request_threads: '2', response_count: 3 },
    { resolved_request_threads: 2, response_count: 1 },
  ])('rejects malformed resolution evidence %j without launching', async (evidence) => {
    arrangeCli(true, false, {}, evidence)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ behavior: 'approve-prs', target: `${pr.repo}#17:check` }),
    ])
  })

  it.each([
    { author_pr_comments_after_request: -1 },
    { author_pr_comments_after_request: null },
    { author_pr_comments_after_request: '1' },
    { author_pr_comments_after_request: 1.5 },
    { author_pr_comments_after_request: 1, response_count: 1 },
  ])('rejects invalid public reply evidence %j without launching', async (evidence) => {
    arrangeCli(true, false, {}, evidence)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ behavior: 'approve-prs', target: `${pr.repo}#17:check` }),
    ])
  })

  it('approves a requested clean review on the next scan without a CI gate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const completedAt = '2026-07-15T11:59:59.000Z'
    arrangeCli(false, false, {
      requestedReviewers: ['other-reviewer', 'REVIEW-BOT'],
      headSha: NEXT_HEAD_SHA,
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt, headSha: NEXT_HEAD_SHA })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledWith(
      'agent-interface',
      expect.arrayContaining(['--pr-approve', `#${pr.number}`]),
      expect.any(Object),
    )
    expect(mocks.runFile).toHaveBeenCalledWith(
      'github-interface',
      [
        '--review-activity-since',
        `#${pr.number}`,
        '--username',
        'review-bot',
        '--since',
        completedAt,
        '--token-user',
        'review-bot',
      ],
      expect.objectContaining({ cwd: expect.stringContaining('Vaquum/poise-test') }),
    )
    expect(mocks.runFile.mock.calls.some(([command]) => command === 'gh')).toBe(false)

    const onExit = (mocks.spawnDetached.mock.calls[0][2] as {
      onExit: (result: { code: number | null, signal: NodeJS.Signals | null }) => void
    }).onExit
    onExit({ code: 0, signal: null })
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.claimSeen(
      'approve-prs',
      `${pr.repo}#${pr.number}@head=${NEXT_HEAD_SHA}`,
    )).toBe(false)
  })

  it('waits for a busy per-PR lock instead of silently starving an eligible approval', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db)
    const blocker = db.claimPrOperationOwned(`${pr.repo}#${pr.number}`, 65_000)
    if (!blocker) throw new Error('could not arrange competing PR operation')
    setTimeout(() => db.releasePrOperationOwned(blocker), 25)

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-approve')
  })

  it('waits for a busy per-PR lock before initial review', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    const blocker = db.claimPrOperationOwned(`${pr.repo}#${pr.number}`, 65_000)
    if (!blocker) throw new Error('could not arrange competing operation')
    setTimeout(() => db.releasePrOperationOwned(blocker), 25)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-review')
  })

  it('does not take a resolver mutation lock when there are no conversations', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    const claim = vi.spyOn(db, 'claimPrOperationOwned')
    await runtime.runEnabledBehaviorsOnce()
    expect(claim).not.toHaveBeenCalled()
    expect(mocks.runFile.mock.calls.some(([, args]) => args[0] === '--resolve-nonblocking-conversations-if-ready')).toBe(false)
  })

  it('does not debounce recent PR activity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const activity: ReviewActivityFixture = {
      requestedReviewers: ['review-bot'],
      latestActivityAt: '2026-07-15T11:59:59.000Z',
    }
    arrangeCli(false, false, activity)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:40:00.000Z' })

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('uses a completed approval as the basis for approving a later head', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      latestActivityAt: '2026-07-15T11:49:59.000Z',
      unresolvedConversationCount: 3,
      unresolvedConversationAuthors: ['review-bot'],
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    const target = `${pr.repo}#${pr.number}@quiet=prior/head=${HEAD_SHA}`
    const claimId = db.claimSeenOwned('approve-prs', target)!
    expect(db.markBehaviorLaunchIntentOwned({
      key: 'approve-prs',
      target,
      claimId,
      launchBehavior: 'pr_approve',
      repo: pr.repo,
      pr: pr.number,
      requestedAt: '2026-07-15T11:39:00.000Z',
      expectedHead: HEAD_SHA,
      actor: 'review-bot',
      source: 'poise:approve-prs',
      correlationId: claimId,
    })).toBe(true)
    expect(db.linkBehaviorLaunchCallOwned(
      'approve-prs',
      target,
      claimId,
      'b'.repeat(32),
    )).toBe(true)
    expect(db.completeBehaviorLaunchOwned({
      key: 'approve-prs',
      target,
      claimId,
      outcome: 'approved',
      action: 'approved',
      completedAt: '2026-07-15T11:40:00.000Z',
      headSha: HEAD_SHA,
    })).toBe(true)

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(NEXT_HEAD_SHA)
  })

  it('does not reapprove while another reviewer owns an unresolved conversation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      latestActivityAt: '2026-07-15T11:49:59.000Z',
      unresolvedConversationCount: 2,
      unresolvedConversationAuthors: ['review-bot', 'other-reviewer'],
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    const target = `${pr.repo}#${pr.number}@quiet=prior/head=${HEAD_SHA}`
    const claimId = db.claimSeenOwned('approve-prs', target)!
    expect(db.markBehaviorLaunchIntentOwned({
      key: 'approve-prs',
      target,
      claimId,
      launchBehavior: 'pr_approve',
      repo: pr.repo,
      pr: pr.number,
      requestedAt: '2026-07-15T11:39:00.000Z',
      expectedHead: HEAD_SHA,
      actor: 'review-bot',
      source: 'poise:approve-prs',
      correlationId: claimId,
    })).toBe(true)
    expect(db.linkBehaviorLaunchCallOwned(
      'approve-prs',
      target,
      claimId,
      'b'.repeat(32),
    )).toBe(true)
    expect(db.completeBehaviorLaunchOwned({
      key: 'approve-prs',
      target,
      claimId,
      outcome: 'approved',
      action: 'approved',
      completedAt: '2026-07-15T11:40:00.000Z',
      headSha: HEAD_SHA,
    })).toBe(true)

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('launches eligible approvals independently across PRs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
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
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, {
      completedAt: '2026-07-15T11:40:00.000Z',
    })
    recordCompletedInitialReview(db, {
      pull: secondPr,
      completedAt: '2026-07-15T11:40:00.000Z',
      callId: 'd'.repeat(32),
    })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['--pr-approve', `#${pr.number}`]),
        expect.arrayContaining(['--pr-approve', `#${secondPr.number}`]),
      ]),
    )
  })

  it('does not approve a clean review while a review conversation is unresolved', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false, false, { unresolvedConversationCount: 1 })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:40:00.000Z' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('evaluates approval after a third-party conversation becomes outdated', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false, false, {
      unresolvedConversationCount: 1,
      unresolvedLiveConversationCount: 0,
      unresolvedConversationAuthors: ['other-reviewer'],
      unresolvedLiveConversationAuthors: [],
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:40:00.000Z' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-approve')
  })

  it('does not approve addressed changes while another reviewer owns an unresolved conversation', async () => {
    arrangeCli(true, false, {
      unresolvedConversationCount: 2,
      unresolvedConversationAuthors: ['review-bot', 'other-reviewer'],
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('approves on the next scan after another reviewer dismisses a change request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    const activity: ReviewActivityFixture = {
      requestedReviewers: ['review-bot'],
      activeChangeRequestAuthors: ['zero-bang'],
      latestActivityAt: '2026-07-15T11:45:00.000Z',
    }
    arrangeCli(false, false, activity)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:40:00.000Z' })

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    activity.activeChangeRequestAuthors = []
    activity.latestActivityAt = '2026-07-15T12:00:00.000Z'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('requires an open non-draft PR but not a separate review request', async () => {
    const activity: ReviewActivityFixture = {
      requestedReviewers: ['other-reviewer'],
    }
    arrangeCli(false, false, activity)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db)

    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    mocks.spawnDetached.mockClear()
    db.clearSeen('approve-prs')
    db.clearSeen('pr-operation')

    activity.draft = true
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    activity.draft = false
    activity.state = 'CLOSED'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    activity.state = 'OPEN'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('does not treat a changes-requested review outcome as clean', async () => {
    arrangeCli(false, false, { requestedReviewers: ['review-bot'] })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { outcome: 'changes_requested' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(mocks.runFile.mock.calls.some(
      ([command, args]) => command === 'github-interface'
        && args[0] === '--review-activity-since',
    )).toBe(false)
  })
})
