import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { HttpError, enforceApiRequest, enforceDocumentRequest, type ApiRequestPolicy } from '../server/http'
import { readServiceConfig } from '../server/service/config'
import { PUBLIC_HOST, PUBLIC_ORIGIN, gatewayKeys, serviceEnvironment, signAssertion } from './service-fixture'

const gateway = gatewayKeys()
const policy: ApiRequestPolicy = { service: readServiceConfig(serviceEnvironment(gateway)) }
const GATEWAY_PEER = '172.18.0.2'

function request(options: {
  url?: string
  host?: string
  origin?: string
  fetchSite?: string
  identity?: string
  remoteAddress?: string | null
  headers?: Record<string, string>
} = {}): IncomingMessage {
  return Object.assign(Readable.from([]), {
    headers: {
      host: options.host ?? PUBLIC_HOST,
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.fetchSite ? { 'sec-fetch-site': options.fetchSite } : {}),
      ...(options.identity ? { 'x-poise-identity': options.identity } : {}),
      ...options.headers,
    },
    method: 'GET',
    socket: { remoteAddress: options.remoteAddress === null ? undefined : options.remoteAddress ?? GATEWAY_PEER },
    url: options.url ?? '/api/settings',
  }) as unknown as IncomingMessage
}

const browser = (claims: Record<string, unknown> = {}) => signAssertion(gateway.privateKey, claims)
const refusal = (run: () => unknown): { status: number, message: string } | null => {
  try {
    run()
    return null
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    return { status: error.statusCode, message: error.message }
  }
}

describe('service mode: the gateway\'s requests', () => {
  it('admits the owner\'s browser on the public host and origin, and drops the assertion', () => {
    const req = request({ origin: PUBLIC_ORIGIN, identity: browser() })
    expect(enforceApiRequest(req, policy)).toEqual({ kind: 'gateway', scope: 'browser' })
    expect(req.headers['x-poise-identity']).toBeUndefined()
    expect(enforceApiRequest(request({ identity: browser() }), policy)).toEqual({ kind: 'gateway', scope: 'browser' })
    expect(enforceApiRequest(request({ host: `${PUBLIC_HOST}:443`, identity: browser() }), policy)).toEqual({ kind: 'gateway', scope: 'browser' })
  })

  it('requires an assertion on every route, documents included', () => {
    for (const url of ['/api/settings', '/api/service/health', '/api/link/hello']) {
      expect(refusal(() => enforceApiRequest(request({ url, origin: PUBLIC_ORIGIN }), policy))).toEqual({ status: 401, message: 'an identity assertion from the gateway is required' })
    }
    for (const url of ['/', '/index.html', '/assets/app.js']) {
      expect(refusal(() => enforceDocumentRequest(request({ url }), policy))).toMatchObject({ status: 401 })
    }
  })

  it('treats a peer it cannot identify as the network, never as loopback', () => {
    expect(refusal(() => enforceApiRequest(request({ remoteAddress: null, host: '127.0.0.1:5555' }), policy))).toEqual({ status: 403, message: 'host is not allowed' })
    expect(refusal(() => enforceApiRequest(request({ remoteAddress: null }), policy))).toMatchObject({ status: 401 })
  })

  it('refuses an invalid, expired or misdirected assertion', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(refusal(() => enforceApiRequest(request({ identity: browser({ iat: now - 120, exp: now - 60 }) }), policy))).toEqual({ status: 401, message: 'the identity assertion has expired' })
    expect(refusal(() => enforceApiRequest(request({ identity: signAssertion(gatewayKeys().privateKey) }), policy))).toEqual({ status: 401, message: 'the identity assertion signature does not verify' })
    expect(refusal(() => enforceApiRequest(request({ identity: browser({ aud: 'workspace:hubot' }) }), policy))).toMatchObject({ status: 401 })
    expect(refusal(() => enforceApiRequest(request({ identity: browser({ sub: 'hubot' }) }), policy))).toMatchObject({ status: 401 })
    expect(refusal(() => enforceApiRequest(request({ identity: 'garbage' }), policy))).toEqual({ status: 401, message: 'the identity assertion is malformed' })
  })

  it('checks the Host against the public origin, whatever the assertion', () => {
    for (const host of ['poise-ws-octocat:5555', '127.0.0.1:5555', 'hubot.poise.example.test', `${PUBLIC_HOST}:8443`, `${PUBLIC_HOST}/evil`, `user@${PUBLIC_HOST}`, '']) {
      expect(refusal(() => enforceApiRequest(request({ host, identity: browser() }), policy)), host).toEqual({ status: 403, message: 'host is not allowed' })
      expect(refusal(() => enforceDocumentRequest(request({ url: '/', host, identity: browser() }), policy)), host).toEqual({ status: 403, message: 'host is not allowed' })
    }
  })

  it('accepts only the exact public origin, scheme included', () => {
    for (const origin of [`http://${PUBLIC_HOST}`, `${PUBLIC_ORIGIN}:8443`, 'https://hubot.poise.example.test', 'https://attacker.example', 'null', `${PUBLIC_ORIGIN}/`]) {
      expect(refusal(() => enforceApiRequest(request({ origin, identity: browser() }), policy)), origin).toEqual({ status: 403, message: 'request origin is not allowed' })
      expect(refusal(() => enforceDocumentRequest(request({ url: '/', origin, identity: browser() }), policy)), origin).toEqual({ status: 403, message: 'request origin is not allowed' })
    }
  })

  it('refuses cross-site API calls but lets a cross-site link open the workspace', () => {
    expect(refusal(() => enforceApiRequest(request({ fetchSite: 'cross-site', identity: browser() }), policy))).toEqual({ status: 403, message: 'cross-site API requests are not allowed' })
    expect(enforceDocumentRequest(request({ url: '/', fetchSite: 'cross-site', identity: browser() }), policy)).toEqual({ kind: 'gateway', scope: 'browser' })
  })

  it('holds each scope to its routes', () => {
    const link = signAssertion(gateway.privateKey, { scope: 'link' })
    const admin = signAssertion(gateway.privateKey, { scope: 'admin' })
    expect(enforceApiRequest(request({ url: '/api/link/hello', identity: link }), policy)).toEqual({ kind: 'gateway', scope: 'link' })
    expect(enforceApiRequest(request({ url: '/api/service/health', identity: admin }), policy)).toEqual({ kind: 'gateway', scope: 'admin' })
    for (const [url, identity] of [
      ['/api/settings', link], ['/api/chat/sessions', link], ['/ws/chat', link], ['/api/service/drain', link], ['/api/link/../service/drain', link],
      ['/api/settings', admin], ['/api/link/hello', admin], ['/ws/chat', admin], ['/api/service/../settings', admin],
    ] as const) {
      expect(refusal(() => enforceApiRequest(request({ url, identity }), policy)), url).toMatchObject({ status: 403 })
    }
    for (const identity of [link, admin]) {
      expect(refusal(() => enforceDocumentRequest(request({ url: '/', identity }), policy))).toMatchObject({ status: 403 })
    }
  })

  it('removes the assertion header before any check can refuse the request', () => {
    const refusals: Array<[string, () => IncomingMessage, (req: IncomingMessage) => unknown, number]> = [
      ['wrong Host', () => request({ host: 'elsewhere.example', identity: browser() }), (req) => enforceApiRequest(req, policy), 403],
      ['wrong Host on a document', () => request({ url: '/', host: 'elsewhere.example', identity: browser() }), (req) => enforceDocumentRequest(req, policy), 403],
      ['wrong Origin', () => request({ origin: 'https://attacker.example', identity: browser() }), (req) => enforceApiRequest(req, policy), 403],
      ['wrong Origin on a document', () => request({ url: '/', origin: 'https://attacker.example', identity: browser() }), (req) => enforceDocumentRequest(req, policy), 403],
      ['cross-site API call', () => request({ fetchSite: 'cross-site', identity: browser() }), (req) => enforceApiRequest(req, policy), 403],
      ['expired assertion', () => request({ identity: browser({ iat: 1, exp: 61 }) }), (req) => enforceApiRequest(req, policy), 401],
      ['scope that does not reach the route', () => request({ url: '/api/settings', identity: signAssertion(gateway.privateKey, { scope: 'link' }) }), (req) => enforceApiRequest(req, policy), 403],
    ]
    for (const [name, make, check, status] of refusals) {
      const req = make()
      expect(refusal(() => check(req)), name).toMatchObject({ status })
      expect(req.headers['x-poise-identity'], name).toBeUndefined()
    }
  })
})

describe('service mode: the gateway\'s own calls', () => {
  it('admits an admin assertion with the public Host, as the gateway sends its calls', () => {
    const admin = signAssertion(gateway.privateKey, { scope: 'admin' })
    const forwarded = { 'x-forwarded-for': '172.18.0.2', 'x-forwarded-proto': 'https', 'x-forwarded-host': PUBLIC_HOST }
    for (const url of ['/api/service/health', '/api/service/drain', '/api/service/resume']) {
      expect(enforceApiRequest(request({ url, identity: admin, headers: forwarded }), policy), url).toEqual({ kind: 'gateway', scope: 'admin' })
    }
    expect(refusal(() => enforceApiRequest(request({ url: '/api/service/health', host: 'poise-ws-octocat:5555', identity: admin }), policy)))
      .toEqual({ status: 403, message: 'host is not allowed' })
  })
})

describe('service mode: identity comes from the assertion alone', () => {
  // The gateway keeps its own credentials: no workspace cookie and no device
  // token reach a workspace, and neither may stand in for an assertion.
  const credentials = { cookie: 'poise_ws=session; poise_gw=apex', authorization: 'Bearer device-token' }

  it('never takes a cookie or an Authorization header for an identity', () => {
    for (const url of ['/api/settings', '/api/link/hello', '/api/service/health', '/ws/chat']) {
      expect(refusal(() => enforceApiRequest(request({ url, headers: credentials }), policy)), url)
        .toEqual({ status: 401, message: 'an identity assertion from the gateway is required' })
    }
    expect(refusal(() => enforceDocumentRequest(request({ url: '/', headers: credentials }), policy))).toMatchObject({ status: 401 })
  })

  it('lets the assertion\'s scope decide whatever else is sent', () => {
    const link = signAssertion(gateway.privateKey, { scope: 'link' })
    expect(refusal(() => enforceApiRequest(request({ url: '/api/settings', identity: link, headers: credentials }), policy))).toMatchObject({ status: 403 })
    expect(enforceApiRequest(request({ url: '/api/link/hello', identity: link, headers: credentials }), policy)).toEqual({ kind: 'gateway', scope: 'link' })
  })
})

describe('service mode: plain http for local end-to-end runs', () => {
  const at = (origin: string): ApiRequestPolicy => ({ service: readServiceConfig({ ...serviceEnvironment(gateway), POISE_PUBLIC_ORIGIN: origin }) })

  it('holds Host and Origin to the http origin, scheme included', () => {
    const local = at('http://octocat.localhost:8080')
    expect(enforceApiRequest(request({ host: 'octocat.localhost:8080', origin: 'http://octocat.localhost:8080', identity: browser(), headers: { 'x-forwarded-proto': 'http' } }), local))
      .toEqual({ kind: 'gateway', scope: 'browser' })
    expect(enforceDocumentRequest(request({ url: '/', host: 'octocat.localhost:8080', identity: browser() }), local)).toEqual({ kind: 'gateway', scope: 'browser' })
    expect(refusal(() => enforceApiRequest(request({ host: 'octocat.localhost:8080', origin: 'https://octocat.localhost:8080', identity: browser() }), local)))
      .toEqual({ status: 403, message: 'request origin is not allowed' })
    expect(refusal(() => enforceApiRequest(request({ host: 'octocat.localhost', identity: browser() }), local))).toEqual({ status: 403, message: 'host is not allowed' })
  })

  it('reads the default port in Host as the origin\'s own scheme does', () => {
    const local = at('http://octocat.localhost')
    expect(enforceApiRequest(request({ host: 'octocat.localhost:80', identity: browser() }), local)).toEqual({ kind: 'gateway', scope: 'browser' })
    expect(refusal(() => enforceApiRequest(request({ host: 'octocat.localhost:443', identity: browser() }), local))).toEqual({ status: 403, message: 'host is not allowed' })
  })
})

describe('service mode: loopback keeps the local rules', () => {
  it('admits the container\'s own health check without an assertion', () => {
    const req = request({ host: '127.0.0.1:5555', remoteAddress: '127.0.0.1', url: '/api/service/health', identity: browser() })
    expect(enforceApiRequest(req, policy)).toEqual({ kind: 'local' })
    expect(req.headers['x-poise-identity']).toBeUndefined()
    expect(enforceApiRequest(request({ host: '[::1]:5555', remoteAddress: '::ffff:127.0.0.1' }), policy)).toEqual({ kind: 'local' })
    expect(enforceDocumentRequest(request({ host: '127.0.0.1:5555', remoteAddress: '127.0.0.1', url: '/' }), policy)).toEqual({ kind: 'local' })
  })

  it('still refuses what the local rules refuse', () => {
    expect(refusal(() => enforceApiRequest(request({ host: PUBLIC_HOST, remoteAddress: '127.0.0.1' }), policy))).toEqual({ status: 403, message: 'host is not allowed' })
    expect(refusal(() => enforceApiRequest(request({ host: '127.0.0.1:5555', remoteAddress: '127.0.0.1', origin: 'https://127.0.0.1:5555' }), policy))).toEqual({ status: 403, message: 'request origin is not allowed' })
  })
})

describe('outside service mode nothing changes', () => {
  it('still refuses a non-loopback request, assertion or not', () => {
    expect(refusal(() => enforceApiRequest(request({ host: '127.0.0.1:5555', identity: browser() }))))
      .toEqual({ status: 403, message: 'non-browser API requests must originate from loopback' })
    expect(refusal(() => enforceApiRequest(request({ identity: browser() })))).toEqual({ status: 403, message: 'host is not allowed' })
  })

  it('serves documents without a check and leaves headers alone', () => {
    const req = request({ url: '/', identity: 'whatever' })
    expect(enforceDocumentRequest(req)).toEqual({ kind: 'local' })
    expect(req.headers['x-poise-identity']).toBe('whatever')
  })
})
