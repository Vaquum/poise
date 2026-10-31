import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyticsDay, analyticsDayProgress } from '../src/analytics-day'
import { setLocalSettings } from '../src/config'

afterEach(() => { vi.useRealTimers() })

describe('analytics calendar days', () => {
  it('labels today, yesterday, and older dates independently of browser timezone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T23:30:00Z'))
    setLocalSettings({ org: '', me: '', timezone: 'Asia/Kolkata' })
    expect(analyticsDay(0)).toEqual({ label: 'Today', isToday: true, since: '2026-01-01T18:30:00.000Z', until: '2026-01-02T18:30:00.000Z', baselineSince: '2025-12-25T18:30:00.000Z' })
    expect(analyticsDay(-1).label).toBe('Yesterday')
    expect(analyticsDay(-2).label).toBe('31 Dec 2025')
  })
  it('uses seven calendar days across daylight saving rather than 168 hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'))
    setLocalSettings({ org: '', me: '', timezone: 'Europe/Helsinki' })
    expect(analyticsDay(-1)).toEqual({ label: 'Yesterday', isToday: false, since: '2026-10-24T21:00:00.000Z', until: '2026-10-25T22:00:00.000Z', baselineSince: '2026-10-17T21:00:00.000Z' })
    expect(analyticsDay(0).baselineSince).toBe('2026-10-18T21:00:00.000Z')
  })
})

describe('elapsed analytics day', () => {
  it.each([
    ['2026-10-19T00:00:00Z', 0],
    ['2026-10-19T10:00:00Z', 10 / 24],
    ['2026-10-20T00:00:00Z', 1],
    ['2026-10-18T23:00:00Z', 0],
    ['2026-10-20T01:00:00Z', 1],
  ] as const)('clamps the selected day at %s to %s', (now, expected) => {
    expect(analyticsDayProgress('2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z', Date.parse(now))).toBe(expected)
  })

  it('uses the current instant and configured timezone bounds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T04:30:00Z'))
    setLocalSettings({ org: '', me: '', timezone: 'Asia/Kolkata' })
    const day = analyticsDay(0)
    expect(day.since).toBe('2026-01-01T18:30:00.000Z')
    expect(analyticsDayProgress(day.since, day.until)).toBe(10 / 24)
  })

  it.each([
    ['2026-03-29T09:30:00Z', 23],
    ['2026-10-25T09:30:00Z', 25],
  ] as const)('uses the actual %s calendar day rather than assuming 24 hours', (now, hours) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    setLocalSettings({ org: '', me: '', timezone: 'Europe/Helsinki' })
    const day = analyticsDay(0)
    expect((Date.parse(day.until) - Date.parse(day.since)) / 3_600_000).toBe(hours)
    expect(analyticsDayProgress(day.since, day.until)).toBe(0.5)
  })
})

it.each([
  ['Africa/Cairo', '2026-04-24T12:00:00Z', '2026-04-23T22:00:00.000Z', '24 Apr 2026', 23],
  ['Asia/Beirut', '2026-03-29T12:00:00Z', '2026-03-28T22:00:00.000Z', '29 Mar 2026', 23],
  ['America/Havana', '2026-11-01T12:00:00Z', '2026-11-01T04:00:00.000Z', '1 Nov 2026', 25],
] as const)('uses the first valid instant when %s skips or repeats midnight', (timezone, now, expected, label, hours) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  setLocalSettings({ org: '', me: '', timezone })
  const day = analyticsDay(0)
  expect(day.since).toBe(expected)
  expect((Date.parse(day.until) - Date.parse(day.since)) / 3_600_000).toBe(hours)
  expect(analyticsDayProgress(day.since, day.until, Date.parse(day.since) + 10 * 3_600_000)).toBe(10 / hours)
  expect(analyticsDay(-1).until).toBe(expected)
  vi.setSystemTime(new Date(Date.parse(now) + 2 * 86_400_000))
  expect(analyticsDay(-2).label).toBe(label)
})

it('keeps an anchored date stable when the current date advances', () => {
  vi.useFakeTimers()
  const anchor = new Date('2026-10-09T23:59:00Z')
  vi.setSystemTime(anchor)
  setLocalSettings({ org: '', me: '', timezone: 'UTC' })
  expect(analyticsDay(-2, anchor).label).toBe('7 Oct 2026')
  vi.setSystemTime(new Date('2026-10-10T00:01:00Z'))
  expect(analyticsDay(-3, anchor).since).toBe('2026-10-06T00:00:00.000Z')
  expect(analyticsDay(0, anchor).label).toBe('Yesterday')
  expect(analyticsDay(1, anchor).isToday).toBe(true)
})
