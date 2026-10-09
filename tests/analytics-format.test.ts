import { describe, expect, it } from 'vitest'
import { analyticsGroups, formatDuration, formatRate, type AnalyticsReport } from '../src/analytics-format'

// What the Analytics panel says (src/analytics-format.ts).

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
      ...pullRequests,
    },
    errors: [],
  }
}

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

  it('lays out every number the panel promises', () => {
    const groups = analyticsGroups(report())
    expect(groups.map((group) => group.label)).toEqual(['Issues', 'Pull requests', 'Per merged pull request'])
    expect(groups.map((group) => group.tiles.map((t) => [t.label, t.value]))).toEqual([
      [['Opened', '1,204'], ['Closed', '1']],
      [['Merged', '4'], ['Lines changed', '12,345'], ['Time to merge', '1d 2h']],
      [['Comments', '2.3'], ['Median lines', '181'], ['Behaviors', '1.5']],
    ])
    expect(tile(groups, 'Behaviors').note).toBe('1 approval · 4 reviews · 1 change request')
    expect(groups.every((group) => !group.note)).toBe(true)
  })

  it('says how many pull requests the line counts come from when some have no size yet', () => {
    const groups = analyticsGroups(report({ merged: 52, lines: { total: 900, median: 20, counted: 40 } }))
    expect(tile(groups, 'Lines changed').value).toBe('900')
    expect(groups[1].note).toBe('From 40 of 52 pull requests; the rest get their size at the datastore\'s next full sync.')
  })

  it('shows an unknown total, not zero, when no merged pull request has a size yet', () => {
    const groups = analyticsGroups(report({ merged: 1, lines: { total: null, median: null, counted: 0 } }))
    expect(tile(groups, 'Lines changed').value).toBe('—')
    expect(tile(groups, 'Median lines').value).toBe('—')
    expect(groups[1].note).toBe('From 0 of 1 pull request; the rest get their size at the datastore\'s next full sync.')
  })

  it('says nothing was merged instead of showing averages of nothing', () => {
    const groups = analyticsGroups(report({
      merged: 0,
      commentsPerPr: null,
      lines: { total: null, median: null, counted: 0 },
      behaviors: { perPr: null, approvals: 0, reviews: 0, changesRequested: 0 },
      averageTimeToMergeMs: null,
    }))
    expect(tile(groups, 'Lines changed').value).toBe('0')
    expect(tile(groups, 'Comments').value).toBe('—')
    expect(tile(groups, 'Behaviors').note).toBeUndefined()
    expect(groups[1].note).toBeUndefined()
    expect(groups[2].note).toBe('No pull requests were merged in this range.')
  })
})
