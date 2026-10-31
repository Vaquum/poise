import http from 'node:http'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { MAX_DECLINED_UPGRADE_BYTES, MAX_REQUEST_BODY_BYTES, proxyRequest, RequestTooLargeError } from '../src/proxy.js'
import { events, startHarness, verifyAssertion, workspaceHost, type Harness } from './harness.js'

const ALICE = workspaceHost('alice')

interface Collected {
  text(): string
  waitFor(needle: string): Promise<void>
  ended: Promise<void>
}

function collect(stream: http.IncomingMessage): Collected {
  let text = ''
  const waiters: Array<{ needle: string; resolve: () => void }> = []
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
    for (const waiter of [...waiters]) {
      if (text.includes(waiter.needle)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  })
  return {
    text: () => text,
    waitFor: (needle) => new Promise((resolve) => {
      if (text.includes(needle)) resolve()
      else waiters.push({ needle, resolve })
    }),
    ended: new Promise((resolve) => stream.on('end', () => resolve())),
  }
}

/** Sends raw bytes and collects everything the gateway answers until it closes the connection. */
function rawExchange(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let answer = ''
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text))
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('latin1')
    })
    socket.on('close', () => resolve(answer))
    socket.on('error', reject)
    socket.setTimeout(3000, () => socket.destroy())
  })
}

function chunked(body: string): string {
  return `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`
}

function upgradeAnswer(h: Harness, path: string, cookie: string): Promise<{ status: number; setCookie: string[] | undefined }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}${path}`, { headers: { host: ALICE, cookie } })
    socket.on('upgrade', (res) => {
      resolve({ status: 101, setCookie: res.headers['set-cookie'] })
      socket.close()
    })
    socket.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0, setCookie: res.headers['set-cookie'] })
      res.resume()
    })
    socket.on('error', reject)
  })
}

describe('proxy', () => {
  let h: Harness
  let cookie: string
  beforeEach(async () => {
    h = await startHarness()
    cookie = (await h.openWorkspace('alice')).workspaceCookie
  })
  afterEach(async () => {
    await h.close()
  })

  it('replaces client identity and forwarding headers, keeps Host and Origin, and forwards no cookie', async () => {
    const reply = await h.request({
      host: ALICE,
      path: '/api/echo',
      headers: {
        // portal_session stands for a login cookie the parent domain shares with every host below it.
        cookie: `a=1; ${cookie}; poise_bind=b; poise_gw=g; poise_oauth=o; portal_session=p; b=2`,
        origin: `https://${ALICE}`,
        'X-Poise-Identity': 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJyb290Iiwic2NvcGUiOiJhZG1pbiJ9.',
        'x-forwarded-proto': 'http',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-port': '8443',
        'x-forwarded-prefix': '/admin',
        forwarded: 'for=evil;proto=http',
        connection: 'keep-alive, x-hop',
        'x-hop': 'secret',
        'x-kept': 'yes',
      },
    })
    expect(reply.status).toBe(200)
    const { headers } = reply.json<{ headers: Record<string, string> }>()
    expect(headers.host).toBe(ALICE)
    expect(headers.origin).toBe(`https://${ALICE}`)
    expect(headers.cookie).toBeUndefined()
    expect(headers['x-forwarded-proto']).toBe('https')
    expect(headers['x-forwarded-host']).toBe(ALICE)
    expect(headers['x-forwarded-for']).toBe('203.0.113.9, 127.0.0.1')
    expect(headers['x-forwarded-port']).toBeUndefined()
    expect(headers['x-forwarded-prefix']).toBeUndefined()
    expect(headers.forwarded).toBeUndefined()
    expect(headers['x-hop']).toBeUndefined()
    expect(headers['x-kept']).toBe('yes')
    expect(verifyAssertion(headers['x-poise-identity'], h.keys.publicKeyBase64)).toMatchObject({ sub: 'Alice', scope: 'browser', aud: 'workspace:alice' })
  })

  it('passes status, body and headers through, but never a cookie the workspace tries to set', async () => {
    const reply = await h.request({ host: ALICE, path: '/created', headers: { cookie } })
    expect(reply.status).toBe(201)
    expect(reply.body).toBe('created')
    expect(reply.headers['x-workspace']).toBe('yes')
    // The workspace tried poise_gw for the whole domain with a longer Path, to swap a visitor's apex identity.
    expect(reply.headers['set-cookie']).toBeUndefined()
  })

  it('answers 502 for a status Node cannot relay, and keeps serving everyone', async () => {
    for (const path of ['/status/099', '/status/999']) {
      const reply = await h.request({ host: ALICE, path, headers: { cookie } })
      expect(reply.status, path).toBe(502)
      expect(reply.json()).toMatchObject({ error: 'bad_gateway' })
    }
    expect(h.logs.filter((entry) => entry.event === 'proxy.failed').map((entry) => entry.error)).toEqual([
      'the workspace answered with status 99',
      'the workspace answered with status 999',
    ])
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie } })).status).toBe(200)
  })

  it('keeps cookies and odd statuses out of WebSocket answers too', async () => {
    expect(await upgradeAnswer(h, '/ws/chat', cookie)).toEqual({ status: 101, setCookie: undefined })
    expect(await upgradeAnswer(h, '/ws/declined', cookie)).toEqual({ status: 403, setCookie: undefined })
    expect(await upgradeAnswer(h, '/ws/status/099', cookie)).toEqual({ status: 502, setCookie: undefined })
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie } })).status).toBe(200)
  })

  it('refuses a declared body larger than it relays, without reaching the workspace', async () => {
    const answer = await rawExchange(h.port, `POST /api/large HTTP/1.1\r\nHost: ${ALICE}\r\nCookie: ${cookie}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${MAX_REQUEST_BODY_BYTES + 1}\r\nConnection: close\r\n\r\n`)
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large')
    expect(h.workspace.requestLines).not.toContain('POST /api/large')
  })

  it('relays a refused WebSocket upgrade only while its answer is short', async () => {
    expect(await upgradeAnswer(h, '/ws/declined-large', cookie)).toEqual({ status: 502, setCookie: undefined })
    expect(h.logs.filter((entry) => entry.event === 'proxy.upgrade.failed').map((entry) => entry.error)).toEqual([
      `the workspace declined the upgrade with more than ${MAX_DECLINED_UPGRADE_BYTES} bytes`,
    ])
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie } })).status).toBe(200)
  })

  it('refuses a body on a bodiless method instead of smuggling it to the workspace', async () => {
    await h.request({ host: ALICE, path: '/api/state', headers: { cookie } })
    const smuggled = `GET /smuggled HTTP/1.1\r\nHost: ${ALICE}\r\nX-Poise-Identity: forged\r\n\r\n`
    const attempts = [
      `GET /api/echo HTTP/1.1\r\nHost: ${ALICE}\r\nCookie: ${cookie}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunked(smuggled)}`,
      `GET /api/echo HTTP/1.1\r\nHost: ${ALICE}\r\nCookie: ${cookie}\r\nContent-Length: ${smuggled.length}\r\nConnection: close\r\n\r\n${smuggled}`,
      ...['HEAD', 'OPTIONS', 'DELETE', 'TRACE'].map((method) =>
        `${method} /api/echo HTTP/1.1\r\nHost: ${ALICE}\r\nCookie: ${cookie}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunked(smuggled)}`),
      `POST /api/echo HTTP/1.1\r\nHost: ${ALICE}\r\nCookie: ${cookie}\r\nTransfer-Encoding: gzip, chunked\r\nConnection: close\r\n\r\n${chunked(smuggled)}`,
    ]
    for (const attempt of attempts) {
      expect((await rawExchange(h.port, attempt)).split('\r\n')[0], attempt.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request')
    }
    await delay(50)
    expect(h.workspace.requestLines).not.toContain('GET /smuggled')
    expect(h.workspace.requests.map((request) => request.url)).toEqual(['/api/state'])
  })

  it('forwards a chunked body with explicit framing, so it stays one request', async () => {
    const inner = `GET /smuggled HTTP/1.1\r\nHost: ${ALICE}\r\n\r\n`
    const answer = await rawExchange(h.port,
      `POST /api/echo HTTP/1.1\r\nHost: ${ALICE}\r\nCookie: ${cookie}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunked(inner)}`)
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    await delay(50)
    expect(h.workspace.requests.at(-1)).toMatchObject({ method: 'POST', url: '/api/echo', body: inner })
    expect(h.workspace.requests.at(-1)?.headers['transfer-encoding']).toBe('chunked')
    expect(h.workspace.requestLines).not.toContain('GET /smuggled')
  })

  it('streams request and response bodies in both directions without buffering', async () => {
    const req = http.request({
      host: '127.0.0.1',
      port: h.port,
      method: 'POST',
      path: '/stream',
      headers: { host: ALICE, cookie, 'content-type': 'text/plain' },
      agent: false,
    })
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve)
      req.on('error', reject)
    })
    req.write('one')
    const body = collect(await response)
    // Each echo arrives while the request body is still open, so neither side was buffered.
    await body.waitFor('echo:one')
    req.write('two')
    await body.waitFor('echo:two')
    req.end()
    await body.ended
    expect(body.text()).toBe('open\necho:one\necho:two\ndone\n')
  })

  it('answers 502 when the workspace drops the exchange', async () => {
    const api = await h.request({ host: ALICE, path: '/reset', headers: { cookie } })
    expect(api.status).toBe(502)
    expect(api.json()).toMatchObject({ error: 'bad_gateway' })
    const page = await h.request({ host: ALICE, path: '/reset', headers: { cookie, 'sec-fetch-mode': 'navigate' } })
    expect(page.status).toBe(502)
    expect(page.body).toContain('Your workspace did not answer')
    expect(events(h.logs, 'proxy.failed')).toHaveLength(2)
  })

  it('records an upstream answer cut mid-body, keeping the partial answer and serving on', async () => {
    const seen = await new Promise<{ status: number; body: string; aborted: boolean }>((resolve, reject) => {
      let settled = false
      const done = (value: { status: number; body: string; aborted: boolean }) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      const req = http.request({ host: '127.0.0.1', port: h.port, method: 'GET', path: '/truncate', headers: { host: ALICE, cookie }, agent: false })
      req.on('response', (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        res.on('aborted', () => done({ status: res.statusCode ?? 0, body, aborted: true }))
        res.on('end', () => done({ status: res.statusCode ?? 0, body, aborted: false }))
        res.on('error', () => done({ status: res.statusCode ?? 0, body, aborted: true }))
      })
      req.on('error', reject)
      req.end()
    })
    // The client keeps its 200 and the bytes it got; the truncation is recorded, never answered twice.
    expect(seen).toEqual({ status: 200, body: 'partial', aborted: true })
    await delay(50)
    expect(events(h.logs, 'proxy.failed')).toHaveLength(0)
    const truncated = h.logs.filter((entry) => entry.event === 'proxy.truncated')
    expect(truncated).toHaveLength(1)
    expect(truncated[0]).toMatchObject({
      handle: 'alice',
      level: 'warn',
      method: 'GET',
      route: '/',
      phase: 'response',
      bytesSent: 7,
      errno: expect.any(String),
    })
    expect(truncated[0].requestId).toEqual(expect.any(String))
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie } })).status).toBe(200)
  })

  it('records a WebSocket the workspace drops without a close frame', async () => {
    const close = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws/drop`, { headers: { host: ALICE, cookie } })
      socket.on('message', (data) => {
        expect(String(data)).toContain('hello')
        socket.send('ping')
      })
      socket.on('close', (code) => resolve(code))
      socket.on('error', () => undefined)
      socket.on('unexpected-response', (_req, res) => reject(new Error(`the upgrade was refused with ${res.statusCode}`)))
    })
    expect(close).toBe(1006)
    await delay(50)
    expect(events(h.logs, 'proxy.failed')).toHaveLength(0)
    const truncated = h.logs.filter((entry) => entry.event === 'proxy.truncated')
    expect(truncated).toHaveLength(1)
    expect(truncated[0]).toMatchObject({ handle: 'alice', level: 'warn', phase: 'websocket', errno: expect.any(String) })
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie } })).status).toBe(200)
  })

  it('stays silent when the client closes its WebSocket first', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws/chat`, { headers: { host: ALICE, cookie } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })
    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve())
      socket.close()
    })
    await delay(50)
    expect(events(h.logs, 'proxy.truncated')).toHaveLength(0)
    expect(events(h.logs, 'proxy.failed')).toHaveLength(0)
  })

  it('stays silent when the client cancels mid-answer', async () => {
    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/stream', headers: { host: ALICE, cookie, 'content-type': 'text/plain' }, agent: false })
      req.on('response', (res) => {
        res.on('data', () => {
          req.destroy()
          res.destroy()
          resolve()
        })
        res.on('error', () => undefined)
      })
      req.on('error', () => undefined)
      req.write('one')
    })
    await delay(50)
    expect(events(h.logs, 'proxy.truncated')).toHaveLength(0)
    expect(events(h.logs, 'proxy.failed')).toHaveLength(0)
  })

  it('retires idle upstream sockets before the workspace closes them and delivers a write once', async () => {
    expect((await h.request({ host: ALICE, path: '/api/analytics', headers: { cookie } })).status).toBe(200)
    const pooled = Object.values(h.context.agent.freeSockets).flat()
    expect(pooled).toHaveLength(1)
    const socket = pooled[0]!
    expect(socket.timeout).toBe(4_000)
    // The workspace stub's keep-alive is five seconds. The gateway must
    // retire its idle socket first, without waiting for the upstream FIN.
    await delay(4_200)
    expect(socket.destroyed).toBe(true)
    const reply = await h.request({ host: ALICE, path: '/api/editor', method: 'PUT', headers: { cookie }, body: 'saved once' })
    expect(reply.status).toBe(200)
    expect(h.workspace.requests.filter(request => request.url === '/api/editor')).toMatchObject([{ method: 'PUT', body: 'saved once' }])
  })

  it('keeps an active full-duplex response open beyond the idle pool timeout', async () => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/stream', headers: { host: ALICE, cookie }, agent: false })
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve)
      req.on('error', reject)
    })
    req.write('before')
    const body = collect(await response)
    await body.waitFor('echo:before')
    await delay(4_200)
    req.end('after')
    await body.ended
    expect(body.text()).toBe('open\necho:before\necho:after\ndone\n')
    expect(events(h.logs, 'proxy.failed')).toHaveLength(0)
  })

  it('keeps a request awaiting response headers open beyond the idle pool timeout', async () => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/api/editor', headers: { host: ALICE, cookie }, agent: false })
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve)
      req.on('error', reject)
    })
    // The workspace's echo waits for the upload to end before answering.
    // This covers the active socket before headers, as well as after them.
    req.write('before')
    await delay(4_200)
    req.end('after')
    const answer = await response
    const body = collect(answer)
    await body.ended
    expect(answer.statusCode).toBe(200)
    expect(JSON.parse(body.text())).toMatchObject({ body: 'beforeafter' })
    expect(h.workspace.requests.filter(request => request.url === '/api/editor')).toHaveLength(1)
  })

  it('answers 503 and starts the workspace when it stops listening', async () => {
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie } })).status).toBe(200)
    h.workspace.reachable = false
    const api = await h.request({ host: ALICE, path: '/api/state', headers: { cookie } })
    expect(api.status).toBe(503)
    expect(api.headers['retry-after']).toBe('2')
    expect(api.json()).toMatchObject({ error: 'workspace_starting' })
    expect(events(h.logs, 'workspace.unreachable')).toHaveLength(1)
    await h.orchestrator.startInProgress('alice')
    expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)
  })
})

describe('streamed request bodies', () => {
  it('stops relaying a chunked body at the limit and answers 413 once', async () => {
    const seen: number[] = []
    const upstream = http.createServer((req, res) => {
      let size = 0
      req.on('data', (chunk: Buffer) => { size += chunk.length })
      req.on('close', () => seen.push(size))
      req.on('end', () => res.end('relayed'))
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as net.AddressInfo).port
    const errors: string[] = []
    const gateway = http.createServer((req, res) => {
      proxyRequest(req, res, { host: '127.0.0.1', port: upstreamPort }, { 'transfer-encoding': 'chunked' }, new http.Agent(), (error) => {
        errors.push(error.message)
        expect(error).toBeInstanceOf(RequestTooLargeError)
        res.writeHead(413, { connection: 'close' })
        res.end()
      }, undefined, 1024)
    })
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    const gatewayPort = (gateway.address() as net.AddressInfo).port
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: gatewayPort, method: 'POST', path: '/', headers: { 'transfer-encoding': 'chunked' } })
        let answered = false
        req.on('response', (res) => {
          answered = true
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        // The gateway closes the connection after refusing; a write racing that close is expected.
        req.on('error', (error) => { if (!answered) reject(error) })
        const chunk = Buffer.alloc(512, 0x61)
        for (let index = 0; index < 64; index += 1) req.write(chunk)
        req.end()
      })
      expect(status).toBe(413)
      await delay(50)
      expect(errors).toEqual(['the request body is larger than 1024 bytes'])
      // The workspace saw at most what arrived before the limit was crossed, never the whole body.
      expect(seen.every((size) => size < 64 * 512)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => gateway.close(() => resolve()))
      gateway.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      upstream.closeAllConnections()
    }
  })
})
