import Database from 'better-sqlite3'
import { afterAll, afterEach, expect, it } from 'vitest'
import { BehaviorChainJournal, chainBasis, type ChainAdmission } from '../server/behavior-chain-store'
import { behaviorChainAttention, behaviorChainWorkImpact, behaviorChainWorkImpacts } from '../server/behavior-chain-summary'
import { decideBehaviorChain } from '../server/behavior-chain-decision'
import { normalize } from '../gateway/src/diagnostics/contract'
import { DiagnosticStore } from '../gateway/src/diagnostics/store'
import { loggingWorkFixture } from './fixtures/logging-work-impact'
import { parseProcessDiagnostic } from '../server/process-diagnostic'
import { callerDiagnostic } from '../gateway/src/diagnostics/sources'
import { loggingSeverity } from '../src/logging'

const at = Date.parse('2026-11-10T17:00:00Z')
const call = '1'.repeat(32), correlation = '11111111-2222-3333-4444-555555555555'
const db = new Database(':memory:')
afterAll(() => db.close())
afterEach(() => { db.exec('DROP TABLE behavior_chain_current; DROP TABLE behavior_chain_events') })

it('annotates duplicate retained records as one target and preserves progress across failed retries and polls', () => {
  const journal = new BehaviorChainJournal(db)
  const fixture = loggingWorkFixture(journal, 'acme/repo', 7, correlation, call, at)
  const logs = new DiagnosticStore(':memory:')
  try {
    logs.append(['first', 'duplicate'].map(id => normalize({ id, source: 'caller', level: 'error', workspace: 'local',
      operation: 'repair-pr', message: 'timeout', callId: call, correlationId: correlation })!))
    const page = logs.query({ workspace: 'local', operator: false }, {})
    expect(page.total).toBe(2)
    for (const event of page.events) {
      expect(event).toMatchObject({ severity: 'error', occurrences: 2 })
      expect(behaviorChainWorkImpact(journal, event.callId, event.correlationId)).toMatchObject({
        target: 'acme/repo#107', impact: 'retrying', recovered: false, progressAt: at + 1000, retryAt: at + 63_000 })
    }
    fixture.append({ type: 'invocation.admitted', invocation: { ...fixture.chain.invocations[0], id: 'retry', admittedAt: at + 64_000 } }, at + 64_000)
    fixture.append({ type: 'invocation.settled', invocationId: 'retry', callId: '2'.repeat(32), outcome: 'preflight_failed',
      evidence: { status: 'failed', action: 'not_started', completedAt: at + 65_000 } }, at + 65_000)
    fixture.append({ type: 'chain.waiting', reason: 'repair-pr is in native failure backoff' }, at + 65_000)
    for (let poll = 0; poll < 105; poll++) fixture.append({ type: 'chain.observed', observation: { ...fixture.observation, checkedAt: at + 66_000 + poll } }, at + 66_000 + poll)
    const before = db.prepare('SELECT * FROM behavior_chain_events').all()
    journal.rebuild()
    expect(behaviorChainWorkImpact(journal, call, correlation)).toMatchObject({ impact: 'retrying', progressAt: at + 1000, retryAt: at + 185_000 })
    expect(db.prepare('SELECT * FROM behavior_chain_events').all()).toEqual(before)
  } finally { logs.close() }
})

it('requires progress after the exact failure and retains an independent hold after recovery', () => {
  const journal = new BehaviorChainJournal(db)
  const fixture = loggingWorkFixture(journal, 'acme/repo', 7, correlation, call, at)
  const progressed = structuredClone(fixture.observation)
  progressed.checkedAt = at + 4000
  progressed.pull!.head = progressed.publication.head_sha = 'b'.repeat(40)
  fixture.append({ type: 'chain.observed', observation: progressed }, at + 4000)
  // Fresh unheld chains are absent from attention, independently of recovery.
  expect(behaviorChainAttention(journal, at + 4000)).toEqual([])
  expect(behaviorChainWorkImpact(journal, call, correlation)).toMatchObject({ impact: 'recovered', recovered: true,
    progressAt: at + 4000, retryAt: null, nextAction: null })
  const laterCall = '2'.repeat(32), laterCorrelation = '2'.repeat(32)
  fixture.append({ type: 'invocation.admitted', invocation: { ...fixture.chain.invocations[0], id: laterCorrelation, admittedAt: at + 5000 } }, at + 5000)
  fixture.append({ type: 'invocation.settled', invocationId: laterCorrelation, callId: laterCall, outcome: 'preflight_failed',
    evidence: { status: 'failed', action: 'not_started', completedAt: at + 6000 } }, at + 6000)
  expect(behaviorChainWorkImpact(journal, laterCall, laterCorrelation)).toMatchObject({ recovered: false, progressAt: at + 4000 })
  fixture.append({ type: 'chain.held', reason: 'independent publication hold' }, at + 7000)
  expect(behaviorChainWorkImpact(journal, call, correlation)).toMatchObject({ impact: 'blocked', recovered: true,
    nextAction: expect.stringContaining('independent publication hold') })
})

it('keeps the original failed invocation boundary when resource reconciliation repeats its failure receipt', () => {
  const journal = new BehaviorChainJournal(db)
  const fixture = loggingWorkFixture(journal, 'acme/repo', 7, correlation, call, at)
  const next = '2'.repeat(32), nextCall = '3'.repeat(32)
  fixture.append({ type: 'invocation.admitted', invocation: { ...fixture.chain.invocations[0], id: next, admittedAt: at + 4000 } }, at + 4000)
  const evidence = { status: 'failed', action: 'not_started', callId: nextCall, completedAt: at + 5000 }
  fixture.append({ type: 'invocation.reconciled', invocationId: next, evidence }, at + 5000)
  const progressed = structuredClone(fixture.observation)
  progressed.checkedAt = at + 6000
  progressed.pull!.head = progressed.publication.head_sha = 'b'.repeat(40)
  fixture.append({ type: 'chain.observed', observation: progressed }, at + 6000)
  fixture.append({ type: 'invocation.uncertain', invocationId: next, reason: 'original resources remain unverified' }, at + 7000)
  fixture.append({ type: 'invocation.reconciled', invocationId: next, evidence: { ...evidence, error: 'cleanup still pending' } }, at + 8000)
  expect(behaviorChainWorkImpact(journal, nextCall, next)).toMatchObject({ impact: 'blocked', recovered: true, progressAt: at + 6000 })
})

it('keeps batch associations equivalent for merged, missing, conflicting and ambiguous identities', () => {
  const journal = new BehaviorChainJournal(db)
  const fixture = loggingWorkFixture(journal, 'acme/repo', 7, correlation, call, at)
  fixture.append({ type: 'chain.merged', mergeSha: 'c'.repeat(40), evidence: { repository: 'acme/repo', pull_number: 107,
    merged: true, merge_sha: 'c'.repeat(40), review_complete: true } }, at + 4000)
  expect(behaviorChainAttention(journal, at + 4000)).toEqual([])
  expect(behaviorChainWorkImpact(journal, call, correlation)).toMatchObject({ impact: 'recovered', stage: 'Merged', nextAction: null })
  expect(behaviorChainWorkImpact(journal, '3'.repeat(32), null)).toBeNull()
  expect(behaviorChainWorkImpact(journal, call, '3'.repeat(32))).toBeNull()
  const other = loggingWorkFixture(journal, 'acme/repo', 8, '2'.repeat(32), '2'.repeat(32), at)
  expect(behaviorChainWorkImpact(journal, call, other.chain.invocations[0].id)).toBeNull()
  // OR ambiguity wins even when the correlation selects only one shared-Call invocation.
  loggingWorkFixture(journal, 'acme/repo', 9, '3'.repeat(32), '2'.repeat(32), at)
  loggingWorkFixture(journal, 'acme/repo', 10, '4'.repeat(32), '4'.repeat(32), at)
  loggingWorkFixture(journal, 'acme/repo', 11, '4'.repeat(32), '5'.repeat(32), at)
  const aliases = loggingWorkFixture(journal, 'acme/repo', 12, '6'.repeat(32), '6'.repeat(32), at)
  aliases.append({ type: 'invocation.admitted', invocation: { ...aliases.chain.invocations[0], id: '7'.repeat(32), admittedAt: at + 4000 } }, at + 4000)
  aliases.append({ type: 'invocation.settled', invocationId: '7'.repeat(32), callId: '7'.repeat(32), outcome: 'preflight_failed',
    evidence: { status: 'failed', action: 'not_started', nativeCallId: '7'.repeat(32), callId: '7'.repeat(32), completedAt: at + 5000 } }, at + 5000)
  const contradictory = loggingWorkFixture(journal, 'acme/repo', 13, '8'.repeat(32), '8'.repeat(32), at)
  contradictory.append({ type: 'invocation.admitted', invocation: { ...contradictory.chain.invocations[0], id: '9'.repeat(32), admittedAt: at + 4000 } }, at + 4000)
  contradictory.append({ type: 'invocation.reconciled', invocationId: '9'.repeat(32),
    evidence: { nativeCallId: 'a'.repeat(32), callId: 'b'.repeat(32) } }, at + 5000)
  const pairs = [[call, correlation], [null, correlation], [call, null], [call, correlation],
    ['2'.repeat(32), '2'.repeat(32)], [null, '2'.repeat(32)], ['2'.repeat(32), null],
    ['4'.repeat(32), '4'.repeat(32)], ['4'.repeat(32), null], [null, '4'.repeat(32)],
    ['7'.repeat(32), '7'.repeat(32)], ['7'.repeat(32), null], [null, '7'.repeat(32)],
    ['a'.repeat(32), '9'.repeat(32)], [null, '9'.repeat(32)], ['b'.repeat(32), null],
    [call, '2'.repeat(32)], ['c'.repeat(32), correlation], [call, 'c'.repeat(32)], ['c'.repeat(32), null], [null, null]]
    .map(([callId, correlationId]) => ({ callId, correlationId }))
  const before = db.prepare('SELECT * FROM behavior_chain_events').all()
  expect(journal.forInvocations(pairs)).toEqual(pairs.map(({ callId, correlationId }) => journal.forInvocation(callId, correlationId)))
  const impacts = behaviorChainWorkImpacts(journal, pairs)
  expect(impacts).toEqual(pairs.map(({ callId, correlationId }) => behaviorChainWorkImpact(journal, callId, correlationId)))
  expect(impacts.map(impact => impact?.impact ?? null)).toEqual(['recovered', 'recovered', 'recovered', 'recovered',
    null, 'retrying', null, null, 'retrying', null, 'unknown', 'unknown', 'unknown', null, null, null, null, null, null, null, null])
  expect(db.prepare('SELECT * FROM behavior_chain_events').all()).toEqual(before)
  // Selected projections still pass the journal's authoritative validation.
  db.prepare("UPDATE behavior_chain_current SET state = json_set(state, '$.held', 'unrecorded hold') WHERE chain_id = ?").run(fixture.chain.id)
  expect(() => journal.forInvocations([pairs[0]])).toThrow('behavior projection disagrees with the authoritative event journal')
})

it('scans a large retained journal once for 100 distinct hit/miss pairs', () => {
  const journal = new BehaviorChainJournal(db)
  const chainCount = 1000, invocationsPerChain = 5
  const identity = (issue: number, invocation: number) => ({
    correlationId: (issue * 10 + invocation).toString(16).padStart(32, '0'),
    callId: (100_000 + issue * 10 + invocation).toString(16).padStart(32, '0'),
  })
  db.transaction(() => {
    for (let issue = 1; issue <= chainCount; issue++) {
      const first = identity(issue, 1)
      const fixture = loggingWorkFixture(journal, 'bench/impact', issue, first.correlationId, first.callId, at)
      for (let invocation = 2; invocation <= invocationsPerChain; invocation++) {
        const pair = identity(issue, invocation)
        fixture.append({ type: 'invocation.admitted', invocation: { ...fixture.chain.invocations[0], id: pair.correlationId, admittedAt: at + invocation * 4000 } }, at + invocation * 4000)
        fixture.append({ type: 'invocation.settled', invocationId: pair.correlationId, callId: pair.callId, outcome: 'preflight_failed',
          evidence: { status: 'failed', action: 'not_started', completedAt: at + invocation * 4000 + 1000 } }, at + invocation * 4000 + 1000)
      }
    }
  })()
  const pairs = Array.from({ length: 100 }, (_, index) => identity(index % 2 ? chainCount + index : index / 2 + 1, invocationsPerChain))
  let visits = 0
  // Instrument the source, so even one SQL statement that rescans per pair fails.
  // Both measurements also include the 50 authoritative point reads for hits.
  db.function('count_impact_state', (value: string) => { visits++; return value })
  db.exec(`CREATE TEMP VIEW behavior_chain_current AS SELECT chain_id, sequence,
    count_impact_state(state) AS state, merged, resource_pending FROM main.behavior_chain_current`)
  try {
    const originalStart = performance.now()
    const original = pairs.map(({ callId, correlationId }) => journal.forInvocation(callId, correlationId))
    const originalMs = performance.now() - originalStart, originalVisits = visits
    visits = 0
    const batchStart = performance.now()
    const batch = journal.forInvocations(pairs)
    const batchMs = performance.now() - batchStart, batchVisits = visits
    expect(batch).toEqual(original)
    expect(batch.filter(Boolean)).toHaveLength(50)
    expect(originalVisits).toBe(chainCount * pairs.length + 50)
    expect(batchVisits).toBe(chainCount + 50)
    console.info('work-impact lookup comparison', { chains: chainCount, invocations: chainCount * invocationsPerChain,
      distinctPairs: pairs.length, hits: 50, originalMs, batchMs, originalVisits, batchVisits })
  } finally { db.exec('DROP VIEW temp.behavior_chain_current') }
}, 30_000)

it('directs a held merged chain to original review evidence despite an external approval', () => {
  const journal = new BehaviorChainJournal(db)
  const fixture = loggingWorkFixture(journal, 'acme/repo', 7, correlation, call, at)
  const before = structuredClone(fixture.observation)
  before.checkedAt = at + 3500
  before.prReviewers = [before.approver]
  Object.assign(before.pull!, { approved: true, ready: true, checksState: 'SUCCESS', failing: [], reviewIds: [91], reviewReceipts: [{ id: 91,
    head: before.pull!.head, state: 'APPROVED', invocation: null, response: null, submittedAt: at + 3500 }] })
  const current = fixture.append({ type: 'chain.observed', observation: before }, at + 3500)
  expect(decideBehaviorChain(current, before, at + 3500)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
  const merged = structuredClone(before)
  merged.checkedAt = at + 4500
  Object.assign(merged.pull!, { state: 'closed', merged: true, mergeSha: 'c'.repeat(40), mergedAt: at + 4000 })
  Object.assign(merged.publication, { state: 'closed', merged: true, merge_sha: 'c'.repeat(40) })
  const reason = 'confirmed merge retains an open review obligation: qualifying pre-merge review response is missing'
  expect(decideBehaviorChain(journal.read(fixture.chain.id)!, merged, at + 4500)).toEqual({ kind: 'hold', reason })
  fixture.append({ type: 'chain.observed', observation: merged }, at + 4500)
  fixture.append({ type: 'chain.merged', mergeSha: 'c'.repeat(40), evidence: { repository: 'acme/repo', pull_number: 107,
    merged: true, merge_sha: 'c'.repeat(40), review_complete: false } }, at + 4500)
  const retained = fixture.append({ type: 'chain.held', reason }, at + 4500)
  const history = journal.history(retained.id)
  journal.rebuild()
  expect(behaviorChainWorkImpact(journal, call, correlation)).toMatchObject({ impact: 'blocked', stage: 'Merged', retryAt: null,
    nextAction: 'Reconcile original pre-merge review evidence; no new invocation can start after merge' })
  expect(decideBehaviorChain(journal.read(retained.id)!, merged, at + 4500,
    { before, firstMerged: merged })).toEqual({ kind: 'hold', reason })
  expect(journal.read(retained.id)).toEqual(retained)
  expect(journal.history(retained.id)).toEqual(history)
})

it('keeps a current backoff retry time when progress advances past its wait note', () => {
  const journal = new BehaviorChainJournal(db)
  const fixture = loggingWorkFixture(journal, 'acme/repo', 7, correlation, call, at)
  // CI turns green mid-backoff: progress advances past the waiting event while the backoff stays current.
  fixture.append({ type: 'chain.observed', observation: { ...fixture.observation, checkedAt: at + 4000,
    pull: { ...fixture.observation.pull!, checksState: 'SUCCESS', pending: false, failing: [] as string[] } } }, at + 4000)
  expect(behaviorChainWorkImpact(journal, call, correlation)).toMatchObject({ impact: 'recovered', recovered: true,
    callerBehavior: 'repair_pr', retryAt: at + 63_000,
    nextAction: 'Automatic retry eligible after backoff, subject to existing admission gates' })
})

function handoffFixture() {
  const journal = new BehaviorChainJournal(db)
  const fixture = loggingWorkFixture(journal, 'acme/repo', 7, correlation, call, at)
  const id = '4'.repeat(32), callId = '5'.repeat(32), head = fixture.observation.pull!.head
  const diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'analysis',
    outcome: 'handoff', submission: 'none', stderr: '', stderr_truncated: false,
    expected_head: head, call_id: callId, correlation_id: id }
  const row = { id: callId, correlation_id: id, repo: 'acme/repo', pr_id: '107', actor: 'reviewer', behavior: 'pr_review',
    status: 'failed', error_code: 'review_budget_exhausted', expected_head: head,
    error: 'grok review reached its analysis time limit; handing off so the next model can run instead',
    completed_at: new Date(at + 5000).toISOString(), diagnostic }
  // Production review-pr carries its head as `--expected-head` argv without request context.
  const original: ChainAdmission = { id, behavior: 'review-pr', basis: chainBasis(['pr', head, fixture.observation.pull!.reviewContext]),
    actor: 'reviewer', model: 'grok', slot: 'primary', admittedAt: at + 4000,
    request: { command: 'agent-interface', cwd: '/isolated/fixture',
      argv: ['--pr-review', 'https://github.com/acme/repo/pull/107', '--expected-head', head] } }
  fixture.append({ type: 'invocation.admitted', invocation: original }, at + 4000)
  fixture.append({ type: 'invocation.settled', invocationId: id, callId, outcome: 'review_budget_exhausted',
    evidence: { status: 'failed', action: null, error_code: row.error_code, diagnostic: parseProcessDiagnostic(diagnostic), completedAt: at + 5000 } }, at + 5000)
  const event = normalize(callerDiagnostic(row, 'local')!, at + 5000)!
  const successor: ChainAdmission = { ...original, id: '6'.repeat(32), model: 'replacement', admittedAt: at + 6000 }
  const impact = () => behaviorChainWorkImpact(journal, callId, id)
  return { ...fixture, journal, head, original, successor, row, event, impact }
}

it('shows only a confirmed same-obligation handoff as Warning through the Logging adapter without rewriting retained events', () => {
  const fixture = handoffFixture()
  const { journal, successor, event, impact, append } = fixture
  const logs = new DiagnosticStore(':memory:')
  try {
    logs.append([event])
    expect(loggingSeverity(event, impact())).toBe('error') // Intent alone has no successor.
    append({ type: 'invocation.admitted', invocation: successor }, at + 6000)
    expect(impact()).toMatchObject({ impact: 'retrying', recovered: false })
    expect(loggingSeverity(event, impact())).toBe('warning')
    const response = { repository: 'acme/repo', pull_number: 107, head_sha: fixture.head,
      context_sha: fixture.observation.pull!.reviewContext, invocation_id: '7'.repeat(32), reviewer: successor.actor,
      model: successor.model, completed_at: at + 8000, coverage: 'complete',
      assessment: { verdict: 'The changed validation has no remaining blocking defects.',
        reviewed_context: 'Inspected the immutable diff and affected callers.', limitations: 'No live provider calls.' } }
    append({ type: 'invocation.settled', invocationId: successor.id, callId: response.invocation_id, outcome: 'reviewed_clean',
      evidence: { status: 'completed', action: 'reviewed_clean', head_sha: response.head_sha, review_id: 91,
        artifact: { review_response: response }, completedAt: at + 8000 } }, at + 8000)
    append({ type: 'chain.observed', observation: { ...fixture.observation, checkedAt: at + 9000,
      pull: { ...fixture.observation.pull!, reviewIds: [91], reviewReceipts: [{ id: 91, head: response.head_sha,
        invocation: response.invocation_id, state: 'COMMENTED', response, submittedAt: at + 8000 }] } } }, at + 9000)
    expect(impact()).toMatchObject({ impact: 'recovered', recovered: true })
    expect(loggingSeverity(event, impact())).toBe('warning')
    append({ type: 'chain.held', reason: 'current recovery is exhausted' }, at + 10_000)
    expect(impact()).toMatchObject({ impact: 'blocked', recovered: true, nextAction: expect.stringContaining('current recovery is exhausted') })
    expect(loggingSeverity(event, impact())).toBe('error')
    const before = journal.history(fixture.chain.id)
    journal.rebuild()
    expect(journal.history(fixture.chain.id)).toEqual(before)
    expect(logs.query({ workspace: 'local', operator: false }, {}).events).toMatchObject([{ ...event, severity: 'error' }])
  } finally { logs.close() }
})

it.each(['head', 'CI', 'slot', 'context', 'target', 'earlier verdict'])('does not mistake unrelated %s progress for a confirmed handoff', change => {
  const fixture = handoffFixture()
  const { successor, event, impact, append } = fixture
  const observation = structuredClone(fixture.observation)
  observation.checkedAt = at + 9000
  if (change === 'head') {
    observation.pull!.head = observation.publication.head_sha = 'b'.repeat(40)
    successor.request = { ...successor.request,
      argv: ['--pr-review', 'https://github.com/acme/repo/pull/107', '--expected-head', observation.pull!.head] }
  } else if (change === 'slot') successor.slot = 'secondary'
  else if (change === 'context') successor.basis = 'another review context'
  else if (change === 'target') successor.request = { ...successor.request,
    argv: ['--pr-review', 'https://github.com/acme/repo/pull/108', '--expected-head', fixture.head] }
  else if (change === 'CI') Object.assign(observation.pull!, { checksState: 'SUCCESS', pending: false, failing: [] })
  else {
    // An earlier or independent sibling's review cannot establish this Call's handoff.
    observation.pull!.reviewIds = [91]
    observation.pull!.reviewReceipts = [{ id: 91, head: observation.pull!.head, state: 'COMMENTED', invocation: '8'.repeat(32), submittedAt: at + 3000 }]
  }
  if (!['CI', 'earlier verdict'].includes(change)) append({ type: 'invocation.admitted', invocation: successor }, at + 6000)
  append({ type: 'chain.observed', observation }, at + 9000)
  expect(impact()).toMatchObject({ impact: 'unknown', recovered: false })
  expect(loggingSeverity(event, impact())).toBe('error')
})

it('retains Error for failed recovery and publication-uncertain timeouts despite a successor admission', () => {
  const { row, event, successor, impact, append } = handoffFixture()
  append({ type: 'invocation.admitted', invocation: successor }, at + 6000)
  const uncertain = normalize(callerDiagnostic({ ...row, error_code: 'review_submission_failed',
    error: 'review submission timed out; publication uncertain, reconcile before retry',
    diagnostic: { ...row.diagnostic, phase: 'submitting', outcome: 'timed_out', submission: 'uncertain' } }, 'local')!, at + 7000)!
  expect(loggingSeverity(uncertain, impact())).toBe('error')
  append({ type: 'invocation.settled', invocationId: successor.id, callId: '7'.repeat(32), outcome: 'review_recovery_failed',
    evidence: { status: 'failed', error_code: 'review_recovery_failed', action: 'not_started', completedAt: at + 8000 } }, at + 8000)
  expect(loggingSeverity(event, impact())).toBe('error')
  expect(impact()).toMatchObject({ impact: 'unknown', recovered: false })
})
