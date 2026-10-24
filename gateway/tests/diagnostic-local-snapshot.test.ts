import { expect, it } from 'vitest'
import { DiagnosticRuntime } from '../src/diagnostics/runtime.js'

it('reports in-memory collection state for health without reading the store', () => {
  const runtime = new DiagnosticRuntime({ path: ':memory:', maxQueueEvents: 1, report: () => undefined })
  try {
    expect(runtime.localSnapshot()).toEqual({
      sinkError: null, sinkSince: null, lossActive: false,
      queued: 0, queuedBytes: 0, dropped: 0, droppedSince: null,
      coverageError: null, journalError: null, reportError: null, lastSuccessfulWriteAt: null,
    })
    runtime.emit({ id: 'queued-1', level: 'error', source: 'poise', workspace: 'alice', operation: 'fixture', message: 'waiting for flush' })
    const queued = runtime.localSnapshot()
    expect(queued.queued).toBe(1)
    expect(queued.queuedBytes).toBeGreaterThan(0)
    // Overflow drops and marks loss active, all visible without a store read.
    runtime.emit({ id: 'dropped-1', level: 'error', source: 'poise', workspace: 'alice', operation: 'fixture', message: 'overflowed evidence' })
    expect(runtime.localSnapshot()).toMatchObject({ lossActive: true, dropped: 1 })
    expect(runtime.localSnapshot().droppedSince).toEqual(expect.any(String))
    runtime.flush()
    expect(runtime.localSnapshot()).toMatchObject({ lossActive: false, dropped: 1, queued: 0, lastSuccessfulWriteAt: expect.any(String) })
  } finally { runtime.stop() }
})
