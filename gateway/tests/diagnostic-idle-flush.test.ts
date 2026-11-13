import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DiagnosticRuntime } from '../src/diagnostics/runtime.js'

// An idle runtime (nothing queued) used to rewrite its store and journal every
// second. It now does so every 15 s, inside the 60 s after which readers call
// the journal stale, and at once when the journal's state changes or an event
// arrives.
it('writes the journal and store while idle only as often as staleness needs, and at once on change', () => {
  const root = mkdtempSync(join(tmpdir(), 'poise-idle-flush-')), path = join(root, 'logging.db')
  let now = Date.parse('2026-11-13T12:00:00.000Z')
  const runtime = new DiagnosticRuntime({ path, now: () => now, report: () => undefined })
  const written = () => JSON.parse(readFileSync(path + '.coverage.json', 'utf8')).writtenAt as string
  try {
    runtime.observe('application', 'poise', 'alice')
    expect(runtime.flush()).toBe(false)
    const first = written()

    // Idle and unchanged: a second's flush does nothing.
    now += 1_000
    runtime.flush()
    expect(written()).toBe(first)
    now += 13_000
    runtime.flush()
    expect(written()).toBe(first)

    // Past the idle bound, the journal's heartbeat is renewed.
    now += 1_000
    runtime.flush()
    expect(Date.parse(written())).toBe(now)
    const renewed = written()

    // A changed source is written at the next flush, idle or not.
    now += 1_000
    runtime.observe('application', 'poise', 'alice', 'source unreachable')
    runtime.flush()
    expect(Date.parse(written())).toBe(now)
    expect(written()).not.toBe(renewed)

    // An event is delivered at once.
    now += 1_000
    runtime.emit({ id: 'idle-event', level: 'error', source: 'poise', workspace: 'alice', operation: 'fixture', message: 'delivered' })
    expect(runtime.flush()).toBe(true)
    expect(runtime.query((db) => db.query({ workspace: 'alice', operator: false })).events.some((event) => event.message === 'delivered')).toBe(true)
  } finally { runtime.stop(); rmSync(root, { recursive: true, force: true }) }
})

it('writes a source change to the store at the next flush even when the change already wrote the journal', () => {
  const root = mkdtempSync(join(tmpdir(), 'poise-idle-coverage-')), path = join(root, 'logging.db')
  let now = Date.parse('2026-11-13T12:00:00.000Z')
  const runtime = new DiagnosticRuntime({ path, now: () => now, report: () => undefined })
  const stored = () => runtime.query((db) => db.readCoverage({ workspace: 'alice', operator: true })).find((source) => source.id === 'application')
  try {
    runtime.observe('application', 'poise', 'alice')
    runtime.flush()
    expect(stored()).toMatchObject({ status: 'connected' })

    // observe() writes the journal itself; the store's copy waits for a flush.
    now += 2_000
    runtime.observe('application', 'poise', 'alice', 'source unreachable')
    now += 1_000
    runtime.flush()
    expect(stored()).toMatchObject({ status: 'unavailable' })
    // Recovery reads as partial (the outage is a gap in its history), in the store as in memory.
    now += 2_000
    runtime.observe('application', 'poise', 'alice')
    now += 1_000
    runtime.flush()
    const live = runtime.health().sources.find((source) => source.id === 'application')
    expect(live?.status).toBe('partial')
    expect(stored()).toMatchObject({ status: live?.status, error: live?.error ?? null })
  } finally { runtime.stop(); rmSync(root, { recursive: true, force: true }) }
})
