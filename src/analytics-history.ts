// The past year of the Analytics topline, one point per 7-day period, from
// /api/analytics/history (server/analytics.ts). Kept free of the DOM so the
// numbers and the chart geometry are testable.

import { formatCount, formatDuration, formatRate } from './analytics-format'

export interface AnalyticsPeriod {
  since: string
  until: string
  issues: { opened: number, closed: number }
  pullRequests: {
    merged: number
    lines: { total: number | null, counted: number }
    averageTimeToMergeMs: number | null
  }
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
  /** A value as the chart, its tooltip and the table say it. */
  format: (value: number | null) => string
  /** What the value is made of in one period. */
  detail: (period: AnalyticsPeriod) => string
}

const PERIOD_DAYS = 7

function perDay(value: number | null): string {
  return value === null ? '—' : `${formatRate(value)}/day`
}

/** The five topline figures over the periods: counts as daily averages, time to merge as each period's mean. */
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
