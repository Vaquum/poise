import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type ConfigModule = typeof import('../../src/config')

let config: ConfigModule

beforeAll(async () => {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })
  config = await import('../../src/config')
})

beforeEach(() => {
  vi.useFakeTimers()
  config.setLocalSettings({ org: '', me: '', timezone: 'UTC' })
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('settings cache', () => {
  it('starts a fresh post-write read and rejects a pre-write snapshot arriving later', async () => {
    const releases: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { releases.push(resolve) })))
    const previous = config.loadSettings()
    const saved = config.loadSettings({ fresh: true })
    expect(releases).toHaveLength(2)
    const current = { org: 'acme', me: 'new-owner', timezone: 'Europe/Helsinki', models: { chat: { default: 'new', fallback: 'backup' } } }
    releases[1](new Response(JSON.stringify(current)))
    await saved
    releases[0](new Response(JSON.stringify({ ...current, me: 'old-owner', timezone: 'UTC', models: {} })))
    await previous
    expect(config.getSettings()).toEqual(current)
  })

  it('shares concurrent reads without letting an older read replace a later save', async () => {
    const prior = { org: 'acme', me: 'octocat', timezone: 'UTC' }
    let release!: (response: Response) => void
    const request = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    vi.stubGlobal('fetch', request)
    const first = config.loadSettings(), second = config.loadSettings()
    expect(first).toBe(second)
    expect(request).toHaveBeenCalledTimes(1)
    config.setLocalSettings({ ...prior, me: 'new-owner' })
    release(new Response(JSON.stringify(prior)))
    await first
    expect(config.getSettings().me).toBe('new-owner')
  })

  it('loads valid server settings into the synchronous cache', async () => {
    const settings = { org: 'acme', me: 'octocat', timezone: 'Europe/Helsinki' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(settings), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))

    await expect(config.loadSettings()).resolves.toEqual(settings)
    expect(config.getSettings()).toEqual(settings)
    expect(config.settingsLoaded()).toBe(true)
    expect(config.settingsReady()).toBe(true)
  })

  it('does not overwrite a saved model with an older in-flight refresh', async () => {
    const previous = { org: 'acme', me: 'octocat', timezone: 'UTC', models: {} }
    const saved = { ...previous, models: { chat: { default: 'grok-4.6-xhigh', fallback: 'opus-5-max' } } }
    let resolve!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done })))
    const loading = config.loadSettings()
    config.setLocalSettings(saved)
    resolve(new Response(JSON.stringify(previous), { status: 200 }))
    await expect(loading).resolves.toEqual(saved)
    expect(config.getSettings().models).toEqual(saved.models)
  })

  it('keeps the prior cache when the settings request fails', async () => {
    const prior = { org: 'acme', me: 'octocat', timezone: 'UTC' }
    config.setLocalSettings(prior)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    await expect(config.loadSettings()).resolves.toEqual(prior)
    expect(config.getSettings()).toEqual(prior)
  })
})

describe('configured timezone boundaries', () => {
  it('returns local midnight across standard and daylight time', () => {
    config.setLocalSettings({ org: 'acme', me: 'octocat', timezone: 'Europe/Helsinki' })

    vi.setSystemTime(new Date('2026-01-14T12:00:00.000Z'))
    expect(config.midnightInZone().toISOString()).toBe('2026-01-13T22:00:00.000Z')

    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'))
    expect(config.midnightInZone().toISOString()).toBe('2026-07-09T21:00:00.000Z')
  })

  it('starts the local week at Monday midnight', () => {
    config.setLocalSettings({ org: 'acme', me: 'octocat', timezone: 'Europe/Helsinki' })
    vi.setSystemTime(new Date('2026-01-14T12:00:00.000Z'))

    expect(config.startOfWeekInZone().toISOString()).toBe('2026-01-11T22:00:00.000Z')
  })
})


it('keeps midnight before the DST transition on both clock-change days', () => {
  config.setLocalSettings({ org: '', me: '', timezone: 'Europe/Helsinki' })
  vi.setSystemTime(new Date('2026-03-29T12:00:00Z'))
  expect(config.midnightInZone().toISOString()).toBe('2026-03-28T22:00:00.000Z')
  expect(config.midnightInZone(1).toISOString()).toBe('2026-03-29T21:00:00.000Z')
  vi.setSystemTime(new Date('2026-10-25T12:00:00Z'))
  expect(config.midnightInZone().toISOString()).toBe('2026-10-24T21:00:00.000Z')
  expect(config.midnightInZone(1).toISOString()).toBe('2026-10-25T22:00:00.000Z')
})
