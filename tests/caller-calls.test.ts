import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { liveCallerCalls } from '../server/service/caller-calls'

// The Caller calls a release switch leaves running: Caller's own records,
// whichever server started them, counted while each process is alive.

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('Caller calls still running', () => {
  it('counts running calls whose process lives, and no Chat turn Poise runs itself', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    const gone = spawnSync('true').pid
    const db = new Database(join(dir, 'calls.sqlite3'))
    db.exec('create table calls (id text, status text, pid integer, runner text)')
    const insert = db.prepare('insert into calls values (?, ?, ?, ?)')
    insert.run('alive', 'running', process.pid, null)
    insert.run('gone', 'running', gone, null)
    insert.run('done', 'completed', process.pid, null)
    insert.run('turn', 'running', null, 'external')
    db.close()
    expect(liveCallerCalls(dir)).toBe(1)
  })

  it('says it cannot tell when the records exist but cannot be read', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    await writeFile(join(dir, 'calls.sqlite3'), 'not a database')
    expect(liveCallerCalls(dir)).toBeNull()
  })

  it('counts nothing without records', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    expect(liveCallerCalls(dir)).toBe(0)
    expect(liveCallerCalls(undefined)).toBe(0)
  })
})
