import Database from 'better-sqlite3'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFileOptions } from '../server/process'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile }))

let tempRoot = ''
let database: typeof import('../server/db') | undefined
let organizations: typeof import('../server/organizations') | undefined
const originalDb = process.env.POISE_DB
const originalDatastore = process.env.POISE_DATASTORE_DB

function writeIndex(path: string, login: string, complete = true): void {
  const fixture = new Database(path)
  try {
    fixture.exec('CREATE TABLE IF NOT EXISTS sync_state(scope TEXT, key TEXT, value TEXT)')
    fixture.prepare('INSERT INTO sync_state VALUES (?, ?, ?)').run('org', 'login', login)
    if (complete) fixture.prepare('INSERT INTO sync_state VALUES (?, ?, ?)').run('org', 'last_full_build_at', new Date().toISOString())
  } finally { fixture.close() }
}

async function cli(command: string, args: string[], _options?: RunFileOptions) {
  if (command === 'gh') return { stdout: 'selected-secret-token\n', stderr: '' }
  const path = args[1]!
  const operation = args[2]
  if (operation === 'init-org') writeIndex(path, args[3]!)
  if (operation === 'health') return {
    stdout: JSON.stringify({ action: 'health', status: 'healthy', healthy: true, database: path }), stderr: '',
  }
  return { stdout: '', stderr: '' }
}

function operations(operation: string) {
  return mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-datastore' && args[2] === operation)
}

async function load() {
  database = await import('../server/db')
  organizations = await import('../server/organizations')
  return organizations
}

async function ready(login: string) {
  await vi.waitFor(() => {
    expect(organizations!.getOrganizations().find((org) => org.login === login)?.status).toBe('ready')
  })
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'poise-organizations-test-'))
  process.env.POISE_DB = join(tempRoot, 'cache.db')
  delete process.env.POISE_DATASTORE_DB
  vi.resetModules()
  mocks.runFile.mockReset().mockImplementation(cli)
  await load()
  database!.setMeta('me', 'octocat')
})

afterEach(async () => {
  await organizations?.stopOrganizationsRuntime()
  if (database?.db.open) database.closeDatabase()
  database = undefined
  organizations = undefined
  vi.useRealTimers()
  if (originalDb === undefined) delete process.env.POISE_DB
  else process.env.POISE_DB = originalDb
  if (originalDatastore === undefined) delete process.env.POISE_DATASTORE_DB
  else process.env.POISE_DATASTORE_DB = originalDatastore
  vi.resetModules()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('organization activation', () => {
  it('preserves legacy routing and automation history without reinitializing its datastore', async () => {
    database!.setMeta('org', 'Vaquum')
    process.env.POISE_DATASTORE_DB = join(tempRoot, 'existing.sqlite')
    database!.recordSeen('review-new-prs', 'Vaquum/repo#4')
    expect(organizations!.getOrganizations()).toEqual([{
      login: 'Vaquum', datastorePath: process.env.POISE_DATASTORE_DB,
      managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null,
    }])
    expect(organizations!.addOrganization('VAQUUM').managed).toBe(false)
    organizations!.addOrganization('second')
    await ready('second')
    expect(operations('init-org').map((call) => call[1][3])).toEqual(['second'])
    expect(database!.hasSeen('review-new-prs', 'Vaquum/repo#4')).toBe(true)
    expect(organizations!.organizationArgs(organizations!.getOrganizations()[0]!, ['view', 'pr'])).toEqual([
      '--db', process.env.POISE_DATASTORE_DB, 'view', 'pr',
    ])
  })

  it('validates and deduplicates organizations case-insensitively before spawning', async () => {
    for (const value of ['', '../repo', '-flag', 'abc--def', 'org/repo', 'a'.repeat(40)]) {
      expect(() => organizations!.addOrganization(value)).toThrow('GitHub organization name')
    }
    const first = organizations!.addOrganization(' Acme ')
    const second = organizations!.addOrganization('ACME')
    expect(first.status).toBe('initializing')
    expect(second.login).toBe('acme')
    expect(organizations!.readyOrganizations()).toEqual([])
    await ready('acme')
    expect(operations('init-org')).toHaveLength(1)
    expect(organizations!.getOrganizations()).toHaveLength(1)
    expect(existsSync(first.datastorePath!)).toBe(true)
    expect(statSync(dirname(first.datastorePath!)).mode & 0o777).toBe(0o700)
    expect(existsSync(`${first.datastorePath}.initializing`)).toBe(false)
  })

  it('pins the selected GitHub identity and keeps credentials out of persisted state', async () => {
    organizations!.addOrganization('acme')
    await ready('acme')
    expect(mocks.runFile.mock.calls[0]).toMatchObject([
      'gh', ['auth', 'token', '--hostname', 'github.com', '--user', 'octocat'],
      { env: { GH_TOKEN: undefined, GH_HOST: undefined, GITHUB_TOKEN: undefined } },
    ])
    for (const call of operations('init-org')) {
      expect(call[2].env).toMatchObject({ GH_TOKEN: 'selected-secret-token', GH_HOST: 'github.com' })
      expect(call[1].join(' ')).not.toContain('selected-secret-token')
    }
    expect(JSON.stringify(database!.db.prepare('SELECT * FROM organizations').all())).not.toContain('secret-token')
    expect(operations('build-user')[0]?.[1][3]).toBe('octocat')
  })

  it('isolates activation failures and retries only the unfinished organization', async () => {
    let failing = true
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'github-datastore' && args[2] === 'init-org' && args[3] === 'broken' && failing) {
        writeIndex(args[1], 'broken', false)
        throw Object.assign(new Error('init failed'), { stderr: 'denied selected-secret-token github_pat_mocksecret' })
      }
      return cli(command, args, options)
    })
    const failed = organizations!.addOrganization('broken')
    organizations!.addOrganization('working')
    await ready('working')
    await vi.waitFor(() => expect(organizations!.getOrganizations().find((org) => org.login === 'broken')?.status).toBe('error'))
    expect(organizations!.getOrganizations().find((org) => org.login === 'broken')?.error).toContain('[redacted]')
    expect(JSON.stringify(organizations!.getOrganizations())).not.toContain('selected-secret-token')
    expect(existsSync(failed.datastorePath!)).toBe(false)
    failing = false
    organizations!.retryOrganization('BROKEN')
    await ready('broken')
    expect(operations('init-org').map((call) => call[1][3]).sort()).toEqual(['broken', 'broken', 'working'])
    expect(operations('init-org').at(-1)?.[1][3]).toBe('broken')
    expect(organizations!.readyOrganizations()).toHaveLength(2)
  })

  it('resumes completed staging work after shutdown without initializing twice', async () => {
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'github-datastore' && args[2] === 'build-user') {
        return new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }
      return cli(command, args, options)
    })
    organizations!.addOrganization('acme')
    await vi.waitFor(() => expect(operations('build-user')).toHaveLength(1))
    await organizations!.stopOrganizationsRuntime()
    expect(organizations!.getOrganizations()[0]!.status).toBe('initializing')
    database!.closeDatabase()
    vi.resetModules()
    mocks.runFile.mockImplementation(cli)
    await load()
    organizations!.startOrganizationsRuntime()
    await ready('acme')
    expect(operations('init-org')).toHaveLength(1)
    expect(operations('build-user')).toHaveLength(2)
  })

  it('adopts a published completed index on restart and rejects an unexpected owner', async () => {
    organizations!.addOrganization('acme')
    await ready('acme')
    database!.db.prepare("UPDATE organizations SET status = 'initializing', last_sync_at = 0 WHERE login = 'acme'").run()
    organizations!.startOrganizationsRuntime()
    await ready('acme')
    expect(operations('init-org')).toHaveLength(1)
    const path = organizations!.getOrganizations()[0]!.datastorePath!
    const fixture = new Database(path)
    fixture.prepare("UPDATE sync_state SET value = 'other' WHERE key = 'login'").run()
    fixture.close()
    database!.db.prepare("UPDATE organizations SET status = 'initializing', activated_at = NULL WHERE login = 'acme'").run()
    organizations!.retryOrganization('acme')
    await vi.waitFor(() => expect(organizations!.getOrganizations()[0]!.status).toBe('error'))
    expect(organizations!.getOrganizations()[0]!.error).toContain('this organization')
    expect(operations('init-org')).toHaveLength(1)
  })

  it('keeps initialization failures durable until the user retries', async () => {
    mocks.runFile.mockRejectedValue(new Error('credential unavailable'))
    organizations!.addOrganization('acme')
    await vi.waitFor(() => expect(organizations!.getOrganizations()[0]!.status).toBe('error'))
    await organizations!.stopOrganizationsRuntime()
    database!.closeDatabase()
    vi.resetModules()
    mocks.runFile.mockClear()
    await load()
    organizations!.startOrganizationsRuntime()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(organizations!.getOrganizations()[0]!.error).toContain('authentication is unavailable for octocat')
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('fails closed when health does not verify the newly created database', async () => {
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'github-datastore' && args[2] === 'health') return {
        stdout: JSON.stringify({ healthy: true, status: 'healthy', action: 'health', database: '/different.sqlite' }), stderr: '',
      }
      return cli(command, args, options)
    })
    const org = organizations!.addOrganization('acme')
    await vi.waitFor(() => expect(organizations!.getOrganizations()[0]!.status).toBe('error'))
    expect(organizations!.readyOrganizations()).toEqual([])
    expect(existsSync(org.datastorePath!)).toBe(false)
  })
})

describe('managed organization synchronization', () => {
  it('pauses new work during a release drain and tracks activation already in progress', async () => {
    const background = await import('../server/release-background')
    background.pauseReleaseBackground()
    organizations!.addOrganization('acme')
    expect(background.releaseBackgroundBusy()).toBe(0)
    expect(mocks.runFile).not.toHaveBeenCalled()
    background.resumeReleaseBackground()
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => { finish = resolve })
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'github-datastore' && args[2] === 'init-org') {
        await Promise.race([waiting, new Promise<void>((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })])
      }
      return cli(command, args, options)
    })
    try {
      organizations!.startOrganizationsRuntime()
      await vi.waitFor(() => expect(operations('init-org')).toHaveLength(1))
      expect(background.releaseBackgroundBusy()).toBe(1)
      background.pauseReleaseBackground()
      finish()
      await ready('acme')
      await vi.waitFor(() => expect(background.releaseBackgroundBusy()).toBe(0))
    } finally {
      finish()
      background.resumeReleaseBackground()
    }
  })

  it('syncs each managed org independently and periodically reconciles repository removals', async () => {
    database!.setMeta('org', 'legacy')
    organizations!.addOrganization('acme')
    organizations!.addOrganization('beta')
    await ready('acme')
    await ready('beta')
    mocks.runFile.mockClear()
    database!.db.prepare('UPDATE organizations SET last_sync_at = 0, last_reconcile_at = 0 WHERE managed = 1').run()
    organizations!.startOrganizationsRuntime()
    await vi.waitFor(() => expect(operations('health')).toHaveLength(2))
    expect(operations('sync').filter((call) => call[1].includes('--reconcile'))).toHaveLength(2)
    expect(operations('sync').every((call) => call[1][1].includes('/datastores/'))).toBe(true)
    expect(operations('init-org')).toHaveLength(0)
  })

  it('rebuilds user projections after the selected identity changes before returning ready', async () => {
    organizations!.addOrganization('acme')
    await ready('acme')
    database!.setMeta('me', 'new-user')
    expect(organizations!.readyOrganizations()).toEqual([])
    organizations!.startOrganizationsRuntime()
    await ready('acme')
    expect(operations('build-user').map((call) => call[1][3])).toEqual(['octocat', 'new-user'])
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'gh').at(-1)?.[1]).toContain('new-user')
  })

  it('persists failed-sync backoff across ticks and restarts while another org continues', async () => {
    organizations!.addOrganization('acme')
    organizations!.addOrganization('beta')
    await ready('acme')
    await ready('beta')
    let failing = true
    let releaseSync!: () => void
    let heldSync: Promise<void> | undefined
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'github-datastore' && args[2] === 'sync' && args[1].includes('/acme/')) {
        if (failing) throw new Error('network unavailable')
        if (heldSync) await Promise.race([
          heldSync,
          new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
        ])
      }
      return cli(command, args, options)
    })
    organizations!.retryOrganization('acme')
    await vi.waitFor(() => expect(organizations!.getOrganizations().find((org) => org.login === 'acme')!.stage).toBe('sync-error'))
    const state = database!.db.prepare("SELECT next_sync_at, sync_failures FROM organizations WHERE login = 'acme'").get() as { next_sync_at: number, sync_failures: number }
    expect(state.next_sync_at - Date.now()).toBeGreaterThan(50_000)
    expect(state.sync_failures).toBe(1)
    await organizations!.stopOrganizationsRuntime()
    database!.closeDatabase()
    vi.resetModules()
    await load()
    database!.db.prepare("UPDATE organizations SET last_sync_at = 0 WHERE login = 'beta'").run()
    mocks.runFile.mockClear()
    const intervals = vi.spyOn(globalThis, 'setInterval')
    try {
      organizations!.startOrganizationsRuntime()
      await vi.waitFor(() => expect(operations('health')).toHaveLength(1))
      const tick = intervals.mock.calls.at(-1)![0]
      for (let index = 0; index < 3; index += 1) {
        if (typeof tick === 'function') tick()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(operations('sync').map((call) => call[1][1])).toEqual([join(tempRoot, 'datastores/beta/github.sqlite')])
      expect(organizations!.getOrganizations().find((org) => org.login === 'acme')!.error).toContain('network unavailable')
      failing = false
      heldSync = new Promise<void>((resolve) => { releaseSync = resolve })
      organizations!.retryOrganization('acme')
      await vi.waitFor(() => expect(operations('sync')).toHaveLength(2))
      expect(organizations!.getOrganizations().find((org) => org.login === 'acme')!.error).toContain('network unavailable')
      releaseSync()
      await vi.waitFor(() => expect(organizations!.getOrganizations().find((org) => org.login === 'acme')!.error).toBeNull())
      expect(database!.db.prepare("SELECT next_sync_at, sync_failures FROM organizations WHERE login = 'acme'").get())
        .toEqual({ next_sync_at: 0, sync_failures: 0 })
    } finally {
      releaseSync?.()
      intervals.mockRestore()
    }
  })

  it('exposes sync failures without dropping the org and recovers on the next sync', async () => {
    organizations!.addOrganization('acme')
    await ready('acme')
    let failing = true
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (failing && command === 'github-datastore' && args[2] === 'sync') throw new Error('network unavailable')
      return cli(command, args, options)
    })
    organizations!.retryOrganization('acme')
    await vi.waitFor(() => expect(organizations!.getOrganizations()[0]!.stage).toBe('sync-error'))
    expect(organizations!.readyOrganizations()).toHaveLength(1)
    failing = false
    organizations!.retryOrganization('acme')
    await vi.waitFor(() => expect(organizations!.getOrganizations()[0]!.error).toBeNull())
    await ready('acme')
  })
})
