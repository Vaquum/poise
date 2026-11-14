// Poise in service mode, end to end through the production server: the
// requests a workspace container gets from the gateway (from another address
// on the container network) and from its own health check (loopback), with
// every piece of state under an isolated home folder.

import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import Database from 'better-sqlite3'
import { Context } from '../gateway/src/context'
import { EnvironmentCollectors } from '../gateway/src/diagnostics/collectors'
import { DiagnosticRuntime } from '../gateway/src/diagnostics/runtime'
import { DiagnosticStore } from '../gateway/src/diagnostics/store'
import { startHarness } from '../gateway/tests/harness'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { STATUS, assertFakeClis, script, writeFakeClis } from './fixtures/accounts/fake-clis'
import { fakePresetCommand } from './fixtures/accounts/fake-presets'
import { CATALOG } from './model-catalog-fixture'
import { HANDLE, OWNER, PUBLIC_HOST, PUBLIC_ORIGIN, gatewayKeys, serviceEnvironment, signAssertion } from './service-fixture'

const gateway = gatewayKeys()
const auth = createAuthenticatedClaudeAuth()
const GATEWAY_PEER = '172.18.0.2'
let root = ''
let home = ''
let bin = ''
let callerLog = ''
let server: Server
let port = 0
let production: typeof import('../server/production')
let turnedOff: typeof import('../server/service/turned-off')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-service-mode-'))
  home = join(root, 'home')
  bin = join(root, 'bin')
  callerLog = join(root, 'caller-calls.jsonl')
  const staticDir = join(root, 'client')
  await Promise.all([home, bin, join(root, 'agent'), join(staticDir, 'assets')].map((dir) => mkdir(dir, { recursive: true })))
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Poise workspace</title>')
  await writeFile(join(staticDir, 'assets', 'app.js'), 'export {}')
  // A stand-in Caller: records how it was started, answers --models (held
  // while a hold file exists, unreadable while a fail file does), and holds a
  // call open until its release file exists.
  await writeFile(join(bin, 'fake-caller.cjs'), `
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callerLog)}, JSON.stringify({ args, dataDir: process.env.AGENT_INTERFACE_DATA_DIR ?? null }) + '\\n')
const models = () => process.stdout.write(fs.existsSync(${JSON.stringify(join(root, 'fail-models'))}) ? 'not a catalogue' : ${JSON.stringify(JSON.stringify(CATALOG))})
if (args[0] === '--models') {
  if (!fs.existsSync(${JSON.stringify(join(root, 'hold-models'))})) models()
  else { const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(join(root, 'hold-models'))})) { clearInterval(timer); models() } }, 20) }
}
else if (args[0] === '--wait') { const timer = setInterval(() => { if (fs.existsSync(args[1])) clearInterval(timer) }, 20) }
else if (args[0] === '--reclaim-native-resources') {
  fs.writeFileSync(${JSON.stringify(join(root, 'cleanup-started'))}, '')
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(join(root, 'hold-cleanup'))})) return
    clearInterval(timer)
    fs.rmSync(require('node:path').join(process.env.AGENT_INTERFACE_DATA_DIR, 'native-resources', 'a'.repeat(32)), {recursive: true})
    const Database = require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))})
    const db = new Database(require('node:path').join(process.env.AGENT_INTERFACE_DATA_DIR, 'calls.sqlite3'))
    db.prepare('UPDATE calls SET resources_settled_at = ?, resource_cleanup = NULL WHERE id = ?').run(1234, 'a'.repeat(32))
    db.close()
    process.stdout.write(JSON.stringify({version: 1, examined: 1, released: ['a'.repeat(32)], held: []}))
  }, 20)
}
else process.stdout.write('[]')
`)
  await writeFile(join(bin, 'agent-interface'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, 'fake-caller.cjs'))} "$@"\n`)
  await chmod(join(bin, 'agent-interface'), 0o755)
  // Every agent CLI is a fake ahead of the real ones on PATH: the accounts
  // and the terminal never reach a real CLI or a real login.
  const loginPrompt = 'Open https://example.test/device and enter ABCD-1234\n'
  await writeFakeClis(bin, home, {
    claude: script('claude', STATUS.claudeSignedOut, { prompt: loginPrompt, afterLogin: STATUS.claudeSubscription }),
    codex: script('codex', STATUS.codexSignedOut, { prompt: loginPrompt, afterLogin: STATUS.codexChatGpt }),
    gh: script('gh', STATUS.ghTwoAccounts, { prompt: loginPrompt }),
    grok: script('grok', undefined, { prompt: loginPrompt }),
    muse: script('muse', undefined, { prompt: loginPrompt }),
    antigravity: script('antigravity', undefined, { prompt: loginPrompt }),
  })

  // Caller's CLIs run from CALLER_BIN_ROOT: here, the stand-in above. The
  // agent CLIs' fakes come first on PATH.
  for (const [key, value] of Object.entries({ ...serviceEnvironment(gateway), POISE_WORKSPACE_OWNER_ID: '1001', HOME: home, CALLER_BIN_ROOT: bin, AGENT_INTERFACE_ROOT: join(root, 'agent'), PATH: `${bin}${delimiter}${process.env.PATH}` })) {
    vi.stubEnv(key, value)
  }
  // Nothing in this file may reach a real CLI, least of all a real login: the
  // whole file stops here unless every CLI resolves to its fake, and each
  // Connect terminal checks its own CLI again before it starts.
  assertFakeClis(bin)
  // Everything else defaults under ~/.poise, as it does in a workspace.
  for (const key of ['POISE_DB', 'POISE_CHAT_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'AGENT_INTERFACE_DATA_DIR', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR',
    'POISE_MODEL_CATALOG_REPORT', 'POISE_PRODUCTION_UPDATE_REPORT', 'POISE_SELF_UPDATE_ROOT', 'POISE_LOCK_DIR', 'POISE_DATASTORE_DB']) {
    vi.stubEnv(key, undefined)
  }
  vi.resetModules()
  production = await import('../server/production')
  turnedOff = await import('../server/service/turned-off')
  // The container listens on every interface; the test binds loopback only.
  server = production.createProductionServer({ host: '0.0.0.0', staticDir, claudeAuth: auth, terminalCommand: fakePresetCommand(bin), reviewAgentUsername: 'bit-mis' })
  const fromGatewayNetwork = (req: IncomingMessage) => {
    const peer = req.headers['x-test-peer']
    if (typeof peer === 'string') Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true })
  }
  server.prependListener('request', fromGatewayNetwork)
  server.prependListener('upgrade', fromGatewayNetwork)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  // Codex was configured here, so its signed-out CLI raises the sign-in
  // demand the accounts tests expect, and clears it once signed in again.
  const { setMeta } = await import('../server/db')
  setMeta('account_logins', JSON.stringify({ codex: '2026-10-20T06:00:00.000Z' }))
})

afterAll(async () => {
  await production.shutdownProductionServer(server)
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

interface Reply { status: number, headers: IncomingHttpHeaders, text: string, json: any }

interface Caller { peer?: string, identity?: string, host?: string, origin?: string, headers?: Record<string, string> }

/** The gateway forwarding the owner's browser (or another scope). */
function fromGateway(scope = 'browser', claims: Record<string, unknown> = {}): Caller {
  return { peer: GATEWAY_PEER, identity: signAssertion(gateway.privateKey, { scope, ...claims }), origin: PUBLIC_ORIGIN }
}

function send(method: string, path: string, caller: Caller = {}, body?: unknown): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: {
        host: caller.host ?? (caller.peer ? PUBLIC_HOST : `127.0.0.1:${port}`),
        accept: 'application/json, text/html',
        ...(caller.origin ? { origin: caller.origin } : {}),
        ...(caller.identity ? { 'x-poise-identity': caller.identity } : {}),
        ...(caller.peer ? { 'x-test-peer': caller.peer } : {}),
        ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
        ...caller.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: unknown = null
        try { json = JSON.parse(text) } catch { /* a document */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

type SocketOutcome = { open: WebSocket } | { status: number }

function openChatSocket(caller: Caller): Promise<SocketOutcome> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`, {
      ...(caller.origin ? { origin: caller.origin } : {}),
      headers: {
        host: caller.host ?? (caller.peer ? PUBLIC_HOST : `127.0.0.1:${port}`),
        ...(caller.identity ? { 'x-poise-identity': caller.identity } : {}),
        ...(caller.peer ? { 'x-test-peer': caller.peer } : {}),
        ...caller.headers,
      },
    })
    socket.once('open', () => resolve({ open: socket }))
    socket.once('unexpected-response', (_request, response) => {
      resolve({ status: response.statusCode ?? 0 })
      response.destroy()
      socket.terminate()
    })
    socket.once('error', (error) => { if (socket.readyState !== WebSocket.CLOSED) reject(error) })
  })
}

interface TerminalOutcome { status: number, output: string, frames: Array<{ type: string, code?: number }>, close: number }

/** A terminal through the gateway (or not): refused with a status, or opened
 *  and driven to its end, typing Enter once the program asks for it. */
function runTerminal(preset: string, caller: Caller): Promise<TerminalOutcome> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?preset=${preset}`, {
      ...(caller.origin ? { origin: caller.origin } : {}),
      headers: {
        host: caller.host ?? (caller.peer ? PUBLIC_HOST : `127.0.0.1:${port}`),
        ...(caller.identity ? { 'x-poise-identity': caller.identity } : {}),
        ...(caller.peer ? { 'x-test-peer': caller.peer } : {}),
        ...caller.headers,
      },
    })
    let output = ''
    const frames: Array<{ type: string, code?: number }> = []
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      frames.push(frame)
      if (frame.type !== 'output') return
      output += Buffer.from(frame.data, 'base64').toString('utf8')
      if (output.includes('ABCD-1234') && !output.includes('\r\n\r\n')) socket.send(JSON.stringify({ type: 'input', data: '\r' }))
    })
    socket.once('close', (close) => resolve({ status: 101, output, frames, close }))
    socket.once('unexpected-response', (_request, response) => {
      resolve({ status: response.statusCode ?? 0, output, frames, close: 0 })
      response.destroy()
      socket.terminate()
    })
    socket.once('error', (error) => { if (socket.readyState !== WebSocket.CLOSED) reject(error) })
  })
}

/** A WebSocket upgrade over a bare socket: what the server answers, and
 *  whether it closes the connection rather than leaving it open. */
function rawUpgrade(path: string, caller: Caller): Promise<{ status: number, closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let answer = ''
    const result = (closed: boolean) => ({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0), closed })
    const deadline = setTimeout(() => { socket.destroy(); resolve(result(false)) }, 3_000)
    socket.on('data', (chunk: Buffer) => { answer += chunk.toString('latin1') })
    socket.on('close', () => { clearTimeout(deadline); resolve(result(true)) })
    socket.on('error', reject)
    const headers: Record<string, string> = {
      host: caller.host ?? (caller.peer ? PUBLIC_HOST : `127.0.0.1:${port}`),
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      ...(caller.origin ? { origin: caller.origin } : {}),
      ...(caller.identity ? { 'x-poise-identity': caller.identity } : {}),
      ...(caller.peer ? { 'x-test-peer': caller.peer } : {}),
    }
    socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`)
  })
}

/** The sign-in alerts recorded so far, by dedupe key: open, or resolved. */
async function signInAlerts(): Promise<Record<string, 'open' | 'resolved'>> {
  const { db } = await import('../server/db')
  const rows = db.prepare('SELECT dedupe_key AS key, resolved_at AS resolved FROM alerts WHERE kind = \'sign_in_needed\' ORDER BY id').all() as Array<{ key: string, resolved: string | null }>
  return Object.fromEntries(rows.map((row) => [row.key, row.resolved === null ? 'open' : 'resolved']))
}

async function callerCalls(): Promise<Array<{ args: string[], dataDir: string | null }>> {
  if (!existsSync(callerLog)) return []
  return (await readFile(callerLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

describe('Poise in service mode', () => {
  it('serves workspace identity and read capabilities through the dedicated MCP assertion', async () => {
    const mcp = { resource: 'https://poise.example.test/mcp', ownerId: 1001, handle: 'octocat', grantId: '12345678-1234-1234-1234-123456789abc' }
    const read = { name: 'poise_describe', arguments: {} }
    const description = await send('POST', '/api/mcp/read', fromGateway('mcp', { mcp }), read)
    expect(description.status).toBe(200)
    expect(description.json).toEqual({ workspace: 'octocat', owner: OWNER, capabilities: { tools: ['poise_describe', 'poise_work'] } })
    for (const scope of ['browser', 'link', 'admin']) {
      expect((await send('POST', '/api/mcp/read', fromGateway(scope), read)).status).toBe(403)
    }
    expect((await send('POST', '/api/mcp/read', { host: PUBLIC_HOST }, read)).status).toBe(401)
    expect((await send('GET', '/api/settings', fromGateway('mcp', { mcp }))).status).toBe(403)
    expect((await send('POST', '/api/mcp/read', fromGateway('mcp', { mcp }), { name: 'poise_work' })).status).toBe(400)
  })

  it('keeps its state in the home volume and passes Caller its data directory there', async () => {
    expect(existsSync(join(home, '.poise', 'cache.db'))).toBe(true)
    expect((await import('../server/chat/local-workspace')).LOCAL_CHAT_ROOT).toBe(join(home, '.poise', 'chat'))
    expect((await import('../server/snippets')).MATCH_FILE).toBe(join(home, '.poise', 'snippets', 'poise.yml'))

    const models = await send('GET', '/api/models', fromGateway())
    expect(models.status).toBe(200)
    expect((await callerCalls()).find((call) => call.args[0] === '--models')).toEqual({ args: ['--models'], dataDir: join(home, '.poise', 'agent-interface') })
  })

  it('serves the workspace to its owner through the gateway and to nobody else', async () => {
    const page = await send('GET', '/', fromGateway())
    expect(page.status).toBe(200)
    expect(page.text).toContain('Poise workspace')
    expect((await send('GET', '/assets/app.js', fromGateway())).status).toBe(200)
    expect((await send('GET', '/api/settings', fromGateway())).status).toBe(200)

    expect((await send('GET', '/', { peer: GATEWAY_PEER })).status).toBe(401)
    expect((await send('GET', '/', fromGateway('link'))).status).toBe(403)
    expect((await send('GET', '/', fromGateway('admin'))).status).toBe(403)
    expect((await send('GET', '/', { ...fromGateway(), identity: signAssertion(gateway.privateKey, { iat: 1, exp: 61 }) })).status).toBe(401)
    expect((await send('GET', '/', { ...fromGateway(), identity: signAssertion(gatewayKeys().privateKey) })).status).toBe(401)
    expect((await send('GET', '/', { ...fromGateway(), host: 'poise-ws-octocat:5555' })).status).toBe(403)
    expect((await send('GET', '/api/settings', { peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN })).status).toBe(401)
    expect((await send('GET', '/api/settings', { ...fromGateway(), origin: `http://${PUBLIC_HOST}` })).status).toBe(403)
    expect((await send('GET', '/api/settings', fromGateway('link'))).status).toBe(403)

    // The container's own processes keep the local rules.
    expect((await send('GET', '/')).status).toBe(200)
    expect((await send('GET', '/api/settings')).status).toBe(200)
  })

  it('never serves Logging environment history through the service workspace query path', async () => {
    const now = Math.floor(Date.now() / 1000)
    const invalid = ['malformed', signAssertion(gatewayKeys().privateKey),
      ...[{ iat: 1, exp: 61 }, { iss: 'foreign' }, { aud: 'workspace:other' }, { sub: 'other' },
        { iat: now + 120, exp: now + 180 }, { exp: now + 3600 }, { scope: 'unknown' }].map((claims) => signAssertion(gateway.privateKey, claims))]
    for (const path of ['/api/logging', '/api/logging/health', '/api/logging/export', '/api/logging/events/evt_' + '0'.repeat(16) + '_' + '0'.repeat(64), '/api/logging?incidentId=inc_' + '0'.repeat(16) + '_' + '0'.repeat(64)]) {
      expect((await send('GET', path)).status).toBe(404)
      expect((await send('GET', path, fromGateway())).status).toBe(404)
      expect((await send('GET', path, { peer: GATEWAY_PEER })).status).toBe(401)
      for (const identity of invalid) expect((await send('GET', path, { ...fromGateway(), identity })).status).toBe(401)
      for (const scope of ['link', 'admin']) expect((await send('GET', path, fromGateway(scope))).status).toBe(403)
      expect((await send('GET', path, { ...fromGateway(), origin: 'https://foreign.test' })).status).toBe(403)
      expect((await send('GET', path, { ...fromGateway(), host: 'foreign.test' })).status).toBe(403)
    }
  })

  it('answers the container health check and the gateway\'s admin scope only', async () => {
    const health = await send('GET', '/api/service/health')
    expect(health.status).toBe(200)
    // Background passes (the /content finalizer every two seconds) can count for a moment.
    expect(health.json).toEqual({ ok: true, mode: 'service', version: null, activeChatTurns: 0, runningCallerCalls: 0, unsettledNativeCalls: 0, backgroundWork: expect.any(Number), idle: expect.any(Boolean), draining: false, release: null, switching: null, repairExhaustionRepositories: '', eventLoop: expect.any(Object), desiredRelease: null, installedRelease: null, pendingSince: null, switchWaitingOn: null })
    expect(health.json.idle).toBe(health.json.backgroundWork === 0)
    expect(await send('GET', '/api/service/health', fromGateway('admin'))).toMatchObject({ status: 200, json: { mode: 'service' } })
    expect((await send('GET', '/api/service/health', fromGateway('browser'))).status).toBe(403)
    expect((await send('GET', '/api/service/health', fromGateway('link'))).status).toBe(403)
    expect((await send('GET', '/api/service/health', { peer: GATEWAY_PEER })).status).toBe(401)
    expect((await send('POST', '/api/service/drain', fromGateway('browser'))).status).toBe(403)
    expect((await send('GET', '/api/settings', fromGateway('admin'))).status).toBe(403)
  })

  it('accepts the gateway\'s own calls: an admin assertion on the public Host, no Origin', async () => {
    const gatewayCall: Caller = {
      peer: GATEWAY_PEER,
      identity: signAssertion(gateway.privateKey, { scope: 'admin' }),
      headers: { 'x-forwarded-for': GATEWAY_PEER, 'x-forwarded-proto': 'https', 'x-forwarded-host': PUBLIC_HOST },
    }
    expect(await send('GET', '/api/service/health', gatewayCall)).toMatchObject({ status: 200, json: { mode: 'service', draining: false } })
    expect(await send('POST', '/api/service/drain', { ...gatewayCall, identity: signAssertion(gateway.privateKey, { scope: 'admin' }) })).toMatchObject({ status: 200, json: { draining: true } })
    expect(await send('POST', '/api/service/resume', { ...gatewayCall, identity: signAssertion(gateway.privateKey, { scope: 'admin' }) })).toMatchObject({ status: 200, json: { draining: false } })
  })

  it('delivers an authenticated bounded diagnostic page within five seconds while Caller drains a backlog', async () => {
    const logging = await import('../server/logging')
    const processes = await import('../server/process')
    await logging.stopLogging()
    const previousEvents = process.env.POISE_LOG_QUEUE_EVENTS, previousBytes = process.env.POISE_LOG_QUEUE_BYTES
    vi.stubEnv('POISE_LOG_QUEUE_EVENTS', '10000')
    vi.stubEnv('POISE_LOG_QUEUE_BYTES', String(16 * 1024 * 1024))
    const h = await startHarness()
    h.store.saveSignIn({ handle: HANDLE, login: OWNER, githubId: 1001, accessOrg: null })
    const central = new DiagnosticRuntime({ path: join(root, 'delivery-central.db'), report: () => undefined })
    let releaseCaller!: (result: { stdout: string; stderr: string }) => void
    const originalRun = processes.runFile
    const run = vi.spyOn(processes, 'runFile').mockImplementation((command, args, options) => command === 'agent-interface' && args[0] === '--diagnostics'
      ? new Promise((resolve, reject) => {
        releaseCaller = resolve
        options?.signal?.addEventListener('abort', () => reject(new Error('fixture diagnostics stopped')), { once: true })
      }) : originalRun(command, args, options))
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    logging.startLogging()
    const source = logging.loggingRuntime()!
    const checkpointPath = join(home, '.poise', 'logging.db.caller')
    const checkpoint = () => existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')).cursor as number : null
    const before = checkpoint()
    let clientStarted = 0, elapsed = 0, queuedAtHandler = 0, checkpointAtHandler: number | null = null
    let flushMs = 0, maxFlushMs = 0, batches = 0
    const flush = source.flush.bind(source)
    const flushing = vi.spyOn(source, 'flush').mockImplementation(() => {
      const started = performance.now(), result = flush(), duration = performance.now() - started
      flushMs += duration; maxFlushMs = Math.max(maxFlushMs, duration); batches++
      return result
    })
    const deliver = central.deliver.bind(central)
    vi.spyOn(central, 'deliver').mockImplementation((...args) => {
      elapsed = performance.now() - clientStarted
      expect(args[0].length).toBeLessThanOrEqual(3)
      return deliver(...args)
    })
    const peer = (req: IncomingMessage) => {
      if (req.headers.host !== PUBLIC_HOST) return
      Object.defineProperty(req.socket, 'remoteAddress', { value: GATEWAY_PEER, configurable: true })
      if (req.url === '/api/service/diagnostics') {
        queuedAtHandler = source.localSnapshot().queued
        checkpointAtHandler = checkpoint()
      }
    }
    server.prependListener('request', peer)
    const callerPage = { version: 1, streamId: 'a'.repeat(32), cursor: 3, hasMore: false, backfillPending: false,
      events: [{ id: 'b'.repeat(32), error: 'loaded Caller diagnostic cause' }] }
    const context = new Context({ ...h.context.deps, config: { ...h.config, domain: 'poise.example.test' },
      keys: { privateKey: gateway.privateKey, publicKeyBase64: gateway.publicKey }, upstream: () => {
        clientStarted = performance.now()
        queueMicrotask(() => releaseCaller({ stdout: JSON.stringify(callerPage), stderr: '' }))
        return { host: '127.0.0.1', port }
      } })
    vi.spyOn(h.context.deps.docker, 'diagnosticContainers').mockResolvedValue([])
    vi.spyOn(h.context.deps.docker, 'diagnosticRead').mockResolvedValue(Buffer.alloc(0))
    const collector = new EnvironmentCollectors(central, h.context.deps.docker, context)
    const workers: Worker[] = []
    try {
      // Concurrent CLI/test processes compete for CPU with the workspace event loop.
      await Promise.all(Array.from({ length: 8 }, () => new Promise<void>((resolve, reject) => {
        const worker = new Worker(`const { parentPort } = require('node:worker_threads');
          const until = Date.now() + 60_000; parentPort.postMessage('ready'); while (Date.now() < until) {}`, { eval: true })
        workers.push(worker); worker.once('message', () => resolve()); worker.once('error', reject)
      })))
      source.flush()
      for (let i = 0; i < 7000; i++) expect(logging.diagnostic({ id: 'loaded-' + i, level: 'error', operation: 'loaded.failure',
        message: 'Concurrent workspace diagnostic backlog', stack: 'frame\n'.repeat(100) })).not.toBeNull()
      expect(source.localSnapshot().queued).toBe(7000)
      collector.start()
      await vi.waitFor(() => expect(central.health().sources.some(row => row.id === 'workspace:' + HANDLE)).toBe(true), { timeout: 30_000 })
      await collector.stop()
      await Promise.all(workers.map(worker => worker.terminate()))
      console.info(`[diagnostic delivery] response=${elapsed.toFixed(0)}ms, flushes=${batches}, totalFlush=${flushMs.toFixed(0)}ms, maxFlush=${maxFlushMs.toFixed(0)}ms, queuedAtHandler=${queuedAtHandler}`)
      expect(central.query(db => db.checkpoint('workspace:' + HANDLE))).not.toBeNull()
      expect(elapsed).toBeLessThan(5000)
      expect(queuedAtHandler).toBeGreaterThan(0)
      expect(checkpointAtHandler).toBe(before)
      await vi.waitFor(() => expect(checkpoint()).toBe(3), { timeout: 30_000 })
      expect(source.query(db => db.query({ workspace: HANDLE, operator: false }, { source: 'caller', search: 'loaded Caller diagnostic cause' })).total).toBe(1)
      expect((await send('GET', '/api/service/diagnostics', fromGateway('admin'))).status).toBe(200)
      for (const caller of [fromGateway('browser'), fromGateway('link'), fromGateway('admin', { sub: 'another-owner' }), fromGateway('admin', { aud: 'workspace:another' })]) {
        expect((await send('GET', '/api/service/diagnostics', caller)).status).not.toBe(200)
      }
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()))
      await collector.stop(); await logging.stopLogging()
      server.off('request', peer); flushing.mockRestore(); run.mockRestore(); stderr.mockRestore()
      central.stop(); context.agent.destroy(); await h.close()
      vi.stubEnv('POISE_LOG_QUEUE_EVENTS', previousEvents); vi.stubEnv('POISE_LOG_QUEUE_BYTES', previousBytes)
      logging.startLogging()
    }
  }, 60_000)

  it('accepts only trusted service reporting configuration and validates explicit repository scope', async () => {
    const path = '/api/service/config'
    const configuration = { repairExhaustionRepositories: 'acme/one, Acme/two' }
    for (const [caller, status] of [
      [fromGateway('browser'), 403], [fromGateway('link'), 403],
      [{ peer: GATEWAY_PEER }, 401],
      [fromGateway('admin', { iat: 1, exp: 61 }), 401],
      [fromGateway('admin', { aud: 'workspace:another' }), 401],
      [fromGateway('admin', { sub: 'another' }), 401],
      [{ ...fromGateway('admin'), identity: signAssertion(gatewayKeys().privateKey, { scope: 'admin' }) }, 401],
      [{ ...fromGateway('admin'), origin: 'https://foreign.test' }, 403],
      [{ ...fromGateway('admin'), host: 'foreign.test' }, 403],
    ] as const) expect((await send('POST', path, caller, configuration)).status).toBe(status)
    expect((await send('GET', '/api/service/health')).json.repairExhaustionRepositories).toBe('')
    expect((await send('GET', path, fromGateway('admin'))).status).toBe(405)
    for (const value of [undefined, null, [], '*', 'acme', 'acme/*', 'acme/one,', 'https://github.com/acme/one']) {
      expect((await send('POST', path, fromGateway('admin'), { repairExhaustionRepositories: value })).status).toBe(400)
    }
    // The gateway carries the public Host and its signed identity without a browser Origin.
    expect(await send('POST', path, { ...fromGateway('admin'), origin: undefined }, configuration))
      .toMatchObject({ status: 200, json: configuration })
    expect((await send('GET', '/api/service/health')).json).toMatchObject(configuration)
    expect(await send('POST', path, fromGateway('admin'), { repairExhaustionRepositories: '' }))
      .toMatchObject({ status: 200, json: { repairExhaustionRepositories: '' } })
  })

  it('never takes a cookie or an Authorization header for an identity', async () => {
    const credentials = { cookie: 'poise_ws=session; poise_gw=apex', authorization: 'Bearer device-token' }
    for (const [method, path] of [['GET', '/'], ['GET', '/api/settings'], ['GET', '/api/service/health'], ['GET', '/api/link/hello'], ['POST', '/api/service/drain']]) {
      expect((await send(method, path, { peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN, headers: credentials })).status, `${method} ${path}`).toBe(401)
    }
    expect(await openChatSocket({ peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN, headers: credentials })).toEqual({ status: 401 })
    expect((await send('GET', '/api/service/health')).json).toMatchObject({ draining: false })
  })

  it('drains new Chat work and launches until it is resumed', async () => {
    const background = await import('../server/release-background')
    expect(await send('POST', '/api/service/drain', fromGateway('admin'))).toMatchObject({ status: 200, json: { draining: true, activeChatTurns: 0, runningCallerCalls: 0 } })
    expect(background.releaseBackgroundPaused()).toBe(true)
    expect((await send('GET', '/api/service/health')).json).toMatchObject({ draining: true })

    for (const [path, body] of [
      ['/api/pr-review', { url: 'https://github.com/acme/app/pull/1' }],
      ['/api/agent-replay', { behavior: 'pr_review', repo: 'acme/app', pr_id: '1' }],
      ['/api/chat-content', { topic: 'Release notes', session: 'chat-1' }],
      ['/api/debate', { topic: 'Ship it?' }],
      ['/api/models/refresh', {}],
    ] as const) {
      expect(await send('POST', path, fromGateway(), body), path).toMatchObject({ status: 503, json: { error: 'Poise is installing an update; try again after it restarts', code: 'draining' } })
    }
    expect(await send('POST', '/api/chat/sessions', fromGateway(), { agent: 'grok', model: 'grok-4.6-high' })).toMatchObject({ status: 503, json: { code: 'draining' } })
    // Ordinary writes are not work a restart would cut.
    expect((await send('POST', '/api/settings', fromGateway(), { timezone: 'Europe/Helsinki' })).status).toBe(200)

    expect(await send('POST', '/api/service/resume', fromGateway('admin'))).toMatchObject({ status: 200, json: { draining: false } })
    expect(background.releaseBackgroundPaused()).toBe(false)
    const after = await send('POST', '/api/pr-review', fromGateway(), { url: 'not a pull request' })
    expect(after.status).not.toBe(503)
    expect(after.json.error).toContain('not a github PR url')
  })

  it('counts a launch admitted before the drain until its handler finishes', async () => {
    ;(await import('../server/db')).setMeta('me', 'octocat')
    await writeFile(join(bin, 'github-interface'), `#!/bin/sh\nprintf '%s' '${JSON.stringify({ action: 'head_sha', repository: 'acme/app', pull_number: 1, head_sha: 'a'.repeat(40), author: 'octocat' })}'\n`)
    await chmod(join(bin, 'github-interface'), 0o755)
    const hold = join(root, 'hold-models')
    const fail = join(root, 'fail-models')
    await writeFile(hold, '')
    await writeFile(fail, '')
    ;(await import('../server/models')).invalidateCatalog()
    const before = (await callerCalls()).length
    const launch = send('POST', '/api/pr-review', fromGateway(), { url: 'https://github.com/acme/app/pull/1' })
    try {
      // Past the drain check, waiting on Caller's catalogue: nothing is spawned yet.
      await vi.waitFor(async () => expect((await callerCalls()).slice(before).some((call) => call.args[0] === '--models')).toBe(true), { timeout: 5_000, interval: 20 })
      const drained = await send('POST', '/api/service/drain', fromGateway('admin'))
      expect(drained.json).toMatchObject({ draining: true, runningCallerCalls: 0, idle: false })
      expect(drained.json.backgroundWork).toBeGreaterThanOrEqual(1)
      expect(await send('GET', '/api/service/health')).toMatchObject({ json: { idle: false } })
    } finally {
      await rm(hold, { force: true })
    }
    expect((await launch).json.error).toBe('pr-review trigger failed: Update Caller: the model catalog is unavailable')
    await rm(fail, { force: true })
    await vi.waitFor(async () => expect((await send('GET', '/api/service/health')).json).toMatchObject({ backgroundWork: 0, idle: true, draining: true }), { timeout: 5_000, interval: 50 })
    expect(await send('POST', '/api/service/resume', fromGateway('admin'))).toMatchObject({ status: 200, json: { draining: false } })
  })

  it('lets the owner lift a drain the gateway left behind', async () => {
    expect(await send('POST', '/api/service/drain', fromGateway('admin'))).toMatchObject({ json: { draining: true } })
    expect((await send('POST', '/api/service/drain', fromGateway('browser'))).status).toBe(403)
    expect(await send('POST', '/api/service/resume', fromGateway('browser'))).toMatchObject({ status: 200, json: { draining: false } })
    expect((await send('POST', '/api/service/resume', fromGateway('link'))).status).toBe(403)
  })

  it('answers and closes an upgrade that nothing serves', async () => {
    for (const [caller, status] of [
      [{}, 404],
      [{ peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN }, 401],
      [{ ...fromGateway(), host: 'poise-ws-octocat:5555' }, 403],
      [fromGateway('link'), 403],
      [fromGateway(), 404],
    ] as Array<[Caller, number]>) {
      expect(await rawUpgrade('/ws/elsewhere', caller)).toEqual({ status, closed: true })
    }
  })

  it('tells the owner\'s browser whose workspace this is, so Settings adds the gateway\'s sections', async () => {
    const answer = await send('GET', '/api/workspace', fromGateway())
    expect(answer.status).toBe(200)
    expect(answer.json).toEqual({ mode: 'service', owner: OWNER })
    expect((await send('GET', '/api/workspace', fromGateway('link'))).status).toBe(403)
    expect((await send('GET', '/api/workspace', { peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN })).status).toBe(401)
  })

  it('answers Connected accounts to the owner\'s browser only', async () => {
    const accounts = await send('GET', '/api/accounts', fromGateway())
    expect(accounts.status).toBe(200)
    expect(accounts.json.accounts.map((account: { id: string }) => account.id)).toEqual(['claude', 'codex', 'gh', 'grok', 'muse', 'antigravity'])
    expect(accounts.json.accounts[2]).toMatchObject({ id: 'gh', installed: true, version: '2.92.0', signedIn: true, identity: 'octocat' })
    // Codex is signed out, and gh does not hold the agent account (bit-mis);
    // Claude is its auth monitor's to alert for, and it is signed in.
    expect(await signInAlerts()).toEqual({ 'sign-in:codex': 'open', 'sign-in:gh:agent': 'open' })
    expect((await send('GET', '/api/accounts', fromGateway('link'))).status).toBe(403)
    expect((await send('GET', '/api/accounts', fromGateway('admin'))).status).toBe(403)
    expect((await send('GET', '/api/accounts', { peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN })).status).toBe(401)
  })

  it('opens the terminal to the owner\'s browser only, and refreshes the accounts when a login exits', async () => {
    for (const [caller, status] of [
      [{ peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN }, 401],
      [fromGateway('link'), 403],
      [fromGateway('admin'), 403],
      [{ ...fromGateway(), identity: signAssertion(gateway.privateKey, { iat: 1, exp: 61 }) }, 401],
      [{ ...fromGateway(), origin: `http://${PUBLIC_HOST}` }, 403],
      [{ ...fromGateway(), host: 'poise-ws-octocat:5555' }, 403],
      [{ ...fromGateway(), headers: { 'sec-fetch-site': 'cross-site' } }, 403],
      [{ peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN, headers: { cookie: 'poise_ws=session', authorization: 'Bearer device-token' } }, 401],
    ] as Array<[Caller, number]>) {
      expect((await runTerminal('codex', caller)).status).toBe(status)
    }

    expect((await send('GET', '/api/accounts', fromGateway())).json.accounts[1]).toMatchObject({ id: 'codex', signedIn: false })
    const login = await runTerminal('codex', fromGateway())
    expect(login).toMatchObject({ status: 101, close: 1000 })
    expect(login.output).toContain('ABCD-1234')
    expect(login.frames.at(-1)).toEqual({ type: 'exit', code: 0 })
    expect((await send('GET', '/api/accounts', fromGateway())).json.accounts[1]).toMatchObject({ id: 'codex', signedIn: true, detail: 'Signed in with ChatGPT' })
    expect(await signInAlerts()).toMatchObject({ 'sign-in:codex': 'resolved', 'sign-in:gh:agent': 'open' })
  })

  it('serves first-run setup to the owner\'s browser only, and counts a login that finished in a terminal', async () => {
    const setup = await send('GET', '/api/onboarding', fromGateway())
    expect(setup.status).toBe(200)
    expect(setup.json).toMatchObject({ available: true, owner: OWNER })
    expect((await send('POST', '/api/onboarding', fromGateway(), { step: 'ai' })).json).toMatchObject({ available: true, step: 'ai' })
    expect((await send('POST', '/api/onboarding', fromGateway(), { step: 'admin' })).status).toBe(400)
    for (const [caller, status] of [
      [fromGateway('link'), 403],
      [fromGateway('admin'), 403],
      [{ peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN }, 401],
    ] as Array<[Caller, number]>) {
      expect((await send('GET', '/api/onboarding', caller)).status).toBe(status)
      expect((await send('POST', '/api/onboarding/github', caller, { role: 'me', login: 'octocat' })).status).toBe(status)
    }

    // Grok cannot report its sign-in, so setup counts its login once the terminal exits cleanly.
    expect(setup.json.logins).not.toHaveProperty('grok')
    const login = await runTerminal('grok', fromGateway())
    expect(login.frames.at(-1)).toEqual({ type: 'exit', code: 0 })
    await vi.waitFor(async () => expect((await send('GET', '/api/onboarding', fromGateway())).json.logins).toHaveProperty('grok'), { timeout: 2_000, interval: 20 })

    const grok = (await send('GET', '/api/accounts?id=grok', fromGateway())).json.accounts[0]
    expect(grok).toMatchObject({ signedIn: null, identity: null, signInRecordedAt: expect.any(String) })
    for (const id of ['grok', 'muse', 'antigravity']) {
      await send('GET', `/api/accounts?id=${id}`, fromGateway())
      for (const signedIn of [true, false]) {
        expect((await send('POST', '/api/onboarding', fromGateway(), { account: id, signedIn })).status).toBe(200)
        for (const query of ['', `?id=${id}`]) {
          const accounts = (await send('GET', `/api/accounts${query}`, fromGateway())).json.accounts
          expect(!!accounts.find((account: { id: string }) => account.id === id).signInRecordedAt).toBe(signedIn)
        }
      }
    }

    // The GitHub check runs gh as the person's stored account; this fake gh holds no token for it.
    expect((await send('POST', '/api/onboarding/github', fromGateway(), { role: 'me', login: 'octocat' })).json).toMatchObject({ ok: false, reason: 'not-signed-in' })
  })

  it('verifies the Claude sign-in at once when Claude\'s login exits', async () => {
    const before = auth.liveChecks
    const login = await runTerminal('claude', fromGateway())
    expect(login.frames.at(-1)).toEqual({ type: 'exit', code: 0 })
    await vi.waitFor(() => expect(auth.liveChecks).toBe(before + 1), { timeout: 2_000, interval: 20 })
    expect((await send('GET', '/api/accounts', fromGateway())).json.accounts[0]).toMatchObject({ id: 'claude', signedIn: true, identity: 'octocat@example.com' })
  })

  it('counts the Caller calls it launched until they finish', async () => {
    const { spawnDetached } = await import('../server/process')
    const release = join(root, 'release-call')
    await spawnDetached(join(bin, 'agent-interface'), ['--wait', release])
    expect((await send('GET', '/api/service/health')).json).toMatchObject({ runningCallerCalls: 1 })
    await writeFile(release, '')
    await vi.waitFor(async () => {
      expect((await send('GET', '/api/service/health')).json).toMatchObject({ runningCallerCalls: 0 })
    }, { timeout: 5_000, interval: 50 })
  })

  it('turns off what only a personal computer has, and says why', async () => {
    expect(await send('GET', '/api/self-update', fromGateway())).toMatchObject({ status: 200, json: { enabled: false, available: false, reason: turnedOff.SELF_UPDATE_OFF, changes: [] } })
    expect(await send('POST', '/api/self-update/revert', fromGateway(), { changeId: 'x' })).toMatchObject({ status: 409, json: { error: turnedOff.SELF_UPDATE_OFF, code: 'service_mode' } })
    expect((await send('POST', '/api/self-update/drain', {}, { releaseId: 'r1' })).status).toBe(409)

    expect(await send('GET', '/api/claude-auth', fromGateway())).toMatchObject({ status: 200, json: { status: 'authenticated', loginUnavailable: turnedOff.CLAUDE_BROWSER_LOGIN_OFF } })
    auth.setStatus('reauth_required')
    try {
      const login = await send('POST', '/api/claude-auth/login', fromGateway())
      expect(login).toMatchObject({ status: 409, json: { code: 'service_mode' } })
      expect(login.json.error).toContain('Settings → Accounts')
      expect(auth.logins).toBe(0)
    } finally {
      auth.setStatus('authenticated')
    }

    expect((await send('GET', '/api/health', fromGateway())).json.production).toEqual({
      status: 'off', reason: turnedOff.PRODUCTION_UPDATER_OFF,
      checkedAt: null, deployedCommit: null, remoteCommit: null, behind: null, failingSince: null, error: null,
    })

    const snippets = await send('GET', '/api/snippets', fromGateway())
    expect(snippets).toMatchObject({ status: 200, json: { desktop: 'poise-link' } })
    expect(snippets.json).not.toHaveProperty('espansoDetected')
    expect((await send('POST', '/api/snippets', fromGateway(), { trigger: ';regards', replace: 'Kind regards' })).status).toBe(200)
    expect(await readFile(join(home, '.poise', 'snippets', 'poise.yml'), 'utf8')).toContain(';regards')
    expect(existsSync(join(home, '.poise', 'config'))).toBe(false)
    expect(existsSync(join(home, 'Library'))).toBe(false)
  })

  it('holds the Chat WebSocket to the same rules', async () => {
    expect(await openChatSocket({ peer: GATEWAY_PEER, origin: PUBLIC_ORIGIN })).toEqual({ status: 401 })
    expect(await openChatSocket(fromGateway('link'))).toEqual({ status: 403 })
    expect(await openChatSocket(fromGateway('admin'))).toEqual({ status: 403 })
    expect(await openChatSocket({ ...fromGateway(), origin: `http://${PUBLIC_HOST}` })).toEqual({ status: 403 })
    expect(await openChatSocket({ ...fromGateway(), host: 'poise-ws-octocat:5555' })).toEqual({ status: 403 })
    expect(await openChatSocket({ ...fromGateway(), headers: { 'sec-fetch-site': 'cross-site' } })).toEqual({ status: 403 })
    expect(await openChatSocket({ ...fromGateway(), identity: signAssertion(gateway.privateKey, { iat: 1, exp: 61 }) })).toEqual({ status: 401 })

    const opened = await openChatSocket(fromGateway())
    if (!('open' in opened)) throw new Error(`the owner's socket was refused with ${opened.status}`)
    const socket = opened.open
    try {
      const ack = new Promise<{ ok: boolean, error?: string, code?: string }>((resolve) => {
        socket.on('message', (raw) => {
          const frame = JSON.parse(raw.toString())
          if (frame.kind === 'ack' && frame.id === 'poise-change-1') resolve(frame)
        })
      })
      socket.send(JSON.stringify({ id: 'poise-change-1', command: { type: 'poise.change', sessionId: '00000000-0000-4000-8000-000000000000', text: 'Add a button', changeId: '11111111-1111-4111-8111-111111111111' } }))
      expect(await ack).toMatchObject({ ok: false, code: 'service_mode', error: turnedOff.SELF_UPDATE_OFF })
    } finally {
      socket.terminate()
    }

    const local = await openChatSocket({ origin: `http://127.0.0.1:${port}` })
    if (!('open' in local)) throw new Error(`the loopback socket was refused with ${local.status}`)
    local.open.terminate()
  })

  it('creates a Manager only from the owner\'s browser', async () => {
    const body = { agent: 'grok', model: 'grok-4.6-xhigh', role: 'manager' }
    const created = await send('POST', '/api/chat/sessions', { ...fromGateway(), origin: PUBLIC_ORIGIN }, body)
    expect(created.status).toBe(201)
    expect(created.json.session.role).toBe('manager')
    expect(await send('POST', '/api/chat/sessions', {}, body)).toMatchObject({ status: 403 })
  })

  it('edits /manager only from the owner\'s browser, including during a service drain', async () => {
    const created = await send('POST', '/api/chat/sessions', { ...fromGateway(), origin: PUBLIC_ORIGIN }, { agent: 'grok', model: 'grok-4.6-xhigh', role: 'manager' })
    expect([201, 409]).toContain(created.status)
    const list = await send('GET', '/api/snippets', fromGateway())
    expect(list.status).toBe(200)
    expect(list.json.snippets.some((snippet: { trigger: string }) => snippet.trigger === ';manager')).toBe(true)
    const edit = (text: string, version: string) => ({ snippets: list.json.snippets.map((snippet: { trigger: string, replace: string }) =>
      snippet.trigger === ';manager' ? { ...snippet, replace: text } : snippet), base_version: version })

    const saved = await send('PUT', '/api/snippets', { ...fromGateway(), origin: PUBLIC_ORIGIN }, edit('Owner text', list.json.version))
    expect(saved.status).toBe(200)
    const version = saved.json.version as string

    expect(await send('PUT', '/api/snippets', { ...fromGateway(), origin: undefined }, edit('No origin', version)))
      .toMatchObject({ status: 403, json: { error: 'The /manager snippet is edited in the browser.' } })
    expect(await send('PUT', '/api/snippets', {}, edit('Container local', version)))
      .toMatchObject({ status: 403, json: { error: 'The /manager snippet is edited in the browser.' } })

    expect(await send('POST', '/api/service/drain', fromGateway('admin'))).toMatchObject({ status: 200, json: { draining: true } })
    try {
      const drained = await send('PUT', '/api/snippets', { ...fromGateway(), origin: PUBLIC_ORIGIN }, edit('During drain', version))
      expect(drained.status).toBe(200)
      expect((await send('GET', '/api/snippets', fromGateway())).json.snippets).toContainEqual({ trigger: ';manager', replace: 'During drain' })
    } finally {
      expect(await send('POST', '/api/service/resume', fromGateway('admin'))).toMatchObject({ status: 200, json: { draining: false } })
    }
  })

  it('changes the Manager wake interval only from the owner\'s browser', async () => {
    const read = await send('GET', '/api/chat/manager/wake', fromGateway())
    expect(read.status).toBe(200)
    const revision = read.json.revision as number
    const everyMinutes = read.json.everyMinutes === 15 ? 30 : 15
    const saved = await send('PUT', '/api/chat/manager/wake', { ...fromGateway(), origin: PUBLIC_ORIGIN }, { everyMinutes, revision })
    expect(saved.status).toBe(200)
    expect(saved.json).toMatchObject({ everyMinutes, revision: revision + 1 })
    expect(await send('PUT', '/api/chat/manager/wake', {}, { everyMinutes: 30, revision: revision + 1 }))
      .toMatchObject({ status: 403, json: { error: 'The Manager\'s wake interval is changed in the browser.' } })
  })

  it('never echoes or logs the identity assertion', async () => {
    const lines: string[] = []
    const capture = (...args: unknown[]) => { lines.push(args.map((arg) => arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')) }
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(capture))
    try {
      const tokens = [
        signAssertion(gateway.privateKey),
        signAssertion(gateway.privateKey, { iat: 1, exp: 61 }),
        signAssertion(gateway.privateKey, { scope: 'link' }),
        signAssertion(gatewayKeys().privateKey),
        signAssertion(gateway.privateKey, { sub: 'hubot' }),
      ]
      const replies: Reply[] = []
      for (const identity of tokens) {
        const caller = { ...fromGateway(), identity }
        replies.push(await send('GET', '/api/settings', caller))
        replies.push(await send('GET', '/', caller))
        replies.push(await send('GET', '/api/service/health', caller))
        replies.push(await send('POST', '/api/pr-review', caller, { url: 'not a pull request' }))
        replies.push(await send('GET', '/api/settings', { ...caller, host: 'elsewhere.example' }))
      }
      for (const reply of replies) {
        const seen = `${JSON.stringify(reply.headers)}\n${reply.text}`
        for (const token of tokens) expect(seen).not.toContain(token.split('.')[2])
      }
      for (const line of lines) {
        for (const token of tokens) expect(line).not.toContain(token.split('.')[2])
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('binds beyond loopback only in service mode', () => {
    expect(() => production.createProductionServer({ host: '0.0.0.0', service: null })).toThrow('Poise is a local application and only binds to a loopback host')
  })

  it('finishes in-flight native cleanup and its original receipt before SQLite closes and exit 75', async () => {
    const maintenance = await import('../server/storage-maintenance')
    const { ServiceControl } = await import('../server/service/control')
    const { getChatRuntime } = await import('../server/cache-plugin')
    const { spawnDetached } = await import('../server/process')
    const { runningCallerCalls } = await import('../server/service/caller-calls')
    const { db } = await import('../server/db')
    await maintenance.stopStorageMaintenanceRuntime()
    const records = process.env.AGENT_INTERFACE_DATA_DIR!
    await mkdir(records, { recursive: true })
    const receipts = new Database(join(records, 'calls.sqlite3'))
    receipts.exec('CREATE TABLE calls (id TEXT, status TEXT, pid INTEGER, runner TEXT, source TEXT, resources_settled_at REAL, resource_cleanup TEXT, artifact TEXT)')
    const originalArtifact = JSON.stringify({ outcome: 'completed', head_sha: 'b'.repeat(40) })
    receipts.prepare('INSERT INTO calls VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?)')
      .run('a'.repeat(32), 'completed', 'poise:behavior-chain', JSON.stringify({ token: 'original-claim' }), originalArtifact)
    const heldReceipt = { id: 'a'.repeat(32), status: 'completed', pid: null, runner: null, source: 'poise:behavior-chain',
      resources_settled_at: null, resource_cleanup: JSON.stringify({ token: 'original-claim' }), artifact: originalArtifact }
    const resource = join(records, 'native-resources', 'a'.repeat(32))
    await mkdir(resource, { recursive: true })
    await writeFile(join(resource, 'owned'), 'original cleanup work')
    const hold = join(root, 'hold-cleanup')
    const releaseCaller = join(root, 'release-surviving-caller')
    await writeFile(hold, '')
    vi.stubEnv('POISE_NATIVE_CONTROL', '{}')
    maintenance.startStorageMaintenanceRuntime()
    await spawnDetached(join(bin, 'agent-interface'), ['--wait', releaseCaller])
    const exit = vi.fn((code: number) => ({ code, resourcePresent: existsSync(resource), receipt: receipts.prepare('SELECT * FROM calls').get(),
      databaseOpen: db.open, runningCallerCalls: runningCallerCalls().count }))
    const shutdown = production.createProductionShutdown(server, exit)
    const releases = join(root, 'releases')
    await mkdir(join(releases, 'new'), { recursive: true })
    await writeFile(join(releases, 'new', 'installed'), '')
    await writeFile(join(releases, 'new', 'base'), 'same-base')
    const service = new ServiceControl(getChatRuntime(), { releasesDir: releases, release: { name: 'old', base: 'same-base' },
      drainTimeoutSeconds: 1800, canRestart: () => true, restart: () => { shutdown(75); return true } })
    try {
      await vi.waitFor(() => expect(existsSync(join(root, 'cleanup-started'))).toBe(true))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      service.switchRelease('new')
      // Longer than production's unchanged shutdown budget, with the actual
      // maintenance command still holding its original cleanup receipt.
      await vi.advanceTimersByTimeAsync(11_000)
      expect(receipts.prepare('SELECT * FROM calls').get()).toEqual(heldReceipt)
      expect(existsSync(resource)).toBe(true)
      expect(db.open).toBe(true)
      expect(server.listening).toBe(true)
      expect(exit).not.toHaveBeenCalled()

      await rm(hold)
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(75), { timeout: 5_000 })
      expect(exit.mock.results[0].value).toEqual({ code: 75, resourcePresent: false, receipt: { ...heldReceipt, resources_settled_at: 1234, resource_cleanup: null },
        databaseOpen: false, runningCallerCalls: 1 })
      expect(server.listening).toBe(false)
    } finally {
      vi.useRealTimers()
      await rm(hold, { force: true })
      await writeFile(releaseCaller, '')
      await production.shutdownProductionServer(server)
      receipts.close()
    }
  }, 20_000)
})

describe('collaborator reconciliation during release teardown', () => {
  let candidate: typeof import('../server/production')
  let runtime: typeof import('../server/cache-plugin')
  let database: typeof import('../server/db')
  let application: Server
  let stateRoot: string
  let finishInvite: () => void
  let inviteStarted: boolean
  const confirmationKey = 'agent_collaborator_confirmed:acme:agent-x'
  const originalConfirmation = JSON.stringify([[101, 'acme/existing']])

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'poise-collaborator-stop-'))
    vi.stubEnv('POISE_DB', join(stateRoot, 'cache.db'))
    vi.stubEnv('AGENT_INTERFACE_DATA_DIR', join(stateRoot, 'caller'))
    vi.resetModules()
    database = await import('../server/db')
    await import('../server/organizations')
    database.setMeta('me', 'octocat')
    database.setMeta('agentAccount', 'agent-x')
    database.setMeta('notification_settings', JSON.stringify({ enabled: false }))
    database.setMeta(confirmationKey, originalConfirmation)
    database.db.prepare("INSERT INTO organizations (login, managed, status, stage) VALUES ('acme', 0, 'ready', 'ready')").run()
    const processes = await import('../server/process')
    const runFile = processes.runFile
    inviteStarted = false
    const invite = new Promise<void>((resolve) => { finishInvite = resolve })
    vi.spyOn(processes, 'runFile').mockImplementation(async (command, args, options) => {
      if (command === 'github-interface' && args[0] === '--view-repos') return { stdout: JSON.stringify({ repos: [
        { full_name: 'acme/existing', id: 101 }, { full_name: 'acme/site', id: 102 },
      ] }), stderr: '' }
      if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') return { stdout: 'fixture-token', stderr: '' }
      if (command === 'gh' && args[0] === 'api') {
        if (args[1] === 'repos/acme/site/collaborators/agent-x') {
          inviteStarted = true
          await invite
          return { stdout: 'HTTP/2.0 201 Created\r\n\r\n{"id":7}', stderr: '' }
        }
        if (args[1]?.startsWith('user/repository_invitations?')) return { stdout: 'HTTP/2.0 200 OK\r\n\r\n[]', stderr: '' }
      }
      return runFile(command, args, options)
    })
    candidate = await import('../server/production')
    runtime = await import('../server/cache-plugin')
    application = candidate.createProductionServer({ claudeAuth: auth, terminalCommand: fakePresetCommand(bin) })
    await new Promise<void>((resolve) => application.listen(0, '127.0.0.1', resolve))
    await vi.waitFor(() => expect(inviteStarted).toBe(true))
  })

  afterEach(async () => {
    vi.useRealTimers()
    finishInvite()
    await candidate.shutdownProductionServer(application).catch(() => undefined)
    vi.restoreAllMocks()
    await rm(stateRoot, { recursive: true, force: true })
  })

  it('identifies the actual unresolved collaborator stop in the durable deadline Error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const exit = vi.fn()
    candidate.createProductionShutdown(application, exit)(75)
    await vi.waitFor(() => expect(runtime.pendingRuntimeStops()).toEqual(['agent_collaborator']))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    const retained = new DiagnosticStore(join(stateRoot, 'logging.db'), undefined, Date.now, true)
    try {
      expect(retained.query({ workspace: HANDLE, operator: false }, { source: 'poise' }).events).toContainEqual(expect.objectContaining({
        operation: 'process.shutdown', severity: 'error', phase: 'shutdown_deadline', exitCode: 1, timeoutMs: 10_000,
        message: expect.stringContaining('runtime_stop.agent_collaborator'),
        context: { requestedExitCode: 75, pendingPhases: ['runtime_stop', 'runtime_stop.agent_collaborator'] },
      }))
    } finally { retained.close() }
  })

  it('finishes the admitted invitation and its original account confirmation before switching with exit 75', async () => {
    const { ServiceControl } = await import('../server/service/control')
    const releases = join(stateRoot, 'releases')
    await mkdir(join(releases, 'new'), { recursive: true })
    await writeFile(join(releases, 'new', 'installed'), '')
    await writeFile(join(releases, 'new', 'base'), 'same-base')
    const confirmations = new Database(join(stateRoot, 'cache.db'), { readonly: true })
    const readConfirmation = () => confirmations.prepare('SELECT value FROM meta WHERE key = ?').get(confirmationKey)
    const exit = vi.fn()
    const shutdown = candidate.createProductionShutdown(application, exit)
    const service = new ServiceControl(runtime.getChatRuntime(), { releasesDir: releases, release: { name: 'old', base: 'same-base' },
      drainTimeoutSeconds: 1800, canRestart: () => true, restart: () => { shutdown(75); return true } })
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      service.switchRelease('new')
      await vi.advanceTimersByTimeAsync(11_000)
      expect(readConfirmation()).toEqual({ value: originalConfirmation })
      expect(database.db.open).toBe(true)
      expect(application.listening).toBe(true)
      expect(exit).not.toHaveBeenCalled()

      finishInvite()
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(75), { timeout: 5_000 })
      expect(readConfirmation()).toEqual({ value: JSON.stringify([[101, 'acme/existing'], [102, 'acme/site']]) })
      expect(database.db.open).toBe(false)
    } finally { service.reset(); confirmations.close() }
  }, 20_000)
})
