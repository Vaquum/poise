import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { legacyDatastoreServices, resolveLegacyDatastore, resolveLegacySyncUser } from '../scripts/legacy-datastore.mjs'

let home
let defaultDb
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'poise-legacy-datastore-'))
  defaultDb = join(home, 'dev', 'caller', 'github_datastore', 'github_datastore.sqlite')
})
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('production legacy datastore selection', () => {
  it('allows clean installation without creating or taking over datastore jobs', async () => {
    const launchAgents = join(home, 'Library', 'LaunchAgents')
    const existing = join(launchAgents, 'com.vaquum.github-datastore.sync.plist')
    await mkdir(launchAgents, { recursive: true })
    await writeFile(existing, 'externally owned job')
    const database = await resolveLegacyDatastore({ home })
    expect(database).toBeNull()
    expect(legacyDatastoreServices(database, launchAgents)).toEqual([])
    expect(await readFile(existing, 'utf8')).toBe('externally owned job')
  })

  it('keeps the default existing database and all three legacy services', async () => {
    await mkdir(dirname(defaultDb), { recursive: true })
    await writeFile(defaultDb, 'existing database')
    const selected = await resolveLegacyDatastore({ home })
    expect(selected).toBe(defaultDb)
    const services = legacyDatastoreServices(selected, join(home, 'Library', 'LaunchAgents'))
    expect(services.map((job) => job.label)).toEqual([
      'com.vaquum.github-datastore.sync', 'com.vaquum.github-datastore.reconcile', 'com.vaquum.github-datastore.health',
    ])
    expect(services.every((job) => job.path === join(home, 'Library', 'LaunchAgents', `${job.label}.plist`))).toBe(true)
    expect(await readFile(defaultDb, 'utf8')).toBe('existing database')
  })

  it('honors an explicit datastore outside the default location without changing it', async () => {
    const configuredPath = join(home, 'custom.sqlite')
    await writeFile(configuredPath, 'custom database')
    expect(await resolveLegacyDatastore({ home, configuredPath })).toBe(configuredPath)
    expect(await readFile(configuredPath, 'utf8')).toBe('custom database')
  })

  it('fails clearly if an explicitly configured path is missing, even when the default exists', async () => {
    await mkdir(dirname(defaultDb), { recursive: true })
    await writeFile(defaultDb, 'existing database')
    await expect(resolveLegacyDatastore({ home, configuredPath: join(home, 'missing.sqlite') }))
      .rejects.toThrow('POISE_DATASTORE_DB does not exist:')
  })

  it('rejects explicit blank paths and directories instead of treating them as a clean install', async () => {
    await expect(resolveLegacyDatastore({ home, configuredPath: '' })).rejects.toThrow('POISE_DATASTORE_DB must name')
    await expect(resolveLegacyDatastore({ home, configuredPath: home })).rejects.toThrow('must point to an initialized')
  })

  it('does not hide permissions or other access failures at the optional default', async () => {
    await expect(resolveLegacyDatastore({ home }, async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })).rejects.toThrow('POISE_DATASTORE_DB could not be inspected:')
  })
})

describe('legacy sync identity', () => {
  // The installer resolves the sync user through this alone: any gh call —
  // the old active-account fallback — fails the test.
  function sqliteRun(rows) {
    const writes = []
    const run = async (command, args) => {
      if (command !== '/usr/bin/sqlite3') throw new Error(`Unexpected command: ${command}`)
      if (args[0] === '-json') return { stdout: JSON.stringify(rows), stderr: '' }
      writes.push(args)
      return { stdout: '', stderr: '' }
    }
    return { run, writes }
  }

  async function savedDb(home, database = join(home, '.poise', 'cache.db')) {
    await mkdir(dirname(database), { recursive: true })
    await writeFile(database, '')
    return database
  }

  it('authenticates sync as your saved GitHub account, with no identity environment', async () => {
    await savedDb(home)
    const { run, writes } = sqliteRun([{ key: 'me', value: 'octocat' }])
    expect(await resolveLegacySyncUser({ home, run, environment: {} })).toEqual({ user: 'octocat', migrated: false })
    expect(writes).toEqual([])
  })

  it('prefers the saved account over a conflicting POISE_GITHUB_USER', async () => {
    await savedDb(home)
    const { run, writes } = sqliteRun([{ key: 'me', value: 'octocat' }])
    expect(await resolveLegacySyncUser({ home, run, environment: { POISE_GITHUB_USER: 'other-person' } }))
      .toEqual({ user: 'octocat', migrated: false })
    expect(writes).toEqual([])
  })

  it('migrates POISE_GITHUB_USER into Settings once, when nothing was ever saved', async () => {
    const database = await savedDb(home)
    const { run, writes } = sqliteRun([])
    expect(await resolveLegacySyncUser({ home, run, environment: { POISE_GITHUB_USER: 'migrated-person' } }))
      .toEqual({ user: 'migrated-person', migrated: true })
    expect(writes).toEqual([[database, "INSERT INTO meta(key, value) VALUES ('me', 'migrated-person') ON CONFLICT(key) DO UPDATE SET value = excluded.value;"]])
  })

  it('leaves a cleared account cleared and fails naming the setting', async () => {
    await savedDb(home)
    const { run, writes } = sqliteRun([{ key: 'me', value: '' }])
    await expect(resolveLegacySyncUser({ home, run, environment: { POISE_GITHUB_USER: 'migrated-person' } }))
      .rejects.toThrow('No GitHub account is saved. Set Your GitHub account in Settings → General')
    expect(writes).toEqual([])
  })

  it('fails naming the setting when nothing is saved and no migration applies', async () => {
    await savedDb(home)
    const { run } = sqliteRun([])
    await expect(resolveLegacySyncUser({ home, run, environment: {} }))
      .rejects.toThrow('No GitHub account is saved. Set Your GitHub account in Settings → General')
  })

  it('fails naming the setting before the first start', async () => {
    const { run } = sqliteRun([{ key: 'me', value: 'octocat' }])
    await expect(resolveLegacySyncUser({ home, run, environment: {} }))
      .rejects.toThrow('No GitHub account is saved. Set Your GitHub account in Settings → General')
  })

  it('refuses an invalid migration value and an invalid saved one', async () => {
    await savedDb(home)
    const invalidEnv = sqliteRun([])
    await expect(resolveLegacySyncUser({ home, run: invalidEnv.run, environment: { POISE_GITHUB_USER: 'not a login' } }))
      .rejects.toThrow('POISE_GITHUB_USER must be a GitHub username')
    expect(invalidEnv.writes).toEqual([])
    const invalidSaved = sqliteRun([{ key: 'me', value: 'not a login' }])
    await expect(resolveLegacySyncUser({ home, run: invalidSaved.run, environment: {} }))
      .rejects.toThrow('The GitHub account in Settings → General is not a GitHub username')
  })

  it('reads the database POISE_DB names', async () => {
    const database = await savedDb(home, join(home, 'custom.db'))
    let readFrom = null
    const run = async (command, args) => {
      if (command !== '/usr/bin/sqlite3') throw new Error(`Unexpected command: ${command}`)
      if (args[0] === '-json') {
        readFrom = args[1]
        return { stdout: JSON.stringify([{ key: 'me', value: 'alice' }]), stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }
    expect(await resolveLegacySyncUser({ home, run, environment: { POISE_DB: database } }))
      .toEqual({ user: 'alice', migrated: false })
    expect(readFrom).toBe(database)
  })
})
