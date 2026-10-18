import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { environmentSecrets, normalize, redact, severity, type DiagnosticInput, type LogEvent } from '../src/diagnostics/contract.js'
import { DiagnosticRuntime } from '../src/diagnostics/runtime.js'
import { runOperator } from '../src/diagnostics/cli.js'
import { DiagnosticStore, DEFAULT_LOG_POLICY } from '../src/diagnostics/store.js'
import { callerDiagnostic, nativeDiagnostic, workspaceEnvelope } from '../src/diagnostics/sources.js'

const NOW = Date.parse('2026-10-18T10:00:00Z')
const alice = { workspace: 'alice', operator: false }
const operator = { workspace: 'alice', operator: true }
const stores: DiagnosticStore[] = []
const directories: string[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { force: true, recursive: true }) })
function directory() { const path = mkdtempSync(join(tmpdir(), 'poise-diagnostics-')); directories.push(path); return path }
function store(policy = DEFAULT_LOG_POLICY) { const value = new DiagnosticStore(':memory:', policy, () => NOW); stores.push(value); return value }
function event(id: string, update: Partial<DiagnosticInput> = {}): LogEvent {
  const value = normalize({ id, time: new Date(NOW).toISOString(), level: 'error', source: 'poise', operation: 'test.operation',
    workspace: 'alice', message: 'precise failure', ...update }, NOW)
  if (!value) throw new Error('Expected a qualifying fixture')
  return value
}

describe('one diagnostic contract', () => {
  it('preserves typed source and Caller identities through short-secret redaction and backfill', async () => {
    const callId = 'a1'.repeat(16); const correlationId = 'ab12cd34-ab12-cd34-ab12-cd34ab12cd34'
    const input = callerDiagnostic({ id: callId, correlation_id: correlationId, completed_at: new Date(NOW).toISOString(),
      status: 'failed', error: 'actual cause a', diagnostic: { version: 1, severity: 'error', operation: 'checkout', stderr: 'fatal: cause a' } }, 'alice')!
    const secrets = ['a', 'caller']
    const original = normalize(input, NOW, secrets)!
    const central = workspaceEnvelope(original, 'alice', NOW, secrets)
    expect(central).toMatchObject({ source: 'caller', callId, correlationId, message: expect.stringContaining('[redacted]') })
    const runtime = new DiagnosticRuntime({ path: ':memory:', now: () => NOW, secrets, report: () => undefined })
    runtime.observe('caller', 'caller', 'alice'); runtime.ingest(central); runtime.flush()
    expect(runtime.query((db) => db.query(alice, { source: 'caller', callId, correlationId })).total).toBe(1)
    expect(runtime.health().sources[0]).toMatchObject({ source: 'caller', ingestedAt: new Date(NOW).toISOString() })
    await runtime.stop()
    // A configured credential itself is never admitted as a public identifier.
    expect(normalize({ ...input, callId, correlationId: callId }, NOW, [callId])).toMatchObject({ callId: '[redacted]', correlationId: '[redacted]' })
  })

  it('keeps unknown-time identity independent of ingestion time and replacement containers', () => {
    const input = { id: 'stable-native-id', time: null, level: 'error', source: 'native', operation: 'read', message: 'cause' }
    expect(normalize(input, NOW)?.id).toBe(normalize({ ...input, container: 'replacement' }, NOW + 5000)?.id)
    expect(event('pre-epoch', { time: '1960-01-01T00:00:00Z' })).toMatchObject({ source: 'collection', severity: 'warning', eventTime: null })
  })

  it('validates full event and incident identities at storage and stream boundaries', () => {
    const original = event('invalid-id'); const db = store()
    for (const update of [{ id: original.id + 'suffix' }, { incidentId: original.incidentId + 'suffix' }]) {
      expect(() => db.append([{ ...original, ...update }])).toThrow('scope')
      expect(() => workspaceEnvelope({ ...original, ...update }, 'alice', NOW, [])).toThrow('scope')
    }
  })

  it('preserves native numeric priorities and diagnoses malformed timestamps without throwing', () => {
    const malformed = nativeDiagnostic({ PRIORITY: 3, __REALTIME_TIMESTAMP: 'not-a-clock', MESSAGE: 'original cause' }, 'kernel', 'journal-id', null)
    expect(() => normalize(malformed, NOW)).not.toThrow()
    expect(normalize(malformed, NOW)).toMatchObject({ severity: 'warning', source: 'collection', message: expect.stringContaining('original cause') })
    const attributed = normalize(nativeDiagnostic({ PRIORITY: 3, MESSAGE: 'kernel cause' }, 'kernel', 'journal-2', 'bob'), NOW)!
    const db = store(); db.append([attributed])
    expect(db.query(operator).total).toBe(1); expect(db.query(alice).total).toBe(0)
    expect(normalize(nativeDiagnostic({ level: 'error', ts: NOW / 1000, msg: 'proxy cause' }, 'ingress', 'request', null), NOW)?.eventTime).toBe(new Date(NOW).toISOString())
  })
  it('maps native levels and refuses to silently omit malformed levels', () => {
    for (const level of ['fatal', 'Critical', '0', '2']) expect(severity(level)).toBe('critical')
    expect(severity('ERROR')).toBe('error'); expect(severity('warn')).toBe('warning')
    for (const level of ['info', 'debug', 'trace', '5', '6', '7']) expect(normalize({ source: 'native', operation: 'read', level, message: 'routine' })).toBeNull()
    expect(event('malformed', { level: 'banana' })).toMatchObject({ source: 'collection', severity: 'warning', operation: 'normalization.failed', sourceLevel: 'banana' })
  })

  it('redacts before persistence and omits prompts, stdout and environment recursively', () => {
    const secret = 'private-example-credential'
    const encoded = Buffer.from('x-access-token:' + secret).toString('base64')
    const value = normalize({ id: 'redaction', level: 'error', source: 'caller', operation: 'fetch', workspace: 'alice',
      message: secret, stderr: `Authorization: Basic ${encoded}\nCookie: private-cookie\nhttps://user:password@example.com/?token=private-query\n${encoded}`,
      context: { prompt: 'private-prompt', stdout: 'private-output', arguments: ['private-argument'], responses: { text: 'private-response' }, token: 'opaque-token-value', refresh_token: 'opaque-refresh-value', nested: { environment: 'private-env', safe: 'measured' } } }, NOW, [secret])!
    const db = store(); db.append([value])
    const output = JSON.stringify(db.query(alice))
    for (const denied of [secret, encoded, 'private-cookie', 'password', 'private-query', 'private-prompt', 'private-output', 'private-env', 'private-argument', 'private-response', 'opaque-token-value', 'opaque-refresh-value']) expect(output).not.toContain(denied)
    expect(output).toContain('measured')
  })

  it('bounds UTF-8 evidence by bytes rather than characters', () => {
    const value = event('unicode', { stderr: '障'.repeat(20_000), stack: '障'.repeat(10_000) })
    expect(Buffer.byteLength(value.stderr!)).toBeLessThanOrEqual(16_384)
    expect(Buffer.byteLength(value.stack!)).toBeLessThanOrEqual(8192)
    expect(value.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(64 * 1024)
  })

  it('preserves occurrence identity while distinguishing workspace and technical scope', () => {
    expect(event('same').id).toBe(event('same').id)
    expect(event('same').id).not.toBe(event('same', { workspace: 'bob' }).id)
    expect(event('same').incidentId).not.toBe(event('same', { visibility: 'operator' }).incidentId)
    const db = store(); expect(db.append([event('same'), event('same')])).toBe(1)
    expect(() => db.append([event('same', { message: 'contradictory cause' })])).toThrow('Conflicting immutable')
    expect(db.query(alice).events[0]?.message).toBe('precise failure')
  })

  it('keeps the same scoped event ID when central collection re-redacts a workspace envelope', () => {
    const original = event('stream')
    const central = workspaceEnvelope(original, 'alice', NOW + 1000, [])
    expect(central.id).toBe(original.id); expect(central.ingestedAt).not.toBe(original.ingestedAt)
    expect(() => workspaceEnvelope(original, 'bob', NOW, [])).toThrow('scope')
    expect(() => workspaceEnvelope({ ...original, id: event('stream', { workspace: 'bob' }).id }, 'alice', NOW, [])).toThrow('scope')
  })
})

describe('retained authorized queries', () => {
  it('expires authorized tombstones in idle writable and read-only stores', () => {
    const policy = { retentionMs: 1000, maxBytes: 100_000, maxEvents: 1 }
    const path = join(directory(), 'tombstones.db'); let now = NOW
    const writer = new DiagnosticStore(path, policy, () => now); stores.push(writer)
    const original = event('tombstone-age')
    writer.append([original]); writer.append([event('tombstone-replacement')])
    const reader = new DiagnosticStore(path, policy, () => now, true); stores.push(reader)
    for (const db of [writer, reader]) {
      expect(db.lookup(alice, original.id).status).toBe('expired')
      expect(db.lookup(operator, original.id).status).toBe('expired')
      expect(db.lookup({ workspace: 'bob', operator: false }, original.id).status).toBe('unavailable')
    }
    now += policy.retentionMs + 1
    for (const db of [writer, reader]) {
      expect(db.lookup(alice, original.id).status).toBe('unavailable')
      expect(db.lookup(operator, original.id).status).toBe('unavailable')
    }
  })

  it('bounds actual bytes and never resurrects a tombstoned replay', () => {
    const policy = { retentionMs: 100_000, maxBytes: 20_000, maxEvents: 100 }
    const db = store(policy)
    const records = Array.from({ length: 8 }, (_, i) => event('large-' + i, { stderr: 's'.repeat(12_000) }))
    for (const record of records) db.append([record])
    expect(db.query(alice).total).toBe(1)
    expect(db.lookup(alice, records[0].id).status).toBe('expired')
    db.append([records[0]])
    expect(db.query(alice).events.map((record) => record.id)).toEqual([records.at(-1)!.id])
  })

  it.each([1001, 2000, 2001])('never renews expiry evidence for an initially %i-ms-old ingestion with a future source timestamp', (age) => {
    const policy = { retentionMs: 1000, maxBytes: 100_000, maxEvents: 100 }
    const path = join(directory(), 'late-ingestion.db'); let now = NOW
    const db = new DiagnosticStore(path, policy, () => now); stores.push(db)
    const future = { ...event('future', { time: '2099-01-01T00:00:00Z' }), ingestedAt: new Date(NOW - age).toISOString() }
    db.append([future])
    expect(db.query(alice).total).toBe(0)
    const reader = new DiagnosticStore(path, policy, () => now, true); stores.push(reader)
    for (const view of [db, reader]) {
      expect(view.lookup(alice, future.id).status).toBe(age <= 2000 ? 'expired' : 'unavailable')
      expect(view.lookup(operator, future.id).status).toBe(age <= 2000 ? 'expired' : 'unavailable')
      expect(view.lookup({ workspace: 'bob', operator: false }, future.id).status).toBe('unavailable')
    }
    now += policy.retentionMs
    db.append([future])
    for (const view of [db, reader]) {
      expect(view.lookup(alice, future.id).status).toBe('unavailable')
      expect(view.query(alice).total).toBe(0)
    }
  })
  it('filters the full retained dataset and never accepts lower severities', () => {
    const db = store()
    db.append(Array.from({ length: 80 }, (_, i) => event(String(i), { level: i % 2 ? 'warning' : 'error', source: i === 70 ? 'caller' : 'poise', repository: 'acme/repo' })))
    expect(db.query(alice, { source: 'caller', limit: 1 }).total).toBe(1)
    expect(db.query(alice, { severities: ['warning'] }).total).toBe(40)
    expect(db.query(alice, { search: 'precise' }).total).toBe(80)
    expect(db.query(alice, { search: "' OR 1=1 --" }).total).toBe(0)
    expect(db.query(alice, { severities: [] }).total).toBe(0)
    expect(() => db.query(alice, { severities: ['info' as 'error'] })).toThrow('only Critical')
  })

  it('does not widen scope through filters, direct IDs or cursors', () => {
    const db = store(); const bob = event('bob', { workspace: 'bob' }); db.append([event('alice'), bob, event('host', { workspace: null })])
    expect(db.query(alice).events).toHaveLength(1)
    expect(db.query(operator).events).toHaveLength(2)
    expect(() => db.query(alice, { workspace: 'bob' })).toThrow('forbidden')
    expect(db.lookup(alice, bob.id).status).toBe('unavailable')
    expect(db.lookup(operator, bob.id).status).toBe('unavailable')
    expect(db.query(operator, { workspace: 'bob' }).total).toBe(0)
    const cursor = db.query(operator, { limit: 1 }).nextCursor!
    expect(() => db.query(alice, { cursor })).toThrow('filters')
  })

  it('paginates with stable ordering and a fixed ingestion boundary', () => {
    const db = store(); db.append(Array.from({ length: 12 }, (_, i) => event(String(i))))
    const first = db.query(alice, { limit: 5 })
    db.append([event('late', { time: new Date(NOW - 1).toISOString() })])
    const second = db.query(alice, { limit: 5, cursor: first.nextCursor! })
    const third = db.query(alice, { limit: 5, cursor: second.nextCursor! })
    const ids = [...first.events, ...second.events, ...third.events].map((row) => row.id)
    expect(new Set(ids).size).toBe(12); expect(third.nextCursor).toBeNull(); expect(second.total).toBe(12)
    expect(db.query(alice).total).toBe(13)
    expect(db.query(alice, { after: first.watermark }).events.map((row) => row.id)).toEqual([event('late', { time: new Date(NOW - 1).toISOString() }).id])
    expect(() => db.query(alice, { cursor: first.nextCursor!.slice(0, -3) + 'xyz' })).toThrow('cursor')
    expect(() => db.query({ workspace: 'bob', operator: false }, { after: first.watermark })).toThrow('cursor')
    expect(Buffer.from(first.nextCursor!, 'base64url').toString()).not.toContain('high')
  })

  it('enforces retention and byte/count bounds without duplicate replay evicting history', () => {
    const db = store({ retentionMs: 1000, maxBytes: 100_000, maxEvents: 2 })
    const old = { ...event('old', { time: new Date(NOW - 2000).toISOString() }), ingestedAt: new Date(NOW - 2000).toISOString() }
    db.append([old, event('one'), event('two')]); expect(db.query(alice).total).toBe(2)
    db.append([event('one')]); expect(db.query(alice).total).toBe(2)
    expect(db.lookup(alice, old.id).status).toBe('expired')
    db.append([event('three')]); expect(db.query(alice).total).toBe(2)
    expect(() => db.query(alice, { limit: 10000 })).toThrow('page size')
  })

  it('survives store restart while preserving multiline cause as one event', () => {
    const path = join(directory(), 'history.db')
    const original = event('removed-container', { container: 'old-container', stderr: 'fatal: exact cause\nstack line one\nstack line two' })
    const first = new DiagnosticStore(path, DEFAULT_LOG_POLICY, () => NOW); first.append([original]); first.close()
    const second = new DiagnosticStore(path, DEFAULT_LOG_POLICY, () => NOW); stores.push(second)
    expect(second.query(alice).total).toBe(1)
    expect(second.lookup(alice, original.id)).toMatchObject({ status: 'found', event: { stderr: original.stderr, container: 'old-container' } })
  })
})

describe('collection independence and Caller evidence', () => {
  it('drains more than one batch on shutdown and does not double count loss on restart', () => {
    const path = join(directory(), 'drain.db')
    const runtime = new DiagnosticRuntime({ path, now: () => NOW })
    for (let i = 0; i < 350; i++) runtime.emit({ id: String(i), time: null, level: 'error', source: 'poise', operation: 'read', workspace: 'alice', message: 'cause' })
    runtime.stop()
    const db = new DiagnosticStore(path, DEFAULT_LOG_POLICY, () => NOW); stores.push(db)
    expect(db.query(alice).total).toBe(350)
    const reopened = new DiagnosticRuntime({ path, now: () => NOW }); expect(reopened.health()).toMatchObject({ dropped: 0, queued: 0 }); reopened.stop()
  })

  it('separates query validation, coverage failure and reporter failure from sink availability', () => {
    const runtime = new DiagnosticRuntime({ path: ':memory:', now: () => NOW, report: () => { throw new Error('reporter broken') } })
    expect(() => runtime.query((db) => db.query(alice, { limit: 1000 }))).toThrow('page size')
    expect(runtime.health().error).toBeNull()
    const writeCoverage = vi.spyOn(DiagnosticStore.prototype, 'coverage').mockImplementation(() => { throw new Error('coverage only') })
    try {
      runtime.observe('source', 'poise', 'alice')
      runtime.emit({ id: 'coverage-failure', time: null, source: 'poise', operation: 'read', level: 'error', workspace: 'alice', message: 'cause' })
      expect(() => runtime.flush()).not.toThrow()
      expect(runtime.health()).toMatchObject({ error: null, queued: 0, coverageError: 'coverage only', reportError: 'reporter broken' })
      expect(runtime.query((db) => db.query(alice)).total).toBe(1)
    } finally { writeCoverage.mockRestore(); runtime.stop() }
  })

  it.each(['flush', 'deliver'])('retains later-source ingestion across an earlier coverage failure during %s', (method) => {
    const path = join(directory(), 'later-source.db'); let now = NOW
    const runtime = new DiagnosticRuntime({ path, now: () => now, report: () => undefined })
    runtime.observe('earlier', 'poise', 'alice')
    runtime.observe('later', 'caller', 'alice')
    runtime.observe('foreign', 'caller', 'bob')
    const failure = runtime.query((db) => vi.spyOn(db, 'coverage').mockImplementationOnce(() => { throw new Error('earlier coverage failed') }))
    const input = event('committed-later', { source: 'caller' })
    const ingestedAt = new Date(now += 2000).toISOString()
    try {
      if (method === 'deliver') expect(runtime.deliver([input], 'later-cursor', '1', { id: 'later', source: 'caller', workspace: 'alice' })).toBe(0)
      else { runtime.ingest(input); expect(runtime.flush()).toBe(true) }
      expect(runtime.health()).toMatchObject({ error: null, queued: 0, coverageError: 'earlier coverage failed' })
      expect(runtime.health().sources.find((source) => source.id === 'later')?.ingestedAt).toBe(ingestedAt)
      expect(runtime.health().sources.find((source) => source.id === 'foreign')?.ingestedAt).toBeNull()
      const journal = JSON.parse(readFileSync(path + '.coverage.json', 'utf8'))
      expect(journal.sources.find((source: { id: string }) => source.id === 'later')?.ingestedAt).toBe(ingestedAt)
      expect(runtime.query((db) => db.query(alice)).total).toBe(1)
      if (method === 'deliver') expect(runtime.query((db) => db.checkpoint('later-cursor'))).toBe('1')
    } finally { failure.mockRestore(); runtime.stop() }
    const restarted = new DiagnosticRuntime({ path, now: () => now, report: () => undefined })
    try {
      expect(restarted.health().sources.find((source) => source.id === 'later')?.ingestedAt).toBe(ingestedAt)
      now += 2000; restarted.flush()
      expect(restarted.health().coverageError).toBeNull()
      expect(restarted.query((db) => db.readCoverage(alice)).find((source) => source.id === 'later')?.ingestedAt).toBe(ingestedAt)
      expect(restarted.query((db) => db.query(alice)).total).toBe(1)
    } finally { restarted.stop() }
  })

  it('quarantines poison input and preserves the first contradictory queued delivery', () => {
    const runtime = new DiagnosticRuntime({ path: ':memory:', now: () => NOW, policy: { ...DEFAULT_LOG_POLICY, maxBytes: 20_000 }, report: () => undefined })
    const input = { id: 'queued', time: null, source: 'poise', operation: 'read', level: 'error', workspace: 'alice', message: 'original' }
    runtime.emit(input); runtime.emit({ ...input, message: 'contradiction' })
    runtime.emit({ ...input, id: 'oversized', stderr: 'large'.repeat(5000), stack: 'stack'.repeat(3000) })
    runtime.emit({ ...input, id: 'valid-later', message: 'later cause' })
    for (let i = 0; i < 5; i++) runtime.flush()
    const records = runtime.query((db) => db.query(alice)).events
    expect(records.some((record) => record.message === 'later cause')).toBe(true)
    expect(records.some((record) => record.message === 'original')).toBe(true)
    expect(records.some((record) => record.message === 'contradiction')).toBe(false)
    expect(runtime.health()).toMatchObject({ error: null, queued: 0, rejected: 2 })
    runtime.stop()
  })

  it('retains prior drop evidence and closes open outages after an unclean restart', () => {
    const path = join(directory(), 'coverage.db'); let now = NOW
    const runtime = new DiagnosticRuntime({ path, now: () => now, maxQueueEvents: 1, report: () => undefined })
    runtime.observe('kernel', 'kernel', null, 'a'.repeat(2048))
    runtime.emit({ source: 'poise', operation: 'read', level: 'error', message: 'dropped' })
    now += 1000; runtime.flush()
    const restarted = new DiagnosticRuntime({ path, now: () => now, report: () => undefined })
    expect(restarted.health()).toMatchObject({ status: 'partial', dropped: 1, droppedSince: new Date(NOW).toISOString() })
    restarted.observe('kernel', 'kernel', null)
    expect(restarted.health().sources[0].gaps.every((gap) => gap.to !== null)).toBe(true)
    restarted.stop(); runtime.stop()
  })

  it('bounds repeated long source gaps and distinguishes same-clock transitions', () => {
    const runtime = new DiagnosticRuntime({ path: ':memory:', now: () => NOW, report: () => undefined })
    for (let i = 0; i < 40; i++) { runtime.observe('kernel', 'kernel', null, String(i) + '障'.repeat(2048)); runtime.observe('kernel', 'kernel', null) }
    runtime.flush()
    expect(runtime.health()).toMatchObject({ error: null, queued: 0, coverageError: null })
    expect(runtime.query((db) => db.query(operator)).total).toBe(40)
    expect(runtime.query((db) => db.readCoverage(operator))[0].gaps).toHaveLength(32)
    runtime.stop()
  })
  it('bounds buffering, exposes drops through an independent health path and recovers ingestion', () => {
    const root = directory(); const blocked = join(root, 'blocked'); writeFileSync(blocked, 'not a directory')
    let now = NOW
    const runtime = new DiagnosticRuntime({ path: join(blocked, 'history.db'), now: () => now, maxQueueEvents: 2, report: () => undefined })
    runtime.emit({ source: 'poise', operation: 'read', level: 'error', workspace: 'alice', message: 'first' })
    runtime.emit({ source: 'poise', operation: 'read', level: 'error', workspace: 'alice', message: 'second' })
    expect(runtime.emit({ source: 'poise', operation: 'read', level: 'error', workspace: 'alice', message: 'dropped' })).toBeNull()
    expect(() => runtime.flush()).not.toThrow()
    expect(runtime.health()).toMatchObject({ status: 'unavailable', queued: 2, dropped: 1 })
    rmSync(blocked); now += 6000; runtime.flush(); runtime.flush()
    expect(runtime.query((db) => db.query(alice)).total).toBe(2)
    expect(runtime.health().queued).toBe(0)
    runtime.stop()
  })

  it('turns source loss into visible coverage, independent of empty event results', () => {
    const db = store(); db.coverage({ id: 'kernel', source: 'kernel', workspace: null, status: 'unavailable', observedAt: null,
      ingestedAt: null, availableFrom: null, error: 'operator-private-path', gaps: [{ from: new Date(NOW).toISOString(), to: null, reason: 'operator-private-path' }] })
    const page = db.query(alice)
    expect(page.total).toBe(0); expect(page.coverage[0]?.status).toBe('unavailable')
    expect(JSON.stringify(page)).not.toContain('operator-private-path')
    expect(db.query(operator).coverage[0]?.error).toBe('operator-private-path')
  })

  it('retains exact Caller process evidence while omitting expected transitions and product successes', () => {
    const row = { id: 'a'.repeat(32), status: 'failed', repo: 'acme/repo', pr_id: '12', actor: 'bot', correlation_id: 'run',
      completed_at: new Date(NOW).toISOString(), diagnostic: { version: 1, severity: 'error', operation: 'fetch', phase: 'checkout',
        stderr: 'fatal: missing ref', context: { exit_code: 128, cwd: '/tmp/review' } }, error: 'Git fetch exited 128' }
    expect(callerDiagnostic(row, 'alice')).toMatchObject({ operation: 'fetch', stderr: 'fatal: missing ref', exitCode: 128, callId: row.id, correlationId: 'run' })
    expect(callerDiagnostic({ ...row, outcome: 'superseded' }, 'alice')).toBeNull()
    expect(callerDiagnostic({ ...row, error_code: 'stopped' }, 'alice')).toBeNull()
    expect(callerDiagnostic({ ...row, diagnostic: null, outcome: 'changes_requested' }, 'alice')).toMatchObject({ level: 'error', message: row.error })
  })

  it.each(['changes_requested', 'clean', 'approved'])('retains a failed Caller operation despite its %s verdict and missing structured evidence', (outcome) => {
    const row = { id: 'b'.repeat(32), status: 'failed', outcome, diagnostic: null, error: 'Review receipt validation failed after publication', behavior: 'review' }
    const input = callerDiagnostic(row, 'alice')!
    const record = normalize(input, NOW)!
    const db = store(); db.append([record])
    expect(db.lookup(alice, record.id)).toMatchObject({ status: 'found', event: {
      source: 'caller', severity: 'error', message: row.error, callId: row.id, context: { outcome, evidenceIncomplete: true },
    } })
    expect(callerDiagnostic({ ...row, status: 'completed', error: null }, 'alice')).toBeNull()
    expect(callerDiagnostic({ ...row, error_code: 'stopped' }, 'alice')).toBeNull()
    expect(callerDiagnostic({ ...row, outcome: 'superseded' }, 'alice')).toBeNull()
  })
})

describe('reviewed retention and redaction boundaries', () => {
  it('redacts opaque access-token URLs and marks context/resource truncation', () => {
    const record = event('opaque-url', { message: 'https://example.com/?access_token=opaque-value',
      context: { detail: 'x'.repeat(2000) }, resources: { detail: 'x'.repeat(2000) } })
    expect(JSON.stringify(record)).not.toContain('opaque-value'); expect(record.truncated).toBe(true)
    expect(event('malformed-source', { level: 'invalid', source: 'one' }).id).not.toBe(event('malformed-source', { level: 'invalid', source: 'two' }).id)
  })

  it('does not evict valid evidence for an already stale input', () => {
    const db = store({ retentionMs: 1000, maxEvents: 1, maxBytes: 100_000 })
    const good = event('retained-good'); db.append([good])
    db.append([{ ...event('stale-late'), ingestedAt: new Date(NOW - 2000).toISOString() }])
    expect(db.lookup(alice, good.id).status).toBe('found'); expect(db.query(alice).total).toBe(1)
  })

  it('enforces retention on idle and read-only stores without waiting for a writer', () => {
    const path = join(directory(), 'idle.db'); let now = NOW
    const policy = { retentionMs: 1000, maxEvents: 100, maxBytes: 100_000 }
    const record = event('idle'); const writer = new DiagnosticStore(path, policy, () => now)
    writer.append([record]); writer.close(); now += 2000
    const reader = new DiagnosticStore(path, policy, () => now, true); stores.push(reader)
    expect(reader.query(alice).total).toBe(0); expect(reader.lookup(alice, record.id).status).toBe('expired')
    expect(reader.bounds(alice).from).toBeNull(); expect(reader.delivery(alice).events).toHaveLength(0)
    now++
    expect(reader.lookup(alice, record.id).status).toBe('unavailable')
    const idleWriter = new DiagnosticStore(path, policy, () => now); stores.push(idleWriter)
    expect(idleWriter.lookup(alice, record.id).status).toBe('unavailable')
    idleWriter.append([])
    for (const db of [reader, idleWriter]) expect(db.lookup(alice, record.id).status).toBe('unavailable')
  })

  it('does not recursively enqueue rejection warnings under a tiny byte policy', () => {
    const runtime = new DiagnosticRuntime({ path: ':memory:', policy: { retentionMs: 1000, maxBytes: 1, maxEvents: 10 }, now: () => NOW, report: () => undefined })
    runtime.emit({ id: 'too-small', source: 'poise', operation: 'read', level: 'error', message: 'cause' })
    for (let i = 0; i < 10; i++) runtime.flush()
    expect(runtime.health()).toMatchObject({ queued: 0, rejected: 1 }); runtime.stop()
  })
})

describe('material cause identity', () => {
  it('separates causes after display truncation and exact stderr changes', () => {
    const prefix = 'same display '.repeat(200)
    expect(event('one-cause', { message: prefix + 'cause A' }).incidentId).not.toBe(event('other-cause', { message: prefix + 'cause B' }).incidentId)
    expect(event('cause-a', { cause: ['actual cause A'] }).incidentId).not.toBe(event('cause-b', { cause: ['actual cause B'] }).incidentId)
    expect(event('stderr-a', { stderr: 'fatal: missing ref' }).incidentId).not.toBe(event('stderr-b', { stderr: 'fatal: permission denied' }).incidentId)
    expect(event('context-a', { callId: 'attempt-1', release: 'old', context: { attempts: 1 } }).incidentId).toBe(event('context-b', { callId: 'attempt-2', release: 'new', context: { attempts: 2 } }).incidentId)
  })
})


describe('source recovery and unavailable evidence', () => {
  it('keeps redacted coverage identities distinct and partial across admission and restart', async () => {
    const path = join(directory(), 'logging.db')
    const options = { path, now: () => NOW, secrets: ['alice', 'bob'], report: () => undefined }
    const runtime = new DiagnosticRuntime(options)
    runtime.unconfigured('workspace:alice', 'poise', 'alice', 'pending setup')
    runtime.observe('workspace:bob', 'poise', 'bob')
    runtime.partial('workspace:alice', 'poise', 'alice', 'pending backfill')
    expect(runtime.health().sources).toHaveLength(2)
    const source = runtime.health().sources.find((row) => row.workspace === 'alice')!
    expect(source).toMatchObject({ status: 'partial', error: 'pending backfill' })
    expect(source.id).not.toContain('alice')
    expect(runtime.health().sources.find((row) => row.workspace === 'bob')!.id).not.toBe(source.id)
    for (let i = 0; i < 254; i++) runtime.observe('extra-' + i, 'poise', null)
    runtime.partial('workspace:alice', 'poise', 'alice', 'still backfilling')
    expect(runtime.health().rejected).toBe(0)
    runtime.flush()
    expect(runtime.query((db) => db.readCoverage(alice)).find((row) => row.id === source.id)?.status).toBe('partial')
    await runtime.stop()
    const restarted = new DiagnosticRuntime(options)
    restarted.partial('workspace:alice', 'poise', 'alice', 'backfill continues')
    expect(restarted.health().sources).toHaveLength(256)
    expect(restarted.health().sources.find((row) => row.id === source.id)).toMatchObject({ status: 'partial', error: 'backfill continues' })
    await restarted.stop()
  })

  it('redacts configured opaque secrets at native and workspace persistence boundaries', () => {
    vi.stubEnv('POISE_TEST_TOKEN', 'opaque-configured-secret')
    try {
      const db = store()
      const native = normalize(nativeDiagnostic({ PRIORITY: 3, MESSAGE: 'opaque-configured-secret', __REALTIME_TIMESTAMP: '1792317600000000' }, 'docker', 'native-secret', null), NOW)!
      db.append([native, workspaceEnvelope({ ...event('untrusted-envelope'), message: 'opaque-configured-secret' }, 'alice', NOW, [])])
      expect(native.eventTime).toBe(new Date(NOW).toISOString())
      expect(JSON.stringify(db.query(operator))).not.toContain('opaque-configured-secret')
    } finally { vi.unstubAllEnvs() }
  })

  it('retains malformed Caller evidence even when no separate error text exists', () => {
    const input = callerDiagnostic({ id: 'f'.repeat(32), status: 'failed', diagnostic: null, evidence_unavailable: 'Stored evidence is oversized' }, 'alice')
    expect(input).toMatchObject({ source: 'collection', level: 'warning', operation: 'caller.evidence_unavailable', message: 'Stored evidence is oversized' })
  })

  it('keeps recovered historical coverage partial rather than unavailable', () => {
    const runtime = new DiagnosticRuntime({ path: ':memory:', now: () => NOW, report: () => undefined })
    runtime.observe('workspace:alice', 'poise', 'alice', 'source offline')
    runtime.partial('workspace:alice', 'poise', 'alice', 'Source is reachable; historical gap remains')
    const source = runtime.health().sources[0]
    expect(source.status).toBe('partial'); expect(source.gaps.every((gap) => gap.to !== null)).toBe(true)
    runtime.stop()
  })
})


it('redacts opaque Git configuration credentials in bare encoded and decoded evidence', () => {
  const secret = 'opaque-git-password'
  const encoded = Buffer.from('x-access-token:' + secret).toString('base64')
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'Authorization: Basic ' + encoded)
  try {
    const value = event('git-config-secret', { stderr: secret + '\n' + encoded })
    expect(JSON.stringify(value)).not.toContain(secret); expect(JSON.stringify(value)).not.toContain(encoded)
  } finally { vi.unstubAllEnvs() }
})

it('keeps expiry metadata within a tiny byte budget under repeated eviction', () => {
  const db = store({ retentionMs: 30 * 86_400_000, maxBytes: 4096, maxEvents: 1_000_000 })
  for (let i = 0; i < 1000; i++) db.append([event('tiny-budget-' + i)])
  expect(db.query(alice).total).toBeGreaterThan(0)
  expect(db.lookup(alice, event('tiny-budget-0').id).status).toBe('unavailable')
  expect(db.lookup(alice, event('tiny-budget-999').id).status).toBe('found')
})

it('redacts API-key headers absent from configured environment secrets', () => {
  const value = normalize({ source: 'poise', operation: 'provider.failed', level: 'error', message: 'provider rejected',
    stderr: 'X-Api-Key: opaque-header-credential\napi_key=another-opaque-value\nX-Goog-Api-Key: google-opaque-value\nprecise cause' }, NOW, [])!
  for (const valueToHide of ['opaque-header-credential', 'another-opaque-value', 'google-opaque-value']) expect(value.stderr).not.toContain(valueToHide)
  expect(value.stderr).toContain('precise cause')
})

it('retains coverage persistence failure independently in the journal and across restart', () => {
  const path = join(directory(), 'coverage.db'); let now = NOW
  const runtime = new DiagnosticRuntime({ path, now: () => now, report: () => undefined })
  runtime.observe('app', 'poise', 'alice')
  const failure = runtime.query((db) => vi.spyOn(db, 'coverage').mockImplementation(() => { throw new Error('fixture coverage write unavailable') }))
  try {
    now += 2000; runtime.emit({ source: 'poise', operation: 'cause', level: 'error', message: 'retained cause', workspace: 'alice' }); runtime.flush()
    expect(runtime.health().coverageError).toContain('fixture coverage write unavailable')
    expect(JSON.parse(readFileSync(path + '.coverage.json', 'utf8')).coverageError).toContain('fixture coverage write unavailable')
  } finally { failure.mockRestore(); runtime.stop() }
  const restored = new DiagnosticRuntime({ path, now: () => now, report: () => undefined })
  try { expect(restored.health().coverageError).toContain('fixture coverage write unavailable') } finally { restored.stop() }
})

it('redacts standard credential URLs and decorated API headers before retaining terminal evidence', () => {
  const value = normalize({ source: 'poise', operation: 'provider.failed', level: 'error', message: 'network failure',
    stderr: '\x1b[31mX-Api-Key\x1b[0m: decorated-private-key\nsocks5h://user:proxy-private-password@proxy.example\npostgresql://user:database-private-password@db.example' }, NOW, [])!
  for (const secret of ['decorated-private-key', 'proxy-private-password', 'database-private-password']) expect(value.stderr).not.toContain(secret)
  expect(value.stderr).toContain('socks5h://[redacted]@proxy.example')
})

it('extracts command-specific bearer credentials before retaining bare stderr values', () => {
  const secrets = environmentSecrets({ GIT_CONFIG_VALUE_0: 'Authorization: Bearer overlay-private-credential' })
  const event = normalize({ source: 'poise', operation: 'git.fetch', level: 'error', message: 'fetch failed', stderr: 'overlay-private-credential' }, NOW, secrets)!
  expect(event.stderr).toBe('[redacted]')
})

it('redacts quoted credential fields in captured diagnostic text', () => {
  const value = normalize({ source: 'poise', operation: 'provider.failed', level: 'error', message: 'provider rejected',
    stderr: '{"X-Api-Key":"json-private-key"}\npassword=private-password\nclient_secret: private-client-secret' }, NOW, [])!
  for (const secret of ['json-private-key', 'private-password', 'private-client-secret']) expect(value.stderr).not.toContain(secret)
})

it.each(['api key', 'private key', 'id_token_hint', 'idTokenHint', 'bearerToken', 'BearerToken', 'custom_token', 'customToken'])('redacts recursive %s fields before persistence', (key) => {
  const secret = 'opaque-nested-credential-not-configured'
  const value = normalize({ source: 'poise', operation: 'provider.failed', level: 'error', workspace: 'alice', message: 'provider rejected',
    context: { nested: { [key]: secret, inputLimitBytes: 123 } }, resources: { nested: { [key]: secret, freeBytes: 456 } } }, NOW, [])!
  const db = store(); db.append([value])
  const retained = { page: db.query(alice), detail: db.lookup(alice, value.id) }
  expect(JSON.stringify(retained)).not.toContain(secret)
  expect(value.context).toEqual({ nested: { [key]: '[redacted]', inputLimitBytes: 123 } })
  expect(value.resources).toEqual({ nested: { [key]: '[redacted]', freeBytes: 456 } })
})

it.each(['api key', 'API key', 'private key', 'api.key', 'private.key', 'api/key', 'private/key', 'access_token', 'refresh_token', 'id_token', 'id_token_hint', 'idTokenHint', 'IDTokenHint', 'oauthTokenSecret', 'accessToken', 'session-token', 'device_token', 'oauth_token_secret', 'token', 'auth', 'bearer', 'credentials', 'secret', 'private_key', 'DB_PASSWORD', 'databasePassword', 'DB_PASSWD', 'cloud_client_secret', 'credential_value', 'serviceAuthorization', 'sessionCookie', 'DB_API_KEY', 'DB_PRIVATE_KEY', 'custom.password.value', 'database password value'])('redacts opaque %s fields without configured secret values', (key) => {
  const secret = 'opaque-value-not-present-in-environment'
  for (const field of [`{"phase":"auth","${key}":"${secret}"}`, JSON.stringify({ body: JSON.stringify({ [key]: secret }) }), `{'${key}': '${secret}'}`, `${key}=${secret}`, `cause: ${key}=${secret}`]) {
    const value = normalize({ source: 'poise', operation: 'provider.failed', level: 'error', message: 'provider rejected', stderr: field }, NOW, [])!
    const db = store(); db.append([value])
    expect(JSON.stringify(db.query(alice))).not.toContain(secret)
    expect(redact(redact(field))).toBe(redact(field))
  }
})

it.each(['signal', 'errno'] as const)('marks byte truncation of persisted %s evidence', (field) => {
  for (const original of ['x'.repeat(513), '障'.repeat(171)]) {
    const record = event('bounded-' + field, { [field]: original })
    const bounded = record[field]
    if (typeof bounded !== 'string') throw new Error('Expected bounded text evidence')
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(512)
    expect(record[field]).not.toContain('\uFFFD')
    expect(record.truncated).toBe(true)
    const db = store(); db.append([record])
    expect(db.lookup(alice, record.id)).toMatchObject({ status: 'found', event: { [field]: record[field], truncated: true } })
  }
  expect(event('exact-' + field, { [field]: 'x'.repeat(512) }).truncated).toBe(false)
  expect(event('numeric-' + field, { [field]: 9 })).toMatchObject({ [field]: 9, truncated: false })
})

it('redacts long credential field names through the shared structured-key classifier', () => {
  const key = 'x'.repeat(2000) + 'PASSWORD', secret = 'opaque-unconfigured-value'
  const record = event('long-credential-name', { stderr: JSON.stringify({ phase: 'prepare', [key]: secret }), message: 'retained technical cause' })
  const db = store(); db.append([record])
  expect(JSON.stringify(db.lookup(alice, record.id))).not.toContain(secret)
  expect(record.message).toBe('retained technical cause')
})


it('redacts nonempty known secrets of every length without recursively expanding redaction markers', () => {
  const secrets = environmentSecrets({ PASSWORD: 'pw7!', PASSWD: 's2' })
  expect(secrets).toEqual(expect.arrayContaining(['pw7!', 's2']))
  const value = normalize({ source: 'poise', operation: 'provider.failed', level: 'error', message: 'failure pw7!', stderr: 'pw7! s2 X9' }, NOW, [...secrets, 'X9', ''])!
  for (const secret of ['pw7!', 's2', 'X9']) expect(JSON.stringify(value)).not.toContain(secret)
  const short = ['e', 'a', 'c', '.', '[']
  const once = redact('each . [ Authorization: opaque-other-value\n cause', short)
  expect(redact(once, short)).toBe(once)
  expect(once.length).toBeLessThan(200)
  expect(once).not.toContain('opaque-other-value')
})


it('keeps the authoritative owner scope when a short secret overlaps its public handle', () => {
  const event = normalize({ source: 'poise', operation: 'fixture.failure', workspace: 'alice', level: 'error', message: 'bare a' }, NOW, ['a'])!
  expect(event.workspace).toBe('alice')
  expect(event.message).not.toContain('bare a')
  expect(event.message).toContain('[redacted]')
  const store = new DiagnosticStore(':memory:', DEFAULT_LOG_POLICY, () => NOW)
  try {
    store.append([event])
    expect(store.query({ workspace: 'alice', operator: false }).total).toBe(1)
    expect(store.query({ workspace: 'bob', operator: true }).total).toBe(0)
  } finally { store.close() }
})


it('persists maximum Unicode coverage plus later losses across clean restart', async () => {
  const root = directory(); const path = join(root, 'logging.db')
  const options = { path, now: () => NOW, maxQueueEvents: 0, secrets: [], report: () => undefined }
  const runtime = new DiagnosticRuntime(options)
  for (let source = 0; source < 256; source++) {
    for (let gap = 0; gap < 32; gap++) {
      runtime.observe('source-' + source, 'kernel', null, String(gap) + '界'.repeat(2046))
      if (gap < 31) runtime.observe('source-' + source, 'kernel', null)
    }
  }
  runtime.emit({ source: 'poise', operation: 'later-drop', level: 'error', message: 'later lost event' })
  const dropped = runtime.health().dropped
  expect(dropped).toBeGreaterThan(8192)
  runtime.stop()
  const payload = readFileSync(path + '.coverage.json', 'utf8')
  expect(Buffer.byteLength(payload)).toBeGreaterThan(2 * 1024 * 1024)
  expect(Buffer.byteLength(payload)).toBeLessThan(8 * 1024 * 1024)
  expect(runtime.health().journalError).toBeNull()
  const restored = new DiagnosticRuntime(options)
  try {
    expect(restored.health()).toMatchObject({ journalError: null, dropped })
    expect(restored.health().sources).toHaveLength(256)
    for (const source of restored.health().sources) {
      expect(source.gaps).toHaveLength(32)
      expect(source.gaps.at(-1)?.reason).toBe('31' + '界'.repeat(126))
    }
  } finally { restored.stop() }
  vi.stubEnv('POISE_GATEWAY_DATA', root)
  try {
    const lines: string[] = []
    await runOperator(['health'], (line) => { lines.push(line) })
    expect(JSON.parse(lines[0])).toMatchObject({ journalError: null, journal: { dropped } })
  } finally { vi.unstubAllEnvs() }
})


it.each([4096, 8192])('keeps full coverage independent of a %i-byte event budget', (maxBytes) => {
  const path = join(directory(), 'small-budget.db')
  const policy = { ...DEFAULT_LOG_POLICY, maxBytes }
  const first = new DiagnosticStore(path, policy, () => NOW)
  const coverage = { source: 'kernel', workspace: null, status: 'partial' as const,
    observedAt: new Date(NOW).toISOString(), ingestedAt: null, availableFrom: null, error: '界'.repeat(16000),
    gaps: Array.from({ length: 32 }, () => ({ from: new Date(NOW).toISOString(), to: new Date(NOW).toISOString(), reason: '界'.repeat(128) })) }
  try {
    first.append([event('before-full-coverage')])
    for (let i = 0; i < 256; i++) first.coverage({ ...coverage, id: 'source-' + i })
    expect(first.readCoverage(operator)).toHaveLength(256)
    expect(() => first.coverage({ ...coverage, id: 'overflow' })).toThrow('source limit')
    first.coverage({ ...coverage, id: 'source-255', error: 'updated at capacity' })
    expect(first.append([event('after-full-coverage')])).toBe(1)
    expect(first.lookup(alice, event('after-full-coverage').id).status).toBe('found')
  } finally { first.close() }
  const restored = new DiagnosticStore(path, policy, () => NOW)
  try {
    expect(restored.readCoverage(operator)).toHaveLength(256)
    expect(restored.append([event('after-restart-full-coverage')])).toBe(1)
    expect(restored.lookup(alice, event('after-restart-full-coverage').id).status).toBe('found')
  } finally { restored.close() }
})


it.each([...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).filter((value) => !['\t', '\r', '\n'].includes(value)), '\x7f', '\x1b[31m'])('redacts credential names before removed control %j can expose them', (control) => {
  const secret = 'opaque-header-credential-not-configured'
  const record = event('control-' + control.charCodeAt(0) + control.length, {
    stderr: 'X-Api-' + control + 'Key: ' + secret + '\nfatal: exact cause',
    context: { ['pass' + control + 'word']: secret, ['pro' + control + 'mpt']: 'private-prompt', safe: 'actual measurement' },
  })
  const db = store(); db.append([record])
  const retained = JSON.stringify({ page: db.query(alice), detail: db.lookup(alice, record.id) })
  expect(retained).not.toContain(secret)
  expect(retained).not.toContain('private-prompt')
  expect(record.stderr).toContain('fatal: exact cause')
  expect(record.context).toEqual({ password: '[redacted]', safe: 'actual measurement' })
  expect(redact(record.stderr!)).toBe(record.stderr)
})

it('matches normalized configured credentials without creating empty secret patterns', () => {
  expect(redact('opaque\x00credential', ['opaque\x00credential'])).toBe('[redacted]')
  expect(redact('actual cause', ['\x00', '\x1b[31m'])).toBe('actual cause')
})
