import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { BehaviorChainJournal, chainBasis, type BehaviorChain, type ChainEvent } from '../server/behavior-chain-store'
import type { ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { nativeActionReceipt } from '../server/behavior-chain-action'
import { completedReviewCall } from './review-response-fixture'
import { parseAgentLogStdout, type LogEntry } from '../server/agent-log-parse'

const NOW = 1_800_000_000_000
const MERGE = 'c'.repeat(40)
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
const databases: Database.Database[] = []
const roots: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
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

it.each(['recovery', 'operator hold', 'uncertain publication', 'ambiguous cause', 'missing failure identity'])(
  'rechecks a CI-only repair hold without duplicate work: %s', async mode => {
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
        cwd: '/fixture', context: { head: obs.pull!.head, reviewRevision: obs.pull!.reviewRevision } } } })
    const ci = { action: 'list_failing_ci', repository: chain.repository, pull_number: 17, head_sha: obs.pull!.head,
      failing: [{ type: 'check_run', name: 'unit', state: 'completed', conclusion: 'failure', check_run_id: 41,
        log_id: mode === 'missing failure identity' ? 0 : 42, url: 'https://github.com/acme/repo/actions/runs/40/job/42' },
      { type: 'check_run', name: 'build', state: 'in_progress', conclusion: null, check_run_id: 43, log_id: 44,
        url: 'https://github.com/acme/repo/actions/runs/40/job/44' }] }
    const call: LogEntry = { ...completedReviewCall(chain.repository, 17, obs.pull!.head, chain.author), id: 'a'.repeat(32),
      behavior: 'repair_pr', source: 'poise:behavior-chain', correlation_id: id, status: 'failed',
      action: 'not_started', outcome: 'preflight_failed', head_sha: null, review_id: null,
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
    expect(journal.read(chain.id)!.held).toBe(call.error)
    expect(observe).not.toHaveBeenCalled()
    await runtime.run()
    expect(launch).not.toHaveBeenCalled()
    if (mode === 'uncertain publication') {
      call.action = null
      call.artifact = { ...call.artifact, phase: 'publishing', plan_sha: 'd'.repeat(64) }
    }
    vi.setSystemTime(NOW + 5000)
    call.resources_settled_at = new Date().toISOString()
    await runtime.run()
    chain = journal.read(chain.id)!
    expect(chain.held).toBe(call.error)
    expect(chain.invocations[0].state).toBe(mode === 'uncertain publication' ? 'uncertain' : 'settled')
    const failedReceipt = structuredClone(chain.invocations[0])
    if (mode === 'operator hold') chain = record(journal, chain, { type: 'chain.held', reason: call.error })
    const history = journal.history(chain.id)
    journal.rebuild()
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
        expect(journal.read(chain.id)!.held).toBe(call.error)
        expect(launch).not.toHaveBeenCalled()
        expect(journal.reconciliationAt(journal.read(chain.id)!)).toBe(Date.now() + 120_000)
      }
      Object.assign(obs.pull!, { checksState: 'SUCCESS', head: ci.head_sha, pending: false, failing: [] })
      for (const offset of [-120_001, 1]) {
        vi.setSystemTime(Date.now() + 120_000)
        observe.mockImplementationOnce(async () => ({ ...structuredClone(obs), checkedAt: Date.now() + offset }))
        await runtime.run()
        expect(journal.read(chain.id)!.held).toBe(call.error)
      }
      vi.setSystemTime(Date.now() + 120_001)
      observe.mockRejectedValueOnce(new Error('CI evidence unavailable'))
      await expect(runtime.run()).rejects.toThrow('CI evidence unavailable')
      expect(journal.read(chain.id)!.held).toBe(call.error)
    }
    Object.assign(obs.pull!, { checksState: 'SUCCESS', head: ci.head_sha, pending: false, failing: [] })
    if (mode === 'recovery') obs.issue.open = false
    vi.setSystemTime(Date.now() + 86_400_000)
    await runtime.run()
    chain = journal.read(chain.id)!
    if (mode !== 'recovery') {
      expect(chain.held).toBe(call.error)
      expect(chain.invocations).toHaveLength(1)
      expect(launch).not.toHaveBeenCalled()
      return
    }
    expect(chain.held).toBeNull()
    expect(chain.ciHold).toBeUndefined()
    expect(chain.resumedAfterSequence).toBe(0)
    expect(chain.invocations[0]).toEqual(failedReceipt)
    expect(chain.invocations.at(-1)!.behavior).toBe('approve-pr')
    expect(launch).toHaveBeenCalledTimes(1)
    const recovery = journal.history(chain.id).map(row => JSON.parse(row.payload)).filter(event => event.ciRecovery)
    expect(recovery).toEqual([{ type: 'chain.resumed', ciRecovery: { invocationId: id, callId: call.id, head: ci.head_sha } }])
    journal.rebuild()
    runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), native)
    for (let tick = 0; tick < 3; tick++) await runtime.run()
    expect(launch).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 2000)
    const approval: LogEntry = { ...completedReviewCall(chain.repository, 17, ci.head_sha, chain.reviewer),
      correlation_id: chain.invocations.at(-1)!.id, source: 'poise:behavior-chain', behavior: 'pr_approve',
      action: 'approved', outcome: 'approved', resources_settled_at: new Date().toISOString(),
      resource_ownership: { version: 1, roots: [], errors: [] } }
    calls.push(approval)
    Object.assign(obs.pull!, { approved: true, reviewIds: [approval.review_id!],
      reviewReceipts: [{ id: approval.review_id!, head: ci.head_sha, state: 'APPROVED', invocation: approval.id,
        response: approval.artifact!.review_response, submittedAt: Date.now() }] })
    await runtime.run()
    expect(journal.read(chain.id)!.invocations.at(-1)).toMatchObject({ state: 'settled', outcome: 'approved' })
    expect(journal.read(chain.id)!.waiting).toBe('native repository readiness gates are not satisfied')
    expect(journal.read(chain.id)!.invocations[0]).toEqual(failedReceipt)
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
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
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
    completed_at: new Date().toISOString(), resources_settled_at: new Date().toISOString() })
  visible = true
  await runtime.run()
  expect(readInvocations).toHaveBeenCalledTimes(3)
  expect(journal.read(chain.id)?.invocations[0].state).toBe('settled')
  expect(journal.liveModelInvocationCount()).toBe(0)
  expect(observe).toHaveBeenCalledTimes(1)
})
