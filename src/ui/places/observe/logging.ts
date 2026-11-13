// Observe → Logging (#556): Poise's retained diagnostics. The reading is a
// copy of classic's src/views/logging-view.ts, whose module holds its state and
// draws classic's markup: filters kept as poise-logging-filters, the durable
// links parseLoggingLink reads, snapshots and pages with Previous returning to
// the snapshot seen, new diagnostics waiting behind a button, related
// diagnostics, Data and collection, export, the administrator's access scope
// and each row's work impact, read once per snapshot (#1106, #1120). What
// changes is the mock's markup, and where the evidence leads: the run opens
// in Behaviors and the work impact opens its task in Tasks at that step,
// instead of a raw journal link. The chain's evidence moved to Tasks.
import { $, esc } from '../../dom'
import { icon } from '../../icons'
import { placeHref } from '../../address'
import { effectiveTimezone, midnightInZone } from '../../../config'
import { TIME_RANGES, isTimeRange, timeRangeWindow, type TimeRange } from '../../../time-range'
import {
  LOGGING_LEVELS, LOGGING_SOURCES, LoggingApiError, loggingAccess, loggingCallId, loggingErrorBounds, loggingEvent, loggingExport, loggingHealth,
  loggingPage, loggingParameters, loggingPullRequest, loggingSeverity, loggingWorkImpacts, parseLoggingLink, subscribeDiagnosticRefresh,
  type LoggingAccess, type LoggingEvent, type LoggingHealth, type LoggingLink, type LoggingPage, type LoggingQuery, type LoggingWorkImpact,
} from '../../../logging'
import { readLoggingTime } from '../../../../gateway/src/diagnostics/query-time'
import { currentCoverageStatus } from '../../../../gateway/src/diagnostics/query-contract'
import { patchContent } from '../../../dom-patch'
import { journalStep } from './chains'
import { capsule, external, partHref } from './util'
import type { ObservePart, PartContext } from './part'

const STORAGE = 'poise-logging-filters'
const EXACT = [
  ['component', 'Component'], ['workspace', 'Workspace'], ['account', 'Account'], ['repository', 'Repository'],
  ['callId', 'Call ID'], ['correlationId', 'Correlation ID'], ['incidentId', 'Incident ID'],
] as const
const COLUMNS = [['time', 'Time'], ['impact', 'Work impact'], ['severity', 'Severity'], ['source', 'Source'], ...EXACT,
  ['target', 'Target'], ['message', 'Message'], ['occurrences', 'Count']] as const
type Column = typeof COLUMNS[number][0]
const OPTIONAL = EXACT.filter(([key]) => key !== 'component')
const BASE_COLUMNS: Column[] = ['time', 'impact', 'severity', 'source', 'component', 'repository', 'target', 'message', 'occurrences']
type Exact = typeof EXACT[number][0]
type Preferences = Record<Exact, string> & { columns: Column[], severities: Array<typeof LOGGING_LEVELS[number]>, time: TimeRange | 'custom', from: string, to: string, source: string, search: string, scope: 'workspace' | 'instance' }
interface Related { loading: boolean, events: LoggingPage['events'], total: number, cursor: string | null, history: Array<string | null>, page: number, error: string, correlation: boolean, first: { events: LoggingPage['events'], total: number, cursor: string | null } | null }
type WorkImpacts = Map<string, { value: LoggingWorkImpact | null, message: string }>

const defaults = (): Preferences => ({ component: '', workspace: '', account: '', repository: '', callId: '', correlationId: '', incidentId: '',
  columns: [...BASE_COLUMNS], severities: [...LOGGING_LEVELS], time: 'all', from: '', to: '', source: '', search: '', scope: 'workspace' })
const absent = (value: unknown) => value === null || value === undefined || value === ''
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

export function createLogging(ctx: PartContext): ObservePart {
  const { root, back } = ctx
  let preferenceWarning = ''

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
        if (typeof saved[key] === 'string') next[key] = saved[key] as string
      }
      if (saved.columns !== undefined) {
        if (!Array.isArray(saved.columns) || !saved.columns.every((key) => COLUMNS.some(([name]) => name === key))) throw new Error('Invalid saved columns')
        next.columns = COLUMNS.filter(([key]) => (saved.columns as unknown[]).includes(key) || !OPTIONAL.some(([name]) => name === key)).map(([key]) => key)
      }
      if (!Array.isArray(saved.severities) || !saved.severities.every((level) => LOGGING_LEVELS.includes(level))) throw new Error('Invalid saved severities')
      next.severities = LOGGING_LEVELS.filter((level) => (saved.severities as unknown[]).includes(level))
      if (!isTimeRange(saved.time) && saved.time !== 'custom') throw new Error('Invalid saved range')
      next.time = saved.time as TimeRange | 'custom'
      if (saved.scope !== 'workspace' && saved.scope !== 'instance') throw new Error('Invalid saved scope')
      next.scope = saved.scope
      return next
    } catch {
      preferenceWarning = 'Saved filters were invalid or unreadable; the default filters are shown.'
      return defaults()
    }
  }
  function persist(value = preferences): void {
    try { localStorage.setItem(STORAGE, JSON.stringify(value)) } catch { preferenceWarning = 'These filter choices could not be saved in this browser.' }
  }

  let preferences = loadPreferences()
  let customDraft: { from: string, to: string } | null = null
  let access: LoggingAccess | null = null
  let page: LoggingPage | null = null
  let firstSnapshot: { page: LoggingPage, at: number, impacts: WorkImpacts } | null = null
  let pageIndex = 0
  let cursors: Array<string | null> = [null]
  let applied: LoggingQuery | null = null
  let health: LoggingHealth | null = null
  let linked: LoggingEvent | null = null
  let link: LoggingLink | null = null
  let linkMessage = ''
  let linkFailure: LoggingApiError | null = null
  let linkBounds: LoggingPage['bounds'] | null = null
  // The link the address carried; Restore saved filters lets it go for this visit.
  let linkSearch: string | null = (() => {
    const params = new URLSearchParams([['view', 'logging']])
    for (const key of ['event', 'incident', 'from', 'to']) for (const value of ctx.query.getAll(key)) params.append(key, value)
    return params.toString() === 'view=logging' ? null : `?${params}`
  })()
  let message = ''
  let messageTone: 'info' | 'error' = 'info'
  let healthMessage = ''
  let healthReadAt: number | null = null
  let queryUnavailable = false
  let stale: 'failed' | 'paused' | null = null
  let loading = false
  let lastSuccess: number | null = null
  let newCount = 0
  let rangeChanged = false
  let generation = 0
  let retryAt = 0
  let failures = 0
  let active = false
  let started = false
  let debounce = 0
  let stopTick: (() => void) | null = null
  const requests = new Set<AbortController>()
  const expanded = new Set<string>()
  const related = new Map<string, Related>()
  let impacts: WorkImpacts = new Map()
  let formatter: { zone: string, value: Intl.DateTimeFormat } | null = null
  const setMessage = (text: string, tone: 'info' | 'error' = 'error'): void => { message = text; messageTone = tone }

  function date(value: string | null): string {
    if (!value) return 'Not recorded'
    const zone = effectiveTimezone()
    if (formatter?.zone !== zone) formatter = { zone, value: new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }
    return formatter.value.format(new Date(value))
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
      next.from = range.since
      next.to = range.until
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
    for (const state of related.values()) if (state.loading) { state.loading = false; state.error = 'The related read was cancelled; ask for it again.' }
    clearTimeout(debounce)
    debounce = 0
    loading = false
    return generation
  }
  const current = (mine: number) => active && mine === generation && !ctx.signal.aborted
  function controller(): AbortController { const request = new AbortController(); requests.add(request); return request }
  function failure(error: unknown): LoggingApiError {
    return error instanceof LoggingApiError ? error : new LoggingApiError(503, 'logging_unavailable', error instanceof Error ? error.message : 'The diagnostic query service is unavailable.')
  }
  function clearLinkUrl(): void {
    const url = new URL(location.href)
    for (const key of ['event', 'incident', 'from', 'to']) url.searchParams.delete(key)
    history.replaceState(history.state, '', url)
    link = null; linked = null; linkFailure = null; linkBounds = null; linkMessage = ''; linkSearch = null
  }
  function denied(): void { page = null; firstSnapshot = null; linked = null; health = null; access = null; related.clear(); expanded.clear(); impacts.clear(); newCount = 0 }
  function syncPolling(): void {
    const wanted = active && !document.hidden && pageIndex === 0 && !!page && !linkFailure
    if (wanted && !stopTick) stopTick = subscribeDiagnosticRefresh(() => { void poll() })
    if (!wanted && stopTick) { stopTick(); stopTick = null }
  }

  // ---------- Markup ----------
  const field = (name: string, value: unknown): string =>
    `<div><dt>${esc(name)}</dt><dd>${absent(value) ? '<span class="dim">Not recorded</span>' : esc(typeof value === 'object' ? JSON.stringify(value) : value)}</dd></div>`
  const pre = (name: string, value: string | null, quiet = true): string =>
    `<section class="lg-ev"><h4 class="t-micro">${name}</h4><pre class="sw-pre${quiet ? ' is-quiet' : ''}">${esc(absent(value) ? 'Not recorded' : value)}</pre></section>`

  function impactHTML(event: LoggingEvent): string {
    const work = impacts.get(event.id)
    const impact = work?.value
    if (!impact) return `<section class="lg-ev" data-ref="lg.workimpact"><h4 class="t-micro">Work impact</h4><p class="note">Current impact: unknown. ${esc(work?.message ?? 'Workspace chain evidence has not been read for this snapshot yet.')}</p></section>`
    const step = journalStep(impact.journal)
    return `<section class="lg-ev" data-ref="lg.workimpact"><h4 class="t-micro">Work impact</h4><dl class="lg-facts">${field('Current impact', impact.impact)}${field('Work stage', impact.stage)}${field('Work target', impact.target)}
      ${field('Last verified progress', date(new Date(impact.progressAt).toISOString()))}${field('Next retry', impact.retryAt === null ? null : date(new Date(impact.retryAt).toISOString()))}
      ${field('Next action', impact.nextAction)}${field('Matched invocation', impact.invocationId)}${impact.recovered ? field('Matched failure', 'Recovered: verified progress followed this failure') : ''}</dl>
      ${step ? `<a class="btn-ghost" href="${esc(partHref('tasks', { chain: step.id, after: String(step.after) }, back))}" data-lg-task>Open its task at this step</a>` : ''}</section>`
  }

  function detail(event: LoggingEvent): string {
    const pr = loggingPullRequest(event)
    const settings = typeof event.context.settings === 'string' && ['general', 'models', 'accounts', 'publishing', 'admin'].includes(event.context.settings) ? event.context.settings : null
    const links = [event.callId && loggingCallId(event.callId) ? `<a class="btn-ghost" href="${esc(partHref('behaviors', { call: event.callId }, back))}">Open the run in Behaviors</a>` : '',
      pr ? external(pr, 'Open the pull request ↗', 'btn-ghost', 'gh.link') : '',
      settings ? `<a class="btn-ghost" href="${esc(placeHref('settings', { settings, back: 'observe' }))}">Open Settings</a>` : ''].filter(Boolean).join('')
    const r = related.get(event.id)
    const relatedHTML = r ? `<p class="note${!r.loading && r.error ? ' is-warn' : ''}" role="status">${esc(r.loading ? 'Reading related diagnostics…' : r.error || `${r.total.toLocaleString('en-US')} matching retained ${r.total === 1 ? 'event' : 'events'} · the same ${r.correlation ? 'correlation' : 'incident'}, within the severities and interval you chose`)}</p>
      ${r.events.length ? `<ul class="lg-related">${r.events.map((entry) => `<li><button type="button" class="lnk" data-action="related-event" data-event="${esc(entry.id)}">${esc(date(entry.eventTime ?? entry.ingestedAt))} · ${esc(entry.message)}</button></li>`).join('')}</ul>` : ''}
      <div class="seg" role="group" aria-label="Related pages"><button type="button" data-action="related-previous" data-row="${esc(event.id)}" data-focus="related-previous-${esc(event.id)}"${r.page === 0 || r.loading ? ' disabled' : ''}>Previous</button><button type="button" data-action="related-next" data-row="${esc(event.id)}" data-focus="related-next-${esc(event.id)}"${!r.cursor || r.loading ? ' disabled' : ''}>Next 20</button></div>` : ''
    return `<div class="sw-detail-in lg-detail">
      ${event.truncated ? '<p class="note is-warn">Evidence is truncated; what was left out is not kept.</p>' : ''}
      <p class="lg-links" data-ref="lg.links">${links || '<span class="note">Nothing recorded to go to.</span>'}</p>
      ${impactHTML(event)}
      <dl class="lg-facts" data-ref="lg.facts">${field('Component', event.component)}${field('Operation', event.operation)}${field('Phase', event.phase)}${field('Target', event.target)}
      ${field('Source severity', event.sourceLevel)}${field('Workspace', event.workspace)}${field('Instance', event.instance)}${field('Container', event.container)}${field('Release', event.release)}
      ${field('Source time', event.eventTime ? date(event.eventTime) : null)}${field('Ingestion time', date(event.ingestedAt))}${field('Account', event.account)}${field('Repository', event.repository)}
      ${field('Call ID', event.callId)}${field('Correlation ID', event.correlationId)}${field('Request ID', event.requestId)}${field('Event ID', event.id)}${field('Incident ID', event.incidentId)}
      ${field('Exit code', event.exitCode)}${field('Signal', event.signal)}${field('Errno', event.errno)}${field('Timeout (ms)', event.timeoutMs)}
      ${field('Resource measurement time', typeof event.resources.measuredAt === 'string' ? event.resources.measuredAt : null)}${field('Resource measurement method', event.resources.measurement)}</dl>
      ${pre('Message', event.message, false)}${pre('Cause chain', event.cause.length ? event.cause.join('\nCaused by: ') : null)}${pre('Stderr · kept with secrets removed', event.stderr)}${pre('Stack', event.stack)}
      ${pre('Context · as recorded', Object.keys(event.context).length ? JSON.stringify(event.context, null, 2) : null)}
      ${pre('Resource facts · recorded units and measurement time', Object.keys(event.resources).length ? JSON.stringify(event.resources, null, 2) : null)}
      <section class="lg-relbox" data-ref="lg.related"><h4 class="t-micro">Related diagnostics</h4><div class="seg" role="group" aria-label="Related condition"><button type="button" data-action="related" data-row="${esc(event.id)}" data-focus="related-${esc(event.id)}" aria-pressed="${!!r && !r.correlation}"${r?.loading ? ' aria-disabled="true"' : ''}>${r && !r.correlation ? 'Refresh incident' : 'Show incident'}</button>${event.correlationId ? `<button type="button" data-action="correlation" data-row="${esc(event.id)}" data-focus="correlation-${esc(event.id)}" aria-pressed="${!!r?.correlation}"${r?.loading ? ' aria-disabled="true"' : ''}>Show correlation</button>` : ''}</div>${relatedHTML}</section>
    </div>`
  }

  function visibleColumns(): typeof COLUMNS[number][] {
    for (const [key] of EXACT) if (preferences[key] && !preferences.columns.includes(key)) preferences.columns.push(key)
    if (preferences.scope === 'instance' && !preferences.columns.includes('workspace')) preferences.columns.push('workspace')
    // Work impact is a base column: a saved set from before it still shows it.
    if (!preferences.columns.includes('impact')) preferences.columns.push('impact')
    return COLUMNS.filter(([key]) => preferences.columns.includes(key))
  }
  const filtered = (key: Column): boolean => key === 'severity' ? preferences.severities.length !== LOGGING_LEVELS.length : key === 'time' ? preferences.time !== 'all'
    : key === 'source' ? !!preferences.source : EXACT.some(([name]) => name === key && !!preferences[name])
  function header(): string {
    return `<tr>${visibleColumns().map(([key, name]) => {
      const filter = ['time', 'severity', 'source', ...EXACT.map(([key]) => key)].includes(key)
      return `<th scope="col" class="lg-c-${key}">${filter ? `<button type="button" class="lg-colbtn${filtered(key) ? ' is-on' : ''}" id="lg-filter-button-${key}" popovertarget="lg-filter-${key}" aria-label="Filter ${name}${filtered(key) ? ', on' : ''}" data-ref="lg.filter"><span class="t-micro">${name}</span>${icon('down', 'sm')}</button>` : `<span class="t-micro">${name}</span>`}</th>`
    }).join('')}<th scope="col" class="lg-c-more"><span class="sr">Evidence</span></th></tr>`
  }
  function popovers(): string {
    const pane = (key: string, name: string, inner: string) => `<div id="lg-filter-${key}" class="obv-pop lg-filter" popover="auto" role="group" aria-label="${name} filter" data-trigger="lg-filter-button-${key}"><p class="t-micro">${name}</p>${inner}</div>`
    return pane('severity', 'Severity', `<div class="seg">${LOGGING_LEVELS.map((level) => `<button type="button" data-level="${level}" aria-pressed="true">${label(level)}</button>`).join('')}</div>`)
      + pane('time', 'Time', `<div class="seg lg-ranges">${[...TIME_RANGES, { key: 'custom', label: 'Custom interval' }].map((range) => `<button type="button" data-time="${range.key}">${range.label}</button>`).join('')}</div>
        <div class="lg-custom" id="lg-custom" hidden><label>From<input id="lg-from" class="search" type="text" aria-label="From, inclusive zoned time" placeholder="2026-10-19T00:00:00+03:00"></label><label>To<input id="lg-to" class="search" type="text" aria-label="To, exclusive zoned time" placeholder="2026-10-20T00:00:00+03:00"></label><button type="button" class="btn-ghost" data-action="custom">Apply interval</button></div>`)
      + pane('source', 'Source', `<select id="lg-source" class="search" aria-label="Filter Source"><option value="">All sources</option>${LOGGING_SOURCES.map((source) => `<option value="${source}">${source}</option>`).join('')}</select>`)
      + EXACT.map(([key, name]) => pane(key, name, `${key === 'workspace' ? '<label class="lg-scope" id="lg-scope-label" hidden data-ref="lg.scope">Access scope<select id="lg-scope" class="search"><option value="workspace">Your workspace</option><option value="instance">Instance diagnostics</option></select></label>' : ''}<input class="search" id="lg-${key}" data-field="${key}" type="text" maxlength="512" autocomplete="off" aria-label="Filter ${name}" placeholder="All ${name.toLowerCase()} values"><button type="button" class="lnk" data-action="clear-filter" data-field="${key}">Clear filter</button>`)).join('')
  }

  root.innerHTML = `<div class="obv-bar">
      <input class="search lg-search" id="lg-search" type="search" placeholder="Search diagnostics…" aria-label="Search diagnostics" maxlength="256" autocomplete="off" spellcheck="false" data-ref="lg.search">
      <span class="obv-count" data-lg-count data-ref="lg.count"></span>
      <button type="button" class="btn-ghost" data-action="refresh" data-focus="refresh" data-ref="lg.refresh">Refresh</button>
      <button type="button" class="btn-ghost" data-action="export" data-focus="export" data-ref="lg.export">Export</button>
      <span class="obv-gap"></span>
      <button type="button" class="btn-ghost" id="lg-columns-button" popovertarget="lg-columns" data-ref="lg.columns">${icon('sliders', 'sm')}Columns</button>
      <button type="button" class="btn-ghost" id="lg-data-button" popovertarget="lg-data" data-ref="lg.data"><span class="sdot" data-lg-dot></span>Data and collection</button>
    </div>
    <p class="obv-note lg-status" role="status" aria-live="polite" data-lg-status data-ref="lg.status"></p>
    <p class="obv-warn" data-lg-message role="status" hidden></p>
    <div data-lg-link></div>
    <p class="lg-new" data-lg-new hidden><button type="button" class="btn-ghost" data-action="new" data-ref="lg.new"></button></p>
    <div class="obv-scroll" data-lg-scroll>
      <table class="table obv-table lg-table" aria-label="Retained diagnostic events"><thead data-lg-head></thead><tbody data-lg-rows></tbody></table>
      <p class="obv-empty" data-lg-empty hidden>No matching events.</p>
      <div class="lg-pages" data-ref="lg.pages"><div class="seg" role="group" aria-label="Pages"><button type="button" data-action="previous" data-focus="page-previous">Previous</button><button type="button" data-action="next" data-focus="page-next">Next</button></div><span class="obv-count" data-lg-page></span></div>
    </div>
    ${popovers()}
    <div id="lg-columns" class="obv-pop" popover="auto" role="group" aria-label="Columns" data-trigger="lg-columns-button"><p class="t-micro">Columns</p>${OPTIONAL.map(([key, name]) => `<label class="lg-check"><input type="checkbox" data-column="${key}">${name}</label>`).join('')}</div>
    <div id="lg-data" class="obv-pop lg-datapop" popover="auto" role="region" aria-label="Data and collection" data-trigger="lg-data-button"><p class="t-micro">Data and collection</p><div data-lg-health></div></div>`
  const tbody: HTMLElement = $('[data-lg-rows]', root)
  const scrollport: HTMLElement = $('[data-lg-scroll]', root)

  function positionPopover(popup: HTMLElement): void {
    const trigger = document.getElementById(popup.dataset.trigger ?? '')
    if (!trigger || !active) { if (popup.matches(':popover-open')) popup.hidePopover(); return }
    const rect = trigger.getBoundingClientRect()
    if (rect.right < 0 || rect.left > innerWidth || rect.bottom < 0 || rect.top > innerHeight) { if (popup.matches(':popover-open')) popup.hidePopover(); return }
    const width = Math.min(popup.id === 'lg-filter-time' ? 340 : popup.id === 'lg-data' ? 620 : 280, innerWidth - 24)
    popup.style.width = `${width}px`
    popup.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`
    popup.style.top = `${Math.max(12, rect.bottom + 6)}px`
    popup.style.maxHeight = `${Math.max(100, innerHeight - Math.max(12, rect.bottom + 6) - 12)}px`
  }
  const positionPopovers = () => { for (const popup of root.querySelectorAll<HTMLElement>('[popover]:popover-open')) positionPopover(popup) }
  const closePopovers = () => { for (const popup of root.querySelectorAll<HTMLElement>('[popover]:popover-open')) popup.hidePopover() }
  for (const popup of root.querySelectorAll<HTMLElement>('[popover]')) {
    popup.addEventListener('beforetoggle', (event) => {
      if ((event as Event & { newState: string }).newState !== 'open') return
      if (popup.id === 'lg-data') renderHealth(true)
      positionPopover(popup)
    })
  }
  addEventListener('resize', positionPopovers, { signal: ctx.signal })
  addEventListener('scroll', positionPopovers, { capture: true, signal: ctx.signal })
  $('#lg-custom', root).addEventListener('keydown', (event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); applyCustom() } })

  function controls(): void {
    const columns = visibleColumns()
    patchContent($('[data-lg-head]', root), header())
    for (const input of root.querySelectorAll<HTMLInputElement>('[data-column]')) {
      input.checked = columns.some(([key]) => key === input.dataset.column)
      input.disabled = EXACT.some(([key]) => key === input.dataset.column && !!preferences[key])
      input.parentElement!.title = input.disabled ? 'Clear the column’s filter before hiding it' : ''
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-level]')) button.setAttribute('aria-pressed', String(preferences.severities.some((level) => level === button.dataset.level)))
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-time]')) button.setAttribute('aria-pressed', String(button.dataset.time === preferences.time))
    const source: HTMLSelectElement = $('#lg-source', root)
    if (preferences.source && ![...source.options].some((option) => option.value === preferences.source)) source.add(new Option(preferences.source, preferences.source))
    source.value = preferences.source
    $('#lg-scope', root).value = preferences.scope
    $('#lg-scope-label', root).hidden = !access?.isAdmin
    for (const key of ['search', ...EXACT.map(([key]) => key)] as const) {
      const input = $(`#lg-${key}`, root) as HTMLInputElement
      if (document.activeElement !== input) input.value = preferences[key]
    }
    $('#lg-custom', root).hidden = preferences.time !== 'custom'
    for (const key of ['from', 'to'] as const) {
      const input = $(`#lg-${key}`, root) as HTMLInputElement
      if (document.activeElement !== input) input.value = (customDraft ?? preferences)[key]
    }
    for (const action of ['export', 'previous', 'next'] as const) {
      const button: HTMLButtonElement = $(`[data-action="${action}"]`, root)
      button.disabled = !page || (action === 'previous' && pageIndex === 0) || (action === 'next' && !page.nextCursor)
      button.setAttribute('aria-disabled', String(loading || button.disabled))
    }
    $('[data-action="refresh"]', root).setAttribute('aria-busy', String(loading))
  }

  function cell(event: LoggingEvent, key: Column): string {
    if (key === 'time') return `<td class="lg-c-time" data-ref="lg.time"><time datetime="${esc(event.eventTime ?? event.ingestedAt)}" title="${esc(`${event.eventTime ? 'Source time' : 'Ingestion time; the source gave none'} · ${effectiveTimezone()}`)}">${esc(date(event.eventTime ?? event.ingestedAt))}</time>${event.eventTime ? '' : '<span class="note">Ingested</span>'}</td>`
    if (key === 'impact') {
      const work = impacts.get(event.id)?.value
      const summary = work ? [work.impact, work.target, work.stage].filter(Boolean).join(' · ') : 'unknown'
      return `<td class="lg-c-impact${work ? ` is-${work.impact}` : ' dim'}" title="${esc(summary)}" data-ref="lg.impact">${esc(summary)}</td>`
    }
    if (key === 'severity') {
      const severity = loggingSeverity(event, impacts.get(event.id)?.value)
      return `<td class="lg-c-severity"><span class="sev is-${severity}" data-ref="lg.severity">${label(severity)}</span></td>`
    }
    if (key === 'source') return `<td class="lg-c-source" data-ref="lg.source">${esc(event.source)}</td>`
    if (key === 'occurrences') return `<td class="num" title="Retained occurrences in this incident">${(event.occurrences ?? 0).toLocaleString('en-US')}</td>`
    const value = String(event[key as keyof LoggingEvent] ?? '') || '—'
    return `<td class="lg-c-${key}${key.endsWith('Id') ? ' t-mono' : ''}" title="${esc(value)}">${esc(value)}</td>`
  }

  function render(): void {
    if (!active) return
    controls()
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined
    const boundary = scrollport.getBoundingClientRect().top + $('[data-lg-head]', root).getBoundingClientRect().height
    const anchor = [...tbody.querySelectorAll<HTMLElement>('tr.lg-row')].find((row) => row.getBoundingClientRect().bottom > boundary)
    const anchorId = anchor?.dataset.ev
    const anchorTop = anchor?.getBoundingClientRect().top
    const ids = new Set(page?.events.map((event) => event.id) ?? [])
    for (const id of [...expanded]) if (!ids.has(id) && linked?.id !== id) { expanded.delete(id); related.delete(id) }
    const columns = visibleColumns()
    const rows = page?.events.map((event) => {
      const open = expanded.has(event.id)
      return `<tr class="lg-row${linked?.id === event.id ? ' is-linked' : ''}" data-ev="${esc(event.id)}" data-ref="lg.row">${columns.map(([key]) => cell(event, key)).join('')}<td class="lg-c-more"><button type="button" class="ib chev${open ? ' is-open' : ''}" id="lg-expand-${esc(event.id)}" data-action="expand" data-row="${esc(event.id)}" data-focus="expand-${esc(event.id)}" aria-label="Show the evidence" aria-expanded="${open}" aria-controls="lg-detail-${esc(event.id)}" data-ref="lg.detail">${icon('chev', 'sm')}</button></td></tr>
        ${open ? `<tr class="sw-detail" data-lg-detail="${esc(event.id)}" id="lg-detail-${esc(event.id)}"><td colspan="${columns.length + 1}">${detail(event)}</td></tr>` : ''}`
    }).join('') ?? ''
    patchContent(tbody, rows)
    const status = $('[data-lg-status]', root)
    status.textContent = loading ? (page ? 'Refreshing retained diagnostics…' : 'Reading retained diagnostics…')
      : page ? `${page.total.toLocaleString('en-US')} matching retained events${preferences.severities.length ? '' : ' · No severities chosen'}${lastSuccess ? ` · Snapshot read ${date(new Date(lastSuccess).toISOString())}, in ${effectiveTimezone()}` : ''}${stale ? ' · These results are a previous snapshot' : ''}`
        : linkFailure ? evidenceFailure(linkFailure) : message || 'Diagnostics have not been read yet.'
    $('[data-lg-count]', root).textContent = page ? page.total.toLocaleString('en-US') : ''
    const note = $('[data-lg-message]', root)
    note.textContent = [message, preferenceWarning].filter(Boolean).join(' ')
    note.hidden = !note.textContent
    note.classList.toggle('is-info', !(message && messageTone === 'error') && !preferenceWarning)
    $('[data-lg-empty]', root).hidden = !page || page.events.length > 0 || loading || !!linkFailure
    $('[data-lg-page]', root).textContent = page ? `${pageIndex * 50 + (page.events.length ? 1 : 0)}–${pageIndex * 50 + page.events.length} of ${page.total.toLocaleString('en-US')}` : ''
    const fresh = $('[data-lg-new]', root)
    fresh.hidden = pageIndex !== 0 || !page || (!newCount && !rangeChanged)
    $('button', fresh).textContent = rangeChanged ? 'The time range moved on · read the diagnostics again' : `${newCount.toLocaleString('en-US')} new ${newCount === 1 ? 'diagnostic' : 'diagnostics'} · read them in`
    renderLink()
    renderHealth()
    if (focused) {
      const target = root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)
      if (target && !(target instanceof HTMLButtonElement && target.disabled)) target.focus({ preventScroll: true })
    }
    if (anchorId && anchorTop !== undefined) {
      const next = tbody.querySelector<HTMLElement>(`tr[data-ev="${CSS.escape(anchorId)}"]`)
      if (next) scrollport.scrollBy({ top: next.getBoundingClientRect().top - anchorTop, behavior: 'instant' as ScrollBehavior })
    }
    // The tab counts today's failing incidents in this snapshot, not each repeat of them.
    const today = midnightInZone(0).getTime()
    const errors = new Set((firstSnapshot?.page.events ?? []).filter((e) => e.severity !== 'warning' && Date.parse(e.eventTime ?? e.ingestedAt) >= today).map((e) => e.incidentId)).size
    ctx.count(errors ? `${capsule('failed')}${errors} ${errors === 1 ? 'error' : 'errors'} today` : '')
    syncPolling()
  }

  function evidenceFailure(error: LoggingApiError): string {
    return error.status === 410 ? 'Linked diagnostic evidence has expired.' : error.status === 404 ? 'Linked diagnostic evidence is unavailable.'
      : error.status === 400 ? 'The diagnostic link is invalid.' : error.status === 401 ? 'Sign in to read diagnostic evidence.'
        : error.status === 403 ? 'Diagnostic access is unavailable.' : error.status === 429 ? 'The diagnostic query service is busy.' : 'The diagnostic query service is unavailable.'
  }
  function renderLink(): void {
    const target = $('[data-lg-link]', root)
    const outside = linked && !page?.events.some((event) => event.id === linked!.id)
    patchContent(target, linkFailure
      ? `<section class="lg-linked is-failed" data-ref="lg.linked"><p><b>${esc(evidenceFailure(linkFailure))}</b> ${esc(linkFailure.message)}</p><button type="button" class="btn-ghost" data-action="restore">Browse retained diagnostics</button>${access?.isAdmin && preferences.scope === 'workspace' && linkFailure.status === 404 ? '<button type="button" class="btn-ghost" data-action="link-instance">Use instance scope</button>' : ''}</section>`
      : link ? `<section class="lg-linked" data-ref="lg.linked"><p><b>${outside ? 'Linked diagnostic, outside this page.' : 'Linked diagnostic.'}</b> ${esc(linkMessage)}</p><button type="button" class="btn-ghost" data-action="restore">Restore saved filters</button></section>${outside && linked ? `<div class="lg-outside" data-lg-detail="${esc(linked.id)}">${detail(linked)}</div>` : ''}` : '')
  }
  function coverageHistory(source: LoggingPage['coverage'][number]): string {
    const gaps = source.gaps.length ? `<details><summary>${source.gaps.length}${source.historyIncomplete ? '+' : ''} ${source.gaps.length === 1 ? 'gap' : 'gaps'}</summary><ul>${source.gaps.map((gap) => `<li>${esc(date(gap.from))} – ${esc(gap.to ? date(gap.to) : 'open')} · ${esc(gap.reason)}</li>`).join('')}</ul></details>` : source.historyIncomplete ? 'Limited' : '<span class="dim">—</span>'
    const loss = [source.dropped ? `at least ${source.dropped.toLocaleString('en-US')} dropped` : '', source.rejected ? `at least ${source.rejected.toLocaleString('en-US')} rejected` : ''].filter(Boolean).join(' · ')
    return gaps + (loss ? `<small>${esc(loss)}</small>` : '')
  }
  function renderHealth(opening = false): void {
    const bounds = page?.bounds ?? linkBounds ?? health?.bounds
    const sources = health?.collection.sources ?? page?.coverage ?? []
    const healthFresh = !!health && !healthMessage && healthReadAt !== null && performance.now() - healthReadAt <= 60_000
    const state = health && !healthFresh ? 'stale' : health?.collection.currentStatus ?? (health?.collection.status === 'partial' ? 'initializing' : health?.collection.status)
    const queryState = queryUnavailable ? 'unavailable' : healthFresh ? health?.query.status : health ? 'stale' : undefined
    const word = (value: string | undefined) => value === 'connected' ? 'Connected' : value === 'partial' ? 'Degraded' : value === 'initializing' ? 'Awaiting observation' : value === 'not-configured' ? 'Not configured' : value ? label(value) : 'Not read'
    const issue = queryUnavailable || !!healthMessage || (!!state && state !== 'connected') || queryState === 'unavailable'
    const button = $('#lg-data-button', root)
    $('[data-lg-dot]', root).className = `sdot${issue ? ' is-warn' : state === 'connected' ? ' is-saved' : ''}`
    button.title = `Data and collection · ${queryUnavailable ? 'Query unavailable' : healthMessage ? 'Health unavailable' : word(state)}`
    if (!opening && !$('#lg-data', root).matches(':popover-open')) return
    patchContent($('[data-lg-health]', root), `<dl class="lg-facts is-two">${field('Collection now', word(state))}${field('Query service', word(queryState))}
      ${field('Snapshot', lastSuccess ? date(new Date(lastSuccess).toISOString()) : null)}${field('Collection read', health ? date(health.collection.checkedAt) : null)}
      ${field('Retention boundary', bounds ? date(bounds.retentionAfter) : null)}${field('Earliest retained', bounds?.from ? date(bounds.from) : null)}${field('Latest retained', bounds?.to ? date(bounds.to) : null)}${field('Time zone', `${effectiveTimezone()}, from General`)}
      ${field('Active loss', healthFresh && health?.collection.lossActive !== undefined ? health.collection.lossActive ? 'Yes' : 'No' : null)}${field('Historical loss recorded', health ? health.collection.lossObserved ? 'Yes' : 'No' : null)}</dl>
      ${healthMessage ? `<p class="note is-warn">${esc(healthMessage)}</p>` : ''}
      <table class="lg-sources" aria-label="Diagnostic sources"><thead><tr><th>Source</th><th>Now</th><th>Last observed</th><th>History</th></tr></thead><tbody>${sources.map((source) => {
        const now = currentCoverageStatus(source)
        const text = health && !healthFresh ? 'Stale' : source.optional && now === 'not-configured' ? 'Not applicable' : word(now)
        return `<tr><td>${esc(source.source)}<span class="dim t-mono"> ${esc(source.id)}</span></td><td title="${esc(source.error ?? '')}">${capsule(now === 'connected' ? 'done' : now === 'unavailable' ? 'failed' : 'waiting')}${esc(text)}${source.error && now !== 'connected' ? `<small>${esc(source.error)}</small>` : ''}</td><td>${esc(source.observedAt ? date(source.observedAt) : '—')}</td><td>${coverageHistory(source)}</td></tr>`
      }).join('')}</tbody></table>`)
  }

  // ---------- Reading ----------
  async function readHealth(mine: number): Promise<void> {
    if (!access || !current(mine)) return
    const request = controller()
    try {
      const value = await loggingHealth(access, preferences.scope, request.signal)
      if (current(mine)) { health = value; healthReadAt = performance.now(); healthMessage = ''; render() }
    } catch (error) {
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
      if (!access.isAdmin && preferences.scope === 'instance') { preferences.scope = 'workspace'; setMessage('Instance access is unavailable; your workspace is chosen.', 'info') }
      return true
    } finally { requests.delete(request) }
  }

  async function loadPage(cursor: string | null = null, fresh = true, focusTarget = false, targetPage = pageIndex): Promise<void> {
    const mine = invalidate()
    loading = true; stale = null; setMessage('')
    render()
    const request = controller()
    try {
      if (!await ensureAccess(mine) || !access) return
      let candidate: LoggingQuery
      try { candidate = fresh ? query() : applied! }
      catch (error) { throw new LoggingApiError(400, 'invalid_logging_query', error instanceof Error ? error.message : 'Invalid diagnostic filters.') }
      const value = await loggingPage(access, { ...candidate, ...(cursor ? { cursor } : {}) }, request.signal)
      if (!current(mine)) return
      if (fresh && applied && loggingParameters(applied).toString() !== loggingParameters(candidate).toString()) { related.clear(); scrollport.scrollTop = 0 }
      if (!fresh || pageIndex !== 0) scrollport.scrollTop = 0
      page = value; impacts = new Map(); applied = candidate; lastSuccess = Date.now(); loading = false; linkFailure = null; queryUnavailable = false
      if (fresh) { firstSnapshot = { page: value, at: lastSuccess, impacts }; cursors = [null]; pageIndex = 0; newCount = 0; rangeChanged = false; failures = 0; retryAt = 0 }
      else pageIndex = targetPage
      render()
      void readWorkImpacts()
      const targetId = linked?.id
      if (focusTarget && targetId) requestAnimationFrame(() => {
        if (!current(mine)) return
        const row = tbody.querySelector<HTMLElement>(`tr[data-ev="${CSS.escape(targetId)}"]`)
        row?.scrollIntoView({ block: 'center' })
        ;(row?.querySelector<HTMLElement>('[data-action="expand"]') ?? $('[data-lg-link] .btn-ghost', root))?.focus({ preventScroll: true })
      })
      void readHealth(mine)
    } catch (error) {
      if (!current(mine) || request.signal.aborted) return
      const problem = failure(error)
      setMessage(problem.status === 400 ? `Invalid diagnostic filters: ${problem.message}` : problem.message)
      stale = page ? 'failed' : null
      if (problem.status !== 400) { queryUnavailable = true; void readHealth(mine) }
      if (problem.status === 401 || problem.status === 403) { denied(); stale = null }
    } finally { requests.delete(request); if (current(mine)) { loading = false; render() } }
  }

  async function initialRead(): Promise<void> {
    const mine = invalidate()
    customDraft = null
    loading = true; page = null; firstSnapshot = null; impacts = new Map(); health = null; healthReadAt = null; healthMessage = ''; queryUnavailable = false
    applied = null; linked = null; link = null; linkFailure = null; linkBounds = null; setMessage(''); newCount = 0; pageIndex = 0; cursors = [null]
    const request = controller()
    try {
      try { link = linkSearch ? parseLoggingLink(linkSearch) : null }
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
        preferences = { ...defaults(), columns: preferences.columns, scope, time: 'custom', from, to, incidentId: link.incident ?? '' }
        expanded.add(value.id)
        linkMessage = widened ? 'The linked interval was widened to include the diagnostic. Your saved filters are kept.' : 'The linked interval and all three severities are applied. Your saved filters are kept.'
      } else if (link?.from || link?.to) {
        preferences.time = 'custom'; preferences.from = link.from ?? ''; preferences.to = link.to ?? ''; linkMessage = 'The linked interval is applied. Your saved filters are kept.'
      }
      if (current(mine)) void loadPage(null, true, !!linked)
    } catch (error) {
      if (!current(mine) || request.signal.aborted) return
      linkFailure = failure(error)
      if (linkFailure.status >= 500 || linkFailure.status === 429) queryUnavailable = true
      linkBounds ??= loggingErrorBounds(linkFailure)
      loading = false
      render()
      requestAnimationFrame(() => { if (current(mine)) $('[data-lg-link] .btn-ghost', root)?.focus({ preventScroll: true }) })
      if (access) void readHealth(mine)
    } finally { requests.delete(request) }
  }

  /** New diagnostics are counted, never drawn in: the table holds still until you read them in. */
  async function poll(): Promise<void> {
    if (!active || document.hidden || pageIndex !== 0 || !page || !applied || !access || requests.size || loading || Date.now() < retryAt) return
    try { if (loggingParameters(query()).toString() !== loggingParameters(applied).toString()) { rangeChanged = true; render(); return } }
    catch (error) { setMessage(`The diagnostic filters need correcting: ${failure(error).message}`); render(); return }
    const mine = generation, request = controller()
    try {
      const value = await loggingPage(access, { ...applied, after: page.watermark, limit: 1 }, request.signal)
      if (!current(mine)) return
      newCount = value.total; failures = 0; retryAt = 0; queryUnavailable = false
      if (stale === 'failed') setMessage('The earlier refresh failed; these results are a previous snapshot. Refresh or read the new diagnostics in to update them.')
      render()
      void readHealth(mine)
    } catch (error) {
      if (current(mine) && !request.signal.aborted) {
        const problem = failure(error)
        stale = 'failed'
        setMessage(`Refresh unavailable; these results are a previous snapshot. ${problem.message}`)
        queryUnavailable = true
        retryAt = Date.now() + Math.min(120_000, 15_000 * 2 ** Math.min(++failures, 3))
        if (problem.status === 401 || problem.status === 403) denied(); else void readHealth(mine)
        render()
      }
    } finally { requests.delete(request) }
  }

  const refreshCurrent = (): void => { if (link || linkFailure) void initialRead(); else void loadPage() }
  function filtersChanged(wait = false): void {
    invalidate(); clearLinkUrl(); page = null; firstSnapshot = null; linked = null; health = null; expanded.clear(); related.clear(); pageIndex = 0; setMessage(''); persist(); render()
    if (wait) debounce = window.setTimeout(() => { debounce = 0; void loadPage() }, 250)
    else void loadPage()
  }
  function applyCustom(): void {
    preferences.time = 'custom'
    preferences.from = ($('#lg-from', root) as HTMLInputElement).value
    preferences.to = ($('#lg-to', root) as HTMLInputElement).value
    customDraft = null
    filtersChanged()
  }

  async function readRelated(id: string, correlation = false, nextPage = 0, fresh = true): Promise<void> {
    if (!access || !applied) return
    const event = page?.events.find((e) => e.id === id) ?? (linked?.id === id ? linked : null)
    if (!event || related.get(id)?.loading) return
    const previous = related.get(id)
    const same = previous?.correlation === correlation ? previous : null
    const state: Related = !fresh && same ? same : { loading: false, events: same?.events ?? [], total: same?.total ?? 0, cursor: null, history: [null], page: 0, error: '', correlation, first: null }
    if (!fresh && nextPage === 0 && state.first) { state.events = state.first.events; state.total = state.first.total; state.cursor = state.first.cursor; state.page = 0; state.error = ''; render(); return }
    if (nextPage > state.page && state.cursor) state.history[nextPage] = state.cursor
    state.loading = true; state.error = ''; related.set(id, state); render()
    const mine = generation, request = controller()
    try {
      const value = await loggingPage(access, { scope: applied.scope, severities: applied.severities, from: applied.from, to: applied.to,
        ...(correlation ? { correlationId: event.correlationId! } : { incidentId: event.incidentId }), limit: 20, ...(state.history[nextPage] ? { cursor: state.history[nextPage]! } : {}) }, request.signal)
      if (!current(mine) || related.get(id) !== state) return
      state.events = value.events; state.total = value.total; state.cursor = value.nextCursor; state.page = nextPage
      if (nextPage === 0) state.first = { events: value.events, total: value.total, cursor: value.nextCursor }
    } catch (error) {
      if (current(mine) && !request.signal.aborted) state.error = `${state.events.length ? 'The related diagnostics shown are from before; the new read failed. ' : ''}${failure(error).message}`
    } finally { requests.delete(request); if (current(mine) && related.get(id) === state) { state.loading = false; render() } }
  }

  async function readWorkImpacts(): Promise<void> {
    if (!access || !page) return
    const events: LoggingEvent[] = [...page.events]
    if (linked && !events.some((event) => event.id === linked!.id)) events.push(linked)
    const state = impacts
    const mine = generation, request = controller()
    try {
      const values = await loggingWorkImpacts(access, events, request.signal)
      if (!current(mine)) return
      for (const [id, value] of values) state.set(id, { value, message: value ? '' : 'No managed chain step matches this evidence exactly.' })
    } catch (error) {
      if (current(mine) && !request.signal.aborted) for (const event of events) state.set(event.id, { value: null, message: `Workspace chain evidence is unavailable. ${failure(error).message}` })
    } finally {
      requests.delete(request)
      if (current(mine)) render()
    }
  }

  async function exportCurrent(): Promise<void> {
    if (!access || !page) return
    const mine = generation, request = controller()
    const button = $('[data-action="export"]', root)
    button.setAttribute('aria-busy', 'true')
    try {
      const filters = { ...applied! }
      delete filters.cursor; delete filters.after; delete filters.limit
      const blob = await loggingExport(access, filters, request.signal)
      if (!current(mine)) return
      const url = URL.createObjectURL(blob)
      const anchor = Object.assign(document.createElement('a'), { href: url, download: 'poise-diagnostics.ndjson' })
      anchor.click()
      ctx.after(1000, () => URL.revokeObjectURL(url))
      setMessage('')
      render()
    } catch (error) {
      if (current(mine) && !request.signal.aborted) { setMessage(`The export failed; no complete download was made. ${failure(error).message}`); render() }
    } finally { requests.delete(request); button.removeAttribute('aria-busy') }
  }

  function instanceLink(): void {
    if (!access?.isAdmin) return
    const saved = loadPreferences(); saved.scope = 'instance'; persist(saved); preferences.scope = 'instance'
    void initialRead()
  }

  // ---------- Events ----------
  root.addEventListener('click', (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button')
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return
    const level = LOGGING_LEVELS.find((value) => value === button.dataset.level)
    if (level) { preferences.severities = preferences.severities.includes(level) ? preferences.severities.filter((value) => value !== level) : LOGGING_LEVELS.filter((value) => value === level || preferences.severities.includes(value)); filtersChanged(); return }
    if (button.dataset.time) {
      customDraft = null
      const time = button.dataset.time
      if (time === 'custom') {
        preferences.time = 'custom'
        preferences.from ||= applied?.from ?? new Date(Date.now() - 3_600_000).toISOString()
        preferences.to ||= applied?.to ?? new Date().toISOString()
      } else if (isTimeRange(time)) preferences.time = time
      filtersChanged()
      return
    }
    const id = button.dataset.row
    switch (button.dataset.action) {
      case 'clear-filter': {
        const key = EXACT.find(([name]) => name === button.dataset.field)?.[0]
        if (key) { preferences[key] = ''; filtersChanged(); ($(`#lg-${key}`, root) as HTMLInputElement | null)?.focus() }
        break
      }
      case 'expand': if (id) { if (expanded.has(id)) { expanded.delete(id); related.delete(id) } else expanded.add(id); render() } break
      case 'refresh': case 'new': refreshCurrent(); break
      case 'export': if (button.getAttribute('aria-busy') !== 'true') void exportCurrent(); break
      case 'custom': applyCustom(); break
      case 'next': if (page?.nextCursor) { cursors[pageIndex + 1] = page.nextCursor; void loadPage(page.nextCursor, false, false, pageIndex + 1) } break
      case 'previous': if (pageIndex > 0) {
        const previous = pageIndex - 1
        if (previous === 0 && firstSnapshot) { const mine = invalidate(); pageIndex = 0; page = firstSnapshot.page; impacts = firstSnapshot.impacts; lastSuccess = firstSnapshot.at; setMessage(''); stale = null; render(); void readHealth(mine) }
        else void loadPage(cursors[previous], false, false, previous)
      } break
      case 'related': if (id) void readRelated(id); break
      case 'correlation': if (id) void readRelated(id, true); break
      case 'related-next': if (id) { const r = related.get(id); if (r?.cursor) void readRelated(id, r.correlation, r.page + 1, false) } break
      case 'related-previous': if (id) { const r = related.get(id); if (r && r.page > 0) void readRelated(id, r.correlation, r.page - 1, false) } break
      case 'related-event': if (button.dataset.event) ctx.go(partHref('logging', { event: button.dataset.event }, back)); break
      case 'restore': invalidate(); clearLinkUrl(); customDraft = null; preferences = loadPreferences(); expanded.clear(); related.clear(); page = null; firstSnapshot = null; void loadPage(); break
      case 'link-instance': instanceLink(); break
    }
  })
  root.addEventListener('input', (event: Event) => {
    const input = event.target as HTMLInputElement
    if (input.id === 'lg-from' || input.id === 'lg-to') {
      customDraft ??= { from: preferences.from, to: preferences.to }
      customDraft[input.id === 'lg-from' ? 'from' : 'to'] = input.value
      return
    }
    if (input.id === 'lg-search') preferences.search = input.value
    else {
      const exact = EXACT.find(([key]) => key === input.dataset.field)
      if (!exact) return
      preferences[exact[0]] = input.value
    }
    filtersChanged(true)
  })
  root.addEventListener('change', (event: Event) => {
    const column = event.target as HTMLInputElement
    const key = OPTIONAL.find(([name]) => name === column.dataset.column)?.[0]
    if (key) {
      if (!column.checked && preferences[key]) { column.checked = true; return }
      preferences.columns = column.checked ? [...preferences.columns.filter((name) => name !== key), key] : preferences.columns.filter((name) => name !== key)
      if (link) {
        const saved = loadPreferences()
        saved.columns = column.checked ? [...saved.columns.filter((name) => name !== key), key] : saved.columns.filter((name) => name !== key)
        persist(saved)
      } else persist()
      render()
      return
    }
    const select = event.target as HTMLSelectElement
    if (select.id === 'lg-source') { preferences.source = select.value; filtersChanged() }
    if (select.id === 'lg-scope' && (select.value === 'workspace' || select.value === 'instance')) {
      preferences.scope = select.value
      if (link) { const saved = loadPreferences(); saved.scope = preferences.scope; persist(saved); void initialRead() } else filtersChanged()
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (!active) return
    if (document.hidden) {
      const pending = loading
      invalidate()
      if (pending && page) { stale = 'paused'; setMessage('The read was paused while this tab was hidden.', 'info') }
      syncPolling()
    } else {
      render()
      if (!page && !linkFailure) void initialRead()
      else { syncPolling(); if (pageIndex === 0) void poll() }
    }
  }, { signal: ctx.signal })

  return {
    show() {
      active = true
      if (!started) { started = true; void initialRead(); if (ctx.query.get('data') === '1') $('#lg-data', root).showPopover(); return }
      render()
      if (!page) void initialRead()
      else if (pageIndex === 0) void poll()
    },
    hide() {
      closePopovers()
      // A read cut off here is read again when the part shows.
      invalidate()
      active = false
      syncPolling()
    },
    busy: () => false,
    leave() {
      closePopovers()
      active = false
      invalidate()
      stopTick?.()
      stopTick = null
    },
  }
}
