// No test can reach the developer's own agent CLIs or their logins. A test
// that reached the real `claude auth login` with only HOME replaced signed the
// developer's Claude out (its macOS Keychain entry follows CLAUDE_CONFIG_DIR),
// so now every test process runs with its own home folder and CLI
// configuration and with stand-ins first on PATH, and a Connect terminal in a
// test refuses, before anything starts, a preset whose CLI is not its fake.
// Every test process and the end-to-end server also run without the variables
// Poise's diagnostics redact as credentials, so a harness flag named like one
// cannot turn the digits a test reads back into "[redacted]".

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir, userInfo } from 'node:os'
import { delimiter, join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { ACCOUNT_IDS } from '../server/accounts/types'
import { TerminalSocketServer } from '../server/terminal/server'
import type { TerminalPreset } from '../server/terminal/protocol'
import { COMMANDS, STATUS, fakeCalls, resolveOnPath, script, writeFakeClis } from './fixtures/accounts/fake-clis'
import { fakePresetCommand } from './fixtures/accounts/fake-presets'
import { AGENT_CLI_NAMES, CLI_HOME_VARIABLES, credentialVariables, isolatedEnvironment, removeCredentialVariables } from './fixtures/cli-isolation'

// A parent environment like a Claude Code session's, which exports
// CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1, in some sessions
// USE_STAGING_OAUTH=0, and real tokens; with git configuration that carries
// a credential, too.
const PARENT_ENVIRONMENT = {
  CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
  USE_STAGING_OAUTH: '0',
  CLAUDE_CODE_MESSAGING_TOKEN: 'opaque-session-token',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic b3BhcXVlLWNyZWRlbnRpYWw=',
}

function inheritedCaches(root: string): Record<string, string> {
  return Object.fromEntries([
    'XDG_CACHE_HOME', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'npm_config_cache', 'AGENT_INTERFACE_WORK_DIR', 'GITHUB_INTERFACE_MIRROR_DIR',
  ].map((name) => [name, join(root, name)]))
}

describe('every test process', () => {
  it('has a home folder and agent-CLI configuration of its own', () => {
    const temp = realpathSync(tmpdir())
    // From the user database, whatever HOME says.
    const developer = userInfo().homedir
    for (const name of CLI_HOME_VARIABLES) {
      const value = process.env[name]
      expect(value, name).toBeTruthy()
      const real = realpathSync(value!)
      expect(real.startsWith(`${temp}${sep}`), `${name} is ${value}`).toBe(true)
      expect(real === developer || real.startsWith(`${developer}${sep}`), `${name} is ${value}`).toBe(false)
    }
    expect(homedir()).toBe(process.env.HOME)
  })

  it('keeps production cache discovery inside its fixture despite inherited cache overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poise-cache-isolation-'))
    try {
      const inherited = inheritedCaches(join(root, 'outside-fixture'))
      for (const dir of Object.values(inherited)) await mkdir(dir, { recursive: true })
      const parent: NodeJS.ProcessEnv = { ...process.env, ...inherited }
      const fixture = join(root, 'fixture')
      const env: NodeJS.ProcessEnv = { ...parent, ...isolatedEnvironment(fixture, parent.PATH ?? '') }
      const { cacheDirs } = await import('../server/storage-maintenance')
      for (const [name, path] of Object.entries(cacheDirs(env.HOME, env))) {
        expect(realpathSync(path).startsWith(`${realpathSync(fixture)}${sep}`), `${name} is ${path}`).toBe(true)
      }
      for (const [name, path] of Object.entries(inherited)) {
        expect(env[name], name).not.toBe(path)
        expect(parent[name], name).toBe(path)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps production workspace discovery inside its fixture', async () => {
    const fixture = realpathSync(resolve(process.env.HOME!, '../..'))
    const { LOCAL_CHAT_ROOT } = await import('../server/chat/local-workspace')
    const { poiseStateRoot } = await import('../server/review-checkout')
    expect(realpathSync(LOCAL_CHAT_ROOT).startsWith(`${fixture}${sep}`)).toBe(true)
    expect(resolve(poiseStateRoot()).startsWith(`${fixture}${sep}`)).toBe(true)
    expect(LOCAL_CHAT_ROOT).not.toBe(resolve('.poise-chat'))
  })

  it('finds a stand-in, never a real CLI, for every agent CLI name', () => {
    for (const name of AGENT_CLI_NAMES) {
      const found = resolveOnPath(name, process.env.PATH ?? '')
      expect(found, name).toMatch(new RegExp(`poise-home-isolation-[^${sep}]+\\${sep}stand-ins\\${sep}${name}$`))
      const run = spawnSync(found!, ['auth', 'login'], { encoding: 'utf8' })
      expect(run.status, name).toBe(127)
      expect(run.stderr).toContain(`${name} is a stand-in`)
    }
  })

  it('carries no variable whose value the diagnostics redact as a credential', () => {
    // Names only: a failure must not print the developer's tokens.
    expect(credentialVariables(process.env)).toEqual([])
  })

  it('runs git whatever git configuration its parent environment carries', () => {
    const git = spawnSync('git', ['config', '--list'], { encoding: 'utf8' })
    expect(git.status, git.stderr).toBe(0)
  })

  it('does both when started from a parent like a Claude Code session', async () => {
    // The same discovery checks in a fresh process with inherited host roots.
    const report = join(tmpdir(), `poise-cli-isolation-${process.pid}.json`)
    const inherited = await mkdtemp(join(tmpdir(), 'poise-inherited-storage-'))
    const sentinel = join(inherited, 'untouched')
    await writeFile(sentinel, 'parent storage')
    try {
      const run = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/cli-isolation.test.ts',
        '--testNamePattern', 'carries no variable|runs git|keeps production workspace discovery', '--reporter=json', `--outputFile=${report}`], {
        encoding: 'utf8', env: { ...process.env, ...PARENT_ENVIRONMENT, POISE_CHAT_ROOT: inherited, ...inheritedCaches(inherited) },
      })
      expect(existsSync(report), run.stderr).toBe(true)
      const result = JSON.parse(readFileSync(report, 'utf8')) as { numPassedTests: number, numFailedTests: number, testResults: { assertionResults: { failureMessages: string[] }[] }[] }
      const failures = result.testResults.flatMap((file) => file.assertionResults.flatMap((test) => test.failureMessages)).join('\n')
      expect({ passed: result.numPassedTests, failed: result.numFailedTests }, failures).toEqual({ passed: 3, failed: 0 })
      expect(readFileSync(sentinel, 'utf8')).toBe('parent storage')
    } finally {
      rmSync(report, { force: true })
      await rm(inherited, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('credential variables', () => {
  it('are the variables with a value the diagnostics redactor collects', () => {
    expect(credentialVariables({
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', USE_STAGING_OAUTH: '0', USE_LOCAL_OAUTH: '', GH_TOKEN: 'fixture',
      SSH_AUTH_SOCK: '/tmp/agent', PATH: '/bin', HOME: '/home/fixture',
    })).toEqual(['CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'USE_STAGING_OAUTH', 'GH_TOKEN', 'SSH_AUTH_SOCK'])
  })

  it('go with GIT_CONFIG_COUNT, which git refuses once the keys it counts are gone', () => {
    const env: NodeJS.ProcessEnv = { ...PARENT_ENVIRONMENT, PATH: '/bin' }
    removeCredentialVariables(env)
    expect(env).toEqual({ PATH: '/bin' })
  })
})

describe('a Connect terminal in a test', () => {
  let root = ''
  let bin = ''
  let home = ''
  let elsewhere = ''
  let ran = ''
  let http: Server | null = null
  let terminals: TerminalSocketServer | null = null

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'poise-cli-isolation-'))
    bin = join(root, 'fakes')
    home = join(root, 'home')
    elsewhere = join(root, 'elsewhere')
    ran = join(root, 'a-real-cli-ran')
    const prompt = 'Enter this one-time code: ABCD-1234\n'
    await writeFakeClis(bin, home, {
      claude: script('claude', STATUS.claudeSignedOut, { prompt }),
      codex: script('codex', STATUS.codexSignedOut, { prompt }),
      gh: script('gh', STATUS.ghSignedOut, { prompt }),
      grok: script('grok', undefined, { prompt }),
      muse: script('muse', undefined, { prompt }),
      antigravity: script('antigravity', undefined, { prompt }),
    })
    // Where the developer's real CLIs would be: each records that it ran.
    await mkdir(elsewhere)
    for (const name of AGENT_CLI_NAMES) {
      await writeFile(join(elsewhere, name), `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(ran)}\nexit 0\n`)
      await chmod(join(elsewhere, name), 0o755)
    }
    vi.stubEnv('HOME', home)
  })

  afterEach(async () => {
    await terminals?.close()
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()))
    http = null
    terminals = null
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  async function serve(): Promise<number> {
    terminals = new TerminalSocketServer({}, { command: fakePresetCommand(bin) })
    http = createServer()
    terminals.attach(http)
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve))
    return (http.address() as { port: number }).port
  }

  /** Opens a terminal for `preset`, answers its prompt with Enter, and
   *  resolves with how it closed and what it printed. */
  function connect(port: number, preset: TerminalPreset): Promise<{ code: number, reason: string, output: string }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?preset=${preset}`, { origin: `http://127.0.0.1:${port}` })
      let output = ''
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.type !== 'output') return
        output += Buffer.from(frame.data, 'base64').toString('utf8')
        if (output.includes('ABCD-1234') && !output.includes('\r\n\r\n')) socket.send(JSON.stringify({ type: 'input', data: '\r' }))
      })
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString(), output }))
      socket.once('error', reject)
    })
  }

  it('refuses before anything starts when the fake directory is not on PATH', async () => {
    // The fakes exist, but a real CLI comes first, then the stand-ins.
    vi.stubEnv('PATH', `${elsewhere}${delimiter}${process.env.PATH}`)
    const command = fakePresetCommand(bin)
    for (const id of ACCOUNT_IDS) {
      expect(() => command(id), id).toThrow(`${COMMANDS[id]} resolves to ${join(elsewhere, COMMANDS[id])}, not its fake in ${bin}`)
    }
    expect(() => command('shell')).toThrow('a test may not open the login shell')

    const port = await serve()
    for (const preset of ['claude', 'codex', 'gh'] as const) {
      const closed = await connect(port, preset)
      expect(closed.code, preset).toBe(1011)
      expect(closed.reason, preset).toContain(`${COMMANDS[preset]} resolves to `)
      expect(closed.output).toBe('')
    }
    expect(existsSync(ran)).toBe(false)
    expect(await fakeCalls(home)).toEqual([])
  })

  it('refuses when only the stand-ins are on PATH, too', async () => {
    expect(() => fakePresetCommand(bin)('claude')).toThrow(/claude resolves to .*stand-ins.*claude, not its fake/)
    const closed = await connect(await serve(), 'claude')
    expect(closed.code).toBe(1011)
    expect(existsSync(ran)).toBe(false)
  })

  it('runs the fake login once the fake directory comes first', async () => {
    vi.stubEnv('PATH', `${bin}${delimiter}${elsewhere}${delimiter}${process.env.PATH}`)
    const closed = await connect(await serve(), 'codex')
    expect(closed).toMatchObject({ code: 1000 })
    expect(closed.output).toContain('ABCD-1234')
    expect(existsSync(ran)).toBe(false)
    expect((await fakeCalls(home)).map((call) => `${call.name} ${call.args.join(' ')}`)).toEqual(['codex login --device-auth'])
  })
})

describe('the end-to-end server', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('starts without them from a parent like a Claude Code session', async () => {
    for (const [name, value] of Object.entries(PARENT_ENVIRONMENT)) vi.stubEnv(name, value)
    const inheritedRoot = await mkdtemp(join(tmpdir(), 'poise-e2e-inherited-caches-'))
    for (const [name, value] of Object.entries(inheritedCaches(inheritedRoot))) vi.stubEnv(name, value)
    vi.stubEnv('POISE_CHAT_ROOT', inheritedRoot)
    const { webServer } = (await import('../playwright.config')).default
    if (!webServer || Array.isArray(webServer)) throw new Error('playwright.config.ts starts one web server')
    try {
      // Playwright starts the server and its workers with the runner's
      // environment, and the server's own variables on top.
      const server = { ...process.env, ...webServer.env }
      expect(credentialVariables(server)).toEqual([])
      expect(server.GIT_CONFIG_COUNT).toBeUndefined()
      const { cacheDirs } = await import('../server/storage-maintenance')
      const isolationRoot = realpathSync(resolve(server.HOME!, '../..'))
      for (const [name, path] of Object.entries(cacheDirs(server.HOME, server))) {
        expect(realpathSync(path).startsWith(`${isolationRoot}${sep}`), `${name} is ${path}`).toBe(true)
      }
      vi.stubEnv('POISE_CHAT_ROOT', server.POISE_CHAT_ROOT)
      vi.resetModules()
      const { LOCAL_CHAT_ROOT } = await import('../server/chat/local-workspace')
      expect(realpathSync(LOCAL_CHAT_ROOT).startsWith(`${isolationRoot}${sep}`)).toBe(true)
      expect(LOCAL_CHAT_ROOT).not.toBe(inheritedRoot)
    } finally {
      rmSync(resolve(webServer.env!.HOME, '../..'), { recursive: true, force: true })
      await rm(inheritedRoot, { recursive: true, force: true })
    }
  })
})
