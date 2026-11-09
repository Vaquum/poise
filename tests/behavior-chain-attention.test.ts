import Database from 'better-sqlite3'
import { afterAll, afterEach, expect, it } from 'vitest'
import { BehaviorChainJournal, type BehaviorChain, type ChainEvent } from '../server/behavior-chain-store'
import { behaviorChainAttention, CHAIN_ATTENTION_DELAY_MS } from '../server/behavior-chain-summary'
import type { ChainObservation } from '../server/behavior-chain-decision'
import { nativeActionReceipt, nativeActionSettlement } from '../server/behavior-chain-action'
import { chainSummaryFixture, delayedChainFixture } from './fixtures/behavior-chain-summary'

const now = Date.parse('2026-11-08T18:00:00Z')
const db = new Database(':memory:')
afterAll(() => db.close())
afterEach(() => { db.exec('DROP TABLE behavior_chain_current; DROP TABLE behavior_chain_events') })
const append = (journal: BehaviorChainJournal, chain: BehaviorChain, event: ChainEvent, at = now) =>
  journal.append(chain.id, `${chain.id}:${chain.sequence}`, chain.sequence, event, at)
function admit(journal: BehaviorChainJournal, issue: number, at: number) {
  return journal.append(`autonomio/poise#${issue}`, `seed-${issue}`, 0, { type: 'chain.admitted', repository: 'autonomio/poise',
    issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' }, at)
}

it('freezes the three reported holds alongside exact-head CI and review gates, oldest progress first', () => {
  const journal = new BehaviorChainJournal(db)
  const snapshot = delayedChainFixture(journal, now)
  expect(snapshot.attention.map(entry => [entry.issue, entry.pullNumber])).toEqual([[887, 893], [896, 900], [898, 901]])
  for (const entry of snapshot.attention.slice(0, 2)) {
    expect(entry).toMatchObject({ step: 'repair-pr: preflight_failed', progressAt: now - (72 - (entry.issue === 887 ? 1 : 2)) * 60 * 60_000,
      retryAt: null, evidence: { state: 'fresh' } })
    expect(entry.blocker).toContain('incomplete review replies')
    expect(entry.evidence.gates).toEqual(expect.arrayContaining(['Required CI passed', 'Review changes requested', 'Current-head approval required']))
    expect(entry.nextAction).toContain('explicitly resume')
    expect(entry.reconciliation.nextObservationAt).toBeGreaterThan(now)
    expect(new URL(entry.journal, 'http://localhost').searchParams.get('id')).toBe(entry.id)
  }
  expect(snapshot.attention[2].evidence.gates).toEqual(expect.arrayContaining([
    'CI failing: Unit/integration (2/2):failure', 'Current-head approval required']))
  expect(snapshot.attention[2].blocker).toContain('required CI shard failed')
})

it('preserves age over unchanged polls, failed retries, history pages and a new journal/rebuild', () => {
  const journal = new BehaviorChainJournal(db)
  const first = delayedChainFixture(journal, now).attention
  let chain = journal.read('autonomio/poise#887')!
  const observation = chain.observation as ChainObservation
  chain = append(journal, chain, { type: 'chain.resumed' })
  chain = append(journal, chain, { type: 'invocation.admitted', invocation: { id: 'retry', behavior: 'repair-pr', actor: chain.author,
    model: 'fixture', slot: 'primary', basis: 'repair', admittedAt: now,
    request: { command: 'agent-interface', cwd: '/isolated/fixture', argv: [] } } })
  chain = append(journal, chain, { type: 'invocation.settled', invocationId: 'retry', callId: 'retry', outcome: 'preflight_failed',
    evidence: { status: 'failed', action: 'not_started', completedAt: now } })
  chain = append(journal, chain, { type: 'chain.held', reason: first[0].blocker })
  for (let poll = 0; poll < 105; poll++) chain = append(journal, chain, { type: 'chain.observed', observation: { ...observation, checkedAt: now } })
  const before = db.prepare('SELECT * FROM behavior_chain_events').all()
  const restarted = new BehaviorChainJournal(db)
  restarted.rebuild()
  const result = behaviorChainAttention(restarted, now)
  expect(result.map(entry => [entry.id, entry.progressAt, entry.ageMs])).toEqual(first.map(entry => [entry.id, entry.progressAt, entry.ageMs]))
  expect(db.prepare('SELECT * FROM behavior_chain_events').all()).toEqual(before)
  expect(restarted.read(chain.id)!.held).toBe(first[0].blocker)
})

it('selects an oldest unpublished admission beyond page one and applies the exact 24-hour cutoff', () => {
  const journal = new BehaviorChainJournal(db)
  const oldest = admit(journal, 999, now - 4 * CHAIN_ATTENTION_DELAY_MS)
  admit(journal, 998, now - CHAIN_ATTENTION_DELAY_MS)
  admit(journal, 997, now - CHAIN_ATTENTION_DELAY_MS + 1)
  for (let issue = 1000; issue < 1101; issue++) admit(journal, issue, now)
  expect(journal.active().map(chain => chain.id)).not.toContain(oldest.id)
  const result = behaviorChainAttention(journal, now)
  expect(result.map(entry => entry.issue)).toEqual([999, 998])
  expect(result[0]).toMatchObject({ progressAt: now - 4 * CHAIN_ATTENTION_DELAY_MS, pullNumber: null,
    step: 'Issue admission', evidence: { state: 'unavailable' } })
})

it('advances the age when blocking outdated conversations resolve while live threads stay zero', () => {
  const journal = new BehaviorChainJournal(db)
  const admittedAt = now - 2 * CHAIN_ATTENTION_DELAY_MS
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const base: ChainObservation = { checkedAt: admittedAt + 60_000, existingPulls: [],
    issue: { open: true, eligible: true, revision: 'issue', commentIds: [] }, issueReviewers: [], prReviewers: [reviewer],
    implementer: reviewer, repairer: reviewer, approver: reviewer,
    publication: { pull_number: 910, head_sha: 'a'.repeat(40), head_invocation: null, state: 'open', merged: false, merge_sha: null },
    pull: { number: 910, head: 'a'.repeat(40), headSince: admittedAt + 60_000, state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, unresolvedOutdated: 1, approved: false, ready: false,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'findings', reviewContext: 'b'.repeat(64),
      greyRuns: [], checksState: 'SUCCESS', readinessBlockers: ['merge_state_not_clean'], pending: false, failing: [], conflict: false, behind: false } }
  let chain = admit(journal, 910, admittedAt)
  const firstAt = admittedAt + 60_000
  chain = append(journal, chain, { type: 'chain.observed', observation: { ...base, checkedAt: firstAt } }, firstAt)
  chain = append(journal, chain, { type: 'chain.held', reason: 'awaiting operator' }, firstAt + 60_000)
  const resolved = structuredClone(base) as ChainObservation
  resolved.pull!.unresolvedOutdated = 0
  resolved.pull!.readinessBlockers = []
  resolved.checkedAt = now
  chain = append(journal, chain, { type: 'chain.observed', observation: resolved }, now)
  const entry = behaviorChainAttention(journal, now).find(entry => entry.id === chain.id)!
  expect(entry.progressAt).toBe(now)
  expect(entry.ageMs).toBe(0)
  expect(entry.blocker).toContain('awaiting operator')
})

it('directs conflict or behind to repair before approval', () => {
  const journal = new BehaviorChainJournal(db)
  const admittedAt = now - 2 * CHAIN_ATTENTION_DELAY_MS
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  for (const [offset, flag] of [[0, 'conflict'], [1, 'behind']] as Array<[number, 'conflict' | 'behind']>) {
    const issue = 920 + offset
    const observation: ChainObservation = { checkedAt: admittedAt + 60_000, existingPulls: [],
      issue: { open: true, eligible: true, revision: 'issue', commentIds: [] }, issueReviewers: [], prReviewers: [reviewer],
      implementer: reviewer, repairer: reviewer, approver: reviewer,
      publication: { pull_number: issue + 10, head_sha: 'a'.repeat(40), head_invocation: null, state: 'open', merged: false, merge_sha: null },
      pull: { number: issue + 10, head: 'a'.repeat(40), headSince: admittedAt + 60_000, state: 'open', draft: false, merged: false, mergeSha: null,
        queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
        reviewIds: [], reviewReceipts: [], reviewRevision: 'findings', reviewContext: 'b'.repeat(64),
        greyRuns: [], checksState: 'SUCCESS', pending: false, failing: [], conflict: flag === 'conflict', behind: flag === 'behind' } }
    let chain = admit(journal, issue, admittedAt)
    chain = append(journal, chain, { type: 'chain.observed', observation }, admittedAt + 60_000)
    chain = append(journal, chain, { type: 'chain.observed', observation: { ...structuredClone(observation), checkedAt: now } }, now)
    const entry = behaviorChainAttention(journal, now).find(entry => entry.id === chain.id)!
    expect(entry.nextAction).toContain('Repair the branch conflict or required base update')
    expect(entry.evidence.state).toBe('fresh')
  }
})

it('advances the age on verified recovery without clearing a durable hold or missing original receipt', () => {
  const journal = new BehaviorChainJournal(db)
  delayedChainFixture(journal, now)
  let chain = journal.read('autonomio/poise#898')!
  const observation = structuredClone(chain.observation) as ChainObservation
  Object.assign(observation.pull!, { failing: [], checksState: 'SUCCESS', approved: true })
  chain = append(journal, chain, { type: 'chain.observed', observation })
  const entry = behaviorChainAttention(journal, now).find(entry => entry.id === chain.id)!
  expect(entry.ageMs).toBe(0)
  expect(entry.blocker).toContain('required CI shard failed')
  expect(entry.retryAt).toBeNull()
  expect(journal.read(chain.id)!.held).toBe(chain.held)
  chain = append(journal, chain, { type: 'chain.resumed' })
  expect(behaviorChainAttention(journal, now).map(entry => entry.id)).not.toContain(chain.id)
})

it.each(['stale', 'wrong-head', 'incomplete', 'future'] as const)('keeps %s PR evidence explicit without resetting progress', kind => {
  const journal = new BehaviorChainJournal(db)
  const first = delayedChainFixture(journal, now).attention[0]
  let chain = journal.read(first.id)!
  const observation = structuredClone(chain.observation) as ChainObservation
  if (kind === 'stale') observation.checkedAt -= 120_001
  if (kind === 'future') observation.checkedAt++
  if (kind === 'wrong-head') observation.publication.head_sha = 'b'.repeat(40)
  if (kind === 'incomplete') observation.pull = { ...observation.pull!, reviewReceipts: undefined } as unknown as ChainObservation['pull']
  chain = append(journal, chain, { type: 'chain.observed', observation })
  const entry = behaviorChainAttention(journal, now).find(entry => entry.id === chain.id)!
  expect(entry.evidence.state).toBe(kind === 'stale' ? 'stale' : 'incomplete')
  expect(entry.progressAt).toBe(first.progressAt)
  expect(entry.blocker).toContain('incomplete review replies')
})

it('distinguishes known retry eligibility from a hold and an unknown provider backoff', () => {
  const journal = new BehaviorChainJournal(db)
  let chain = admit(journal, 7, now - 2 * CHAIN_ATTENTION_DELAY_MS)
  chain = append(journal, chain, { type: 'invocation.admitted', invocation: { id: 'failed', behavior: 'implement-issue', actor: chain.author,
    model: 'fixture', slot: 'primary', basis: 'issue', admittedAt: now - 1000,
    request: { command: 'agent-interface', cwd: '/isolated/fixture', argv: [] } } })
  chain = append(journal, chain, { type: 'invocation.settled', invocationId: 'failed', callId: 'failed', outcome: 'preflight_failed',
    evidence: { status: 'failed', action: 'not_started', completedAt: now } })
  chain = append(journal, chain, { type: 'chain.waiting', reason: 'implement-issue is in native failure backoff' })
  expect(behaviorChainAttention(journal, now)[0]).toMatchObject({ retryAt: now + 60_000,
    step: 'implement-issue is in native failure backoff',
    progressAt: now - 2 * CHAIN_ATTENTION_DELAY_MS, nextAction: 'Automatic retry eligible after backoff, subject to existing admission gates' })
  chain = append(journal, chain, { type: 'chain.waiting', reason: 'implement-issue is waiting for native provider backoff' })
  expect(behaviorChainAttention(journal, now)[0].retryAt).toBeNull()
  chain = append(journal, chain, { type: 'chain.waiting', reason: 'implement-issue is in native failure backoff' })
  chain = append(journal, chain, { type: 'chain.resumed' })
  expect(behaviorChainAttention(journal, now)[0].retryAt).toBeNull()
  append(journal, chain, { type: 'chain.held', reason: 'person intervention required' })
  expect(behaviorChainAttention(journal, now)[0].retryAt).toBeNull()
})

it('retains pending original evidence after a merge and clears only verified completion', () => {
  new BehaviorChainJournal(db)
  const pending = chainSummaryFixture('pending-original-response').attention
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({ step: 'merge-pr: uncertain', retryAt: null,
    nextAction: 'Reconcile original pre-merge review evidence; no new invocation can start after merge' })
  expect(pending[0].blocker).toContain('original response missing')
  expect(chainSummaryFixture('complete').attention).toEqual([])
})

it('preserves age when readiness gains a non-conversation blocker with unchanged threads', () => {
  const journal = new BehaviorChainJournal(db)
  const admittedAt = now - 2 * CHAIN_ATTENTION_DELAY_MS
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const base: ChainObservation = { checkedAt: admittedAt + 60_000, existingPulls: [],
    issue: { open: true, eligible: true, revision: 'issue', commentIds: [] }, issueReviewers: [], prReviewers: [reviewer],
    implementer: reviewer, repairer: reviewer, approver: reviewer,
    publication: { pull_number: 930, head_sha: 'a'.repeat(40), head_invocation: null, state: 'open', merged: false, merge_sha: null },
    pull: { number: 930, head: 'a'.repeat(40), headSince: admittedAt + 60_000, state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, unresolvedOutdated: 1, approved: false, ready: false,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'findings', reviewContext: 'b'.repeat(64),
      greyRuns: [], checksState: 'SUCCESS', readinessBlockers: ['merge_state_not_clean'], pending: false, failing: [], conflict: false, behind: false } }
  let chain = admit(journal, 930, admittedAt)
  const firstAt = admittedAt + 60_000
  chain = append(journal, chain, { type: 'chain.observed', observation: { ...base, checkedAt: firstAt } }, firstAt)
  chain = append(journal, chain, { type: 'chain.held', reason: 'awaiting operator' }, firstAt + 60_000)
  const regressed = structuredClone(base) as ChainObservation
  regressed.pull!.readinessBlockers = ['merge_state_not_clean', 'required_checks_not_green']
  regressed.checkedAt = now
  chain = append(journal, chain, { type: 'chain.observed', observation: regressed }, now)
  const entry = behaviorChainAttention(journal, now).find(entry => entry.id === chain.id)!
  expect(entry.progressAt).toBe(firstAt)
  expect(entry.ageMs).toBe(now - firstAt)
  expect(entry.blocker).toContain('awaiting operator')
})

it('directs pending CI to repair-pr diagnosis when stuck and to waiting when fresh', () => {
  const journal = new BehaviorChainJournal(db)
  const admittedAt = now - 2 * CHAIN_ATTENTION_DELAY_MS
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const makeObservation = (headSince: number): ChainObservation => ({ checkedAt: admittedAt + 60_000, existingPulls: [],
    issue: { open: true, eligible: true, revision: 'issue', commentIds: [] }, issueReviewers: [], prReviewers: [reviewer],
    implementer: reviewer, repairer: reviewer, approver: reviewer,
    publication: { pull_number: 940, head_sha: 'a'.repeat(40), head_invocation: null, state: 'open', merged: false, merge_sha: null },
    pull: { number: 940, head: 'a'.repeat(40), headSince, state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'findings', reviewContext: 'b'.repeat(64),
      greyRuns: [], checksState: 'PENDING', readinessBlockers: [], pending: true, failing: [], conflict: false, behind: false } })
  let stuck = admit(journal, 940, admittedAt)
  stuck = append(journal, stuck, { type: 'chain.observed', observation: makeObservation(now - 31 * 60_000) }, admittedAt + 60_000)
  stuck = append(journal, stuck, { type: 'chain.observed',
    observation: { ...makeObservation(now - 31 * 60_000), checkedAt: now } }, now)
  let fresh = admit(journal, 941, admittedAt)
  const freshObservation = makeObservation(now - 5 * 60_000)
  freshObservation.publication = { pull_number: 941, head_sha: 'b'.repeat(40), head_invocation: null, state: 'open', merged: false, merge_sha: null }
  freshObservation.pull = { ...freshObservation.pull!, number: 941, head: 'b'.repeat(40) }
  fresh = append(journal, fresh, { type: 'chain.observed', observation: freshObservation }, admittedAt + 60_000)
  fresh = append(journal, fresh, { type: 'chain.observed', observation: { ...structuredClone(freshObservation), checkedAt: now } }, now)
  const entries = behaviorChainAttention(journal, now)
  const stuckEntry = entries.find(entry => entry.id === stuck.id)!
  expect(stuckEntry.evidence.state).toBe('fresh')
  expect(stuckEntry.nextAction).toContain('pending over 30 minutes')
  expect(stuckEntry.nextAction).not.toContain('approval')
  const freshEntry = entries.find(entry => entry.id === fresh.id)!
  expect(freshEntry.evidence.state).toBe('fresh')
  expect(freshEntry.nextAction).toContain('Await exact-head CI')
  expect(freshEntry.nextAction).not.toContain('approval')
})

it('advances on an accepted queue receipt while retaining unverified merge completion', () => {
  const journal = new BehaviorChainJournal(db)
  delayedChainFixture(journal, now)
  let chain = journal.read('autonomio/poise#887')!
  chain = append(journal, chain, { type: 'chain.resumed' })
  chain = append(journal, chain, { type: 'invocation.admitted', invocation: { id: 'queue', behavior: 'merge-pr', actor: chain.reviewer,
    model: null, slot: null, basis: 'merge', admittedAt: now,
    request: { command: 'github-interface', cwd: '/isolated/fixture', argv: ['--merge-if-ready', '893',
      '--expected-head', 'a'.repeat(40), '--token-user', chain.reviewer] } } })
  const proof = nativeActionReceipt(chain, chain.invocations.at(-1)!, { action: 'merge_if_ready', repository: chain.repository,
    pull_number: 893, head_sha: 'a'.repeat(40), outcome: 'enqueued', queue_entry_id: 'entry' }, now)
  chain = append(journal, chain, { type: 'invocation.settled', invocationId: 'queue', callId: null, outcome: 'enqueued',
    evidence: nativeActionSettlement(proof) })
  chain = append(journal, chain, { type: 'chain.held', reason: 'Await original merge evidence' })
  expect(behaviorChainAttention(journal, now).find(entry => entry.id === chain.id)!.progressAt).toBe(now)
  const observation = structuredClone(chain.observation) as ChainObservation
  observation.pull!.queueEntry = 'entry'
  const later = now + 2 * CHAIN_ATTENTION_DELAY_MS
  observation.checkedAt = later
  chain = append(journal, chain, { type: 'chain.observed', observation }, later)
  expect(behaviorChainAttention(journal, later).find(entry => entry.id === chain.id)).toMatchObject({
    progressAt: now, ageMs: 2 * CHAIN_ATTENTION_DELAY_MS,
    evidence: { gates: expect.arrayContaining(['Native queue owns the candidate; merge completion unverified']) } })
  expect(journal.read(chain.id)!.mergeSha).toBeNull()
})
