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
    opened.open.terminate()

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
