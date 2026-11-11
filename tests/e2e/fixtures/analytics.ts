import type { AnalyticsReport } from '../../../src/analytics-format'
import type { AnalyticsHealth } from '../../../src/analytics-health-types'

export function analyticsHealthReport(scope = ''): AnalyticsHealth {
  const now = Date.parse('2026-10-09T12:00:00Z'), hour = 3_600_000
  const journal = '/?view=logging&chain=acme%2Frepo%237&after=0'
  return { readAt: now, window: { since: now - 24 * hour, until: now }, scope,
    limits: ['v2-only; uncorrelated legacy work excluded', 'acme/repo#7: incomplete lifetime evidence before the last 24 hours'],
    rate: { completed: 2, errors: 1, perItem: null, items: [{ work: 'acme/repo#7', journal, summary: '1 error; merged in the trailing 24 hours' }] },
    blocked: { count: 1, oldestProgressAt: now - 2 * hour, largestStage: 'Issue admission: 1', items: [{ work: 'acme/repo#7', journal, summary: 'Held before publication' }] },
    recovery: { automatic: [], intervention: [{ work: 'acme/repo#7', journal, summary: 'Refresh credential rejected', failedCall: 'a'.repeat(32),
      origin: 'operator', actionSequence: 8, actionAt: now - 4 * hour, progressAt: now - 3 * hour, interventionAt: now - 4 * hour }], unknown: 1 },
    lastError: { error: { work: 'acme/repo#7', journal, summary: 'Refresh credential rejected', callId: 'a'.repeat(32), invocation: 'b'.repeat(32),
      incident: 'fixture-incident', at: now - hour }, lastObserved: true, coveredSince: now - hour / 2, coveredUntil: now },
    coverage: [{ name: 'Chain journal', scope: scope || 'All configured accounts', status: 'verified v2', lastReadAt: new Date(now).toISOString(), intervals: null },
      { name: 'Caller receipts', scope: 'Instance-wide coverage history; selected v2 work', status: 'ok', lastReadAt: new Date(now).toISOString(),
        intervals: [{ since: now - 48 * hour, until: now - 36 * hour, state: 'unknown' }, { since: now - 36 * hour, until: now - 30 * hour, state: 'gap' }, { since: now - 30 * hour, until: now, state: 'covered' }] },
      { name: 'GitHub', scope: scope || 'acme', status: 'ok', lastReadAt: new Date(now).toISOString(), intervals: null }] }
}

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
