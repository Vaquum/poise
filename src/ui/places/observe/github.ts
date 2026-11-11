// Observe → GitHub (#556): the history of pull requests, issues and CI. The
// reading is a copy of classic's Archive (src/views/main-view.ts), which keeps
// its state in its module and draws classic's table: one source per kind that
// pages on its own, counts read once per query, refreshes that keep the pages
// read, failures retried with a backoff while the rest shows, and a consensus
// review guarded while it runs. What is new is the mock's table and words,
// filters kept as poise-observe-github, the review's progress on the row, a
// link to the work on Board, and `item=` opening its row for that visit.
import { $, $$, esc, store } from '../../dom'
import { icon } from '../../icons'
import { lifeHTML } from '../../shell'
import { getOrganizations, getSettings, midnightInZone, startOfWeekInZone } from '../../../config'
import { organizationErrors } from '../../../organizations'
import { failedCi, historyState, readRecord, rowKey, type HistoryRow, type Kind } from './history'
import { relFromMs } from './runs'
import { aborted, capsule, exactTime, external, failureOf, github, message, onBoard } from './util'
import type { ObservePart, PartContext } from './part'

const KEY = 'poise-observe-github'
// Classic Archive's own record of what was reviewed, so both say "Reviewed".
const REVIEWED_KEY = 'poise-reviewed'
const PAGE_SIZE = 20
type Time = 'all' | 'today' | 'yesterday' | 'week'
interface Filters { types: Kind[], ci: 'failed' | 'all', status: 'all' | 'open', time: Time }
const DEFAULTS: Filters = { types: ['action'], ci: 'failed', status: 'all', time: 'all' }

function loadFilters(): Filters {
  const saved = store.get<unknown>(KEY, null)
  if (!saved || typeof saved !== 'object') return { ...DEFAULTS }
  const s = saved as Record<string, unknown>
  const types = Array.isArray(s.types) ? s.types.filter((t): t is Kind => t === 'action' || t === 'issue' || t === 'pr') : DEFAULTS.types
  return {
    types: types.length ? [...new Set(types)] : DEFAULTS.types,
    ci: s.ci === 'all' ? 'all' : 'failed',
    status: s.status === 'open' ? 'open' : 'all',
    time: s.time === 'today' || s.time === 'yesterday' || s.time === 'week' ? s.time : 'all',
  }
}

interface Source {
  type: Kind
  payload: Record<string, unknown>
  rows: HistoryRow[]
  total: number
  partial: boolean
  done: boolean
  fetching: Promise<void> | null
  loaded: boolean
  pending: boolean
  error: string
  countError: string
  loadedAt: number
  revision: number
  failures: number
  retryRefresh: boolean
  timer: number
}

export function createGithub(ctx: PartContext): ObservePart {
  const { root } = ctx
  root.innerHTML = `<div class="obv-bar">
      <div class="seg" role="group" aria-label="Shows" data-ar-type data-ref="gh.type"><button type="button" data-v="action">CI</button><button type="button" data-v="issue">Issues</button><button type="button" data-v="pr">Pull requests</button></div>
      <div class="seg" role="group" aria-label="CI outcome" data-ar-ci data-ref="gh.cistatus"><button type="button" data-v="failed">Failed</button><button type="button" data-v="all">Any</button></div>
      <div class="seg" role="group" aria-label="Status" data-ar-status data-ref="gh.status"><button type="button" data-v="all">Any</button><button type="button" data-v="open">Open</button></div>
      <div class="seg" role="group" aria-label="Updated" data-ar-time data-ref="gh.time"><button type="button" data-v="all">Any time</button><button type="button" data-v="today">Today</button><button type="button" data-v="yesterday">Yesterday</button><button type="button" data-v="week">This week</button></div>
      <input class="search" type="search" placeholder="Filter…" aria-label="Filter the history" autocomplete="off" spellcheck="false" data-ar-search data-ref="gh.search">
      <span class="obv-count" data-ar-count data-ref="gh.count"></span>
    </div>
    <p class="obv-warn" data-ar-error data-ref="gh.error" role="status" hidden></p>
    <p class="obv-warn" data-ar-focus role="status" hidden></p>
    <div class="obv-scroll" data-ar-scroll>
      <table class="table obv-table ar-table" aria-label="GitHub history">
        <thead><tr>
          <th class="c-kind"><span class="sr">Kind</span></th>
          <th class="c-title"><span class="t-micro">Title</span></th>
          <th class="c-author"><span class="t-micro">Author</span></th>
          <th class="c-org"><span class="t-micro">Org</span></th>
          <th class="c-repo"><span class="t-micro">Repo</span></th>
          <th class="c-owner"><span class="t-micro" data-ar-ownerh>Branch</span></th>
          <th class="c-state"><span class="t-micro">Status</span></th>
          <th class="c-updated"><span class="t-micro">Updated</span></th>
          <th class="c-act"><span class="sr">Review and Board</span></th>
        </tr></thead>
        <tbody data-ar-rows></tbody>
      </table>
      <p class="obv-empty" data-ar-empty hidden>Nothing matches these filters.</p>
      <p class="obv-more" data-ar-more data-ref="gh.more"></p>
    </div>`
  const tbody: HTMLElement = $('[data-ar-rows]', root)
  const scroll: HTMLElement = $('[data-ar-scroll]', root)
  const searchInput: HTMLInputElement = $('[data-ar-search]', root)

  let saved = loadFilters()
  // A link widens the filters for this visit only; what you left stays saved.
  let visit: Partial<Filters> = {}
  const filters = (): Filters => ({ ...saved, ...visit })
  let search = ''
  let items: HistoryRow[] = []
  const sources = new Map<string, Source>()
  const reviewing = new Map<string, 'Executing' | 'Completed'>()
  const reviewNotes = new Map<string, string>()
  const reviewed = new Set<string>(store.get<string[]>(REVIEWED_KEY, []))
  let searchDebounce = 0
  let stale = true
  let focusMessage = ''
  let focusKey = ''

  // ---------- The sources: one per kind, each paging on its own ----------
  function window_(): { since?: string, until?: string } {
    const time = filters().time
    if (time === 'today') return { since: midnightInZone(0).toISOString() }
    if (time === 'yesterday') return { since: midnightInZone(-1).toISOString(), until: midnightInZone(0).toISOString() }
    if (time === 'week') return { since: startOfWeekInZone().toISOString() }
    return {}
  }
  function selectedSources(): Source[] {
    const f = filters()
    const org = ctx.scope.org()
    const selected = f.types.map((type) => {
      const win = window_()
      const payload: Record<string, unknown> = {
        operation: type === 'action' ? 'actions' : 'list', ...(org ? { org } : {}),
        record_type: type === 'pr' ? 'pull_request' : 'issue',
        record_state: type === 'action' ? f.ci : f.status,
        ...(type === 'action' ? { snapshot: true } : {}),
        ...(win.since ? { updated_since: win.since } : {}),
        ...(win.until ? { updated_until: win.until } : {}),
        ...(search ? { q: search } : {}),
      }
      const key = JSON.stringify([getSettings().me, getOrganizations().filter((o) => o.status === 'ready').map((o) => o.login), payload])
      let source = sources.get(key)
      if (!source) {
        source = { type, payload, rows: [], total: 0, partial: true, done: false, fetching: null, loaded: false, pending: false,
          error: '', countError: '', loadedAt: 0, revision: 0, failures: 0, retryRefresh: false, timer: 0 }
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

  async function post(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch('/api/gh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctx.signal })
    if (!response.ok) throw new Error(`GitHub ${await failureOf(response)}`)
    return response.json()
  }
  async function readCount(source: Source, revision: number): Promise<void> {
    try {
      const data = await post({ ...source.payload, count_only: true })
      if (source.revision !== revision) return
      const errors = organizationErrors(data as { errors?: Array<{ org: string, error: string }> })
      source.partial = typeof data.count !== 'number' || !!errors || source.error.startsWith('Some GitHub accounts')
      source.countError = errors || (source.partial ? 'The total could not be counted; what was read is shown.' : '')
      if (typeof data.count === 'number') source.total = data.count
      if (!source.partial && source.rows.length >= source.total) source.done = true
    } catch (error) {
      if (aborted(error) || source.revision !== revision) return
      source.partial = true
      source.countError = 'The total could not be counted; what was read is shown.'
    }
    paint()
  }
  function retainUnchanged(previous: HistoryRow[], incoming: HistoryRow[]): HistoryRow[] {
    const existing = new Map(previous.map((row) => [rowKey(row), row]))
    return incoming.map((row) => {
      const old = existing.get(rowKey(row))
      return old && (Object.keys(row) as Array<keyof HistoryRow>).every((key) => old[key] === row[key]) ? old : row
    })
  }
  function schedule(source: Source, delay: number, refresh: boolean): void {
    clearTimeout(source.timer)
    source.timer = window.setTimeout(() => {
      source.timer = 0
      if (!ctx.signal.aborted && selectedSources().includes(source)) void readSource(source, refresh)
    }, delay)
  }
  function readSource(source: Source, refresh = false): Promise<void> {
    if (source.fetching) return source.fetching
    if (!refresh && source.done) return Promise.resolve()
    clearTimeout(source.timer)
    source.timer = 0
    const run = (async () => {
      const revision = refresh || !source.loaded ? ++source.revision : source.revision
      const limit = refresh ? Math.max(PAGE_SIZE, source.rows.length) : PAGE_SIZE
      const offset = refresh ? 0 : source.rows.length
      paint()
      try {
        const data = await post({ ...source.payload, limit, offset })
        const incoming = (Array.isArray(data.records) ? data.records : []).map(readRecord).filter((row): row is HistoryRow => !!row)
        const rows = retainUnchanged(source.rows, incoming)
        // CI is a bounded snapshot, replaced on refresh; history keeps the pages already read.
        const tail = refresh && source.type !== 'action' ? source.rows.filter((item) => !rows.some((row) => rowKey(row) === rowKey(item))) : []
        source.rows = refresh ? [...rows, ...tail] : [...source.rows, ...rows]
        source.loaded = true
        source.loadedAt = Date.now()
        source.pending = data.pending === true
        const errors = organizationErrors(data as { errors?: Array<{ org: string, error: string }> })
        source.partial = source.pending || !!errors || (typeof data.count !== 'number' && (offset === 0 || source.partial))
        source.total = typeof data.count === 'number' ? data.count : offset === 0 ? source.rows.length : Math.max(source.total, source.rows.length)
        source.done = !source.pending && (rows.length < limit || (!source.partial && source.rows.length >= source.total))
        source.error = errors
        if (offset === 0) source.countError = ''
        source.failures = 0
        if (source.type !== 'action' && offset === 0) void readCount(source, revision)
        if (source.pending) schedule(source, 250, true)
      } catch (error) {
        if (aborted(error)) return
        source.error = `${source.loaded ? 'Not updating:' : 'Could not be read:'} ${message(error)}`
        source.pending = false
        source.retryRefresh = refresh
        if (++source.failures <= 4) schedule(source, Math.min(30_000, 1000 * 2 ** (source.failures - 1)), refresh)
      } finally {
        source.fetching = null
        paint()
      }
    })()
    source.fetching = run
    return run
  }
  function fetchPage(): Promise<unknown> {
    return Promise.all(selectedSources().filter((s) => !s.pending && !s.timer && s.failures === 0).map((s) => readSource(s)))
  }
  function resetAndFetch(): Promise<unknown> {
    const selected = selectedSources()
    for (const source of sources.values()) if (!selected.includes(source)) { clearTimeout(source.timer); source.timer = 0 }
    paint()
    const reads: Array<Promise<void>> = []
    for (const source of selected) {
      if (source.timer) continue
      if (source.failures > 0) { if (source.failures <= 4) schedule(source, Math.min(30_000, 1000 * 2 ** (source.failures - 1)), source.retryRefresh) }
      else if (!source.loaded || source.pending || Date.now() - source.loadedAt > 60_000) reads.push(readSource(source, source.loaded))
    }
    return Promise.all(reads)
  }

  // ---------- Painting: rows repaint in place ----------
  const avatar = (login: string | null, title = ''): string => (login
    ? `<span class="av${/\[bot\]$|bot$/i.test(login) ? ' is-bot' : ''}" title="${esc(title || login)}" aria-hidden="true">${esc(login.slice(0, 2))}</span><span class="av-n">${esc(login)}</span>`
    : '<span class="dim" title="No assignee">—</span>')
  function reviewHTML(row: HistoryRow): string {
    if (row.kind !== 'pr') return ''
    const s = historyState(row)
    if (s.settled) return `<button type="button" class="btn-ghost" aria-disabled="true" title="This pull request is ${s.word.toLowerCase()}: nothing to review" data-ref="gh.review">Review</button>`
    const stage = reviewing.get(row.url)
    if (stage) return `<span class="life" data-life="${stage}">${lifeHTML(stage, stage === 'Executing' ? 'several models review it' : 'review posted', true)}</span>`
    const done = reviewed.has(row.url)
    return `<button type="button" class="btn-ghost" data-act="ar-review" title="${done ? 'Reviewed; run it again' : 'Run a consensus review'}" data-ref="gh.review">${done ? 'Reviewed · again' : 'Review'}</button>`
  }
  function rowHTML(row: HistoryRow): string {
    const [org, repo] = row.repo.split('/', 2)
    const s = historyState(row)
    const kind = row.kind === 'pr' ? 'PR' : row.kind === 'issue' ? 'Issue' : 'CI'
    const updated = Date.parse(row.updatedAt)
    const note = reviewNotes.get(row.url)
    return `<td class="c-kind"><span class="kind is-${row.kind}" data-ref="gh.kind">${kind}</span></td>
      <td class="c-title" data-ref="gh.title">${external(row.url, `${esc(row.title)}${row.kind === 'action' ? '' : `<span class="dim"> #${row.number}</span>`}`, 'ar-title')}</td>
      <td class="c-author" data-ref="gh.author">${avatar(row.author || null)}</td>
      <td class="c-org">${org ? external(github(org), esc(org), 'sw-link') : ''}</td>
      <td class="c-repo">${repo ? external(github(org, repo), esc(repo), 'sw-link') : ''}</td>
      <td class="c-owner" data-ref="gh.owner">${row.kind === 'action' ? `<span class="t-mono br" title="${esc(row.event ?? '')}">${esc(row.branch || '—')}</span>` : avatar(row.owner, row.owner ? `Assigned to ${row.owner}` : '')}</td>
      <td class="c-state" data-ref="gh.state">${s.state ? capsule(s.state) : '<span class="sc-open"></span>'}<span class="ow">${esc(s.word)}</span></td>
      <td class="c-updated" data-ref="gh.updated" data-updated title="${esc(exactTime(updated))}">${esc(relFromMs(updated))}</td>
      <td class="c-act">${reviewHTML(row)}${row.kind !== 'action' ? `<a class="ib" href="${esc(onBoard(`${row.repo}#${row.number}`))}" aria-label="See it on Board" title="See it on Board" data-ref="gh.board">${icon('card', 'sm')}</a>` : ''}${note ? `<span class="note is-warn" title="${esc(note)}">${esc(note)}</span>` : ''}</td>`
  }
  const markup = new WeakMap<HTMLElement, string>()
  function paint(): void {
    if (!ctx.visible()) return
    const f = filters()
    const selected = selectedSources()
    items = [...new Map(selected.flatMap((s) => s.rows).map((row) => [rowKey(row), row])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const existing = new Map<string, HTMLTableRowElement>()
    for (const tr of [...tbody.children] as HTMLTableRowElement[]) if (tr.dataset.key) existing.set(tr.dataset.key, tr)
    const keys = new Set(items.map(rowKey))
    for (const [key, tr] of existing) if (!keys.has(key)) tr.remove()
    let cursor: ChildNode | null = tbody.firstChild
    for (const row of items) {
      const key = rowKey(row)
      let tr = existing.get(key)
      if (!tr) { tr = document.createElement('tr'); tr.dataset.key = key; tr.dataset.ar = key }
      const html = rowHTML(row)
      if (markup.get(tr) !== html) { tr.innerHTML = html; markup.set(tr, html) }
      tr.classList.toggle('is-focus', key === focusKey)
      if (cursor !== tr) tbody.insertBefore(tr, cursor)
      cursor = tr.nextSibling
    }
    const total = selected.reduce((sum, s) => sum + s.total, 0)
    const partial = selected.some((s) => s.partial || s.pending)
    const fetching = selected.some((s) => s.fetching || s.pending)
    const done = selected.every((s) => s.done)
    const loaded = selected.some((s) => s.loaded)
    $('[data-ar-empty]', root).hidden = items.length > 0 || !loaded || fetching
    $('[data-ar-count]', root).textContent = partial ? (items.length ? `${items.length}` : '') : total > 0 ? `${Math.min(items.length, total)} of ${total.toLocaleString('en-US')}` : ''
    $('[data-ar-more]', root).innerHTML = fetching ? '<span class="spin"></span> Reading the history…'
      : !done ? `${partial ? '' : `${(total - items.length).toLocaleString('en-US')} older · `}they load as you scroll`
        : items.length ? 'The whole history is here.' : ''
    const errors = [...new Set(selected.flatMap((s) => [s.error, s.countError]).filter(Boolean))]
    const error = $('[data-ar-error]', root)
    error.hidden = !errors.length
    error.innerHTML = errors.length ? `<span class="sdot is-warn"></span>${esc(errors.join(' '))} Poise tries again on its own.` : ''
    const focus = $('[data-ar-focus]', root)
    focus.hidden = !focusMessage
    focus.innerHTML = focusMessage ? `<span class="sdot is-warn"></span>${esc(focusMessage)}` : ''
    $$('[data-ar-type] button', root).forEach((b: HTMLElement) => b.setAttribute('aria-pressed', String(f.types.includes(b.dataset.v as Kind))))
    $$('[data-ar-ci] button', root).forEach((b: HTMLElement) => b.setAttribute('aria-pressed', String(b.dataset.v === f.ci)))
    $$('[data-ar-status] button', root).forEach((b: HTMLElement) => b.setAttribute('aria-pressed', String(b.dataset.v === f.status)))
    $$('[data-ar-time] button', root).forEach((b: HTMLElement) => b.setAttribute('aria-pressed', String(b.dataset.v === f.time)))
    $('[data-ar-ci]', root).hidden = !f.types.includes('action')
    $('[data-ar-status]', root).hidden = !f.types.some((t) => t !== 'action')
    $('[data-ar-ownerh]', root).textContent = f.types.includes('action') ? (f.types.length > 1 ? 'Owner / Branch' : 'Branch') : 'Owner'
    const ci = selected.find((s) => s.type === 'action')
    if (ci?.loaded && f.ci === 'failed') {
      const failing = ci.rows.filter(failedCi).length
      ctx.count(failing ? `${capsule('failed')}${failing} failed CI` : '')
    }
  }
  function tick(): void {
    if (!ctx.visible()) return
    const byKey = new Map(items.map((row) => [rowKey(row), row]))
    for (const tr of tbody.querySelectorAll<HTMLElement>('tr[data-key]')) {
      const row = byKey.get(tr.dataset.key ?? '')
      const cell = tr.querySelector<HTMLElement>('[data-updated]')
      if (!row || !cell) continue
      const text = relFromMs(Date.parse(row.updatedAt))
      if (cell.textContent !== text) cell.textContent = text
    }
  }

  // ---------- Filters and search ----------
  function changeFilters(change: (f: Filters) => void): void {
    const next = filters()
    change(next)
    saved = next
    visit = {}
    store.set(KEY, saved)
    focusKey = ''
    focusMessage = ''
    scroll.scrollTop = 0
    void resetAndFetch()
  }
  $('.obv-bar', root).addEventListener('click', (e: Event) => {
    const button = (e.target as Element).closest<HTMLElement>('.seg button')
    if (!button) return
    const group = button.closest('.seg')!
    const v = button.dataset.v ?? ''
    if (group.matches('[data-ar-type]')) {
      const on = filters().types.includes(v as Kind)
      if (on && filters().types.length === 1) { focusMessage = 'At least one kind stays shown.'; paint(); return }
      changeFilters((f) => { f.types = on ? f.types.filter((t) => t !== v) : [...f.types, v as Kind] })
    } else if (group.matches('[data-ar-ci]')) changeFilters((f) => { f.ci = v === 'all' ? 'all' : 'failed' })
    else if (group.matches('[data-ar-status]')) changeFilters((f) => { f.status = v === 'open' ? 'open' : 'all' })
    else if (group.matches('[data-ar-time]') && v !== filters().time) changeFilters((f) => { f.time = v as Time })
  })
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce)
    searchDebounce = window.setTimeout(() => {
      const next = searchInput.value.trim()
      if (next === search) return
      search = next
      focusKey = ''
      scroll.scrollTop = 0
      void resetAndFetch()
    }, 150)
  })

  // ---------- Consensus review: guarded while it runs, its progress on the row ----------
  tbody.addEventListener('click', (e: Event) => {
    const button = (e.target as Element).closest<HTMLElement>('[data-act="ar-review"]')
    if (!button || button.getAttribute('aria-disabled') === 'true') return
    const key = button.closest<HTMLElement>('tr')?.dataset.key
    const row = items.find((item) => rowKey(item) === key)
    // Checked against what is read now: a refresh may have settled it since it was drawn.
    if (!row || row.kind !== 'pr' || historyState(row).settled || reviewing.has(row.url)) return
    void review(row)
  })
  async function review(row: HistoryRow): Promise<void> {
    reviewing.set(row.url, 'Executing')
    reviewNotes.delete(row.url)
    paint()
    try {
      const response = await fetch('/api/confab/review/pr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: row.url }), signal: ctx.signal })
      if (!response.ok) throw new Error(await failureOf(response))
      reviewed.add(row.url)
      store.set(REVIEWED_KEY, [...reviewed])
      reviewing.set(row.url, 'Completed')
      paint()
      ctx.after(2400, () => { reviewing.delete(row.url); paint() })
      return
    } catch (error) {
      if (aborted(error)) return
      reviewNotes.set(row.url, `Review failed: ${message(error)}`)
    }
    reviewing.delete(row.url)
    paint()
  }

  // ---------- A link opens its row, clearing a filter that hides it, for this visit ----------
  async function focusItem(item: string): Promise<void> {
    const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(item)
    if (!match) return
    const [, repo, number] = match
    const kinds: Kind[] = [...new Set<Kind>([...saved.types, 'issue', 'pr'])]
    visit = { types: kinds, status: 'all', time: 'all' }
    search = ''
    searchInput.value = ''
    const owner = repo.split('/')[0].toLowerCase()
    if (ctx.scope.org() && ctx.scope.org().toLowerCase() !== owner) ctx.scope.set('', false)
    const find = () => items.find((row) => row.kind !== 'action' && `${row.repo}#${row.number}`.toLowerCase() === item.toLowerCase())
    await resetAndFetch()
    for (let pages = 0; !find() && pages < 10 && !selectedSources().every((s) => s.done || s.failures); pages++) await fetchPage()
    if (!find()) {
      // Older than ten pages: the server's search reads the whole history for its number.
      search = number
      searchInput.value = number
      await resetAndFetch()
    }
    const found = find()
    focusKey = found ? rowKey(found) : ''
    focusMessage = found ? '' : `${item} is not in the history that could be read.`
    paint()
    if (!found) return
    const tr = tbody.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(focusKey)}"]`)
    tr?.scrollIntoView({ block: 'center' })
    ctx.after(1600, () => { focusKey = ''; paint() })
  }

  // Older history loads as the end comes into view.
  const sentinel = $('[data-ar-more]', root)
  const observer = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting && ctx.visible() && !selectedSources().every((s) => s.done)) void fetchPage()
  }, { root: scroll, rootMargin: '0px 0px 400px 0px' })
  observer.observe(sentinel)

  ctx.scope.onChange(() => {
    for (const source of sources.values()) clearTimeout(source.timer)
    sources.clear()
    if (ctx.visible()) void resetAndFetch(); else stale = true
  })
  addEventListener('poise:refresh-tick', () => {
    if (ctx.visible()) void Promise.all(selectedSources().map((source) => readSource(source, true)))
  }, { signal: ctx.signal })
  ctx.every(30_000, tick)

  const linked = ctx.query.get('item')
  let opened = false
  return {
    show() {
      if (!opened) {
        opened = true
        stale = false
        if (linked) void focusItem(linked); else void resetAndFetch()
        return
      }
      if (stale) { stale = false; void resetAndFetch() } else { paint(); void resetAndFetch() }
    },
    hide() { /* Reads already out finish; nothing new starts while hidden. */ },
    busy: () => [...reviewing.values()].includes('Executing'),
    leave() {
      observer.disconnect()
      clearTimeout(searchDebounce)
      for (const source of sources.values()) clearTimeout(source.timer)
    },
  }
}
