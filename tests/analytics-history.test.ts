import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyticsDay, analyticsDailyBounds, analyticsHistoryBounds } from '../src/analytics-day'
import { historyChart, histogram, historySeries, periodLabel, type AnalyticsPeriod } from '../src/analytics-history'
import { setLocalSettings } from '../src/config'

// The past year under the Analytics topline (src/analytics-history.ts).

afterEach(() => { vi.useRealTimers() })

function period(i: number, overrides: Partial<AnalyticsPeriod['pullRequests']> = {}, issues = { opened: 14, closed: 7 }): AnalyticsPeriod {
  const since = new Date(Date.UTC(2026, 0, 5 + 7 * i)).toISOString()
  const until = new Date(Date.UTC(2026, 0, 12 + 7 * i)).toISOString()
  return { since, until, issues, pullRequests: { opened: 14, closedUnmerged: 7, merged: 7, mergedByAgent: 3, firstReview: { count: 7, medianMs: 60_000 }, commentsPerPr: 2, medianCommentsPerPr: 2, lines: { total: 700, median: 100, counted: 7 }, behaviors: { perPr: 1, medianPerPr: 1, approvals: 7, reviews: 0, changesRequested: 0 }, averageTimeToMergeMs: 3_600_000, medianTimeToMergeMs: 3_600_000, ...overrides } }
}

describe('the periods', () => {
  it('ends the year at the selected day, so the latest period is its 7-day baseline', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'))
    setLocalSettings({ org: '', me: '', timezone: 'UTC' })
    const bounds = analyticsHistoryBounds(0)
    expect(bounds).toHaveLength(53)
    expect(bounds[0]).toBe('2025-10-10T00:00:00.000Z')
    expect(bounds.at(-2)).toBe(analyticsDay(0).baselineSince)
    expect(bounds.at(-1)).toBe(analyticsDay(0).since)
    expect(analyticsHistoryBounds(-1).at(-1)).toBe(analyticsDay(-1).since)
  })

  it('counts calendar weeks across daylight saving rather than 168 hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
    setLocalSettings({ org: '', me: '', timezone: 'Europe/Helsinki' })
    const bounds = analyticsHistoryBounds(0, new Date(), 2)
    const daily = analyticsDailyBounds(-7, new Date())
    expect(daily).toHaveLength(8)
    expect(daily.at(-1)).toBe(bounds[1])
    expect(daily.some((edge, i) => i > 0 && Date.parse(edge) - Date.parse(daily[i - 1]) === 25 * 3_600_000)).toBe(true)
    // Summer time ends on 25 October: that week is 169 hours long.
    expect(bounds).toEqual(['2026-10-18T21:00:00.000Z', '2026-10-25T22:00:00.000Z', '2026-11-01T22:00:00.000Z'])
  })

  it.each([
    ['2026-03-31T12:00:00Z', '2026-02-28T22:00:00.000Z', '2026-03-30T21:00:00.000Z', 23],
    ['2026-11-02T12:00:00Z', '2026-10-02T21:00:00.000Z', '2026-11-01T22:00:00.000Z', 25],
  ])('bounds the 30 completed local days across DST at %s, excluding selection', (now, first, last, dstHours) => {
    vi.useFakeTimers()
    const anchor = new Date(now)
    vi.setSystemTime(anchor)
    setLocalSettings({ org: '', me: '', timezone: 'Europe/Helsinki' })
    const bounds = analyticsDailyBounds(0, anchor, 30)
    expect(bounds).toHaveLength(31)
    expect([bounds[0], bounds.at(-1)]).toEqual([first, last])
    expect(bounds.at(-1)).toBe(analyticsDay(0, anchor).since)
    const hours = bounds.slice(1).map((edge, i) => (Date.parse(edge) - Date.parse(bounds[i])) / 3_600_000)
    expect(hours.filter(h => h === dstHours)).toHaveLength(1)
    expect(hours.filter(h => h === 24)).toHaveLength(29)
    expect(analyticsDailyBounds(-1, anchor, 30).at(-1)).toBe(analyticsDay(-1, anchor).since)
    expect(analyticsDailyBounds(0, anchor)).toHaveLength(8)
  })

  it('names a period by its first and last day, with the year once unless it crosses one', () => {
    // ICU data names September "Sep" or "Sept" in en-GB, depending on its version.
    expect(periodLabel({ since: '2026-09-26T00:00:00.000Z', until: '2026-10-03T00:00:00.000Z' }, 'UTC')).toMatch(/^26 Sept? – 2 Oct 2026$/)
    expect(periodLabel({ since: '2025-12-29T00:00:00.000Z', until: '2026-01-05T00:00:00.000Z' }, 'UTC')).toBe('29 Dec 2025 – 4 Jan 2026')
    expect(periodLabel({ since: '2026-10-18T21:00:00.000Z', until: '2026-10-25T22:00:00.000Z' }, 'Europe/Helsinki')).toBe('19 Oct – 25 Oct 2026')
  })
})

describe('the series', () => {
  it('uses each weekly merged cohort for rounds and change-request shares, preserving unknowns', () => {
    const workReview = { reviewed: 7, types: [], rounds: { median: 3, counted: 7, missingReviews: 0, distribution: [] }, changesRequested: { prs: 5, reviews: 10, dismissed: 1, counted: 7 } }
    const all = historySeries({ periods: [period(0, { workReview }), period(1), period(2, { merged: 0, workReview })], errors: [] })
    const rounds = all.find((s) => s.label === 'Review rounds')!
    const changes = all.find((s) => s.label === 'Change-request share')!
    expect(rounds.values.slice(0, 2)).toEqual([3, null])
    expect(changes.values).toEqual([5 / 7 * 100, null, null])
    expect(changes.format(changes.values[0])).toBe('71.4%')
    expect(changes.format(null)).toBe('—')
    const partial = period(3, { workReview: { ...workReview, rounds: { ...workReview.rounds, median: null, counted: 6, missingReviews: 2 } } })
    expect(rounds.detail(partial)).toContain('exact round counts for 6 of 7 merged PRs; 2 reviews lack commit identities')
    expect(rounds.detail(period(1))).toContain('review aggregates unavailable')
    expect(rounds.detail(period(1, { merged: 0 }))).toBe('Period: no merged PRs.')
    expect(changes.detail(partial)).toContain('Stored summaries available for 7 of 7')
  })
  it('gives the five topline figures as daily averages, and time to merge as each period\'s median', () => {
    const all = historySeries({ periods: [period(0), period(1, { merged: 0, lines: { total: null, median: null, counted: 0 }, averageTimeToMergeMs: null, medianTimeToMergeMs: null })], errors: [] })
    expect(all).toHaveLength(15)
    const series = all.slice(0, 5)
    expect(series.map((s) => s.label)).toEqual(['Issues opened', 'Issues closed', 'Pull requests merged', 'Lines changed', 'Time to merge'])
    expect(series.map((s) => s.values)).toEqual([[2, 2], [1, 1], [1, 0], [100, 0], [3_600_000, null]])
    expect(series.map((s) => s.format(s.values[0]))).toEqual(['2.0/day', '1.0/day', '1.0/day', '100/day', '1h'])
    expect(series[4].format(null)).toBe('—')
    expect(series.map((s) => s.detail(period(0)))).toEqual(['14 opened', '7 closed', '7 merged', '700 lines', 'Median of 7 PRs'])
    expect(series[4].detail(period(1, { merged: 0 }))).toBe('No merges')
  })

  it('leaves lines unknown where a period has merged pull requests without a size', () => {
    const series = historySeries({ periods: [period(0, { lines: { total: 500, median: 100, counted: 5 } })], errors: [] })
    expect(series[3].values).toEqual([null])
    expect(series[3].detail(period(0, { lines: { total: 500, median: 100, counted: 5 } }))).toBe('Sizes known for 5 of 7')
  })

  it('uses daily totals for distributions and one daily median/share, retaining zeros and excluding unknown sizes', () => {
    const all = historySeries({ periods: [
      period(0),
      period(1, { merged: 0, mergedByAgent: 0, lines: { total: null, median: null, counted: 0 }, medianTimeToMergeMs: null, medianCommentsPerPr: null, behaviors: { perPr: null, medianPerPr: null, approvals: 0, reviews: 0, changesRequested: 0 } }, { opened: 0, closed: 0 }),
      period(2, { lines: { total: 500, median: 100, counted: 5 } }),
    ], errors: [] }, 1)
    expect(all.map(s => s.values[0])).toEqual([14, 7, 7, 700, 3_600_000, 14, 7, 60_000, 2, null, null, 100, 1, 3_600_000, 3 / 7 * 100])
    const series = (label: string) => all.find(s => s.label === label)!
    expect(series('Pull requests merged').values).toEqual([7, 0, 7])
    expect(series('Pull requests merged').format(7)).toBe('7.0/day')
    expect(series('Lines changed').values).toEqual([700, 0, null])
    expect(series('Median lines').values).toEqual([100, null, null])
    expect(series('Median time').values).toEqual([3_600_000, null, 3_600_000])
    expect(series('Comments').values).toEqual([2, null, 2])
    expect(series('Behaviors').values).toEqual([1, null, 1])
    expect(series('Merged by agent').values).toEqual([3 / 7 * 100, null, 3 / 7 * 100])
    expect(histogram(series('Lines changed').values).reduce((sum, bin) => sum + bin.count, 0)).toBe(2)
  })
})

describe('the chart', () => {
  it('scales to the highest value and breaks the line where a value is unknown', () => {
    const chart = historyChart([0, 2, 4, null, 4, 2, null, 1])
    expect(chart.max).toBe(4)
    expect(chart.points[0]).toEqual({ x: 0, y: 96 })
    expect(chart.points[2]).toEqual({ x: 28.57, y: 4 })
    expect(chart.points[3]).toBeNull()
    expect(chart.line).toBe('M0 96 L14.29 50 L28.57 4 M57.14 4 L71.43 50')
    expect(chart.area).toBe('M0 96 L0 96 L14.29 50 L28.57 4 L28.57 96 Z M57.14 96 L57.14 4 L71.43 50 L71.43 96 Z')
    // A known value between two unknown ones has no line to sit on.
    expect(chart.isolated).toEqual([{ x: 100, y: 73 }])
  })

  it('draws a flat year on the baseline and an empty one not at all', () => {
    expect(historyChart([0, 0, 0]).points.every((p) => p?.y === 96)).toBe(true)
    expect(historyChart([null, null])).toEqual({ line: '', area: '', points: [null, null], isolated: [], max: null })
  })
})

describe('five-bin distributions', () => {
  it('includes both boundaries, excludes unknowns, and preserves every observation', () => {
    const bins = histogram([0, 1, 2, 4, 6, 8, 9, 10, null, NaN, Infinity])
    expect(bins).toEqual([
      { from: 0, until: 2, count: 2 },
      { from: 2, until: 4, count: 1 },
      { from: 4, until: 6, count: 1 },
      { from: 6, until: 8, count: 1 },
      { from: 8, until: 10, count: 3 },
    ])
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(8)
    const empty = histogram([null])
    expect(empty).toHaveLength(5)
    expect(empty.every((bin) => bin.count === 0 && bin.until > bin.from)).toBe(true)
    expect(empty.at(-1)!.until).toBe(1)
    const constant = histogram([4, 4])
    expect(constant.map((bin) => bin.count)).toEqual([2, 0, 0, 0, 0])
    expect(constant.at(-1)!.until).toBe(5)
  })

  it('provides all flow and per-PR series from the same periods', () => {
    const series = historySeries({ periods: [period(0)], errors: [] })
    expect(series.slice(5).map((item) => item.values[0])).toEqual([2, 1, 60_000, 2, null, null, 100, 1, 3_600_000, 3 / 7 * 100])
  })
})
