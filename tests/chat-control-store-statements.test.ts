import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

// The control tick runs every second: its queries compile once per
// connection, not once per tick.
let root = ''
let database: typeof import('../server/db')
let store: typeof import('../server/chat/control-store')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-control-statements-'))
  process.env.POISE_DB = join(root, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
  await import('../server/chat/storage')
  store = await import('../server/chat/control-store')
})

afterAll(async () => {
  if (database?.db.open) database.closeDatabase()
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

it('runs a quiet control tick without compiling its statements again', () => {
  const instance = 'statements-instance'
  const tick = () => {
    const now = Date.now()
    store.sweepStaleTimers(instance, now)
    store.clampTimerClocks(instance, now)
    store.liveTimers(instance)
    store.watches(instance)
    store.timerPendingWaits(instance)
    store.pending(instance, '', now)
  }
  tick()
  const prepare = vi.spyOn(database.db, 'prepare')
  tick()
  tick()
  expect(prepare.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').slice(0, 60))).toEqual([])
  prepare.mockRestore()
})
