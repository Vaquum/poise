import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { BehaviorChainJournal, chainBasis, chainIdentity, type BehaviorChain, type ChainAdmission, type ChainEvent, type ChainInvocation } from '../server/behavior-chain-store'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import type { LogEntry } from '../server/agent-log-parse'
import { CheckSemaphore } from '../server/check-semaphore'

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

describe('authoritative behavior journal', () => {
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
    obs.pull!.merged = true; obs.pull!.mergeSha = MERGE; obs.pull!.state = 'closed'
    expect(decideBehaviorChain(current, obs, NOW)).toEqual({ kind: 'complete', mergeSha: MERGE })
  })

  it('requires a fresh diagnosis and approval before requeueing an unchanged rejected head', () => {
    const { journal, chain } = setup(); const obs = observation()
    let current = reviewed(journal, chain, obs); pull(obs)
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD, CONTEXT]),
      { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 27, head_sha: HEAD })
    current = finish(journal, current, 'queue', 'merge-pr', 'queue-basis', { status: 'completed', outcome: 'enqueued', head_sha: HEAD }, null)
    obs.pull!.approved = true; obs.pull!.ready = true
    obs.pull!.queueRemoval = { id: 'failed-integration', reason: 'failed_checks', at: NOW, actor: null }
    const repair = decideBehaviorChain(current, obs, NOW)
    expect(repair).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
    if (repair.kind !== 'invoke') throw new Error('expected repair')
    const repairInvocation = invocation('diagnosis', 'repair-pr', repair.basis)
    repairInvocation.request.context = { head: HEAD, reviewRevision: obs.pull!.reviewRevision, queueRemoval: 'failed-integration' }
    current = record(journal, current, { type: 'invocation.admitted', invocation: repairInvocation })
    current = record(journal, current, { type: 'invocation.settled', invocationId: 'diagnosis', callId: 'diagnosis-native', outcome: 'no_changes',
      evidence: { status: 'completed', action: 'no_changes', head_sha: HEAD } })
    const verify = decideBehaviorChain(current, obs, NOW)
    expect(verify).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
    if (verify.kind !== 'invoke') throw new Error('expected independent approval')
    obs.pull!.reviewIds.push(28)
    current = finish(journal, current, 'verify-integration-repair', 'approve-pr', verify.basis,
      { status: 'completed', action: 'approved', outcome: 'approved', review_id: 28, head_sha: HEAD })
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'invoke', behavior: 'merge-pr' })
    // Admission to the second queue attempt still cannot complete the chain.
    obs.pull!.queueEntry = 'second-integration-attempt'
    expect(decideBehaviorChain(current, obs, NOW)).toMatchObject({ kind: 'wait' })
  })
})

describe('native admission and recovery', () => {
  function operations(overrides: Partial<ChainRuntimeOperations> = {}): ChainRuntimeOperations {
    return { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }), discover: async () => [],
      ownsRepository: () => true, observe: async () => ({ ...observation(), checkedAt: Date.now() }),
      readInvocations: async () => ({ entries: [], quarantined: [] }), received: () => {}, available: () => true, capacity: () => 2,
      permitted: () => true, request: async () => ({ command: 'agent-interface', argv: ['--model', 'fixture-model'], cwd: '/fixture' }),
      launch: async () => true, perform: async () => ({}), resumePublication: async () => { throw new Error('unexpected publication resume') }, wake: () => {}, ...overrides }
  }

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
      evidence: { callId: nativeId, resources_settled_at: new Date(now).toISOString(), completedAt: now } })
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
    const call = { id: 'a'.repeat(32), correlation_id: pending.id, source: 'poise:behavior-chain', actor: 'reviewer',
      repo: 'Example/Repo', behavior: 'issue_review', status: 'completed', outcome: 'commented', action: 'commented',
      issue_revision: obs.issue.revision, resources_settled_at: new Date(NOW).toISOString(),
      receipts: [{ issue: 'Example/Repo#7', comment_id: 17, author: 'reviewer' }] } as LogEntry
    const runtime = new BehaviorChainRuntime(journal, operations({ discover: async () => { throw new Error('intake is stale') },
      readInvocations: async () => ({ entries: [call], quarantined: [] }) }))
    await expect(runtime.run()).rejects.toThrow('intake is stale')
    const current = journal.read(chain.id)!
    expect(current.invocations[0]).toMatchObject({ state: 'settled', callId: call.id, outcome: 'commented' })
    expect(current.invocations[1]).toMatchObject({ behavior: 'implement-issue', state: 'started' })
  })

  it.each(['review-pr', 'approve-pr'] as const)('recovers a relative %s target against the original chain without a checkout or a new admission', async (behavior) => {
    const { journal, chain } = setup()
    const pending = invocation('original-correlation', behavior, 'head')
    pending.admittedAt = Date.now() - 60_000
    pending.request = { command: 'agent-interface', cwd: '/interface', argv: [behavior === 'review-pr' ? '--pr-review' : '--pr-approve', '#37', '--pwd', '/empty/interface/directory'] }
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: pending })
    current = record(journal, current, { type: 'invocation.started', invocationId: pending.id })
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
        source: 'poise:behavior-chain', repo: 'Example/Repo', actor: 'reviewer', behavior: 'issue_review',
        status: completed ? 'completed' : 'running', action: completed ? 'commented' : null, outcome: completed ? 'commented' : null,
        issue_revision: obs.issue.revision, receipts: [{ issue: 'Example/Repo#7', comment_id: 17, author: 'reviewer' }],
        resources_settled_at: completed ? new Date().toISOString() : null,
      } as LogEntry] : [] }),
    }))
    await runtime.run()
    expect(launched).toEqual(['review-issue'])
    await runtime.run()
    expect(observations).toBe(1)
    completed = true
    await runtime.run()
    expect(launched).toEqual(['review-issue', 'implement-issue'])
    expect(observations).toBe(2)
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

  it('retains original ownership when a repeat launch is deferred without a native receipt', async () => {
    const { journal, chain } = setup()
    const admitted = record(journal, chain, { type: 'invocation.admitted', invocation: { ...invocation('same-correlation', 'review-issue', 'revision'), admittedAt: Date.now() - 60_000 } })
    record(journal, admitted, { type: 'invocation.started', invocationId: 'same-correlation' })
    const runtime = new BehaviorChainRuntime(journal, operations({ launch: async (pending) => {
      expect(pending.id).toBe('same-correlation'); return false
    } }))
    await runtime.run()
    expect(journal.read(chain.id)!.invocations[0]).toMatchObject({ state: 'started', evidence: { retryUsesSameCorrelation: true, repeatLaunchDeferred: true } })
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
      pr_id: '21', model: 'fixture-model', session_id: null, prompt: '', started_at: new Date(NOW).toISOString(), time_elapsed: '1s',
      head_sha: null, expected_head: HEAD, response: null, error: 'PR head confirmation timed out',
      artifact: { phase: 'publishing', plan_sha: 'b'.repeat(64) } }
    obs.publication.head_invocation = callId
    obs.workPublication = { callId, repliesComplete: false, resumable: true, planSha: 'b'.repeat(64) }
    let resumed = 0
    const runtime = new BehaviorChainRuntime(journal, operations({ observe: async () => ({ ...obs, checkedAt: Date.now() }),
      readInvocations: async () => ({ entries: [call], quarantined: [] }), resumePublication: async (original, head) => {
        expect(original.id).toBe(pending.id)
        expect(head).toBe(HEAD)
        expect(journal.read(chain.id)!.invocations[0].evidence).toMatchObject({ publicationResume: { callId, head: HEAD } })
        resumed++; throw new Error('completion response lost')
      }, launch: async () => { throw new Error('must not launch a replacement worker') } }))
    await runtime.run()
    expect(resumed).toBe(1)
    expect(journal.read(chain.id)!.invocations).toHaveLength(1)
    expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
    obs.workPublication.resumable = false
    call.artifact = { ...call.artifact, replies_started: true }
    await runtime.run()
    expect(resumed).toBe(1)
    expect(journal.read(chain.id)!.invocations[0].evidence?.artifact).toMatchObject({ replies_started: true })
    obs.workPublication.repliesComplete = true
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
