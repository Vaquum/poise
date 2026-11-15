import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBehaviorLedgerArguments, runBehaviorLedgerCli } from '../server/behavior-ledger-cli'
import { computePrBlocker, parsePrStatusRead, type BlockerInput } from '../server/behavior-pr-status'
import { REVIEW_BUDGET_STOPPED } from '../server/behavior-diagnostics'
import { HEAD_SHA, NEXT_HEAD_SHA, agentLog, arrangeCli, fixture, loadModules, mocks, pr, recordCompletedInitialReview } from './behaviors-runtime-fixture'
import { prGroup } from '../src/ui/places/overview/entries'

const HEAD = HEAD_SHA
const NEXT = NEXT_HEAD_SHA
const SHORT = HEAD.slice(0, 8)

function baseInput(overrides: Partial<BlockerInput> = {}): BlockerInput {
  return {
    refusal: null,
    held: [],
    liveClaim: null,
    verdict: { action: 'approved', outcome: 'approved', head: HEAD, completedAt: '2026-10-29T10:00:00Z', key: 'approve-prs', quarantine: null },
    onCurrentHead: true,
    roundsCompleted: 3,
    roundsCap: 5,
    currentHead: HEAD,
    rollupState: 'SUCCESS',
    reviewDecision: 'APPROVED',
    mergeState: 'CLEAN',
    unresolvedThreads: 0,
    threadsComplete: true,
    queueEnabled: true,
    queue: { state: 'not_queued', since: null, entryId: null },
    ejectedUnrecorded: false,
    mergePrsEnabled: true,
    mergePrsPaused: false,
    mergeRetryAt: null,
    greyPending: false,
    evidenceFresh: true,
    evidenceWhy: null,
    ...overrides,
  }
}

// Answer here reads who moves a pull request next from the blocker this
// computes (src/ui/places/overview/entries.ts): these are its exact lines.
describe('who moves a pull request next, as Answer here reads the blocker', () => {
  const group = (input: Partial<BlockerInput>) => {
    const computed = computePrBlocker(baseInput(input))
    return prGroup({ repository: 'acme/site', number: 1, blocker: { id: computed.id, line: computed.line, since: '', sinceRestart: false, details: [] } })
  }
  it('keeps operational PR blockers in status or faults', () => {
    expect(group({ queue: { state: 'queued', since: null, entryId: 'e1' } })).toBe('auto')
    expect(group({ liveClaim: { key: 'review-new-prs', expectedHead: HEAD, others: [] } })).toBe('auto')
    expect(group({ verdict: null, onCurrentHead: null })).toBe('auto')
    expect(group({ verdict: null, onCurrentHead: null, roundsCompleted: 5 })).toBe('fault')
    expect(group({ rollupState: 'FAILURE', greyPending: true })).toBe('auto')
    expect(group({ rollupState: 'FAILURE' })).toBe('fault')
    expect(group({ mergeState: 'BEHIND' })).toBe('auto')
    expect(group({ mergeState: 'DIRTY' })).toBe('fault')
    expect(group({})).toBe('auto')
    expect(group({ mergePrsEnabled: false })).toBe('fault')
    expect(group({ mergePrsPaused: true })).toBe('fault')
    expect(group({ refusal: 'outside your configured GitHub account pair' })).toBe('fault')
    expect(group({ held: [{ behavior: 'merge-prs', code: 'merge_failed', since: '2026-10-29T10:00:00Z' }] })).toBe('fault')
  })
})

describe('computePrBlocker', () => {
  it('reports refusal verbatim as not_eligible', () => {
    const refusal = 'Vaquum/poise-test#17 is a draft'
    const computed = computePrBlocker(baseInput({ refusal }))
    expect(computed.id).toBe('not_eligible')
    expect(computed.line).toBe(refusal)
    expect(computed.key).toContain('draft')
  })

  it('prefers the strongest hold and keeps the others in details', () => {
    const computed = computePrBlocker(baseInput({
      held: [
        { behavior: 'approve-prs', code: 'rate_limit', detail: 'GitHub rate limit', since: '2026-10-29T15:54:00Z', nextRetryAt: '2026-10-29T16:02:00Z' },
        { behavior: 'review-new-prs', code: 'held_result', detail: 'Pending publication', since: '2026-10-29T15:50:00Z' },
      ],
      liveClaim: { key: 'approve-prs', expectedHead: HEAD, others: [] },
    }))
    expect(computed.id).toBe('held')
    expect(computed.line).toBe('held: approve-prs rate_limit since 15:54Z, retry 16:02Z')
    expect(computed.details).toContain(`review running: approve-prs on ${SHORT}`)
    expect(computed.details).toContain('approve-prs: GitHub rate limit')
    expect(computed.details).toContain('also held: review-new-prs held_result since 15:50Z: Pending publication')
  })

  it('shows a live claim with its head', () => {
    const computed = computePrBlocker(baseInput({
      liveClaim: { key: 'approve-prs', expectedHead: HEAD, others: ['review-new-prs on 12345678'] },
    }))
    expect(computed.id).toBe('review_running')
    expect(computed.line).toBe(`review running: approve-prs on ${SHORT}`)
    expect(computed.details).toContain('also running: review-new-prs on 12345678')
  })

  it('notes a claim on a stale head', () => {
    const computed = computePrBlocker(baseInput({ liveClaim: { key: 'approve-prs', expectedHead: NEXT, others: [] } }))
    expect(computed.details).toContain(`claim is on ${NEXT.slice(0, 8)}, current head is ${SHORT}`)
  })

  it('keeps a current change request with the author', () => {
    const computed = computePrBlocker(baseInput({
      verdict: { action: 'requested_changes', outcome: 'changes_requested', head: HEAD, completedAt: '2026-10-29T10:00:00Z', key: 'approve-prs', quarantine: null },
      reviewDecision: 'CHANGES_REQUESTED',
    }))
    expect(computed.id).toBe('awaiting_author')
    expect(computed.line).toBe(`changes requested on ${SHORT} need author action`)
  })

  it('treats a foreign change request as author action', () => {
    const computed = computePrBlocker(baseInput({
      verdict: null, onCurrentHead: null, reviewDecision: 'CHANGES_REQUESTED',
    }))
    expect(computed.id).toBe('awaiting_author')
    expect(computed.details).toContain('requested outside the latest Poise verdict')
  })

  it('marks author action unverified without head evidence', () => {
    const computed = computePrBlocker(baseInput({
      verdict: { action: 'requested_changes', outcome: 'changes_requested', head: HEAD, completedAt: '2026-10-29T10:00:00Z', key: 'approve-prs', quarantine: null },
      onCurrentHead: null, currentHead: null, evidenceFresh: false, evidenceWhy: 'merge-prs paused',
      rollupState: null, reviewDecision: null, mergeState: null, unresolvedThreads: null, threadsComplete: null,
      queueEnabled: null, queue: { state: 'unknown', since: null, entryId: null },
    }))
    expect(computed.id).toBe('awaiting_author')
    expect(computed.details).toContain('current head unverified')
  })

  it('waits for review with rounds against the cap', () => {
    const computed = computePrBlocker(baseInput({ verdict: null, onCurrentHead: null, reviewDecision: 'REVIEW_REQUIRED' }))
    expect(computed.id).toBe('awaiting_review')
    expect(computed.line).toBe(`awaiting review of ${SHORT} · cap 3/5`)
    expect(computed.details).toContain('review decision: REVIEW_REQUIRED')
  })

  it('ignores a null review decision on bases requiring no reviews', () => {
    const computed = computePrBlocker(baseInput({ reviewDecision: null }))
    expect(computed.id).toBe('approved_not_enqueued')
    expect(computed.details).not.toContain('review decision: null')
  })

  it('names a reached cap and an off cap', () => {
    const reached = computePrBlocker(baseInput({ verdict: null, onCurrentHead: null, roundsCompleted: 5 }))
    expect(reached.line).toBe(`awaiting review of ${SHORT} · cap 5/5 · cap reached`)
    const off = computePrBlocker(baseInput({ verdict: null, onCurrentHead: null, roundsCap: null }))
    expect(off.line).toBe(`awaiting review of ${SHORT} · cap off`)
  })

  it('distinguishes a stale verdict from a missing one', () => {
    const computed = computePrBlocker(baseInput({
      verdict: { action: 'approved', outcome: 'approved', head: NEXT, completedAt: '2026-10-29T09:00:00Z', key: 'approve-prs', quarantine: null },
      onCurrentHead: false,
    }))
    expect(computed.id).toBe('awaiting_review')
    expect(computed.details).toContain(`last verdict on ${NEXT.slice(0, 8)}`)
  })

  it('short-circuits queued past head-CI churn', () => {
    const computed = computePrBlocker(baseInput({
      rollupState: 'FAILURE',
      queue: { state: 'queued', since: '2026-10-29T15:54:00Z', entryId: 'MQE_1' },
    }))
    expect(computed.id).toBe('in_queue')
    expect(computed.line).toBe('in merge queue since 15:54Z')
  })

  it('keeps a retained ejection visible', () => {
    const recorded = computePrBlocker(baseInput({
      queue: { state: 'ejected', since: '2026-10-29T15:54:00Z', entryId: null },
    }))
    expect(recorded.id).toBe('approved_not_enqueued')
    expect(recorded.line).toBe('approved, not enqueued: removed from merge queue (observed 15:54Z)')
    const unrecorded = computePrBlocker(baseInput({
      queue: { state: 'ejected', since: null, entryId: null }, ejectedUnrecorded: true,
    }))
    expect(unrecorded.line).toBe('approved, not enqueued: queue entry gone, cause unrecorded')
  })

  it('reads CI from the rollup with the queue-path distinction', () => {
    const failing = computePrBlocker(baseInput({ rollupState: 'FAILURE', greyPending: true }))
    expect(failing.id).toBe('ci_failing')
    expect(failing.line).toBe(`CI failing on ${SHORT} · grey rerun pending`)
    const pending = computePrBlocker(baseInput({ rollupState: 'PENDING' }))
    expect(pending.id).toBe('ci_pending')
    const missingOnQueue = computePrBlocker(baseInput({ rollupState: null }))
    expect(missingOnQueue.id).toBe('ci_pending')
    const missingOffQueue = computePrBlocker(baseInput({ rollupState: null, queueEnabled: false }))
    expect(missingOffQueue.id).toBe('approved_not_enqueued')
  })

  it('counts open conversations and names merge states', () => {
    const threads = computePrBlocker(baseInput({ unresolvedThreads: 2 }))
    expect(threads.id).toBe('unresolved_threads')
    expect(threads.line).toBe(`2 unresolved conversations on ${SHORT}`)
    const single = computePrBlocker(baseInput({ unresolvedThreads: 1 }))
    expect(single.line).toBe(`1 unresolved conversation on ${SHORT}`)
    expect(computePrBlocker(baseInput({ mergeState: 'DIRTY' })).id).toBe('conflicting')
    expect(computePrBlocker(baseInput({ mergeState: 'BEHIND' })).id).toBe('behind')
    expect(computePrBlocker(baseInput({ mergeState: 'BLOCKED' })).id).toBe('blocked')
    const unknownState = computePrBlocker(baseInput({ mergeState: 'UNKNOWN' }))
    expect(unknownState.id).toBe('unknown')
    expect(unknownState.line).toBe('unknown: merge state unavailable')
  })

  it('explains approved but not enqueued', () => {
    expect(computePrBlocker(baseInput()).line).toBe('approved, not enqueued: waiting for merge-prs scan')
    expect(computePrBlocker(baseInput({ mergePrsEnabled: false })).line).toBe('approved, not enqueued: merge-prs disabled')
    expect(computePrBlocker(baseInput({ mergePrsPaused: true })).line).toBe('approved, not enqueued: merge-prs paused')
    const retry = computePrBlocker(baseInput({ mergeRetryAt: '2026-10-29T16:02:00Z' }))
    expect(retry.line).toBe('approved, not enqueued: merge retry at 16:02Z')
  })

  it('names stale evidence instead of guessing', () => {
    const computed = computePrBlocker(baseInput({
      currentHead: null, onCurrentHead: null, evidenceFresh: false, evidenceWhy: 'merge-prs paused',
      rollupState: null, reviewDecision: null, mergeState: null, unresolvedThreads: null, threadsComplete: null,
      queueEnabled: null, queue: { state: 'unknown', since: null, entryId: null },
      verdict: { action: 'approved', outcome: 'approved', head: HEAD, completedAt: '2026-10-29T10:00:00Z', key: 'approve-prs', quarantine: null },
    }))
    // An approval without verifiable currency never reads as current.
    expect(computed.id).toBe('awaiting_review')
    const noVerdict = computePrBlocker(baseInput({
      verdict: null, onCurrentHead: null, currentHead: null, evidenceFresh: false, evidenceWhy: 'merge-prs disabled',
      rollupState: null, reviewDecision: null, mergeState: null, unresolvedThreads: null, threadsComplete: null,
      queueEnabled: null, queue: { state: 'unknown', since: null, entryId: null },
    }))
    expect(noVerdict.id).toBe('awaiting_review')
  })

  it('truncates long lines', () => {
    const refusal = `${'x'.repeat(200)} is a draft`
    expect(computePrBlocker(baseInput({ refusal })).line.length).toBeLessThanOrEqual(160)
  })
})

function recordApproval(
  db: typeof import('../server/db'),
  options: { target: string, headSha: string, callId: string, completedAt: string },
): void {
  const claimId = db.claimSeenOwned('approve-prs', options.target)
  if (!claimId) throw new Error('could not arrange approval claim')
  const marked = db.markBehaviorLaunchIntentOwned({
    key: 'approve-prs', target: options.target, claimId, launchBehavior: 'pr_approve',
    repo: pr.repo, pr: pr.number, requestedAt: '2026-10-29T09:00:00Z',
    expectedHead: options.headSha, actor: 'review-bot',
    source: 'poise:approve-prs', correlationId: claimId,
  })
  const linked = db.linkBehaviorLaunchCallOwned('approve-prs', options.target, claimId, options.callId)
  const completed = db.completeBehaviorLaunchOwned({
    key: 'approve-prs', target: options.target, claimId,
    action: 'approved', outcome: 'approved',
    completedAt: options.completedAt, headSha: options.headSha,
  })
  if (!marked || !linked || !completed) throw new Error('could not arrange completed approval')
}

describe('readPrStatus', () => {
  async function setup() {
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_merge_prs_enabled', '1')
    arrangeCli()
    const status = await import('../server/behavior-pr-status')
    status.resetPrStatusCaches()
    runtime.resetMergeCandidateCache()
    return { db, runtime, status }
  }

  function seedCache(runtime: typeof import('../server/behaviors'), at: string,
    overrides: Partial<import('../server/behaviors').CachedMergeCandidate> = {}): void {
    runtime.seedMergeCandidateCache(pr.repo, pr.number, {
      head: HEAD, ready: false, behind: false, author: 'poise-user', approvedAt: null,
      queueEntryId: null, rollupState: 'SUCCESS', reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN', unresolvedThreads: 0, threadsComplete: true,
      queueEnabled: true, error: null, at, ...overrides,
    })
  }

  function seedReview(db: typeof import('../server/db'), options: {
    behavior?: 'review-new-prs' | 'approve-prs', target?: string, head?: string,
    callId?: string, failureAt?: string, error?: string,
  } = {}) {
    const { behavior = 'approve-prs', head = NEXT, callId = 'c'.repeat(32), failureAt } = options
    const target = options.target ?? `${pr.repo}#${pr.number}@head=${head}`
    const claimId = db.claimSeenOwned(behavior, target)
    if (!claimId) throw new Error('could not arrange review claim')
    if (!db.markBehaviorLaunchIntentOwned({
      key: behavior, target, claimId, launchBehavior: behavior === 'approve-prs' ? 'pr_approve' : 'pr_review',
      repo: pr.repo, pr: pr.number, requestedAt: failureAt ?? '2026-11-12T15:14:41Z',
      expectedHead: head, actor: 'review-bot', source: `poise:${behavior}`, correlationId: claimId,
    }) || !db.linkBehaviorLaunchCallOwned(behavior, target, claimId, callId)) {
      throw new Error('could not arrange review launch')
    }
    if (failureAt) {
      const launch = db.listBehaviorLaunchClaims(behavior).find((row) => row.claimId === claimId)
      if (!launch) throw new Error('could not find review launch')
      const error = options.error ?? 'review failed: HTTP 503 Service Unavailable'
      const id = db.recordBehaviorDeadLetter(launch, error)
      db.db.prepare('UPDATE behavior_dead_letters SET created_at = ? WHERE id = ?').run(failureAt, id)
      db.setBehaviorLaunchErrorOwned(behavior, target, claimId, error)
      db.completeSeenOwned(behavior, target, claimId)
    }
    return { behavior, target, claimId, callId }
  }

  async function retainTimeout(review: ReturnType<typeof seedReview>, overrides: Record<string, unknown> = {}) {
    fixture.agentLogs = [agentLog({
      id: review.callId, correlation_id: review.claimId, expected_head: HEAD,
      behavior: review.behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
      source: `poise:${review.behavior}`, model: 'grok-4-20', status: 'failed',
      started_at: '2026-11-12T14:00:00Z', started_at_precise: '2026-11-12T14:00:00Z',
      completed_at: '2026-11-12T15:03:00Z', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'review_budget_exhausted', error: 'review failed: no verdict before the budget ran out',
      ...overrides,
    })]
    await (await import('../server/agent')).fetchAgentLogSnapshot()
  }

  it.each([
    ['review-new-prs', ''], ['review-new-prs', ':secondary'], ['review-new-prs', ':tertiary'], ['approve-prs', ''],
  ] as const)('projects the scoped %s %s check retry before, at and after its due time until cleared', async (behavior, slot) => {
    const { db, runtime, status } = await setup()
    db.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('beta', '/datastores/beta.sqlite', 1, 'ready', 'ready', 'poise-user')`).run()
    fixture.listedPrs = [pr, ...[18, 19].map((number) => ({
      ...pr, repo: 'beta/site', number, url: `https://github.com/beta/site/pull/${number}`,
    }))]
    const now = Date.now()
    seedReview(db, { behavior: 'review-new-prs', head: HEAD })
    seedCache(runtime, new Date(now).toISOString())
    const checkTarget = `beta/site#18${slot}:check`
    const failureKey = `behavior_${behavior.replace(/-/g, '_')}_failure:${checkTarget}`
    const retryAt = now + 60_000
    const state = { kind: 'operation', consecutiveFailures: 3,
      lastFailureAtMs: now - 60_000, nextRetryAtMs: retryAt, error: 'review preflight could not read PR state' }
    const failure = JSON.stringify(state)
    db.setMeta(`org:beta:${failureKey}`, failure)
    db.setMeta(failureKey, JSON.stringify({ ...state, error: 'failure in another organization' }))
    mocks.runFile.mockClear()

    for (const [at, timing] of [[now, 'at'], [retryAt, 'due since'], [retryAt + 1, 'due since']] as const) {
      const reply = await status.readPrStatus(50, at)
      expect(reply.rows.find((row) => row.number === 18)?.blocker).toMatchObject({
        id: 'awaiting_review',
        details: [`${behavior} check failed for ${checkTarget}: review preflight could not read PR state; revision unverified; retry ${timing} ${new Date(retryAt).toISOString()}`],
      })
      expect(reply.rows.find((row) => row.number === 19)?.blocker).toMatchObject({ id: 'awaiting_review', details: [] })
      expect(reply.rows.find((row) => row.number === 17)?.blocker).toMatchObject({
        id: 'review_running', line: `review running: review-new-prs on ${SHORT}`, details: [],
      })
    }
    expect(db.getMeta(`org:beta:${failureKey}`)).toBe(failure)
    db.setMeta(`org:beta:${failureKey}`, '')
    const recovered = await status.readPrStatus(50, retryAt + 2)
    expect(recovered.rows.find((row) => row.number === 18)?.blocker.details).toEqual([])
    expect(mocks.runFile.mock.calls.every(([command]) => command === 'github-datastore')).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('shows an approval check failure alongside changes requested and clears it after a successful no-op', async () => {
    const { db, runtime, status } = await setup()
    const now = Date.now()
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: HEAD,
      completedAt: new Date(now - 120_000).toISOString() })
    seedCache(runtime, new Date(now).toISOString(), { reviewDecision: 'CHANGES_REQUESTED' })
    db.setMeta('behavior_approve_prs_enabled', '1')
    const failureKey = `behavior_approve_prs_failure:${pr.repo}#${pr.number}:check`
    db.setMeta(failureKey, JSON.stringify({ kind: 'operation', consecutiveFailures: 1,
      lastFailureAtMs: now - 60_000, nextRetryAtMs: now - 1, error: 'approval preflight failed' }))

    const failed = await status.readPrStatus(50, now)
    expect(failed.rows[0].blocker).toMatchObject({
      id: 'awaiting_author',
      details: [`approve-prs check failed for ${pr.repo}#${pr.number}:check: approval preflight failed; revision unverified; retry due since ${new Date(now - 1).toISOString()}`],
    })
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(db.getMeta(failureKey)).toBe('')
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    const recovered = await status.readPrStatus(50, Date.now())
    expect(recovered.rows[0].blocker).toMatchObject({ id: 'awaiting_author', details: [] })
  })

  it('keeps a secondary check failure ahead of capped history without replacing a live review or explicit hold', async () => {
    const { db, runtime, status } = await setup()
    const target = `${pr.repo}#${pr.number}`
    for (let index = 1; index <= 8; index++) {
      seedReview(db, { target: `${target}@head=${HEAD}/history=${index}`, head: HEAD,
        callId: String(index).repeat(32), failureAt: '2026-11-12T14:40:00Z' })
    }
    seedReview(db, { behavior: 'review-new-prs', head: NEXT })
    seedCache(runtime, '2026-11-12T15:31:00Z', { head: NEXT })
    const now = Date.parse('2026-11-12T15:31:00Z')
    db.setMeta(`behavior_review_new_prs_failure:${target}:secondary:check`, JSON.stringify({
      kind: 'operation', consecutiveFailures: 1, lastFailureAtMs: now - 60_000,
      nextRetryAtMs: now + 60_000, error: 'secondary preflight failed',
    }))
    const detail = `review-new-prs check failed for ${target}:secondary:check: secondary preflight failed; revision unverified; retry at 2026-11-12T15:32:00.000Z`

    const running = await status.readPrStatus(50, now)
    expect(running.rows[0].blocker).toMatchObject({
      id: 'review_running', line: `review running: review-new-prs on ${NEXT.slice(0, 8)}`,
    })
    expect(running.rows[0].blocker.details).toHaveLength(8)
    expect(running.rows[0].blocker.details[0]).toBe(detail)
    expect(running.rows[0].blocker.details.slice(1).every((entry) => entry.startsWith('past review:'))).toBe(true)

    seedReview(db, { head: NEXT, callId: 'f'.repeat(32), failureAt: '2026-11-12T15:30:00Z' })
    const held = await status.readPrStatus(50, now)
    expect(held.rows[0].blocker).toMatchObject({
      id: 'held', line: 'held: approve-prs upstream_unavailable since 15:30Z',
    })
    const heldDetails = held.rows[0].blocker.details
    const runningLine = `review running: review-new-prs on ${NEXT.slice(0, 8)}`
    expect(heldDetails).toContain(runningLine)
    expect(heldDetails).toContain(detail)
    expect(heldDetails.indexOf(runningLine)).toBeLessThan(heldDetails.indexOf(detail))
    expect(heldDetails.indexOf(detail)).toBeLessThan(heldDetails.findIndex((entry) => entry.startsWith('past review:')))
  })

  it.each(['released', 'reused'] as const)('attributes an older timeout from its original Call after its headless launch is %s', async (launch) => {
    const { db, runtime, status } = await setup()
    const target = `${pr.repo}#${pr.number}`
    const old = seedReview(db, { behavior: 'review-new-prs', target, head: HEAD,
      callId: 'a'.repeat(32), failureAt: '2026-11-12T15:03:00Z',
      error: 'review failed: no verdict before the budget ran out' })
    expect(db.releaseFailedBehaviorLaunch(old.behavior, old.target, old.callId, HEAD)).toBe(true)
    seedReview(db, { behavior: 'review-new-prs', target: launch === 'reused' ? target : `${target}@secondary` })
    await retainTimeout(old)
    seedCache(runtime, '2026-11-12T15:31:00Z', { head: NEXT })
    mocks.runFile.mockClear()
    const before = db.db.prepare('SELECT * FROM behavior_dead_letters').all()

    const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

    expect(reply.rows[0].blocker).toMatchObject({
      id: 'review_running', line: `review running: review-new-prs on ${NEXT.slice(0, 8)}`,
      details: [`past review: review-new-prs review_budget_exhausted on ${HEAD} since 2026-11-12T15:03:00Z`],
    })
    expect(db.db.prepare('SELECT * FROM behavior_dead_letters').all()).toEqual(before)
    expect(mocks.runFile.mock.calls.every(([command]) => command === 'github-datastore')).toBe(true)
  })

  it.each([
    ['Call ID', { id: 'b'.repeat(32) }], ['correlation', { correlation_id: 'other' }],
    ['repository', { repo: 'other/repo' }], ['PR', { pr_id: '18' }],
    ['behavior', { behavior: 'pr_approve' }], ['actor', { actor: 'other-bot' }], ['source', { source: 'poise:replay' }],
    ['missing head', { expected_head: null }], ['unreadable row', { expected_head: 'invalid' }],
    ['ambiguous publication', { action: null, outcome: null }], ['review receipt', { review_id: 123 }],
  ] as const)('keeps the hold when the original Caller evidence has a mismatched or uncertain %s', async (_identity, overrides) => {
    const { db, runtime, status } = await setup()
    const old = seedReview(db, { behavior: 'review-new-prs', target: `${pr.repo}#${pr.number}`, head: HEAD,
      callId: 'a'.repeat(32), failureAt: '2026-11-12T15:03:00Z' })
    expect(db.releaseFailedBehaviorLaunch(old.behavior, old.target, old.callId, HEAD)).toBe(true)
    seedReview(db, { behavior: 'review-new-prs', target: old.target })
    await retainTimeout(old, overrides)
    seedCache(runtime, '2026-11-12T15:31:00Z', { head: NEXT })

    const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

    expect(reply.rows[0].blocker.id).toBe('held')
    expect(reply.rows[0].blocker.details).toEqual([expect.stringMatching(/^review-new-prs: /), `review running: review-new-prs on ${NEXT.slice(0, 8)}`])
  })

  it('keeps a released launch held when its previously readable Caller history becomes unreadable', async () => {
    const { db, runtime, status } = await setup()
    const old = seedReview(db, { behavior: 'review-new-prs', target: `${pr.repo}#${pr.number}`, head: HEAD,
      callId: 'a'.repeat(32), failureAt: '2026-11-12T15:03:00Z' })
    expect(db.releaseFailedBehaviorLaunch(old.behavior, old.target, old.callId, HEAD)).toBe(true)
    seedReview(db, { behavior: 'review-new-prs', target: old.target })
    await retainTimeout(old)
    mocks.runFile.mockRejectedValueOnce(new Error('Caller history unavailable'))
    await expect((await import('../server/agent')).fetchAgentLogSnapshot({ fresh: true })).rejects.toThrow('Caller history unavailable')
    seedCache(runtime, '2026-11-12T15:31:00Z', { head: NEXT })

    const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

    expect(reply.rows[0].blocker.id).toBe('held')
    expect(reply.rows[0].blocker.details).toEqual(['review-new-prs: review failed: HTTP 503 Service Unavailable', `review running: review-new-prs on ${NEXT.slice(0, 8)}`])
  })

  it.each(['expired', 'future'] as const)('keeps an interrupted review held without advertising its %s failure timer', async (timer) => {
    const { db, runtime, status } = await setup()
    const now = Date.parse('2026-11-12T15:31:00Z')
    const error = 'review interrupted; publication disposition unknown'
    const old = seedReview(db, { behavior: 'review-new-prs', target: `${pr.repo}#${pr.number}`, head: HEAD,
      callId: 'a'.repeat(32), failureAt: '2026-11-12T15:14:00Z', error })
    const live = seedReview(db, { behavior: 'review-new-prs', head: NEXT })
    const refusalKey = `behavior_review_recovery:${old.behavior}:${old.target}:${old.callId}:${old.claimId}`
    const refusal = `Legacy review retry held for Call ${old.callId} (correlation ${old.claimId}); original head ${HEAD}; observed head ${NEXT}; reviewer review-bot. Unclaimed publication: 1 reviews not attributed to this Call. Observed reviews: 91 APPROVED on ${HEAD}. Observed reviews are not this Call's receipt.`
    db.setMeta(refusalKey, refusal)
    db.setMeta(`behavior_review_new_prs_failure:${old.target}`, JSON.stringify({ kind: 'worker', consecutiveFailures: 1,
      firstFailureAtMs: Date.parse('2026-11-12T15:14:00Z'), lastFailureAtMs: Date.parse('2026-11-12T15:14:00Z'),
      nextRetryAtMs: Date.parse(timer === 'expired' ? '2026-11-12T15:15:00Z' : '2026-11-12T15:32:00Z'),
      error, callId: old.callId, diagnostic: { severity: 'warning', code: 'held_result' } }))
    db.reconcileBehaviorDeadLetters(new Set([`${pr.repo}#${pr.number}`]), undefined, undefined, undefined, 200, now)
    fixture.agentLogs = [
      agentLog({ id: old.callId, correlation_id: old.claimId, status: 'interrupted', expected_head: HEAD,
        started_at: '2026-11-12T15:14:00Z', started_at_precise: '2026-11-12T15:14:00Z',
        completed_at: '2026-11-12T15:14:41Z', error }),
      agentLog({ id: live.callId, correlation_id: live.claimId, expected_head: NEXT,
        started_at: '2026-11-12T15:30:00Z', started_at_precise: '2026-11-12T15:30:00Z' }),
    ]
    const snapshot = await (await import('../server/agent')).fetchAgentLogSnapshot({ fresh: true })
    seedCache(runtime, new Date(now).toISOString(), { head: NEXT })
    mocks.runFile.mockClear()
    const dump = () => ({
      seen: db.db.prepare('SELECT * FROM behavior_seen ORDER BY key, target').all(),
      meta: db.db.prepare('SELECT key, value FROM meta ORDER BY key').all(),
      letters: db.db.prepare('SELECT * FROM behavior_dead_letters ORDER BY id').all(),
      calls: structuredClone(fixture.agentLogs),
    })
    const before = dump()

    for (const evidence of [snapshot, null]) {
      const incident = runtime.getBehaviorDiagnosticIncidents(evidence).find((row) => row.callId === old.callId)!
      expect(incident).toMatchObject({ error: `${error} ${refusal}`, createdAt: '2026-11-12T15:14:00Z',
        resolution: 'held', resolvedAt: new Date(now).toISOString() })
      expect(incident.nextRetryAt).toBeUndefined()
    }
    const reply = await status.readPrStatus(50, now)
    expect(reply.rows[0].blocker).toMatchObject({
      id: 'held', line: 'held: review-new-prs held_result since 15:14Z',
      details: [`review-new-prs: ${error} ${refusal}`, `review running: review-new-prs on ${NEXT.slice(0, 8)}`],
    })
    expect(dump()).toEqual(before)

    // An unprobed interruption also needs publication verification, not a timer.
    db.setMeta(refusalKey, '')
    const unprobed = dump()
    const pending = await status.readPrStatus(50, now)
    expect(pending.rows[0].blocker.line).toBe('held: review-new-prs held_result since 15:14Z')
    expect(pending.rows[0].blocker.details[0]).toBe(`review-new-prs: ${error} Publication disposition unverified for Call ${old.callId}. Inspect the original Call and reconcile publication before retrying.`)
    expect(dump()).toEqual(unprobed)
    expect(mocks.runFile.mock.calls.every(([command]) => command === 'github-datastore')).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('keeps a same-head Grok stop primary and exposes the running Sol fallback', async () => {
    const { db, runtime, status } = await setup()
    const stopped = seedReview(db, { behavior: 'review-new-prs', head: HEAD, callId: 'a'.repeat(32),
      failureAt: '2026-11-12T14:43:00Z', error: REVIEW_BUDGET_STOPPED })
    const fallback = seedReview(db, { behavior: 'review-new-prs', target: `${pr.repo}#${pr.number}@fallback`, head: HEAD })
    await retainTimeout(stopped)
    fixture.agentLogs.push(agentLog({ id: fallback.callId, correlation_id: fallback.claimId,
      expected_head: HEAD, model: 'gpt-6.1-sol-max' }))
    await (await import('../server/agent')).fetchAgentLogSnapshot({ fresh: true })
    seedCache(runtime, '2026-11-12T15:31:00Z')
    db.setMeta(`behavior_review_new_prs_failure:${stopped.target}`, JSON.stringify({ kind: 'worker', consecutiveFailures: 2,
      lastFailureAtMs: Date.parse('2026-11-12T14:43:00Z'), nextRetryAtMs: Date.parse('2026-11-12T15:32:00Z'),
      error: REVIEW_BUDGET_STOPPED, callId: stopped.callId }))
    const before = db.db.prepare('SELECT * FROM behavior_dead_letters').all()

    const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

    expect(reply.rows[0].blocker).toMatchObject({
      id: 'held', line: 'held: review-new-prs review_budget_exhausted since 14:43Z',
      details: [`review-new-prs: ${REVIEW_BUDGET_STOPPED}`, `review running: review-new-prs on ${SHORT}`],
    })
    expect(runtime.getBehaviorDiagnosticIncidents(null).find((row) => row.callId === stopped.callId)?.nextRetryAt).toBeUndefined()
    expect(db.db.prepare('SELECT * FROM behavior_dead_letters').all()).toEqual(before)
  })

  it('shows the current review alongside both retained past-revision failures', async () => {
    const { db, runtime, status } = await setup()
    seedReview(db, { behavior: 'review-new-prs', target: `${pr.repo}#${pr.number}`,
      head: HEAD, callId: 'a'.repeat(32), failureAt: '2026-11-12T14:40:00Z' })
    const old = seedReview(db, { target: `${pr.repo}#${pr.number}@req=2026-11-12T14:40:00Z/r=1/head=${HEAD}:secondary`,
      head: HEAD, callId: 'b'.repeat(32), failureAt: '2026-11-12T15:03:00Z' })
    // The full-SHA target remains evidence even after its launch row is gone.
    db.releaseSeen(old.behavior, old.target)
    seedReview(db)
    seedCache(runtime, '2026-11-12T15:31:00Z', { head: NEXT })

    const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

    expect(reply.rows[0].blocker).toMatchObject({
      id: 'review_running', line: `review running: approve-prs on ${NEXT.slice(0, 8)}`,
      details: [
        `past review: approve-prs upstream_unavailable on ${HEAD} since 2026-11-12T15:03:00Z`,
        `past review: review-new-prs upstream_unavailable on ${HEAD} since 2026-11-12T14:40:00Z`,
      ],
    })
    expect(reply.rows[0].ledger).toBe(`/api/behavior-ledger?repository=${pr.repo}&number=${pr.number}`)
  })

  it('keeps a current-head hold ahead of the live review in a mixed revision history', async () => {
    const { db, runtime, status } = await setup()
    seedReview(db, { head: HEAD, callId: 'a'.repeat(32), failureAt: '2026-11-12T15:03:00Z' })
    seedReview(db, { target: `${pr.repo}#${pr.number}@req=2026-11-12T14:40:00Z/r=1/head=${NEXT}`,
      head: NEXT, callId: 'b'.repeat(32), failureAt: '2026-11-12T14:40:00Z' })
    seedReview(db)
    seedCache(runtime, '2026-11-12T15:31:00Z', { head: NEXT })

    const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

    expect(reply.rows[0].blocker).toMatchObject({
      id: 'held', line: 'held: approve-prs upstream_unavailable since 14:40Z',
      details: [
        'approve-prs: review failed: HTTP 503 Service Unavailable',
        `review running: approve-prs on ${NEXT.slice(0, 8)}`,
        `past review: approve-prs upstream_unavailable on ${HEAD} since 2026-11-12T15:03:00Z`,
      ],
    })
  })

  it.each(['missing', 'short target head', 'conflicting', 'reused target'] as const)(
    'keeps a hold with %s revision identity', async (identity) => {
      const { db, runtime, status } = await setup()
      const target = `${pr.repo}#${pr.number}${identity === 'conflicting' ? `@head=${HEAD}`
        : identity === 'short target head' ? `@head=${HEAD.slice(0, 8)}` : ''}`
      const old = seedReview(db, { target, head: identity === 'conflicting' ? NEXT : HEAD,
        callId: 'a'.repeat(32), failureAt: '2026-11-12T15:03:00Z' })
      if (identity !== 'conflicting') db.releaseSeen(old.behavior, old.target)
      seedReview(db, identity === 'reused target' ? { target } : {})
      seedCache(runtime, '2026-11-12T15:31:00Z', { head: NEXT })

      const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

      expect(reply.rows[0].blocker).toMatchObject({ id: 'held', details: ['approve-prs: review failed: HTTP 503 Service Unavailable', `review running: approve-prs on ${NEXT.slice(0, 8)}`] })
    },
  )

  it.each(['missing', 'stale', 'failed', 'paused', 'disabled', 'headless'] as const)(
    'keeps old holds when the merge cache is %s despite a live current-head claim', async (evidence) => {
      const { db, runtime, status } = await setup()
      seedReview(db, { head: HEAD, callId: 'a'.repeat(32), failureAt: '2026-11-12T15:03:00Z' })
      seedReview(db)
      if (evidence !== 'missing') seedCache(runtime, evidence === 'stale' ? '2026-11-12T14:00:00Z' : '2026-11-12T15:31:00Z',
        { head: evidence === 'headless' ? null : NEXT, error: evidence === 'failed' ? 'GitHub unavailable' : null })
      if (evidence === 'paused') db.setMeta('behavior_merge_prs_paused_until', new Date(Date.now() + 3_600_000).toISOString())
      if (evidence === 'disabled') db.setMeta('behavior_merge_prs_enabled', '0')

      const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

      expect(reply.rows[0].blocker).toMatchObject({ id: 'held', details: ['approve-prs: review failed: HTTP 503 Service Unavailable'] })
    },
  )

  it.each([null, HEAD])('keeps old holds without a live claim matching the current head (%s)', async (head) => {
    const { db, runtime, status } = await setup()
    seedReview(db, { head: HEAD, callId: 'a'.repeat(32), failureAt: '2026-11-12T15:03:00Z' })
    if (head) seedReview(db, { target: `${pr.repo}#${pr.number}@other`, head })
    seedCache(runtime, '2026-11-12T15:31:00Z', { head: NEXT })

    const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

    expect(reply.rows[0].blocker).toMatchObject({ id: 'held', details: ['approve-prs: review failed: HTTP 503 Service Unavailable'] })
  })

  it.each(['invalid_result', 'unreadable'] as const)('preserves PR-wide %s quarantine across head changes', async (quarantine) => {
    const { db, runtime, status } = await setup()
    seedReview(db, { head: HEAD, callId: 'a'.repeat(32), failureAt: '2026-11-12T15:03:00Z' })
    const held = seedReview(db, { behavior: 'review-new-prs', head: HEAD, callId: 'b'.repeat(32) })
    expect(db.quarantineBehaviorLaunchOwned(held.behavior, held.target, held.claimId, quarantine, 'invalid review result', false)).toBe(true)
    db.completeSeenOwned(held.behavior, held.target, held.claimId)
    seedReview(db)
    seedCache(runtime, '2026-11-12T15:31:00Z', { head: NEXT })

    const reply = await status.readPrStatus(50, Date.parse('2026-11-12T15:31:00Z'))

    expect(reply.rows[0].blocker).toMatchObject({ id: 'held', details: ['approve-prs: review failed: HTTP 503 Service Unavailable', `review running: approve-prs on ${NEXT.slice(0, 8)}`] })
  })

  it('projects one approved green row with rounds from the cap counter', async () => {
    const { db, runtime, status } = await setup()
    runtime.setReviewCap(5)
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: HEAD, completedAt: '2026-10-29T09:00:00Z' })
    recordApproval(db, {
      target: `${pr.repo}#${pr.number}@req=2026-10-29T09:00:00Z/r=1/head=${HEAD}`,
      headSha: HEAD, callId: 'e'.repeat(32), completedAt: '2026-10-29T10:00:00Z',
    })
    const now = Date.parse('2026-10-29T10:30:00Z')
    seedCache(runtime, new Date(now).toISOString())
    const reply = await status.readPrStatus(50, now)
    expect(reply.health.status).toBe('ok')
    expect(reply.totalOpen).toBe(1)
    expect(reply.truncated).toBe(false)
    const row = reply.rows[0]
    expect(row.repository).toBe(pr.repo)
    expect(row.rounds.completed).toBe(db.countReviewRounds(pr.repo, pr.number))
    expect(row.rounds).toEqual({ completed: 1, cap: 5, next: 2 })
    expect(row.verdict).toMatchObject({ outcome: 'approved', head: HEAD, onCurrentHead: true })
    expect(row.ci).toMatchObject({ state: 'SUCCESS', head: HEAD.toLowerCase() })
    expect(row.queue.state).toBe('not_queued')
    expect(row.blocker.id).toBe('approved_not_enqueued')
    expect(row.blocker.line).toBe('approved, not enqueued: waiting for merge-prs scan')
    expect(row.flags).toEqual({ age: false, staleBlocker: false })
    expect(row.ledger).toBe(`/api/behavior-ledger?repository=${pr.repo}&number=${pr.number}`)
  })

  it('lists drafts and skipped repos with refusal reasons', async () => {
    const { runtime, status } = await setup()
    fixture.listedPrs = [
      { ...pr, draft: 1 },
      { ...pr, number: 18, url: 'https://github.com/Vaquum/poise-test/pull/18', draft: 0 },
    ]
    for (const behavior of ['review-new-prs', 'approve-prs', 'resolve-unblocking', 'merge-prs', 'rerun-grey-ci', 'close-old-prs'] as const) {
      runtime.setRepositorySkips(behavior, ['Vaquum/poise-test'])
    }
    const reply = await status.readPrStatus(50, Date.now())
    expect(reply.totalOpen).toBe(2)
    expect(reply.rows.map((row) => row.blocker.id)).toEqual(['not_eligible', 'not_eligible'])
    expect(reply.rows[0].blocker.line).toBe(`${pr.repo}#${pr.number} is a draft`)
    expect(reply.rows[1].blocker.line).toContain('Skip repositories list of every PR behavior')
  })

  it('excludes authors outside the pair', async () => {
    const { status } = await setup()
    fixture.listedPrs = [{ ...pr, author: 'stranger' }]
    const reply = await status.readPrStatus(50, Date.now())
    expect(reply.totalOpen).toBe(0)
    expect(reply.rows).toEqual([])
  })

  it('renders an eligible no-action 429 preflight failure with its retry time', async () => {
    const { db, status } = await setup()
    const target = `${pr.repo}#${pr.number}@req=2026-10-29T15:00:00Z/r=2/head=${HEAD}`
    db.db.prepare(`INSERT INTO behavior_dead_letters(id, behavior, target, repo, pr, actor, source, correlation_id, call_id, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('dl-1', 'approve-prs', target, pr.repo, pr.number,
      'review-bot', 'poise:approve-prs', 'c'.repeat(32), 'd'.repeat(32),
      'review failed: GitHub 429 Too Many Requests', '2026-10-29T15:54:00Z')
    db.setMeta(`behavior_approve_prs_failure:${target}`, JSON.stringify({ kind: 'worker', consecutiveFailures: 2,
      lastFailureAtMs: Date.parse('2026-10-29T15:54:00Z'), nextRetryAtMs: Date.parse('2026-10-29T16:02:00Z'),
      error: 'review failed: GitHub 429 Too Many Requests', callId: 'd'.repeat(32),
      diagnostic: { severity: 'warning', code: 'rate_limit' } }))
    fixture.agentLogs = [agentLog({ id: 'd'.repeat(32), behavior: 'pr_approve', correlation_id: 'c'.repeat(32),
      status: 'failed', action: 'not_started', outcome: 'preflight_failed', expected_head: HEAD,
      started_at: '2026-10-29T15:53:00Z', started_at_precise: '2026-10-29T15:53:00Z',
      completed_at: '2026-10-29T15:54:00Z', error: 'review failed: GitHub 429 Too Many Requests' })]
    await (await import('../server/agent')).fetchAgentLogSnapshot({ fresh: true })
    const reply = await status.readPrStatus(50, Date.parse('2026-10-29T16:00:00Z'))
    expect(reply.rows).toHaveLength(1)
    expect(reply.rows[0].blocker.id).toBe('held')
    expect(reply.rows[0].blocker.line).toBe('held: approve-prs rate_limit since 15:54Z, retry 16:02Z')
  })

  it('recovers hold causes from incident text and failure rows', async () => {
    const { db, status } = await setup()
    // A 429 with no surviving failure row still reads from its text.
    db.db.prepare(`INSERT INTO behavior_dead_letters(id, behavior, target, repo, pr, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('dl-4', 'approve-prs', `${pr.repo}#${pr.number}`,
      pr.repo, pr.number, 'review failed: API error (status 429 Too Many Requests)', '2026-10-29T15:54:00Z')
    const textOnly = await status.readPrStatus(50, Date.parse('2026-10-29T16:00:00Z'))
    expect(textOnly.rows[0].blocker.line).toBe('held: approve-prs rate_limit since 15:54Z')
    // An exhausted review budget has no text rule; the failure row kept it.
    db.db.prepare(`UPDATE behavior_dead_letters SET error = ?, call_id = ? WHERE id = ?`)
      .run('review failed: no verdict before the budget ran out', 'e'.repeat(32), 'dl-4')
    db.setMeta(`behavior_approve_prs_failure:${pr.repo}#${pr.number}`, JSON.stringify({ kind: 'worker',
      consecutiveFailures: 1, lastFailureAtMs: Date.parse('2026-10-29T15:54:00Z'),
      nextRetryAtMs: Date.parse('2026-10-29T16:54:00Z'), callId: 'e'.repeat(32),
      diagnostic: { severity: 'warning', code: 'review_budget_exhausted' } }))
    const budget = await status.readPrStatus(50, Date.parse('2026-10-29T16:00:00Z'))
    expect(budget.rows[0].blocker.line).toBe('held: approve-prs review_budget_exhausted since 15:54Z')
  })

  it('flags age past 60 minutes at the exact boundary', async () => {
    const { status } = await setup()
    const base = Date.parse('2026-10-29T10:00:00Z')
    for (const [minutes, flagged] of [[59, false], [60, false], [61, true]] as const) {
      status.resetPrStatusCaches()
      fixture.listedPrs = [{ ...pr, created_at: new Date(base - minutes * 60_000).toISOString() }]
      const reply = await status.readPrStatus(50, base)
      expect(reply.rows[0].ageMinutes).toBe(minutes)
      expect(reply.rows[0].flags.age).toBe(flagged)
    }
  })

  it('flags a stale blocker and restarts identity on change', async () => {
    const { db, status } = await setup()
    const start = Date.parse('2026-10-29T10:00:00Z')
    const first = await status.readPrStatus(50, start)
    expect(first.rows[0].blocker.sinceRestart).toBe(true)
    expect(first.rows[0].flags.staleBlocker).toBe(false)
    const stale = await status.readPrStatus(50, start + 16 * 60_000)
    expect(stale.rows[0].blocker.since).toBe(first.rows[0].blocker.since)
    expect(stale.rows[0].flags.staleBlocker).toBe(true)
    // A→B starts a witnessed interval.
    db.db.prepare(`INSERT INTO behavior_dead_letters(id, behavior, target, repo, pr, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('dl-2', 'approve-prs', `${pr.repo}#${pr.number}`,
      pr.repo, pr.number, 'review failed: provider busy', new Date(start + 17 * 60_000).toISOString())
    const held = await status.readPrStatus(50, start + 17 * 60_000)
    expect(held.rows[0].blocker.id).toBe('held')
    expect(held.rows[0].blocker.sinceRestart).toBe(false)
    // B→A starts a new interval rather than resuming the old one.
    db.db.prepare(`UPDATE behavior_dead_letters SET retired_at = ?`).run(new Date(start + 18 * 60_000).toISOString())
    const back = await status.readPrStatus(50, start + 18 * 60_000)
    expect(back.rows[0].blocker.id).toBe(first.rows[0].blocker.id)
    expect(back.rows[0].blocker.since).toBe(back.asOf)
    expect(back.rows[0].flags.staleBlocker).toBe(false)
  })

  it('reads unknown when merge-prs is paused', async () => {
    const { db, runtime, status } = await setup()
    recordApproval(db, {
      target: `${pr.repo}#${pr.number}@req=2026-10-29T09:00:00Z/r=1/head=${HEAD}`,
      headSha: HEAD, callId: 'e'.repeat(32), completedAt: '2026-10-29T10:00:00Z',
    })
    const now = Date.now()
    seedCache(runtime, new Date(now).toISOString())
    db.setMeta('behavior_merge_prs_paused_until', new Date(now + 3_600_000).toISOString())
    const reply = await status.readPrStatus(50, now)
    expect(reply.rows[0].ci).toEqual({ state: 'unknown', reason: 'merge-prs paused' })
    expect(reply.rows[0].queue.state).toBe('unknown')
    expect(reply.rows[0].blocker.id).toBe('awaiting_review')
  })

  it('reports datastore outages as coverage, not empty success', async () => {
    const { status } = await setup()
    mocks.runFile.mockImplementationOnce(async () => { throw new Error('datastore offline') })
    const reply = await status.readPrStatus(50, Date.now())
    expect(reply.health.status).toBe('unavailable')
    expect(reply.rows).toEqual([])
    expect(reply.datastore.orgs).toHaveLength(1)
    expect(reply.datastore.orgs[0]).toMatchObject({ status: 'unavailable', error: 'datastore offline' })
  })

  it('reads every organization at once, not one after another', async () => {
    const { db, status } = await setup()
    for (const login of ['acme', 'beta']) db.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES (?, ?, 1, 'ready', 'ready', 'poise-user')`).run(login, `/datastores/${login}.sqlite`)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reads = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command !== 'github-datastore' || !args.includes('view')) throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
      reads++
      await gate
      return { stdout: '[]', stderr: '' }
    })
    const reply = status.readPrStatus(50, Date.now())
    try {
      await vi.waitFor(() => expect(reads).toBe(3), { timeout: 1_000 })
    } finally {
      release()
    }
    expect((await reply).datastore.orgs.map((org) => [org.org, org.status])).toEqual([['Vaquum', 'ready'], ['acme', 'ready'], ['beta', 'ready']])
  })

  it('bounds rows with flagged oldest first', async () => {
    const { status } = await setup()
    const base = Date.parse('2026-10-29T10:00:00Z')
    fixture.listedPrs = [19, 18, 17].map((number) => ({
      ...pr, number, url: `https://github.com/Vaquum/poise-test/pull/${number}`,
      created_at: new Date(base - (number === 17 ? 120 : number === 18 ? 30 : 10) * 60_000).toISOString(),
    }))
    const reply = await status.readPrStatus(2, base)
    expect(reply.totalOpen).toBe(3)
    expect(reply.truncated).toBe(true)
    expect(reply.rows.map((row) => row.number)).toEqual([17, 18])
    expect(reply.rows[0].flags.age).toBe(true)
  })

  it('reads invalid identity without rows', async () => {
    const { db, status } = await setup()
    db.setMeta('me', '')
    const reply = await status.readPrStatus(50, Date.now())
    expect(reply.identity.status).toBe('invalid')
    expect(reply.health.status).toBe('unavailable')
    expect(reply.rows).toEqual([])
  })

  it('merges past a null review decision with a current approval', async () => {
    const { db, runtime, status } = await setup()
    recordApproval(db, {
      target: `${pr.repo}#${pr.number}@req=2026-10-29T09:00:00Z/r=1/head=${HEAD}`,
      headSha: HEAD, callId: 'e'.repeat(32), completedAt: '2026-10-29T10:00:00Z',
    })
    const now = Date.parse('2026-10-29T10:30:00Z')
    seedCache(runtime, new Date(now).toISOString(), { reviewDecision: null })
    const reply = await status.readPrStatus(50, now)
    expect(reply.rows[0].blocker.id).toBe('approved_not_enqueued')
  })

  it('reads a fresh admission as queued, a vanished entry as ejected', async () => {
    const { db, runtime, status } = await setup()
    recordApproval(db, {
      target: `${pr.repo}#${pr.number}@req=2026-10-29T09:00:00Z/r=1/head=${HEAD}`,
      headSha: HEAD, callId: 'e'.repeat(32), completedAt: '2026-10-29T10:00:00Z',
    })
    const cacheAt = '2026-10-29T10:30:00Z'
    seedCache(runtime, cacheAt)
    const target = `${pr.repo}#${pr.number}`
    // The enqueue landed after the cached reading: queued, not ejected.
    db.setMeta(`behavior_merge_prs_queue:${target}`,
      JSON.stringify({ entryId: 'MQE_1', head: HEAD, at: '2026-10-29T10:31:00Z' }))
    const queued = await status.readPrStatus(50, Date.parse('2026-10-29T10:32:00Z'))
    expect(queued.rows[0].queue.state).toBe('queued')
    expect(queued.rows[0].blocker.id).toBe('in_queue')
    // A newer entry-less reading proves the entry is gone.
    status.resetPrStatusCaches()
    seedCache(runtime, '2026-10-29T10:33:00Z')
    const ejected = await status.readPrStatus(50, Date.parse('2026-10-29T10:34:00Z'))
    expect(ejected.rows[0].queue.state).toBe('ejected')
    expect(ejected.rows[0].blocker.line).toBe('approved, not enqueued: queue entry gone, cause unrecorded')
  })

  it('holds repositories with their refusal reason', async () => {
    const { db, status } = await setup()
    const now = Date.now()
    db.setMeta(`behavior_repo_hold:review-bot:${pr.repo.toLowerCase()}`, JSON.stringify({
      repo: pr.repo, error: 'Repository not accessible to review-bot',
      heldAtMs: now - 60_000, nextRecheckAtMs: now + 3_600_000,
    }))
    const reply = await status.readPrStatus(50, now)
    expect(reply.rows[0].blocker.id).toBe('not_eligible')
    expect(reply.rows[0].blocker.line).toContain('has no access to')
  })

  it('leaves execution state unchanged', async () => {
    const { db, runtime, status } = await setup()
    recordCompletedInitialReview(db, { outcome: 'changes_requested', headSha: HEAD, completedAt: '2026-10-29T09:00:00Z' })
    const now = Date.now()
    seedCache(runtime, new Date(now).toISOString())
    db.setMeta(`behavior_review_new_prs_failure:${pr.repo}#${pr.number}:secondary:check`, JSON.stringify({
      kind: 'operation', consecutiveFailures: 1, lastFailureAtMs: now,
      nextRetryAtMs: now + 60_000, error: 'secondary preflight failed',
    }))
    db.db.prepare(`INSERT INTO behavior_dead_letters(id, behavior, target, repo, pr, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('dl-3', 'approve-prs', `${pr.repo}#${pr.number}`,
      pr.repo, pr.number, 'review failed: provider busy', new Date(now).toISOString())
    const dump = () => ({
      seen: db.db.prepare('SELECT * FROM behavior_seen ORDER BY key, target').all(),
      meta: db.db.prepare('SELECT key, value FROM meta ORDER BY key').all(),
      letters: db.db.prepare('SELECT * FROM behavior_dead_letters ORDER BY id').all(),
    })
    const before = dump()
    await status.readPrStatus(50, now)
    expect(dump()).toEqual(before)
  })
})

describe('parsePrStatusRead', () => {
  it('defaults the limit to 50', () => {
    expect(parsePrStatusRead('/api/behavior-ledger/pr-status')).toEqual({ limit: 50 })
    expect(parsePrStatusRead('/api/behavior-ledger/pr-status?limit=10')).toEqual({ limit: 10 })
  })

  it('rejects bad selectors', () => {
    for (const target of ['/api/behavior-ledger/pr-status?limit=0', '/api/behavior-ledger/pr-status?limit=101',
      '/api/behavior-ledger/pr-status?limit=many', '/api/behavior-ledger/pr-status?limit=10&limit=10',
      '/api/behavior-ledger/pr-status?cursor=x', '/api/behavior-ledger/pr-status/extra']) {
      expect(() => parsePrStatusRead(target)).toThrow()
    }
  })
})

describe('handleBehaviorPrStatus', () => {
  async function setup() {
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_merge_prs_enabled', '1')
    arrangeCli()
    const status = await import('../server/behavior-pr-status')
    status.resetPrStatusCaches()
    runtime.resetMergeCandidateCache()
    return { status }
  }

  function fakeRes() {
    return {
      statusCode: 0, headers: {} as Record<string, string>, body: '',
      setHeader(name: string, value: string) { this.headers[name] = value },
      end(text: string) { this.body = text },
    }
  }

  it('refuses non-GET', async () => {
    const { status } = await setup()
    const res = fakeRes()
    await status.handleBehaviorPrStatus({ method: 'POST' } as IncomingMessage, res as unknown as ServerResponse,
      '/api/behavior-ledger/pr-status')
    expect(res.statusCode).toBe(405)
  })

  it('rejects bad queries', async () => {
    const { status } = await setup()
    const res = fakeRes()
    await status.handleBehaviorPrStatus({ method: 'GET' } as IncomingMessage, res as unknown as ServerResponse,
      '/api/behavior-ledger/pr-status?limit=0')
    expect(res.statusCode).toBe(400)
  })

  it('serves rows as JSON', async () => {
    const { status } = await setup()
    const res = fakeRes()
    await status.handleBehaviorPrStatus({ method: 'GET' } as IncomingMessage, res as unknown as ServerResponse,
      '/api/behavior-ledger/pr-status?limit=10')
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(res.body) as { version: number, totalOpen: number }
    expect(body.version).toBe(2)
    expect(body.totalOpen).toBe(1)
  })
})

describe('pr-status CLI', () => {
  it('accepts status schema v2 while keeping ordinary ledger reads on their v1 contract', async () => {
    const body = { version: 2, health: { status: 'ok', pending: 0, dropped: 0, gaps: [] }, rows: [] }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
    const output: string[] = []
    expect(await runBehaviorLedgerCli(['pr-status'], (text) => output.push(text))).toBe(0)
    expect(JSON.parse(output[0]).version).toBe(2)
    expect(await runBehaviorLedgerCli(['list'], () => {})).toBe(1)
    body.version = 3
    expect(await runBehaviorLedgerCli(['pr-status'], () => {})).toBe(1)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('builds the pr-status URL', () => {
    const url = parseBehaviorLedgerArguments(['pr-status'])
    expect(url.pathname).toBe('/api/behavior-ledger/pr-status')
    expect(url.searchParams.get('limit')).toBeNull()
    const limited = parseBehaviorLedgerArguments(['pr-status', '--limit', '10'])
    expect(limited.searchParams.get('limit')).toBe('10')
  })

  it('rejects bad pr-status flags with exit 2', async () => {
    const silent = () => {}
    expect(await runBehaviorLedgerCli(['pr-status', '--limit', '0'], silent, silent)).toBe(2)
    expect(await runBehaviorLedgerCli(['pr-status', '--cursor', 'x'], silent, silent)).toBe(2)
    expect(await runBehaviorLedgerCli(['pr-status', 'extra'], silent, silent)).toBe(2)
  })

  it('exits 0 on complete reads and 1 on stale ones', async () => {
    const bodies = [
      { version: 1, health: { status: 'ok', pending: 0, dropped: 0, gaps: [] }, rows: [] },
      { version: 1, health: { status: 'stale', pending: 0, dropped: 0, gaps: [] }, rows: [] },
    ]
    for (const [index, body] of bodies.entries()) {
      const text = JSON.stringify(body)
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        body: new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(text))
          controller.close()
        } }),
      }) as unknown as Response))
      let out = ''
      const code = await runBehaviorLedgerCli(['pr-status'], (chunk) => { out += chunk }, () => {})
      expect(code).toBe(index === 0 ? 0 : 1)
      expect(JSON.parse(out)).toEqual(body)
      vi.unstubAllGlobals()
    }
  })
})
