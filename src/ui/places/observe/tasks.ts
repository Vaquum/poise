// Observe → Tasks: the behavior chain's evidence (#556, #728, #955), which
// main shows at the foot of Logging (src/views/behavior-chain-logging.ts).
// Its reads, cursors, control and journal follow that view: a refresh never
// drops pages read with More, only the newest read writes, Hold and Resume
// send the sequence they read and refresh after, and a failed read keeps what
// was read and stops both until a read succeeds. What is new is the task:
// its phase rail, its state in the seven words, Needs attention from the
// attention projection, its evidence, and a timeline read newest first.
import { $, esc } from '../../dom'
import { placeHref } from '../../address'
import { term } from '../../registry'
import {
  KIND_WORDS, LEGACY_PULL, PHASES, REPOSITORY, age, attentionOrder, eventWords, failureWords, isActive,
  phaseOf, readChain, readChainsPage, readJournalPage, reasonWords, stepEvent, taskState, timelineLines,
  type AttentionRow, type ChainInvocation, type ChainRow, type ChainsPage,
} from './chains'
import { readFrom, readLater, readNewest, readOlder, type JournalWindow, type ReadPage } from './journal'
import { patchContent } from '../../../dom-patch'
import { aborted, capsule, clockTime, exactTime, external, github, message, onBoard, partHref, postJson, readJson } from './util'
import type { ObservePart, PartContext } from './part'

type Which = 'active' | 'attention' | 'merged' | 'all'
const WHICH: Which[] = ['active', 'attention', 'merged', 'all']
const LAST = Number.MAX_SAFE_INTEGER

export function railHTML(chain: ChainRow): string {
  const { index, word } = phaseOf(chain)
  const { state } = taskState(chain)
  return `<span class="rail" data-ref="task.rail" role="img" aria-label="${esc(`Phase: ${word}`)}">${PHASES.map((phase, i) =>
    `<i class="${i < index ? 'p' : i === index ? 'c' : ''}"${i === index ? ` data-state="${state}"` : ''} data-help="${esc(phase)}"></i>`).join('')}</span><span class="rail-w">${esc(word)}</span>`
}

const identity = (repository: string, issue: number, pull: number | null): string => `${repository}#${issue}${pull ? ` → #${pull}` : ''}`

/** Tasks' last read with its choice of list, kept across visits: a return paints it at once, then reads again. */
let lastRead: { which: string, chains: ChainRow[], next: string | null, meta: ChainsPage | null, attention: AttentionRow[], activeCount: number | null, activeMore: boolean, readAt: number } | null = null

export function createTasks(ctx: PartContext): ObservePart {
  const { root, query, back } = ctx
  root.innerHTML = `<div class="obv-bar">
      <input class="search" type="search" placeholder="Filter…" aria-label="Filter tasks" data-tk-search data-ref="tk.search">
      <div class="seg" role="group" aria-label="Which tasks" data-tk-which data-ref="tk.which"><button type="button" aria-pressed="true" data-v="active">Active</button><button type="button" aria-pressed="false" data-v="attention" data-ref="tk.attention">Needs attention</button><button type="button" aria-pressed="false" data-v="merged">Merged</button><button type="button" aria-pressed="false" data-v="all">All</button></div>
      <span class="obv-count" data-tk-count></span>
      <div class="obv-note tk-note" data-tk-note data-ref="tk.note"></div>
    </div>
    <div class="tk-split">
      <div class="obv-scroll" data-tk-scroll><ul class="tk-list" data-tk-list></ul><p class="tk-more" data-tk-more hidden><button type="button" class="btn-ghost" data-act="tk-more" data-ref="tk.more">More tasks</button></p></div>
      <div class="tk-detail" data-tk-detail><div data-tk-head></div><div data-tk-tl></div></div>
    </div>`

  const askedWhich = query.get('which')
  let which: Which = WHICH.includes(askedWhich as Which) ? askedWhich as Which : 'active'
  let search = ''
  let chains: ChainRow[] = []
  let next: string | null = null
  let meta: ChainsPage | null = null
  let attention: AttentionRow[] = []
  let readAt = 0
  let failure = ''
  let loading = false
  let generation = 0
  let stale = true
  let activeCount: number | null = null
  let activeMore = false
  // Summaries read one by one: a linked task, or attention beyond the pages read.
  const extra = new Map<string, ChainRow>()

  const asked = query.get('chain')
  const askedAfter = query.get('after')
  let open: string | null = asked
  let step: number | null = asked && askedAfter !== null && Number.isSafeInteger(Number(askedAfter)) && Number(askedAfter) >= 0 ? Number(askedAfter) : null
  let linked = !!asked
  let timeline: JournalWindow | null = null
  let windowError = ''
  let windowReading = false
  let timelineGeneration = 0
  let journalReadAt = 0
  let acting: string | null = null
  let note: { id: string, text: string, tone: 'done' | 'failed' } | null = null

  const byId = (id: string | null): ChainRow | undefined => (id ? chains.find((c) => c.id === id) ?? extra.get(id) : undefined)
  const attentionFor = (id: string): AttentionRow | undefined => attention.find((a) => a.id === id)
  const owner = (repository: string): string => repository.split('/')[0].toLowerCase()
  const inScope = (repository: string): boolean => !ctx.scope.org() || owner(repository) === ctx.scope.org().toLowerCase()

  // ---------- Reading the chain, as classic's chain list does ----------
  const listUrl = (cursor: string | null): string => {
    const params = new URLSearchParams()
    if (which === 'merged') params.set('state', 'merged')
    else if (which !== 'all') params.set('state', 'active')
    if (cursor) params.set('after', cursor)
    return `/api/behavior-chains${params.toString() ? `?${params}` : ''}`
  }
  const advance = (cursor: string | null, after: string | null): void => {
    if (cursor !== null && (after !== null && cursor <= after)) throw new Error('The chain cursor did not advance.')
  }

  async function read(more = false, tick = false): Promise<void> {
    // A tick never supersedes a read in flight; a person's choice does, and only the newest read writes.
    if (tick && loading) return
    const mine = ++generation
    loading = true
    paintNote()
    try {
      if (more && next) {
        const page = readChainsPage(await readJson(listUrl(next), ctx.signal))
        if (mine !== generation) return
        advance(page.next, next)
        chains = [...chains, ...page.chains]
        next = page.next
      } else {
        // A refresh must not drop pages read with More: read on until the fresh list covers what was shown.
        const shown = chains.length
        const first = readChainsPage(await readJson(listUrl(null), ctx.signal))
        if (mine !== generation) return
        let rows = first.chains
        let cursor = first.next
        while (rows.length < shown && cursor) {
          const page = readChainsPage(await readJson(listUrl(cursor), ctx.signal))
          if (mine !== generation) return
          advance(page.next, cursor)
          cursor = page.next
          rows = [...rows, ...page.chains]
          if (!page.chains.length) break
        }
        chains = rows
        next = cursor
        meta = first
        attention = attentionOrder(first.attention ?? [])
        if (which !== 'merged') {
          activeCount = chains.filter(isActive).length
          activeMore = which !== 'all' && !!next
        }
      }
      for (const chain of chains) extra.delete(chain.id)
      readAt = Date.now()
      failure = ''
      stale = false
      lastRead = { which, chains, next, meta, attention, activeCount, activeMore, readAt }
      await readMissing(mine)
    } catch (error) {
      if (aborted(error) || mine !== generation) return
      failure = message(error)
    } finally {
      if (mine === generation) {
        loading = false
        paint()
      }
    }
  }

  /** Attention beyond the pages read, and a linked task outside them, read one by one. */
  async function readMissing(mine: number): Promise<void> {
    const ids = new Set(which === 'attention' ? attention.filter((a) => !chains.some((c) => c.id === a.id)).map((a) => a.id) : [])
    if (open && !chains.some((c) => c.id === open)) ids.add(open)
    await Promise.all([...ids].map(async (id) => {
      try {
        const data = readJournalPage(await readJson(`/api/behavior-chains?${new URLSearchParams({ id, after: String(LAST) })}`, ctx.signal))
        if (mine === generation && data.chain) extra.set(id, data.chain)
      } catch (error) {
        if (aborted(error)) return
        if (id === open) windowError = `The task could not be read: ${message(error)}`
      }
    }))
    if (mine === generation) clearLinkedFilters()
  }

  /** A link clears a filter that hides what it names, for this visit only. */
  function clearLinkedFilters(): void {
    if (!linked || !open) return
    const chain = byId(open)
    if (!chain) return
    linked = false
    let reread = false
    if (!inScope(chain.repository)) ctx.scope.set('', false)
    if (search) { search = ''; $('[data-tk-search]', root).value = '' }
    const shows = which === 'all' || (which === 'merged' ? !!chain.mergeSha : which === 'attention' ? !!attentionFor(chain.id) : isActive(chain))
    if (!shows) { which = 'all'; reread = true }
    if (reread) void read()
  }

  // ---------- The list ----------
  function rows(): Array<{ chain: ChainRow | null, attention: AttentionRow | null }> {
    if (which === 'attention') return attention.map((a) => ({ chain: byId(a.id) ?? null, attention: a }))
    return chains.map((chain) => ({ chain, attention: attentionFor(chain.id) ?? null }))
  }
  function matches(row: { chain: ChainRow | null, attention: AttentionRow | null }): boolean {
    const repository = row.chain?.repository ?? row.attention!.repository
    if (!inScope(repository)) return false
    if (!search) return true
    const q = search.toLowerCase()
    const c = row.chain
    const words = c ? `${identity(c.repository, c.issue, c.pullNumber)} ${taskState(c).reason} ${phaseOf(c).word}` : `${identity(row.attention!.repository, row.attention!.issue, row.attention!.pullNumber)} ${row.attention!.step} ${row.attention!.blocker}`
    return words.toLowerCase().includes(q) || words.replace(/ → /g, ' ').toLowerCase().includes(q)
  }
  function rowHTML(row: { chain: ChainRow | null, attention: AttentionRow | null }): string {
    const a = row.attention
    const c = row.chain
    const id = c?.id ?? a!.id
    const ageNote = a ? ` <span class="tk-age" data-ref="tk.age">· no verified advance for ${esc(age(Date.now() - a.progressAt))}</span>` : ''
    if (!c) {
      return `<li><button type="button" class="tk-row${open === id ? ' is-open' : ''}" data-act="tk-open" data-id="${esc(id)}" aria-expanded="${open === id}" data-ref="tk.row"><span class="tk-t"><span class="tk-id">${esc(identity(a!.repository, a!.issue, a!.pullNumber))}</span></span><span class="tk-r"></span><span class="tk-s"><span class="note">${esc(a!.step)}</span>${ageNote}</span></button></li>`
    }
    const { state, reason } = taskState(c)
    return `<li><button type="button" class="tk-row${open === id ? ' is-open' : ''}" data-act="tk-open" data-id="${esc(id)}" aria-expanded="${open === id}" data-ref="tk.row"><span class="tk-t"><span class="tk-id">${esc(identity(c.repository, c.issue, c.pullNumber))}</span></span><span class="tk-r">${railHTML(c)}</span><span class="tk-s">${capsule(state)}<b>${esc(term(`state.${state}`))}</b><span class="tk-why">${esc(reason)}</span>${ageNote}</span></button></li>`
  }

  function paintList(): void {
    const all = rows()
    const shown = all.filter(matches)
    const list = $('[data-tk-list]', root)
    const empty = meta?.cutover?.mode === 'v1' && !chains.length ? 'No task: the chain is off.'
      : !readAt ? (failure ? 'Tasks could not be read.' : 'Reading the chain…')
        : which === 'attention' ? 'Nothing needs attention.' : search || ctx.scope.org() ? 'No task matches.' : 'No tasks.'
    patchContent(list, shown.map(rowHTML).join('') || `<li class="t-gloss tk-empty">${empty}</li>`)
    const total = which === 'attention' ? attention.filter((a) => inScope(a.repository)).length : all.filter((r) => inScope((r.chain ?? r.attention!).repository)).length
    $('[data-tk-count]', root).textContent = readAt ? `${shown.length} of ${total}${which !== 'attention' && next ? '+' : ''} tasks` : ''
    $('[data-tk-more]', root).hidden = which === 'attention' || !next
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-tk-which] button')) button.setAttribute('aria-pressed', String(button.dataset.v === which))
    const needs = attention.filter((a) => inScope(a.repository)).length
    $('[data-tk-which] [data-v="attention"]', root).textContent = needs ? `Needs attention ${needs}` : 'Needs attention'
    ctx.count(activeCount ? `${activeCount}${activeMore ? '+' : ''}` : '')
  }

  // ---------- The state line ----------
  function paintNote(): void {
    const box = $('[data-tk-note]', root)
    if (failure) {
      patchContent(box, `<span class="tk-st is-warn" role="status" data-ref="tk.status">Tasks could not be refreshed: ${esc(failure)}. ${readAt ? `Showing what was read at ${esc(clockTime(readAt))}; Hold and Resume wait until a read succeeds.` : 'Nothing has been read yet.'}</span>`)
      return
    }
    if (!meta) { patchContent(box, `<span class="tk-st" role="status" data-ref="tk.status">${loading ? '<span class="spin"></span> Reading the chain…' : ''}</span>`); return }
    const { cutover, capacity, runtime } = meta
    const legacy = cutover?.legacyPulls ?? []
    const legacyHTML = legacy.length ? `<details class="tk-legacy" data-ref="tk.legacy"><summary>${legacy.length} pull ${legacy.length === 1 ? 'request' : 'requests'} kept by v1 at cutover</summary><p class="t-gloss">v1 keeps reviewing these until they close. They are not tasks.</p><ul>${legacy.map((target) => {
      const m = LEGACY_PULL.exec(target)
      return `<li class="t-mono">${m ? external(github(m[1], 'pull', m[2]), esc(target), 'lnk') : esc(target)}</li>`
    }).join('')}</ul></details>` : ''
    if (cutover?.mode === 'v1') {
      patchContent(box, `<span class="tk-st" role="status" data-ref="tk.status"><b>The chain is off.</b> v1 owns new work, so behaviors act one at a time and no task is carried from issue to merge.</span><a class="btn-ghost" href="${placeHref('settings', { settings: 'behaviors', back: 'observe' })}" data-ref="tk.engine">Behavior engine, in Settings</a>${legacyHTML}`)
      return
    }
    const owns = !cutover ? 'Who owns new work could not be read' : cutover.mode === 'draining'
      ? `Draining: v1 finishes its runs before v2 takes new work${cutover.blockers?.length ? ` (${cutover.blockers.join('; ')})` : ''}`
      : 'v2 owns new work'
    const runs = capacity?.status === 'available' && capacity.reservedModelInvocations !== null && capacity.modelInvocationLimit !== null
      ? `${capacity.reservedModelInvocations} of ${capacity.modelInvocationLimit} model slots occupied across the workspace, shared with other heavy work${capacity.enabled === false ? ' · admissions paused' : ''}`
      : `model capacity unavailable${capacity?.error ? `: ${capacity.error}` : ''}`
    const retained = capacity?.status === 'available' && capacity.retainedModelInvocations !== null
      ? `${capacity.retainedModelInvocations} retained for unresolved cleanup, awaiting original resource evidence`
      : 'retained cleanup count unknown'
    const errors = runtime.filter((r) => r.error).map((r) => `${r.organization}: ${r.error}`)
    patchContent(box, `<span class="tk-st" role="status" data-ref="tk.status">${esc(owns)} · ${esc(runs)} · ${esc(retained)} · read ${esc(clockTime(readAt))}${loading ? ' <span class="spin"></span>' : ''}</span>${errors.length ? `<span class="tk-st is-warn" role="status">${esc(errors.join('; '))}</span>` : ''}${legacyHTML}`)
  }

  // ---------- The task: its state, evidence and controls ----------
  function evidenceHTML(chain: ChainRow): string {
    const a = attentionFor(chain.id)
    const rows: Array<[string, string]> = []
    const now = Date.now()
    if (a) {
      rows.push(['Last verified advance', `${esc(age(now - a.progressAt))} ago · ${esc(clockTime(a.progressAt))} · it needs attention`])
      if (a.blocker && a.blocker !== chain.held) rows.push(['What holds it', esc(a.blocker)])
      if (a.evidence.gates.length) rows.push(['Evidence on its head', `${esc(a.evidence.gates.join(' · '))}${a.evidence.state !== 'fresh' ? ` <span class="note is-warn">${esc(a.evidence.state)} evidence${a.evidence.checkedAt ? `, read ${esc(clockTime(a.evidence.checkedAt))}` : ''}</span>` : ''}`])
      if (a.nextAction) rows.push(['Next', `${esc(a.nextAction)}${a.retryAt ? ` · ${esc(clockTime(a.retryAt))}` : ''}`])
    }
    const recheck = a?.reconciliation.nextObservationAt ?? chain.reconciliation?.nextObservationAt ?? null
    const warning = chain.mergedReviewWarning
    if (warning) {
      rows.push(['Native review clearance', `Unmet at merge on head ${esc(warning.head)}. Original review responses are complete; no qualifying favorable native response preceded the merge.`])
      for (const review of warning.reviews) rows.push(['Retained native review', `${external(review.url, 'Changes requested', 'lnk')}: ${esc(review.verdict)}`])
      const approval = warning.githubApproval
      if (approval) rows.push(['Later GitHub approval', `${external(approval.url, `Review #${approval.id}`, 'lnk')} · head ${esc(approval.head)} · submitted ${esc(new Date(approval.submittedAt).toISOString())} · submitting client unknown`])
    }
    if (recheck && recheck > now) rows.push(['Evidence recheck', `${esc(clockTime(recheck))}. A recheck never retries held work.`])
    if (chain.reconciliation?.waitingForOriginalResponse) rows.push(['Original response', 'Required: GitHub reads cannot settle this step.'])
    if (chain.reconciliation?.waitingForResourceRelease || a?.reconciliation.waitingForResourceRelease) rows.push(['Resources', 'Their release is unverified; reconciliation goes on and its memory and disk stay reserved.'])
    if (chain.supersession && REPOSITORY.test(chain.repository)) {
      const s = chain.supersession
      rows.push(['Covered by', [
        ...s.covering.map((p) => `${external(github(chain.repository, 'pull', p.number), `#${p.number}`, 'lnk')}, merged as ${esc(p.mergeSha.slice(0, 7))}`),
        ...s.failures.map((f) => external(github(chain.repository, 'actions/runs', f.id), 'the failing run', 'lnk')),
        ...(s.recovery ? [external(github(chain.repository, 'actions/runs', s.recovery.id), 'the recovery run', 'lnk')] : []),
      ].join(' · ')])
    }
    return rows.length ? `<dl class="tk-ev" data-ref="tk.evidence">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>` : ''
  }

  function controlHTML(chain: ChainRow): string {
    if (chain.supersession) return '<span class="t-gloss" data-ref="tk.history">Superseded: only its history remains.</span>'
    if (chain.mergeSha) return chain.reviewPending
      ? '<span class="t-gloss" data-ref="tk.history">Merged: the chain reconciles its original review evidence; nothing new can start after a merge.</span>'
      : '<span class="t-gloss" data-ref="tk.history">Merged: only its history remains; there is nothing to hold or resume.</span>'
    const held = !!chain.held
    const ref = held ? 'task.resume' : 'task.hold'
    const word = held ? 'Resume' : 'Hold new invocations'
    if (failure) return `<button type="button" class="btn-ghost" aria-disabled="true" data-help="Tasks could not be read, so nothing can be held or resumed until they are." data-ref="${ref}">${word}</button>`
    if (!meta?.cutover) return `<button type="button" class="btn-ghost" aria-disabled="true" data-help="Who owns new work has not been read yet; its controls wait for that read." data-ref="${ref}">${word}</button>`
    if (acting === chain.id) return `<button type="button" class="btn-ghost" aria-disabled="true" data-ref="${ref}"><span class="spin"></span>${held ? 'Resuming…' : 'Holding…'}</button>`
    return `<button type="button" class="btn-ghost${held ? ' is-primary' : ''}" data-act="${held ? 'tk-resume' : 'tk-hold'}" data-id="${esc(chain.id)}" data-ref="${ref}">${word}</button>`
  }

  function paintHead(): void {
    const head = $('[data-tk-head]', root)
    const chain = byId(open)
    if (!open) { patchContent(head, '<p class="t-gloss tk-empty">Choose a task to read its evidence and timeline.</p>'); return }
    if (!chain) { patchContent(head, `<p class="t-gloss tk-empty">${windowError ? esc(windowError) : `Reading ${esc(open)}…`}</p>`); return }
    const { state, reason } = taskState(chain)
    const links = REPOSITORY.test(chain.repository)
      ? `${external(github(chain.repository, 'issues', chain.issue), `#${chain.issue}`, 'lnk')}${chain.pullNumber ? ` → ${external(github(chain.repository, 'pull', chain.pullNumber), `#${chain.pullNumber}`, 'lnk')}` : ''}`
      : esc(chain.id)
    const card = `${chain.repository}#${chain.pullNumber ?? chain.issue}`
    patchContent(head, `<div class="tk-d-h"><h3>${esc(identity(chain.repository, chain.issue, chain.pullNumber))}</h3><p class="t-gloss">${links} · driven by the behaviors</p></div>
      <div class="tk-d-rail">${railHTML(chain)}</div>
      <p class="tk-d-s"><span class="st" data-state="${state}" data-ref="state">${esc(term(`state.${state}`))}</span> ${esc(reason)}</p>
      ${chain.held ? `<p class="tk-hold" data-ref="side.hold">${esc(reasonWords(chain.held))}. The chain waits for your decision; Resume ends the hold.</p>` : ''}
      ${evidenceHTML(chain)}
      <div class="tk-acts">${controlHTML(chain)}${/^[\w.-]+\/[\w.-]+$/.test(chain.repository) ? `<a class="lnk" href="${esc(onBoard(card))}" data-ref="tk.board">See it on Board</a>` : ''}</div>
      ${note && note.id === chain.id ? `<p class="tk-act-note${note.tone === 'failed' ? ' is-failed' : ''}" role="status">${esc(note.text)}</p>` : ''}`)
  }

  // ---------- The timeline: the journal, newest first, held still while you read it ----------
  const readPage: ReadPage = async (after) => {
    const id = open
    if (!id) return { events: [], next: null }
    const data = readJournalPage(await readJson(`/api/behavior-chains?${new URLSearchParams({ id, after: String(after) })}`, ctx.signal))
    if (data.chain && id === open) remember(data.chain)
    return { events: data.events, next: data.next }
  }
  /** A summary read with the journal is newer than the list's. */
  function remember(chain: ChainRow): void {
    const at = chains.findIndex((c) => c.id === chain.id)
    if (at >= 0) chains[at] = chain
    else extra.set(chain.id, chain)
  }

  function paintTimeline(): void {
    const box = $('[data-tk-tl]', root)
    const chain = byId(open)
    if (!open || !chain && !windowError) { patchContent(box, ''); return }
    const invocations = new Map<string, ChainInvocation>((chain?.invocations ?? []).map((i) => [i.id, i]))
    const events = timeline?.events ?? []
    const from = stepEvent(events, step)
    const newer = !!timeline && (!timeline.complete || (!!chain && chain.sequence > timeline.hi))
    const lines = timelineLines(events, from).map(({ event, folded, oldest }) => {
      const { kind, text, call } = eventWords(event, invocations)
      const failureText = failureWords(event)
      const isFrom = event.sequence === from
      const observed = event.type === 'chain.observed'
      return `<li data-kind="${kind}"${isFrom ? ' class="is-from" data-ref="tk.from"' : observed ? ' data-ref="tk.observed"' : ''}><span class="t-mono" data-help="${esc(exactTime(event.at))}">${esc(clockTime(event.at))}</span><span><b>${KIND_WORDS[kind]}</b> ${esc(text)}${folded > 1 ? ` <span class="t-gloss">×${folded} since ${esc(clockTime(oldest ?? event.at))}</span>` : ''}${call ? ` · <a class="lnk" href="${esc(partHref('behaviors', { call }, back))}" data-ref="tk.run">run ${esc(call.slice(0, 8))}</a>` : ''}${failureText ? `<span class="t-gloss"> · ${esc(failureText)}</span>` : ''}</span></li>`
    }).join('')
    const status = windowReading ? '<span class="spin"></span> Reading the journal…' : windowError ? `<span class="note is-warn">${esc(windowError)}</span> <button type="button" class="lnk" data-act="tk-journal">Read it again</button>` : ''
    patchContent(box, `<p class="t-micro tk-tl-h">Timeline · newest first <span class="t-gloss">· ${journalReadAt ? `read ${esc(clockTime(journalReadAt))} · ` : ''}held still while you read it</span></p>
      ${newer ? '<button type="button" class="btn-ghost tk-later" data-act="tk-later" data-ref="tk.later">Later events</button>' : ''}
      ${status ? `<p class="tk-tl-status" role="status">${status}</p>` : ''}
      ${timeline ? `<ol class="tk-tl" data-ref="side.timeline">${lines || '<li class="t-gloss tk-tl-empty">No journal events.</li>'}</ol>` : ''}
      ${timeline && !timeline.start ? '<button type="button" class="btn-ghost" data-act="tk-earlier" data-ref="tk.earlier">More events</button>' : ''}`)
  }

  async function readJournal(how: 'open' | 'later' | 'earlier'): Promise<void> {
    const id = open
    if (!id) return
    const mine = ++timelineGeneration
    windowReading = true
    windowError = ''
    paintTimeline()
    try {
      let next: JournalWindow
      if (how === 'later' && timeline) next = await readLater(readPage, timeline)
      else if (how === 'earlier' && timeline) next = await readOlder(readPage, timeline)
      else if (step !== null) next = await readFrom(readPage, step)
      else {
        let chain = byId(id)
        if (!chain) {
          await readPage(LAST)
          chain = byId(id)
        }
        if (!chain) throw new Error('The task was not found.')
        next = await readNewest(readPage, chain.sequence)
      }
      if (mine !== timelineGeneration || id !== open) return
      timeline = next
      journalReadAt = Date.now()
    } catch (error) {
      if (aborted(error) || mine !== timelineGeneration) return
      windowError = `The journal could not be read: ${message(error)}`
    } finally {
      if (mine === timelineGeneration) {
        windowReading = false
        paintHead()
        paintTimeline()
        clearLinkedFilters()
        paintList()
        if (how === 'open' && step !== null) $('.tk-tl .is-from', root)?.scrollIntoView({ block: 'center' })
      }
    }
  }

  function openTask(id: string | null): void {
    // Another task starts at its top; on a narrow window it comes into view under the list.
    const detail = $('[data-tk-detail]', root)
    detail.scrollTop = 0
    if (id && matchMedia('(max-width: 760px)').matches) requestAnimationFrame(() => detail.scrollIntoView({ block: 'start' }))
    open = id
    step = null
    timeline = null
    windowError = ''
    note = null
    const url = new URL(location.href)
    url.searchParams.delete('after')
    if (id) url.searchParams.set('chain', id); else url.searchParams.delete('chain')
    history.replaceState(history.state, '', url)
    paintList()
    paintHead()
    paintTimeline()
    if (id) void readJournal('open')
  }

  async function control(id: string, operation: 'hold' | 'resume'): Promise<void> {
    const chain = byId(id)
    if (!chain || acting || failure) return
    acting = id
    note = null
    paintHead()
    try {
      const data = await postJson('/api/behavior-chains', { id, sequence: chain.sequence, operation }, ctx.signal) as { chain?: unknown }
      if (data.chain) remember(readChain(data.chain))
      note = { id, tone: 'done', text: operation === 'hold'
        ? 'Held. No new step starts; a run already going carries on, and Stop in Behaviors ends it.'
        : 'Resumed. Its next step starts when it is due; the journal records it.' }
    } catch (error) {
      if (aborted(error)) return
      note = { id, tone: 'failed', text: `Not applied: ${message(error)}` }
    } finally {
      acting = null
      paintHead()
      paintList()
      void read()
      if (open === id && timeline?.complete) void readJournal('later')
    }
  }

  function paint(): void {
    paintNote()
    paintList()
    paintHead()
    paintTimeline()
  }

  // ---------- Events ----------
  root.addEventListener('click', (e: Event) => {
    const target = e.target as Element
    const seg = target.closest<HTMLButtonElement>('[data-tk-which] button')
    if (seg && seg.dataset.v !== which) {
      which = seg.dataset.v as Which
      chains = []
      next = null
      paintList()
      void read()
      return
    }
    const button = target.closest<HTMLElement>('[data-act]')
    if (!button || button.getAttribute('aria-disabled') === 'true') return
    const id = button.dataset.id ?? ''
    switch (button.dataset.act) {
      case 'tk-open': openTask(open === id ? null : id); $(`[data-act="tk-open"][data-id="${CSS.escape(id)}"]`, root)?.focus({ preventScroll: true }); break
      case 'tk-more': void read(true); break
      case 'tk-hold': void control(id, 'hold'); break
      case 'tk-resume': void control(id, 'resume'); break
      case 'tk-later': void readJournal('later'); break
      case 'tk-earlier': void readJournal('earlier'); break
      case 'tk-journal': void readJournal(timeline ? 'later' : 'open'); break
    }
  })
  let debounce = 0
  $('[data-tk-search]', root).addEventListener('input', (e: Event) => {
    clearTimeout(debounce)
    debounce = window.setTimeout(() => { search = (e.target as HTMLInputElement).value.trim(); paintList() }, 120)
  })
  addEventListener('poise:refresh-tick', () => { if (ctx.visible()) void read(false, true) }, { signal: ctx.signal })
  ctx.scope.onChange(() => paintList())

  if (lastRead?.which === which) ({ chains, next, meta, attention, activeCount, activeMore, readAt } = lastRead)
  paint()
  if (open) void readJournal('open')
  return {
    show() { if (stale || Date.now() - readAt > 30_000) void read(); else paint() },
    hide() { /* The list holds what it read; the next showing reads again if it has aged. */ },
    leave() { clearTimeout(debounce) },
    busy: () => acting !== null,
  }
}
