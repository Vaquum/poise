import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  it('replaces client identity and forwarding headers and keeps Host, Origin and the client\'s own cookies', async () => {
    const reply = await h.request({
      host: ALICE,
      path: '/api/echo',
      headers: {
        cookie: `a=1; ${cookie}; b=2`,
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
    expect(headers.cookie).toBe('a=1; b=2')
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

  it('passes status, body and repeated response headers through unchanged', async () => {
    const reply = await h.request({ host: ALICE, path: '/created', headers: { cookie } })
    expect(reply.status).toBe(201)
    expect(reply.body).toBe('created')
    expect(reply.headers['x-workspace']).toBe('yes')
    expect(reply.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/'])
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
