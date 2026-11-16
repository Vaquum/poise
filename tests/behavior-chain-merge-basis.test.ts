import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { BehaviorChainJournal, chainBasis, type ChainEvent } from '../server/behavior-chain-store'
import { chainMergeReviewDecision, chainReviewClearance, chainReviewResponse, decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { completedReviewCall } from './review-response-fixture'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers() })
const HEAD = 'a'.repeat(40)
const MERGE = 'c'.repeat(40)
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }

function setup(path = ':memory:') {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000)
  const db = new Database(path); databases.push(db)
  const journal = new BehaviorChainJournal(db)
  let chain = journal.append('acme/repo#7', 'seed', 0, { type: 'chain.admitted', repository: 'acme/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  const call = completedReviewCall(chain.repository, 17, HEAD, chain.reviewer)
  const observation: ChainObservation = { checkedAt: Date.now(), existingPulls: [], issue: { open: true, eligible: true, revision: 'issue', commentIds: [] },
    issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer,
    publication: { pull_number: 17, head_sha: HEAD, head_invocation: 'implementation', state: 'open', merged: false, merge_sha: null },
    pull: { number: 17, head: HEAD, headSince: Date.now(), state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: true, ready: true,
      reviewIds: [call.review_id!], reviewRevision: 'review', reviewContext: 'b'.repeat(64), reviewReceipts: [{ id: call.review_id!,
        head: HEAD, state: 'COMMENTED', invocation: call.id, response: call.artifact!.review_response, submittedAt: Date.now() }],
      greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }
  const record = (event: ChainEvent) => { chain = journal.append(chain.id, `event-${chain.sequence}`, chain.sequence, event); return chain }
  record({ type: 'invocation.admitted', invocation: { id: 'original-review', behavior: 'review-pr',
    actor: chain.reviewer, model: call.model, slot: 'primary', basis: chainBasis(['pr', HEAD, observation.pull!.reviewContext]),
    admittedAt: Date.parse(call.started_at), request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  record({ type: 'invocation.settled', invocationId: 'original-review', callId: call.id, outcome: 'clean',
    evidence: { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: call.review_id,
      head_sha: HEAD, completedAt: Date.parse(call.completed_at!), artifact: call.artifact,
      resources_settled_at: call.completed_at, resource_ownership: { version: 1, roots: [], errors: [] } } })
  function merge(live: ChainObservation) {
    vi.setSystemTime(Date.now() + 1000)
    return { ...structuredClone(live), checkedAt: Date.now(), pull: { ...live.pull!, merged: true, state: 'closed', mergeSha: MERGE,
      mergedAt: Date.now() - 500 } }
  }
  return { db, journal, record, observation, merge, call, current: () => chain }
}

function reconciliation(live: ChainObservation): ChainRuntimeOperations {
  const forbidden = async () => { throw new Error('merge reconciliation cannot start work') }
  return { enabled: () => false, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    discover: async () => [], ownsRepository: () => true, observe: async () => ({ ...live, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [], quarantined: [] }), received: () => {}, available: () => false, capacity: () => 3,
    permitted: () => false, request: forbidden, launch: forbidden, perform: forbidden, readActionResult: forbidden,
    resumePublication: forbidden, fenceClosedTarget: forbidden, wake: () => {} }
}

it('reopens a journal written by the pre-coverage reducer and recovers its actual native merge admission without rewriting history', async () => {
  // Rows and hashes were frozen using the unmodified reducer at this revision,
  // before #1540. Neither the writer nor today's reducer generates this proof.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/pre-coverage-merge-journal.json', import.meta.url), 'utf8')) as {
    revision: string, rows: Array<{ sequence: number, chain_id: string, event_id: string, at: number, payload: string, state_hash: string }>
  }
  expect(fixture.revision).toBe('20edd6aecfc963f6979f7f78b33c752dc8104cb1')
  const root = mkdtempSync(join(tmpdir(), 'poise-pre-coverage-'))
  try {
    const path = join(root, 'journal.db'), original = new Database(path)
    new BehaviorChainJournal(original)
    const insert = original.prepare('INSERT INTO behavior_chain_events(sequence, chain_id, event_id, at, payload, state_hash) VALUES (@sequence, @chain_id, @event_id, @at, @payload, @state_hash)')
    for (const row of fixture.rows) insert.run(row)
    original.close()
    const db = new Database(path); databases.push(db)
    const journal = new BehaviorChainJournal(db)
    journal.rebuild()
    const id = 'acme/repo#7', historical = journal.read(id)!
    expect(historical.invocations.every(invocation => !invocation.reviewDecision)).toBe(true)
    const live = structuredClone(historical.observation) as ChainObservation
    vi.useFakeTimers(); vi.setSystemTime(live.checkedAt + 86400_000)
    live.issue.intakeLabel = 'poise'
    live.prReviewers.push({ ...reviewer, slot: 'secondary' })
    const open = { ...live, pull: { ...live.pull!, state: 'open', merged: false } }
    expect(chainReviewResponse(historical, historical.invocations[0], open, Date.now())).toBeNull()
    expect(chainReviewClearance(historical, open, Date.now())).toContain('lacks its current-head/context receipt')
    expect(chainMergeReviewDecision(historical, open, Date.now())).toBeNull()
    await new BehaviorChainRuntime(journal, reconciliation(live)).run()
    expect(journal.read(id)).toMatchObject({ mergeSha: MERGE, reviewPending: false, invocations: historical.invocations })
    expect(journal.read(id)?.reviewHoldClosure).toBeUndefined()
    journal.rebuild()
    expect(db.prepare('SELECT * FROM behavior_chain_events ORDER BY sequence LIMIT ?').all(fixture.rows.length)).toEqual(fixture.rows)
    expect(journal.read(id)?.reviewPending).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('retains the versioned panel and receipt identities at actual native merge admission and uses them after restart', async () => {
  const { journal, observation, merge, call, current } = setup()
  const request = { command: 'github-interface' as const, cwd: '/fixture', argv: ['--merge-if-ready', '17', '--author', 'author',
    '--review-response-json', JSON.stringify({ ...call.artifact!.review_response as object, review_id: call.review_id }),
    '--expected-head', HEAD, '--token-user', 'reviewer'] }
  const operations = { ...reconciliation(observation), enabled: () => true, available: () => true, permitted: () => true,
    request: async () => request, perform: async () => ({ action: 'merge_if_ready', repository: 'acme/repo', pull_number: 17,
      head_sha: HEAD, outcome: 'enqueued', queue_entry_id: 'queue', merged: false }) }
  await new BehaviorChainRuntime(journal, operations).run()
  const admitted = journal.read(current().id)!.invocations.at(-1)!
  expect(admitted).toMatchObject({ behavior: 'merge-pr', state: 'settled', request,
    reviewDecision: { version: 2, repository: 'acme/repo', number: 17, head: HEAD, context: observation.pull!.reviewContext,
      panel: [{ slot: 'primary', model: 'fixture', invocation: 'original-review', call: call.id, review: call.review_id,
        response: chainBasis(call.artifact!.review_response) }],
      final: { invocation: 'original-review', call: call.id, review: call.review_id } } })
  expect(admitted.request).not.toHaveProperty('reviewDecision')
  // A later settings change before the merge must not replace the admitted panel.
  const later = structuredClone(observation)
  later.prReviewers.push({ ...reviewer, slot: 'secondary' })
  let saved = journal.read(current().id)!
  saved = journal.append(saved.id, 'later-panel', saved.sequence, { type: 'chain.observed', observation: later })
  const live = merge(later)
  const authority = journal.history(saved.id)
  journal.rebuild()
  await new BehaviorChainRuntime(journal, reconciliation(live)).run()
  expect(journal.read(saved.id)).toMatchObject({ mergeSha: MERGE, reviewPending: false })
  expect(journal.read(saved.id)?.invocations.at(-1)?.reviewDecision).toEqual(admitted.reviewDecision)
  expect(journal.history(saved.id).slice(0, authority.length)).toEqual(authority)
})

it.each(['no admission', 'wrong review', 'wrong repository', 'wrong PR', 'wrong head', 'wrong context', 'wrong Call',
  'wrong panel', 'late admission', 'late submission', 'altered response', 'incomplete coverage'])(
  'does not infer legacy authority from absent coverage with %s', mode => {
    const { record, observation, merge, current, call } = setup()
    const response = call.artifact!.review_response as Record<string, unknown>
    delete response.coverage
    observation.pull!.reviewReceipts[0].response = response
    // The fixture's persisted Call must carry the same old-format response.
    const chain = structuredClone(current())
    ;(chain.invocations[0].evidence!.artifact as { review_response: unknown }).review_response = response
    const pinned: Record<string, unknown> = { ...response, review_id: call.review_id }
    if (mode === 'wrong review') pinned.review_id = 99
    if (mode === 'wrong repository') pinned.repository = 'other/repo'
    if (mode === 'wrong PR') pinned.pull_number = 18
    if (mode === 'wrong head') pinned.head_sha = 'e'.repeat(40)
    if (mode === 'wrong context') pinned.context_sha = 'e'.repeat(64)
    if (mode === 'wrong Call') pinned.invocation_id = 'e'.repeat(32)
    if (mode === 'altered response') pinned.assessment = { verdict: 'A changed verdict without original acceptance.' }
    if (mode === 'incomplete coverage') response.coverage = pinned.coverage = 'incomplete'
    record({ type: 'chain.observed', observation })
    const live = merge(observation)
    if (mode === 'late submission') live.pull.reviewReceipts[0].submittedAt = live.pull.mergedAt! + 1
    if (mode === 'wrong panel') observation.prReviewers.push({ ...reviewer, slot: 'secondary' })
    if (mode !== 'no admission') chain.invocations.push({ id: 'native-merge', behavior: 'merge-pr', actor: chain.reviewer,
      model: null, slot: null, basis: 'merge', admissionSequence: chain.sequence + 2,
      admittedAt: mode === 'late admission' ? live.pull.mergedAt! + 1 : observation.checkedAt,
      request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', '17', '--author', chain.author,
        '--review-response-json', JSON.stringify(pinned), '--expected-head', HEAD, '--token-user', chain.reviewer] },
      state: 'settled', callId: null, outcome: 'enqueued', evidence: { status: 'completed' } })
    chain.observation = observation
    expect(decideBehaviorChain(chain, live, Date.now())).toMatchObject({ kind: 'hold' })
    expect(chainReviewResponse(chain, chain.invocations[0], observation, Date.now())).toBeNull()
  })

it('does not discharge an old obligation when the PR context is restored after merge', () => {
  const { record, observation, merge, current } = setup()
  const before = structuredClone(observation)
  before.pull!.reviewContext = 'd'.repeat(64)
  record({ type: 'chain.observed', observation: before })
  expect(decideBehaviorChain(current(), merge(observation), Date.now())).toMatchObject({ kind: 'hold' })
})

it('does not discharge the original two-slot panel when current settings require one', () => {
  const { record, observation, merge, current } = setup()
  const before = structuredClone(observation)
  before.prReviewers.push({ ...reviewer, slot: 'secondary' })
  record({ type: 'chain.observed', observation: before })
  expect(decideBehaviorChain(current(), merge(observation), Date.now())).toMatchObject({ kind: 'hold' })
})

it('does not substitute the last open context for a changed merged context', () => {
  const { record, observation, merge, current } = setup()
  record({ type: 'chain.observed', observation: structuredClone(observation) })
  const live = merge(observation)
  live.pull.reviewContext = 'd'.repeat(64)
  expect(decideBehaviorChain(current(), live, Date.now())).toMatchObject({ kind: 'hold' })
})

it('retains a mismatch seen at the first merge after the live context is restored', async () => {
  const { journal, record, observation, merge, current } = setup()
  record({ type: 'chain.observed', observation: structuredClone(observation) })
  const live = merge(observation)
  live.pull.reviewContext = 'd'.repeat(64)
  const forbidden = async () => { throw new Error('merged evidence reconciliation cannot start work') }
  const operations: ChainRuntimeOperations = { enabled: () => false, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    discover: async () => [], ownsRepository: () => true, observe: async () => structuredClone(live),
    readInvocations: async () => ({ entries: [], quarantined: [] }), received: () => {}, available: () => false, capacity: () => 3,
    permitted: () => false, request: forbidden, launch: forbidden, perform: forbidden, readActionResult: forbidden, resumePublication: forbidden, fenceClosedTarget: forbidden, wake: () => {} }
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  expect(journal.read(current().id)).toMatchObject({ mergeSha: MERGE, reviewPending: true })
  live.pull.reviewContext = observation.pull!.reviewContext
  await runtime.run()
  journal.rebuild()
  expect(journal.read(current().id)).toMatchObject({ mergeSha: MERGE, reviewPending: true })
})

it('allows newly visible original pre-merge evidence against the original panel despite a later settings increase', () => {
  const { record, observation, merge, current } = setup()
  const before = structuredClone(observation)
  before.pull!.reviewReceipts = []; before.pull!.reviewIds = []
  record({ type: 'chain.observed', observation: before })
  const live = merge(observation)
  live.prReviewers.push({ ...reviewer, slot: 'secondary' })
  expect(decideBehaviorChain(current(), live, Date.now())).toEqual({ kind: 'complete', mergeSha: MERGE })
})

it('keeps missing historical basis and an empty recorded panel unproven', () => {
  const { record, observation, merge, current } = setup()
  const live = merge(observation)
  expect(decideBehaviorChain(current(), live, Date.now())).toMatchObject({ kind: 'hold' })
  const before = structuredClone(observation)
  before.prReviewers = []
  record({ type: 'chain.observed', observation: before })
  expect(decideBehaviorChain(current(), live, Date.now())).toMatchObject({ kind: 'hold' })
})

it('does not accept a later submission or a different merged head as original review proof', () => {
  const { record, observation, merge, current } = setup()
  record({ type: 'chain.observed', observation: structuredClone(observation) })
  const live = merge(observation)
  live.pull.reviewReceipts[0].submittedAt = live.pull.mergedAt! + 1
  expect(decideBehaviorChain(current(), live, Date.now())).toMatchObject({ kind: 'hold' })
  live.pull.reviewReceipts[0].submittedAt = live.pull.mergedAt! - 1
  live.pull.head = 'e'.repeat(40)
  expect(decideBehaviorChain(current(), live, Date.now())).toMatchObject({ kind: 'hold' })
})

it('recovers late original visibility through the runtime without a replacement worker or current-roster authority', async () => {
  const { journal, record, observation, merge, current } = setup()
  const before = structuredClone(observation)
  before.pull!.reviewReceipts = []; before.pull!.reviewIds = []
  record({ type: 'chain.observed', observation: before })
  const live = merge(observation)
  live.prReviewers.push({ ...reviewer, slot: 'secondary' })
  const launch = vi.fn(async () => { throw new Error('a merged chain cannot launch a worker') })
  const operations: ChainRuntimeOperations = { enabled: () => false, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    discover: async () => [], ownsRepository: () => true, observe: async () => live,
    readInvocations: async () => ({ entries: [], quarantined: [] }), received: () => {}, available: () => false, capacity: () => 3,
    permitted: () => false, request: launch, launch, perform: launch, readActionResult: launch, resumePublication: launch, fenceClosedTarget: launch, wake: () => {} }
  await new BehaviorChainRuntime(journal, operations).run()
  expect(journal.read(current().id)).toMatchObject({ mergeSha: MERGE, reviewPending: false })
  expect(launch).not.toHaveBeenCalled()
})

it('retains the original basis across later observations, projection rebuild and reopening the database', () => {
  const root = mkdtempSync(join(tmpdir(), 'poise-merge-basis-'))
  const path = join(root, 'journal.db')
  try {
    const { db, journal, record, observation, merge, current } = setup(path)
    const before = structuredClone(observation)
    before.prReviewers.push({ ...reviewer, slot: 'secondary' })
    record({ type: 'chain.observed', observation: before })
    const live = merge(observation)
    record({ type: 'chain.observed', observation: live })
    record({ type: 'chain.merged', mergeSha: MERGE, evidence: { repository: 'acme/repo', pull_number: 17,
      merged: true, merge_sha: MERGE, review_complete: false } })
    for (let repeat = 0; repeat < 10; repeat++) record({ type: 'chain.observed', observation: live })
    const authority = db.prepare('SELECT sequence, payload, state_hash FROM behavior_chain_events ORDER BY sequence').all()
    expect(journal.preMergeObservation(current().id, live.pull.mergedAt!)).toEqual(before)
    journal.rebuild()
    expect(db.prepare('SELECT sequence, payload, state_hash FROM behavior_chain_events ORDER BY sequence').all()).toEqual(authority)
    const id = current().id
    db.close(); databases.splice(databases.indexOf(db), 1)
    const reopened = new Database(path); databases.push(reopened)
    const retained = new BehaviorChainJournal(reopened)
    const basis = retained.preMergeObservation(id, live.pull.mergedAt!) as ChainObservation | null
    expect(basis).toEqual(before)
    expect(decideBehaviorChain(retained.read(id)!, live, Date.now(), {
      before: basis, firstMerged: retained.firstMergedObservation(id) as ChainObservation | null,
    })).toMatchObject({ kind: 'hold' })
    expect(retained.read(id)).toMatchObject({ mergeSha: MERGE, reviewPending: true })
    reopened.close(); databases.splice(databases.indexOf(reopened), 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('does not turn a later observation with a backdated clock into missing pre-merge authority', () => {
  const { journal, record, observation, merge, current } = setup()
  const live = merge(observation)
  record({ type: 'chain.merged', mergeSha: MERGE, evidence: { repository: 'acme/repo', pull_number: 17,
    merged: true, merge_sha: MERGE, review_complete: false } })
  vi.setSystemTime(live.pull.mergedAt! - 10)
  record({ type: 'chain.observed', observation })
  expect(journal.preMergeObservation(current().id, live.pull.mergedAt!)).toBeNull()
})
