import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, loadModules, arrangeCli, fixture } from './behaviors-runtime-fixture'

// Closed-target reconciliation reads each behavior's failures once per pass and
// resolves cleared alerts once per pass, however many targets turn out closed:
// each alert check reads every standing incident.
const notices = vi.hoisted(() => ({ retire: vi.fn() }))
vi.mock('../server/alerts/notices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/alerts/notices')>()
  notices.retire.mockImplementation(actual.retireClearedBehaviorAlerts)
  return { ...actual, retireClearedBehaviorAlerts: notices.retire }
})

describe('closed-target reconciliation', () => {
  it('retires every closed target and its alert with one alert check for the pass', async () => {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    const { behaviorHeld } = await import('../server/alerts/producers')
    fixture.listedPrs = []
    const numbers = [31, 32, 33]
    fixture.closedPrs = numbers.map((number) => ({ ...pr, number, url: `https://github.com/${pr.repo}/pull/${number}`, status: 'merged' }))
    const failure = JSON.stringify({ kind: 'operation', error: 'original failure', consecutiveFailures: 1,
      lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 60_000 })
    for (const number of numbers) {
      const target = `${pr.repo}#${number}`
      const claimId = db.claimSeenOwned('review-new-prs', target)!
      db.markBehaviorLaunchIntentOwned({ key: 'review-new-prs', target, claimId, launchBehavior: 'pr_review',
        repo: pr.repo, pr: number, requestedAt: new Date().toISOString(), expectedHead: HEAD_SHA,
        actor: 'review-bot', source: 'poise:review-new-prs', correlationId: claimId })
      db.recordBehaviorDeadLetter(db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.target === target)!, 'held')
      behaviorHeld('review-new-prs', target, false, 'held')
      db.setMeta(`behavior_approve_prs_failure:${target}:check`, failure)
    }
    const openAlerts = () => db.db.prepare("SELECT count(*) FROM alerts WHERE kind = 'behavior_held' AND resolved_at IS NULL").pluck().get()
    expect(openAlerts()).toBe(3)
    notices.retire.mockClear()

    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(db.db.prepare('SELECT count(*) FROM behavior_dead_letters WHERE retired_at IS NULL').pluck().get()).toBe(0)
    for (const number of numbers) expect(db.getMeta(`behavior_approve_prs_failure:${pr.repo}#${number}:check`)).toBe('')
    expect(openAlerts()).toBe(0)
    expect(notices.retire).toHaveBeenCalledTimes(1)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })
})
