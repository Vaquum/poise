import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { closeSync, constants, openSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CALLER_CALLS_READ_TIMEOUT_MS, CallerReceiptStoreError, liveCallerCalls, requireCallerReceipts, runningCallerCalls } from '../server/service/caller-calls'
import { diagnosticPage, loggingRuntime, startLogging, stopLogging } from '../server/logging'

// The Caller calls a release switch leaves running: Caller's own records,
// whichever server started them, counted while each process is alive.

let dir = ''
afterEach(async () => {
  await stopLogging()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('Caller calls still running', () => {
  it('isolates scheduled behaviors for cutover while preserving the service-wide count and unknown provenance', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    const db = new Database(join(dir, 'calls.sqlite3'))
    db.exec('create table calls (id text, status text, pid integer, runner text, source text)')
    const insert = db.prepare('insert into calls values (?, ?, ?, ?, ?)')
    for (const source of ['poise:behavior-chain', 'poise:review-new-prs', 'poise:chat', 'manual', null]) insert.run(String(source), 'running', process.pid, null, source)
    db.close()
    expect(liveCallerCalls(dir)).toBe(5)
    expect(liveCallerCalls(dir, true)).toBe(3)
  })
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

  it('retains the first typed integrity failure and workspace in independent diagnostics without changing the damaged file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    vi.stubEnv('POISE_DB', join(dir, 'cache.db'))
    vi.stubEnv('POISE_WORKSPACE_HANDLE', 'alice')
    vi.stubEnv('AGENT_INTERFACE_DATA_DIR', dir)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    startLogging()
    const path = join(dir, 'calls.sqlite3')
    await writeFile(path, 'preserved invalid database header')
    const original = await readFile(path)
    expect(liveCallerCalls()).toBeNull()
    let first: unknown
    try { requireCallerReceipts() } catch (error) { first = error }
    expect(first).toBeInstanceOf(CallerReceiptStoreError)
    expect(first).toMatchObject({ kind: 'integrity', code: 'SQLITE_NOTADB', dataDir: dir,
      cause: { code: 'SQLITE_NOTADB', message: 'file is not a database' } })
    expect(() => requireCallerReceipts()).toThrow(first as Error)
    loggingRuntime()!.flush()
    const event = diagnosticPage(null).events.find(event => event.operation === 'caller.receipts.integrity')!
    expect(event).toMatchObject({ workspace: 'alice', cause: ['file is not a database'], context: {
      code: 'SQLITE_NOTADB', dataDir: dir, firstObservedAt: expect.any(String) } })
    expect(event.context.firstObservedAt).toBe((first as CallerReceiptStoreError).firstObservedAt)
    expect(await readFile(path)).toEqual(original)
    await stopLogging()
    startLogging()
    loggingRuntime()!.flush()
    expect(diagnosticPage(null).events.some(record => record.id === event.id)).toBe(true)
  })

  it('counts nothing without records', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    expect(liveCallerCalls(dir)).toBe(0)
    expect(liveCallerCalls(undefined)).toBe(0)
  })

  it.skipIf(process.platform !== 'linux')('refuses a structurally clean replacement through the actual pinned reader and admission gate', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    const path = join(dir, 'calls.sqlite3')
    const create = () => {
      const db = new Database(path)
      db.exec('create table calls (status text, pid integer, runner text, source text, resources_settled_at real, resource_cleanup text)')
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      db.close()
    }
    create()
    const folder = statSync(dir, { bigint: true }), original = statSync(path, { bigint: true })
    const directoryFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY)
    vi.stubEnv('AGENT_INTERFACE_DATA_DIR', dir)
    vi.stubEnv('POISE_NATIVE_CONTROL', JSON.stringify({ store: { path: dir, pid: process.pid, directoryFd,
      directory: { device: String(folder.dev), inode: String(folder.ino) },
      database: { device: String(original.dev), inode: String(original.ino) } } }))
    try {
      expect(() => requireCallerReceipts()).not.toThrow()
      await rename(path, join(dir, 'preserved.sqlite3'))
      create()
      expect(liveCallerCalls()).toBeNull()
      expect(() => requireCallerReceipts()).toThrow(expect.objectContaining({ kind: 'unavailable',
        cause: expect.objectContaining({ message: 'Caller metadata differs from its original workspace directory' }) }))
    } finally { closeSync(directoryFd) }
  })

  it('retains positively observed live processes when the resource query is unavailable', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    vi.stubEnv('AGENT_INTERFACE_DATA_DIR', dir)
    const db = new Database(join(dir, 'calls.sqlite3'))
    db.exec('create table calls (status text, pid integer, runner text)')
    db.prepare('insert into calls values (?, ?, ?)').run('running', process.pid, null)
    db.close()
    expect(runningCallerCalls()).toMatchObject({ count: 1, known: false })
    expect(() => requireCallerReceipts()).toThrow(expect.objectContaining({ kind: 'unavailable', code: 'SQLITE_ERROR' }))
  })

  it('bounds the health read instead of waiting a full second on a locked store', () => {
    expect(CALLER_CALLS_READ_TIMEOUT_MS).toBe(100)
  })

  it('says it cannot tell while another writer holds the store', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    const path = join(dir, 'calls.sqlite3')
    const setup = new Database(path)
    setup.exec('create table calls (id text, status text, pid integer, runner text, source text, resources_settled_at real, resource_cleanup text)')
    setup.prepare('insert into calls (id, status, pid, runner) values (?, ?, ?, ?)').run('alive', 'running', process.pid, null)
    setup.close()
    const holder = new Database(path)
    holder.exec('BEGIN EXCLUSIVE')
    holder.prepare('insert into calls (id, status, pid, runner) values (?, ?, ?, ?)').run('held', 'running', process.pid, null)
    vi.stubEnv('AGENT_INTERFACE_DATA_DIR', dir)
    try {
      expect(liveCallerCalls(dir)).toBeNull()
      expect(() => requireCallerReceipts()).toThrow(expect.objectContaining({ kind: 'contention', code: 'SQLITE_BUSY' }))
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    expect(liveCallerCalls(dir)).toBe(1)
    expect(() => requireCallerReceipts()).not.toThrow()
  })
})
