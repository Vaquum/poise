import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { parseAgentLogStdout, type LogEntry } from '../server/agent-log-parse'
import { BehaviorChainJournal, type BehaviorChain, type ChainBehavior, type ChainEvent } from '../server/behavior-chain-store'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import type { ChainObservation } from '../server/behavior-chain-decision'
import { completedReviewCall } from './review-response-fixture'

const NOW = 1_800_000_000_000
const HEAD = 'a'.repeat(40)
const MERGE = 'b'.repeat(40)
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
const databases: Database.Database[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.useRealTimers() })

function record(journal: BehaviorChainJournal, chain: BehaviorChain, event: ChainEvent) {
  return journal.append(chain.id, `${chain.id}:${chain.sequence}`, chain.sequence, event)
}
function observed(kind: 'merged' | 'closed' | 'issue-closed' | 'open' = 'merged'): ChainObservation {
  const hasPull = kind !== 'issue-closed'
  return { checkedAt: Date.now(), existingPulls: [], issue: { open: kind !== 'issue-closed', eligible: true, revision: 'seed', commentIds: [] },
    issueReviewers: [reviewer], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer,
    publication: { pull_number: hasPull ? 17 : null, head_sha: hasPull ? HEAD : null, head_invocation: null,
      state: hasPull ? kind === 'open' ? 'open' : 'closed' : null, merged: kind === 'merged', merge_sha: kind === 'merged' ? MERGE : null },
    pull: hasPull ? { number: 17, head: HEAD, headSince: NOW - 1000, state: kind === 'open' ? 'open' : 'closed', draft: false,
      merged: kind === 'merged', mergeSha: kind === 'merged' ? MERGE : null, mergedAt: kind === 'merged' ? NOW : null,
      queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'revision', reviewContext: 'c'.repeat(64), greyRuns: [], pending: false,
      failing: [], conflict: false, behind: false } : null }
}
function setup(behavior: ChainBehavior | null = 'repair-pr', started = false) {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  const db = new Database(':memory:'); databases.push(db)
  const journal = new BehaviorChainJournal(db)
  let chain = journal.append('aaa/repo#7', 'seed', 0, { type: 'chain.admitted', repository: 'aaa/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  if (behavior) chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'original', behavior,
    actor: ['implement-issue', 'repair-pr'].includes(behavior) ? 'author' : 'reviewer', model: 'fixture', slot: 'primary',
    basis: 'original', admittedAt: NOW - 60_000, reservation: { memoryBytes: 8, diskBytes: 16 },
    request: { command: 'agent-interface', cwd: '/isolated', argv: ['--atomic-work', 'aaa/repo#7', '--model', 'fixture'] } } })
  if (started) chain = record(journal, chain, { type: 'invocation.started', invocationId: 'original' })
  const calls: LogEntry[] = []
  const forbidden = vi.fn(async () => { throw new Error('closed work must not execute') })
  const fenceClosedTarget = vi.fn(async (_chain: BehaviorChain, invocation: BehaviorChain['invocations'][number]) => {
    const call = completedReviewCall(chain.repository, 17, HEAD, invocation.actor)
    Object.assign(call, { correlation_id: invocation.id, source: 'poise:behavior-chain', model: invocation.model,
      behavior: ({ 'repair-pr': 'repair_pr', 'review-pr': 'pr_review', 'approve-pr': 'pr_approve',
        'implement-issue': 'implement_issue', 'review-issue': 'issue_review' } as Partial<Record<ChainBehavior, string>>)[invocation.behavior],
      status: 'superseded', action: 'not_started', outcome: 'target_closed', artifact: { phase: 'admission_fenced' },
      head_sha: null, expected_head: ['review-issue', 'implement-issue'].includes(invocation.behavior) ? null : HEAD,
      pr_id: ['review-issue', 'implement-issue'].includes(invocation.behavior) ? String(chain.issue) : '17',
      review_id: null, review_comments: null, receipts: null, error_code: 'target_closed',
      resources_settled_at: new Date().toISOString() })
    calls.push(call)
    return true
  })
  const operations: ChainRuntimeOperations = { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    discover: async () => [], ownsRepository: () => true, observe: vi.fn(async () => observed()),
    readInvocations: vi.fn(async () => parseAgentLogStdout(JSON.stringify(calls), 'closed-target native receipt fixture')), received: () => {},
    available: () => true, capacity: () => 1, permitted: (_chain, decision) => !['review-pr', 'approve-pr'].includes(decision.behavior),
    request: forbidden, launch: forbidden, perform: forbidden, readActionResult: forbidden, resumePublication: forbidden, fenceClosedTarget, wake: () => {} }
  return { db, journal, chain, calls, operations, forbidden, fenceClosedTarget }
}

it.each(['repair-pr', 'review-pr', 'approve-pr', 'review-issue', 'implement-issue'] as const)(
  'settles an admitted %s on a merged target before any worker start, even while paused', async behavior => {
    const { journal, chain, operations, forbidden, fenceClosedTarget } = setup(behavior)
    operations.enabled = () => false
    await new BehaviorChainRuntime(journal, operations).run()
    const current = journal.read(chain.id)!
    expect(current.invocations[0]).toMatchObject({ state: 'settled', outcome: 'target_closed',
      evidence: { status: 'deferred', action: 'not_started' } })
    expect(current.mergeSha).toBe(MERGE)
    expect(journal.history(chain.id).some(row => JSON.parse(row.payload).type === 'invocation.started')).toBe(false)
    expect(journal.liveModelInvocationCount()).toBe(0)
    expect(journal.reservedResources().unaccounted).toBe(0)
    expect(forbidden).not.toHaveBeenCalled()
    expect(fenceClosedTarget).not.toHaveBeenCalled()
  })

it.each(['merged', 'closed', 'issue-closed'] as const)('holds a started original missing from readable receipts after %s without a retry or no-effect fence', async kind => {
  const { db, journal, chain, operations, forbidden, fenceClosedTarget } = setup(kind === 'issue-closed' ? 'review-issue' : 'repair-pr', true)
  operations.observe = vi.fn(async () => observed(kind))
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  expect(fenceClosedTarget).not.toHaveBeenCalled()
  expect(journal.read(chain.id)?.invocations[0]).toMatchObject({ state: 'uncertain', callId: null,
    outcome: expect.stringContaining('without a durable Call receipt') })
  expect(journal.liveModelInvocationCount()).toBe(1)
  expect(journal.reservedResources()).toEqual({ memoryBytes: 8, diskBytes: 16, unaccounted: 0 })
  const before = journal.history(chain.id)
  const reopened = new BehaviorChainJournal(db)
  reopened.rebuild()
  expect(journal.history(chain.id)).toEqual(before)
  await new BehaviorChainRuntime(reopened, operations).run()
  expect(fenceClosedTarget).not.toHaveBeenCalled()
  expect(forbidden).not.toHaveBeenCalled()
})

it('honors a durable merge even when a later observation has no PR', async () => {
  const { journal, chain, operations, forbidden, fenceClosedTarget } = setup('repair-pr', true)
  let current = record(journal, chain, { type: 'chain.observed', observation: observed('issue-closed') })
  current = record(journal, current, { type: 'chain.merged', mergeSha: MERGE,
    evidence: { repository: chain.repository, pull_number: 17, merged: true, merge_sha: MERGE, review_complete: false } })
  await new BehaviorChainRuntime(journal, operations).run()
  expect(fenceClosedTarget).not.toHaveBeenCalled()
  expect(journal.read(chain.id)?.invocations[0].state).toBe('uncertain')
  expect(operations.observe).not.toHaveBeenCalled()
  expect(forbidden).not.toHaveBeenCalled()
})

it('keeps capacity reserved for a closed original whose receipt is missing', async () => {
  const { journal, operations, fenceClosedTarget } = setup('repair-pr', true)
  const other = journal.append('zzz/repo#8', 'other-seed', 0, { type: 'chain.admitted', repository: 'zzz/repo', issue: 8,
    branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' })
  operations.observe = async chain => {
    const obs = observed(chain.id === other.id ? 'issue-closed' : 'merged')
    if (chain.id === other.id) obs.issue.open = true
    return obs
  }
  operations.request = vi.fn(async () => ({ command: 'agent-interface' as const, cwd: '/isolated', argv: ['--issue-review', 'zzz/repo#8', '--model', 'fixture'] }))
  operations.launch = vi.fn(async (_invocation, _exit, allowed) => allowed())
  await new BehaviorChainRuntime(journal, operations).run()
  expect(fenceClosedTarget).not.toHaveBeenCalled()
  expect(journal.read(other.id)?.invocations).toEqual([])
  expect(operations.launch).not.toHaveBeenCalled()
  expect(journal.liveModelInvocationCount()).toBe(1)
})

it('does not continue uncertain publication after merge but still adopts complete original replies', async () => {
  const { journal, chain, operations, forbidden } = setup('repair-pr', true)
  let current = record(journal, chain, { type: 'invocation.reconciled', invocationId: 'original', evidence: {
    callId: 'd'.repeat(32), resources_settled_at: new Date().toISOString(), artifact: { replies_started: false },
    resource_ownership: { version: 1, roots: [], errors: [] } } })
  current = record(journal, current, { type: 'invocation.uncertain', invocationId: 'original', reason: 'publication acknowledgement lost' })
  let complete = false
  operations.observe = async () => {
    const obs = observed()
    obs.publication.head_invocation = 'd'.repeat(32)
    obs.workPublication = { callId: 'd'.repeat(32), repliesComplete: complete, resumable: true, planSha: 'e'.repeat(64) }
    return obs
  }
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  const before = journal.history(chain.id)
  for (let pass = 0; pass < 5; pass++) await new BehaviorChainRuntime(journal, operations).run()
  expect(journal.history(chain.id)).toEqual(before)
  expect(forbidden).not.toHaveBeenCalled()
  complete = true
  vi.setSystemTime(NOW + 120_000)
  await runtime.run()
  expect(journal.read(chain.id)?.invocations[0]).toMatchObject({ state: 'settled', outcome: 'published' })
})

it('keeps a running original and uncertain resource ownership until native settlement, without observing or stopping it', async () => {
  const { journal, chain, calls, operations, forbidden, fenceClosedTarget } = setup('review-pr', true)
  const call = completedReviewCall(chain.repository, 17, HEAD, chain.reviewer)
  Object.assign(call, { source: 'poise:behavior-chain', correlation_id: 'original', status: 'running', completed_at: null,
    resources_settled_at: null, action: null, outcome: null, artifact: null,
    resource_ownership: { version: 1, roots: [], errors: [] } })
  calls.push(call)
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  Object.assign(call, { status: 'failed', action: 'not_started', outcome: 'preflight_failed', head_sha: null,
    error: 'original target closed before the provider ran', completed_at: new Date().toISOString() })
  await runtime.run()
  expect(journal.liveModelInvocationCount()).toBe(1)
  expect(operations.observe).not.toHaveBeenCalled()
  expect(fenceClosedTarget).not.toHaveBeenCalled()
  call.resources_settled_at = new Date().toISOString()
  await runtime.run()
  expect(journal.read(chain.id)?.invocations[0].state).toBe('settled')
  expect(journal.liveModelInvocationCount()).toBe(0)
  expect(forbidden).not.toHaveBeenCalled()
})

it('journals the recovery hold before a partial restore is readable, including held and disabled work', async () => {
  const { db, journal, chain, operations, forbidden, fenceClosedTarget } = setup('repair-pr', true)
  record(journal, chain, { type: 'chain.held', reason: 'person hold' })
  operations.enabled = () => false
  operations.readInvocations = vi.fn(async () => { throw new Error('native receipt store unavailable') })
  const runtime = new BehaviorChainRuntime(journal, operations)
  await expect(runtime.run()).rejects.toThrow('native receipt store unavailable')
  expect(journal.read(chain.id)).toMatchObject({ held: 'person hold', invocations: [{ state: 'uncertain', callId: null }] })
  const reopened = new BehaviorChainJournal(db)
  reopened.rebuild()
  operations.readInvocations = async () => ({ entries: [], quarantined: [] })
  await new BehaviorChainRuntime(reopened, operations).run()
  expect(journal.read(chain.id)).toMatchObject({ held: 'person hold', invocations: [{ state: 'uncertain', callId: null }] })
  expect(fenceClosedTarget).not.toHaveBeenCalled()
  expect(forbidden).not.toHaveBeenCalled()
  expect(journal.liveModelInvocationCount()).toBe(1)
  expect(journal.reservedResources()).toEqual({ memoryBytes: 8, diskBytes: 16, unaccounted: 0 })
})

it.each([false, true])('retains native-exit uncertainty without closure as release proof, with quarantine: %s', async quarantined => {
  const { journal, chain, operations, fenceClosedTarget } = setup('repair-pr', true)
  record(journal, chain, { type: 'invocation.reconciled', invocationId: 'original',
    evidence: { nativeExit: { code: 1, signal: null, error: null } } })
  if (quarantined) operations.readInvocations = async () => parseAgentLogStdout(JSON.stringify([
    { id: 'd'.repeat(32), correlation_id: 'original', status: 'invalid' },
  ]), 'closed-target malformed receipt fixture')
  await new BehaviorChainRuntime(journal, operations).run()
  expect(fenceClosedTarget).not.toHaveBeenCalled()
  expect(journal.read(chain.id)?.invocations[0].state).toBe('uncertain')
  expect(journal.liveModelInvocationCount()).toBe(1)
})

it('does not prepare a new repair for an open PR whose seed issue is closed', async () => {
  const { journal, chain, operations, forbidden } = setup(null)
  operations.observe = async () => {
    const obs = observed('open')
    obs.issue.open = false
    obs.pull!.failing = ['required-check']
    return obs
  }
  await new BehaviorChainRuntime(journal, operations).run()
  expect(journal.read(chain.id)?.invocations).toEqual([])
  expect(journal.read(chain.id)?.held).toContain('seed issue is closed')
  expect(forbidden).not.toHaveBeenCalled()
})

it('settles a never-started closed admission while disabled without replacing the person hold', async () => {
  const { journal, chain, operations, forbidden } = setup('repair-pr')
  record(journal, chain, { type: 'chain.held', reason: 'New invocations held by the person' })
  operations.enabled = () => false
  await new BehaviorChainRuntime(journal, operations).run()
  expect(journal.read(chain.id)).toMatchObject({ held: 'New invocations held by the person',
    invocations: [{ state: 'settled', outcome: 'target_closed' }] })
  expect(journal.liveModelInvocationCount()).toBe(0)
  expect(forbidden).not.toHaveBeenCalled()
})

it('rechecks canonical closure at the late launch boundary without accepting a worker', async () => {
  const { journal, chain, operations, fenceClosedTarget } = setup('repair-pr')
  operations.observe = async () => observed('open')
  operations.launch = vi.fn(async (_invocation, _exit, allowed) => {
    expect(allowed()).toBe(true)
    let current = record(journal, journal.read(chain.id)!, { type: 'chain.observed', observation: observed() })
    current = record(journal, current, { type: 'chain.merged', mergeSha: MERGE,
      evidence: { repository: chain.repository, pull_number: 17, merged: true, merge_sha: MERGE, review_complete: false } })
    expect(allowed()).toBe(false)
    return false
  })
  await new BehaviorChainRuntime(journal, operations).run()
  expect(journal.read(chain.id)?.invocations[0]).toMatchObject({ state: 'settled', outcome: 'launch_deferred' })
  expect(journal.liveModelInvocationCount()).toBe(0)
  expect(fenceClosedTarget).not.toHaveBeenCalled()
})

it('adopts an already-recorded native fence without repeating it or starting a worker', async () => {
  const { journal, chain, operations, fenceClosedTarget, forbidden } = setup('repair-pr', true)
  await fenceClosedTarget(chain, chain.invocations[0])
  fenceClosedTarget.mockClear()
  await new BehaviorChainRuntime(journal, operations).run()
  expect(journal.read(chain.id)?.invocations[0]).toMatchObject({ state: 'settled', outcome: 'target_closed' })
  expect(journal.liveModelInvocationCount()).toBe(0)
  expect(fenceClosedTarget).not.toHaveBeenCalled()
  expect(forbidden).not.toHaveBeenCalled()
})
