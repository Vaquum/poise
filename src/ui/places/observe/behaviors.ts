// Observe → Behaviors (#556): every agent run, as classic's Swarm reads them.
// The reading is a copy of src/views/swarm-view.ts, whose module keeps its
// state private and draws classic's table: the newest page and the running
// feed, 200 a page with exact totals and the server's search, refreshes that
// keep the pages already read, running runs settled by their own id, Stop with
// Sure?, Replay with its refusal, unreadable records kept apart and reported
// once (src/swarm-records.ts), and links that open the exact run. What is new
// is the mock's table: the seven state words, the behaviors' own names, the
// refusal and the failure on the row, runs that start while you are in the
// table waiting, counted, and a link to the work on Board.
import { $, esc } from '../../dom'
import { icon } from '../../icons'
import { placeHref } from '../../address'
import { term } from '../../registry'
import { logTime } from '../../../clock'
import { effectiveTimezone } from '../../../config'
import { noticeFeed } from '../../../notices'
import { organizationUrl } from '../../../organizations'
import { PHASE_LABELS } from '../../../agent-progress'
import { loadRecordsCheckpoints, retainQuarantineIds, saveRecordsCheckpoints } from '../../../swarm-records'
import { patchContent } from '../../../dom-patch'
import { viewFeedback } from '../../../view-feedback'
import {
  behaviorName, elapsedText, estimateText, groupRuns, isChatTurn, isReplayable, isRunning, matchesSearch, mergeQuarantined, modelName,
  quarantineDescription, quarantineKey, relFromMs, repoParts, serverSearch, startedAtMs, statusOf, targetKind, targetText,
  type LogEntry, type LogFeed, type QuarantinedLog, type RunEstimate, type RunGroup,
} from './runs'
import { aborted, capsule, clockTime, exactTime, external, failureOf, github, message, onBoard } from './util'
import type { ObservePart, PartContext } from './part'

const PAGE_SIZE = 200
const HISTORY_PAGE_LIMIT = 200
/** The last first page read, kept across visits with its scope and search. */
let lastFirst: { scope: string, search: string, data: LogFeed } | null = null
const STOP_ARM_MS = 4000
const COLUMNS = 11
const RECORDS_KEY = 'swarm-records'
const RECORDS_TITLE = 'Unreadable run records'

interface RunRow { entry: LogEntry, group?: RunGroup, repeat?: boolean }

export function createBehaviors(ctx: PartContext): ObservePart {
  const { root } = ctx
  root.innerHTML = `<div class="obv-bar">
      <input class="search" type="search" placeholder="Filter…" aria-label="Filter runs" autocomplete="off" spellcheck="false" data-sw-search data-ref="bh.search">
      <span class="obv-count" data-sw-count data-ref="bh.count"></span>
      <p class="obv-note" data-sw-history data-ref="bh.history"></p>
      <p class="oheld" data-sw-held data-ref="bh.held" hidden></p>
    </div>
    <p class="obv-warn" data-sw-stale data-ref="bh.stale" role="status" hidden></p>
    <p class="obv-warn" data-sw-focus role="status" hidden></p>
    <div class="obv-scroll" data-sw-scroll>
      <table class="table obv-table sw-table" aria-label="Agent runs">
        <thead><tr>
          <th class="c-group"><span class="sr">Identical runs</span></th>
          <th class="c-model"><span class="t-micro">Model</span></th>
          <th class="c-behavior"><span class="t-micro">Behavior</span></th>
          <th class="c-org"><span class="t-micro">Org</span></th>
          <th class="c-repo"><span class="t-micro">Repo</span></th>
          <th class="c-status"><span class="t-micro">Status</span></th>
          <th class="c-started"><span class="t-micro">Started</span></th>
          <th class="c-elapsed"><span class="t-micro">Elapsed</span></th>
          <th class="c-act"><span class="t-micro">Replay</span></th>
          <th class="c-act"><span class="t-micro">Stop</span></th>
          <th class="c-more"><span class="sr">Detail</span></th>
        </tr></thead>
        <tbody data-sw-rows></tbody>
      </table>
      <p class="obv-empty" data-sw-empty hidden></p>
      <div class="obv-quarantine" data-sw-quarantine></div>
    </div>`
  const body: HTMLElement = $('[data-sw-rows]', root)
  const scroll: HTMLElement = $('[data-sw-scroll]', root)
  const searchEl: HTMLInputElement = $('[data-sw-search]', root)

  // ---------- State, as classic's Swarm keeps it ----------
  let entries: LogEntry[] = []
  let quarantined: QuarantinedLog[] = []
  let searchQuery = ''
  let pageIndex = 0
  let searchDebounce = 0
  const expanded = new Map<string, { body: string | null, loading: boolean, error: string, unavailable: string, running: boolean }>()
  const expandedGroups = new Set<string>()
  let displayedGroups = new Map<string, RunGroup>()
  const reasoning = new Map<string, { chars: number, body: string, loading: boolean, error: string }>()
  const openReasoning = new Set<string>()
  let armedStop: { id: string, until: number } | null = null
  const stopsInFlight = new Set<string>()
  // Stopped, until a read shows the run settled: Stopping… holds until then.
  const stopping = new Set<string>()
  const replaysInFlight = new Set<string>()
  // Results that stay on the row: a refusal or failure in the server's words, or an accepted replay.
  const rowNotes = new Map<string, { text: string, warn: boolean }>()
  let pollInFlight: Promise<void> | null = null
  let pollOrganization = ''
  let pollSearch = ''
  let pollSequence = 0
  let incompleteTotal: number | null = null
  let loadingHistory = false
  let totalMatching = 0
  let historyCursor: string | null = null
  let historyComplete = false
  let historyIds = new Set<string>()
  let pinnedIds = new Set<string>()
  let lastLoadError: string | null = null
  let lastLoadedAt = 0
  let callFocusSequence = 0
  let focusMessage = ''
  // Arrivals wait while the pointer or the focus is in the table, counted (row 408).
  let inside = false
  const held = new Set<string>()
  const fresh = new Set<string>()
  // Estimates for running agent runs (main's /api/behavior-estimates).
  const estimates = new Map<string, RunEstimate | null>()
  let estimatesError = ''
  let estimatesAt = 0
  let stale = true

  const org = (): string => ctx.scope.org()

  // ---------- Unreadable records: reported once, kept per organization (classic's checkpoints) ----------
  const recordsCheckpoints = loadRecordsCheckpoints()
  let lastReportedOrg: string | null = null
  const recordsBody = (rows: QuarantinedLog[]): string => `${rows.length} unreadable worker log row(s) isolated. Other runs continue updating.\n${rows.map(quarantineDescription).join('\n')}`
  function reportRecords(): void {
    const scope = org()
    const checkpoint = recordsCheckpoints[scope]
    const freshKeys = quarantined.map(quarantineKey)
    const complete = historyComplete && !searchQuery && !lastLoadError
    const report = (text: string, since: string, due: string, preserve: boolean) => {
      noticeFeed.reportLocalNotices(RECORDS_KEY, [{ key: RECORDS_KEY, title: RECORDS_TITLE, body: text, kind: 'read_failed', preserveIdentity: preserve, since, due }])
      lastReportedOrg = scope
    }
    const clear = () => { viewFeedback(RECORDS_KEY, RECORDS_TITLE, ''); lastReportedOrg = scope }
    if (!quarantined.length && !checkpoint) { clear(); return }
    if (!quarantined.length && checkpoint) {
      if (complete) { delete recordsCheckpoints[scope]; saveRecordsCheckpoints(recordsCheckpoints); clear(); return }
      if (checkpoint.dismissed) { clear(); return }
      report(checkpoint.body, checkpoint.since, checkpoint.due, scope === lastReportedOrg)
      return
    }
    const known = new Set(checkpoint?.ids ?? [])
    const unseen = freshKeys.filter((key) => !known.has(key))
    const ids = retainQuarantineIds(checkpoint?.ids ?? [], freshKeys, complete)
    if (unseen.length) {
      const at = new Date().toISOString()
      const text = recordsBody(quarantined)
      recordsCheckpoints[scope] = { ids, since: at, due: at, dismissed: false, body: text }
      saveRecordsCheckpoints(recordsCheckpoints)
      report(text, at, at, false)
      return
    }
    const retained = recordsCheckpoints[scope]
    if (!retained || retained.dismissed) {
      if (retained?.dismissed && complete) { recordsCheckpoints[scope] = { ...retained, ids }; saveRecordsCheckpoints(recordsCheckpoints) }
      clear()
      return
    }
    const text = recordsBody(quarantined)
    const sameIds = ids.length === retained.ids.length && ids.every((id, index) => id === retained.ids[index])
    if (!sameIds || retained.body !== text) { recordsCheckpoints[scope] = { ...retained, ids, body: text }; saveRecordsCheckpoints(recordsCheckpoints) }
    report(text, retained.since, retained.due, scope === lastReportedOrg)
  }
  const unsubscribe = noticeFeed.subscribe(() => {
    if (!noticeFeed.isLocalNoticeDismissed(RECORDS_KEY)) return
    const checkpoint = recordsCheckpoints[org()]
    if (checkpoint && !checkpoint.dismissed) { recordsCheckpoints[org()] = { ...checkpoint, dismissed: true }; saveRecordsCheckpoints(recordsCheckpoints) }
  })

  // ---------- Rows ----------
  const visible = (): LogEntry[] => entries.filter((e) => !held.has(e.id) && matchesSearch(e, searchQuery))
  const groupRows = (groups: RunGroup[]): RunRow[] => groups.flatMap((group) => [
    { entry: group.entries[0], group },
    ...(expandedGroups.has(group.key) ? group.entries.slice(1).map((entry) => ({ entry, repeat: true })) : []),
  ])

  function groupButton(group?: RunGroup): string {
    if (!group || group.entries.length < 2) return ''
    const open = expandedGroups.has(group.key)
    const n = group.entries.length
    const label = `${open ? 'Hide' : 'Show'} ${n - 1} identical earlier ${n === 2 ? 'run' : 'runs'}, ${n} in all`
    return `<button type="button" class="grp-btn${open ? ' is-open' : ''}" data-act="sw-group" data-group-id="${esc(group.entries[0].id)}" aria-expanded="${open}" aria-label="${esc(label)}" data-help="${esc(label)}" data-ref="bh.group">${n}</button>`
  }
  function whereCells(e: LogEntry): string {
    const { owner, name } = repoParts(e)
    const pr = e.pr_id ? String(e.pr_id) : ''
    if (name || pr) {
      const orgCell = owner ? external(github(owner), esc(owner), 'sw-link', 'bh.org') : '<span class="dim">—</span>'
      const repo = !name ? '' : owner ? external(github(owner, name), esc(name), 'sw-link', 'bh.repo') : `<span>${esc(name)}</span>`
      const number = !pr ? '' : owner ? external(github(owner, name, targetKind(e), pr), `#${esc(pr)}`, 'sw-link is-num', 'bh.repo') : `<span class="is-num">#${esc(pr)}</span>`
      return `<td class="c-org">${orgCell}</td><td class="c-repo">${repo}<span class="dim"> </span>${number}</td>`
    }
    if (e.session_id) {
      const label = esc(targetText(e))
      return isChatTurn(e)
        ? `<td class="c-org" colspan="2"><a class="sw-session" href="${esc(placeHref('chat', { chat: e.session_id, back: 'observe' }))}" data-help="Open this conversation in Chat" data-ref="bh.session">${icon('chat', 'sm')}${label}</a></td>`
        : `<td class="c-org" colspan="2"><button type="button" class="sw-session" data-act="sw-session" data-session="${esc(e.session_id)}" data-help="Open this conversation — ${esc(e.session_id)}" data-ref="bh.session">${icon('chat', 'sm')}${label}</button></td>`
    }
    return '<td class="c-org"><span class="dim">—</span></td><td class="c-repo"><span class="dim">—</span></td>'
  }
  function statusHTML(e: LogEntry): string {
    if ((stopsInFlight.has(e.id) || stopping.has(e.id)) && isRunning(e)) return `${capsule('running')}<span class="ow">Stopping…</span>`
    const s = statusOf(e)
    const word = s.state === 'running' || s.word === term(`state.${s.state}`) ? term(`state.${s.state}`) : `${term(`state.${s.state}`)} · ${s.word}`
    const est = estimateText(e, estimates.get(e.id))
    const row = rowNotes.get(e.id)
    return `${capsule(s.state)}<span class="ow">${esc(word)}</span>${s.note ? `<span class="note${s.warn ? ' is-warn' : ''}" data-progress data-help="${esc(s.note)}">${esc(s.note)}</span>` : ''}${est ? `<span class="note${est.warn ? ' is-warn' : ''}" data-est data-ref="bh.est">${esc(est.text)}</span>` : ''}${row ? `<span class="note${row.warn ? ' is-warn' : ''}" data-row-note data-help="${esc(row.text)}">${esc(row.text)}</span>` : ''}`
  }
  function stopHTML(e: LogEntry): string {
    if (!isRunning(e)) return '<span class="dim">—</span>'
    if (stopsInFlight.has(e.id) || stopping.has(e.id)) return '<span class="spin" aria-label="Stopping"></span>'
    const armed = armedStop?.id === e.id && armedStop.until > Date.now()
    return `<button type="button" class="btn-ghost sw-stop${armed ? ' is-armed' : ''}" data-act="sw-stop" aria-label="${armed ? 'Confirm stopping this run' : 'Stop this run'}" data-help="${armed ? 'Sure? Press again to stop it' : 'Stop this run'}" data-ref="bh.stop">${armed ? 'Sure?' : icon('stop', 'sm')}</button>`
  }
  function replayHTML(e: LogEntry, repeat: boolean): string {
    if (!isReplayable(e) || repeat) return '<span class="dim">—</span>'
    if (replaysInFlight.has(e.id)) return '<span class="spin" aria-label="Replaying"></span>'
    const issue = e.behavior === 'issue_review'
    return `<button type="button" class="ib" data-act="sw-replay" aria-label="${issue ? 'Review this revision again' : 'Replay this run'}" data-help="${issue ? 'Review this revision again' : 'Replay this run'}" data-ref="bh.replay">${icon('replay', 'sm')}</button>`
  }
  function mainHTML(row: RunRow): string {
    const e = row.entry
    const open = expanded.has(e.id)
    const model = modelName(e)
    const detail = `<button type="button" class="ib chev${open ? ' is-open' : ''}" data-act="sw-detail" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} detail" data-help="${open ? 'Hide detail' : e.progress ? 'View activity' : e.error ? 'View error' : 'View response'}" data-ref="bh.detail">${icon('chev', 'sm')}</button>`
    return `<td class="c-group">${row.repeat ? '' : groupButton(row.group)}</td>
      <td class="c-model" data-help="${esc(model)}" data-ref="bh.model">${model ? esc(model) : '<span class="dim">—</span>'}</td>
      <td class="c-behavior" data-help="${esc(e.behavior ?? '')}" data-ref="bh.behavior">${esc(behaviorName(e))}</td>
      ${whereCells(e)}
      <td class="c-status" data-ref="bh.status"><span class="sw-st">${statusHTML(e)}</span></td>
      <td class="c-started" data-ref="bh.started" data-started data-help="${esc(exactTime(startedAtMs(e)))}">${esc(relFromMs(startedAtMs(e)))}</td>
      <td class="c-elapsed" data-ref="bh.elapsed" data-elapsed>${esc(elapsedText(e))}</td>
      <td class="c-act">${replayHTML(e, !!row.repeat)}</td>
      <td class="c-act">${stopHTML(e)}</td>
      <td class="c-more">${detail}</td>`
  }

  function activityHTML(e: LogEntry): string {
    const p = e.progress
    if (!p) return ''
    const zone = effectiveTimezone(), now = Date.now(), live = isRunning(e)
    const heartbeat = live ? `Worker heartbeat ${relFromMs(Date.parse(p.heartbeat_at), now)} ago` : `Last worker heartbeat at ${logTime(p.heartbeat_at, zone, now)}`
    const provider = p.last_provider_event_at
      ? (live ? `Last provider event ${relFromMs(Date.parse(p.last_provider_event_at), now)} ago` : `Last provider event at ${logTime(p.last_provider_event_at, zone, now)}`)
      : 'No provider event received'
    let deadline = ''
    if (live && p.deadline_at) {
      const left = Date.parse(p.deadline_at) - now
      deadline = left > 0 ? `Stage deadline in ${Math.ceil(left / 60_000)}m` : 'Stage deadline passed; waiting for the worker’s outcome'
    }
    const events = p.events.map((event) => `<li><time datetime="${esc(event.at)}">${esc(logTime(event.at, zone, now))}</time>${esc(event.message)}</li>`).join('')
    const r = reasoning.get(e.id)
    const reasoningHTML = p.reasoning_available === undefined ? '' : `<details class="sw-reasoning" data-reasoning-id="${esc(e.id)}"${openReasoning.has(e.id) ? ' open' : ''} data-ref="bh.reasoning"><summary>Provider reasoning</summary>${r?.error ? `<p class="note is-warn">${esc(r.error)}</p>` : ''}<pre class="sw-pre">${r?.loading && !r.body ? 'Reading…' : esc(r?.body ?? '')}</pre></details>`
    return `<section class="sw-activity" data-ref="bh.activity"><h4 class="t-micro">Activity · ${esc(PHASE_LABELS[p.phase] || 'Unknown activity')}</h4><p class="sw-facts">${esc([heartbeat, provider, deadline].filter(Boolean).join(' · '))}</p>${p.warning ? `<p class="note is-warn">${esc(p.warning)}</p>` : ''}${events ? `<ol class="sw-events">${events}</ol>` : ''}${reasoningHTML}</section>`
  }
  function detailHTML(e: LogEntry): string {
    const state = expanded.get(e.id)
    const { owner, name } = repoParts(e)
    const target = owner && name && e.pr_id ? `${owner}/${name}#${e.pr_id}` : ''
    const response = state?.loading ? '<section><h4 class="t-micro">Response</h4><p class="note"><span class="spin"></span> Reading the response…</p></section>'
      : state?.error ? `<section><h4 class="t-micro">Response</h4><p class="note is-warn">${esc(state.error)}</p></section>`
        : state?.unavailable ? `<section><h4 class="t-micro">Response</h4><p class="note">Unavailable: ${esc(state.unavailable)}</p></section>`
          : state?.body !== null && state?.body !== undefined ? `<section><h4 class="t-micro">Response</h4><pre class="sw-pre">${esc(state.body)}</pre></section>` : ''
    return `<td colspan="${COLUMNS}"><div class="sw-detail-in">
      ${activityHTML(e)}${response}
      ${e.error ? `<section><h4 class="t-micro">Error</h4><pre class="sw-pre is-error">${esc(e.error)}</pre></section>` : ''}
      <p class="sw-go">${target ? `${external(github(owner, name, targetKind(e), e.pr_id!), `Open ${esc(target)} ↗`)}<a class="lnk" href="${esc(onBoard(target))}" data-ref="bh.board">See it on Board</a>` : ''}<span class="dim t-mono">Run ${esc(e.id.slice(0, 12))}…</span></p>
    </div></td>`
  }

  // Keyed rows: an unchanged row is never rebuilt, so nothing moves while you read.
  const rowMarkup = new WeakMap<HTMLElement, string>()
  function reconcile(rows: RunRow[]): void {
    const main = new Map<string, HTMLTableRowElement>()
    const detail = new Map<string, HTMLTableRowElement>()
    for (const tr of [...body.children] as HTMLTableRowElement[]) {
      if (tr.dataset.run) main.set(tr.dataset.run, tr)
      if (tr.dataset.detailFor) detail.set(tr.dataset.detailFor, tr)
    }
    const ids = new Set(rows.map(({ entry }) => entry.id))
    for (const [id, tr] of main) if (!ids.has(id)) tr.remove()
    for (const [id, tr] of detail) if (!ids.has(id) || !expanded.has(id)) tr.remove()
    const focused = document.activeElement
    let cursor: ChildNode | null = body.firstChild
    const place = (tr: HTMLTableRowElement) => { if (cursor !== tr) body.insertBefore(tr, cursor); cursor = tr.nextSibling }
    for (const row of rows) {
      const e = row.entry
      const markup = mainHTML(row)
      let tr = main.get(e.id)
      if (!tr) { tr = document.createElement('tr'); tr.dataset.run = e.id }
      tr.className = `sw-row${row.repeat ? ' is-repeat' : ''}${fresh.has(e.id) ? ' is-fresh' : ''}`
      if (rowMarkup.get(tr) !== markup) { patchContent(tr, markup); rowMarkup.set(tr, markup) }
      place(tr)
      if (expanded.has(e.id)) {
        let d = detail.get(e.id)
        if (!d) { d = document.createElement('tr'); d.className = 'sw-detail'; d.dataset.detailFor = e.id }
        const next = detailHTML(e)
        const selection = getSelection()
        const selecting = !!selection && !selection.isCollapsed && !!selection.anchorNode && d.contains(selection.anchorNode)
        if (!selecting && rowMarkup.get(d) !== next) { patchContent(d, next); rowMarkup.set(d, next) }
        place(d)
      }
    }
    if (focused instanceof HTMLElement && focused.isConnected && body.contains(focused)) focused.focus({ preventScroll: true })
  }

  function render(): void {
    if (!ctx.visible()) return
    const present = new Map(entries.map((e) => [e.id, e]))
    for (const id of held) if (!present.has(id)) held.delete(id)
    for (const id of stopping) if (!present.get(id) || !isRunning(present.get(id)!)) stopping.delete(id)
    const list = visible()
    const groups = groupRuns(list)
    const rows = groupRows(groups)
    pageIndex = Math.min(pageIndex, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1))
    const start = pageIndex * PAGE_SIZE
    displayedGroups = new Map(groups.map((group) => [group.entries[0].id, group]))
    reconcile(rows.slice(start, start + PAGE_SIZE))
    const empty = $('[data-sw-empty]', root)
    empty.hidden = list.length > 0 || !lastLoadedAt
    empty.textContent = searchQuery ? 'No run matches the filter.' : 'No runs yet.'
    const total = entries.length - held.size
    $('[data-sw-count]', root).textContent = !lastLoadedAt ? '' : list.length === total ? `${total} runs` : `${list.length} of ${total} runs`
    paintHistory(rows.length, start)
    paintHeld()
    paintQuarantine()
    const running = entries.filter(isRunning).length
    ctx.count(running ? `${capsule('running')}${running} running` : '')
  }

  function paintHistory(rows: number, start: number): void {
    const note = $('[data-sw-history]', root)
    if (!lastLoadedAt) { note.innerHTML = lastLoadError ? '' : '<span class="spin"></span> Reading the newest runs…'; return }
    const more = historyCursor !== null
    const pages = Math.max(1, Math.ceil(rows / PAGE_SIZE))
    const totalText = totalMatching ? `, of ${totalMatching.toLocaleString('en-US')} runs in all` : ''
    const loadingText = loadingHistory ? ' · <span class="spin"></span> reading older runs' : ''
    const estimate = estimatesError ? ` · <span class="is-warn">estimates unavailable: ${esc(estimatesError)}</span>` : ''
    const pager = rows > PAGE_SIZE || more
      ? ` <span class="pager" data-ref="bh.pager"><button type="button" class="btn-ghost" data-page="-1"${pageIndex === 0 ? ' aria-disabled="true"' : ''}>Newer</button><button type="button" class="btn-ghost" data-page="1"${start + PAGE_SIZE >= rows && !more ? ' aria-disabled="true"' : ''}>Older</button></span>`
      : ''
    patchContent(note, `Newest first, 200 a page · page ${pageIndex + 1} of ${pages}${more ? '+' : ''}${totalText} · search reads every run · running ones refresh every 15 seconds${loadingText}${estimate}${pager}`)
  }
  function paintHeld(): void {
    const el = $('[data-sw-held]', root)
    el.hidden = !held.size
    el.innerHTML = `${held.size} new ${held.size === 1 ? 'run' : 'runs'} · <button type="button" class="lnk" data-act="sw-release">Show now</button>`
  }
  function paintQuarantine(): void {
    const box = $('[data-sw-quarantine]', root)
    patchContent(box, quarantined.length ? `<details class="obv-q" data-ref="bh.quarantine"><summary><span class="sdot is-warn"></span>${quarantined.length} unreadable ${quarantined.length === 1 ? 'record' : 'records'} kept apart. Every other run keeps updating.</summary>${quarantined.map((row) => `<p>${esc(quarantineDescription(row))}</p>`).join('')}</details>` : '')
  }
  function paintStale(): void {
    const el = $('[data-sw-stale]', root)
    const partial = incompleteTotal === null ? '' : ` Only ${entries.length} of ${incompleteTotal} runs are loaded.`
    el.hidden = !lastLoadError
    el.innerHTML = lastLoadError ? `<span class="sdot is-warn"></span>Behaviors is not updating: ${esc(lastLoadError)}. ${lastLoadedAt ? `Last read ${esc(clockTime(lastLoadedAt))}.` : 'Nothing has been read yet.'}${esc(partial)} Poise keeps trying.` : ''
    reportRecords()
  }
  function paintFocus(): void {
    const el = $('[data-sw-focus]', root)
    el.hidden = !focusMessage
    el.innerHTML = focusMessage ? `<span class="sdot is-warn"></span>${esc(focusMessage)}` : ''
  }

  // ---------- Arrivals wait while you are in the table ----------
  function release(): void {
    if (!held.size) return
    for (const id of held) fresh.add(id)
    held.clear()
    render()
    ctx.after(2400, () => { fresh.clear(); render() })
  }
  scroll.addEventListener('pointerenter', () => { inside = true })
  scroll.addEventListener('pointerleave', () => { inside = scroll.contains(document.activeElement); if (!inside) ctx.after(400, () => { if (!inside) release() }) })
  scroll.addEventListener('focusin', () => { inside = true })
  scroll.addEventListener('focusout', (e: FocusEvent) => {
    if (!scroll.contains(e.relatedTarget as Node | null) && !scroll.matches(':hover')) { inside = false; ctx.after(400, () => { if (!inside) release() }) }
  })
  /** New runs that arrived at the top while you were in the table. */
  function holdArrivals(before: Set<string>): void {
    if (!inside || !before.size) return
    for (const entry of entries) if (!before.has(entry.id)) held.add(entry.id)
  }

  // ---------- Reading, as classic's Swarm reads ----------
  async function readLogFeed(url: string): Promise<LogFeed> {
    const response = await fetch(url, { cache: 'no-store', signal: ctx.signal })
    if (!response.ok) throw new Error(await failureOf(response))
    return response.json()
  }
  const historyUrl = (scope: string, cursor: string | null, search: string): string => {
    let path = `/api/agent-logs?limit=${HISTORY_PAGE_LIMIT}`
    if (cursor !== null) path += `&cursor=${encodeURIComponent(cursor)}`
    if (search) path += `&search=${encodeURIComponent(serverSearch(search))}`
    return organizationUrl(path, scope)
  }
  const byTime = (list: LogEntry[]): LogEntry[] => list.map((e) => [startedAtMs(e), e] as const).sort((a, b) => b[0] - a[0]).map(([, e]) => e)

  function applyFirstPage(data: LogFeed, current: () => boolean): void {
    lastFirst = { scope: org(), search: searchQuery, data }
    if (!current()) return
    entries = data.logs || []
    historyIds = new Set(entries.map((e) => e.id))
    pinnedIds = new Set(entries.map((e) => e.id))
    quarantined = mergeQuarantined([], Array.isArray(data.quarantined) ? data.quarantined : [])
    totalMatching = data.total ?? entries.length
    historyCursor = data.nextCursor ?? null
    historyComplete = historyCursor === null
    incompleteTotal = historyCursor !== null ? totalMatching : null
    loadingHistory = historyCursor !== null
    lastLoadError = null
    lastLoadedAt = Date.now()
    render()
    paintStale()
    refreshExpandedDetails()
  }

  function slotTail(merged: LogEntry[], tail: LogEntry[], staleIds: Set<string>): LogEntry[] {
    const placed = [...merged]
    const at = placed.map(startedAtMs)
    for (const row of tail) {
      const ms = startedAtMs(row)
      let index = placed.length
      while (index > 0 && (at[index - 1]! < ms || staleIds.has(placed[index - 1]!.id))) index--
      placed.splice(index, 0, row)
      at.splice(index, 0, ms)
    }
    return placed
  }

  function appendPage(data: LogFeed, cursor: string | null, current: () => boolean): boolean {
    if (!current()) return false
    const retained = new Set(entries.map((e) => e.id))
    const pinned = new Set(pinnedIds)
    const covered = new Set(historyIds)
    const page = data.logs || []
    let older: string | null = null
    const before = new Map<string, LogEntry[]>()
    const tail: LogEntry[] = []
    const move = new Set<string>()
    for (let index = page.length - 1; index >= 0; index--) {
      const row = page[index]!
      historyIds.add(row.id)
      pinnedIds.add(row.id)
      if (pinned.has(row.id)) { if (retained.has(row.id)) older = row.id; continue }
      if (retained.has(row.id)) move.add(row.id)
      if (older === null) tail.push(row)
      else { const group = before.get(older); if (group) group.push(row); else before.set(older, [row]) }
    }
    tail.reverse()
    for (const group of before.values()) group.reverse()
    if (before.size || tail.length || move.size) {
      const kept = move.size ? entries.filter((e) => !move.has(e.id)) : entries
      const merged: LogEntry[] = []
      for (const entry of kept) { const group = before.get(entry.id); if (group) merged.push(...group); merged.push(entry) }
      const staleIds = new Set<string>()
      if (tail.length) {
        const pageIds = new Set(page.map((row) => row.id))
        for (const entry of kept) if (!covered.has(entry.id) && !pageIds.has(entry.id) && !isRunning(entry)) staleIds.add(entry.id)
      }
      entries = tail.length ? slotTail(merged, tail, staleIds) : merged
    }
    quarantined = mergeQuarantined(quarantined, Array.isArray(data.quarantined) ? data.quarantined : [])
    if (typeof data.total === 'number') totalMatching = data.total
    historyCursor = cursor
    historyComplete = cursor === null
    incompleteTotal = historyCursor !== null ? totalMatching : null
    loadingHistory = historyCursor !== null
    lastLoadedAt = Date.now()
    render()
    paintStale()
    refreshExpandedDetails()
    return true
  }

  function mergeRefresh(history: LogFeed, running: LogFeed): void {
    const before = new Set(entries.map((e) => e.id))
    const incoming = new Map<string, LogEntry>()
    for (const entry of running.logs || []) incoming.set(entry.id, entry)
    for (const entry of history.logs || []) if (!incoming.has(entry.id)) incoming.set(entry.id, entry)
    const known = new Map(entries.map((e) => [e.id, e]))
    let arrivals = false
    let historyArrivals = false
    let absorbedLogs = 0
    for (const entry of history.logs || []) if (!known.has(entry.id)) { historyArrivals = true; absorbedLogs++ }
    for (const [id, entry] of incoming) { if (!known.has(id)) arrivals = true; known.set(id, entry) }
    const knownBadBefore = new Set(quarantined.map(quarantineKey))
    if (!historyArrivals) historyArrivals = (history.quarantined || []).some((row) => !knownBadBefore.has(quarantineKey(row)))
    const historyOverlaps = (history.logs || []).some((e) => historyIds.has(e.id))
    const freshBad = mergeQuarantined(running.quarantined || [], history.quarantined || [])
    const absorbedBad = freshBad.filter((row) => !knownBadBefore.has(quarantineKey(row))).length
    const hiddenGrowth = historyComplete && typeof history.total === 'number' && history.total - totalMatching > absorbedLogs + absorbedBad
    const keepComplete = historyComplete && (!historyArrivals || historyOverlaps) && !hiddenGrowth
    if (historyArrivals && !keepComplete) historyIds = new Set((history.logs || []).map((e) => e.id))
    else for (const entry of history.logs || []) historyIds.add(entry.id)
    for (const entry of history.logs || []) pinnedIds.add(entry.id)
    if (!arrivals) arrivals = absorbedBad > 0
    entries = byTime([...incoming.values(), ...entries.filter((e) => !incoming.has(e.id))])
    quarantined = mergeQuarantined(quarantined, freshBad)
    if (typeof history.total === 'number') totalMatching = history.total
    if (!keepComplete && (arrivals || historyCursor === null)) historyCursor = history.nextCursor ?? null
    historyComplete = historyCursor === null
    incompleteTotal = historyCursor !== null ? totalMatching : null
    loadingHistory = historyCursor !== null
    lastLoadError = null
    lastLoadedAt = Date.now()
    holdArrivals(before)
    render()
    paintStale()
    refreshExpandedDetails()
  }

  async function loadMoreForView(current: () => boolean): Promise<void> {
    if (!current() || historyCursor === null) return
    const scope = org(), search = searchQuery
    const needed = pageIndex * PAGE_SIZE + 1
    const covered = groupRows(groupRuns(entries.filter((e) => historyIds.has(e.id) && matchesSearch(e, searchQuery))))
    if (covered.length >= needed) return
    const data = await readLogFeed(historyUrl(scope, historyCursor, search))
    if (!current() || scope !== org() || search !== searchQuery) return
    appendPage(data, data.nextCursor ?? null, current)
  }

  async function settleStaleRunning(freshIds: Set<string>, current: () => boolean): Promise<void> {
    const scope = org()
    const staleRuns = entries.filter((e) => isRunning(e) && !freshIds.has(e.id))
    if (!staleRuns.length) return
    const settled = await Promise.all(staleRuns.map(async (entry) => {
      try { return { data: await readLogFeed(organizationUrl(`/api/agent-logs?id=${encodeURIComponent(entry.id)}`, scope)), error: null as string | null } }
      catch (error) { return { data: null, error: message(error) } }
    }))
    if (!current()) return
    let changed = false
    const failures: string[] = []
    const byId = new Map(entries.map((e) => [e.id, e]))
    for (let index = 0; index < staleRuns.length; index++) {
      const { data } = settled[index]!
      if (!data) { failures.push(staleRuns[index]!.id.slice(0, 8)); continue }
      const row = (data.logs || [])[0]
      if (row) { if (matchesSearch(row, searchQuery)) byId.set(row.id, row); else byId.delete(row.id); changed = true; continue }
      const bad = (Array.isArray(data.quarantined) ? data.quarantined : []).find((item) => item.id === staleRuns[index]!.id)
      if (bad) { byId.delete(staleRuns[index]!.id); changed = true; quarantined = mergeQuarantined(quarantined, [bad]) }
    }
    if (failures.length) lastLoadError = `Settling ${failures.length} running ${failures.length === 1 ? 'run' : 'runs'} failed (${failures.join(', ')}): ${settled.find((item) => item.error)?.error || 'lookup failed'}`
    if (!changed && !failures.length) return
    entries = byTime([...byId.values()])
    render()
    paintStale()
    refreshExpandedDetails()
  }

  async function chaseHistoryFill(current: () => boolean, scope: string, search: string): Promise<void> {
    while (current() && historyCursor !== null && entries.length + quarantined.length < PAGE_SIZE) {
      const data = await readLogFeed(historyUrl(scope, historyCursor, search))
      if (!current() || scope !== org() || search !== searchQuery) return
      appendPage(data, data.nextCursor ?? null, current)
    }
  }

  function pollOnce(chase = false): Promise<void> {
    const scope = org(), search = searchQuery
    if (pollInFlight && pollOrganization === scope && pollSearch === search) return pollInFlight
    pollOrganization = scope
    pollSearch = search
    const mine = ++pollSequence
    const current = () => mine === pollSequence && scope === org() && search === searchQuery && !ctx.signal.aborted
    const run = (async () => {
      try {
        if (!lastLoadedAt || entries.length === 0) {
          const [history, running] = await Promise.all([readLogFeed(historyUrl(scope, null, search)), readLogFeed(organizationUrl('/api/agent-logs?status=running', scope))])
          if (!current()) return
          applyFirstPage(history, current)
          const known = new Set(entries.map((e) => e.id))
          const extra = (running.logs || []).filter((e) => !known.has(e.id) && matchesSearch(e, searchQuery))
          if (extra.length) { entries = byTime([...extra, ...entries]); render() }
          if ((running.quarantined || []).length) { quarantined = mergeQuarantined(quarantined, running.quarantined || []); paintStale() }
          if (chase && current()) await chaseHistoryFill(current, scope, search)
        } else {
          const history = await readLogFeed(historyUrl(scope, null, search))
          if (!current()) return
          const running: LogFeed = history.nextCursor == null ? { logs: [] } : await readLogFeed(organizationUrl('/api/agent-logs?status=running', scope))
          if (!current()) return
          mergeRefresh(history, running)
          if (!current()) return
          await settleStaleRunning(new Set([...(history.logs || []), ...(running.logs || [])].map((e) => e.id)), current)
        }
        if (!current()) return
        await loadMoreForView(current)
        void readEstimates()
      } catch (error) {
        if (aborted(error) || !current()) return
        loadingHistory = historyCursor !== null
        lastLoadError = message(error)
        if (entries.length) render()
        paintStale()
      } finally {
        if (mine === pollSequence) pollInFlight = null
      }
    })()
    pollInFlight = run
    return run
  }

  async function ensureTarget(predicate: (entry: LogEntry) => boolean, preferHistory = false): Promise<LogEntry | undefined> {
    const mine = pollSequence, scope = org(), search = searchQuery
    const current = () => mine === pollSequence && scope === org() && search === searchQuery && !ctx.signal.aborted
    const find = (historyOnly: boolean) => entries.find((e) => predicate(e) && (!historyOnly || historyIds.has(e.id)))
    let match = find(preferHistory)
    while (!match && historyCursor !== null && current()) {
      const data = await readLogFeed(historyUrl(scope, historyCursor, search))
      if (!current()) return undefined
      if (!appendPage(data, data.nextCursor ?? null, current)) return undefined
      match = find(preferHistory)
    }
    if (!match && preferHistory) match = entries.find(predicate)
    return match
  }

  async function readEstimates(): Promise<void> {
    if (!entries.some(isRunning) || Date.now() - estimatesAt < 14_000) return
    estimatesAt = Date.now()
    try {
      const response = await fetch('/api/behavior-estimates', { cache: 'no-store', signal: ctx.signal })
      if (!response.ok) throw new Error(await failureOf(response))
      const data = await response.json() as { estimates?: Array<{ id: string, estimate: RunEstimate | null }> }
      if (!Array.isArray(data.estimates)) throw new Error('the answer is incomplete')
      estimates.clear()
      for (const row of data.estimates) if (row && typeof row.id === 'string') estimates.set(row.id, row.estimate ?? null)
      estimatesError = ''
    } catch (error) {
      if (aborted(error)) return
      estimatesError = message(error)
    }
    render()
  }

  // ---------- Detail: the response and the provider's reasoning, read when opened ----------
  function refreshExpandedDetails(): void {
    for (const entry of entries) {
      const state = expanded.get(entry.id)
      if (state && openReasoning.has(entry.id)) void loadReasoning(entry.id)
      if (state && !state.loading && state.body === null && !state.error
        && (entry.response || (state.unavailable !== '' && state.running && !isRunning(entry)))) void loadResponse(entry.id)
    }
  }
  async function loadResponse(id: string): Promise<void> {
    const startedRunning = entries.some((entry) => entry.id === id && isRunning(entry))
    expanded.set(id, { body: null, loading: true, error: '', unavailable: '', running: false })
    render()
    let next: { body: string | null, loading: boolean, error: string, unavailable: string, running: boolean }
    try {
      const response = await fetch(`/api/agent-response/${encodeURIComponent(id)}`, { cache: 'no-store', signal: ctx.signal })
      if (!response.ok) throw new Error(await failureOf(response))
      const data = await response.json() as { body?: unknown, disposition?: unknown, reason?: unknown }
      if (data.disposition === 'unavailable' && typeof data.reason === 'string' && data.reason) {
        next = { body: null, loading: false, error: '', unavailable: data.reason, running: startedRunning }
      } else {
        if (data.disposition !== undefined || typeof data.body !== 'string') throw new Error('the answer is incomplete')
        next = { body: data.body, loading: false, error: '', unavailable: '', running: false }
      }
    } catch (error) {
      if (aborted(error)) return
      next = { body: null, loading: false, error: `The response could not be read: ${message(error)}`, unavailable: '', running: false }
    }
    // The row may have been folded while the response was out.
    if (!expanded.has(id)) return
    expanded.set(id, next)
    render()
    if (next.unavailable !== '' && next.running) {
      const current = entries.find((e) => e.id === id)
      if (current && !isRunning(current)) void loadResponse(id)
    }
  }
  async function loadReasoning(id: string): Promise<void> {
    const entry = entries.find((e) => e.id === id)
    if (!entry?.progress?.reasoning_available || !openReasoning.has(id)) return
    const saved = reasoning.get(id)
    const chars = entry.progress.reasoning_chars || 0
    if (saved?.loading || (saved?.chars === chars && !saved.error)) return
    reasoning.set(id, { chars: saved?.chars ?? -1, body: saved?.body || '', loading: true, error: '' })
    render()
    try {
      const response = await fetch(`/api/agent-reasoning/${encodeURIComponent(id)}`, { cache: 'no-store', signal: ctx.signal })
      if (!response.ok) throw new Error(await failureOf(response))
      const data = await response.json() as { body?: unknown }
      if (typeof data.body !== 'string') throw new Error('the answer is incomplete')
      reasoning.set(id, { chars, body: data.body, loading: false, error: '' })
    } catch (error) {
      if (aborted(error)) return
      reasoning.set(id, { chars: -1, body: saved?.body || '', loading: false, error: `The reasoning could not be read: ${message(error)}` })
    }
    render()
  }

  // ---------- Actions ----------
  async function stop(entry: LogEntry): Promise<void> {
    const id = entry.id
    if (stopsInFlight.has(id)) return
    if (!(armedStop?.id === id && armedStop.until > Date.now())) {
      armedStop = { id, until: Date.now() + STOP_ARM_MS }
      render()
      $(`[data-run="${CSS.escape(id)}"] [data-act="sw-stop"]`, body)?.focus({ preventScroll: true })
      ctx.after(STOP_ARM_MS + 50, () => { if (armedStop?.id === id && armedStop.until <= Date.now()) { armedStop = null; render() } })
      return
    }
    armedStop = null
    stopsInFlight.add(id)
    rowNotes.delete(id)
    render()
    try {
      const response = await fetch('/api/agent-stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), signal: ctx.signal })
      if (!response.ok) throw new Error(await failureOf(response))
      stopping.add(id)
      ctx.after(300, () => { void pollOnce() })
    } catch (error) {
      if (aborted(error)) return
      rowNotes.set(id, { text: `Not stopped: ${message(error)}`, warn: true })
    } finally {
      stopsInFlight.delete(id)
      render()
    }
  }
  async function replay(entry: LogEntry): Promise<void> {
    const id = entry.id
    if (replaysInFlight.has(id)) return
    replaysInFlight.add(id)
    rowNotes.delete(id)
    render()
    try {
      const response = await fetch('/api/agent-replay', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ behavior: entry.behavior, repo: entry.repo, pr_id: entry.pr_id }), signal: ctx.signal })
      if (response.status === 409) {
        const data = await response.json().catch(() => ({})) as { error?: unknown }
        rowNotes.set(id, { text: `Refused: ${typeof data.error === 'string' && data.error ? data.error : 'Replay refused.'}`, warn: true })
        return
      }
      if (!response.ok) throw new Error(await failureOf(response))
      rowNotes.set(id, { text: `Accepted at ${clockTime(Date.now())} · the new run comes in at the top`, warn: false })
      ctx.after(800, () => { void pollOnce() })
    } catch (error) {
      if (aborted(error)) return
      rowNotes.set(id, { text: `Not replayed: ${message(error)}`, warn: true })
    } finally {
      replaysInFlight.delete(id)
      render()
    }
  }
  async function openSession(button: HTMLElement, session: string): Promise<void> {
    try {
      const response = await fetch(`/api/chat/sessions?legacy=${encodeURIComponent(session)}`, { cache: 'no-store', signal: ctx.signal })
      if (!response.ok) throw new Error(await failureOf(response))
      const data = await response.json() as { session?: { id?: unknown } | null }
      if (!data || !('session' in data)) throw new Error('the answer is incomplete')
      if (data.session === null) {
        const note = document.createElement('span')
        note.className = 'note'
        note.textContent = 'This conversation was never opened in Chat; its replies stay here, in the detail.'
        button.replaceWith(note)
        return
      }
      if (!data.session || typeof data.session.id !== 'string' || !data.session.id) throw new Error('the answer is incomplete')
      ctx.go(placeHref('chat', { chat: data.session.id, back: 'observe' }))
    } catch (error) {
      if (aborted(error)) return
      button.setAttribute('data-help', `The conversation could not be found: ${message(error)}`)
      button.classList.add('is-warn')
    }
  }

  body.addEventListener('toggle', (e: Event) => {
    const details = e.target
    if (!(details instanceof HTMLDetailsElement) || !details.dataset.reasoningId) return
    const id = details.dataset.reasoningId
    if (details.open) { openReasoning.add(id); void loadReasoning(id) } else openReasoning.delete(id)
  }, true)
  body.addEventListener('click', (e: Event) => {
    const button = (e.target as Element).closest<HTMLElement>('[data-act]')
    if (!button) return
    const id = button.closest<HTMLElement>('[data-run]')?.dataset.run ?? ''
    const entry = entries.find((x) => x.id === id)
    switch (button.dataset.act) {
      case 'sw-group': {
        const group = displayedGroups.get(button.dataset.groupId ?? '')
        if (!group) return
        if (expandedGroups.has(group.key)) expandedGroups.delete(group.key); else expandedGroups.add(group.key)
        render()
        $(`[data-run="${CSS.escape(group.entries[0].id)}"] [data-act="sw-group"]`, body)?.focus({ preventScroll: true })
        break
      }
      case 'sw-detail':
        if (expanded.has(id)) { expanded.delete(id); render() } else void loadResponse(id)
        break
      case 'sw-stop': if (entry) void stop(entry); break
      case 'sw-replay': if (entry) void replay(entry); break
      case 'sw-session': void openSession(button, button.dataset.session ?? ''); break
    }
  })
  root.addEventListener('click', (e: Event) => {
    const target = e.target as Element
    if (target.closest('[data-act="sw-release"]')) { release(); return }
    const pageButton = target.closest<HTMLElement>('[data-page]')
    if (!pageButton || pageButton.getAttribute('aria-disabled') === 'true') return
    const previous = pageIndex
    pageIndex = Math.max(0, pageIndex + Number(pageButton.dataset.page))
    const mine = pollSequence, scope = org(), search = searchQuery
    const current = () => mine === pollSequence && scope === org() && search === searchQuery
    void loadMoreForView(current).then(() => {
      if (!current()) return
      render()
      scroll.scrollTop = 0
    }, (error: unknown) => {
      if (aborted(error) || !current()) return
      pageIndex = previous
      lastLoadError = message(error)
      paintStale()
    })
  })
  searchEl.addEventListener('input', () => {
    clearTimeout(searchDebounce)
    searchDebounce = window.setTimeout(() => {
      const next = searchEl.value.trim()
      if (next === searchQuery) return
      searchQuery = next
      pageIndex = 0
      focusMessage = ''
      paintFocus()
      // Filter what is in hand at once; the server's search reads every run behind it.
      entries = entries.filter((e) => matchesSearch(e, searchQuery))
      held.clear()
      const kept = new Set(entries.map((e) => e.id))
      pinnedIds = new Set([...pinnedIds].filter((id) => kept.has(id)))
      historyIds.clear()
      quarantined = []
      totalMatching = 0
      historyCursor = null
      historyComplete = false
      incompleteTotal = null
      loadingHistory = false
      render()
      paintStale()
      void pollOnce()
    }, 90)
  })

  function reset(): void {
    entries = []
    historyIds.clear()
    pinnedIds.clear()
    quarantined = []
    lastLoadError = null
    lastLoadedAt = 0
    incompleteTotal = null
    loadingHistory = false
    totalMatching = 0
    historyCursor = null
    historyComplete = false
    pageIndex = 0
    held.clear()
    expanded.clear()
    expandedGroups.clear()
    openReasoning.clear()
    displayedGroups.clear()
    body.replaceChildren()
  }
  ctx.scope.onChange(() => {
    reset()
    if (ctx.visible()) { render(); paintStale(); void pollOnce() } else stale = true
  })

  // ---------- A link opens the exact run, clearing a filter that hides it ----------
  function clearSearch(): void {
    if (!searchQuery) return
    clearTimeout(searchDebounce)
    searchQuery = ''
    searchEl.value = ''
    reset()
  }
  function showRun(match: LogEntry): HTMLTableRowElement | null {
    held.delete(match.id)
    const groups = groupRuns(visible())
    const group = groups.find((candidate) => candidate.entries.some((e) => e.id === match.id))
    if (group && group.entries[0].id !== match.id) expandedGroups.add(group.key)
    const index = groupRows(groups).findIndex((row) => row.entry.id === match.id)
    pageIndex = Math.max(0, Math.floor(index / PAGE_SIZE))
    if (!expanded.has(match.id)) void loadResponse(match.id)
    render()
    const row = body.querySelector<HTMLTableRowElement>(`tr[data-run="${CSS.escape(match.id)}"]`)
    if (row) {
      row.scrollIntoView({ block: 'center' })
      row.classList.add('is-focus')
      ctx.after(1600, () => row.classList.remove('is-focus'))
      ;(row.querySelector<HTMLElement>('[data-act="sw-detail"]') ?? row).focus({ preventScroll: true })
    }
    return row
  }
  async function focusCall(callId: string): Promise<void> {
    const mine = ++callFocusSequence
    clearSearch()
    await pollOnce()
    if (mine !== callFocusSequence) return
    let pollBefore = pollSequence
    let match = await ensureTarget((e) => e.id === callId)
    if (mine !== callFocusSequence || pollBefore !== pollSequence) return
    if (!match && org()) {
      ctx.scope.set('', false)
      await pollOnce()
      if (mine !== callFocusSequence) return
      pollBefore = pollSequence
      match = await ensureTarget((e) => e.id === callId)
      if (mine !== callFocusSequence || pollBefore !== pollSequence) return
    }
    focusMessage = match ? '' : `No run found for call ${callId.slice(0, 12)}…`
    paintFocus()
    if (match) showRun(match)
  }
  async function focusTarget(repo: string, number: string): Promise<void> {
    const mine = ++callFocusSequence
    clearSearch()
    const ownerOf = repo.split('/')[0].toLowerCase()
    if (org() && org().toLowerCase() !== ownerOf) ctx.scope.set('', false)
    await pollOnce()
    if (mine !== callFocusSequence) return
    const pollBefore = pollSequence
    const match = await ensureTarget((e) => (e.repo || '').toLowerCase() === repo.toLowerCase() && String(e.pr_id) === number, true)
    if (mine !== callFocusSequence || pollBefore !== pollSequence) return
    focusMessage = match ? '' : `No run found for ${repo}#${number}.`
    paintFocus()
    if (match) showRun(match)
  }

  // ---------- Time counts up in place; running runs are read every 15 seconds ----------
  function tick(): void {
    if (!ctx.visible()) return
    const byId = new Map(entries.map((e) => [e.id, e]))
    const now = Date.now()
    for (const tr of body.querySelectorAll<HTMLElement>('tr[data-run]')) {
      const e = byId.get(tr.dataset.run ?? '')
      if (!e) continue
      const started = tr.querySelector<HTMLElement>('[data-started]')
      const nextStarted = relFromMs(startedAtMs(e), now)
      if (started && started.textContent !== nextStarted) started.textContent = nextStarted
      const elapsed = tr.querySelector<HTMLElement>('[data-elapsed]')
      const nextElapsed = elapsedText(e, now)
      if (elapsed && elapsed.textContent !== nextElapsed) elapsed.textContent = nextElapsed
      if (isRunning(e) && !stopsInFlight.has(e.id) && !stopping.has(e.id)) {
        const progress = tr.querySelector<HTMLElement>('[data-progress]')
        const s = statusOf(e, now)
        if (progress && progress.textContent !== s.note) { progress.textContent = s.note; progress.dataset.help = s.note; progress.classList.toggle('is-warn', s.warn) }
        const est = tr.querySelector<HTMLElement>('[data-est]')
        const x = estimateText(e, estimates.get(e.id), now)
        if (est && x && est.textContent !== x.text) { est.textContent = x.text; est.classList.toggle('is-warn', x.warn) }
      }
    }
  }
  ctx.every(5_000, tick)
  ctx.every(15_000, () => { if (ctx.visible() && entries.some(isRunning)) void pollOnce() })
  addEventListener('poise:refresh-tick', () => { if (ctx.visible()) void pollOnce() }, { signal: ctx.signal })

  // The address may name a run: by its call, or by its pull request or issue.
  const call = ctx.query.get('call')
  const target = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ctx.query.get('pr') ?? '')
  let opened = false
  // A return paints the last first page at once; the first poll then refreshes it in place.
  if (lastFirst && lastFirst.scope === org() && lastFirst.search === searchQuery) applyFirstPage(lastFirst.data, () => true)

  return {
    show() {
      render()
      paintStale()
      paintFocus()
      if (!opened) {
        opened = true
        stale = false
        if (call && /^[a-f0-9]{32}$/i.test(call)) void focusCall(call)
        else if (target) void focusTarget(target[1], target[2])
        else {
          if (call || ctx.query.get('pr')) { focusMessage = 'The run link is invalid; the newest runs are shown.'; paintFocus() }
          void pollOnce(true)
        }
        return
      }
      if (stale || Date.now() - lastLoadedAt > 15_000) { stale = false; void pollOnce() }
    },
    hide() { armedStop = null },
    leave() { clearTimeout(searchDebounce); unsubscribe() },
    busy: () => stopsInFlight.size > 0 || replaysInFlight.size > 0,
  }
}
