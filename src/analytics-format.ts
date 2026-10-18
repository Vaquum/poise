// What the Analytics view says about a report from /api/analytics
// (server/analytics.ts). Kept free of the DOM so the wording is testable.

export interface AnalyticsReport {
  window: { since: string | null, until: string | null }
  agentAccount: string | null
  issues: { opened: number, closed: number }
  pullRequests: {
    opened: number
    closedUnmerged: number
    merged: number
    mergedByAgent: number | null
    firstReview: { count: number, medianMs: number | null }
    commentsPerPr: number | null
    lines: { total: number | null, median: number | null, counted: number }
    behaviors: { perPr: number | null, approvals: number, reviews: number, changesRequested: number }
    averageTimeToMergeMs: number | null
    medianTimeToMergeMs: number | null
  }
  errors: Array<{ org: string, error: string }>
}

export interface AnalyticsTile {
  label: string
  value: string
  /** A line under the value that says what it is made of. */
  note?: string
  trend?: { direction: 'good' | 'bad' | 'neutral', text: string, description: string, caption: string }
  comparison?: string
}

export interface AnalyticsGroup {
  /** Names the section on the page; the productivity topline comes first. */
  id: 'productivity' | 'per-merged-pr'
  label: string
  /** What the section counts, shown over its heading. */
  help: string
  tiles: AnalyticsTile[]
  note?: string
}

const UNKNOWN = '—'

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** An average per pull request, to one decimal. */
export function formatRate(n: number | null): string {
  return n === null ? UNKNOWN : n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** Two units at most: "3d 4h", "5h 12m", "42m", "<1m". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return UNKNOWN
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`
  const rest = minutes % 60
  if (hours) return rest ? `${hours}h ${rest}m` : `${hours}h`
  return `${minutes}m`
}

/** Down to the second, two units at most: "45s", "3m 12s", then as formatDuration. */
export function formatShortDuration(ms: number | null): string {
  if (ms === null) return UNKNOWN
  const seconds = Math.floor(ms / 1000)
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return seconds % 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds / 60}m`
  return formatDuration(ms)
}

function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

/** A duration trend names faster or slower against the 7-day average or median. */
function metricTrend(current: number | null, baseline: number | null, duration?: { format: (ms: number) => string, basis: 'average' | 'median' }, basis = duration?.basis ?? 'average', daily = true): AnalyticsTile['trend'] {
  if (current === null || baseline === null) return undefined
  const delta = current - baseline
  const direction = delta === 0 ? 'neutral' : (duration ? delta < 0 : delta > 0) ? 'good' : 'bad'
  const percent = baseline === 0 ? 0 : Math.abs(delta / baseline * 100)
  const change = baseline === 0
    ? duration ? duration.format(Math.abs(delta)) : formatRate(Math.abs(delta))
    : percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
  const movement = duration ? delta < 0 ? 'faster' : 'slower' : delta < 0 ? 'below' : 'above'
  const description = delta === 0 ? 'Unchanged' : `${change} ${movement}`
  const caption = delta === 0 ? `Same as 7-day ${basis}` : duration
    ? `${delta < 0 ? 'Faster' : 'Slower'} vs 7-day ${basis}`
    : `${delta < 0 ? 'Below' : 'Above'} 7-day ${daily ? 'daily ' : ''}${basis}`
  return { direction, caption, text: `${delta < 0 ? '↓' : delta > 0 ? '↑' : '→'} ${delta === 0 ? '0%' : change}`, description: `${description} versus the preceding 7-day ${basis}` }
}

export function mergeTimeTrend(current: number | null, baseline: number | null): AnalyticsTile['trend'] {
  return metricTrend(current, baseline, { format: formatDuration, basis: 'average' })
}

export function firstReviewTrend(current: number | null, baseline: number | null): AnalyticsTile['trend'] {
  return metricTrend(current, baseline, { format: formatShortDuration, basis: 'median' })
}

export function analyticsGroups(report: AnalyticsReport, baseline: AnalyticsReport): AnalyticsGroup[] {
  const pr = report.pullRequests
  const { lines, behaviors } = pr
  const none = pr.merged === 0
  const complete = !report.errors.length && !baseline.errors.length
  const dailyCount = (label: string, current: number | null, previous: number | null): AnalyticsTile => ({
    label,
    value: current === null ? UNKNOWN : formatCount(current),
    trend: complete ? metricTrend(current, previous === null ? null : previous / 7) : undefined,
    comparison: `7-day daily average: ${formatRate(previous === null ? null : previous / 7)}`,
  })

  // Zero merged pull requests changed zero lines; merged ones nobody has
  // sized yet changed an unknown number.
  const linesTotal = none ? '0' : lines.total === null ? UNKNOWN : formatCount(lines.total)
  let linesNote: string | undefined
  if (!none && lines.counted < pr.merged) {
    linesNote = `From ${formatCount(lines.counted)} of ${plural(pr.merged, 'pull request', 'pull requests')}`
  }

  const perPr = (label: string, current: number | null, previous: number | null, format: (n: number | null) => string, median = false, duration = false): AnalyticsTile => ({
    label, value: format(current),
    trend: complete ? metricTrend(current, previous, duration ? { format: formatDuration, basis: 'median' } : undefined, median ? 'median' : 'average', false) : undefined,
    comparison: `7-day ${median ? 'median' : 'average'}: ${format(previous)} · ${plural(baseline.pullRequests.merged, 'PR', 'PRs')}`,
  })

  return [
    {
      id: 'productivity',
      label: 'Productivity',
      help: 'Your work on the selected day, against the daily average of the seven days before it.',
      tiles: [
        dailyCount('Issues opened', report.issues.opened, baseline.issues.opened),
        dailyCount('Issues closed', report.issues.closed, baseline.issues.closed),
        dailyCount('Pull requests merged', pr.merged, baseline.pullRequests.merged),
        { ...dailyCount('Lines changed', none ? 0 : lines.total, baseline.pullRequests.lines.counted < baseline.pullRequests.merged ? null : baseline.pullRequests.merged === 0 ? 0 : baseline.pullRequests.lines.total), value: linesTotal,
          trend: complete && lines.counted === pr.merged && baseline.pullRequests.lines.counted === baseline.pullRequests.merged
            ? metricTrend(none ? 0 : lines.total, baseline.pullRequests.merged === 0 ? 0 : baseline.pullRequests.lines.total === null ? null : baseline.pullRequests.lines.total / 7) : undefined,
        },
        {
          label: 'Time to merge', value: formatDuration(pr.averageTimeToMergeMs), note: 'Average, from opened to merged',
          trend: !complete ? undefined : mergeTimeTrend(pr.averageTimeToMergeMs, baseline.pullRequests.averageTimeToMergeMs),
          comparison: `7-day rolling average: ${formatDuration(baseline.pullRequests.averageTimeToMergeMs)} · ${plural(baseline.pullRequests.merged, 'PR', 'PRs')}${baseline.pullRequests.merged ? '' : ' · No baseline'}`,
        },
        dailyCount('Pull requests opened', pr.opened, baseline.pullRequests.opened),
        dailyCount('Closed without merging', pr.closedUnmerged, baseline.pullRequests.closedUnmerged),
        {
          label: 'Time to first review', value: formatShortDuration(pr.firstReview.medianMs),
          note: 'Median, from opened to the first review by someone other than the author',
          trend: complete ? firstReviewTrend(pr.firstReview.medianMs, baseline.pullRequests.firstReview.medianMs) : undefined,
          comparison: `7-day median: ${formatShortDuration(baseline.pullRequests.firstReview.medianMs)} · ${plural(baseline.pullRequests.firstReview.count, 'first review', 'first reviews')}`,
        },
      ],
      note: [linesNote, pr.firstReview.count ? '' : 'No pull request had its first review in this range.'].filter(Boolean).join(' '),
    },
    {
      id: 'per-merged-pr',
      label: 'Per merged pull request',
      help: 'Over the pull requests merged on the selected day.',
      tiles: [
        perPr('Comments', pr.commentsPerPr, baseline.pullRequests.commentsPerPr, formatRate),
        perPr('Median lines', lines.counted < pr.merged ? null : lines.median, baseline.pullRequests.lines.counted < baseline.pullRequests.merged ? null : baseline.pullRequests.lines.median, (n) => n === null ? UNKNOWN : formatCount(Math.round(n)), true),
        {
          ...perPr('Behaviors', behaviors.perPr, baseline.pullRequests.behaviors.perPr, formatRate),
          note: none ? undefined : [
            plural(behaviors.approvals, 'approval', 'approvals'),
            plural(behaviors.reviews, 'review', 'reviews'),
            plural(behaviors.changesRequested, 'change request', 'change requests'),
          ].join(' · '),
        },
        { ...perPr('Median time', pr.medianTimeToMergeMs, baseline.pullRequests.medianTimeToMergeMs, formatDuration, true, true), note: 'Median, from opened to merged' },
        {
          ...perPr('Merged by agent', pr.mergedByAgent === null || none ? null : pr.mergedByAgent / pr.merged * 100, baseline.pullRequests.mergedByAgent === null || !baseline.pullRequests.merged ? null : baseline.pullRequests.mergedByAgent / baseline.pullRequests.merged * 100, (n) => n === null ? UNKNOWN : `${formatRate(n)}%`),
          value: pr.mergedByAgent === null || none ? UNKNOWN : `${Math.round(pr.mergedByAgent / pr.merged * 100)}%`,
          ...(report.agentAccount === null ? { comparison: 'No agent account in Settings' } : {}),
          note: report.agentAccount === null || none ? undefined : `${formatCount(pr.mergedByAgent ?? 0)} of ${formatCount(pr.merged)} by ${report.agentAccount}`,
        },
      ],
      note: none ? 'No pull requests were merged in this range.' : undefined,
    },
  ]
}
