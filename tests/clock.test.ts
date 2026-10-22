// Poise's clock (src/clock.ts): how a time reads wherever Poise shows one, on
// a 24-hour en-GB clock in a given time zone, with the date only when it is
// not the day of `now`.

import { describe, expect, it } from 'vitest'
import { clockDay, fullTime, listTime, logTime, shortTime } from '../src/clock'

const NOW = Date.parse('2026-10-21T17:00:00Z')
const ZONE = 'Europe/Helsinki'
const TODAY = '2026-10-21T16:38:12.000Z'
const EARLIER_DAY = '2026-10-20T14:05:12.000Z'
const EARLIER_YEAR = '2025-12-31T21:05:12.000Z'

describe("Poise's clock", () => {
  it('gives the short time alone today, with the date on another day and the year in another year', () => {
    expect([TODAY, EARLIER_DAY, EARLIER_YEAR].map((at) => shortTime(at, ZONE, NOW))).toEqual(['19:38', '20 Oct 17:05', '31 Dec 2025 23:05'])
  })

  it('adds seconds for activity lines', () => {
    expect([TODAY, EARLIER_DAY, EARLIER_YEAR].map((at) => logTime(at, ZONE, NOW))).toEqual(['19:38:12', '20 Oct 17:05:12', '31 Dec 2025 23:05:12'])
  })

  it('gives the date alone on another day, for compact lists', () => {
    expect([TODAY, EARLIER_DAY, EARLIER_YEAR].map((at) => listTime(at, ZONE, NOW))).toEqual(['19:38', '20 Oct', '31 Dec 2025'])
  })

  it('reads a time held as epoch milliseconds the same way', () => {
    expect(shortTime(Date.parse(TODAY), ZONE, NOW)).toBe('19:38')
  })

  // en-GB's own month name: en-US would write "Sep 5".
  it('writes September as en-GB does', () => {
    const at = '2026-09-04T21:30:00.000Z'
    expect([shortTime(at, ZONE, NOW), logTime(at, ZONE, NOW), listTime(at, ZONE, NOW)]).toEqual(['5 Sept 00:30', '5 Sept 00:30:00', '5 Sept'])
  })

  it('writes midnight as 00, never 24', () => {
    const at = '2026-10-21T00:00:00.000Z'
    expect([shortTime(at, 'UTC', NOW), logTime(at, 'UTC', NOW), fullTime(at, 'UTC')]).toEqual(['00:00', '00:00:00', 'Wednesday 21 October 2026 at 00:00:00 UTC'])
  })

  // 22:30 UTC on the 20th is 01:30 on the 21st in Helsinki: today there.
  it("decides today in the time zone's own calendar", () => {
    const at = '2026-10-20T22:30:00.000Z'
    expect([shortTime(at, ZONE, NOW), logTime(at, ZONE, NOW), listTime(at, ZONE, NOW)]).toEqual(['01:30', '01:30:00', '01:30'])
  })

  it('dates a time on a later day, as a retry after midnight', () => {
    expect(shortTime('2026-10-22T05:00:00.000Z', ZONE, NOW)).toBe('22 Oct 08:00')
  })

  it('writes the whole moment out in words', () => {
    expect(fullTime(TODAY, ZONE)).toBe('Wednesday 21 October 2026 at 19:38:12 EEST')
  })

  it("names the zone's calendar day, which changes at the zone's midnight", () => {
    expect(clockDay(ZONE, Date.parse('2026-10-21T20:59:59Z'))).toBe('Europe/Helsinki 2026-10-21')
    expect(clockDay(ZONE, Date.parse('2026-10-21T21:00:00Z'))).toBe('Europe/Helsinki 2026-10-22')
    expect(clockDay('UTC', Date.parse('2026-10-21T21:00:00Z'))).toBe('UTC 2026-10-21')
  })

  it('throws for a value that is not a time, and for a time zone Intl does not know', () => {
    const reads = [
      (at: string, zone: string) => shortTime(at, zone, NOW), (at: string, zone: string) => logTime(at, zone, NOW),
      (at: string, zone: string) => listTime(at, zone, NOW), (at: string, zone: string) => fullTime(at, zone),
    ]
    for (const read of reads) {
      expect(() => read('not a time', 'UTC')).toThrow(RangeError)
      expect(() => read(TODAY, 'Mars/Olympus')).toThrow(RangeError)
    }
    expect(() => clockDay('Mars/Olympus', NOW)).toThrow(RangeError)
  })

  it('throws for a now that is not a time', () => {
    expect(() => shortTime(TODAY, ZONE, NaN)).toThrow(RangeError)
    expect(() => logTime(TODAY, ZONE, NaN)).toThrow(RangeError)
    expect(() => listTime(TODAY, ZONE, NaN)).toThrow(RangeError)
    expect(() => clockDay(ZONE, NaN)).toThrow(RangeError)
  })
})
