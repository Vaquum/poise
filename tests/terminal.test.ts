// The terminal: the Python pseudo-terminal helper, the process around it, and
// the /ws/terminal WebSocket with its limits and its trust boundary. Every
// program here is a /bin/sh script; no preset's real login ever runs.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { CLAUDE_SUBSCRIPTION_CLI } from '../server/process'
import { readServiceConfig } from '../server/service/config'
import { PTY_HELPER } from '../server/terminal/helper'
import { presetCommand } from '../server/terminal/presets'
import { PtyProcess, type TerminalCommand, type TerminalProcess } from '../server/terminal/pty'
import { OUTPUT_HIGH_WATER, OUTPUT_LOW_WATER, TerminalSession, TerminalSocketServer, type TerminalServerOptions } from '../server/terminal/server'
import type { TerminalPreset, TerminalServerFrame } from '../server/terminal/protocol'
import { HANDLE, PUBLIC_HOST, PUBLIC_ORIGIN, gatewayKeys, serviceEnvironment, signAssertion } from './service-fixture'

let home = ''
beforeAll(async () => { home = await mkdtemp(join(tmpdir(), 'poise-terminal-')) })
afterAll(async () => { await rm(home, { recursive: true, force: true }) })

function sh(script: string, env: NodeJS.ProcessEnv = {}): TerminalCommand {
  return { command: '/bin/sh', args: ['-c', script], env: { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', ...env }, cwd: home }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until<T>(read: () => T | undefined | null | false, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function watch(pty: PtyProcess) {
  let output = ''
  pty.on('output', (chunk) => { output += chunk.toString('utf8') })
  const exit = new Promise<number>((resolve) => pty.once('exit', resolve))
  return { output: () => output, exit }
}

describe('the pseudo-terminal helper', () => {
  it('runs a program on a terminal and relays its input and output', async () => {
    const pty = new PtyProcess(sh('echo hi; read x; echo got:$x'), { cols: 80, rows: 24 })
    const seen = watch(pty)
    await until(() => seen.output().includes('hi'), 'hi')
    pty.write(Buffer.from('abc\n'))
    expect(await seen.exit).toBe(0)
    // The terminal echoes what was typed, as a terminal does.
    expect(seen.output()).toBe('hi\r\nabc\r\ngot:abc\r\n')
  })

  it('starts the program at the size asked for and resizes it', async () => {
    const pty = new PtyProcess(sh('stty size; read x; stty size'), { cols: 80, rows: 24 })
    const seen = watch(pty)
    await until(() => seen.output().includes('24 80'), 'the first size')
    pty.resize({ cols: 132, rows: 43 })
    pty.write(Buffer.from('\n'))
    expect(await seen.exit).toBe(0)
    expect(seen.output()).toContain('43 132')
  })

  it('exits with the program\'s code, or 128 and the signal that ended it', async () => {
    expect(await watch(new PtyProcess(sh('exit 3'), { cols: 80, rows: 24 })).exit).toBe(3)
    expect(await watch(new PtyProcess(sh('kill -TERM $$'), { cols: 80, rows: 24 })).exit).toBe(143)
  })

  it('says on the terminal why a program cannot start, and exits 127', async () => {
    const pty = new PtyProcess({ ...sh(''), command: 'no-such-login-command', args: [] }, { cols: 80, rows: 24 })
    const seen = watch(pty)
    expect(await seen.exit).toBe(127)
    expect(seen.output()).toContain('poise-pty: cannot run no-such-login-command: No such file or directory')
  })

  it('hangs up the program\'s whole process group when closed', async () => {
    const pty = new PtyProcess(sh('sleep 30 & echo pids:$$:$!; wait'), { cols: 80, rows: 24 })
    const seen = watch(pty)
    const [, shell, child] = (await until(() => /pids:(\d+):(\d+)/.exec(seen.output()), 'the pids')).map(Number)
    pty.close()
    expect(await seen.exit).toBe(129)
    await until(() => !alive(shell) && !alive(child), 'the group to be gone')
  })

  it('kills a program that ignores the hang-up', async () => {
    const pty = new PtyProcess(sh('trap "" HUP; echo pid:$$; while :; do sleep 1; done'), { cols: 80, rows: 24 })
    const seen = watch(pty)
    const pid = Number((await until(() => /pid:(\d+)/.exec(seen.output()), 'the pid'))[1])
    pty.close()
    expect(await seen.exit).toBe(137)
    expect(alive(pid)).toBe(false)
  })

  it('fails loudly when python3 is not on the PATH', async () => {
    const pty = new PtyProcess(sh('echo never', { PATH: '/nonexistent' }), { cols: 80, rows: 24 })
    const error = new Promise<Error>((resolve) => pty.once('error', resolve))
    const seen = watch(pty)
    expect((await error).message).toBe('The terminal needs python3 on Poise\'s PATH, and there is none.')
    expect(await seen.exit).toBe(127)
  })

  it('refuses a control line that is not a resize, and arguments it cannot use', async () => {
    const run = (args: string[], control?: string) => new Promise<{ code: number | null, stderr: string }>((resolve) => {
      const child = spawn('python3', ['-I', '-c', PTY_HELPER, ...args], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.stdout.resume()
      if (control) (child.stdio[3] as Writable).write(control)
      child.on('close', (code) => resolve({ code, stderr }))
    })
    expect(await run(['80', '24', '/bin/sh', '-c', 'sleep 5'], 'resize 80\n')).toEqual({ code: 2, stderr: 'poise-pty: unknown control line b\'resize 80\'\n' })
    expect(await run(['0', '24', '/bin/sh'])).toEqual({ code: 2, stderr: 'poise-pty: cols and rows must be whole numbers from 1 to 1000\n' })
    expect(await run(['80', '24'])).toMatchObject({ code: 2, stderr: expect.stringContaining('usage:') })
  })
})

describe('the terminal presets', () => {
  it('run each CLI\'s own login, Claude\'s through Poise\'s wrapper, in the home folder', () => {
    vi.stubEnv('HOME', home)
    vi.stubEnv('GH_TOKEN', 'ghp_environment_token')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-environment-key')
    vi.stubEnv('CONFAB_API_KEY', 'confab-key')
    try {
      const claude = presetCommand('claude')
      expect(claude).toMatchObject({ command: CLAUDE_SUBSCRIPTION_CLI, args: ['auth', 'login', '--claudeai'], cwd: home })
      expect(claude.env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', CLAUDE_CLI: CLAUDE_SUBSCRIPTION_CLI, HOME: home })
      expect(claude.env).not.toHaveProperty('ANTHROPIC_API_KEY')
      expect(presetCommand('codex')).toMatchObject({ command: 'codex', args: ['login', '--device-auth'] })
      const gh = presetCommand('gh')
      expect(gh).toMatchObject({ command: 'gh', args: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'] })
      // gh refuses to log in while a token is set in its environment.
      expect(gh.env).not.toHaveProperty('GH_TOKEN')
      expect(presetCommand('grok')).toMatchObject({ command: 'grok', args: ['login', '--device-auth'] })
      expect(presetCommand('muse')).toMatchObject({ command: 'muse', args: ['login'] })
      expect(presetCommand('antigravity')).toMatchObject({ command: 'agy', args: [] })
      const shell = presetCommand('shell')
      expect(shell).toMatchObject({ command: userInfo().shell, args: ['-l'], cwd: home })
      for (const env of [shell.env, presetCommand('codex').env]) {
        expect(env).not.toHaveProperty('CONFAB_API_KEY')
        expect(env).not.toHaveProperty('GH_TOKEN')
        expect(env).toMatchObject({ TERM: 'xterm-256color' })
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// ── The WebSocket ─────────────────────────────────────────────────────────

interface Peer { origin?: string, host?: string, identity?: string, peer?: string, headers?: Record<string, string> }

let http: Server | null = null
let terminals: TerminalSocketServer | null = null
let port = 0
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await terminals?.close()
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()))
  http = null
  terminals = null
})

async function serve(programs: Partial<Record<TerminalPreset, string>>, options: Omit<TerminalServerOptions, 'command'> = {}, policy: ConstructorParameters<typeof TerminalSocketServer>[0] = {}) {
  terminals = new TerminalSocketServer(policy, {
    ...options,
    command: (preset) => sh(programs[preset] ?? `echo "no program for ${preset}"; exit 64`),
  })
  http = createServer((_req, res) => { res.statusCode = 404; res.end() })
  // A request from the gateway's network, as the service-mode tests do it.
  http.prependListener('upgrade', (req: IncomingMessage) => {
    const peer = req.headers['x-test-peer']
    if (typeof peer === 'string') Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true })
  })
  terminals.attach(http)
  await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve))
  port = (http.address() as { port: number }).port
  return terminals
}

interface Session {
  socket: WebSocket
  frames: TerminalServerFrame[]
  output: () => string
  closed: Promise<{ code: number, reason: string }>
}

function local(): Peer {
  return { origin: `http://127.0.0.1:${port}` }
}

function open(preset: string, peer: Peer = local()): Promise<Session | { status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?preset=${encodeURIComponent(preset)}`, {
      ...(peer.origin ? { origin: peer.origin } : {}),
      headers: {
        ...(peer.host ? { host: peer.host } : {}),
        ...(peer.identity ? { 'x-poise-identity': peer.identity } : {}),
        ...(peer.peer ? { 'x-test-peer': peer.peer } : {}),
        ...peer.headers,
      },
    })
    sockets.push(socket)
    const frames: TerminalServerFrame[] = []
    const closed = new Promise<{ code: number, reason: string }>((done) => socket.once('close', (code, reason) => done({ code, reason: reason.toString() })))
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
    socket.once('open', () => resolve({
      socket, frames, closed,
      output: () => frames.filter((frame) => frame.type === 'output').map((frame) => Buffer.from(frame.data, 'base64').toString('utf8')).join(''),
    }))
    socket.once('unexpected-response', (_request, response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }); socket.terminate() })
    })
    socket.once('error', (error) => { if (socket.readyState !== WebSocket.CLOSED) reject(error) })
  })
}

async function opened(preset: string, peer?: Peer): Promise<Session> {
  const result = await open(preset, peer)
  if (!('socket' in result)) throw new Error(`the terminal was refused with ${result.status}: ${result.body}`)
  return result
}

function send(session: Session, frame: unknown): void {
  session.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
}

describe('the terminal WebSocket', () => {
  it('relays a preset\'s output and input, then its exit', async () => {
    const server = await serve({ codex: 'echo "Enter this one-time code: ABCD-1234"; read x; echo "got:$x"' })
    const exits: Array<[TerminalPreset, number]> = []
    server.on('exit', (preset, code) => exits.push([preset, code]))
    const session = await opened('codex')
    await until(() => session.output().includes('ABCD-1234'), 'the prompt')
    // xterm.js sends Enter as a carriage return.
    send(session, { type: 'input', data: 'done\r' })
    expect(await session.closed).toEqual({ code: 1000, reason: 'exited' })
    expect(session.output()).toContain('got:done')
    expect(session.frames.at(-1)).toEqual({ type: 'exit', code: 0 })
    expect(session.frames.slice(0, -1).every((frame) => frame.type === 'output')).toBe(true)
    expect(exits).toEqual([['codex', 0]])
  })

  it('resizes the terminal when the browser does', async () => {
    await serve({ shell: 'stty size; read x; stty size' })
    const session = await opened('shell')
    await until(() => session.output().includes('24 80'), 'the first size')
    send(session, { type: 'resize', cols: 120, rows: 30 })
    send(session, { type: 'input', data: '\r' })
    await session.closed
    expect(session.output()).toContain('30 120')
  })

  it('refuses a preset it does not know', async () => {
    await serve({})
    expect(await open('bash')).toEqual({ status: 400, body: 'preset must be one of claude, codex, gh, grok, muse, antigravity, shell' })
    expect(await open('')).toMatchObject({ status: 400 })
  })

  it('holds the upgrade to the same origin and host as the API', async () => {
    await serve({ shell: 'exit 0' })
    expect(await open('shell', { origin: 'https://evil.example' })).toEqual({ status: 403, body: 'request origin is not allowed' })
    expect(await open('shell', { ...local(), headers: { 'sec-fetch-site': 'cross-site' } })).toEqual({ status: 403, body: 'cross-site API requests are not allowed' })
    expect(await open('shell', { origin: 'http://rebound.example', host: 'rebound.example' })).toEqual({ status: 403, body: 'host is not allowed' })
    // Without an Origin it is no browser, so only this machine may connect.
    expect(await open('shell', { peer: '192.0.2.7' })).toEqual({ status: 403, body: 'non-browser API requests must originate from loopback' })
  })

  it('closes a terminal that sends a frame it cannot read, and hangs up its program', async () => {
    await serve({ shell: 'echo pid:$$; exec sleep 30' })
    for (const [frame, code] of [
      ['not json', 1007],
      [{ type: 'paste', data: 'x' }, 1007],
      [{ type: 'input', data: 7 }, 1007],
      [{ type: 'resize', cols: 1, rows: 24 }, 1007],
      [{ type: 'resize', cols: 80, rows: 201 }, 1007],
      [{ type: 'resize', cols: 80.5, rows: 24 }, 1007],
    ] as Array<[unknown, number]>) {
      const session = await opened('shell')
      const pid = Number((await until(() => /pid:(\d+)/.exec(session.output()), 'the pid'))[1])
      send(session, frame)
      expect((await session.closed).code, JSON.stringify(frame)).toBe(code)
      await until(() => !alive(pid), 'the program to be hung up')
    }
    const binary = await opened('shell')
    binary.socket.send(Buffer.from('raw'), { binary: true })
    expect((await binary.closed).code).toBe(1003)
  })

  it('runs at most two terminals at once and refuses a third with a clear message', async () => {
    const server = await serve({ shell: 'echo ready; exec sleep 30' })
    const first = await opened('shell')
    const second = await opened('shell')
    await until(() => first.output().includes('ready') && second.output().includes('ready'), 'two terminals')
    const third = await opened('shell')
    expect(await third.closed).toEqual({ code: 1013, reason: 'At most 2 terminals can be open at a time; close one first.' })
    expect(third.frames).toEqual([])
    first.socket.close()
    await until(() => server.size === 1, 'the first terminal to end')
    const fourth = await opened('shell')
    await until(() => fourth.output().includes('ready'), 'a new terminal')
  })

  it('closes a terminal after its idle time and hangs up its program', async () => {
    await serve({ shell: 'echo pid:$$; exec sleep 30' }, { idleMs: 400 })
    const session = await opened('shell')
    const pid = Number((await until(() => /pid:(\d+)/.exec(session.output()), 'the pid'))[1])
    expect(await session.closed).toEqual({ code: 4000, reason: 'Closed after 400 idle milliseconds.' })
    await until(() => !alive(pid), 'the program to be hung up')
  })

  it('keeps a terminal that is in use past its idle time', async () => {
    await serve({ shell: 'while read x; do echo "got:$x"; done' }, { idleMs: 600 })
    const session = await opened('shell')
    for (let i = 0; i < 5; i += 1) {
      send(session, { type: 'input', data: `${i}\r` })
      await until(() => session.output().includes(`got:${i}`), `echo ${i}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(session.socket.readyState).toBe(WebSocket.OPEN)
  })

  it('hangs up the program when the browser goes away', async () => {
    const server = await serve({ gh: 'echo pid:$$; exec sleep 30' })
    const session = await opened('gh')
    const pid = Number((await until(() => /pid:(\d+)/.exec(session.output()), 'the pid'))[1])
    session.socket.terminate()
    await until(() => !alive(pid) && server.size === 0, 'the program to be hung up')
  })

  it('hangs up every terminal when Poise stops', async () => {
    const server = await serve({ shell: 'echo pid:$$; exec sleep 30' })
    const session = await opened('shell')
    const pid = Number((await until(() => /pid:(\d+)/.exec(session.output()), 'the pid'))[1])
    await server.close()
    expect(alive(pid)).toBe(false)
    expect((await session.closed).code).toBe(1001)
  })

  it('closes with the reason when the terminal cannot start', async () => {
    terminals = new TerminalSocketServer({}, { command: () => sh('exit 0', { PATH: '/nonexistent' }) })
    http = createServer()
    terminals.attach(http)
    await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve))
    port = (http.address() as { port: number }).port
    const session = await opened('shell')
    expect(await session.closed).toEqual({ code: 1011, reason: 'The terminal needs python3 on Poise\'s PATH, and there is none.' })
    await until(() => terminals!.size === 0, 'the session to end')
  })
})

describe('the terminal WebSocket in service mode', () => {
  const gateway = gatewayKeys()
  const service = readServiceConfig(serviceEnvironment(gateway))!
  const GATEWAY_PEER = '172.18.0.2'
  const fromGateway = (scope: string, claims: Record<string, unknown> = {}): Peer => ({
    peer: GATEWAY_PEER, host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, identity: signAssertion(gateway.privateKey, { scope, ...claims }),
  })

  it('opens only to the owner\'s browser through the gateway', async () => {
    await serve({ codex: 'echo signed in; exit 0' }, {}, { service })
    expect(await open('codex', { peer: GATEWAY_PEER, host: PUBLIC_HOST, origin: PUBLIC_ORIGIN })).toEqual({ status: 401, body: 'an identity assertion from the gateway is required' })
    expect(await open('codex', fromGateway('link'))).toEqual({ status: 403, body: 'an identity assertion with the link scope does not reach this route' })
    expect(await open('codex', fromGateway('admin'))).toEqual({ status: 403, body: 'an identity assertion with the admin scope does not reach this route' })
    expect(await open('codex', fromGateway('browser', { iat: 1, exp: 61 }))).toEqual({ status: 401, body: 'the identity assertion has expired' })
    expect(await open('codex', fromGateway('browser', { aud: 'workspace:hubot' }))).toEqual({ status: 401, body: 'the identity assertion is for another workspace' })
    expect(await open('codex', { ...fromGateway('browser'), identity: signAssertion(gatewayKeys().privateKey) })).toEqual({ status: 401, body: 'the identity assertion signature does not verify' })
    expect(await open('codex', { ...fromGateway('browser'), origin: 'https://evil.example' })).toEqual({ status: 403, body: 'request origin is not allowed' })
    expect(await open('codex', { ...fromGateway('browser'), host: `poise-ws-${HANDLE}:5555` })).toEqual({ status: 403, body: 'host is not allowed' })
    expect(await open('codex', { ...fromGateway('browser'), headers: { 'sec-fetch-site': 'cross-site' } })).toEqual({ status: 403, body: 'cross-site API requests are not allowed' })
    expect(await open('codex', { ...fromGateway('browser'), headers: { cookie: 'poise_ws=session', authorization: 'Bearer device-token' }, identity: undefined })).toMatchObject({ status: 401 })

    const session = await opened('codex', fromGateway('browser'))
    await session.closed
    expect(session.output()).toContain('signed in')
    expect(session.frames.at(-1)).toEqual({ type: 'exit', code: 0 })
  })
})

describe('a terminal session\'s flow control', () => {
  class FakeSocket extends EventEmitter {
    readyState: number = WebSocket.OPEN
    bufferedAmount = 0
    paused = false
    readonly pending: Array<() => void> = []
    send(data: string, sent: (error?: Error) => void) {
      this.bufferedAmount += Buffer.byteLength(data)
      this.pending.push(() => { this.bufferedAmount -= Buffer.byteLength(data); sent() })
    }
    close() { this.readyState = WebSocket.CLOSED }
    terminate() { this.readyState = WebSocket.CLOSED }
    pause() { this.paused = true }
    resume() { this.paused = false }
  }
  class FakePty extends EventEmitter {
    paused = false
    writable = true
    pause() { this.paused = true }
    resume() { this.paused = false }
    write() { return this.writable }
    resize() {}
    close() {}
  }
  const start = () => {
    const socket = new FakeSocket()
    const pty = new FakePty()
    new TerminalSession(socket as unknown as WebSocket, pty as unknown as TerminalProcess, { idleMs: 60_000, onExit: () => {}, onEnd: () => {} })
    return { socket, pty }
  }

  it('stops reading output while the browser is too far behind, until it catches up', () => {
    const { socket, pty } = start()
    const chunk = Buffer.alloc(256 * 1024, 'x')
    while (!pty.paused) pty.emit('output', chunk)
    expect(socket.bufferedAmount).toBeGreaterThan(OUTPUT_HIGH_WATER)
    // Delivered, but still above the low-water mark: stay paused.
    while (socket.bufferedAmount - Buffer.byteLength(JSON.stringify({ type: 'output', data: chunk.toString('base64') })) > OUTPUT_LOW_WATER) {
      socket.pending.shift()!()
      expect(pty.paused).toBe(true)
    }
    socket.pending.shift()!()
    expect(pty.paused).toBe(false)
  })

  it('stops reading input while the program is not taking it', () => {
    const { socket, pty } = start()
    pty.writable = false
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'a long paste' })), false)
    expect(socket.paused).toBe(true)
    pty.emit('drain')
    expect(socket.paused).toBe(false)
  })
})
