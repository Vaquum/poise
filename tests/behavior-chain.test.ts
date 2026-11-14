import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BehaviorChainJournal, chainBasis, chainIdentity, type BehaviorChain, type ChainAdmission, type ChainEvent, type ChainInvocation } from '../server/behavior-chain-store'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { behaviorChainAttention, CHAIN_ATTENTION_DELAY_MS, chainProgress, chainProgressOf } from '../server/behavior-chain-summary'
import type { LogEntry } from '../server/agent-log-parse'
import { CheckSemaphore } from '../server/check-semaphore'
import { nativeRequestSha } from '../server/behavior-chain-action'

const NOW = 1_800_000_000_000
const HEAD = '1'.repeat(40)
const NEXT = '2'.repeat(40)
const MERGE = '3'.repeat(40)
const CONTEXT = '4'.repeat(64)
const REVIEWER = { slot: 'primary', model: 'fixture-model', recovery: 'fixture-model' }
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup(): { db: Database.Database, journal: BehaviorChainJournal, chain: BehaviorChain } {
  const db = new Database(':memory:'); databases.push(db)
  const journal = new BehaviorChainJournal(db)
  const id = chainIdentity('Example/Repo', 7)
  const chain = journal.append(id, 'seed', 0, { type: 'chain.admitted', repository: 'Example/Repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW)
  return { db, journal, chain }
}
function observation(): ChainObservation {
  return { checkedAt: NOW, existingPulls: [], issue: { open: true, eligible: true, revision: chainBasis(['title', 'body']), commentIds: [17, 18, 19] },
    prerequisites: { wait: null, base: HEAD, evidence: [] },
    issueReviewers: [REVIEWER], prReviewers: [REVIEWER], implementer: REVIEWER, repairer: REVIEWER, approver: REVIEWER,
    publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null }, pull: null }
}
function record(journal: BehaviorChainJournal, chain: BehaviorChain, event: ChainEvent): BehaviorChain {
  return journal.append(chain.id, `event-${chain.sequence}`, chain.sequence, event, NOW)
}
function invocation(id: string, behavior: ChainInvocation['behavior'], basis: string, slot: string | null = 'primary'): ChainAdmission {
  return { id, behavior, basis, actor: behavior === 'implement-issue' || behavior === 'repair-pr' ? 'author' : 'reviewer',
    model: 'fixture-model', slot, admittedAt: NOW, request: { command: 'agent-interface', argv: ['--fixture'], cwd: '/fixture' } }
}
function finish(journal: BehaviorChainJournal, chain: BehaviorChain, id: string, behavior: ChainInvocation['behavior'], basis: string,
  evidence: Record<string, unknown>, slot: string | null = 'primary'): BehaviorChain {
  const callId = ['review-pr', 'approve-pr'].includes(behavior) ? chainBasis(id).slice(0, 32) : id
  if (['review-pr', 'approve-pr'].includes(behavior)) evidence = { ...evidence, completedAt: NOW,
    artifact: { review_response: reviewResponse(callId, String(evidence.head_sha)) } }
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: invocation(id, behavior, basis, slot) })
  chain = record(journal, chain, { type: 'invocation.started', invocationId: id })
  return record(journal, chain, { type: 'invocation.settled', invocationId: id, callId, outcome: String(evidence.outcome), evidence })
}
function reviewResponse(callId: string, head = HEAD) {
  return { repository: 'Example/Repo', pull_number: 21, head_sha: head, context_sha: CONTEXT,
    invocation_id: callId, reviewer: 'reviewer', model: 'fixture-model', completed_at: NOW,
    assessment: { verdict: 'The changed validation has no remaining blocking defects.',
      reviewed_context: 'Inspected the immutable diff and affected callers.', limitations: 'No live provider calls.' } }
}
function reviewed(journal: BehaviorChainJournal, chain: BehaviorChain, obs: ChainObservation, slot = 'primary', comment = 17): BehaviorChain {
  return finish(journal, chain, `issue-${slot}`, 'review-issue', chainBasis(['issue', obs.issue.revision]),
    { status: 'completed', action: 'commented', outcome: 'commented', issue_revision: obs.issue.revision,
      receipts: [{ issue: 'Example/Repo#7', comment_id: comment, author: 'reviewer' }] }, slot)
}
function pull(obs: ChainObservation): void {
  obs.publication = { pull_number: 21, head_sha: HEAD, head_invocation: 'implementation', state: 'open', merged: false, merge_sha: null }
  obs.pull = { number: 21, head: HEAD, headSince: NOW, state: 'open', draft: false, merged: false, mergeSha: null,
    queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
    reviewIds: [27], reviewContext: CONTEXT, mergedAt: NOW,
    reviewReceipts: [['pr-review', 27], ['verify-integration-repair', 28]].map(([id, number]) => ({
      id: Number(number), head: HEAD, state: number === 28 ? 'APPROVED' : 'COMMENTED', invocation: chainBasis(id).slice(0, 32), submittedAt: NOW,
      response: reviewResponse(chainBasis(id).slice(0, 32)) })),
    reviewRevision: 'findings-1', greyRuns: [], pending: false, failing: [], conflict: false, behind: false }
}

describe('progress clock', () => {
  it('continues a chain’s clock over its new events only, as a replay from the start reads it', () => {
    const { journal, chain } = setup()
    const observed = (change: (obs: ChainObservation) => void) => { const obs = observation(); pull(obs); change(obs); return obs }
    let current = record(journal, chain, { type: 'chain.observed', observation: observed((obs) => { obs.pull!.pending = true; obs.pull!.checksState = 'PENDING' }) })
    current = record(journal, current, { type: 'chain.observed', observation: observed((obs) => { obs.pull!.checksState = 'SUCCESS' }) })
    const replay = () => chainProgressOf(journal.history(chain.id).map((row) => ({ sequence: row.sequence, at: row.at, event: JSON.parse(row.payload) as ChainEvent })), chain.id, undefined, true)
    const first = chainProgress(journal, chain.id, undefined, true)
    expect(first).toEqual(replay())
    expect(first.advances.length).toBeGreaterThan(0)
    const before = current.sequence
    current = record(journal, current, { type: 'chain.observed', observation: observed((obs) => { obs.pull!.checksState = 'SUCCESS'; obs.pull!.approved = true }) })
    current = record(journal, current, { type: 'chain.held', reason: 'person stopped it' })
    current = record(journal, current, { type: 'chain.observed', observation: observed((obs) => {
      obs.publication.head_sha = NEXT; obs.pull!.head = NEXT; obs.pull!.checksState = 'SUCCESS' }) })
    const read = vi.spyOn(journal, 'history')
    const next = chainProgress(journal, chain.id, undefined, true)
    expect(read.mock.calls.map(([, after]) => after)).toEqual([before])
    read.mockRestore()
    expect(next).toEqual(replay())
    expect(next.advances.length).toBeGreaterThan(first.advances.length)
    // What a caller is handed is its own: changing it never changes the clock kept.
    next.advances[0].at = 0
    next.advances[0].sequence = 0
    next.advances.length = 1
    expect(chainProgress(journal, chain.id, undefined, true)).toEqual(replay())
    // A failed invocation's view is still read from the start.
    expect(chainProgress(journal, chain.id, 'missing')).toEqual(chainProgressOf(journal.history(chain.id).map((row) => ({ sequence: row.sequence, at: row.at, event: JSON.parse(row.payload) as ChainEvent })), chain.id, 'missing'))
  })
})

describe('authoritative behavior journal', () => {
  it('reads a projection by its own text, one written another way the long way, and refuses any other state', () => {
    const { db, journal, chain } = setup()
    const next = record(journal, chain, { type: 'chain.held', reason: 'person stopped it' })
    expect(journal.read(chain.id)).toEqual(next)
    const stored = db.prepare('SELECT state FROM behavior_chain_current WHERE chain_id = ?').pluck().get(chain.id) as string
    const write = (state: string) => db.prepare('UPDATE behavior_chain_current SET state = ? WHERE chain_id = ?').run(state, chain.id)
    // The same state written with other spacing is still that state.
    write(JSON.stringify(JSON.parse(stored), null, 2))
    expect(journal.read(chain.id)).toEqual(next)
    // Another state is refused, however it is written.
    write(JSON.stringify({ ...JSON.parse(stored), held: 'someone else' }))
    expect(() => journal.read(chain.id)).toThrow(/disagrees with the authoritative event journal/)
    write(JSON.stringify({ ...JSON.parse(stored), held: 'someone else' }, null, 2))
    expect(() => journal.read(chain.id)).toThrow(/disagrees with the authoritative event journal/)
  })

  it('rebuilds every projection from immutable events and refuses corrupted authority', () => {
    const { db, journal, chain } = setup()
    const next = record(journal, chain, { type: 'chain.held', reason: 'person stopped it' })
    expect(() => db.prepare('DELETE FROM behavior_chain_events').run()).toThrow('immutable')
    expect(() => db.prepare("UPDATE behavior_chain_events SET payload = '{}' ").run()).toThrow('immutable')
    db.prepare("UPDATE behavior_chain_current SET state = '{}' ").run()
    expect(() => journal.read(chain.id)).toThrow('authoritative event journal')
    journal.rebuild()
    expect(journal.read(chain.id)).toEqual(next)
    db.prepare('DELETE FROM behavior_chain_current').run()
    expect(() => journal.read(chain.id)).toThrow('rebuild')
    journal.rebuild()
    expect(journal.read(chain.id)).toEqual(next)
  })

  it('makes duplicate triggers idempotent, conflicts loud and stale concurrent decisions unable to launch', () => {
    const { journal, chain } = setup()
    const event: ChainEvent = { type: 'chain.waiting', reason: 'CI is running' }
    const next = journal.append(chain.id, 'observation-1', chain.sequence, event, NOW)
    expect(journal.append(chain.id, 'observation-1', chain.sequence, event, NOW + 1)).toEqual(next)
    expect(() => journal.append(chain.id, 'observation-1', next.sequence, { type: 'chain.resumed' }, NOW)).toThrow('identity conflicts')
    expect(() => journal.append(chain.id, 'new', chain.sequence, { type: 'chain.resumed' }, NOW)).toThrow('changed before event admission')
  })

  it('retains ownership across restart and refuses a second invocation while an outcome is uncertain', () => {
    const { db, journal, chain } = setup()
    const admitted = record(journal, chain, { type: 'invocation.admitted', invocation: invocation('first', 'implement-issue', 'body') })
    const uncertain = record(journal, admitted, { type: 'invocation.uncertain', invocationId: 'first', reason: 'publication response lost' })
    const recovered = new BehaviorChainJournal(db); recovered.rebuild()
    expect(recovered.read(chain.id)).toEqual(uncertain)
    expect(() => record(recovered, uncertain, { type: 'invocation.admitted', invocation: invocation('duplicate', 'implement-issue', 'body') })).toThrow('already owns')
    expect(decideBehaviorChain(uncertain, observation(), NOW)).toMatchObject({ kind: 'wait' })
  })

  it('does not steal an existing Chat binding and never turns CLOSED or queue admission into merge completion', () => {
    const { db, journal, chain } = setup()
    db.exec('CREATE TABLE chat_work_bindings (target TEXT)')
    db.prepare('INSERT INTO chat_work_bindings VALUES (?)').run('https://github.com/example/repo/issues/8')
    expect(() => journal.append('example/repo#8', 'seed-8', 0, { type: 'chain.admitted', repository: 'Example/Repo', issue: 8,
      branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' }, NOW)).toThrow('already owned')
    expect(() => record(journal, chain, { type: 'chain.merged', mergeSha: MERGE,
      evidence: { repository: 'Example/Repo', pull_number: 21, state: 'closed', outcome: 'enqueued' } })).toThrow('verified GitHub merge artifact')
    expect(record(journal, chain, { type: 'chain.merged', mergeSha: MERGE,
      evidence: { repository: 'Example/Repo', pull_number: 21, merged: true, merge_sha: MERGE } }).mergeSha).toBe(MERGE)
  })
})

describe('completion-driven atomic behavior decisions', () => {
  it('keeps acknowledgements pending and rejects metadata, late and superseded response coverage', () => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    let current = reviewed(journal, chain, obs)
    const first = invocation('pr-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]))
    current = record(journal, current, { type: 'invocation.admitted', invocation: first })
    current = record(journal, current, { type: 'invocation.started', invocationId: first.id })
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'wait' })
    current = record(journal, current, { type: 'invocation.settled', invocationId: first.id,
      callId: chainBasis(first.id).slice(0, 32), outcome: 'clean', evidence: { status: 'completed', action: 'reviewed_clean',
        review_id: 27, head_sha: HEAD, completedAt: NOW } })
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'hold' })
    const valid = structuredClone(current)
    valid.invocations.at(-1)!.evidence!.artifact = { review_response: reviewResponse(chainBasis(first.id).slice(0, 32)) }
    expect(decideBehaviorChain(valid, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
    const late = structuredClone(valid)
    late.invocations.at(-1)!.evidence!.completedAt = NOW + 1
    expect(decideBehaviorChain(late, obs, NOW)).toMatchObject({ kind: 'hold' })
    obs.pull!.reviewContext = '5'.repeat(64)
    expect(decideBehaviorChain(valid, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
    obs.pull!.head = NEXT
    expect(decideBehaviorChain(valid, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
  })

  it('records an external merge separately and retains its open review obligation through rebuild', () => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    obs.pull!.merged = true; obs.pull!.mergeSha = MERGE; obs.pull!.state = 'closed'
    expect(decideBehaviorChain(chain, obs, NOW)).toMatchObject({ kind: 'hold', reason: expect.stringContaining('open review obligation') })
    const merged = record(journal, chain, { type: 'chain.merged', mergeSha: MERGE,
      evidence: { repository: chain.repository, pull_number: 21, merged: true, merge_sha: MERGE, review_complete: false } })
    expect(merged).toMatchObject({ mergeSha: MERGE, reviewPending: true })
    journal.rebuild()
    expect(journal.read(chain.id)).toEqual(merged)
    expect(journal.active().map(item => item.id)).toContain(chain.id)
  })

  it('requires every configured review slot and its actually posted comment before implementation, without a settle delay', () => {
    const { journal, chain } = setup(); const obs = observation()
    obs.issueReviewers = [REVIEWER, { ...REVIEWER, slot: 'secondary' }, { ...REVIEWER, slot: 'tertiary' }]
    expect(decideBehaviorChain(chain, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-issue', reviewer: { slot: 'primary' } })
    let current = reviewed(journal, chain, obs)
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-issue', reviewer: { slot: 'secondary' } })
    current = reviewed(journal, current, obs, 'secondary', 18)
    current = reviewed(journal, current, obs, 'tertiary', 19)
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'implement-issue' })
    obs.issue.commentIds.pop()
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'hold', reason: expect.stringContaining('posted GitHub comment') })
    obs.issue.revision = 'edited body'
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-issue' })
  })

  it('requires an actual current-head PR review, treats a new head as a fresh review cycle and retains strict CI/approval gates', () => {
    const { journal, chain } = setup(); const obs = observation()
    let current = reviewed(journal, chain, obs); pull(obs)
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]),
      { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 27, head_sha: HEAD })
    obs.pull!.pending = true
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'wait', reason: 'exact-head CI is still running' })
    obs.pull!.pending = false
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
    obs.pull!.approved = true; obs.pull!.ready = true
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'merge-pr' })
    obs.pull!.head = NEXT
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
  })

  it('repairs a first conflicting PR before spending review slots, then requires every review and the normal merge gates on the new head', () => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    let current = reviewed(journal, chain, obs)
    obs.prReviewers.push({ ...REVIEWER, slot: 'secondary' })
    Object.assign(obs.pull!, { conflict: true, reviewIds: [], reviewReceipts: [] })
    const repair = decideBehaviorChain(current, obs, NOW)
    expect(repair).toMatchObject({ kind: 'invoke', behavior: 'repair-pr', actor: 'author', reviewer: REVIEWER,
      basis: chainBasis(['repair', HEAD, [], true, false, false, 0, obs.pull!.reviewRevision, obs.issue.revision]) })
    if (repair.kind !== 'invoke') throw new Error('expected conflict repair')
    current = finish(journal, current, 'conflict-repair', 'repair-pr', repair.basis,
      { status: 'completed', action: 'published', outcome: 'published', head_sha: NEXT })
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'wait', reason: expect.stringContaining('repair-pr finished') })
    obs.publication.head_sha = NEXT; obs.publication.head_invocation = 'conflict-repair'
    obs.pull!.head = NEXT; obs.pull!.conflict = false
    obs.pull!.reviewRevision = 'repaired-findings'
    for (const [index, reviewer] of obs.prReviewers.entries()) {
      const basis = chainBasis(['pr', NEXT, CONTEXT])
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr', basis,
        reviewer: { slot: reviewer.slot } })
      const id = `repaired-${reviewer.slot}`
      current = finish(journal, current, id, 'review-pr', basis,
        { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 30 + index, head_sha: NEXT }, reviewer.slot)
      obs.pull!.reviewIds.push(30 + index)
      obs.pull!.reviewReceipts.push({ id: 30 + index, head: NEXT, state: 'COMMENTED', invocation: chainBasis(id).slice(0, 32),
        submittedAt: NOW, response: reviewResponse(chainBasis(id).slice(0, 32), NEXT) })
    }
    obs.pull!.pending = true
    expect(decideBehaviorChain(current, obs, NOW)).toEqual({ kind: 'wait', reason: 'exact-head CI is still running' })
    obs.pull!.pending = false
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
    obs.pull!.approved = true; obs.pull!.unresolved = 1
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'resolve-threads' })
    obs.pull!.unresolved = 0
    expect(decideBehaviorChain(current, obs, NOW)).toEqual({ kind: 'wait', reason: 'native repository readiness gates are not satisfied' })
    obs.pull!.ready = true
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'merge-pr' })
    obs.pull!.queueEntry = 'repaired-queue-entry'
    expect(decideBehaviorChain(current, obs, NOW)).toEqual({ kind: 'wait', reason: 'native merge queue owns entry repaired-queue-entry' })
  })

  it.each([
    ['started', 'review-pr is started'], ['uncertain', 'review-pr is uncertain'],
    ['held', 'operator hold'], ['queue', 'native merge queue owns'], ['stale', 'observations need refreshing'],
  ])('preserves the %s guard before conflict repair or PR review', (guard, reason) => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    let current = reviewed(journal, chain, obs)
    Object.assign(obs.pull!, { conflict: true, reviewIds: [], reviewReceipts: [] })
    if (guard === 'started' || guard === 'uncertain') {
      current = record(journal, current, { type: 'invocation.admitted', invocation: invocation('owned-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT])) })
      current = record(journal, current, { type: 'invocation.started', invocationId: 'owned-review' })
      if (guard === 'uncertain') current = record(journal, current, { type: 'invocation.uncertain', invocationId: 'owned-review', reason: 'verdict unavailable' })
    }
    if (guard === 'held') current = record(journal, current, { type: 'chain.held', reason: 'operator hold' })
    if (guard === 'queue') obs.pull!.queueEntry = 'existing-entry'
    if (guard === 'stale') obs.checkedAt = NOW - 120_001
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'wait', reason: expect.stringContaining(reason) })
  })

  it('merges a ready pull request without making its outdated threads a prerequisite', () => {
    const { journal, chain } = setup(); const obs = observation()
    let current = reviewed(journal, chain, obs); pull(obs)
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]),
      { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 27, head_sha: HEAD })
    Object.assign(obs.pull!, { approved: true, ready: true, unresolvedOutdated: 1, readinessBlockers: [] })
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'merge-pr' })
  })

  it('repairs actual blockers with a fresh invocation and diagnoses queue rejection instead of blindly re-enqueuing', () => {
    const { journal, chain } = setup(); const obs = observation()
    let current = reviewed(journal, chain, obs); pull(obs)
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]),
      { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 27, head_sha: HEAD })
    for (const flag of ['conflict', 'behind', 'changesRequested'] as const) {
      obs.pull![flag] = true
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
      obs.pull![flag] = false
    }
    obs.pull!.failing = ['unit:failure']
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
    obs.pull!.failing = []
    current = finish(journal, current, 'merge', 'merge-pr', 'merge-basis', { status: 'completed', outcome: 'enqueued', head_sha: HEAD, queue_entry_id: 'queue-1' }, null)
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'wait', reason: expect.stringContaining('removal evidence') })
    obs.pull!.queueRemoval = { id: 'removal-1', reason: 'failed_checks', at: NOW, actor: null }
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr', reason: expect.stringContaining('PR-head green checks do not prove integration success') })
    obs.pull!.queueRemoval.reason = 'manual'
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'hold', reason: expect.stringContaining('decision') })
    current = record(journal, current, { type: 'chain.observed', observation: structuredClone(obs) })
    obs.pull!.merged = true; obs.pull!.mergeSha = MERGE; obs.pull!.state = 'closed'
    expect(decideBehaviorChain(current, obs, NOW)).toEqual({ kind: 'complete', mergeSha: MERGE })
  })

  it('waits for a confirmed merge when the queue reports merged during an open-PR observation', () => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    let current = reviewed(journal, chain, obs)
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]),
      { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 27, head_sha: HEAD })
    current = finish(journal, current, 'queue', 'merge-pr', 'queue-basis',
      { status: 'completed', outcome: 'enqueued', head_sha: HEAD, queue_entry_id: 'original-entry' }, null)
    obs.pull!.approved = true; obs.pull!.ready = true
    obs.pull!.queueRemoval = { id: 'merged-removal', reason: 'merged', at: NOW, actor: null }
    const decision = decideBehaviorChain(current, obs, NOW)
    expect(decision).toEqual({ kind: 'wait', reason: 'GitHub queue reports a merge; awaiting confirmed merge evidence' })
    if (decision.kind !== 'wait') throw new Error('expected merge observation wait')
    current = record(journal, current, { type: 'chain.observed', observation: structuredClone(obs) })
    current = record(journal, current, { type: 'chain.waiting', reason: decision.reason })
    journal.rebuild()
    current = journal.read(chain.id)!
    expect(current.held).toBeNull()
    expect(current.mergeSha).toBeNull()
    expect(current.invocations).toHaveLength(3)
    obs.pull!.merged = true; obs.pull!.state = 'closed'; obs.pull!.mergeSha = MERGE
    expect(decideBehaviorChain(current, obs, NOW)).toEqual({ kind: 'complete', mergeSha: MERGE })
  })

  it('surfaces an unmergeable queue entry after 24 hours without resetting attention age on polls or restart', () => {
    const { db, journal, chain } = setup(); const obs = observation(); pull(obs)
    let current = reviewed(journal, chain, obs)
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]),
      { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 27, head_sha: HEAD })
    Object.assign(obs.pull!, { approved: true, checksState: 'SUCCESS', queueEntry: 'entry',
      queueEntryDetails: { id: 'entry', state: 'UNMERGEABLE', base: NEXT, head: null } })
    current = record(journal, current, { type: 'chain.observed', observation: structuredClone(obs) })
    const decision = decideBehaviorChain(current, obs, NOW)
    expect(decision).toMatchObject({ kind: 'wait', reason: expect.stringContaining('UNMERGEABLE; cause unknown') })
    if (decision.kind !== 'wait') throw new Error('expected queue wait')
    current = record(journal, current, { type: 'chain.waiting', reason: decision.reason })
    for (const elapsed of [CHAIN_ATTENTION_DELAY_MS - 1, CHAIN_ATTENTION_DELAY_MS, CHAIN_ATTENTION_DELAY_MS + 1000]) {
      obs.checkedAt = NOW + elapsed
      current = journal.append(chain.id, `poll-${elapsed}`, current.sequence, { type: 'chain.observed', observation: structuredClone(obs) }, obs.checkedAt)
      const attention = behaviorChainAttention(journal, obs.checkedAt)
      if (elapsed < CHAIN_ATTENTION_DELAY_MS) expect(attention).toEqual([])
      else expect(attention[0]).toMatchObject({ progressAt: NOW, ageMs: elapsed,
        evidence: { state: 'fresh', gates: expect.arrayContaining(['Queue UNMERGEABLE; cause unknown']) },
        nextAction: 'Queue UNMERGEABLE needs attention; cause unknown. Await GitHub queue resolution or removal; GitHub retains ownership' })
    }
    const before = behaviorChainAttention(journal, obs.checkedAt)
    const recovered = new BehaviorChainJournal(db); recovered.rebuild()
    expect(behaviorChainAttention(recovered, obs.checkedAt)).toEqual(before)
    expect(recovered.read(chain.id)!.held).toBeNull()
  })

  it.each([{ shared: false, reason: 'failed_checks' }, { shared: true, reason: 'failed_checks' }, { shared: false, reason: 'merge_conflict' }])(
    'requires diagnosis, baseline recovery when shared=$shared, and approval after $reason before a fresh integration attempt', ({ shared, reason }) => {
    const { journal, chain } = setup(); const obs = observation()
    let current = reviewed(journal, chain, obs); pull(obs)
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]),
      { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 27, head_sha: HEAD })
    current = finish(journal, current, 'queue', 'merge-pr', 'queue-basis', { status: 'completed', outcome: 'enqueued', head_sha: HEAD }, null)
    obs.pull!.approved = true; obs.pull!.ready = true
    obs.pull!.queueEntry = 'unmergeable-entry'
    obs.pull!.queueEntryDetails = { id: 'unmergeable-entry', state: 'UNMERGEABLE', base: NEXT, head: null }
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'wait', reason: expect.stringContaining('UNMERGEABLE; cause unknown') })
    obs.pull!.queueEntry = null; obs.pull!.queueEntryDetails = null
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'wait', reason: expect.stringContaining('removal evidence') })
    obs.pull!.queueRemoval = { id: 'failed-integration', reason, at: NOW, actor: null }
    const repair = decideBehaviorChain(current, obs, NOW)
    expect(repair).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
    if (repair.kind !== 'invoke') throw new Error('expected repair')
    const repairInvocation = invocation('diagnosis', 'repair-pr', repair.basis)
    repairInvocation.request.context = { head: HEAD, reviewRevision: obs.pull!.reviewRevision, queueRemoval: 'failed-integration' }
    current = record(journal, current, { type: 'invocation.admitted', invocation: repairInvocation })
    current = record(journal, current, { type: 'invocation.settled', invocationId: 'diagnosis', callId: 'diagnosis-native', outcome: 'no_changes',
      evidence: { status: 'completed', action: 'no_changes', head_sha: HEAD,
        ...(shared ? { artifact: { ci_dependency: { head: HEAD, integration: MERGE, base: NEXT, removal: 'failed-integration',
          remediation: 'https://github.com/Example/Repo/pull/99', allShared: true,
          failures: [{ name: 'unit', check: 11, run: 10, workflow: 1 }] } } } : {}) } })
    if (shared) {
      const waiting = { kind: 'wait', reason: expect.stringContaining('shared baseline CI dependency') }
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject(waiting)
      obs.ciDependency = { invocationId: 'diagnosis', base: NEXT, recovered: false }
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject(waiting)
      // A shared shard never excuses a separate candidate defect.
      obs.pull!.failing = ['candidate-only:failure']
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
      obs.pull!.failing = []
      obs.pull!.queueRemoval!.id = 'new-failed-integration'
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
      obs.pull!.queueRemoval!.id = 'failed-integration'
      current = record(journal, current, { type: 'chain.observed', observation: structuredClone(obs) })
      const decision = decideBehaviorChain(current, obs, NOW)
      if (decision.kind !== 'wait') throw new Error('expected dependency wait')
      current = record(journal, current, { type: 'chain.waiting', reason: decision.reason })
      journal.rebuild()
      current = journal.read(chain.id)!
      expect(current.held).toBeNull()
      expect(current.waiting).toContain('check 11')
      expect(current.waiting).toContain(HEAD)
      expect(current.waiting).toContain(NEXT)
      obs.ciDependency.recovered = true
      expect(decideBehaviorChain({ ...current, held: 'operator hold' }, obs, NOW)).toEqual({ kind: 'wait', reason: 'operator hold' })
      // Recovery cannot adopt another head or its old reviews.
      obs.pull!.head = NEXT
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
      obs.pull!.head = HEAD
      obs.pull!.reviewContext = '5'.repeat(64)
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
      obs.pull!.reviewContext = CONTEXT
    }
    const verify = decideBehaviorChain(current, obs, NOW)
    expect(verify).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
    if (verify.kind !== 'invoke') throw new Error('expected independent approval')
    obs.pull!.reviewIds.push(28)
    current = finish(journal, current, 'verify-integration-repair', 'approve-pr', verify.basis,
      { status: 'completed', action: 'approved', outcome: 'approved', review_id: 28, head_sha: HEAD })
    if (shared) {
      obs.ciDependency!.base = '7'.repeat(40)
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
      obs.ciDependency!.base = NEXT
    }
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'merge-pr' })
    // Admission to the second queue attempt still cannot complete the chain.
    obs.pull!.queueEntry = 'second-integration-attempt'
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'wait' })
  })

  it('hands a published repair to approval after its fresh review instead of repeating repair for the answered thread', () => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    let current = reviewed(journal, chain, obs)
    const repair = invocation('repair', 'repair-pr', 'original-findings')
    repair.request.context = { head: NEXT, reviewRevision: 'original-findings' }
    repair.request.argv = ['--atomic-work', 'Example/Repo#7', '--expected-issue-revision', obs.issue.revision]
    current = record(journal, current, { type: 'invocation.admitted', invocation: repair })
    current = record(journal, current, { type: 'invocation.settled', invocationId: repair.id, callId: 'repair-call', outcome: 'published',
      evidence: { status: 'completed', action: 'published', outcome: 'published', head_sha: HEAD } })
    obs.publication.head_invocation = 'repair-call'
    obs.pull!.unresolved = 1
    obs.pull!.reviewRevision = 'fresh-clean-review-with-original-thread'
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]),
      { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 27, head_sha: HEAD })
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
    for (const flag of ['conflict', 'behind', 'changesRequested'] as const) {
      obs.pull![flag] = true
      expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
      obs.pull![flag] = false
    }
    obs.pull!.failing = ['unit:failure']
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
    obs.pull!.failing = []
    obs.publication.head_invocation = 'unrelated-call'
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
    obs.publication.head_invocation = 'repair-call'
    current.invocations.find(item => item.id === repair.id)!.request.argv[3] = 'superseded-issue-revision'
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
  })
})

describe('native admission and recovery', () => {
  function operations(overrides: Partial<ChainRuntimeOperations> = {}): ChainRuntimeOperations {
    return { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }), discover: async () => [],
      ownsRepository: () => true, observe: async () => ({ ...observation(), checkedAt: Date.now() }),
      readInvocations: async () => ({ entries: [], quarantined: [] }), received: () => {}, available: () => true, capacity: () => 2,
      permitted: () => true, request: async () => ({ command: 'agent-interface', argv: ['--model', 'fixture-model'], cwd: '/fixture' }),
      launch: async () => true, perform: async () => ({}), resumePublication: async () => { throw new Error('unexpected publication resume') },
      readActionResult: async () => { throw new Error('unexpected native response read') },
      fenceClosedTarget: async () => { throw new Error('unexpected closed-target fence') }, wake: () => {}, ...overrides }
  }

  function admissionQueue() {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const { db, journal, chain } = setup()
    const observations = new Map<string, ChainObservation>()
    const obs = observation(); obs.issueReviewers = []
    observations.set(chain.id, obs)
    const slots = new CheckSemaphore(() => 1)
    const calls: LogEntry[] = [], launches: string[] = []
    let release: (() => void) | null = null
    const seed = (number: number) => {
      const id = chainIdentity(chain.repository, number)
      const next = journal.append(id, `seed:${number}`, 0, { type: 'chain.admitted', repository: chain.repository,
        issue: number, branch: `poise/issue-${number}`, author: chain.author, reviewer: chain.reviewer }, NOW)
      observations.set(id, structuredClone(obs))
      return next
    }
    const call = (current: BehaviorChain, pending: ChainInvocation): LogEntry => ({ id: chainBasis(pending.id).slice(0, 32),
      correlation_id: pending.id, source: 'poise:behavior-chain', actor: pending.actor, repo: current.repository,
      pr_id: String(current.issue), behavior: 'implement_issue', model: pending.model!, session_id: null, prompt: '',
      started_at: new Date(NOW).toISOString(), time_elapsed: '1s', completed_at: null, status: 'running',
      head_sha: null, expected_head: null, response: null, error: '', action: null, outcome: null,
      resource_ownership: { version: 1, roots: [], errors: [] }, resources_settled_at: null })
    const native = operations({ available: () => slots.available('behavior'), capacity: () => slots.laneCapacity('behavior'),
      observe: async current => ({ ...structuredClone(observations.get(current.id)!), checkedAt: Date.now() }),
      readInvocations: async () => ({ entries: calls, quarantined: [] }),
      request: async current => ({ command: 'agent-interface', argv: ['--model', REVIEWER.model, current.id], cwd: '/fixture' }),
      launch: async pending => {
        const current = journal.read(pending.request.argv.at(-1)!)!
        expect(release).toBeNull()
        release = slots.tryAcquire('behavior')
        expect(release).not.toBeNull()
        launches.push(current.id); calls.push(call(current, pending))
        return true
      } })
    const complete = (entry: LogEntry) => Object.assign(entry, { status: 'completed', action: 'no_changes', outcome: 'no_changes',
      completed_at: new Date(NOW).toISOString(), resources_settled_at: new Date(NOW).toISOString() })
    const finishLaunch = () => {
      const entry = calls.at(-1)!
      complete(entry)
      const current = journal.read(launches.at(-1)!)!
      record(journal, current, { type: 'invocation.settled', invocationId: entry.correlation_id!, callId: entry.id,
        outcome: 'no_changes', evidence: { status: 'completed', outcome: 'no_changes',
          resource_ownership: entry.resource_ownership, resources_settled_at: entry.resources_settled_at } })
      release!(); release = null
    }
    return { db, journal, chain, observations, slots, calls, launches, seed, call, native, complete, finishLaunch }
  }

  it.each(['semaphore', 'journal'] as const)('gives an older implementation the freed %s slot across cursor pages and restart', async gate => {
    const queue = admissionQueue()
    const { db, journal, chain, native, launches } = queue
    let release: (() => void) | null = null, busyCall: LogEntry | null = null
    if (gate === 'semaphore') release = queue.slots.tryAcquire('behavior')!
    else {
      let busy = queue.seed(1)
      busy = record(journal, busy, { type: 'invocation.admitted', invocation: invocation('busy', 'implement-issue', chainBasis(['issue', observation().issue.revision])) })
      busy = record(journal, busy, { type: 'invocation.started', invocationId: 'busy' })
      busyCall = queue.call(busy, busy.invocations[0]); queue.calls.push(busyCall)
    }
    let runtime = new BehaviorChainRuntime(journal, native)
    await runtime.run()
    expect(journal.read(chain.id)!.waiting).toBe(gate === 'semaphore'
      ? 'waiting for the shared native behavior capacity' : 'shared native invocation capacity is occupied')
    for (let turn = 0; turn < 3; turn++) {
      // Each release has another full page of later issues before #7. Without
      // global ordering they consume every release and the cursor never gets #7.
      for (let index = 0; index < 100; index++) queue.seed(1000 + turn * 100 + index)
      expect(journal.reconcilable(turn ? `example/repo#${999 + turn * 100}` : '', NOW, false).map(item => item.id)).not.toContain(chain.id)
      if (turn === 0) {
        release?.(); release = null
        if (busyCall) queue.complete(busyCall) // Reconciliation frees this slot inside the next page.
      } else queue.finishLaunch()
      await Promise.all([runtime.run(), runtime.run()])
      expect(launches).toHaveLength(turn + 1)
      if (turn === 0) {
        expect(launches).toEqual([chain.id])
        journal.rebuild()
        runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), native)
        await runtime.run()
        expect(launches).toEqual([chain.id])
      }
    }
    expect(launches.filter(id => id === chain.id)).toHaveLength(1)
    expect(launches.slice(1).every(id => id !== chain.id)).toBe(true)
  })

  it.each(['unchanged', 'hold-resume', 'basis', 'behavior', 'slot', 'eligibility', 'permission'] as const)(
    'ages only the current eligible capacity-wait episode: %s', async change => {
      const queue = admissionQueue()
      const { journal, chain, native, observations, launches } = queue
      const release = queue.slots.tryAcquire('behavior')!
      let runtime = new BehaviorChainRuntime(journal, native)
      await runtime.run()
      const later = queue.seed(change === 'unchanged' ? 6 : 8)
      await runtime.run()
      const obs = observations.get(chain.id)!
      let permitted = true
      native.permitted = current => current.id !== chain.id || permitted
      if (change === 'hold-resume') {
        const held = record(journal, journal.read(chain.id)!, { type: 'chain.held', reason: 'operator hold' })
        record(journal, held, { type: 'chain.resumed' })
      } else {
        if (change === 'basis') obs.issue.revision = 'changed seed'
        if (change === 'behavior') obs.issueReviewers = [REVIEWER]
        if (change === 'slot') obs.implementer = { ...REVIEWER, slot: 'secondary' }
        if (change === 'eligibility') obs.issue.eligible = false
        if (change === 'permission') permitted = false
        // More than one journal history page of unchanged checks cannot renew age.
        for (let check = 0; check < (change === 'unchanged' ? 101 : 1); check++) await runtime.run()
        if (change === 'permission') expect(journal.read(chain.id)!.waiting).toContain('disabled or held')
        obs.issue.eligible = true; permitted = true
      }
      journal.rebuild()
      runtime = new BehaviorChainRuntime(journal, native)
      release()
      await runtime.run()
      expect(launches).toEqual([change === 'unchanged' ? chain.id : later.id])
    })

  it.each(['ineligible', 'held', 'backoff', 'changed basis'] as const)(
    'leaves the slot usable when a fresh check of the oldest waiter is %s', async cause => {
      const queue = admissionQueue()
      const { journal, chain, native, observations, launches } = queue
      const release = queue.slots.tryAcquire('behavior')!
      const runtime = new BehaviorChainRuntime(journal, native)
      await runtime.run()
      const later = queue.seed(6)
      await runtime.run()
      if (cause === 'ineligible') observations.get(chain.id)!.issue.eligible = false
      if (cause === 'changed basis') observations.get(chain.id)!.issue.revision = 'fresh changed seed'
      if (cause === 'held') record(journal, journal.read(chain.id)!, { type: 'chain.held', reason: 'person hold' })
      const request = native.request
      const prepared: string[] = []
      native.request = async (current, ...args) => {
        prepared.push(current.id)
        return current.id === chain.id && cause === 'backoff' ? null : request(current, ...args)
      }
      release()
      await runtime.run()
      expect(launches).toEqual([later.id])
      expect(prepared).toEqual(cause === 'backoff' ? [chain.id, later.id] : [later.id])
    })

  it('rechecks a settled shared failure on the existing tick across restart and honors operator holds', async () => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    obs.prReviewers = []
    let current = reviewed(journal, chain, obs)
    current = finish(journal, current, 'queue', 'merge-pr', 'queue', { status: 'completed', outcome: 'enqueued', head_sha: HEAD }, null)
    obs.pull!.queueRemoval = { id: 'failed-integration', reason: 'failed_checks', at: NOW, actor: null }
    const repair = invocation('diagnosis', 'repair-pr', 'queue-repair')
    repair.request.context = { head: HEAD, reviewRevision: obs.pull!.reviewRevision, queueRemoval: 'failed-integration' }
    current = record(journal, current, { type: 'invocation.admitted', invocation: repair })
    const call: LogEntry = { id: 'a'.repeat(32), correlation_id: repair.id, source: 'poise:behavior-chain', actor: 'author',
      pr_id: '21', repo: chain.repository, behavior: 'repair_pr', model: 'fixture-model', session_id: null, prompt: '',
      started_at: new Date(NOW).toISOString(), completed_at: new Date(NOW).toISOString(), time_elapsed: '1s',
      expected_head: HEAD, head_sha: HEAD, response: null, error: '', status: 'completed', action: 'no_changes', outcome: 'no_changes',
      resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] },
      artifact: { phase: 'waiting_baseline', ci_dependency: { head: HEAD, integration: MERGE, base: NEXT, removal: 'failed-integration',
        remediation: 'https://github.com/Example/Repo/pull/99', allShared: true,
        failures: [{ name: 'unit', check: 11, run: 10, workflow: 1 }] } } }
    let recovered = false
    let observations = 0
    const launched: string[] = []
    const native = operations({ capacity: () => 10,
      readInvocations: async () => ({ entries: [call], quarantined: [] }),
      observe: async () => { observations++; return { ...structuredClone(obs), checkedAt: Date.now(),
        ciDependency: { invocationId: repair.id, base: NEXT, recovered } } },
      launch: async invocation => { launched.push(invocation.behavior); return true },
    })
    await new BehaviorChainRuntime(journal, native).run()
    current = journal.read(chain.id)!
    expect(current.invocations.at(-1)).toMatchObject({ state: 'settled', outcome: 'no_changes' })
    expect(current.held).toBeNull()
    expect(current.waiting).toContain('shared baseline CI dependency')
    journal.rebuild()
    const runtime = new BehaviorChainRuntime(journal, native)
    await runtime.run()
    expect(observations).toBe(2)
    expect(launched).toEqual([])
    current = record(journal, journal.read(chain.id)!, { type: 'chain.held', reason: 'operator hold' })
    recovered = true
    await runtime.run()
    expect(journal.read(chain.id)!.held).toBe('operator hold')
    expect(launched).toEqual([])
    record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
    obs.pull!.pending = true
    await runtime.run()
    expect(launched).toEqual([])
    obs.pull!.pending = false
    await runtime.run()
    expect(launched).toEqual(['approve-pr'])
  })

  it.each(['recovered', 'operator recovery', 'operator hold', 'posting began', 'resources unknown', 'unrelated failure'])('reconciles only a proved auth hold: %s', async mode => {
    const { journal, chain } = setup()
    const obs = { ...observation(), checkedAt: Date.now() }
    const basis = chainBasis(['issue', obs.issue.revision])
    let current = chain
    for (let index = 0; index < 3; index++) current = finish(journal, current, `rejected-${index}`, 'review-issue', basis,
      { status: 'failed', action: 'not_started', outcome: 'preflight_failed', error_code: 'authentication_failed',
        error: 'Refresh credential was rejected', completedAt: Date.now(), receipts: mode === 'posting began' && index === 2 ? [] : null,
        review_id: null, head_sha: null, resources_settled_at: mode === 'resources unknown' && index === 2 ? null : new Date().toISOString(),
        resource_ownership: { version: 1, roots: [], errors: [] } })
    const reason = 'review-issue failed before publication three times: Refresh credential was rejected'
    current = record(journal, current, { type: 'chain.held', reason: mode === 'operator hold' ? 'New invocations held by the person' : reason })
    // Held observations would ordinarily be deferred, even after sign-in.
    current = record(journal, current, { type: 'chain.observed', observation: obs })
    let recovered = false
    const launched: ChainInvocation[] = []
    const calls: LogEntry[] = []
    const runtime = new BehaviorChainRuntime(journal, operations({ observe: async () => ({ ...obs, checkedAt: Date.now() }),
      readInvocations: async () => ({ entries: calls, quarantined: [] }),
      authRecovered: () => recovered && mode !== 'unrelated failure' && (mode === 'operator recovery'
        ? { origin: 'operator', intervention: { callId: 'rejected-2', at: Date.now(), verifiedAt: Date.now() } } : true),
      launch: async invocation => { launched.push(invocation); return true } }))
    await runtime.run()
    expect(launched).toHaveLength(0)
    recovered = true
    await runtime.run()
    await runtime.run()
    const after = journal.read(chain.id)!
    if (mode === 'recovered' || mode === 'operator recovery') {
      expect(after.held).toBeNull()
      expect(after.resumedAfterSequence).toBeGreaterThan(current.sequence)
      expect(launched).toHaveLength(1)
      expect(launched[0].behavior).toBe('review-issue')
      expect(after.invocations).toHaveLength(4)
      const resumes = journal.history(chain.id).filter(row => JSON.parse(row.payload).type === 'chain.resumed')
      expect(resumes).toHaveLength(1)
      expect(JSON.parse(resumes[0].payload).recovery).toMatchObject({ origin: mode === 'operator recovery' ? 'operator' : 'unknown' })
      const review = launched[0]
      calls.push({ id: 'a'.repeat(32), correlation_id: review.id, source: 'poise:behavior-chain', actor: 'reviewer',
        pr_id: '7', model: 'fixture-model', session_id: null, prompt: '', started_at: new Date(review.admittedAt).toISOString(),
        completed_at: new Date().toISOString(), time_elapsed: '1s', head_sha: null, expected_head: null, response: null,
        error: '', repo: 'Example/Repo', behavior: 'issue_review', status: 'completed', action: 'commented', outcome: 'commented',
        issue_revision: obs.issue.revision, resources_settled_at: new Date().toISOString(),
        resource_ownership: { version: 1, roots: [], errors: [] },
        receipts: [{ issue: 'Example/Repo#7', comment_id: 17, author: 'reviewer', url: null }] })
      await runtime.run()
      await runtime.run()
      expect(launched.map(invocation => invocation.behavior)).toEqual(['review-issue', 'implement-issue'])
      const advanced = journal.read(chain.id)!
      expect(advanced.invocations.filter(invocation => invocation.evidence?.action === 'commented')).toHaveLength(1)
      expect(journal.history(chain.id).filter(row => JSON.parse(row.payload).type === 'chain.resumed')).toHaveLength(1)
      journal.rebuild()
      expect(journal.read(chain.id)).toEqual(advanced)
    } else {
      expect(after.held).toBe(current.held)
      expect(after.resumedAfterSequence).toBe(0)
      expect(launched).toHaveLength(0)
    }
  })

  it('pages authentication holds from their own partial index, never reading other chains', () => {
    const { db, journal, chain } = setup()
    const seed = (issue: number) => journal.append(chainIdentity('Example/Repo', issue), `seed-${issue}`, 0, { type: 'chain.admitted',
      repository: 'Example/Repo', issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' }, NOW)
    record(journal, chain, { type: 'chain.held', reason: 'review-issue failed before publication three times: Refresh credential was rejected' })
    record(journal, seed(8), { type: 'chain.held', reason: 'repair-pr failed before publication three times: required CI shard failed' })
    seed(9)
    expect(journal.authenticationHolds('').map(held => held.id)).toEqual([chain.id])
    expect(journal.authenticationHolds(chain.id)).toEqual([])
    const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT chain_id FROM behavior_chain_current INDEXED BY behavior_chain_authentication_holds
      WHERE merged = 0 AND json_extract(state, '$.held') LIKE 'review-issue failed before publication three times:%' AND chain_id > ?`)
      .all('') as Array<{ detail: string }>).map(row => row.detail).join('\n')
    expect(plan).toMatch(/USING (COVERING )?INDEX behavior_chain_authentication_holds/)
    expect(db.prepare('SELECT count(*) FROM behavior_chain_current INDEXED BY behavior_chain_authentication_holds WHERE merged = 0 AND json_extract(state, \'$.held\') LIKE \'review-issue failed before publication three times:%\'').pluck().get()).toBe(1)
  })

  it('recovers a later slot despite an earlier slot failure and success', async () => {
    const { journal, chain } = setup()
    const obs = { ...observation(), checkedAt: Date.now() }
    const basis = chainBasis(['issue', obs.issue.revision])
    let current = chain
    current = finish(journal, current, 'earlier-failed', 'review-issue', basis,
      { status: 'failed', action: 'not_started', outcome: 'preflight_failed', error_code: 'review_provider_exit',
        error: 'provider died', completedAt: Date.now(), receipts: null, review_id: null, head_sha: null,
        resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } }, 'secondary')
    current = finish(journal, current, 'earlier-ok', 'review-issue', basis,
      { status: 'completed', action: 'commented', outcome: 'commented', completedAt: Date.now(),
        receipts: [{ issue: 'Example/Repo#7', comment_id: 17, author: 'reviewer' }] }, 'secondary')
    for (let index = 0; index < 3; index++) current = finish(journal, current, `rejected-${index}`, 'review-issue', basis,
      { status: 'failed', action: 'not_started', outcome: 'preflight_failed', error_code: 'authentication_failed',
        error: 'Refresh credential was rejected', completedAt: Date.now(), receipts: null,
        review_id: null, head_sha: null, resources_settled_at: new Date().toISOString(),
        resource_ownership: { version: 1, roots: [], errors: [] } })
    const reason = 'review-issue failed before publication three times: Refresh credential was rejected'
    current = record(journal, current, { type: 'chain.held', reason })
    current = record(journal, current, { type: 'chain.observed', observation: obs })
    const launched: ChainInvocation[] = []
    const calls: LogEntry[] = []
    const runtime = new BehaviorChainRuntime(journal, operations({ observe: async () => ({ ...obs, checkedAt: Date.now() }),
      readInvocations: async () => ({ entries: calls, quarantined: [] }),
      authRecovered: () => true,
      launch: async invocation => { launched.push(invocation); return true } }))
    await runtime.run()
    await runtime.run()
    const after = journal.read(chain.id)!
    expect(after.held).toBeNull()
    expect(after.resumedAfterSequence).toBeGreaterThan(current.sequence)
    expect(launched).toHaveLength(1)
  })

  it.each([{ receipts: null }, { receipts: [] }])('requires original resource settlement and preserves posting receipts $receipts', async ({ receipts }) => {
    const { journal, chain } = setup(); const obs = observation()
    const pending = invocation('rejected-review', 'review-issue', chainBasis(['issue', obs.issue.revision]))
    record(journal, chain, { type: 'invocation.admitted', invocation: pending })
    const call: LogEntry = { id: 'a'.repeat(32), correlation_id: pending.id, source: 'poise:behavior-chain', actor: 'reviewer',
      pr_id: '7', model: 'fixture-model', session_id: null, prompt: '', started_at: new Date(NOW).toISOString(),
      completed_at: new Date().toISOString(), time_elapsed: '1s', head_sha: null, expected_head: null, response: null,
      repo: 'Example/Repo', behavior: 'issue_review', status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error: 'refresh rejected', error_code: 'authentication_failed', receipts,
      resources_settled_at: null, resource_ownership: { version: 1, roots: [], errors: [] } }
    let notified = 0
    const launched: ChainInvocation[] = []
    const runtime = new BehaviorChainRuntime(journal, operations({ readInvocations: async () => ({ entries: [call], quarantined: [] }),
      authenticationRejected: () => { notified++ }, authRecovered: () => true,
      launch: async invocation => { launched.push(invocation); return true } }))
    await runtime.run()
    expect(notified).toBe(1)
    expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
    expect(launched).toHaveLength(0)
    call.resources_settled_at = new Date().toISOString()
    await runtime.run()
    await runtime.run()
    expect(journal.read(chain.id)!.invocations[0].state).toBe(receipts === null ? 'settled' : 'uncertain')
    expect(launched).toHaveLength(receipts === null ? 1 : 0)
  })

  it('deduplicates provider waits across runtime replacement without skipping changed blockers, recovery or retries', async () => {
    const { db, journal, chain } = setup(); const obs = observation()
    let blocked = true
    const request = vi.fn<ChainRuntimeOperations['request']>(async () => blocked ? null
      : { command: 'agent-interface', argv: ['--model', 'fixture-model'], cwd: '/fixture' })
    const launch = vi.fn<ChainRuntimeOperations['launch']>(async () => true)
    const ops = operations({ observe: async () => ({ ...obs, checkedAt: Date.now() }), request, launch })
    let runtime = new BehaviorChainRuntime(journal, ops)
    const waits = () => journal.history(chain.id).filter(row => JSON.parse(row.payload).type === 'chain.waiting')
    const reason = 'review-issue is waiting for native provider backoff'

    await runtime.run()
    const firstWait = waits()
    expect(firstWait).toHaveLength(1)
    expect(JSON.parse(firstWait[0].payload)).toEqual({ type: 'chain.waiting', reason })
    await runtime.run()
    const restarted = new BehaviorChainJournal(db); restarted.rebuild()
    runtime = new BehaviorChainRuntime(restarted, ops)
    await runtime.run()
    expect(waits()).toEqual(firstWait)
    expect(request).toHaveBeenCalledTimes(3)
    expect(journal.read(chain.id)!.invocations).toHaveLength(0)
    expect(launch).not.toHaveBeenCalled()

    obs.issue.eligible = false
    await runtime.run()
    obs.issue.eligible = true
    await runtime.run()
    await runtime.run()
    expect(waits().map(row => JSON.parse(row.payload).reason)).toEqual([
      reason, 'seed issue no longer matches intake settings', reason,
    ])
    expect(request).toHaveBeenCalledTimes(5)
    expect(journal.read(chain.id)!.invocations).toHaveLength(0)
    expect(launch).not.toHaveBeenCalled()

    blocked = false
    await runtime.run()
    const admitted = journal.read(chain.id)!
    expect(request).toHaveBeenCalledTimes(6)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(admitted.waiting).toBeNull()
    expect(admitted.invocations).toHaveLength(1)
    expect(admitted.invocations[0]).toMatchObject({ behavior: 'review-issue', state: 'started' })

    record(journal, admitted, { type: 'invocation.settled', invocationId: admitted.invocations[0].id,
      callId: 'failed-attempt', outcome: 'preflight_failed', evidence: { status: 'failed', action: 'not_started',
        completedAt: Date.now() - 61_000, resources_settled_at: new Date().toISOString() } })
    blocked = true
    await runtime.run()
    await runtime.run()
    expect(waits()).toHaveLength(4)
    expect(JSON.parse(waits().at(-1)!.payload)).toEqual({ type: 'chain.waiting', reason })
    expect(journal.read(chain.id)!.invocations).toHaveLength(1)
    expect(launch).toHaveBeenCalledTimes(1)
    blocked = false
    await runtime.run()
    expect(journal.read(chain.id)!.invocations).toHaveLength(2)
    expect(launch).toHaveBeenCalledTimes(2)
  })

  it('records one fresh provider wait after Hold and Resume without a sweep while held', async () => {
    const { db, journal, chain } = setup()
    const request = vi.fn<ChainRuntimeOperations['request']>(async () => null)
    const launch = vi.fn<ChainRuntimeOperations['launch']>(async () => true)
    const ops = operations({ request, launch })
    const waits = () => journal.history(chain.id).filter(row => JSON.parse(row.payload).type === 'chain.waiting')
    await new BehaviorChainRuntime(journal, ops).run()
    const firstWait = waits()[0]
    let current = record(journal, journal.read(chain.id)!, { type: 'chain.held', reason: 'person paused it' })
    current = record(journal, current, { type: 'chain.resumed' })
    expect(current.waiting).toBe(JSON.parse(firstWait.payload).reason)
    const restarted = new BehaviorChainJournal(db); restarted.rebuild()
    expect(restarted.read(chain.id)).toEqual(current)

    const runtime = new BehaviorChainRuntime(restarted, ops)
    await runtime.run()
    expect(waits()).toHaveLength(2)
    expect(waits()[0]).toEqual(firstWait)
    expect(waits()[1].payload).toBe(firstWait.payload)
    expect(waits()[1].sequence).toBeGreaterThan(current.resumedAfterSequence)
    await runtime.run()
    await new BehaviorChainRuntime(restarted, ops).run()
    expect(waits()).toHaveLength(2)
    expect(request).toHaveBeenCalledTimes(4)
    expect(journal.read(chain.id)!.invocations).toHaveLength(0)
    expect(launch).not.toHaveBeenCalled()
  })

  it('recovers a review only with its retained substantive response and preserves its original completion time', async () => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    const now = Date.now(); const nativeId = 'c'.repeat(32)
    obs.checkedAt = now
    const pending = invocation('original-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]))
    pending.admittedAt = now - 3000
    pending.request.argv = ['--pr-review', '#21', '--expected-head', HEAD]
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: pending })
    current = record(journal, current, { type: 'invocation.uncertain', invocationId: pending.id, reason: 'submission response lost' })
    current = record(journal, current, { type: 'invocation.reconciled', invocationId: pending.id,
      evidence: { callId: nativeId, resources_settled_at: new Date(now).toISOString(), completedAt: now,
        resource_ownership: { version: 1, roots: [], errors: [] } } })
    obs.pull!.reviewReceipts = [{ id: 91, head: HEAD, state: 'COMMENTED', invocation: nativeId, submittedAt: now - 1000 }]
    const runtime = new BehaviorChainRuntime(journal, operations({ observe: async () => obs, launch: async () => { throw new Error('duplicate review dispatch') } }))
    await runtime.run()
    current = journal.read(chain.id)!
    expect(current.invocations[0].state).toBe('uncertain')
    const response = { ...reviewResponse(nativeId), completed_at: now - 2000 }
    obs.pull!.reviewReceipts[0].response = response
    record(journal, current, { type: 'invocation.reconciled', invocationId: pending.id, evidence: { artifact: { review_response: response } } })
    await runtime.run()
    expect(journal.read(chain.id)!.invocations[0]).toMatchObject({ state: 'settled', callId: nativeId,
      evidence: { artifact: { review_response: { completed_at: now - 2000 } } } })
  })

  it('reconciles and advances admitted work while intake failure remains visible', async () => {
    const { journal, chain } = setup(); const obs = observation()
    const pending = invocation('existing-review', 'review-issue', chainBasis(['issue', obs.issue.revision]))
    record(journal, chain, { type: 'invocation.admitted', invocation: pending })
    const call: LogEntry = { id: 'a'.repeat(32), correlation_id: pending.id, source: 'poise:behavior-chain', actor: 'reviewer',
      pr_id: '7', model: 'fixture-model', session_id: null, prompt: '', started_at: new Date(NOW).toISOString(),
      time_elapsed: '1s', head_sha: null, expected_head: null, response: null, error: '',
      repo: 'Example/Repo', behavior: 'issue_review', status: 'completed', outcome: 'commented', action: 'commented',
      issue_revision: obs.issue.revision, resources_settled_at: new Date(NOW).toISOString(),
      resource_ownership: { version: 1, roots: [], errors: [] },
      receipts: [{ issue: 'Example/Repo#7', comment_id: 17, author: 'reviewer', url: null }] }
    const runtime = new BehaviorChainRuntime(journal, operations({ discover: async () => { throw new Error('intake is stale') },
      readInvocations: async () => ({ entries: [call], quarantined: [] }) }))
    await expect(runtime.run()).rejects.toThrow('intake is stale')
    const current = journal.read(chain.id)!
    expect(current.invocations[0]).toMatchObject({ state: 'settled', callId: call.id, outcome: 'commented' })
    expect(current.invocations[1]).toMatchObject({ behavior: 'implement-issue', state: 'started' })
  })

  it.each(['review-pr', 'approve-pr'] as const)('starts a never-started relative %s target against the original chain without a checkout or a new admission', async (behavior) => {
    const { journal, chain } = setup()
    const pending = invocation('original-correlation', behavior, 'head')
    pending.admittedAt = Date.now() - 60_000
    pending.request = { command: 'agent-interface', cwd: '/interface', argv: [behavior === 'review-pr' ? '--pr-review' : '--pr-approve', '#37', '--pwd', '/empty/interface/directory'] }
    record(journal, chain, { type: 'invocation.admitted', invocation: pending })
    const launched: ChainInvocation[] = []
    await new BehaviorChainRuntime(journal, operations({ launch: async (request) => { launched.push(request); return true } })).run()
    expect(launched).toHaveLength(1)
    expect(launched[0].id).toBe(pending.id)
    expect(launched[0].request.argv).toEqual([pending.request.argv[0], 'https://github.com/Example/Repo/pull/37', '--pwd', '/empty/interface/directory'])
    const recovered = journal.read(chain.id)!
    expect(recovered.invocations).toHaveLength(1)
    expect(recovered.invocations[0].request).toEqual(pending.request)
    expect(recovered.invocations[0].state).toBe('started')
  })

  it('retains native exit evidence and refuses to relaunch an exited process with no Call receipt', async () => {
    const { journal, chain } = setup()
    const pending = invocation('exited-before-track', 'review-issue', 'revision')
    pending.admittedAt = Date.now() - 60_000
    record(journal, chain, { type: 'invocation.admitted', invocation: pending })
    let launches = 0
    const runtime = new BehaviorChainRuntime(journal, operations({ launch: async (_request, onExit) => {
      launches++; onExit({ code: 1, signal: null }); return true
    } }))
    await runtime.run()
    await runtime.run()
    expect(launches).toBe(1)
    expect(journal.read(chain.id)!.invocations[0]).toMatchObject({ state: 'uncertain',
      outcome: expect.stringContaining('without a durable Call receipt'), evidence: { nativeExit: { code: 1, signal: null, error: null } } })
  })

  it('advances on the completion wake without an empty cursor pass or polling GitHub during a running invocation', async () => {
    const { journal } = setup()
    const obs = observation()
    let running: ChainInvocation | null = null
    let completed = false
    let observations = 0
    const launched: string[] = []
    const runtime = new BehaviorChainRuntime(journal, operations({
      observe: async () => { observations++; return { ...obs, checkedAt: Date.now() } },
      launch: async (invocation) => { launched.push(invocation.behavior); running = invocation; return true },
      readInvocations: async () => ({ quarantined: [], entries: running ? [{ id: 'a'.repeat(32), correlation_id: running.id,
        pr_id: '7', model: 'fixture-model', session_id: null, prompt: '', started_at: new Date(NOW).toISOString(),
        time_elapsed: '1s', head_sha: null, expected_head: null, response: null, error: '',
        source: 'poise:behavior-chain', repo: 'Example/Repo', actor: 'reviewer', behavior: 'issue_review',
        status: completed ? 'completed' : 'running', action: completed ? 'commented' : null, outcome: completed ? 'commented' : null,
        issue_revision: obs.issue.revision, receipts: [{ issue: 'Example/Repo#7', comment_id: 17, author: 'reviewer', url: null }],
        resources_settled_at: completed ? new Date().toISOString() : null,
        resource_ownership: { version: 1, roots: [], errors: [] },
      } as LogEntry] : [] }),
    }))
    await runtime.run()
    expect(launched).toEqual(['review-issue'])
    await runtime.run()
    expect(observations).toBe(1)
    completed = true
    await runtime.run()
    expect(launched).toEqual(['review-issue', 'implement-issue'])
    expect(observations).toBe(3) // Includes the implementation's final admission read.
  })

  it('commits authority before launch, coalesces duplicate ticks and rechecks controls after preparation', async () => {
    const { journal, chain } = setup()
    let launches = 0
    const runtime = new BehaviorChainRuntime(journal, operations({
      launch: async (invocation, _exit, allowed) => {
        const current = journal.read(chain.id)!
        expect(current.invocations[0].id).toBe(invocation.id)
        expect(current.invocations[0].state).toBe('started')
        record(journal, current, { type: 'chain.held', reason: 'person paused during preparation' })
        if (!allowed()) return false
        launches++; return true
      },
    }))
    await Promise.all([runtime.run(), runtime.run()])
    expect(launches).toBe(0)
    const current = journal.read(chain.id)!
    expect(current.held).toBe('person paused during preparation')
    expect(current.invocations).toHaveLength(1)
    expect(current.invocations[0]).toMatchObject({ state: 'settled', outcome: 'launch_deferred' })
  })

  it('retains original ownership without retrying a started invocation whose Call is missing', async () => {
    const { journal, chain } = setup()
    const admitted = record(journal, chain, { type: 'invocation.admitted', invocation: { ...invocation('same-correlation', 'review-issue', 'revision'), admittedAt: Date.now() - 60_000 } })
    record(journal, admitted, { type: 'invocation.started', invocationId: 'same-correlation' })
    const launch = vi.fn(async () => false)
    const runtime = new BehaviorChainRuntime(journal, operations({ launch }))
    await runtime.run()
    await runtime.run()
    expect(launch).not.toHaveBeenCalled()
    expect(journal.read(chain.id)!.invocations[0]).toMatchObject({ state: 'uncertain', callId: null,
      outcome: expect.stringContaining('without a durable Call receipt') })
    expect(journal.liveModelInvocationCount()).toBe(1)
    expect(journal.history(chain.id).filter(row => JSON.parse(row.payload).type === 'invocation.uncertain')).toHaveLength(1)
  })

  it('does not release ownership from a terminal turn without worker resource proof', async () => {
    const { journal, chain } = setup()
    const admitted = record(journal, chain, { type: 'invocation.admitted', invocation: invocation('pending', 'review-issue', 'revision') })
    record(journal, admitted, { type: 'invocation.started', invocationId: 'pending' })
    const call = { id: 'a'.repeat(32), correlation_id: 'pending', source: 'poise:behavior-chain', actor: 'reviewer',
      repo: 'Example/Repo', behavior: 'issue_review', status: 'completed', outcome: 'commented', action: 'commented' } as LogEntry
    let launches = 0
    const runtime = new BehaviorChainRuntime(journal, operations({ readInvocations: async () => ({ entries: [call], quarantined: [] }),
      launch: async () => { launches++; return true } }))
    await runtime.run()
    expect(launches).toBe(0)
    expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
  })

  it('settles a lost grey-CI response from its later native attempt without issuing another rerun', async () => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    const pending = invocation('uncertain-grey', 'rerun-grey-ci', 'attempt-2', null)
    pending.model = null
    pending.request = { command: 'github-interface', cwd: '/interface', argv: ['--rerun-grey-ci-if-ready', '21',
      '--run-id', '100', '--run-attempt', '2', '--expected-head', HEAD] }
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: pending })
    current = record(journal, current, { type: 'invocation.uncertain', invocationId: pending.id, reason: 'HTTP response lost' })
    let writes = 0
    const runtime = new BehaviorChainRuntime(journal, operations({ observe: async () => ({ ...obs, checkedAt: Date.now() }),
      perform: async () => { writes++; return {} } }))
    obs.greyRecovery = { invocationId: pending.id, receipt: { outcome: 'unconfirmed' } }
    await runtime.run()
    expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
    obs.greyRecovery.receipt = { outcome: 'rerun_observed', run_id: 100, run_attempt: 2, observed_run_attempt: 3, head_sha: HEAD }
    await runtime.run()
    expect(journal.read(chain.id)!.invocations[0]).toMatchObject({ state: 'settled', outcome: 'rerun_observed' })
    expect(writes).toBe(0)
  })

  it('resumes only provably unattempted repair replies under the original admission and verifies their actual outcome', async () => {
    const { journal, chain } = setup(); const obs = observation(); pull(obs)
    const pending = invocation('original-repair', 'repair-pr', 'findings')
    record(journal, chain, { type: 'invocation.admitted', invocation: pending })
    const callId = 'a'.repeat(32)
    const call: LogEntry = { id: callId, correlation_id: pending.id, source: 'poise:behavior-chain', actor: 'author', repo: 'Example/Repo', behavior: 'repair_pr',
      status: 'failed', action: null, outcome: null, resources_settled_at: new Date(NOW).toISOString(),
      resource_ownership: { version: 1, roots: [], errors: [] },
      pr_id: '21', model: 'fixture-model', session_id: null, prompt: '', started_at: new Date(NOW).toISOString(), time_elapsed: '1s',
      head_sha: null, expected_head: HEAD, response: null, error: 'PR head confirmation timed out',
      artifact: { phase: 'publishing', plan_sha: 'b'.repeat(64) } }
    obs.publication.head_invocation = callId
    obs.workPublication = { callId, repliesComplete: false, resumable: true, planSha: 'b'.repeat(64) }
    let resumed = 0
    let received = 0
    let publicationCall: LogEntry | null = null
    const runtime = new BehaviorChainRuntime(journal, operations({ observe: async () => ({ ...obs, checkedAt: Date.now() }),
      received: () => { received++ },
      readInvocations: async () => ({ entries: [call, ...(publicationCall ? [publicationCall] : [])], quarantined: [] }), resumePublication: async (original, head, correlation) => {
        expect(original.id).toBe(pending.id)
        expect(head).toBe(HEAD)
        expect(journal.read(chain.id)!.invocations[0].evidence).toMatchObject({ publicationResume: { callId, head: HEAD } })
        publicationCall = { ...call, id: 'c'.repeat(32), correlation_id: correlation, behavior: 'native_publication', model: 'native-action',
          status: 'running', resources_settled_at: null, artifact: { phase: 'preparing_native_action',
            request_sha: nativeRequestSha({ kind: 'native_publication', call_id: callId, digest: 'b'.repeat(64), head }) } }
        resumed++; throw new Error('completion response lost')
      }, launch: async () => { throw new Error('must not launch a replacement worker') } }))
    const releasedAt = call.resources_settled_at
    call.resources_settled_at = null
    await runtime.run()
    expect(resumed).toBe(0)
    expect(received).toBe(0)
    expect(journal.liveModelInvocationCount()).toBe(1)
    call.resources_settled_at = releasedAt
    await runtime.run()
    expect(resumed).toBe(1)
    expect(received).toBe(1)
    expect(journal.read(chain.id)!.invocations).toHaveLength(1)
    expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
    obs.workPublication.resumable = false
    call.artifact = { ...call.artifact, replies_started: true }
    await runtime.run()
    expect(resumed).toBe(1)
    expect(received).toBe(1)
    expect(journal.read(chain.id)!.invocations[0].evidence?.artifact).toMatchObject({ replies_started: true })
    obs.workPublication.repliesComplete = true
    await runtime.run()
    expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
    expect(journal.liveModelInvocationCount()).toBe(1)
    const continuation = publicationCall as LogEntry | null
    expect(continuation).not.toBeNull()
    Object.assign(continuation!, { status: 'completed', action: 'native_action', outcome: 'native_action', head_sha: HEAD,
      resources_settled_at: releasedAt, resource_ownership: { version: 2, roots: [], errors: [], namespace: {
        state: 'settled', callId: continuation!.id, correlation: continuation!.correlation_id!, settled_at: NOW / 1000,
        controller: { version: 1, instance: 'd'.repeat(32) }, binding: { pid: 104, start: '12', namespace: 'pid:[91]',
          owner: { pid: 102, start: '10' }, holder: { pid: 103, start: '11' },
          epoch: { boot: 'fixture', init_start: '1', namespace_dev: '2', namespace_ino: '3' } } } },
      artifact: { ...continuation!.artifact, phase: 'received_native_action', response_sha: chainBasis({ outcome: 'published' }) } })
    await runtime.run()
    expect(journal.read(chain.id)!.invocations[0]).toMatchObject({ state: 'settled', callId, outcome: 'published' })
  })

  it('bounds active model admissions transactionally and excludes completed history', () => {
    const { journal, chain } = setup()
    expect(journal.admitInvocation(chain, 'admit-first', invocation('one', 'review-issue', 'revision'), 1)).not.toBeNull()
    const other = journal.append('example/repo#8', 'seed-eight', 0, { type: 'chain.admitted', repository: 'Example/Repo', issue: 8,
      branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' }, NOW)
    expect(journal.admitInvocation(other, 'admit-second', invocation('two', 'review-issue', 'revision'), 1)).toBeNull()
    let current = journal.read(chain.id)!
    current = record(journal, current, { type: 'invocation.settled', invocationId: 'one', callId: 'native', outcome: 'commented', evidence: { status: 'completed' } })
    current = record(journal, current, { type: 'chain.merged', mergeSha: MERGE,
      evidence: { repository: 'Example/Repo', pull_number: 21, merged: true, merge_sha: MERGE } })
    expect(journal.page('', 100, true).map(item => item.id)).toEqual([current.id])
    expect(journal.admitInvocation(other, 'admit-second', invocation('two', 'review-issue', 'revision'), 1)).not.toBeNull()
  })

  it('preserves the interactive reserve and provider probes when an empty process adopts three durable behavior invocations', async () => {
    const { db, journal, chain } = setup()
    const slots = new CheckSemaphore(() => 4)
    expect(slots.laneCapacity('behavior')).toBe(3)
    for (const number of [7, 8, 9]) {
      const current = number === 7 ? chain : journal.append(`example/repo#${number}`, `seed-${number}`, 0,
        { type: 'chain.admitted', repository: 'Example/Repo', issue: number, branch: `poise/issue-${number}`, author: 'author', reviewer: 'reviewer' }, NOW)
      expect(journal.admitInvocation(current, `admit-${number}`, invocation(`work-${number}`, 'review-issue', 'revision'), slots.laneCapacity('behavior'))).not.toBeNull()
    }
    const restarted = new BehaviorChainJournal(db); restarted.rebuild()
    const freshSlots = new CheckSemaphore(() => 4)
    expect(freshSlots.stats().running).toBe(0)
    const fourth = restarted.append('example/repo#10', 'seed-10', 0,
      { type: 'chain.admitted', repository: 'Example/Repo', issue: 10, branch: 'poise/issue-10', author: 'author', reviewer: 'reviewer' }, NOW)
    expect(restarted.admitInvocation(fourth, 'admit-10', invocation('work-10', 'review-issue', 'revision'), freshSlots.laneCapacity('behavior'))).toBeNull()
    expect(freshSlots.tryAcquire('person')).not.toBeNull()
    let prepared = 0
    const entries = [7, 8, 9].map((number) => ({ id: String(number).repeat(32), correlation_id: `work-${number}`,
      source: 'poise:behavior-chain', actor: 'reviewer', repo: 'Example/Repo', behavior: 'issue_review', status: 'running' }) as LogEntry)
    await new BehaviorChainRuntime(restarted, operations({ capacity: () => freshSlots.laneCapacity('behavior'),
      available: () => freshSlots.available('behavior'), readInvocations: async () => ({ entries, quarantined: [] }),
      request: async () => { prepared++; return { command: 'agent-interface', argv: ['--model', 'fixture-model'], cwd: '/fixture' } },
    })).run()
    expect(prepared).toBe(0)
    record(restarted, restarted.read(chain.id)!, { type: 'invocation.settled', invocationId: 'work-7', callId: 'native',
      outcome: 'commented', evidence: { status: 'completed', resources_settled_at: new Date(NOW).toISOString() } })
    expect(restarted.admitInvocation(restarted.read(fourth.id)!, 'admit-10', invocation('work-10', 'review-issue', 'revision'), freshSlots.laneCapacity('behavior'))).not.toBeNull()
  })
})
