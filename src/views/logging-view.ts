import { effectiveTimezone, midnightInZone } from '../config'
import { patchContent } from '../dom-patch'
import { TIME_RANGES, isTimeRange, timeRangeWindow, type TimeRange } from '../time-range'
import {
  LOGGING_LEVELS, LOGGING_SOURCES, LoggingApiError, loggingAccess, loggingCallId, loggingErrorBounds, loggingEvent, loggingExport, loggingHealth,
  loggingHref, loggingPage, loggingParameters, loggingPullRequest, parseLoggingLink, subscribeDiagnosticRefresh,
  type LoggingAccess, type LoggingEvent, type LoggingHealth, type LoggingLink, type LoggingPage, type LoggingQuery,
} from '../logging'
import { readLoggingTime } from '../../gateway/src/diagnostics/query-time'

const STORAGE = 'poise-logging-filters'
const EXACT = [
  ['component', 'Component'], ['workspace', 'Workspace'], ['account', 'Account'], ['repository', 'Repository'],
  ['callId', 'Call ID'], ['correlationId', 'Correlation ID'], ['incidentId', 'Incident ID'],
] as const
type Exact = typeof EXACT[number][0]
type Preferences = Record<Exact, string> & { severities: Array<typeof LOGGING_LEVELS[number]>; time: TimeRange | 'custom'; from: string; to: string; source: string; search: string; scope: 'workspace' | 'instance' }
interface Related { loading: boolean; events: LoggingPage['events']; total: number; cursor: string | null; history: Array<string | null>; page: number; error: string; correlation: boolean; first: { events: LoggingPage['events']; total: number; cursor: string | null } | null }

const defaults = (): Preferences => ({ component: '', workspace: '', account: '', repository: '', callId: '', correlationId: '', incidentId: '',
  severities: [...LOGGING_LEVELS], time: 'all', from: '', to: '', source: '', search: '', scope: 'workspace' })
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
const CHEVRON = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const absent = (value: unknown) => value === null || value === undefined || value === ''

let view: HTMLElement
let initialized = false
let active = false
let preferences = defaults()
let customDraft: { from: string; to: string } | null = null
let access: LoggingAccess | null = null
let page: LoggingPage | null = null
let firstSnapshot: { page: LoggingPage; at: number } | null = null
let pageIndex = 0
let cursors: Array<string | null> = [null]
let applied: LoggingQuery | null = null
let health: LoggingHealth | null = null
let linked: LoggingEvent | null = null
let link: LoggingLink | null = null
let linkMessage = ''
let linkFailure: LoggingApiError | null = null
let linkBounds: LoggingPage['bounds'] | null = null
let mountedSearch = ''
let preferenceWarning = ''
let message = ''
let healthMessage = ''
let stale = false
let loading = false
let lastSuccess: number | null = null
let newCount = 0
let rangeChanged = false
let generation = 0
let retryAt = 0
let failures = 0
let debounce: ReturnType<typeof setTimeout> | null = null
let stopTick: (() => void) | null = null
const requests = new Set<AbortController>()
const expanded = new Set<string>()
const related = new Map<string, Related>()
let formatter: { zone: string; value: Intl.DateTimeFormat } | null = null

function date(value: string | null): string {
  if (!value) return 'Not recorded'
  const zone = effectiveTimezone()
  if (formatter?.zone !== zone) formatter = { zone, value: new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }
  return formatter.value.format(new Date(value))
}

function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE)
    if (!raw) return defaults()
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved filters')
    const saved = value as Record<string, unknown>
    const next = defaults()
    for (const key of [...EXACT.map(([key]) => key), 'from', 'to', 'source', 'search'] as const) {
      if (saved[key] !== undefined && (typeof saved[key] !== 'string' || String(saved[key]).length > (key === 'search' ? 256 : 512))) throw new Error('Invalid saved filter')
      if (typeof saved[key] === 'string') next[key] = saved[key]
    }
    if (!Array.isArray(saved.severities) || !saved.severities.every((level) => LOGGING_LEVELS.includes(level))) throw new Error('Invalid saved severities')
    next.severities = LOGGING_LEVELS.filter((level) => (saved.severities as unknown[]).includes(level))
    if (!isTimeRange(saved.time) && saved.time !== 'custom') throw new Error('Invalid saved range')
    next.time = saved.time
    if (saved.scope !== 'workspace' && saved.scope !== 'instance') throw new Error('Invalid saved scope')
    next.scope = saved.scope
    return next
  } catch {
    preferenceWarning = 'Saved filters were invalid or unreadable; default filters are shown.'
    return defaults()
  }
}

function persist(value = preferences): void {
  try { localStorage.setItem(STORAGE, JSON.stringify(value)) }
  catch { preferenceWarning = 'These filter choices could not be saved in this browser.' }
}

function query(): LoggingQuery {
  const next: LoggingQuery = { severities: [...preferences.severities], scope: preferences.scope, limit: 50 }
  for (const [key] of EXACT) if (preferences[key] !== '') next[key] = preferences[key]
  if (preferences.source) next.source = preferences.source
  if (preferences.search) next.search = preferences.search
  if (preferences.time === 'custom') {
    if (preferences.from) next.from = readLoggingTime(preferences.from)
    if (preferences.to) next.to = readLoggingTime(preferences.to)
    if (!next.from && !next.to) throw new Error('Enter at least one zoned time for a custom interval.')
    if (next.from && next.to && next.from >= next.to) throw new Error('From must be before To.')
  } else {
    const range = timeRangeWindow(preferences.time)
    next.from = range.since; next.to = range.until
    if (preferences.time === 'today') next.to = midnightInZone(1).toISOString()
    if (preferences.time === 'week') {
      const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: effectiveTimezone() }).format(new Date())
      const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(day)
      if (index < 0) throw new Error('The configured civil week could not be read.')
      next.to = midnightInZone(7 - index).toISOString()
    }
  }
  return next
}

function invalidate(): number {
  generation++
  for (const request of requests) request.abort()
  requests.clear()
  for (const state of related.values()) if (state.loading) { state.loading = false; state.error = 'The related read was cancelled; request it again.' }
  if (debounce) clearTimeout(debounce)
  debounce = null
  loading = false
  return generation
}
const current = (mine: number) => active && mine === generation
function controller(): AbortController { const request = new AbortController(); requests.add(request); return request }
function failure(error: unknown): LoggingApiError {
  return error instanceof LoggingApiError ? error : new LoggingApiError(503, 'logging_unavailable', error instanceof Error ? error.message : 'The diagnostic query service is unavailable.')
}
function clearLinkUrl(): void {
  const url = new URL(location.href)
  for (const key of ['event', 'incident', 'from', 'to']) url.searchParams.delete(key)
  history.replaceState(null, '', url)
  link = null; linked = null; linkFailure = null; linkBounds = null; linkMessage = ''; mountedSearch = location.search
}
function denied(): void { page = null; firstSnapshot = null; linked = null; health = null; access = null; related.clear(); expanded.clear(); newCount = 0 }

function syncPolling(): void {
  const wanted = active && !document.hidden && pageIndex === 0 && !!page && !linkFailure
  if (wanted && !stopTick) stopTick = subscribeDiagnosticRefresh(() => { void poll() })
  if (!wanted && stopTick) { stopTick(); stopTick = null }
}

function field(label: string, value: unknown): string {
  return `<div><dt>${escape(label)}</dt><dd>${escape(absent(value) ? 'Not recorded' : typeof value === 'object' ? JSON.stringify(value) : value)}</dd></div>`
}
function detail(event: LoggingEvent): string {
  const pr = loggingPullRequest(event)
  const settings = typeof event.context.settings === 'string' && ['general', 'models', 'accounts', 'publishing', 'admin'].includes(event.context.settings) ? event.context.settings : null
  const links = [event.callId && loggingCallId(event.callId) ? `<button type="button" data-action="call" data-call="${event.callId}">Open Caller run in Swarm</button>` : '',
    pr ? `<a href="${escape(pr)}" target="_blank" rel="noopener noreferrer">Open pull request</a>` : '',
    settings ? `<button type="button" data-action="settings" data-settings="${settings}">Open Settings</button>` : ''].filter(Boolean).join(' ')
  const pre = (label: string, value: string | null) => `<section class="logging-evidence"><h3 class="tp-group-label">${label}</h3><pre class="agent-response-body">${escape(absent(value) ? 'Not recorded' : value)}</pre></section>`
  const r = related.get(event.id)
  const relatedMarkup = r ? `<p class="st-help" role="status">${escape(r.loading ? 'Loading related diagnostics…' : r.error || `${r.total.toLocaleString()} matching retained events · related snapshot`)}</p>
    <ul class="logging-related-list">${r.events.map((entry) => `<li><button type="button" data-action="related-event" data-event="${entry.id}">${escape(date(entry.eventTime ?? entry.ingestedAt))} · ${escape(entry.message)}</button></li>`).join('')}</ul>
    <div class="range-picker" role="group" aria-label="Related pages"><button type="button" data-action="related-previous" data-row="${event.id}" data-focus="related-previous-${event.id}" ${r.page === 0 || r.loading ? 'disabled' : ''}>Previous</button><button type="button" data-action="related-next" data-row="${event.id}" data-focus="related-next-${event.id}" ${!r.cursor || r.loading ? 'disabled' : ''}>Next 20</button></div>` : ''
  return `${event.truncated ? '<p class="st-help st-help-error">Evidence is truncated; omitted details are not retained.</p>' : ''}
    <div class="range-picker logging-evidence-links" role="group" aria-label="Diagnostic destinations">${links || '<span class="st-help">No recorded navigation target.</span>'}</div>
    <dl class="logging-facts">${field('Component', event.component)}${field('Operation', event.operation)}${field('Phase', event.phase)}${field('Target', event.target)}
    ${field('Source severity', event.sourceLevel)}${field('Workspace', event.workspace)}${field('Instance', event.instance)}${field('Container', event.container)}${field('Release', event.release)}
    ${field('Source time', event.eventTime ? date(event.eventTime) : null)}${field('Ingestion time', date(event.ingestedAt))}${field('Account', event.account)}${field('Repository', event.repository)}
    ${field('Call ID', event.callId)}${field('Correlation ID', event.correlationId)}${field('Request ID', event.requestId)}${field('Event ID', event.id)}${field('Incident ID', event.incidentId)}
    ${field('Exit code', event.exitCode)}${field('Signal', event.signal)}${field('Errno', event.errno)}${field('Timeout (ms)', event.timeoutMs)}
    ${field('Resource measurement time', typeof event.resources.measuredAt === 'string' ? event.resources.measuredAt : null)}${field('Resource measurement method', event.resources.measurement)}</dl>
    ${pre('Message', event.message)}${pre('Cause chain', event.cause.length ? event.cause.join('\nCaused by: ') : null)}${pre('Stderr · retained redacted evidence', event.stderr)}${pre('Stack', event.stack)}
    ${pre('Context · as recorded', Object.keys(event.context).length ? JSON.stringify(event.context, null, 2) : null)}
    ${pre('Resource facts · recorded units and measurement time', Object.keys(event.resources).length ? JSON.stringify(event.resources, null, 2) : null)}
    <section class="logging-related" aria-label="Related diagnostics"><h3 class="tp-group-label">Related diagnostics</h3><p class="st-help">Selected access scope, severities and time interval. At most 20 events per page.</p>
      <div class="range-picker" role="group" aria-label="Related condition"><button type="button" data-action="related" data-row="${event.id}" data-focus="related-${event.id}" aria-disabled="${!!r?.loading}">${r ? 'Refresh incident' : 'Show incident'}</button>
      ${event.correlationId ? `<button type="button" data-action="correlation" data-row="${event.id}" data-focus="correlation-${event.id}" aria-disabled="${!!r?.loading}">Show correlation</button>` : ''}</div>${relatedMarkup}</section>`
}

function shell(): void {
  view.innerHTML = `<header class="view-header" tabindex="-1" aria-label="Logging filters"><div class="filter-cluster" id="logging-filters">
    <div class="range-picker" role="group" aria-label="Diagnostic severity">${LOGGING_LEVELS.map((level) => `<button type="button" data-level="${level}" aria-pressed="true">${level[0].toUpperCase() + level.slice(1)}</button>`).join('')}</div>
    <div class="range-picker" role="group" aria-label="Diagnostic time range">${[...TIME_RANGES, { key: 'custom', label: 'Custom interval' }].map((range) => `<button type="button" data-time="${range.key}">${range.label}</button>`).join('')}</div>
    <label class="logging-compact">Source<select id="logging-source" class="st-select"><option value="">All sources</option>${LOGGING_SOURCES.map((source) => `<option value="${source}">${source}</option>`).join('')}</select></label>
    <label class="logging-compact" id="logging-scope-label" hidden>Access scope<select id="logging-scope" class="st-select"><option value="workspace">Your workspace</option><option value="instance">Instance diagnostics</option></select></label>
    <div class="search-cluster"><input class="search-input" id="logging-search" type="search" aria-label="Search redacted diagnostics" placeholder="Search diagnostics…" maxlength="256" autocomplete="off" spellcheck="false"><span class="filter-count" id="logging-count"></span></div>
    <div class="range-picker" role="group" aria-label="Diagnostic actions"><button type="button" data-action="refresh" data-focus="refresh">Refresh</button><button type="button" data-action="export" data-focus="export" title="Export a fresh matching retained snapshot">Export NDJSON</button></div>
    </div></header><main>
    <div class="logging-custom" id="logging-custom" hidden><label>From · inclusive, with UTC offset<input id="logging-from" class="st-input" type="text" placeholder="2026-10-19T00:00:00+03:00"></label><label>To · exclusive, with UTC offset<input id="logging-to" class="st-input" type="text" placeholder="2026-10-20T00:00:00+03:00"></label><div class="range-picker"><button type="button" data-action="custom">Apply interval</button></div></div>
    <details class="logging-more"><summary>More filters</summary><div class="logging-exact-fields">${EXACT.map(([key, label]) => `<label>${label}<input class="st-input" id="logging-${key}" data-field="${key}" type="text" maxlength="512" autocomplete="off"></label>`).join('')}</div></details>
    <h1 class="tp-group-label" id="logging-heading" tabindex="-1">Logging</h1>
    <p class="st-help" id="logging-status" role="status" aria-live="polite" tabindex="-1"></p>
    <p class="st-help st-help-error" id="logging-message" role="status" hidden></p>
    <div class="range-picker logging-new" id="logging-new" hidden><button type="button" data-action="new"></button></div>
    <div id="logging-link"></div><div id="logging-health" class="logging-health"></div>
    <div class="logging-table-wrap"><table id="logging-table" aria-label="Retained diagnostic events"><thead><tr><th>Time</th><th>Severity</th><th>Source</th><th>Component</th><th>Target</th><th>Message</th><th>Occurrences</th><th aria-label="Evidence"></th></tr></thead><tbody id="logging-tbody"></tbody></table></div>
    <div id="logging-loader" class="loader" role="status" aria-label="Loading diagnostics" hidden><span></span><span></span><span></span></div>
    <p class="st-help" id="logging-empty" hidden>No matching retained events.</p>
    <div class="logging-pagination"><div class="range-picker" role="group" aria-label="Diagnostic pages"><button type="button" data-action="previous" data-focus="page-previous">Previous</button><button type="button" data-action="next" data-focus="page-next">Next 50</button></div><span class="st-help" id="logging-page"></span></div>
    </main>`
  view.addEventListener('click', onClick)
  view.addEventListener('input', onInput)
  view.addEventListener('change', onChange)
  view.querySelector('#logging-custom')!.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); applyCustom() } })
}

function controls(): void {
  for (const button of view.querySelectorAll<HTMLButtonElement>('[data-level]')) {
    const selected = preferences.severities.some((level) => level === button.dataset.level)
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected))
  }
  for (const button of view.querySelectorAll<HTMLButtonElement>('[data-time]')) {
    const selected = button.dataset.time === preferences.time
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected))
  }
  const source = view.querySelector<HTMLSelectElement>('#logging-source')!
  if (preferences.source && ![...source.options].some((option) => option.value === preferences.source)) source.add(new Option(preferences.source, preferences.source))
  source.value = preferences.source
  view.querySelector<HTMLSelectElement>('#logging-scope')!.value = preferences.scope
  view.querySelector<HTMLElement>('#logging-scope-label')!.hidden = !access?.isAdmin
  for (const key of ['search', ...EXACT.map(([key]) => key)] as const) {
    const input = view.querySelector<HTMLInputElement>('#logging-' + key)!
    if (document.activeElement !== input) input.value = preferences[key]
  }
  view.querySelector<HTMLElement>('#logging-custom')!.hidden = preferences.time !== 'custom'
  for (const key of ['from', 'to'] as const) {
    const input = view.querySelector<HTMLInputElement>('#logging-' + key)!
    if (document.activeElement !== input) input.value = (customDraft ?? preferences)[key]
  }
  for (const action of ['export', 'previous', 'next'] as const) {
    const button = view.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
    button.disabled = !page || action === 'previous' && pageIndex === 0 || action === 'next' && !page.nextCursor
    button.setAttribute('aria-disabled', String(loading || button.disabled))
  }
  view.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.setAttribute('aria-busy', String(loading))
}

function render(): void {
  controls()
  const tbody = view.querySelector<HTMLElement>('#logging-tbody')!
  const focused = document.activeElement instanceof HTMLElement && view.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined
  const anchor = [...tbody.querySelectorAll<HTMLElement>('tr.agent-row')].find((row) => row.getBoundingClientRect().bottom > 100)
  const anchorId = anchor?.dataset.id; const anchorTop = anchor?.getBoundingClientRect().top
  const ids = new Set(page?.events.map((event) => event.id) ?? [])
  for (const id of [...expanded]) if (!ids.has(id) && linked?.id !== id) { expanded.delete(id); related.delete(id) }
  const rows = page?.events.map((event) => {
    const open = expanded.has(event.id)
    return `<tr class="agent-row" data-id="${event.id}"><td class="started-cell"><time datetime="${escape(event.eventTime ?? event.ingestedAt)}" title="${escape((event.eventTime ? 'Source time' : 'Ingestion time; source time not recorded') + ' · ' + effectiveTimezone())}">${escape(date(event.eventTime ?? event.ingestedAt))}</time>${event.eventTime ? '' : '<span class="agent-status-note">Ingested</span>'}</td>
      <td><span class="agent-status ${event.severity === 'warning' ? 'warn' : 'bad'}"><span class="agent-status-label">${event.severity[0].toUpperCase() + event.severity.slice(1)}</span></span></td><td><span class="agent-behavior">${escape(event.source)}</span></td><td>${escape(event.component || '—')}</td><td class="logging-target">${escape(event.target || '—')}</td><td class="logging-summary">${escape(event.message || '—')}</td><td>${event.occurrences.toLocaleString()} retained occurrences</td>
      <td class="action-cell"><button type="button" class="expand-btn${open ? ' open' : ''}" id="logging-expand-${event.id}" data-action="expand" data-row="${event.id}" data-focus="expand-${event.id}" aria-label="Toggle diagnostic evidence" aria-expanded="${open}" aria-controls="logging-detail-${event.id}">${CHEVRON}</button></td></tr>
      ${open ? `<tr class="agent-expand-row" data-expand-for="${event.id}" id="logging-detail-${event.id}"><td colspan="8">${detail(event)}</td></tr>` : ''}`
  }).join('') ?? ''
  patchContent(tbody, rows)
  const status = view.querySelector<HTMLElement>('#logging-status')!
  status.textContent = loading ? (page ? 'Refreshing retained diagnostics…' : 'Loading retained diagnostics…')
    : page ? `${page.total.toLocaleString()} matching retained events${preferences.severities.length ? '' : ' · No severities selected'}${lastSuccess ? ' · Snapshot read ' + date(new Date(lastSuccess).toISOString()) : ''}${stale ? ' · Stale results' : ''}` : linkFailure ? evidenceFailure(linkFailure) : message || 'Diagnostic results have not been read.'
  view.querySelector<HTMLElement>('#logging-count')!.textContent = page ? page.total.toLocaleString() + ' events' : ''
  const note = view.querySelector<HTMLElement>('#logging-message')!
  note.textContent = [message, healthMessage, preferenceWarning].filter(Boolean).join(' '); note.hidden = !note.textContent
  view.querySelector<HTMLElement>('#logging-loader')!.hidden = !loading
  view.querySelector<HTMLElement>('#logging-empty')!.hidden = !page || page.events.length > 0 || loading || !!linkFailure
  view.querySelector<HTMLElement>('#logging-table')!.hidden = !page
  view.querySelector<HTMLElement>('#logging-page')!.textContent = page ? `Page ${pageIndex + 1} · at most 50 events per page` : ''
  const fresh = view.querySelector<HTMLElement>('#logging-new')!
  fresh.hidden = pageIndex !== 0 || !page || (!newCount && !rangeChanged)
  fresh.querySelector('button')!.textContent = rangeChanged ? 'Time range changed · refresh diagnostics' : `${newCount.toLocaleString()} new diagnostics`
  renderLink()
  renderHealth()
  if (focused) {
    const target = view.querySelector<HTMLElement>(`[data-focus="${focused}"]`)
    if (target && !(target instanceof HTMLButtonElement && target.disabled)) target.focus({ preventScroll: true })
    else { status.textContent += ' The focused diagnostic or control is no longer available in this snapshot.'; status.focus({ preventScroll: true }) }
  }
  if (anchorId && anchorTop !== undefined) {
    const next = tbody.querySelector<HTMLElement>(`tr[data-id="${anchorId}"]`)
    if (next) window.scrollBy({ top: next.getBoundingClientRect().top - anchorTop, behavior: 'instant' as ScrollBehavior })
  }
  syncPolling()
}

function evidenceFailure(error: LoggingApiError): string {
  return error.status === 410 ? 'Linked diagnostic evidence has expired.' : error.status === 404 ? 'Linked diagnostic evidence is unavailable.'
    : error.status === 400 ? 'The diagnostic link is invalid.' : error.status === 401 ? 'Sign in to read diagnostic evidence.'
    : error.status === 403 ? 'Diagnostic access is unavailable.' : error.status === 429 ? 'The diagnostic query service is busy.' : 'The diagnostic query service is unavailable.'
}
function renderLink(): void {
  const target = view.querySelector<HTMLElement>('#logging-link')!
  const extra = linked && !page?.events.some((event) => event.id === linked!.id)
  patchContent(target, linkFailure ? `<section class="logging-linked" aria-label="Linked diagnostic state"><h2 class="tp-group-label" tabindex="-1" id="logging-linked-heading">${evidenceFailure(linkFailure)}</h2><p class="st-help">${escape(linkFailure.message)}</p>
    <div class="range-picker"><button type="button" data-action="restore">Browse retained diagnostics</button>${access?.isAdmin && preferences.scope === 'workspace' && linkFailure.status === 404 ? '<button type="button" data-action="link-instance">Use instance scope</button>' : ''}</div></section>`
    : link ? `<section class="logging-linked" aria-label="Linked diagnostic evidence"><h2 class="tp-group-label" tabindex="-1" id="logging-linked-heading">${extra ? 'Linked diagnostic · outside the current page' : 'Linked diagnostic'}</h2><p class="st-help">${escape(linkMessage)}</p><div class="range-picker"><button type="button" data-action="restore">Restore saved filters</button></div>${extra && linked ? detail(linked) : ''}</section>` : '')
}
function renderHealth(): void {
  const target = view.querySelector<HTMLElement>('#logging-health')!
  const bounds = page?.bounds ?? linkBounds ?? health?.bounds
  const sources = health?.collection.sources ?? page?.coverage ?? []
  const partial = sources.filter((source) => source.status !== 'connected')
  const unavailable = health && (health.collection.status !== 'connected' || health.query.status !== 'connected')
  patchContent(target, `<p class="st-help">${bounds ? `Retention boundary: ${escape(date(bounds.retentionAfter))}. Retained source times: ${escape(bounds.from ? date(bounds.from) : 'Not recorded')} – ${escape(bounds.to ? date(bounds.to) : 'Not recorded')}.` : 'Retention bounds have not been read.'} Rows use ${escape(effectiveTimezone())}.${health ? ' Collection health read ' + escape(date(health.collection.checkedAt)) + '.' : ''}</p>
    ${partial.length || unavailable ? `<details class="logging-coverage" open><summary>Partial or unavailable collection coverage</summary><p class="st-help">${health ? `Collection: ${escape(health.collection.status)} · Query service: ${escape(health.query.status)}${health.collection.lossObserved ? ' · Collection loss has been observed' : ''}.` : 'Source coverage is incomplete.'}</p><ul>${partial.map((source) => `<li>${escape(source.source)}: ${escape(source.status)}${source.error ? ' · ' + escape(source.error) : ''}${source.gaps.length ? ` · ${source.gaps.length} retained coverage gaps` : ''}</li>`).join('')}</ul></details>` : ''}`)
}

async function readHealth(mine: number): Promise<void> {
  if (!access || !current(mine)) return
  const request = controller()
  try { const value = await loggingHealth(access, preferences.scope, request.signal); if (current(mine)) { health = value; healthMessage = ''; render() } }
  catch (error) {
    if (current(mine) && !request.signal.aborted) {
      const problem = failure(error)
      healthMessage = `Collection health could not be read: ${problem.message}`
      if (problem.status === 401 || problem.status === 403) denied()
      render()
    }
  } finally { requests.delete(request) }
}

async function ensureAccess(mine: number): Promise<boolean> {
  if (access) return true
  const request = controller()
  try {
    const value = await loggingAccess(request.signal)
    if (!current(mine)) return false
    access = value
    if (!access.isAdmin && preferences.scope === 'instance') { preferences.scope = 'workspace'; message = 'Instance access is unavailable; your workspace is selected.' }
    return true
  } finally { requests.delete(request) }
}

async function loadPage(cursor: string | null = null, fresh = true, focusTarget = false, targetPage = pageIndex): Promise<void> {
  const mine = invalidate()
  loading = true; stale = false; message = ''
  render()
  const request = controller()
  try {
    if (!await ensureAccess(mine) || !access) return
    let candidate: LoggingQuery
    try { candidate = fresh ? query() : applied! }
    catch (error) { throw new LoggingApiError(400, 'invalid_logging_query', error instanceof Error ? error.message : 'Invalid diagnostic filters.') }
    const value = await loggingPage(access, { ...candidate, ...(cursor ? { cursor } : {}) }, request.signal)
    if (!current(mine)) return
    if (fresh && applied && loggingParameters(applied).toString() !== loggingParameters(candidate).toString()) related.clear()
    page = value; applied = candidate; lastSuccess = Date.now(); loading = false; linkFailure = null
    if (fresh) { firstSnapshot = { page: value, at: lastSuccess }; cursors = [null]; pageIndex = 0; newCount = 0; rangeChanged = false; failures = 0; retryAt = 0 }
    else pageIndex = targetPage
    render()
    const targetId = linked?.id
    if (focusTarget && targetId) requestAnimationFrame(() => {
      if (!current(mine)) return
      ;(view.querySelector<HTMLElement>(`#logging-expand-${targetId}`) ?? view.querySelector<HTMLElement>('#logging-linked-heading'))?.focus({ preventScroll: true })
    })
    void readHealth(mine)
  } catch (error) {
    if (!current(mine) || request.signal.aborted) return
    const problem = failure(error)
    message = problem.status === 400 ? `Invalid diagnostic filters: ${problem.message}` : problem.message
    stale = !!page
    if (problem.status === 401 || problem.status === 403) { denied(); stale = false }
  } finally { requests.delete(request); if (current(mine)) { loading = false; render() } }
}

async function initialRead(): Promise<void> {
  const mine = invalidate()
  customDraft = null
  loading = true; page = null; firstSnapshot = null; health = null; healthMessage = ''; applied = null; linked = null; link = null; linkFailure = null; linkBounds = null; message = ''; newCount = 0; pageIndex = 0; cursors = [null]; mountedSearch = location.search
  const request = controller()
  try {
    try { link = parseLoggingLink(location.search) }
    catch (error) { throw new LoggingApiError(400, 'invalid_logging_link', error instanceof Error ? error.message : 'Invalid diagnostic link.') }
    render()
    if (!await ensureAccess(mine) || !access) return
    if (link?.event || link?.incident) {
      let value: LoggingEvent | undefined
      if (link.event) {
        const result = await loggingEvent(access, link.event, preferences.scope, request.signal)
        value = result.event; linkBounds = result.bounds
      } else {
        const result = await loggingPage(access, { scope: preferences.scope, incidentId: link.incident, limit: 1 }, request.signal)
        value = result.events[0]; linkBounds = result.bounds
      }
      if (!current(mine)) return
      if (!value) throw new LoggingApiError(404, 'logging_event_unavailable', 'No permitted retained evidence is available for this incident.')
      linked = value
      const at = Date.parse(value.eventTime ?? value.ingestedAt)
      let from = link.from ?? new Date(at - 3_600_000).toISOString()
      let to = link.to ?? new Date(at + 3_600_000).toISOString()
      const widened = Date.parse(from) > at || Date.parse(to) <= at
      if (Date.parse(from) > at) from = new Date(at - 3_600_000).toISOString()
      if (Date.parse(to) <= at) to = new Date(at + 3_600_000).toISOString()
      const scope = preferences.scope
      preferences = { ...defaults(), scope, time: 'custom', from, to, incidentId: link.incident ?? '' }
      expanded.add(value.id)
      linkMessage = widened ? 'The linked interval was widened visibly to include the retained diagnostic. Saved filters are available below.' : 'The linked interval and all three severities are applied. Saved filters are available below.'
    } else if (link?.from || link?.to) {
      preferences.time = 'custom'; preferences.from = link.from ?? ''; preferences.to = link.to ?? ''; linkMessage = 'The linked interval is applied.'
    }
    if (current(mine)) void loadPage(null, true, !!linked)
  } catch (error) {
    if (!current(mine) || request.signal.aborted) return
    linkFailure = failure(error)
    linkBounds ??= loggingErrorBounds(linkFailure)
    loading = false; render()
    requestAnimationFrame(() => { if (current(mine)) view.querySelector<HTMLElement>('#logging-linked-heading')?.focus({ preventScroll: true }) })
    if (access) void readHealth(mine)
  } finally { requests.delete(request) }
}

async function poll(): Promise<void> {
  if (!active || document.hidden || pageIndex !== 0 || !page || !applied || !access || requests.size || loading || Date.now() < retryAt) return
  try { if (loggingParameters(query()).toString() !== loggingParameters(applied).toString()) { rangeChanged = true; render(); return } }
  catch (error) { message = 'Diagnostic filters need correction: ' + failure(error).message; render(); return }
  const mine = generation; const request = controller()
  try {
    const value = await loggingPage(access, { ...applied, after: page.watermark, limit: 1 }, request.signal)
    if (!current(mine)) return
    newCount = value.total; failures = 0; retryAt = 0
    if (stale) message = 'The earlier refresh failed; these results remain a previous snapshot. Refresh or apply new diagnostics to update.'
    render()
    void readHealth(mine)
  } catch (error) {
    if (current(mine) && !request.signal.aborted) {
      const problem = failure(error)
      stale = true; message = 'Refresh unavailable; previous results are stale. ' + problem.message
      retryAt = Date.now() + Math.min(120_000, 15_000 * 2 ** Math.min(++failures, 3))
      if (problem.status === 401 || problem.status === 403) denied()
      render()
    }
  } finally { requests.delete(request) }
}

function refreshCurrent(): void {
  if (link || linkFailure) void initialRead()
  else void loadPage()
}

function filtersChanged(wait = false): void {
  invalidate(); clearLinkUrl(); page = null; firstSnapshot = null; linked = null; health = null; expanded.clear(); related.clear(); pageIndex = 0; message = ''; persist(); render()
  if (wait) debounce = setTimeout(() => { debounce = null; void loadPage() }, 250)
  else void loadPage()
}
function applyCustom(): void {
  preferences.time = 'custom'; preferences.from = view.querySelector<HTMLInputElement>('#logging-from')!.value; preferences.to = view.querySelector<HTMLInputElement>('#logging-to')!.value
  customDraft = null
  filtersChanged()
}

async function readRelated(id: string, correlation = false, nextPage = 0, fresh = true): Promise<void> {
  if (!access || !applied) return
  const event = page?.events.find((event) => event.id === id) ?? (linked?.id === id ? linked : null)
  if (!event || related.get(id)?.loading) return
  const previous = related.get(id)
  const same = previous?.correlation === correlation ? previous : null
  const state: Related = !fresh && same ? same : { loading: false, events: same?.events ?? [], total: same?.total ?? 0, cursor: null, history: [null], page: 0, error: '', correlation, first: null }
  if (!fresh && nextPage === 0 && state.first) { state.events = state.first.events; state.total = state.first.total; state.cursor = state.first.cursor; state.page = 0; state.error = ''; render(); return }
  if (nextPage > state.page && state.cursor) state.history[nextPage] = state.cursor
  state.loading = true; state.error = ''; related.set(id, state); render()
  const mine = generation; const request = controller()
  try {
    const value = await loggingPage(access, { scope: applied.scope, severities: applied.severities, from: applied.from, to: applied.to,
      ...(correlation ? { correlationId: event.correlationId! } : { incidentId: event.incidentId }), limit: 20, ...(state.history[nextPage] ? { cursor: state.history[nextPage]! } : {}) }, request.signal)
    if (!current(mine) || related.get(id) !== state) return
    state.events = value.events; state.total = value.total; state.cursor = value.nextCursor; state.page = nextPage
    if (nextPage === 0) state.first = { events: value.events, total: value.total, cursor: value.nextCursor }
  } catch (error) { if (current(mine) && !request.signal.aborted) state.error = (state.events.length ? 'Previous related snapshot retained; the new read failed. ' : '') + failure(error).message }
  finally { requests.delete(request); if (current(mine) && related.get(id) === state) { state.loading = false; render() } }
}

async function exportCurrent(): Promise<void> {
  if (!access || !page) return
  const mine = generation; const request = controller()
  const button = view.querySelector<HTMLButtonElement>('[data-action="export"]')!
  button.setAttribute('aria-busy', 'true')
  try {
    const filters = { ...applied! }
    delete filters.cursor; delete filters.after; delete filters.limit
    const blob = await loggingExport(access, filters, request.signal)
    if (!current(mine)) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'poise-diagnostics.ndjson'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    message = 'A fresh bounded snapshot was exported. Its metadata records any truncation and resume cursor.'; render()
  } catch (error) { if (current(mine) && !request.signal.aborted) { message = 'Export failed; no complete download was produced. ' + failure(error).message; render() } }
  finally { requests.delete(request); button.removeAttribute('aria-busy') }
}

function openTarget(id: string): void {
  const href = loggingHref({ event: id })
  if (!href) return
  history.pushState(null, '', href)
  void initialRead()
}
function instanceLink(): void {
  if (!access?.isAdmin) return
  const saved = loadPreferences(); saved.scope = 'instance'; persist(saved); preferences.scope = 'instance'
  void initialRead()
}
function onClick(event: Event): void {
  const button = (event.target as Element).closest<HTMLButtonElement>('button')
  if (!button || button.disabled) return
  if (button.getAttribute('aria-disabled') === 'true') return
  const level = LOGGING_LEVELS.find((level) => level === button.dataset.level)
  if (level) { preferences.severities = preferences.severities.includes(level) ? preferences.severities.filter((value) => value !== level) : LOGGING_LEVELS.filter((value) => value === level || preferences.severities.includes(value)); filtersChanged(); return }
  if (button.dataset.time) {
    customDraft = null
    const time = button.dataset.time
    if (time === 'custom') {
      preferences.time = 'custom'; preferences.from ||= applied?.from ?? new Date(Date.now() - 3_600_000).toISOString(); preferences.to ||= applied?.to ?? new Date().toISOString()
    } else if (isTimeRange(time)) preferences.time = time
    filtersChanged(); return
  }
  const id = button.dataset.row
  switch (button.dataset.action) {
    case 'expand': if (id) { if (expanded.has(id)) { expanded.delete(id); related.delete(id) } else expanded.add(id); render() } break
    case 'refresh': case 'new': refreshCurrent(); break
    case 'export': if (button.getAttribute('aria-busy') !== 'true') void exportCurrent(); break
    case 'custom': applyCustom(); break
    case 'next': if (page?.nextCursor) { cursors[pageIndex + 1] = page.nextCursor; void loadPage(page.nextCursor, false, false, pageIndex + 1) } break
    case 'previous': if (pageIndex > 0) {
      const previous = pageIndex - 1
      if (previous === 0 && firstSnapshot) { const mine = invalidate(); pageIndex = 0; page = firstSnapshot.page; lastSuccess = firstSnapshot.at; message = ''; stale = false; render(); void readHealth(mine) }
      else void loadPage(cursors[previous], false, false, previous)
    } break
    case 'related': if (id) void readRelated(id); break
    case 'correlation': if (id) void readRelated(id, true); break
    case 'related-next': if (id) { const r = related.get(id); if (r?.cursor) void readRelated(id, r.correlation, r.page + 1, false) } break
    case 'related-previous': if (id) { const r = related.get(id); if (r && r.page > 0) void readRelated(id, r.correlation, r.page - 1, false) } break
    case 'related-event': if (button.dataset.event) openTarget(button.dataset.event); break
    case 'restore': invalidate(); clearLinkUrl(); customDraft = null; preferences = loadPreferences(); expanded.clear(); related.clear(); page = null; firstSnapshot = null; void loadPage(); requestAnimationFrame(() => view.querySelector<HTMLElement>('.view-header')?.focus({ preventScroll: true })); break
    case 'link-instance': instanceLink(); break
    case 'call': if (button.dataset.call && loggingCallId(button.dataset.call)) window.dispatchEvent(new CustomEvent('poise:goto-swarm-call', { detail: { id: button.dataset.call } })); break
    case 'settings': window.dispatchEvent(new CustomEvent('poise:logging-settings', { detail: { section: button.dataset.settings } })); break
  }
}
function onInput(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.id === 'logging-from' || input.id === 'logging-to') {
    customDraft ??= { from: preferences.from, to: preferences.to }
    customDraft[input.id === 'logging-from' ? 'from' : 'to'] = input.value
    return
  }
  if (input.id === 'logging-search') preferences.search = input.value
  else {
    const exact = EXACT.find(([key]) => key === input.dataset.field)
    if (!exact) return
    preferences[exact[0]] = input.value
  }
  filtersChanged(true)
}
function onChange(event: Event): void {
  const select = event.target as HTMLSelectElement
  if (select.id === 'logging-source') { preferences.source = select.value; filtersChanged() }
  if (select.id === 'logging-scope' && (select.value === 'workspace' || select.value === 'instance')) {
    preferences.scope = select.value
    if (link) { const saved = loadPreferences(); saved.scope = preferences.scope; persist(saved); void initialRead() }
    else filtersChanged()
  }
}
function visibility(): void {
  if (!active) return
  if (document.hidden) { const pending = loading; invalidate(); if (pending && page) { stale = true; message = 'The pending read was paused when this tab became hidden.' } syncPolling() }
  else { render(); if (!page && !linkFailure) void initialRead(); else { syncPolling(); if (pageIndex === 0) void poll() } }
}

export function initLoggingView(): void {
  if (!initialized) { view = document.getElementById('view-logging')!; shell(); initialized = true }
  if (active) { if (mountedSearch !== location.search) { preferences = loadPreferences(); void initialRead() } else refreshCurrent(); return }
  active = true; preferences = loadPreferences(); access = null; expanded.clear(); related.clear()
  document.addEventListener('visibilitychange', visibility)
  void initialRead()
  requestAnimationFrame(() => { if (active && !link?.event && !link?.incident && !linkFailure) view.querySelector<HTMLElement>('.view-header')?.focus({ preventScroll: true }) })
}
export function refreshLoggingView(): void { if (active) refreshCurrent() }
export function stopLoggingRefresh(): void {
  if (!active) return
  active = false; invalidate(); document.removeEventListener('visibilitychange', visibility)
  stopTick?.(); stopTick = null
}
