// A Link API client for tests: plain requests, and an event-stream reader
// that dispatches events by the WHATWG rules Poise Link's parser follows
// (link/src-tauri/src/sse.rs): CRLF, LF or CR line ends, `:` comments, and an
// event dispatched at a blank line only when it has data.

import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { expect } from 'vitest'
import { isMap, isScalar, isSeq, parseDocument, Scalar } from 'yaml'
import { LINK_HEADER, type PlainSnippet } from '../server/link/espanso'

export interface Reply { status: number, headers: IncomingHttpHeaders, text: string, json: any }

export interface StreamEvent { event: string, data: string, id: string | null }

export interface EventStream {
  status: number
  headers: IncomingHttpHeaders
  /** Every byte received, as text. */
  raw(): string
  events: StreamEvent[]
  retry: number | null
  /** Resolves with the first event (from the start) matching `match`. */
  next(match: (event: StreamEvent) => boolean, timeoutMs?: number): Promise<StreamEvent>
  /** Resolves when the server ends the stream. */
  ended: Promise<void>
  close(): void
}

export interface Target { port: number, host?: string, headers?: Record<string, string> }

export function send(target: Target, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return start(target, path, headers, method).done
}

/** Starts a request and keeps a handle on it, so a test can abort it. */
export function start(target: Target, path: string, headers: Record<string, string> = {}, method = 'GET'): { done: Promise<Reply>, abort(): void } {
  let abort = () => {}
  const done = new Promise<Reply>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: target.port, method, path, agent: false, headers: { host: target.host ?? `127.0.0.1:${target.port}`, ...target.headers, ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: unknown = null
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    abort = () => req.destroy()
    req.end()
  })
  return { done, abort: () => abort() }
}

export function openEvents(target: Target, headers: Record<string, string> = {}, path = '/api/link/events'): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: target.port, method: 'GET', path, agent: false,
      headers: { host: target.host ?? `127.0.0.1:${target.port}`, accept: 'text/event-stream', 'cache-control': 'no-cache', ...target.headers, ...headers },
    }, (res: IncomingMessage) => {
      let text = ''
      let line = ''
      let afterCr = false
      let fields: { event: string, data: string[], id: string | null } = { event: '', data: [], id: null }
      const waiters: Array<{ match: (event: StreamEvent) => boolean, resolve: (event: StreamEvent) => void }> = []
      let endedResolve!: () => void
      const stream: EventStream = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        raw: () => text,
        events: [],
        retry: null,
        next(match, timeoutMs = 5_000) {
          const found = stream.events.find(match)
          if (found) return Promise.resolve(found)
          return new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error(`no matching event within ${timeoutMs} ms; got ${JSON.stringify(stream.events)}`)), timeoutMs)
            waiters.push({ match, resolve: (event) => { clearTimeout(timer); done(event) } })
          })
        },
        ended: new Promise((done) => { endedResolve = done }),
        close: () => req.destroy(),
      }
      const dispatch = () => {
        if (fields.data.length) {
          const event = { event: fields.event || 'message', data: fields.data.join('\n'), id: fields.id }
          stream.events.push(event)
          for (const waiter of [...waiters]) {
            if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event) }
          }
        }
        fields = { event: '', data: [], id: null }
      }
      const processLine = (value: string) => {
        if (value === '') return dispatch()
        if (value.startsWith(':')) return
        const colon = value.indexOf(':')
        const field = colon < 0 ? value : value.slice(0, colon)
        let content = colon < 0 ? '' : value.slice(colon + 1)
        if (content.startsWith(' ')) content = content.slice(1)
        if (field === 'event') fields.event = content
        else if (field === 'data') fields.data.push(content)
        else if (field === 'id' && !content.includes('\0')) fields.id = content
        else if (field === 'retry' && /^\d+$/.test(content)) stream.retry = Number(content)
      }
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
        for (const char of chunk) {
          if (afterCr) {
            afterCr = false
            if (char === '\n') continue
          }
          if (char === '\n' || char === '\r') {
            processLine(line)
            line = ''
            afterCr = char === '\r'
          } else line += char
        }
      })
      res.on('end', () => endedResolve())
      res.on('close', () => endedResolve())
      resolve(stream)
    })
    req.on('error', reject)
    req.end()
  })
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// What Poise Link accepts (link/src-tauri/src/duties/snippets/document.rs):
// one document, a mapping whose single key `matches` lists entries with
// exactly a text `trigger` and `replace` and an optional text `label`; no
// aliases, merge keys, tags or duplicate keys.
export function assertLinkAccepts(yaml: string): PlainSnippet[] {
  const document = parseDocument(yaml, { uniqueKeys: true, merge: false, schema: 'core' })
  expect(document.errors).toEqual([])
  expect(yaml.split('\n')[0]).toBe(LINK_HEADER)
  const root = document.contents
  if (!isMap(root)) throw new Error('the top level is not a mapping')
  expect(root.items.map((pair) => (pair.key as Scalar).value)).toEqual(['matches'])
  const matches = root.get('matches', true)
  if (!isSeq(matches)) throw new Error('matches is not a list')
  return matches.items.map((item) => {
    if (!isMap(item)) throw new Error('an entry is not a mapping')
    const entry: Record<string, string> = {}
    for (const pair of item.items) {
      const key = (pair.key as Scalar).value as string
      expect(['trigger', 'replace', 'label']).toContain(key)
      // Every value is a double-quoted string, never a tag or an alias.
      if (!isScalar(pair.value) || pair.value.type !== Scalar.QUOTE_DOUBLE || pair.value.tag) throw new Error(`${key} is not a double-quoted string`)
      entry[key] = pair.value.value as string
    }
    expect(Object.keys(entry)).toEqual(expect.arrayContaining(['trigger', 'replace']))
    return entry as unknown as PlainSnippet
  })
}
