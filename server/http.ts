import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServiceConfig } from './service/config'
import { IDENTITY_HEADER, scopeAllowsPath, verifyIdentityAssertion, type AssertionScope } from './service/identity'

export const JSON_BODY_MAX_BYTES = 1 * 1024 * 1024
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] || '' : value || ''
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase()
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

/** A Host header as the URL it names under `protocol`: the local server is
 *  plain HTTP, the gateway's public origin HTTPS (plain HTTP only for a local
 *  end-to-end run). */
function urlFromHost(value: string, protocol: 'http:' | 'https:' = 'http:'): URL | null {
  try {
    const parsed = new URL(`${protocol}//${value}`)
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function allowedHostname(value: string): string {
  const parsed = urlFromHost(value)
  return normalizeHostname(parsed?.hostname || value)
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return true
  const address = value.replace(/^::ffff:/, '')
  return address === '127.0.0.1' || address === '::1'
}

export interface ApiRequestPolicy {
  allowedHosts?: string[]
  /** Service mode: every request that is not from loopback is the gateway's. */
  service?: ServiceConfig | null
}

/** Who a request was admitted as: this machine under the local rules, or the
 *  gateway with an identity assertion of one scope. */
export type RequestAuthority =
  | { kind: 'local' }
  | { kind: 'gateway', scope: AssertionScope }

// Unlike the local rules, an unknown peer is never taken for loopback here.
function isLoopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress
  return !!address && isLoopbackAddress(address)
}

/** The gateway's request: the workspace's public host, its exact origin when
 *  one is sent, and a valid identity assertion whose scope covers the path.
 *  The assertion header is removed before anything can refuse the request,
 *  so nothing downstream can echo, log or forward it. */
function enforceGatewayRequest(req: IncomingMessage, service: ServiceConfig, api: boolean): RequestAuthority {
  const token = header(req, IDENTITY_HEADER)
  delete req.headers[IDENTITY_HEADER]
  if (urlFromHost(header(req, 'host'), service.publicProtocol)?.host !== service.publicHost) throw new HttpError(403, 'host is not allowed')
  if (api && header(req, 'sec-fetch-site').toLowerCase() === 'cross-site') {
    throw new HttpError(403, 'cross-site API requests are not allowed')
  }
  const origin = header(req, 'origin')
  if (origin && origin !== service.publicOrigin) throw new HttpError(403, 'request origin is not allowed')
  if (!token) throw new HttpError(401, 'an identity assertion from the gateway is required')
  const result = verifyIdentityAssertion(token, { key: service.gatewayKey, handle: service.handle, owner: service.owner }, Date.now() / 1000)
  if (!result.ok) throw new HttpError(401, result.reason)
  const path = (req.url || '/').split('?')[0]
  if (!scopeAllowsPath(result.assertion.scope, path)) {
    throw new HttpError(403, `an identity assertion with the ${result.assertion.scope} scope does not reach this route`)
  }
  return { kind: 'gateway', scope: result.assertion.scope }
}

/** Static files and the SPA document. Locally there is nothing to check (the
 *  server only binds loopback); in service mode they are the owner's like
 *  every API route. A cross-site navigation to the workspace is allowed. */
export function enforceDocumentRequest(req: IncomingMessage, policy: ApiRequestPolicy = {}): RequestAuthority {
  if (policy.service) {
    if (!isLoopbackPeer(req)) return enforceGatewayRequest(req, policy.service, false)
    delete req.headers[IDENTITY_HEADER]
  }
  return { kind: 'local' }
}

export function allowedApiHosts(policy: ApiRequestPolicy = {}): Set<string> {
  return new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    ...(policy.allowedHosts ?? []).map(allowedHostname),
  ])
}

/**
 * Enforce Poise's local-only trust boundary before an API handler runs.
 * Same-origin browser requests and loopback CLI probes are accepted;
 * cross-site browser requests and non-loopback callers are rejected.
 * In service mode a non-loopback request is the gateway's and is held to its
 * identity assertion instead; loopback keeps the local rules.
 */
export function enforceApiRequest(
  req: IncomingMessage,
  policy: ApiRequestPolicy = {},
): RequestAuthority {
  if ((req.url?.length ?? 0) > 8_192) {
    throw new HttpError(414, 'request URL is too long')
  }
  if (policy.service) {
    if (!isLoopbackPeer(req)) return enforceGatewayRequest(req, policy.service, true)
    delete req.headers[IDENTITY_HEADER]
  }

  const hostHeader = header(req, 'host')
  const hostUrl = urlFromHost(hostHeader)
  const hostname = normalizeHostname(hostUrl?.hostname || '')
  if (!hostUrl || !hostname || !allowedApiHosts(policy).has(hostname)) {
    throw new HttpError(403, 'host is not allowed')
  }

  if (header(req, 'sec-fetch-site').toLowerCase() === 'cross-site') {
    throw new HttpError(403, 'cross-site API requests are not allowed')
  }

  const origin = header(req, 'origin')
  if (origin) {
    let originUrl: URL
    try {
      originUrl = new URL(origin)
    } catch {
      throw new HttpError(403, 'invalid request origin')
    }
    if (originUrl.protocol !== hostUrl.protocol || originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) {
      throw new HttpError(403, 'request origin is not allowed')
    }
  } else if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    throw new HttpError(403, 'non-browser API requests must originate from loopback')
  }
  return { kind: 'local' }
}

export function setApiHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox")
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
}

export async function readBuffer(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(header(req, 'content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, `request body exceeds ${maxBytes} bytes`)
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAborted)
      req.off('error', onError)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += value.byteLength
      if (size > maxBytes) {
        fail(new HttpError(413, `request body exceeds ${maxBytes} bytes`))
        // The rejected consumer no longer owns the stream. Keep draining it
        // and absorb a subsequent transport error so an oversized request
        // cannot become an uncaught EventEmitter error.
        req.once('error', () => {})
        req.resume()
        return
      }
      chunks.push(value)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, size))
    }
    const onAborted = () => fail(new HttpError(400, 'request was aborted'))
    const onError = (error: Error) => fail(new HttpError(400, error.message))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('aborted', onAborted)
    req.on('error', onError)
  })
}

export async function readJson<T = Record<string, unknown>>(
  req: IncomingMessage,
  maxBytes: number = JSON_BODY_MAX_BYTES,
): Promise<T> {
  const contentType = header(req, 'content-type').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
    throw new HttpError(415, 'content-type must be application/json')
  }
  const raw = (await readBuffer(req, maxBytes)).toString('utf8')
  if (!raw) return {} as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
}

export function httpStatus(error: unknown, fallback: number): number {
  return error instanceof HttpError ? error.statusCode : fallback
}
