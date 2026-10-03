// GET /api/link/events: the Server-Sent Events stream a paired Poise Link
// holds open. On connect it sends `retry:`, the current snippets version and
// the alerts recorded after `Last-Event-ID`; then a `snippets` event for each
// new version, an `alert` event (whose id is the alert's) for each new alert,
// and a `ping` every 20 seconds.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { alertEvents, alertSeq, alertsAfter, latestAlertSeq, type Alert } from '../alerts/store'
import type { SnippetFeed } from './snippets'

export const PING_MS = 20_000
/** The reconnection delay Poise Link starts its backoff from. */
export const RETRY_MS = 3_000
/** At most this many alerts are replayed on connect: the newest ones. A
 *  device that was away longer is not flooded with stale notifications. */
export const REPLAY_LIMIT = 50
/** A client that stops reading is cut off once this much is queued for it;
 *  it reconnects and resumes after the last alert it received. */
export const STREAM_BUFFER_LIMIT = 1024 * 1024
const DELIVERY_BATCH = 100

interface Stream {
  res: ServerResponse
  /** The workspace origin alert links are absolute in. */
  origin: string
  /** The last alert sent, by seq. */
  alertSeq: number
  snippetsVersion: string | null
}

export interface EventStreamsOptions {
  feed: SnippetFeed
  maxStreams: number
  pingMs?: number
}

function frame(event: string, data: unknown, id?: string): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function alertFrame(alert: Alert, origin: string): string {
  return frame('alert', {
    id: alert.id,
    kind: alert.kind,
    title: alert.title,
    body: alert.body,
    url: new URL(alert.path, origin).href,
    created_at: alert.createdAt,
  }, alert.id)
}

export class EventStreams {
  private readonly streams = new Set<Stream>()
  private readonly feed: SnippetFeed
  private readonly maxStreams: number
  private readonly ping: ReturnType<typeof setInterval>
  private readonly onVersion = (version: string) => {
    for (const stream of this.streams) this.sendSnippets(stream, version)
  }
  private readonly onAlerts = () => {
    for (const stream of this.streams) this.sendAlerts(stream)
  }

  constructor(options: EventStreamsOptions) {
    this.feed = options.feed
    this.maxStreams = options.maxStreams
    this.feed.on('version', this.onVersion)
    alertEvents.on('recorded', this.onAlerts)
    this.ping = setInterval(() => {
      for (const stream of this.streams) this.write(stream, frame('ping', {}))
    }, options.pingMs ?? PING_MS)
    this.ping.unref()
  }

  get open(): number {
    return this.streams.size
  }

  /** Starts a stream on `res`; false when too many are open already. Throws,
   *  before anything is sent, when the alerts cannot be read. */
  start(req: IncomingMessage, res: ServerResponse, origin: string): boolean {
    if (this.streams.size >= this.maxStreams) return false
    const header = req.headers['last-event-id']
    // Any other id (none, another database's, or garbage) resumes nowhere:
    // the device receives the alerts recorded from now on.
    const resumeAfter = typeof header === 'string' && header ? alertSeq(header.trim()) : null
    const replay = resumeAfter === null ? [] : alertsAfter(resumeAfter, REPLAY_LIMIT, { newest: true })
    // A resume point past the newest alert would hold back the next ones.
    const latest = latestAlertSeq()
    const stream: Stream = { res, origin, alertSeq: replay.at(-1)?.seq ?? Math.min(resumeAfter ?? latest, latest), snippetsVersion: null }
    let version: string | null = null
    try {
      version = this.feed.read().version
    } catch (error) {
      // The stream still carries alerts; GET /api/link/snippets reports the error.
      console.error('[link] the snippets could not be read for a new event stream:', error)
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    })
    this.write(stream, `retry: ${RETRY_MS}\n\n`)
    if (version !== null) this.sendSnippets(stream, version)
    for (const alert of replay) this.write(stream, alertFrame(alert, origin))
    this.streams.add(stream)
    res.once('close', () => this.streams.delete(stream))
    return true
  }

  private sendSnippets(stream: Stream, version: string): void {
    if (stream.snippetsVersion === version) return
    stream.snippetsVersion = version
    this.write(stream, frame('snippets', { version }))
  }

  private sendAlerts(stream: Stream): void {
    try {
      for (;;) {
        const batch = alertsAfter(stream.alertSeq, DELIVERY_BATCH)
        for (const alert of batch) {
          this.write(stream, alertFrame(alert, stream.origin))
          stream.alertSeq = alert.seq
        }
        if (batch.length < DELIVERY_BATCH || stream.res.destroyed) return
      }
    } catch (error) {
      // The client resumes from its last alert once it has reconnected.
      console.error('[link] new alerts could not be read for an event stream:', error)
      stream.res.destroy()
    }
  }

  private write(stream: Stream, text: string): void {
    const { res } = stream
    if (res.destroyed || res.writableEnded) return
    res.write(text)
    if (res.writableLength > STREAM_BUFFER_LIMIT) res.destroy()
  }

  /** Ends every stream: Poise Link reconnects to the next server. */
  close(): void {
    clearInterval(this.ping)
    this.feed.off('version', this.onVersion)
    alertEvents.off('recorded', this.onAlerts)
    for (const stream of this.streams) stream.res.end()
    this.streams.clear()
  }
}
