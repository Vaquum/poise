// Consume actual Caller lifecycle bytes; no provider or GitHub operation.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { parseAgentLogStdout } from '../../server/agent-log-parse'
import { type ChainObservation } from '../../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../../server/behavior-chain-runtime'
import { BehaviorChainJournal } from '../../server/behavior-chain-store'

const wire = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const released = parseAgentLogStdout(JSON.stringify(wire.released), 'actual superseded repair')
const pending = parseAgentLogStdout(JSON.stringify(wire.pending), 'actual repair before cleanup')
for (const snapshot of [released, pending]) {
  assert.deepEqual(snapshot.quarantined, [])
  assert.equal(snapshot.entries.length, 1)
}
const call = released.entries[0]
assert.equal(call.status, 'superseded')
assert.equal(call.outcome, 'superseded')
assert.equal(call.action, null)
assert.notEqual(call.expected_head, call.head_sha)
assert.equal(pending.entries[0].resources_settled_at ?? null, null)
assert.ok(call.resources_settled_at)
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
const observation: ChainObservation = { checkedAt: Date.now(), issue: { open: true, eligible: true, revision: 'issue', commentIds: [] },
  issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer, existingPulls: [],
  publication: { pull_number: 17, head_sha: call.head_sha, head_invocation: null, state: 'open', merged: false, merge_sha: null },
  pull: { number: 17, head: call.head_sha!, headSince: Date.now(), state: 'open', draft: false, merged: false, mergeSha: null,
    queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
    reviewIds: [], reviewReceipts: [], reviewContext: 'c'.repeat(64), reviewRevision: 'review', greyRuns: [],
    pending: false, failing: [], conflict: true, behind: false } }
const db = new Database(':memory:')
try {
  const journal = new BehaviorChainJournal(db)
  let chain = journal.append('example/repo#7', 'seed', 0, { type: 'chain.admitted', repository: 'example/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  chain = journal.append(chain.id, 'observed', chain.sequence, { type: 'chain.observed', observation })
  chain = journal.append(chain.id, 'original', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: call.correlation_id!, behavior: 'repair-pr', actor: 'author', model: call.model, slot: 'primary', basis: 'old-head',
    admittedAt: Date.parse(call.started_at), reservation: { memoryBytes: 8, diskBytes: 16 }, request: { command: 'agent-interface',
      cwd: '/isolated', argv: ['--atomic-work', 'example/repo#7'], context: { head: call.expected_head! } } } })
  journal.append(chain.id, 'started', chain.sequence, { type: 'invocation.started', invocationId: call.correlation_id! })
  let snapshot = pending, permitted = false, launches = 0
  const forbidden = async (): Promise<never> => { throw new Error('unexpected external operation') }
  const operations: ChainRuntimeOperations = { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    ownsRepository: () => true, discover: async () => [], available: () => true, capacity: () => 1, permitted: () => permitted,
    observe: async () => ({ ...observation, checkedAt: Date.now() }), readInvocations: async () => snapshot, received: () => {}, wake: () => {},
    request: async (_chain, obs, decision) => {
      assert.equal(decision.behavior, 'repair-pr')
      assert.equal(obs.pull!.head, call.head_sha)
      return { command: 'agent-interface', cwd: '/isolated', argv: ['--atomic-work', 'example/repo#7'], context: { head: obs.pull!.head } }
    }, launch: async () => { launches++; return true }, perform: forbidden, readActionResult: forbidden,
    resumePublication: forbidden, fenceClosedTarget: forbidden }
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  assert.equal(journal.read(chain.id)!.invocations[0].state, 'uncertain')
  assert.equal(journal.liveModelInvocationCount(), 1)
  assert.equal(launches, 0)
  assert.equal(journal.read(chain.id)!.held, null)
  journal.rebuild()
  snapshot = released
  await runtime.run()
  assert.equal(journal.read(chain.id)!.invocations[0].state, 'settled')
  assert.equal(journal.liveModelInvocationCount(), 0)
  assert.equal(journal.reservedResources().memoryBytes, 0)
  assert.equal(launches, 0, 'normal admission permission must still gate the new head')
  permitted = true
  await runtime.run()
  const current = journal.read(chain.id)!
  assert.equal(launches, 1)
  assert.equal(current.held, null, 'supersession must not require Resume')
  assert.equal(current.supersession, undefined, 'the original invocation retires, not the chain')
  assert.equal(current.invocations.length, 2)
  assert.equal(current.invocations[1].request.context!.head, call.head_sha)
  assert.equal(current.invocations[1].behavior, 'repair-pr')
  journal.rebuild()
  assert.deepEqual(journal.read(chain.id), current)
} finally { db.close() }
