import { describe, expect, it } from 'vitest'
import { DailyModelRefresh, nextDailyRefresh, type RefreshClock } from '../server/service/model-refresh'

const iso = (at: number) => new Date(at).toISOString()
const t = (value: string) => Date.parse(value)

class FakeClock implements RefreshClock {
  private timers: Array<{ id: number, at: number, callback: () => void }> = []
  private ids = 0
  constructor(public time: number) {}
  now(): number { return this.time }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.ids
    this.timers.push({ id, at: this.time + delayMs, callback })
    return id
  }
  clearTimeout(timer: unknown): void { this.timers = this.timers.filter((entry) => entry.id !== timer) }
  get pending(): number { return this.timers.length }
  /** Fire every timer due up to `target` in order, letting each refresh settle. */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      const due = this.timers.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((entry) => entry !== due)
      this.time = due.at
      due.callback()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    this.time = target
  }
}

function harness(start: string, zone: string, options: { paused?: () => boolean, refresh?: () => Promise<Record<string, unknown>> } = {}) {
  const clock = new FakeClock(t(start))
  const runs: string[] = []
  const logs: string[] = []
  const errors: string[] = []
  const state = { zone }
  const schedule = new DailyModelRefresh({
    timeZone: () => state.zone,
    refresh: options.refresh ?? (async () => { runs.push(iso(clock.now())); return { families: {} } }),
    paused: options.paused ?? (() => false),
    clock,
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  })
  return { clock, runs, logs, errors, state, schedule }
}

describe('the next 07:00 in a timezone', () => {
  it('follows the zone\'s own clock across daylight saving changes', () => {
    // Helsinki moves to EEST at 01:00Z on 29 March and back to EET at 01:00Z on 25 October 2026.
    expect(iso(nextDailyRefresh(t('2026-03-28T06:00:00Z'), 'Europe/Helsinki'))).toBe('2026-03-29T04:00:00.000Z')
    expect(iso(nextDailyRefresh(t('2026-03-28T04:59:00Z'), 'Europe/Helsinki'))).toBe('2026-03-28T05:00:00.000Z')
    expect(iso(nextDailyRefresh(t('2026-10-24T05:00:00Z'), 'Europe/Helsinki'))).toBe('2026-10-25T05:00:00.000Z')
    // New York moves to EDT at 07:00Z on 8 March and back to EST at 06:00Z on 1 November 2026.
    expect(iso(nextDailyRefresh(t('2026-03-07T13:00:00Z'), 'America/New_York'))).toBe('2026-03-08T11:00:00.000Z')
    expect(iso(nextDailyRefresh(t('2026-10-31T12:00:00Z'), 'America/New_York'))).toBe('2026-11-01T12:00:00.000Z')
  })

  it('is strictly after the given instant', () => {
    expect(iso(nextDailyRefresh(t('2026-06-01T07:00:00Z'), 'UTC'))).toBe('2026-06-02T07:00:00.000Z')
    expect(iso(nextDailyRefresh(t('2026-06-01T06:59:59.999Z'), 'UTC'))).toBe('2026-06-01T07:00:00.000Z')
  })

  it('handles zones far from UTC and with half-hour offsets', () => {
    expect(iso(nextDailyRefresh(t('2026-06-01T00:00:00Z'), 'Asia/Kolkata'))).toBe('2026-06-01T01:30:00.000Z')
    expect(iso(nextDailyRefresh(t('2026-06-01T00:00:00Z'), 'Pacific/Kiritimati'))).toBe('2026-06-01T17:00:00.000Z')
    expect(iso(nextDailyRefresh(t('2026-06-01T00:00:00Z'), 'Pacific/Pago_Pago'))).toBe('2026-06-01T18:00:00.000Z')
  })
})

describe('the daily model check in service mode', () => {
  it('runs once a day at 07:00 local time through a daylight saving change', async () => {
    const { clock, runs, schedule } = harness('2026-03-27T12:00:00Z', 'Europe/Helsinki')
    schedule.start()
    await clock.advanceTo(t('2026-03-31T00:00:00Z'))
    expect(runs).toEqual(['2026-03-28T05:00:00.000Z', '2026-03-29T04:00:00.000Z', '2026-03-30T04:00:00.000Z'])
    schedule.stop()
  })

  it('moves to the new timezone as soon as Settings changes it', async () => {
    const { clock, runs, state, schedule, logs } = harness('2026-06-10T05:00:00Z', 'Europe/Helsinki')
    schedule.start()
    expect(iso(schedule.next!)).toBe('2026-06-11T04:00:00.000Z')
    await clock.advanceTo(t('2026-06-10T06:00:00Z'))
    state.zone = 'America/New_York'
    await clock.advanceTo(t('2026-06-10T06:01:00Z'))
    expect(iso(schedule.next!)).toBe('2026-06-10T11:00:00.000Z')
    expect(logs).toContain('[models] daily model check scheduled for 2026-06-10T11:00:00.000Z (07:00 America/New_York)')
    await clock.advanceTo(t('2026-06-11T12:00:00Z'))
    expect(runs).toEqual(['2026-06-10T11:00:00.000Z', '2026-06-11T11:00:00.000Z'])
    schedule.stop()
  })

  it('falls back to UTC only when no timezone is set, and says so once', async () => {
    const { clock, runs, logs, state, schedule } = harness('2026-06-10T00:00:00Z', '')
    schedule.start()
    await clock.advanceTo(t('2026-06-11T08:00:00Z'))
    expect(runs).toEqual(['2026-06-10T07:00:00.000Z', '2026-06-11T07:00:00.000Z'])
    expect(logs.filter((line) => line.includes('no timezone is set'))).toEqual(['[models] no timezone is set in Settings; the daily model check runs at 07:00 UTC'])
    state.zone = 'Asia/Tokyo'
    await clock.advanceTo(t('2026-06-12T00:00:00Z'))
    expect(runs.at(-1)).toBe('2026-06-11T22:00:00.000Z')
    schedule.stop()
  })

  it('does not replace a timezone that is not one with UTC', async () => {
    const { clock, runs, errors, state, schedule } = harness('2026-06-10T00:00:00Z', 'Mars/Olympus_Mons')
    schedule.start()
    await clock.advanceTo(t('2026-06-12T00:00:00Z'))
    expect(runs).toEqual([])
    expect(schedule.next).toBeNull()
    expect(errors).toEqual(['[models] the timezone "Mars/Olympus_Mons" in Settings is not an IANA timezone; the daily model check waits until it is corrected'])
    state.zone = 'UTC'
    await clock.advanceTo(t('2026-06-12T08:00:00Z'))
    expect(runs).toEqual(['2026-06-12T07:00:00.000Z'])
    schedule.stop()
  })

  it('skips a run while Poise is draining and keeps the schedule', async () => {
    const draining = { on: true }
    const { clock, runs, logs, schedule } = harness('2026-06-10T00:00:00Z', 'UTC', { paused: () => draining.on })
    schedule.start()
    await clock.advanceTo(t('2026-06-10T08:00:00Z'))
    expect(runs).toEqual([])
    expect(logs).toContain('[models] daily model check skipped: Poise is draining')
    draining.on = false
    await clock.advanceTo(t('2026-06-11T08:00:00Z'))
    expect(runs).toEqual(['2026-06-11T07:00:00.000Z'])
    schedule.stop()
  })

  it('reports a failed check and runs again the next day', async () => {
    let calls = 0
    const { clock, errors, logs, schedule } = harness('2026-06-10T00:00:00Z', 'UTC', {
      refresh: async () => {
        calls += 1
        if (calls === 1) throw new Error('agent-interface --refresh-models timed out')
        return calls === 2 ? { families: {}, error: 'Caller returned an invalid model discovery report' } : { families: {} }
      },
    })
    schedule.start()
    await clock.advanceTo(t('2026-06-12T08:00:00Z'))
    expect(calls).toBe(3)
    expect(errors).toEqual([
      '[models] daily model check failed: agent-interface --refresh-models timed out',
      '[models] daily model check failed: Caller returned an invalid model discovery report',
    ])
    expect(logs).toContain('[models] daily model check finished')
    schedule.stop()
  })

  it('never overlaps a check that is still running', async () => {
    let finish!: () => void
    let calls = 0
    const { clock, logs, schedule } = harness('2026-06-10T00:00:00Z', 'UTC', {
      refresh: () => { calls += 1; return new Promise((resolve) => { finish = () => resolve({ families: {} }) }) },
    })
    schedule.start()
    await clock.advanceTo(t('2026-06-11T08:00:00Z'))
    expect(calls).toBe(1)
    expect(logs).toContain('[models] daily model check skipped: the previous one is still running')
    finish()
    await clock.advanceTo(t('2026-06-12T08:00:00Z'))
    expect(calls).toBe(2)
    schedule.stop()
  })

  it('stops for good', async () => {
    const { clock, runs, schedule } = harness('2026-06-10T00:00:00Z', 'UTC')
    schedule.start()
    schedule.stop()
    expect(clock.pending).toBe(0)
    await clock.advanceTo(t('2026-06-12T00:00:00Z'))
    expect(runs).toEqual([])
  })
})
