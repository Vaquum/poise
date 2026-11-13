import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

// Alerts, the handled log and quota risk windows report what Poise observed;
// a producer that checks again records them again. They commit on the
// observation connection, which does not wait for the disk on the server's
// thread, never through the main connection's writes.
let root = ''
let database: typeof import('../server/db')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-observation-commits-'))
  process.env.POISE_DB = join(root, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
})

afterAll(async () => {
  if (database?.db.open) database.closeDatabase()
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

function mainWrites(run: () => void): string[] {
  const prepare = vi.spyOn(database.db, 'prepare')
  let prepared: string[] = []
  try {
    run()
  } finally {
    // Read before restoring: restoring a spy clears its calls.
    prepared = prepare.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim())
    prepare.mockRestore()
  }
  return prepared.filter((sql) => /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))
}

it('raises an alert and records a handled action without writing through the main connection', async () => {
  const { raiseAlert } = await import('../server/alerts/store')
  const { recordHandling } = await import('../server/alerts/handling')
  let raised: ReturnType<typeof raiseAlert> = null
  expect(mainWrites(() => {
    raised = raiseAlert({ kind: 'behavior_held', title: 'Held', body: 'A behavior held a target.', path: '/', dedupeKey: 'behavior-held:test:acme/repo#1' })
  })).toEqual([])
  expect(raised).not.toBeNull()
  // A duplicate of an unresolved alert is still refused.
  expect(raiseAlert({ kind: 'behavior_held', title: 'Held', body: 'Again.', path: '/', dedupeKey: 'behavior-held:test:acme/repo#1' })).toBeNull()
  expect(database.db.prepare("SELECT count(*) FROM alerts WHERE dedupe_key = 'behavior-held:test:acme/repo#1'").pluck().get()).toBe(1)

  const at = new Date().toISOString()
  expect(mainWrites(() => recordHandling({ kind: 'notice', source: 'behavior_held', title: 'Held', startedAt: at,
    finishedAt: at, outcome: 'resolved', error: null, actor: 'notices-service', ref: 'alert:test:resolved' }, at))).toEqual([])
  expect(database.db.prepare("SELECT count(*) FROM handling_log WHERE ref = 'alert:test:resolved'").pluck().get()).toBe(1)
})

it('keeps an alert raised inside a transaction with that transaction', async () => {
  const { raiseAlert } = await import('../server/alerts/store')
  expect(() => database.db.transaction(() => {
    raiseAlert({ kind: 'behavior_held', title: 'Held', body: 'Inside.', path: '/', dedupeKey: 'behavior-held:test:acme/repo#2' })
    throw new Error('rolled back')
  })()).toThrow('rolled back')
  expect(database.db.prepare("SELECT count(*) FROM alerts WHERE dedupe_key = 'behavior-held:test:acme/repo#2'").pluck().get()).toBe(0)
})
