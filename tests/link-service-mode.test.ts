// The Link API in a workspace, end to end through the production server in
// service mode: who reaches it, and the exact HTTP the Poise Link client
// parses (link/src-tauri/src/link_api.rs, sse.rs and duties/), checked against
// the fake workspace its own tests run on (link/src-tauri/tests/support/mod.rs).

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { assertLinkAccepts, openEvents, send, start, type EventStream, type Target } from './link-fixture'
import { HANDLE, OWNER, PUBLIC_HOST, PUBLIC_ORIGIN, gatewayKeys, serviceEnvironment, signAssertion } from './service-fixture'

const gateway = gatewayKeys()
const auth = createAuthenticatedClaudeAuth()
const GATEWAY_PEER = '172.18.0.2'
let root = ''
let home = ''
let server: Server
let port = 0
let production: typeof import('../server/production')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-link-service-'))
  home = join(root, 'home')
  const staticDir = join(root, 'client')
  await Promise.all([home, join(root, 'agent'), staticDir].map((dir) => mkdir(dir, { recursive: true })))
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Poise workspace</title>')
  for (const [key, value] of Object.entries({ ...serviceEnvironment(gateway), HOME: home, AGENT_INTERFACE_ROOT: join(root, 'agent') })) vi.stubEnv(key, value)
  // Everything else defaults under ~/.poise in the isolated home, as in a workspace.
  for (const key of ['POISE_DB', 'POISE_CHAT_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'AGENT_INTERFACE_DATA_DIR', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR',
    'POISE_MODEL_CATALOG_REPORT', 'POISE_PRODUCTION_UPDATE_REPORT', 'POISE_SELF_UPDATE_ROOT', 'POISE_LOCK_DIR', 'POISE_DATASTORE_DB']) {
    vi.stubEnv(key, undefined)
  }
  vi.resetModules()
  production = await import('../server/production')
  server = production.createProductionServer({ host: '0.0.0.0', staticDir, claudeAuth: auth, reviewAgentUsername: 'bit-mis' })
  // Requests carrying x-test-peer arrive from the gateway's network.
  server.prependListener('request', (req: IncomingMessage) => {
    const peer = req.headers['x-test-peer']
    if (typeof peer === 'string') Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await production.shutdownProductionServer(server)
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

/** The gateway forwarding a request with an assertion of `scope`. */
function viaGateway(scope: string, claims: Record<string, unknown> = {}): Target {
  return { port, host: PUBLIC_HOST, headers: { 'x-test-peer': GATEWAY_PEER, 'x-poise-identity': signAssertion(gateway.privateKey, { scope, ...claims }) } }
}
const device = () => viaGateway('link')
const browser = () => ({ ...viaGateway('browser'), headers: { ...viaGateway('browser').headers, origin: PUBLIC_ORIGIN } })
const loopback = (): Target => ({ port })

async function postJson(target: Target, path: string, body: unknown) {
  const { request } = await import('node:http')
  const payload = JSON.stringify(body)
  return new Promise<{ status: number, json: any }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, agent: false, headers: { host: target.host ?? `127.0.0.1:${port}`, ...target.headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

async function eventsAs(target: Target, headers: Record<string, string> = {}): Promise<EventStream> {
  const stream = await openEvents(target, headers)
  expect(stream.status).toBe(200)
  return stream
}

describe('the Link API in a workspace', () => {
  it('serves a paired device, the owner\'s browser and the container itself', async () => {
    for (const target of [device(), browser(), loopback()]) {
      expect(await send(target, 'GET', '/api/link/hello')).toMatchObject({ status: 200, json: { login: OWNER, version: null } })
      expect((await send(target, 'GET', '/api/link/snippets')).status).toBe(200)
      const stream = await eventsAs(target)
      stream.close()
    }
  })

  it('confines a device to /api/link/* and refuses the gateway\'s admin scope there', async () => {
    for (const [method, path] of [['GET', '/api/settings'], ['GET', '/api/snippets'], ['POST', '/api/snippets/import'], ['GET', '/api/service/health'], ['GET', '/'], ['GET', '/api/link/../settings'], ['GET', '/api/link/%2e%2e/settings']]) {
      expect((await send(device(), method, path)).status, `${method} ${path}`).toBe(403)
    }
    for (const path of ['/api/link/hello', '/api/link/snippets', '/api/link/events']) {
      expect((await send(viaGateway('admin'), 'GET', path)).status, path).toBe(403)
    }
  })

  it('answers 401, the only status Poise Link signs out on, to a request without a valid assertion', async () => {
    const other = gatewayKeys()
    const refused: Record<string, Target> = {
      'no assertion': { port, host: PUBLIC_HOST, headers: { 'x-test-peer': GATEWAY_PEER } },
      'a device token instead of an assertion': { port, host: PUBLIC_HOST, headers: { 'x-test-peer': GATEWAY_PEER, authorization: 'Bearer device-token-123' } },
      'an expired assertion': viaGateway('link', { iat: 1, exp: 61 }),
      'a forged assertion': { ...device(), headers: { ...device().headers, 'x-poise-identity': signAssertion(other.privateKey, { scope: 'link' }) } },
      'another workspace\'s assertion': viaGateway('link', { aud: 'workspace:hubot' }),
      'another person\'s assertion': viaGateway('link', { sub: 'hubot' }),
    }
    for (const [why, target] of Object.entries(refused)) {
      for (const path of ['/api/link/hello', '/api/link/snippets', '/api/link/events']) {
        expect((await send(target, 'GET', path)).status, `${why}: ${path}`).toBe(401)
      }
    }
    // Everything else a device can meet is not a 401.
    expect((await send(device(), 'GET', '/api/link/nothing')).status).toBe(404)
    expect((await send(device(), 'GET', '/api/link/snippets?wait=nope')).status).toBe(400)
    expect(HANDLE).toBe(OWNER.toLowerCase())
  })

  it('sends snippets exactly as Poise Link reads them: JSON, a quoted ETag, and 304 only when asked', async () => {
    expect((await postJson(browser(), '/api/snippets', { trigger: ';sig', replace: 'Best,\nOcto' })).status).toBe(200)
    const reply = await send(device(), 'GET', '/api/link/snippets')
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('application/json')
    const { version, yaml } = reply.json as { version: string, yaml: string }
    expect(version).toBe(createHash('sha256').update(yaml, 'utf8').digest('hex'))
    // The fake workspace sends `ETag: "<version>"`; Poise Link echoes it back verbatim.
    expect(reply.headers.etag).toBe(`"${version}"`)
    expect(assertLinkAccepts(yaml)).toEqual([{ trigger: ';sig', replace: 'Best,\nOcto' }])
    expect(await send(device(), 'GET', '/api/link/snippets', { 'if-none-match': reply.headers.etag as string })).toMatchObject({ status: 304, text: '' })
    // Poise Link treats a 304 to an unconditional request as a broken server.
    expect((await send(device(), 'GET', '/api/link/snippets')).status).toBe(200)
  })

  it('streams events in the fake workspace\'s framing, with alerts linking into the public origin', async () => {
    const stream = await eventsAs(device())
    try {
      expect(stream.headers['content-type']).toMatch(/^text\/event-stream/)
      const { version } = (await send(device(), 'GET', '/api/link/snippets')).json
      await stream.next((event) => event.event === 'snippets')
      // support/mod.rs: `event: snippets\ndata: {"version":"…"}\n\n`.
      expect(stream.raw()).toContain(`event: snippets\ndata: {"version":"${version}"}\n\n`)

      // The workspace records the alert itself: Claude's sign-in lapsing.
      auth.setStatus('reauth_required')
      const alert = await stream.next((event) => event.event === 'alert')
      const data = JSON.parse(alert.data)
      expect(data).toEqual({
        id: alert.id, kind: 'sign_in_needed', title: 'Claude needs you to sign in again',
        body: 'Claude-backed work is paused. Connect Claude in Settings → Connected accounts.',
        url: `${PUBLIC_ORIGIN}/`, created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      })
      // support/mod.rs alert_frame(): `id: …\nevent: alert\ndata: {"id":…,"kind":…,"title":…,"body":…,"url":…,"created_at":…}\n\n`.
      expect(stream.raw()).toContain(`id: ${alert.id}\nevent: alert\ndata: ${JSON.stringify({ id: data.id, kind: data.kind, title: data.title, body: data.body, url: data.url, created_at: data.created_at })}\n\n`)

      // Still the same condition: no second alert. Signed in again, then out: a new one.
      auth.setStatus('degraded')
      auth.setStatus('reauth_required')
      auth.setStatus('authenticated')
      auth.setStatus('reauth_required')
      await stream.next((event) => event.event === 'alert' && event.id !== alert.id)
      expect(stream.events.filter((event) => event.event === 'alert')).toHaveLength(2)

      // A snippet saved in the browser reaches the device's stream.
      expect((await postJson(browser(), '/api/snippets', { trigger: ';hi', replace: 'hello' })).status).toBe(200)
      const next = (await send(device(), 'GET', '/api/link/snippets')).json.version
      await stream.next((event) => event.event === 'snippets' && JSON.parse(event.data).version === next)
    } finally {
      auth.setStatus('authenticated')
      stream.close()
    }
  })

  it('resumes after Last-Event-ID across a reconnect', async () => {
    const first = await eventsAs(device())
    auth.setStatus('reauth_required')
    const seen = await first.next((event) => event.event === 'alert')
    first.close()
    auth.setStatus('authenticated')
    auth.setStatus('reauth_required')
    const resumed = await eventsAs(device(), { 'last-event-id': seen.id! })
    try {
      const replayed = await resumed.next((event) => event.event === 'alert')
      expect(replayed.id).not.toBe(seen.id)
      expect(resumed.events.filter((event) => event.event === 'alert').map((event) => event.id)).toEqual([replayed.id])
    } finally {
      auth.setStatus('authenticated')
      resumed.close()
    }
  })

  it('imports an Espanso file in the browser and sends only its plain pairs to the device', async () => {
    const imported = await postJson(browser(), '/api/snippets/import', {
      yaml: 'matches:\n  - trigger: ";addr"\n    replace: "1 Main St"\n  - trigger: ";pwn"\n    replace: "{{o}}"\n    vars: [{ name: o, type: shell, params: { cmd: id } }]\n',
    })
    expect(imported).toMatchObject({ status: 200, json: { added: [';addr'], skipped: [{ entry: 2, trigger: ';pwn', reason: 'not_plain', detail: 'it runs a shell command' }] } })
    const { yaml } = (await send(device(), 'GET', '/api/link/snippets')).json
    expect(assertLinkAccepts(yaml)).toContainEqual({ trigger: ';addr', replace: '1 Main St' })
    expect(yaml).not.toContain('pwn')
    expect((await postJson(device(), '/api/snippets/import', { yaml: 'matches: []\n' })).status).toBe(403)
  })

  it('lets the server shut down promptly with event streams and long polls open', async () => {
    const stream = await eventsAs(device())
    const { version } = (await send(device(), 'GET', '/api/link/snippets')).json
    const held = start(device(), `/api/link/snippets?wait=${version}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    await production.shutdownProductionServer(server)
    expect(Date.now() - started).toBeLessThan(5_000)
    await stream.ended
    expect(await held.done).toMatchObject({ status: 503, json: { error: 'Poise is shutting down' } })
  })
})
