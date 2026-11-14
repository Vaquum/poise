import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BehaviorChainJournal, chainBasis, type ChainEvent, type ChainInvocation } from '../server/behavior-chain-store'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { nativeChainOperations } from '../server/behavior-chain-native'
import { behaviorChainSummary } from '../server/behavior-chain-summary'
import { setProcessFailureObserver } from '../server/process'
import type { Organization } from '../server/organizations'
import { historicalEvents, historicalJournals } from './fixtures/behavior-chain-journal'

const TARGET = 'historical/repo#7'
const opened: Database.Database[] = []
const directories: string[] = []
vi.mock('../server/models', () => ({ agentInterfaceCwd: () => process.cwd() }))
vi.mock('../server/settings', () => ({ getSettings: () => ({ me: 'author', agentAccount: 'reviewer' }),
  getBehaviorChainSettings: () => ({ enabled: true, seedMode: 'all', label: 'poise' }),
  BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY: 'behavior_chain_integrity_hold' }))
vi.mock('../server/organizations', () => ({ organizationForRepository: () => ({ login: 'historical' }),
  organizationArgs: (_org: unknown, argv: string[]) => argv }))
vi.mock('../server/datastore-health', () => ({ runDatastoreHealth: async () => {} }))
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  setProcessFailureObserver(null)
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function database(path = ':memory:') {
  const db = new Database(path)
  opened.push(db)
  return { db, journal: new BehaviorChainJournal(db) }
}

function retain(db: Database.Database, hashes: string[], events = historicalEvents) {
  const insert = db.prepare('INSERT INTO behavior_chain_events(sequence, chain_id, event_id, at, payload, state_hash) VALUES (?, ?, ?, ?, ?, ?)')
  for (let index = 0; index < hashes.length; index++) {
    insert.run(index + 1, TARGET, `historical-${index}`, 1_800_000_000_000 + index, JSON.stringify(events[index]), hashes[index])
  }
}

function authority(db: Database.Database) {
  return db.prepare('SELECT * FROM behavior_chain_events ORDER BY sequence').all()
}

it.each(['repair-pr', 'review-issue'] as const)('retains one missing-plan episode across replacement and validates %s recovery through real process observation', async behavior => {
  const root = mkdtempSync(join(tmpdir(), 'poise-missing-plan-')); directories.push(root)
  const statePath = join(root, 'transport.json'), callsPath = join(root, 'calls.jsonl')
  const callId = 'c'.repeat(32), head = 'a'.repeat(40)
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const plan = behavior === 'repair-pr'
    ? { publication: { title: 'Repair', body: 'Original plan', replies: [{ commentId: 17, body: 'Original answer' }] } }
    : { kind: 'issue_review', model: 'fixture', issue_revision: 'seed', posts: [{ issue: 'Historical/Repo#7', body: 'Original review' }] }
  const planSha = chainBasis(plan)
  const transport = (mode: string) => writeFileSync(statePath, JSON.stringify({ mode, plan, planSha, callId }))
  // Only the transport is a stand-in: runFile and its failure observer are real.
  const script = `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const args = process.argv.slice(2), op = args[0];
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (op === '--read-action-plan') {
  if (state.mode === 'missing' || state.mode === 'wrong-exit') {
    process.stderr.write('Traceback (most recent call last):\\nValueError: native call has no durable publication plan\\n');
    process.exit(state.mode === 'missing' ? 1 : 2);
  }
  if (state.mode === 'database' || state.mode === 'different-value-error') {
    process.stderr.write(state.mode === 'database' ? 'sqlite3.OperationalError: database is locked\\n'
      : 'ValueError: native call has no durable publication plan for a different reason\\n');
    process.exit(1);
  }
  if (state.mode === 'parse') { process.stdout.write('{'); process.exit(0); }
  output({ id: state.mode === 'identity' ? 'd'.repeat(32) : state.callId,
    sha: state.mode === 'digest' ? 'e'.repeat(64) : state.planSha,
    plan: state.mode === 'validation' ? [] : state.plan });
} else if (op === '--chain-seed') {
  const number = Number(args[1].slice(1));
  const pull = number === 7 && ${JSON.stringify(behavior === 'repair-pr')};
  output({ repository: 'Historical/Repo', issue_number: number, actor: 'author', branch: 'poise/issue-' + number,
    issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
    publication: { existing_pulls: [], pull_number: pull ? 21 : null, head_sha: pull ? ${JSON.stringify(head)} : null,
      base_sha: ${JSON.stringify(head)},
      prerequisites: { repo: 'Historical/Repo', number, found: true, complete: true, prerequisites: [] },
      head_invocation: pull ? state.callId : null, state: pull ? 'open' : null, merged: false, merge_sha: null } });
} else if (op === '--issue-work') output({ replies_complete: false });
else if (op === '--pull-action-state') output({ pull_number: 21, state: 'open', head_sha: ${JSON.stringify(head)},
  review_context: 'b'.repeat(64), merged: false, queue_entry_id: null, queue_removals: [], my_reviews: [] });
else if (op === '--pr-readiness') output({ head_sha: ${JSON.stringify(head)}, draft: false,
  reviewer_approved_current_head: false, unresolved_live_conversation_count: 1,
  unresolved_outdated_conversation_count: 0, green: false, blockers: ['unresolved_conversations'] });
else if (op === '--list-failing-ci') output({ pull_number: 21, head_sha: ${JSON.stringify(head)}, failing: [] });
else { process.stderr.write('Forbidden fixture operation: ' + op); process.exit(3); }
`
  for (const command of ['agent-interface', 'github-interface', 'github-datastore']) writeFileSync(join(root, command), script, { mode: 0o700 })
  vi.stubEnv('CALLER_BIN_ROOT', root)
  const path = join(root, 'journal.sqlite')
  let { db, journal } = database(path)
  let chain = journal.append(TARGET, 'seed', 0, { type: 'chain.admitted', repository: 'Historical/Repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  const append = (event: ChainEvent) => { chain = journal.append(TARGET, `event-${chain.sequence}`, chain.sequence, event) }
  append({ type: 'chain.observed', observation: { checkedAt: 1, issue: { open: true }, pull: { state: 'open' } } })
  append({ type: 'invocation.admitted', invocation: { id: 'original', behavior, basis: 'seed',
    actor: behavior === 'repair-pr' ? 'author' : 'reviewer', model: reviewer.model, slot: reviewer.slot, admittedAt: Date.now() - 5000,
    reservation: { memoryBytes: 6, diskBytes: 3 },
    request: { command: 'agent-interface', cwd: root, argv: ['--fixture'] } } })
  const originalEvidence = { callId, artifact: { plan_sha: planSha, replies_started: false, publication_head: head },
    status: 'failed', action: 'published', error: 'Original publication interrupted',
    resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } }
  append({ type: 'invocation.reconciled', invocationId: 'original', evidence: originalEvidence })
  append({ type: 'invocation.uncertain', invocationId: 'original', reason: 'Original publication remains uncertain' })
  append({ type: 'chain.held', reason: 'Person holds new invocations' })
  const original = structuredClone(chain)
  journal.append('historical/repo#8', 'unrelated-seed', 0, { type: 'chain.admitted', repository: 'Historical/Repo', issue: 8,
    branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' })
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('Missing evidence cannot authorize an effect') })
  const launch = vi.fn(async () => true)
  const operations: ChainRuntimeOperations = { ...nativeChainOperations({ login: 'historical' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: forbidden, prepare: forbidden, borrow: () => { throw new Error('No native worker') },
    available: () => true, capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2',
    received: () => {}, reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  }), discover: async () => [], readInvocations: async () => ({ entries: [], quarantined: [] }),
    request: async target => { expect(target.id).toBe('historical/repo#8'); return { command: 'agent-interface', cwd: root, argv: ['--model', 'fixture'] } },
    launch, perform: forbidden, resumePublication: forbidden, fenceClosedTarget: forbidden }
  const failures = vi.fn()
  setProcessFailureObserver(failures)
  transport('missing')
  let runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  const absent = journal.read(TARGET)!
  const condition = absent.invocations[0].evidence?.publicationPlan
  expect(condition).toEqual({ code: 'original_publication_plan_missing', callId, planSha, missingAt: expect.any(Number), recoveredAt: null })
  const missingHistory = journal.history(TARGET)
  await runtime.run()
  db.close()
  ;({ db, journal } = database(path))
  journal.rebuild()
  runtime = new BehaviorChainRuntime(journal, operations)
  await runtime.run()
  expect(journal.read(TARGET)).toEqual(absent)
  expect(journal.history(TARGET)).toEqual(missingHistory)
  expect(failures).not.toHaveBeenCalled()
  expect(launch).toHaveBeenCalledTimes(1)
  expect(journal.read('historical/repo#8')?.invocations[0]).toMatchObject({ state: 'uncertain',
    outcome: expect.stringContaining('without a durable Call receipt') })
  expect(behaviorChainSummary(absent).invocations[0].evidence?.publicationPlan).toEqual(condition)

  for (const [mode, message, observed] of [
    ['database', 'Command failed (1)', true], ['wrong-exit', 'Command failed (2)', true],
    ['different-value-error', 'Command failed (1)', true], ['parse', 'JSON', false],
    ['identity', 'differs from its durable receipt', false], ['digest', 'differs from its durable receipt', false],
    ['validation', 'invalid evidence', false],
  ] as const) {
    failures.mockClear(); transport(mode)
    const unrelatedSequence = journal.read('historical/repo#8')!.sequence
    await expect(runtime.run()).rejects.toThrow(message)
    expect(failures).toHaveBeenCalledTimes(observed ? 1 : 0)
    expect(journal.read(TARGET)).toEqual(absent)
    expect(journal.read('historical/repo#8')!.sequence).toBeGreaterThan(unrelatedSequence)
  }
  transport('valid')
  await runtime.run()
  const recovered = journal.read(TARGET)!
  expect(recovered.invocations[0]).toMatchObject({ state: 'uncertain', callId: null, outcome: original.invocations[0].outcome,
    evidence: { ...originalEvidence, publicationPlan: { ...condition, recoveredAt: expect.any(Number) } } })
  expect(recovered.held).toBe(original.held)
  expect(recovered.invocations).toHaveLength(1)
  expect(recovered.invocations[0].request).toEqual(original.invocations[0].request)
  expect(recovered.invocations[0].reservation).toEqual(original.invocations[0].reservation)
  expect(forbidden).not.toHaveBeenCalled()
  const conditions = journal.history(TARGET).map(row => JSON.parse(row.payload)).filter(event => event.evidence?.publicationPlan)
  expect(conditions).toHaveLength(2)
  expect(conditions.map(event => event.evidence.publicationPlan.recoveredAt)).toEqual([null, expect.any(Number)])
  const reads = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(reads.filter(args => args[0] === '--read-action-plan')).toHaveLength(11)
  expect(reads.filter(args => args[0] === '--issue-work').every(args => args.includes('inspect'))).toBe(true)
  journal.rebuild()
  expect(journal.read(TARGET)).toEqual(recovered)
})

it.each(['unchanged', 'findings', 'head', 'execution-budget'])('requires Resume after repair exhaustion and restarts once with %s inputs', async (changed) => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-repair-replay-'))
  directories.push(directory)
  const path = join(directory, 'journal.sqlite')
  const { db, journal } = database(path)
  const now = Date.now(), head = 'a'.repeat(40)
  const reviewer = { slot: 'primary', model: 'fixture-model', recovery: 'fixture-model' }
  const observation: ChainObservation = { checkedAt: now, existingPulls: [],
    issue: { open: true, eligible: true, revision: 'seed', commentIds: [] }, issueReviewers: [], prReviewers: [],
    implementer: reviewer, repairer: reviewer, approver: reviewer,
    publication: { pull_number: 21, head_sha: head, head_invocation: null, state: 'open', merged: false, merge_sha: null },
    pull: { number: 21, head, headSince: now, state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: true, unresolved: 1, unresolvedOutdated: 1, approved: false, ready: false,
      reviewIds: [], reviewRevision: 'findings-1', reviewReceipts: [], greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }
  let current = journal.append(TARGET, 'seed', 0, { type: 'chain.admitted', repository: 'Historical/Repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, now)
  function append(event: ChainEvent) {
    current = journal.append(TARGET, `event-${current.sequence}`, current.sequence, event, now)
  }
  const first = decideBehaviorChain(current, observation, now)
  if (first.kind !== 'invoke') throw new Error('expected initial repair')
  const exhausted = changed === 'execution-budget'
  const error = exhausted ? 'Atomic behavior provider exhausted its execution budget; no publication attempted'
    : 'repair did not answer every unresolved review finding: missing_root_comment_ids=[18]; missing_count=1; required_count=2'
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(decideBehaviorChain(current, observation, observation.checkedAt)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr', basis: first.basis })
    const id = `repair-${attempt}`
    append({ type: 'invocation.admitted', invocation: { id, behavior: 'repair-pr', basis: first.basis, actor: 'author',
      model: reviewer.model, slot: reviewer.slot, admittedAt: now,
      request: { command: 'agent-interface', argv: ['--atomic-work'], cwd: '/isolated' } } })
    const errorCode = exhausted ? 'atomic_work_execution_budget_exhausted' : 'atomic_work_failed'
    append({ type: 'invocation.settled', invocationId: id, callId: id, outcome: exhausted ? errorCode : 'preflight_failed',
      evidence: { status: 'failed', error_code: errorCode, action: 'not_started', outcome: 'preflight_failed', error,
        completedAt: observation.checkedAt, resources_settled_at: new Date(now).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
    if (attempt < 2) expect(decideBehaviorChain(current, observation, observation.checkedAt)).toMatchObject({ kind: 'wait', reason: expect.stringContaining('backoff') })
    observation.checkedAt += 120_000
  }
  const launches: ChainInvocation[] = []
  const unexpected = async () => { throw new Error('preflight failure cannot continue publication or perform a GitHub action') }
  const operations: ChainRuntimeOperations = {
    enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }), discover: async () => [], ownsRepository: () => true,
    observe: async () => ({ ...observation, checkedAt: Date.now() }), readInvocations: async () => ({ entries: [], quarantined: [] }),
    received: () => {}, available: () => true, capacity: () => 1, permitted: () => true,
    request: async (_chain, latest, decision) => {
      expect(decision).toMatchObject({ behavior: 'repair-pr' })
      expect(latest.pull).toMatchObject({ head: observation.pull!.head, reviewRevision: observation.pull!.reviewRevision })
      return { command: 'agent-interface', argv: ['--atomic-work', '--model', reviewer.model, '--expected-head', latest.pull!.head], cwd: '/isolated',
        context: { head: latest.pull!.head, reviewRevision: latest.pull!.reviewRevision } }
    },
    launch: async (invocation) => { launches.push(invocation); return true },
    perform: unexpected, readActionResult: unexpected, resumePublication: unexpected, fenceClosedTarget: unexpected, wake: () => {},
  }
  await new BehaviorChainRuntime(journal, operations).run()
  expect(journal.read(TARGET)!.held).toContain(`failed before publication three times: ${error}`)
  expect(launches).toHaveLength(0)
  db.close()
  const reopened = database(path)
  reopened.journal.verifyProjection()
  if (changed === 'findings') observation.pull!.reviewRevision = 'findings-2'
  if (changed === 'head') observation.pull!.head = 'b'.repeat(40)
  const runtime = new BehaviorChainRuntime(reopened.journal, operations)
  await runtime.run()
  current = reopened.journal.read(TARGET)!
  expect(current.held).toContain(error)
  expect(current.invocations).toHaveLength(3)
  expect(launches).toHaveLength(0)
  reopened.journal.append(TARGET, 'operator-resume', current.sequence, { type: 'chain.resumed' })
  await runtime.run()
  await runtime.run()
  expect(launches).toHaveLength(1)
  expect(reopened.journal.read(TARGET)!.invocations).toHaveLength(4)
  expect(launches[0].request.context).toEqual({ head: observation.pull!.head, reviewRevision: observation.pull!.reviewRevision })
  expect(launches[0].basis === first.basis).toBe(changed === 'unchanged' || exhausted)
})

describe.each(historicalJournals)('journal compatibility from $revision', ({ hashes, reservationPresent }) => {
  it('rebuilds and reopens the original immutable evidence without changing hashes or ownership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'poise-journal-replay-'))
    directories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const { db, journal } = database(path)
    retain(db, hashes)
    const original = authority(db)
    journal.verifyProjection()
    const recovered = journal.read(TARGET)!
    expect(chainBasis(recovered)).toBe(hashes.at(-1))
    expect(recovered.invocations[0]).toMatchObject({ id: 'historical-review', state: 'uncertain', outcome: 'publication response lost' })
    expect(Object.hasOwn(recovered.invocations[0], 'reservation')).toBe(reservationPresent)
    expect(authority(db)).toEqual(original)
    db.prepare('DELETE FROM behavior_chain_current').run()
    db.close()
    const reopened = database(path)
    reopened.journal.verifyProjection()
    expect(reopened.journal.read(TARGET)).toEqual(recovered)
    expect(authority(reopened.db)).toEqual(original)
    expect(() => reopened.db.prepare('DELETE FROM behavior_chain_events').run()).toThrow('immutable')
  })

  it('retains unknown reservations until resource proof and supports mixed new admissions through another rebuild', () => {
    const { db, journal } = database()
    retain(db, hashes.slice(0, 4))
    journal.rebuild()
    expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 1 })
    const other = journal.append('historical/repo#8', 'new-chain', 0, { type: 'chain.admitted', repository: 'Historical/Repo', issue: 8,
      branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' })
    const invocation = { id: 'new-review', behavior: 'review-issue' as const, basis: 'revision-2', actor: 'reviewer', model: 'fixture-model',
      slot: 'primary', admittedAt: 1_800_000_000_100, request: { command: 'agent-interface' as const, argv: [], cwd: '/isolated' },
      reservation: { memoryBytes: 6, diskBytes: 3 } }
    const budget = { memoryBytes: 10, diskBytes: 10 }
    expect(journal.admitInvocation(other, 'new-admission', invocation, 2, budget)).toBeNull()
    const recovered = journal.read(TARGET)!
    journal.append(TARGET, 'verified-resource-release', recovered.sequence, historicalEvents[4])
    expect(journal.admitInvocation(other, 'new-admission', invocation, 2, budget)).toBeNull()
    const pending = journal.read(TARGET)!
    journal.append(TARGET, 'current-resource-ownership-proof', pending.sequence, { type: 'invocation.reconciled',
      invocationId: pending.invocations[0].id, evidence: { resource_ownership: { version: 1, roots: [], errors: [] } } })
    const admitted = journal.admitInvocation(other, 'new-admission', invocation, 2, budget)!
    expect(admitted.invocations[0].reservation).toEqual(invocation.reservation)
    journal.rebuild()
    expect(journal.read(TARGET)!.invocations[0].state).toBe('uncertain')
    expect(journal.read(other.id)).toEqual(admitted)
    expect(journal.reservedResources()).toEqual({ memoryBytes: 6, diskBytes: 3, unaccounted: 0 })
  })

  it.each(['actor', 'basis', 'request'] as const)('rejects altered %s evidence and rolls projection rebuilding back', (field) => {
    const { db, journal } = database()
    const events = structuredClone(historicalEvents)
    const event = events[1]
    if (event.type !== 'invocation.admitted') throw new Error('fixture admission missing')
    if (field === 'request') event.invocation.request.argv.push('--altered')
    else event.invocation[field] = 'altered'
    retain(db, hashes, events)
    const existing = journal.append('historical/repo#8', 'unrelated-chain', 0, { type: 'chain.admitted', repository: 'Historical/Repo',
      issue: 8, branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' })
    const original = authority(db)
    expect(() => journal.rebuild()).toThrow('state hash is invalid')
    expect(journal.read(existing.id)).toEqual(existing)
    expect(authority(db)).toEqual(original)
    expect(db.prepare('SELECT count(*) AS count FROM behavior_chain_current WHERE chain_id = ?').get(TARGET)).toEqual({ count: 0 })
  })
})

it('never removes an explicitly recorded reservation to satisfy an older hash', () => {
  const { db, journal } = database()
  const events = structuredClone(historicalEvents)
  const event = events[1]
  if (event.type !== 'invocation.admitted') throw new Error('fixture admission missing')
  event.invocation.reservation = null
  retain(db, historicalJournals[0].hashes, events)
  const original = authority(db)
  expect(() => journal.rebuild()).toThrow('state hash is invalid')
  expect(authority(db)).toEqual(original)
  expect(db.prepare('SELECT count(*) AS count FROM behavior_chain_current').get()).toEqual({ count: 0 })
})
