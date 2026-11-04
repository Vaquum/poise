// Caller pytest supplies actual --logs bytes. This isolated contract harness
// creates no GitHub artifact, provider process or live workflow evidence.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { parseAgentLogStdout } from '../../server/agent-log-parse'
import { BehaviorChainJournal, chainIdentity, type ChainBehavior } from '../../server/behavior-chain-store'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../../server/behavior-chain-runtime'
import { BehaviorResourceRecovery } from '../../server/behavior-chain-resource-recovery'

const wire = readFileSync(process.argv[2], 'utf8')
const mode = process.argv[3] ?? 'fence'
assert.ok(['fence', 'pending', 'released', 'recovered', 'namespace-no-effect', 'namespace-interrupted-pending', 'namespace-interrupted-released', 'namespace-physical-only', 'resource-guard'].includes(mode))
const physical = mode === 'namespace-physical-only'
const interrupted = mode.startsWith('namespace-interrupted-') || physical
const guarded = mode === 'resource-guard'
const direct = mode === 'namespace-no-effect' || interrupted || guarded
const snapshot = parseAgentLogStdout(wire, 'actual native Call log output')
assert.equal(snapshot.quarantined.length, 0, JSON.stringify(snapshot.quarantined))
assert.equal(snapshot.entries.length, 1)
const call = snapshot.entries[0]
const limits = call.resource_guard?.limits
const reservation = { memoryBytes: limits?.memoryBytes ?? 8, diskBytes: limits?.diskBytes ?? 16 }
assert.ok(call.repo && call.actor && call.correlation_id && call.completed_at)
const behavior = ({ issue_review: 'review-issue', implement_issue: 'implement-issue', repair_pr: 'repair-pr',
  pr_review: 'review-pr', pr_approve: 'approve-pr', native_action: 'merge-pr' } as Record<string, ChainBehavior>)[call.behavior!]
assert.ok(behavior)
const db = new Database(':memory:')
try {
  const journal = new BehaviorChainJournal(db)
  const id = chainIdentity(call.repo, 7)
  let chain = journal.append(id, 'seed', 0, { type: 'chain.admitted', repository: call.repo, issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  chain = journal.append(id, 'admit', chain.sequence, { type: 'invocation.admitted', invocation: { id: call.correlation_id,
    behavior, actor: call.actor, model: direct ? null : call.model, slot: direct ? null : 'primary', basis: 'original-contract-admission',
    reservation, admittedAt: Date.parse(call.started_at_precise ?? call.started_at) - 1000,
    request: direct ? { command: 'github-interface', nativeResources: 2, cwd: '/isolated-contract',
      ...(limits ? { resourceLimits: limits } : {}),
      argv: ['--merge-if-ready', '21', '--expected-head', call.expected_head!, '--token-user', call.actor] }
      : { command: 'agent-interface', cwd: '/isolated-contract', argv: [] } } })
  journal.append(id, 'start', chain.sequence, { type: 'invocation.started', invocationId: call.correlation_id })
  assert.equal(journal.liveModelInvocationCount(), direct ? 0 : 1)
  assert.deepEqual(journal.reservedResources(), { ...reservation, unaccounted: 0 })
  const forbidden = async () => { throw new Error('receipt reconciliation must not execute work') }
  const reviewer = { slot: 'primary', model: call.model, recovery: call.model }
  const operations: ChainRuntimeOperations = { enabled: () => false, accounts: () => ({ author: 'author', reviewer: 'reviewer' }),
    discover: async () => [], ownsRepository: () => true, readInvocations: async () => parseAgentLogStdout(wire, 'actual native receipt'),
    observe: async () => ({ checkedAt: Date.now(), existingPulls: [], issue: { open: false, eligible: false, revision: 'closed', commentIds: [] },
      issueReviewers: [reviewer], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer,
      publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null }, pull: null }),
    available: () => false, capacity: () => 1, permitted: () => false, received: () => {}, request: forbidden, launch: forbidden,
    perform: forbidden, readActionResult: forbidden, resumePublication: forbidden, fenceClosedTarget: forbidden, wake: () => {} }
  if (physical) {
    const started = journal.read(id)!
    journal.append(id, 'original-uncertainty', started.sequence, { type: 'invocation.uncertain', invocationId: call.correlation_id,
      reason: 'original effect remains uncertain' })
    await new BehaviorResourceRecovery(journal, async () => snapshot).run()
  } else await new BehaviorChainRuntime(journal, operations).run()
  const current = journal.read(id)!
  const pending = mode === 'pending' || mode === 'namespace-interrupted-pending'
  assert.equal(current.invocations[0].state, pending || interrupted ? 'uncertain' : 'settled')
  if (mode === 'fence') assert.equal(current.invocations[0].outcome, 'target_closed')
  if (mode === 'released' || mode === 'recovered') assert.equal(current.invocations[0].outcome, 'commented')
  if (physical) {
    assert.equal(current.invocations[0].outcome, 'original effect remains uncertain')
    assert.equal(current.invocations[0].callId, null)
    assert.equal(current.invocations[0].evidence?.resources_settled_at, call.resources_settled_at)
  }
  if (direct) {
    assert.equal(call.resource_ownership?.version, 2)
    assert.equal(call.resource_ownership.namespace?.state, pending ? 'active' : 'settled')
    if (guarded) {
      assert.equal(current.invocations[0].outcome, call.error_code)
      assert.equal(current.held, call.error)
      assert.equal(call.resource_guard?.failure?.noWrite, true)
    } else if (!interrupted) assert.equal(current.invocations[0].outcome, 'preflight_failed')
    else assert.equal(call.error_code, physical && limits ? call.resource_guard?.failure?.code : 'interrupted')
  }
  if (mode === 'pending' || mode === 'recovered') assert.ok(call.resource_ownership!.errors.length > 0)
  assert.equal(journal.liveModelInvocationCount(), pending && !direct ? 1 : 0)
  assert.deepEqual(journal.reservedResources(), { memoryBytes: pending ? reservation.memoryBytes : 0,
    diskBytes: pending ? reservation.diskBytes : 0, unaccounted: 0 })
  const events = journal.history(id)
  if (guarded) {
    await new BehaviorChainRuntime(journal, operations).run()
    assert.deepEqual(journal.history(id), events)
  }
  journal.rebuild()
  assert.deepEqual(journal.history(id), events)
  assert.deepEqual(journal.read(id), current)
  if (mode === 'fence') for (const change of [{ artifact: null }, { source: 'poise:review-new-prs' }, { resources_settled_at: null },
    { head_sha: 'a'.repeat(40) }, { review_id: 91 }, { artifact: { phase: 'admission_fenced', publication: {} } }]) {
    const rejected = parseAgentLogStdout(JSON.stringify([{ ...call, ...change }]), 'invalid native fence proof')
    assert.equal(rejected.entries.length, 0, JSON.stringify(change))
    assert.equal(rejected.quarantined.length, 1)
  }
  process.stdout.write(JSON.stringify({ accepted: 1, settled: pending || interrupted ? 0 : 1, reservations: pending ? 1 : 0 }))
} finally { db.close() }
