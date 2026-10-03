import http, { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { withoutCookie } from './cookies.js'
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

export interface ForwardOptions {
  assertion: string
  proto: 'http' | 'https'
  /** The Authorization header carried a device token the gateway has consumed. */
  dropAuthorization: boolean
  /** The gateway's own session cookie, which the workspace never needs to see. */
  sessionCookie: string
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
      const kept = withoutCookie(Array.isArray(value) ? value.join('; ') : value, options.sessionCookie)
      if (kept) out.cookie = kept
      continue
    }
    out[name] = value
  }
  const priorFor = header(req, 'x-forwarded-for')
  out['x-forwarded-for'] = priorFor ? `${priorFor}, ${clientAddress(req)}` : clientAddress(req)
  out['x-forwarded-proto'] = options.proto
  out['x-forwarded-host'] = header(req, 'host')
  out['x-poise-identity'] = options.assertion
  return out
}

function responseHead(status: number, message: string | undefined, rawHeaders: readonly string[]): string {
  let head = `HTTP/1.1 ${status} ${message || STATUS_CODES[status] || ''}\r\n`
  for (let index = 0; index < rawHeaders.length; index += 2) head += `${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`
  return `${head}\r\n`
}

/**
 * Streams a request to the workspace and its answer back, in both directions without buffering.
 * `onError` runs only while the client can still be answered.
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
  upstream.on('response', (upstreamRes) => {
    const listed = connectionTokens(upstreamRes.headers)
    const outgoing: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name) && !listed.has(name)) outgoing[name] = value
    }
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, outgoing)
    // Long polls and event streams must not wait for a first body chunk to deliver their headers.
    res.flushHeaders()
    upstreamRes.on('error', () => res.destroy())
    upstreamRes.pipe(res)
  })
  upstream.on('error', (error) => {
    if (clientGone) return
    if (res.headersSent) {
      res.destroy()
      return
    }
    req.unpipe(upstream)
    req.resume()
    onError(error)
  })
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
  socket.end(responseHead(status, undefined, raw) + payload)
}

/** Relays a WebSocket upgrade to the workspace and then pipes the two sockets together. */
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
    socket.off('close', abandon)
    socket.on('error', () => upstreamSocket.destroy())
    socket.on('close', () => upstreamSocket.destroy())
    upstreamSocket.on('error', () => socket.destroy())
    upstreamSocket.on('close', () => socket.destroy())
    socket.write(responseHead(101, upstreamRes.statusMessage, upstreamRes.rawHeaders))
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket).pipe(upstreamSocket)
  })
  upstream.on('response', (upstreamRes) => {
    // The workspace declined the upgrade: relay its answer as a complete response and close.
    const chunks: Buffer[] = []
    upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk))
    upstreamRes.on('error', () => socket.destroy())
    upstreamRes.on('end', () => {
      const body = Buffer.concat(chunks)
      const raw: string[] = []
      for (let index = 0; index < upstreamRes.rawHeaders.length; index += 2) {
        const name = upstreamRes.rawHeaders[index]
        if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'content-length') {
          raw.push(name, upstreamRes.rawHeaders[index + 1])
        }
      }
      raw.push('content-length', String(body.length), 'connection', 'close')
      socket.end(Buffer.concat([Buffer.from(responseHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, raw)), body]))
    })
  })
  upstream.on('error', (error) => {
    if (!clientGone) onError(error)
  })
  upstream.end()
}
