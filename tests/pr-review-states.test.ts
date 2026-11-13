import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

// behavior_seen keeps every review and approval launch ever made; a status
// read asks only for the pull requests it reports.
let root = ''
let database: typeof import('../server/db')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-pr-review-states-'))
  process.env.POISE_DB = join(root, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
})

afterAll(async () => {
  if (database?.db.open) database.closeDatabase()
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

it('lists review launches of the given pull requests only, and all of them without a list', () => {
  const head = 'a'.repeat(40)
  for (const [key, pr] of [['review-new-prs', 1], ['review-new-prs', 2], ['approve-prs', 2], ['review-new-prs', 3]] as const) {
    const target = `acme/repo#${pr}`
    const claimId = database.claimSeenOwned(key, target)!
    database.markBehaviorLaunchIntentOwned({ key, target, claimId, launchBehavior: key === 'approve-prs' ? 'pr_approve' : 'pr_review',
      repo: 'acme/repo', pr, requestedAt: new Date().toISOString(), expectedHead: head,
      actor: 'review-bot', source: `poise:${key}`, correlationId: claimId })
  }
  const pairs = (states: ReturnType<typeof database.listPrReviewStates>) => states.map((state) => `${state.key}:${state.pr}`).sort()
  expect(pairs(database.listPrReviewStates())).toEqual(['approve-prs:2', 'review-new-prs:1', 'review-new-prs:2', 'review-new-prs:3'])
  expect(pairs(database.listPrReviewStates([2, 2]))).toEqual(['approve-prs:2', 'review-new-prs:2'])
  expect(pairs(database.listPrReviewStates([3, 9]))).toEqual(['review-new-prs:3'])
  expect(database.listPrReviewStates([])).toEqual([])
})
