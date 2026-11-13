// Caller pytest supplies receipts produced at the actual publication boundary.
// GitHub and provider transports are stand-ins; this is not live cycle proof.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { callerDiagnostic } from '../../gateway/src/diagnostics/sources'
import { normalize } from '../../gateway/src/diagnostics/contract'
import { parseAgentLogStdout } from '../../server/agent-log-parse'
import { decideBehaviorChain, type ChainObservation } from '../../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../../server/behavior-chain-runtime'
import { BehaviorChainJournal, chainBasis } from '../../server/behavior-chain-store'

const snapshot = parseAgentLogStdout(readFileSync(process.argv[2], 'utf8'), 'original publication receipt')
assert.equal(snapshot.quarantined.length, 0, JSON.stringify(snapshot.quarantined))
assert.equal(snapshot.entries.length, 1)
const call = snapshot.entries[0], now = Date.now(), parent = 'b'.repeat(40), merge = 'd'.repeat(40)
const diagnostic = call.diagnostic
if (diagnostic) {
  const logged = normalize(callerDiagnostic(call, 'fixture')!, now, [])!
  assert.equal(logged.operation, diagnostic.operation)
  assert.equal(logged.phase, diagnostic.phase)
  assert.equal(logged.message, call.error)
  assert.equal(logged.stderr, diagnostic.stderr)
  assert.equal(logged.exitCode, diagnostic.context.exit_code)
  assert.equal(logged.signal, diagnostic.context.signal)
}
const closed = process.argv[3] === 'merged-parent', repair = call.behavior === 'repair_pr'
const noWrite = call.action === 'not_started'
const reviewer = { slot: 'primary', model: call.model, recovery: call.model }
const observation: ChainObservation = { checkedAt: now, existingPulls: [],
  issue: { open: !closed, eligible: true, revision: 'seed', commentIds: [] },
  issueReviewers: [], prReviewers: closed ? [reviewer] : [], implementer: reviewer, repairer: reviewer, approver: reviewer,
  prerequisites: { wait: null, base: parent, evidence: [] },
  publication: { pull_number: repair ? 3 : null, head_sha: repair ? parent : null, head_invocation: null,
    state: repair ? closed ? 'closed' : 'open' : null, merged: closed, merge_sha: closed ? merge : null },
  pull: repair ? { number: 3, head: parent, headSince: now - 1000, state: closed ? 'closed' : 'open', draft: false,
    merged: closed, mergeSha: closed ? merge : null, mergedAt: closed ? now - 100 : null,
    queueEntry: null, queueRemoval: null, changesRequested: true, unresolved: 1, approved: false, ready: false,
    reviewIds: [], reviewReceipts: [], reviewRevision: 'findings', reviewContext: 'e'.repeat(64), greyRuns: [], pending: false,
    failing: [], conflict: false, behind: false } : null }
const path = join(dirname(process.argv[2]), 'journal.sqlite3')
let db = new Database(path), journal = new BehaviorChainJournal(db)
try {
  let chain = journal.append('example/repo#7', 'seed', 0, { type: 'chain.admitted', repository: 'example/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  const basis = chainBasis(repair ? ['repair', parent, [], false, false, true, 1, 'findings', 'seed'] : ['issue', 'seed'])
  chain = journal.append(chain.id, 'admit', chain.sequence, { type: 'invocation.admitted', invocation: {
    id: call.correlation_id!, behavior: repair ? 'repair-pr' : 'implement-issue', actor: 'author', model: call.model,
    slot: reviewer.slot, basis, admittedAt: Date.parse(call.started_at_precise ?? call.started_at) - 1000,
    reservation: { memoryBytes: 8, diskBytes: 16 }, request: { command: 'agent-interface', argv: [], cwd: '/isolated' } } })
  journal.append(chain.id, 'start', chain.sequence, { type: 'invocation.started', invocationId: call.correlation_id! })
  const forbidden = async (): Promise<never> => { throw new Error('recovery cannot repeat a write or start a second worker') }
  let released = false
  const operations: ChainRuntimeOperations = { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    discover: async () => [], ownsRepository: () => true, observe: async () => observation,
    readInvocations: async () => released ? snapshot : { entries: [{ ...call, resources_settled_at: null }], quarantined: [] },
    available: () => true, capacity: () => 1, permitted: () => true, received: () => {},
    request: forbidden, launch: forbidden, perform: forbidden, readActionResult: forbidden,
    resumePublication: forbidden, fenceClosedTarget: forbidden, wake: () => {} }
  await new BehaviorChainRuntime(journal, operations).run()
  assert.equal(journal.read(chain.id)!.invocations[0].state, 'uncertain')
  assert.deepEqual(journal.reservedResources(), { memoryBytes: 8, diskBytes: 16, unaccounted: 0 })
  released = true
  await new BehaviorChainRuntime(journal, operations).run()
  const recovered = journal.read(chain.id)!
  assert.equal(recovered.invocations.length, 1)
  assert.equal(recovered.invocations[0].state, noWrite ? 'settled' : 'uncertain')
  assert.equal(recovered.invocations[0].evidence?.artifact && chainBasis(recovered.invocations[0].evidence.artifact), chainBasis(call.artifact))
  assert.equal(recovered.invocations[0].evidence?.resources_settled_at ?? null, call.resources_settled_at ?? null)
  if (!noWrite) {
    assert.equal(recovered.invocations[0].evidence?.action, null)
    if (call.resources_settled_at) {
      assert.ok(recovered.waiting?.includes(call.id))
      assert.ok(recovered.waiting?.includes('pre-push no-write checkpoint or a conclusive push result'))
    }
  } else if (!closed) {
    assert.equal(recovered.invocations[0].outcome, 'preflight_failed')
    assert.ok(recovered.waiting?.includes('native failure backoff'))
    const later = Date.parse(call.completed_at!) + 60_001
    assert.equal(decideBehaviorChain(recovered, { ...observation, checkedAt: later }, later).kind, 'invoke')
  }
  if (closed) {
    assert.notEqual(recovered.invocations[0].outcome, 'published')
    if (call.resources_settled_at) {
      assert.equal(recovered.mergeSha, merge)
      assert.equal(recovered.reviewPending, true)
      assert.ok(recovered.held)
    } else {
      assert.equal(recovered.invocations[0].state, 'uncertain')
    }
  }
  const effects = () => journal.history(chain.id).filter(row => JSON.parse(row.payload).type !== 'chain.observed')
  const history = effects()
  db.close()
  db = new Database(path)
  journal = new BehaviorChainJournal(db)
  journal.rebuild()
  for (let pass = 0; pass < 3; pass++) await new BehaviorChainRuntime(journal, operations).run()
  assert.deepEqual({ ...journal.read(chain.id), sequence: recovered.sequence }, recovered)
  assert.deepEqual(effects(), history)
} finally { db.close() }
