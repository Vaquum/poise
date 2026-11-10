import Database from 'better-sqlite3'
import { afterAll, afterEach, expect, it } from 'vitest'
import { BehaviorChainJournal } from '../server/behavior-chain-store'
import { behaviorChainAttention, behaviorChainWorkImpact } from '../server/behavior-chain-summary'
import { normalize } from '../gateway/src/diagnostics/contract'
import { DiagnosticStore } from '../gateway/src/diagnostics/store'
import { loggingWorkFixture } from './fixtures/logging-work-impact'

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

it('reads completed chains and refuses missing, conflicting and ambiguous exact associations', () => {
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
  loggingWorkFixture(journal, 'acme/repo', 9, correlation, call, at)
  expect(behaviorChainWorkImpact(journal, call, correlation)).toBeNull()
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
