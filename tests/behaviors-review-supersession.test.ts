import { describe, expect, it, vi } from 'vitest'
import { agentLog, arrangeCli, fixture, HEAD_SHA, loadModules, mocks, pr, recordCompletedInitialReview, resetLogCache, restartModules } from './behaviors-runtime-fixture'

const model = 'gpt-6-astra-ultra'
const mismatch = 'material review basis changed; saved analysis and repair verifications are invalid'
const yieldedMessage = 'completed the scheduled review units; continue the saved checkpoint'
const ownership = { version: 1, roots: [], errors: [] }
const times = {
  firstStarted: '2026-11-20T10:42:00Z',
  firstEnded: '2026-11-20T10:48:09Z',
  resumeStarted: '2026-11-20T10:49:00Z',
  resumeEnded: '2026-11-20T10:49:12Z',
}

async function interruptReview(behavior: 'review-new-prs' | 'approve-prs' = 'review-new-prs') {
  vi.stubEnv('POISE_NATIVE_CONTROL', 'fixture')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(times.firstStarted))
  arrangeCli(behavior === 'approve-prs', false, { headSha: HEAD_SHA, reviewerReviewIdsSince: [] })
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database, behaviors } = await loadModules()
  database.setMeta('me', pr.author)
  database.setMeta('models', JSON.stringify({ slots: { primary: model, secondary: 'muse-spark-1.3-contributor-max' },
    places: { pr_review: { slot: 'primary' }, pr_approve: { slot: 'primary' } } }))
  database.setMeta('behavior_review_new_prs_keyver', '3')
  database.setMeta('behavior_' + behavior.replace(/-/g, '_') + '_enabled', '1')
  database.recordSeen('review-new-prs', '__snapshot_v3__')
  if (behavior === 'approve-prs') {
    recordCompletedInitialReview(database, { pull: pr, headSha: 'b'.repeat(40), outcome: 'changes_requested', response: false })
  }
  await behaviors.runEnabledBehaviorsOnce()
  const original = database.listBehaviorLaunchClaims(behavior)[0]
  expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
  const root = 'a'.repeat(32)
  const link = { root_call: root, generation: 7, basis: '7'.repeat(64), slot: original.launchReviewSlot }
  const checkpoint = { root_call: root, generation: link.generation, basis: link.basis, unit: 6, required_units: 8,
    attempts: 6, spent_ms: 369_000, allowance_ms: 2_826_000, last_progress_at: Date.parse(times.firstEnded), progress_call: root }
  const yielded = agentLog({ id: root, model, repo: pr.repo, pr_id: String(pr.number),
    expected_head: HEAD_SHA, actor: original.launchActor, source: original.launchSource,
    correlation_id: original.launchCorrelationId, behavior: original.launchBehavior, status: 'failed',
    action: 'not_started', outcome: 'incomplete', error_code: 'review_continuation_required', error: yieldedMessage,
    started_at: times.firstStarted, started_at_precise: times.firstStarted, completed_at: times.firstEnded,
    resources_settled_at: times.firstEnded, resource_ownership: ownership,
    artifact: { phase: 'reviewing', review_resume: link, review_checkpoint: checkpoint } })
  fixture.agentLogs.push(yielded)
  vi.setSystemTime(new Date(times.resumeStarted))
  await resetLogCache()
  await behaviors.runEnabledBehaviorsOnce()
  expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
  expect(mocks.spawnDetached.mock.lastCall![1]).toContain(root + ':7')
  const resumed = database.listBehaviorLaunchClaims(behavior)[0]
  const rejection = {
    ...yielded, id: 'b'.repeat(32), correlation_id: resumed.launchCorrelationId,
    started_at: resumed.launchRequestedAt, started_at_precise: resumed.launchRequestedAt, completed_at: times.resumeEnded,
    resources_settled_at: times.resumeEnded, error_code: 'review_continuation_held', error: mismatch,
    diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review',
      phase: 'verification', outcome: 'held', submission: 'none' },
    // Caller rejects the incompatible basis before setting review_resume.
    artifact: { phase: 'reviewing' },
  }
  return { database, behaviors, yielded, rejection, resumed, link, checkpoint }
}

describe('verified replacement of a stale continuation', () => {
  it('restarts an already held review on the same commit and only then admits approval', async () => {
    const { behaviors, database, rejection, resumed } = await interruptReview()
    try {
      const waitingForCleanup = { ...rejection, resources_settled_at: null }
      fixture.agentLogs.push(waitingForCleanup)
      vi.setSystemTime(new Date(times.resumeEnded))
      await resetLogCache()
      await behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)

      fixture.agentLogs[1] = rejection
      database.recordBehaviorDeadLetter(resumed, rejection.error, rejection.id)
      database.setBehaviorLaunchErrorOwned(resumed.key, resumed.target, resumed.claimId, rejection.error)
      expect(database.completeSeenOwned(resumed.key, resumed.target, resumed.claimId)).toBe(true)
      expect(database.getFailedBehaviorLaunch(resumed.key, resumed.target)?.launchCallId).toEqual(rejection.id)
      const restarted = await restartModules()
      await Promise.all([restarted.behaviors.runEnabledBehaviorsOnce(), restarted.behaviors.runEnabledBehaviorsOnce()])
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
      const fresh = mocks.spawnDetached.mock.lastCall![1] as string[]
      expect(fresh).toContain('--pr-review')
      expect(fresh).toContain(HEAD_SHA)
      expect(fresh).not.toContain('--resume-review')
      expect(restarted.database.listBehaviorLaunchClaims('review-new-prs')[0].launchCorrelationId)
        .not.toEqual(resumed.launchCorrelationId)
      expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({
        callId: rejection.id, state: 'superseded', activity: 'settled',
      }))
      await restarted.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)

      restarted.database.setMeta('behavior_approve_prs_enabled', '1')
      await restarted.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
      const replacement = restarted.database.listBehaviorLaunchClaims('review-new-prs')[0]
      vi.setSystemTime(Date.now() + 1_000)
      fixture.agentLogs.push(agentLog({ id: 'c'.repeat(32), model, repo: pr.repo,
        pr_id: String(pr.number), expected_head: HEAD_SHA, actor: replacement.launchActor,
        source: replacement.launchSource, correlation_id: replacement.launchCorrelationId, status: 'completed',
        action: 'reviewed_clean', outcome: 'clean', started_at: replacement.launchRequestedAt,
        started_at_precise: replacement.launchRequestedAt, completed_at: new Date().toISOString(),
        head_sha: HEAD_SHA, resources_settled_at: new Date().toISOString(), resource_ownership: ownership }))
      arrangeCli(false, false, { headSha: HEAD_SHA, requestedReviewers: [replacement.launchActor], reviewerReviewIdsSince: [91] })
      await resetLogCache()
      await restarted.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(4)
      expect(mocks.spawnDetached.mock.lastCall![1]).toContain('--pr-approve')
    } finally { vi.unstubAllEnvs() }
  })

  it.each(['closed', 'draft'])('does not relaunch when the PR is %s', async (state) => {
    const { rejection } = await interruptReview()
    try {
      fixture.agentLogs.push(rejection)
      vi.setSystemTime(new Date(times.resumeEnded))
      if (state === 'closed') {
        fixture.listedPrs = []
        fixture.closedPrs = [{ ...pr, status: 'closed' }]
      } else {
        fixture.listedPrs = [{ ...pr, draft: 1 }]
      }
      const { behaviors } = await restartModules()
      await behaviors.runEnabledBehaviorsOnce()
      await behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllEnvs() }
  })

  it('resumes work saved after the first edit, then restarts once after a second edit', async () => {
    const { rejection, yielded, link, checkpoint } = await interruptReview()
    try {
      fixture.agentLogs.push(rejection)
      vi.setSystemTime(new Date(times.resumeEnded))
      const recovered = await restartModules()
      await recovered.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
      expect(mocks.spawnDetached.mock.lastCall![1]).not.toContain('--resume-review')

      const fresh = recovered.database.listBehaviorLaunchClaims('review-new-prs')[0]
      const nextRoot = 'd'.repeat(32)
      const nextLink = { ...link, root_call: nextRoot, basis: '8'.repeat(64) }
      vi.setSystemTime(Date.now() + 30_000)
      const now = new Date().toISOString()
      fixture.agentLogs.push({ ...yielded, id: nextRoot, correlation_id: fresh.launchCorrelationId,
        started_at: fresh.launchRequestedAt, started_at_precise: fresh.launchRequestedAt, completed_at: now,
        resources_settled_at: now, artifact: { phase: 'reviewing', review_resume: nextLink,
          review_checkpoint: { ...checkpoint, root_call: nextRoot, basis: nextLink.basis, progress_call: nextRoot, last_progress_at: Date.now() } } })
      await resetLogCache()
      await recovered.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(4)
      expect(mocks.spawnDetached.mock.lastCall![1]).toContain(nextRoot + ':7')

      const resumed = recovered.database.listBehaviorLaunchClaims('review-new-prs')[0]
      vi.setSystemTime(Date.now() + 1_000)
      const ended = new Date().toISOString()
      fixture.agentLogs.push({ ...rejection, id: 'e'.repeat(32), correlation_id: resumed.launchCorrelationId,
        started_at: resumed.launchRequestedAt, started_at_precise: resumed.launchRequestedAt, completed_at: ended,
        resources_settled_at: ended })
      const restarted = await restartModules()
      await restarted.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(5)
      expect(mocks.spawnDetached.mock.lastCall![1]).not.toContain('--resume-review')
      await restarted.behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(5)
    } finally { vi.unstubAllEnvs() }
  })

  it.each([
    ['missing resource release', { resources_settled_at: null }],
    ['missing ownership evidence', { resource_ownership: null }],
    ['different failure reason', { error: 'review continuation checkpoint is missing' }],
    ['changed finalization identity', { error: 'material review basis changed; original finalization identity differs' }],
    ['lost publication acknowledgement', { action: null, artifact: { phase: 'submitting_review' } }],
    ['retained published review', { review_id: 91 }],
    ['retained review response', { artifact: { phase: 'reviewing', review_response: {} } }],
    ['suspicious alternate writer', { actor: 'different-reviewer' }],
    ['unknown diagnostic', { diagnostic: null }],
    ['uncertain publication diagnostic', { diagnostic: { version: 1, source: 'caller', severity: 'error',
      operation: 'provider.review', phase: 'analysis', outcome: 'held', submission: 'uncertain' } }],
  ])('keeps %s fenced after restart', async (_name, overrides) => {
    const { rejection } = await interruptReview()
    try {
      fixture.agentLogs.push({ ...rejection, ...overrides })
      vi.setSystemTime(new Date(times.resumeEnded))
      const { behaviors } = await restartModules()
      await behaviors.runEnabledBehaviorsOnce()
      await behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
      expect(mocks.captureOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ callId: rejection.id, state: 'superseded' }))
    } finally { vi.unstubAllEnvs() }
  })

  it('keeps the approval stage on its normal admission path when its own inputs change', async () => {
    const { rejection } = await interruptReview('approve-prs')
    try {
      fixture.agentLogs.push(rejection)
      vi.setSystemTime(new Date(times.resumeEnded))
      const { behaviors } = await restartModules()
      await behaviors.runEnabledBehaviorsOnce()
      expect(mocks.spawnDetached).toHaveBeenCalledTimes(3)
      expect(mocks.spawnDetached.mock.lastCall![1]).toContain('--pr-approve')
      expect(mocks.spawnDetached.mock.lastCall![1]).not.toContain('--resume-review')
    } finally { vi.unstubAllEnvs() }
  })
})
