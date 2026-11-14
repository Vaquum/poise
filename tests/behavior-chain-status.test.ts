import { expect, it, vi } from 'vitest'
import { BehaviorChainJournal, chainBasis, chainIdentity, type BehaviorChain, type ChainEvent } from '../server/behavior-chain-store'
import type { ChainObservation } from '../server/behavior-chain-decision'
import { CheckSemaphore } from '../server/check-semaphore'
import { arrangeCli, fixture, loadModules, mocks, pr } from './behaviors-runtime-fixture'
import { completedReviewCall } from './review-response-fixture'
import { nativeActionReceipt, nativeActionSettlement } from '../server/behavior-chain-action'
import { behaviorChainSummary } from '../server/behavior-chain-summary'

const HEAD = 'a'.repeat(40)
const MERGE = 'b'.repeat(40)
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }

function observation(now: number): ChainObservation {
  return { checkedAt: now, issue: { open: true, revision: 'body', eligible: true, commentIds: [] },
    issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer, existingPulls: [],
    publication: { pull_number: pr.number, head_sha: HEAD, head_invocation: 'native-implementation', state: 'open', merged: false, merge_sha: null },
    pull: { number: pr.number, head: HEAD, headSince: now, state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
      reviewIds: [], reviewReceipts: [], reviewContext: 'c'.repeat(64), reviewRevision: 'reviews', greyRuns: [],
      checksState: 'PENDING', readinessBlockers: ['reviewer_not_approved_current_head'],
      pending: true, failing: [], conflict: false, behind: false } }
}

function record(journal: BehaviorChainJournal, chain: BehaviorChain, event: ChainEvent): BehaviorChain {
  return journal.append(chain.id, `${chain.id}:${chain.sequence}`, chain.sequence, event)
}

async function setup() {
  const { database: db, behaviors: runtime } = await loadModules()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_chain_settings', JSON.stringify({ enabled: true, seedMode: 'label', label: 'work-ready' }))
  for (const key of ['review-new-prs', 'approve-prs', 'repair-prs', 'resolve-unblocking', 'merge-prs', 'rerun-grey-ci'] as const) runtime.setEnabled(key, true)
  arrangeCli()
  const journal = new BehaviorChainJournal(db.db)
  const draining = journal.changeAdmission(0, 'draining')
  journal.changeAdmission(draining.sequence, 'v2')
  let chain = journal.append(chainIdentity(pr.repo, 7), 'seed', 0, { type: 'chain.admitted', repository: pr.repo, issue: 7,
    branch: 'poise/issue-7', author: 'poise-user', reviewer: 'review-bot' })
  const obs = observation(Date.now())
  chain = record(journal, chain, { type: 'chain.observed', observation: obs })
  const status = await import('../server/behavior-pr-status')
  status.resetPrStatusCaches()
  return { db, runtime, journal, chain, obs, status }
}

it('projects the canonical chain without legacy review-cap escape or missing merge-cache guesses', async () => {
  const { runtime, journal, chain, status } = await setup()
  runtime.setReviewCap(1)
  const before = journal.history(chain.id)
  const reply = await status.readPrStatus(50)
  expect(reply.rows[0]).toMatchObject({ ownership: { engine: 'v2', chainId: chain.id, reviews: { completed: 0, required: 1 } },
    rounds: { completed: null, cap: null }, ci: { state: 'PENDING', head: HEAD },
    blocker: { id: 'ci_pending', line: 'v2 exact-head CI is running' } })
  expect(journal.history(chain.id)).toEqual(before)
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
  expect(mocks.runFile.mock.calls.every(([command]) => command === 'github-datastore')).toBe(true)
})

it('keeps an original uncertain action distinct from the actual merge and open review obligation', async () => {
  const { journal, chain, obs, status } = await setup()
  let current = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'original-merge', behavior: 'merge-pr',
    actor: chain.reviewer, model: null, slot: null, basis: 'merge', admittedAt: Date.now(),
    request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', String(pr.number)] } } })
  current = record(journal, current, { type: 'invocation.uncertain', invocationId: 'original-merge', reason: 'original response missing' })
  Object.assign(obs.pull!, { merged: true, state: 'closed', mergeSha: MERGE, checksState: null, pending: false })
  current = record(journal, current, { type: 'chain.observed', observation: obs })
  record(journal, current, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository,
    pull_number: pr.number, merged: true, merge_sha: MERGE, review_complete: false } })
  const reply = await status.readPrStatus(50)
  expect(reply.rows[0]).toMatchObject({ ownership: { engine: 'v2', mergeSha: MERGE, reviewPending: true },
    blocker: { id: 'held' }, ci: { state: 'unknown' } })
  expect(reply.rows[0].blocker.line).toContain('review evidence pending')
  expect(reply.rows[0].blocker.details).toContain('original response missing')
  expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
})

it.each([true, false])('counts only verified current-context review slots, with current context matching: %s', async (matching) => {
  const { journal, chain, obs, status } = await setup()
  const call = completedReviewCall(pr.repo, pr.number, HEAD, chain.reviewer)
  const response = call.artifact!.review_response as { context_sha: string }
  Object.assign(obs.pull!, { reviewContext: matching ? response.context_sha : 'd'.repeat(64),
    approved: true, ready: true, checksState: 'SUCCESS', pending: false, reviewIds: [call.review_id!],
    reviewReceipts: [{ id: call.review_id!, head: HEAD, state: 'COMMENTED', invocation: call.id,
      response, submittedAt: Date.parse(call.completed_at!) }] })
  let current = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'review', behavior: 'review-pr',
    actor: chain.reviewer, model: call.model, slot: reviewer.slot, basis: chainBasis(['pr', HEAD, response.context_sha]),
    admittedAt: Date.parse(call.started_at), request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  current = record(journal, current, { type: 'invocation.settled', invocationId: 'review', callId: call.id, outcome: 'clean',
    evidence: { status: 'completed', action: 'reviewed_clean', review_id: call.review_id, head_sha: HEAD,
      completedAt: Date.parse(call.completed_at!), artifact: call.artifact } })
  obs.checkedAt = Date.now()
  record(journal, current, { type: 'chain.observed', observation: obs })
  const reply = await status.readPrStatus(50)
  expect(reply.rows[0].ownership?.reviews).toEqual({ completed: matching ? 1 : 0, required: 1 })
  expect(reply.rows[0].ci).toMatchObject({ state: 'SUCCESS' })
  expect(reply.rows[0].blocker.id).toBe(matching ? 'approved_not_enqueued' : 'awaiting_review')
  expect(reply.rows[0].verdict?.onCurrentHead ?? null).toBe(matching ? true : null)
})

it('does not let an earlier successful rollup hide a later same-head failing check', async () => {
  const { journal, chain, obs, status } = await setup()
  Object.assign(obs.pull!, { checksState: 'SUCCESS', pending: false, failing: ['native-check:failure'] })
  record(journal, chain, { type: 'chain.observed', observation: obs })
  const reply = await status.readPrStatus(50)
  expect(reply.rows[0]).toMatchObject({ ci: { state: 'FAILURE' }, blocker: { id: 'ci_failing' } })
})

it('omits a pre-Resume wait from PR status without hiding fresh waits or review and admission gates', async () => {
  const { runtime, journal, chain, obs, status } = await setup()
  const reason = 'Old blocker; explicitly Resume. Report https://github.com/example/repo/issues/99'
  Object.assign(obs.pull!, { pending: false, checksState: 'SUCCESS' })
  let current = record(journal, chain, { type: 'chain.observed', observation: obs })
  current = record(journal, current, { type: 'chain.waiting', reason })
  current = record(journal, current, { type: 'chain.held', reason: 'automatic hold' })
  current = record(journal, current, { type: 'chain.resumed' })
  const read = async () => (await status.readPrStatus(50)).rows[0]
  const resumed = await read()
  expect(resumed.blocker.id).toBe('awaiting_review')
  expect(resumed.blocker.details).not.toContain(reason)
  current = record(journal, current, { type: 'chain.observed', observation: { ...obs, checkedAt: Date.now() } })
  expect((await read()).blocker).toEqual(resumed.blocker)
  current = record(journal, current, { type: 'chain.waiting', reason })
  expect((await read()).blocker).toMatchObject({ id: 'blocked', line: `v2 waiting: ${reason}` })
  expect((await read()).blocker.details).toContain(reason)
  runtime.setEnabled('review-new-prs', false)
  expect((await read()).blocker.line).toContain('review-new-prs is disabled')
  expect(journal.read(chain.id)).toEqual(current)
})

it.each(['stale', 'future'])('keeps %s observations unknown instead of reporting zero completed reviews or green CI', async (kind) => {
  const { status, obs } = await setup()
  const now = kind === 'stale' ? obs.checkedAt + 121_000 : obs.checkedAt - 1
  const reply = await status.readPrStatus(50, now)
  expect(reply.health.status).toBe('stale')
  expect(reply.rows[0]).toMatchObject({ ownership: { engine: 'v2', reviews: { completed: null, required: null } },
    rounds: { completed: null, next: null }, ci: { state: 'unknown' }, queue: { state: 'unknown' }, blocker: { id: 'unknown' } })
})

it('shows a long-running owned invocation and its age without mistaking skipped observation for collector failure', async () => {
  const { journal, chain, obs, status } = await setup()
  let current = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'owned-review', behavior: 'review-pr',
    actor: chain.reviewer, model: 'fixture', slot: 'primary', basis: 'review', admittedAt: obs.checkedAt,
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  current = record(journal, current, { type: 'invocation.started', invocationId: 'owned-review' })
  const reply = await status.readPrStatus(50, obs.checkedAt + 30 * 60_000)
  expect(reply.health.status).toBe('ok')
  expect(reply.rows[0]).toMatchObject({ ownership: { observation: 'skipped-while-owned' },
    blocker: { id: 'review_running', line: 'v2 review-pr: started' }, ci: { state: 'unknown' } })
  expect(reply.rows[0].blocker.details[0]).toContain('30 minute(s) ago')
  expect(journal.read(chain.id)?.sequence).toBe(current.sequence)
})

it('reports a deliberate original-evidence recheck without declaring the old GitHub facets fresh or the collector failed', async () => {
  const { journal, chain, obs, status } = await setup()
  const now = Date.now()
  obs.checkedAt = now - 5 * 60_000
  Object.assign(obs.pull!, { merged: true, mergeSha: MERGE, state: 'closed', mergedAt: now - 20 * 60_000 })
  let current = record(journal, chain, { type: 'chain.observed', observation: obs })
  current = record(journal, current, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository,
    pull_number: pr.number, merged: true, merge_sha: MERGE, review_complete: false } })
  current = record(journal, current, { type: 'chain.held', reason: 'original pre-merge review evidence is missing' })
  const next = journal.reconciliationAt(current)!
  const reply = await status.readPrStatus(50, now)
  expect(reply.health.status).toBe('ok')
  expect(reply.rows[0]).toMatchObject({ ownership: { observation: 'skipped-while-owned',
    reconciliation: { nextObservationAt: new Date(next).toISOString(), waitingForOriginalResponse: false } },
    ci: { state: 'unknown' }, blocker: { id: 'held' } })
})

it.each(['merged', 'closed-pr', 'closed-seed'] as const)('distinguishes immediate native resource reconciliation from a skipped GitHub read for %s', async kind => {
  const { journal, chain, obs, status } = await setup()
  const now = Date.now()
  let current = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'original-model', behavior: 'repair-pr',
    actor: chain.author, model: 'fixture', slot: 'primary', basis: 'repair', admittedAt: now - 20 * 60_000,
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  current = record(journal, current, { type: 'invocation.uncertain', invocationId: 'original-model', reason: 'original resource release is unknown' })
  obs.checkedAt = now - 5 * 60_000
  Object.assign(obs.pull!, { merged: kind === 'merged', mergeSha: kind === 'merged' ? MERGE : null,
    state: kind === 'closed-seed' ? 'open' : 'closed', mergedAt: kind === 'merged' ? now - 6 * 60_000 : null })
  if (kind === 'closed-seed') obs.issue.open = false
  current = record(journal, current, { type: 'chain.observed', observation: obs })
  if (kind === 'merged') current = record(journal, current, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository,
    pull_number: pr.number, merged: true, merge_sha: MERGE, review_complete: false } })
  const before = journal.history(chain.id)
  expect(journal.reconcilable('', now, false).map(row => row.id)).toContain(chain.id)
  expect(journal.reconciliationAt(current)).toBeNull()
  expect(behaviorChainSummary(current, journal, { at: journal.reconciliationAt(current) }).reconciliation).toMatchObject({
    nextObservationAt: null, waitingForOriginalResponse: false, waitingForResourceRelease: true })
  const reply = await status.readPrStatus(50, now)
  expect(reply.health.status).toBe('ok')
  expect(reply.rows[0]).toMatchObject({ ownership: { observation: 'skipped-while-owned', reconciliation: {
    nextObservationAt: null, waitingForOriginalResponse: false, waitingForResourceRelease: true } }, ci: { state: 'unknown' }, blocker: { id: 'held' } })
  expect(reply.rows[0].blocker.details.join(' ')).toContain('resource release remains unverified')
  expect(journal.liveModelInvocationCount()).toBe(1)
  expect(journal.history(chain.id)).toEqual(before)
})

it.each(['review-pr', 'approve-pr'] as const)('keeps open-PR %s observation eligible when only its seed closes', async behavior => {
  const { journal, chain, obs } = await setup()
  let current = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'open-pr-model', behavior,
    actor: chain.reviewer, model: 'fixture', slot: 'primary', basis: 'review', admittedAt: Date.now(),
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  current = record(journal, current, { type: 'invocation.uncertain', invocationId: 'open-pr-model', reason: 'original resource release is unknown' })
  obs.issue.open = false
  current = record(journal, current, { type: 'chain.observed', observation: obs })
  const before = journal.history(chain.id)
  expect(journal.reconciliationAt(current)).toBe(0)
  expect(behaviorChainSummary(current, journal, { at: 0 }).reconciliation).toEqual({ nextObservationAt: 0, waitingForOriginalResponse: false })
  expect(journal.reconcilable('', Date.now(), false).map(row => row.id)).toContain(chain.id)
  expect(journal.liveModelInvocationCount()).toBe(1)
  expect(journal.history(chain.id)).toEqual(before)
})

it('excludes a completed chain from a stale open-PR listing without a false original-response wait', async () => {
  const { journal, chain, obs, status } = await setup()
  const now = Date.now()
  obs.checkedAt = now - 5 * 60_000
  Object.assign(obs.pull!, { merged: true, mergeSha: MERGE, state: 'closed', mergedAt: now - 20 * 60_000 })
  let current = record(journal, chain, { type: 'chain.observed', observation: obs })
  current = record(journal, current, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository,
    pull_number: pr.number, merged: true, merge_sha: MERGE } })
  expect(journal.reconciliationAt(current)).toBeNull()
  const reply = await status.readPrStatus(50, now)
  expect(reply.rows).toEqual([])
  expect(reply.health.status).toBe('ok')
})

it.each(['switch', 'phase-pause', 'release', 'repository-skip'] as const)('reports the existing %s admission control without changing it', async (kind) => {
  const { runtime, status } = await setup()
  const release = await import('../server/release-background')
  if (kind === 'switch') runtime.setEnabled('review-new-prs', false)
  if (kind === 'phase-pause') await runtime.setPaused('review-new-prs', new Date(Date.now() + 60_000).toISOString(), 'person')
  if (kind === 'release') release.pauseReleaseBackground()
  if (kind === 'repository-skip') runtime.setRepositorySkips('review-new-prs', [pr.repo])
  try {
    const row = (await status.readPrStatus(50)).rows[0]
    expect(row.blocker.id).toBe(kind === 'repository-skip' ? 'not_eligible' : 'blocked')
    expect(row.blocker.line).toContain(kind === 'switch' ? 'is disabled' : kind === 'phase-pause' ? 'admissions are paused'
      : kind === 'release' ? 'release background barrier' : 'Skip repositories')
  } finally { release.resumeReleaseBackground() }
})

it('shows a queue-reported merge as waiting for confirmation instead of rejected work for the author', async () => {
  const { journal, chain, obs, status } = await setup()
  let current = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'merging-queue', behavior: 'merge-pr',
    actor: chain.reviewer, model: null, slot: null, basis: 'queue', admittedAt: obs.checkedAt - 1,
    request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', String(pr.number),
      '--expected-head', HEAD, '--token-user', chain.reviewer] } } })
  const proof = nativeActionReceipt(current, current.invocations[0], { action: 'merge_if_ready', repository: pr.repo,
    pull_number: pr.number, head_sha: HEAD, outcome: 'enqueued', queue_entry_id: 'merging-entry' })
  current = record(journal, current, { type: 'invocation.settled', invocationId: 'merging-queue', callId: null,
    outcome: 'enqueued', evidence: nativeActionSettlement(proof) })
  obs.checkedAt = Math.max(Date.now(), proof.observedAt)
  Object.assign(obs.pull!, { pending: false, checksState: 'SUCCESS',
    queueRemoval: { id: 'merged-removal', reason: 'merged', at: obs.checkedAt, actor: null } })
  current = record(journal, current, { type: 'chain.observed', observation: obs })
  record(journal, current, { type: 'chain.waiting', reason: 'GitHub queue reports a merge; awaiting confirmed merge evidence' })
  const before = journal.history(chain.id)
  const reply = await status.readPrStatus(50, obs.checkedAt)
  expect(reply.rows[0]).toMatchObject({ queue: { state: 'not_queued' }, blocker: { id: 'blocked' } })
  expect(reply.rows[0].blocker.line).toContain('awaiting confirmed merge evidence')
  expect(journal.history(chain.id)).toEqual(before)
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})

it('reports the actual queue rejection and retains blocker age across repeated observations', async () => {
  const { journal, chain, obs, status } = await setup()
  let queued = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'rejected-queue', behavior: 'merge-pr',
    actor: chain.reviewer, model: null, slot: null, basis: 'queue', admittedAt: obs.checkedAt - 1,
    request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', String(pr.number),
      '--expected-head', HEAD, '--token-user', chain.reviewer] } } })
  const proof = nativeActionReceipt(queued, queued.invocations[0], { action: 'merge_if_ready', repository: pr.repo,
    pull_number: pr.number, head_sha: HEAD, outcome: 'enqueued', queue_entry_id: 'rejected-entry' })
  queued = record(journal, queued, { type: 'invocation.settled', invocationId: 'rejected-queue', callId: null,
    outcome: 'enqueued', evidence: nativeActionSettlement(proof) })
  obs.pull!.queueRemoval = { id: 'rejected-entry', reason: 'failed_checks', at: obs.checkedAt, actor: null }
  const current = record(journal, queued, { type: 'chain.observed', observation: obs })
  const first = await status.readPrStatus(50, obs.checkedAt)
  expect(first.rows[0]).toMatchObject({ queue: { state: 'ejected' }, blocker: { id: 'awaiting_author' } })
  expect(first.rows[0].blocker.line).toContain('failed_checks')
  obs.checkedAt += 60_000
  record(journal, current, { type: 'chain.observed', observation: obs })
  const repeated = await status.readPrStatus(50, obs.checkedAt)
  expect(repeated.rows[0].blocker.since).toBe(first.rows[0].blocker.since)
})

it.each(['never-enqueued', 'old-head', 'earlier-removal'] as const)('does not let %s queue history hide the current head CI blocker', async (kind) => {
  const { journal, chain, obs, status } = await setup()
  let current = chain
  if (kind !== 'never-enqueued') {
    current = record(journal, current, { type: 'invocation.admitted', invocation: { id: 'earlier-queue', behavior: 'merge-pr',
      actor: chain.reviewer, model: null, slot: null, basis: 'queue', admittedAt: obs.checkedAt,
      request: { command: 'github-interface', cwd: '/fixture', argv: [] } } })
    // Historical queue participation remains usable without inventing an
    // original action response for an admission that predates that receipt.
    current = record(journal, current, { type: 'invocation.settled', invocationId: 'earlier-queue', callId: null,
      outcome: 'enqueued', evidence: { status: 'completed', outcome: 'enqueued', head_sha: kind === 'old-head' ? 'd'.repeat(40) : HEAD } })
  }
  obs.pull!.queueRemoval = { id: 'old-removal', reason: 'failed_checks', at: obs.checkedAt - (kind === 'earlier-removal' ? 1 : 0), actor: null }
  record(journal, current, { type: 'chain.observed', observation: obs })
  const row = (await status.readPrStatus(50)).rows[0]
  expect(row.queue.state).toBe('not_queued')
  expect(row.blocker).toMatchObject({ id: 'ci_pending', line: 'v2 exact-head CI is running' })
})

it.each(['enqueued', 'in_queue'] as const)('distinguishes the original %s response from somebody else queueing the candidate, including UNMERGEABLE', async (outcome) => {
  const { journal, chain, obs, status } = await setup()
  let current = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'queue-action', behavior: 'merge-pr',
    actor: chain.reviewer, model: null, slot: null, basis: 'queue', admittedAt: Date.now(),
    request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', String(pr.number),
      '--expected-head', HEAD, '--token-user', chain.reviewer] } } })
  const proof = nativeActionReceipt(current, current.invocations[0], { action: 'merge_if_ready', repository: pr.repo,
    pull_number: pr.number, head_sha: HEAD, outcome, queue_entry_id: 'real-entry' })
  current = record(journal, current, { type: 'invocation.settled', invocationId: 'queue-action', callId: null, outcome,
    evidence: nativeActionSettlement(proof) })
  obs.checkedAt = Date.now()
  obs.pull!.queueEntry = 'real-entry'
  current = record(journal, current, { type: 'chain.observed', observation: obs })
  const row = (await status.readPrStatus(50)).rows[0]
  expect(row.queue).toMatchObject({ state: 'queued', attribution: outcome === 'enqueued' ? 'accepted-response' : 'observed' })
  expect(row.blocker.line).toContain(outcome === 'enqueued' ? 'enqueue accepted' : 'enqueue mutation is not attributed')
  const summary = behaviorChainSummary(current, journal)
  expect(summary.invocations[0].nativeAction).toMatchObject({
    attribution: outcome === 'enqueued' ? 'accepted-response' : 'observed-no-action', queueEntryId: 'real-entry',
  })
  expect(JSON.stringify(summary)).not.toContain('nativeActionReceipt')
  obs.pull!.queueEntryDetails = { id: 'real-entry', state: 'UNMERGEABLE', base: MERGE, head: null }
  current = record(journal, current, { type: 'chain.observed', observation: obs })
  const blocked = (await status.readPrStatus(50)).rows[0]
  expect(blocked).toMatchObject({ queue: { state: 'queued', entryId: 'real-entry',
    attribution: outcome === 'enqueued' ? 'accepted-response' : 'observed', disposition: 'UNMERGEABLE', integrationBase: MERGE, integrationHead: null },
  blocker: { id: 'blocked', line: 'v2 queue UNMERGEABLE; cause unknown; GitHub retains ownership' } })
  expect(journal.read(chain.id)!.held).toBeNull()
  for (const disposition of ['QUEUED', 'AWAITING_CHECKS', 'LOCKED', 'MERGEABLE']) {
    obs.pull!.queueEntryDetails.state = disposition
    current = record(journal, current, { type: 'chain.observed', observation: obs })
    expect((await status.readPrStatus(50)).rows[0]).toMatchObject({ queue: { state: 'queued', disposition }, blocker: { id: 'in_queue' } })
  }
  obs.pull!.queueEntryDetails.state = 'UNMERGEABLE'
  // A replaced entry cannot inherit the earlier entry's disposition.
  obs.pull!.queueEntry = 'replacement'
  current = record(journal, current, { type: 'chain.observed', observation: obs })
  expect((await status.readPrStatus(50)).rows[0]).toMatchObject({ queue: { state: 'queued', entryId: 'replacement', attribution: 'observed' },
    blocker: { id: 'in_queue' } })
  record(journal, current, { type: 'chain.observed', observation: obs })
  expect((await status.readPrStatus(50, Date.now() + 120_001)).rows[0]).toMatchObject({ queue: { state: 'unknown' }, blocker: { id: 'unknown' } })
})

it('preserves the original enqueue attribution after a later no-action observation of the same entry', async () => {
  const { journal, chain, obs, status } = await setup()
  let current = chain
  for (const outcome of ['enqueued', 'in_queue'] as const) {
    const id = `queue-${outcome}`
    current = record(journal, current, { type: 'invocation.admitted', invocation: { id, behavior: 'merge-pr',
      actor: chain.reviewer, model: null, slot: null, basis: 'queue', admittedAt: Date.now(),
      request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', String(pr.number),
        '--expected-head', HEAD, '--token-user', chain.reviewer] } } })
    const proof = nativeActionReceipt(current, current.invocations.at(-1)!, { action: 'merge_if_ready', repository: pr.repo,
      pull_number: pr.number, head_sha: HEAD, outcome, queue_entry_id: 'original-entry' })
    current = record(journal, current, { type: 'invocation.settled', invocationId: id, callId: null, outcome,
      evidence: nativeActionSettlement(proof) })
  }
  obs.checkedAt = Date.now()
  obs.pull!.queueEntry = 'original-entry'
  record(journal, current, { type: 'chain.observed', observation: obs })
  const row = (await status.readPrStatus(50)).rows[0]
  expect(row.queue).toMatchObject({ state: 'queued', entryId: 'original-entry', attribution: 'accepted-response', invocationId: 'queue-enqueued' })
  expect(behaviorChainSummary(current, journal).invocations[1].nativeAction?.attribution).toBe('observed-no-action')
})

it('keeps a paused chain and a legacy PR under their respective status rules', async () => {
  const { db, runtime, chain, status } = await setup()
  db.setMeta('behavior_chain_settings', JSON.stringify({ enabled: false, seedMode: 'all', label: 'work-ready' }))
  runtime.setReviewCap(3)
  fixture.listedPrs = [pr, { ...pr, number: 18, url: `${pr.url.slice(0, -2)}18`, head_ref: 'personal-work', head_repo: pr.repo }]
  const reply = await status.readPrStatus(50)
  expect(reply.rows.find((row) => row.number === pr.number)).toMatchObject({ ownership: { engine: 'v2', chainId: chain.id },
    rounds: { cap: null }, blocker: { id: 'blocked', line: 'v2 admissions paused; existing ownership is retained' } })
  expect(reply.rows.find((row) => row.number === 18)).toMatchObject({ ownership: { engine: 'v1' }, rounds: { cap: 3 } })
})

it('recognizes a reserved native branch before publication has a PR number, without inventing an observation', async () => {
  const { journal, chain, status } = await setup()
  record(journal, chain, { type: 'chain.observed', observation: { ...observation(Date.now()), pull: null,
    publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } } })
  fixture.listedPrs = [{ ...pr, head_ref: chain.branch, head_repo: pr.repo }]
  const row = (await status.readPrStatus(50)).rows[0]
  expect(row).toMatchObject({ ownership: { engine: 'v2', chainId: chain.id, observation: 'missing' },
    rounds: { completed: null, cap: null }, ci: { state: 'unknown' }, blocker: { id: 'unknown' } })
})

it('does not list a confirmed completed chain as an open PR while the datastore catches up', async () => {
  const { journal, chain, status } = await setup()
  record(journal, chain, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository,
    pull_number: pr.number, merged: true, merge_sha: MERGE, review_complete: true } })
  expect((await status.readPrStatus(50)).totalOpen).toBe(0)
})

it('does not fall back to legacy status when the journal projection is contradictory', async () => {
  const { db, chain, status } = await setup()
  db.db.prepare("UPDATE behavior_chain_current SET state = json_set(state, '$.held', 'unrecorded change') WHERE chain_id = ?").run(chain.id)
  await expect(status.readPrStatus(50)).rejects.toThrow('authoritative event journal')
})

it('refuses unprovable legacy ownership while an active native branch may own the PR', async () => {
  const { status } = await setup()
  fixture.listedPrs = [{ ...pr, number: 18, url: `${pr.url.slice(0, -2)}18` }]
  await expect(status.readPrStatus(50)).rejects.toThrow('branch evidence needed')
})

it('bounds status previews and pagination without truncating authoritative hold evidence', async () => {
  const { journal, chain, status } = await setup()
  const reason = 'retained failure evidence '.repeat(2000)
  const listed = []
  for (let offset = 0; offset < 101; offset++) {
    const number = offset + 1000
    listed.push({ ...pr, number, url: `https://github.com/${pr.repo}/pull/${number}` })
    let target = journal.append(chainIdentity(pr.repo, number), `large-seed-${number}`, 0, { type: 'chain.admitted',
      repository: pr.repo, issue: number, branch: `poise/issue-${number}`, author: chain.author, reviewer: chain.reviewer })
    const obs = observation(Date.now())
    obs.publication.pull_number = number
    obs.pull!.number = number
    target = record(journal, target, { type: 'chain.observed', observation: obs })
    record(journal, target, { type: 'chain.held', reason })
  }
  fixture.listedPrs = listed
  const reply = await status.readPrStatus(100)
  expect(reply).toMatchObject({ totalOpen: 101, truncated: true })
  expect(reply.rows).toHaveLength(100)
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(512 * 1024)
  expect(reply.rows[0].blocker.details[0]).toHaveLength(1024)
  expect(journal.read(chainIdentity(pr.repo, 1000))!.held).toBe(reason)
})

it('keeps durable model reservations visible after replacing the process-local semaphore', async () => {
  const { runtime, journal, chain } = await setup()
  let current = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'surviving-model', behavior: 'review-pr',
    actor: chain.reviewer, model: 'fixture', slot: 'primary', basis: 'review', admittedAt: Date.now(),
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  current = record(journal, current, { type: 'invocation.uncertain', invocationId: 'surviving-model', reason: 'native process ownership unresolved' })
  runtime.setBehaviorCheckSlots(new CheckSemaphore(() => 4))
  expect(runtime.getBehaviorCheckSlots().stats().running).toBe(0)
  expect(runtime.getBehaviorChainCapacity()).toMatchObject({ status: 'available', reservedModelInvocations: 1, retainedModelInvocations: 1,
    modelInvocationLimit: 3, enabled: true, mode: 'v2', intake: { seedMode: 'label', label: 'work-ready' },
    processLocal: { behaviorRunning: 0 }, resources: { unaccounted: 1 } })
  record(journal, current, { type: 'invocation.reconciled', invocationId: 'surviving-model',
    evidence: { resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  expect(runtime.getBehaviorChainCapacity()).toMatchObject({ reservedModelInvocations: 0, retainedModelInvocations: 0 })
  expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
})

it('counts retained cleanup across pages without counting released publication uncertainty or changing holds', async () => {
  const { runtime, journal, chain, obs } = await setup()
  const invocation = { id: 'live', behavior: 'repair-pr' as const, actor: chain.author, model: 'fixture', slot: 'primary',
    basis: 'repair', admittedAt: Date.now(), request: { command: 'agent-interface' as const, cwd: '/fixture', argv: [], nativeResources: 2 as const } }
  const live = record(journal, chain, { type: 'invocation.admitted', invocation })
  record(journal, live, { type: 'invocation.started', invocationId: invocation.id })
  for (let issue = 1000; issue < 1101; issue++) journal.append(chainIdentity(pr.repo, issue), `seed-${issue}`, 0, {
    type: 'chain.admitted', repository: pr.repo, issue, branch: `poise/issue-${issue}`, author: chain.author, reviewer: chain.reviewer })
  const release = { resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } }
  for (const issue of [998, 999]) {
    let target = journal.append(chainIdentity(pr.repo, issue), `seed-${issue}`, 0, { type: 'chain.admitted', repository: pr.repo,
      issue, branch: `poise/issue-${issue}`, author: chain.author, reviewer: chain.reviewer })
    target = record(journal, target, { type: 'chain.observed', observation: { ...obs, pull: null,
      publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } } })
    target = record(journal, target, { type: 'invocation.admitted', invocation: { ...invocation, id: `uncertain-${issue}` } })
    target = record(journal, target, { type: 'invocation.uncertain', invocationId: `uncertain-${issue}`, reason: 'original publication receipt missing' })
    if (issue === 998) target = record(journal, target, { type: 'invocation.resources_reconciled', invocationId: `uncertain-${issue}`, evidence: release })
    record(journal, target, { type: 'chain.held', reason: 'original publication receipt missing' })
  }
  let retained = journal.read(chainIdentity(pr.repo, 999))!
  expect(journal.page().map(entry => entry.id)).not.toContain(retained.id)
  const before = journal.history(retained.id)
  expect(runtime.getBehaviorChainCapacity()).toMatchObject({ reservedModelInvocations: 2, retainedModelInvocations: 1 })
  expect(journal.liveModelInvocationCount()).toBe(2)
  expect(journal.modelCapacityAvailable(2)).toBe(false)
  expect(journal.history(retained.id)).toEqual(before)
  retained = record(journal, retained, { type: 'invocation.reconciled', invocationId: 'uncertain-999',
    evidence: { ...release, resource_ownership: { version: 1, roots: [], errors: [], process_pending: true } } })
  expect(runtime.getBehaviorChainCapacity()).toMatchObject({ reservedModelInvocations: 2, retainedModelInvocations: 1 })
  journal.rebuild()
  expect(runtime.getBehaviorChainCapacity()).toMatchObject({ reservedModelInvocations: 2, retainedModelInvocations: 1 })
  record(journal, retained, { type: 'invocation.resources_reconciled', invocationId: 'uncertain-999', evidence: release })
  expect(runtime.getBehaviorChainCapacity()).toMatchObject({ reservedModelInvocations: 1, retainedModelInvocations: 0 })
  for (const issue of [998, 999]) expect(journal.read(chainIdentity(pr.repo, issue))).toMatchObject({
    held: 'original publication receipt missing', invocations: [{ state: 'uncertain', outcome: 'original publication receipt missing' }] })
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
})

it('reports budget exhaustion from the same reservation snapshot that refuses another admission', async () => {
  const { runtime, journal, chain } = await setup()
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_BUDGET_BYTES', '1024')
  vi.stubEnv('POISE_BEHAVIOR_DISK_BUDGET_BYTES', '2048')
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES', '256')
  vi.stubEnv('POISE_BEHAVIOR_DISK_RESERVATION_BYTES', '512')
  try {
    const invocation = { id: 'budget-owner', behavior: 'review-pr' as const, actor: chain.reviewer, model: 'fixture', slot: 'primary',
      basis: 'review', admittedAt: Date.now(), reservation: { memoryBytes: 1024, diskBytes: 2048 },
      request: { command: 'agent-interface' as const, cwd: '/fixture', argv: [] } }
    record(journal, chain, { type: 'invocation.admitted', invocation })
    const snapshot = runtime.getBehaviorChainCapacity()
    expect(snapshot).toMatchObject({ status: 'available', reservedModelInvocations: 1, modelInvocationLimit: 3,
      resources: { budget: { memoryBytes: 1024, diskBytes: 2048 }, reserved: { memoryBytes: 1024, diskBytes: 2048 }, unaccounted: 0 } })
    const other = journal.append(chainIdentity(pr.repo, 8), 'other-budget-seed', 0, { type: 'chain.admitted', repository: pr.repo,
      issue: 8, branch: 'poise/issue-8', author: chain.author, reviewer: chain.reviewer })
    expect(journal.admitInvocation(other, 'over-budget', { ...invocation, id: 'next-owner', reservation: { memoryBytes: 256, diskBytes: 512 } },
      3, snapshot.resources!.budget!)).toBeNull()
  } finally { vi.unstubAllEnvs() }
})

it('keeps a full durable ceiling distinct from an empty in-memory semaphore and invalid budget configuration', async () => {
  const { runtime, journal, chain } = await setup()
  record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'full-owner', behavior: 'review-pr',
    actor: chain.reviewer, model: 'fixture', slot: 'primary', basis: 'review', admittedAt: Date.now(),
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  runtime.setBehaviorCheckSlots(new CheckSemaphore(() => 2))
  expect(runtime.getBehaviorChainCapacity()).toMatchObject({ reservedModelInvocations: 1, modelInvocationLimit: 1,
    processLocal: { behaviorRunning: 0, allRunning: 0 } })
  expect(journal.modelCapacityAvailable(1)).toBe(false)
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_BUDGET_BYTES', 'invalid')
  try { expect(runtime.getBehaviorChainCapacity()).toMatchObject({ status: 'unavailable', reservedModelInvocations: null, retainedModelInvocations: null }) }
  finally { vi.unstubAllEnvs() }
})

it('reports unavailable capacity as unknown instead of free', async () => {
  const { db, runtime, chain } = await setup()
  db.db.prepare("UPDATE behavior_chain_current SET state = json_set(state, '$.held', 'unrecorded change') WHERE chain_id = ?").run(chain.id)
  expect(runtime.getBehaviorChainCapacity()).toMatchObject({ status: 'unavailable', reservedModelInvocations: null, retainedModelInvocations: null, enabled: null })
})

it('looks up a target beside 1,000 historical chains without loading their projections', async () => {
  const { db, journal, chain } = await setup()
  db.db.transaction(() => {
    for (let issue = 100; issue < 1100; issue++) {
      let historical = journal.append(chainIdentity(pr.repo, issue), `seed-${issue}`, 0, { type: 'chain.admitted', repository: pr.repo,
        issue, branch: `poise/issue-${issue}`, author: chain.author, reviewer: chain.reviewer })
      historical = record(journal, historical, { type: 'chain.observed', observation: { publication: { pull_number: issue + 1000 } } })
      record(journal, historical, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: pr.repo,
        pull_number: issue + 1000, merged: true, merge_sha: MERGE } })
    }
  })()
  const read = vi.spyOn(journal, 'read')
  expect(journal.forPull(pr.repo, pr.number)?.id).toBe(chain.id)
  expect(read).toHaveBeenCalledTimes(1)
  const plan = db.db.prepare(`EXPLAIN QUERY PLAN SELECT chain_id FROM behavior_chain_current
    WHERE lower(json_extract(state, '$.repository')) = lower(?)
      AND json_extract(state, '$.observation.publication.pull_number') = ? LIMIT 2`).all(pr.repo, pr.number) as Array<{ detail: string }>
  expect(plan.some((step) => step.detail.includes('behavior_chain_pull'))).toBe(true)
})

it('does not attribute another PR or a reused completed branch to a historical merge', async () => {
  const { journal, chain } = await setup()
  const identity = { headRef: chain.branch, headRepo: chain.repository }
  expect(() => journal.forPull(pr.repo, 18, identity)).toThrow('different published pull request')
  record(journal, chain, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: pr.repo,
    pull_number: pr.number, merged: true, merge_sha: MERGE } })
  expect(journal.forPull(pr.repo, pr.number)?.mergeSha).toBe(MERGE)
  expect(journal.forPull(pr.repo, 18, identity)).toBeNull()
})
