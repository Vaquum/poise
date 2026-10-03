import http, { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { withoutCookies } from './cookies.js'
import { header } from './http.js'
import type { Upstream } from './orchestrator.js'

// RFC 9110 section 7.6.1 hop-by-hop fields, plus Expect, which only governs the client's own hop.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect',
])

// Errors that mean nothing is listening at the workspace's address yet, as opposed to a broken exchange.
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])

export function isUnreachable(error: NodeJS.ErrnoException): boolean {
  return UNREACHABLE.has(error.code ?? '')
}

/** The workspace answered with something the gateway will not relay. */
export class UpstreamResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamResponseError'
  }
}

/** A status Node can send on: an owner-controlled workspace may answer with anything, e.g. `HTTP/1.1 099`. */
function relayableStatus(status: number | undefined): number {
  if (status === undefined || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new UpstreamResponseError(`the workspace answered with status ${String(status)}`)
  }
  return status
}

export interface ForwardOptions {
  assertion: string
  proto: 'http' | 'https'
  /** The Authorization header carried a device token the gateway has consumed. */
  dropAuthorization: boolean
  /** The gateway's own cookies, which a workspace never sees. */
  stripCookies: ReadonlySet<string>
}

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection
  const list = Array.isArray(value) ? value.join(',') : value ?? ''
  return new Set(list.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean))
}

function clientAddress(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
}

/** The request headers a workspace receives: the client's, minus anything identity-bearing the gateway owns. */
export function forwardHeaders(req: IncomingMessage, options: ForwardOptions): OutgoingHttpHeaders {
  const listed = connectionTokens(req.headers)
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) continue
    if (name === 'x-poise-identity' || name === 'forwarded' || name.startsWith('x-forwarded-')) continue
    if (name === 'authorization' && options.dropAuthorization) continue
    if (name === 'cookie') {
      const kept = withoutCookies(Array.isArray(value) ? value.join('; ') : value, options.stripCookies)
      if (kept) out.cookie = kept
      continue
    }
    out[name] = value
  }
  // A chunked body is re-framed as chunked on the way in: Node would otherwise send it unframed for some
  // methods, and the workspace would read the body as a second request.
  if (req.headers['transfer-encoding'] !== undefined) out['transfer-encoding'] = 'chunked'
  const priorFor = header(req, 'x-forwarded-for')
  out['x-forwarded-for'] = priorFor ? `${priorFor}, ${clientAddress(req)}` : clientAddress(req)
  out['x-forwarded-proto'] = options.proto
  out['x-forwarded-host'] = header(req, 'host')
  out['x-poise-identity'] = options.assertion
  return out
}

/** Response headers worth relaying: no hop-by-hop fields and no cookies, which a workspace may never set. */
function relayedHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = connectionTokens(headers)
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && !listed.has(name) && name !== 'set-cookie') out[name] = value
  }
  return out
}

function responseHead(status: number, rawHeaders: readonly string[]): string {
  let head = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n`
  for (let index = 0; index < rawHeaders.length; index += 2) head += `${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`
  return `${head}\r\n`
}

function withoutRawHeaders(rawHeaders: readonly string[], drop: (name: string) => boolean): string[] {
  const kept: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (!drop(rawHeaders[index].toLowerCase())) kept.push(rawHeaders[index], rawHeaders[index + 1])
  }
  return kept
}

/**
 * Streams a request to the workspace and its answer back, in both directions without buffering.
 * `onError` runs only while the client can still be answered, and must not throw.
 */
export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  target: Upstream,
  headers: OutgoingHttpHeaders,
  agent: http.Agent,
  onError: (error: NodeJS.ErrnoException) => void,
): void {
  let clientGone = false
  const upstream = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers, agent })
  const fail = (error: NodeJS.ErrnoException) => {
    if (clientGone) return
    if (res.headersSent) {
      res.destroy()
      return
    }
    req.unpipe(upstream)
    req.resume()
    onError(error)
  }
  upstream.on('response', (upstreamRes) => {
    // Anything thrown in this listener would escape every handler and take the whole gateway down.
    try {
      res.writeHead(relayableStatus(upstreamRes.statusCode), relayedHeaders(upstreamRes.headers))
      // Long polls and event streams must not wait for a first body chunk to deliver their headers.
      res.flushHeaders()
      upstreamRes.on('error', () => res.destroy())
      upstreamRes.pipe(res)
    } catch (error) {
      upstreamRes.destroy()
      upstream.destroy()
      fail(error as NodeJS.ErrnoException)
    }
  })
  upstream.on('error', fail)
  res.on('close', () => {
    if (res.writableFinished) return
    clientGone = true
    upstream.destroy()
  })
  req.pipe(upstream)
}

/** Answers a WebSocket upgrade with a plain HTTP error and closes the connection. */
export function rejectUpgrade(socket: Duplex, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  const payload = JSON.stringify(body)
  const raw = [
    'content-type', 'application/json; charset=utf-8',
    'content-length', String(Buffer.byteLength(payload)),
    'connection', 'close',
    ...Object.entries(headers).flat(),
  ]
  socket.end(responseHead(status, raw) + payload)
}

/**
 * Relays a WebSocket upgrade to the workspace and then pipes the two sockets together.
 * `onError` runs only while the client can still be answered, and must not throw.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: Upstream,
  headers: OutgoingHttpHeaders,
  onError: (error: NodeJS.ErrnoException) => void,
): void {
  let clientGone = false
  const upstream = http.request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: { ...headers, connection: 'Upgrade', upgrade: header(req, 'upgrade') },
    agent: false,
  })
  const abandon = () => {
    clientGone = true
    upstream.destroy()
  }
  socket.once('close', abandon)
  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    try {
      socket.off('close', abandon)
      socket.on('error', () => upstreamSocket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.on('error', () => socket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
      socket.write(responseHead(101, withoutRawHeaders(upstreamRes.rawHeaders, (name) => name === 'set-cookie')))
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
    } catch (error) {
      // Nothing can be answered on a half-switched connection: close both ends, then report it.
      upstreamSocket.destroy()
      socket.destroy()
      onError(error as NodeJS.ErrnoException)
    }
  })
  upstream.on('response', (upstreamRes) => {
    // The workspace declined the upgrade: relay its answer as a complete response and close.
    let status: number
    try {
      status = relayableStatus(upstreamRes.statusCode)
    } catch (error) {
      upstreamRes.destroy()
      upstream.destroy()
      if (!clientGone) onError(error as NodeJS.ErrnoException)
      return
    }
    const chunks: Buffer[] = []
    upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk))
    upstreamRes.on('error', () => socket.destroy())
    upstreamRes.on('end', () => {
      const body = Buffer.concat(chunks)
      const raw = withoutRawHeaders(upstreamRes.rawHeaders, (name) => HOP_BY_HOP.has(name) || name === 'content-length' || name === 'set-cookie')
      raw.push('content-length', String(body.length), 'connection', 'close')
      socket.end(Buffer.concat([Buffer.from(responseHead(status, raw)), body]))
    })
  })
  upstream.on('error', (error) => {
    if (!clientGone) onError(error)
  })
  upstream.end()
}
