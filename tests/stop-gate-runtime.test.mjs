import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CALLER_ROOT, callerVersions } from '../scripts/caller.mjs'
import {
  configureStopGate,
  installStopGate,
  stopGateIsCurrent,
  stopGateManifest,
} from '../scripts/stop-gate-runtime.mjs'

const manifest = {
  source: '/production/caller',
  commit: 'a'.repeat(40),
  packages: {
    'agent-interface': '0.3.0',
    'github-interface': '0.2.0',
    'github-datastore': '0.2.0',
  },
}
const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), 'poise-stop-gate-'))
  roots.push(home)
  return home
}

async function executable(path) {
  await writeFile(path, '#!/bin/sh\n')
  await chmod(path, 0o700)
}

const SAVED = JSON.stringify([
  { key: 'agentAccount', value: 'review-bot' },
  { key: 'me', value: 'octocat' },
  { key: 'org', value: 'Vaquum' },
])

// Poise has started at least once: its database holds saved settings.
async function savedPoise(home) {
  await mkdir(join(home, '.poise'), { recursive: true })
  await writeFile(join(home, '.poise', 'cache.db'), '')
}

async function configuredEnvironment(home, sqlite, environment) {
  const bin = join(home, '.local', 'share', 'caller-pr-stop-gate', 'bin')
  await mkdir(bin, { recursive: true })
  await executable(join(bin, 'agent-interface'))
  const run = vi.fn(async (command) => (command === '/usr/bin/sqlite3' ? { stdout: sqlite, stderr: '' } : { stdout: '', stderr: '' }))
  await configureStopGate({ home, run, environment })
  return { env: run.mock.lastCall[2].env, run }
}

describe('stop-gate runtime reconciliation', () => {
  it('creates a missing runtime, records its release, and configures both hooks', async () => {
    const home = await temporaryHome()
    const hookRoot = join(home, '.local', 'share', 'caller-pr-stop-gate')
    const bin = join(hookRoot, 'bin')
    const calls = []
    const run = vi.fn(async (command, args, options = {}) => {
      calls.push({ command, args, options })
      if (command === '/python3.13') {
        await mkdir(bin, { recursive: true })
        await executable(join(bin, 'python'))
        return { stdout: '', stderr: '' }
      }
      if (command === join(bin, 'python') && args.includes('pip')) {
        await executable(join(bin, 'agent-interface'))
        await executable(join(bin, 'github-interface'))
        return { stdout: '', stderr: '' }
      }
      if (command === '/usr/bin/sqlite3') return { stdout: SAVED, stderr: '' }
      return { stdout: '', stderr: '' }
    })
    await savedPoise(home)

    await installStopGate({
      home,
      manifest,
      python: '/python3.13',
      run,
    })

    expect(await stopGateIsCurrent({ home, manifest })).toBe(true)
    expect(JSON.parse(await readFile(join(hookRoot, 'release.json'), 'utf8'))).toEqual(manifest)
    const install = calls.find((call) => call.command === join(bin, 'python') && call.args.includes('pip'))
    expect(install.args.slice(-2)).toEqual(['/production/caller/github_interface', '/production/caller/agent_interface'])
    const configuration = calls.find((call) => call.args[0] === '--install-pr-stop-gate')
    expect(configuration.options.env).toMatchObject({
      CALLER_PR_GATE_SCOPE: 'Vaquum/*',
      GITHUB_INTERFACE_AGENT_USER: 'review-bot',
      CALLER_GITHUB_READER: 'octocat',
    })
  })

  it('names the in-tree Caller it installs from, and treats any other as stale', async () => {
    expect(await stopGateManifest({ callerRoot: CALLER_ROOT, commit: manifest.commit })).toEqual({
      source: CALLER_ROOT,
      commit: manifest.commit,
      packages: await callerVersions(),
    })
    const home = await temporaryHome()
    const hookRoot = join(home, '.local', 'share', 'caller-pr-stop-gate')
    await mkdir(join(hookRoot, 'bin'), { recursive: true })
    for (const name of ['python', 'agent-interface', 'github-interface']) await executable(join(hookRoot, 'bin', name))
    await writeFile(join(hookRoot, 'release.json'), JSON.stringify(manifest))
    expect(await stopGateIsCurrent({ home, manifest })).toBe(true)
    for (const changed of [{ source: '/elsewhere/caller' }, { commit: 'b'.repeat(40) }, { packages: { 'agent-interface': '0.4.0' } }]) {
      expect(await stopGateIsCurrent({ home, manifest: { ...manifest, ...changed } })).toBe(false)
    }
    // A gate installed from a pinned Caller release before Caller moved in-tree.
    await writeFile(join(hookRoot, 'release.json'), JSON.stringify({
      repository: 'mikkokotila/caller', ref: 'main', commit: manifest.commit, packages: manifest.packages,
    }))
    expect(await stopGateIsCurrent({ home, manifest })).toBe(false)
  })

  it('reapplies hook configuration without reinstalling packages', async () => {
    const home = await temporaryHome()
    const bin = join(home, '.local', 'share', 'caller-pr-stop-gate', 'bin')
    await mkdir(bin, { recursive: true })
    await executable(join(bin, 'agent-interface'))
    const run = vi.fn(async (command) => (
      command === '/usr/bin/sqlite3'
        ? { stdout: SAVED, stderr: '' }
        : { stdout: '', stderr: '' }
    ))
    await savedPoise(home)

    await configureStopGate({ home, run })

    expect(run).toHaveBeenLastCalledWith(
      join(bin, 'agent-interface'),
      ['--install-pr-stop-gate'],
      expect.objectContaining({
        env: expect.objectContaining({ CALLER_PR_GATE_SCOPE: 'Vaquum/*', GITHUB_INTERFACE_AGENT_USER: 'review-bot' }),
      }),
    )
  })

  it('before Poise has started, waits for the agent account REVIEW_AGENT_USERNAME will seed', async () => {
    const home = await temporaryHome()
    const { env, run } = await configuredEnvironment(home, '', { REVIEW_AGENT_USERNAME: 'seed-bot' })
    expect(run.mock.calls.some(([command]) => command === '/usr/bin/sqlite3')).toBe(false)
    expect(env).toEqual({ REVIEW_AGENT_USERNAME: 'seed-bot', GITHUB_INTERFACE_AGENT_USER: 'seed-bot' })
  })

  it('once Poise has saved the agent account, Settings decides, cleared included', async () => {
    const home = await temporaryHome()
    await savedPoise(home)
    expect((await configuredEnvironment(home, SAVED, { REVIEW_AGENT_USERNAME: 'seed-bot' })).env)
      .toMatchObject({ GITHUB_INTERFACE_AGENT_USER: 'review-bot', CALLER_GITHUB_READER: 'octocat' })
    const cleared = JSON.stringify([{ key: 'agentAccount', value: '' }])
    expect((await configuredEnvironment(home, cleared, { REVIEW_AGENT_USERNAME: 'seed-bot' })).env)
      .toEqual({ REVIEW_AGENT_USERNAME: 'seed-bot' })
  })

  it('refuses a saved account that is not a GitHub login', async () => {
    const home = await temporaryHome()
    await savedPoise(home)
    await expect(configuredEnvironment(home, JSON.stringify([{ key: 'agentAccount', value: 'not a login' }]), {}))
      .rejects.toThrow('Configured agent account is invalid')
  })
})
