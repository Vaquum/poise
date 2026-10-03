import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertCallerRelease, getCallerReleaseHealth } from '../server/caller-release'
import { CALLER_ROOT, callerVersions } from '../scripts/caller.mjs'

const versions = vi.hoisted(() => ({ failure: null as Error | null }))
vi.mock('../scripts/caller.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/caller.mjs')>()
  return {
    ...actual,
    callerVersions: async (root?: string) => {
      if (versions.failure) throw versions.failure
      return actual.callerVersions(root)
    },
  }
})

let root = ''
let bin = ''
let agent = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-caller-release-'))
  bin = join(root, 'bin')
  agent = join(root, 'agent_interface')
  await Promise.all([mkdir(bin), mkdir(agent)])
  for (const command of ['agent-interface', 'github-datastore', 'github-interface']) {
    const path = join(bin, command)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o700)
  }
  vi.stubEnv('CALLER_BIN_ROOT', bin)
  vi.stubEnv('AGENT_INTERFACE_ROOT', agent)
})

afterEach(async () => {
  versions.failure = null
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('Caller health', () => {
  it('is ready with runnable CLIs and reports the in-tree package versions', async () => {
    const packages = await callerVersions()
    expect(Object.keys(packages)).toEqual(['agent-interface', 'github-interface', 'github-datastore'])
    await expect(getCallerReleaseHealth()).resolves.toEqual({ status: 'ready', packages, error: null })
    await expect(assertCallerRelease()).resolves.toBeUndefined()
  })

  it('defaults to the virtualenv and agent-interface root in caller/', async () => {
    vi.stubEnv('CALLER_BIN_ROOT', '')
    vi.stubEnv('AGENT_INTERFACE_ROOT', '')
    const cli = join(CALLER_ROOT, '.venv', 'bin', 'agent-interface')
    // caller/.venv exists once `npm run caller:setup` has run in this checkout.
    await expect(getCallerReleaseHealth()).resolves.toMatchObject(existsSync(cli)
      ? { status: 'ready', error: null }
      : { status: 'invalid', error: `${cli} is missing or not runnable; run npm run caller:setup` })
  })

  it('is invalid when the checkout carries no Caller', async () => {
    versions.failure = new Error(`${join(CALLER_ROOT, 'agent_interface', 'pyproject.toml')}: ENOENT`)
    await expect(getCallerReleaseHealth()).resolves.toEqual({
      status: 'invalid',
      packages: {},
      error: `Caller is missing from this checkout: ${join(CALLER_ROOT, 'agent_interface', 'pyproject.toml')}: ENOENT`,
    })
    await expect(assertCallerRelease()).rejects.toThrow(/^Caller is not ready: Caller is missing from this checkout/)
  })

  it('is invalid when a CLI is missing, and production refuses to start', async () => {
    await rm(join(bin, 'github-interface'))
    await expect(getCallerReleaseHealth()).resolves.toMatchObject({
      status: 'invalid',
      error: `${join(bin, 'github-interface')} is missing or not runnable (CALLER_BIN_ROOT)`,
    })
    await expect(assertCallerRelease()).rejects.toThrow(/^Caller is not ready: .*github-interface is missing or not runnable/)
  })

  it('is invalid when a CLI is not executable or its interpreter is gone', async () => {
    await chmod(join(bin, 'agent-interface'), 0o600)
    expect((await getCallerReleaseHealth()).status).toBe('invalid')
    await chmod(join(bin, 'agent-interface'), 0o700)
    await writeFile(join(bin, 'github-datastore'), `#!${join(root, 'missing-python')}\n`)
    await expect(getCallerReleaseHealth()).resolves.toMatchObject({
      status: 'invalid',
      error: `${join(bin, 'github-datastore')} is missing or not runnable (CALLER_BIN_ROOT)`,
    })
  })

  it('is invalid without an agent-interface root', async () => {
    vi.stubEnv('AGENT_INTERFACE_ROOT', join(root, 'missing'))
    await expect(getCallerReleaseHealth()).resolves.toMatchObject({
      status: 'invalid',
      error: `agent-interface root ${join(root, 'missing')} is not a directory`,
    })
  })

  it('rejects relative Caller paths instead of resolving them against the working directory', async () => {
    vi.stubEnv('CALLER_BIN_ROOT', 'caller/.venv/bin')
    await expect(getCallerReleaseHealth()).resolves.toMatchObject({
      status: 'invalid',
      error: 'CALLER_BIN_ROOT must be an absolute path, got caller/.venv/bin',
    })
    vi.stubEnv('CALLER_BIN_ROOT', bin)
    vi.stubEnv('AGENT_INTERFACE_ROOT', 'agent_interface')
    expect((await getCallerReleaseHealth()).error).toBe('AGENT_INTERFACE_ROOT must be an absolute path, got agent_interface')
  })
})
