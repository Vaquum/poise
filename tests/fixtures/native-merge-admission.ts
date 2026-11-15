// Caller pytest supplies actual CLI -> committed Call bytes. This contract
// fixture starts no GitHub action, provider or production behavior.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { parseAgentLogList } from '../../server/agent-log-parse'
import { BehaviorChainJournal, type ChainInvocation } from '../../server/behavior-chain-store'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../../server/behavior-chain-runtime'
import { behaviorChainSummary } from '../../server/behavior-chain-summary'

const data = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  logs: unknown[], submission: string | null, request: ChainInvocation['request'], response: string | null,
}
const snapshot = parseAgentLogList(data.logs)
assert.deepEqual(snapshot.quarantined, [])
assert.equal(snapshot.entries.length, 1)
const call = snapshot.entries[0]
assert.ok(call.repo && call.actor && call.correlation_id && call.completed_at)
const db = new Database(':memory:')
try {
  const journal = new BehaviorChainJournal(db)
  let chain = journal.append('example/repo#7', 'seed', 0, { type: 'chain.admitted', repository: call.repo, issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: call.actor })
  chain = journal.append(chain.id, 'admit', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: call.correlation_id, behavior: 'merge-pr', basis: 'original-admission', actor: call.actor, model: null, slot: null,
    admittedAt: Date.parse(call.started_at_precise ?? call.started_at) - 1000, request: data.request } })
  journal.append(chain.id, 'start', chain.sequence, { type: 'invocation.started', invocationId: call.correlation_id })
  const forbidden = async () => { throw new Error('must not repeat an enqueue after losing its response') }
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const operations: ChainRuntimeOperations = { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    discover: async () => [], ownsRepository: () => true,
    readInvocations: async () => ({ entries: [{ ...call, resources_settled_at: null }], quarantined: [] }),
    // An empty queue is observation only, never proof the mutation was refused.
    observe: async () => ({ checkedAt: Date.now(), existingPulls: [], issue: { open: true, eligible: true, revision: 'seed', commentIds: [] },
      issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
      publication: { pull_number: 21, head_sha: call.expected_head, head_invocation: null, state: 'open', merged: false, merge_sha: null },
      pull: { number: 21, head: call.expected_head!, headSince: Date.now(), state: 'open', draft: false, merged: false, mergeSha: null,
        queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: true, ready: true,
        reviewIds: [], reviewReceipts: [], reviewRevision: 'reviews', greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }),
    available: () => true, capacity: () => 2, permitted: () => true, received: () => {}, request: forbidden, launch: forbidden,
    perform: forbidden, readActionResult: async () => JSON.parse(data.response!), resumePublication: forbidden, fenceClosedTarget: forbidden, wake: () => {} }
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  assert.equal(journal.read(chain.id)!.invocations[0].state, 'uncertain', 'a refusal cannot release resources')
  assert.equal(behaviorChainSummary(journal.read(chain.id)!, journal).invocations[0].callId, call.id)
  operations.readInvocations = async () => snapshot
  operations.enabled = () => data.submission === 'uncertain'
  await runtime.run()
  await runtime.run()
  const current = journal.read(chain.id)!
  assert.equal(current.invocations.length, 1)
  assert.equal(current.invocations[0].state, data.submission === 'uncertain' ? 'uncertain' : 'settled')
  assert.deepEqual(current.invocations[0].evidence?.diagnostic ?? null, call.diagnostic)
  if (data.submission === null) {
    assert.equal(current.invocations[0].outcome, 'enqueued')
    assert.equal(behaviorChainSummary(current, journal).invocations[0].nativeAction?.attribution, 'accepted-response')
  }
  const events = journal.history(chain.id)
  journal.rebuild()
  assert.deepEqual(journal.history(chain.id), events)
  assert.deepEqual(journal.read(chain.id), current)
  process.stdout.write(JSON.stringify(behaviorChainSummary(current, journal)))
} finally { db.close() }
