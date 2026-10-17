import { describe, expect, it } from 'vitest'
import { analyticsGroups as buildGroups, mergeTimeTrend, formatDuration, formatRate, type AnalyticsReport } from '../src/analytics-format'

// What the Analytics view says (src/analytics-format.ts).

function report(pullRequests: Partial<AnalyticsReport['pullRequests']> = {}): AnalyticsReport {
  return {
    window: { since: null, until: null },
    issues: { opened: 1204, closed: 1 },
    pullRequests: {
      merged: 4,
      commentsPerPr: 2.25,
      lines: { total: 12_345, median: 180.5, counted: 4 },
      behaviors: { perPr: 1.5, approvals: 1, reviews: 4, changesRequested: 1 },
      averageTimeToMergeMs: (26 * 60 + 5) * 60_000,
      medianTimeToMergeMs: 5 * 3_600_000,
      ...pullRequests,
    },
    errors: [],
  }
}

function analyticsGroups(value: AnalyticsReport) { return buildGroups(value, report()) }

function tile(groups: ReturnType<typeof analyticsGroups>, label: string) {
  return groups.flatMap((group) => group.tiles).find((t) => t.label === label)!
}

describe('Analytics wording', () => {
  it('shows durations in at most two units', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(30_000)).toBe('<1m')
    expect(formatDuration(42 * 60_000)).toBe('42m')
    expect(formatDuration(5 * 3_600_000)).toBe('5h')
    expect(formatDuration(5 * 3_600_000 + 12 * 60_000)).toBe('5h 12m')
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000 + 59 * 60_000)).toBe('3d 4h')
    expect(formatDuration(2 * 86_400_000)).toBe('2d')
  })

  it('shows averages to one decimal', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(2)).toBe('2.0')
    expect(formatRate(2.25)).toBe('2.3')
    expect(formatRate(1234.5)).toBe('1,234.5')
  })

  it('leads with the productivity topline, then the numbers per merged pull request', () => {
    const groups = analyticsGroups(report())
    expect(groups.map((group) => [group.id, group.label])).toEqual([['productivity', 'Productivity'], ['per-merged-pr', 'Per merged pull request']])
    expect(groups.map((group) => group.tiles.map((t) => [t.label, t.value]))).toEqual([
      [['Issues opened', '1,204'], ['Issues closed', '1'], ['Pull requests merged', '4'], ['Lines changed', '12,345'], ['Time to merge', '1d 2h']],
      [['Comments', '2.3'], ['Median lines', '181'], ['Behaviors', '1.5'], ['Median time', '5h']],
    ])
    expect(groups.every((group) => group.help)).toBe(true)
    expect(tile(groups, 'Behaviors').note).toBe('1 approval · 4 reviews · 1 change request')
    expect(groups.every((group) => !group.note)).toBe(true)
  })

  it('says how many pull requests the line counts come from when some have no size yet', () => {
    const groups = analyticsGroups(report({ merged: 52, lines: { total: 900, median: 20, counted: 40 } }))
    expect(tile(groups, 'Lines changed').value).toBe('900')
    expect(groups[0].note).toBe('From 40 of 52 pull requests')
  })

  it('shows an unknown total, not zero, when no merged pull request has a size yet', () => {
    const groups = analyticsGroups(report({ merged: 1, lines: { total: null, median: null, counted: 0 } }))
    expect(tile(groups, 'Lines changed').value).toBe('—')
    expect(tile(groups, 'Median lines').value).toBe('—')
    expect(groups[0].note).toBe('From 0 of 1 pull request')
  })

  it('says nothing was merged instead of showing averages of nothing', () => {
    const groups = analyticsGroups(report({
      merged: 0,
      commentsPerPr: null,
      lines: { total: null, median: null, counted: 0 },
      behaviors: { perPr: null, approvals: 0, reviews: 0, changesRequested: 0 },
      averageTimeToMergeMs: null,
      medianTimeToMergeMs: null,
    }))
    expect(tile(groups, 'Lines changed').value).toBe('0')
    expect(tile(groups, 'Comments').value).toBe('—')
    expect(tile(groups, 'Behaviors').note).toBeUndefined()
    expect(groups[0].note).toBeUndefined()
    expect(groups[1].note).toBe('No pull requests were merged in this range.')
  })
})


describe('merge-time trends', () => {
  it('makes faster, slower and unchanged comparisons explicit', () => {
    expect(mergeTimeTrend(50, 100)).toEqual({ direction: 'good', caption: 'Faster vs 7-day average', text: '↓ 50%', description: '50% faster versus the preceding 7-day average' })
    expect(mergeTimeTrend(150, 100)).toEqual({ direction: 'bad', caption: 'Slower vs 7-day average', text: '↑ 50%', description: '50% slower versus the preceding 7-day average' })
    expect(mergeTimeTrend(100, 100)?.text).toBe('→ 0%')
    expect(mergeTimeTrend(100, 100)?.direction).toBe('neutral')
  })
  it('does not invent percentages without data or with a zero baseline', () => {
    expect(mergeTimeTrend(null, 100)).toBeUndefined()
    expect(mergeTimeTrend(100, null)).toBeUndefined()
    expect(mergeTimeTrend(3_600_000, 0)?.text).toBe('↑ 1h')
    expect(mergeTimeTrend(0, 0)?.text).toBe('→ 0%')
    expect(mergeTimeTrend(100.001, 100)?.text).toBe('↑ <0.1%')
  })
})

it('withholds comparative claims when an account is missing from either period', () => {
  const partial = report()
  partial.errors = [{ org: 'beta', error: 'offline' }]
  expect(tile(buildGroups(partial, report()), 'Time to merge').trend).toBeUndefined()
  expect(tile(buildGroups(report(), partial), 'Time to merge').trend).toBeUndefined()
})

it('compares headline event counts against seven-day daily averages, including zero days', () => {
  const day = report({ merged: 4, lines: { total: 700, median: 175, counted: 4 } })
  day.issues = { opened: 7, closed: 0 }
  const week = report({ merged: 14, lines: { total: 2450, median: 175, counted: 14 } })
  week.issues = { opened: 14, closed: 7 }
  const groups = buildGroups(day, week)
  expect(tile(groups, 'Issues opened').trend).toMatchObject({ direction: 'good', text: '↑ 250%' })
  expect(tile(groups, 'Issues closed').trend).toMatchObject({ direction: 'bad', text: '↓ 100%' })
  expect(tile(groups, 'Pull requests merged').comparison).toBe('7-day daily average: 2.0')
  expect(tile(groups, 'Lines changed').trend).toMatchObject({ direction: 'good', text: '↑ 100%' })
  week.pullRequests.lines.counted = 10
  expect(tile(buildGroups(day, week), 'Lines changed').trend).toBeUndefined()
  expect(tile(buildGroups(day, week), 'Lines changed').comparison).toBe('7-day daily average: —')
})
