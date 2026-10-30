import { sign } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalize } from '../src/diagnostics/contract.js'
import { DiagnosticStore } from '../src/diagnostics/store.js'
import { parseLoggingQuery } from '../src/diagnostics/query-parser.js'
import { startHarness, workspaceHost, type Harness } from './harness.js'

describe('authorized retained diagnostic reads', () => {
  let h: Harness
  let alice: string
  let root: string
  const own = normalize({ id: 'http-alice', source: 'caller', level: 'error', operation: 'fetch', workspace: 'alice', message: 'retained fetch cause' })!
  const foreign = normalize({ id: 'http-bob', source: 'caller', level: 'error', operation: 'fetch', workspace: 'bob', message: 'bob-private-cause' })!
  const host = normalize({ id: 'http-host', source: 'kernel', level: 'critical', operation: 'oom', workspace: null, message: 'host OOM cause' })!
  beforeEach(async () => {
    h = await startHarness()
    alice = (await h.openWorkspace('Alice')).workspaceCookie
    root = (await h.openWorkspace('root')).workspaceCookie
    const db = new DiagnosticStore(join(h.config.dataDir, 'logging.db'))
    try { db.append([own, foreign, host]) } finally { db.close() }
  })
  afterEach(async () => { await h.close(); vi.restoreAllMocks() })

  const request = (handle: string, cookie: string, path: string, extra: Record<string, string> = {}) => h.request({
    host: workspaceHost(handle), path: '/_poise/api/logging' + path,
    headers: { cookie, 'sec-fetch-site': 'same-origin', ...extra },
  })

  it('serves list, detail and export without contacting a workspace', async () => {
    h.workspace.reachable = false
    const list = await request('alice', alice, '')
    expect(list.status).toBe(200)
    expect(list.json()).toMatchObject({ version: 1, total: 1, countKind: 'events', events: [{ id: own.id, message: own.message }] })
    expect((await request('alice', alice, '/events/' + own.id)).json()).toMatchObject({ version: 1, event: { id: own.id } })
    const exported = await request('alice', alice, '/export')
    expect(exported.status).toBe(200)
    const lines = exported.body.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ type: 'metadata', exported: 1, truncated: false, resumeCursor: null })
    expect(lines[1]).toMatchObject({ type: 'event', event: { id: own.id } })
    expect(exported.body).not.toContain('bob-private-cause')
    expect(h.workspace.requests).toHaveLength(0)
  })

  it('requires explicit current admin access and never exposes another owner private record', async () => {
    vi.spyOn(h.context.deps, 'now').mockReturnValue(h.context.deps.now())
    expect((await request('root', root, '')).json()).toMatchObject({ total: 0 })
    const instance = await request('root', root, '?scope=instance')
    expect(instance.json()).toMatchObject({ total: 1, events: [{ id: host.id }] })
    expect(instance.body).not.toContain('bob-private-cause')
    expect((await request('root', root, '/export?scope=instance')).status).toBe(200)
    expect((await request('alice', alice, '?scope=instance')).status).toBe(403)
    const inaccessible = await request('alice', alice, '/events/' + foreign.id)
    const unknown = await request('alice', alice, '/events/evt_' + '0'.repeat(16) + '_' + '0'.repeat(64))
    expect(inaccessible.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(inaccessible.json()).toEqual(unknown.json())
    expect(h.logs.filter((entry) => entry.event === 'logging.query')).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'root', scope: 'instance' })]))
    h.store.addAllowed('root', 'root')
    h.config.admins.splice(0)
    expect((await request('root', root, '?scope=instance')).status).toBe(403)
  })

  it('honors an explicit export limit and resumes without skipping the unused page suffix', async () => {
    const db = new DiagnosticStore(join(h.config.dataDir, 'logging.db'))
    const events = Array.from({ length: 15 }, (_, i) => normalize({ id: 'export-limit-' + i, time: new Date(Date.now() + i * 1000).toISOString(),
      source: 'caller', component: 'export-limit', operation: 'fetch', level: 'error', workspace: 'alice', message: 'export row ' + i })!)
    try { db.append(events) } finally { db.close() }
    const first = await request('alice', alice, '/export?component=export-limit&limit=10')
    expect(first.status).toBe(200)
    const lines = first.body.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ exported: 10, truncated: true, resumeCursor: expect.any(String) })
    expect(lines.slice(1).map((line) => line.event.id)).toEqual(events.slice(5).reverse().map((event) => event.id))
    const next = await request('alice', alice, '/export?component=export-limit&limit=10&cursor=' + encodeURIComponent(lines[0].resumeCursor))
    const remaining = next.body.trim().split('\n').map((line) => JSON.parse(line))
    expect(remaining[0]).toMatchObject({ exported: 5, truncated: false, resumeCursor: null })
    expect(remaining.slice(1).map((line) => line.event.id)).toEqual(events.slice(0, 5).reverse().map((event) => event.id))
  })

  it('retains a cold Logging URL through fake GitHub sign-in and the bound workspace ticket', async () => {
    const target = '/?' + new URLSearchParams({ view: 'logging', event: own.id, from: '2026-10-18T03:00:00+03:00' })
    const { reply, bindCookie } = await h.signIn('Alice', 'https://' + workspaceHost('alice') + target)
    const ticket = new URL(reply.headers.location!)
    expect(ticket.searchParams.get('next')).toBe(target)
    const session = await h.request({ host: workspaceHost('alice'), path: ticket.pathname + ticket.search, headers: { cookie: bindCookie } })
    expect(session.status).toBe(302)
    expect(session.headers.location).toBe(target)
    expect(session.cookie('poise_ws')).not.toBe('')
  })

  it.each(['', '/health', '/export', '/events/' + own.id, '?incidentId=' + own.incidentId])('applies browser authentication and exact-origin guards to %s', async (path) => {
    expect((await request('alice', '', path)).status).toBe(401)
    expect((await request('alice', root, path)).status).toBe(403)
    expect((await request('alice', alice, path, { authorization: 'Bearer device-token' })).status).toBe(401)
    expect((await request('alice', alice, path, { origin: 'https://bob.poise.test' })).status).toBe(403)
    expect((await request('alice', alice, path, { 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await request('alice', alice, path, { 'sec-fetch-site': 'none' })).status).toBe(403)
    const valid = h.context.assertion(h.store.getUser('alice')!, 'browser')
    const [header, payload, signature] = valid.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    const signed = (changes: Record<string, unknown>) => {
      const input = header + '.' + Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url')
      return input + '.' + sign(null, Buffer.from(input), h.keys.privateKey).toString('base64url')
    }
    const assertions = ['malformed', header + '.' + payload + '.' + signature.slice(0, -4) + 'AAAA',
      signed({ iat: 1, exp: 61 }), signed({ iss: 'foreign' }), signed({ aud: 'workspace:bob' }), signed({ sub: 'bob' }),
      signed({ iat: claims.iat + 120, exp: claims.iat + 180 }), signed({ exp: claims.iat + 3600 }), signed({ scope: 'unknown' }),
      h.context.assertion(h.store.getUser('alice')!, 'link'), h.context.assertion(h.store.getUser('alice')!, 'admin')]
    for (const identity of assertions) expect((await request('alice', '', path, { 'x-poise-identity': identity })).status).toBe(401)
    expect((await request('alice', alice, path + (path.includes('?') ? '&' : '?') + 'scope=instance')).status).toBe(403)
  })
})

describe('strict shared diagnostic filters', () => {
  const owner = { workspace: 'alice', isAdmin: false }
  it.each(['severity=info', 'severity=&severity=error', 'from=2026-02-30T00:00:00Z', 'from=2026-10-18', 'from=2026-10-18T01:00:00Z&to=2026-10-18T00:00:00Z', 'limit=101', 'limit=0', 'cursor=a&cursor=b', 'unknown=value'])('rejects %s', (query) => {
    expect(() => parseLoggingQuery(new URLSearchParams(query), owner)).toThrow()
  })
  it('canonicalizes severities, supports an empty selection and preserves exact literal search', () => {
    expect(parseLoggingQuery(new URLSearchParams('severity='), owner).filter.severities).toEqual([])
    expect(parseLoggingQuery(new URLSearchParams('severity=warning&severity=critical&severity=warning'), owner).filter.severities).toEqual(['critical', 'warning'])
    expect(parseLoggingQuery(new URLSearchParams({ search: '%_literal', from: '2026-10-18T03:00:00+03:00' }), owner).filter).toMatchObject({ search: '%_literal', from: '2026-10-18T00:00:00.000Z' })
    expect(() => parseLoggingQuery(new URLSearchParams('workspace=bob'), owner)).toThrow('belongs to someone else')
  })
})
