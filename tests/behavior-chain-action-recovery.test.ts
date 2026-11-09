import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { BehaviorChainJournal, chainBasis, type BehaviorChain, type ChainAdmission, type ChainInvocation } from '../server/behavior-chain-store'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { matchingNativeActionReceipt, nativeActionReceipt, nativeActionSettlement, nativeRequestSha } from '../server/behavior-chain-action'
import { BehaviorResourceRecovery } from '../server/behavior-chain-resource-recovery'
import { completedReviewCall } from './review-response-fixture'
import type { LogEntry } from '../server/agent-log-parse'

const HEAD = 'a'.repeat(40)
const MERGE = 'b'.repeat(40)
const databases: Database.Database[] = []
const directories: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(behavior: 'merge-pr' | 'resolve-threads' = 'merge-pr', pending = true, filename = ':memory:', contained = false) {
  const db = new Database(filename)
  databases.push(db)
  const journal = new BehaviorChainJournal(db)
  let chain = journal.append('example/repo#7', 'seed', 0, { type: 'chain.admitted', repository: 'example/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  const invocation: ChainAdmission = { id: 'original-action', behavior, basis: 'exact-request', actor: 'reviewer', model: null,
    slot: null, admittedAt: Date.now() - 20_000, ...(contained ? { reservation: { memoryBytes: 8, diskBytes: 16 } } : {}),
    request: { command: 'github-interface', cwd: '/isolated/example/repo', ...(contained ? { nativeResources: 2 as const } : {}),
      argv: [behavior === 'merge-pr' ? '--merge-if-ready' : '--resolve-nonblocking-conversations-if-ready', '21',
        '--expected-head', HEAD, '--token-user', 'reviewer'] } }
  if (pending) {
    chain = journal.append(chain.id, 'admit', chain.sequence, { type: 'invocation.admitted', invocation })
    chain = journal.append(chain.id, 'uncertain', chain.sequence, { type: 'invocation.uncertain', invocationId: invocation.id,
      reason: 'acknowledgement lost' })
  }
  return { db, journal, chain }
}

function observation(): ChainObservation {
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  return { checkedAt: Date.now(), issue: { open: true, revision: 'body', eligible: true, commentIds: [] },
    issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer, existingPulls: [],
    publication: { pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null },
    pull: { number: 21, head: HEAD, headSince: Date.now(), state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: true, ready: true,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'reviews', greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }
}

function operations(obs: ChainObservation, overrides: Partial<ChainRuntimeOperations> = {}): ChainRuntimeOperations {
  return { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }), discover: async () => [],
    ownsRepository: () => true, observe: async () => ({ ...obs, checkedAt: Date.now() }), readInvocations: async () => ({ entries: [], quarantined: [] }),
    received: () => {}, available: () => true, capacity: () => 2, permitted: () => true,
    request: async () => { throw new Error('unexpected admission') }, launch: async () => { throw new Error('unexpected launch') },
    perform: async () => { throw new Error('must not repeat an uncertain action') }, resumePublication: async () => { throw new Error('unexpected resume') },
    readActionResult: async () => { throw new Error('unexpected native response read') },
    fenceClosedTarget: async () => { throw new Error('unexpected closed-target fence') },
    wake: () => {}, ...overrides }
}

it.each(['same-head merge', 'different-head merge', 'queue entry'])('keeps the original action uncertain after an independent %s', async (state) => {
  const { journal, chain } = setup()
  const obs = observation()
  if (state === 'queue entry') obs.pull!.queueEntry = 'unrelated-entry'
  else {
    Object.assign(obs.pull!, { merged: true, state: 'closed', mergeSha: MERGE })
    if (state === 'different-head merge') obs.pull!.head = 'c'.repeat(40)
  }
  const perform = vi.fn(async () => ({}))
  await new BehaviorChainRuntime(journal, operations(obs, { perform })).run()
  const current = journal.read(chain.id)!
  expect(current.invocations[0]).toMatchObject({ id: 'original-action', state: 'uncertain', outcome: 'acknowledgement lost' })
  expect(perform).not.toHaveBeenCalled()
  expect(current.invocations).toHaveLength(1)
  if (state !== 'queue entry') expect(current).toMatchObject({ mergeSha: MERGE, reviewPending: true })
})

it('does not attribute somebody else resolving the conversations to the original invocation', async () => {
  const { journal, chain } = setup('resolve-threads')
  await new BehaviorChainRuntime(journal, operations(observation())).run()
  expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
})

function acceptedMerge() {
  return { action: 'merge_if_ready', repository: 'example/repo', pull_number: 21, head_sha: HEAD,
    outcome: 'merged', merge_sha: MERGE, merge_method: 'squash' }
}

function releasedAction(invocation: ChainInvocation, result?: Record<string, unknown>): LogEntry {
  const id = 'c'.repeat(32), stamp = Date.now()
  return { id, correlation_id: invocation.id, model: 'native-action', behavior: 'native_action', source: 'poise:behavior-chain',
    actor: invocation.actor, repo: 'example/repo', pr_id: invocation.request.argv[1], session_id: null, prompt: '',
    started_at: new Date(invocation.admittedAt).toISOString(), completed_at: new Date(stamp).toISOString(), time_elapsed: '1s',
    status: 'failed', action: null, outcome: null, error: 'original process failed', head_sha: null, expected_head: HEAD,
    response: result ? id.slice(0, 8) : null, resources_settled_at: new Date(stamp).toISOString(),
    resource_ownership: { version: 2, roots: [], errors: [], namespace: { state: 'settled', callId: id,
      correlation: invocation.id, settled_at: stamp / 1000, controller: { version: 1, instance: 'd'.repeat(32) },
      binding: { pid: 104, start: '12', namespace: 'pid:[91]', owner: { pid: 102, start: '10' },
        holder: { pid: 103, start: '11' }, epoch: { boot: 'fixture', init_start: '1', namespace_dev: '2', namespace_ino: '3' } } } },
    artifact: { phase: result ? 'received_native_action' : 'performing_native_action', request_sha: nativeRequestSha(invocation.request),
      ...(result ? { response_sha: chainBasis(result) } : {}) } }
}

it('releases native resources using Caller encoding while preserving the original journal receipt', async () => {
  const { journal, chain } = setup('merge-pr', true, ':memory:', true)
  const invocation = chain.invocations[0]
  const result = { action: 'merge_if_ready', repository: chain.repository, pull_number: 21, head_sha: HEAD,
    outcome: 'enqueued', queue_entry_id: 'original-queue-entry' }
  const proof = nativeActionReceipt(chain, invocation, result)
  const current = journal.append(chain.id, 'accepted-response', chain.sequence, { type: 'invocation.reconciled',
    invocationId: invocation.id, evidence: { nativeActionReceipt: proof } })
  const originalEvents = journal.history(chain.id)
  const call = releasedAction(invocation, result)
  const correctDigest = call.artifact!.request_sha
  const recovery = new BehaviorResourceRecovery(journal, async () => ({ entries: [call], quarantined: [] }))
  call.artifact!.request_sha = '0'.repeat(64)
  await expect(recovery.run()).rejects.toThrow('immutable request')
  expect(journal.reservedResources()).toEqual({ memoryBytes: 8, diskBytes: 16, unaccounted: 0 })
  call.artifact!.request_sha = correctDigest
  await recovery.run()
  const recovered = journal.read(chain.id)!
  expect(recovered.invocations[0]).toMatchObject({ state: current.invocations[0].state, outcome: current.invocations[0].outcome })
  expect(recovered.invocations[0].evidence!.nativeActionReceipt).toEqual(proof)
  expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
  expect(journal.history(chain.id).slice(0, originalEvents.length)).toEqual(originalEvents)
  journal.rebuild()
  expect(journal.read(chain.id)).toEqual(recovered)
})

it.each(['rerun-grey-ci', 'publish-issue'] as const)('keeps physical release proof when %s recovers from an observation', async behavior => {
  const { journal, chain } = setup('merge-pr', false)
  const request: ChainAdmission = { id: 'original-direct', behavior, basis: 'original-request', actor: behavior === 'publish-issue' ? chain.author : chain.reviewer,
    model: null, slot: null, admittedAt: Date.now() - 1000, reservation: { memoryBytes: 8, diskBytes: 16 },
    request: { command: 'github-interface', cwd: '/fixture', nativeResources: 2, argv: behavior === 'publish-issue'
      ? ['--issue-work', '7', '--invocation-id', 'original-native', '--expected-head', HEAD]
      : ['--rerun-grey-ci-if-ready', '21', '--expected-head', HEAD] } }
  const admitted = journal.append(chain.id, 'direct', chain.sequence, { type: 'invocation.admitted', invocation: request })
  const invocation = admitted.invocations[0]
  const call = releasedAction(invocation)
  const obs = observation()
  obs.publication.head_invocation = 'original-native'
  obs.greyRecovery = { invocationId: invocation.id, receipt: { outcome: 'rerun_observed', observed_run_attempt: 3 } }
  const perform = vi.fn(async () => { throw new Error('must not repeat recovered work') })
  await new BehaviorChainRuntime(journal, operations(obs, { enabled: () => false, perform,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  const current = journal.read(chain.id)!
  expect(current.invocations[0]).toMatchObject({ state: 'settled', callId: call.id,
    evidence: { nativeCallId: call.id, nativeCallStatus: 'failed', resources_settled_at: call.resources_settled_at, resource_ownership: call.resource_ownership } })
  expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
  expect(perform).not.toHaveBeenCalled()
  const history = journal.history(chain.id)
  journal.rebuild()
  expect(journal.history(chain.id)).toEqual(history)
  expect(journal.admitInvocation(current, 'next', { ...request, id: 'next-direct' }, 2)).not.toBeNull()
})

it('reads an uncertain non-attributed result once and retains only changed receipts on later passes', async () => {
  const { journal, chain } = setup('merge-pr', false)
  const admitted = journal.append(chain.id, 'direct', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: 'original-grey', behavior: 'rerun-grey-ci', basis: 'original-request', actor: chain.reviewer, model: null, slot: null,
    admittedAt: Date.now() - 1000, reservation: { memoryBytes: 8, diskBytes: 16 },
    request: { command: 'github-interface', cwd: '/fixture', nativeResources: 2, argv: ['--rerun-grey-ci-if-ready', '21', '--expected-head', HEAD] } } })
  const result = { outcome: 'unconfirmed', nativeProcessFailure: { code: 7, signal: null } }
  const call = releasedAction(admitted.invocations[0], result)
  const readActionResult = vi.fn(async () => result)
  const runtime = new BehaviorChainRuntime(journal, operations(observation(), { enabled: () => false, readActionResult,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }))
  await runtime.run()
  const receipts = () => journal.history(chain.id).filter(event => ['invocation.reconciled', 'invocation.uncertain'].includes(JSON.parse(event.payload).type))
  const original = receipts()
  await runtime.run()
  await runtime.run()
  expect(readActionResult).toHaveBeenCalledTimes(1)
  expect(receipts()).toEqual(original)
  expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
  expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
  journal.rebuild()
  await new BehaviorChainRuntime(journal, operations(observation(), { enabled: () => false, readActionResult,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  expect(readActionResult).toHaveBeenCalledTimes(1)
  expect(receipts()).toEqual(original)
})

it('keeps a contained action reserved after its accepted response until original process and disk proof agree', async () => {
  const { journal, chain } = setup('merge-pr', true, ':memory:', true)
  const invocation = chain.invocations[0]
  const result = { action: 'merge_if_ready', repository: chain.repository, pull_number: 21, head_sha: HEAD,
    outcome: 'enqueued', queue_entry_id: 'original-entry' }
  const proof = nativeActionReceipt(chain, invocation, result)
  journal.append(chain.id, 'accepted-before-cleanup', chain.sequence, { type: 'invocation.reconciled', invocationId: invocation.id,
    evidence: { nativeCallId: 'c'.repeat(32), nativeActionReceipt: proof } })
  const call: LogEntry = { id: 'c'.repeat(32), correlation_id: invocation.id, model: 'native-action', behavior: 'native_action',
    source: 'poise:behavior-chain', actor: 'reviewer', repo: chain.repository, pr_id: '21', session_id: null, prompt: '',
    started_at: new Date(invocation.admittedAt).toISOString(), completed_at: new Date().toISOString(), time_elapsed: '1s',
    status: 'completed', action: 'native_action', outcome: 'native_action', error: '', head_sha: HEAD, expected_head: HEAD,
    response: 'cccccccc', resources_settled_at: null, resource_ownership: { version: 2, roots: [], errors: [],
      namespace: { state: 'active', callId: 'c'.repeat(32), correlation: invocation.id,
        controller: { version: 1, instance: 'd'.repeat(32) }, binding: { pid: 104, start: '12', namespace: 'pid:[91]',
          owner: { pid: 102, start: '10' }, holder: { pid: 103, start: '11' },
          epoch: { boot: 'fixture', init_start: '1', namespace_dev: '2', namespace_ino: '3' } } } },
    artifact: { phase: 'received_native_action', request_sha: nativeRequestSha(invocation.request), response_sha: chainBasis(result) } }
  const readActionResult = vi.fn(async () => result)
  const perform = vi.fn(async () => { throw new Error('must not repeat the action') })
  const runtime = new BehaviorChainRuntime(journal, operations(observation(), { enabled: () => false, perform, readActionResult,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }))
  const originalCallId = call.id
  call.id = 'e'.repeat(32)
  call.resource_ownership!.namespace!.callId = call.id
  await expect(runtime.run()).rejects.toThrow('native action target conflicts')
  expect(journal.reservedResources()).toEqual({ memoryBytes: 8, diskBytes: 16, unaccounted: 0 })
  call.id = originalCallId
  call.resource_ownership!.namespace!.callId = call.id
  await runtime.run()
  expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
  expect(journal.reservedResources()).toEqual({ memoryBytes: 8, diskBytes: 16, unaccounted: 0 })
  expect(journal.liveModelInvocationCount()).toBe(0)
  expect(readActionResult).not.toHaveBeenCalled()
  const stamp = Date.now()
  call.resource_ownership!.namespace = { ...call.resource_ownership!.namespace!, state: 'settled', settled_at: stamp / 1000 }
  call.resources_settled_at = new Date(stamp).toISOString()
  await runtime.run()
  expect(journal.read(chain.id)!.invocations[0]).toMatchObject({ state: 'settled', callId: call.id, outcome: 'enqueued' })
  expect(journal.read(chain.id)!.invocations[0].evidence!.nativeActionReceipt).toEqual(proof)
  expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
  expect(readActionResult).toHaveBeenCalledTimes(1)
  expect(perform).not.toHaveBeenCalled()
  const events = journal.history(chain.id)
  journal.rebuild()
  expect(journal.history(chain.id)).toEqual(events)
  expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
})

it('does not settle a contained action from a retained response while the original physical Call is missing', async () => {
  const { journal, chain } = setup('merge-pr', true, ':memory:', true)
  const invocation = chain.invocations[0]
  journal.append(chain.id, 'response-only', chain.sequence, { type: 'invocation.reconciled', invocationId: invocation.id,
    evidence: { nativeActionReceipt: nativeActionReceipt(chain, invocation, acceptedMerge()) } })
  await new BehaviorChainRuntime(journal, operations(observation(), { enabled: () => false })).run()
  expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
  expect(journal.reservedResources()).toEqual({ memoryBytes: 8, diskBytes: 16, unaccounted: 0 })
})

it.each(['merge-pr', 'resolve-threads'] as const)('settles %s from its retained original response after rebuilding, without repeating the action', async (behavior) => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-action-receipt-'))
  directories.push(directory)
  const filename = join(directory, 'journal.sqlite')
  const { db, journal, chain } = setup(behavior, true, filename)
  const invocation = chain.invocations[0]
  const response = behavior === 'merge-pr' ? acceptedMerge() : { action: 'resolved_nonblocking_conversations_if_ready',
    repository: chain.repository, pull_number: 21, head_sha: HEAD, ready_except_conversations: true,
    resolved_count: 1, unresolved_count: 0, conversations: [{ id: 'original-thread', isResolved: true }] }
  const proof = nativeActionReceipt(chain, invocation, response)
  journal.append(chain.id, 'accepted-response', chain.sequence, { type: 'invocation.reconciled', invocationId: invocation.id,
    evidence: { nativeActionReceipt: proof } })
  const originalHistory = journal.history(chain.id)
  db.prepare('DELETE FROM behavior_chain_current').run()
  db.close()
  const reopened = new Database(filename)
  databases.push(reopened)
  const restarted = new BehaviorChainJournal(reopened)
  restarted.rebuild()
  expect(restarted.history(chain.id)).toEqual(originalHistory)
  const obs = observation()
  obs.pull!.queueEntry = 'some-later-entry'
  await new BehaviorChainRuntime(restarted, operations(obs)).run()
  const current = restarted.read(chain.id)!
  expect(current.invocations).toHaveLength(1)
  expect(current.invocations[0]).toMatchObject({ id: invocation.id, state: 'settled',
    outcome: behavior === 'merge-pr' ? 'merged' : 'resolved', evidence: { status: 'completed', nativeActionReceipt: proof } })
  expect(restarted.history(chain.id).filter((row) => JSON.parse(row.payload).type === 'invocation.settled')).toHaveLength(1)
})

it.each(['chainId', 'invocationId', 'actor', 'requestSha', 'head_sha', 'repository', 'observedAt'])('cannot release ownership using a receipt with different %s', async (field) => {
  const { journal, chain } = setup()
  const invocation = chain.invocations[0]
  const proof = nativeActionReceipt(chain, invocation, acceptedMerge())
  const changed = { ...proof, result: { ...proof.result } }
  if (field === 'head_sha' || field === 'repository') changed.result[field] = 'wrong'
  else if (field === 'observedAt') changed.observedAt = invocation.admittedAt - 1
  else Object.assign(changed, { [field]: 'wrong' })
  const next = journal.append(chain.id, 'mismatched-response', chain.sequence, { type: 'invocation.reconciled',
    invocationId: invocation.id, evidence: { nativeActionReceipt: changed } })
  expect(matchingNativeActionReceipt(next, next.invocations[0])).toBeNull()
  await new BehaviorChainRuntime(journal, operations(observation())).run()
  expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
})

it('bounds retained proof, omits unrelated output and keeps process failure separate from accepted work', () => {
  const { chain } = setup()
  const invocation = chain.invocations[0]
  const proof = nativeActionReceipt(chain, invocation, { ...acceptedMerge(), stdout: 'private output', secret: 'not retained',
    nativeProcessFailure: { code: 1, signal: null } })
  expect(proof.result).toEqual(acceptedMerge())
  expect(proof).toMatchObject({ processFailure: { code: 1, signal: null } })
  expect(nativeActionSettlement(proof)).toMatchObject({ status: 'completed', outcome: 'merged' })
  const resolving = setup('resolve-threads').chain
  expect(() => nativeActionReceipt(resolving, resolving.invocations[0], {
    action: 'resolved_nonblocking_conversations_if_ready', repository: chain.repository, pull_number: 21, head_sha: HEAD,
    ready_except_conversations: true, resolved_count: 1, unresolved_count: 0,
    conversations: [{ id: 'x'.repeat(256 * 1024), isResolved: true }],
  })).toThrow('journal bound')
  expect(() => nativeActionReceipt(chain, invocation, { ...acceptedMerge(), nativeProcessFailure: { code: 'private error text', signal: null } })).toThrow('process failure')
})

it.each(['already_merged', 'in_queue', 'not_ready', 'superseded'])('does not count a returned %s observation as this invocation performing a mutation', (outcome) => {
  const { chain } = setup()
  const proof = nativeActionReceipt(chain, chain.invocations[0], { action: 'merge_if_ready', repository: chain.repository,
    pull_number: 21, head_sha: HEAD, outcome,
    ...(outcome === 'in_queue' ? { queue_entry_id: 'existing-queue-entry' } : {}) })
  expect(nativeActionSettlement(proof)).toMatchObject({ outcome, status: 'deferred', action: 'not_started' })
})

it('continues queue-rejection repair after observing an existing entry without claiming its enqueue mutation', () => {
  const { journal, chain } = setup()
  const invocation = chain.invocations[0]
  const proof = nativeActionReceipt(chain, invocation, { action: 'merge_if_ready', repository: chain.repository,
    pull_number: 21, head_sha: HEAD, outcome: 'in_queue', queue_entry_id: 'existing-entry' })
  const evidence = nativeActionSettlement(proof)
  const next = journal.append(chain.id, 'observed-queue', chain.sequence, { type: 'invocation.settled',
    invocationId: invocation.id, callId: null, outcome: 'in_queue', evidence })
  const obs = observation()
  obs.pull!.queueRemoval = { id: 'rejection', reason: 'failed_checks', at: Date.now(), actor: null }
  expect(evidence).toMatchObject({ status: 'deferred', action: 'not_started' })
  expect(decideBehaviorChain(next, obs, Date.now())).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
})

it.each([
  { ...acceptedMerge(), merge_sha: 'missing' },
  { ...acceptedMerge(), merge_method: 'unknown' },
  { ...acceptedMerge(), outcome: 'enqueued', queue_entry_id: 'contradictory-merge' },
  { action: 'merge_if_ready', repository: 'example/repo', pull_number: 21, head_sha: HEAD, outcome: 'enqueued', queue_entry_id: '' },
])('rejects an incomplete or contradictory native mutation response', (response) => {
  const { chain } = setup()
  expect(() => nativeActionReceipt(chain, chain.invocations[0], response)).toThrow('accepted result')
})

it('rejects contradictory conversation receipts and does not claim zero resolved conversations as a mutation', () => {
  const { chain } = setup('resolve-threads')
  const invocation = chain.invocations[0]
  const response = { action: 'resolved_nonblocking_conversations_if_ready', repository: chain.repository,
    pull_number: 21, head_sha: HEAD, ready_except_conversations: true, resolved_count: 0, unresolved_count: 0, conversations: [] }
  expect(nativeActionSettlement(nativeActionReceipt(chain, invocation, response))).toMatchObject({
    status: 'deferred', action: 'not_started', outcome: 'nothing_to_resolve',
  })
  for (const invalid of [
    { ...response, outcome: 'merged' },
    { ...response, resolved_count: 1 },
    { ...response, unresolved_count: 1 },
    { ...response, resolved_count: 1, conversations: [{ id: 'thread', isResolved: false }] },
    { ...response, resolved_count: 2, conversations: [{ id: 'thread', isResolved: true }, { id: 'thread', isResolved: true }] },
  ]) expect(() => nativeActionReceipt(chain, invocation, invalid)).toThrow('accepted results')
})

it('retains a large accepted conversation batch once within the existing journal event bound', () => {
  const { journal, chain } = setup('resolve-threads')
  const invocation = chain.invocations[0]
  const conversations = Array.from({ length: 1000 }, (_, index) => ({ id: `${index}-${'x'.repeat(100)}`, isResolved: true }))
  const proof = nativeActionReceipt(chain, invocation, { action: 'resolved_nonblocking_conversations_if_ready',
    repository: chain.repository, pull_number: 21, head_sha: HEAD, ready_except_conversations: true,
    resolved_count: conversations.length, unresolved_count: 0, conversations })
  const evidence = nativeActionSettlement(proof)
  const settled = journal.append(chain.id, 'large-resolution', chain.sequence, { type: 'invocation.settled',
    invocationId: invocation.id, callId: null, outcome: 'resolved', evidence })
  expect(settled.invocations[0]).toMatchObject({ state: 'settled', evidence: { resolved_count: 1000,
    nativeActionReceipt: { result: { conversations } } } })
  expect(evidence).not.toHaveProperty('conversations')
})

function reviewed(journal: BehaviorChainJournal, chain: BehaviorChain, obs: ChainObservation): BehaviorChain {
  const call = completedReviewCall(chain.repository, 21, HEAD, chain.reviewer)
  const response = call.artifact!.review_response as { context_sha: string }
  Object.assign(obs.pull!, { reviewContext: response.context_sha, reviewIds: [call.review_id!], reviewReceipts: [{
    id: call.review_id!, head: HEAD, state: 'COMMENTED', invocation: call.id, response,
    submittedAt: Date.parse(call.completed_at!),
  }] })
  chain = journal.append(chain.id, 'review-admit', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: 'review', behavior: 'review-pr', basis: chainBasis(['pr', HEAD, response.context_sha]), actor: chain.reviewer,
    model: 'fixture', slot: 'primary', admittedAt: Date.parse(call.started_at),
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] },
  } })
  return journal.append(chain.id, 'review-complete', chain.sequence, { type: 'invocation.settled', invocationId: 'review',
    callId: call.id, outcome: 'clean', evidence: { status: 'completed', action: 'reviewed_clean', review_id: call.review_id,
      head_sha: HEAD, completedAt: Date.parse(call.completed_at!), artifact: call.artifact } })
}

it.each(['receipt', 'settlement'])('keeps original ownership when the %s journal write fails after an accepted mutation', async (boundary) => {
  const { db, journal, chain } = setup('merge-pr', false)
  const obs = observation()
  reviewed(journal, chain, obs)
  const event = boundary === 'receipt' ? 'invocation.reconciled' : 'invocation.settled'
  db.exec(`CREATE TRIGGER reject_action_boundary BEFORE INSERT ON behavior_chain_events
    WHEN json_extract(NEW.payload, '$.type') = '${event}'
    BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`)
  const perform = vi.fn(async () => acceptedMerge())
  const runtimeOperations = operations(obs, { perform, request: async () => ({ command: 'github-interface', cwd: '/fixture',
    argv: ['--merge-if-ready', '21', '--expected-head', HEAD, '--token-user', 'reviewer'] }) })
  await new BehaviorChainRuntime(journal, runtimeOperations).run()
  const interrupted = journal.read(chain.id)!.invocations.at(-1)!
  expect(interrupted.state).toBe('uncertain')
  expect(interrupted.outcome).toContain('injected journal failure')
  expect(perform).toHaveBeenCalledTimes(1)
  expect(Boolean(interrupted.evidence?.nativeActionReceipt)).toBe(boundary === 'settlement')
  db.exec('DROP TRIGGER reject_action_boundary')
  db.prepare('DELETE FROM behavior_chain_current').run()
  const restarted = new BehaviorChainJournal(db)
  restarted.rebuild()
  await new BehaviorChainRuntime(restarted, runtimeOperations).run()
  expect(perform).toHaveBeenCalledTimes(1)
  expect(restarted.read(chain.id)!.invocations.at(-1)!.state).toBe(boundary === 'settlement' ? 'settled' : 'uncertain')
})

it('lets an unrelated chain progress while an original native action stays uncertain', async () => {
  const { journal, chain } = setup()
  journal.append('example/repo#8', 'other-seed', 0, { type: 'chain.admitted', repository: chain.repository, issue: 8,
    branch: 'poise/issue-8', author: chain.author, reviewer: chain.reviewer })
  const launch = vi.fn(async (_invocation: ChainInvocation) => true)
  await new BehaviorChainRuntime(journal, operations(observation(), { launch,
    observe: async (target) => target.issue === 7 ? observation() : { ...observation(), pull: null,
      publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } },
    request: async () => ({ command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', 'example/repo#8', '--model', 'fixture'] }),
  })).run()
  expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
  expect(launch).toHaveBeenCalledTimes(1)
  expect(journal.read('example/repo#8')!.invocations[0]).toMatchObject({ behavior: 'implement-issue', state: 'started' })
})

it.each(['matching', 'wrong-head', 'wrong-invocation', 'missing-flags'])('recovers publication only from its original marker and head: %s', async (variant) => {
  const { journal, chain } = setup('merge-pr', false)
  const invocation: ChainAdmission = { id: 'publication', behavior: 'publish-issue', basis: 'publish-original', actor: chain.author,
    model: null, slot: null, admittedAt: Date.now() - 1000, request: { command: 'github-interface', cwd: '/fixture',
      argv: ['--issue-work', '7', ...(variant === 'missing-flags' ? [] : ['--invocation-id', 'original-native', '--expected-head', HEAD])] } }
  const admitted = journal.append(chain.id, 'publication-admit', chain.sequence, { type: 'invocation.admitted', invocation })
  journal.append(chain.id, 'publication-uncertain', admitted.sequence, { type: 'invocation.uncertain', invocationId: invocation.id,
    reason: 'publication acknowledgement lost' })
  const obs = observation()
  obs.publication.head_invocation = variant === 'wrong-invocation' ? 'independent-native' : 'original-native'
  if (variant === 'wrong-head') obs.publication.head_sha = 'c'.repeat(40)
  await new BehaviorChainRuntime(journal, operations(obs)).run()
  expect(journal.read(chain.id)!.invocations[0].state).toBe(variant === 'matching' ? 'settled' : 'uncertain')
})

it('settles a never-attempted direct action as deferred when receipts are unreadable, so recovery can admit a fresh attempt', async () => {
  const { CallerReceiptStoreError } = await import('../server/service/caller-calls')
  const { journal, chain } = setup('merge-pr', false)
  const obs = observation()
  reviewed(journal, chain, obs)
  const receiptError = new CallerReceiptStoreError('/tmp', Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }))
  const perform = vi.fn(async () => { throw receiptError })
  const runtimeOperations = operations(obs, { perform, request: async () => ({ command: 'github-interface', cwd: '/fixture',
    argv: ['--merge-if-ready', '21', '--expected-head', HEAD, '--token-user', 'reviewer'] }) })
  await expect(new BehaviorChainRuntime(journal, runtimeOperations).run()).rejects.toBe(receiptError)
  const current = journal.read(chain.id)!
  const settled = current.invocations.at(-1)!
  expect(perform).toHaveBeenCalledTimes(1)
  expect(settled).toMatchObject({ state: 'settled', outcome: 'receipt_unavailable', callId: null })
  expect(settled.evidence).toMatchObject({ status: 'deferred', action: 'not_started', outcome: 'receipt_unavailable' })
  // A fresh attempt can be admitted after readability returns; an uncertain hold would block it.
  expect(journal.admitInvocation(current, 'admit-next', { id: 'grey-retry', behavior: 'merge-pr', basis: 'exact-request',
    actor: 'reviewer', model: null, slot: null, admittedAt: Date.now(),
    request: { command: 'github-interface', cwd: '/fixture',
      argv: ['--merge-if-ready', '21', '--expected-head', HEAD, '--token-user', 'reviewer'] } }, 2)).not.toBeNull()
})

it('releases contained direct-action capacity when receipts are unreadable before any Call', async () => {
  const { CallerReceiptStoreError } = await import('../server/service/caller-calls')
  const { journal, chain } = setup('merge-pr', false)
  const obs = observation()
  reviewed(journal, chain, obs)
  const receiptError = new CallerReceiptStoreError('/tmp', Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }))
  const perform = vi.fn(async () => { throw receiptError })
  const runtimeOperations = operations(obs, { perform, request: async () => ({ command: 'github-interface', cwd: '/fixture',
    nativeResources: 2 as const, argv: ['--merge-if-ready', '21', '--expected-head', HEAD, '--token-user', 'reviewer'] }) })
  await expect(new BehaviorChainRuntime(journal, runtimeOperations).run()).rejects.toBe(receiptError)
  const current = journal.read(chain.id)!
  const settled = current.invocations.at(-1)!
  expect(perform).toHaveBeenCalledTimes(1)
  expect(settled).toMatchObject({ state: 'settled', outcome: 'receipt_unavailable', callId: null })
  expect(settled.request.nativeResources).toBe(2)
  // No Call was created and no resources were acquired, so no reservation is retained.
  expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
  // A fresh contained attempt can be admitted after readability returns; pending capacity would block it.
  expect(journal.admitInvocation(current, 'admit-contained-next', { id: 'contained-retry', behavior: 'merge-pr',
    basis: 'exact-request', actor: 'reviewer', model: null, slot: null, admittedAt: Date.now(),
    reservation: { memoryBytes: 8, diskBytes: 16 },
    request: { command: 'github-interface', cwd: '/fixture', nativeResources: 2 as const,
      argv: ['--merge-if-ready', '21', '--expected-head', HEAD, '--token-user', 'reviewer'] } }, 2)).not.toBeNull()
})

it('clears a dangling publication correlation when receipts are unreadable, so recovery retries after readability returns', async () => {
  const { CallerReceiptStoreError } = await import('../server/service/caller-calls')
  const { journal, chain } = setup('merge-pr', false)
  const callId = 'a'.repeat(32)
  const pending: ChainAdmission = { id: 'original-repair', behavior: 'repair-pr', basis: 'repair-original', actor: chain.author,
    model: 'fixture-model', slot: 'primary', admittedAt: Date.now() - 20_000, reservation: { memoryBytes: 8, diskBytes: 16 },
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', 'example/repo#7', '--model', 'fixture'] } }
  let current = journal.append(chain.id, 'repair-admit', chain.sequence, { type: 'invocation.admitted', invocation: pending })
  const call: LogEntry = { id: callId, correlation_id: pending.id, source: 'poise:behavior-chain', actor: chain.author,
    repo: 'example/repo', behavior: 'repair_pr', status: 'failed', action: null, outcome: null, head_sha: null, expected_head: HEAD,
    response: null, error: 'PR head confirmation timed out', pr_id: '21', model: 'fixture-model', session_id: null, prompt: '',
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(), time_elapsed: '1s',
    resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] },
    artifact: { phase: 'publishing', plan_sha: 'b'.repeat(64) } }
  current = journal.append(current.id, 'repair-uncertain', current.sequence,
    { type: 'invocation.uncertain', invocationId: pending.id, reason: 'publication acknowledgement lost' })
  const obs = observation()
  obs.publication.head_invocation = callId
  obs.publication.head_sha = HEAD
  obs.workPublication = { callId, repliesComplete: false, resumable: true, planSha: 'b'.repeat(64) }
  const receiptError = new CallerReceiptStoreError('/tmp', Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }))
  const resumePublication = vi.fn(async (_invocation: ChainInvocation, _head: string, _correlation: string): Promise<Record<string, unknown>> => { throw receiptError })
  await expect(new BehaviorChainRuntime(journal, operations(obs, {
    readInvocations: async () => ({ entries: [call], quarantined: [] }),
    resumePublication, launch: async () => { throw new Error('must not launch a replacement worker') },
  })).run()).rejects.toBe(receiptError)
  expect(resumePublication).toHaveBeenCalledTimes(1)
  const interrupted = journal.read(chain.id)!.invocations[0]
  expect(interrupted.state).toBe('uncertain')
  expect(interrupted.evidence?.publicationResume).toBeNull()
  expect(String(interrupted.evidence?.publicationResumeError)).toContain('Caller receipt store')
  // After readability returns, recovery retries with a fresh correlation instead of staying blocked on the dangling one.
  const fresh = 'd'.repeat(32)
  const retry = vi.fn(async (_invocation: ChainInvocation, _head: string, _correlation: string): Promise<Record<string, unknown>> => ({}))
  await new BehaviorChainRuntime(journal, operations(obs, {
    readInvocations: async () => ({ entries: [call], quarantined: [] }),
    resumePublication: retry, launch: async () => { throw new Error('must not launch a replacement worker') },
  })).run()
  expect(retry).toHaveBeenCalledTimes(1)
  expect(retry.mock.calls[0][2]).not.toBe(fresh)
  expect(typeof retry.mock.calls[0][2]).toBe('string')
  expect(journal.read(chain.id)!.invocations[0].evidence?.publicationResume).toMatchObject({ callId, head: HEAD })
})
