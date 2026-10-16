import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyticsDay } from '../src/analytics-day'
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

it.each([
  ['Africa/Cairo', '2026-04-24T12:00:00Z', '2026-04-23T22:00:00.000Z', '24 Apr 2026'],
  ['Asia/Beirut', '2026-03-29T12:00:00Z', '2026-03-28T22:00:00.000Z', '29 Mar 2026'],
  ['America/Havana', '2026-11-01T12:00:00Z', '2026-11-01T04:00:00.000Z', '1 Nov 2026'],
])('uses the first valid instant when %s skips or repeats midnight', (timezone, now, expected, label) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  setLocalSettings({ org: '', me: '', timezone })
  expect(analyticsDay(0).since).toBe(expected)
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
