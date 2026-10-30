import { describe, expect, it } from 'vitest'
import { advanceWork } from '../server/work-rehearsal'
import { HEAD, NOW, pull } from './fixtures/work-rehearsal'
import { arrangeCli, loadModules, mocks, pr } from './behaviors-runtime-fixture'

describe('same recorded observations through v1 and v2', () => {
  it.each([1, 2, 3])('retains the existing %s-slot review panel, exact head and native action', async reviewers => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database, behaviors } = await loadModules()
    database.setMeta('me', 'poise-user')
    database.setMeta('behavior_review_new_prs_keyver', '3')
    database.setMeta('behavior_review_new_prs_enabled', '1')
    database.setMeta('behavior_review_new_prs_reviewers', String(reviewers))
    database.recordSeen('review-new-prs', '__snapshot_v3__')
    const observation = pull({ review: 'needed', reviewedHead: null, approvedHead: null })
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(reviewers)
    for (const [, args] of mocks.spawnDetached.mock.calls) {
      expect(args).toEqual(expect.arrayContaining(['--pr-review', `#${pr.number}`, '--expected-head', HEAD]))
    }
    const calls = mocks.runFile.mock.calls.length
    expect(advanceWork(observation, null, NOW)).toMatchObject({ kind: 'propose', action: 'review-pr', head: HEAD })
    expect(mocks.runFile).toHaveBeenCalledTimes(calls)
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(reviewers)
    // The existing launch/claim machinery still suppresses duplicate triggers.
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(reviewers)
  })

  it('reuses the existing admission refusal instead of inventing another policy', async () => {
    arrangeCli(false)
    const { database, behaviors } = await loadModules()
    database.setMeta('me', 'poise-user')
    database.setMeta('behavior_review_new_prs_skip_repos', JSON.stringify([pr.repo]))
    const refusal = behaviors.pullRequestRefusal(behaviors.pullRequestPolicy('review-new-prs'), pr.repo, pr.number,
      { ...pr, draft: false })
    expect(refusal).toContain('Skip repositories')
    expect(advanceWork({ ...pull(), refusal }, null, NOW)).toEqual({ kind: 'wait', reason: refusal })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('records the deliberate CI-before-review ordering difference', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database, behaviors } = await loadModules()
    database.setMeta('me', 'poise-user')
    database.setMeta('behavior_review_new_prs_keyver', '3')
    database.setMeta('behavior_review_new_prs_enabled', '1')
    database.recordSeen('review-new-prs', '__snapshot_v3__')
    // v1's independent new-PR behavior does not consult CI; v2 sequences it.
    const observation = pull({ ci: { head: HEAD, pending: true, failing: [] }, review: 'needed', reviewedHead: null })
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(advanceWork(observation, null, NOW)).toEqual({ kind: 'wait', reason: 'CI is running' })
    expect(advanceWork(pull({ review: 'needed', reviewedHead: null }), null, NOW))
      .toMatchObject({ kind: 'propose', action: 'review-pr' })
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })
})
