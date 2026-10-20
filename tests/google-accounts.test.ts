import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string, previous: string | undefined
let database: typeof import('../server/db'), accounts: typeof import('../server/google/accounts')
const fakeFetch = vi.fn<typeof fetch>()
const origin = 'http://localhost:5173'
function request(givenOrigin = origin) { return { headers: { origin: givenOrigin } } as IncomingMessage }
function begin() {
  const browserSecret = randomBytes(32).toString('base64url')
  const result = accounts.beginGoogleLogin(request(), { browserSecret })
  return { url: new URL(result.url), browserSecret }
}
const token = () => new Response(JSON.stringify({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file' }))
const identity = (sub = 'account-one', email = 'one@example.com') => new Response(JSON.stringify({ sub, email, email_verified: true }))

beforeEach(async () => {
  vi.resetModules(); root = await mkdtemp(join(tmpdir(), 'google-accounts-')); previous = process.env.POISE_DB; process.env.POISE_DB = join(root, 'cache.db')
  database = await import('../server/db'); accounts = await import('../server/google/accounts')
  accounts.configureGoogle({ clientId: 'poise.apps.googleusercontent.com', clientSecret: 'private-client-secret', origin })
  fakeFetch.mockReset(); vi.stubGlobal('fetch', fakeFetch)
})
afterEach(async () => { vi.unstubAllGlobals(); database.closeDatabase(); if (previous === undefined) delete process.env.POISE_DB; else process.env.POISE_DB = previous; await rm(root, { recursive: true, force: true }) })

describe('Google OAuth browser and account boundaries', () => {
  it('uses offline consent, account selection and PKCE without putting the tab binding in the redirect URL', () => {
    const { url, browserSecret } = begin()
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('redirect_uri')).toBe(origin + '/')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('prompt')).toBe('consent select_account')
    expect(url.toString()).not.toContain(browserSecret)
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(() => accounts.beginGoogleLogin(request(), {})).toThrow('browser binding')
  })
  it('rejects missing, forged, expired, replayed and other-tab bindings before exchanging tokens', async () => {
    const { url, browserSecret } = begin(), state = url.searchParams.get('state')!
    await expect(accounts.completeGoogleLogin(request(), { state, code: 'code' })).rejects.toThrow('another browser')
    await expect(accounts.completeGoogleLogin(request(), { state, code: 'code', browserSecret: randomBytes(32).toString('base64url') })).rejects.toThrow('another browser')
    await expect(accounts.completeGoogleLogin(request(), { state: 'forged', code: 'code', browserSecret })).rejects.toThrow('another browser')
    await expect(accounts.completeGoogleLogin(request('https://other.example'), { state, code: 'code', browserSecret })).rejects.toThrow('another browser')
    expect(fakeFetch).not.toHaveBeenCalled()
    fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity())
    await accounts.completeGoogleLogin(request(), { state, code: 'code', browserSecret })
    await expect(accounts.completeGoogleLogin(request(), { state, code: 'code', browserSecret })).rejects.toThrow('expired')
    const pending = begin(); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000)
    await expect(accounts.completeGoogleLogin(request(), { state: pending.url.searchParams.get('state'), code: 'code', browserSecret: pending.browserSecret })).rejects.toThrow('expired')
  })
  it('connects two stable identities without cookies, as required by the service gateway', async () => {
    for (const [sub, email] of [['account-one', 'one@example.com'], ['account-two', 'two@example.com']]) {
      const { url, browserSecret } = begin(); fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity(sub, email))
      await accounts.completeGoogleLogin(request(), { state: url.searchParams.get('state'), code: 'code', browserSecret })
    }
    expect(accounts.googleAccounts()).toEqual([{ id: 'account-one', email: 'one@example.com', connected: true }, { id: 'account-two', email: 'two@example.com', connected: true }])
    expect(JSON.stringify(accounts.googleAccountSettings())).not.toMatch(/private-|refreshToken|accessToken|clientSecret/)
    expect(await accounts.googleAccessToken('account-two')).toBe('private-access')
    accounts.disconnectGoogle('account-one')
    await expect(accounts.googleAccessToken('account-one')).rejects.toThrow('Reconnect')
    expect(accounts.googleAccounts()[1].connected).toBe(true)
  })
  it('rejects wrong scopes and unverified identities', async () => {
    let auth = begin()
    fakeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'private', expires_in: 3600, scope: 'email' })))
    await expect(accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })).rejects.toThrow('not granted')
    auth = begin(); fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'one', email: 'one@example.com', email_verified: false })))
    await expect(accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })).rejects.toThrow('verified')
    expect(accounts.googleAccounts()).toEqual([])
  })
})
it('disconnect supersedes an authorization completion already waiting for Google', async () => {
  let auth = begin()
  fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity())
  await accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  auth = begin()
  let release!: (value: Response) => void
  const held = new Promise<Response>(resolve => { release = resolve })
  fakeFetch.mockReturnValueOnce(held).mockResolvedValueOnce(identity())
  const completion = accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  accounts.disconnectGoogle('account-one')
  const outcome = expect(completion).rejects.toThrow('connections changed')
  release(token()); await outcome
  expect(accounts.googleAccounts()).toEqual([{ id: 'account-one', email: 'one@example.com', connected: false }])
  expect(database.getMeta('google:account:account-one')).not.toContain('private-refresh')
})
it('client reconfiguration invalidates older unfinished authorizations', async () => {
  const auth = begin()
  let release!: (value: Response) => void
  fakeFetch.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve })).mockResolvedValueOnce(identity())
  const completion = accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  accounts.configureGoogle({ clientId: 'poise.apps.googleusercontent.com', clientSecret: 'rotated-private-secret', origin })
  const outcome = expect(completion).rejects.toThrow('connections changed')
  release(token()); await outcome
  expect(accounts.googleAccounts()).toEqual([])
})
it('redacts private JSON fragments from corrupt stored state and malformed token responses', async () => {
  const auth = begin()
  fakeFetch.mockResolvedValueOnce(new Response('{"access_token":"private-access-secret'))
  await expect(accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })).rejects.toThrow('Google returned an unreadable response.')
  database.setMeta('google:config', '{"clientSecret":"private-client-secret')
  expect(() => accounts.googleAccountSettings()).toThrow('Saved Google connection state is unreadable.')
})
