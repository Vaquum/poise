// Analytics — a side panel of headline numbers, opened from the burger menu.
// It offers Current's time ranges and opens on the one Current shows; picking
// another here leaves Current as it is. The numbers come from /api/analytics
// (server/analytics.ts) for the selected account.

import { analyticsGroups, type AnalyticsReport } from './analytics-format'
import { organizationErrors, organizationUrl } from './organizations'
import { TIME_RANGES, currentViewTimeRange, timeRangeWindow, type TimeRange } from './time-range'

let panelEl: HTMLElement | null = null
let range: TimeRange = 'all'
// Each read is numbered so a slow answer for an earlier range or account
// never replaces the one for what is selected now.
let readGeneration = 0

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function buildPanel(): HTMLElement {
  const panel = document.createElement('aside')
  panel.id = 'analytics-panel'
  panel.setAttribute('aria-label', 'Analytics')
  panel.innerHTML = `
    <div class="tp-header"><span class="tp-title">Analytics</span>
      <button class="tp-close" type="button" aria-label="Close analytics">&times;</button></div>
    <div class="tp-body">
      <div class="range-picker analytics-range" role="group" aria-label="Time range">
        ${TIME_RANGES.map((r) => `<button type="button" data-range="${r.key}">${r.label}</button>`).join('')}
      </div>
      <p class="analytics-status st-help" role="status" hidden></p>
      <div class="analytics-groups" aria-live="polite"></div>
      <p class="tp-hint analytics-scope">Counts what Current shows: what you are involved in and what the agent account opened. Per-PR numbers are over the pull requests merged in the range.</p>
    </div>`
  panel.querySelector('.tp-close')!.addEventListener('click', () => closeAnalyticsPanel())
  panel.querySelector('.analytics-range')!.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-range]')
    if (!button || button.dataset.range === range) return
    range = button.dataset.range as TimeRange
    void readAnalytics()
  })
  return panel
}

function showRange(panel: HTMLElement): void {
  panel.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((button) => {
    const active = button.dataset.range === range
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
}

function showStatus(panel: HTMLElement, message: string, isError = false): void {
  const status = panel.querySelector<HTMLElement>('.analytics-status')!
  status.textContent = message
  status.hidden = !message
  status.classList.toggle('st-help-error', isError)
}

function renderReport(panel: HTMLElement, report: AnalyticsReport): void {
  panel.querySelector('.analytics-groups')!.innerHTML = analyticsGroups(report).map((group) => `
    <section class="analytics-group">
      <h3 class="tp-group-label">${escapeHtml(group.label)}</h3>
      <dl class="analytics-tiles">
        ${group.tiles.map((tile) => `
          <div class="analytics-tile">
            <dt class="analytics-label">${escapeHtml(tile.label)}</dt>
            <dd class="analytics-value">${escapeHtml(tile.value)}</dd>
            ${tile.note ? `<dd class="analytics-note">${escapeHtml(tile.note)}</dd>` : ''}
          </div>`).join('')}
      </dl>
      ${group.note ? `<p class="analytics-group-note">${escapeHtml(group.note)}</p>` : ''}
    </section>`).join('')
}

async function readAnalytics(): Promise<void> {
  const panel = panelEl
  if (!panel) return
  const generation = ++readGeneration
  showRange(panel)
  showStatus(panel, 'Reading…')
  panel.querySelector('.analytics-groups')!.classList.add('is-stale')
  const bounds = timeRangeWindow(range)
  const query = new URLSearchParams()
  if (bounds.since) query.set('since', bounds.since)
  if (bounds.until) query.set('until', bounds.until)
  const path = query.toString() ? `/api/analytics?${query}` : '/api/analytics'
  try {
    const res = await fetch(organizationUrl(path))
    const data = await res.json().catch(() => null)
    if (generation !== readGeneration) return
    if (!res.ok || !data) throw new Error(data?.error || `Analytics could not be read (HTTP ${res.status})`)
    renderReport(panel, data as AnalyticsReport)
    showStatus(panel, organizationErrors(data))
  } catch (error) {
    if (generation !== readGeneration) return
    // Numbers from the last range under the next range's name would be wrong.
    panel.querySelector('.analytics-groups')!.innerHTML = ''
    showStatus(panel, error instanceof Error ? error.message : String(error), true)
  } finally {
    if (generation === readGeneration) panel.querySelector('.analytics-groups')!.classList.remove('is-stale')
  }
}

function markPanelClosed(panel: HTMLElement): void {
  panel.setAttribute('inert', '')
  panel.setAttribute('aria-hidden', 'true')
}

function onAnalyticsKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !panelEl?.classList.contains('open') || e.defaultPrevented) return
  e.preventDefault()
  closeAnalyticsPanel()
}

function onOrganizationChanged(): void {
  if (panelEl?.classList.contains('open')) void readAnalytics()
}

export function initAnalytics(): void {
  panelEl = buildPanel()
  // Built closed, and closed means out of the tab order and unannounced.
  markPanelClosed(panelEl)
  document.body.appendChild(panelEl)
  window.addEventListener('poise:organization-filter-changed', onOrganizationChanged)
}

export function openAnalyticsPanel(): void {
  if (!panelEl) return
  range = currentViewTimeRange()
  panelEl.removeAttribute('inert')
  panelEl.removeAttribute('aria-hidden')
  panelEl.classList.add('open')
  document.addEventListener('keydown', onAnalyticsKeydown)
  void readAnalytics()
}

export function closeAnalyticsPanel(): void {
  if (!panelEl) return
  if (panelEl.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur()
  readGeneration++
  panelEl.classList.remove('open')
  markPanelClosed(panelEl)
  document.removeEventListener('keydown', onAnalyticsKeydown)
}

export function toggleAnalyticsPanel(): void {
  if (!panelEl) return
  if (panelEl.classList.contains('open')) closeAnalyticsPanel()
  else openAnalyticsPanel()
}
