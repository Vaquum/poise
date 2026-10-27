// OAuth sign-in for remote MCP servers, through the MCP SDK's client flow:
// protected-resource discovery, dynamic client registration, PKCE, the code
// exchange and refresh. Poise is a public client; the browser only ever sees
// the provider's authorization page. Everything the flow keeps (client
// registration, discovery, verifier, tokens) is a secret slot of the server.

import { randomBytes } from 'node:crypto'
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { ExtensionError, addEvent, eraseSecret, oauthFlows, readSecret, storedServer, writeSecret } from './store'

/** Where the provider sends the browser back: a page of the app, because an
 *  API route refuses a cross-site navigation. */
export const OAUTH_RETURN_PATH = '/extensions/oauth'
const FLOW_TTL_MS = 10 * 60_000
const REFRESH_MARGIN_MS = 60_000

interface Flow { state: string, redirectUrl: string, createdAt: number, verifier?: string }
interface Stored { tokens: OAuthTokens, obtainedAt: number, redirectUrl: string }

const json = <T>(id: string, slot: string): T | undefined => {
  const raw = readSecret(id, slot)
  return raw ? JSON.parse(raw) as T : undefined
}

class StoredProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null
  /** `fresh`: start a new authorization even with tokens stored, which stay in
   *  use until the new sign-in completes. */
  constructor(private readonly id: string, private readonly redirect: string, private flow?: Flow, private readonly fresh = false) {}

  get redirectUrl(): string { return this.redirect }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Poise', redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  }
  state(): string {
    if (!this.flow) throw new Error('No sign-in is in progress for this server.')
    return this.flow.state
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    const info = json<OAuthClientInformationMixed & { redirect_uris?: unknown }>(this.id, 'oauth:client')
    // A registration for another origin cannot return the browser here.
    return info && (!Array.isArray(info.redirect_uris) || info.redirect_uris.includes(this.redirect)) ? info : undefined
  }
  saveClientInformation(info: OAuthClientInformationMixed): void { writeSecret(this.id, 'oauth:client', JSON.stringify(info)) }
  tokens(): OAuthTokens | undefined { return this.fresh ? undefined : json<Stored>(this.id, 'oauth:tokens')?.tokens }
  saveTokens(tokens: OAuthTokens): void {
    writeSecret(this.id, 'oauth:tokens', JSON.stringify({ tokens, obtainedAt: Date.now(), redirectUrl: this.redirect } satisfies Stored))
  }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url }
  saveCodeVerifier(verifier: string): void {
    if (!this.flow) throw new Error('No sign-in is in progress for this server.')
    this.flow = { ...this.flow, verifier }
    writeSecret(this.id, 'oauth:flow', JSON.stringify(this.flow))
  }
  codeVerifier(): string {
    if (!this.flow?.verifier) throw new Error('The sign-in lost its verifier. Sign in again.')
    return this.flow.verifier
  }
  discoveryState(): OAuthDiscoveryState | undefined { return json<OAuthDiscoveryState>(this.id, 'oauth:discovery') }
  saveDiscoveryState(state: OAuthDiscoveryState): void { writeSecret(this.id, 'oauth:discovery', JSON.stringify(state)) }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const slots = { all: ['oauth:client', 'oauth:tokens', 'oauth:discovery', 'oauth:flow'], client: ['oauth:client'], tokens: ['oauth:tokens'], verifier: ['oauth:flow'], discovery: ['oauth:discovery'] }[scope]
    for (const slot of slots) eraseSecret(this.id, slot)
  }
}

function serverUrl(id: string): string {
  const { spec } = storedServer(id)
  if (spec.transport === 'stdio' || !spec.url) throw new ExtensionError(400, 'Only remote servers sign in.')
  return spec.url
}

/** The browser's own origin, as Google sign-in accepts it: HTTPS, or HTTP on loopback. */
function returnUrl(origin: unknown): string {
  if (typeof origin !== 'string') throw new ExtensionError(400, 'Send this Poise origin.')
  let parsed: URL
  try { parsed = new URL(origin) } catch { throw new ExtensionError(400, 'Invalid Poise origin.') }
  if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) {
    throw new ExtensionError(400, 'Use an HTTPS origin, or HTTP on localhost.')
  }
  return parsed.origin + OAUTH_RETURN_PATH
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Start signing in: the provider's authorization URL for the browser to open. */
export async function startSignIn(id: string, origin: unknown): Promise<{ authorizationUrl: string }> {
  const url = serverUrl(id)
  const flow: Flow = { state: randomBytes(24).toString('base64url'), redirectUrl: returnUrl(origin), createdAt: Date.now() }
  writeSecret(id, 'oauth:flow', JSON.stringify(flow))
  // Signing in again is a new authorization (perhaps another account), never a
  // quiet refresh; the current sign-in keeps working until it completes.
  const provider = new StoredProvider(id, flow.redirectUrl, flow, true)
  let result: Awaited<ReturnType<typeof auth>>
  try {
    result = await auth(provider, { serverUrl: url })
  } catch (error) {
    eraseSecret(id, 'oauth:flow')
    addEvent(id, 'error', `Sign-in could not start: ${reason(error)}`)
    throw new ExtensionError(502, `${storedServer(id).spec.title} sign-in could not start: ${reason(error)}`)
  }
  if (result === 'AUTHORIZED' || !provider.authorizationUrl) {
    eraseSecret(id, 'oauth:flow')
    throw new ExtensionError(409, 'Already signed in.')
  }
  // The browser is sent here, and the address comes from the server's own
  // metadata: anything but a web page (javascript:, data:) would run in Poise.
  const page = provider.authorizationUrl
  if (page.protocol !== 'https:' && !(page.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname))) {
    eraseSecret(id, 'oauth:flow')
    addEvent(id, 'error', `Sign-in refused: the server named ${page.protocol} as its sign-in page`)
    throw new ExtensionError(502, `${storedServer(id).spec.title} named a sign-in page that is not an HTTPS address.`)
  }
  addEvent(id, 'info', 'Sign-in started')
  return { authorizationUrl: provider.authorizationUrl.href }
}

/** Finish signing in with what the provider returned to the browser. */
export async function finishSignIn(input: { state?: unknown, code?: unknown, error?: unknown }): Promise<{ id: string }> {
  if (typeof input.state !== 'string' || !input.state) throw new ExtensionError(400, 'The sign-in returned without its state.')
  const match = oauthFlows().map(({ id, value }) => ({ id, flow: JSON.parse(value) as Flow })).find(({ flow }) => flow.state === input.state)
  if (!match) throw new ExtensionError(400, 'That sign-in is unknown or already finished. Sign in again.')
  const { id, flow } = match
  eraseSecret(id, 'oauth:flow')
  if (Date.now() - flow.createdAt > FLOW_TTL_MS) throw new ExtensionError(400, 'That sign-in expired. Sign in again.')
  if (typeof input.error === 'string' && input.error) {
    addEvent(id, 'warning', `Sign-in was not completed: ${input.error}`)
    throw new ExtensionError(400, `${storedServer(id).spec.title} sign-in was not completed (${input.error}).`)
  }
  if (typeof input.code !== 'string' || !input.code) throw new ExtensionError(400, 'The sign-in returned without a code.')
  const provider = new StoredProvider(id, flow.redirectUrl, flow)
  try {
    await auth(provider, { serverUrl: serverUrl(id), authorizationCode: input.code })
  } catch (error) {
    addEvent(id, 'error', `Sign-in failed: ${reason(error)}`)
    throw new ExtensionError(502, `${storedServer(id).spec.title} sign-in failed: ${reason(error)}`)
  }
  addEvent(id, 'info', 'Signed in')
  return { id }
}

export function signOut(id: string): void {
  for (const slot of ['oauth:tokens', 'oauth:flow']) eraseSecret(id, slot)
  addEvent(id, 'info', 'Signed out')
}

const refreshing = new Map<string, Promise<string | null>>()

/** A current access token, refreshed when it is about to expire; null when
 *  the server needs a sign-in. */
export function accessToken(id: string): Promise<string | null> {
  const stored = json<Stored>(id, 'oauth:tokens')
  if (!stored) return Promise.resolve(null)
  const expires = stored.tokens.expires_in ? stored.obtainedAt + stored.tokens.expires_in * 1000 : Infinity
  if (expires - REFRESH_MARGIN_MS > Date.now()) return Promise.resolve(stored.tokens.access_token)
  if (!stored.tokens.refresh_token) return Promise.resolve(null)
  const running = refreshing.get(id)
  if (running) return running
  const attempt = (async () => {
    const provider = new StoredProvider(id, stored.redirectUrl)
    try {
      const result = await auth(provider, { serverUrl: serverUrl(id) })
      // A refused refresh falls through to a new authorization: that needs the person.
      if (result !== 'AUTHORIZED') { eraseSecret(id, 'oauth:tokens'); addEvent(id, 'warning', 'The sign-in expired; sign in again'); return null }
      return provider.tokens()?.access_token ?? null
    } catch (error) {
      addEvent(id, 'error', `Refreshing the sign-in failed: ${reason(error)}`)
      return null
    }
  })().finally(() => refreshing.delete(id))
  refreshing.set(id, attempt)
  return attempt
}
