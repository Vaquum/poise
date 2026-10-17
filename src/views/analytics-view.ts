import { patchContent } from '../dom-patch'
// Analytics — a view of its own, opened from the burger menu rather than the
// top nav: the selected day's productivity topline, then the numbers per
// merged pull request, then live GitHub API quota. Independent of Current's
// filters.
import { analyticsGroups, type AnalyticsReport } from '../analytics-format'
import { analyticsDay } from '../analytics-day'
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
let quotaTimer: ReturnType<typeof setInterval> | undefined

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

function renderReport(report: AnalyticsReport, baseline: AnalyticsReport): void {
  patchContent(viewEl.querySelector('.analytics-groups')!, analyticsGroups(report, baseline).map((group) => `
    <section class="analytics-group" data-group="${group.id}" aria-labelledby="analytics-${group.id}">
      <h2 class="tp-group-label" id="analytics-${group.id}" data-help="${escapeHtml(group.help)}" tabindex="0">${escapeHtml(group.label)}</h2>
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
  const generation = ++readGeneration
  const groups = viewEl.querySelector<HTMLElement>('.analytics-groups')!
  const quota = viewEl.querySelector<HTMLElement>('.github-quota-section')!
  const day = analyticsDay(dayOffset, dayAnchor)
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
    renderReport(data, baseline)
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
  clearInterval(quotaTimer)
  clearTimeout(midnightTimer)
}
