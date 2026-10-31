import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DiagnosticRuntime } from '../src/diagnostics/runtime.js'
import { executeLoggingRead } from '../src/diagnostics/query-worker.js'
import { DEFAULT_LOG_POLICY } from '../src/diagnostics/store.js'

it('reports continuing overflow immediately through real runtime and browser health, then preserves recovered loss', () => {
  const root = mkdtempSync(join(tmpdir(), 'poise-active-loss-')), path = join(root, 'logging.db'), now = Date.now()
  const runtime = new DiagnosticRuntime({ path, maxQueueEvents: 1, now: () => now, report: () => undefined })
  const read = () => JSON.parse(executeLoggingRead({ path, policy: DEFAULT_LOG_POLICY, now, access: { workspace: 'alice', operator: false }, operation: 'health', filter: {} }).body)
  try {
    runtime.observe('application', 'poise', 'alice'); runtime.flush()
    for (let pass = 0; pass < 3; pass++) {
      runtime.emit({ id: 'accepted-' + pass, level: 'error', source: 'poise', workspace: 'alice', operation: 'fixture', message: 'retained evidence' })
      runtime.emit({ id: 'dropped-' + pass, level: 'error', source: 'poise', workspace: 'alice', operation: 'fixture', message: 'overflowed evidence' })
      expect(runtime.health()).toMatchObject({ currentStatus: 'partial', lossActive: true, dropped: pass + 1 })
      expect(read()).toMatchObject({ collection: { currentStatus: 'partial', lossActive: true, lossObserved: true }, query: { status: 'connected' } })
      runtime.flush()
      expect(runtime.health()).toMatchObject({ currentStatus: 'connected', lossActive: false, dropped: pass + 1 })
      expect(read()).toMatchObject({ collection: { currentStatus: 'connected', lossActive: false, lossObserved: true } })
    }
  } finally { runtime.stop(); rmSync(root, { recursive: true, force: true }) }
})

it('keeps rejected records degraded until a successful recovery boundary without erasing their cumulative count', () => {
  const runtime = new DiagnosticRuntime({ path: ':memory:', report: () => undefined })
  const input = { id: 'same-native-position', level: 'error', source: 'poise', workspace: 'alice', operation: 'fixture', message: 'original immutable cause' }
  try {
    runtime.observe('application', 'poise', 'alice'); runtime.flush()
    runtime.emit(input); runtime.emit({ ...input, message: 'contradictory replacement' })
    expect(runtime.health()).toMatchObject({ currentStatus: 'partial', lossActive: true, rejected: 1 })
    runtime.flush()
    expect(runtime.health()).toMatchObject({ currentStatus: 'connected', lossActive: false, rejected: 1 })
    expect(runtime.query((db) => db.query({ workspace: 'alice', operator: false })).events.some((event) => event.message === input.message)).toBe(true)
  } finally { runtime.stop() }
})

it('excludes explicitly unsupported local sources while a newly observed required source still degrades health', () => {
  const runtime = new DiagnosticRuntime({ path: ':memory:', report: () => undefined })
  try {
    runtime.unconfigured('kernel', 'kernel', 'alice', 'Kernel collection is not configured in local mode')
    runtime.observe('application', 'poise', 'alice'); runtime.flush()
    expect(runtime.health().currentStatus).toBe('connected')
    expect(runtime.health().sources.find((source) => source.id === 'kernel')?.optional).toBe(true)
    runtime.observe('kernel', 'kernel', 'alice', 'Actual configured journal read failed')
    expect(runtime.health().currentStatus).toBe('partial')
    expect(runtime.health().sources.find((source) => source.id === 'kernel')?.optional).toBe(false)
  } finally { runtime.stop() }
})
