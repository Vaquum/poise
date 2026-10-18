import Database from 'better-sqlite3'
import { DiagnosticRuntime } from '../src/diagnostics/runtime.js'
import { diagnosticConfig } from '../src/diagnostics/config.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { supervisorDiagnostic } from '../src/diagnostics/sources.js'
import { normalize } from '../src/diagnostics/contract.js'
import { dockerLifecycle, dockerLines, gatewayDiagnostic } from '../src/diagnostics/collectors.js'
import { DiagnosticStore } from '../src/diagnostics/store.js'
import { createLogger } from '../src/log.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const access = { workspace: 'alice', operator: false }
const input = { id: 'source-test', level: 'error', source: 'poise', operation: 'read', workspace: 'alice', message: 'cause' }

describe('owned source boundaries', () => {
  it('decodes split Docker frame payloads without turning a stack into occurrences', () => {
    const line = '2026-10-18T10:00:00Z ' + JSON.stringify({ poiseDiagnostic: { message: 'cause\nstack one\nstack two' } }) + '\n'
    const payload = Buffer.from(line)
    const frame = (part: Buffer, stream = 2) => { const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(part.length, 4); return Buffer.concat([header, part]) }
    expect(dockerLines(Buffer.concat([frame(payload.subarray(0, 20)), frame(payload.subarray(20))]))).toEqual([line.trimEnd()])
    expect(dockerLines(Buffer.concat([frame(Buffer.from('unrelated unfinished stdout'), 1), frame(payload, 2)]))).toEqual(['unrelated unfinished stdout', line.trimEnd()])
    expect(() => dockerLines(Buffer.from('incomplete'))).toThrow('frame')
    expect(() => dockerLines(frame(Buffer.from('x'.repeat(64 * 1024 + 1))))).toThrow('bound')
  })

  it('uses native OOM/exit/health meaning and excludes unrelated business containers', () => {
    const base = { Type: 'container', time: 1792317600, Actor: { ID: 'container-1', Attributes: { 'poise.managed': 'true', 'poise.workspace': 'alice' } } }
    expect(dockerLifecycle({ ...base, Action: 'oom' })).toMatchObject({ level: 'critical', workspace: 'alice', visibility: 'infrastructure' })
    expect(dockerLifecycle({ ...base, Action: 'die' })).toBeNull()
    expect(dockerLifecycle({ ...base, Action: 'die', Actor: { ...base.Actor, Attributes: { ...base.Actor.Attributes, exitCode: '128' } } })).toMatchObject({ level: 'error', exitCode: 128 })
    expect(dockerLifecycle({ ...base, Action: 'health_status: unhealthy' })).toMatchObject({ level: 'warning' })
    expect(dockerLifecycle({ ...base, Action: 'oom', Actor: { ID: 'other', Attributes: { 'com.docker.compose.project': 'business' } } })).toBeNull()
  })

  it('redacts gateway output before Docker persistence and projects only technical shared facts', () => {
    const lines: string[] = []; const records: unknown[] = []
    const logger = createLogger((line) => lines.push(line), (level, operation, fields) => records.push(normalize(gatewayDiagnostic(level, operation, fields))))
    logger.error('proxy.failed', { handle: 'bob', error: 'ECONNRESET in /home/poise/private/repository', method: 'GET',
      route: '/api/chat', Authorization: 'opaque-secret', prompt: 'private-prompt', repository: 'private/repo', callId: 'private-call' })
    const output = JSON.stringify({ lines, records })
    for (const value of ['opaque-secret', 'private-prompt']) expect(output).not.toContain(value)
    expect(JSON.stringify(records)).not.toContain('private/repo'); expect(JSON.stringify(records)).not.toContain('private-call')
    expect(records[0]).toMatchObject({ workspace: 'bob', visibility: 'infrastructure', context: { method: 'GET', route: '/api/chat' } })
  })

  it('commits delivery checkpoints atomically, preserves stable replay and scopes delivery cursors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'poise-delivery-')); directories.push(directory)
    const path = join(directory, 'history.db'); const store = new DiagnosticStore(path)
    try {
      const event = normalize(input)!
      store.commitDelivery([event], 'workspace:alice', 'source-cursor')
      const first = store.delivery(access)
      expect(first.events.map((record) => record.id)).toEqual([event.id])
      expect(store.delivery(access, first.cursor).events).toHaveLength(0)
      expect(() => store.delivery({ workspace: 'bob', operator: false }, first.cursor)).toThrow('authorization')
      expect(() => store.commitDelivery([{ ...event, message: 'contradictory' }], 'workspace:alice', 'bad-cursor')).toThrow('Conflicting')
      expect(store.checkpoint('workspace:alice')).toBe('source-cursor')
    } finally { store.close() }
  })
})


describe('operator diagnostic budgets', () => {
  it('applies explicit retention/storage/buffer limits and rejects contradictory configuration', () => {
    expect(diagnosticConfig({ POISE_LOG_RETENTION_DAYS: '7', POISE_LOG_MAX_BYTES: '1048576', POISE_LOG_MAX_EVENTS: '500', POISE_LOG_QUEUE_EVENTS: '20', POISE_LOG_QUEUE_BYTES: '65536' })).toEqual({
      policy: { retentionMs: 7 * 86_400_000, maxBytes: 1048576, maxEvents: 500 }, maxQueueEvents: 20, maxQueueBytes: 65536,
    })
    for (const key of ['POISE_LOG_RETENTION_DAYS', 'POISE_LOG_MAX_BYTES', 'POISE_LOG_MAX_EVENTS', 'POISE_LOG_QUEUE_EVENTS', 'POISE_LOG_QUEUE_BYTES']) {
      expect(() => diagnosticConfig({ [key]: '-1' })).toThrow(key)
      expect(() => diagnosticConfig({ [key]: 'unexpected' })).toThrow(key)
    }
  })
})


it('preserves a full gateway cause beyond stdout formatting limits with truthful truncation', () => {
  const lines: string[] = []; const events: Array<ReturnType<typeof normalize>> = []
  const logger = createLogger((line) => lines.push(line), (level, operation, fields) => events.push(normalize(gatewayDiagnostic(level, operation, fields))))
  logger.error('proxy.failed', { handle: 'alice', error: 'x'.repeat(1400) + ' exact-tail-cause' })
  expect(JSON.parse(lines[0]).truncated).toBe(true)
  expect(events[0]?.message).toContain('exact-tail-cause')
  expect(events[0]?.truncated).toBe(false)
})

it('rolls back all native batches when checkpointing fails and permits fresh enrichment on replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-atomic-native-')); directories.push(directory)
  const path = join(directory, 'history.db'); const store = new DiagnosticStore(path)
  const control = new Database(path)
  const records = Array.from({ length: 101 }, (_, i) => normalize({ ...input, id: 'native-' + i, resources: { measuredAt: 'first-inspection' } })!)
  try {
    control.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON log_meta WHEN NEW.key='checkpoint:docker-events' BEGIN SELECT RAISE(FAIL,'checkpoint unavailable'); END")
    expect(() => store.commitDelivery(records, 'docker-events', 'next')).toThrow('checkpoint unavailable')
    expect(store.query(access).total).toBe(0); expect(store.checkpoint('docker-events')).toBeNull()
    control.exec('DROP TRIGGER fail_checkpoint')
    expect(store.commitDelivery(records.map((event) => ({ ...event, resources: { measuredAt: 'second-inspection' } })), 'docker-events', 'next')).toBe(101)
    expect(store.checkpoint('docker-events')).toBe('next')
  } finally { control.close(); store.close() }
})

it('quarantines evidence above the configured storage budget without pinning the source cursor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-source-budget-')); directories.push(directory)
  const runtime = new DiagnosticRuntime({ path: join(directory, 'history.db'), policy: { maxBytes: 4096, maxEvents: 100, retentionMs: 86400000 }, report: () => undefined })
  try {
    const large = normalize({ ...input, id: 'too-large', stderr: 'x'.repeat(16000) })!
    expect(runtime.deliver([large], 'workspace:alice', 'after-large')).toBeGreaterThan(0)
    expect(runtime.query((db) => db.checkpoint('workspace:alice'))).toBe('after-large')
    const later = normalize({ ...input, id: 'later' })!
    runtime.deliver([later], 'workspace:alice', 'after-later')
    expect(runtime.query((db) => db.lookup(access, later.id)).status).toBe('found')
    expect(runtime.health()).toMatchObject({ status: 'partial', rejected: expect.any(Number) })
  } finally { runtime.stop() }
})

it('captures only owned fatal entrypoint checks and explicit supervisor collection failures', () => {
  const missing = supervisorDiagnostic('poise-runtime: missing environment: POISE_MODE POISE_WORKSPACE_HANDLE.', 'entrypoint', 'alice')
  expect(normalize(missing!)).toMatchObject({ source: 'poise', severity: 'error', workspace: 'alice', visibility: 'workspace', component: 'workspace-supervisor' })
  expect(supervisorDiagnostic('poise-runtime: installing missing provider CLIs in the background', 'routine', 'alice')).toBeNull()
  expect(supervisorDiagnostic('arbitrary private user content', 'private', 'alice')).toBeNull()
  expect(supervisorDiagnostic('poise-runtime: diagnostic helper unavailable.', 'gap', 'alice')).toMatchObject({ level: 'warning', source: 'collection' })
  const invalid = supervisorDiagnostic('poise-runtime: POISE_SKIP_CLI_BOOTSTRAP must be 0 or 1, not "private-config-value".', 'invalid', 'alice')
  expect(JSON.stringify(invalid)).not.toContain('private-config-value')
})


it('bounds removed-container checkpoints across churn without evicting retained evidence or live cursors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-checkpoint-churn-')); directories.push(directory)
  const path = join(directory, 'history.db'); const store = new DiagnosticStore(path, { maxBytes: 4096, maxEvents: 100, retentionMs: 86400000 })
  const control = new Database(path)
  try {
    const event = normalize(input)!
    store.commitDelivery([event], 'docker-log:live', 'live-cursor')
    store.commitDelivery([], 'host-journal', 'host-cursor')
    for (let i = 0; i < 1000; i++) {
      store.reconcileDockerCheckpoints(['live', 'replacement-' + i])
      store.commitDelivery([], 'docker-log:replacement-' + i, String(i))
    }
    expect(control.prepare("SELECT COUNT(*) AS count FROM log_meta WHERE key GLOB 'checkpoint:docker-log:*'").get()).toEqual({ count: 2 })
    expect(store.checkpoint('docker-log:replacement-0')).toBeNull()
    expect(store.checkpoint('docker-log:live')).toBe('live-cursor')
    expect(store.checkpoint('host-journal')).toBe('host-cursor')
    store.reconcileDockerCheckpoints([])
    expect(store.checkpoint('docker-log:live')).toBeNull()
    expect(store.lookup(access, event.id).status).toBe('found')
  } finally { control.close(); store.close() }
})


it.each(['same-batch', 'across-batches', 'invalid-first', 'persisted'])('quarantines only the offending record for %s identity conflicts', (kind) => {
  const runtime = new DiagnosticRuntime({ path: ':memory:', report: () => undefined })
  const first = normalize({ ...input, id: 'original', message: 'first valid cause' })!
  const conflicting = { ...first, message: 'contradictory cause' }
  const later = normalize({ ...input, id: 'later-valid', message: 'later valid cause' })!
  const filler = kind === 'across-batches' ? Array.from({ length: 99 }, (_, i) => normalize({ ...input, id: 'filler-' + i })!) : []
  if (kind === 'persisted') runtime.deliver([first], 'source', 'before')
  const batch = kind === 'invalid-first' ? [{ ...first, incidentId: 'invalid' }, first, later] : [first, ...filler, conflicting, later]
  try {
    expect(runtime.deliver(batch, 'source', 'after')).toBe(1)
    expect(runtime.query((db) => db.checkpoint('source'))).toBe('after')
    expect(runtime.query((db) => db.lookup(access, first.id))).toMatchObject({ status: 'found', event: { message: 'first valid cause' } })
    expect(runtime.query((db) => db.lookup(access, later.id)).status).toBe('found')
    const page = runtime.query((db) => db.query(access, { limit: 100 }))
    expect(page.total).toBe(3 + filler.length)
    expect(runtime.query((db) => db.query(access, { source: 'collection' })).events[0]).toMatchObject({ operation: 'record.rejected' })
  } finally { runtime.stop() }
})

it('keeps conflict quarantine, source timestamps and checkpoint failure atomic', () => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-delivery-conflict-')); directories.push(directory)
  const path = join(directory, 'history.db'); const runtime = new DiagnosticRuntime({ path, report: () => undefined })
  runtime.query(() => undefined)
  const control = new Database(path)
  const event = normalize({ ...input, id: 'first' })!
  const source = { id: 'workspace:alice', source: 'poise', workspace: 'alice' }
  try {
    control.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON log_meta WHEN NEW.key='checkpoint:workspace:alice' BEGIN SELECT RAISE(FAIL,'checkpoint unavailable'); END")
    expect(() => runtime.deliver([event, { ...event, message: 'conflicting' }], source.id, 'after', source)).toThrow('checkpoint unavailable')
    expect(runtime.query((db) => db.query(access)).total).toBe(0)
    expect(runtime.query((db) => db.checkpoint(source.id))).toBeNull()
    expect(runtime.health().sources).toHaveLength(0)
    control.exec('DROP TRIGGER fail_checkpoint')
    expect(runtime.deliver([event, { ...event, message: 'conflicting' }], source.id, 'after', source)).toBe(1)
    expect(runtime.query((db) => db.lookup(access, event.id)).status).toBe('found')
    expect(runtime.health().sources[0].ingestedAt).not.toBeNull()
  } finally { control.close(); runtime.stop() }
})

it('records ingestion for the exact delivered boundary before its first observation and across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-delivery-coverage-')); directories.push(directory)
  const path = join(directory, 'history.db'); const now = Date.now()
  const runtime = new DiagnosticRuntime({ path, now: () => now, report: () => undefined })
  const source = { id: 'workspace-stream:alice', source: 'poise', workspace: 'alice' }
  const event = normalize({ ...input, id: 'delivered-caller', source: 'caller' }, now)!
  try {
    runtime.observe('other-boundary', 'caller', 'alice')
    runtime.deliver([event], 'docker-log:container', 'after', source)
    runtime.observe(source.id, source.source, source.workspace)
    runtime.observe('empty', 'kernel', null)
    runtime.deliver([], 'empty', 'observed', { id: 'empty', source: 'kernel', workspace: null })
    expect(runtime.health().sources.find((row) => row.id === source.id)?.ingestedAt).toBe(new Date(now).toISOString())
    expect(runtime.health().sources.find((row) => row.id === 'empty')?.ingestedAt).toBeNull()
    expect(runtime.health().sources.find((row) => row.id === 'other-boundary')?.ingestedAt).toBeNull()
    expect(runtime.query((db) => db.readCoverage(access)).find((row) => row.id === source.id)?.ingestedAt).toBe(new Date(now).toISOString())
  } finally { runtime.stop() }
  const restored = new DiagnosticRuntime({ path, now: () => now, report: () => undefined })
  try { expect(restored.health().sources.find((row) => row.id === source.id)?.ingestedAt).toBe(new Date(now).toISOString()) } finally { restored.stop() }
})


it('retains delivered evidence and checkpoints when coverage persistence fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-delivery-coverage-failure-')); directories.push(directory)
  const path = join(directory, 'history.db'); const runtime = new DiagnosticRuntime({ path, report: () => undefined })
  runtime.query(() => undefined)
  const control = new Database(path)
  const event = normalize({ ...input, id: 'coverage-failed' })!
  try {
    control.exec("CREATE TRIGGER fail_coverage BEFORE INSERT ON log_coverage BEGIN SELECT RAISE(FAIL,'coverage unavailable'); END")
    expect(runtime.deliver([event], 'workspace:alice', 'after', { id: 'workspace:alice', source: 'poise', workspace: 'alice' })).toBe(0)
    expect(runtime.query((db) => db.checkpoint('workspace:alice'))).toBe('after')
    expect(runtime.query((db) => db.lookup(access, event.id)).status).toBe('found')
    expect(runtime.health()).toMatchObject({ error: null, coverageError: expect.stringContaining('coverage unavailable') })
    expect(runtime.health().sources[0].ingestedAt).toEqual(expect.any(String))
  } finally { control.close(); runtime.stop() }
})
