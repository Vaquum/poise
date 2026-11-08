import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { receiveIngress, INGRESS_LEASE_MS } from '../src/diagnostics/ingress.js'
import { DiagnosticStore } from '../src/diagnostics/store.js'
import { receiveManualIngress } from '../src/diagnostics/ingress.js'
import { executeLoggingRead } from '../src/diagnostics/query-worker.js'
import { nativeDiagnostic } from '../src/diagnostics/sources.js'
import { normalize } from '../src/diagnostics/contract.js'

const NOW = Date.parse('2026-10-19T10:00:00.000Z')
const access = { workspace: null, operator: true }
const container = 'a'.repeat(64)
// Caddy's post-header warning has no response status or content type.
const cancellation = { level: 'warn', ts: (NOW - 2000) / 1000, logger: 'http.handlers.reverse_proxy', msg: 'aborting with incomplete response', error: 'reading: context canceled',
  request: { host: 'alice.poise.test', method: 'GET', uri: '/api/link/events?private-query', headers: { Authorization: 'private-header' } } }
const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function store(now = () => NOW) {
  const dir = mkdtempSync(join(tmpdir(), 'poise-ingress-')); dirs.push(dir)
  return new DiagnosticStore(join(dir, 'logging.db'), undefined, now)
}
function batch(expected: string | null = null) {
  return { version: 1, expected, container, from: new Date(NOW - 300_000).toISOString(), until: new Date(NOW - 1000).toISOString(), state: 'complete',
    records: [{ id: '1'.repeat(64), time: new Date(NOW - 2000).toISOString(), log: { request: { host: 'alice.poise.test', method: 'GET', headers: { Authorization: 'private-header' }, uri: '/?private-query' },
      level: 'error', msg: 'dial tcp: refused ?token=private-query', request_id: 'same-request' } }] }
}
async function send(db: DiagnosticStore, input: unknown, now = () => NOW) {
  const lines: string[] = []
  async function* stdin() { yield JSON.stringify({ ...(input as Record<string, unknown>), challenge: (input as Record<string, unknown>).challenge ?? JSON.parse(lines[0]).challenge }) }
  await receiveIngress(db, 'poise.test', stdin(), (line) => lines.push(line), now)
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

it('commits actual Python source projection through the consumer, redaction and retained SQLite reader', async () => {
  const python = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('reporter',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nb=json.loads(sys.stdin.read());start=m.instant(b['from']);end=m.instant(b['until']);lines=b.pop('lines');b['records']=[r for line in lines if (r:=m.projected(line.encode(),'poise.test',start,end)) is not None];print(json.dumps(b))`
  const input = batch()
  const lines = [
    '2026-10-19T09:59:58.123456789Z ' + JSON.stringify(input.records[0].log),
    '2026-10-19T09:59:58.123456789Z ' + JSON.stringify({ ...input.records[0].log, request: { host: 'unrelated-business.test' }, msg: 'other-business-private-cause' }),
    '2026-10-19T09:59:58.123456789Z ' + JSON.stringify({ ...input.records[0].log, level: 'info', msg: 'routine native record' }),
    '2026-10-19T09:59:58.123456789Z ' + JSON.stringify(cancellation),
    '2026-10-19T09:59:58.123456790Z ' + JSON.stringify({ ...cancellation, error: 'reading: unexpected EOF' }),
  ]
  const projected: { records: unknown[] } = JSON.parse(execFileSync('python3', ['-c', python, resolve('../deploy/ingress/reporter.py')], { input: JSON.stringify({ ...input, lines }), encoding: 'utf8', timeout: 5000 }))
  execFileSync(process.execPath, ['deploy/ingress/build.mjs'], { cwd: resolve('..'), timeout: 15_000 })
  const safe = execFileSync(process.execPath, [resolve('../test-results/ingress/projection.cjs'), 'poise.test'], { input: JSON.stringify(projected.records), encoding: 'utf8', timeout: 5000 })
  const db = store()
  try {
    const replies = await send(db, { ...projected, records: JSON.parse(safe) })
    expect(replies[1]).toMatchObject({ accepted: true, currentStatus: 'connected', events: 2 })
    const page = db.query(access)
    expect(page.total).toBe(2)
    expect(page.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'ingress', visibility: 'operator', workspace: null, message: 'dial tcp:[redacted header]' }),
      expect.objectContaining({ message: cancellation.msg, stderr: 'reading: unexpected EOF', context: expect.objectContaining({ route: '/api/link/events', method: 'GET' }) }),
    ]))
    expect(safe).not.toMatch(/private-header|private-query|uri|headers/)
    expect(JSON.stringify(page)).not.toContain('reading: context canceled')
    expect(JSON.stringify(page)).not.toMatch(/private-header|private-query|other-business-private-cause|routine native record/)
    expect(db.query({ workspace: 'alice', operator: false }).total).toBe(0)
    expect(db.readCoverage(access)[0]).toMatchObject({ currentStatus: 'connected', availableFrom: input.from })
  } finally { db.close() }
})

it('excludes only the exact native Link cancellation and retains ambiguous cancellations and other causes', () => {
  expect(normalize(nativeDiagnostic(cancellation, 'ingress', 'cancel', null), NOW)).toBeNull()
  const faults = [
    { ...cancellation, error: 'reading: unexpected EOF' },
    { ...cancellation, error: 'dial tcp: connection refused' },
    { ...cancellation, error: 'reading: i/o timeout' },
    { ...cancellation, error: 'context canceled' },
    { ...cancellation, error: 'reading: context canceled (unknown cause)' },
    ...['level', 'logger', 'msg', 'error'].map((key) => Object.fromEntries(Object.entries(cancellation).filter(([name]) => name !== key))),
    { ...cancellation, level: 'error' },
    { ...cancellation, logger: 'http.handlers.other' },
    { ...cancellation, msg: 'request canceled before response' },
    ...[{}, { method: 'GET' }, { uri: '/api/link/events' }, { method: 'POST', uri: '/api/link/events' },
      { method: 'GET', uri: '/api/link/snippets' }, { method: 'GET', uri: '/api/link/events/other' },
      { method: 'GET', uri: '/api/link/snippets', route: '/api/link/events' }].map((request) => ({ ...cancellation, request })),
  ]
  for (const [index, fault] of faults.entries()) {
    const event = normalize(nativeDiagnostic(fault, 'ingress', String(index), null), NOW)
    expect(event, JSON.stringify(fault)).not.toBeNull()
    if (typeof fault.error === 'string') expect(event?.stderr).toBe(fault.error)
  }
})

it('advances cancellation-only scans and renews observation without faults, gaps or an ingestion timestamp', async () => {
  let now = NOW
  const db = store(() => now)
  const record = { id: 'c'.repeat(64), time: new Date(NOW - 2000).toISOString(), log: { ...cancellation, request: { host: 'alice.poise.test', method: 'GET', route: '/api/link/events' } } }
  try {
    const first = { ...batch(), until: record.time, records: [record] }
    const [, ack] = await send(db, first, () => now)
    expect(ack).toMatchObject({ events: 0, currentStatus: 'connected' })
    expect(db.checkpoint('external-ingress-window')).toBe(ack.checkpoint)
    expect(db.readCoverage(access)[0]).toMatchObject({ status: 'connected', gaps: [], ingestedAt: null, observationExpiresAt: new Date(now + INGRESS_LEASE_MS).toISOString() })
    now += 15_000
    const next = { ...first, expected: ack.checkpoint, from: first.until, until: new Date(now - 1000).toISOString() }
    const [, renewed] = await send(db, next, () => now)
    expect(renewed).toMatchObject({ events: 0, currentStatus: 'connected' })
    expect(renewed.checkpoint).not.toBe(ack.checkpoint)
    expect(db.checkpoint('external-ingress-window')).toBe(renewed.checkpoint)
    expect(db.query(access).total).toBe(0)
    expect(db.readCoverage(access)[0]).toMatchObject({ status: 'connected', gaps: [], ingestedAt: null, observedAt: new Date(now).toISOString(), observationExpiresAt: new Date(now + INGRESS_LEASE_MS).toISOString() })
  } finally { db.close() }
})

it('preserves redacted native causes in manual ingress while routine cancellation acknowledges no fault', async () => {
  const db = store()
  try {
    for (const error of ['reading: context canceled', 'reading: unexpected EOF', 'dial tcp: refused\nAuthorization: Bearer private-secret']) {
      async function* stdin() { yield JSON.stringify({ ...cancellation, error }) }
      const replies: string[] = []
      await receiveManualIngress(db, 'poise.test', stdin(), (line) => replies.push(line))
      if (error === cancellation.error) expect(JSON.parse(replies[0]).eventId).toBeNull()
    }
    const page = db.query(access)
    expect(page.total).toBe(2)
    expect(page.events.map((event) => event.stderr)).toContain('reading: unexpected EOF')
    expect(page.events.some((event) => event.stderr?.includes('dial tcp: refused'))).toBe(true)
    expect(JSON.stringify(page)).not.toMatch(/private-secret|private-query|private-header/)
  } finally { db.close() }
})

it('resumes committed windows, deduplicates replay and preserves distinct native occurrences', async () => {
  const db = store()
  try {
    const first = batch(); first.records[0].time = first.until
    const [, ack] = await send(db, first)
    const next = { ...batch(ack.checkpoint as string), from: first.until, until: new Date(NOW).toISOString(), records: first.records.map((record) => ({ ...record, time: first.until })) }
    // Docker window edges can replay a record: identity remains independent of observation time.
    await send(db, next)
    expect(db.query(access).total).toBe(1)
    const checkpoint = db.checkpoint('external-ingress-window')
    await expect(send(db, { ...next, expected: null })).rejects.toThrow(/checkpoint/)
    expect(db.checkpoint('external-ingress-window')).toBe(checkpoint)
    const following = { ...next, expected: checkpoint, from: next.until, until: new Date(NOW + 1000).toISOString(), records: next.records.map((record) => ({ ...record, id: '2'.repeat(64), time: next.until })) }
    await send(db, following)
    expect(db.query(access).total).toBe(2)
  } finally { db.close() }
})

it('expires health without reporter cooperation and closes rather than erases recovery history', async () => {
  let now = NOW
  const db = store(() => now)
  try {
    const first = batch(); const [, ack] = await send(db, first, () => now)
    now += INGRESS_LEASE_MS + 1
    expect(db.readCoverage(access)[0]).toMatchObject({ currentStatus: 'unavailable', status: 'partial', gaps: [{ to: null }] })
    const next = { ...first, expected: ack.checkpoint, from: first.until, until: new Date(now - 1000).toISOString(), records: [] }
    await send(db, next, () => now)
    const coverage = db.readCoverage(access)[0]
    expect(coverage).toMatchObject({ currentStatus: 'connected', status: 'partial' })
    expect(coverage.gaps).toHaveLength(1)
    expect(coverage.gaps[0].to).toBe(new Date(now).toISOString())
  } finally { db.close() }
})

it('records source/read losses explicitly while unavailable reads never advance the cursor', async () => {
  const db = store()
  try {
    const first = batch(); const [, ack] = await send(db, first)
    const unavailable = { ...first, expected: ack.checkpoint, from: first.until, state: 'unavailable', records: [] }
    await send(db, unavailable)
    expect(db.checkpoint('external-ingress-window')).toBe(ack.checkpoint)
    expect(db.readCoverage(access)[0]).toMatchObject({ currentStatus: 'unavailable', gaps: [{ to: null }] })
    const [, bounded] = await send(db, { ...unavailable, until: new Date(NOW).toISOString(), state: 'bounded' })
    expect(bounded.currentStatus).toBe('partial')
    expect(db.readCoverage(access)[0].gaps).toHaveLength(2)
    await send(db, { ...unavailable, expected: bounded.checkpoint, from: new Date(NOW).toISOString(), until: new Date(NOW + 1000).toISOString(), state: 'complete' })
    expect(db.readCoverage(access)[0]).toMatchObject({ currentStatus: 'connected', status: 'partial' })
  } finally { db.close() }
})

it('rejects wrong domains, malformed/oversized/future records without acknowledging or advancing', async () => {
  const db = store()
  try {
    for (const input of [
      { ...batch(), records: [{ ...batch().records[0], log: { request: { host: 'poise.test.attacker.test' }, level: 'error' } }] },
      { ...batch(), until: new Date(NOW + 6000).toISOString() },
      { ...batch(), records: [{ ...batch().records[0], id: 'invalid' }] },
      { ...batch(), records: [{ ...batch().records[0], log: { ...batch().records[0].log, msg: 'x'.repeat(65_536) } }] },
      { ...batch(), padding: 'x'.repeat(1024 * 1024) },
    ]) await expect(send(db, input)).rejects.toThrow()
    expect(db.checkpoint('external-ingress-window')).toBeNull()
    expect(db.query(access).total).toBe(0)
  } finally { db.close() }
})

it('rolls back earlier events and coverage if an immutable replay conflicts', async () => {
  const db = store()
  try {
    const first = batch(); const [, ack] = await send(db, first)
    const next = { ...first, expected: ack.checkpoint, from: first.until, until: new Date(NOW).toISOString(), records: [
      { ...first.records[0], id: '2'.repeat(64), time: first.until },
      { ...first.records[0], time: first.until, log: { ...first.records[0].log, msg: 'conflicting native record' } },
    ] }
    await expect(send(db, next)).rejects.toThrow(/immutable/)
    expect(db.checkpoint('external-ingress-window')).toBe(ack.checkpoint)
    expect(db.query(access).total).toBe(1)
  } finally { db.close() }
})

it('times out a stalled forced-command stream without committing', async () => {
  vi.useFakeTimers()
  const db = store()
  const stalled: AsyncIterable<Buffer> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
  try {
    const pending = expect(receiveIngress(db, 'poise.test', stalled, () => undefined)).rejects.toThrow(/30 seconds/)
    await vi.advanceTimersByTimeAsync(30_001)
    await pending
    expect(db.checkpoint('external-ingress-window')).toBeNull()
  } finally { db.close() }
})

it('projects an expired reporter into the actual independent browser-health read', async () => {
  const db = store()
  try {
    await send(db, batch())
    const now = NOW + INGRESS_LEASE_MS + 1
    writeFileSync(db.path + '.coverage.json', JSON.stringify({ version: 1, writtenAt: new Date(now).toISOString(), stopped: false,
      sinkError: null, dropped: 0, rejected: 0, sources: [] }))
    const reply = executeLoggingRead({ path: db.path, policy: db.policy, now, access, operation: 'health', filter: {} })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toMatchObject({ query: { status: 'connected' }, collection: { currentStatus: 'partial', sources: [
      { id: 'external-ingress', currentStatus: 'unavailable', gaps: [{ to: null }] },
    ] } })
  } finally { db.close() }
})

it('retains source rotation uncertainty independently of a connected current window', async () => {
  const db = store()
  try {
    await send(db, { ...batch(), retainedFrom: new Date(NOW - 2000).toISOString() })
    expect(db.readCoverage(access)[0]).toMatchObject({ currentStatus: 'connected', status: 'partial', gaps: [
      { from: batch().from, to: new Date(NOW - 2000).toISOString(), reason: expect.stringContaining('oldest retained') },
    ] })
  } finally { db.close() }
})

it('manual one-record delivery cannot renew an expired continuous lease', async () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  const db = store()
  try {
    await send(db, batch())
    vi.setSystemTime(NOW + INGRESS_LEASE_MS + 1)
    vi.stubEnv('POISE_DOMAIN', 'poise.test'); vi.stubEnv('POISE_GATEWAY_DATA', resolve(db.path, '..'))
    async function* input() { yield JSON.stringify(batch().records[0].log) }
    await receiveManualIngress(db, 'poise.test', input(), () => undefined)
    const reader = new DiagnosticStore(db.path, db.policy, Date.now, true)
    try { expect(reader.readCoverage(access)[0]).toMatchObject({ currentStatus: 'unavailable', observationExpiresAt: new Date(NOW + INGRESS_LEASE_MS).toISOString() }) }
    finally { reader.close() }
  } finally { db.close() }
})

it('does not let a concurrent reporter overwrite a window committed after its handshake', async () => {
  const db = store()
  let release!: (text: string) => void
  const text = new Promise<string>((resolve) => { release = resolve })
  async function* delayed() { yield await text }
  try {
    let challenge = ''
    const pending = expect(receiveIngress(db, 'poise.test', delayed(), (line) => { challenge = JSON.parse(line).challenge }, () => NOW)).rejects.toThrow(/checkpoint changed/)
    const [, ack] = await send(db, batch())
    release(JSON.stringify({ ...batch(), challenge }))
    await pending
    expect(db.checkpoint('external-ingress-window')).toBe(ack.checkpoint)
    expect(db.query(access).total).toBe(1)
  } finally { db.close() }
})


it('rejects an old challenge on a new connection without renewing source observation', async () => {
  const db = store()
  try {
    const [hello, ack] = await send(db, batch())
    const before = db.readCoverage(access)[0]
    await expect(send(db, { ...batch(ack.checkpoint as string), from: batch().until, until: new Date(NOW).toISOString(), records: [], challenge: hello.challenge })).rejects.toThrow(/envelope|checkpoint/)
    expect(db.readCoverage(access)[0]).toEqual(before)
    expect(db.checkpoint('external-ingress-window')).toBe(ack.checkpoint)
  } finally { db.close() }
})

it('starts the observation lease at the fresh challenge instead of delayed receipt', async () => {
  const db = store()
  let calls = 0
  try {
    await send(db, batch(), () => NOW + calls++ * 10_000)
    expect(db.readCoverage(access)[0]).toMatchObject({ observedAt: new Date(NOW).toISOString(), observationExpiresAt: new Date(NOW + INGRESS_LEASE_MS).toISOString() })
  } finally { db.close() }
})


it('marks bounded expiry history incomplete before recovery persists it', async () => {
  let now = NOW
  const db = store(() => now)
  try {
    const [, ack] = await send(db, batch(), () => now)
    const source = db.readCoverage(access)[0]
    db.coverage({ ...source, gaps: Array.from({ length: 32 }, (_, index) => ({ from: new Date(NOW - 100_000 + index * 1000).toISOString(), to: new Date(NOW - 99_500 + index * 1000).toISOString(), reason: 'retained outage ' + index })) })
    now += INGRESS_LEASE_MS + 1
    expect(db.readCoverage(access)[0]).toMatchObject({ historyIncomplete: true, gaps: expect.any(Array) })
    expect(db.readCoverage(access)[0].gaps).toHaveLength(32)
    await send(db, { ...batch(ack.checkpoint as string), from: batch().until, until: new Date(now).toISOString(), records: [] }, () => now)
    expect(db.readCoverage(access)[0]).toMatchObject({ currentStatus: 'connected', historyIncomplete: true })
  } finally { db.close() }
})
