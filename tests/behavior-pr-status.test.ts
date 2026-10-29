import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBehaviorLedgerArguments, runBehaviorLedgerCli } from '../server/behavior-ledger-cli'
import { computePrBlocker, parsePrStatusRead, type BlockerInput } from '../server/behavior-pr-status'
import { HEAD_SHA, NEXT_HEAD_SHA, arrangeCli, fixture, loadModules, mocks, pr, recordCompletedInitialReview } from './behaviors-runtime-fixture'

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
        { behavior: 'approve-prs', code: 'rate_limit', since: '2026-10-29T15:54:00Z', nextRetryAt: '2026-10-29T16:02:00Z' },
        { behavior: 'review-new-prs', code: 'held_result', since: '2026-10-29T15:50:00Z' },
      ],
      liveClaim: { key: 'approve-prs', expectedHead: HEAD, others: [] },
    }))
    expect(computed.id).toBe('held')
    expect(computed.line).toBe('held: approve-prs rate_limit since 15:54Z, retry 16:02Z')
    expect(computed.details).toContain('also held: review-new-prs held_result since 15:50Z')
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
    for (const behavior of ['review-new-prs', 'approve-prs', 'resolve-unblocking', 'merge-prs', 'rerun-grey-ci'] as const) {
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

  it('renders a 429 hold with its retry time', async () => {
    const { db, status } = await setup()
    const target = `${pr.repo}#${pr.number}@req=2026-10-29T15:00:00Z/r=2/head=${HEAD}`
    db.db.prepare(`INSERT INTO behavior_dead_letters(id, behavior, target, repo, pr, actor, source, correlation_id, call_id, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('dl-1', 'approve-prs', target, pr.repo, pr.number,
      'review-bot', 'poise:approve-prs', 'c'.repeat(32), 'd'.repeat(32),
      'review failed: API error (status 429 Too Many Requests)', '2026-10-29T15:54:00Z')
    db.setMeta(`behavior_approve_prs_failure:${target}`, JSON.stringify({ kind: 'worker', consecutiveFailures: 2,
      lastFailureAtMs: Date.parse('2026-10-29T15:54:00Z'), nextRetryAtMs: Date.parse('2026-10-29T16:02:00Z'),
      error: 'review failed: API error (status 429 Too Many Requests)', callId: 'd'.repeat(32),
      diagnostic: { severity: 'warning', code: 'rate_limit' } }))
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
    expect(budget.rows[0].blocker.line).toBe('held: approve-prs review_budget_exhausted since 15:54Z, retry 16:54Z')
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
    expect(body.version).toBe(1)
    expect(body.totalOpen).toBe(1)
  })
})

describe('pr-status CLI', () => {
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
