import { patchContent } from './dom-patch'
// Daily analytics, independently of Current's filters.
import { analyticsGroups, type AnalyticsReport } from './analytics-format'
import { analyticsDay } from './analytics-day'
import { organizationErrors, organizationUrl } from './organizations'
import { effectiveTimezone } from './config'
import { GITHUB_QUOTA_REFRESH_MS, quotaRiskTone, type GithubQuotaReport } from './github-quota'

let panelEl: HTMLElement | null = null
let dayOffset = 0
let dayAnchor = new Date()
let midnightTimer: ReturnType<typeof setTimeout> | undefined
// Each read is numbered so a slow answer for an earlier range or account
// never replaces the one for what is selected now.
let readGeneration = 0
let quotaGeneration = 0
let quotaTimer: ReturnType<typeof setInterval> | undefined

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function buildPanel(): HTMLElement {
  const panel = document.createElement('aside')
  panel.id = 'analytics-panel'
  panel.setAttribute('aria-label', 'Analytics')
  panel.innerHTML = `
    <div class="tp-header"><span class="tp-title" data-help="Counts your work on the selected day. Per-PR numbers cover pull requests merged that day." tabindex="0">Analytics</span></div>
    <div class="tp-body">
      <nav class="analytics-day" aria-label="Analytics day">
        <button type="button" class="analytics-day-step" data-day="-1" aria-label="Previous day">←</button>
        <span class="analytics-date" aria-live="polite"></span>
        <button type="button" class="analytics-day-step" data-day="1" aria-label="Next day">→</button>
      </nav>
      <div class="analytics-loader loader" role="status" aria-label="Loading analytics" hidden><span></span><span></span><span></span></div>
      <p class="analytics-status st-help" role="status" hidden></p>
      <div class="analytics-groups" aria-live="polite"></div>
      <section class="github-quota-section" aria-label="GitHub API quota">
        <h3 class="tp-group-label">GitHub API · Live</h3>
        <div class="github-quota-accounts" aria-live="polite"></div>
        <p class="analytics-group-note">Estimated risk of running out before reset, assuming recent usage continues. Collecting samples takes at least 15 seconds. Live quotas do not follow the selected day or organization.</p>
      </section>
    </div>`
  panel.querySelector('.analytics-day')!.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-day]')
    if (!button || button.disabled) return
    dayOffset += Number(button.dataset.day)
    void readAnalytics()
  })
  return panel
}

async function readQuota(): Promise<void> {
  const panel = panelEl
  if (!panel) return
  const generation = ++quotaGeneration
  const content = panel.querySelector<HTMLElement>('.github-quota-accounts')!
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
      <article class="github-quota-account">
        <h4>${escapeHtml(account.login)} <span>${escapeHtml(account.roles.join(' + '))}</span></h4>
        ${account.error ? `<p class="st-help st-help-error">${escapeHtml(account.error)}</p>` : account.buckets.map((bucket) => {
          const minutes = Math.max(0, (Date.parse(bucket.resetAt) - now) / 60_000)
          const risk = minutes > 0 ? bucket.riskPercent : null
          return `<div class="github-quota-bucket">
            <h5>${escapeHtml(bucket.label)}</h5>
            <p class="github-quota-usage">${number(bucket.used)} / ${number(bucket.limit)} used <span>· ${number(bucket.remaining)} left</span></p>
            ${bucket.limit === 0 ? '<p class="analytics-note">Unavailable for this account</p>' : `
              <progress max="${bucket.limit}" value="${bucket.used}" aria-label="${escapeHtml(bucket.label)} quota used"></progress>
              <p class="analytics-note">Reset ${escapeHtml(time(bucket.resetAt))} · ${minutes.toFixed(1)} min left</p>
              <p class="analytics-note">${bucket.perMinute === null ? 'Collecting usage samples…' : `${number(Math.round(bucket.perMinute * 10) / 10)} / min used · ${(bucket.remaining / Math.max(minutes, 1 / 60)).toFixed(1)} / min available`}</p>
              <p class="github-quota-risk ${quotaRiskTone(risk)}">${risk === null ? minutes === 0 ? 'Awaiting reset refresh' : 'Risk: collecting samples…' : `${risk}% estimated risk${bucket.remaining === 0 ? ' · Exhausted' : ''}`}</p>
            `}
          </div>`
        }).join('')}
        ${account.checkedAt ? `<p class="analytics-group-note">Checked ${escapeHtml(time(account.checkedAt))}</p>` : ''}
      </article>`).join('') : '<p class="analytics-note">Set your GitHub user and automation accounts in Settings → General.</p>')
  } catch (error: unknown) {
    if (generation !== quotaGeneration) return
    content.textContent = error instanceof Error ? error.message : String(error)
    content.classList.add('st-help-error')
  }
}

function refreshQuota(): void {
  if (document.visibilityState === 'visible' && panelEl?.classList.contains('open')) void readQuota()
}

function showStatus(panel: HTMLElement, message: string, isError = false): void {
  const status = panel.querySelector<HTMLElement>('.analytics-status')!
  status.textContent = message
  status.hidden = !message
  status.classList.toggle('st-help-error', isError)
}

function renderReport(panel: HTMLElement, report: AnalyticsReport, baseline: AnalyticsReport): void {
  patchContent(panel.querySelector('.analytics-groups')!, analyticsGroups(report, baseline).map((group) => `
    <section class="analytics-group">
      <h3 class="tp-group-label">${escapeHtml(group.label)}</h3>
      <dl class="analytics-tiles">
        ${group.tiles.map((tile) => `
          <div class="analytics-tile">
            <dt class="analytics-label"${tile.note ? ` data-help="${escapeHtml(tile.note)}" tabindex="0"` : ''}>${escapeHtml(tile.label)}</dt>
            <dd class="analytics-value">${escapeHtml(tile.value)}</dd>
            ${tile.trend ? `<dd class="analytics-trend ${tile.trend.direction}"><span role="img" aria-label="${escapeHtml(tile.trend.description)}">${escapeHtml(tile.trend.text)}</span><span class="analytics-trend-caption" aria-hidden="true">${escapeHtml(tile.trend.caption)}</span></dd>` : ''}
            ${tile.comparison ? `<dd class="analytics-note">${escapeHtml(tile.comparison)}</dd>` : ''}
          </div>`).join('')}
      </dl>
      ${group.note ? `<p class="analytics-group-note">${escapeHtml(group.note)}</p>` : ''}
    </section>`).join(''))
}

async function readAnalytics(): Promise<void> {
  const panel = panelEl
  if (!panel) return
  const generation = ++readGeneration
  const groups = panel.querySelector<HTMLElement>('.analytics-groups')!
  const day = analyticsDay(dayOffset, dayAnchor)
  panel.querySelector('.analytics-date')!.textContent = day.label
  panel.querySelector<HTMLButtonElement>('[data-day="1"]')!.disabled = day.isToday
  groups.replaceChildren()
  showStatus(panel, '')
  panel.querySelector<HTMLElement>('.analytics-loader')!.hidden = false
  groups.setAttribute('aria-busy', 'true')
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
    renderReport(panel, data, baseline)
    showStatus(panel, [organizationErrors(data), organizationErrors(baseline)].filter(Boolean).filter((error, i, all) => all.indexOf(error) === i).join('; '))
  } catch (error) {
    if (generation !== readGeneration) return
    // Numbers from the last range under the next range's name would be wrong.
    groups.innerHTML = ''
    showStatus(panel, error instanceof Error ? error.message : String(error), true)
  } finally {
    if (generation === readGeneration) {
      panel.querySelector<HTMLElement>('.analytics-loader')!.hidden = true
      groups.removeAttribute('aria-busy')
    }
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
  document.addEventListener('visibilitychange', refreshQuota)
}

function scheduleMidnightRead(): void {
  clearTimeout(midnightTimer)
  const delay = Date.parse(analyticsDay(0).until) - Date.now()
  midnightTimer = setTimeout(() => {
    void readAnalytics()
    scheduleMidnightRead()
  }, delay + 10)
}

export function openAnalyticsPanel(): void {
  if (!panelEl) return
  window.dispatchEvent(new CustomEvent('poise:panel-opening', { detail: { id: panelEl.id } }))
  dayOffset = 0
  dayAnchor = new Date()
  scheduleMidnightRead()
  panelEl.removeAttribute('inert')
  panelEl.removeAttribute('aria-hidden')
  panelEl.classList.add('open')
  panelEl.querySelector('.github-quota-accounts')!.textContent = 'Reading live quota…'
  clearInterval(quotaTimer)
  quotaTimer = setInterval(refreshQuota, GITHUB_QUOTA_REFRESH_MS)
  document.addEventListener('keydown', onAnalyticsKeydown)
  void readAnalytics()
  void readQuota()
}

export function closeAnalyticsPanel(): void {
  if (!panelEl) return
  if (panelEl.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur()
  readGeneration++
  quotaGeneration++
  clearInterval(quotaTimer)
  clearTimeout(midnightTimer)
  panelEl.classList.remove('open')
  markPanelClosed(panelEl)
  document.removeEventListener('keydown', onAnalyticsKeydown)
}

export function toggleAnalyticsPanel(): void {
  if (!panelEl) return
  if (panelEl.classList.contains('open')) closeAnalyticsPanel()
  else openAnalyticsPanel()
}
