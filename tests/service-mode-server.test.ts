// Poise in service mode, end to end through the production server: the
// requests a workspace container gets from the gateway (from another address
// on the container network) and from its own health check (loopback), with
// every piece of state under an isolated home folder.

import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { CATALOG } from './model-catalog-fixture'
import { PUBLIC_HOST, PUBLIC_ORIGIN, gatewayKeys, serviceEnvironment, signAssertion } from './service-fixture'

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
  // A stand-in Caller: records how it was started, answers --models, and holds
  // a call open until its release file exists.
  await writeFile(join(bin, 'fake-caller.cjs'), `
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callerLog)}, JSON.stringify({ args, dataDir: process.env.AGENT_INTERFACE_DATA_DIR ?? null }) + '\\n')
if (args[0] === '--models') process.stdout.write(${JSON.stringify(JSON.stringify(CATALOG))})
else if (args[0] === '--wait') { const timer = setInterval(() => { if (fs.existsSync(args[1])) clearInterval(timer) }, 20) }
else process.stdout.write('[]')
`)
  await writeFile(join(bin, 'agent-interface'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, 'fake-caller.cjs'))} "$@"\n`)
  await chmod(join(bin, 'agent-interface'), 0o755)

  for (const [key, value] of Object.entries({ ...serviceEnvironment(gateway), HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, AGENT_INTERFACE_ROOT: join(root, 'agent') })) {
    vi.stubEnv(key, value)
  }
  // Everything else defaults under ~/.poise, as it does in a workspace.
  for (const key of ['POISE_DB', 'POISE_CHAT_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'AGENT_INTERFACE_DATA_DIR', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR',
    'POISE_MODEL_CATALOG_REPORT', 'POISE_PRODUCTION_UPDATE_REPORT', 'POISE_SELF_UPDATE_ROOT', 'POISE_LOCK_DIR', 'POISE_DATASTORE_DB']) {
    vi.stubEnv(key, undefined)
  }
  vi.resetModules()
  production = await import('../server/production')
  turnedOff = await import('../server/service/turned-off')
  // The container listens on every interface; the test binds loopback only.
  server = production.createProductionServer({ host: '0.0.0.0', staticDir, claudeAuth: auth, reviewAgentUsername: 'bit-mis' })
  const fromGatewayNetwork = (req: IncomingMessage) => {
    const peer = req.headers['x-test-peer']
    if (typeof peer === 'string') Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true })
  }
  server.prependListener('request', fromGatewayNetwork)
  server.prependListener('upgrade', fromGatewayNetwork)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
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

async function callerCalls(): Promise<Array<{ args: string[], dataDir: string | null }>> {
  if (!existsSync(callerLog)) return []
  return (await readFile(callerLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

describe('Poise in service mode', () => {
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

  it('answers the container health check and the gateway\'s admin scope only', async () => {
    const health = await send('GET', '/api/service/health')
    expect(health.status).toBe(200)
    expect(health.json).toEqual({ ok: true, mode: 'service', version: null, activeChatTurns: 0, runningCallerCalls: 0, draining: false })
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
      ['/api/chat', { session: 'card-1', message: 'hello' }],
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
      expect(login.json.error).toContain('Settings → Connected accounts')
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
})
