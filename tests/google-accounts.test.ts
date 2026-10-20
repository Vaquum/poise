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
async function begin() {
  const browserSecret = randomBytes(32).toString('base64url')
  const result = await accounts.beginGoogleLogin(request(), { browserSecret })
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
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); database.closeDatabase(); if (previous === undefined) delete process.env.POISE_DB; else process.env.POISE_DB = previous; await rm(root, { recursive: true, force: true }) })

describe('Google OAuth browser and account boundaries', () => {
  it('uses offline consent, account selection and PKCE without putting the tab binding in the redirect URL', async () => {
    const { url, browserSecret } = await begin()
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('redirect_uri')).toBe(origin + '/')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('prompt')).toBe('consent select_account')
    expect(url.toString()).not.toContain(browserSecret)
    expect(url.searchParams.get('client_secret')).toBeNull()
    await expect(accounts.beginGoogleLogin(request(), {})).rejects.toThrow('browser binding')
  })
  it('rejects missing, forged, expired, replayed and other-tab bindings before exchanging tokens', async () => {
    const { url, browserSecret } = await begin(), state = url.searchParams.get('state')!
    await expect(accounts.completeGoogleLogin(request(), { state, code: 'code' })).rejects.toThrow('another browser')
    await expect(accounts.completeGoogleLogin(request(), { state, code: 'code', browserSecret: randomBytes(32).toString('base64url') })).rejects.toThrow('another browser')
    await expect(accounts.completeGoogleLogin(request(), { state: 'forged', code: 'code', browserSecret })).rejects.toThrow('another browser')
    await expect(accounts.completeGoogleLogin(request('https://other.example'), { state, code: 'code', browserSecret })).rejects.toThrow('another browser')
    expect(fakeFetch).not.toHaveBeenCalled()
    fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity())
    await accounts.completeGoogleLogin(request(), { state, code: 'code', browserSecret })
    await expect(accounts.completeGoogleLogin(request(), { state, code: 'code', browserSecret })).rejects.toThrow('expired')
    const pending = await begin(); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000)
    await expect(accounts.completeGoogleLogin(request(), { state: pending.url.searchParams.get('state'), code: 'code', browserSecret: pending.browserSecret })).rejects.toThrow('expired')
  })
  it('connects two stable identities without workspace cookies in local mode', async () => {
    for (const [sub, email] of [['account-one', 'one@example.com'], ['account-two', 'two@example.com']]) {
      const { url, browserSecret } = await begin(); fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity(sub, email))
      await accounts.completeGoogleLogin(request(), { state: url.searchParams.get('state'), code: 'code', browserSecret })
    }
    expect(accounts.googleAccounts()).toEqual([{ id: 'account-one', email: 'one@example.com', connected: true }, { id: 'account-two', email: 'two@example.com', connected: true }])
    expect(JSON.stringify(accounts.googleAccountSettings())).not.toMatch(/private-|refreshToken|accessToken|clientSecret/)
    expect(await accounts.googleAccessToken('account-two')).toBe('private-access')
    await accounts.disconnectGoogle('account-one')
    await expect(accounts.googleAccessToken('account-one')).rejects.toThrow('Reconnect')
    expect(accounts.googleAccounts()[1].connected).toBe(true)
  })
  it('rejects wrong scopes and unverified identities', async () => {
    let auth = await begin()
    fakeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'private', expires_in: 3600, scope: 'email' })))
    await expect(accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })).rejects.toThrow('not granted')
    auth = await begin(); fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'one', email: 'one@example.com', email_verified: false })))
    await expect(accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })).rejects.toThrow('verified')
    expect(accounts.googleAccounts()).toEqual([])
  })
})
it('disconnect supersedes an authorization completion already waiting for Google', async () => {
  let auth = await begin()
  fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity())
  await accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  auth = await begin()
  let release!: (value: Response) => void
  const held = new Promise<Response>(resolve => { release = resolve })
  fakeFetch.mockReturnValueOnce(held).mockResolvedValueOnce(identity())
  const completion = accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  await accounts.disconnectGoogle('account-one')
  const outcome = expect(completion).rejects.toThrow('connections changed')
  release(token()); await outcome
  expect(accounts.googleAccounts()).toEqual([{ id: 'account-one', email: 'one@example.com', connected: false }])
  expect(database.getMeta('google:account:account-one')).not.toContain('private-refresh')
})
it('client reconfiguration invalidates older unfinished authorizations', async () => {
  const auth = await begin()
  let release!: (value: Response) => void
  fakeFetch.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve })).mockResolvedValueOnce(identity())
  const completion = accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  accounts.configureGoogle({ clientId: 'poise.apps.googleusercontent.com', clientSecret: 'rotated-private-secret', origin })
  const outcome = expect(completion).rejects.toThrow('connections changed')
  release(token()); await outcome
  expect(accounts.googleAccounts()).toEqual([])
})
it('redacts private JSON fragments from corrupt stored state and malformed token responses', async () => {
  const auth = await begin()
  fakeFetch.mockResolvedValueOnce(new Response('{"access_token":"private-access-secret'))
  await expect(accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })).rejects.toThrow('Google returned an unreadable response.')
  database.setMeta('google:config', '{"clientSecret":"private-client-secret')
  expect(() => accounts.googleAccountSettings()).toThrow('Saved Google connection state is unreadable.')
})
it('requires a complete operator environment and keeps private configuration out of account responses', () => {
  vi.stubEnv('POISE_GOOGLE_CLIENT_ID', 'configured.apps.googleusercontent.com')
  vi.stubEnv('POISE_GOOGLE_CLIENT_SECRET', '')
  vi.stubEnv('POISE_GOOGLE_ORIGIN', '')
  expect(() => accounts.validateGoogleEnvironment(false)).toThrow('must configure')
  vi.stubEnv('POISE_GOOGLE_CLIENT_SECRET', 'private-env-secret')
  vi.stubEnv('POISE_GOOGLE_ORIGIN', origin)
  expect(() => accounts.validateGoogleEnvironment(false)).not.toThrow()
  expect(JSON.stringify(accounts.googleAccountSettings())).not.toMatch(/configured.apps|private-env-secret|clientId|origin/)
  vi.stubEnv('POISE_GOOGLE_ORIGIN', 'https://external.example')
  expect(() => accounts.validateGoogleEnvironment(false)).toThrow('loopback')
  vi.unstubAllEnvs()
})
it('requires the same subject during local reconnect and reports authoritative grant failure', async () => {
  let auth = await begin()
  fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity())
  await accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  const browserSecret = randomBytes(32).toString('base64url')
  auth = { url: new URL((await accounts.beginGoogleLogin(request(), { browserSecret, accountId: 'account-one' })).url), browserSecret }
  fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity('different', 'other@example.com'))
  await expect(accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret })).rejects.toThrow('same Google account')
  expect(accounts.googleAccounts()).toHaveLength(1)
  fakeFetch.mockResolvedValueOnce(Response.json({ error: 'invalid_grant', error_description: 'private-error-fragment' }, { status: 400 }))
  await expect(accounts.googleAccessToken('account-one', true)).rejects.toThrow('sign-in has ended')
  expect(accounts.googleAccounts()).toEqual([{ id: 'account-one', email: 'one@example.com', connected: false, state: 'expired' }])
})
it('invalidates unexpired cached grants when the operator selects a different local Google app', async () => {
  const auth = await begin()
  fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity())
  await accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  expect(await accounts.googleAccessToken('account-one')).toBe('private-access')
  fakeFetch.mockClear()
  vi.stubEnv('POISE_GOOGLE_CLIENT_ID', 'different.apps.googleusercontent.com')
  vi.stubEnv('POISE_GOOGLE_CLIENT_SECRET', 'private-other-client')
  vi.stubEnv('POISE_GOOGLE_ORIGIN', origin)
  expect(accounts.googleAccountSettings().accounts).toEqual([{ id: 'account-one', email: 'one@example.com', connected: false, state: 'expired' }])
  await expect(accounts.googleAccessToken('account-one')).rejects.toThrow('configured Google app')
  expect(fakeFetch).not.toHaveBeenCalled()
  const next = await begin()
  fakeFetch.mockResolvedValueOnce(Response.json({ access_token: 'new-private-access', refresh_token: 'new-private-refresh', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file' })).mockResolvedValueOnce(identity())
  await accounts.completeGoogleLogin(request(), { state: next.url.searchParams.get('state'), code: 'new-code', browserSecret: next.browserSecret })
  expect(await accounts.googleAccessToken('account-one')).toBe('new-private-access')
  expect(String(fakeFetch.mock.calls[0][1]?.body)).toContain('client_id=different.apps.googleusercontent.com')
})
it('refuses a local refresh completing after an environment client change', async () => {
  const auth = await begin()
  fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity())
  await accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  let release!: (response: Response) => void
  fakeFetch.mockReturnValueOnce(new Promise<Response>(r => { release = r }))
  const refresh = accounts.googleAccessToken('account-one', true)
  vi.stubEnv('POISE_GOOGLE_CLIENT_ID', 'different.apps.googleusercontent.com')
  vi.stubEnv('POISE_GOOGLE_CLIENT_SECRET', 'private-other-client')
  vi.stubEnv('POISE_GOOGLE_ORIGIN', origin)
  const failed = expect(refresh).rejects.toThrow('configuration changed')
  release(token()); await failed
  expect(accounts.googleAccounts()[0].connected).toBe(false)
})
it('counts a former-app reconnect as a new current-app account at the limit', async () => {
  const connect = async (sub: string) => {
    const auth = await begin()
    fakeFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(identity(sub, `${sub}@example.com`))
    return accounts.completeGoogleLogin(request(), { state: auth.url.searchParams.get('state'), code: 'code', browserSecret: auth.browserSecret })
  }
  await connect('former-app')
  vi.stubEnv('POISE_GOOGLE_CLIENT_ID', 'different.apps.googleusercontent.com')
  vi.stubEnv('POISE_GOOGLE_CLIENT_SECRET', 'private-other-client')
  vi.stubEnv('POISE_GOOGLE_ORIGIN', origin)
  for (let n = 0; n < 10; n++) await connect(`current-${n}`)
  await expect(connect('former-app')).rejects.toThrow('At most ten')
  expect(accounts.googleAccounts().find(a => a.id === 'former-app')).toMatchObject({ connected: false, state: 'expired' })
  expect(accounts.googleAccounts().filter(a => a.connected)).toHaveLength(10)
  await expect(connect('current-0')).resolves.toMatchObject({ outcome: 'connected', accountId: 'current-0' })
  await accounts.disconnectGoogle('current-1')
  await expect(connect('former-app')).resolves.toMatchObject({ outcome: 'connected', accountId: 'former-app' })
  expect(accounts.googleAccounts().filter(a => a.connected)).toHaveLength(10)
})
