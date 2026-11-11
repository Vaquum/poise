import type { AnalyticsHealth, HealthEvidence, HealthSource, WorkRecovery } from './analytics-health-types'
import { formatCount, formatDuration, formatRate } from './analytics-format'
import { effectiveTimezone } from './config'
import { escapeHtml } from './markdown'
import { getSelectedOrganization, organizationUrl } from './organizations'

const evidenceHref = '/?view=logging'
function timestamp(at: number | string): string {
  return new Date(at).toLocaleString('en-GB', { timeZone: effectiveTimezone(), timeZoneName: 'short', hour12: false })
}
function evidence(items: HealthEvidence[]): string {
  return items.length ? `<details><summary>Evidence (${items.length})</summary><ul>${items.map(item =>
    `<li><a href="${escapeHtml(item.journal)}">${escapeHtml(item.work)}</a> · ${escapeHtml(item.summary)}</li>`).join('')}</ul></details>` : ''
}
function recoveryEvidence(items: WorkRecovery[]): HealthEvidence[] {
  return items.map(item => ({ ...item, summary: `${item.origin}; failed Call ${item.failedCall}; action ${item.actionSequence} at ${timestamp(item.actionAt)}; verified progress ${timestamp(item.progressAt)}${item.interventionAt === null ? '' : `; outside intervention ${timestamp(item.interventionAt)}`}` }))
}
function sourceRow(source: HealthSource): string {
  const intervals = source.intervals
  const duration = intervals?.reduce((sum, part) => sum + part.until - part.since, 0) ?? 0
  const intervalText = intervals?.map(part => `${part.state}: ${timestamp(part.since)} – ${timestamp(part.until)}`).join('; ')
  return `<div class="system-health-source"><span>${escapeHtml(source.name)} · ${escapeHtml(source.status)}</span>
    ${intervals && duration > 0 ? `<span class="system-health-bar" role="img" aria-label="${escapeHtml(`${source.name}: ${intervalText}`)}" title="${escapeHtml(intervalText ?? '')}">${intervals.map(part => `<i class="${part.state}" style="width:${(part.until - part.since) / duration * 100}%"></i>`).join('')}</span>` : ''}
    <small>${escapeHtml(source.scope)}${intervals?.length ? ` · ${escapeHtml(timestamp(intervals[0].since))} – ${escapeHtml(timestamp(intervals[intervals.length - 1].until))}` : ''} · Last successful read: ${source.lastReadAt ? escapeHtml(timestamp(source.lastReadAt)) : 'unknown'}</small></div>`
}

export function analyticsHealthMarkup(data: AnalyticsHealth | null, failure = ''): string {
  const card = (label: string, value: string, detail: string, items: HealthEvidence[] = [], extra = '') =>
    `<article class="system-health-card"><a class="analytics-label" href="${evidenceHref}">${label}</a><p class="system-health-value">${escapeHtml(value)}</p><p class="analytics-note">${escapeHtml(detail)}</p>${extra}${evidence(items)}</article>`
  const latest = data?.lastError
  const error = latest?.error
  const unavailable = !data
  const coverage = data?.coverage.map(sourceRow).join('') ?? '<p class="analytics-note">Sources have not been read.</p>'
  const lastValue = error ? formatDuration(Math.max(0, data!.readAt - error.at))
    : latest?.coveredSince !== null && latest?.coveredSince !== undefined && latest.coveredUntil !== null
      ? `${formatDuration(latest.coveredUntil - latest.coveredSince)} covered` : 'Unavailable'
  const lastDetail = error ? `${latest!.lastObserved ? 'Last observed error' : 'Last work error'} · ${timestamp(error.at)}`
    : latest?.coveredSince !== null && latest?.coveredSince !== undefined && latest.coveredUntil !== null
      ? `No observed error · ${timestamp(latest.coveredSince)} – ${timestamp(latest.coveredUntil)}` : 'Error coverage unknown'
  return `<div class="system-health-heading"><span>System health · Live</span><span>Trailing 24 hours · live blocked snapshot · v2-only</span></div>
    <p class="system-health-status" role="status">${failure ? escapeHtml(`${data ? 'Stale' : 'Unavailable'} · ${data ? `Last successful read ${timestamp(data.readAt)} · ` : ''}${data?.scope || getSelectedOrganization() || 'All configured accounts'} · ${failure}`)
      : data ? escapeHtml(`${data.scope || 'All configured accounts'} · Read ${timestamp(data.readAt)}`) : 'Reading system health…'}</p>
    <div class="system-health-cards">
      ${card('Errors per completed work item', unavailable || data!.rate.perItem === null ? 'Unavailable' : `${formatRate(data!.rate.perItem)} errors/item`,
        data ? `${formatCount(data.rate.errors)} known errors / ${formatCount(data.rate.completed)} completed items${data.rate.perItem === null ? ' · rate requires a nonempty, complete lifetime cohort' : ''}` : 'Verified v2 completions and lifetime errors', data?.rate.items)}
      ${card('Work blocked', data ? formatCount(data.blocked.count) : 'Unavailable', data?.blocked.oldestProgressAt !== null && data?.blocked.oldestProgressAt !== undefined
        ? `Oldest progress ${formatDuration(data.readAt - data.blocked.oldestProgressAt)} ago · ${data.blocked.largestStage}` : data ? 'No known blocked work · live snapshot' : 'Live snapshot unavailable', data?.blocked.items)}
      ${card('Auto recovery', data ? formatCount(data.recovery.automatic.length) : 'Unavailable', data
        ? `${formatCount(data.recovery.intervention.length)} required outside intervention · ${formatCount(data.recovery.unknown)} unknown outcomes` : 'Verified progress after execution failure',
      data ? recoveryEvidence([...data.recovery.automatic, ...data.recovery.intervention]) : [])}
      ${card('Time since last work error', lastValue, lastDetail, error ? [error] : [])}
      ${card('Evidence coverage', '', 'Current source status; retained history below', [], coverage)}
    </div>
    ${data ? `<details class="system-health-limits"><summary>Coverage limits (${data.limits.length}) · covered / gaps / unknown</summary><ul>${data.limits.map(limit => `<li>${escapeHtml(limit)}</li>`).join('')}</ul><a href="${evidenceHref}">Open source evidence in Logging</a></details>` : ''}`
}

/** Uses Analytics' existing refresh events; there is no additional timer. */
export function analyticsHealthView(element: HTMLElement) {
  let data: AnalyticsHealth | null = null
  let scope: string | null = null
  let controller: AbortController | null = null
  const render = (failure = '') => { element.innerHTML = analyticsHealthMarkup(data, failure) }
  render()
  return {
    async refresh(): Promise<void> {
      const selected = getSelectedOrganization()
      if (controller && scope === selected) return
      controller?.abort()
      if (scope !== selected) { data = null; scope = selected; render() }
      const read = new AbortController()
      controller = read
      const timeout = setTimeout(() => read.abort(new Error('System health read timed out')), 5_000)
      try {
        const response = await fetch(organizationUrl('/api/analytics/system-health'), { signal: read.signal })
        const value: AnalyticsHealth & { error?: string } = await response.json()
        if (!response.ok || !value.window || !value.rate || !value.blocked || !value.recovery || !value.lastError || !Array.isArray(value.coverage) || !Array.isArray(value.limits)) {
          throw new Error(value.error || 'System health evidence could not be read')
        }
        if (controller !== read) return
        data = value
        render()
      } catch (error) {
        if (controller === read) render(error instanceof Error ? error.message : String(error))
      } finally {
        clearTimeout(timeout)
        if (controller === read) controller = null
      }
    },
    stop(): void { controller?.abort(); controller = null },
  }
}
