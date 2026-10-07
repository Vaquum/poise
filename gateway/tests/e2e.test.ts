import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { APEX, startHarness, verifyAssertion, workspaceHost, type Harness } from './harness.js'

describe('end to end', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('signs in through GitHub, follows the ticket to the workspace and proxies HTTP and WebSocket with a fresh assertion', async () => {
    const alice = workspaceHost('alice')

    // An unauthenticated navigation to the workspace goes to sign-in on the apex and asks to come back.
    const visit = await h.request({ host: alice, path: '/projects?tab=open', headers: { 'sec-fetch-mode': 'navigate' } })
    expect(visit.status).toBe(404) // nobody has signed in as alice yet, so the host is unknown

    const { reply: callback, apexCookie, bindCookie } = await h.signIn('Alice', `https://${alice}/projects?tab=open`)
    expect(callback.status).toBe(302)
    expect(apexCookie).toMatch(/^poise_gw=/)
    expect(bindCookie).toMatch(/^poise_bind=/)
    const ticketUrl = new URL(callback.headers.location ?? '')
    expect(ticketUrl.origin).toBe(`https://${alice}`)
    expect(ticketUrl.pathname).toBe('/_poise/session')
    expect(ticketUrl.searchParams.get('next')).toBe('/projects?tab=open')

    // The browser holds poise_bind for the whole domain, so the workspace host sees it too.
    const session = await h.request({ host: alice, path: `${ticketUrl.pathname}${ticketUrl.search}`, headers: { cookie: bindCookie } })
    expect(session.status).toBe(302)
    expect(session.headers.location).toBe('/projects?tab=open')
    const workspaceCookie = session.cookie('poise_ws')

    // Once alice exists, an unauthenticated navigation is sent to apex sign-in with a way back.
    const anonymous = await h.request({ host: alice, path: '/projects?tab=open', headers: { 'sec-fetch-mode': 'navigate' } })
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.location).toBe(`https://${APEX}/auth/login?next=${encodeURIComponent(`https://${alice}/projects?tab=open`)}`)

    const proxied = await h.request({
      host: alice,
      method: 'POST',
      path: '/api/echo?x=1',
      headers: {
        cookie: `theme=dark; ${workspaceCookie}; ${bindCookie}`,
        origin: `https://${alice}`,
        'content-type': 'application/json',
        'x-poise-identity': 'forged',
      },
      body: '{"hello":"workspace"}',
    })
    expect(proxied.status).toBe(200)
    const seen = proxied.json<{ method: string; url: string; headers: Record<string, string>; body: string }>()
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/api/echo?x=1')
    expect(seen.body).toBe('{"hello":"workspace"}')
    expect(seen.headers.host).toBe(alice)
    expect(seen.headers.origin).toBe(`https://${alice}`)
    expect(seen.headers['x-forwarded-proto']).toBe('https')
    expect(seen.headers['x-forwarded-host']).toBe(alice)
    expect(seen.headers['x-forwarded-for']).toBe('127.0.0.1')
    expect(seen.headers.cookie).toBeUndefined()
    expect(seen.headers['x-poise-identity']).not.toBe('forged')
    const claims = verifyAssertion(seen.headers['x-poise-identity'], h.keys.publicKeyBase64)
    expect(claims).toMatchObject({ iss: 'poise-gateway', aud: 'workspace:alice', sub: 'Alice', scope: 'browser' })
    expect(claims.exp - claims.iat).toBe(60)

    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws/chat?tab=1`, {
      headers: { host: alice, cookie: `${workspaceCookie}; portal_session=p`, 'x-poise-identity': 'forged' },
      origin: `https://${alice}`,
    })
    const messages: string[] = []
    const nextMessage = () => new Promise<string>((resolve) => socket.once('message', (data) => resolve(String(data))))
    const hello = JSON.parse(await nextMessage()) as { url: string; headers: Record<string, string> }
    expect(hello.url).toBe('/ws/chat?tab=1')
    expect(hello.headers.host).toBe(alice)
    expect(hello.headers.origin).toBe(`https://${alice}`)
    expect(hello.headers.cookie).toBeUndefined()
    const wsClaims = verifyAssertion(hello.headers['x-poise-identity'], h.keys.publicKeyBase64)
    expect(wsClaims).toMatchObject({ aud: 'workspace:alice', sub: 'Alice', scope: 'browser' })
    expect(wsClaims.jti).not.toBe(claims.jti)
    socket.send('ping')
    messages.push(await nextMessage())
    expect(messages).toEqual(['echo:ping'])
    socket.close()
  })
})
