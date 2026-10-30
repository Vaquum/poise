import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalize, SEVERITIES, SOURCES } from '../gateway/src/diagnostics/contract'
import { DEFAULT_LOG_POLICY } from '../gateway/src/diagnostics/store'
import {
  LOGGING_LEVELS, LOGGING_SOURCES, LoggingApiError, loggingCallId, loggingErrorBounds, loggingEvent,
  loggingExport, loggingHealth, loggingHref, loggingPage, loggingParameters, loggingPullRequest,
  loggingRecord, parseLoggingLink, subscribeDiagnosticRefresh,
} from '../src/logging'

const access = { endpoint: '/api/logging', isAdmin: false, owner: 'local' }
const event = normalize({ id: 'client-record', source: 'caller', level: 'error', workspace: 'local', time: null,
  operation: 'git.fetch', message: 'retained failure', repository: 'acme/repo', pr: '42' })!
const bounds = { retentionAfter: '2026-09-19T00:00:00.000Z', from: null, to: null }
const page = { version: 1, countKind: 'events', events: [{ ...event, occurrences: 2 }], total: 1, coverage: [], bounds,
  policy: DEFAULT_LOG_POLICY, nextCursor: null, watermark: 'opaque' }
const health = { version: 1, status: 'partial', collection: { status: 'unavailable', checkedAt: event.ingestedAt, sources: [], lossObserved: false },
  query: { status: 'connected' }, bounds, policy: DEFAULT_LOG_POLICY }
const signal = () => new AbortController().signal
const respond = (value: unknown, status = 200) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(value), { status }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('canonical diagnostic browser contract', () => {
  it('shares the canonical severities and sources and preserves missing evidence', () => {
    expect(LOGGING_LEVELS).toEqual(SEVERITIES)
    expect(LOGGING_SOURCES).toEqual(SOURCES)
    expect(loggingRecord(event)).toEqual(event)
    expect(loggingRecord(event).eventTime).toBeNull()
    expect(loggingParameters({ severities: [], limit: 50 }).getAll('severity')).toEqual([''])
    expect(loggingParameters({ severities: ['critical', 'warning'], source: undefined }).getAll('severity')).toEqual(['critical', 'warning'])
  })
  it.each([{ version: 2 }, { cause: Array(9).fill('too many') }, { context: null }, { eventTime: 'bad' }, { id: '<script>' }, { severity: 'info' }, { exitCode: '1' }])('rejects incompatible records %j', (change) => {
    expect(() => loggingRecord({ ...event, ...change })).toThrow(LoggingApiError)
  })
  it('reads complete bounded pages with cookies, an abort signal and no cache', async () => {
    const fetch = respond(page)
    const abort = signal()
    expect(await loggingPage(access, { severities: ['error'], search: '%literal' }, abort)).toEqual(page)
    expect(fetch).toHaveBeenCalledWith('/api/logging?severity=error&search=%25literal', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal: abort }))
  })
  it.each([{ total: -1 }, { countKind: 'groups' }, { watermark: null }, { nextCursor: 3 }, { coverage: [{}] }, { policy: null }, { bounds: {} }, { events: Array(101).fill(page.events[0]) }, { events: [{ ...event }] }])('fails loudly on invalid page metadata %j', async (change) => {
    respond({ ...page, ...change })
    await expect(loggingPage(access, {}, signal())).rejects.toMatchObject({ status: 503, code: 'logging_incompatible' })
  })
  it('does not commit a body that finished after cancellation', async () => {
    const abort = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => { abort.abort(); return page } } as Response)
    await expect(loggingPage(access, {}, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('keeps 404 and 410 evidence states with retention bounds', async () => {
    for (const status of [404, 410]) {
      respond({ error: 'evidence_unavailable', message: 'Retained state', bounds }, status)
      try { await loggingEvent(access, event.id, 'workspace', signal()); expect.fail('must reject') }
      catch (error) { expect(error).toBeInstanceOf(LoggingApiError); expect((error as LoggingApiError).status).toBe(status); expect(loggingErrorBounds(error as LoggingApiError)).toEqual(bounds) }
      vi.restoreAllMocks()
    }
  })
  it('accepts independently unavailable collection/query health without inventing empty success', async () => {
    respond({ ...health, status: 'unavailable', query: { status: 'unavailable' } }, 503)
    expect((await loggingHealth(access, 'workspace', signal())).query.status).toBe('unavailable')
  })
  it('rejects unknown health versions or source status', async () => {
    respond({ ...health, collection: { ...health.collection, status: 'future' } })
    await expect(loggingHealth(access, 'workspace', signal())).rejects.toMatchObject({ code: 'logging_incompatible' })
  })
  it('rejects an over-budget download and preserves query errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(8 * 1024 * 1024 + 1)))
    await expect(loggingExport(access, {}, signal())).rejects.toMatchObject({ code: 'logging_incompatible' })
    vi.restoreAllMocks(); respond({ error: 'logging_busy', message: 'Busy' }, 429)
    await expect(loggingPage(access, {}, signal())).rejects.toMatchObject({ status: 429, code: 'logging_busy' })
  })
})

describe('validated durable navigation', () => {
  it('round-trips only a canonical event/incident target and zoned civil bounds', () => {
    const href = loggingHref({ event: event.id, from: '2026-10-18T03:00:00+03:00' })!
    expect(parseLoggingLink(new URL(href, 'http://local').search)).toEqual({ event: event.id, from: '2026-10-18T00:00:00.000Z' })
    expect(loggingHref({ incident: event.incidentId })).toContain('incident=')
    expect(loggingHref({ event: event.id, incident: event.incidentId })).toBeNull()
    expect(loggingHref({ event: 'https://evil.test/' })).toBeNull()
    expect(loggingHref({})).toBeNull()
  })
  it.each(['?view=logging&event=bad', '?view=logging&event=', '?view=logging&view=logging', '?view=logging&from=2026-02-30T00:00:00Z', '?view=logging&from=2026-10-18T00:00:00', '?view=logging&from=2026-10-19T00:00:00Z&to=2026-10-18T00:00:00Z'])('rejects %s before a request', (link) => {
    expect(() => parseLoggingLink(link)).toThrow()
  })
  it('constructs only fixed-origin PR and validated Caller links', () => {
    expect(loggingPullRequest(event)).toBe('https://github.com/acme/repo/pull/42')
    for (const repository of ['//evil.test/repo', 'acme/../repo', 'acme/repo?x', 'acme/..', 'acme/repo#x']) expect(loggingPullRequest({ repository, pr: '42' })).toBeNull()
    for (const pr of ['0', '-1', '1/x', '9007199254740992']) expect(loggingPullRequest({ repository: 'acme/repo', pr })).toBeNull()
    expect(loggingCallId('a'.repeat(32))).toBe(true)
    expect(loggingCallId('javascript:alert(1)')).toBe(false)
  })
})

it('shares a fixed wall-clock 15-second cadence and stops every unsubscribed reader', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  const first = vi.fn(); const second = vi.fn()
  const stopFirst = subscribeDiagnosticRefresh(first); const stopSecond = subscribeDiagnosticRefresh(second)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(13_999)
  expect(first).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1)
  stopFirst(); await vi.advanceTimersByTimeAsync(15_000)
  expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(2)
  stopSecond(); expect(vi.getTimerCount()).toBe(0)
})

it('validates current observation independently of historical completeness', async () => {
  respond({ ...health, collection: { ...health.collection, status: 'partial', currentStatus: 'connected' } })
  expect((await loggingHealth(access, 'workspace', signal())).collection.currentStatus).toBe('connected')
  vi.restoreAllMocks()
  respond({ ...health, collection: { ...health.collection, currentStatus: 'invented' } })
  await expect(loggingHealth(access, 'workspace', signal())).rejects.toMatchObject({ code: 'logging_incompatible' })
})

it.each([{ optional: 'yes' }, { historyIncomplete: 'yes' }, { lossActive: 'yes' }, { dropped: -1 }, { rejected: 1.5 }])('rejects malformed additive coverage fields %j', async (change) => {
  const source = { id: 'application', source: 'poise', workspace: 'local', status: 'partial', currentStatus: 'connected',
    observedAt: null, ingestedAt: null, availableFrom: null, error: null, gaps: [], ...change }
  respond({ ...health, collection: { ...health.collection, sources: [source] } })
  await expect(loggingHealth(access, 'workspace', signal())).rejects.toMatchObject({ code: 'logging_incompatible' })
})

it('rejects malformed active-loss observation without treating it as historical recovery', async () => {
  respond({ ...health, collection: { ...health.collection, lossActive: 'false' } })
  await expect(loggingHealth(access, 'workspace', signal())).rejects.toMatchObject({ code: 'logging_incompatible' })
})
