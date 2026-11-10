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

  it('keeps chain admissions paused after integrity failure and successful narrow reads, including across restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    vi.stubEnv('POISE_MODE', 'service')
    vi.stubEnv('POISE_DB', join(dir, 'cache.db'))
    vi.stubEnv('AGENT_INTERFACE_DATA_DIR', dir)
    vi.resetModules()
    let database = await import('../server/db')
    let settings = await import('../server/settings')
    let receipts = await import('../server/service/caller-calls')
    const configured: { enabled: boolean, seedMode: 'label', label: string } = { enabled: true, seedMode: 'label', label: 'recovered-work' }
    database.setMeta('behavior_chain_settings', JSON.stringify(configured))
    const path = join(dir, 'calls.sqlite3')
    const store = new Database(path)
    store.exec(`CREATE TABLE calls (status text, pid integer, runner text, source text, resources_settled_at real, resource_cleanup text);
      CREATE INDEX pending_resources ON calls (source, resources_settled_at, resource_cleanup)`)
    store.prepare('INSERT INTO calls VALUES (?, ?, NULL, ?, NULL, NULL)').run('running', process.pid, 'poise:behavior-chain')
    const pageSize = store.pragma('page_size', { simple: true }) as number
    const { rootpage } = store.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'pending_resources'").get() as { rootpage: number }
    store.close()
    const original = await readFile(path)
    const damaged = Buffer.from(original)
    damaged[(rootpage - 1) * pageSize] = 0 // Damage only the resource index; the running-Call query remains readable.
    await writeFile(path, damaged)
    try {
      expect(() => receipts.requireCallerReceipts()).toThrow(expect.objectContaining({ kind: 'integrity', code: 'SQLITE_CORRUPT' }))
      expect(settings.getBehaviorChainSettings()).toEqual({ ...configured, enabled: false })
      expect(receipts.liveCallerCalls()).toBe(1)
      expect(settings.getBehaviorChainSettings().enabled).toBe(false)
      database.closeDatabase()
      vi.resetModules()
      database = await import('../server/db')
      settings = await import('../server/settings')
      receipts = await import('../server/service/caller-calls')
      expect(receipts.liveCallerCalls()).toBe(1)
      expect(settings.getBehaviorChainSettings()).toEqual({ ...configured, enabled: false })
      // Even a fully readable store requires an explicit admission resume.
      await writeFile(path, original)
      expect(() => receipts.requireCallerReceipts()).not.toThrow()
      expect(settings.getBehaviorChainSettings().enabled).toBe(false)
      // A direct stored write cannot resume while the hold persists. This is
      // the crash window: the hold was committed but the settings update was
      // not, so the stored setting still reads enabled yet admissions stay
      // fenced until an explicit resume.
      const { BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY } = await import('../server/settings')
      database.setMeta('behavior_chain_settings', JSON.stringify(configured))
      expect(database.getMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY)).toBe('1')
      expect(settings.getBehaviorChainSettings()).toEqual({ ...configured, enabled: false })
      database.closeDatabase()
      vi.resetModules()
      database = await import('../server/db')
      settings = await import('../server/settings')
      receipts = await import('../server/service/caller-calls')
      expect(settings.getBehaviorChainSettings()).toEqual({ ...configured, enabled: false })
      const holder = new Database(path)
      holder.exec('BEGIN EXCLUSIVE')
      try {
        expect(() => receipts.requireCallerReceipts()).toThrow(expect.objectContaining({ kind: 'contention', code: 'SQLITE_BUSY' }))
        expect(settings.getBehaviorChainSettings()).toEqual({ ...configured, enabled: false })
      } finally { holder.close() }
      expect(() => receipts.requireCallerReceipts()).not.toThrow()
      expect(settings.getBehaviorChainSettings()).toEqual({ ...configured, enabled: false })
      // Only an explicit Settings resume clears the hold and enables.
      const { behaviorChainJournal } = await import('../server/behavior-chain-journal')
      const journal = behaviorChainJournal()
      journal.changeAdmission(journal.cutover().sequence, 'draining')
      journal.changeAdmission(journal.cutover().sequence, 'v2', [])
      settings.setSettings({ behaviorChain: configured })
      expect(database.getMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY)).toBe('')
      expect(settings.getBehaviorChainSettings()).toEqual(configured)
    } finally { database.closeDatabase(); vi.resetModules() }
  })

  it('persists an integrity hold when admissions are already disabled, until an explicit Settings resume', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    vi.stubEnv('POISE_DB', join(dir, 'cache.db'))
    vi.stubEnv('AGENT_INTERFACE_DATA_DIR', dir)
    vi.resetModules()
    let database = await import('../server/db')
    let settings = await import('../server/settings')
    let receipts = await import('../server/service/caller-calls')
    const { BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY } = await import('../server/settings')
    // Draining-like: admissions already disabled before the integrity failure.
    database.setMeta('behavior_chain_settings', JSON.stringify({ enabled: false, seedMode: 'label', label: 'poise' }))
    const path = join(dir, 'calls.sqlite3')
    await writeFile(path, 'preserved invalid database header')
    try {
      expect(() => receipts.requireCallerReceipts()).toThrow(expect.objectContaining({ kind: 'integrity', code: 'SQLITE_NOTADB' }))
      expect(database.getMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY)).toBe('1')
      expect(settings.getBehaviorChainSettings().enabled).toBe(false)
      database.closeDatabase()
      vi.resetModules()
      database = await import('../server/db')
      settings = await import('../server/settings')
      receipts = await import('../server/service/caller-calls')
      expect(database.getMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY)).toBe('1')
      expect(settings.getBehaviorChainSettings().enabled).toBe(false)
      // A fully readable store still requires an explicit admission resume.
      await rm(path)
      const valid = new Database(path)
      valid.exec('CREATE TABLE calls (status text, pid integer, runner text, source text, resources_settled_at real, resource_cleanup text)')
      valid.prepare('INSERT INTO calls VALUES (?, ?, NULL, ?, NULL, NULL)').run('running', process.pid, 'poise:behavior-chain')
      valid.close()
      expect(() => receipts.requireCallerReceipts()).not.toThrow()
      expect(database.getMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY)).toBe('1')
      expect(settings.getBehaviorChainSettings().enabled).toBe(false)
      // Contention neither clears the hold nor resumes admissions.
      const holder = new Database(path)
      holder.exec('BEGIN EXCLUSIVE')
      try {
        expect(() => receipts.requireCallerReceipts()).toThrow(expect.objectContaining({ kind: 'contention', code: 'SQLITE_BUSY' }))
        expect(database.getMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY)).toBe('1')
        expect(settings.getBehaviorChainSettings().enabled).toBe(false)
      } finally { holder.close() }
      // An explicit Settings resume clears the hold and enables invocations.
      const { behaviorChainJournal } = await import('../server/behavior-chain-journal')
      const journal = behaviorChainJournal()
      journal.changeAdmission(journal.cutover().sequence, 'draining')
      journal.changeAdmission(journal.cutover().sequence, 'v2', [])
      settings.setSettings({ behaviorChain: { enabled: true, seedMode: 'label', label: 'poise' } })
      expect(database.getMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY)).toBe('')
      expect(settings.getBehaviorChainSettings().enabled).toBe(true)
    } finally { database.closeDatabase(); vi.resetModules() }
  })

  it('suppresses sweep wrappers only for the exact recorded receipt failure, retaining health and independent errors', async () => {
    dir = await mkdtemp(join(tmpdir(), 'poise-caller-calls-'))
    vi.stubEnv('POISE_DB', join(dir, 'cache.db'))
    vi.stubEnv('AGENT_INTERFACE_DATA_DIR', dir)
    vi.resetModules()
    const database = await import('../server/db')
    const receipts = await import('../server/service/caller-calls')
    const logging = await import('../server/logging')
    const processes = await import('../server/process')
    const { BehaviorChainRuntime } = await import('../server/behavior-chain-runtime')
    const behaviors = await import('../server/behaviors')
    database.setMeta('org', 'acme')
    database.setMeta('behavior_chain_settings', JSON.stringify({ enabled: false, seedMode: 'label', label: 'poise' }))
    await writeFile(join(dir, 'calls.sqlite3'), 'preserved invalid database header')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    vi.spyOn(processes, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32),
      events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '' })
    const sweep = vi.spyOn(BehaviorChainRuntime.prototype, 'run').mockImplementation(async () => receipts.requireCallerReceipts())
    try {
      // No canonical diagnostic was accepted yet, so the wrapper must report it.
      await behaviors.runEnabledBehaviorsOnce()
      expect(report).toHaveBeenCalledWith(expect.stringContaining('Caller receipt store integrity failure'))
      logging.startLogging()
      const events = () => {
        logging.loggingRuntime()!.flush()
        return logging.diagnosticPage(null).events
      }
      const wrappers = () => events().filter(event => event.message.includes('[behaviors] behavior chain failed'))
      for (let attempt = 0; attempt < 3; attempt++) await behaviors.runEnabledBehaviorsOnce()
      expect(wrappers()).toEqual([])
      expect(behaviors.getBehaviorChainRuntimeHealth()).toEqual([
        expect.objectContaining({ organization: 'acme', error: 'Caller receipt store integrity failure (SQLITE_NOTADB)' }),
      ])
      expect(events().filter(event => event.operation === 'caller.receipts.integrity')).toHaveLength(1)
      let recorded: unknown
      try { receipts.requireCallerReceipts() } catch (error) { recorded = error }
      expect(recorded).toBeInstanceOf(receipts.CallerReceiptStoreError)
      // A successful intervening probe cannot erase this error's diagnostic.
      expect(receipts.liveCallerCalls('')).toBe(0)
      sweep.mockRejectedValueOnce(recorded)
      await behaviors.runEnabledBehaviorsOnce()
      expect(wrappers()).toEqual([])
      const independent = new receipts.CallerReceiptStoreError(dir, Object.assign(new Error('separate failure'), { code: 'SQLITE_NOTADB' }))
      sweep.mockRejectedValueOnce(independent)
      await behaviors.runEnabledBehaviorsOnce()
      expect(wrappers()).toHaveLength(1)
      sweep.mockRejectedValueOnce(new AggregateError([recorded, new Error('uncertainty journal failed')], 'uncertainty journal failed'))
      await behaviors.runEnabledBehaviorsOnce()
      expect(wrappers()).toHaveLength(2)
      expect(wrappers().some(event => event.message.includes('uncertainty journal failed'))).toBe(true)
    } finally {
      await logging.stopLogging()
      database.closeDatabase()
      vi.resetModules()
    }
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
