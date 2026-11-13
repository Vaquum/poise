import { createHash } from 'node:crypto'
import http, { type IncomingMessage } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { describeDevice, PHONE_CODE_TTL_MS, PHONE_DECISION_TTL_MS, PHONE_FINISH_TTL_MS } from '../src/phone.js'
import { APEX, events, startHarness, workspaceHost, type Harness, type Reply } from './harness.js'

const ROOT = workspaceHost('root')
const ALICE = workspaceHost('alice')
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

interface CodeView {
  id: string
  state: string
  device: string | null
  grant: string | null
  expiresAt: number
}

interface PhoneView {
  id: string
  device: string
  grant: string
  createdAt: number
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** What a phone's browser sends to the apex, from the QR's address or its own reloads. */
function phone(h: Harness, path: string, cookie = '', userAgent = IPHONE, client = '203.0.113.7'): Promise<Reply> {
  return h.request({
    host: APEX,
    path,
    headers: { 'user-agent': userAgent, accept: 'text/html', 'x-forwarded-for': client, ...(cookie ? { cookie } : {}) },
  })
}

describe('signing in on a phone with the QR code in Settings', () => {
  let h: Harness
  let owner: string
  beforeEach(async () => {
    h = await startHarness()
    owner = (await h.openWorkspace('root')).workspaceCookie
  })
  afterEach(async () => {
    await h.close()
  })

  async function startCode(cookie = owner, host = ROOT): Promise<{ code: CodeView; url: URL; token: string }> {
    const reply = await api(h, host, cookie, 'phone/start', {})
    expect(reply.status).toBe(200)
    const { code, url } = reply.json<{ code: CodeView; url: string }>()
    const parsed = new URL(url)
    return { code, url: parsed, token: parsed.searchParams.get('t') ?? '' }
  }

  async function scan(token: string, userAgent = IPHONE): Promise<string> {
    const reply = await phone(h, `/auth/phone?t=${token}`, '', userAgent)
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/auth/phone')
    return reply.cookie('poise_phone')
  }

  async function overview(cookie = owner, host = ROOT): Promise<{ codes: CodeView[]; phones: PhoneView[] }> {
    const reply = await api(h, host, cookie, 'phone')
    expect(reply.status).toBe(200)
    return reply.json<{ codes: CodeView[]; phones: PhoneView[] }>()
  }

  function approve(id: string, grant: string | null, cookie = owner, host = ROOT): Promise<Reply> {
    return api(h, host, cookie, `phone/approve${grant === null ? '' : `?grant=${grant}`}`, { id })
  }

  /** Scans, approves and finishes: the phone's own apex and workspace cookies. */
  async function signInPhone(): Promise<{ binding: string; apex: string; workspace: string; code: CodeView }> {
    const { code, token } = await startCode()
    const binding = await scan(token)
    const scanned = (await overview()).codes.find((candidate) => candidate.id === code.id)
    expect((await approve(code.id, scanned?.grant ?? null)).status).toBe(200)
    const done = await phone(h, '/auth/phone', binding)
    expect(done.status).toBe(200)
    const ticket = new URL(/<a class="button" href="([^"]+)"/.exec(done.body)?.[1].replaceAll('&amp;', '&') ?? '')
    expect(ticket.host).toBe(ROOT)
    const session = await h.request({
      host: ROOT,
      path: `${ticket.pathname}${ticket.search}`,
      headers: { cookie: done.cookie('poise_bind') },
    })
    expect(session.status).toBe(302)
    return { binding, apex: done.cookie('poise_gw'), workspace: session.cookie('poise_ws'), code }
  }

  it('signs in the phone the owner approves, with sessions of its own', async () => {
    const { code, url, token } = await startCode()
    expect(url.origin).toBe(`https://${APEX}`)
    expect(url.pathname).toBe('/auth/phone')
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(code).toMatchObject({ state: 'waiting', device: null, grant: null })
    expect(code.expiresAt - Date.now()).toBeGreaterThan(PHONE_CODE_TTL_MS - 5_000)

    const opened = await phone(h, `/auth/phone?t=${token}`)
    expect(opened.status).toBe(303)
    const binding = opened.cookie('poise_phone')
    const line = opened.setCookie('poise_phone') ?? ''
    for (const attribute of ['Path=/auth/phone', 'HttpOnly', 'SameSite=Lax', 'Secure']) expect(line).toContain(attribute)

    const waiting = await phone(h, '/auth/phone', binding)
    expect(waiting.status).toBe(200)
    expect(waiting.body).toContain('Approve on your computer')
    expect(waiting.body).toContain('iPhone · Safari')
    expect(waiting.body).toContain('<meta http-equiv="refresh" content="2">')

    const scanned = (await overview()).codes.find((candidate) => candidate.id === code.id)
    expect(scanned).toMatchObject({ state: 'scanned', device: 'iPhone · Safari', grant: sha256(binding.split('=')[1]) })

    const approved = await approve(code.id, scanned!.grant)
    expect(approved.status).toBe(200)
    expect(approved.json<{ code: CodeView }>().code.state).toBe('approved')

    const done = await phone(h, '/auth/phone', binding)
    expect(done.status).toBe(200)
    expect(done.body).toContain('Signed in')
    expect(done.body).toContain('root')
    expect(done.setCookie('poise_phone')).toContain('Max-Age=0')
    const apex = done.cookie('poise_gw')
    const ticket = new URL(/<a class="button" href="([^"]+)"/.exec(done.body)?.[1].replaceAll('&amp;', '&') ?? '')
    expect(done.body).toContain(`content="2; url=${ticket.href.replaceAll('&', '&amp;')}"`)
    const session = await h.request({ host: ROOT, path: `${ticket.pathname}${ticket.search}`, headers: { cookie: done.cookie('poise_bind') } })
    expect(session.status).toBe(302)
    const workspace = session.cookie('poise_ws')

    // Its own sessions: neither is the owner's, and both work.
    expect(workspace).not.toBe(owner)
    expect((await h.request({ host: APEX, path: '/', headers: { cookie: apex } })).body).toContain('Signed in as root')
    expect((await api(h, ROOT, workspace, 'account')).json()).toMatchObject({ login: 'root' })

    const after = await overview()
    expect(after.codes.find((candidate) => candidate.id === code.id)?.state).toBe('signed_in')
    expect(after.phones).toEqual([{ id: expect.any(String), device: 'iPhone · Safari', grant: scanned!.grant, createdAt: expect.any(Number) }])
    expect(events(h.logs, 'phone.')).toEqual(['phone.code.created', 'phone.code.scanned', 'phone.approved', 'phone.signed_in'])
  })

  it('never logs the code, the phone\'s secret or its grant', async () => {
    const { token } = await startCode()
    const { binding } = await signInPhone()
    const logged = JSON.stringify(h.logs)
    const secret = binding.split('=')[1]
    for (const value of [token, secret, sha256(secret)]) expect(logged).not.toContain(value)
  })

  it('signs a phone out from Settings, ending its sessions on every host', async () => {
    const { apex, workspace } = await signInPhone()
    const [listed] = (await overview()).phones
    expect((await api(h, ROOT, owner, `phone/revoke?grant=${'0'.repeat(64)}`, { id: listed.id })).status).toBe(400)
    expect((await api(h, ROOT, owner, 'phone/revoke', { id: listed.id })).status).toBe(400)
    expect((await api(h, ROOT, owner, `phone/revoke?grant=${listed.grant}`, { id: 'nope' })).status).toBe(404)
    expect((await api(h, ROOT, workspace, 'account')).status).toBe(200)

    const out = await api(h, ROOT, owner, `phone/revoke?grant=${listed.grant}`, { id: listed.id })
    expect(out.status).toBe(200)
    expect(out.json()).toEqual({ phones: [] })
    expect((await api(h, ROOT, workspace, 'account')).status).toBe(401)
    expect((await h.request({ host: APEX, path: '/', headers: { cookie: apex } })).body).not.toContain('Signed in as')
    // The owner is still signed in.
    expect((await api(h, ROOT, owner, 'account')).status).toBe(200)
    expect(events(h.logs, 'phone.signed_out')).toHaveLength(1)
  })

  it('cuts what a signed-out phone still holds open, and leaves the owner\'s alone', async () => {
    const { workspace } = await signInPhone()
    const open = (cookie: string) => new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws/chat`, { headers: { host: ROOT, cookie } })
      socket.once('message', () => resolve(socket))
      socket.once('error', reject)
    })
    const phoneSocket = await open(workspace)
    const ownerSocket = await open(owner)
    // An answer still streaming: the workspace echoes the body as it arrives, and the request never ends.
    const stream = http.request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/stream', headers: { host: ROOT, cookie: workspace, 'transfer-encoding': 'chunked' } })
    const streaming = new Promise<IncomingMessage>((resolve, reject) => {
      stream.once('response', resolve)
      stream.once('error', reject)
    })
    stream.write('first')
    const answer = await streaming
    await new Promise<void>((resolve) => answer.once('data', () => resolve()))
    const streamEnded = new Promise<void>((resolve) => {
      answer.once('close', () => resolve())
      stream.once('error', () => resolve())
    })
    const phoneClosed = new Promise<void>((resolve) => phoneSocket.once('close', () => resolve()))

    const [listed] = (await overview()).phones
    expect((await api(h, ROOT, owner, `phone/revoke?grant=${listed.grant}`, { id: listed.id })).status).toBe(200)
    await phoneClosed
    await streamEnded
    const echo = new Promise<string>((resolve) => ownerSocket.once('message', (data) => resolve(String(data))))
    ownerSocket.send('still here')
    expect(await echo).toBe('echo:still here')
    ownerSocket.close()
    expect(h.logs.find((entry) => entry.event === 'phone.signed_out')).toMatchObject({ cut: 2 })
  })

  it('binds the code to the first device that opens it', async () => {
    const { code, token } = await startCode()
    const binding = await scan(token)
    const second = await phone(h, `/auth/phone?t=${token}`, '', ANDROID, '198.51.100.9')
    expect(second.status).toBe(409)
    expect(second.body).toContain('already used')
    expect(second.setCookie('poise_phone')).toBeUndefined()
    // The first device opening its own code again just carries on.
    const again = await phone(h, `/auth/phone?t=${token}`, binding)
    expect(again.status).toBe(303)
    expect(again.headers.location).toBe('/auth/phone')
    expect(again.setCookie('poise_phone')).toBeUndefined()
    expect((await overview()).codes.find((candidate) => candidate.id === code.id)?.device).toBe('iPhone · Safari')
  })

  it('refuses codes that are unknown, malformed or expired', async () => {
    for (const path of ['/auth/phone?t=', '/auth/phone?t=short', `/auth/phone?t=${'A'.repeat(22)}`, `/auth/phone?t=${'A'.repeat(23)}`]) {
      const reply = await phone(h, path)
      expect(reply.status).toBe(410)
      expect(reply.setCookie('poise_phone')).toBeUndefined()
    }
    const { code, token } = await startCode()
    h.advance(PHONE_CODE_TTL_MS)
    const late = await phone(h, `/auth/phone?t=${token}`)
    expect(late.status).toBe(410)
    expect(late.body).toContain('This code has expired')
    expect((await overview()).codes.find((candidate) => candidate.id === code.id)?.state).toBe('expired')
  })

  it('lets the owner deny the phone, and lets nothing undecided or late sign in', async () => {
    // Denied.
    let started = await startCode()
    let binding = await scan(started.token)
    expect((await api(h, ROOT, owner, 'phone/deny', { id: started.code.id })).json<{ code: CodeView }>().code.state).toBe('denied')
    let reply = await phone(h, '/auth/phone', binding)
    expect(reply.status).toBe(403)
    expect(reply.body).toContain('Not approved')
    expect(reply.setCookie('poise_gw')).toBeUndefined()
    const grant = (await overview()).codes.find((candidate) => candidate.id === started.code.id)?.grant ?? null
    expect((await approve(started.code.id, grant)).status).toBe(409)

    // Never decided.
    started = await startCode()
    binding = await scan(started.token)
    h.advance(PHONE_DECISION_TTL_MS)
    reply = await phone(h, '/auth/phone', binding)
    expect(reply.status).toBe(410)
    expect(reply.setCookie('poise_phone')).toContain('Max-Age=0')
    const lateGrant = (await overview()).codes.find((candidate) => candidate.id === started.code.id)?.grant ?? null
    expect((await approve(started.code.id, lateGrant)).status).toBe(409)

    // Approved, but the phone came back too late.
    started = await startCode()
    binding = await scan(started.token)
    const approvedGrant = (await overview()).codes.find((candidate) => candidate.id === started.code.id)?.grant ?? null
    expect((await approve(started.code.id, approvedGrant)).status).toBe(200)
    h.advance(PHONE_FINISH_TTL_MS)
    reply = await phone(h, '/auth/phone', binding)
    expect(reply.status).toBe(410)
    expect(reply.setCookie('poise_gw')).toBeUndefined()
    expect((await overview()).phones).toEqual([])
  })

  it('gives a phone that retries the same sign-in within its window, and nothing after', async () => {
    // The answer that carried the sign-in can be lost when the phone drops the request and retries.
    const { binding, apex } = await signInPhone()
    const again = await phone(h, '/auth/phone', binding)
    expect(again.status).toBe(200)
    expect(again.cookie('poise_gw')).toBe(apex)
    const ticket = new URL(/<a class="button" href="([^"]+)"/.exec(again.body)?.[1].replaceAll('&amp;', '&') ?? '')
    const session = await h.request({ host: ROOT, path: `${ticket.pathname}${ticket.search}`, headers: { cookie: again.cookie('poise_bind') } })
    expect(session.status).toBe(302)
    expect((await api(h, ROOT, session.cookie('poise_ws'), 'account')).json()).toMatchObject({ login: 'root' })
    expect((await overview()).phones).toHaveLength(1)
    expect(events(h.logs, 'phone.signed_in')).toEqual(['phone.signed_in', 'phone.signed_in.again'])
    h.advance(PHONE_FINISH_TTL_MS)
    const late = await phone(h, '/auth/phone', binding)
    expect(late.status).toBe(410)
    expect(late.setCookie('poise_gw')).toBeUndefined()
  })

  it('gives a phone signed out in the meantime nothing again', async () => {
    const { binding } = await signInPhone()
    const [listed] = (await overview()).phones
    expect((await api(h, ROOT, owner, `phone/revoke?grant=${listed.grant}`, { id: listed.id })).status).toBe(200)
    const again = await phone(h, '/auth/phone', binding)
    expect(again.status).toBe(410)
    expect(again.setCookie('poise_gw')).toBeUndefined()
  })

  it('approves only with the grant of the device that is waiting', async () => {
    const { code, token } = await startCode()
    const binding = await scan(token)
    const grant = sha256(binding.split('=')[1])
    for (const wrong of [null, '0'.repeat(64), grant.toUpperCase(), `${grant}&grant=${grant}`]) {
      expect((await approve(code.id, wrong)).status).toBe(400)
    }
    expect((await approve('no-such-code', grant)).status).toBe(404)
    // Another person, on their own workspace, cannot decide on the owner's code.
    const alice = (await h.openWorkspace('Alice')).workspaceCookie
    expect((await approve(code.id, grant, alice, ALICE)).status).toBe(404)
    expect((await api(h, ALICE, alice, 'phone/deny', { id: code.id })).status).toBe(404)
    expect((await overview()).codes.find((candidate) => candidate.id === code.id)?.state).toBe('scanned')
    expect((await approve(code.id, grant)).status).toBe(200)
  })

  it('keeps the phone API to the owner\'s own pages', async () => {
    const alice = (await h.openWorkspace('Alice')).workspaceCookie
    expect((await api(h, ROOT, '', 'phone')).status).toBe(401)
    expect((await api(h, ROOT, '', 'phone/start', {})).status).toBe(401)
    expect((await api(h, ROOT, alice, 'phone/start', {})).status).toBe(403)
    expect((await api(h, ROOT, owner, 'phone/start', {}, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await api(h, ROOT, owner, 'phone/start', {}, { 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await api(h, ROOT, owner, 'phone/start')).status).toBe(405)
    expect((await api(h, ROOT, owner, 'phone/start', {}, { authorization: 'Bearer anything' })).status).toBe(401)
    // Alice's own list holds nothing of the owner's.
    await startCode()
    expect(await overview(alice, ALICE)).toEqual({ codes: [], phones: [] })
  })

  it('rate limits the codes a sign-in shows', async () => {
    for (let index = 0; index < 30; index += 1) await startCode()
    const limited = await api(h, ROOT, owner, 'phone/start', {})
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(limited.json()).toMatchObject({ error: 'too_many_requests' })
    h.advance(15 * 60_000)
    expect((await api(h, ROOT, owner, 'phone/start', {})).status).toBe(200)
  })

  it('rate limits a client opening codes that do not exist', async () => {
    for (let index = 0; index < 20; index += 1) expect((await phone(h, `/auth/phone?t=${'B'.repeat(21)}${index % 10}`)).status).toBe(410)
    const { token } = await startCode()
    const limited = await phone(h, `/auth/phone?t=${token}`)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    // Another client is unaffected, and the limit passes.
    expect((await phone(h, `/auth/phone?t=${token}`, '', IPHONE, '198.51.100.9')).status).toBe(303)
    h.advance(10 * 60_000)
    expect((await phone(h, `/auth/phone?t=${(await startCode()).token}`)).status).toBe(303)
  })

  it('signs in a device that is already signed in here through the code all the same', async () => {
    // A login proxy in front may have ended the phone's sign-in there while the gateway's lives on.
    const { code, token } = await startCode()
    const signedIn = (await h.signIn('Alice')).apexCookie
    const opened = await phone(h, `/auth/phone?t=${token}`, signedIn)
    expect(opened.status).toBe(303)
    const binding = opened.cookie('poise_phone')
    const grant = (await overview()).codes.find((candidate) => candidate.id === code.id)?.grant ?? null
    expect((await approve(code.id, grant)).status).toBe(200)
    const done = await phone(h, '/auth/phone', `${signedIn}; ${binding}`)
    expect(done.status).toBe(200)
    expect(done.cookie('poise_gw')).not.toBe(signedIn)
    expect((await h.request({ host: APEX, path: '/', headers: { cookie: done.cookie('poise_gw') } })).body).toContain('Signed in as root')
  })

  it('stops the phone of someone whose access ended', async () => {
    // Disabling ends every session, and the codes minted from them go with it.
    const alice = (await h.openWorkspace('Alice')).workspaceCookie
    const unused = await startCode(alice, ALICE)
    const scanned = await startCode(alice, ALICE)
    const binding = await scan(scanned.token)
    expect(h.store.disableUser('alice', 'root')).toBe(true)
    expect((await phone(h, `/auth/phone?t=${unused.token}`)).status).toBe(410)
    const waiting = await phone(h, '/auth/phone', binding)
    expect(waiting.setCookie('poise_gw')).toBeUndefined()
    expect(waiting.body).not.toContain('Approve on your computer')

    // Taken off the allow list: the sessions stay, and the phone is still refused.
    h.store.addAllowed('mallory', 'root')
    const mallory = (await h.openWorkspace('mallory')).workspaceCookie
    const host = workspaceHost('mallory')
    const first = await startCode(mallory, host)
    const second = await startCode(mallory, host)
    const bound = await scan(second.token)
    expect(h.store.removeAllowed('mallory')).toBe('removed')
    expect((await phone(h, `/auth/phone?t=${first.token}`)).status).toBe(403)
    const refused = await phone(h, '/auth/phone', bound)
    expect(refused.status).toBe(403)
    expect(refused.setCookie('poise_gw')).toBeUndefined()
  })

  it('shows the page a phone opens without a code', async () => {
    const reply = await phone(h, '/auth/phone')
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('Settings → Accounts → Sign in on your phone')
  })
})

describe('the device a phone is shown as', () => {
  it('names the kind of device and its browser', () => {
    expect(describeDevice(IPHONE)).toBe('iPhone · Safari')
    expect(describeDevice(ANDROID)).toBe('Android phone · Chrome')
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1')).toBe('iPhone · Chrome')
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15')).toBe('iPhone · Firefox')
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36')).toBe('Android phone · Samsung Internet')
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('Android tablet · Chrome')
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Mac · Edge')
    expect(describeDevice('')).toBe('Unknown device · unknown browser')
  })
})
