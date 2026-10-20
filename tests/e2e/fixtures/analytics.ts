import type { AnalyticsReport } from '../../../src/analytics-format'

/** A successful empty API read, including background Analytics preparation. */
export function emptyAnalyticsReport(url: URL): AnalyticsReport {
  return {
    window: { since: url.searchParams.get('since'), until: url.searchParams.get('until') },
    agentAccount: null,
    issues: { opened: 0, closed: 0 },
    pullRequests: {
      opened: 0, closedUnmerged: 0, merged: 0, mergedByAgent: null,
      firstReview: { count: 0, medianMs: null }, commentsPerPr: null,
      lines: { total: null, median: null, counted: 0 },
      behaviors: { perPr: null, approvals: 0, reviews: 0, changesRequested: 0 },
      averageTimeToMergeMs: null, medianTimeToMergeMs: null,
    },
    errors: [],
  }
}
