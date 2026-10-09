import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Behaviors per PR in Analytics count what behaviors actually did: a launch
// written through the same calls the runtime uses counts once its agent
// reported a typed result, and not before, nor after it failed.

let root = ''
let database: typeof import('../server/db')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-analytics-ledger-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  database = await import('../server/db')
})

afterAll(async () => {
  database.closeDatabase()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function launch(key: string, behavior: 'pr_review' | 'pr_approve' | 'issue_review', repo: string, pr: number, head: string): { target: string, claimId: string } {
  const target = behavior === 'issue_review' ? `${repo}#${pr}` : `${repo}#${pr}@${head}`
  const claimId = database.claimSeenOwned(key, target)!
  expect(database.markBehaviorLaunchIntentOwned({
    key, target, claimId, launchBehavior: behavior, repo, pr,
    requestedAt: '2026-10-09T10:00:00.000Z', expectedHead: behavior === 'issue_review' ? '' : head,
    actor: 'robot', source: `poise:${key}`, correlationId: claimId,
  })).toBe(true)
  return { target, claimId }
}

describe('completed behavior actions', () => {
  it('lists the reviews and approvals whose agent reported a result, and nothing else', () => {
    const clean = launch('review-new-prs', 'pr_review', 'acme/app', 1, 'a'.repeat(40))
    expect(database.completeReviewLaunchOwned({
      key: 'review-new-prs', ...clean, outcome: 'clean', completedAt: '2026-10-09T10:10:00.000Z', headSha: 'a'.repeat(40),
    })).toBe(true)
    const changes = launch('review-new-prs', 'pr_review', 'acme/app', 1, 'b'.repeat(40))
    expect(database.completeReviewLaunchOwned({
      key: 'review-new-prs', ...changes, outcome: 'changes_requested', completedAt: '2026-10-09T10:20:00.000Z', headSha: 'b'.repeat(40),
    })).toBe(true)
    const approval = launch('approve-prs', 'pr_approve', 'acme/app', 1, 'c'.repeat(40))
    expect(database.completeBehaviorLaunchOwned({
      key: 'approve-prs', ...approval, action: 'approved', outcome: 'approved', completedAt: '2026-10-09T10:30:00.000Z', headSha: 'c'.repeat(40),
    })).toBe(true)

    // Still running.
    launch('review-new-prs', 'pr_review', 'acme/app', 2, 'd'.repeat(40))
    // Failed before doing anything.
    const failed = launch('review-new-prs', 'pr_review', 'acme/app', 3, 'e'.repeat(40))
    expect(database.setBehaviorLaunchErrorOwned('review-new-prs', failed.target, failed.claimId, 'worker exited 1')).toBe(true)
    // An issue review comments on an issue, not on a pull request.
    const issueReview = launch('review-new-issues', 'issue_review', 'acme/app', 4, '')
    expect(database.completeIssueReviewLaunchOwned({
      key: 'review-new-issues', ...issueReview, completedAt: '2026-10-09T10:40:00.000Z',
    })).toBe(true)

    expect(database.listCompletedBehaviorActions().sort((a, b) => a.completedAt.localeCompare(b.completedAt))).toEqual([
      { repo: 'acme/app', pr: 1, action: 'reviewed_clean', completedAt: '2026-10-09T10:10:00.000Z' },
      { repo: 'acme/app', pr: 1, action: 'requested_changes', completedAt: '2026-10-09T10:20:00.000Z' },
      { repo: 'acme/app', pr: 1, action: 'approved', completedAt: '2026-10-09T10:30:00.000Z' },
    ])
  })
})
