import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import type { LogEntry } from '../server/agent-log-parse'
import { nativeActionReceipt, nativeRequestSha } from '../server/behavior-chain-action'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { BehaviorChainJournal, chainBasis, type BehaviorChain, type ChainInvocation } from '../server/behavior-chain-store'
import { behaviorChainSummary } from '../server/behavior-chain-summary'
import { completedReviewCall } from './review-response-fixture'

const HEAD = 'a'.repeat(40), MERGE = 'b'.repeat(40)
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers() })

function setup(held: string | null = null, remediation = false) {
  const db = new Database(':memory:'); databases.push(db)
  const journal = new BehaviorChainJournal(db)
  let chain = journal.append('example/repo#943', 'seed', 0, { type: 'chain.admitted', repository: 'example/repo', issue: 943,
    branch: 'poise/issue-943', author: 'author', reviewer: 'reviewer' })
  if (held) chain = journal.append(chain.id, 'hold', chain.sequence, { type: 'chain.held', reason: held })
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const coverage = remediation ? { kind: 'empty_integration', verified: true, base: MERGE,
    integration: { tree: 'c'.repeat(40), baseTree: 'c'.repeat(40), mergeBase: 'd'.repeat(40) },
    covering: [{ number: 940, mergeSha: MERGE, url: 'https://github.com/example/repo/pull/940' }], duplicate: { number: 946, head: HEAD } }
    : { verified: true, failures: [{ id: 1, sha: 'c'.repeat(40), attempt: 1, url: 'https://github.com/example/repo/actions/runs/1' }],
    recovery: { id: 2, sha: MERGE, attempt: 1, url: 'https://github.com/example/repo/actions/runs/2' },
    covering: [{ number: 940, mergeSha: MERGE, url: 'https://github.com/example/repo/pull/940' }], duplicate: { number: 946, head: HEAD } }
  const obs: ChainObservation = { checkedAt: Date.now(), issue: { open: remediation, eligible: true, revision: 'reported-failure', commentIds: [1] },
    issueReviewers: [reviewer], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer, existingPulls: [],
    publication: { pull_number: 946, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null },
    ...(remediation ? { remediation: coverage } : { fullSuite: coverage }),
    pull: { number: 946, head: HEAD, headSince: Date.now(), state: 'open', draft: false, merged: false, mergeSha: null, queueEntry: null,
      queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false, reviewIds: [], reviewReceipts: [],
      reviewRevision: 'review', greyRuns: [], pending: false, failing: [], conflict: true, behind: false } }
  const calls: LogEntry[] = []
  const result = { action: 'issue_work', repository: chain.repository, issue_number: chain.issue, pull_number: 946,
    head_sha: HEAD, merged: false, merge_sha: null, state: 'closed', outcome: 'closed', coverage }
  const operations: ChainRuntimeOperations = { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    ownsRepository: () => true, discover: async () => [], available: () => true, capacity: () => 1, permitted: () => true,
    observe: vi.fn(async () => ({ ...obs, checkedAt: Date.now() })), readInvocations: async () => ({ entries: calls, quarantined: [] }),
    received: () => {}, wake: () => {}, request: vi.fn<ChainRuntimeOperations['request']>(async (_chain, _obs, decision) => {
      expect(decision.behavior).toBe('retire-pr')
      return { command: 'github-interface', cwd: '/isolated/example/repo', nativeResources: 2,
        argv: ['--issue-work', '943', '--mode', 'retire', '--branch', chain.branch, '--pull-number', '946',
          '--expected-head', HEAD, '--token-user', 'author', '--coverage-json', JSON.stringify(coverage)] }
    }), launch: vi.fn(async () => { throw new Error('a recovered seed must not launch another worker') }),
    perform: vi.fn<ChainRuntimeOperations['perform']>(async invocation => {
      calls.push(actionCall(invocation, result))
      return { ...result, nativeCallId: calls.at(-1)!.id }
    }), readActionResult: async () => result, resumePublication: async () => { throw new Error('unexpected publication') },
    fenceClosedTarget: async () => { throw new Error('a running original must keep its native ownership') } }
  return { db, journal, chain, obs, operations, calls, result }
}

function actionCall(invocation: ChainInvocation, result: Record<string, unknown>): LogEntry {
  const call = completedReviewCall('example/repo', 943, HEAD, 'author')
  Object.assign(call, { id: 'f'.repeat(32), correlation_id: invocation.id, source: 'poise:behavior-chain', model: 'native-action', behavior: 'native_action',
    pr_id: '943', expected_head: HEAD, status: 'completed', action: 'native_action', outcome: 'native_action',
    artifact: { phase: 'received_native_action', request_sha: nativeRequestSha(invocation.request), response_sha: nativeRequestSha(result) },
    resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } })
  return call
}

it('reconciles an existing automatic closure hold, closes once and rebuilds distinct supersession without a duplicate merge', async () => {
  const { db, journal, chain, operations, result } = setup('No new repair-pr: the seed issue is closed')
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  expect(operations.perform).toHaveBeenCalledTimes(1)
  expect(journal.read(chain.id)?.supersession).toBeUndefined()
  await runtime.run()
  const current = journal.read(chain.id)!
  expect(() => nativeActionReceipt(current, current.invocations[0], { ...result, state: 'open' })).toThrow('original verified coverage')
  expect(current).toMatchObject({ held: null, mergeSha: null, supersession: { verified: true,
    covering: [{ number: 940, mergeSha: MERGE }], duplicate: { number: 946, head: HEAD }, failures: [{ id: 1 }], recovery: { id: 2 } } })
  expect(behaviorChainSummary(current).supersession).toEqual(current.supersession)
  expect(journal.active()).toEqual([])
  expect(journal.page()).toHaveLength(1)
  expect(journal.forPull(chain.repository, 946)?.id).toBe(chain.id)
  expect(journal.reconciliationAt(current)).toBeNull()
  const events = journal.history(chain.id)
  const reopened = new BehaviorChainJournal(db)
  reopened.rebuild()
  expect(reopened.read(chain.id)).toEqual(current)
  for (let pass = 0; pass < 3; pass++) await new BehaviorChainRuntime(reopened, operations).run()
  expect(reopened.history(chain.id)).toEqual(events)
  expect(operations.perform).toHaveBeenCalledTimes(1)
  expect(operations.launch).not.toHaveBeenCalled()
})

it('retires a queued remediation when a covering merge lands, retaining the source hold and outstanding work', async () => {
  const { db, journal, chain, obs, operations } = setup(null, true)
  let source = journal.append('example/repo#1608', 'source', 0, { type: 'chain.admitted', repository: chain.repository,
    issue: 1608, branch: 'poise/issue-1608', author: chain.author, reviewer: chain.reviewer })
  source = journal.append(source.id, 'source-hold', source.sequence, { type: 'chain.held', reason: 'original preflight hold; source work remains' })
  obs.issueReviewers = []
  obs.pull!.queueEntry = 'original-queue-entry'
  obs.remediation!.verified = false
  const observe = operations.observe
  operations.observe = async current => current.id === source.id ? { ...obs, checkedAt: Date.now(), remediation: undefined,
    pull: null, publication: { ...obs.publication, pull_number: null, head_sha: null } } : observe(current)
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  expect(journal.read(chain.id)?.waiting).toContain('native merge queue owns entry')
  expect(operations.perform).not.toHaveBeenCalled()
  obs.remediation!.verified = true
  await runtime.run()
  expect(operations.perform).toHaveBeenCalledTimes(1)
  await runtime.run()
  expect(journal.read(chain.id)).toMatchObject({ mergeSha: null, supersession: obs.remediation,
    invocations: [{ behavior: 'retire-pr', state: 'settled', evidence: { nativeActionReceipt: { result: { outcome: 'closed' } } } }] })
  expect(journal.read(source.id)).toMatchObject({ held: source.held, mergeSha: null, invocations: [] })
  expect(journal.read(source.id)?.supersession).toBeUndefined()
  const reopened = new BehaviorChainJournal(db)
  reopened.rebuild()
  expect(reopened.read(chain.id)?.supersession).toEqual(obs.remediation)
  expect(operations.launch).not.toHaveBeenCalled()
})

it('keeps independent work and incomplete or stale remediation coverage under ordinary gates', () => {
  const { chain, obs } = setup(null, true)
  obs.issueReviewers = []
  obs.prReviewers = []
  obs.pull!.conflict = false
  obs.remediation!.verified = false
  expect(decideBehaviorChain(chain, obs, Date.now())).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
  obs.remediation!.verified = true
  const first = decideBehaviorChain(chain, obs, Date.now())
  expect(first).toMatchObject({ kind: 'invoke', behavior: 'retire-pr' })
  obs.remediation!.base = 'e'.repeat(40)
  const changed = decideBehaviorChain(chain, obs, Date.now())
  expect(changed).toMatchObject({ kind: 'invoke', behavior: 'retire-pr' })
  if (first.kind === 'invoke' && changed.kind === 'invoke') expect(changed.basis).not.toBe(first.basis)
  obs.pull!.head = 'f'.repeat(40)
  obs.publication.head_sha = obs.pull!.head
  expect(decideBehaviorChain(chain, obs, Date.now())).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
  obs.pull!.queueEntry = 'queued-independent-work'
  expect(decideBehaviorChain(chain, obs, Date.now())).toMatchObject({ kind: 'wait', reason: expect.stringContaining('native merge queue') })
})

it('preserves a person’s hold and keeps independent or changed-head work visible for a decision', async () => {
  const { journal, chain, obs, operations } = setup('New invocations held by the person')
  await new BehaviorChainRuntime(journal, operations).run()
  expect(journal.read(chain.id)?.held).toBe('New invocations held by the person')
  expect(operations.perform).not.toHaveBeenCalled()
  const unheld: BehaviorChain = { ...chain, held: null }
  obs.fullSuite = { ...obs.fullSuite, verified: false, reason: 'duplicate has independent work outside the reported tests' }
  expect(decideBehaviorChain(unheld, obs, Date.now())).toMatchObject({ kind: 'hold', reason: expect.stringContaining('independent work') })
  obs.fullSuite.verified = true
  obs.pull!.head = 'f'.repeat(40)
  expect(decideBehaviorChain(unheld, obs, Date.now())).toMatchObject({ kind: 'hold' })
  obs.pull!.head = HEAD
  obs.existingPulls = ['https://github.com/example/repo/pull/947']
  expect(decideBehaviorChain(unheld, obs, Date.now())).toMatchObject({ kind: 'hold', reason: expect.stringContaining('linked work') })
})

it('waits for an active original and its native release before closing, then waits for the close action’s release', async () => {
  const { journal, chain, obs, operations, calls } = setup()
  const original = { id: 'original', behavior: 'repair-pr' as const, actor: chain.author, model: 'fixture', slot: 'primary',
    basis: 'original', admittedAt: Date.now(), request: { command: 'agent-interface' as const, cwd: '/isolated', argv: ['--atomic-work', 'example/repo#943'] } }
  let current = journal.append(chain.id, 'original', chain.sequence, { type: 'invocation.admitted', invocation: original })
  current = journal.append(chain.id, 'started', current.sequence, { type: 'invocation.started', invocationId: original.id })
  const call = completedReviewCall(chain.repository, 946, HEAD, chain.author)
  Object.assign(call, { correlation_id: original.id, source: 'poise:behavior-chain', model: 'fixture', behavior: 'repair_pr',
    status: 'running', completed_at: null, resources_settled_at: null, resource_ownership: { version: 1, roots: [], errors: [] } })
  calls.push(call)
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  expect(operations.observe).not.toHaveBeenCalled()
  Object.assign(call, { status: 'completed', action: 'published', outcome: 'published', completed_at: new Date().toISOString() })
  await runtime.run()
  expect(operations.perform).not.toHaveBeenCalled()
  expect(journal.read(chain.id)?.invocations[0].state).toBe('uncertain')
  call.resources_settled_at = new Date().toISOString()
  await runtime.run()
  expect(journal.read(chain.id)?.invocations[0].state).toBe('settled')
  expect(operations.perform).toHaveBeenCalledTimes(1)
  const close = calls.at(-1)!
  close.resources_settled_at = null
  await runtime.run()
  expect(journal.read(chain.id)?.supersession).toBeUndefined()
  close.resources_settled_at = new Date().toISOString()
  await runtime.run()
  expect(journal.read(chain.id)?.supersession).toEqual(obs.fullSuite)
})

it.each([false, true])('retains a lost close response as uncertain across closed observations, sweeps and rebuild (remediation=%s)', async remediation => {
  const { db, journal, chain, obs, operations } = setup(null, remediation)
  operations.perform = vi.fn(async () => { throw new Error('native close response lost') })
  await new BehaviorChainRuntime(journal, operations).run()
  obs.pull!.state = 'closed'
  obs.publication.state = 'closed'
  const reopened = new BehaviorChainJournal(db)
  reopened.rebuild()
  for (let pass = 0; pass < 3; pass++) await new BehaviorChainRuntime(reopened, operations).run()
  expect(reopened.read(chain.id)).toMatchObject({ mergeSha: null, invocations: [{ behavior: 'retire-pr', state: 'uncertain' }] })
  expect(reopened.read(chain.id)?.supersession).toBeUndefined()
  expect(reopened.liveModelInvocationCount()).toBe(0)
  expect(reopened.reservedResources().unaccounted).toBe(1)
  expect(operations.perform).toHaveBeenCalledTimes(1)
  expect(operations.launch).not.toHaveBeenCalled()
})

it('reconciles original possible publication and every reply before retiring a recovered repair', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { journal, chain, obs, operations, calls } = setup()
  const call = completedReviewCall(chain.repository, 946, HEAD, chain.author)
  Object.assign(call, { correlation_id: 'original', source: 'poise:behavior-chain', behavior: 'repair_pr',
    status: 'failed', action: 'published', outcome: 'publication_incomplete', error: 'original publication response lost',
    resource_ownership: { version: 1, roots: [], errors: [] }, resources_settled_at: new Date().toISOString() })
  calls.push(call)
  let current = journal.append(chain.id, 'original', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: 'original', behavior: 'repair-pr', actor: chain.author, model: call.model, slot: 'primary', basis: 'original',
    admittedAt: Date.now(), request: { command: 'agent-interface', cwd: '/isolated', argv: ['--atomic-work', 'example/repo#943'] } } })
  current = journal.append(chain.id, 'started', current.sequence, { type: 'invocation.started', invocationId: 'original' })
  obs.publication.head_invocation = call.id
  obs.workPublication = { callId: call.id, repliesComplete: false }
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  expect(journal.read(chain.id)?.invocations[0].state).toBe('uncertain')
  expect(operations.perform).not.toHaveBeenCalled()
  obs.workPublication.repliesComplete = true
  vi.setSystemTime(Date.now() + 120_001)
  await runtime.run()
  expect(journal.read(chain.id)?.invocations[0]).toMatchObject({ state: 'settled', callId: call.id, outcome: 'published' })
  vi.setSystemTime(Date.now() + 240_001)
  await runtime.run()
  await runtime.run()
  expect(journal.read(chain.id)?.supersession).toEqual(obs.fullSuite)
  expect(operations.perform).toHaveBeenCalledTimes(1)
})

it('holds an unconfirmed retirement on identical evidence instead of re-invoking in a loop', async () => {
  const { journal, chain, obs } = setup()
  const coverage = obs.fullSuite as Record<string, unknown>
  let current = journal.append(chain.id, 'retire', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: 'retire-1', behavior: 'retire-pr', actor: chain.author, model: null, slot: null, basis: chainBasis(['retire', coverage]),
    admittedAt: Date.now(), request: { command: 'github-interface', cwd: '/isolated', argv: ['--issue-work', '943'] } } })
  current = journal.append(chain.id, 'started', current.sequence, { type: 'invocation.started', invocationId: 'retire-1' })
  current = journal.append(chain.id, 'settled', current.sequence, { type: 'invocation.settled', invocationId: 'retire-1',
    callId: null, outcome: 'not_ready', evidence: { status: 'failed', action: 'not_started', outcome: 'not_ready' } })
  const decision = decideBehaviorChain(current, { ...obs, checkedAt: Date.now() }, Date.now())
  expect(decision).toMatchObject({ kind: 'hold', reason: expect.stringContaining('redundant PR retirement needs a decision') })
})

it('re-invokes retirement when the duplicate head moved after an unconfirmed attempt', async () => {
  const { journal, chain, obs } = setup()
  const coverage = obs.fullSuite as Record<string, unknown>
  let current = journal.append(chain.id, 'retire', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: 'retire-1', behavior: 'retire-pr', actor: chain.author, model: null, slot: null, basis: chainBasis(['retire', coverage]),
    admittedAt: Date.now(), request: { command: 'github-interface', cwd: '/isolated', argv: ['--issue-work', '943'] } } })
  current = journal.append(chain.id, 'started', current.sequence, { type: 'invocation.started', invocationId: 'retire-1' })
  current = journal.append(chain.id, 'settled', current.sequence, { type: 'invocation.settled', invocationId: 'retire-1',
    callId: null, outcome: 'not_ready', evidence: { status: 'failed', action: 'not_started', outcome: 'not_ready' } })
  const moved = 'd'.repeat(40)
  const fresh = { ...coverage, duplicate: { number: 946, head: moved } }
  const decision = decideBehaviorChain(current, { ...obs, checkedAt: Date.now(), fullSuite: fresh,
    pull: { ...obs.pull!, head: moved }, publication: { ...obs.publication, head_sha: moved } }, Date.now())
  expect(decision).toMatchObject({ kind: 'invoke', behavior: 'retire-pr', basis: chainBasis(['retire', fresh]) })
})
