import { patchContent } from '../dom-patch'
// Analytics — a view of its own, opened from the burger menu rather than the
// top nav: the selected day's productivity topline with each figure's past
// year, then pull request flow and the numbers per merged pull request, then
// live GitHub API quota. Independent of Current's filters.
import { analyticsGroups, type AnalyticsGroup, type AnalyticsReport } from '../analytics-format'
import { analyticsDay, analyticsHistoryBounds } from '../analytics-day'
import { HISTORY_BASELINE, historyChart, historySeries, periodLabel, type AnalyticsHistory, type HistorySeries } from '../analytics-history'
import { mountOrganizationFilter, organizationErrors, organizationUrl } from '../organizations'
import { effectiveTimezone } from '../config'
import { GITHUB_QUOTA_REFRESH_MS, quotaRiskTone, type GithubQuotaReport } from '../github-quota'

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
let quotaGeneration = 0
let historyGeneration = 0
let quotaTimer: ReturnType<typeof setInterval> | undefined
// The day on screen and the past year it is drawn with. The year arrives on
// its own: until then each headline tile holds its chart's place.
let shown: { report: AnalyticsReport, baseline: AnalyticsReport } | null = null
let history: { data: AnalyticsHistory | null, error: string } = { data: null, error: '' }
// The period a chart's cursor rests on, by tile, while hovered or focused.
const cursors = new Map<string, number>()

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
      <p class="analytics-status st-help" role="status" hidden></p>
      <div class="analytics-groups" aria-live="polite"></div>
      <section class="github-quota-section" aria-labelledby="analytics-github-quota">
        <h2 class="tp-group-label" id="analytics-github-quota">GitHub API · Live</h2>
        <div class="github-quota-accounts" aria-live="polite"></div>
        <p class="analytics-group-note">Estimated risk of running out before reset, assuming recent usage continues. Collecting samples takes at least 15 seconds. Live quotas do not follow the selected day or organization.</p>
      </section>
    </main>`
}

async function readQuota(): Promise<void> {
  const generation = ++quotaGeneration
  const content = viewEl.querySelector<HTMLElement>('.github-quota-accounts')!
  try {
    const response = await fetch('/api/github-quota')
    const data: GithubQuotaReport & { error?: string } = await response.json()
    if (!response.ok || !Array.isArray(data.accounts)) throw new Error(data.error || 'GitHub API quota could not be read.')
    if (generation !== quotaGeneration) return
    content.classList.remove('st-help-error')
    const now = Date.now()
    const number = (n: number) => n.toLocaleString('en-US')
    const time = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: effectiveTimezone(), hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(value))
    patchContent(content, data.accounts.length ? data.accounts.map((account) => `
      <article class="github-quota-account" data-account="${escapeHtml(account.login)}">
        <header class="github-quota-identity">
          <h3>${escapeHtml(account.login)} <span>${escapeHtml(account.roles.join(' + '))}</span></h3>
          ${account.checkedAt ? `<p class="analytics-note">Checked ${escapeHtml(time(account.checkedAt))}</p>` : ''}
        </header>
        ${account.error ? `<p class="st-help st-help-error">${escapeHtml(account.error)}</p>` : account.buckets.map((bucket) => {
          const minutes = Math.max(0, (Date.parse(bucket.resetAt) - now) / 60_000)
          const risk = minutes > 0 ? bucket.riskPercent : null
          return `<div class="github-quota-bucket">
            <h4>${escapeHtml(bucket.label)}</h4>
            <p class="github-quota-usage">${number(bucket.used)} / ${number(bucket.limit)} used <span>· ${number(bucket.remaining)} left</span></p>
            ${bucket.limit === 0 ? '<p class="analytics-note">Unavailable for this account</p>' : `
              <progress max="${bucket.limit}" value="${bucket.used}" aria-label="${escapeHtml(bucket.label)} quota used"></progress>
              <p class="analytics-note">Reset ${escapeHtml(time(bucket.resetAt))} · ${minutes.toFixed(1)} min left</p>
              <p class="analytics-note">${bucket.perMinute === null ? 'Collecting usage samples…' : `${number(Math.round(bucket.perMinute * 10) / 10)} / min used · ${(bucket.remaining / Math.max(minutes, 1 / 60)).toFixed(1)} / min available`}</p>
              <p class="github-quota-risk ${quotaRiskTone(risk)}">${risk === null ? minutes === 0 ? 'Awaiting reset refresh' : 'Risk: collecting samples…' : `${risk}% estimated risk${bucket.remaining === 0 ? ' · Exhausted' : ''}`}</p>
            `}
          </div>`
        }).join('')}
      </article>`).join('') : '<p class="analytics-note">Set your GitHub user and automation accounts in Settings → General.</p>')
  } catch (error: unknown) {
    if (generation !== quotaGeneration) return
    content.textContent = error instanceof Error ? error.message : String(error)
    content.classList.add('st-help-error')
  }
}

function refreshQuota(): void {
  if (document.visibilityState === 'visible' && active) void readQuota()
}

function showStatus(message: string, isError = false): void {
  const status = viewEl.querySelector<HTMLElement>('.analytics-status')!
  status.textContent = message
  status.hidden = !message
  status.classList.toggle('st-help-error', isError)
}

function historyMarkup(label: string, all: HistorySeries[] | null): string {
  if (history.error) return `<dd class="analytics-history"><p class="analytics-history-empty" data-help="${escapeHtml(history.error)}" tabindex="0">Past year unavailable</p></dd>`
  if (!all) return '<dd class="analytics-history" aria-busy="true"><span class="analytics-history-max"></span><div class="analytics-history-plot"></div></dd>'
  const series = all.find((s) => s.label === label)
  if (!series) return ''
  const chart = historyChart(series.values)
  const latest = chart.points[chart.points.length - 1]
  const at = (point: { x: number, y: number }) => `left: ${point.x}%; top: ${point.y}%`
  const summary = `${series.label}, the past year by 7-day period: latest ${series.format(series.values[series.values.length - 1] ?? null)}, highest ${series.format(chart.max)}. Arrow keys move between periods.`
  return `<dd class="analytics-history" data-series="${escapeHtml(series.label)}">
    <span class="analytics-history-max">${chart.max === null ? '' : `Max ${escapeHtml(series.format(chart.max))}`}</span>
    <div class="analytics-history-plot" tabindex="0" role="img" aria-label="${escapeHtml(summary)}">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <line class="analytics-history-base" x1="0" y1="${HISTORY_BASELINE}" x2="100" y2="${HISTORY_BASELINE}" vector-effect="non-scaling-stroke"/>
        ${chart.area ? `<path class="analytics-history-area" d="${chart.area}"/>` : ''}
        ${chart.line ? `<path class="analytics-history-line" d="${chart.line}" vector-effect="non-scaling-stroke"/>` : ''}
      </svg>
      ${chart.isolated.map((point) => `<span class="analytics-history-dot" style="${at(point)}"></span>`).join('')}
      ${latest ? `<span class="analytics-history-latest" style="${at(latest)}"></span>` : ''}
    </div>
  </dd>`
}

function historyTable(): string {
  const data = history.data
  if (!data) return ''
  const series = historySeries(data)
  const zone = effectiveTimezone()
  return `<details class="analytics-history-table">
    <summary>The past year as a table</summary>
    <table>
      <thead><tr><th>Period</th>${series.map((s) => `<th>${escapeHtml(s.label)}</th>`).join('')}</tr></thead>
      <tbody>${data.periods.map((period, i) => `<tr><td>${escapeHtml(periodLabel(period, zone))}</td>${series.map((s) => `<td>${escapeHtml(s.format(s.values[i]))}</td>`).join('')}</tr>`).reverse().join('')}</tbody>
    </table>
  </details>`
}

function groupMarkup(group: AnalyticsGroup): string {
  const topline = group.id === 'productivity'
  const series = topline && history.data ? historySeries(history.data) : null
  const historyNote = !topline ? '' : history.data?.errors.length
    ? organizationErrors(history.data)
    : 'Under each figure, the past year by 7-day period: daily averages, and time to merge as each period\'s mean. The last period is the 7 days before the selected day.'
  return `
    <section class="analytics-group" data-group="${group.id}" aria-labelledby="analytics-${group.id}">
      <h2 class="tp-group-label" id="analytics-${group.id}" data-help="${escapeHtml(group.help)}" tabindex="0">${escapeHtml(group.label)}</h2>
      <dl class="analytics-tiles">
        ${group.tiles.map((tile) => `
          <div class="analytics-tile">
            <dt class="analytics-label"${tile.note ? ` data-help="${escapeHtml(tile.note)}" tabindex="0"` : ''}>${escapeHtml(tile.label)}</dt>
            <dd class="analytics-value">${escapeHtml(tile.value)}</dd>
            ${tile.trend ? `<dd class="analytics-trend ${tile.trend.direction}"><span role="img" aria-label="${escapeHtml(tile.trend.description)}">${escapeHtml(tile.trend.text)}</span><span class="analytics-trend-caption" aria-hidden="true">${escapeHtml(tile.trend.caption)}</span></dd>` : ''}
            ${tile.comparison ? `<dd class="analytics-note">${escapeHtml(tile.comparison)}</dd>` : ''}
            ${topline ? historyMarkup(tile.label, series) : ''}
          </div>`).join('')}
      </dl>
      ${group.note ? `<p class="analytics-group-note">${escapeHtml(group.note)}</p>` : ''}
      ${topline && history.data ? `<p class="analytics-group-note">${escapeHtml(historyNote)}</p>${historyTable()}` : ''}
    </section>`
}

function render(): void {
  if (!shown) return
  patchContent(viewEl.querySelector('.analytics-groups')!, analyticsGroups(shown.report, shown.baseline).map(groupMarkup).join(''))
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
  tip.replaceChildren(value, detail)
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

function hideCursor(label: string): void {
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
  showCursor(label, Math.round((event.clientX - rect.left) / Math.max(1, rect.width) * (count - 1)))
}

function onPlotKey(event: KeyboardEvent): void {
  const label = plotLabel(event)
  const count = history.data?.periods.length ?? 0
  if (!label || !count) return
  const at = cursors.get(label) ?? count - 1
  const next = event.key === 'ArrowLeft' ? at - 1 : event.key === 'ArrowRight' ? at + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null
  if (next === null) return
  event.preventDefault()
  showCursor(label, next)
}

async function readHistory(bounds: string[]): Promise<void> {
  const generation = ++historyGeneration
  history = { data: null, error: '' }
  cursors.clear()
  try {
    const res = await fetch(organizationUrl(`/api/analytics/history?${new URLSearchParams({ bounds: bounds.join(',') })}`))
    const data = await res.json().catch(() => null)
    if (!res.ok || !Array.isArray(data?.periods)) throw new Error(data?.error || `The past year could not be read (HTTP ${res.status})`)
    if (generation !== historyGeneration) return
    history = { data: data as AnalyticsHistory, error: '' }
  } catch (error) {
    if (generation !== historyGeneration) return
    history = { data: null, error: error instanceof Error ? error.message : String(error) }
  }
  render()
}

async function readAnalytics(): Promise<void> {
  const generation = ++readGeneration
  const groups = viewEl.querySelector<HTMLElement>('.analytics-groups')!
  const quota = viewEl.querySelector<HTMLElement>('.github-quota-section')!
  const day = analyticsDay(dayOffset, dayAnchor)
  shown = null
  void readHistory(analyticsHistoryBounds(dayOffset, dayAnchor))
  viewEl.querySelector('.analytics-date')!.textContent = day.label
  viewEl.querySelector<HTMLButtonElement>('[data-day="1"]')!.disabled = day.isToday
  // The emptied sections keep their space while the next day loads, so
  // GitHub below does not jump up under the loader and back down after.
  const quotaTop = quota.offsetTop
  groups.style.minHeight = ''
  groups.replaceChildren()
  showStatus('')
  viewEl.querySelector<HTMLElement>('.analytics-loader')!.hidden = false
  groups.setAttribute('aria-busy', 'true')
  groups.style.minHeight = `${Math.max(0, quotaTop - quota.offsetTop)}px`
  const read = async (since: string, until: string): Promise<AnalyticsReport> => {
    const query = new URLSearchParams({ since, until })
    const res = await fetch(organizationUrl(`/api/analytics?${query}`))
    const data = await res.json().catch(() => null)
    if (!res.ok || !data) throw new Error(data?.error || `Analytics could not be read (HTTP ${res.status})`)
    return data as AnalyticsReport
  }
  try {
    const [data, baseline] = await Promise.all([
      read(day.since, day.until),
      read(day.baselineSince, day.since),
    ])
    if (generation !== readGeneration) return
    shown = { report: data, baseline }
    render()
    showStatus([organizationErrors(data), organizationErrors(baseline)].filter(Boolean).filter((error, i, all) => all.indexOf(error) === i).join('; '))
  } catch (error) {
    if (generation !== readGeneration) return
    // Numbers from the last day under the next day's name would be wrong.
    groups.innerHTML = ''
    showStatus(error instanceof Error ? error.message : String(error), true)
  } finally {
    if (generation === readGeneration) {
      viewEl.querySelector<HTMLElement>('.analytics-loader')!.hidden = true
      groups.removeAttribute('aria-busy')
      groups.style.minHeight = ''
    }
  }
}

function scheduleMidnightRead(): void {
  clearTimeout(midnightTimer)
  const delay = Date.parse(analyticsDay(0).until) - Date.now()
  midnightTimer = setTimeout(() => {
    void readAnalytics()
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
      if (label && plot && !plot.contains(event.relatedTarget as Node | null) && document.activeElement !== plot) hideCursor(label)
    })
    groups.addEventListener('focusin', (event) => {
      const label = plotLabel(event)
      const count = history.data?.periods.length ?? 0
      if (label && count) showCursor(label, cursors.get(label) ?? count - 1)
    })
    groups.addEventListener('focusout', (event) => {
      const label = plotLabel(event)
      if (label) hideCursor(label)
    })
    groups.addEventListener('keydown', onPlotKey)
    document.addEventListener('visibilitychange', refreshQuota)
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
  quotaGeneration++
  historyGeneration++
  clearInterval(quotaTimer)
  clearTimeout(midnightTimer)
}
