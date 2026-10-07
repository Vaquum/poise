import { beforeEach, expect, it, vi } from 'vitest'
import type { Catalog } from '../server/models'

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), finished: vi.fn() }))
vi.mock('../scripts/provider-cli-updates.mjs', () => ({ ensureProviderCli: mocks.ensure }))
vi.mock('../server/release-background', () => ({ trackReleaseBackground: () => mocks.finished }))
import { prepareModelClis } from '../server/provider-clis'

const catalog = { models: [{ identity: 'sol-max', provider: 'codex' }] } as Catalog
beforeEach(() => { mocks.ensure.mockReset(); mocks.finished.mockReset() })

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
