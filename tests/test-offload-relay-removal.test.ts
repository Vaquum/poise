// A release install that disables test offload removes ~/.poise/test-offload/relay
// while the workspace keeps running. A child launched in that window must start
// without the hooks rather than fail reading the removed file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({ readRelay: 'real' as 'real' | 'enoent' | 'eacces' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const [path] = args
    if (control.readRelay !== 'real' && typeof path === 'string'
      && (path.endsWith('/test-offload/relay') || path.endsWith('\\test-offload\\relay'))) {
      const error = new Error(`mocked relay read ${control.readRelay}: ${path}`) as NodeJS.ErrnoException
      error.code = control.readRelay === 'enoent' ? 'ENOENT' : 'EACCES'
      throw error
    }
    return (actual.readFileSync as (...call: unknown[]) => unknown)(...args)
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync }
})

import { scrubbedChildEnvironment } from '../server/process'

const temporary: string[] = []
afterEach(() => {
  control.readRelay = 'real'
  vi.unstubAllEnvs()
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function installedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'test-offload-relay-removal-'))
  temporary.push(home)
  const hooks = join(home, '.poise', 'test-offload')
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, 'relay'), 'https://relay.example.com\nkey\n900\n')
  writeFileSync(join(hooks, 'hook.cjs'), '')
  vi.stubEnv('HOME', home)
  return home
}

it('starts a child without the hooks when relay is removed before its read', () => {
  installedHome()
  // The existence check saw relay; the release installer removed it before the read.
  control.readRelay = 'enoent'
  const env = scrubbedChildEnvironment('agent-interface')
  for (const name of ['PYTHONPATH', 'NODE_OPTIONS', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS']) {
    expect(env[name]).toBeUndefined()
  }
})

it('still fails loud when the relay read fails for another reason', () => {
  installedHome()
  control.readRelay = 'eacces'
  expect(() => scrubbedChildEnvironment('agent-interface')).toThrow('mocked relay read eacces')
})
