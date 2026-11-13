import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedStatement, prefixRange } from '../server/statements'

let tempRoot = ''
let loaded: typeof import('../server/db') | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  if (loaded?.db.open) loaded.closeDatabase()
  loaded = null
  delete process.env.POISE_DB
  vi.resetModules()
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

describe('cached statements', () => {
  it('compiles a statement once per connection and SQL', () => {
    const first = new Database(':memory:')
    const second = new Database(':memory:')
    const statement = cachedStatement(first, 'SELECT ? AS n')
    expect(cachedStatement(first, 'SELECT ? AS n')).toBe(statement)
    expect(cachedStatement(first, 'SELECT ? + 1 AS n')).not.toBe(statement)
    expect(cachedStatement(second, 'SELECT ? AS n')).not.toBe(statement)
    expect(statement.get(7)).toEqual({ n: 7 })
    expect(cachedStatement(first, 'SELECT ? AS n').get(8)).toEqual({ n: 8 })
    first.close()
    second.close()
  })

  it('offers no way to change a shared statement', () => {
    const database = new Database(':memory:')
    const statement = cachedStatement(database, 'SELECT 1 AS n')
    // @ts-expect-error pluck would change every later caller's rows
    void statement.pluck
    // @ts-expect-error a reused statement must not be mid-iteration
    void statement.iterate
    // @ts-expect-error bound parameters would carry into later calls
    void statement.bind
    database.close()
  })

  it('compiles the hot readers once, however often they run', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'poise-statements-test-'))
    process.env.POISE_DB = join(tempRoot, 'cache.db')
    vi.resetModules()
    loaded = await import('../server/db')
    const prepare = vi.spyOn(loaded.db, 'prepare')
    const read = () => {
      loaded!.getMeta('me')
      loaded!.countReviewRounds('acme/repo', 1)
      loaded!.listBehaviorLaunchClaims('review-new-prs')
      loaded!.listBehaviorDeadLetters(10)
    }
    read()
    const compiled = prepare.mock.calls.length
    read()
    read()
    expect(prepare).toHaveBeenCalledTimes(compiled)
  })
})

describe('prefixRange', () => {
  it('selects exactly the keys a prefix comparison selects, through the key index', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const keys = ['behavior_repo_hold', 'behavior_repo_hold:', 'behavior_repo_hold:a/b:x', 'behavior_repo_hold:~', 'behavior_repo_hold:\u00e9',
      'behavior_repo_hold;', 'behavior_repo_hold9', 'behavior_repo_holdz', 'org:alpha:behavior_repo_hold:a/b', 'datastore_stale:x']
    const insert = db.prepare('INSERT INTO meta VALUES (?, ?)')
    for (const key of keys) insert.run(key, 'v')
    const prefix = 'behavior_repo_hold:'
    const bySubstr = db.prepare('SELECT key FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key').all(prefix.length, prefix)
    const byRange = db.prepare('SELECT key FROM meta WHERE key >= ? AND key < ? ORDER BY key').all(...prefixRange(prefix))
    expect(byRange).toEqual(bySubstr)
    expect(byRange.map((row) => (row as { key: string }).key)).toEqual(['behavior_repo_hold:', 'behavior_repo_hold:a/b:x', 'behavior_repo_hold:~', 'behavior_repo_hold:\u00e9'])
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT key FROM meta WHERE key >= ? AND key < ?').all(...prefixRange(prefix)) as Array<{ detail: string }>
    expect(plan.map((row) => row.detail).join(' ')).toMatch(/SEARCH meta USING (COVERING )?INDEX/)
    db.close()
  })

  it('refuses a prefix it cannot bound', () => {
    expect(prefixRange('a:')).toEqual(['a:', 'a;'])
    expect(() => prefixRange('')).toThrow('ASCII')
    expect(() => prefixRange('caf\u00e9')).toThrow('ASCII')
  })
})
