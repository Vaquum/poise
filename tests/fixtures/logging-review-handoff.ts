import type { Database } from 'better-sqlite3'
import { normalize } from '../../gateway/src/diagnostics/contract'
import { callerDiagnostic } from '../../gateway/src/diagnostics/sources'
import { handoffCandidate } from '../../gateway/src/diagnostics/query-handoff'
import { chainBasis, type BehaviorChainJournal, type ChainAdmission } from '../../server/behavior-chain-store'
import { parseProcessDiagnostic } from '../../server/process-diagnostic'
import { loggingWorkFixture } from './logging-work-impact'

let serial = 1000
export function reviewHandoffFixture(journal: BehaviorChainJournal, behavior: 'review-pr' | 'approve-pr' = 'review-pr', workspace = 'local') {
  const issue = ++serial
  const identity = (offset: number) => (issue * 10 + offset).toString(16).padStart(32, '0')
  const at = Date.now() - 60_000
  const fixture = loggingWorkFixture(journal, 'acme/repo', issue, identity(0), identity(1), at)
  const id = identity(2), callId = identity(3), head = fixture.observation.pull!.head
  const callerBehavior = behavior === 'review-pr' ? 'pr_review' : 'pr_approve'
  const diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'analysis',
    outcome: 'handoff', submission: 'none', stderr: '', stderr_truncated: false,
    expected_head: head, call_id: callId, correlation_id: id }
  const row = { id: callId, correlation_id: id, repo: 'acme/repo', pr_id: String(issue + 100), actor: 'reviewer', behavior: callerBehavior,
    status: 'failed', error_code: 'review_budget_exhausted', expected_head: head,
    error: 'review reached its analysis time limit; handing off so the next model can run instead',
    completed_at: new Date(at + 5000).toISOString(), diagnostic }
  const admission = (invocationId: string, time: number, model = 'fixture'): ChainAdmission => ({ id: invocationId, behavior,
    basis: behavior === 'review-pr' ? chainBasis(['pr', head, fixture.observation.pull!.reviewContext])
      : chainBasis(['approve', head, fixture.observation.pull!.reviewRevision, null]),
    actor: 'reviewer', model, slot: 'primary', admittedAt: time,
    request: { command: 'agent-interface', cwd: '/isolated/fixture', argv: [behavior === 'review-pr' ? '--pr-review' : '--pr-approve',
      `https://github.com/acme/repo/pull/${issue + 100}`, '--source', 'poise:behavior-chain', '--correlation-id', invocationId,
      '--actor', 'reviewer', '--model', model, '--recovery-model', 'replacement', '--pwd', '/isolated/checkout',
      '--expected-head', head, '--p', 'p2', '--note', 'Review the admitted change'] } })
  const original = admission(id, at + 4000)
  fixture.append({ type: 'invocation.admitted', invocation: original }, at + 4000)
  fixture.append({ type: 'invocation.settled', invocationId: id, callId, outcome: row.error_code,
    evidence: { status: 'failed', error_code: row.error_code, diagnostic: parseProcessDiagnostic(diagnostic), completedAt: at + 5000 } }, at + 5000)
  const event = normalize(callerDiagnostic(row, workspace)!, at + 5000)!
  return { ...fixture, at, original, successor: admission(identity(4), at + 6000, 'replacement'), row, event, candidate: handoffCandidate(event)! }
}

/** The original dead letter retains the approval context after its launch row
 * is replaced. A fallback slot shares the exact target, not its firing ID. */
export function legacyHandoffFixture(db: Database, workspace = 'local') {
  const number = ++serial, at = Date.now() - 60_000, head = 'a'.repeat(40)
  const callId = number.toString(16).padStart(32, '0'), correlation = (number + 10000).toString(16).padStart(32, '0')
  const next = (number + 20000).toString(16).padStart(32, '0')
  const target = `acme/repo#${number}@head=${head}/context=${'b'.repeat(64)}`
  const diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'analysis', outcome: 'handoff',
    submission: 'none', expected_head: head, call_id: callId, correlation_id: correlation }
  const row = { id: callId, correlation_id: correlation, repo: 'acme/repo', pr_id: String(number), actor: 'reviewer', behavior: 'pr_approve',
    status: 'failed', error_code: 'review_budget_exhausted', expected_head: head, completed_at: new Date(at).toISOString(), error: 'bounded analysis handoff', diagnostic }
  const event = normalize(callerDiagnostic(row, workspace)!)!
  db.prepare(`INSERT INTO behavior_dead_letters(id,behavior,target,repo,pr,actor,source,correlation_id,call_id,error,created_at,retired_at)
    VALUES(?,'approve-prs',?,'acme/repo',?,'reviewer','poise:approve-prs',?,?,?, ?,?)`)
    .run(correlation, target, number, correlation, callId, row.error, new Date(at).toISOString(), new Date(at + 1000).toISOString())
  db.prepare(`INSERT INTO behavior_seen(key,target,seen_at,claim_id,lease_until,launch_behavior,launch_repo,launch_pr,launch_requested_at,
    launch_expected_head,launch_actor,launch_source,launch_correlation_id)
    VALUES('approve-prs',?,? ,?,?,'pr_approve','acme/repo',?,? ,?,'reviewer','poise:approve-prs',?)`)
    .run(target, new Date(at + 1000).toISOString(), next, Date.now() + 60_000, number, new Date(at + 1000).toISOString(), head, next)
  return { event, candidate: handoffCandidate(event)!, target, next }
}
