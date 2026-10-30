import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
let database: typeof import('../server/db')
let alerts: typeof import('../server/alerts/store')
let storage: typeof import('../server/temporary-storage')
let notices: typeof import('../server/alerts/notices')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-storage-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  database = await import('../server/db')
  alerts = await import('../server/alerts/store')
  storage = await import('../server/temporary-storage')
  notices = await import('../server/alerts/notices')
})

beforeEach(() => {
  database.db.prepare('DELETE FROM alerts').run()
  database.db.prepare("DELETE FROM meta WHERE key = 'temporary_storage_warning_bucket'").run()
})

afterAll(async () => {
  await storage.stopTemporaryStorageRuntime()
  database.closeDatabase()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('temporary storage warnings', () => {
  it('warns at 5 GB and each GB below, with one current warning and no repetition', () => {
    const gb = storage.TEMPORARY_STORAGE_GB
    storage.temporaryStorageMeasured(6 * gb)
    expect(alerts.openAlerts()).toHaveLength(0)
    for (const level of [5, 4, 3, 2, 1]) {
      storage.temporaryStorageMeasured(level * gb)
      storage.temporaryStorageMeasured((level - 0.2) * gb)
      expect(alerts.openAlerts()).toMatchObject([{ kind: 'storage_low', title: `Temporary space is down to ${level} GB` }])
      expect(alerts.alertsAfter(0, 20)).toHaveLength(6 - level)
    }
    storage.temporaryStorageMeasured(0)
    expect(alerts.alertsAfter(0, 20)).toHaveLength(5)
    expect(notices.noticesState().notices).toMatchObject([{ kind: 'storage_low', target: null, silenceable: false }])
  })

  it('warns once per threshold in a low-space episode and rearms only after recovering to 6 GB', () => {
    const gb = storage.TEMPORARY_STORAGE_GB
    storage.temporaryStorageMeasured(3.5 * gb)
    expect(alerts.openAlerts()[0].title).toContain('4 GB')
    storage.temporaryStorageMeasured(4.5 * gb)
    storage.temporaryStorageMeasured(4.5 * gb)
    expect(alerts.openAlerts()[0].title).toContain('4 GB')
    expect(alerts.alertsAfter(0, 20)).toHaveLength(1)
    storage.temporaryStorageMeasured(3.5 * gb)
    expect(alerts.alertsAfter(0, 20)).toHaveLength(1)
    storage.temporaryStorageMeasured(2.5 * gb)
    expect(alerts.alertsAfter(0, 20)).toHaveLength(2)
    for (const free of [5.1, 4.9, 5.1, 4.9, 3.1, 2.9]) storage.temporaryStorageMeasured(free * gb)
    expect(alerts.alertsAfter(0, 20)).toHaveLength(2)
    storage.temporaryStorageMeasured(6 * gb)
    expect(alerts.openAlerts()).toHaveLength(0)
    storage.temporaryStorageMeasured(5 * gb)
    expect(alerts.openAlerts()[0].title).toContain('5 GB')
  })

  it('retains its warning across unreadable measurements and never rejects work', async () => {
    storage.temporaryStorageMeasured(storage.TEMPORARY_STORAGE_GB)
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(storage.checkTemporaryStorage(async () => { throw new Error('unavailable') })).resolves.toBeUndefined()
      expect(alerts.openAlerts()).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith('[storage] could not measure temporary space:', expect.any(Error))
      expect(database.getMeta('temporary_storage_warning_bucket')).toBe('1')
      for (const value of [NaN, Infinity, -1]) expect(() => storage.temporaryStorageMeasured(value)).toThrow()
    } finally {
      warn.mockRestore()
    }
  })

  it('persists its crossing so restarting the monitor does not repeat a warning', async () => {
    storage.temporaryStorageMeasured(4 * storage.TEMPORARY_STORAGE_GB)
    vi.resetModules()
    const restarted = await import('../server/temporary-storage')
    restarted.temporaryStorageMeasured(4 * storage.TEMPORARY_STORAGE_GB)
    expect(alerts.alertsAfter(0, 20)).toHaveLength(1)
    const connection = await import('../server/db')
    connection.closeDatabase()
  })
})
