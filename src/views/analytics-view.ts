import { reveal } from '../motion'
import { patchContent } from '../dom-patch'
// Analytics — a view of its own: productivity, work and review, then the numbers per merged
// pull request, each with a weekly line and distribution, then
// live GitHub API quota. Independent of Current's filters.
import { analyticsGroups, formatCount, formatRate, type AnalyticsGroup, type AnalyticsReport, type AnalyticsTile } from '../analytics-format'
import { analyticsDay, analyticsDayProgress, analyticsDailyBounds, analyticsHistoryBounds } from '../analytics-day'
import { HISTORY_BASELINE, historyChart, histogram, historySeries, periodLabel, type AnalyticsHistory, type HistorySeries } from '../analytics-history'
import { mountOrganizationFilter, organizationUrl } from '../organizations'
import { effectiveTimezone } from '../config'
import { noticeFeed, type ReadFailure } from '../notices'
import { GITHUB_QUOTA_REFRESH_MS, quotaRiskTone, quotaHours, type GithubQuotaReport, type GithubQuotaBucket } from '../github-quota'

let viewEl: HTMLElement
let initialized = false
// From entering the view until leaving it. Timers, account changes and the
// tab becoming visible read only while the view is on screen.
let active = false
let dayOffset = 0
let dayAnchor = new Date()
let midnightTimer: ReturnType<typeof setTimeout> | undefined
// Each read is numbered so a slow answer for an earlier day or account
// never replaces the one for what is selected now.
let readGeneration = 0
let analyticsRead: AbortController | null = null
let lastReadAt = 0
let quotaGeneration = 0
let historyGeneration = 0
let quotaTimer: ReturnType<typeof setInterval> | undefined
// The day on screen and the past year it is drawn with. The year arrives on
// its own: until then each headline tile holds its chart's place.
let shown: { report: AnalyticsReport, baseline: AnalyticsReport, progress: number | undefined, snapshotTime: string | undefined } | null = null
let history: { data: AnalyticsHistory | null, error: string } = { data: null, error: '' }
// The period a chart's cursor rests on, by tile, while hovered or focused.
const cursors = new Map<string, number>()
let hoverTimer: ReturnType<typeof setTimeout> | undefined
let hoveredSeries: string | null = null
let hoveredIndex = 0

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function renderShell(): string {
  return `
    <header class="view-header">
      <div class="filter-cluster" id="analytics-filters">
        <div class="range-picker analytics-day" role="group" aria-label="Analytics day">
          <button type="button" data-day="-1" aria-label="Previous day">←</button>
          <span class="analytics-date" aria-live="polite"></span>
          <button type="button" data-day="1" aria-label="Next day">→</button>
        </div>
      </div>
    </header>
    <main>
      <div class="analytics-loader loader" role="status" aria-label="Loading analytics" hidden><span></span><span></span><span></span></div>
      <div class="analytics-groups" aria-live="polite"></div>
      <section class="github-quota-section" aria-labelledby="analytics-github-quota">
        <h2 class="tp-group-label" id="analytics-github-quota">GitHub API · Live</h2>
        <div class="github-quota-accounts" aria-live="polite"></div>
      </section>
    </main>`
}

function histogramMarkup(series: Pick<HistorySeries, 'label' | 'values' | 'format'>, tile: AnalyticsTile): string {
  const rounds = tile.label === 'Review rounds'
  const distribution = tile.distribution
  const values = rounds ? (distribution?.distribution ?? []).flatMap((entry) => Array<number>(entry.prs).fill(entry.rounds)) : series.values
  const bins = histogram(values, rounds || tile.label === 'Change-request share' ? 0 : undefined, tile.label === 'Change-request share' ? 100 : undefined)
  const max = Math.max(1, ...bins.map((bin) => bin.count))
  const count = bins.reduce((sum, bin) => sum + bin.count, 0)
  const help = rounds
    ? `Review rounds: distribution of exact round counts for ${distribution?.counted ?? 0} of ${tile.population ?? 0} merged PRs on the selected day. Unknown counts are excluded.`
    : `${series.label}: distribution of ${count} known weekly values over the past year in 10 equal-width bins. Unknown periods are excluded.`
  return `<div class="analytics-histogram" tabindex="0" role="img" aria-label="${escapeHtml(help)}" data-help="${escapeHtml(help)}">
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">${bins.map((bin, i) => `<rect x="${i * 10 + 1}" y="${39 - bin.count / max * 36}" width="8" height="${bin.count / max * 36}" data-help="${escapeHtml(`${series.format(bin.from)} – ${series.format(bin.until)}: ${bin.count} ${rounds ? 'PRs' : 'periods'}`)}"/>`).join('')}</svg>
    <span class="analytics-chart-axis"><span>${escapeHtml(series.format(bins[0].from))}</span><span>${count ? '' : '—'}</span><span>${escapeHtml(series.format(bins[9].until))}</span></span>
  </div>`
}

function quotaCharts(bucket: GithubQuotaBucket, now: number): string {
  const observations = (bucket.history ?? []).filter((sample) => Math.floor(sample.at / 3_600_000) >= Math.floor(now / 3_600_000) - 167 && sample.at <= now && sample.limit > 0)
  const hours = quotaHours(observations, now)
  const time = (at: number) => new Intl.DateTimeFormat('en-GB', { timeZone: effectiveTimezone(), day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(at)
  const used = histogram(observations.map((sample) => sample.used / sample.limit * 100), 0, 100)
  const left = histogram(observations.map((sample) => sample.remaining / sample.limit * 100), 0, 100)
  const peak = Math.max(1, ...used.map((bin) => bin.count), ...left.map((bin) => bin.count))
  const help = 'Used and remaining quota at the latest observation in each hour, past 24 hours including this hour. Empty columns have no observation. Heights show percentage of the quota limit.'
  const distribution = `Past 7 days: distribution of used and remaining quota percentages in 10 bins, from ${observations.length} hourly observations. Gaps are excluded.`
  return `<div class="quota-charts">
    <div class="analytics-chart-heading"><span>Past 24 hours</span><span class="quota-legend"><i class="quota-used"></i>Used <i class="quota-left"></i>Left</span></div>
    <div class="quota-hours" role="img" tabindex="0" aria-label="${help}" data-help="${help}">${hours.map((sample, i) => {
      const at = Math.floor(now / 3_600_000) * 3_600_000 - (23 - i) * 3_600_000
      const text = sample ? `${time(sample.at)}: ${sample.used.toLocaleString('en-US')} used · ${sample.remaining.toLocaleString('en-US')} left` : `${time(at)}: no observation`
      return `<span class="quota-hour${sample ? '' : ' quota-hour-empty'}" data-help="${escapeHtml(text)}">${sample ? `<i class="quota-left" style="height:${sample.remaining / sample.limit * 100}%"></i><i class="quota-used" style="height:${sample.used / sample.limit * 100}%"></i>` : ''}</span>`
    }).join('')}</div>
    <span class="analytics-chart-axis"><span>24h ago</span><span>Now</span></span>
    <div class="analytics-chart-heading"><span>Past 7 days</span><span>${observations.length}/168 hours</span></div>
    <div class="quota-distribution" role="img" tabindex="0" aria-label="${escapeHtml(distribution)}" data-help="${escapeHtml(distribution)}"><svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">${used.map((bin, i) => `<g data-help="${bin.from}–${bin.until}% quota: ${bin.count} used observations · ${left[i].count} remaining observations"><rect class="quota-used" x="${i * 10 + 1}" y="${39 - bin.count / peak * 36}" width="3.5" height="${bin.count / peak * 36}"/><rect class="quota-left" x="${i * 10 + 5}" y="${39 - left[i].count / peak * 36}" width="3.5" height="${left[i].count / peak * 36}"/></g>`).join('')}</svg></div>
    <span class="analytics-chart-axis"><span>0%</span><span>${observations.length ? 'Quota utilization' : 'Collecting history…'}</span><span>100%</span></span>
  </div>`
}

async function readQuota(): Promise<void> {
  const generation = ++quotaGeneration
  const content = viewEl.querySelector<HTMLElement>('.github-quota-accounts')!
  try {
    const response = await fetch('/api/github-quota')
    const data: GithubQuotaReport & { error?: string } = await response.json()
    if (!response.ok || !Array.isArray(data.accounts)) throw new Error(data.error || 'GitHub API quota could not be read.')
    if (generation !== quotaGeneration) return
    const quotaFailures: ReadFailure[] = data.accounts.flatMap((account) => account.error ? [{ key: `quota:${account.login.toLowerCase()}`, title: `GitHub quota for ${account.login} is unavailable`, body: account.error }] : [])
    if (!data.accounts.length) quotaFailures.push({ key: 'quota:configuration', title: 'GitHub quota needs configured accounts', body: 'Set your GitHub user and automation accounts in Settings → General.', target: { settings: 'general' } })
    noticeFeed.reportReadErrors('analytics-quota', quotaFailures)
    const now = Date.now()
    const avatar = (login: string) => `https://github.com/${encodeURIComponent(login)}.png?size=80`
    const failedAvatars = new Set(Array.from(content.querySelectorAll<HTMLImageElement>('.github-quota-avatar img.broken'), (img) => img.getAttribute('src')))
    const number = (n: number) => n.toLocaleString('en-US')
    const time = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: effectiveTimezone(), hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(value))
    patchContent(content, data.accounts.length ? data.accounts.map((account) => `
      <article class="github-quota-account" data-account="${escapeHtml(account.login)}">
        <header class="github-quota-identity">
          <span class="github-quota-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg><img class="last-avatar${failedAvatars.has(avatar(account.login)) ? ' broken' : ''}" src="${avatar(account.login)}" alt="" width="40" height="40"></span>
          <div><h3>${escapeHtml(account.login)}</h3><p class="analytics-note">${escapeHtml(account.roles.join(' + '))}</p>
          ${account.checkedAt ? `<p class="analytics-note">Checked ${escapeHtml(time(account.checkedAt))}</p>` : ''}</div>
        </header>
        ${account.error ? '<div class="github-quota-unavailable" aria-label="Quota unavailable">—</div>' : account.buckets.filter((bucket) => bucket.resource === 'core' || bucket.resource === 'graphql').map((bucket) => {
          const minutes = Math.max(0, (Date.parse(bucket.resetAt) - now) / 60_000)
          const risk = minutes > 0 ? bucket.riskPercent : null
          return `<div class="github-quota-bucket">
            <h4>${escapeHtml(bucket.label)}</h4>
            <p class="github-quota-usage">${number(bucket.used)} / ${number(bucket.limit)} used <span>· ${number(bucket.remaining)} left</span></p>
            ${bucket.limit === 0 ? '<p class="analytics-note">Unavailable for this account</p>' : `
              <progress max="${bucket.limit}" value="${bucket.used}" aria-label="${escapeHtml(bucket.label)} quota used"></progress>
              <p class="analytics-note">Reset ${escapeHtml(time(bucket.resetAt))} · ${minutes.toFixed(1)} min left</p>
              <p class="analytics-note">${bucket.perMinute === null ? 'Collecting usage samples…' : `${number(Math.round(bucket.perMinute * 10) / 10)} / min used · ${(bucket.remaining / Math.max(minutes, 1 / 60)).toFixed(1)} / min available`}</p>
              <p class="github-quota-risk ${quotaRiskTone(risk)}" tabindex="0" data-help="Estimated chance of exhausting this budget before reset if the recently observed rate continues. Requires at least 15 seconds of samples; live quota is independent of the selected day and organization.">${risk === null ? minutes === 0 ? 'Awaiting reset refresh' : 'Risk: collecting samples…' : `${risk}% estimated risk${bucket.remaining === 0 ? ' · Exhausted' : ''}`}</p>
            `}
            ${quotaCharts(bucket, now)}
          </div>`
        }).join('')}
      </article>`).join('') : '')
  } catch (error: unknown) {
    if (generation !== quotaGeneration) return
    content.replaceChildren()
    noticeFeed.reportReadErrors('analytics-quota', [readFailure('GitHub quota is unavailable', error)])
  }
}

function refreshQuota(): void {
  if (document.visibilityState === 'visible' && active) void readQuota()
}

function refreshAnalytics(): void {
  if (document.visibilityState === 'visible' && active) {
    render()
    void readAnalytics(true)
  }
}

function readFailure(title: string, error: unknown): ReadFailure {
  const body = error instanceof Error ? error.message : String(error)
  return { key: `read:${body}`, title, body }
}

function accountFailures(data: { errors: Array<{ org: string, error: string, stale?: boolean }> }): ReadFailure[] {
  return data.errors.map(({ org, error, stale }) => ({ key: `account:${org.toLowerCase()}`, title: `GitHub data for ${org} ${stale ? 'is not updating' : 'is unavailable'}`, body: error }))
}

function hasNewAccountFailure(report: AnalyticsReport, previous: AnalyticsReport): boolean {
  const missing = new Set(previous.errors.filter((error) => !error.stale).map((error) => error.org.toLowerCase()))
  return report.errors.some((error) => !error.stale && !missing.has(error.org.toLowerCase()))
}

function historyMarkup(tile: AnalyticsTile, all: HistorySeries[] | null): string {
  const { label } = tile
  if (label === 'Review rounds' && (history.error || !all)) {
    return `<dd class="analytics-history"><span class="analytics-history-max"></span><div class="analytics-history-plot" ${history.error ? 'aria-label="Year history unavailable"' : 'aria-busy="true"'}></div>${histogramMarkup({ label, values: [], format: formatRate }, tile)}</dd>`
  }
  if (history.error) return '<dd class="analytics-history" aria-label="History unavailable"></dd>'
  if (!all) return '<dd class="analytics-history" aria-busy="true"><span class="analytics-history-max"></span><div class="analytics-history-plot"></div><div class="analytics-histogram"></div></dd>'
  const series = all.find((s) => s.label === label)
  if (!series) return ''
  const chart = historyChart(series.values)
  const latest = chart.points[chart.points.length - 1]
  const at = (point: { x: number, y: number }) => `left: ${point.x}%; top: ${point.y}%`
  const summary = `${series.label}, the past year by 7-day period: latest ${series.format(series.values[series.values.length - 1] ?? null)}, highest ${series.format(chart.max)}. Arrow keys move between periods.`
  return `<dd class="analytics-history" data-series="${escapeHtml(series.label)}">
    <span class="analytics-history-max"><span>${chart.max === null ? '' : `Max ${escapeHtml(series.format(chart.max))}`}</span></span>
    <div class="analytics-history-plot" tabindex="0" role="img" aria-label="${escapeHtml(summary)}">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <line class="analytics-history-base" x1="0" y1="${HISTORY_BASELINE}" x2="100" y2="${HISTORY_BASELINE}" vector-effect="non-scaling-stroke"/>
        ${chart.area ? `<path class="analytics-history-area" d="${chart.area}"/>` : ''}
        ${chart.line ? `<path class="analytics-history-line" d="${chart.line}" vector-effect="non-scaling-stroke"/>` : ''}
      </svg>
      ${chart.isolated.map((point) => `<span class="analytics-history-dot" style="${at(point)}"></span>`).join('')}
      ${latest ? `<span class="analytics-history-latest" style="${at(latest)}"></span>` : ''}
    </div>
    ${histogramMarkup(series, tile)}
  </dd>`
}

const measurementHelp: Record<string, string> = {
  'Issues opened': 'Issues created on the selected day within the selected organization scope.',
  'Issues closed': 'Issues closed on the selected day within the selected organization scope.',
  'Pull requests merged': 'Pull requests merged on the selected day.',
  'Lines changed': 'Additions plus deletions across pull requests merged on the selected day. The tooltip names any partial size coverage.',
  'Time to merge': 'Median elapsed time from opening to merge across pull requests merged on the selected day.',
  'Pull requests opened': 'Pull requests created on the selected day.',
  'Closed without merging': 'Pull requests closed on the selected day without being merged.',
  'Time to first review': 'Median elapsed time from opening to the first submitted review by someone other than the author, for first reviews on the selected day.',
  'Comments': 'Median conversation and review comments per pull request merged on the selected day.',
  'Median lines': 'Median additions plus deletions per pull request merged on the selected day. Withheld when any size is unknown.',
  'Behaviors': 'Median completed review and approval behaviors per pull request merged on the selected day, from Poise’s own launch ledger.',
  'Median time': 'Median elapsed time from opening to merge across pull requests merged on the selected day.',
  'Merged by agent': 'Share of pull requests merged on the selected day whose merger was the configured agent account.',
  'Work type': 'Share of merged PRs by Conventional Commit title prefix. Titles without a recognized prefix are unclassified. The headline shows the largest category; categories have no good or bad polarity.',
  'Review rounds': 'Median distinct commit revisions with a submitted APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED review by someone other than the author, at or before merge. Bots and the configured agent count; deleted accounts count unless known to be the author. Multiple reviews of one commit count once; PRs without reviews count zero. Includes the initial reviewed revision and comment-only reviews; this does not prove rework or causation.',
  'Change-request share': 'Share of merged PRs with at least one observed submitted CHANGES_REQUESTED review by someone other than the author, at or before merge, from the local GitHub datastore. Each PR counts once. Comparison is a relative percentage change, like the other cards.',
}

function workTypeMarkup(tile: AnalyticsTile): string {
  const entries = tile.workTypes ?? []
  return `<dd class="analytics-work-types">${entries.map((entry) => {
    const share = tile.population ? entry.count / tile.population * 100 : 0
    const help = `${entry.type}: ${formatCount(entry.count)} of ${formatCount(tile.population ?? 0)} merged PRs · ${formatRate(share)}%`
    return `<div class="analytics-work-type" data-help="${escapeHtml(help)}" tabindex="0"><span>${entry.type}</span><span class="analytics-work-track"><i style="width:${share}%"></i></span><span>${formatRate(share)}%</span></div>`
  }).join('')}</dd>`
}

function groupMarkup(group: AnalyticsGroup): string {
  const series = history.data ? historySeries(history.data) : null
  return `
    <section class="analytics-group" data-group="${group.id}" aria-labelledby="analytics-${group.id}">
      <h2 class="tp-group-label" id="analytics-${group.id}">${escapeHtml(group.label)}</h2>
      <dl class="analytics-tiles">
        ${group.tiles.map((tile) => `
          <div class="analytics-tile${tile.workTypes ? ' analytics-work-tile' : ''}">
            <dt class="analytics-label">${escapeHtml(tile.label)}</dt>
            <dd class="analytics-summary ${tile.trend?.direction ?? 'neutral'}${tile.trend?.onPace ? ' on-pace' : ''}">
              <div class="analytics-value-row"><span class="analytics-value" data-help="${escapeHtml([measurementHelp[tile.label], tile.note].filter(Boolean).join(' '))}" tabindex="0">${escapeHtml(tile.value)}</span>${tile.valueLabel ? `<span class="analytics-work-label">${escapeHtml(tile.valueLabel)}</span>` : ''}${tile.trend ? `<span class="analytics-arrow" role="img" aria-label="${escapeHtml(tile.trend.description)}" data-help="${escapeHtml(tile.trend.caption)}" tabindex="0">${escapeHtml(tile.trend.text.slice(0, 1))}</span>` : ''}</div>
              ${tile.workTypes ? '' : `<div class="analytics-trend">${tile.trend ? `<span class="analytics-delta" data-help="${escapeHtml(tile.trend.description)}" tabindex="0">${escapeHtml(tile.trend.text.slice(2))}</span>` : ''}<span class="analytics-note">${tile.comparison ? escapeHtml(tile.comparison) : ''}</span></div>`}
            </dd>
            ${tile.workTypes ? workTypeMarkup(tile) : historyMarkup(tile, series)}
          </div>`).join('')}
      </dl>
    </section>`
}

function render(): void {
  const day = analyticsDay(dayOffset, dayAnchor)
  viewEl.querySelector('.analytics-date')!.textContent = day.label
  viewEl.querySelector<HTMLButtonElement>('[data-day="1"]')!.disabled = day.isToday
  if (!shown) return
  patchContent(viewEl.querySelector('.analytics-groups')!, analyticsGroups(shown.report, shown.baseline, day.isToday ? shown.progress : undefined, day.isToday ? shown.snapshotTime : undefined).map(groupMarkup).join(''))
  for (const [label, index] of cursors) showCursor(label, index)
}

// ── A chart's cursor: the period under the pointer or the arrow keys ──
function plotFor(label: string): HTMLElement | null {
  return viewEl.querySelector<HTMLElement>(`.analytics-history[data-series="${CSS.escape(label)}"] .analytics-history-plot`)
}

function showCursor(label: string, index: number): void {
  const plot = plotFor(label)
  const data = history.data
  const series = data && historySeries(data).find((s) => s.label === label)
  if (!plot || !data || !series || !data.periods.length) return
  const i = Math.max(0, Math.min(data.periods.length - 1, index))
  cursors.set(label, i)
  const point = historyChart(series.values).points[i]
  const x = data.periods.length > 1 ? i / (data.periods.length - 1) * 100 : 50
  const part = (name: string, tag = 'span') => {
    let el = plot.querySelector<HTMLElement>(`.analytics-history-${name}`)
    if (!el) {
      el = document.createElement(tag)
      el.className = `analytics-history-${name}`
      plot.append(el)
    }
    return el
  }
  part('cursor').style.left = `${x}%`
  const dot = part('point')
  dot.hidden = !point
  if (point) { dot.style.left = `${point.x}%`; dot.style.top = `${point.y}%` }
  const tip = part('tip', 'div')
  tip.setAttribute('role', 'status')
  const value = document.createElement('strong')
  value.textContent = series.format(series.values[i])
  const detail = document.createElement('span')
  detail.textContent = `${series.detail(data.periods[i])} · ${periodLabel(data.periods[i], effectiveTimezone())}`
  const explanation = document.createElement('small')
  explanation.textContent = `${series.label} · Past year, one value per 7-day period. ${['Issues opened', 'Issues closed', 'Pull requests merged', 'Lines changed', 'Pull requests opened', 'Closed without merging'].includes(label) ? 'Daily averages.' : label === 'Time to merge' ? 'Period medians.' : 'Period values.'} Last period: the 7 days before the selected day.`
  const firstShow = !tip.childElementCount
  tip.replaceChildren(value, detail, explanation)
  if (firstShow) reveal(tip, { distance: 4 })
  // Centre the readout on the cursor but keep it on the page: a chart in the
  // right column of a narrow page is narrower than its readout. Only a
  // readout wider than the page itself wraps.
  const page = viewEl.querySelector('main')!.getBoundingClientRect()
  const box = plot.getBoundingClientRect()
  tip.style.whiteSpace = ''
  tip.style.width = ''
  if (tip.offsetWidth > page.width) {
    tip.style.whiteSpace = 'normal'
    tip.style.width = `${page.width}px`
  }
  const left = Math.max(page.left, Math.min(page.right - tip.offsetWidth, box.left + x / 100 * box.width - tip.offsetWidth / 2))
  tip.style.left = `${left - box.left}px`
}

function cancelHover(): void {
  clearTimeout(hoverTimer)
  hoverTimer = undefined
}

function hideCursor(label: string): void {
  if (hoveredSeries === label) {
    cancelHover()
    hoveredSeries = null
  }
  cursors.delete(label)
  const plot = plotFor(label)
  plot?.querySelectorAll('.analytics-history-cursor, .analytics-history-point, .analytics-history-tip').forEach((el) => el.remove())
}

function plotLabel(event: Event): string | null {
  const plot = (event.target as HTMLElement).closest<HTMLElement>('.analytics-history-plot')
  return plot?.closest<HTMLElement>('.analytics-history')?.dataset.series ?? null
}

function onPlotPointer(event: PointerEvent): void {
  const label = plotLabel(event)
  const count = history.data?.periods.length ?? 0
  if (!label || !count) return
  const rect = plotFor(label)!.getBoundingClientRect()
  hoveredIndex = Math.round((event.clientX - rect.left) / Math.max(1, rect.width) * (count - 1))
  if (hoveredSeries !== label) {
    cancelHover()
    hoveredSeries = label
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined
      if (hoveredSeries === label && active) showCursor(label, hoveredIndex)
    }, 500)
  } else if (!hoverTimer) showCursor(label, hoveredIndex)
}

function onPlotKey(event: KeyboardEvent): void {
  const label = plotLabel(event)
  const count = history.data?.periods.length ?? 0
  if (!label || !count) return
  if (event.key === 'Escape') {
    cancelHover()
    hoveredSeries = null
    hideCursor(label)
    return
  }
  const at = cursors.get(label) ?? count - 1
  const next = event.key === 'ArrowLeft' ? at - 1 : event.key === 'ArrowRight' ? at + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null
  if (next === null) return
  cancelHover()
  event.preventDefault()
  showCursor(label, next)
}

async function readHistory(bounds: string[]): Promise<void> {
  const generation = ++historyGeneration
  history = { data: null, error: '' }
  cursors.clear()
  cancelHover()
  hoveredSeries = null
  try {
    const res = await fetch(organizationUrl(`/api/analytics/history?${new URLSearchParams({ bounds: bounds.join(',') })}`))
    const data = await res.json().catch(() => null)
    if (!res.ok || !Array.isArray(data?.periods)) throw new Error(data?.error || `The past year could not be read (HTTP ${res.status})`)
    if (generation !== historyGeneration) return
    history = { data: data as AnalyticsHistory, error: '' }
    noticeFeed.reportReadErrors('analytics-history', accountFailures(data))
  } catch (error) {
    if (generation !== historyGeneration) return
    history = { data: null, error: error instanceof Error ? error.message : String(error) }
    noticeFeed.reportReadErrors('analytics-history', [readFailure('Analytics history is unavailable', error)])
  }
  render()
}

async function readAnalytics(background = false): Promise<void> {
  if (background && analyticsRead) return
  const generation = ++readGeneration
  analyticsRead?.abort()
  const controller = new AbortController()
  analyticsRead = controller
  const groups = viewEl.querySelector<HTMLElement>('.analytics-groups')!
  const quota = viewEl.querySelector<HTMLElement>('.github-quota-section')!
  const day = analyticsDay(dayOffset, dayAnchor)
  // Totals and typical-by-now must describe the same read, even on later renders.
  const capturedAt = Date.now()
  lastReadAt = capturedAt
  const progress = day.isToday ? analyticsDayProgress(day.since, day.until, capturedAt) : undefined
  const snapshotTime = day.isToday ? new Intl.DateTimeFormat('en-GB', {
    timeZone: effectiveTimezone(), day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(capturedAt) : undefined
  if (!background) {
    shown = null
    render()
    void readHistory(analyticsHistoryBounds(dayOffset, dayAnchor))
    // The emptied sections keep their space while the next day loads, so
    // GitHub below does not jump up under the loader and back down after.
    const quotaTop = quota.offsetTop
    groups.style.minHeight = ''
    groups.replaceChildren()
    viewEl.querySelector<HTMLElement>('.analytics-loader')!.hidden = false
    groups.setAttribute('aria-busy', 'true')
    groups.style.minHeight = `${Math.max(0, quotaTop - quota.offsetTop)}px`
  }
  const read = async (since: string, until: string, dailyBounds?: string[]): Promise<AnalyticsReport> => {
    const query = new URLSearchParams({ since, until, ...(dailyBounds ? { dailyBounds: dailyBounds.join(',') } : {}) })
    const res = await fetch(organizationUrl(`/api/analytics?${query}`), { signal: controller.signal })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data) throw new Error(data?.error || `Analytics could not be read (HTTP ${res.status})`)
    return data as AnalyticsReport
  }
  try {
    const [data, baseline] = await Promise.all([
      read(day.since, day.until),
      read(day.baselineSince, day.since, analyticsDailyBounds(dayOffset, dayAnchor)),
    ])
    if (generation !== readGeneration) return
    const failures = [...accountFailures(data), ...accountFailures(baseline)]
    if (background && shown && (hasNewAccountFailure(data, shown.report) || hasNewAccountFailure(baseline, shown.baseline))) {
      noticeFeed.reportReadErrors('analytics-day', failures)
      return
    }
    shown = { report: data, baseline, progress, snapshotTime }
    render()
    noticeFeed.reportReadErrors('analytics-day', failures)
  } catch (error) {
    if (generation !== readGeneration) return
    // A failed refresh keeps the last totals and their matching pace timestamp.
    if (!background) groups.innerHTML = ''
    noticeFeed.reportReadErrors('analytics-day', [readFailure(background ? 'Analytics could not refresh' : 'Analytics is unavailable', error)])
  } finally {
    controller.abort()
    if (analyticsRead === controller) analyticsRead = null
    if (generation === readGeneration && !background) {
      viewEl.querySelector<HTMLElement>('.analytics-loader')!.hidden = true
      groups.removeAttribute('aria-busy')
      groups.style.minHeight = ''
    }
  }
}

function scheduleMidnightRead(): void {
  clearTimeout(midnightTimer)
  const boundary = Date.parse(analyticsDay(0).until)
  const delay = boundary - Date.now()
  midnightTimer = setTimeout(() => {
    // The shared refresh tick can already have read this midnight's snapshot.
    if (lastReadAt < boundary) refreshAnalytics()
    scheduleMidnightRead()
  }, delay + 10)
}

export function initAnalyticsView(): void {
  viewEl = document.getElementById('view-analytics')!
  if (!initialized) {
    initialized = true
    viewEl.innerHTML = renderShell()
    mountOrganizationFilter(viewEl.querySelector<HTMLElement>('#analytics-filters')!)
    viewEl.querySelector('.analytics-day')!.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-day]')
      if (!button || button.disabled) return
      dayOffset += Number(button.dataset.day)
      void readAnalytics()
    })
    window.addEventListener('poise:organization-filter-changed', () => { if (active) void readAnalytics() })
    const groups = viewEl.querySelector<HTMLElement>('.analytics-groups')!
    groups.addEventListener('pointermove', onPlotPointer)
    groups.addEventListener('pointerout', (event) => {
      const label = plotLabel(event)
      const plot = label ? plotFor(label) : null
      if (label && plot && !plot.contains(event.relatedTarget as Node | null)) {
        cancelHover()
        hoveredSeries = null
        if (document.activeElement !== plot) hideCursor(label)
      }
    })
    groups.addEventListener('focusin', (event) => {
      const label = plotLabel(event)
      const count = history.data?.periods.length ?? 0
      if (label && count) {
        cancelHover()
        showCursor(label, cursors.get(label) ?? count - 1)
      }
    })
    groups.addEventListener('focusout', (event) => {
      const label = plotLabel(event)
      if (label) hideCursor(label)
    })
    groups.addEventListener('keydown', onPlotKey)
    window.addEventListener('poise:refresh-tick', refreshAnalytics)
    document.addEventListener('visibilitychange', refreshQuota)
    document.addEventListener('visibilitychange', refreshAnalytics)
  }
  // Arriving opens on Today. A settings save re-enters the showing view;
  // that reads again for the day already chosen.
  if (!active) {
    active = true
    dayOffset = 0
    dayAnchor = new Date()
    const quota = viewEl.querySelector<HTMLElement>('.github-quota-accounts')!
    quota.textContent = 'Reading live quota…'
    quota.classList.remove('st-help-error')
    clearInterval(quotaTimer)
    quotaTimer = setInterval(refreshQuota, GITHUB_QUOTA_REFRESH_MS)
  }
  scheduleMidnightRead()
  void readAnalytics()
  void readQuota()
}

export function stopAnalyticsRefresh(): void {
  if (!active) return
  active = false
  readGeneration++
  analyticsRead?.abort()
  analyticsRead = null
  quotaGeneration++
  historyGeneration++
  cancelHover()
  hoveredSeries = null
  clearInterval(quotaTimer)
  clearTimeout(midnightTimer)
}
