import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSavedSettings, settingsDatabasePath, writeSavedSetting } from '../scripts/saved-settings.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), 'poise-saved-settings-'))
  roots.push(home)
  return home
}

describe('the settings database every consumer opens', () => {
  it('is ~/.poise/cache.db when POISE_DB is unset or empty, the same default the server opens', async () => {
    const home = await temporaryHome()
    expect(settingsDatabasePath(home, {})).toBe(join(home, '.poise', 'cache.db'))
    expect(settingsDatabasePath(home, { POISE_DB: '' })).toBe(join(home, '.poise', 'cache.db'))
  })

  it('is POISE_DB verbatim when set, exactly as the server opens it', async () => {
    const home = await temporaryHome()
    expect(settingsDatabasePath(home, { POISE_DB: join(home, 'custom.db') })).toBe(join(home, 'custom.db'))
    // server/db.ts does not trim: a name with whitespace opens that file.
    expect(settingsDatabasePath(home, { POISE_DB: '  ' })).toBe('  ')
    expect(settingsDatabasePath(home, { POISE_DB: `${join(home, 'custom.db')} ` })).toBe(`${join(home, 'custom.db')} `)
  })
})

describe('reading saved settings outside the server', () => {
  it('reports nothing saved before the first start, without touching sqlite', async () => {
    const home = await temporaryHome()
    const run = vi.fn()
    expect(await readSavedSettings({ home, run, environment: {} })).toEqual({
      database: join(home, '.poise', 'cache.db'),
      present: false,
      settings: {},
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports nothing saved for the in-memory database, which has no file', async () => {
    const home = await temporaryHome()
    const run = vi.fn()
    const found = await readSavedSettings({ home, run, environment: { POISE_DB: ':memory:' } })
    expect(found).toEqual({ database: ':memory:', present: false, settings: {} })
    expect(run).not.toHaveBeenCalled()
  })

  it('reads org, human account and agent account from the configured database', async () => {
    const home = await temporaryHome()
    const database = join(home, 'custom.db')
    await writeFile(database, '')
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([
        { key: 'org', value: 'acme' },
        { key: 'me', value: 'alice' },
        { key: 'agentAccount', value: 'alice-bot' },
      ]),
      stderr: '',
    }))
    const found = await readSavedSettings({ home, run, environment: { POISE_DB: database } })
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toBe('/usr/bin/sqlite3')
    expect(run.mock.calls[0][1][1]).toBe(database)
    expect(found).toEqual({
      database,
      present: true,
      settings: { org: 'acme', me: 'alice', agentAccount: 'alice-bot' },
    })
  })

  it('tells a cleared value from one never saved', async () => {
    const home = await temporaryHome()
    const database = join(home, '.poise', 'cache.db')
    await mkdir(join(home, '.poise'), { recursive: true })
    await writeFile(database, '')
    const run = vi.fn(async () => ({ stdout: JSON.stringify([{ key: 'me', value: '' }]), stderr: '' }))
    const { present, settings } = await readSavedSettings({ home, run, environment: {} })
    expect(present).toBe(true)
    expect(settings).toEqual({ me: '' })
    expect('agentAccount' in settings).toBe(false)
  })
})

describe("a migration's explicit write to Settings", () => {
  it('inserts the key only when still absent, so a concurrent save wins', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await writeSavedSetting({ run, database: '/home/test/.poise/cache.db', key: 'me', value: 'octocat' })
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0][0]).toBe('/usr/bin/sqlite3')
    expect(run.mock.calls[0][1]).toEqual([
      '/home/test/.poise/cache.db',
      "INSERT INTO meta(key, value) VALUES ('me', 'octocat') ON CONFLICT(key) DO NOTHING;",
    ])
  })

  it('refuses an unknown key and escapes the value', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await expect(writeSavedSetting({ run, database: '/db', key: 'me\'; DROP', value: 'x' }))
      .rejects.toThrow('Cannot save unknown settings key')
    await writeSavedSetting({ run, database: '/db', key: 'me', value: "o'cat" })
    expect(run.mock.calls[0][1][1]).toContain("'o''cat'")
    expect(run).toHaveBeenCalledOnce()
  })
})
