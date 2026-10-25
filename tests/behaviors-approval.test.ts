import { describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatRuntime } from '../server/chat/runtime'
import { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, loadModules, restartModules, resetLogCache, arrangeCli, recordCompletedInitialReview, launchApprovalBeforeCrash, agentLog, fixture, type ReviewActivityFixture } from './behaviors-runtime-fixture'

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

  it('starts a behavior launch normally with a release switch pending', async () => {
    arrangeCli(true, false, { headSha: NEXT_HEAD_SHA }, {
      commits_after_request: 0,
      author_commits_after_request: 0,
      author_pr_comments_after_request: 1,
    })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    // A pending Poise update waits Chat turns only; the scheduler keeps launching.
    const { ServiceControl } = await import('../server/service/control')
    const releasesDir = join(fixture.tempRoot, 'releases')
    await mkdir(join(releasesDir, 'r2'), { recursive: true })
    await writeFile(join(releasesDir, 'r2', 'base'), 'b1\n')
    await writeFile(join(releasesDir, 'r2', 'installed'), '')
    const chat = { instance: 'behavior-switch-test', setSwitchPending: () => {}, endDrain: () => {} } as unknown as ChatRuntime
    const service = new ServiceControl(chat, {
      drainTimeoutSeconds: 60, timer: { setTimeout: () => 0, clearTimeout: () => {} },
      log: () => {}, releasesDir, release: { name: 'r1', base: 'b1' }, restart: () => true, canRestart: () => true,
    })
    service.switchRelease('r2')
    try {
      runtime.startBehaviorsRuntime()
      db.setMeta('me', 'poise-user')
      db.setMeta('behavior_approve_prs_enabled', '1')

      await runtime.runEnabledBehaviorsOnce()

      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining([
        '--pr-approve', '#17', '--expected-head', NEXT_HEAD_SHA,
      ]))
    } finally {
      service.reset()
    }
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
    const activityCalls = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--review-activity-since')
    expect(activityCalls).toHaveLength(1)
    const [, activityArgs, activityOptions] = activityCalls[0]
    expect(activityArgs.slice(0, 2)).toEqual(['--review-activity-since', '--requests-json'])
    expect(JSON.parse(activityArgs[activityArgs.indexOf('--requests-json') + 1])).toEqual([
      { repository: pr.repo, number: pr.number, since: completedAt },
    ])
    expect(activityOptions).not.toHaveProperty('cwd')
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
      updated_at: '2026-07-15T12:00:00Z',
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
    // The dismissal is a new review, so the datastore row moves too.
    fixture.listedPrs = [{ ...pr, updated_at: '2026-07-15T12:00:01Z' }]
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

    // Each transition below moves the datastore row, as on GitHub.
    activity.draft = true
    fixture.listedPrs = [{ ...pr, updated_at: '2026-07-15T12:00:01Z' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    activity.draft = false
    activity.state = 'CLOSED'
    fixture.listedPrs = [{ ...pr, updated_at: '2026-07-15T12:00:02Z' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    activity.state = 'OPEN'
    fixture.listedPrs = [{ ...pr, updated_at: '2026-07-15T12:00:03Z' }]
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

  it('recovers a dismissed superseded approval from a completed negative review', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const prior = await launchApprovalBeforeCrash()
    recordCompletedInitialReview(prior.database, {
      target: `${pr.repo}#${pr.number}:tertiary`, outcome: 'changes_requested',
    })
    prior.database.recordSeen('review-new-prs', `${pr.repo}#${pr.number}`)
    prior.database.recordSeen('review-new-prs', `${pr.repo}#${pr.number}:secondary`)
    expect(prior.database.latestApprovalBasisLaunch(pr.repo, pr.number)).toBeNull()
    fixture.agentLogs = [agentLog({
      behavior: 'pr_approve', status: 'failed', error: 'submitted approval was dismissed as stale after the target moved',
      error_code: 'approval_dismissed_stale',
      expected_head: prior.expectedHead,
      started_at: new Date(Date.parse(prior.requestedAt) + 1_000).toISOString(),
      completed_at: new Date().toISOString(), review_id: 91,
      actor: prior.actor, source: prior.source, correlation_id: prior.correlationId,
    })]
    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA, reviewerLatestState: 'DISMISSED', reviewerLatestCommit: HEAD_SHA,
      latestActivityAt: new Date().toISOString(),
    }, { reviewer_latest_state: 'DISMISSED' })
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()

    await modules.behaviors.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    const args: string[] = mocks.spawnDetached.mock.calls[1][1]
    expect(args).toEqual(expect.arrayContaining(['--pr-approve', '#17', '--expected-head', NEXT_HEAD_SHA]))
    expect(modules.database.hasSeen('approve-prs', `${pr.repo}#17@head=${NEXT_HEAD_SHA}`)).toBe(true)
    expect(modules.database.latestApprovalBasisLaunch(pr.repo, pr.number)).toBeNull()
    expect(mocks.captureOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'approved' }))
    expect(mocks.runFile.mock.calls.some(([, argv]) => argv[0] === '--approve-pr')).toBe(false)

    await modules.behaviors.runEnabledBehaviorsOnce()
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)

    vi.setSystemTime(Date.now() + 2_000)
    fixture.agentLogs.push(agentLog({
      id: 'e'.repeat(32), behavior: 'pr_approve', status: 'completed',
      action: 'approved', outcome: 'approved', expected_head: NEXT_HEAD_SHA, head_sha: NEXT_HEAD_SHA,
      review_id: 92, correlation_id: args[args.indexOf('--correlation-id') + 1],
    }))
    await resetLogCache()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.latestApprovalBasisLaunch(pr.repo, pr.number)?.headSha).toBe(NEXT_HEAD_SHA)
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  })

  it('can use a completed approval change request by the same reviewer', async () => {
    const prior = await launchApprovalBeforeCrash()
    const callId = 'b'.repeat(32)
    expect(prior.database.linkBehaviorLaunchCallOwned('approve-prs', prior.target, prior.correlationId, callId)).toBe(true)
    expect(prior.database.completeBehaviorLaunchOwned({
      key: 'approve-prs', target: prior.target, claimId: prior.correlationId,
      action: 'requested_changes', outcome: 'changes_requested',
      completedAt: new Date().toISOString(), headSha: HEAD_SHA,
    })).toBe(true)
    expect(prior.database.latestApprovalBasisLaunch(pr.repo, pr.number)).toBeNull()
    expect(prior.database.latestCompletedChangeRequestLaunch(pr.repo, pr.number, 'REVIEW-BOT')).toMatchObject({
      callId, headSha: HEAD_SHA,
    })
  })

  it.each([
    ['launch_actor', 'another-reviewer'], ['launch_source', 'another-system'],
    ['launch_behavior', 'issue_review'], ['launch_action', 'approved'],
    ['launch_outcome', 'superseded'], ['claim_id', 'inflight'],
    ['launch_error', 'unreadable'], ['launch_quarantine', 'unreadable'],
    ['launch_requested_at', null], ['launch_call_id', null], ['launch_call_id', ''],
    ['launch_completed_at', null], ['launch_completed_at', 'invalid'],
    ['launch_expected_head', NEXT_HEAD_SHA], ['launch_head_sha', 'x'.repeat(40)],
  ] as const)('rejects invalid prior change-request evidence (%s=%s)', async (column, value) => {
    const { database: db } = await loadModules()
    recordCompletedInitialReview(db, { outcome: 'changes_requested' })
    db.db.prepare(`UPDATE behavior_seen SET ${column} = ? WHERE key = 'review-new-prs'`).run(value)
    if (column === 'launch_head_sha') db.db.prepare("UPDATE behavior_seen SET launch_expected_head = ?").run(value)
    expect(db.latestCompletedChangeRequestLaunch(pr.repo, pr.number, 'review-bot')).toBeNull()
  })

  it.each([
    'missing-review', 'same-head', 'head-race', 'dismissal-race', 'missing-activity',
    'active-request', 'live-conversation', 'draft', 'closed',
  ] as const)('does not recover a dismissal with %s', async (blocked) => {
    const activity: ReviewActivityFixture = {
      headSha: blocked === 'same-head' ? HEAD_SHA : NEXT_HEAD_SHA,
      reviewerLatestState: blocked === 'dismissal-race' ? null : 'DISMISSED',
      latestActivityAt: blocked === 'missing-activity' ? null : new Date().toISOString(),
      activeChangeRequestAuthors: blocked === 'active-request' ? ['another-reviewer'] : [],
      unresolvedLiveConversationCount: blocked === 'live-conversation' ? 1 : 0,
      unresolvedConversationCount: blocked === 'live-conversation' ? 1 : 0,
      unresolvedLiveConversationAuthors: blocked === 'live-conversation' ? ['another-reviewer'] : [],
      draft: blocked === 'draft', state: blocked === 'closed' ? 'CLOSED' : 'OPEN',
    }
    arrangeCli(false, false, activity, {
      reviewer_latest_state: 'DISMISSED',
      ...(blocked === 'head-race' ? { head_sha: HEAD_SHA } : {}),
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    if (blocked !== 'missing-review') recordCompletedInitialReview(db, { outcome: 'changes_requested' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.latestApprovalBasisLaunch(pr.repo, pr.number)).toBeNull()
  })

  it('re-approves a dismissed approval when only the reviewer owns live conversations', async () => {
    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      reviewerLatestState: 'DISMISSED',
      reviewerLatestCommit: HEAD_SHA,
      latestActivityAt: new Date().toISOString(),
      unresolvedConversationCount: 2,
      unresolvedLiveConversationCount: 2,
      unresolvedConversationAuthors: ['review-bot'],
      unresolvedLiveConversationAuthors: ['review-bot'],
    }, { reviewer_latest_state: 'DISMISSED' })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { outcome: 'changes_requested' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--pr-approve', '#17', '--expected-head', NEXT_HEAD_SHA, '--actor', 'review-bot',
    ]))
    expect(db.hasSeen('approve-prs', `${pr.repo}#17@head=${NEXT_HEAD_SHA}`)).toBe(true)
  })

  it('re-approves on the next tick after a push dismisses the approval with no threads', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      reviewerLatestState: 'DISMISSED',
      reviewerLatestCommit: HEAD_SHA,
      latestActivityAt: new Date().toISOString(),
    }, { reviewer_latest_state: 'DISMISSED' })
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    const target = `${pr.repo}#${pr.number}@head=${HEAD_SHA}`
    const claimId = db.claimSeenOwned('approve-prs', target)
    if (!claimId) throw new Error('could not arrange approval basis')
    db.markBehaviorLaunchIntentOwned({
      key: 'approve-prs', target, claimId,
      launchBehavior: 'pr_approve', repo: pr.repo, pr: pr.number,
      requestedAt: new Date(Date.now() - 60_000).toISOString(), expectedHead: HEAD_SHA,
      actor: 'review-bot', source: 'poise:approve-prs', correlationId: claimId,
    })
    db.linkBehaviorLaunchCallOwned('approve-prs', target, claimId, 'a'.repeat(32))
    const completed = db.completeBehaviorLaunchOwned({
      key: 'approve-prs', target, claimId,
      action: 'approved', outcome: 'approved',
      completedAt: new Date(Date.now() - 30_000).toISOString(), headSha: HEAD_SHA,
    })
    if (!completed) throw new Error('could not complete approval basis')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining([
      '--pr-approve', '#17', '--expected-head', NEXT_HEAD_SHA,
    ]))
    expect(db.hasSeen('approve-prs', `${pr.repo}#17@head=${NEXT_HEAD_SHA}`)).toBe(true)
  })

  it('logs why a dismissed approval without a basis is skipped', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      reviewerLatestState: 'DISMISSED',
      reviewerLatestCommit: HEAD_SHA,
      latestActivityAt: new Date().toISOString(),
    }, { reviewer_latest_state: 'DISMISSED' })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    const lines = () => log.mock.calls.map(([first]) => String(first))
    expect(lines().some((line) =>
      line.includes(`approve-prs skipped ${pr.repo}#${pr.number}`)
      && line.includes('without a recorded approval or change-request basis'),
    )).toBe(true)
    await runtime.runEnabledBehaviorsOnce()
    expect(lines().some((line) => line.includes('no change since last check'))).toBe(true)
    const calls = log.mock.calls.length
    await runtime.runEnabledBehaviorsOnce()
    expect(log.mock.calls.length).toBe(calls)
  })

  it('does not re-approve a dismissed approval while another author owns a live conversation', async () => {
    arrangeCli(false, false, {
      headSha: NEXT_HEAD_SHA,
      reviewerLatestState: 'DISMISSED',
      reviewerLatestCommit: HEAD_SHA,
      latestActivityAt: new Date().toISOString(),
      unresolvedConversationCount: 3,
      unresolvedLiveConversationCount: 3,
      unresolvedConversationAuthors: ['review-bot', 'another-reviewer'],
      unresolvedLiveConversationAuthors: ['review-bot', 'another-reviewer'],
    }, { reviewer_latest_state: 'DISMISSED' })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { outcome: 'changes_requested' })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.hasSeen('approve-prs', `${pr.repo}#17@head=${NEXT_HEAD_SHA}`)).toBe(false)
  })

  it.each(['--review-activity-since', '--local-checkout-path'])('abandons dismissed recovery when the reviewer changes during %s', async (stage) => {
    arrangeCli(false, false, { headSha: NEXT_HEAD_SHA, reviewerLatestState: 'DISMISSED',
      latestActivityAt: new Date().toISOString() }, { reviewer_latest_state: 'DISMISSED' })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { outcome: 'changes_requested' })
    const original = mocks.runFile.getMockImplementation()!
    let changed = false
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      const result = await original(command, args, options)
      if (args[0] === stage && !changed) { changed = true; db.setMeta('agentAccount', 'replacement-bot') }
      return result
    })

    await runtime.runEnabledBehaviorsOnce()

    expect(changed).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.hasSeen('approve-prs', `${pr.repo}#17@head=${NEXT_HEAD_SHA}`)).toBe(false)
    expect(db.listBehaviorLaunchClaims('approve-prs')).toEqual([])
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    const target = `${pr.repo}#17:replacement`
    recordCompletedInitialReview(db, { target, outcome: 'changes_requested', callId: 'd'.repeat(32) })
    db.db.prepare('UPDATE behavior_seen SET launch_actor = ? WHERE target = ?').run('replacement-bot', target)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining(['--actor', 'replacement-bot']))
  })

  it.each([
    'stopped', 'review_provider_blocked', 'new-head', 'new-model', 'receipt', 'executed-head',
    'ambiguous-action', 'missing-call', 'wrong-source', 'retry-delay',
    'head-receipt', 'head-executed-head', 'head-ambiguous-action', 'head-new-model',
    'head-model-rollback', 'head-reviewer-change', 'head-preparation-failure',
  ] as const)('preserves a held approval across dismissal and key changes (%s)', async (variant) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const prior = await launchApprovalBeforeCrash()
    const args: string[] = mocks.spawnDetached.mock.calls[0][1]
    const model = args[args.indexOf('--model') + 1]
    recordCompletedInitialReview(prior.database, { target: `${pr.repo}#17:tertiary`,
      outcome: 'changes_requested', headSha: NEXT_HEAD_SHA })
    const call = agentLog({
      behavior: 'pr_approve', status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      review_policy: 'bounded-v1', error_code: variant === 'review_provider_blocked' ? variant : 'stopped',
      error: 'Review needs attention', model, expected_head: prior.expectedHead,
      actor: prior.actor, source: prior.source, correlation_id: prior.correlationId,
      started_at: new Date(Date.parse(prior.requestedAt) + 1_000).toISOString(),
    })
    fixture.agentLogs = [call]
    arrangeCli(true, false, {}, { commits_after_request: 0, response_count: 0 })
    let modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('approve-prs', prior.target)).not.toBeNull()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    const occupiedHead = variant.startsWith('head-')
    const heldTarget = occupiedHead ? `${pr.repo}#17@head=${HEAD_SHA}` : prior.target
    if (occupiedHead) {
      modules.database.db.prepare('UPDATE behavior_seen SET target = ? WHERE key = ? AND target = ?')
        .run(heldTarget, 'approve-prs', prior.target)
      modules.database.db.prepare('UPDATE behavior_dead_letters SET target = ? WHERE behavior = ? AND target = ?')
        .run(heldTarget, 'approve-prs', prior.target)
    }
    if (occupiedHead || ['new-model', 'receipt', 'executed-head', 'ambiguous-action', 'missing-call', 'wrong-source', 'retry-delay'].includes(variant)) {
      modules.database.setMeta('models', JSON.stringify({ pr_approve: {
        default: model === 'gpt-6-astra-ultra' ? 'opus-5-xhigh' : 'gpt-6-astra-ultra', fallback: model,
      } }))
    }
    if (variant === 'receipt' || variant === 'head-receipt') call.review_id = 91
    if (variant === 'executed-head' || variant === 'head-executed-head') call.head_sha = HEAD_SHA
    if (variant === 'ambiguous-action' || variant === 'head-ambiguous-action') { call.action = null; call.outcome = null }
    if (variant === 'missing-call') fixture.agentLogs = []
    if (variant === 'wrong-source') call.source = 'another-system'
    if (variant === 'retry-delay') modules.database.setMeta(`behavior_approve_prs_failure:${prior.target}`, JSON.stringify({
      kind: 'worker', consecutiveFailures: 1, lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 60_000,
    }))
    // Variants above mutate the held call in place; the next read must see it.
    await resetLogCache()
    const head = variant === 'new-head' ? 'e'.repeat(40) : HEAD_SHA
    arrangeCli(false, false, { headSha: head, reviewerLatestState: 'DISMISSED',
      latestActivityAt: new Date().toISOString() }, { reviewer_latest_state: 'DISMISSED' })
    // The dismissal review (and the push behind a new head) moves the datastore row.
    fixture.listedPrs = [{ ...pr, updated_at: '2026-07-15T12:00:01Z' }]
    const abortPreparation = ['head-model-rollback', 'head-reviewer-change', 'head-preparation-failure'].includes(variant)
    let interrupted = false
    if (abortPreparation) {
      const original = mocks.runFile.getMockImplementation()!
      mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
        const result = await original(command, args, options)
        if (args[0] === '--local-checkout-path' && !interrupted) {
          interrupted = true
          if (variant === 'head-reviewer-change') modules.database.setMeta('agentAccount', 'replacement-bot')
          else if (variant === 'head-preparation-failure') throw new Error('checkout unavailable')
          else modules.database.setMeta('models', JSON.stringify({ pr_approve: { default: model, fallback: model } }))
        }
        return result
      })
    }

    await modules.behaviors.runEnabledBehaviorsOnce()
    if (abortPreparation) {
      expect(interrupted).toBe(true)
      expect(modules.database.getFailedBehaviorLaunch('approve-prs', heldTarget)?.launchCallId).toBe(call.id)
      modules.database.setMeta('agentAccount', prior.actor)
      modules.database.setMeta('models', JSON.stringify({ pr_approve: { default: model, fallback: model } }))
    }
    await modules.behaviors.runEnabledBehaviorsOnce()
    modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()

    const eligible = variant === 'new-head' || variant === 'new-model' || variant === 'head-new-model'
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(eligible ? 2 : 1)
    expect(modules.database.hasSeen('approve-prs', `${pr.repo}#17@head=${head}`)).toBe(eligible || occupiedHead)
    if (variant !== 'head-new-model') expect(modules.database.getFailedBehaviorLaunch('approve-prs', heldTarget)).not.toBeNull()
    expect(modules.database.listBehaviorDeadLetters()).toHaveLength(1)
  })

  it('retries a budget-exhausted dismissed approval on the same head after backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
    const prior = await launchApprovalBeforeCrash()
    const args: string[] = mocks.spawnDetached.mock.calls[0][1]
    const model = args[args.indexOf('--model') + 1]
    recordCompletedInitialReview(prior.database, { target: `${pr.repo}#17:tertiary`,
      outcome: 'changes_requested', headSha: NEXT_HEAD_SHA })
    const call = agentLog({
      behavior: 'pr_approve', status: 'failed', action: null, outcome: null,
      review_policy: 'bounded-v1', error_code: 'review_budget_exhausted',
      error: 'Review reached its total time limit; needs attention', model, expected_head: prior.expectedHead,
      actor: prior.actor, source: prior.source, correlation_id: prior.correlationId,
      started_at: new Date(Date.parse(prior.requestedAt) + 1_000).toISOString(),
    })
    fixture.agentLogs = [call]
    arrangeCli(true, false, {}, { commits_after_request: 0, response_count: 0 })
    const modules = await restartModules()
    modules.behaviors.startBehaviorsRuntime()
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(modules.database.getFailedBehaviorLaunch('approve-prs', prior.target)).not.toBeNull()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    // The dismissed-recovery target occupies this head: move the failed launch there.
    const heldTarget = `${pr.repo}#${pr.number}@head=${HEAD_SHA}`
    modules.database.db.prepare('UPDATE behavior_seen SET target = ? WHERE key = ? AND target = ?')
      .run(heldTarget, 'approve-prs', prior.target)
    modules.database.db.prepare('UPDATE behavior_dead_letters SET target = ? WHERE behavior = ? AND target = ?')
      .run(heldTarget, 'approve-prs', prior.target)
    const failureKey = `behavior_approve_prs_failure:${prior.target}`
    const stored = modules.database.getMeta(failureKey)
    if (!stored) throw new Error('expected a backoff failure for the budget-exhausted launch')
    modules.database.setMeta(`behavior_approve_prs_failure:${heldTarget}`, stored)
    modules.database.setMeta(failureKey, '')
    await resetLogCache()
    arrangeCli(false, false, { headSha: HEAD_SHA, reviewerLatestState: 'DISMISSED',
      latestActivityAt: new Date().toISOString() }, { reviewer_latest_state: 'DISMISSED' })
    fixture.listedPrs = [{ ...pr, updated_at: '2026-07-15T12:00:01Z' }]
    // Still inside the backoff: no relaunch.
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    // Past the backoff the same head relaunches through dismissed recovery.
    vi.setSystemTime(new Date(Date.now() + modules.behaviors.BEHAVIOR_RETRY_BASE_MS))
    await modules.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(mocks.spawnDetached.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['--expected-head', HEAD_SHA]))
  })
})
