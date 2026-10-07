import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { APEX, events, startHarness, workspaceHost, type Harness } from './harness.js'

const ALICE = workspaceHost('alice')
const BOB = workspaceHost('bob')
const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html' }

async function ticketFor(h: Harness, login: string, host: string, next = '/'): Promise<{ apexCookie: string; bindCookie: string; ticket: string }> {
  const { reply, apexCookie, bindCookie } = await h.signIn(login, `https://${host}${next}`)
  expect(reply.status).toBe(302)
  return { apexCookie, bindCookie, ticket: new URL(reply.headers.location ?? '').searchParams.get('ticket') ?? '' }
}

function upgradeStatus(h: Harness, host: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws/chat`, { headers: { host, ...headers } })
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
      res.resume()
    })
    socket.on('open', () => {
      socket.close()
      resolve(101)
    })
    socket.on('error', reject)
  })
}

describe('hosts', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('answers 404 for hosts that are neither the apex nor a known workspace', async () => {
    await h.openWorkspace('alice')
    for (const host of ['evil.example', `www.${APEX}`, `admin.${APEX}`, `a.b.${APEX}`, `x${APEX}`, workspaceHost('nobody'), '127.0.0.1']) {
      const reply = await h.request({ host, path: '/' })
      expect(reply.status, host).toBe(404)
    }
    expect(h.workspace.requests).toHaveLength(0)
    expect(await upgradeStatus(h, 'evil.example')).toBe(404)
  })

  it('answers the TLS ask for the apex and known handles only, and only at gateway:8080', async () => {
    await h.openWorkspace('alice')
    const ask = (domain: string, host = 'gateway:8080') => h.request({ host, path: `/_gateway/tls-ask?domain=${encodeURIComponent(domain)}` })
    expect((await ask(APEX)).status).toBe(200)
    expect((await ask(ALICE)).status).toBe(200)
    expect((await ask(BOB)).status).toBe(404) // allowed, but has never signed in
    expect((await ask(`www.${APEX}`)).status).toBe(404)
    expect((await ask('alice.evil.example')).status).toBe(404)
    expect((await ask('')).status).toBe(404)
    // Nobody outside the deployment can use it to learn which handles exist. On a workspace host the
    // path is the workspace's own, so it needs a session like any other.
    for (const host of [APEX, ALICE, `www.${APEX}`, `gateway.${APEX}`, 'evil.example', 'gateway', 'gateway:9999', '127.0.0.1:8080']) {
      const reply = await ask(ALICE, host)
      expect(reply.status, host).toBe(host === ALICE ? 401 : 404)
      expect(reply.body).not.toBe('ok\n')
    }
  })

  it('answers the TLS ask at POISE_PROXY_LISTEN too, where a proxy of the operator\'s own asks it', async () => {
    await h.close()
    h = await startHarness({ env: { POISE_PROXY_LISTEN: '[FD00::5]:8080' } })
    await h.openWorkspace('alice')
    const ask = (domain: string, host: string) => h.request({ host, path: `/_gateway/tls-ask?domain=${encodeURIComponent(domain)}` })
    for (const host of ['[fd00::5]:8080', '[FD00::5]:8080', 'gateway:8080']) {
      expect((await ask(APEX, host)).status, host).toBe(200)
      expect((await ask(ALICE, host)).status, host).toBe(200)
      expect((await ask(BOB, host)).status, host).toBe(404)
    }
    for (const host of [APEX, '[fd00::5]', '[fd00::5]:9999', '[fd00::6]:8080', '127.0.0.1:8080']) {
      expect((await ask(ALICE, host)).status, host).toBe(404)
    }
  })
})

describe('workspace hosts', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('sends navigations without a session to apex sign-in and gives API calls 401 JSON', async () => {
    await h.openWorkspace('alice')
    const navigation = await h.request({ host: ALICE, path: '/settings?tab=accounts', headers: NAVIGATE })
    expect(navigation.status).toBe(302)
    expect(navigation.headers.location).toBe(`https://${APEX}/auth/login?next=${encodeURIComponent(`https://${ALICE}/settings?tab=accounts`)}`)

    const api = await h.request({ host: ALICE, path: '/api/settings', headers: { accept: 'application/json' } })
    expect(api.status).toBe(401)
    expect(api.headers['content-type']).toContain('application/json')
    expect(api.json()).toMatchObject({ error: 'unauthorized' })

    const post = await h.request({ host: ALICE, method: 'POST', path: '/api/settings', headers: { accept: 'text/html' }, body: '{}' })
    expect(post.status).toBe(401)
    expect(await upgradeStatus(h, ALICE)).toBe(401)
    expect(h.workspace.requests).toHaveLength(0)
  })

  it('rejects another person\'s session with 403', async () => {
    const alice = await h.openWorkspace('alice')
    await h.openWorkspace('bob')
    const page = await h.request({ host: BOB, path: '/', headers: { ...NAVIGATE, cookie: alice.workspaceCookie } })
    expect(page.status).toBe(403)
    const api = await h.request({ host: BOB, path: '/api/state', headers: { cookie: alice.workspaceCookie } })
    expect(api.status).toBe(403)
    expect(api.json()).toMatchObject({ error: 'forbidden' })
    expect(await upgradeStatus(h, BOB, { cookie: alice.workspaceCookie })).toBe(403)
    // The apex session is not a workspace session either.
    const apexCookie = alice.apexCookie.replace('poise_gw=', 'poise_ws=')
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie: apexCookie } })).status).toBe(401)
    expect(h.workspace.requests).toHaveLength(0)
  })

  it('gives admins no implicit access to other people\'s workspaces', async () => {
    await h.openWorkspace('alice')
    const { reply, apexCookie } = await h.signIn('root', `https://${ALICE}/`)
    expect(reply.status).toBe(403)
    expect(reply.body).toContain('belongs to someone else')
    expect(h.logs.find((entry) => entry.event === 'session.ticket.refused')).toMatchObject({ login: 'root', host: 'alice' })
    const again = await h.request({ host: APEX, path: `/auth/login?next=${encodeURIComponent(`https://${ALICE}/`)}`, headers: { cookie: apexCookie } })
    expect(again.status).toBe(403)

    const root = await h.openWorkspace('root')
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie: root.workspaceCookie } })).status).toBe(403)
  })

  it('treats a forged session cookie as no session', async () => {
    await h.openWorkspace('alice')
    const forged = 'poise_ws=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie: forged } })).status).toBe(401)
    expect((await h.request({ host: APEX, path: '/admin', headers: { cookie: 'poise_gw=forged' } })).status).toBe(302)
  })

  it('ends sessions after 14 days', async () => {
    const { apexCookie, workspaceCookie } = await h.openWorkspace('alice')
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie: workspaceCookie } })).status).toBe(200)
    h.advance(14 * 24 * 60 * 60_000 + 1000)
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie: workspaceCookie } })).status).toBe(401)
    expect((await h.request({ host: APEX, path: '/', headers: { cookie: apexCookie } })).body).toContain('Sign in with GitHub')
  })

  it('picks the valid session when the browser sends several poise_ws cookies', async () => {
    const alice = await h.openWorkspace('alice')
    const reply = await h.request({ host: ALICE, path: '/api/state', headers: { cookie: `poise_ws=stale; ${alice.workspaceCookie}` } })
    expect(reply.status).toBe(200)
  })
})

describe('tickets', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('sets poise_bind for the whole domain at sign-in', async () => {
    const { reply } = await h.signIn('alice')
    expect(reply.setCookie('poise_bind')).toMatch(/^poise_bind=[A-Za-z0-9_-]{43}; Domain=poise\.test; Path=\/; Max-Age=1209600; HttpOnly; SameSite=Lax; Secure$/)
  })

  it('sets poise_ws with the contract attributes and lifetime and continues to next', async () => {
    const { ticket, bindCookie } = await ticketFor(h, 'alice', ALICE, '/chat?id=7')
    const reply = await h.request({ host: ALICE, path: `/_poise/session?ticket=${ticket}&next=${encodeURIComponent('/chat?id=7')}`, headers: { cookie: bindCookie } })
    expect(reply.status).toBe(302)
    expect(reply.headers.location).toBe('/chat?id=7')
    expect(reply.setCookie('poise_ws')).toMatch(/^poise_ws=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=(1209600|1209599); HttpOnly; SameSite=Lax; Secure$/)
  })

  it('redeems a ticket only in the browser it was minted for', async () => {
    const { ticket, bindCookie } = await ticketFor(h, 'alice', ALICE)
    const path = `/_poise/session?ticket=${ticket}&next=/`
    const unbound = await h.request({ host: ALICE, path })
    expect(unbound.status).toBe(403)
    expect(unbound.setCookie('poise_ws')).toBeUndefined()
    expect(h.logs.find((entry) => entry.event === 'session.ticket.rejected')).toMatchObject({ reason: 'the ticket was issued to another browser' })
    // The refusal burnt the ticket, so not even the right browser can use it now.
    expect((await h.request({ host: ALICE, path, headers: { cookie: bindCookie } })).status).toBe(403)

    // Login CSRF: bob mints a ticket for his own workspace and sends the link to alice's browser.
    const alice = await h.openWorkspace('alice')
    const { ticket: bobs } = await ticketFor(h, 'bob', BOB)
    const lured = await h.request({ host: BOB, path: `/_poise/session?ticket=${bobs}&next=/`, headers: { cookie: alice.bindCookie } })
    expect(lured.status).toBe(403)
    expect(lured.setCookie('poise_ws')).toBeUndefined()
  })

  it('mints a binding when a signed-in browser has none, and keeps one it already holds', async () => {
    const { apexCookie } = await h.signIn('alice')
    const reply = await h.request({ host: APEX, path: `/auth/login?next=${encodeURIComponent(`https://${ALICE}/`)}`, headers: { cookie: apexCookie } })
    expect(reply.status).toBe(302)
    const bindCookie = reply.cookie('poise_bind')
    const ticket = new URL(reply.headers.location ?? '').searchParams.get('ticket') ?? ''
    expect((await h.request({ host: ALICE, path: `/_poise/session?ticket=${ticket}&next=/`, headers: { cookie: bindCookie } })).status).toBe(302)

    // A browser that already holds a binding keeps it.
    const again = await h.request({ host: APEX, path: `/auth/login?next=${encodeURIComponent(`https://${ALICE}/`)}`, headers: { cookie: `${apexCookie}; ${bindCookie}` } })
    expect(again.setCookie('poise_bind')).toBeUndefined()
    const second = new URL(again.headers.location ?? '').searchParams.get('ticket') ?? ''
    expect((await h.request({ host: ALICE, path: `/_poise/session?ticket=${second}&next=/`, headers: { cookie: bindCookie } })).status).toBe(302)
  })

  it('accepts each ticket once', async () => {
    const { ticket, bindCookie } = await ticketFor(h, 'alice', ALICE)
    const path = `/_poise/session?ticket=${ticket}&next=/`
    expect((await h.request({ host: ALICE, path, headers: { cookie: bindCookie } })).status).toBe(302)
    const replay = await h.request({ host: ALICE, path, headers: { cookie: bindCookie } })
    expect(replay.status).toBe(403)
    expect(replay.setCookie('poise_ws')).toBeUndefined()
    expect(h.logs.find((entry) => entry.event === 'session.ticket.rejected')).toMatchObject({ reason: 'used' })
  })

  it('expires tickets after 60 seconds', async () => {
    const { ticket, bindCookie } = await ticketFor(h, 'alice', ALICE)
    h.advance(61_000)
    const reply = await h.request({ host: ALICE, path: `/_poise/session?ticket=${ticket}&next=/`, headers: { cookie: bindCookie } })
    expect(reply.status).toBe(403)
    expect(reply.setCookie('poise_ws')).toBeUndefined()
    expect(h.logs.find((entry) => entry.event === 'session.ticket.rejected')).toMatchObject({ reason: 'expired' })
  })

  it('refuses a ticket on another host and burns it', async () => {
    await h.openWorkspace('bob')
    const { ticket, bindCookie } = await ticketFor(h, 'alice', ALICE)
    const wrongHost = await h.request({ host: BOB, path: `/_poise/session?ticket=${ticket}&next=/`, headers: { cookie: bindCookie } })
    expect(wrongHost.status).toBe(403)
    expect(wrongHost.setCookie('poise_ws')).toBeUndefined()
    expect((await h.request({ host: ALICE, path: `/_poise/session?ticket=${ticket}&next=/`, headers: { cookie: bindCookie } })).status).toBe(403)
  })

  it('refuses a ticket whose apex session has ended', async () => {
    const { ticket, apexCookie, bindCookie } = await ticketFor(h, 'alice', ALICE)
    const home = await h.request({ host: APEX, path: '/', headers: { cookie: apexCookie } })
    const csrf = /name="csrf" value="([^"]+)"/.exec(home.body)?.[1] ?? ''
    await h.request({
      host: APEX, method: 'POST', path: '/auth/logout',
      headers: { cookie: apexCookie, origin: `https://${APEX}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${encodeURIComponent(csrf)}`,
    })
    expect((await h.request({ host: ALICE, path: `/_poise/session?ticket=${ticket}&next=/`, headers: { cookie: bindCookie } })).status).toBe(403)
  })

  it('refuses a next that leaves the workspace host', async () => {
    for (const next of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'evil', '/%0d%0aSet-Cookie:x=1'.replace('%0d%0a', '\r\n')]) {
      const { ticket, bindCookie } = await ticketFor(h, 'alice', ALICE)
      const reply = await h.request({ host: ALICE, path: `/_poise/session?ticket=${ticket}&next=${encodeURIComponent(next)}`, headers: { cookie: bindCookie } })
      expect(reply.status, next).toBe(400)
      expect(reply.headers.location).toBeUndefined()
      expect(reply.setCookie('poise_ws')).toBeUndefined()
    }
  })

  it('signs out from the workspace host and ends the apex session with it', async () => {
    const { apexCookie, workspaceCookie } = await h.openWorkspace('alice')
    const page = await h.request({ host: ALICE, path: '/_poise/logout', headers: { cookie: workspaceCookie } })
    expect(page.status).toBe(200)
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? ''
    const form = { 'content-type': 'application/x-www-form-urlencoded', cookie: workspaceCookie }

    const crossOrigin = await h.request({ host: ALICE, method: 'POST', path: '/_poise/logout', headers: { ...form, origin: `https://${BOB}` }, body: `csrf=${csrf}` })
    expect(crossOrigin.status).toBe(403)
    const missingToken = await h.request({ host: ALICE, method: 'POST', path: '/_poise/logout', headers: { ...form, origin: `https://${ALICE}` }, body: '' })
    expect(missingToken.status).toBe(403)

    const done = await h.request({ host: ALICE, method: 'POST', path: '/_poise/logout', headers: { ...form, origin: `https://${ALICE}` }, body: `csrf=${csrf}` })
    expect(done.status).toBe(303)
    expect(done.headers.location).toBe(`https://${APEX}/`)
    expect(done.setCookie('poise_ws')).toBe('poise_ws=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure')
    expect(done.setCookie('poise_bind')).toBe('poise_bind=; Domain=poise.test; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure')
    expect((await h.request({ host: ALICE, path: '/api/state', headers: { cookie: workspaceCookie } })).status).toBe(401)
    expect((await h.request({ host: APEX, path: '/', headers: { cookie: apexCookie } })).body).toContain('Sign in with GitHub')
    expect(events(h.logs, 'auth.signed_out')).toHaveLength(1)
  })

  it('keeps /_poise/ for the gateway', async () => {
    const { workspaceCookie } = await h.openWorkspace('alice')
    expect((await h.request({ host: ALICE, path: '/_poise/anything', headers: { cookie: workspaceCookie } })).status).toBe(404)
    expect(h.workspace.requests).toHaveLength(0)
  })
})
