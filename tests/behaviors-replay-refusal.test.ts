import { describe, expect, it } from 'vitest'
import { mocks, pr, HEAD_SHA, fixture, loadModules, arrangeCli, agentLog } from './behaviors-runtime-fixture'

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
      id: 'b'.repeat(32), behavior: 'pr_approve', status: 'failed',
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
    fixture.agentLogs = [agentLog({ id: 'b'.repeat(32), status: 'failed', correlation_id: 'c'.repeat(32) })]
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
      agentLog({ id: 'e'.repeat(32), status: 'failed', correlation_id: 'f'.repeat(32) }),
    ]
    const { database, behaviors } = await admitReady()
    failedPrClaim(database, 'review-new-prs', `${pr.repo}#${pr.number}:tertiary`, 'e'.repeat(32))

    await expect(behaviors.admitReplay('pr_review', pr.repo, pr.number)).resolves.toBeUndefined()
  })

  it('admits a pr_approve replay after the head approval was dismissed', async () => {
    arrangeCli(false, false, {
      reviewerLatestState: 'DISMISSED',
      reviewerLatestCommit: HEAD_SHA,
      reviewerReviewsSinceItems: [{ id: 91, state: 'DISMISSED', commit: HEAD_SHA }],
    })
    const { behaviors } = await admitReady()

    await expect(behaviors.admitReplay('pr_approve', pr.repo, pr.number)).resolves.toBeUndefined()
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

    await expect(behaviors.admitReplay('pr_approve', pr.repo, pr.number)).resolves.toBeUndefined()
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
