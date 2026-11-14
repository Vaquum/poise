import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { BehaviorChainJournal, chainBasis, type BehaviorChain, type ChainEvent } from '../server/behavior-chain-store'
import type { ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { behaviorChainAttention } from '../server/behavior-chain-summary'
import { nativeActionReceipt } from '../server/behavior-chain-action'
import { completedReviewCall } from './review-response-fixture'
import { parseAgentLogStdout, type LogEntry } from '../server/agent-log-parse'
import { diagnosticPage, loggingRuntime, startLogging, stopLogging } from '../server/logging'
import * as processes from '../server/process'

const NOW = 1_800_000_000_000
const MERGE = 'c'.repeat(40)
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
const databases: Database.Database[] = []
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await stopLogging()
  vi.unstubAllEnvs()
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(path = ':memory:') {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  const db = new Database(path); databases.push(db)
  return { db, journal: new BehaviorChainJournal(db) }
}
function record(journal: BehaviorChainJournal, chain: BehaviorChain, event: ChainEvent) {
  return journal.append(chain.id, `${chain.id}:${chain.sequence}`, chain.sequence, event)
}
function seed(journal: BehaviorChainJournal, repository = 'acme/repo', issue = 7) {
  const id = `${repository}#${issue}`
  return journal.append(id, `seed:${id}`, 0, { type: 'chain.admitted', repository, issue,
    branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' })
}
function observation(merged = true): ChainObservation {
  return { checkedAt: Date.now(), existingPulls: [], issue: { open: true, eligible: true, revision: 'seed', commentIds: [] },
    prerequisites: { wait: null, base: 'a'.repeat(40), evidence: [] },
    issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer,
    publication: { pull_number: merged ? 17 : null, head_sha: merged ? 'a'.repeat(40) : null,
      head_invocation: null, state: merged ? 'closed' : null, merged, merge_sha: merged ? MERGE : null },
    pull: merged ? { number: 17, head: 'a'.repeat(40), headSince: NOW - 1000, state: 'closed', draft: false, merged: true,
      mergeSha: MERGE, mergedAt: NOW - 1000, queueEntry: null, queueRemoval: null, changesRequested: false,
      unresolved: 0, approved: false, ready: false, reviewIds: [], reviewRevision: 'missing', reviewContext: 'b'.repeat(64),
      reviewReceipts: [], greyRuns: [], pending: false, failing: [], conflict: false, behind: false } : null }
}
function operations(overrides: Partial<ChainRuntimeOperations> = {}): ChainRuntimeOperations {
  const forbidden = async () => { throw new Error('reconciliation fixture must not start work') }
  return { enabled: () => false, accounts: () => ({ author: 'author', reviewer: 'reviewer' }), discover: async () => [],
    ownsRepository: () => true, observe: async () => observation(), readInvocations: async () => ({ entries: [], quarantined: [] }),
    received: () => {}, available: () => false, capacity: () => 3, permitted: () => false, request: forbidden,
    launch: forbidden, perform: forbidden, readActionResult: forbidden, resumePublication: forbidden, fenceClosedTarget: forbidden, wake: () => {}, ...overrides }
}

function captureDiagnostics() {
  const root = mkdtempSync(join(tmpdir(), 'poise-chain-conflict-')); roots.push(root)
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.stubEnv('POISE_WORKSPACE_HANDLE', 'fixture')
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId: 'd'.repeat(32),
    events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '' })
  startLogging()
  return () => {
    loggingRuntime()!.flush()
    return diagnosticPage(null).events.filter(event => event.operation === 'behavior-chain.revision-conflict')
  }
}

it.each(['recovery', 'restart before admission', 'identical operator hold', 'missing original proof', 'unreleased resources',
  'unknown publication', 'changed source', 'ineligible source', 'pushed branch', 'bound PR', 'competing work',
  'unrelated passing run', 'source changes during preparation', 'missing review', 'review disappears during preparation',
  'relay recovery', 'relay restart before admission', 'relay identical operator hold', 'relay mismatched capture',
  'relay unreleased resources', 'relay unknown publication', 'relay unrelated passing run'])(
  'recovers one pre-PR implementation on attempt three through normal admission: %s', async scenario => {
    const relay = scenario.startsWith('relay ')
    const mode = scenario.replace(/^relay /, '')
    const { db, journal } = setup()
    let chain = seed(journal)
    const obs = observation(false)
    const basis = chainBasis(['issue', obs.issue.revision])
    obs.issueReviewers = [reviewer]; obs.issue.commentIds = [11]
    chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'original-review', behavior: 'review-issue',
      actor: chain.reviewer, model: reviewer.model, slot: reviewer.slot, basis, admittedAt: NOW - 500_000,
      request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
    chain = record(journal, chain, { type: 'invocation.settled', invocationId: 'original-review', callId: 'b'.repeat(32), outcome: 'commented',
      evidence: { status: 'completed', action: 'commented', issue_revision: obs.issue.revision,
        receipts: [{ issue: chain.id, author: chain.reviewer, comment_id: 11 }], resources_settled_at: new Date(NOW - 400_000).toISOString() } })
    const reviewed = structuredClone(chain.invocations[0])
    for (let attempt = 1; attempt <= 3; attempt++) {
      chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: `implementation-${attempt}`, behavior: 'implement-issue',
        actor: chain.author, model: reviewer.model, slot: reviewer.slot, basis, admittedAt: NOW - (4 - attempt) * 100_000,
        request: { command: 'agent-interface', cwd: '/fixture', argv: ['--expected-issue-revision', obs.issue.revision] } } })
      if (attempt < 3) chain = record(journal, chain, { type: 'invocation.settled', invocationId: `implementation-${attempt}`,
        callId: String(attempt).repeat(32), outcome: 'preflight_failed', evidence: { status: 'failed', action: 'not_started',
          completedAt: NOW - (4 - attempt) * 100_000, resources_settled_at: new Date(NOW - 50_000).toISOString() } })
    }
    const proof = { verified: true, base: 'a'.repeat(40), run: 1, runAttempt: 1, baselineRun: 2, baselineAttempt: 1,
      remediation: 'https://github.com/acme/repo/issues/1530', failures: [{ file: 'tests/test-relay.test.ts', test: 'warning array', cause: 'expected []' }],
      ...(relay ? { source: 'relay', run: '1'.repeat(32), baselineRun: '2'.repeat(32),
        capture: { call: 'a'.repeat(32), nonce: 'f'.repeat(64), repository: 'acme/repo', base: 'a'.repeat(40) },
        candidate: '3'.repeat(64), baselineCapture: '4'.repeat(64),
        relay: { original: { payload: 'original', signature: 'authenticated by Caller' }, baseline: { payload: 'baseline', signature: 'authenticated by Caller' } } } : {}) }
    const original: LogEntry = { ...completedReviewCall(chain.repository, 7, 'a'.repeat(40), chain.author), id: 'a'.repeat(32),
      behavior: 'implement_issue', source: 'poise:behavior-chain', correlation_id: 'implementation-3', status: 'failed',
      action: 'not_started', outcome: 'preflight_failed', head_sha: null, review_id: null,
      error_code: 'atomic_work_blocked', error: 'Original test failed on the implementation base',
      completed_at: new Date(NOW - 3000).toISOString(), resources_settled_at: mode === 'unreleased resources' ? null : new Date(NOW - 2000).toISOString(),
      resource_ownership: { version: 1, roots: [], errors: [] },
      artifact: { phase: mode === 'unknown publication' ? 'publishing' : 'executing',
        ...(relay ? { test_capture: { ...proof.capture, ...(mode === 'mismatched capture' ? { nonce: '0'.repeat(64) } : {}) } } : {}),
        prepared: { repository: chain.repository, issue_number: 7, actor: chain.author, branch: chain.branch,
          checkout_head: proof.base, head_sha: null, pull_number: null },
        ...(mode === 'missing original proof' ? {} : { test_dependency: proof }) } }
    const calls = [original]
    obs.testDependency = { invocationId: 'implementation-3', verified: true, recovered: false }
    const observe = vi.fn(async () => ({ ...structuredClone(obs), checkedAt: Date.now() }))
    const launch = vi.fn(async () => true)
    let admitted = mode !== 'restart before admission'
    const native = operations({ enabled: () => true, available: () => true, permitted: () => admitted, observe, launch,
      readInvocations: async () => parseAgentLogStdout(JSON.stringify(calls), 'pre-PR test recovery'),
      request: async () => {
        if (mode === 'source changes during preparation') obs.existingPulls = ['https://github.com/acme/repo/pull/99']
        if (mode === 'review disappears during preparation') obs.issue.commentIds = []
        return { command: 'agent-interface', cwd: '/fixture', argv: ['--model', reviewer.model] }
      } })
    let runtime = new BehaviorChainRuntime(journal, native)
    await runtime.run()
    chain = journal.read(chain.id)!
    expect(chain.held).toBe(original.error)
    const failed = structuredClone(chain.invocations.at(-1))
    expect(launch).not.toHaveBeenCalled()
    if (mode === 'identical operator hold') chain = record(journal, chain, { type: 'chain.held', reason: original.error })
    obs.testDependency = { ...obs.testDependency, recovered: mode !== 'unrelated passing run',
      recovery: { merge: 'b'.repeat(40), base: 'c'.repeat(40), run: { id: 3 } } }
    obs.prerequisites!.base = 'c'.repeat(40)
    if (mode === 'changed source') obs.issue.revision = 'changed'
    if (mode === 'ineligible source') obs.issue.eligible = false
    if (mode === 'pushed branch') obs.publication.head_sha = 'd'.repeat(40)
    if (mode === 'bound PR') obs.publication.pull_number = 17
    if (mode === 'competing work') obs.existingPulls = ['https://github.com/acme/repo/pull/99']
    if (mode === 'missing review') obs.issue.commentIds = []
    vi.setSystemTime(NOW + 120_000)
    await runtime.run()
    if (mode === 'restart before admission') {
      expect(journal.read(chain.id)).toMatchObject({ held: null, testRecovery: { hold: { invocationId: 'implementation-3' } } })
      expect(launch).not.toHaveBeenCalled()
      journal.rebuild()
      runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), native)
      admitted = true
      await runtime.run()
    }
    chain = journal.read(chain.id)!
    expect(chain.invocations[0]).toEqual(reviewed)
    expect(chain.invocations[3]).toEqual(failed)
    if (!['recovery', 'restart before admission'].includes(mode)) {
      expect(launch).not.toHaveBeenCalled()
      expect(chain.invocations).toHaveLength(4)
      return
    }
    expect(launch).toHaveBeenCalledTimes(1)
    const replacement = chain.invocations.at(-1)!
    expect(chain).toMatchObject({ held: null, resumedAfterSequence: 0, testRecovery: { merge: 'b'.repeat(40), admission: replacement.id } })
    expect(replacement).toMatchObject({ behavior: 'implement-issue', state: 'started', basis })
    calls.push({ ...original, id: 'c'.repeat(32), correlation_id: replacement.id, artifact: { phase: 'executing' } })
    vi.setSystemTime(Date.now() + 120_000)
    await runtime.run()
    journal.rebuild()
    runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), native)
    // Neither another main commit nor a duplicate passing validation restores
    // the allowance after the replacement has failed.
    obs.testDependency.recovery!.base = 'e'.repeat(40)
    obs.prerequisites!.base = 'e'.repeat(40)
    for (let tick = 0; tick < 3; tick++) { vi.setSystemTime(Date.now() + 120_000); await runtime.run() }
    expect(journal.read(chain.id)?.invocations).toHaveLength(5)
    expect(launch).toHaveBeenCalledTimes(1)
  })

it.each(['receipt-read', 'observation', 'request-preparation'] as const)(
  'recovers a competing write during %s and advances another chain without a stale effect', async phase => {
    const { journal } = setup()
    let first = seed(journal, 'aaa/repo')
    const second = seed(journal, 'zzz/repo')
    if (phase === 'receipt-read') {
      first = record(journal, first, { type: 'invocation.admitted', invocation: { id: 'original', behavior: 'implement-issue',
        actor: first.author, model: reviewer.model, slot: reviewer.slot, basis: 'seed', admittedAt: NOW - 60_000,
        request: { command: 'agent-interface', cwd: '/fixture', argv: ['--model', reviewer.model] } } })
      first = record(journal, first, { type: 'invocation.started', invocationId: 'original' })
    }
    const diagnostics = captureDiagnostics()
    let raced = false
    const compete = () => {
      if (raced) return
      raced = true
      record(journal, journal.read(first.id)!, phase === 'receipt-read'
        ? { type: 'invocation.reconciled', invocationId: 'original', evidence: { nativeExit: { code: 1, signal: null, error: null } } }
        : { type: 'chain.held', reason: 'concurrent person hold' })
    }
    const call: LogEntry = { ...completedReviewCall(first.repository, 7, 'a'.repeat(40), first.author),
      source: 'poise:behavior-chain', correlation_id: 'original', behavior: 'implement_issue', status: 'failed',
      action: null, outcome: null, resources_settled_at: null, artifact: null }
    const readInvocations = vi.fn<ChainRuntimeOperations['readInvocations']>(async () => {
      if (!raced) { compete(); return { entries: [], quarantined: [] } }
      return { entries: [call], quarantined: [] }
    })
    const observe = vi.fn(async (chain: BehaviorChain) => {
      if (chain.id === first.id && phase === 'observation') compete()
      return observation(false)
    })
    const request = vi.fn(async (chain: BehaviorChain) => {
      if (chain.id === first.id && phase === 'request-preparation') compete()
      return { command: 'agent-interface' as const, cwd: '/fixture', argv: ['--model', reviewer.model] }
    })
    const launch = vi.fn<ChainRuntimeOperations['launch']>(async () => true)
    await expect(new BehaviorChainRuntime(journal, operations({ enabled: () => true, available: () => true,
      permitted: () => true, observe, request, launch, readInvocations })).run()).resolves.toBeUndefined()
    expect(raced).toBe(true)
    expect(journal.read(second.id)?.invocations).toMatchObject([{ behavior: 'implement-issue', state: 'started' }])
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch.mock.calls[0][0]).toMatchObject({ id: journal.read(second.id)!.invocations[0].id })
    const current = journal.read(first.id)!
    if (phase === 'receipt-read') {
      expect(readInvocations.mock.calls).toEqual([[['original']], [['original']]])
      expect(current.invocations).toMatchObject([{ id: 'original', state: 'uncertain', callId: null,
        evidence: { nativeExit: { code: 1 }, callId: call.id } }])
    } else {
      expect(current.held).toBe('concurrent person hold')
      expect(current.invocations).toHaveLength(0)
      expect(observe.mock.calls.filter(([chain]) => chain.id === first.id)).toHaveLength(phase === 'request-preparation' ? 3 : 2)
    }
    expect(diagnostics()).toMatchObject([{ severity: 'warning', target: first.id,
      phase: phase === 'receipt-read' ? 'reconciliation' : phase,
      context: { outcome: 'recovered', attempts: 2 } }])
  })

it('defers repeated conflicts after one retry, including a chain moved to the deferred page', async () => {
  const { journal } = setup()
  const first = seed(journal, 'aaa/repo'), second = seed(journal, 'zzz/repo')
  const diagnostics = captureDiagnostics()
  let writes = 0
  const launch = vi.fn(async () => true)
  const runtime = new BehaviorChainRuntime(journal, operations({ enabled: () => true, available: () => true,
    permitted: () => true, launch, request: async () => ({ command: 'agent-interface', cwd: '/fixture', argv: ['--model', reviewer.model] }),
    observe: async chain => {
      if (chain.id === first.id) record(journal, journal.read(first.id)!, { type: 'chain.held', reason: `competing hold ${++writes}` })
      return observation(false)
    } }))
  await expect(runtime.run()).resolves.toBeUndefined()
  expect(writes).toBe(2)
  expect(journal.read(first.id)).toMatchObject({ held: 'competing hold 2', invocations: [], observation: null })
  expect(journal.read(second.id)?.invocations).toMatchObject([{ state: 'started' }])
  expect(launch).toHaveBeenCalledTimes(1)
  expect(diagnostics()).toMatchObject([{ target: first.id, phase: 'observation', context: { outcome: 'deferred', attempts: 2 } }])
})

it('defers a revision conflict when the existing sweep budget is exhausted', async () => {
  const { journal } = setup()
  const chain = seed(journal)
  const diagnostics = captureDiagnostics()
  const observe = vi.fn(async () => {
    record(journal, journal.read(chain.id)!, { type: 'chain.held', reason: 'concurrent hold' })
    vi.setSystemTime(NOW + 45_001)
    return observation(false)
  })
  await expect(new BehaviorChainRuntime(journal, operations({ observe })).run()).resolves.toBeUndefined()
  expect(observe).toHaveBeenCalledTimes(1)
  expect(journal.read(chain.id)).toMatchObject({ held: 'concurrent hold', invocations: [], observation: null })
  expect(diagnostics()).toMatchObject([{ target: chain.id, phase: 'observation', context: { outcome: 'deferred', attempts: 1 } }])
})

it('surfaces a real journal failure even when its message matches a revision conflict', async () => {
  const { db, journal } = setup()
  seed(journal)
  const diagnostics = captureDiagnostics()
  db.exec(`CREATE TRIGGER fail_observation BEFORE INSERT ON behavior_chain_events
    WHEN json_extract(NEW.payload, '$.type') = 'chain.observed'
    BEGIN SELECT RAISE(ABORT, 'behavior chain changed before event admission'); END`)
  const observe = vi.fn(async () => observation(false))
  await expect(new BehaviorChainRuntime(journal, operations({ observe })).run()).rejects.toThrow('behavior chain changed before event admission')
  expect(observe).toHaveBeenCalledTimes(1)
  expect(diagnostics()).toEqual([])
})

it.each(['recovery', 'base update', 'base update review', 'operator hold', 'uncertain publication', 'publication receipt',
  'unreleased resources', 'ambiguous cause', 'missing failure identity'].flatMap(mode => ['head', 'queue'].map(source => ({ mode, source }))))(
  'rechecks a $source CI-only repair hold without duplicate work: $mode', async ({ mode, source }) => {
    const recovers = ['recovery', 'base update', 'base update review'].includes(mode)
    const { db, journal } = setup()
    const obs = observation()
    obs.publication.state = 'open'; obs.publication.merged = false; obs.publication.merge_sha = null
    Object.assign(obs.pull!, { state: 'open', merged: false, mergeSha: null, checksState: 'FAILURE', failing: ['unit:failure'] })
    obs.prReviewers = []
    let chain = seed(journal)
    chain = record(journal, chain, { type: 'chain.observed', observation: structuredClone(obs) })
    const id = 'blocked-repair'
    record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: 'repair-pr', actor: chain.author,
      model: reviewer.model, slot: reviewer.slot, basis: 'failed-ci', admittedAt: NOW - 86_400_000,
      request: { command: 'agent-interface', argv: ['--atomic-work', 'acme/repo#7', '--expected-head', obs.pull!.head],
        cwd: '/fixture', context: { head: obs.pull!.head, reviewRevision: obs.pull!.reviewRevision, queueRemoval: 'removed' } } } })
    const queue = { removal: 'removed', integration: 'b'.repeat(40), base: 'c'.repeat(40),
      failures: [{ name: 'unit', check: 41, job: mode === 'missing failure identity' ? 0 : 42, run: 40, workflow: 1, attempt: 1,
        url: 'https://github.com/acme/repo/actions/runs/40/job/42' }] }
    if (source === 'queue') obs.pull!.queueRemoval = { id: queue.removal, reason: 'failed_checks', at: NOW - 1000, actor: null }
    const ci = { action: 'list_failing_ci', repository: chain.repository, pull_number: 17, head_sha: obs.pull!.head,
      ...(source === 'queue' ? { queue } : {}),
      failing: [{ type: 'check_run', name: 'unit', state: 'completed', conclusion: 'failure', check_run_id: 41,
        log_id: mode === 'missing failure identity' ? 0 : 42, url: 'https://github.com/acme/repo/actions/runs/40/job/42' },
      { type: 'check_run', name: 'build', state: 'in_progress', conclusion: null, check_run_id: 43, log_id: 44,
        url: 'https://github.com/acme/repo/actions/runs/40/job/44' }] }
    if (source === 'queue') ci.failing = []
    const call: LogEntry = { ...completedReviewCall(chain.repository, 17, obs.pull!.head, chain.author), id: 'a'.repeat(32),
      behavior: 'repair_pr', source: 'poise:behavior-chain', correlation_id: id, status: 'failed',
      action: 'not_started', outcome: 'preflight_failed', head_sha: null, review_id: mode === 'publication receipt' ? 91 : null,
      error_code: 'atomic_work_blocked', error: 'CI failed; repair cannot continue',
      artifact: { phase: 'executing', ...(mode === 'ambiguous cause' ? {} : { ci_blocker: ci }) },
      resource_ownership: { version: 1, roots: [], errors: [] }, resources_settled_at: null }
    const calls = [call]
    const observe = vi.fn(async () => ({ ...structuredClone(obs), checkedAt: Date.now() }))
    const launch = vi.fn(async () => true)
    const request = vi.fn(async () => ({ command: 'agent-interface' as const, cwd: '/fixture', argv: ['--model', reviewer.model] }))
    const native = operations({ enabled: () => true, available: () => true, permitted: () => true, observe, launch, request,
      readInvocations: async () => parseAgentLogStdout(JSON.stringify(calls), 'CI hold regression') })
    let runtime = new BehaviorChainRuntime(journal, native)
    await runtime.run()
    expect(journal.read(chain.id)!.held).toContain(call.error)
    const ciHold = ['ambiguous cause', 'missing failure identity', 'publication receipt'].includes(mode) ? undefined
      : { invocationId: id, callId: call.id, head: ci.head_sha, ...(source === 'queue' ? { queue } : {}) }
    expect(journal.read(chain.id)!.ciHold).toEqual(ciHold)
    expect(observe).not.toHaveBeenCalled()
    await runtime.run()
    expect(launch).not.toHaveBeenCalled()
    if (mode === 'uncertain publication') {
      call.action = null
      call.artifact = { ...call.artifact, phase: 'publishing', plan_sha: 'd'.repeat(64) }
    }
    vi.setSystemTime(NOW + 5000)
    if (mode !== 'unreleased resources') call.resources_settled_at = new Date().toISOString()
    await runtime.run()
    chain = journal.read(chain.id)!
    expect(chain.held).toContain(call.error)
    expect(chain.ciHold).toEqual(ciHold)
    expect(chain.invocations[0].state).toBe(['uncertain publication', 'unreleased resources'].includes(mode) ? 'uncertain' : 'settled')
    const failedReceipt = structuredClone(chain.invocations[0])
    if (mode === 'operator hold') chain = record(journal, chain, { type: 'chain.held', reason: call.error })
    const history = journal.history(chain.id)
    journal.rebuild()
    expect(journal.read(chain.id)!.ciHold).toEqual(mode === 'operator hold' ? undefined : ciHold)
    runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), native)
    for (let tick = 0; tick < 3; tick++) await runtime.run()
    if (mode !== 'uncertain publication') expect(journal.history(chain.id)).toEqual(history)
    expect(launch).not.toHaveBeenCalled()
    if (mode === 'recovery') {
      expect(journal.reconciliationAt(chain)).toBe(Date.now() + 120_000)
      for (const state of [
        { checksState: 'PENDING', pending: true, failing: [] },
        { checksState: 'FAILURE', pending: false, failing: ['unit:failure'] },
        { checksState: 'SUCCESS', pending: true, failing: [] },
        { checksState: 'SUCCESS', pending: false, failing: ['unit:failure'] },
        { checksState: null, pending: false, failing: [] },
        { checksState: 'SUCCESS', pending: false, failing: [], head: 'c'.repeat(40) },
      ]) {
        Object.assign(obs.pull!, { head: ci.head_sha, ...state })
        vi.setSystemTime(Date.now() + 120_000)
        await runtime.run()
        expect(journal.read(chain.id)!.held).toContain(call.error)
        expect(launch).not.toHaveBeenCalled()
        expect(journal.reconciliationAt(journal.read(chain.id)!)).toBe(Date.now() + 120_000)
      }
      Object.assign(obs.pull!, { checksState: 'SUCCESS', head: ci.head_sha, pending: false, failing: [] })
      for (const offset of [-120_001, 1]) {
        vi.setSystemTime(Date.now() + 120_000)
        observe.mockImplementationOnce(async () => ({ ...structuredClone(obs), checkedAt: Date.now() + offset }))
        await runtime.run()
        expect(journal.read(chain.id)!.held).toContain(call.error)
      }
      vi.setSystemTime(Date.now() + 120_001)
      observe.mockRejectedValueOnce(new Error('CI evidence unavailable'))
      await expect(runtime.run()).rejects.toThrow('CI evidence unavailable')
      expect(journal.read(chain.id)!.held).toContain(call.error)
    }
    if (!recovers) {
      obs.pull!.conflict = true
      vi.setSystemTime(Date.now() + 120_000)
      await runtime.run()
      expect(journal.read(chain.id)!.held).toContain(call.error)
      expect(launch).not.toHaveBeenCalled()
    }
    Object.assign(obs.pull!, { checksState: 'SUCCESS', head: ci.head_sha, pending: false, failing: [] })
    if (source === 'queue') {
      obs.ciRecovery = { invocationId: id, removal: queue.removal, integration: queue.integration, recovered: true, reason: 'Verified integration recovery' }
      if (mode === 'recovery') {
        for (const mismatch of [undefined, { ...obs.ciRecovery, recovered: false }, { ...obs.ciRecovery, invocationId: 'other' },
          { ...obs.ciRecovery, removal: 'other' }, { ...obs.ciRecovery, integration: 'e'.repeat(40) }]) {
          observe.mockImplementationOnce(async () => ({ ...structuredClone(obs), checkedAt: Date.now(), ciRecovery: mismatch }))
          vi.setSystemTime(Date.now() + 120_000)
          await runtime.run()
          expect(journal.read(chain.id)!.ciHold).toEqual(ciHold)
          expect(launch).not.toHaveBeenCalled()
        }
      }
    }
    if (mode !== 'recovery') {
      obs.pull!.head = 'e'.repeat(40)
      obs.publication.head_sha = obs.pull!.head
      obs.ciBaseUpdate = { from: ci.head_sha, head: obs.pull!.head, base: 'f'.repeat(40), tree: 'd'.repeat(40) }
    }
    if (mode === 'base update review') obs.prReviewers = [reviewer]
    if (recovers) obs.issue.open = false
    vi.setSystemTime(Date.now() + 86_400_000)
    await runtime.run()
    chain = journal.read(chain.id)!
    if (!recovers) {
      expect(chain.held).toContain(call.error)
      expect(chain.invocations).toHaveLength(1)
      expect(launch).not.toHaveBeenCalled()
      return
    }
    expect(chain.held).toBeNull()
    expect(chain.ciHold).toBeUndefined()
    expect(chain.resumedAfterSequence).toBe(0)
    expect(chain.invocations[0]).toEqual(failedReceipt)
    expect(chain.invocations.at(-1)!.behavior).toBe(mode === 'base update review' ? 'review-pr' : 'approve-pr')
    expect(chain.observation).toMatchObject({ pull: { head: obs.pull!.head } })
    expect(launch).toHaveBeenCalledTimes(1)
    const recovery = journal.history(chain.id).map(row => JSON.parse(row.payload)).filter(event => event.ciRecovery)
    expect(recovery).toEqual([{ type: 'chain.resumed', ciRecovery: ciHold }])
    journal.rebuild()
    runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), native)
    for (let tick = 0; tick < 3; tick++) await runtime.run()
    expect(launch).toHaveBeenCalledTimes(1)
    if (mode === 'base update review') return
    vi.setSystemTime(Date.now() + 2000)
    const approval: LogEntry = { ...completedReviewCall(chain.repository, 17, obs.pull!.head, chain.reviewer),
      correlation_id: chain.invocations.at(-1)!.id, source: 'poise:behavior-chain', behavior: 'pr_approve',
      action: 'approved', outcome: 'approved', resources_settled_at: new Date().toISOString(),
      resource_ownership: { version: 1, roots: [], errors: [] } }
    calls.push(approval)
    Object.assign(obs.pull!, { approved: true, reviewIds: [approval.review_id!],
      reviewReceipts: [{ id: approval.review_id!, head: obs.pull!.head, state: 'APPROVED', invocation: approval.id,
        response: approval.artifact!.review_response, submittedAt: Date.now() }] })
    await runtime.run()
    expect(journal.read(chain.id)!.invocations.at(-1)).toMatchObject({ state: 'settled', outcome: 'approved' })
    expect(journal.read(chain.id)!.waiting).toBe('native repository readiness gates are not satisfied')
    expect(journal.read(chain.id)!.invocations[0]).toEqual(failedReceipt)
    expect(launch).toHaveBeenCalledTimes(1)
  })

it('admits only a scoped exact-head conflict repair and never replenishes its retry budget across CI holds and rebuilds', async () => {
  const { db, journal } = setup()
  const obs = observation()
  Object.assign(obs.publication, { state: 'open', merged: false, merge_sha: null })
  Object.assign(obs.pull!, { state: 'open', merged: false, mergeSha: null, checksState: 'FAILURE', failing: ['unit:failure'] })
  let chain = seed(journal)
  chain = record(journal, chain, { type: 'chain.resumed' })
  const retryBoundary = chain.resumedAfterSequence
  chain = record(journal, chain, { type: 'chain.observed', observation: structuredClone(obs) })
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'old-ci-failure', behavior: 'repair-pr',
    actor: chain.author, model: reviewer.model, slot: reviewer.slot, basis: 'before-conflict', admittedAt: NOW - 86_400_000,
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--expected-head', obs.pull!.head],
      context: { head: obs.pull!.head, reviewRevision: obs.pull!.reviewRevision } } } })
  const original: LogEntry = { ...completedReviewCall(chain.repository, 17, obs.pull!.head, chain.author), id: 'a'.repeat(32),
    behavior: 'repair_pr', source: 'poise:behavior-chain', correlation_id: 'old-ci-failure', status: 'failed', action: 'not_started',
    outcome: 'preflight_failed', error_code: 'atomic_work_blocked', error: 'Original CI job failed', review_id: null, head_sha: null,
    completed_at: new Date(NOW - 3000).toISOString(), resources_settled_at: new Date(NOW - 2000).toISOString(),
    resource_ownership: { version: 1, roots: [], errors: [] }, artifact: { phase: 'executing', ci_blocker: {
      action: 'list_failing_ci', repository: chain.repository, pull_number: 17, head_sha: obs.pull!.head,
      failing: [{ type: 'check_run', name: 'unit', state: 'completed', conclusion: 'failure', check_run_id: 41, log_id: 42,
        url: 'https://github.com/acme/repo/actions/runs/40/job/42' }] } } }
  const calls = [original]
  let enabled = true, permitted = true, author = chain.author
  const observe = vi.fn(async () => ({ ...structuredClone(obs), checkedAt: Date.now() }))
  const launch = vi.fn<ChainRuntimeOperations['launch']>(async (invocation, _exit, allowed) => {
    expect(allowed()).toBe(true)
    calls.push({ ...original, id: chainBasis(invocation.id).slice(0, 32), correlation_id: invocation.id,
      completed_at: new Date().toISOString(), resources_settled_at: new Date().toISOString() })
    return true
  })
  const native = operations({ enabled: () => enabled, permitted: () => permitted, accounts: () => ({ author, reviewer: chain.reviewer }),
    available: () => true, observe, launch,
    readInvocations: async () => parseAgentLogStdout(JSON.stringify(calls), 'conflict CI hold retry regression'),
    request: async (_chain, fresh) => ({ command: 'agent-interface', cwd: '/fixture',
      argv: ['--model', reviewer.model, '--expected-head', fresh.pull!.head, '--merge-base'],
      context: { head: fresh.pull!.head, reviewRevision: fresh.pull!.reviewRevision } }) })
  let runtime = new BehaviorChainRuntime(journal, native)
  await runtime.run()
  const held = journal.read(chain.id)!
  expect(held).toMatchObject({ held: original.error, ciHold: { invocationId: 'old-ci-failure' } })
  const originalReceipt = structuredClone(held.invocations[0])
  obs.pull!.conflict = true
  for (const guard of ['unchanged', 'behind', 'changed head', 'queue', 'draft', 'closed seed', 'competing work',
    'issue review', 'stale', 'future', 'paused', 'disabled', 'owner']) {
    vi.setSystemTime(Date.now() + 120_001)
    const fresh = { ...structuredClone(obs), checkedAt: Date.now() }
    if (guard === 'unchanged' || guard === 'behind') fresh.pull!.conflict = false
    if (guard === 'behind') fresh.pull!.behind = true
    if (guard === 'changed head') {
      fresh.pull!.head = 'd'.repeat(40); fresh.publication.head_sha = fresh.pull!.head
      fresh.pull!.checksState = 'SUCCESS'; fresh.pull!.failing = []
    }
    if (guard === 'queue') fresh.pull!.queueEntry = 'existing-entry'
    if (guard === 'draft') fresh.pull!.draft = true
    if (guard === 'closed seed') fresh.issue.open = false
    if (guard === 'competing work') fresh.existingPulls = ['https://github.com/acme/repo/pull/99']
    if (guard === 'issue review') fresh.issueReviewers = [reviewer]
    if (guard === 'stale') fresh.checkedAt -= 120_001
    if (guard === 'future') fresh.checkedAt++
    enabled = guard !== 'paused'; permitted = guard !== 'disabled'; author = guard === 'owner' ? 'another-author' : chain.author
    observe.mockResolvedValueOnce(fresh)
    await runtime.run()
    expect(journal.read(chain.id), guard).toMatchObject({ held: original.error, ciHold: held.ciHold, resumedAfterSequence: retryBoundary })
    expect(launch, guard).not.toHaveBeenCalled()
  }
  enabled = true; permitted = true; author = chain.author
  vi.setSystemTime(Date.now() + 120_001)
  await runtime.run()
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(launch).toHaveBeenCalledTimes(attempt)
    chain = journal.read(chain.id)!
    const repair = chain.invocations.at(-1)!
    expect(repair).toMatchObject({ behavior: 'repair-pr', state: 'started' })
    expect(repair.basis).toBe(chainBasis(['repair', obs.pull!.head, obs.pull!.failing, true, false, false,
      obs.pull!.unresolved, obs.pull!.reviewRevision, obs.issue.revision]))
    await runtime.run()
    chain = journal.read(chain.id)!
    expect(chain).toMatchObject({ held: original.error, ciHold: { invocationId: repair.id }, resumedAfterSequence: retryBoundary })
    expect(chain.invocations.at(-1)).toMatchObject({ state: 'settled', evidence: { action: 'not_started' } })
    journal.rebuild()
    runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), native)
    vi.setSystemTime(Date.now() + 120_001)
    await runtime.run()
  }
  for (let tick = 0; tick < 4; tick++) { vi.setSystemTime(Date.now() + 120_001); await runtime.run() }
  chain = journal.read(chain.id)!
  expect(launch).toHaveBeenCalledTimes(3)
  expect(chain.invocations).toHaveLength(4)
  expect(chain.invocations[0]).toEqual(originalReceipt)
  expect(chain.resumedAfterSequence).toBe(retryBoundary)
  expect(journal.history(chain.id).map(row => JSON.parse(row.payload)).filter(event => event.ciRecovery)).toHaveLength(3)
})

it('releases a CI-only hold for a pending issue review when CI recovers on the conflicted head', async () => {
  const { journal } = setup()
  const obs = observation()
  Object.assign(obs.publication, { state: 'open', merged: false, merge_sha: null })
  Object.assign(obs.pull!, { state: 'open', merged: false, mergeSha: null, checksState: 'FAILURE', failing: ['unit:failure'] })
  let chain = seed(journal)
  chain = record(journal, chain, { type: 'chain.observed', observation: structuredClone(obs) })
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'old-ci-failure', behavior: 'repair-pr',
    actor: chain.author, model: reviewer.model, slot: reviewer.slot, basis: 'before-conflict', admittedAt: NOW - 86_400_000,
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--expected-head', obs.pull!.head],
      context: { head: obs.pull!.head, reviewRevision: obs.pull!.reviewRevision } } } })
  const original: LogEntry = { ...completedReviewCall(chain.repository, 17, obs.pull!.head, chain.author), id: 'a'.repeat(32),
    behavior: 'repair_pr', source: 'poise:behavior-chain', correlation_id: 'old-ci-failure', status: 'failed', action: 'not_started',
    outcome: 'preflight_failed', error_code: 'atomic_work_blocked', error: 'Original CI job failed', review_id: null, head_sha: null,
    completed_at: new Date(NOW - 3000).toISOString(), resources_settled_at: new Date(NOW - 2000).toISOString(),
    resource_ownership: { version: 1, roots: [], errors: [] }, artifact: { phase: 'executing', ci_blocker: {
      action: 'list_failing_ci', repository: chain.repository, pull_number: 17, head_sha: obs.pull!.head,
      failing: [{ type: 'check_run', name: 'unit', state: 'completed', conclusion: 'failure', check_run_id: 41, log_id: 42,
        url: 'https://github.com/acme/repo/actions/runs/40/job/42' }] } } }
  const calls = [original]
  const observe = vi.fn(async () => ({ ...structuredClone(obs), checkedAt: Date.now() }))
  const launch = vi.fn(async () => true)
  const native = operations({ enabled: () => true, available: () => true, permitted: () => true, observe, launch,
    readInvocations: async () => parseAgentLogStdout(JSON.stringify(calls), 'conflicted green review regression'),
    request: async () => ({ command: 'agent-interface', cwd: '/fixture', argv: ['--model', reviewer.model] }) })
  const runtime = new BehaviorChainRuntime(journal, native)
  await runtime.run()
  expect(journal.read(chain.id)).toMatchObject({ held: original.error, ciHold: { invocationId: 'old-ci-failure' } })
  // A seed edit requires a new issue review while CI recovers on the retained conflicted head.
  obs.issue.revision = 'edited-seed'
  obs.issueReviewers = [reviewer]
  Object.assign(obs.pull!, { conflict: true, checksState: 'SUCCESS', failing: [], pending: false })
  vi.setSystemTime(Date.now() + 120_001)
  await runtime.run()
  chain = journal.read(chain.id)!
  expect(chain.held).toBeNull()
  expect(chain.ciHold).toBeUndefined()
  expect(chain.invocations.at(-1)).toMatchObject({ behavior: 'review-issue', state: 'started' })
  expect(launch).toHaveBeenCalledTimes(1)
})

it('deduplicates merged holds and bounds repeated observation from durable state across runtime replacement', async () => {
  const { journal } = setup()
  const chain = seed(journal)
  const observe = vi.fn(async () => observation())
  const runtime = new BehaviorChainRuntime(journal, operations({ observe }))
  await runtime.run()
  const original = journal.history(chain.id)
  for (let pass = 0; pass < 5; pass++) await runtime.run()
  expect(journal.history(chain.id)).toEqual(original)
  expect(observe).toHaveBeenCalledTimes(1)
  journal.rebuild()
  await new BehaviorChainRuntime(journal, operations({ observe })).run()
  expect(observe).toHaveBeenCalledTimes(1)
  vi.setSystemTime(NOW + 120_000)
  await runtime.run()
  expect(observe).toHaveBeenCalledTimes(2)
  expect(journal.history(chain.id).filter((row) => JSON.parse(row.payload).type === 'chain.held')).toHaveLength(1)
  vi.setSystemTime(NOW + 240_000)
  await runtime.run()
  expect(observe).toHaveBeenCalledTimes(2)
  expect(journal.active().map((row) => row.id)).toContain(chain.id)
})

it('preserves the person hold rather than replacing it with a merge-verification hold', async () => {
  const { journal } = setup()
  let chain = seed(journal)
  chain = record(journal, chain, { type: 'chain.held', reason: 'New invocations held by the person' })
  await new BehaviorChainRuntime(journal, operations()).run()
  expect(journal.read(chain.id)?.held).toBe('New invocations held by the person')
})

it.each(['clean review', 'changes requested', 'capacity waiting'])(
  'surfaces fresh queue admission immediately without replacing review ownership: %s', async mode => {
    const { journal } = setup()
    let chain = seed(journal)
    const before = observation()
    Object.assign(before.publication, { state: 'open', merged: false, merge_sha: null })
    Object.assign(before.pull!, { state: 'open', merged: false, mergeSha: null, mergedAt: null,
      approved: true, ready: true, checksState: 'SUCCESS', reviewIds: [99],
      reviewReceipts: [{ id: 99, head: before.pull!.head, state: 'APPROVED', invocation: null }] })
    const retained = completedReviewCall(chain.repository, 17, before.pull!.head, chain.reviewer)
    const retainedAction = mode === 'capacity waiting' ? 'requested_changes' : 'reviewed_clean'
    chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'retained-review', behavior: 'review-pr',
      actor: chain.reviewer, model: retained.model, slot: reviewer.slot,
      basis: chainBasis(['pr', before.pull!.head, before.pull!.reviewContext]), admittedAt: Date.parse(retained.started_at),
      request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
    chain = record(journal, chain, { type: 'invocation.settled', invocationId: 'retained-review', callId: retained.id,
      outcome: mode === 'capacity waiting' ? 'changes_requested' : 'clean',
      evidence: { status: 'completed', action: retainedAction, review_id: retained.review_id, head_sha: retained.head_sha,
        artifact: retained.artifact, completedAt: NOW, resources_settled_at: retained.completed_at,
        resource_ownership: { version: 1, roots: [], errors: [] } } })
    before.pull!.reviewIds.push(91)
    before.pull!.reviewReceipts.push({ id: 91, head: before.pull!.head,
      state: mode === 'capacity waiting' ? 'CHANGES_REQUESTED' : 'COMMENTED', invocation: retained.id,
      response: retained.artifact!.review_response, submittedAt: NOW })
    if (mode === 'capacity waiting') {
      before.pull!.head = before.publication.head_sha = 'd'.repeat(40)
      before.pull!.reviewReceipts[0].head = before.pull!.head
    } else before.prReviewers.push({ ...reviewer, slot: 'secondary' })
    chain = record(journal, chain, { type: 'chain.observed', observation: structuredClone(before) })
    const call: LogEntry = { ...completedReviewCall(chain.repository, 17, before.pull!.head, chain.reviewer),
      id: 'e'.repeat(32), source: 'poise:behavior-chain', correlation_id: 'running-review', review_id: 92,
      resource_ownership: { version: 1, roots: [], errors: [] } }
    call.artifact!.review_response = { ...(call.artifact!.review_response as Record<string, unknown>), invocation_id: call.id }
    const completed = structuredClone(call)
    Object.assign(call, { status: 'running', action: null, outcome: null, review_id: null, head_sha: null, completed_at: null, artifact: null })
    if (mode !== 'capacity waiting') {
      chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: call.correlation_id!, behavior: 'review-pr',
        actor: chain.reviewer, model: call.model, slot: 'secondary', basis: chainBasis(['pr', before.pull!.head, before.pull!.reviewContext]),
        admittedAt: Date.parse(call.started_at), request: { command: 'agent-interface', cwd: '/fixture',
          argv: ['--pr-review', 'https://github.com/acme/repo/pull/17', '--expected-head', before.pull!.head] } } })
      chain = record(journal, chain, { type: 'invocation.started', invocationId: call.correlation_id! })
    } else chain = record(journal, chain, { type: 'chain.waiting', reason: 'waiting for shared invocation capacity' })
    const original = structuredClone(chain.invocations)
    const queued = structuredClone(before)
    queued.pull!.queueEntry = 'external-queue-entry'
    const observe = vi.fn(async () => ({ ...structuredClone(queued), checkedAt: Date.now() }))
    const launch = vi.fn(async () => true)
    const runtime = new BehaviorChainRuntime(journal, operations({ observe, launch, enabled: () => true,
      available: () => mode !== 'capacity waiting', permitted: () => true,
      readInvocations: async () => ({ entries: mode === 'capacity waiting' ? [] : [call], quarantined: [] }) }))
    if (mode !== 'capacity waiting') {
      vi.setSystemTime(NOW + 119_999)
      await runtime.run()
      expect(observe).not.toHaveBeenCalled()
      vi.setSystemTime(NOW + 120_000)
    }
    await runtime.run()
    expect(observe).toHaveBeenCalledTimes(1)
    const attention = behaviorChainAttention(journal, Date.now())
    expect(attention).toHaveLength(1)
    expect(attention[0].ageMs).toBe(0)
    expect(attention[0].blocker).toContain('Queue admission conflicts with required retained Poise review evidence')
    expect(attention[0].evidence.gates).toContain('Current-head approval observed')
    expect(attention[0].nextAction).toContain(`PR acme/repo#17 head ${queued.pull!.head}, queue entry external-queue-entry`)
    expect(attention[0].nextAction).toContain('remove it from the merge queue and disable auto-merge if enabled')
    expect(journal.read(chain.id)).toMatchObject({ held: null, mergeSha: null, invocations: original })
    for (const time of [Date.now() - 1, Date.now() + 120_001]) expect(behaviorChainAttention(journal, time)).toEqual([])
    if (mode !== 'capacity waiting') {
      await runtime.run()
      expect(observe).toHaveBeenCalledTimes(1)
      expect(journal.read(chain.id)!.invocations).toEqual(original)
    }
    queued.pull!.queueEntry = null
    vi.setSystemTime(Date.now() + 120_000)
    await runtime.run()
    expect(behaviorChainAttention(journal, Date.now())).toEqual([])
    expect(journal.read(chain.id)!.invocations).toEqual(original)
    queued.pull!.queueEntry = 'external-queue-entry'
    vi.setSystemTime(Date.now() + 120_000)
    await runtime.run()
    expect(behaviorChainAttention(journal, Date.now())).toHaveLength(1)
    if (mode !== 'capacity waiting') {
      Object.assign(call, completed, { completed_at: new Date().toISOString(), resources_settled_at: new Date().toISOString() })
      if (mode === 'changes requested') {
        call.action = 'requested_changes'; call.outcome = 'changes_requested'
        queued.pull!.changesRequested = true; queued.pull!.approved = false
      }
      queued.pull!.reviewIds.push(92)
      queued.pull!.reviewReceipts.push({ id: 92, head: queued.pull!.head,
        state: mode === 'changes requested' ? 'CHANGES_REQUESTED' : 'COMMENTED', invocation: call.id,
        response: call.artifact!.review_response, submittedAt: Date.now() })
      await runtime.run()
      expect(journal.read(chain.id)!.invocations.at(-1)).toMatchObject({ state: 'settled', callId: call.id })
      expect(behaviorChainAttention(journal, Date.now())).toHaveLength(mode === 'changes requested' ? 1 : 0)
    }
    expect(launch).not.toHaveBeenCalled()
  })

it.each(['missing review', 'changed head', 'changed context', 'missing response', 'missing reviewer', 'retained reviews'])(
  'observes held queue admission before merge through ordinary scheduling: %s', async mode => {
    const { db, journal } = setup()
    vi.setSystemTime(NOW - 3 * 86400_000)
    let chain = seed(journal)
    const before = observation()
    Object.assign(before.publication, { state: 'open', merged: false, merge_sha: null })
    Object.assign(before.pull!, { state: 'open', merged: false, mergeSha: null, mergedAt: null,
      approved: true, ready: true, checksState: 'SUCCESS', reviewIds: [99],
      reviewReceipts: [{ id: 99, head: before.pull!.head, state: 'APPROVED', invocation: null }] })
    before.prReviewers.push({ ...reviewer, slot: 'secondary' })
    for (const [index, slot] of before.prReviewers.entries()) {
      if ((mode === 'missing reviewer' || mode === 'missing review') && index === 1) break
      const call = completedReviewCall(chain.repository, 17, before.pull!.head, chain.reviewer)
      call.id = chainBasis(['retained-review', slot.slot]).slice(0, 32)
      const response = { ...(call.artifact!.review_response as Record<string, unknown>), invocation_id: call.id }
      const artifact = mode === 'missing response' && index === 1 ? {} : { review_response: response }
      chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: slot.slot, behavior: 'review-pr',
        actor: chain.reviewer, model: call.model, slot: slot.slot, basis: chainBasis(['pr', before.pull!.head, before.pull!.reviewContext]),
        admittedAt: Date.parse(call.started_at), request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
      chain = record(journal, chain, { type: 'invocation.settled', invocationId: slot.slot, callId: call.id,
        outcome: mode === 'missing review' ? 'preflight_failed' : 'clean', evidence: {
          status: mode === 'missing review' ? 'failed' : 'completed',
          action: mode === 'missing review' ? 'not_started' : 'reviewed_clean',
          review_id: 91 + index, head_sha: before.pull!.head, artifact, completedAt: Date.parse(call.completed_at!),
          resources_settled_at: call.completed_at, resource_ownership: { version: 1, roots: [], errors: [] } } })
      if (mode !== 'missing review') {
        before.pull!.reviewIds.push(91 + index)
        before.pull!.reviewReceipts.push({ id: 91 + index, head: before.pull!.head, state: 'COMMENTED', invocation: call.id,
          response, submittedAt: Date.now() })
      }
    }
    vi.setSystemTime(NOW)
    before.checkedAt = Date.now()
    chain = record(journal, chain, { type: 'chain.observed', observation: before })
    chain = record(journal, chain, { type: 'chain.held', reason: 'review hold requires an operator decision' })
    const original = structuredClone(chain)
    const history = journal.history(chain.id)
    const queued = structuredClone(before)
    queued.pull!.queueEntry = 'external-queue-entry'
    if (mode === 'changed head') {
      queued.pull!.head = queued.publication.head_sha = 'd'.repeat(40)
      queued.pull!.reviewReceipts[0].head = queued.pull!.head
      queued.pull!.reviewIds = [99]
    }
    if (mode === 'changed context') queued.pull!.reviewContext = 'e'.repeat(64)
    const observe = vi.fn(async () => ({ ...queued, checkedAt: Date.now() }))
    // Replacement rebuilds the existing reconciliation index from the same receipts.
    const restarted = new BehaviorChainJournal(db)
    restarted.rebuild()
    const runtime = new BehaviorChainRuntime(restarted, operations({ observe, enabled: () => true,
      available: () => true, permitted: () => true }))
    expect(restarted.reconciliationAt(restarted.read(chain.id)!)).toBe(NOW + 120_000)
    vi.setSystemTime(NOW + 119_999)
    await runtime.run()
    expect(observe).not.toHaveBeenCalled()
    vi.setSystemTime(NOW + 120_000)
    await runtime.run()
    expect(observe).toHaveBeenCalledTimes(1)
    const attention = behaviorChainAttention(restarted, Date.now())[0]
    expect(attention.evidence).toMatchObject({ state: 'fresh', gates: expect.arrayContaining([
      'Required CI passed', 'Current-head approval observed']) })
    if (mode === 'retained reviews') expect(attention.nextAction).toBe('Resolve the durable hold, then explicitly resume the chain')
    else {
      expect(attention.evidence.gates).toContain('Queue admission conflicts with required retained Poise review evidence')
      expect(attention.nextAction).toContain(`PR acme/repo#17 head ${queued.pull!.head}, queue entry external-queue-entry`)
      expect(attention.nextAction).toContain('remove it from the merge queue and disable auto-merge if enabled')
      expect(attention.nextAction).toContain('Resuming alone cannot stop GitHub merging')
    }
    for (const time of [Date.now() - 1, Date.now() + 120_001]) {
      const unverified = behaviorChainAttention(restarted, time)[0]
      expect(unverified.evidence.state).not.toBe('fresh')
      expect(unverified.nextAction).not.toContain('remove it from the merge queue')
      expect(unverified.evidence.gates).not.toContain('Queue admission conflicts with required retained Poise review evidence')
    }
    expect(restarted.read(chain.id)).toMatchObject({ held: original.held, mergeSha: null,
      resumedAfterSequence: original.resumedAfterSequence, invocations: original.invocations })
    expect(restarted.history(chain.id).slice(0, history.length)).toEqual(history)
    vi.setSystemTime(NOW + 240_000)
    Object.assign(queued.pull!, { state: 'closed', merged: true, mergeSha: MERGE, mergedAt: Date.now() - 1, queueEntry: null })
    Object.assign(queued.publication, { state: 'closed', merged: true, merge_sha: MERGE })
    await runtime.run()
    expect(observe).toHaveBeenCalledTimes(2)
    expect(restarted.read(chain.id)).toMatchObject({ held: original.held, mergeSha: MERGE,
      reviewPending: mode !== 'retained reviews', invocations: original.invocations })
  })

it('records an external merge after exhausted repairs without retrying or erasing their no-publication receipts', async () => {
  const { journal } = setup()
  vi.setSystemTime(NOW - 180_000)
  let chain = seed(journal)
  const before = observation()
  Object.assign(before.publication, { head_sha: 'd'.repeat(40), state: 'open', merged: false, merge_sha: null })
  Object.assign(before.pull!, { head: 'd'.repeat(40), state: 'open', merged: false, mergeSha: null, mergedAt: null,
    changesRequested: true, reviewRevision: 'original-findings' })
  chain = record(journal, chain, { type: 'chain.observed', observation: before })
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = `failed-repair-${attempt}`
    chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: 'repair-pr',
      actor: chain.author, model: reviewer.model, slot: reviewer.slot,
      basis: chainBasis(['repair', before.pull!.head, before.pull!.reviewRevision]), admittedAt: Date.now(),
      request: { command: 'agent-interface', cwd: '/fixture', argv: [],
        context: { head: before.pull!.head, reviewRevision: before.pull!.reviewRevision } } } })
    chain = record(journal, chain, { type: 'invocation.settled', invocationId: id, callId: chainBasis(id).slice(0, 32),
      outcome: 'atomic_work_execution_budget_exhausted', evidence: { status: 'failed', action: 'not_started',
        outcome: 'preflight_failed', error_code: 'atomic_work_execution_budget_exhausted', artifact: { phase: 'executing' },
        resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  }
  const reason = 'repair-pr failed before publication three times: execution budget exhausted'
  chain = record(journal, chain, { type: 'chain.held', reason })
  const failures = structuredClone(chain.invocations)
  const history = journal.history(chain.id)
  vi.setSystemTime(NOW)
  const merged = observation()
  merged.pull!.approved = true
  const native = operations({ enabled: () => true, available: () => true, permitted: () => true, observe: async () => merged })
  await new BehaviorChainRuntime(journal, native).run()
  const reconciled = journal.read(chain.id)!
  expect(reconciled).toMatchObject({ mergeSha: MERGE, reviewPending: true, held: reason,
    resumedAfterSequence: chain.resumedAfterSequence })
  expect(reconciled.invocations).toEqual(failures)
  expect(journal.history(chain.id).slice(0, history.length)).toEqual(history)
  journal.rebuild()
  expect(journal.read(chain.id)).toEqual(reconciled)
  await new BehaviorChainRuntime(journal, native).run()
  expect(journal.read(chain.id)).toEqual(reconciled)
})

it('retains the redacted observation cause and rechecks without launching work', async () => {
  const { journal } = setup()
  seed(journal)
  vi.stubEnv('GH_TOKEN', 'observation-private-credential')
  const error = Object.assign(new Error('Command failed (1): github-interface'), {
    stderr: 'error: GitHub 500: observation-private-credential upstream unavailable', stdout: 'private-output',
  })
  const observe = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(observation(false))
  const runtime = new BehaviorChainRuntime(journal, operations({ observe }))
  try {
    await expect(runtime.run()).rejects.toThrow(
      'behavior observation failed for acme/repo#7: Command failed (1): github-interface: error: GitHub 500: [redacted] upstream unavailable')
    await runtime.run()
    expect(observe).toHaveBeenCalledTimes(2)
  } finally { vi.unstubAllEnvs() }
})

it('prefers an access failure over an earlier transient observation failure in the same sweep', async () => {
  const { journal } = setup()
  seed(journal)
  seed(journal, 'acme/repo', 8)
  const transient = new Error('Command failed (1): github-interface: error: GitHub 500: Internal Server Error')
  const access = new Error('Command failed (1): github-interface: error: GitHub 403: Resource not accessible')
  const observe = vi.fn().mockRejectedValueOnce(transient).mockRejectedValueOnce(access)
  const runtime = new BehaviorChainRuntime(journal, operations({ observe }))
  await expect(runtime.run()).rejects.toThrow(
    'behavior observation failed for acme/repo#8: Command failed (1): github-interface: error: GitHub 403: Resource not accessible')
  expect(observe).toHaveBeenCalledTimes(2)
})

it('holds a receiptless started invocation for reconciliation without fencing when an earlier chain failed transiently', async () => {
  const { journal } = setup()
  seed(journal)
  let fenced = seed(journal, 'acme/repo', 8)
  fenced = record(journal, fenced, { type: 'invocation.admitted', invocation: { id: 'fence-1', behavior: 'repair-pr',
    basis: 'basis', actor: 'author', model: 'fixture', slot: 'primary', admittedAt: NOW - 60_000,
    request: { command: 'agent-interface', cwd: '/isolated', argv: ['--atomic-work', 'acme/repo#8', '--model', 'fixture'] } } })
  record(journal, fenced, { type: 'invocation.started', invocationId: 'fence-1' })
  const transient = new Error('Command failed (1): github-interface: error: GitHub 500: Internal Server Error')
  const observe = vi.fn(async (chain: BehaviorChain) => {
    if (chain.id === 'acme/repo#7') throw transient
    return observation(true)
  })
  const fenceClosedTarget = vi.fn(async () => { throw new Error('native receipt store unavailable') })
  const runtime = new BehaviorChainRuntime(journal, operations({ observe, fenceClosedTarget }))
  // Reconciliation marks the receiptless invocation uncertain before the
  // closed-target fence, so the transient observation error is the only
  // recorded cause and the chain holds for read-only reconciliation.
  await expect(runtime.run()).rejects.toThrow('behavior observation failed for acme/repo#7')
  expect(fenceClosedTarget).not.toHaveBeenCalled()
  expect(journal.read('acme/repo#8')).toMatchObject({ held: expect.stringContaining('read-only reconciliation'),
    invocations: [{ id: 'fence-1', state: 'uncertain' }] })
})

it('reconciles live work on every pass despite 250 quiescent merged chains and one failing observation', async () => {
  const { db, journal } = setup()
  db.transaction(() => {
    for (let issue = 1; issue <= 250; issue++) {
      let chain = seed(journal, 'aaa/repo', issue)
      chain = record(journal, chain, { type: 'chain.observed', observation: observation() })
      chain = record(journal, chain, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository,
        pull_number: 17, merged: true, merge_sha: MERGE, review_complete: false } })
      record(journal, chain, { type: 'chain.held', reason: 'qualifying original review response missing' })
    }
  })()
  const live = seed(journal, 'zzz/repo', 1)
  const observed: string[] = []
  const runtime = new BehaviorChainRuntime(journal, operations({ observe: async (chain) => {
    observed.push(chain.id)
    if (chain.id === 'aaa/repo#1') throw new Error('retained source failure')
    return observation(chain.id !== live.id)
  } }))
  for (let pass = 0; pass < 3; pass++) {
    observed.length = 0
    await runtime.run()
    expect(observed).toEqual([live.id])
  }
  vi.setSystemTime(NOW + 120_000)
  await expect(runtime.run()).rejects.toThrow('retained source failure')
  expect(observed).toContain(live.id)
})

it('keeps merged journal-only uncertainty without repeatedly reading GitHub or sending another action', async () => {
  const { journal } = setup()
  let chain = seed(journal)
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'original-action', behavior: 'merge-pr',
    actor: 'reviewer', model: null, slot: null, basis: 'merge', admittedAt: NOW - 5000,
    request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', '17', '--expected-head', 'a'.repeat(40), '--token-user', 'reviewer'] } } })
  chain = record(journal, chain, { type: 'invocation.uncertain', invocationId: 'original-action', reason: 'original response absent' })
  chain = record(journal, chain, { type: 'chain.observed', observation: observation() })
  chain = record(journal, chain, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository,
    pull_number: 17, merged: true, merge_sha: MERGE, review_complete: false } })
  const before = journal.history(chain.id)
  const observe = vi.fn(async () => observation())
  for (let pass = 0; pass < 5; pass++) await new BehaviorChainRuntime(journal, operations({ observe })).run()
  expect(observe).not.toHaveBeenCalled()
  expect(journal.history(chain.id)).toEqual(before)
  expect(journal.read(chain.id)?.invocations[0].state).toBe('uncertain')
  const proof = nativeActionReceipt(chain, chain.invocations[0], { action: 'merge_if_ready', repository: chain.repository,
    pull_number: 17, head_sha: 'a'.repeat(40), outcome: 'merged', merge_sha: MERGE, merge_method: 'merge' })
  chain = record(journal, chain, { type: 'invocation.reconciled', invocationId: 'original-action', evidence: { nativeActionReceipt: proof } })
  await new BehaviorChainRuntime(journal, operations({ observe })).run()
  expect(journal.read(chain.id)?.invocations[0]).toMatchObject({ state: 'settled', outcome: 'merged' })
  expect(observe).not.toHaveBeenCalled()
})

it('reopens an old duplicated history without an observation burst, ownership change or rewritten authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'poise-reconciliation-')); roots.push(root)
  const path = join(root, 'journal.db')
  const { db, journal } = setup(path)
  let chain = seed(journal)
  chain = record(journal, chain, { type: 'chain.observed', observation: observation() })
  chain = record(journal, chain, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository,
    pull_number: 17, merged: true, merge_sha: MERGE, review_complete: false } })
  chain = record(journal, chain, { type: 'chain.held', reason: 'original review evidence missing' })
  for (let repeat = 0; repeat < 5; repeat++) {
    chain = record(journal, chain, { type: 'chain.observed', observation: observation() })
    chain = record(journal, chain, { type: 'chain.held', reason: 'original review evidence missing' })
  }
  const before = db.prepare('SELECT sequence, payload, state_hash FROM behavior_chain_events ORDER BY sequence').all()
  expect(before).toHaveLength(14)
  const next = journal.reconciliationAt(chain)
  db.close(); databases.splice(databases.indexOf(db), 1)
  const reopened = new Database(path); databases.push(reopened)
  const retained = new BehaviorChainJournal(reopened)
  retained.rebuild()
  const observe = vi.fn(async () => observation())
  await new BehaviorChainRuntime(retained, operations({ observe })).run()
  expect(observe).not.toHaveBeenCalled()
  expect(retained.reconciliationAt(retained.read(chain.id)!)).toBe(next)
  expect(retained.forPull(chain.repository, 17)?.id).toBe(chain.id)
  expect(retained.active().map((row) => row.id)).toContain(chain.id)
  expect(reopened.prepare('SELECT sequence, payload, state_hash FROM behavior_chain_events ORDER BY sequence').all()).toEqual(before)
})

it.each([false, true])('rechecks late original review visibility within the bound and rejects a post-merge submission: %s', async (lateSubmission) => {
  const { journal } = setup()
  let chain = seed(journal)
  const call = completedReviewCall(chain.repository, 17, 'a'.repeat(40), chain.reviewer)
  const before = observation()
  Object.assign(before.pull!, { merged: false, state: 'open', mergeSha: null, mergedAt: null })
  Object.assign(before.publication, { merged: false, state: 'open', merge_sha: null })
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'review', behavior: 'review-pr', actor: chain.reviewer,
    model: call.model, slot: 'primary', basis: chainBasis(['pr', 'a'.repeat(40), 'b'.repeat(64)]), admittedAt: Date.parse(call.started_at),
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  chain = record(journal, chain, { type: 'invocation.settled', invocationId: 'review', callId: call.id, outcome: 'clean',
    evidence: { status: 'completed', action: 'reviewed_clean', review_id: call.review_id, head_sha: 'a'.repeat(40),
      completedAt: Date.parse(call.completed_at!), resources_settled_at: call.completed_at, artifact: call.artifact } })
  chain = record(journal, chain, { type: 'chain.observed', observation: before })
  vi.setSystemTime(NOW + 1000)
  let visible = false
  const observe = vi.fn(async () => {
    const live = observation()
    live.pull!.mergedAt = NOW + 500
    if (visible) {
      live.pull!.reviewIds = [call.review_id!]
      live.pull!.reviewReceipts = [{ id: call.review_id!, head: 'a'.repeat(40), state: 'COMMENTED', invocation: call.id,
        response: call.artifact!.review_response, submittedAt: lateSubmission ? NOW + 501 : NOW }]
    }
    return live
  })
  const runtime = new BehaviorChainRuntime(journal, operations({ observe }))
  await runtime.run()
  expect(journal.read(chain.id)?.reviewPending).toBe(true)
  visible = true
  vi.setSystemTime(NOW + 121_000)
  await runtime.run()
  expect(observe).toHaveBeenCalledTimes(2)
  expect(journal.read(chain.id)).toMatchObject({ mergeSha: MERGE, reviewPending: lateSubmission })
})

it.each([false, true])('does not defer original model/resource settlement, with an original Call initially present: %s', async (present) => {
  const { journal } = setup()
  let chain = seed(journal)
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'original-model', behavior: 'review-pr',
    actor: 'reviewer', model: 'fixture', slot: 'primary', basis: 'review', admittedAt: NOW - 5000,
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--pr-review', 'https://github.com/acme/repo/pull/17',
      '--expected-head', 'a'.repeat(40)] } } })
  chain = record(journal, chain, { type: 'invocation.started', invocationId: 'original-model' })
  chain = record(journal, chain, { type: 'chain.observed', observation: observation() })
  chain = record(journal, chain, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository,
    pull_number: 17, merged: true, merge_sha: MERGE, review_complete: false } })
  const call = completedReviewCall(chain.repository, 17, 'a'.repeat(40), chain.reviewer)
  Object.assign(call, { source: 'poise:behavior-chain', correlation_id: 'original-model', status: 'running',
    action: null, outcome: null, completed_at: null, resources_settled_at: null, artifact: null, review_id: null,
    resource_ownership: { version: 1, roots: [], errors: [] } })
  let visible = present
  const readInvocations = vi.fn(async () => ({ entries: visible ? [structuredClone(call)] : [], quarantined: [] }))
  const observe = vi.fn(async () => observation())
  // A native fence sees the existing original even before this reader does.
  const runtime = new BehaviorChainRuntime(journal, operations({ readInvocations, observe, fenceClosedTarget: async () => false }))
  await runtime.run()
  vi.setSystemTime(NOW + 3 * 86400_000)
  await runtime.run()
  expect(readInvocations).toHaveBeenCalledTimes(2)
  expect(observe).not.toHaveBeenCalled()
  expect(journal.liveModelInvocationCount()).toBe(1)
  Object.assign(call, { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
    head_sha: null, artifact: { phase: 'reviewing' }, completed_at: new Date().toISOString(), resources_settled_at: new Date().toISOString() })
  visible = true
  await runtime.run()
  expect(readInvocations).toHaveBeenCalledTimes(3)
  expect(journal.read(chain.id)?.invocations[0].state).toBe('settled')
  expect(journal.liveModelInvocationCount()).toBe(0)
  expect(observe).toHaveBeenCalledTimes(1)
})
