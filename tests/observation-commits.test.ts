import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

// The handled log and quota risk windows report what Poise observed; a
// producer that checks again records them again. They commit on the
// observation connection, which does not wait for the disk on the server's
// thread. Alerts do not: Link remembers delivered alert ids, which a power cut
// must never roll back for a later alert to reuse.
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

it('records a handled action without writing through the main connection', async () => {
  const { recordHandling } = await import('../server/alerts/handling')
  const at = new Date().toISOString()
  expect(mainWrites(() => recordHandling({ kind: 'notice', source: 'behavior_held', title: 'Held', startedAt: at,
    finishedAt: at, outcome: 'resolved', error: null, actor: 'notices-service', ref: 'alert:test:resolved' }, at))).toEqual([])
  expect(database.db.prepare("SELECT count(*) FROM handling_log WHERE ref = 'alert:test:resolved'").pluck().get()).toBe(1)
  // Recording the same ref again keeps one row.
  recordHandling({ kind: 'notice', source: 'behavior_held', title: 'Held', startedAt: at,
    finishedAt: at, outcome: 'resolved', error: null, actor: 'notices-service', ref: 'alert:test:resolved' }, at)
  expect(database.db.prepare("SELECT count(*) FROM handling_log WHERE ref = 'alert:test:resolved'").pluck().get()).toBe(1)
})

it('keeps raising alerts on the main connection, whose commits survive a power cut', async () => {
  const { raiseAlert } = await import('../server/alerts/store')
  expect(mainWrites(() => {
    raiseAlert({ kind: 'behavior_held', title: 'Held', body: 'A behavior held a target.', path: '/', dedupeKey: 'behavior-held:test:acme/repo#1' })
  }).some((sql) => sql.startsWith('INSERT INTO alerts'))).toBe(true)
})

it('keeps a handled action recorded inside a transaction with that transaction', async () => {
  const { recordHandling } = await import('../server/alerts/handling')
  const at = new Date().toISOString()
  expect(() => database.db.transaction(() => {
    recordHandling({ kind: 'notice', source: 'behavior_held', title: 'Held', startedAt: at,
      finishedAt: at, outcome: 'resolved', error: null, actor: 'notices-service', ref: 'alert:test:rolled-back' }, at)
    throw new Error('rolled back')
  })()).toThrow('rolled back')
  expect(database.db.prepare("SELECT count(*) FROM handling_log WHERE ref = 'alert:test:rolled-back'").pluck().get()).toBe(0)
})
