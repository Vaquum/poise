import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** A top-level browser navigation, as opposed to a fetch, XHR, WebSocket or non-browser client. */
export function isNavigation(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const mode = header(req, 'sec-fetch-mode')
  if (mode) return mode === 'navigate'
  return header(req, 'accept').includes('text/html')
}

export function sendHtml(res: ServerResponse, status: number, html: string, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(html)
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export function redirect(res: ServerResponse, location: string, status = 302, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { location, 'cache-control': 'no-store', 'content-length': 0, ...headers })
  res.end()
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limitBytes) throw new HttpError(413, `The request body is larger than ${limitBytes} bytes.`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (!header(req, 'content-type').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new HttpError(415, 'Send this form as application/x-www-form-urlencoded.')
  }
  return new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'))
}
