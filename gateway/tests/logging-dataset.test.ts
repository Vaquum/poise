import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalize, type LogEvent } from '../src/diagnostics/contract.js'
import { LoggingQueryPool } from '../src/diagnostics/query-pool.js'
import { executeLoggingRead } from '../src/diagnostics/query-worker.js'
import { DiagnosticStore, DEFAULT_LOG_POLICY, type LogFilter } from '../src/diagnostics/store.js'
import { LOGGING_RESPONSE_BYTES, type LoggingRead } from '../src/diagnostics/query-types.js'

it('queries 100,000 retained records with independent filter/count/export and snapshot parity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logging-100k-'))
  const now = Date.now()
  const path = join(dir, 'logging.db')
  const policy = { ...DEFAULT_LOG_POLICY, maxEvents: 200_000, maxBytes: 1024 * 1024 * 1024 }
  const db = new DiagnosticStore(path, policy, () => now)
  const events: LogEvent[] = []
  const access = { workspace: 'alice', operator: false }
  const request: LoggingRead = { path, now, policy, access, operation: 'list', filter: {} }
  const sort = (values: LogEvent[]) => [...values].sort((a, b) => (b.eventTime ?? b.ingestedAt).localeCompare(a.eventTime ?? a.ingestedAt) || b.id.localeCompare(a.id))
  const read = (filter: LogFilter) => JSON.parse(executeLoggingRead({ ...request, filter }).body) as ReturnType<DiagnosticStore['query']>
  try {
    for (let start = 0; start < 100_000; start += 100) {
      const batch = Array.from({ length: 100 }, (_, offset) => {
        const i = start + offset
        return normalize({ id: 'dataset-' + i, time: i % 11 ? new Date(now - (i % 1000) * 1000).toISOString() : null,
          source: i % 2 ? 'caller' : 'poise', component: i % 2 ? 'parity-a' : 'parity-b', workspace: 'alice',
          level: ['critical', 'error', 'warning'][i % 3], operation: 'dataset', condition: 'same-retained-condition',
          account: 'account-' + i % 2, repository: 'acme/repo', callId: (i % 1000 + 1).toString(16).padStart(32, '0'),
          correlationId: 'c'.repeat(32), target: 'target-' + i % 10, message: 'failure literal_% ' + i % 10 + '\nAuthorization: Bearer never-search-secret' }, now, ['never-search-secret'])!
      })
      events.push(...batch); db.append(batch)
    }
    const foreign = normalize({ id: 'bob-private', source: 'caller', workspace: 'bob', level: 'critical', operation: 'dataset', message: 'bob-private-cause' }, now)!
    db.append([foreign])
    const measured = (filter: LogFilter) => { const at = performance.now(); const result = read(filter); return { result, ms: performance.now() - at } }
    const first = measured({})
    expect(first.result.total).toBe(100_000)
    expect(first.result.events.map((event) => event.id)).toEqual(sort(events).slice(0, 50).map((event) => event.id))
    const search = measured({ search: 'literal_% 7' })
    expect(search.result.total).toBe(10_000)
    console.info('Logging 100k fixture performance (ms)', { first: first.ms, search: search.ms })
    expect(first.ms).toBeLessThan(500); expect(search.ms).toBeLessThan(500)
    const cases: Array<[LogFilter, (event: LogEvent) => boolean]> = [
      [{ severities: [] }, () => false],
      [{ severities: ['warning'], source: 'caller', component: 'parity-a', account: 'account-1', repository: 'acme/repo' }, (event) => event.severity === 'warning' && event.source === 'caller'],
      [{ from: new Date(now - 100_000).toISOString(), to: new Date(now - 50_000).toISOString() }, (event) => { const time = Date.parse(event.eventTime ?? event.ingestedAt); return time >= now - 100_000 && time < now - 50_000 }],
      [{ callId: events[7].callId! }, (event) => event.callId === events[7].callId],
      [{ correlationId: 'c'.repeat(32), incidentId: events[7].incidentId }, (event) => event.incidentId === events[7].incidentId],
      [{ search: 'never-search-secret' }, () => false],
      [{ source: 'unknown-well-formed-source' }, () => false],
    ]
    for (const [filter, matches] of cases) {
      const expected = sort(events.filter(matches)); const result = read(filter)
      expect(result.total).toBe(expected.length)
      expect(result.events.map((event) => event.id)).toEqual(expected.slice(0, 50).map((event) => event.id))
    }
    const filter = { callId: events[7].callId! }
    const expected = sort(events.filter((event) => event.callId === filter.callId))
    const exported = executeLoggingRead({ ...request, operation: 'export', filter })
    const lines = exported.body.trim().split('\n').map((line) => JSON.parse(line))
    expect(lines[0]).toMatchObject({ total: 100, exported: 100, truncated: false, resumeCursor: null })
    expect(lines.slice(1).map((line) => line.event.id)).toEqual(expected.map((event) => event.id))
    expect(exported.body).not.toContain('never-search-secret'); expect(exported.body).not.toContain('bob-private-cause')
    const pool = new LoggingQueryPool(); let timedOut = false
    try {
      const lease = await pool.read({ ...request, filter: { callId: events[7].callId! } }, 'alice', new AbortController().signal, () => { timedOut = true })
      expect(JSON.parse(lease.reply.body).total).toBe(100); expect(timedOut).toBe(false); lease.release()
    } finally { await pool.close() }
    const bounded = executeLoggingRead({ ...request, operation: 'export' })
    const header = JSON.parse(bounded.body.split('\n')[0])
    expect(header).toMatchObject({ exported: 1000, truncated: true, resumeCursor: expect.any(String) })
    expect(Buffer.byteLength(bounded.body)).toBeLessThanOrEqual(LOGGING_RESPONSE_BYTES)
    const before = first.result
    const late = normalize({ id: 'late-old', source: 'caller', workspace: 'alice', level: 'error', operation: 'dataset', time: new Date(now - 86_400_000).toISOString(), message: 'late older evidence' }, now)!
    db.append([late])
    const next = read({ cursor: before.nextCursor! })
    expect(next.total).toBe(100_000)
    expect(next.events.map((event) => event.id)).toEqual(sort(events).slice(50, 100).map((event) => event.id))
    expect(read({ after: before.watermark })).toMatchObject({ total: 1, events: [{ id: late.id }] })
    const related = read({ incidentId: events[7].incidentId, limit: 20 })
    expect(related.events).toHaveLength(20)
    expect(related.events[0].occurrences).toBe(events.filter((event) => event.incidentId === events[7].incidentId).length)
    expect(() => read({ source: 'caller', cursor: before.nextCursor! })).toThrow('cursor')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
}, 120_000)

it('exports an honest byte-bounded prefix and resumes exactly at the first omitted event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logging-export-bytes-')); const now = Date.now(); const path = join(dir, 'logging.db')
  const db = new DiagnosticStore(path)
  const events = Array.from({ length: 400 }, (_, i) => normalize({ id: 'large-' + i, time: new Date(now + i).toISOString(), source: 'caller', workspace: 'alice', level: 'error', operation: 'large', message: 'large retained cause', stderr: 'retained stderr line\n'.repeat(820), stack: 'retained stack frame\n'.repeat(410), cause: Array(8).fill('retained cause '.repeat(36)), context: { details: 'recorded context '.repeat(480) } }, now)!)
  const request: LoggingRead = { path, now, policy: DEFAULT_LOG_POLICY, access: { workspace: 'alice', operator: false }, operation: 'export', filter: {} }
  try {
    for (let i = 0; i < events.length; i += 100) db.append(events.slice(i, i + 100))
    const first = executeLoggingRead(request); const lines = first.body.trim().split('\n').map((line) => JSON.parse(line))
    expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(LOGGING_RESPONSE_BYTES)
    expect(lines[0].truncated).toBe(true); expect(lines[0].exported).toBeLessThan(400)
    const next = executeLoggingRead({ ...request, filter: { cursor: lines[0].resumeCursor } }).body.trim().split('\n').map((line) => JSON.parse(line))
    expect(next[0].truncated).toBe(false)
    expect([...lines.slice(1), ...next.slice(1)].map((line) => line.event.id)).toEqual([...events].reverse().map((event) => event.id))
    writeFileSync(path + '.coverage.json', JSON.stringify({ version: 1, writtenAt: new Date(now).toISOString(), stopped: false, sinkError: null, dropped: 10, rejected: 0, sources: [
      { id: 'private-bob', source: 'caller', workspace: 'bob', status: 'unavailable', error: 'bob-private-counts-and-cause', observedAt: null, ingestedAt: null, availableFrom: null, gaps: [] },
      { id: 'shared-host', source: 'kernel', workspace: null, status: 'unavailable', error: 'operator-private-cause', observedAt: null, ingestedAt: null, availableFrom: null, gaps: [{ from: new Date(now).toISOString(), to: null, reason: 'operator-private-gap' }] },
    ] }))
    const health = executeLoggingRead({ ...request, operation: 'health' }).body
    expect(JSON.parse(health)).toMatchObject({ collection: { status: 'partial', lossObserved: true, sources: [{ error: 'Source unavailable; an operator can inspect the cause.' }] } })
    expect(health).not.toContain('private-bob'); expect(health).not.toContain('operator-private'); expect(health).not.toContain('bob-private')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})


it('keeps scoped source-time bounds and ingestion expiry equivalent across readers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'logging-bounds-'))
  const path = join(directory, 'logging.db'); let now = Date.now()
  const policy = { ...DEFAULT_LOG_POLICY, retentionMs: 10_000 }
  const writer = new DiagnosticStore(path, policy, () => now)
  const at = (offset: number) => new Date(now + offset).toISOString()
  const inputs = [
    { id: 'own-old-source', workspace: 'alice', visibility: 'workspace' as const, time: at(-86_400_000) },
    { id: 'own-shared', workspace: 'alice', visibility: 'infrastructure' as const, time: at(3_600_000) },
    { id: 'foreign-private', workspace: 'bob', visibility: 'workspace' as const, time: at(-4 * 86_400_000) },
    { id: 'foreign-shared', workspace: 'bob', visibility: 'infrastructure' as const, time: at(2 * 3_600_000) },
    { id: 'operator', workspace: null, visibility: 'operator' as const, time: at(-3 * 86_400_000) },
  ]
  const reader = () => new DiagnosticStore(path, policy, () => now, true)
  try {
    writer.append(inputs.map((input) => normalize({ ...input, source: 'poise', level: 'error', operation: 'bounds', message: 'retained bounds evidence' }, now)!))
    const read = reader()
    try {
      expect(read.bounds({ workspace: 'alice', operator: false })).toMatchObject({ from: at(-86_400_000), to: at(3_600_000) })
      expect(read.bounds({ workspace: 'alice', operator: true })).toMatchObject({ from: at(-3 * 86_400_000), to: at(2 * 3_600_000) })
      now += policy.retentionMs + 1
      // The writer has not pruned: a read still enforces ingestion retention.
      expect(read.bounds({ workspace: 'alice', operator: false })).toMatchObject({ from: null, to: null })
      expect(read.bounds({ workspace: 'alice', operator: true })).toMatchObject({ from: null, to: null })
    } finally { read.close() }
  } finally { writer.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('projects current collection state independently of historical gaps and loss without widening access', () => {
  const directory = mkdtempSync(join(tmpdir(), 'logging-current-health-'))
  const path = join(directory, 'logging.db'); const now = Date.now()
  const db = new DiagnosticStore(path)
  const source = { id: 'own-source', source: 'caller', workspace: 'alice', status: 'partial', currentStatus: 'connected',
    observedAt: new Date(now).toISOString(), ingestedAt: null, availableFrom: new Date(now - 1000).toISOString(), error: null as string | null,
    gaps: [{ from: new Date(now - 2000).toISOString(), to: new Date(now - 1000).toISOString(), reason: 'recovered outage' }] }
  const journal = { version: 1, writtenAt: new Date(now).toISOString(), stopped: false, sinkError: null as string | null, dropped: 2, rejected: 0, lossActive: false,
    sources: [source, { ...source, id: 'foreign-source', workspace: 'bob', currentStatus: 'unavailable', error: 'foreign-private-cause' }] }
  const request: LoggingRead = { path, now, policy: DEFAULT_LOG_POLICY, access: { workspace: 'alice', operator: false }, operation: 'health', filter: {} }
  const read = () => { writeFileSync(path + '.coverage.json', JSON.stringify(journal)); return JSON.parse(executeLoggingRead(request).body) }
  try {
    expect(read()).toMatchObject({ collection: { status: 'partial', currentStatus: 'connected', lossObserved: true, sources: [{ id: 'own-source', currentStatus: 'connected' }] } })
    expect(JSON.stringify(read())).not.toContain('foreign-private-cause')
    expect(read().collection.sources).toHaveLength(1)
    source.currentStatus = 'partial'; source.error = 'backfill pending'
    expect(read().collection.currentStatus).toBe('partial')
    journal.sinkError = 'sink failed'
    expect(read()).toMatchObject({ collection: { currentStatus: 'unavailable' }, query: { status: 'connected' } })
    journal.sinkError = null; source.error = null
    const legacy = { ...source }; delete (legacy as Partial<typeof source>).currentStatus
    writeFileSync(path + '.coverage.json', JSON.stringify({ ...journal, sources: [legacy] }))
    expect(JSON.parse(executeLoggingRead(request).body).collection.currentStatus).toBe('initializing')
    source.currentStatus = 'connected'; request.now += 60_001
    expect(read().collection.currentStatus).toBe('stale')
    request.now = now
    db.coverage({ id: 'external-ingress', source: 'ingress', workspace: null, status: 'not-configured', currentStatus: 'not-configured',
      observedAt: null, ingestedAt: null, availableFrom: null, error: 'Operator delivery has not been configured', gaps: [] })
    expect(read()).toMatchObject({ collection: { status: 'partial', currentStatus: 'partial', sources: expect.arrayContaining([
      expect.objectContaining({ source: 'ingress', currentStatus: 'not-configured' }),
    ]) } })
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})
