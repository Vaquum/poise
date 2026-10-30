import { createHash } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openEvents, send, start, wait, type Target } from './link-fixture'

let root = ''
let server: Server
let target: Target
let link: import('../server/link/api').LinkApi
let api: typeof import('../server/link/api')
let store: typeof import('../server/alerts/store')
let library: typeof import('../server/snippet-library')
let database: typeof import('../server/db')
let espanso: typeof import('../server/link/espanso')
let events: typeof import('../server/link/events')
let feeds: typeof import('../server/link/snippets')

const LONG_POLL_MS = 300
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-link-api-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.stubEnv('POISE_ESPANSO_MATCH_DIR', join(root, 'match'))
  vi.resetModules()
  database = await import('../server/db')
  api = await import('../server/link/api')
  store = await import('../server/alerts/store')
  library = await import('../server/snippet-library')
  espanso = await import('../server/link/espanso')
  events = await import('../server/link/events')
  feeds = await import('../server/link/snippets')
  server = createServer((req, res) => { void link.handle(req, res, req.url ?? '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  target = { port: (server.address() as { port: number }).port }
})

beforeEach(async () => {
  database.db.prepare('DELETE FROM alerts').run()
  database.setMeta('me', '')
  await rm(join(root, 'match'), { recursive: true, force: true })
  await mkdir(join(root, 'match'))
  link = new api.LinkApi({ service: null, longPollMs: LONG_POLL_MS, pingMs: 100, maxStreams: 2, maxWaiters: 1 })
})

afterEach(() => {
  link.close()
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

/** A Link API whose long polls only a change, an abort or closing can
 *  answer: the hold outlasts every wait in these tests, even on a slow runner. */
function holdingLongPolls(): void {
  link.close()
  link = new api.LinkApi({ service: null, longPollMs: 60_000, pingMs: 100, maxStreams: 2, maxWaiters: 1 })
}

async function currentVersion(): Promise<string> {
  const reply = await send(target, 'GET', '/api/link/snippets')
  expect(reply.status).toBe(200)
  return reply.json.version
}

describe('GET /api/link/hello', () => {
  it('names the owner and the running build', async () => {
    expect(await send(target, 'GET', '/api/link/hello')).toMatchObject({ status: 200, json: { login: null, version: null } })
    database.setMeta('me', 'OctoCat')
    expect((await send(target, 'GET', '/api/link/hello')).json).toEqual({ login: 'OctoCat', version: null })
  })

  it('answers only GET, and only its own routes', async () => {
    expect(await send(target, 'POST', '/api/link/hello')).toMatchObject({ status: 405, headers: { allow: 'GET' } })
    expect((await send(target, 'GET', '/api/link/nothing')).status).toBe(404)
  })
})

describe('GET /api/link/snippets', () => {
  it('sends the plain pairs under the header, versioned by their SHA-256, which is also the ETag', async () => {
    await library.addSkillSnippet({ trigger: ';sig', replace: 'Best,\nOcto' })
    await library.addSkillSnippet({ trigger: ';hi', replace: 'hello' })
    const reply = await send(target, 'GET', '/api/link/snippets')
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('application/json')
    expect(Object.keys(reply.json)).toEqual(['version', 'yaml'])
    expect(reply.json.yaml).toBe(`${espanso.LINK_HEADER}\nmatches:\n  - trigger: ";sig"\n    replace: "Best,\\nOcto"\n  - trigger: ";hi"\n    replace: "hello"\n`)
    expect(reply.json.version).toBe(sha256(reply.json.yaml))
    expect(reply.headers.etag).toBe(`"${reply.json.version}"`)
  })

  it('answers 304 exactly when If-None-Match still names the current version', async () => {
    await library.addSkillSnippet({ trigger: ';hi', replace: 'hello' })
    const version = await currentVersion()
    for (const header of [`"${version}"`, `W/"${version}"`, '*', `"${'0'.repeat(64)}", "${version}"`]) {
      const reply = await send(target, 'GET', '/api/link/snippets', { 'if-none-match': header })
      expect(reply, header).toMatchObject({ status: 304, text: '', headers: { etag: `"${version}"` } })
    }
    for (const header of [`"${'0'.repeat(64)}"`, version]) {
      expect((await send(target, 'GET', '/api/link/snippets', { 'if-none-match': header })).status, header).toBe(200)
    }
    await library.addSkillSnippet({ trigger: ';bye', replace: 'goodbye' })
    const changed = await send(target, 'GET', '/api/link/snippets', { 'if-none-match': `"${version}"` })
    expect(changed.status).toBe(200)
    expect(changed.json.version).not.toBe(version)
  })

  it('holds ?wait= until the version changes, and answers at once when it does', async () => {
    holdingLongPolls()
    const version = await currentVersion()
    const started = Date.now()
    const held = start(target, `/api/link/snippets?wait=${version}`, { 'if-none-match': `"${version}"` })
    await vi.waitFor(() => expect(link.feed.waiting).toBe(1))
    await library.addSkillSnippet({ trigger: ';new', replace: 'fresh' })
    const reply = await held.done
    expect(reply.status).toBe(200)
    expect(reply.json.version).not.toBe(version)
    expect(reply.json.yaml).toContain('";new"')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(link.feed.waiting).toBe(0)
  })

  it('answers ?wait= like a plain request once the hold runs out', async () => {
    const version = await currentVersion()
    const started = Date.now()
    const conditional = await send(target, 'GET', `/api/link/snippets?wait=${version}`, { 'if-none-match': `"${version}"` })
    expect(conditional).toMatchObject({ status: 304, headers: { etag: `"${version}"` } })
    expect(Date.now() - started).toBeGreaterThanOrEqual(LONG_POLL_MS - 20)
    const unconditional = await send(target, 'GET', `/api/link/snippets?wait=${version}`)
    expect(unconditional).toMatchObject({ status: 200, json: { version } })
    expect(link.feed.waiting).toBe(0)
  })

  it('answers a wait for an outdated version at once, and refuses a malformed one', async () => {
    const version = await currentVersion()
    const stale = await send(target, 'GET', `/api/link/snippets?wait=${'0'.repeat(64)}`)
    expect(stale).toMatchObject({ status: 200, json: { version } })
    for (const wait of ['abc', '', version.toUpperCase()]) {
      expect((await send(target, 'GET', `/api/link/snippets?wait=${wait}`)).status, wait).toBe(400)
    }
  })

  it('lets go of a long poll whose client went away', async () => {
    holdingLongPolls()
    const version = await currentVersion()
    const held = start(target, `/api/link/snippets?wait=${version}`)
    held.done.catch(() => undefined)
    await vi.waitFor(() => expect(link.feed.waiting).toBe(1))
    held.abort()
    await vi.waitFor(() => expect(link.feed.waiting).toBe(0), { timeout: 2_000 })
    expect((await send(target, 'GET', '/api/link/snippets')).status).toBe(200)
  })

  it('refuses more long polls than it holds, and answers those it holds when it closes', async () => {
    holdingLongPolls()
    const version = await currentVersion()
    const held = start(target, `/api/link/snippets?wait=${version}`)
    await vi.waitFor(() => expect(link.feed.waiting).toBe(1))
    expect(await send(target, 'GET', `/api/link/snippets?wait=${version}`)).toMatchObject({ status: 503, headers: { 'retry-after': '5' } })
    link.close()
    expect(await held.done).toMatchObject({ status: 503, json: { error: 'Poise is shutting down' } })
  })

  it('says why when the library file cannot be read', async () => {
    await writeFile(join(root, 'match', 'poise.yml'), 'matches:\n  - trigger: ";a"\n    replace: a\n    replace: b\n')
    const reply = await send(target, 'GET', '/api/link/snippets')
    expect(reply.status).toBe(500)
    expect(reply.json.error).toMatch(/^The snippets could not be read: Map keys must be unique/)
  })
})

describe('GET /api/link/events', () => {
  it('opens with retry and the current snippets version, and replays nothing without Last-Event-ID', async () => {
    store.raiseAlert({ kind: 'chat_waiting', dedupeKey: 'before', title: 'Earlier', body: '', path: '/' })
    const version = await currentVersion()
    const stream = await openEvents(target)
    try {
      expect(stream.status).toBe(200)
      expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8')
      expect(stream.headers['cache-control']).toBe('no-store, no-transform')
      await stream.next((event) => event.event === 'ping')
      expect(stream.raw().startsWith(`retry: ${events.RETRY_MS}\n\nevent: snippets\ndata: {"version":"${version}"}\n\n`)).toBe(true)
      expect(stream.retry).toBe(events.RETRY_MS)
      expect(stream.events[0]).toEqual({ event: 'snippets', data: JSON.stringify({ version }), id: null })
      expect(stream.events.filter((event) => event.event === 'alert')).toEqual([])
    } finally {
      stream.close()
    }
  })

  it('delivers each new alert, with its id as the event id, and each new snippets version once', async () => {
    const stream = await openEvents(target)
    try {
      await stream.next((event) => event.event === 'snippets')
      const alert = store.raiseAlert({ kind: 'chat_turn_finished', dedupeKey: 'chat-turn-finished:t1', title: 'Codex finished', body: 'Done.', path: '/' })!
      const delivered = await stream.next((event) => event.event === 'alert')
      expect(delivered.id).toBe(alert.id)
      expect(JSON.parse(delivered.data)).toEqual({
        id: alert.id, kind: 'chat_turn_finished', title: 'Codex finished', body: 'Done.',
        url: `http://127.0.0.1:${target.port}/`, created_at: alert.createdAt,
      })
      expect(Object.keys(JSON.parse(delivered.data))).toEqual(['id', 'kind', 'title', 'body', 'url', 'created_at'])

      await library.addSkillSnippet({ trigger: ';hi', replace: 'hello' })
      const version = await currentVersion()
      await stream.next((event) => event.event === 'snippets' && JSON.parse(event.data).version === version)
      // Writing the same set again is no new version.
      const state = await library.readSkillSnippets()
      await library.saveSkillSnippets(state.snippets, state.version)
      await wait(150)
      expect(stream.events.filter((event) => event.event === 'snippets').map((event) => JSON.parse(event.data).version)).toHaveLength(2)
    } finally {
      stream.close()
    }
  })

  it('pings on its interval', async () => {
    const stream = await openEvents(target)
    try {
      const ping = await stream.next((event) => event.event === 'ping')
      expect(ping).toEqual({ event: 'ping', data: '{}', id: null })
    } finally {
      stream.close()
    }
  })

  it('replays the alerts recorded after Last-Event-ID, oldest first, then continues live', async () => {
    const [first, second, third] = ['a', 'b', 'c'].map((key) => store.raiseAlert({ kind: 'behavior_held', dedupeKey: key, title: key, body: '', path: '/' })!)
    const stream = await openEvents(target, { 'last-event-id': first.id })
    try {
      await stream.next((event) => event.id === third.id)
      const fourth = store.raiseAlert({ kind: 'behavior_held', dedupeKey: 'd', title: 'd', body: '', path: '/' })!
      await stream.next((event) => event.id === fourth.id)
      expect(stream.events.map((event) => event.event === 'alert' ? event.id : event.event).filter((name) => name !== 'ping'))
        .toEqual(['snippets', second.id, third.id, fourth.id])
    } finally {
      stream.close()
    }
    // An id this database did not issue resumes nowhere.
    for (const id of [`${'f'.repeat(12)}-1`, 'garbage']) {
      const other = await openEvents(target, { 'last-event-id': id })
      try {
        await other.next((event) => event.event === 'ping')
        expect(other.events.filter((event) => event.event === 'alert'), id).toEqual([])
      } finally {
        other.close()
      }
    }
  })

  it('delivers new alerts to a device whose resume point is past the newest alert', async () => {
    const seen = store.raiseAlert({ kind: 'behavior_held', dedupeKey: 'seen', title: 'seen', body: '', path: '/' })!
    const [prefix] = seen.id.split('-')
    const stream = await openEvents(target, { 'last-event-id': `${prefix}-${seen.seq + 1000}` })
    try {
      await stream.next((event) => event.event === 'snippets')
      const next = store.raiseAlert({ kind: 'behavior_held', dedupeKey: 'next', title: 'next', body: '', path: '/' })!
      await stream.next((event) => event.id === next.id)
      expect(stream.events.filter((event) => event.event === 'alert').map((event) => event.id)).toEqual([next.id])
    } finally {
      stream.close()
    }
  })

  it('replays at most the newest alerts to a device that was away long', async () => {
    const alerts = Array.from({ length: events.REPLAY_LIMIT + 10 }, (_, n) => store.raiseAlert({ kind: 'behavior_held', dedupeKey: `k${n}`, title: `t${n}`, body: '', path: '/' })!)
    const stream = await openEvents(target, { 'last-event-id': alerts[0].id })
    try {
      await stream.next((event) => event.id === alerts.at(-1)!.id)
      const replayed = stream.events.filter((event) => event.event === 'alert').map((event) => event.id)
      expect(replayed).toEqual(alerts.slice(-events.REPLAY_LIMIT).map((alert) => alert.id))
    } finally {
      stream.close()
    }
  })

  it('refuses more streams than it holds, and ends every stream when it closes', async () => {
    const streams = [await openEvents(target), await openEvents(target)]
    const third = await send(target, 'GET', '/api/link/events')
    expect(third).toMatchObject({ status: 503, headers: { 'retry-after': '5' } })
    link.close()
    await Promise.all(streams.map((stream) => stream.ended))
    const pings = streams.map((stream) => stream.events.filter((event) => event.event === 'ping').length)
    await wait(250)
    expect(streams.map((stream) => stream.events.filter((event) => event.event === 'ping').length)).toEqual(pings)
  })

  it('still carries alerts when the snippets cannot be read', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await writeFile(join(root, 'match', 'poise.yml'), 'matches: []\n---\nmatches: []\n')
    const stream = await openEvents(target)
    try {
      expect(stream.status).toBe(200)
      const alert = store.raiseAlert({ kind: 'sign_in_needed', dedupeKey: 'sign-in:claude', title: 'Sign in', body: '', path: '/' })!
      await stream.next((event) => event.id === alert.id)
      expect(stream.events.some((event) => event.event === 'snippets')).toBe(false)
      expect(errors).toHaveBeenCalledWith('[link] the snippets could not be read for a new event stream:', expect.any(Error))
    } finally {
      stream.close()
    }
  })

  it('cuts off a client that stops reading once a megabyte is queued for it', () => {
    const feed = new feeds.SnippetFeed(1)
    const streams = new events.EventStreams({ feed, maxStreams: 1 })
    const destroy = vi.fn()
    const res = {
      destroyed: false, writableEnded: false, writableLength: events.STREAM_BUFFER_LIMIT + 1,
      writeHead() { return this }, write: () => false, once() { return this }, end() { return this }, destroy,
    } as unknown as ServerResponse
    try {
      expect(streams.start({ headers: {} } as never, res, 'http://127.0.0.1')).toBe(true)
      expect(destroy).toHaveBeenCalled()
    } finally {
      streams.close()
      feed.close()
    }
  })
})
