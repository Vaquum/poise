// No test can reach the developer's own agent CLIs or their logins. A test
// that reached the real `claude auth login` with only HOME replaced signed the
// developer's Claude out (its macOS Keychain entry follows CLAUDE_CONFIG_DIR),
// so now every test process runs with its own home folder and CLI
// configuration and with stand-ins first on PATH, and a Connect terminal in a
// test refuses, before anything starts, a preset whose CLI is not its fake.

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir, userInfo } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { ACCOUNT_IDS } from '../server/accounts/types'
import { TerminalSocketServer } from '../server/terminal/server'
import type { TerminalPreset } from '../server/terminal/protocol'
import { COMMANDS, STATUS, fakeCalls, resolveOnPath, script, writeFakeClis } from './fixtures/accounts/fake-clis'
import { fakePresetCommand } from './fixtures/accounts/fake-presets'
import { AGENT_CLI_NAMES, CLI_HOME_VARIABLES } from './fixtures/cli-isolation'

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

  it('finds a stand-in, never a real CLI, for every agent CLI name', () => {
    for (const name of AGENT_CLI_NAMES) {
      const found = resolveOnPath(name, process.env.PATH ?? '')
      expect(found, name).toMatch(new RegExp(`poise-home-isolation-[^${sep}]+\\${sep}stand-ins\\${sep}${name}$`))
      const run = spawnSync(found!, ['auth', 'login'], { encoding: 'utf8' })
      expect(run.status, name).toBe(127)
      expect(run.stderr).toContain(`${name} is a stand-in`)
    }
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
