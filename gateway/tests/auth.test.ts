import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { APEX, events, startHarness, workspaceHost, type Harness, type HarnessOptions } from './harness.js'

describe('sign-in', () => {
  let h: Harness
  const start = async (options?: HarnessOptions) => {
    h = await startHarness(options)
    return h
  }
  afterEach(async () => {
    await h.close()
  })

  it('sends the browser to GitHub with read:user only and binds the state to a short-lived cookie', async () => {
    await start()
    const reply = await h.request({ host: APEX, path: '/auth/login' })
    expect(reply.status).toBe(302)
    const authorize = new URL(reply.headers.location ?? '')
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${h.github.url}/login/oauth/authorize`)
    expect(authorize.searchParams.get('client_id')).toBe('client-id')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`https://${APEX}/auth/callback`)
    expect(authorize.searchParams.get('scope')).toBe('read:user')
    const state = authorize.searchParams.get('state')
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(reply.setCookie('poise_oauth')).toBe(`poise_oauth=${state}; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax; Secure`)
  })

  it('also requests read:org when organisation access is configured', async () => {
    await start({ env: { POISE_ALLOWED_ORGS: 'acme' } })
    const reply = await h.request({ host: APEX, path: '/auth/login' })
    expect(new URL(reply.headers.location ?? '').searchParams.get('scope')).toBe('read:user read:org')
  })

  it('sets poise_gw with exactly the contract attributes', async () => {
    await start()
    const { reply } = await h.signIn('bob')
    expect(reply.status).toBe(302)
    expect(reply.headers.location).toBe('/')
    expect(reply.setCookie('poise_gw')).toMatch(/^poise_gw=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=1209600; HttpOnly; SameSite=Lax; Secure$/)
    expect(reply.setCookie('poise_oauth')).toBe('poise_oauth=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax; Secure')
    expect(events(h.logs, 'auth.')).toContain('auth.signed_in')
  })

  it('rejects a callback whose state does not match the state cookie', async () => {
    await start()
    h.github.signInAs('bob')
    const begin = await h.request({ host: APEX, path: '/auth/login' })
    const authorize = await fetch(begin.headers.location ?? '', { redirect: 'manual' })
    const callback = new URL(authorize.headers.get('location') ?? '')
    const code = callback.searchParams.get('code') ?? ''

    const forged = await h.request({ host: APEX, path: `/auth/callback?code=${code}&state=attacker`, headers: { cookie: begin.cookie('poise_oauth') } })
    expect(forged.status).toBe(400)
    expect(forged.setCookie('poise_gw')).toBeUndefined()

    const noCookie = await h.request({ host: APEX, path: `${callback.pathname}${callback.search}` })
    expect(noCookie.status).toBe(400)
    expect(noCookie.setCookie('poise_gw')).toBeUndefined()
    // Neither attempt reached GitHub's token endpoint.
    expect(h.github.requests.filter((request) => request.path === '/login/oauth/access_token')).toHaveLength(0)
    expect(events(h.logs, 'auth.state')).toEqual(['auth.state.mismatch', 'auth.state.mismatch'])
  })

  it('uses each state once', async () => {
    await start()
    h.github.signInAs('bob')
    const begin = await h.request({ host: APEX, path: '/auth/login' })
    const authorize = await fetch(begin.headers.location ?? '', { redirect: 'manual' })
    const callback = new URL(authorize.headers.get('location') ?? '')
    const first = await h.request({ host: APEX, path: `${callback.pathname}${callback.search}`, headers: { cookie: begin.cookie('poise_oauth') } })
    expect(first.status).toBe(302)
    const replay = await h.request({ host: APEX, path: `${callback.pathname}${callback.search}`, headers: { cookie: begin.cookie('poise_oauth') } })
    expect(replay.status).toBe(400)
    expect(replay.setCookie('poise_gw')).toBeUndefined()
  })

  it('refuses a login that is neither allowed, an admin nor an organisation member', async () => {
    await start()
    const { reply, apexCookie } = await h.signIn('mallory')
    expect(reply.status).toBe(403)
    expect(reply.body).toContain('mallory is not allowed to use this Poise')
    expect(apexCookie).toBe('')
    expect(h.store.getUser('mallory')).toBeNull()
    expect(h.logs.find((entry) => entry.event === 'auth.refused')).toMatchObject({ login: 'mallory', reason: 'not allowed' })
  })

  it('lets admins sign in without being on the allow list', async () => {
    await start()
    const { reply, apexCookie } = await h.signIn('root')
    expect(reply.status).toBe(302)
    expect(apexCookie).toMatch(/^poise_gw=/)
  })

  it('admits active members of an allowed organisation and nobody else from it', async () => {
    await start({ env: { POISE_ALLOWED_ORGS: 'acme' } })
    expect((await h.signIn('carol')).reply.status).toBe(302)
    expect(h.store.getUser('carol')?.accessOrg).toBe('acme')

    const pending = await h.signIn('erin')
    expect(pending.reply.status).toBe(403)

    const restricted = await h.signIn('dave')
    expect(restricted.reply.status).toBe(403)
    expect(restricted.reply.body).toContain('did not share your membership of acme')
  })

  it('refuses a GitHub login that equals a reserved handle', async () => {
    await start({ env: { POISE_ALLOWED_ORGS: 'acme' } })
    const { reply, apexCookie } = await h.signIn('www')
    expect(reply.status).toBe(403)
    expect(reply.body).toContain('www.poise.test is one of this Poise&#39;s own addresses')
    expect(apexCookie).toBe('')
    expect(h.store.getUser('www')).toBeNull()
    // Refused before any membership lookup.
    expect(h.github.requests.some((request) => request.path.startsWith('/user/memberships'))).toBe(false)
  })

  it('discards the GitHub token after reading the login', async () => {
    await start()
    await h.signIn('Alice')
    expect(h.github.issuedTokens).toHaveLength(1)
    const token = h.github.issuedTokens[0]
    for (const file of readdirSync(h.config.dataDir)) {
      expect(readFileSync(join(h.config.dataDir, file)).includes(token)).toBe(false)
    }
    expect(JSON.stringify(h.logs)).not.toContain(token)
  })

  it('keeps a handle bound to the GitHub account that first used it', async () => {
    await start()
    expect((await h.signIn('bob')).reply.status).toBe(302)
    // GitHub logins can be renamed and reused: a different account now calls itself bob.
    h.github.users.set('bob', { login: 'bob', id: 9999 })
    const { reply, apexCookie } = await h.signIn('bob')
    expect(reply.status).toBe(403)
    expect(apexCookie).toBe('')
    expect(h.store.getUser('bob')?.githubId).toBe(1002)
  })

  it('refuses to send people back anywhere but this gateway', async () => {
    await start()
    for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example', `http://${workspaceHost('alice')}/`, `https://${workspaceHost('alice')}:8443/`]) {
      const reply = await h.request({ host: APEX, path: `/auth/login?next=${encodeURIComponent(next)}` })
      expect(reply.status).toBe(400)
    }
  })

  it('signs out with a CSRF-protected form and ends the workspace sessions too', async () => {
    await start()
    const { apexCookie, workspaceCookie } = await h.openWorkspace('alice')
    const home = await h.request({ host: APEX, path: '/', headers: { cookie: apexCookie } })
    const csrf = /name="csrf" value="([^"]+)"/.exec(home.body)?.[1] ?? ''

    const forged = await h.request({
      host: APEX, method: 'POST', path: '/auth/logout',
      headers: { cookie: apexCookie, origin: `https://${APEX}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'csrf=wrong',
    })
    expect(forged.status).toBe(403)

    const done = await h.request({
      host: APEX, method: 'POST', path: '/auth/logout',
      headers: { cookie: apexCookie, origin: `https://${APEX}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${encodeURIComponent(csrf)}`,
    })
    expect(done.status).toBe(303)
    expect(done.setCookie('poise_gw')).toBe('poise_gw=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure')
    expect(done.setCookie('poise_bind')).toBe('poise_bind=; Domain=poise.test; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure')

    const after = await h.request({ host: APEX, path: '/', headers: { cookie: apexCookie } })
    expect(after.body).toContain('Sign in with GitHub')
    const workspace = await h.request({ host: workspaceHost('alice'), path: '/api/state', headers: { cookie: workspaceCookie } })
    expect(workspace.status).toBe(401)
  })

  it('drops Secure from cookies and uses http addresses in insecure local mode', async () => {
    await start({ env: { POISE_INSECURE_HTTP: '1' } })
    const login = await h.request({ host: APEX, path: '/auth/login' })
    expect(new URL(login.headers.location ?? '').searchParams.get('redirect_uri')).toBe(`http://${APEX}/auth/callback`)
    expect(login.setCookie('poise_oauth')).not.toContain('Secure')
    const { reply } = await h.signIn('bob', `http://${workspaceHost('bob')}/`)
    expect(reply.setCookie('poise_gw')).toMatch(/; HttpOnly; SameSite=Lax$/)
    expect(reply.headers.location).toMatch(new RegExp(`^http://${workspaceHost('bob').replaceAll('.', '\\.')}/_poise/session\\?`))
  })
})
