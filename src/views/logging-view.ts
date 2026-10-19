import { effectiveTimezone, midnightInZone } from '../config'
import { patchContent } from '../dom-patch'
import { TIME_RANGES, isTimeRange, timeRangeWindow, type TimeRange } from '../time-range'
import {
  LOGGING_LEVELS, LOGGING_SOURCES, LoggingApiError, loggingAccess, loggingCallId, loggingErrorBounds, loggingEvent, loggingExport, loggingHealth,
  loggingHref, loggingPage, loggingParameters, loggingPullRequest, parseLoggingLink, subscribeDiagnosticRefresh,
  type LoggingAccess, type LoggingEvent, type LoggingHealth, type LoggingLink, type LoggingPage, type LoggingQuery,
} from '../logging'
import { readLoggingTime } from '../../gateway/src/diagnostics/query-time'
import { currentCoverageStatus } from '../../gateway/src/diagnostics/query-contract'

const STORAGE = 'poise-logging-filters'
const EXACT = [
  ['component', 'Component'], ['workspace', 'Workspace'], ['account', 'Account'], ['repository', 'Repository'],
  ['callId', 'Call ID'], ['correlationId', 'Correlation ID'], ['incidentId', 'Incident ID'],
] as const
const COLUMNS = [['time', 'Time'], ['severity', 'Severity'], ['source', 'Source'], ...EXACT,
  ['target', 'Target'], ['message', 'Message'], ['occurrences', 'Count']] as const
type Column = typeof COLUMNS[number][0]
const OPTIONAL = EXACT.filter(([key]) => key !== 'component')
const BASE_COLUMNS: Column[] = ['time', 'severity', 'source', 'component', 'repository', 'target', 'message', 'occurrences']
const FILTER_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 3h12L9.5 8v4l-3 1V8L2 3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
const DATA_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M8 7v4M8 4.5v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
type Exact = typeof EXACT[number][0]
type Preferences = Record<Exact, string> & { columns: Column[]; severities: Array<typeof LOGGING_LEVELS[number]>; time: TimeRange | 'custom'; from: string; to: string; source: string; search: string; scope: 'workspace' | 'instance' }
interface Related { loading: boolean; events: LoggingPage['events']; total: number; cursor: string | null; history: Array<string | null>; page: number; error: string; correlation: boolean; first: { events: LoggingPage['events']; total: number; cursor: string | null } | null }

const defaults = (): Preferences => ({ component: '', workspace: '', account: '', repository: '', callId: '', correlationId: '', incidentId: '',
  columns: [...BASE_COLUMNS], severities: [...LOGGING_LEVELS], time: 'all', from: '', to: '', source: '', search: '', scope: 'workspace' })
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
let healthReadAt: number | null = null
let queryUnavailable = false
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
    if (saved.columns !== undefined) {
      if (!Array.isArray(saved.columns) || !saved.columns.every((key) => COLUMNS.some(([name]) => name === key))) throw new Error('Invalid saved columns')
      next.columns = COLUMNS.filter(([key]) => (saved.columns as unknown[]).includes(key) || !OPTIONAL.some(([name]) => name === key)).map(([key]) => key)
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

function visibleColumns(): typeof COLUMNS[number][] {
  for (const [key] of EXACT) if (preferences[key] && !preferences.columns.includes(key)) preferences.columns.push(key)
  if (preferences.scope === 'instance' && !preferences.columns.includes('workspace')) preferences.columns.push('workspace')
  return COLUMNS.filter(([key]) => preferences.columns.includes(key))
}
function filtered(key: Column): boolean {
  return key === 'severity' ? preferences.severities.length !== LOGGING_LEVELS.length : key === 'time' ? preferences.time !== 'all'
    : key === 'source' ? !!preferences.source : EXACT.some(([name]) => name === key && !!preferences[name])
}
function header(): string {
  return '<tr>' + visibleColumns().map(([key, label]) => {
    const filter = ['time', 'severity', 'source', ...EXACT.map(([key]) => key)].includes(key)
    return `<th scope="col" id="logging-column-${key}" class="logging-column-${key}">${filter ? `<button type="button" class="logging-column-button${filtered(key) ? ' active' : ''}" id="logging-filter-button-${key}" popovertarget="logging-filter-${key}" aria-label="Filter ${label}${filtered(key) ? ', active' : ''}">${label}${FILTER_ICON}</button>` : label}</th>`
  }).join('') + '<th scope="col" aria-label="Evidence"></th></tr>'
}
function popovers(): string {
  const pane = (key: string, label: string, body: string) => `<div id="logging-filter-${key}" class="logging-popover" popover="auto" role="group" aria-label="${label} filter" data-trigger="logging-filter-button-${key}"><div class="logging-popover-title">${label}</div>${body}</div>`
  return pane('severity', 'Severity', `<div class="range-picker logging-filter-options">${LOGGING_LEVELS.map((level) => `<button type="button" data-level="${level}" aria-pressed="true">${level[0].toUpperCase() + level.slice(1)}</button>`).join('')}</div>`)
    + pane('time', 'Time', `<div class="range-picker logging-filter-options">${[...TIME_RANGES, { key: 'custom', label: 'Custom interval' }].map((range) => `<button type="button" data-time="${range.key}">${range.label}</button>`).join('')}</div>
      <div class="logging-custom" id="logging-custom" hidden><label>From<input id="logging-from" class="st-input" type="text" aria-label="From, inclusive zoned time" placeholder="2026-10-19T00:00:00+03:00"></label><label>To<input id="logging-to" class="st-input" type="text" aria-label="To, exclusive zoned time" placeholder="2026-10-20T00:00:00+03:00"></label><div class="range-picker"><button type="button" data-action="custom">Apply interval</button></div></div>`)
    + pane('source', 'Source', `<select id="logging-source" class="st-select" aria-label="Filter Source" autofocus><option value="">All sources</option>${LOGGING_SOURCES.map((source) => `<option value="${source}">${source}</option>`).join('')}</select>`)
    + EXACT.map(([key, label]) => pane(key, label, `${key === 'workspace' ? '<label id="logging-scope-label" hidden>Access scope<select id="logging-scope" class="st-select"><option value="workspace">Your workspace</option><option value="instance">Instance diagnostics</option></select></label>' : ''}<input class="st-input" id="logging-${key}" data-field="${key}" type="text" maxlength="512" autocomplete="off" aria-label="Filter ${label}" autofocus placeholder="All ${label.toLowerCase()} values"><button type="button" class="logging-clear-filter" data-action="clear-filter" data-field="${key}">Clear filter</button>`)).join('')
}
function positionPopover(popup: HTMLElement): void {
  const trigger = document.getElementById(popup.dataset.trigger ?? '')
  if (!trigger || !active) { if (popup.matches(':popover-open')) popup.hidePopover(); return }
  const rect = trigger.getBoundingClientRect()
  if (rect.right < 0 || rect.left > innerWidth || rect.bottom < 0 || rect.top > innerHeight) { if (popup.matches(':popover-open')) popup.hidePopover(); return }
  const width = Math.min(popup.id === 'logging-filter-time' ? 340 : popup.id === 'logging-data' ? 620 : 280, innerWidth - 24)
  popup.style.width = width + 'px'
  popup.style.left = Math.max(12, Math.min(rect.left, innerWidth - width - 12)) + 'px'
  popup.style.top = Math.max(12, rect.bottom + 6) + 'px'
  popup.style.maxHeight = Math.max(100, innerHeight - Math.max(12, rect.bottom + 6) - 12) + 'px'
}
function positionPopovers(): void { for (const popup of view.querySelectorAll<HTMLElement>('[popover]:popover-open')) positionPopover(popup) }
function closePopovers(): void { for (const popup of view.querySelectorAll<HTMLElement>('[popover]:popover-open')) popup.hidePopover() }
function shell(): void {
  view.innerHTML = `<header class="view-header" tabindex="-1" aria-label="Logging controls"><div class="filter-cluster" id="logging-filters">
    <div class="search-cluster"><input class="search-input" id="logging-search" type="search" aria-label="Search redacted diagnostics" placeholder="Search diagnostics…" maxlength="256" autocomplete="off" spellcheck="false"><span class="filter-count" id="logging-count"></span></div>
    <div class="range-picker" role="group" aria-label="Diagnostic actions"><button type="button" data-action="refresh" data-focus="refresh">Refresh</button><button type="button" data-action="export" data-focus="export" title="Export matching retained events">Export</button></div>
    <button type="button" class="logging-toolbar-button" id="logging-columns-button" popovertarget="logging-columns" aria-label="Choose diagnostic columns" title="Columns"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M6 3v10M10 3v10" stroke="currentColor" stroke-width="1.2"/></svg></button>
    <button type="button" class="logging-toolbar-button" id="logging-data-button" popovertarget="logging-data" aria-label="Diagnostic data details" title="Data and collection">${DATA_ICON}</button>
    </div></header><main>
    <h1 class="logging-screen-reader" id="logging-heading" tabindex="-1">Logging</h1>
    <p class="logging-screen-reader" id="logging-status" role="status" aria-live="polite" tabindex="-1"></p>
    <p class="st-help st-help-error" id="logging-message" role="status" hidden></p>
    <div class="range-picker logging-new" id="logging-new" hidden><button type="button" data-action="new"></button></div>
    <div id="logging-link"></div>
    <div class="logging-table-wrap"><table id="logging-table" aria-label="Retained diagnostic events"><thead id="logging-thead"></thead><tbody id="logging-tbody"></tbody></table></div>
    <div id="logging-loader" class="loader" role="status" aria-label="Loading diagnostics" hidden><span></span><span></span><span></span></div>
    <p class="st-help" id="logging-empty" hidden>No matching events.</p>
    <div class="logging-pagination"><div class="range-picker" role="group" aria-label="Diagnostic pages"><button type="button" data-action="previous" data-focus="page-previous">Previous</button><button type="button" data-action="next" data-focus="page-next">Next</button></div><span class="filter-count" id="logging-page"></span></div>
    ${popovers()}
    <div id="logging-columns" class="logging-popover" popover="auto" role="group" aria-label="Diagnostic columns" data-trigger="logging-columns-button"><div class="logging-popover-title">Columns</div>${OPTIONAL.map(([key, label]) => `<label class="logging-column-option"><input type="checkbox" data-column="${key}">${label}</label>`).join('')}</div>
    <div id="logging-data" class="logging-popover logging-data" popover="auto" role="region" aria-label="Diagnostic data" data-trigger="logging-data-button"><div class="logging-popover-title">Data and collection</div><div id="logging-health"></div></div>
    </main>`
  view.addEventListener('click', onClick)
  view.addEventListener('input', onInput)
  view.addEventListener('change', onChange)
  for (const popup of view.querySelectorAll<HTMLElement>('[popover]')) popup.addEventListener('beforetoggle', (event) => { if ((event as Event & { newState: string }).newState === 'open') { if (popup.id === 'logging-data') renderHealth(true); positionPopover(popup) } })
  window.addEventListener('resize', positionPopovers)
  window.addEventListener('scroll', positionPopovers, true)
  view.querySelector('#logging-custom')!.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); applyCustom() } })
}

function controls(): void {
  const columns = visibleColumns()
  patchContent(view.querySelector<HTMLElement>('#logging-thead')!, header())
  for (const input of view.querySelectorAll<HTMLInputElement>('[data-column]')) {
    input.checked = columns.some(([key]) => key === input.dataset.column)
    input.disabled = EXACT.some(([key]) => key === input.dataset.column && !!preferences[key])
    input.title = input.disabled ? 'Clear the column filter before hiding this column' : ''
  }
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
  const scrollport = view.querySelector<HTMLElement>('.logging-table-wrap')!
  const focused = document.activeElement instanceof HTMLElement && view.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined
  const boundary = scrollport.getBoundingClientRect().top + view.querySelector<HTMLElement>('#logging-thead')!.getBoundingClientRect().height
  const anchor = [...tbody.querySelectorAll<HTMLElement>('tr.agent-row')].find((row) => row.getBoundingClientRect().bottom > boundary)
  const anchorId = anchor?.dataset.id; const anchorTop = anchor?.getBoundingClientRect().top
  const ids = new Set(page?.events.map((event) => event.id) ?? [])
  for (const id of [...expanded]) if (!ids.has(id) && linked?.id !== id) { expanded.delete(id); related.delete(id) }
  const columns = visibleColumns()
  const rows = page?.events.map((event) => {
    const open = expanded.has(event.id)
    const cells = columns.map(([key]) => {
      if (key === 'time') return `<td class="started-cell"><time datetime="${escape(event.eventTime ?? event.ingestedAt)}" title="${escape((event.eventTime ? 'Source time' : 'Ingestion time; source time not recorded') + ' · ' + effectiveTimezone())}">${escape(date(event.eventTime ?? event.ingestedAt))}</time>${event.eventTime ? '' : '<span class="agent-status-note">Ingested</span>'}</td>`
      if (key === 'severity') return `<td><span class="agent-status ${event.severity === 'warning' ? 'warn' : 'bad'}"><span class="agent-status-label">${event.severity[0].toUpperCase() + event.severity.slice(1)}</span></span></td>`
      if (key === 'occurrences') return `<td class="logging-number" title="Retained occurrences in this incident">${event.occurrences.toLocaleString()}</td>`
      const value = event[key] || '—'
      return `<td class="logging-cell logging-cell-${key}" title="${escape(value)}">${escape(value)}</td>`
    }).join('')
    return `<tr class="agent-row" data-id="${event.id}">${cells}<td class="action-cell"><button type="button" class="expand-btn${open ? ' open' : ''}" id="logging-expand-${event.id}" data-action="expand" data-row="${event.id}" data-focus="expand-${event.id}" aria-label="Toggle diagnostic evidence" aria-expanded="${open}" aria-controls="logging-detail-${event.id}">${CHEVRON}</button></td></tr>
      ${open ? `<tr class="agent-expand-row" data-expand-for="${event.id}" id="logging-detail-${event.id}"><td colspan="${columns.length + 1}">${detail(event)}</td></tr>` : ''}`
  }).join('') ?? ''

  patchContent(tbody, rows)
  const status = view.querySelector<HTMLElement>('#logging-status')!
  status.textContent = loading ? (page ? 'Refreshing retained diagnostics…' : 'Loading retained diagnostics…')
    : page ? `${page.total.toLocaleString()} matching retained events${preferences.severities.length ? '' : ' · No severities selected'}${lastSuccess ? ' · Snapshot read ' + date(new Date(lastSuccess).toISOString()) : ''}${stale ? ' · Stale results' : ''}` : linkFailure ? evidenceFailure(linkFailure) : message || 'Diagnostic results have not been read.'
  view.querySelector<HTMLElement>('#logging-count')!.textContent = page ? page.total.toLocaleString() : ''
  const note = view.querySelector<HTMLElement>('#logging-message')!
  note.textContent = [message, preferenceWarning].filter(Boolean).join(' '); note.hidden = !note.textContent
  view.querySelector<HTMLElement>('#logging-loader')!.hidden = !loading
  view.querySelector<HTMLElement>('#logging-empty')!.hidden = !page || page.events.length > 0 || loading || !!linkFailure
  view.querySelector<HTMLElement>('#logging-table')!.hidden = false
  view.querySelector<HTMLElement>('#logging-page')!.textContent = page ? `${pageIndex * 50 + (page.events.length ? 1 : 0)}–${pageIndex * 50 + page.events.length} / ${page.total.toLocaleString()}` : ''
  const fresh = view.querySelector<HTMLElement>('#logging-new')!
  fresh.hidden = pageIndex !== 0 || !page || (!newCount && !rangeChanged)
  fresh.querySelector('button')!.textContent = rangeChanged ? 'Time range changed · refresh diagnostics' : `${newCount.toLocaleString()} new diagnostics`
  renderLink()
  renderHealth()
  if (focused) {
    const target = view.querySelector<HTMLElement>(`[data-focus="${focused}"]`)
    if (target && !(target instanceof HTMLButtonElement && target.disabled)) target.focus({ preventScroll: true })
    else { status.textContent += ' The focused diagnostic or control is no longer available in this snapshot.'; view.querySelector<HTMLElement>('.view-header')!.focus({ preventScroll: true }) }
  }
  if (anchorId && anchorTop !== undefined) {
    const next = tbody.querySelector<HTMLElement>(`tr[data-id="${anchorId}"]`)
    if (next) scrollport.scrollBy({ top: next.getBoundingClientRect().top - anchorTop, behavior: 'instant' as ScrollBehavior })
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
function coverageHistory(source: LoggingPage['coverage'][number]): string {
  const gaps = source.gaps.length ? `<details><summary aria-label="${source.gaps.length} retained gaps for ${escape(source.id)}">${source.gaps.length}${source.historyIncomplete ? '+' : ''} gaps</summary><ul>${source.gaps.map((gap) => `<li>${escape(date(gap.from))} – ${escape(gap.to ? date(gap.to) : 'Open')}<br>${escape(gap.reason)}</li>`).join('')}</ul></details>` : source.historyIncomplete ? 'Limited' : '—'
  const loss = [source.dropped ? `≥${source.dropped.toLocaleString()} dropped` : '', source.rejected ? `≥${source.rejected.toLocaleString()} rejected` : ''].filter(Boolean).join(' · ')
  return gaps + (loss ? `<small>${escape(loss)}</small>` : '')
}
function renderHealth(opening = false): void {
  const target = view.querySelector<HTMLElement>('#logging-health')!
  const bounds = page?.bounds ?? linkBounds ?? health?.bounds
  const sources = health?.collection.sources ?? page?.coverage ?? []
  const healthFresh = !!health && !healthMessage && healthReadAt !== null && performance.now() - healthReadAt <= 60_000
  const state = health && !healthFresh ? 'stale' : health?.collection.currentStatus ?? (health?.collection.status === 'partial' ? 'initializing' : health?.collection.status)
  const queryState = queryUnavailable ? 'unavailable' : healthFresh ? health?.query.status : health ? 'stale' : undefined
  const label = (value: string | undefined) => value === 'connected' ? 'Connected' : value === 'partial' ? 'Degraded' : value === 'initializing' ? 'Awaiting observation' : value === 'not-configured' ? 'Not configured' : value ? value[0].toUpperCase() + value.slice(1) : 'Not read'
  const button = view.querySelector<HTMLButtonElement>('#logging-data-button')!
  button.classList.toggle('has-issue', queryUnavailable || !!healthMessage || !!state && state !== 'connected' || queryState === 'unavailable')
  button.title = `Data and collection · ${queryUnavailable ? 'Query unavailable' : healthMessage ? 'Health unavailable' : label(state)}`
  if (!opening && !view.querySelector<HTMLElement>('#logging-data')!.matches(':popover-open')) return
  patchContent(target, `<dl class="logging-data-facts">${field('Collection now', label(state))}${field('Query service', label(queryState))}
    ${field('Snapshot', lastSuccess ? date(new Date(lastSuccess).toISOString()) : null)}${field('Collection read', health ? date(health.collection.checkedAt) : null)}
    ${field('Retention boundary', bounds ? date(bounds.retentionAfter) : null)}${field('Earliest retained', bounds?.from ? date(bounds.from) : null)}${field('Latest retained', bounds?.to ? date(bounds.to) : null)}${field('Timezone', effectiveTimezone())}${field('Active loss', healthFresh && health?.collection.lossActive !== undefined ? health.collection.lossActive ? 'Yes' : 'No' : null)}${field('Historical loss recorded', health ? health.collection.lossObserved ? 'Yes' : 'No' : null)}</dl>
    ${healthMessage ? `<p class="st-help st-help-error">${escape(healthMessage)}</p>` : ''}
    <table class="logging-coverage-table" aria-label="Diagnostic sources"><thead><tr><th>Source</th><th>Current</th><th>Last observed</th><th>History</th></tr></thead><tbody>${sources.map((source) => `<tr><td><span>${escape(source.source)}</span><small>${escape(source.id)}</small></td><td title="${escape(source.error ?? '')}">${escape(health && !healthFresh ? 'Stale' : source.optional && currentCoverageStatus(source) === 'not-configured' ? 'Not applicable' : label(currentCoverageStatus(source)))}${source.error && currentCoverageStatus(source) !== 'connected' ? `<small>${escape(source.error)}</small>` : ''}</td><td>${escape(source.observedAt ? date(source.observedAt) : '—')}</td><td>${coverageHistory(source)}</td></tr>`).join('')}</tbody></table>`)
}

async function readHealth(mine: number): Promise<void> {
  if (!access || !current(mine)) return
  const request = controller()
  try { const value = await loggingHealth(access, preferences.scope, request.signal); if (current(mine)) { health = value; healthReadAt = performance.now(); healthMessage = ''; render() } }
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
    if (fresh && applied && loggingParameters(applied).toString() !== loggingParameters(candidate).toString()) {
      related.clear(); view.querySelector<HTMLElement>('.logging-table-wrap')!.scrollTop = 0
    }
    if (!fresh || pageIndex !== 0) view.querySelector<HTMLElement>('.logging-table-wrap')!.scrollTop = 0
    page = value; applied = candidate; lastSuccess = Date.now(); loading = false; linkFailure = null; queryUnavailable = false
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
    if (problem.status !== 400) { queryUnavailable = true; void readHealth(mine) }
    if (problem.status === 401 || problem.status === 403) { denied(); stale = false }
  } finally { requests.delete(request); if (current(mine)) { loading = false; render() } }
}

async function initialRead(): Promise<void> {
  const mine = invalidate()
  customDraft = null
  loading = true; page = null; firstSnapshot = null; health = null; healthReadAt = null; healthMessage = ''; queryUnavailable = false; applied = null; linked = null; link = null; linkFailure = null; linkBounds = null; message = ''; newCount = 0; pageIndex = 0; cursors = [null]; mountedSearch = location.search
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
    if (linkFailure.status >= 500 || linkFailure.status === 429) queryUnavailable = true
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
    newCount = value.total; failures = 0; retryAt = 0; queryUnavailable = false
    if (stale) message = 'The earlier refresh failed; these results remain a previous snapshot. Refresh or apply new diagnostics to update.'
    render()
    void readHealth(mine)
  } catch (error) {
    if (current(mine) && !request.signal.aborted) {
      const problem = failure(error)
      stale = true; message = 'Refresh unavailable; previous results are stale. ' + problem.message
      queryUnavailable = true
      retryAt = Date.now() + Math.min(120_000, 15_000 * 2 ** Math.min(++failures, 3))
      if (problem.status === 401 || problem.status === 403) denied()
      else void readHealth(mine)
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
    message = ''; render()
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
    case 'clear-filter': {
      const key = EXACT.find(([key]) => key === button.dataset.field)?.[0]
      if (key) { preferences[key] = ''; filtersChanged(); view.querySelector<HTMLInputElement>('#logging-' + key)?.focus() }
      break
    }
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
  const column = event.target as HTMLInputElement
  const key = OPTIONAL.find(([key]) => key === column.dataset.column)?.[0]
  if (key) {
    if (!column.checked && preferences[key]) { column.checked = true; return }
    preferences.columns = column.checked ? [...preferences.columns.filter((name) => name !== key), key] : preferences.columns.filter((name) => name !== key)
    if (link) {
      const saved = loadPreferences()
      saved.columns = column.checked ? [...saved.columns.filter((name) => name !== key), key] : saved.columns.filter((name) => name !== key)
      persist(saved)
    } else persist()
    render(); return
  }
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
  closePopovers(); active = false; invalidate(); document.removeEventListener('visibilitychange', visibility)
  stopTick?.(); stopTick = null
}
