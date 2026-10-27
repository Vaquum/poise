import { analyticsDay, analyticsDailyBounds } from './analytics-day'
import type { AnalyticsReport } from './analytics-format'
import { effectiveTimezone, getRefreshRateMs, getSettings } from './config'
import { getSelectedOrganization, organizationUrl } from './organizations'

export interface AnalyticsSnapshot {
  report: AnalyticsReport
  baseline: AnalyticsReport
  capturedAt: number
}

interface Prepared {
  key: string
  controller: AbortController
  snapshot: AnalyticsSnapshot | null
  pending: Promise<AnalyticsSnapshot> | null
}
let prepared: Prepared | null = null

export function hasNewAccountFailure(report: AnalyticsReport, previous: AnalyticsReport): boolean {
  const missing = new Set(previous.errors.filter(error => !error.stale).map(error => error.org.toLowerCase()))
  return report.errors.some(error => !error.stale && !missing.has(error.org.toLowerCase()))
}

export function analyticsSnapshotScope(offset: number, anchor: Date): string {
  const day = analyticsDay(offset, anchor)
  const settings = getSettings()
  return JSON.stringify([day.since, day.until, getSelectedOrganization(), settings.me, settings.agentAccount, effectiveTimezone(), settings.organizations ?? settings.org])
}

/** Only an exact scope within the configured refresh interval can paint immediately. */
export function preparedAnalytics(offset: number, anchor: Date): AnalyticsSnapshot | null {
  if (prepared?.key !== analyticsSnapshotScope(offset, anchor) || !prepared.snapshot) return null
  return Date.now() - prepared.snapshot.capturedAt <= getRefreshRateMs() ? prepared.snapshot : null
}

/** Share an in-flight preparation; refresh completed snapshots rather than redate them. */
export function readAnalyticsSnapshot(offset: number, anchor: Date, signal?: AbortSignal): Promise<AnalyticsSnapshot> {
  const key = analyticsSnapshotScope(offset, anchor)
  if (prepared?.key === key && prepared.pending && !prepared.controller.signal.aborted) return prepared.pending
  prepared?.controller.abort()
  const entry: Prepared = { key, controller: new AbortController(), snapshot: prepared?.key === key ? prepared.snapshot : null, pending: null }
  prepared = entry
  const abort = () => entry.controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const capturedAt = Date.now()
  const day = analyticsDay(offset, anchor)
  const org = getSelectedOrganization()
  const read = async (since: string, until: string, dailyBounds?: string[]): Promise<AnalyticsReport> => {
    const query = new URLSearchParams({ since, until, ...(dailyBounds ? { dailyBounds: dailyBounds.join(',') } : {}) })
    const response = await fetch(organizationUrl(`/api/analytics?${query}`, org), {
      signal: entry.controller.signal,
    })
    const data = await response.json().catch(() => null)
    entry.controller.signal.throwIfAborted()
    if (!response.ok || !data) throw new Error(data?.error || `Analytics could not be read (HTTP ${response.status})`)
    const validErrors = Array.isArray(data.errors) && data.errors.every((value: unknown) =>
      typeof value === 'object' && value !== null && 'org' in value && typeof value.org === 'string'
      && 'error' in value && typeof value.error === 'string')
    if (!validErrors || !data.window || !data.issues || !data.pullRequests) {
      throw new Error(`Analytics returned an invalid report (HTTP ${response.status})`)
    }
    return data as AnalyticsReport
  }
  const pending = Promise.all([
    read(day.since, day.until),
    read(day.baselineSince, day.since, analyticsDailyBounds(offset, anchor)),
  ]).then(([report, baseline]) => {
    const snapshot = { report, baseline, capturedAt }
    const previous = entry.snapshot
    if (prepared === entry && (!previous || !(hasNewAccountFailure(report, previous.report) || hasNewAccountFailure(baseline, previous.baseline)))) entry.snapshot = snapshot
    return snapshot
  }).finally(() => {
    signal?.removeEventListener('abort', abort)
    entry.controller.abort()
    if (entry.pending === pending) entry.pending = null
  })
  entry.pending = pending
  return pending
}
