// What the Analytics panel says about a report from /api/analytics
// (server/analytics.ts). Kept free of the DOM so the wording is testable.

export interface AnalyticsReport {
  window: { since: string | null, until: string | null }
  issues: { opened: number, closed: number }
  pullRequests: {
    merged: number
    commentsPerPr: number | null
    lines: { total: number | null, median: number | null, counted: number }
    behaviors: { perPr: number | null, approvals: number, reviews: number, changesRequested: number }
    averageTimeToMergeMs: number | null
  }
  errors: Array<{ org: string, error: string }>
}

export interface AnalyticsTile {
  label: string
  value: string
  /** A line under the value that says what it is made of. */
  note?: string
}

export interface AnalyticsGroup {
  label: string
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

function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

export function analyticsGroups(report: AnalyticsReport): AnalyticsGroup[] {
  const pr = report.pullRequests
  const { lines, behaviors } = pr
  const none = pr.merged === 0

  // Zero merged pull requests changed zero lines; merged ones nobody has
  // sized yet changed an unknown number.
  const linesTotal = none ? '0' : lines.total === null ? UNKNOWN : formatCount(lines.total)
  let linesNote: string | undefined
  if (!none && lines.counted < pr.merged) {
    linesNote = `From ${formatCount(lines.counted)} of ${plural(pr.merged, 'pull request', 'pull requests')}; `
      + 'the rest get their size at the datastore\'s next full sync.'
  }

  return [
    {
      label: 'Issues',
      tiles: [
        { label: 'Opened', value: formatCount(report.issues.opened) },
        { label: 'Closed', value: formatCount(report.issues.closed) },
      ],
    },
    {
      label: 'Pull requests',
      tiles: [
        { label: 'Merged', value: formatCount(pr.merged) },
        { label: 'Lines changed', value: linesTotal },
        { label: 'Time to merge', value: formatDuration(pr.averageTimeToMergeMs), note: 'Average, from opened to merged' },
      ],
      note: linesNote,
    },
    {
      label: 'Per merged pull request',
      tiles: [
        { label: 'Comments', value: formatRate(pr.commentsPerPr) },
        { label: 'Median lines', value: lines.median === null ? UNKNOWN : formatCount(Math.round(lines.median)) },
        {
          label: 'Behaviors',
          value: formatRate(behaviors.perPr),
          note: none ? undefined : [
            plural(behaviors.approvals, 'approval', 'approvals'),
            plural(behaviors.reviews, 'review', 'reviews'),
            plural(behaviors.changesRequested, 'change request', 'change requests'),
          ].join(' · '),
        },
      ],
      note: none ? 'No pull requests were merged in this range.' : undefined,
    },
  ]
}
