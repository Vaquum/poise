// The past year of the Analytics topline, one point per 7-day period, from
// /api/analytics/history (server/analytics.ts). Kept free of the DOM so the
// numbers and the chart geometry are testable.

import { formatCount, formatDuration, formatRate, formatShortDuration, type AnalyticsReport } from './analytics-format'

export interface AnalyticsPeriod {
  since: string
  until: string
  issues: AnalyticsReport['issues']
  pullRequests: AnalyticsReport['pullRequests']
}

export interface AnalyticsHistory {
  periods: AnalyticsPeriod[]
  errors: Array<{ org: string, error: string }>
}

export interface HistorySeries {
  /** The topline tile it belongs to. */
  label: string
  /** One value per period, oldest first; null where it is unknown. */
  values: Array<number | null>
  /** A value as the chart, its tooltip say it. */
  format: (value: number | null) => string
  /** What the value is made of in one period. */
  detail: (period: AnalyticsPeriod) => string
}

const PERIOD_DAYS = 7

function perDay(value: number | null): string {
  return value === null ? '—' : `${formatRate(value)}/day`
}

/** All metric figures over the periods: counts as daily averages, time to merge as each period's mean. */
export function historySeries(history: AnalyticsHistory): HistorySeries[] {
  const { periods } = history
  return [
    { label: 'Issues opened', values: periods.map((p) => p.issues.opened / PERIOD_DAYS), format: perDay, detail: (p) => `${formatCount(p.issues.opened)} opened` },
    { label: 'Issues closed', values: periods.map((p) => p.issues.closed / PERIOD_DAYS), format: perDay, detail: (p) => `${formatCount(p.issues.closed)} closed` },
    { label: 'Pull requests merged', values: periods.map((p) => p.pullRequests.merged / PERIOD_DAYS), format: perDay, detail: (p) => `${formatCount(p.pullRequests.merged)} merged` },
    {
      label: 'Lines changed',
      // A period whose merged pull requests are not all sized has an unknown total.
      values: periods.map(({ pullRequests: pr }) => pr.merged === 0 ? 0 : pr.lines.counted < pr.merged || pr.lines.total === null ? null : pr.lines.total / PERIOD_DAYS),
      format: (value) => value === null ? '—' : `${formatCount(Math.round(value))}/day`,
      detail: ({ pullRequests: pr }) => pr.lines.counted < pr.merged
        ? `Sizes known for ${formatCount(pr.lines.counted)} of ${formatCount(pr.merged)}`
        : `${formatCount(pr.lines.total ?? 0)} lines`,
    },
    {
      label: 'Time to merge',
      values: periods.map((p) => p.pullRequests.averageTimeToMergeMs),
      format: formatDuration,
      detail: ({ pullRequests: pr }) => pr.merged ? `Mean of ${formatCount(pr.merged)} ${pr.merged === 1 ? 'PR' : 'PRs'}` : 'No merges',
    },
    { label: 'Pull requests opened', values: periods.map((p) => p.pullRequests.opened / PERIOD_DAYS), format: perDay, detail: (p) => `${formatCount(p.pullRequests.opened)} opened` },
    { label: 'Closed without merging', values: periods.map((p) => p.pullRequests.closedUnmerged / PERIOD_DAYS), format: perDay, detail: (p) => `${formatCount(p.pullRequests.closedUnmerged)} closed unmerged` },
    { label: 'Time to first review', values: periods.map((p) => p.pullRequests.firstReview.medianMs), format: formatShortDuration, detail: (p) => `Median of ${formatCount(p.pullRequests.firstReview.count)} first reviews` },
    ...[
      { label: 'Comments', value: (pr: AnalyticsPeriod['pullRequests']) => pr.commentsPerPr, format: formatRate },
      { label: 'Median lines', value: (pr: AnalyticsPeriod['pullRequests']) => pr.lines.counted < pr.merged ? null : pr.lines.median, format: (n: number | null) => n === null ? '—' : formatCount(Math.round(n)) },
      { label: 'Behaviors', value: (pr: AnalyticsPeriod['pullRequests']) => pr.behaviors.perPr, format: formatRate },
      { label: 'Median time', value: (pr: AnalyticsPeriod['pullRequests']) => pr.medianTimeToMergeMs, format: formatDuration },
      { label: 'Merged by agent', value: (pr: AnalyticsPeriod['pullRequests']) => pr.merged && pr.mergedByAgent !== null ? pr.mergedByAgent / pr.merged * 100 : null, format: (n: number | null) => n === null ? '—' : `${formatRate(n)}%` },
    ].map(({ label, value, format }) => ({ label, values: periods.map((p) => value(p.pullRequests)), format, detail: (p: AnalyticsPeriod) => `Over ${formatCount(p.pullRequests.merged)} merged PRs` })),
  ]
}

/** "2 Oct – 8 Oct 2026": the period's first and last calendar day in the timezone. */
export function periodLabel(period: Pick<AnalyticsPeriod, 'since' | 'until'>, timeZone: string): string {
  const day = (at: number, year: boolean) => new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }).format(at)
  const first = Date.parse(period.since)
  // until is the next period's midnight; its last day starts a day earlier.
  const last = Date.parse(period.until) - 1
  const sameYear = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric' })
  return `${day(first, sameYear.format(first) !== sameYear.format(last))} – ${day(last, true)}`
}

export interface HistoryPoint { x: number, y: number }

export interface HistoryChart {
  /** SVG path data in a 100 by 100 box; an unknown value breaks the line. */
  line: string
  area: string
  /** Each value's place in percent of the plot; null where it is unknown. */
  points: Array<HistoryPoint | null>
  /** Points with no known neighbor, which a line cannot show. */
  isolated: HistoryPoint[]
  max: number | null
}

// The plot keeps a little room so a 2px line at either extreme is not cut.
const TOP = 4
export const HISTORY_BASELINE = 96

function round(n: number): number {
  return Math.round(n * 100) / 100
}

export function historyChart(values: Array<number | null>): HistoryChart {
  const known = values.filter((value): value is number => value !== null)
  const max = known.length ? Math.max(...known) : null
  const points = values.map((value, i) => value === null ? null : {
    x: round(values.length > 1 ? i / (values.length - 1) * 100 : 50),
    y: round(max ? HISTORY_BASELINE - value / max * (HISTORY_BASELINE - TOP) : HISTORY_BASELINE),
  })
  const runs: HistoryPoint[][] = []
  points.forEach((point, i) => {
    if (!point) return
    if (i > 0 && points[i - 1]) runs[runs.length - 1].push(point)
    else runs.push([point])
  })
  const path = (run: HistoryPoint[]) => run.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')
  const lines = runs.filter((run) => run.length > 1)
  return {
    line: lines.map(path).join(' '),
    area: lines.map((run) => `M${run[0].x} ${HISTORY_BASELINE} ${path(run).replace(/^M/, 'L')} L${run[run.length - 1].x} ${HISTORY_BASELINE} Z`).join(' '),
    points,
    isolated: runs.filter((run) => run.length === 1).map((run) => run[0]),
    max,
  }
}

export interface HistogramBin { from: number, until: number, count: number }

/** Equal-width bins; unknown observations never enter the distribution. */
export function histogram(values: Array<number | null>, min?: number, max?: number): HistogramBin[] {
  const known = values.filter((n): n is number => n !== null && Number.isFinite(n))
  const low = min ?? (known.length ? Math.min(...known) : 0)
  const high = max ?? (known.length ? Math.max(...known) : 0)
  const width = (high - low || Math.max(1, Math.abs(low) * 0.1)) / 10
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: low + width * i, until: low + width * (i + 1), count: 0 }))
  for (const n of known) bins[Math.max(0, Math.min(9, Math.floor((n - low) / width)))].count++
  return bins
}
