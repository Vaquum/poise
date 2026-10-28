import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { BehaviorChainJournal, chainBasis, chainIdentity, type BehaviorChain, type ChainEvent, type ChainInvocation } from '../server/behavior-chain-store'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import type { LogEntry } from '../server/agent-log-parse'

const NOW = 1_800_000_000_000
const HEAD = '1'.repeat(40)
const NEXT = '2'.repeat(40)
const MERGE = '3'.repeat(40)
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
function invocation(id: string, behavior: ChainInvocation['behavior'], basis: string, slot: string | null = 'primary'): Omit<ChainInvocation, 'state' | 'callId' | 'outcome' | 'evidence' | 'admissionSequence'> {
  return { id, behavior, basis, actor: behavior === 'implement-issue' || behavior === 'repair-pr' ? 'author' : 'reviewer',
    model: 'fixture-model', slot, admittedAt: NOW, request: { command: 'agent-interface', argv: ['--fixture'], cwd: '/fixture' } }
}
function finish(journal: BehaviorChainJournal, chain: BehaviorChain, id: string, behavior: ChainInvocation['behavior'], basis: string,
  evidence: Record<string, unknown>, slot: string | null = 'primary'): BehaviorChain {
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: invocation(id, behavior, basis, slot) })
  chain = record(journal, chain, { type: 'invocation.started', invocationId: id })
  return record(journal, chain, { type: 'invocation.settled', invocationId: id, callId: id, outcome: String(evidence.outcome), evidence })
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
    reviewIds: [27], reviewReceipts: [], reviewRevision: 'findings-1', greyRuns: [], pending: false, failing: [], conflict: false, behind: false }
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
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD]),
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
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD]),
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
    current = finish(journal, current, 'pr-review', 'review-pr', chainBasis(['pr', HEAD]),
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
      launch: async () => true, perform: async () => ({}), wake: () => {}, ...overrides }
  }

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
})
