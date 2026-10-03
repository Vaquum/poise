// A workspace whose service configuration is missing or wrong must not start:
// the production entry stops before any module derives a path from it.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { gatewayKeys, serviceEnvironment } from './service-fixture'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-service-startup-'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('POISE_ENV_ROOT', root)
  vi.resetModules()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

it('names every missing variable before creating any state', async () => {
  vi.stubEnv('POISE_MODE', 'service')
  vi.stubEnv('POISE_WORKSPACE_HANDLE', 'octocat')
  for (const key of ['POISE_WORKSPACE_OWNER', 'POISE_PUBLIC_ORIGIN', 'POISE_GATEWAY_PUBLIC_KEY', 'POISE_DB']) vi.stubEnv(key, undefined)
  await expect(import('../server/production')).rejects.toThrow(
    'Poise cannot start in service mode: POISE_WORKSPACE_OWNER is required; POISE_PUBLIC_ORIGIN is required; POISE_GATEWAY_PUBLIC_KEY is required',
  )
  expect(existsSync(join(root, '.poise'))).toBe(false)
})

it('refuses an invalid variable', async () => {
  for (const [key, value] of Object.entries({ ...serviceEnvironment(gatewayKeys()), POISE_PUBLIC_ORIGIN: 'http://octocat.poise.example.com' })) vi.stubEnv(key, value)
  await expect(import('../server/production')).rejects.toThrow('POISE_PUBLIC_ORIGIN may use http only on a localhost, *.localhost or *.test host')
})

it('refuses a mode it does not know', async () => {
  vi.stubEnv('POISE_MODE', 'workspace')
  await expect(import('../server/production')).rejects.toThrow('POISE_MODE must be "service" or unset; it is "workspace"')
})
