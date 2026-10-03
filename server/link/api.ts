// The Link API a paired Poise Link calls (docs/Service-architecture.md,
// "Snippets and Poise Link"):
//   GET /api/link/hello     → { login, version }
//   GET /api/link/snippets  → { version, yaml }, ETag/If-None-Match, ?wait=
//   GET /api/link/events    → Server-Sent Events (server/link/events.ts)
// The caller has already applied the request policy: outside service mode
// only loopback reaches it, and in service mode the gateway's assertion must
// carry a scope that reaches /api/link/* (the device's `link`, or the owner's
// `browser`). Poise Link signs out on any 401, so nothing here answers 401.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BUILD_SHA } from '../build-identity'
import type { ServiceConfig } from '../service/config'
import { getSettings } from '../settings'
import type { LinkSnippets } from './espanso'
import { EventStreams } from './events'
import { SnippetFeed } from './snippets'

/** How long `?wait=` holds a request when nothing changes. */
export const LONG_POLL_MS = 25_000
/** Open event streams and waiting long polls each; more are refused with 503. */
export const MAX_STREAMS = 32
export const MAX_WAITERS = 32
const VERSION = /^[0-9a-f]{64}$/

export interface LinkApiOptions {
  service: ServiceConfig | null
  longPollMs?: number
  pingMs?: number
  maxStreams?: number
  maxWaiters?: number
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/** RFC 9110 If-None-Match: `*`, or a list of entity tags compared weakly. */
function noneMatch(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header ?? ''
  return value.split(',').some((tag) => {
    const trimmed = tag.trim()
    return trimmed === '*' || trimmed === etag || trimmed === `W/${etag}`
  })
}

export class LinkApi {
  readonly feed: SnippetFeed
  private readonly streams: EventStreams
  private readonly service: ServiceConfig | null
  private readonly longPollMs: number

  constructor(options: LinkApiOptions) {
    this.service = options.service
    this.longPollMs = options.longPollMs ?? LONG_POLL_MS
    this.feed = new SnippetFeed(options.maxWaiters ?? MAX_WAITERS)
    this.streams = new EventStreams({ feed: this.feed, maxStreams: options.maxStreams ?? MAX_STREAMS, pingMs: options.pingMs })
  }

  /** Handles `url` (path and query) under /api/link/. */
  async handle(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    const queryAt = url.indexOf('?')
    const path = queryAt < 0 ? url : url.slice(0, queryAt)
    const query = new URLSearchParams(queryAt < 0 ? '' : url.slice(queryAt + 1))
    const routes: Record<string, () => void | Promise<void>> = {
      '/api/link/hello': () => this.hello(res),
      '/api/link/snippets': () => this.snippets(req, res, query),
      '/api/link/events': () => this.events(req, res),
    }
    const route = routes[path]
    if (!route) return json(res, 404, { error: 'Link API route not found' })
    if (req.method !== 'GET') return json(res, 405, { error: `use GET for ${path}` }, { Allow: 'GET' })
    return route()
  }

  private hello(res: ServerResponse): void {
    json(res, 200, { login: this.service ? this.service.owner : getSettings().me || null, version: BUILD_SHA })
  }

  private read(res: ServerResponse): LinkSnippets | null {
    try {
      return this.feed.read()
    } catch (error) {
      json(res, 500, { error: `The snippets could not be read: ${error instanceof Error ? error.message : String(error)}` })
      return null
    }
  }

  private async snippets(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const wait = query.get('wait')
    if (wait !== null && !VERSION.test(wait)) return json(res, 400, { error: 'wait must be a snippets version: 64 lowercase hex digits' })
    let snippets = this.read(res)
    if (!snippets) return
    if (wait === snippets.version) {
      if (this.feed.full) return json(res, 503, { error: 'Too many requests are waiting for snippets; try again shortly' }, { 'Retry-After': '5' })
      const outcome = await this.feed.waitForChange(wait, this.longPollMs, res)
      if (outcome === 'gone') return
      if (outcome === 'closed') return json(res, 503, { error: 'Poise is shutting down' }, { 'Retry-After': '5' })
      snippets = this.read(res)
      if (!snippets) return
    }
    const etag = `"${snippets.version}"`
    res.setHeader('ETag', etag)
    if (noneMatch(req.headers['if-none-match'], etag)) {
      res.statusCode = 304
      res.end()
      return
    }
    json(res, 200, { version: snippets.version, yaml: snippets.yaml })
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    // A loopback request outside service mode came in on its own Host, which
    // the request policy has checked; a workspace's links are its public ones.
    const origin = this.service ? this.service.publicOrigin : `http://${req.headers.host}`
    let started: boolean
    try {
      started = this.streams.start(req, res, origin)
    } catch (error) {
      return json(res, 500, { error: `The alerts could not be read: ${error instanceof Error ? error.message : String(error)}` })
    }
    if (!started) json(res, 503, { error: 'Too many event streams are open; try again shortly' }, { 'Retry-After': '5' })
  }

  /** Ends every event stream and long poll, so the server can close. */
  close(): void {
    this.streams.close()
    this.feed.close()
  }
}
