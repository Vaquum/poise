import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APEX, startHarness, verifyAssertion, workspaceHost, type Harness, type Reply } from './harness.js'

const ALICE = workspaceHost('alice')
const BOB = workspaceHost('bob')
const FORM = 'application/x-www-form-urlencoded'

function csrfOf(reply: Reply): string {
  return /name="csrf" value="([^"]+)"/.exec(reply.body)?.[1] ?? ''
}

async function requestCode(h: Harness): Promise<{ device_code: string; user_code: string }> {
  const reply = await h.request({ host: APEX, method: 'POST', path: '/link/device/code', headers: { 'user-agent': 'PoiseLink/1.0 (macOS)' } })
  expect(reply.status).toBe(200)
  return reply.json()
}

function poll(h: Harness, deviceCode: string): Promise<Reply> {
  return h.request({
    host: APEX, method: 'POST', path: '/link/device/token',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  })
}

async function decide(h: Harness, apexCookie: string, userCode: string, decision: 'approve' | 'deny'): Promise<Reply> {
  const page = await h.request({ host: APEX, path: '/link', headers: { cookie: apexCookie } })
  return h.request({
    host: APEX, method: 'POST', path: '/link',
    headers: { cookie: apexCookie, origin: `https://${APEX}`, 'content-type': FORM },
    body: new URLSearchParams({ csrf: csrfOf(page), user_code: userCode, decision }).toString(),
  })
}

async function pair(h: Harness, apexCookie: string): Promise<string> {
  const code = await requestCode(h)
  expect((await decide(h, apexCookie, code.user_code, 'approve')).status).toBe(200)
  const reply = await poll(h, code.device_code)
  expect(reply.status).toBe(200)
  return reply.json<{ access_token: string }>().access_token
}

describe('device pairing', () => {
  let h: Harness
  let alice: { apexCookie: string; workspaceCookie: string }
  beforeEach(async () => {
    h = await startHarness()
    alice = await h.openWorkspace('Alice')
  })
  afterEach(async () => {
    await h.close()
  })

  it('starts with an RFC 8628 device authorization response', async () => {
    const reply = await h.request({ host: APEX, method: 'POST', path: '/link/device/code' })
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.json()).toEqual({
      device_code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      user_code: expect.stringMatching(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
      verification_uri: `https://${APEX}/link`,
      expires_in: 900,
      interval: 5,
    })
  })

  it('answers authorization_pending, slow_down, then the token once approved, and only once', async () => {
    const code = await requestCode(h)
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'authorization_pending' })
    const tooFast = await poll(h, code.device_code)
    expect(tooFast.status).toBe(400)
    expect(tooFast.json()).toEqual({ error: 'slow_down' })
    // slow_down raised the interval to ten seconds.
    h.advance(6_000)
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'slow_down' })
    h.advance(16_000)
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'authorization_pending' })

    // People type codes loosely; the page accepts lower case and a missing dash.
    const approved = await decide(h, alice.apexCookie, code.user_code.toLowerCase().replace('-', ''), 'approve')
    expect(approved.status).toBe(200)
    expect(approved.body).toContain(`paired with ${ALICE}`)

    const issued = await poll(h, code.device_code)
    expect(issued.status).toBe(200)
    expect(issued.json()).toEqual({ access_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), endpoint: `https://${ALICE}`, login: 'Alice' })
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'invalid_grant' })
    expect(h.store.listDevices('alice')).toEqual([expect.objectContaining({ handle: 'alice', label: 'PoiseLink/1.0 (macOS)', revokedAt: null })])
  })

  it('answers access_denied when the person denies the code', async () => {
    const code = await requestCode(h)
    expect((await decide(h, alice.apexCookie, code.user_code, 'deny')).status).toBe(200)
    const reply = await poll(h, code.device_code)
    expect(reply.status).toBe(400)
    expect(reply.json()).toEqual({ error: 'access_denied' })
  })

  it('answers expired_token after fifteen minutes and refuses to approve an expired code', async () => {
    const code = await requestCode(h)
    h.advance(15 * 60_000 + 1000)
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'expired_token' })
    expect((await decide(h, alice.apexCookie, code.user_code, 'approve')).status).toBe(400)
  })

  it('refuses unknown device codes and malformed requests', async () => {
    expect((await poll(h, 'not-a-code')).json()).toEqual({ error: 'invalid_grant' })
    const malformed = await h.request({ host: APEX, method: 'POST', path: '/link/device/token', body: 'device_code=x' })
    expect(malformed.status).toBe(400)
    expect(malformed.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('needs a signed-in person, a CSRF token and the apex origin to decide a code', async () => {
    const code = await requestCode(h)
    const page = await h.request({ host: APEX, path: '/link', headers: { cookie: alice.apexCookie } })
    const body = (csrf: string) => new URLSearchParams({ csrf, user_code: code.user_code, decision: 'approve' }).toString()

    const signedOut = await h.request({ host: APEX, method: 'POST', path: '/link', headers: { origin: `https://${APEX}`, 'content-type': FORM }, body: body(csrfOf(page)) })
    expect(signedOut.status).toBe(403)
    const noToken = await h.request({ host: APEX, method: 'POST', path: '/link', headers: { cookie: alice.apexCookie, origin: `https://${APEX}`, 'content-type': FORM }, body: body('') })
    expect(noToken.status).toBe(403)
    const crossSite = await h.request({ host: APEX, method: 'POST', path: '/link', headers: { cookie: alice.apexCookie, origin: 'https://evil.example', 'content-type': FORM }, body: body(csrfOf(page)) })
    expect(crossSite.status).toBe(403)
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'authorization_pending' })

    const signedOutPage = await h.request({ host: APEX, path: '/link' })
    expect(signedOutPage.status).toBe(302)
    expect(signedOutPage.headers.location).toBe('/auth/login?next=%2Flink')
  })

  it('lets a device token reach /api/link/* with the link scope and nothing else', async () => {
    const token = await pair(h, alice.apexCookie)
    const hello = await h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: `Bearer ${token}` } })
    expect(hello.status).toBe(200)
    const { headers } = hello.json<{ headers: Record<string, string> }>()
    expect(headers.authorization).toBeUndefined()
    expect(verifyAssertion(headers['x-poise-identity'], h.keys.publicKeyBase64)).toMatchObject({ aud: 'workspace:alice', sub: 'Alice', scope: 'link' })

    // Dot segments, encoded or not, would let a URL parser resolve the path outside /api/link/.
    for (const path of ['/api/chat', '/', '/api/link', '/api/link/../settings', '/api/link/%2e%2e/settings', '/api/link/x/..']) {
      const reply = await h.request({ host: ALICE, path, headers: { authorization: `Bearer ${token}` } })
      expect(reply.status, path).toBe(401)
      expect(reply.headers['www-authenticate']).toBe('Bearer error="invalid_token"')
    }
    // A device token never falls back to a browser session either.
    const both = await h.request({ host: ALICE, path: '/api/chat', headers: { authorization: `Bearer ${token}`, cookie: alice.workspaceCookie } })
    expect(both.status).toBe(401)
    expect(h.workspace.requests.map((request) => request.url)).toEqual(['/api/link/hello'])
  })

  it('refuses unknown and revoked device tokens', async () => {
    const token = await pair(h, alice.apexCookie)
    expect((await h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: 'Bearer guessed' } })).status).toBe(401)
    expect((await h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: 'Bearer' } })).status).toBe(401)

    const list = await h.request({ host: APEX, path: '/link/devices', headers: { cookie: alice.apexCookie } })
    expect(list.status).toBe(200)
    expect(list.body).toContain('PoiseLink/1.0 (macOS)')
    const id = /name="id" value="([^"]+)"/.exec(list.body)?.[1] ?? ''
    const revoked = await h.request({
      host: APEX, method: 'POST', path: '/link/devices/revoke',
      headers: { cookie: alice.apexCookie, origin: `https://${APEX}`, 'content-type': FORM },
      body: new URLSearchParams({ csrf: csrfOf(list), id }).toString(),
    })
    expect(revoked.status).toBe(303)
    expect(revoked.headers.location).toBe('/link/devices')

    const after = await h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: `Bearer ${token}` } })
    expect(after.status).toBe(401)
    expect(after.json()).toMatchObject({ error: 'invalid_token' })
  })

  it('keeps a device to the workspace that paired it and to its owner\'s device list', async () => {
    const token = await pair(h, alice.apexCookie)
    const bob = await h.openWorkspace('bob')
    const crossed = await h.request({ host: BOB, path: '/api/link/hello', headers: { authorization: `Bearer ${token}` } })
    expect(crossed.status).toBe(403)

    const aliceDevice = h.store.listDevices('alice')[0]
    const bobList = await h.request({ host: APEX, path: '/link/devices', headers: { cookie: bob.apexCookie } })
    expect(bobList.body).not.toContain(aliceDevice.id)
    const bobHome = await h.request({ host: APEX, path: '/', headers: { cookie: bob.apexCookie } })
    const stolen = await h.request({
      host: APEX, method: 'POST', path: '/link/devices/revoke',
      headers: { cookie: bob.apexCookie, origin: `https://${APEX}`, 'content-type': FORM },
      body: new URLSearchParams({ csrf: csrfOf(bobHome), id: aliceDevice.id }).toString(),
    })
    expect(stolen.status).toBe(404)
    expect(h.store.listDevices('alice')[0].revokedAt).toBeNull()
  })

  it('expires a device after 30 days unused and a year after pairing, so Poise Link pairs again', async () => {
    const day = 24 * 60 * 60_000
    const token = await pair(h, alice.apexCookie)
    const hello = () => h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: `Bearer ${token}` } })
    for (let month = 0; month < 12; month += 1) {
      h.advance(29 * day)
      expect((await hello()).status, `after ${(month + 1) * 29} days`).toBe(200)
    }
    // Still in use, but 365 days old.
    h.advance(17 * day)
    const old = await hello()
    expect(old.status).toBe(401)
    expect(old.json()).toMatchObject({ error: 'invalid_token' })

    // A year on, alice signs in again to pair a second device, then leaves it unused.
    const { apexCookie } = await h.signIn('Alice')
    const idle = await pair(h, apexCookie)
    h.advance(30 * day)
    expect((await h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: `Bearer ${idle}` } })).status).toBe(401)
    const list = await h.request({ host: APEX, path: '/link/devices', headers: { cookie: (await h.signIn('Alice')).apexCookie } })
    expect(list.body.match(/Expired; pair it again/g)).toHaveLength(2)
  })

  it('lets a session try only ten codes in fifteen minutes', async () => {
    const page = await h.request({ host: APEX, path: '/link', headers: { cookie: alice.apexCookie } })
    const attempt = (userCode: string) => h.request({
      host: APEX, method: 'POST', path: '/link',
      headers: { cookie: alice.apexCookie, origin: `https://${APEX}`, 'content-type': FORM },
      body: new URLSearchParams({ csrf: csrfOf(page), user_code: userCode, decision: 'approve' }).toString(),
    })
    const code = await requestCode(h)
    for (let guess = 0; guess < 10; guess += 1) expect((await attempt('BCDF-GHJK')).status).toBe(400)
    const limited = await attempt(code.user_code)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(890)
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'authorization_pending' })
    expect(h.logs.filter((entry) => entry.event === 'device.code.rate_limited')).toHaveLength(1)

    h.advance(15 * 60_000)
    const fresh = await requestCode(h)
    expect((await attempt(fresh.user_code)).status).toBe(200)
  })

  it('stores only hashes of device codes and tokens', async () => {
    const code = await requestCode(h)
    await decide(h, alice.apexCookie, code.user_code, 'approve')
    const token = (await poll(h, code.device_code)).json<{ access_token: string }>().access_token
    for (const file of readdirSync(h.config.dataDir)) {
      const bytes = readFileSync(join(h.config.dataDir, file))
      expect(bytes.includes(token)).toBe(false)
      expect(bytes.includes(code.device_code)).toBe(false)
    }
  })
})
