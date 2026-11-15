// Caller pytest supplies real committed Call bytes after its subprocess exits.
// All GitHub responses and kernel witnesses in that test are isolated stand-ins.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { parseAgentLogList } from '../../server/agent-log-parse'
import { BehaviorChainJournal, type ChainInvocation } from '../../server/behavior-chain-store'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../../server/behavior-chain-runtime'
import { behaviorChainSummary } from '../../server/behavior-chain-summary'

const data = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  logs: unknown[], mode: string, request: ChainInvocation['request'], response: string | null,
}
const snapshot = parseAgentLogList(data.logs)
assert.deepEqual(snapshot.quarantined, [])
assert.equal(snapshot.entries.length, 1)
const call = snapshot.entries[0]
assert.ok(call.repo && call.actor && call.correlation_id && call.completed_at)
const path = `${process.argv[2]}.sqlite3`
let db = new Database(path)
try {
  let journal = new BehaviorChainJournal(db)
  let chain = journal.append('example/repo#7', 'seed', 0, { type: 'chain.admitted', repository: call.repo, issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: call.actor })
  chain = journal.append(chain.id, 'admit', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: call.correlation_id, behavior: 'resolve-threads', basis: 'original-admission', actor: call.actor, model: null, slot: null,
    admittedAt: Date.parse(call.started_at_precise ?? call.started_at) - 1000, request: data.request } })
  journal.append(chain.id, 'start', chain.sequence, { type: 'invocation.started', invocationId: call.correlation_id })
  const forbidden = async () => { throw new Error('must not repeat a resolution or merge after losing its response') }
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const operations: ChainRuntimeOperations = { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    discover: async () => [], ownsRepository: () => true,
    readInvocations: async () => ({ entries: [{ ...call, resources_settled_at: null }], quarantined: [] }),
    // Even a later complete closed-thread observation cannot acknowledge B.
    observe: async () => ({ checkedAt: Date.now(), existingPulls: [], issue: { open: true, eligible: true, revision: 'seed', commentIds: [] },
      issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
      publication: { pull_number: 21, head_sha: call.expected_head, head_invocation: null, state: 'open', merged: false, merge_sha: null },
      pull: { number: 21, head: call.expected_head!, headSince: Date.now(), state: 'open', draft: false, merged: false, mergeSha: null,
        queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: true, ready: true,
        reviewIds: [], reviewReceipts: [], reviewRevision: 'reviews', greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }),
    available: () => true, capacity: () => 2, permitted: () => true, received: () => {}, request: forbidden, launch: forbidden,
    perform: forbidden, readActionResult: async () => {
      assert.ok(data.response, 'partial thread progress cannot be read as a completed batch')
      return JSON.parse(data.response)
    }, resumePublication: forbidden, fenceClosedTarget: forbidden, wake: () => {} }
  await new BehaviorChainRuntime(journal, operations).run()
  assert.equal(journal.read(chain.id)!.invocations[0].state, 'uncertain', 'progress cannot bypass resource release')
  assert.deepEqual(behaviorChainSummary(journal.read(chain.id)!, journal).invocations[0].nativeAction?.resolutionProgress,
    call.artifact!.resolution_progress)
  db.close()
  db = new Database(path)
  journal = new BehaviorChainJournal(db)
  operations.readInvocations = async () => snapshot
  // Normal completion settles on its own final gate and resource evidence;
  // do not admit another behavior after it in this isolated contract fixture.
  operations.enabled = () => data.mode !== 'complete'
  const runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  await runtime.run()
  const current = journal.read(chain.id)!
  assert.equal(current.invocations.length, 1)
  assert.equal(current.invocations[0].state, data.mode === 'complete' ? 'settled' : 'uncertain')
  assert.equal(current.mergeSha, null)
  const summary = behaviorChainSummary(current, journal).invocations[0]
  assert.equal(summary.callId, call.id)
  assert.deepEqual(summary.nativeAction?.resolutionProgress, call.artifact!.resolution_progress)
  assert.equal(summary.nativeAction?.attribution, data.mode === 'complete' ? 'accepted-response' : 'uncertain')
  if (data.mode === 'complete') assert.equal(current.invocations[0].outcome, 'resolved')
  else assert.equal(current.invocations[0].evidence?.nativeActionReceipt, undefined)
  const events = journal.history(chain.id)
  journal.rebuild()
  assert.deepEqual(journal.history(chain.id), events)
  assert.deepEqual(journal.read(chain.id), current)
} finally { db.close() }
