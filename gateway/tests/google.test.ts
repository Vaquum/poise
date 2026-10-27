import { randomBytes, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHarness, APEX, type Harness, type Reply } from './harness.js'

const CLIENT = 'poise.apps.googleusercontent.com', CLIENT_SECRET = 'private-google-client-secret'
let h: Harness
const actualFetch = globalThis.fetch
let lifetime: number, refreshMode: 'ok' | 'invalid' | 'transient'
let holdRefresh: (() => Promise<void>) | null
const subjects = new Map<string, string>()
let providerCalls: string[]
interface Login { login: string; apexCookie: string; session: NonNullable<ReturnType<Harness['store']['findSession']>> }
interface Metadata { configured: boolean; accounts: Array<{ id: string; connected: boolean; state: string; connectionVersion: string }> }
const proof = () => randomBytes(32).toString('base64url')
async function post(token: string, action: string, body: Record<string, unknown> = {}): Promise<Reply> {
  return h.request({ host: APEX, path: '/_gateway/google', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, action }) })
}
async function login(name = 'Alice'): Promise<Login> {
  const cookies = await h.openWorkspace(name)
  return { login: name.toLowerCase(), apexCookie: cookies.apexCookie, session: h.store.findSession(cookies.workspaceCookie.slice('poise_ws='.length))! }
}
function assertion(l: Login) { return h.context.assertion(h.store.getUser(l.login)!, 'browser', l.session) }
async function open(l: Login, purpose = 'accounts'): Promise<string> {
  const reply = await post(assertion(l), 'open', { purpose })
  expect(reply.status, reply.body).toBe(200)
  return reply.json<{ operationToken: string }>().operationToken
}
async function settings(l: Login): Promise<Metadata> {
  const op = await open(l), reply = await post(op, 'settings'); await post(op, 'close')
  expect(reply.status).toBe(200); return reply.json<Metadata>()
}
async function pending(l: Login, expected?: string) {
  const browserSecret = proof(), op = await open(l, 'connect')
  const start = await post(op, 'begin', { browserSecret, ...(expected ? { accountId: expected } : {}) })
  await post(op, 'close'); expect(start.status, start.body).toBe(200)
  const url = new URL(start.json<{ url: string }>().url), state = url.searchParams.get('state')!
  const redirect = await h.request({ host: APEX, path: url.pathname + url.search, headers: { cookie: l.apexCookie } })
  expect(redirect.status, redirect.body).toBe(302)
  return { state, browserSecret, redirect }
}
async function stage(l: Login, subject: string, expected?: string) {
  const flow = await pending(l, expected), code = proof()
  subjects.set(code, subject)
  const callback = await h.request({ host: APEX, path: `/auth/google/callback?state=${flow.state}&code=${code}`, headers: { cookie: l.apexCookie } })
  expect(callback.status, callback.body).toBe(302)
  expect(callback.headers.location).toBe(`https://${l.login}.${APEX}/?google_state=${flow.state}`)
  return { ...flow, code }
}
async function finish(l: Login, flow: { state: string; browserSecret: string }) {
  const op = await open(l, 'callback'), reply = await post(op, 'finish', flow); await post(op, 'close'); return reply
}
async function connect(l: Login, subject = 'google-one') {
  const flow = await stage(l, subject)
  expect((await finish(l, flow)).json()).toEqual({ outcome: 'connected', accountId: subject })
  return flow
}
async function token(l: Login, id: string, version: string, forceRefresh = false) {
  const op = await open(l, 'publish')
  try { return await post(op, 'token', { accountId: id, connectionVersion: version, forceRefresh }) }
  finally { await post(op, 'close') }
}
beforeEach(async () => {
  subjects.clear(); providerCalls = []; lifetime = 3600; refreshMode = 'ok'; holdRefresh = null
  h = await startHarness({ env: { POISE_GOOGLE_CLIENT_ID: CLIENT, POISE_GOOGLE_CLIENT_SECRET: CLIENT_SECRET } })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body)), code = body.get('code') ?? body.get('refresh_token')!.slice('private-refresh-'.length)
      providerCalls.push(body.get('grant_type')!)
      if (body.get('grant_type') === 'refresh_token') {
        await holdRefresh?.()
        if (refreshMode !== 'ok') return Response.json({ error: refreshMode === 'invalid' ? 'invalid_grant' : 'temporarily_unavailable', error_description: 'private-provider-secret' }, { status: refreshMode === 'invalid' ? 400 : 503 })
      }
      return Response.json({ access_token: `private-access-${code}`, refresh_token: `private-refresh-${code}`, expires_in: lifetime, scope: 'openid email https://www.googleapis.com/auth/drive.file' })
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      const code = new Headers(init?.headers).get('authorization')!.slice('Bearer private-access-'.length), sub = subjects.get(code)
      return Response.json({ sub, email: `${sub}@example.test`, email_verified: true })
    }
    return actualFetch(input, init)
  }))
})
afterEach(async () => { vi.unstubAllGlobals(); await h.close() })

describe('central Google browser flow', () => {
  it('stages PKCE consent, activates only with its flow proof, and rejects replay', async () => {
    const l = await login(), flow = await stage(l, 'google-one')
    const google = new URL(flow.redirect.headers.location!)
    expect(google.origin).toBe('https://accounts.google.com')
    expect(google.searchParams.get('redirect_uri')).toBe(`https://${APEX}/auth/google/callback`)
    expect(google.searchParams.get('code_challenge_method')).toBe('S256')
    expect(google.href).not.toContain(flow.browserSecret)
    expect((await settings(l)).accounts).toEqual([])
    expect((await finish(l, { ...flow, browserSecret: proof() })).status).toBe(403)
    expect((await finish(l, flow)).json()).toEqual({ outcome: 'connected', accountId: 'google-one' })
    expect((await finish(l, flow)).status).toBe(403)
    expect((await h.request({ host: APEX, path: `/auth/google/callback?state=${flow.state}&code=${flow.code}`, headers: { cookie: l.apexCookie } })).status).toBe(403)
    const metadata = await settings(l)
    expect(metadata.accounts[0]).toMatchObject({ id: 'google-one', connected: true, state: 'connected' })
    expect(JSON.stringify(metadata)).not.toMatch(/private-|refreshToken|accessToken|clientSecret/)
    const bytes = readFileSync(join(h.config.dataDir, 'google-connections.sqlite3-wal')).toString('latin1')
    expect(bytes).not.toContain(`private-refresh-${flow.code}`)
    expect(bytes).not.toContain(`private-access-${flow.code}`)
    expect(bytes).not.toContain(flow.browserSecret)
    expect(JSON.stringify(h.logs)).not.toMatch(/private-google|private-access|private-refresh/)
  })
  it('refuses another owner and another live login of the same owner at start and callback', async () => {
    const a = await login(), b = await login('bob'), second = await login()
    const op = await open(a, 'connect'), begun = await post(op, 'begin', { browserSecret: proof() }), url = new URL(begun.json<{ url: string }>().url)
    for (const other of [b, second]) expect((await h.request({ host: APEX, path: url.pathname + url.search, headers: { cookie: other.apexCookie } })).status).toBe(403)
    expect((await h.request({ host: APEX, path: url.pathname + url.search, headers: { cookie: a.apexCookie } })).status).toBe(302)
    for (const other of [b, second]) expect((await h.request({ host: APEX, path: `/auth/google/callback?state=${url.searchParams.get('state')}&code=bad`, headers: { cookie: other.apexCookie } })).status).toBe(403)
    expect(providerCalls).toEqual([])
  })
  it('consumes cancellation and refuses a different subject during reconnect without changing the existing grant', async () => {
    const l = await login(); await connect(l)
    const before = await settings(l), cancel = await pending(l)
    expect((await h.request({ host: APEX, path: `/auth/google/callback?state=${cancel.state}&error=access_denied`, headers: { cookie: l.apexCookie } })).status).toBe(302)
    expect((await finish(l, cancel)).json()).toEqual({ outcome: 'cancelled' })
    expect((await finish(l, cancel)).status).toBe(403)
    const wrong = await stage(l, 'other-account', 'google-one')
    expect((await finish(l, wrong)).json()).toMatchObject({ outcome: 'failed', message: 'Choose the same Google account when reconnecting.' })
    expect(await settings(l)).toEqual(before)
  })
  it('disconnect invalidates ready flows and old connection versions without touching other accounts', async () => {
    const l = await login(); await connect(l); await connect(l, 'google-two')
    const before = await settings(l), ready = await stage(l, 'google-one', 'google-one'), op = await open(l, 'disconnect')
    expect((await post(op, 'disconnect', { accountId: 'google-one' })).status).toBe(200)
    expect((await finish(l, ready)).status).toBe(403)
    const after = await settings(l)
    expect(after.accounts.find(a => a.id === 'google-one')).toMatchObject({ connected: false, state: 'disconnected' })
    expect(after.accounts.find(a => a.id === 'google-two')?.connected).toBe(true)
    expect((await token(l, 'google-two', before.accounts.find(a => a.id === 'google-two')!.connectionVersion)).status).toBe(409)
  })
})

describe('operation identity and lifetime', () => {
  it('rejects missing, forged, wrong issuer/audience/owner/scope and expired assertions and admission replay', async () => {
    const l = await login(), valid = assertion(l), pieces = valid.split('.')
    const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString()) as Record<string, unknown>
    const changed = (patch: Record<string, unknown>) => {
      const body = `${pieces[0]}.${Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url')}`
      return `${body}.${sign(null, Buffer.from(body), h.keys.privateKey).toString('base64url')}`
    }
    for (const bad of ['', valid.slice(0, -6) + 'forged', changed({ iss: 'other' }), changed({ aud: 'workspace:bob' }), changed({ sub: 'bob' }), changed({ scope: 'link' }), changed({ scope: 'admin' }), changed({ sid: undefined }), changed({ exp: Number(claims.iat) - 1 }), changed({ iat: Number(claims.iat) - 300, exp: Number(claims.exp) - 300 })]) expect((await post(bad, 'open', { purpose: 'publish' })).status).toBe(401)
    expect((await post(valid, 'open', { purpose: 'accounts' })).status).toBe(200)
    expect((await post(valid, 'open', { purpose: 'accounts' })).status).toBe(401)
    const op = await open(l)
    expect((await post(op, 'token', { accountId: 'x' })).status).toBe(403)
    expect((await h.request({ host: APEX, path: '/_gateway/google', method: 'POST', headers: { cookie: l.apexCookie, 'content-type': 'application/json' }, body: '{"action":"settings"}' })).status).toBe(401)
  })
  it('continues admitted work beyond sixty seconds but never extends its twenty-minute deadline', async () => {
    const l = await login(), jwt = assertion(l), op = await open(l)
    h.advance(70_000)
    expect((await post(jwt, 'open', { purpose: 'accounts' })).status).toBe(401)
    expect((await post(op, 'settings')).status).toBe(200)
    h.advance(20 * 60_000)
    expect((await post(op, 'settings')).status).toBe(401)
    expect((await post(op, 'close')).status).toBe(200)
  })
  it('an ended original login cannot use another live login or recover after disable and enable', async () => {
    const l = await login(), second = await login(), op = await open(l), jwt = assertion(l)
    h.store.deleteSession(l.session.parentHash!)
    expect((await post(op, 'settings')).status).toBe(401)
    expect((await post(jwt, 'open', { purpose: 'accounts' })).status).toBe(401)
    expect((await settings(second)).configured).toBe(true)
    const otherOp = await open(second)
    h.store.deleteSession(second.session.parentHash!)
    // Session deletion is permanent even when the owner's access predicate becomes allowed again.
    expect(h.context.isAllowed(h.store.getUser('alice')!)).toBe(true)
    expect((await post(otherOp, 'settings')).status).toBe(401)
  })
})

describe('owner grants and refresh', () => {
  it('partitions the same Google subject across immutable GitHub owners', async () => {
    const a = await login(), b = await login('bob'), fa = await connect(a, 'same-google'), fb = await connect(b, 'same-google')
    const ma = await settings(a), mb = await settings(b)
    expect((await token(a, 'same-google', ma.accounts[0].connectionVersion)).json()).toEqual({ accessToken: `private-access-${fa.code}` })
    expect((await token(b, 'same-google', mb.accounts[0].connectionVersion)).json()).toEqual({ accessToken: `private-access-${fb.code}` })
    const op = await open(a, 'disconnect'); await post(op, 'disconnect', { accountId: 'same-google', owner: b.login })
    expect((await settings(a)).accounts[0].connected).toBe(false)
    expect((await settings(b)).accounts[0].connected).toBe(true)
  })
  it('distinguishes transient refresh errors from an authoritative expired grant', async () => {
    const l = await login(); await connect(l)
    const version = (await settings(l)).accounts[0].connectionVersion
    refreshMode = 'transient'
    const transient = await token(l, 'google-one', version, true)
    expect(transient.status).toBe(502); expect(transient.body).not.toContain('private-provider-secret')
    expect((await settings(l)).accounts[0].connected).toBe(true)
    refreshMode = 'invalid'
    expect((await token(l, 'google-one', version, true)).status).toBe(422)
    expect((await settings(l)).accounts[0]).toMatchObject({ connected: false, state: 'expired' })
  })
  it('does not install a held refresh after logout or a newer reconnect', async () => {
    const l = await login(); await connect(l)
    const before = await settings(l)
    let started!: () => void, release!: () => void
    const pending = new Promise<void>(r => { started = r }), held = new Promise<void>(r => { release = r })
    holdRefresh = async () => { started(); await held }
    const refreshing = token(l, 'google-one', before.accounts[0].connectionVersion, true)
    await pending
    const reconnect = await stage(l, 'google-one', 'google-one')
    expect((await finish(l, reconnect)).status).toBe(200)
    release()
    expect((await refreshing).status).toBe(409)
    const current = await settings(l)
    expect((await token(l, 'google-one', current.accounts[0].connectionVersion)).json()).toEqual({ accessToken: `private-access-${reconnect.code}` })
    holdRefresh = async () => { h.store.deleteSession(l.session.parentHash!) }
    expect((await token(l, 'google-one', current.accounts[0].connectionVersion, true)).status).toBe(401)
  })
  it('marks an authenticated-encryption failure as Needs sign-in without exposing or replacing credentials', async () => {
    const l = await login(); await connect(l)
    const db = new Database(join(h.config.dataDir, 'google-connections.sqlite3'))
    const row = db.prepare('SELECT value FROM google_records WHERE kind=? AND owner=? AND id=?').get('account', 1001, 'google-one') as { value: string }
    const saved = JSON.parse(row.value) as Record<string, unknown>
    db.prepare('UPDATE google_records SET value=? WHERE kind=? AND owner=? AND id=?').run(JSON.stringify({ ...saved, grant: 'tampered-private-fragment' }), 'account', 1001, 'google-one'); db.close()
    expect((await settings(l)).accounts[0]).toMatchObject({ connected: false, state: 'expired' })
    expect(JSON.stringify(h.logs)).not.toContain('tampered-private-fragment')
  })
})

it('admits only one tenth account when two ready flows race, and bounds pending stages', async () => {
  const l = await login()
  for (let i = 0; i < 9; i++) await connect(l, `google-${i}`)
  const a = await stage(l, 'tenth-a'), b = await stage(l, 'tenth-b')
  const results = await Promise.all([finish(l, a), finish(l, b)])
  expect(results.map(r => r.status).sort()).toEqual([200, 429])
  expect((await settings(l)).accounts.filter(a => a.connected)).toHaveLength(10)
  // The refused ready flow still occupies a pending slot; created and started
  // flows count too, rather than just flows waiting at the first screen.
  for (let i = 0; i < 9; i++) await pending(l)
  const op = await open(l, 'connect')
  expect((await post(op, 'begin', { browserSecret: proof() })).status).toBe(429)
})
it('expires a ready result and rejects reconfiguration while a callback is awaiting Google', async () => {
  const l = await login(), ready = await stage(l, 'google-one')
  h.advance(601_000)
  expect((await finish(l, ready)).status).toBe(403)
  expect((await settings(l)).accounts).toEqual([])
  const f = await pending(l), code = proof(); subjects.set(code, 'google-one')
  const previousFetch = globalThis.fetch
  let release!: () => void, started!: () => void
  const held = new Promise<void>(r => { release = r }), pendingExchange = new Promise<void>(r => { started = r })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => { if (String(input) === 'https://oauth2.googleapis.com/token') { started(); await held }; return previousFetch(input, init) }))
  const completing = h.request({ host: APEX, path: `/auth/google/callback?state=${f.state}&code=${code}`, headers: { cookie: l.apexCookie } })
  await pendingExchange
  h.config.google = { clientId: CLIENT, clientSecret: 'rotated-private-google-secret' }
  release()
  expect((await completing).status).toBe(403)
  expect((await settings(l)).accounts).toEqual([])
  expect(JSON.stringify(h.logs)).not.toContain('rotated-private-google-secret')
})
it('ends delegation on originating-session expiry and disable→enable, including held refresh', async () => {
  const l = await login(), second = await login(), op = await open(l)
  const db = new Database(join(h.config.dataDir, 'gateway.db'))
  db.prepare('UPDATE sessions SET expires_at=? WHERE id_hash=?').run(Date.now() + 5000, l.session.idHash); db.close()
  h.advance(10_000)
  expect((await post(op, 'settings')).status).toBe(401)
  expect((await settings(second)).configured).toBe(true)
  await connect(second)
  const version = (await settings(second)).accounts[0].connectionVersion
  let release!: () => void, started!: () => void
  const held = new Promise<void>(r => { release = r }), pendingRefresh = new Promise<void>(r => { started = r })
  holdRefresh = async () => { started(); await held }
  const refreshing = token(second, 'google-one', version, true)
  await pendingRefresh
  h.store.disableUser('alice', 'root'); h.store.enableUser('alice')
  release()
  expect((await refreshing).status).toBe(401)
  expect(h.context.isAllowed(h.store.getUser('alice')!)).toBe(true)
})
it('does not count grants from the previous deployment app against the current connection quota', async () => {
  const l = await login()
  for (let i = 0; i < 10; i++) await connect(l, `previous-${i}`)
  h.config.google = { clientId: 'replacement.apps.googleusercontent.com', clientSecret: 'replacement-private-secret' }
  expect((await settings(l)).accounts.filter(a => a.connected)).toHaveLength(0)
  await connect(l, 'new-account')
  const reconnect = await stage(l, 'previous-0', 'previous-0')
  expect((await finish(l, reconnect)).status).toBe(200)
  const current = await settings(l)
  expect(current.accounts.filter(a => a.connected).map(a => a.id).sort()).toEqual(['new-account', 'previous-0'])
  expect(current.accounts.find(a => a.id === 'previous-1')).toMatchObject({ connected: false, state: 'expired' })
})
