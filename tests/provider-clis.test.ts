import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Catalog } from '../server/models'

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), finished: vi.fn(), providerFailure: vi.fn() }))
vi.unmock('../server/provider-clis')
vi.mock('../scripts/provider-cli-updates.mjs', () => ({ ensureProviderCli: mocks.ensure }))
vi.mock('../server/release-background', () => ({ trackReleaseBackground: () => mocks.finished }))
vi.mock('../server/alerts/producers', () => ({ providerFailure: mocks.providerFailure }))
import { prepareModelClis } from '../server/provider-clis'

const catalog = { models: [{ identity: 'sol-max', provider: 'codex' }] } as Catalog
beforeEach(() => { mocks.ensure.mockReset(); mocks.finished.mockReset(); vi.stubEnv('CODEX_CLI', '') })
afterEach(() => { vi.unstubAllEnvs() })

it('passes the verified immutable launcher to Caller, including a still usable older version', async () => {
  mocks.ensure.mockResolvedValue({ provider: 'codex', status: 'unavailable', before: '0.161.0',
    launchPath: '/immutable/codex/bin/codex.js', error: 'registry timeout' })
  expect(await prepareModelClis(catalog, ['sol-max', 'sol-max'])).toEqual({ CODEX_CLI: '/immutable/codex/bin/codex.js' })
  expect(mocks.ensure).toHaveBeenCalledTimes(1)
  expect(mocks.finished).toHaveBeenCalledTimes(1)
})

it('does not admit a review worker when no Codex launcher has passed its version check', async () => {
  mocks.ensure.mockResolvedValue({ provider: 'codex', status: 'unavailable', path: '/broken/codex', error: 'missing native dependency' })
  await expect(prepareModelClis(catalog, ['sol-max'])).rejects.toThrow('no verified launcher')
})

it('preserves the operator configured Codex wrapper for Caller workers', async () => {
  vi.stubEnv('CODEX_CLI', '/operator/codex-wrapper')
  mocks.ensure.mockResolvedValue({ provider: 'codex', status: 'current', launchPath: '/immutable/codex/bin/codex.js' })
  expect(await prepareModelClis(catalog, ['sol-max'])).toEqual({})
  expect(process.env.CODEX_CLI).toBe('/operator/codex-wrapper')
})

it('keeps a runnable review when its recovery CLI is unavailable and reports that provider once', async () => {
  const reviewCatalog = { models: [...catalog.models, { identity: 'opus', provider: 'claude' }] } as Catalog
  mocks.ensure.mockImplementation(async (provider) => provider === 'claude'
    ? { status: 'current', launchPath: '/fixture/claude' }
    : { status: 'unavailable', error: 'broken installation' })
  expect(await prepareModelClis(reviewCatalog, ['opus', 'sol-max'], true)).toEqual({})
  expect(mocks.providerFailure).toHaveBeenCalledExactlyOnceWith('codex', expect.stringContaining('broken installation'))
})
