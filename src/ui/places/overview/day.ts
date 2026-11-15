// The day's numbers (#556, Overview: Analytics moves in, O1–O15): classic
// Analytics' reads and words (src/views/analytics-view.ts, src/analytics-*.ts),
// drawn as the mock's tiles. Each number has its pace, a bullet against
// typical by now, its year, and under the year the 30 days before (#995).
import { analyticsDay, analyticsDailyBounds, analyticsDayProgress, analyticsHistoryBounds } from '../../../analytics-day'
import { analyticsGroups, type AnalyticsGroup, type AnalyticsReport, type AnalyticsTile } from '../../../analytics-format'
import { historySeries, periodLabel, type AnalyticsHistory, type HistorySeries } from '../../../analytics-history'
import { readAnalyticsSnapshot, type AnalyticsSnapshot } from '../../../analytics-snapshot'
import { effectiveTimezone, getOrganizations, getRefreshRateMs, getSettings } from '../../../config'
import { noticeFeed, type ReadFailure } from '../../../notices'
import { getSelectedOrganization, organizationUrl, setSelectedOrganization } from '../../../organizations'
import { $, $$, esc, store } from '../../dom'
import { hydrateIcons } from '../../icons'
import { bins, bullet, spark, weekAt, yearChart } from './charts'
import type { RightFilter } from './find'
import { clockAt, reason, readLine, unread, type Read, type PartContext } from './util'

export const TILES_KEY = 'poise-overview-tiles'
const SOURCES = ['overview-day', 'overview-history'] as const

/** The tiles' remembered order, with any number it does not name at its end. */
export function tileOrder(saved: unknown, labels: readonly string[]): string[] {
  const kept = Array.isArray(saved) ? saved.filter((label): label is string => typeof label === 'string' && labels.includes(label)) : []
  return [...new Set([...kept, ...labels])]
}

/** The day's work types as listed under a search: the leader is always the
 *  day's own, from every type, and only the rows narrow, scaled against it. */
export function workTypeRows<T extends { type: string, count: number }>(types: readonly T[], matches: (type: string) => boolean): { lead: T | undefined, rows: T[] } {
  const counted = types.filter((entry) => entry.count > 0)
  return { lead: counted[0], rows: counted.filter((entry) => matches(entry.type)) }
}

/** Moves `label` by `step` places, within the list. */
export function moveTile(order: readonly string[], label: string, step: number): string[] {
  const from = order.indexOf(label)
  if (from < 0) return [...order]
  const to = Math.max(0, Math.min(order.length - 1, from + step))
  const next = [...order]
  next.splice(from, 1)
  next.splice(to, 0, label)
  return next
}

type Pr = AnalyticsReport['pullRequests']
type Day = NonNullable<AnalyticsReport['daily']>[number]
// The counts a bullet compares: today's value and the 7-day daily median.
const COUNTS: Record<string, { value: (r: AnalyticsReport) => number | null, day: (d: Day) => number | null }> = {
  'Pull requests opened': { value: (r) => r.pullRequests.opened, day: (d) => d.pullRequests.opened },
  'Pull requests merged': { value: (r) => r.pullRequests.merged, day: (d) => d.pullRequests.merged },
  'Closed without merging': { value: (r) => r.pullRequests.closedUnmerged, day: (d) => d.pullRequests.closedUnmerged },
  'Lines changed': { value: (r) => linesTotal(r.pullRequests), day: (d) => linesTotal(d.pullRequests) },
  'Issues opened': { value: (r) => r.issues.opened, day: (d) => d.issues.opened },
  'Issues closed': { value: (r) => r.issues.closed, day: (d) => d.issues.closed },
}
function linesTotal(pr: Pr): number | null {
  return pr.merged === 0 ? 0 : pr.lines.counted < pr.merged ? null : pr.lines.total
}
/** Today and typical by now for a count, as classic's pace reads them; null when either is unknown. */
export function countPair(label: string, report: AnalyticsReport, baseline: AnalyticsReport, progress: number | undefined): { current: number, typical: number } | null {
  const count = COUNTS[label]
  if (!count || baseline.daily?.length !== 7) return null
  const values = baseline.daily.map(count.day)
  const current = count.value(report)
  if (current === null || values.some((value) => value === null)) return null
  const median = (values as number[]).sort((a, b) => a - b)[3]
  return { current, typical: median * (progress ?? 1) }
}

interface Shown { snapshot: AnalyticsSnapshot, progress: number | undefined, snapshotTime: string | undefined }
/** Today's last numbers, kept across visits and page loads: a return or a
 *  reload paints them at once, with the time they were read, then reads again.
 *  Another day's, organization's or GitHub user's numbers never stand for these. */
type LastDay = { key: string, shown: Shown, day: Read<true>, history: Read<AnalyticsHistory>, daily: Read<AnalyticsHistory> }
const LAST_DAY_KEY = 'poise-overview-day'
let lastDay: LastDay | null = (() => {
  try { return JSON.parse(localStorage.getItem(LAST_DAY_KEY) ?? 'null') as LastDay | null } catch { return null }
})()

/** The day the right-hand side is for: its bounds in Settings' time zone and its name. */
export interface ChosenDay { since: string, until: string, label: string, isToday: boolean }

export function mountDay(ctx: PartContext, main: HTMLElement, find: RightFilter, onDay: (day: ChosenDay) => void): void {
  const { signal } = ctx
  let offset = 0
  let anchor = new Date()
  let shown: Shown | null = null
  /** The user, organizations and day the numbers shown were read for. */
  let shownKey = ''
  let day: Read<true> = unread()
  let history: Read<AnalyticsHistory> = unread()
  let daily: Read<AnalyticsHistory> = unread()
  let generation = 0
  let open: string | null = null
  let order: string[] = []
  let pendingPaint = false
  let read: AbortController | null = null
  signal.addEventListener('abort', () => read?.abort())

  const tiles: HTMLElement = $('[data-tiles]', main)
  const detail: HTMLElement = $('[data-detail]', main)

  const groups = (): AnalyticsGroup[] => shown ? analyticsGroups(shown.snapshot.report, shown.snapshot.baseline, shown.progress, shown.snapshotTime) : []
  const group = (id: AnalyticsGroup['id']) => groups().find((value) => value.id === id)?.tiles ?? []
  const allTiles = () => groups().flatMap((value) => value.tiles)
  const weekly = (): HistorySeries[] | null => history.data ? historySeries(history.data) : null
  const days = (): HistorySeries[] | null => daily.data ? historySeries(daily.data, 1) : null

  const arrow = (tile: AnalyticsTile) => tile.trend ? tile.trend.text.slice(0, 1) : ''
  function paceHTML(tile: AnalyticsTile): string {
    if (!tile.trend) return '<span class="pace is-neutral" data-ref="ov.pace">—</span>'
    return `<span class="pace is-${tile.trend.direction}" data-ref="ov.pace" data-help="${esc(tile.trend.description)}"><b>${esc(arrow(tile))}</b>${esc(tile.trend.text.slice(2))}</span>`
  }
  function sparkFor(label: string): string {
    const series = weekly()?.find((value) => value.label === label)
    return series ? spark(series.values) : '<span class="spark is-empty" aria-hidden="true"></span>'
  }

  function tileHTML(tile: AnalyticsTile): string {
    const pair = shown ? countPair(tile.label, shown.snapshot.report, shown.snapshot.baseline, shown.progress) : null
    const tone = tile.trend?.direction ?? 'neutral'
    return `<article class="otile${open === tile.label ? ' is-open' : ''}" data-tile="${esc(tile.label)}" draggable="true" tabindex="0" role="button" aria-expanded="${open === tile.label}" aria-label="${esc(tile.label)}: ${esc(tile.value)}. ${esc(tile.trend?.description ?? 'No comparison')}. Enter opens its year; Alt with an arrow key moves it." data-ref="ov.tile">
      <header class="otile-h"><span class="otile-l">${esc(tile.label)}</span><span class="grip" aria-hidden="true"></span></header>
      <p class="otile-v" data-help="${esc(tile.note ?? '')}">${esc(tile.value)}</p>
      ${paceHTML(tile)}
      ${pair ? bullet(pair.current, pair.typical, tone) : ''}
      <p class="otile-t">${esc(tile.comparison ?? '')}</p>
      ${sparkFor(tile.label)}
    </article>`
  }

  function smallHTML(tile: AnalyticsTile): string {
    return `<button class="osmall" data-small="${esc(tile.label)}" aria-expanded="${open === tile.label}" aria-label="${esc(tile.label)}: ${esc(tile.value)}. ${esc(tile.trend?.description ?? 'No comparison')}." data-ref="ov.tile"><span class="otile-l">${esc(tile.label)}</span><span class="osmall-v">${esc(tile.value)}</span>${paceHTML(tile)}${tile.note ? `<span class="t-gloss">${esc(tile.note)}</span>` : ''}</button>`
  }

  function failure(): string {
    const line = readLine('The day’s numbers', day)
    return line ? `<p class="onote is-warn ova-fail" role="status" data-ref="ov.read">${esc(line)}</p>` : ''
  }

  function paintTiles(): void {
    if (!shown) {
      tiles.innerHTML = day.error ? failure() : '<p class="onote" role="status">Reading the day’s numbers…</p>'
      detail.hidden = true
      return
    }
    const productivity = group('productivity')
    order = tileOrder(store.get<unknown>(TILES_KEY, null), productivity.map((tile) => tile.label))
    const shownTiles = order.map((label) => productivity.find((tile) => tile.label === label)).filter((tile): tile is AnalyticsTile => !!tile && find.matches(tile.label))
    tiles.innerHTML = shownTiles.length ? shownTiles.map(tileHTML).join('') : `<p class="onote" role="status">${esc(find.none())}</p>`
    const fail = $('[data-dayfail]', main)
    if (fail) fail.innerHTML = failure()
    paintDetail()
  }

  function paintSmall(): void {
    const perPr = $('[data-perpr]', main)
    const work = $('[data-worktype]', main)
    const friction = $('[data-friction]', main)
    if (!shown) {
      perPr.innerHTML = ''
      work.innerHTML = '<h3 class="ocard-h"><span class="t-micro" data-ref="ov.worktype">Work type</span></h3>'
      friction.innerHTML = '<h3 class="ocard-h"><span class="t-micro" data-ref="ov.friction">Review</span></h3>'
      return
    }
    const perPrTiles = group('per-merged-pr').filter((tile) => find.matches(tile.label))
    perPr.innerHTML = perPrTiles.length ? perPrTiles.map(smallHTML).join('') : `<p class="onote" role="status">${esc(find.none())}</p>`
    const review = group('work-review')
    const type = review.find((tile) => tile.workTypes)
    const population = type?.population ?? 0
    const { lead, rows: types } = workTypeRows(type?.workTypes ?? [], (name) => find.matches(name, 'Work type'))
    work.innerHTML = `<h3 class="ocard-h"><span class="t-micro" data-ref="ov.worktype">Work type</span><span class="t-gloss">of ${population} merged</span></h3>
      ${lead && population ? `<p class="ova-lead"><b>${esc(lead.type)}</b> leads, ${Math.round((lead.count / population) * 100)}%</p>` : `<p class="onote">${esc(type?.note ?? 'No pull requests were merged.')}</p>`}
      ${types.length || !find.query() ? `<ul class="wtype">${types.map((entry) => `<li><span class="wt-k t-mono">${esc(entry.type)}</span><svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="wt-t" width="100" height="6"/><rect class="wt-v" width="${lead ? ((entry.count / lead.count) * 100).toFixed(1) : 0}" height="6"/></svg><span class="wt-n">${entry.count}</span></li>`).join('')}</ul>` : `<p class="onote" role="status">${esc(find.none())}</p>`}`
    const frictionTiles = review.filter((tile) => !tile.workTypes && find.matches(tile.label, 'Review'))
    friction.innerHTML = `<h3 class="ocard-h"><span class="t-micro" data-ref="ov.friction">Review</span><span class="t-gloss">what it took to merge</span></h3>${frictionTiles.length ? frictionTiles.map((tile) => `<button class="ofric" data-small="${esc(tile.label)}" aria-expanded="${open === tile.label}" aria-label="${esc(tile.label)}: ${esc(tile.value)}." data-ref="ov.tile"><span class="otile-l">${esc(tile.label)}</span><span class="osmall-v">${esc(tile.value)}</span>${paceHTML(tile)}<span class="t-gloss">${esc(tile.comparison ?? '')}</span>${sparkFor(tile.label)}</button>`).join('') : `<p class="onote" role="status">${esc(find.none())}</p>`}`
  }

  function paintDetail(): void {
    const tile = open ? allTiles().find((value) => value.label === open) : undefined
    if (!tile) { detail.hidden = true; detail.innerHTML = ''; return }
    detail.hidden = false
    const series = weekly()?.find((value) => value.label === tile.label)
    const day30 = days()?.find((value) => value.label === tile.label)
    let year = ''
    if (history.error) year = `<p class="onote is-warn" data-ref="ov.read">${esc(readLine('The year', history))}</p>`
    else if (!series || !history.data) year = '<p class="onote" role="status">Reading the past year…</p>'
    else {
      const known = series.values.filter((value): value is number => value !== null)
      const highest = known.length ? Math.max(...known) : null
      const at = highest === null ? -1 : series.values.indexOf(highest)
      const last = history.data.periods.length - 1
      year = `${yearChart(series.values, tile.label)}
        <p class="yread" aria-live="polite" data-yread>${highest === null ? 'No week of the past year has a known value.' : `Highest: ${esc(series.format(highest))} in ${esc(periodLabel(history.data.periods[at], effectiveTimezone()))}. The latest, ${esc(periodLabel(history.data.periods[last], effectiveTimezone()))}, is marked.`}</p>`
    }
    let thirty = ''
    if (daily.error) thirty = `<p class="onote is-warn" data-ref="ov.read">${esc(readLine('The 30 days', daily))}</p>`
    else if (day30) {
      const share = tile.label === 'Change-request share'
      const drawn = bins(day30.values, share ? 0 : undefined, share ? 100 : undefined)
      const first = drawn.bins[0], lastBin = drawn.bins[drawn.bins.length - 1]
      thirty = `${drawn.svg}<p class="t-gloss">The 30 completed days before ${offset === 0 ? 'today' : 'the chosen day'}, one value a day, in five bins${drawn.known ? ` from ${esc(day30.format(first.from))} to ${esc(day30.format(lastBin.until))}` : ''}. ${drawn.known} of 30 days known.</p>`
    }
    detail.innerHTML = `<header class="ova-dh"><h4>${esc(tile.label)} <span class="t-gloss">the past year, one point per week</span></h4><button class="ib" data-act="close-detail" aria-label="Close the year" data-ref="ov.closeyear"><i data-i="cross"></i></button></header><div class="year" data-year="${esc(tile.label)}" data-ref="ov.year">${year}${thirty}</div>`
    hydrateIcons(detail)
  }

  function showWeek(chart: HTMLElement, index: number): void {
    const label = chart.closest<HTMLElement>('[data-year]')?.dataset.year
    const series = weekly()?.find((value) => value.label === label)
    const periods = history.data?.periods ?? []
    if (!series || !periods.length) return
    const i = Math.max(0, Math.min(periods.length - 1, index))
    chart.dataset.week = String(i)
    const cursor = $('[data-cur]', chart) as HTMLElement
    cursor.hidden = false
    cursor.style.setProperty('--x', `${weekAt(i, periods.length)}%`)
    const readout = $('[data-yread]', detail)
    if (readout) readout.textContent = `${periodLabel(periods[i], effectiveTimezone())}: ${series.format(series.values[i])} · ${series.detail(periods[i])}`
  }

  function paintDay(): void {
    const today = analyticsDay(offset, anchor)
    const ctl = $('[data-dayctl]', main)
    const organizations = getOrganizations().filter((org) => org.status === 'ready')
    const selected = getSelectedOrganization()
    ctl.innerHTML = `<div class="oday" role="group" aria-label="Day" data-ref="ov.day"><button class="ib" data-act="day-prev" aria-label="Previous day"><i data-i="chev" class="sm flip-x"></i></button><span class="oday-t" data-day-label>${esc(today.label)}</span><button class="ib" data-act="day-next" aria-label="Next day"${today.isToday ? ' aria-disabled="true"' : ''}><i data-i="chev" class="sm"></i></button></div>`
    hydrateIcons(ctl)
    // The organization stays where it was, beside the search, which is never redrawn under your typing.
    const org = $('[data-orgctl]', main)
    const orgKey = `${selected}|${organizations.map((value) => value.login).join(',')}`
    if (org.dataset.shown !== orgKey) {
      org.innerHTML = organizations.length > 1 ? `<label class="oorg" data-ref="ov.org"><span class="sr">Organization</span><select data-org><option value="">All orgs</option>${organizations.map((value) => `<option value="${esc(value.login)}"${value.login === selected ? ' selected' : ''}>${esc(value.login)}</option>`).join('')}</select></label>` : ''
      org.dataset.shown = orgKey
    }
    const line = $('[data-dayline]', main)
    if (line) line.textContent = `${today.label}${today.isToday && shown ? `, until ${clockAt(shown.snapshot.capturedAt)}` : ''} · ${selected || 'All orgs'} · against the 7 days before`
    const when = $('[data-when]', main)
    if (when) when.textContent = new Intl.DateTimeFormat('en-GB', { timeZone: effectiveTimezone(), weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
  }

  // Only a known GitHub user keeps the day, and All orgs only for the same organizations.
  const readyOrgs = () => getOrganizations().filter((org) => org.status === 'ready').map((org) => org.login.toLowerCase()).sort().join(',')
  const dayKey = () => `${getSettings().me ?? ''}|${getSelectedOrganization()}|${readyOrgs()}|${analyticsDay(0, anchor).since}`
  const paint = () => {
    // Kept only while what is shown was read for what the key says now.
    if (offset === 0 && shown && getSettings().me && shownKey === dayKey() && (lastDay?.shown !== shown || lastDay.day !== day || lastDay.history !== history || lastDay.daily !== daily)) {
      lastDay = { key: shownKey, shown, day, history, daily }
      try { localStorage.setItem(LAST_DAY_KEY, JSON.stringify(lastDay)) } catch { /* the next page reads them anew */ }
    }
    paintDay(); paintTiles(); paintSmall()
  }
  // Typical by now moves with the clock; nothing redraws under the pointer or focus.
  const quiet = () => tiles.matches(':hover') || tiles.contains(document.activeElement) || detail.matches(':hover') || detail.contains(document.activeElement)
  function repaint(): void {
    if (quiet()) { pendingPaint = true; return }
    pendingPaint = false
    paint()
  }
  for (const el of [tiles, detail]) {
    el.addEventListener('pointerleave', () => { if (pendingPaint) repaint() }, { signal })
    el.addEventListener('focusout', () => { if (pendingPaint) requestAnimationFrame(repaint) }, { signal })
  }

  const accountFailures = (errors: AnalyticsReport['errors']): ReadFailure[] => errors.map(({ org, error, stale }) => ({ key: `account:${org.toLowerCase()}`, title: `GitHub data for ${org} ${stale ? 'is not updating' : 'is unavailable'}`, body: error }))

  /** The right-hand side follows the day: Behaviors reads it, live panels say they are live. */
  let announced = ''
  function announce(): void {
    const day = analyticsDay(offset, anchor)
    const key = `${day.since}|${day.until}`
    if (key === announced) return
    announced = key
    onDay({ since: day.since, until: day.until, label: day.label, isToday: day.isToday })
  }

  async function readDay(background: boolean): Promise<void> {
    announce()
    const mine = ++generation
    const key = dayKey()
    read?.abort()
    const controller = new AbortController()
    read = controller
    if (!background) { shown = null; history = unread(); daily = unread(); paint() }
    try {
      const snapshot = await readAnalyticsSnapshot(offset, anchor, controller.signal)
      if (mine !== generation) return
      const today = analyticsDay(offset, anchor)
      shown = {
        snapshot,
        progress: today.isToday ? analyticsDayProgress(today.since, today.until, snapshot.capturedAt) : undefined,
        snapshotTime: today.isToday ? new Intl.DateTimeFormat('en-GB', { timeZone: effectiveTimezone(), day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(snapshot.capturedAt) : undefined,
      }
      day = { data: true, error: '', at: Date.now() }
      shownKey = key
      noticeFeed.reportReadErrors('overview-day', [...accountFailures(snapshot.report.errors), ...accountFailures(snapshot.baseline.errors)])
      if (!background || !history.data || !daily.data) void readHistory(mine)
    } catch (error) {
      if (mine !== generation || signal.aborted) return
      // A failed refresh keeps the last totals; the failure shows on the tiles.
      day = { ...day, error: reason(error) }
      noticeFeed.reportReadErrors('overview-day', [{ key: 'overview-day', title: background ? 'The day’s numbers could not refresh' : 'The day’s numbers are unavailable', body: reason(error) }])
    }
    repaint()
  }

  async function readHistory(mine: number): Promise<void> {
    const failures: ReadFailure[] = []
    await Promise.all([analyticsHistoryBounds(offset, anchor), analyticsDailyBounds(offset, anchor, 30)].map(async (edges, index) => {
      const title = index ? 'The 30 days' : 'The past year'
      try {
        const response = await fetch(organizationUrl(`/api/analytics/history?${new URLSearchParams({ bounds: edges.join(',') })}`), { signal })
        const data = await response.json().catch(() => null) as AnalyticsHistory & { error?: string } | null
        if (!response.ok || !Array.isArray(data?.periods)) throw new Error(data?.error || `HTTP ${response.status}`)
        if (mine !== generation) return
        const value = { data, error: '', at: Date.now() }
        if (index) daily = value; else history = value
        failures.push(...accountFailures(data.errors ?? []))
      } catch (error) {
        if (mine !== generation || signal.aborted) return
        if (index) daily = { ...daily, error: reason(error) }; else history = { ...history, error: reason(error) }
        failures.push({ key: `overview-history:${index}`, title: `${title} is unavailable`, body: reason(error) })
      }
    }))
    if (mine !== generation) return
    noticeFeed.reportReadErrors('overview-history', failures)
    repaint()
  }

  // ---------- Controls ----------
  main.addEventListener('click', (e) => {
    const target = e.target as Element
    const act = target.closest<HTMLElement>('[data-act^="day-"]')
    if (act) {
      if (act.matches('[aria-disabled="true"]')) return
      offset = Math.min(0, offset + (act.dataset.act === 'day-prev' ? -1 : 1))
      open = null
      void readDay(false)
      return
    }
    if (target.closest('[data-act="close-detail"]')) { const was = open; open = null; paint(); if (was) $(`[data-tile="${CSS.escape(was)}"]`, tiles)?.focus(); return }
    const tile = target.closest<HTMLElement>('[data-tile], [data-small]')
    if (tile) {
      const label = tile.dataset.tile ?? tile.dataset.small ?? ''
      open = open === label ? null : label
      paint()
      $(`[data-tile="${CSS.escape(label)}"], [data-small="${CSS.escape(label)}"]`, main)?.focus({ preventScroll: true })
      if (open) detail.scrollIntoView({ block: 'nearest' })
    }
  }, { signal })
  main.addEventListener('change', (e) => {
    const select = (e.target as Element).closest<HTMLSelectElement>('[data-org]')
    // The same choice as Board and Observe; its event reads the day again.
    if (select) setSelectedOrganization(select.value)
  }, { signal })
  tiles.addEventListener('keydown', (e) => {
    const tile = (e.target as Element).closest<HTMLElement>('[data-tile]')
    if (!tile) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tile.click(); return }
    const step = ({ ArrowLeft: -1, ArrowUp: -4, ArrowRight: 1, ArrowDown: 4 } as Record<string, number>)[e.key]
    if (e.altKey && step) { e.preventDefault(); move(tile.dataset.tile!, step) }
  }, { signal })
  function move(label: string, step: number): void {
    order = moveTile(order, label, step)
    store.set(TILES_KEY, order)
    paintTiles()
    $(`[data-tile="${CSS.escape(label)}"]`, tiles)?.focus()
  }
  let dragged: string | null = null
  tiles.addEventListener('dragstart', (e) => { const tile = (e.target as Element).closest<HTMLElement>('[data-tile]'); if (!tile) return; dragged = tile.dataset.tile!; tile.classList.add('is-dragging'); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move' }, { signal })
  tiles.addEventListener('dragover', (e) => { if (dragged && (e.target as Element).closest('[data-tile]')) e.preventDefault() }, { signal })
  tiles.addEventListener('drop', (e) => { const tile = (e.target as Element).closest<HTMLElement>('[data-tile]'); if (!tile || !dragged) return; e.preventDefault(); move(dragged, order.indexOf(tile.dataset.tile!) - order.indexOf(dragged)) }, { signal })
  tiles.addEventListener('dragend', () => { dragged = null; $$('.is-dragging', tiles).forEach((tile: HTMLElement) => tile.classList.remove('is-dragging')) }, { signal })
  // The readout follows the pointer, or the arrow keys with Home and End, week by week.
  detail.addEventListener('pointermove', (e) => {
    const chart = (e.target as Element).closest<HTMLElement>('[data-ychart]')
    const count = history.data?.periods.length ?? 0
    if (!chart || !count) return
    const box = chart.getBoundingClientRect()
    showWeek(chart, Math.round(((e.clientX - box.left) / Math.max(1, box.width)) * (count - 1)))
  }, { signal })
  detail.addEventListener('keydown', (e) => {
    const chart = (e.target as Element).closest<HTMLElement>('[data-ychart]')
    const count = history.data?.periods.length ?? 0
    if (!chart || !count) return
    const at = Number(chart.dataset.week ?? count - 1)
    const next = ({ ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: count - 1 } as Record<string, number>)[e.key]
    if (next === undefined) return
    e.preventDefault()
    showWeek(chart, next)
  }, { signal })

  // ---------- Live ----------
  // A return or a reload paints today's last numbers at once, so nothing below moves; the read refreshes them in place.
  if (getSettings().me && lastDay?.key === dayKey()) { ({ shown, day, history, daily } = lastDay); shownKey = lastDay.key }
  paint()
  void readDay(!!shown)
  ctx.every(getRefreshRateMs(), () => { if (document.visibilityState === 'visible') void readDay(true) })
  // A new day begins at midnight in Settings' zone: Today reads again.
  const midnight = () => {
    const delay = Date.parse(analyticsDay(0).until) - Date.now() + 10
    ctx.after(Math.max(1000, delay), () => { anchor = new Date(); if (offset === 0) void readDay(false); midnight() })
  }
  midnight()
  window.addEventListener('poise:organization-filter-changed', () => void readDay(false), { signal })
  find.onChange(() => { open = null; paint() })
  signal.addEventListener('abort', () => { for (const source of SOURCES) noticeFeed.reportReadErrors(source, []) })
}
