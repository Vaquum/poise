import { describe, expect, it } from 'vitest'
import { analyticsGroups as buildGroups, firstReviewTrend, formatDuration, formatRate, formatShortDuration, mergeTimeTrend, type AnalyticsReport } from '../src/analytics-format'

// What the Analytics view says (src/analytics-format.ts).

function report(pullRequests: Partial<AnalyticsReport['pullRequests']> = {}): AnalyticsReport {
  return {
    window: { since: null, until: null },
    agentAccount: 'robot',
    issues: { opened: 1204, closed: 1 },
    pullRequests: {
      opened: 6,
      closedUnmerged: 1,
      merged: 4,
      mergedByAgent: 3,
      firstReview: { count: 5, medianMs: 95_000 },
      commentsPerPr: 2.25,
      medianCommentsPerPr: pullRequests.commentsPerPr ?? 2.25,
      lines: { total: 12_345, median: 180.5, counted: 4 },
      behaviors: { medianPerPr: 1.5, perPr: 1.5, approvals: 1, reviews: 4, changesRequested: 1 },
      averageTimeToMergeMs: (26 * 60 + 5) * 60_000,
      medianTimeToMergeMs: 5 * 3_600_000,
      ...pullRequests,
    },
    daily: Array.from({ length: 7 }, () => ({ issues: { opened: 172, closed: 1 }, pullRequests: { opened: 3, closedUnmerged: 0, merged: 2, mergedByAgent: 1, firstReview: { count: 1, medianMs: 1 }, commentsPerPr: 1, lines: { total: 350, median: 175, counted: 2 }, behaviors: { perPr: 1, approvals: 1, reviews: 1, changesRequested: 0 }, averageTimeToMergeMs: 1, medianTimeToMergeMs: 1 } })),
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

  it('orders productivity by pull request flow, review and merge times, then issues', () => {
    const groups = analyticsGroups(report())
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ['productivity', 'Productivity'], ['per-merged-pr', 'Per merged pull request'],
    ])
    expect(groups.map((group) => group.tiles.map((t) => [t.label, t.value]))).toEqual([
      [['Pull requests opened', '6'], ['Pull requests merged', '4'], ['Closed without merging', '1'], ['Lines changed', '12,345'], ['Time to first review', '1m 35s'], ['Time to merge', '5h'], ['Issues opened', '1,204'], ['Issues closed', '1']],
      [['Comments', '2.3'], ['Median lines', '181'], ['Behaviors', '1.5'], ['Median time', '5h'], ['Merged by agent', '75%']],
    ])
    expect(tile(groups, 'Merged by agent').note).toBe('3 of 4 by robot')
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
      mergedByAgent: 0,
      commentsPerPr: null,
      medianCommentsPerPr: null,
      lines: { total: null, median: null, counted: 0 },
      behaviors: { perPr: null, approvals: 0, reviews: 0, changesRequested: 0 },
      averageTimeToMergeMs: null,
      medianTimeToMergeMs: null,
    }))
    expect(tile(groups, 'Lines changed').value).toBe('0')
    expect(tile(groups, 'Comments').value).toBe('—')
    expect(tile(groups, 'Behaviors').note).toBeUndefined()
    expect(tile(groups, 'Merged by agent').value).toBe('—')
    expect(tile(groups, 'Merged by agent').trend).toBeUndefined()
    expect(groups[0].note).toBe('')
    expect(groups[1].note).toBe('No pull requests were merged in this range.')
  })
})


describe('merge-time trends', () => {
  it('makes faster, slower and unchanged comparisons explicit', () => {
    expect(mergeTimeTrend(50, 100)).toEqual({ direction: 'good', caption: 'Faster vs 7-day median', text: '↓ 50%', description: '50% faster versus the preceding 7-day median' })
    expect(mergeTimeTrend(150, 100)).toEqual({ direction: 'bad', caption: 'Slower vs 7-day median', text: '↑ 50%', description: '50% slower versus the preceding 7-day median' })
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

it('compares headline event counts against seven-day daily medians, including zero days', () => {
  const day = report({ merged: 4, lines: { total: 700, median: 175, counted: 4 } })
  day.issues = { opened: 7, closed: 0 }
  const week = report({ merged: 14, lines: { total: 2450, median: 175, counted: 14 } })
  week.issues = { opened: 14, closed: 7 }
  week.daily!.forEach((day) => { day.issues = { opened: 2, closed: 1 } })
  const groups = buildGroups(day, week)
  expect(tile(groups, 'Issues opened').trend).toMatchObject({ direction: 'good', text: '↑ 250%' })
  expect(tile(groups, 'Issues closed').trend).toMatchObject({ direction: 'bad', text: '↓ 100%' })
  expect(tile(groups, 'Pull requests merged').comparison).toBe('7-day median: 2.0 / day')
  expect(tile(groups, 'Lines changed').trend).toMatchObject({ direction: 'good', text: '↑ 100%' })
  week.pullRequests.lines.counted = 10
  week.daily![0].pullRequests.lines.counted = 1
  expect(tile(buildGroups(day, week), 'Lines changed').trend).toBeUndefined()
  expect(tile(buildGroups(day, week), 'Lines changed').comparison).toBe('7-day median: — / day')
})


describe('pull request flow', () => {
  it('times first reviews down to the second', () => {
    expect(formatShortDuration(null)).toBe('—')
    expect(formatShortDuration(400)).toBe('<1s')
    expect(formatShortDuration(42_900)).toBe('42s')
    expect(formatShortDuration(3 * 60_000)).toBe('3m')
    expect(formatShortDuration(3 * 60_000 + 12_000)).toBe('3m 12s')
    expect(formatShortDuration(59 * 60_000 + 59_999)).toBe('59m 59s')
    expect(formatShortDuration(65 * 60_000 + 30_000)).toBe('1h 5m')
    expect(formatShortDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h')
  })

  it('compares first reviews with the 7-day median, in seconds when the baseline is zero', () => {
    expect(firstReviewTrend(30_000, 60_000)).toEqual({ direction: 'good', caption: 'Faster vs 7-day median', text: '↓ 50%', description: '50% faster versus the preceding 7-day median' })
    expect(firstReviewTrend(90_000, 60_000)?.caption).toBe('Slower vs 7-day median')
    expect(firstReviewTrend(45_000, 0)?.text).toBe('↑ 45s')
    expect(firstReviewTrend(null, 60_000)).toBeUndefined()
    const groups = buildGroups(report(), report({ firstReview: { count: 20, medianMs: 190_000 } }))
    expect(tile(groups, 'Time to first review').trend).toMatchObject({ direction: 'good', text: '↓ 50%' })
    expect(tile(groups, 'Time to first review').comparison).toBe('7-day median: 3m 10s · 20 first reviews')
  })

  it('counts openings and unmerged closings against the 7-day daily median', () => {
    const groups = buildGroups(report(), report({ opened: 21, closedUnmerged: 0 }))
    expect(tile(groups, 'Pull requests opened')).toMatchObject({ trend: { direction: 'good', text: '↑ 100%' }, comparison: '7-day median: 3.0 / day' })
    expect(tile(groups, 'Closed without merging').trend).toMatchObject({ text: '↑ 1.0' })
  })

  it('says when nothing had its first review, and when no agent account is set', () => {
    const quiet = analyticsGroups(report({ firstReview: { count: 0, medianMs: null } }))
    expect(tile(quiet, 'Time to first review').value).toBe('—')
    expect(quiet[0].note).toBe('No pull request had its first review in this range.')
    const unset = analyticsGroups({ ...report({ mergedByAgent: null }), agentAccount: null })
    expect(tile(unset, 'Merged by agent')).toMatchObject({ value: '—', comparison: 'No agent account in Settings' })
  })
})

it('compares every per-PR metric with the same seven-day population', () => {
  const day = report({ commentsPerPr: 6, medianTimeToMergeMs: 3_600_000 })
  const groups = buildGroups(day, report({ commentsPerPr: 3, medianTimeToMergeMs: 7_200_000 }))
  expect(groups[1].tiles.every((item) => item.trend && item.comparison?.includes('4 PRs'))).toBe(true)
  expect(tile(groups, 'Comments').trend?.text).toBe('↑ 100%')
  expect(tile(groups, 'Median time')).toMatchObject({ trend: { direction: 'good', text: '↓ 50%' }, comparison: '7-day median: 2h · 4 PRs' })
})

it('keeps trends for a readable cache with a sync failure, but not missing scope', () => {
  const stale = report()
  stale.errors = [{ org: 'alpha', error: 'enumeration changed', stale: true }]
  expect(tile(buildGroups(stale, report()), 'Time to merge').trend).toBeDefined()
  stale.errors.push({ org: 'beta', error: 'unreadable' })
  expect(tile(buildGroups(stale, report()), 'Time to merge').trend).toBeUndefined()
})

it('uses the middle daily total, includes zero days, and never substitutes a weekly mean', () => {
  const week = report()
  week.daily!.forEach((day, i) => { day.issues.opened = [0, 0, 0, 2, 4, 10, 700][i] })
  const day = report()
  day.issues.opened = 4
  expect(tile(buildGroups(day, week), 'Issues opened')).toMatchObject({ trend: { text: '↑ 100%' }, comparison: '7-day median: 2.0 / day' })
  delete week.daily
  expect(tile(buildGroups(day, week), 'Issues opened').trend).toBeUndefined()
})

it('compares medians consistently even when unchanged populations are strongly skewed', () => {
  const skewed = report({ commentsPerPr: 34, medianCommentsPerPr: 1, behaviors: { perPr: 34, medianPerPr: 1, approvals: 100, reviews: 1, changesRequested: 1 } })
  const groups = buildGroups(skewed, skewed)
  for (const label of ['Comments', 'Behaviors']) expect(tile(groups, label)).toMatchObject({ value: '1.0', trend: { direction: 'neutral', text: '→ 0%' } })
})
