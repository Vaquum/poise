import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

// The switchboard and content jobs answer every Overview load, every open
// tab's minute and the job poller with constant statements: they compile once
// per connection, not on each read.
let root = ''
let database: typeof import('../server/db')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-hot-statements-'))
  process.env.POISE_DB = join(root, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
  await import('../server/chat/storage')
})

afterAll(async () => {
  if (database?.db.open) database.closeDatabase()
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

function compiled(run: () => void): string[] {
  const prepare = vi.spyOn(database.db, 'prepare')
  let sql: string[] = []
  try {
    run()
  } finally {
    // Read before restoring: restoring a spy clears its calls.
    sql = prepare.mock.calls.map(([text]) => String(text).replace(/\s+/g, ' ').trim().slice(0, 60))
    prepare.mockRestore()
  }
  return sql
}

it('reads the switchboard again without compiling its statements', async () => {
  const store = await import('../server/chat/switchboard-store')
  const read = () => {
    store.board('statements-instance')
    store.items('statements-instance')
    store.cursors('statements-instance')
    store.lastCommitted('statements-instance')
    store.openDecisions('statements-instance')
    store.pendingExplanations('statements-instance')
  }
  read()
  expect(compiled(read)).toEqual([])
})
