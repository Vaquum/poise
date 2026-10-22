import { describe, expect, it } from 'vitest'
import { productionSummary, type ProductionRecord } from '../src/production-status'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const NOW = Date.parse('2026-09-18T12:00:00.000Z')
const minutesBefore = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

function update(overrides: Partial<ProductionRecord> = {}): ProductionRecord {
  return {
    status: 'current',
    checkedAt: minutesBefore(1),
    deployedCommit: A,
    remoteCommit: A,
    behind: 0,
    failingSince: null,
    error: null,
    ...overrides,
  }
}

// The Settings line is the one place that says whether a merge reached
// production. It reads as a sentence, names both commits, and turns red only
// when the updater is failing or has stopped.
describe('production summary in Settings', () => {
  it('says nothing without a record, so the group can hide', () => {
    expect(productionSummary(update({ status: 'unknown', checkedAt: null }), NOW, 'UTC')).toBeNull()
  })

  it('shows both commits and when the updater last looked', () => {
    expect(productionSummary(update(), NOW, 'UTC')).toEqual({
      text: 'Deployed aaaaaaa · main aaaaaaa — up to date, checked 1 min ago.',
      level: 'info',
    })
    expect(productionSummary(update({ status: 'updated', checkedAt: minutesBefore(0) }), NOW, 'UTC')?.text)
      .toBe('Deployed aaaaaaa · main aaaaaaa — up to date, checked just now.')
  })

  it('names the failure, how long it has lasted and how far behind main is', () => {
    const failing = update({
      status: 'failed',
      remoteCommit: B,
      behind: 2,
      failingSince: '2026-09-18T11:52:00.000Z',
      error: 'Remote Poise main is not a fast-forward of the deployed commit',
    })
    const summary = productionSummary(failing, NOW, 'UTC')
    expect(summary?.level).toBe('error')
    expect(summary?.text).toBe('Deployed aaaaaaa · main bbbbbbb — 2 commits behind; updater failing since 11:52: Remote Poise main is not a fast-forward of the deployed commit')
    expect(productionSummary(update({ status: 'failed', remoteCommit: null, behind: null }), NOW, 'UTC')?.text)
      .toBe('Deployed aaaaaaa; updater failing: no error recorded')
  })

  it('says why there is no updater in service mode', () => {
    const off = { ...update({ checkedAt: null, deployedCommit: null, remoteCommit: null, behind: null }), status: 'off' as const, reason: 'No production updater runs in service mode.' }
    expect(productionSummary(off, NOW, 'UTC')).toEqual({ text: 'No production updater runs in service mode.', level: 'info' })
  })

  it('treats a record that stopped arriving as the most important fact', () => {
    const summary = productionSummary(update({ checkedAt: minutesBefore(10) }), NOW, 'UTC')
    expect(summary?.level).toBe('error')
    expect(summary?.text).toBe('Deployed aaaaaaa — the updater has not run since 11:50; merges are not reaching production.')
    // On Poise's clock, in Settings' time zone, whatever the browser's language.
    expect(productionSummary(update({ checkedAt: minutesBefore(10) }), NOW, 'Europe/Helsinki')?.text).toContain('has not run since 14:50;')
    // A record from another day says which day.
    expect(productionSummary(update({ checkedAt: '2026-09-17T11:50:00.000Z' }), NOW, 'UTC')?.text).toContain('has not run since 17 Sept 11:50;')
  })
})
