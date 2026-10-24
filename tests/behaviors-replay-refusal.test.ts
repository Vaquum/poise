import { describe, expect, it } from 'vitest'
import { mocks, pr, HEAD_SHA, fixture, loadModules, arrangeCli, agentLog, recordCompletedInitialReview } from './behaviors-runtime-fixture'

async function admitReady() {
  const { database, behaviors } = await loadModules()
  database.setMeta('me', 'poise-user')
  return { database, behaviors }
}

function failedPrClaim(
  database: Awaited<ReturnType<typeof loadModules>>['database'],
  key: 'review-new-prs' | 'approve-prs',
  target: string,
  callId: string,
) {
  const claimId = database.claimSeenOwned(key, target)!
  database.markBehaviorLaunchIntentOwned({
    key, target, claimId, launchBehavior: key === 'review-new-prs' ? 'pr_review' : 'pr_approve',
    repo: pr.repo, pr: pr.number, requestedAt: new Date().toISOString(),
    expectedHead: HEAD_SHA, actor: 'review-bot', source: `poise:${key}`, correlationId: claimId,
  })
  database.linkBehaviorLaunchCallOwned(key, target, claimId, callId)
  database.recordBehaviorDeadLetter(
    database.listBehaviorLaunchClaims(key).find((claim) => claim.target === target)!, 'worker failed', callId)
  database.setBehaviorLaunchErrorOwned(key, target, claimId, 'worker failed')
  expect(database.completeSeenOwned(key, target, claimId)).toBe(true)
}

describe('replay publication refusal', () => {
  it('refuses a pr_approve replay when the failed run already published its approval', async () => {
    arrangeCli(false, false, {
      reviewerReviewsSinceItems: [{ id: 91, state: 'APPROVED', commit: HEAD_SHA }],
    })
    fixture.agentLogs = [agentLog({
      id: 'b'.repeat(32), behavior: 'pr_approve', status: 'failed', error: 'worker failed',
      source: 'poise:approve-prs', correlation_id: 'c'.repeat(32),
      review_id: null, head_sha: null, expected_head: HEAD_SHA,
    })]
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_approve', pr.repo, pr.number))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('already published on') })
  })

  it('refuses a pr_review replay when an unclaimed review sits on the current head', async () => {
    arrangeCli(false, false, {
      reviewerReviewsSinceItems: [{ id: 91, state: 'CHANGES_REQUESTED', commit: HEAD_SHA }],
    })
    fixture.agentLogs = [agentLog({ id: 'b'.repeat(32), status: 'failed', error: 'worker failed', correlation_id: 'c'.repeat(32) })]
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('review 91') })
  })

  it('refuses a pr_review replay of completed work whose review is already published', async () => {
    arrangeCli(false, false, {
      reviewerReviewsSinceItems: [{ id: 91, state: 'COMMENTED', commit: HEAD_SHA }],
    })
    fixture.agentLogs = [agentLog({
      id: 'b'.repeat(32), status: 'completed', action: 'reviewed_clean', outcome: 'clean',
      head_sha: HEAD_SHA, review_id: 91, correlation_id: 'c'.repeat(32),
      completed_at: new Date().toISOString(),
    })]
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('already published') })
  })

  it('admits a failed panel slot beside a claimed sibling review on the same head', async () => {
    arrangeCli(false, false, {
      reviewerReviewsSinceItems: [{ id: 91, state: 'COMMENTED', commit: HEAD_SHA }],
    })
    fixture.agentLogs = [
      agentLog({
        id: 'b'.repeat(32), status: 'completed', action: 'reviewed_clean', outcome: 'clean',
        head_sha: HEAD_SHA, review_id: 91, correlation_id: 'c'.repeat(32),
        completed_at: new Date().toISOString(),
      }),
      agentLog({ id: 'e'.repeat(32), status: 'failed', error: 'worker failed', correlation_id: 'f'.repeat(32) }),
    ]
    const { database, behaviors } = await admitReady()
    failedPrClaim(database, 'review-new-prs', `${pr.repo}#${pr.number}:tertiary`, 'e'.repeat(32))

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number)).resolves.toMatchObject({ author: pr.author })
  })

  it('admits a pr_approve replay after the head approval was dismissed', async () => {
    arrangeCli(false, false, {
      reviewerLatestState: 'DISMISSED',
      reviewerLatestCommit: HEAD_SHA,
      reviewerReviewsSinceItems: [{ id: 91, state: 'DISMISSED', commit: HEAD_SHA }],
    })
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_approve', pr.repo, pr.number)).resolves.toMatchObject({ author: pr.author })
  })

  it('admits a pr_approve replay while an unclaimed change request stands on the head', async () => {
    arrangeCli(false, false, {
      reviewerReviewsSinceItems: [{ id: 91, state: 'CHANGES_REQUESTED', commit: HEAD_SHA }],
    })
    fixture.agentLogs = [agentLog({ id: 'b'.repeat(32), status: 'failed', error: 'worker failed', correlation_id: 'c'.repeat(32) })]
    const { behaviors } = await admitReady()

    // An approval replay duplicates only an approval: a lost review verdict
    // belongs to the review behavior, not to this replay.
    await expect(behaviors.admitReplay('pr_approve', pr.repo, pr.number)).resolves.toMatchObject({ author: pr.author })
  })

  it('admits a pr_review replay while only an approval stands on the head', async () => {
    arrangeCli(false, false, {
      reviewerReviewsSinceItems: [{ id: 91, state: 'APPROVED', commit: HEAD_SHA }],
    })
    fixture.agentLogs = [agentLog({
      id: 'b'.repeat(32), behavior: 'pr_approve', status: 'completed', action: 'approved', outcome: 'approved',
      head_sha: HEAD_SHA, review_id: 91, source: 'poise:approve-prs', correlation_id: 'c'.repeat(32),
      completed_at: new Date().toISOString(),
    })]
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number)).resolves.toMatchObject({ author: pr.author })
  })

  it('admits a failed slot beside a claimed sibling review after its incident retired', async () => {
    arrangeCli(false, false, {
      reviewerReviewsSinceItems: [{ id: 91, state: 'COMMENTED', commit: HEAD_SHA }],
    })
    fixture.agentLogs = [
      agentLog({
        id: 'b'.repeat(32), status: 'completed', action: 'reviewed_clean', outcome: 'clean',
        head_sha: HEAD_SHA, review_id: 91, correlation_id: 'c'.repeat(32),
        completed_at: new Date().toISOString(),
      }),
      agentLog({ id: 'e'.repeat(32), status: 'failed', error: 'worker failed', correlation_id: 'f'.repeat(32) }),
    ]
    const { database, behaviors } = await admitReady()
    failedPrClaim(database, 'review-new-prs', `${pr.repo}#${pr.number}:tertiary`, 'e'.repeat(32))
    database.db.prepare('UPDATE behavior_dead_letters SET created_at = ?')
      .run(new Date(Date.now() - 60 * 60_000).toISOString())
    recordCompletedInitialReview(database, {})
    // The sibling's later success reconciles the incident away, but the
    // failed slot itself still has no launch outcome.
    const [settled] = database.reconcileBehaviorDeadLetters(new Set([`${pr.repo}#${pr.number}`]))
    expect(settled.disposition).toBe('resolved')

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number)).resolves.toMatchObject({ author: pr.author })
  })

  it('admits a pr_approve replay while only a change request stands on the head', async () => {
    arrangeCli(false, false, {
      reviewerLatestState: 'CHANGES_REQUESTED',
      reviewerLatestCommit: HEAD_SHA,
      reviewerReviewsSinceItems: [{ id: 91, state: 'CHANGES_REQUESTED', commit: HEAD_SHA }],
    })
    fixture.agentLogs = [agentLog({
      id: 'b'.repeat(32), status: 'completed', action: 'requested_changes', outcome: 'changes_requested',
      head_sha: HEAD_SHA, review_id: 91, correlation_id: 'c'.repeat(32),
      completed_at: new Date().toISOString(),
    })]
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_approve', pr.repo, pr.number)).resolves.toMatchObject({ author: pr.author })
  })

  it('refuses while the scheduler still owns the pull request', async () => {
    arrangeCli()
    const { database, behaviors } = await admitReady()
    const target = `${pr.repo}#${pr.number}`
    const claimId = database.claimSeenOwned('review-new-prs', target)!
    database.markBehaviorLaunchIntentOwned({
      key: 'review-new-prs', target, claimId, launchBehavior: 'pr_review',
      repo: pr.repo, pr: pr.number, requestedAt: new Date().toISOString(),
      expectedHead: HEAD_SHA, actor: 'review-bot', source: 'poise:review-new-prs', correlationId: claimId,
    })

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('still active') })
    expect(mocks.runFile.mock.calls.some(([command, args]: any[]) =>
      command === 'github-interface' && args[0] === '--review-activity-since')).toBe(false)
  })

  it('refuses when reviews are reported only as a count that cannot be placed', async () => {
    arrangeCli(false, false, { reviewerReviewsSince: 2 })
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_approve', pr.repo, pr.number))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('cannot prove') })
  })

  it('answers 502 and launches nothing when live GitHub cannot be read', async () => {
    arrangeCli()
    const base = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && args[0] === '--review-activity-since') {
        throw new Error('github down')
      }
      return base(command, args, options)
    })
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_approve', pr.repo, pr.number))
      .rejects.toMatchObject({ statusCode: 502 })
  })

  it('refuses a replay while a possibly-matching worker row is quarantined', async () => {
    arrangeCli()
    fixture.agentLogs = [{ corrupt: true }]
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('cannot prove no worker is active') })
  })

  it('ignores a quarantined row that names another repository', async () => {
    arrangeCli()
    fixture.agentLogs = [{ corrupt: true, repo: 'other/repo', pr_id: '9' }]
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number)).resolves.toMatchObject({ author: pr.author })
  })

  it('admits exactly one of two concurrent replays of the same target', async () => {
    arrangeCli()
    const { database, behaviors } = await admitReady()

    const [first, second] = await Promise.allSettled([
      behaviors.admitReplay('pr_review', pr.repo, pr.number),
      behaviors.admitReplay('pr_review', pr.repo, pr.number),
    ])
    const admitted = [first, second].filter((result) => result.status === 'fulfilled')
    const refused = [first, second].filter((result) => result.status === 'rejected')
    expect(admitted).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409, message: expect.stringContaining('already in progress'),
    })
    expect(database.db.prepare('SELECT repo, pr, behavior FROM behavior_replay_reservations').all()).toEqual([
      { repo: pr.repo, pr: pr.number, behavior: 'pr_review' },
    ])
  })

  it('admits concurrent replays of different behaviors on the same pull request', async () => {
    arrangeCli()
    const { behaviors } = await admitReady()

    await expect(Promise.all([
      behaviors.admitReplay('pr_review', pr.repo, pr.number),
      behaviors.admitReplay('pr_approve', pr.repo, pr.number),
    ])).resolves.toEqual([{ author: pr.author, actor: 'review-bot', reviewEnvironment: undefined }, { author: pr.author, actor: 'review-bot', reviewEnvironment: {} }])
  })

  it('releases its reservation when refused, leaving nothing behind', async () => {
    arrangeCli(false, false, {
      reviewerReviewsSinceItems: [{ id: 91, state: 'APPROVED', commit: HEAD_SHA }],
    })
    const { database, behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_approve', pr.repo, pr.number))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(database.db.prepare('SELECT count(*) FROM behavior_replay_reservations').pluck().get()).toBe(0)
  })

  it('fences the launch claim itself while reserved, atomically with the claim', async () => {
    arrangeCli()
    const { database } = await admitReady()
    const target = `${pr.repo}#${pr.number}`
    const claimId = database.claimSeenOwned('review-new-prs', target)!
    const intent = {
      key: 'review-new-prs', target, claimId, launchBehavior: 'pr_review' as const,
      repo: pr.repo, pr: pr.number, requestedAt: new Date().toISOString(),
      expectedHead: HEAD_SHA, actor: 'review-bot', source: 'poise:review-new-prs', correlationId: claimId,
    }
    expect(database.reserveBehaviorReplay(pr.repo, pr.number, 'pr_review')).toBe(true)
    expect(database.markBehaviorLaunchIntentOwned(intent)).toBe(false)
    database.db.prepare('DELETE FROM behavior_replay_reservations').run()
    expect(database.markBehaviorLaunchIntentOwned(intent)).toBe(true)
  })

  it('admits past an expired reservation', async () => {
    arrangeCli()
    const { database, behaviors } = await admitReady()
    database.db.prepare(`
      INSERT INTO behavior_replay_reservations(repo, pr, behavior, created_at, expires_at)
      VALUES (?, ?, 'pr_review', '2026-07-15T12:00:00Z', '2026-07-15T12:10:00Z')
    `).run(pr.repo, pr.number)

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number)).resolves.toMatchObject({ author: pr.author })
  })

  it('makes the scheduler skip a reserved target and launch once the reservation expires', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database, behaviors } = await admitReady()
    database.setMeta('models', 'mock-models')
    database.recordSeen('review-new-prs', '__snapshot_v3__')
    database.setMeta('behavior_review_new_prs_keyver', '3')
    behaviors.startBehaviorsRuntime()
    database.setMeta('behavior_review_new_prs_enabled', '1')
    expect(database.reserveBehaviorReplay(pr.repo, pr.number, 'pr_review')).toBe(true)

    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    database.db.prepare('UPDATE behavior_replay_reservations SET expires_at = ?')
      .run(new Date(Date.now() - 1000).toISOString())
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('leaves issue_review replays a deliberate fresh run with no publication check', async () => {
    arrangeCli()
    const base = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-datastore' && args.includes('issue')) {
        return {
          stdout: JSON.stringify([{
            repo: pr.repo, number: pr.number, author: 'poise-user',
            created_at: '2026-07-15T12:00:00Z', status: 'open',
            url: `https://github.com/${pr.repo}/issues/${pr.number}`,
          }]),
          stderr: '',
        }
      }
      return base(command, args, options)
    })
    const { database, behaviors } = await admitReady()
    database.setMeta('behavior_review_new_issues_repos', JSON.stringify([{ repo: pr.repo, since: '2026-07-01T00:00:00Z' }]))
    database.setMeta('behavior_review_new_issues_authors', JSON.stringify(['poise-user']))

    await expect(behaviors.admitReplay('issue_review', pr.repo, pr.number)).resolves.toBeUndefined()
    expect(mocks.runFile.mock.calls.some(([command, args]: any[]) =>
      command === 'github-interface' && args[0] === '--review-activity-since')).toBe(false)
  })
})
