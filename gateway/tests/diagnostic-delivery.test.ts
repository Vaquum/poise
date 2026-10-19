import { expect, it } from 'vitest'
import { normalize } from '../src/diagnostics/contract.js'
import { DiagnosticRuntime } from '../src/diagnostics/runtime.js'
import { diagnosticDeliveryPage } from '../src/diagnostics/workspace-delivery.js'

it('bounds the real maintenance projection with large events and escaped Unicode coverage while preserving limited history', () => {
  let now = Date.now()
  const runtime = new DiagnosticRuntime({ path: ':memory:', workspace: 'alice', now: () => now, report: () => undefined })
  try {
    for (let index = 0; index < 16; index++) {
      for (let gap = 0; gap < 3; gap++) {
        runtime.observe('source-' + index, '\ud800'.repeat(128), 'alice', '\ud800'.repeat(128))
        now++; runtime.observe('source-' + index, '\ud800'.repeat(128), 'alice'); now++
      }
    }
    while (runtime.health().queued) runtime.flush()
    let before = diagnosticDeliveryPage(runtime, 'alice', null)
    while (before.hasMore) before = diagnosticDeliveryPage(runtime, 'alice', before.cursor)
    for (let index = 0; index < 3; index++) {
      const event = normalize({ id: 'large-wire-' + index, level: 'error', source: 'poise', workspace: 'alice', operation: 'fixture', message: 'bounded native cause',
        stderr: 'retained stderr\n'.repeat(1800), stack: 'retained stack\n'.repeat(1200),
        context: Object.fromEntries(Array.from({ length: 64 }, (_, key) => ['field-' + key, 'x'.repeat(1024)])),
      }, now)!
      runtime.ingest(event)
    }
    while (runtime.health().queued) runtime.flush()
    const page = diagnosticDeliveryPage(runtime, 'alice', before.cursor)
    expect(page.events).toHaveLength(3)
    expect(page.coverage.sources).toHaveLength(16)
    expect(page.coverage.sources.every((source) => source.gaps.length === 2 && source.historyIncomplete)).toBe(true)
    expect(page.coverage.historyIncomplete).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024)
  } finally { runtime.stop() }
})
