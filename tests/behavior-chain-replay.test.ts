import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BehaviorChainJournal, chainBasis, type ChainEvent, type ChainInvocation } from '../server/behavior-chain-store'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { historicalEvents, historicalJournals } from './fixtures/behavior-chain-journal'

const TARGET = 'historical/repo#7'
const opened: Database.Database[] = []
const directories: string[] = []
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
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

it.each(['unchanged', 'findings', 'head'])('requires Resume after repair exhaustion and restarts once with %s inputs', async (changed) => {
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
  const error = 'repair did not answer every unresolved review finding: missing_root_comment_ids=[18]; missing_count=1; required_count=2'
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(decideBehaviorChain(current, observation, observation.checkedAt)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr', basis: first.basis })
    const id = `repair-${attempt}`
    append({ type: 'invocation.admitted', invocation: { id, behavior: 'repair-pr', basis: first.basis, actor: 'author',
      model: reviewer.model, slot: reviewer.slot, admittedAt: now,
      request: { command: 'agent-interface', argv: ['--atomic-work'], cwd: '/isolated' } } })
    append({ type: 'invocation.settled', invocationId: id, callId: id, outcome: 'preflight_failed',
      evidence: { status: 'failed', error_code: 'atomic_work_failed', action: 'not_started', outcome: 'preflight_failed', error,
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
  expect(launches[0].basis === first.basis).toBe(changed === 'unchanged')
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
