import { viewFeedback } from '../view-feedback'
// Main table view — reads through /api/gh from the unified /github API.

import { getSettings, getOrganizations, effectiveTimezone, midnightInZone, startOfWeekInZone } from '../config'
import { fullTime } from '../clock'
import { layout, retire } from '../motion'
import { patchContent } from '../dom-patch'
import { mountOrganizationFilter, organizationPayload, organizationErrors } from '../organizations'

const STORAGE_KEY = 'poise-filters-v2'
const REVIEWED_KEY = 'poise-reviewed'
const PAGE_SIZE = 20

const reviewed: Set<string> = new Set(
  (() => { try { return JSON.parse(localStorage.getItem(REVIEWED_KEY) || '[]') } catch { return [] } })()
)
function saveReviewed() { localStorage.setItem(REVIEWED_KEY, JSON.stringify([...reviewed])) }

// Reviews in flight, by pull-request URL. This guard used to be two statements
// on the button element — `disabled = true`, and a re-entry check reading it
// back. buildRow rebuilds that button from scratch with no notion of a review
// in progress, and three ordinary things clear the whole tbody: returning to
// Archive, clicking a filter pill, and typing in the search box. Any of them
// handed back an enabled, idle-looking play button while the review was still
// running, and the call has a two-minute budget. Confab posts its output back
// on the pull request, so a second click meant a second review posted for real
// on the same PR. The guard has to outlive the node.
const reviewing = new Set<string>()

const PLAY_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg>'
const SPIN_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="spin"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="8 6" stroke-linecap="round"/></svg>'

interface PrRow {
  kind?: 'pr' | 'issue' | 'action'
  branch?: string
  event?: string
  repo: string
  number: number
  title: string
  html_url: string
  author: string
  is_pr: number
  state: string
  owner_login: string | null
  owner_avatar: string | null
  updated_at: string
  merged_at: string | null
}

type TypeFilter = 'issue' | 'pr' | 'action'
type StatusFilter = 'all' | 'open'
type TimeFilter = 'all' | 'today' | 'yesterday' | 'week'

let typeFilters = new Set<TypeFilter>(['action'])
let statusFilter: StatusFilter = 'all'
let actionStatus: 'all' | 'failed' = 'failed'
let timeFilter: TimeFilter = 'all'
let searchQuery = ''
let items: PrRow[] = []
let total = 0
let partialResults = false
let done = false
let fetching = false
let initialized = false
let organizationDirty = false
let observer: IntersectionObserver | null = null
let searchDebounce: ReturnType<typeof setTimeout> | null = null
// Tick listener installed when the view is initialized; removed via
// stopMainRefresh() when navigating away. Single shared clock — see
// startRefreshTicker() in src/config.ts.
const onTick = () => refreshMainSoft()
let tickListening = false

// DOM
let tbody: HTMLTableSectionElement
let loader: HTMLDivElement
let table: HTMLTableElement
let clusterEl: HTMLElement
let timePickerEl: HTMLElement
let countEl: HTMLSpanElement
let searchInput: HTMLInputElement
let sentinel: HTMLDivElement

function showLoadError(message: string): void {
  viewFeedback('archive-read', 'Archive data is incomplete', message, 'read_failed')
}

function loadFilters(): void {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw)
    const legacy = parsed.type === 'both' ? ['issue', 'pr'] : [parsed.type]
    const types: unknown[] = Array.isArray(parsed.types) ? parsed.types : legacy
    typeFilters = new Set(types.filter((type): type is TypeFilter => type === 'action' || type === 'issue' || type === 'pr'))
    statusFilter = parsed.status === 'open' ? 'open' : 'all'
    actionStatus = parsed.actionStatus === 'all' || (parsed.type === 'action' && parsed.status === 'all') ? 'all' : 'failed'
    if (['all', 'today', 'yesterday', 'week'].includes(parsed.time)) timeFilter = parsed.time
  } catch { /* Invalid stored preferences use the defaults. */ }
}

function saveFilters() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ types: [...typeFilters], status: statusFilter, actionStatus, time: timeFilter }))
}

function timeWindow(): { since?: string; until?: string } {
  if (timeFilter === 'today') {
    return { since: midnightInZone(0).toISOString() }
  }
  if (timeFilter === 'yesterday') {
    return { since: midnightInZone(-1).toISOString(), until: midnightInZone(0).toISOString() }
  }
  if (timeFilter === 'week') {
    return { since: startOfWeekInZone().toISOString() }
  }
  return {}
}

// The same s/m/h/d/mo/y vocabulary the other views use. This was a drifted
// copy that collapsed everything under a day to the word "today" — which read
// as wrong next to the Yesterday pill (a row updated at 00:30 today is
// "today", but so was one from 23 hours ago), and told you nothing about how
// recent a row actually was.
function relativeDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!isFinite(t)) return '—'
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  const days = Math.floor(secs / 86400)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

// The updated cell's tooltip: the exact time on Poise's clock, or no tooltip
// when the time does not parse — relativeDate shows '—' then, and fullTime
// throws for what it cannot read.
function updatedTitle(iso: string, zone: string): string | null {
  return Number.isFinite(Date.parse(iso)) ? fullTime(iso, zone) : null
}

// Attribute-safe HTML escape. textContent → innerHTML only escapes &,
// <, >; we also need to escape " and ' so attribute interpolations
// like `title="${escapeHtml(text)}"` don't break on quoted content.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}

function safeHttpsUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? escapeHtml(url.href) : '#'
  } catch {
    return '#'
  }
}

function stateLabel(item: PrRow): { text: string; cls: string } {
  if (item.kind === 'action') {
    const text = item.state.replace(/_/g, ' ')
    const cls = item.state === 'failure' || item.state === 'timed_out' ? 'bad'
      : item.state === 'success' ? 'ok'
      : ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(item.state) ? 'live' : 'flat'
    return { text: text.charAt(0).toUpperCase() + text.slice(1), cls }
  }
  if (item.is_pr === 1 && item.merged_at) return { text: 'Merged', cls: 'merged' }
  return item.state === 'open' ? { text: 'Open', cls: 'open' } : { text: 'Closed', cls: 'closed' }
}

function humanAvatarFallback(username: string): string {
  // Only works for real user accounts (not GitHub Apps). Used if we don't have the
  // API-reported avatar_url stored yet.
  return `https://github.com/${encodeURIComponent(username)}.png?size=48`
}

// Populated only when the pull request has an assignee — 7 of 400 rows in the
// current cache. The dash is honest, but it is worth saying which kind of
// absence it is rather than leaving it to be read as missing data.
function ownerCell(item: PrRow): string {
  const name = item.owner_login
  if (!name) return '<span class="last-dash" title="No assignee">—</span>'
  const isBot = /\[bot\]$/i.test(name)
  const src = item.owner_avatar && item.owner_avatar.length > 0 ? item.owner_avatar : humanAvatarFallback(name)
  const classes = ['last-avatar']
  if (isBot) classes.push('is-bot')
  return `<img class="${classes.join(' ')}" src="${safeHttpsUrl(src)}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" loading="lazy" decoding="async" />`
}

// The column this fills was headed "Last", which reads as "who acted last".
// There is no such field in the record — this is the author, and it always was
// (every one of the 400 sampled rows has one). The header now says Author, so
// the column and its contents agree.
function lastCell(item: PrRow): string {
  const name = item.author
  if (!name) return '<span class="last-dash">\u2014</span>'

  const isBot = /\[bot\]$/i.test(name)
  const src = humanAvatarFallback(name)
  const classes = ['last-avatar']
  if (isBot) classes.push('is-bot')
  return `<img class="${classes.join(' ')}" src="${safeHttpsUrl(src)}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" loading="lazy" decoding="async" />`
}

// Stable identity for a row across refreshes. Matches the format Current
// uses for live items so the FLIP path captures the same kind of key.
function rowKey(item: PrRow): string {
  return item.kind === 'action' ? `${item.repo}:action:${item.number}` : `${item.repo}#${item.number}`
}

// A settled pull request is not a review target. The button was rendered armed
// on every PR row — `stateLabel(item)` was computed on the line above it and
// never consulted — and Archive defaults to "Any" status, so merged and closed
// work fills the default view. Clicking one dispatched a full consensus review
// and had Confab post its output back on a pull request that shipped weeks
// ago. Current was changed for exactly this case; Archive never was.
//
// The in-flight state is rendered from `reviewing`, not left on the node, so a
// running review still reads as running after the table is rebuilt.
function reviewButtonHtml(item: PrRow, st: { text: string; cls: string }): string {
  const settled = st.cls === 'merged' || st.cls === 'closed'
  if (settled) {
    return `<button class="review-btn" disabled aria-label="Run consensus review (unavailable)"`
      + ` title="This pull request is ${st.text.toLowerCase()} — nothing to review">${PLAY_SVG}</button>`
  }
  const busy = reviewing.has(item.html_url)
  if (busy) {
    return `<button class="review-btn running" disabled aria-label="Consensus review running"`
      + ` title="Consensus review running…">${SPIN_SVG}</button>`
  }
  const isDone = reviewed.has(item.html_url)
  return `<button class="review-btn${isDone ? ' done' : ''}" aria-label="Run consensus review"`
    + ` title="${isDone ? 'Reviewed — run again' : 'Run consensus review'}">${PLAY_SVG}</button>`
}

function buildRow(item: PrRow): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.dataset.key = rowKey(item)
  paintRow(tr, item)
  return tr
}

// Repaint an existing row from current data. The FLIP moved rows without ever
// touching their contents, so a pull request that merged since the first paint
// slid to a new position still showing "Open" and its original timestamp — the
// movement said something had changed and every cell said nothing had.
function paintRow(tr: HTMLTableRowElement, item: PrRow): void {
  const pr = item.is_pr === 1
  const st = stateLabel(item)
  const actionHtml = pr ? reviewButtonHtml(item, st) : ''

  const action = item.kind === 'action'
  const [org, repo] = item.repo.split('/', 2)
  const repoUrl = `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`
  const tone = action ? st.cls : st.cls === 'open' ? 'live' : st.cls === 'merged' ? 'ok' : 'flat'
  const updated = updatedTitle(item.updated_at, effectiveTimezone())
  patchContent(tr, `
    <td><span class="type-toggle ${pr ? 'pr' : action ? 'action' : 'issue'}">${pr ? 'PR' : action ? 'CI' : 'IS'}</span></td>
    <td class="title-cell"><a href="${safeHttpsUrl(item.html_url)}" target="_blank" rel="noopener" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</a></td>
    <td class="last-cell">${lastCell(item)}</td>
    <td class="org-cell"><a class="agent-org" href="https://github.com/${encodeURIComponent(org)}" target="_blank" rel="noopener">${escapeHtml(org)}</a></td>
    <td><a class="agent-repo repo-name" href="${repoUrl}" target="_blank" rel="noopener" title="${escapeHtml(item.repo)}">${escapeHtml(repo)}</a></td>
    <td class="${action ? 'branch-cell' : 'last-cell'}">${action ? `<span class="agent-pr" title="${escapeHtml(item.event || '')}">${escapeHtml(item.branch || '—')}</span>` : ownerCell(item)}</td>
    <td><span class="agent-status ${tone}"><span class="agent-status-label">${escapeHtml(st.text)}</span></span></td>
    <td class="updated-cell"><span class="date"${updated === null ? '' : ` title="${escapeHtml(updated)}"`}>${relativeDate(item.updated_at)}</span></td>
    <td class="action-cell">${actionHtml}</td>
  `)
}

function updateCount() {
  countEl.textContent = partialResults ? String(items.length) : total > 0 ? `${Math.min(items.length, total)} / ${total}` : ''
}

function applyMainFlip(nextItems: PrRow[]) {
  layout(tbody, () => {
    const existingEls = new Map<string, HTMLTableRowElement>()
    for (const el of [...tbody.children] as HTMLTableRowElement[]) {
      if (el.dataset.key) existingEls.set(el.dataset.key, el)
    }
    const newKeys = new Set(nextItems.map(rowKey))
    for (const [key, el] of existingEls) if (!newKeys.has(key)) retire(el)
    const fragment = document.createDocumentFragment()
    for (const item of nextItems) {
      const existing = existingEls.get(rowKey(item))
      if (existing) { paintRow(existing, item); fragment.appendChild(existing) }
      else fragment.appendChild(buildRow(item))
    }
    tbody.appendChild(fragment)
  })
}

function sentinelNeedsFetch(): boolean {
  if (!sentinel || done) return false
  const rect = sentinel.getBoundingClientRect()
  // Match observer's rootMargin: fire if sentinel is within 400px of viewport bottom
  return rect.top < window.innerHeight + 400
}

// Subset of the /api/gh record shape used by Archive. The proxy keeps
// the legacy envelope; we only pluck what the table needs.
interface GhRecord {
  kind: 'pr' | 'issue' | 'action'
  branch?: string
  event?: string
  repo: string                      // "acme/foo"
  number: number
  state: string
  title: string
  url: string
  updated_at: string
  author: string
  merged_at: string | null
  owner_login: string | null
  owner_avatar: string | null
}

function recordToRow(r: GhRecord): PrRow {
  return {
    kind: r.kind,
    branch: r.branch,
    event: r.event,
    repo: r.repo,
    number: r.number,
    title: r.title,
    html_url: r.url,
    author: r.author,
    is_pr: r.kind === 'pr' ? 1 : 0,
    state: r.state === 'merged' ? 'closed' : r.state,   // collapse to open/closed; merged_at distinguishes
    owner_login: r.owner_login,
    owner_avatar: r.owner_avatar,
    updated_at: r.updated_at,
    merged_at: r.merged_at,
  }
}

function updateFilterContext(): void {
  const action = typeFilters.has('action')
  const history = typeFilters.has('pr') || typeFilters.has('issue')
  document.getElementById('filter-status')!.hidden = !history
  document.getElementById('filter-action-status')!.hidden = !action
  document.querySelector('#table .col-owner')!.textContent = action ? history ? 'Owner / Branch' : 'Branch' : 'Owner'
}

interface SourceState {
  type: TypeFilter
  payload: Record<string, unknown>
  rows: PrRow[]
  total: number
  partial: boolean
  done: boolean
  fetching: boolean
  loaded: boolean
  pending: boolean
  error: string
  countError: string
  loadedAt: number
  revision: number
  failures: number
  retryRefresh: boolean
  timer?: ReturnType<typeof setTimeout>
}

// A source owns its rows and paging independently. A slow Actions repository or
// history count cannot hold another source's first paint or subsequent pages.
const sources = new Map<string, SourceState>()
function selectedSources(): SourceState[] {
  const selected = [...typeFilters].map((type) => {
    const win = timeWindow()
    const payload = {
      operation: type === 'action' ? 'actions' : 'list', ...organizationPayload(),
      record_type: type === 'pr' ? 'pull_request' : 'issue',
      record_state: type === 'action' ? actionStatus : statusFilter,
      ...(type === 'action' ? { snapshot: true } : {}),
      ...(win.since ? { updated_since: win.since } : {}),
      ...(win.until ? { updated_until: win.until } : {}),
      ...(searchQuery ? { q: searchQuery } : {}),
    }
    const key = JSON.stringify([getSettings().me, getOrganizations().filter(org => org.status === 'ready').map(org => org.login), payload])
    let source = sources.get(key)
    if (!source) {
      source = { type, payload, rows: [], total: 0, partial: true, done: false, fetching: false,
        loaded: false, pending: false, error: '', countError: '', loadedAt: 0, revision: 0, failures: 0, retryRefresh: false }
      sources.set(key, source)
    }
    return source
  })
  for (const [key, source] of sources) {
    if (sources.size <= 24) break
    if (!selected.includes(source) && !source.fetching && !source.timer) sources.delete(key)
  }
  return selected
}

function mainVisible(): boolean { return !document.getElementById('view-main')!.hidden }

function paintSources(): void {
  const selected = selectedSources()
  const next = [...new Map(selected.flatMap(source => source.rows).map(item => [rowKey(item), item])).values()]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const rowsChanged = next.length !== items.length || next.some((row, index) => row !== items[index])
  items = next
  total = selected.reduce((sum, source) => sum + source.total, 0)
  partialResults = selected.some(source => source.partial || source.pending)
  fetching = selected.some(source => source.fetching || source.pending)
  done = selected.every(source => source.done)
  loader.hidden = !fetching
  showLoadError(selected.flatMap(source => [source.error, source.countError]).filter(Boolean).join(' '))
  if (items.length) {
    table.hidden = false
    if (rowsChanged) applyMainFlip(items)
    else {
      const byKey = new Map(items.map(item => [rowKey(item), item]))
      for (const row of tbody.rows) {
        const item = byKey.get(row.dataset.key || '')
        const date = row.querySelector('.date')
        if (item && date) {
          const text = relativeDate(item.updated_at)
          if (date.textContent !== text) date.textContent = text
          const tip = updatedTitle(item.updated_at, effectiveTimezone())
          if (tip === null) date.removeAttribute('title')
          else if (date.getAttribute('title') !== tip) date.setAttribute('title', tip)
        }
      }
    }
  } else {
    tbody.replaceChildren()
    table.hidden = true

  }
  updateCount()
}

function cancelPendingRetry(): void {
  for (const source of sources.values()) {
    if (source.timer) clearTimeout(source.timer)
    source.timer = undefined
  }
}

function scheduleRead(source: SourceState, delay: number, refresh: boolean): void {
  if (source.timer) clearTimeout(source.timer)
  if (!mainVisible() || !selectedSources().includes(source)) return
  source.timer = setTimeout(() => {
    source.timer = undefined
    if (mainVisible() && selectedSources().includes(source)) void readSource(source, refresh)
  }, delay)
}

async function postRead(payload: Record<string, unknown>) {
  const response = await fetch('/api/gh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (!response.ok) throw new Error(`Github ${response.status}`)
  return response.json()
}

async function readCount(source: SourceState, revision: number): Promise<void> {
  try {
    const data = await postRead({ ...source.payload, count_only: true })
    if (source.revision !== revision) return
    source.partial = typeof data.count !== 'number' || !!organizationErrors(data) || source.error.startsWith('Some GitHub accounts')
    source.countError = organizationErrors(data) || (source.partial ? 'Total count unavailable. Showing available results.' : '')
    if (typeof data.count === 'number') source.total = data.count
    if (!source.partial && source.rows.length >= source.total) source.done = true
  } catch {
    if (source.revision !== revision) return
    source.partial = true
    source.countError = 'Total count unavailable. Showing available results.'
  }
  if (mainVisible()) paintSources()
}

function retainUnchangedRows(previous: PrRow[], incoming: PrRow[]): PrRow[] {
  const existing = new Map(previous.map(row => [rowKey(row), row]))
  return incoming.map(row => {
    const old = existing.get(rowKey(row))
    return old && Object.entries(row).every(([key, value]) => old[key as keyof PrRow] === value) ? old : row
  })
}

async function readSource(source: SourceState, refresh = false): Promise<void> {
  if (source.fetching || (!refresh && source.done)) return
  if (source.timer) clearTimeout(source.timer)
  source.timer = undefined
  source.fetching = true
  const revision = refresh || !source.loaded ? ++source.revision : source.revision
  const limit = refresh ? Math.max(PAGE_SIZE, source.rows.length) : PAGE_SIZE
  const offset = refresh ? 0 : source.rows.length
  if (mainVisible()) paintSources()
  try {
    const data = await postRead({ ...source.payload, limit, offset })
    const rows = retainUnchangedRows(source.rows, (data.records as GhRecord[] || []).map(recordToRow))
    // Actions is a bounded snapshot: replace it on refresh so recovered runs
    // disappear. History refreshes retain the already paged tail.
    const tail = refresh && source.type !== 'action'
      ? source.rows.filter(item => !rows.some(row => rowKey(row) === rowKey(item))) : []
    source.rows = refresh ? [...rows, ...tail] : [...source.rows, ...rows]
    source.loaded = true
    source.loadedAt = Date.now()
    source.pending = data.pending === true
    source.partial = source.pending || !!organizationErrors(data) || (typeof data.count !== 'number' && (offset === 0 || source.partial))
    source.total = typeof data.count === 'number' ? data.count : offset === 0 ? source.rows.length : Math.max(source.total, source.rows.length)
    source.done = !source.pending && (rows.length < limit || (!source.partial && source.rows.length >= source.total))
    source.error = organizationErrors(data)
    if (offset === 0) source.countError = ''
    source.failures = 0
    // Full-history counts start only after the bounded page is painted. They
    // never hold the paging lock, and are read once per query/refresh.
    if (source.type !== 'action' && (offset === 0)) void readCount(source, revision)
    if (source.pending) scheduleRead(source, 250, true)
  } catch (error) {
    source.error = `${source.loaded ? 'Not updating —' : 'Could not load:'} ${(error as Error).message}`
    source.pending = false
    source.retryRefresh = refresh
    if (++source.failures <= 4) scheduleRead(source, Math.min(30_000, 1000 * 2 ** (source.failures - 1)), refresh)
  } finally {
    source.fetching = false
    if (mainVisible()) {
      paintSources()
      if (!source.pending && !source.failures) requestAnimationFrame(() => {
        if (mainVisible() && sentinelNeedsFetch()) void fetchPage()
      })
    }
  }
}

async function fetchPage(): Promise<void> {
  await Promise.all(selectedSources().filter(source => !source.pending && !source.timer && source.failures === 0).map(source => readSource(source)))
}

function resetAndFetch() {
  const selected = selectedSources()
  for (const source of sources.values()) {
    if (!selected.includes(source) && source.timer) {
      clearTimeout(source.timer)
      source.timer = undefined
    }
  }
  paintSources()
  for (const source of selected) {
    if (source.timer) continue
    if (source.failures > 0) {
      if (source.failures <= 4) scheduleRead(source, Math.min(30_000, 1000 * 2 ** (source.failures - 1)), source.retryRefresh)
    } else if (!source.loaded || source.pending || Date.now() - source.loadedAt > 60_000) void readSource(source, source.loaded)
  }
  requestAnimationFrame(() => {
    if (mainVisible() && sentinelNeedsFetch()) void fetchPage()
  })
}

// `active` is a class, which tells a screen reader nothing about which filter
// is applied. aria-pressed is set alongside it everywhere the class is.
function setPillActive(b: HTMLButtonElement, on: boolean): void {
  b.classList.toggle('active', on)
  b.setAttribute('aria-pressed', String(on))
}

function initFilterButtons() {
  clusterEl.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) => {
    setPillActive(b, typeFilters.has(b.dataset.filter as TypeFilter))
  })
  clusterEl.querySelectorAll<HTMLButtonElement>('[data-status], [data-action-status]').forEach((b) => {
    setPillActive(b, (b.dataset.actionStatus ? b.dataset.actionStatus === actionStatus : b.dataset.status === statusFilter))
  })
  timePickerEl.querySelectorAll<HTMLButtonElement>('[data-time]').forEach((b) => {
    setPillActive(b, b.dataset.time === timeFilter)
  })
}

function attachHandlers() {
  // All filter pills live in one cluster now — single delegated click handler
  clusterEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn) return
    if (btn.dataset.filter) {
      const next = btn.dataset.filter as TypeFilter
      if (typeFilters.has(next)) typeFilters.delete(next)
      else typeFilters.add(next)
      updateFilterContext()
      initFilterButtons()
      saveFilters()
      resetAndFetch()
    }
    if (btn.dataset.status || btn.dataset.actionStatus) {
      if (btn.dataset.actionStatus) actionStatus = btn.dataset.actionStatus as 'all' | 'failed'
      else statusFilter = btn.dataset.status as StatusFilter
      updateFilterContext()
      initFilterButtons()
      saveFilters()
      resetAndFetch()
    }
    if (btn.dataset.time) {
      const next = btn.dataset.time as TimeFilter
      if (next === timeFilter) return
      timeFilter = next
      initFilterButtons()
      saveFilters()
      resetAndFetch()
    }
  })

  // Search — debounced live filter; resets pagination because the server
  // applies the LIKE query and re-counts the result set.
  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      const next = searchInput.value.trim()
      if (next === searchQuery) return
      searchQuery = next
      resetAndFetch()
    }, 150)
  })

  // Consensus review — Confab does the work and any side effects (e.g.
  // posting a comment back on the PR). Poise just kicks it off and
  // marks the row as reviewed when Confab returns OK.
  tbody.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('.review-btn')
    if (!btn) return
    if ((btn as HTMLButtonElement).disabled) return
    const row = btn.closest('tr')!
    const key = row.dataset.key
    const item = items.find((i) => rowKey(i) === key)
    if (!item || item.is_pr !== 1) return
    // Re-check the target against current data rather than trusting the row
    // that was painted: a refresh can land between deciding and clicking, and
    // this dispatches a review that posts on a real pull request.
    const st = stateLabel(item)
    if (st.cls === 'merged' || st.cls === 'closed') return
    if (reviewing.has(item.html_url)) return
    reviewing.add(item.html_url)
    repaintReviewButton(item)
    try {
      const reviewRes = await fetch('/api/confab/review/pr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.html_url }),
      })
      if (!reviewRes.ok) {
        const detail = await reviewRes.text().catch(() => '')
        throw new Error(detail
          ? `${reviewRes.status}: ${detail.slice(0, 200)}`
          : `Review API ${reviewRes.status}`)
      }
      reviewed.add(item.html_url)
      saveReviewed()
      viewFeedback(`archive-review:${item.html_url}`, 'Archive action needs attention', '')
    } catch (err) {
      console.error('Review failed:', err)
      viewFeedback(`archive-review:${item.html_url}`, 'Archive action needs attention', `Review failed: ${(err as Error).message}`)
    } finally {
      reviewing.delete(item.html_url)
      // The button that was clicked may be long gone — the table is rebuilt by
      // a filter, a search keystroke or a return to this view. Repaint
      // whichever node is attached now, so the outcome is actually visible.
      repaintReviewButton(item)
    }
  })
}

// Repaint one row's review button from current state, wherever it now lives.
function repaintReviewButton(item: PrRow): void {
  const row = tbody?.querySelector<HTMLTableRowElement>(`tr[data-key="${CSS.escape(rowKey(item))}"]`)
  const cell = row?.querySelector<HTMLElement>('.action-cell')
  if (!cell) return
  // Replacing the node drops focus to <body>, so a keyboard user who activated
  // this button lands nowhere and has to tab back from the top of the table.
  const hadFocus = cell.contains(document.activeElement)
  cell.innerHTML = reviewButtonHtml(item, stateLabel(item))
  if (hadFocus) {
    const next = cell.querySelector<HTMLButtonElement>('.review-btn')
    if (next && !next.disabled) next.focus()
    else row?.querySelector<HTMLAnchorElement>('.title-cell a')?.focus()
  }
}

export function initMainView() {
  // Re-entry has to re-attach the tick. Leaving the view now removes the
  // listener (it never did before, which is why this early return could get
  // away with skipping startMainTimer), so without this Archive would refresh
  // on its first visit of a session and never again.
  if (initialized) {
    startMainTimer()
    requestAnimationFrame(() => {
      if (!mainVisible()) return
      if (organizationDirty) { organizationDirty = false; resetAndFetch() }
      else { paintSources(); void refreshMainSoft() }
    })
    return
  }
  initialized = true

  tbody = document.getElementById('tbody') as HTMLTableSectionElement
  loader = document.getElementById('loader') as HTMLDivElement
  table = document.getElementById('table') as HTMLTableElement
  clusterEl = document.getElementById('main-filters') as HTMLElement
  timePickerEl = document.getElementById('time-picker') as HTMLElement
  searchInput = document.getElementById('search-input') as HTMLInputElement
  countEl = document.getElementById('count') as HTMLSpanElement

  loadFilters()

  updateFilterContext()
  mountOrganizationFilter(clusterEl)
  window.addEventListener('poise:organization-filter-changed', () => {
    cancelPendingRetry()
    sources.clear()
    if (!mainVisible()) organizationDirty = true
    else resetAndFetch()
  })
  initFilterButtons()
  attachHandlers()

  // Sentinel for infinite scroll
  sentinel = document.createElement('div')
  sentinel.id = 'main-sentinel'
  table.parentElement!.appendChild(sentinel)
  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !done && !document.getElementById('view-main')!.hidden) fetchPage()
  }, { rootMargin: '400px' })
  observer.observe(sentinel)

  resetAndFetch()
  startMainTimer()
}

async function refreshMainSoft() {
  if (!initialized || !mainVisible()) return
  await Promise.all(selectedSources().map(source => readSource(source, true)))
}

// Refresh the selected sources at the user-chosen cadence (1m / 5m).
export function refreshMainView() {
  if (!initialized) return
  refreshMainSoft()
}

export function stopMainRefresh() {
  if (tickListening) {
    window.removeEventListener('poise:refresh-tick', onTick)
    tickListening = false
  }
  // A scheduled retry outlives the view otherwise, and keeps asking a
  // datastore nobody is looking at.
  cancelPendingRetry()
}

function startMainTimer() {
  if (tickListening) return
  window.addEventListener('poise:refresh-tick', onTick)
  tickListening = true
}
