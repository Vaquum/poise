import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { legacyDatastoreServices, resolveLegacyDatastore } from '../scripts/legacy-datastore.mjs'

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
