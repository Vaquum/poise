import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { installStallObserver, maskSql, stallSnapshot } from '../server/stall-observer'

installStallObserver()

it('masks the values a statement carried, keeping what ran', () => {
  expect(maskSql(`SELECT * FROM prs WHERE repo = 'acme/site' AND number = 42\n  LIMIT 10`)).toBe('SELECT * FROM prs WHERE repo = ? AND number = ? LIMIT ?')
  expect(maskSql(`UPDATE meta SET value = 'it''s' WHERE key = 'me'`)).toBe('UPDATE meta SET value = ? WHERE key = ?')
  // Comments go, so an apostrophe in one never shifts what counts as a literal.
  expect(maskSql(`-- user's query\nSELECT 'secret'`)).toBe('SELECT ?')
  expect(maskSql(`/* it's */ SELECT * FROM t WHERE a = 'secret' -- don't`)).toBe('SELECT * FROM t WHERE a = ?')
  expect(maskSql(`SELECT "it's" FROM [o'k] WHERE a = 'secret'`)).toBe(`SELECT "it's" FROM [o'k] WHERE a = ?`)
  expect(maskSql(`SELECT 'unterminated secret`)).toBe('SELECT ?')
})

it('records a slow statement with the code that ran it, and leaves fast ones and every answer as they were', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
  const info = db.prepare('INSERT INTO t (name) VALUES (?)').run('a')
  expect(info.changes).toBe(1)
  expect(db.prepare('SELECT name FROM t WHERE id = ?').pluck().get(1)).toBe('a')
  expect(db.prepare('SELECT * FROM t').all()).toEqual([{ id: 1, name: 'a' }])
  expect(() => db.prepare('SELECT * FROM missing').all()).toThrow(/no such table/)
  expect(db.exec('SELECT 1')).toBe(db)
  const tx = db.transaction((name: string) => db.prepare('INSERT INTO t (name) VALUES (?)').run(name))
  tx.immediate('b')
  expect(db.prepare('SELECT count(*) FROM t').pluck().get()).toBe(2)
  expect(stallSnapshot().totals.filter((total) => total.kind === 'sqlite')).toEqual([])

  function slowCount(): unknown {
    return db.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000000) SELECT count(*) FROM c').pluck().get()
  }
  expect(slowCount()).toBe(5_000_000)
  const slow = stallSnapshot().totals.find((total) => total.kind === 'sqlite')
  expect(slow).toMatchObject({ what: 'WITH RECURSIVE c(x) AS (SELECT ? UNION ALL SELECT x + ? FROM c WHERE x < ?) SELECT count(*) FROM c', count: 1 })
  expect(slow!.maxMs).toBeGreaterThanOrEqual(50)
  expect(slow!.site).toMatch(/^slowCount \(stall-observer\.test\.ts:\d+\)/)
  expect(stallSnapshot().recent[0]).toMatchObject({ kind: 'sqlite', what: slow!.what, site: slow!.site })
  db.close()
})

it('reports memory, the event loop and the file-I/O probe alongside', () => {
  const snapshot = stallSnapshot()
  expect(snapshot.installedAt).not.toBeNull()
  expect(snapshot.memoryMb.rss).toBeGreaterThan(0)
  expect(snapshot.memoryMb.heapLimit).toBeGreaterThan(0)
  expect(snapshot.eventLoop).toHaveProperty('maxMs')
  expect(snapshot.threadpoolProbe).toHaveProperty('maxMs')
})

it('times file I/O in its own thread, so a blocked main thread never counts as a file-I/O wait', async () => {
  await expect.poll(() => stallSnapshot().threadpoolProbe.maxAt, { timeout: 5_000 }).not.toBeNull()
  // The main thread is busy 400 ms at a time for 4.5 s, across two probes,
  // yielding only for timers, so a probe's file read lands while it is busy.
  const until = Date.now() + 4_500
  while (Date.now() < until) {
    const busy = Date.now() + 400
    while (Date.now() < busy) { /* block */ }
    await new Promise((resolve) => setImmediate(resolve))
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(stallSnapshot().threadpoolProbe.maxMs).toBeLessThan(100)
  expect(stallSnapshot().totals.filter((total) => total.kind === 'threadpool')).toEqual([])
}, 15_000)
