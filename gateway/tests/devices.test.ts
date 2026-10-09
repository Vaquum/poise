import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { LINK_INSTALLER_URL, LINK_RELEASES_URL } from '../src/pages.js'
import { APEX, startHarness, verifyAssertion, workspaceHost, type Harness, type Reply } from './harness.js'

const ALICE = workspaceHost('alice')
const BOB = workspaceHost('bob')

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

/** A call to the gateway's API on a workspace host, as Settings makes it from that host's own page. */
function api(h: Harness, host: string, cookie: string, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Reply> {
  return h.request({
    host,
    method: body === undefined ? 'GET' : 'POST',
    path: `/_poise/api/${path}`,
    headers: {
      cookie,
      'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { origin: `https://${host}`, 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Settings → Poise Link approving or denying the code Poise Link shows. */
function decide(h: Harness, workspaceCookie: string, userCode: string, decision: 'approve' | 'deny', host = ALICE): Promise<Reply> {
  return api(h, host, workspaceCookie, 'devices/pair', { userCode, decision })
}

/** What Poise Link relies on: 401 with a JSON reason, never 403 and never a redirect. */
function expectDeviceRefusal(reply: Reply, error: string): void {
  expect(reply.status, error).toBe(401)
  expect(reply.headers.location).toBeUndefined()
  expect(reply.headers['www-authenticate']).toBe('Bearer error="invalid_token"')
  expect(reply.headers['content-type']).toContain('application/json')
  expect(reply.json()).toMatchObject({ error })
}

/** A Link API call dressed as a browser navigation, which would otherwise be redirected to sign-in. */
function linkCall(h: Harness, host: string, token: string): Promise<Reply> {
  return h.request({
    host,
    path: '/api/link/events',
    headers: { authorization: `Bearer ${token}`, 'sec-fetch-mode': 'navigate', accept: 'text/html' },
  })
}

async function pair(h: Harness, workspaceCookie: string, host = ALICE): Promise<string> {
  const code = await requestCode(h)
  expect((await decide(h, workspaceCookie, code.user_code, 'approve', host)).status).toBe(200)
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
    const approved = await decide(h, alice.workspaceCookie, code.user_code.toLowerCase().replace('-', ''), 'approve')
    expect(approved.status).toBe(200)
    expect(approved.json()).toEqual({ decision: 'approve', message: `Approved. Poise Link on that computer is now paired with ${ALICE}.` })

    const issued = await poll(h, code.device_code)
    expect(issued.status).toBe(200)
    expect(issued.json()).toEqual({ access_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), endpoint: `https://${ALICE}`, login: 'Alice' })
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'invalid_grant' })
    expect(h.store.listDevices('alice')).toEqual([expect.objectContaining({ handle: 'alice', label: 'PoiseLink/1.0 (macOS)', revokedAt: null })])
  })

  it('answers access_denied when the person denies the code', async () => {
    const code = await requestCode(h)
    const denied = await decide(h, alice.workspaceCookie, code.user_code, 'deny')
    expect(denied.status).toBe(200)
    expect(denied.json()).toEqual({ decision: 'deny', message: 'Denied. That computer will not be paired.' })
    const reply = await poll(h, code.device_code)
    expect(reply.status).toBe(400)
    expect(reply.json()).toEqual({ error: 'access_denied' })
  })

  it('answers expired_token after fifteen minutes and refuses to approve an expired code', async () => {
    const code = await requestCode(h)
    h.advance(15 * 60_000 + 1000)
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'expired_token' })
    const expired = await decide(h, alice.workspaceCookie, code.user_code, 'approve')
    expect(expired.status).toBe(400)
    expect(expired.json()).toEqual({ error: 'invalid_code', message: 'That code is not valid or has expired. Start pairing again in Poise Link.' })
  })

  it('refuses unknown device codes and malformed requests', async () => {
    expect((await poll(h, 'not-a-code')).json()).toEqual({ error: 'invalid_grant' })
    const malformed = await h.request({ host: APEX, method: 'POST', path: '/link/device/token', body: 'device_code=x' })
    expect(malformed.status).toBe(400)
    expect(malformed.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('decides a code only for the owner\'s own session, from the workspace\'s own page', async () => {
    const code = await requestCode(h)
    const body = { userCode: code.user_code, decision: 'approve' }
    const bob = await h.openWorkspace('bob')

    expect((await api(h, ALICE, '', 'devices/pair', body)).status).toBe(401)
    // Bob's session on Alice's host is not Alice's.
    expect((await api(h, ALICE, bob.workspaceCookie, 'devices/pair', body)).status).toBe(403)
    // The apex session alone is not a workspace session.
    expect((await api(h, ALICE, alice.apexCookie, 'devices/pair', body)).status).toBe(401)
    // Another origin, a sibling workspace host included, or none at all.
    for (const origin of ['https://evil.example', `https://${BOB}`, `https://${APEX}`, 'null']) {
      expect((await api(h, ALICE, alice.workspaceCookie, 'devices/pair', body, { origin })).status, origin).toBe(403)
    }
    const noOrigin = await h.request({
      host: ALICE, method: 'POST', path: '/_poise/api/devices/pair',
      headers: { cookie: alice.workspaceCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(noOrigin.status).toBe(403)
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect((await api(h, ALICE, alice.workspaceCookie, 'devices/pair', body, { 'sec-fetch-site': site })).status, site).toBe(403)
    }
    // A form post cannot be made to look like the JSON Settings sends.
    const form = await api(h, ALICE, alice.workspaceCookie, 'devices/pair', body, { 'content-type': 'application/x-www-form-urlencoded' })
    expect(form.status).toBe(415)
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'authorization_pending' })
    // The gateway answers these itself: none reaches the workspace.
    expect(h.workspace.requests).toHaveLength(0)
  })

  it('sends Poise Link\'s /link and the old device list to Settings in the workspace', async () => {
    for (const path of ['/link', '/link/devices']) {
      const page = await h.request({ host: APEX, path, headers: { cookie: alice.apexCookie } })
      expect(page.status, path).toBe(302)
      expect(page.headers.location, path).toBe(`https://${ALICE}/?settings=link`)
    }
    const signedOut = await h.request({ host: APEX, path: '/link' })
    expect(signedOut.status).toBe(302)
    expect(signedOut.headers.location).toBe('/auth/login?next=%2Flink')
    // The apex no longer takes codes or revocations itself.
    for (const path of ['/link', '/link/devices/revoke']) {
      expect((await h.request({ host: APEX, method: 'POST', path, headers: { cookie: alice.apexCookie, origin: `https://${APEX}` } })).status, path).not.toBe(200)
    }
  })

  it('lets a device token reach /api/link/* with the link scope and nothing else', async () => {
    const token = await pair(h, alice.workspaceCookie)
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
    const token = await pair(h, alice.workspaceCookie)
    expect((await h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: 'Bearer guessed' } })).status).toBe(401)
    expect((await h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: 'Bearer' } })).status).toBe(401)

    const list = await api(h, ALICE, alice.workspaceCookie, 'devices')
    expect(list.status).toBe(200)
    const [device] = list.json<{ devices: Array<{ id: string; label: string; state: string }> }>().devices
    expect(device).toMatchObject({ label: 'PoiseLink/1.0 (macOS)', state: 'active', revokedAt: null })
    const revoked = await api(h, ALICE, alice.workspaceCookie, 'devices/revoke', { id: device.id })
    expect(revoked.status).toBe(200)
    expect(revoked.json<{ devices: Array<{ state: string }> }>().devices).toEqual([expect.objectContaining({ id: device.id, state: 'revoked' })])

    const after = await h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: `Bearer ${token}` } })
    expectDeviceRefusal(after, 'device_revoked')
  })

  it('keeps a device to the workspace that paired it and to its owner\'s device list', async () => {
    const token = await pair(h, alice.workspaceCookie)
    const bob = await h.openWorkspace('bob')
    const crossed = await h.request({ host: BOB, path: '/api/link/hello', headers: { authorization: `Bearer ${token}` } })
    expectDeviceRefusal(crossed, 'device_unknown')

    const aliceDevice = h.store.listDevices('alice')[0]
    const bobList = await api(h, BOB, bob.workspaceCookie, 'devices')
    expect(bobList.json()).toEqual({ devices: [] })
    const stolen = await api(h, BOB, bob.workspaceCookie, 'devices/revoke', { id: aliceDevice.id })
    expect(stolen.status).toBe(404)
    expect(h.store.listDevices('alice')[0].revokedAt).toBeNull()
  })

  it('expires a device after 30 days unused and a year after pairing, so Poise Link pairs again', async () => {
    const day = 24 * 60 * 60_000
    const token = await pair(h, alice.workspaceCookie)
    const hello = () => h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: `Bearer ${token}` } })
    for (let month = 0; month < 12; month += 1) {
      h.advance(29 * day)
      expect((await hello()).status, `after ${(month + 1) * 29} days`).toBe(200)
    }
    // Still in use, but 365 days old.
    h.advance(17 * day)
    expectDeviceRefusal(await hello(), 'device_expired')

    // A year on, alice signs in again to pair a second device, then leaves it unused.
    const idle = await pair(h, (await h.openWorkspace('Alice')).workspaceCookie)
    h.advance(30 * day)
    expect((await h.request({ host: ALICE, path: '/api/link/hello', headers: { authorization: `Bearer ${idle}` } })).status).toBe(401)
    const list = await api(h, ALICE, (await h.openWorkspace('Alice')).workspaceCookie, 'devices')
    expect(list.json<{ devices: Array<{ state: string }> }>().devices.map((device) => device.state)).toEqual(['expired', 'expired'])
  })

  it('answers every unusable device token with 401 and a reason, never 403 or a redirect', async () => {
    const day = 24 * 60 * 60_000
    expectDeviceRefusal(await linkCall(h, ALICE, 'never-issued'), 'device_unknown')

    const elsewhere = await pair(h, alice.workspaceCookie)
    await h.openWorkspace('bob')
    expectDeviceRefusal(await linkCall(h, BOB, elsewhere), 'device_unknown')

    const revoked = await pair(h, alice.workspaceCookie)
    expect(h.store.revokeDevice('alice', h.store.findDeviceByToken(revoked)?.id ?? '')).toBe(true)
    expectDeviceRefusal(await linkCall(h, ALICE, revoked), 'device_revoked')

    const idle = await pair(h, alice.workspaceCookie)
    h.advance(31 * day)
    expectDeviceRefusal(await linkCall(h, ALICE, idle), 'device_expired')

    // Removed from the allow list without being disabled: the device survives, the access does not.
    h.store.addAllowed('mallory', 'root')
    const mallory = await h.openWorkspace('mallory')
    const malloryToken = await pair(h, mallory.workspaceCookie, workspaceHost('mallory'))
    h.store.removeAllowed('mallory')
    expectDeviceRefusal(await linkCall(h, workspaceHost('mallory'), malloryToken), 'access_removed')

    // Disabling revokes every device; a device that somehow outlived it still meets the per-request flag.
    const before = await pair(h, (await h.openWorkspace('Alice')).workspaceCookie)
    h.store.disableUser('alice', 'root')
    expectDeviceRefusal(await linkCall(h, ALICE, before), 'device_revoked')
    const code = h.store.createDeviceCode(null, 60_000, 5)
    h.store.decideDeviceCode(code.userCode, 'alice', true)
    const outlived = h.store.pollDeviceCode(code.deviceCode, 5)
    expect(outlived.issued).toBe(true)
    expectDeviceRefusal(await linkCall(h, ALICE, outlived.issued ? outlived.token : ''), 'user_disabled')

    const upgrade = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${h.port}/api/link/events`, { headers: { host: ALICE, authorization: `Bearer ${revoked}` } })
      socket.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      socket.on('error', reject)
    })
    expect(upgrade.status).toBe(401)
    expect(JSON.parse(upgrade.body)).toMatchObject({ error: 'device_revoked' })
    expect(h.workspace.requests).toHaveLength(0)
  })

  it('answers the token endpoint with exactly the documented RFC 8628 errors', async () => {
    const answers: Array<[string, Reply]> = []
    const code = await requestCode(h)
    answers.push(['authorization_pending', await poll(h, code.device_code)])
    answers.push(['slow_down', await poll(h, code.device_code)])
    const denied = await requestCode(h)
    await decide(h, alice.workspaceCookie, denied.user_code, 'deny')
    answers.push(['access_denied', await poll(h, denied.device_code)])
    const approved = await requestCode(h)
    await decide(h, alice.workspaceCookie, approved.user_code, 'approve')
    expect((await poll(h, approved.device_code)).status).toBe(200)
    answers.push(['invalid_grant', await poll(h, approved.device_code)])
    answers.push(['invalid_grant', await poll(h, 'never-issued')])
    h.advance(15 * 60_000 + 1000)
    answers.push(['expired_token', await poll(h, code.device_code)])
    for (const [error, reply] of answers) {
      expect(reply.status, error).toBe(400)
      expect(reply.json(), error).toEqual({ error })
    }
    const malformed = await h.request({ host: APEX, method: 'POST', path: '/link/device/token', body: '{}' })
    expect(malformed.status).toBe(400)
    expect(malformed.json()).toEqual({ error: 'invalid_request', error_description: 'Send {"device_code": "..."} as JSON.' })
  })

  it('lets a sign-in try only ten codes in fifteen minutes, across its hosts', async () => {
    const attempt = (userCode: string) => decide(h, alice.workspaceCookie, userCode, 'approve')
    const code = await requestCode(h)
    for (let guess = 0; guess < 10; guess += 1) expect((await attempt('BCDF-GHJK')).status).toBe(400)
    const limited = await attempt(code.user_code)
    expect(limited.status).toBe(429)
    expect(limited.json()).toEqual({ error: 'too_many_requests', message: 'Too many codes were tried. Try again in 15 minutes.' })
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(890)
    expect((await poll(h, code.device_code)).json()).toEqual({ error: 'authorization_pending' })
    expect(h.logs.filter((entry) => entry.event === 'device.code.rate_limited')).toHaveLength(1)

    h.advance(15 * 60_000)
    const fresh = await requestCode(h)
    expect((await attempt(fresh.user_code)).status).toBe(200)
  })

  it('tells Settings how to install Poise Link, with the command the installer documents', async () => {
    const account = await api(h, ALICE, alice.workspaceCookie, 'account')
    expect(account.status).toBe(200)
    expect(account.json()).toEqual({
      login: 'Alice',
      handle: 'alice',
      isAdmin: false,
      workspaceHost: ALICE,
      apexOrigin: `https://${APEX}`,
      link: { installer: LINK_INSTALLER_URL, releases: LINK_RELEASES_URL },
    })
    const installer = readFileSync(new URL('../../link/install.sh', import.meta.url), 'utf8')
    expect(installer).toContain(`curl -fsSL ${LINK_INSTALLER_URL} | sh`)
  })

  it('stores only hashes of device codes and tokens', async () => {
    const code = await requestCode(h)
    await decide(h, alice.workspaceCookie, code.user_code, 'approve')
    const token = (await poll(h, code.device_code)).json<{ access_token: string }>().access_token
    for (const file of readdirSync(h.config.dataDir)) {
      const bytes = readFileSync(join(h.config.dataDir, file))
      expect(bytes.includes(token)).toBe(false)
      expect(bytes.includes(code.device_code)).toBe(false)
    }
  })
})
