// The existing Caller revision-fence cases supply actual history and --diagnostics bytes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { callerDiagnostic } from '../../gateway/src/diagnostics/sources'
import { parseAgentLogStdout } from '../../server/agent-log-parse'
import { workError } from '../../server/analytics-health'
import { BehaviorChainJournal } from '../../server/behavior-chain-store'
import { statusOf } from '../../src/ui/places/observe/runs'

const wire = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const before = JSON.stringify(wire)
const snapshot = parseAgentLogStdout(JSON.stringify(wire.logs), 'actual issue revision fence')
assert.equal(snapshot.quarantined.length, 0, JSON.stringify(snapshot.quarantined))
assert.equal(snapshot.entries.length, 1)
const call = snapshot.entries[0]
assert.equal(call.status, 'failed')
assert.equal(call.outcome, 'preflight_failed')
assert.equal(call.issue_revision ?? null, wire.logs[0].issue_revision)
assert.deepEqual(call.resource_ownership ?? null, wire.logs[0].resource_ownership)
assert.equal(call.resources_settled_at ?? null, wire.logs[0].resources_settled_at)
assert.equal(callerDiagnostic(wire.diagnostic, 'local'), null)
assert.equal(callerDiagnostic(call, 'local'), null)
assert.deepEqual(statusOf({ ...call, started_at_precise: call.started_at_precise ?? null,
  completed_at: call.completed_at ?? null, outcome: 'preflight_failed' }),
{ state: 'idle', word: 'Superseded', note: 'Issue changed', warn: false })

const db = new Database(':memory:')
try {
  const journal = new BehaviorChainJournal(db), id = `${call.repo!.toLowerCase()}#${call.pr_id}`
  let chain = journal.append(id, 'seed', 0, { type: 'chain.admitted', repository: call.repo!, issue: Number(call.pr_id),
    branch: 'poise/issue-452', author: 'author', reviewer: call.actor! })
  chain = journal.append(id, 'admit', chain.sequence, { type: 'invocation.admitted', invocation: { id: call.correlation_id!,
    behavior: 'review-issue', actor: call.actor!, model: call.model, slot: 'primary', basis: 'original-issue-revision',
    admittedAt: Date.parse(call.started_at_precise!), request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  chain = journal.append(id, 'start', chain.sequence, { type: 'invocation.started', invocationId: call.correlation_id! })
  chain = journal.append(id, 'settle', chain.sequence, { type: 'invocation.settled', invocationId: call.correlation_id!,
    callId: call.id, outcome: call.outcome!, evidence: { ...call, completedAt: Date.parse(call.completed_at!) } })
  assert.equal(workError(chain, chain.invocations[0]), null)
  const invocation = chain.invocations[0]
  assert.ok(workError(chain, { ...invocation, evidence: { ...invocation.evidence, error_code: 'posting_failed', receipts: [] } }))
} finally { db.close() }
assert.equal(JSON.stringify(wire), before)
