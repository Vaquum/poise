import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BehaviorChainJournal, chainBasis } from '../server/behavior-chain-store'
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
