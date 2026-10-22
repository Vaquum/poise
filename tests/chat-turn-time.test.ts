// When a Chat turn ended, as its meta row shows it (src/chat-turn-time.ts),
// and where the transcript model takes that time from. Only this test imports
// the transcript; the time module itself has no runtime imports.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StopReason } from '../server/chat/protocol'
import { turnTime } from '../src/chat-turn-time'
import { clockDay, shortTime } from '../src/clock'
import { applyEvent, createModel } from '../src/views/chat-transcript'

const NOW = Date.parse('2026-10-21T17:00:00Z')

describe("a turn's end time", () => {
  it("shows the time alone for a turn that ended today, in the person's time zone", () => {
    expect(turnTime('2026-10-21T16:38:12.000Z', 'end_turn', 'Europe/Helsinki', NOW)).toEqual({ text: '19:38', label: 'Finished Wednesday 21 October 2026 at 19:38:12 EEST' })
    expect(turnTime('2026-10-21T16:38:12.000Z', 'end_turn', 'UTC', NOW)).toEqual({ text: '16:38', label: 'Finished Wednesday 21 October 2026 at 16:38:12 UTC' })
  })

  it('adds the date for an earlier day and the year for an earlier year', () => {
    expect(turnTime('2026-10-20T14:05:12.000Z', 'end_turn', 'Europe/Helsinki', NOW).text).toBe('20 Oct 17:05')
    expect(turnTime('2025-12-31T21:05:00.000Z', 'end_turn', 'Europe/Helsinki', NOW)).toEqual({ text: '31 Dec 2025 23:05', label: 'Finished Wednesday 31 December 2025 at 23:05:00 EET' })
  })

  it("uses en-GB month names, so September is 'Sept'", () => {
    expect(turnTime('2026-09-03T21:30:00.000Z', 'end_turn', 'Europe/Helsinki', NOW).text).toBe('4 Sept 00:30')
  })

  it("gives the notification rail the same short time as Chat's turns", () => {
    for (const [at, text] of [['2026-10-21T16:38:12.000Z', '19:38'], ['2026-10-20T14:05:12.000Z', '20 Oct 17:05'], ['2025-12-31T21:05:00.000Z', '31 Dec 2025 23:05']]) {
      expect(shortTime(at, 'Europe/Helsinki', NOW)).toBe(text)
      expect(turnTime(at, 'end_turn', 'Europe/Helsinki', NOW).text).toBe(text)
    }
    expect(() => shortTime('not a time', 'UTC', NOW)).toThrow(RangeError)
  })

  it('compares calendar days, so a time ahead of the clock is labelled the same way', () => {
    expect(turnTime('2026-10-21T19:00:00.000Z', 'end_turn', 'Europe/Helsinki', NOW).text).toBe('22:00')
    expect(turnTime('2026-10-22T09:00:00.000Z', 'end_turn', 'Europe/Helsinki', NOW).text).toBe('22 Oct 12:00')
  })

  it("decides today by the time zone's calendar, on a 24-hour clock", () => {
    const morning = Date.parse('2026-10-21T08:00:00Z')
    expect(turnTime('2026-10-20T21:30:00.000Z', 'end_turn', 'Europe/Helsinki', morning).text).toBe('00:30')
    expect(turnTime('2026-10-20T21:30:00.000Z', 'end_turn', 'UTC', morning).text).toBe('20 Oct 21:30')
  })

  it('names how the turn ended before its full time', () => {
    const label = (stop: StopReason) => turnTime('2026-10-21T16:20:00.000Z', stop, 'Europe/Helsinki', NOW).label
    expect(label('cancelled')).toBe('Stopped Wednesday 21 October 2026 at 19:20:00 EEST')
    expect(label('max_tokens')).toBe('Hit the output limit Wednesday 21 October 2026 at 19:20:00 EEST')
    expect(label('refusal')).toBe('Refused Wednesday 21 October 2026 at 19:20:00 EEST')
    expect(label('error')).toBe('Failed Wednesday 21 October 2026 at 19:20:00 EEST')
    // Restart recovery writes this end when Poise next starts, so the words claim only the record.
    expect(label('interrupted')).toBe('Recorded as interrupted Wednesday 21 October 2026 at 19:20:00 EEST')
  })

  it("names the zone's calendar day, which changes at the zone's midnight", () => {
    expect(clockDay('Europe/Helsinki', Date.parse('2026-10-21T20:59:59Z'))).toBe('Europe/Helsinki 2026-10-21')
    expect(clockDay('Europe/Helsinki', Date.parse('2026-10-21T21:00:00Z'))).toBe('Europe/Helsinki 2026-10-22')
    expect(clockDay('UTC', Date.parse('2026-10-21T21:00:00Z'))).toBe('UTC 2026-10-21')
  })

  it('throws for a value that is not a time, and for a time zone Intl does not know', () => {
    for (const at of ['not a time', '', '2026-13-99']) expect(() => turnTime(at, 'end_turn', 'UTC', NOW), at).toThrow(RangeError)
    expect(() => turnTime('2026-10-21T16:38:12.000Z', 'end_turn', 'Mars/Olympus', NOW)).toThrow(RangeError)
  })
})

describe('where the end time comes from', () => {
  afterEach(() => { vi.useRealTimers() })

  it("records the turn.finished envelope's time, whatever the clock reads", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const model = createModel()
    applyEvent(model, { seq: 1, sessionId: 's', at: '2026-10-21T16:37:30.000Z', event: { type: 'turn.started', turnId: 't', prompt: { text: 'go', attachments: [], mentions: [] } } })
    applyEvent(model, { seq: 2, sessionId: 's', at: '2026-10-21T16:38:12.000Z', event: { type: 'turn.finished', turnId: 't', stopReason: 'end_turn', durationMs: 42_800 } })
    expect(model.turns.get('t')!.finished).toEqual({ stopReason: 'end_turn', durationMs: 42_800, at: '2026-10-21T16:38:12.000Z' })
  })
})
