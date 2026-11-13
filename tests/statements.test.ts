import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedStatement } from '../server/statements'

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
