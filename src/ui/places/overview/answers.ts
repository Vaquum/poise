// Answer here (#556, Overview): everything that wants you, with the answers
// on each entry, grouped by who acts and shown to the level you chose. It
// reads its four sources, answers through the service and shows only what the
// service confirms; while your pointer or focus is in it, arrivals wait,
// counted, and nothing moves. Classic's rail (src/views/notification-rail.ts)
// is where the joins and the reads it shares come from.
import type { DiagnosticEvidence } from '../../../../gateway/src/diagnostics/evidence-contract'
import { getBehaviorDiagnostics } from '../../../behaviors'
import { chatClient, ChatCommandError } from '../../../chat-client'
import { midnightInZone } from '../../../config'
import { patchContent } from '../../../dom-patch'
import { loggingAccess, loggingEvent, loggingWorkImpacts } from '../../../logging'
import { LOCAL_NOTICE_KINDS, noticeFeed, type Notice, type NoticesState } from '../../../notices'
import { notificationItems, type ChainAttentionRow } from '../../../notification-items'
import { registerReloadGuard } from '../../../self-update-guards'
import { placeHref } from '../../address'
import { $, $$, esc } from '../../dom'
import { paintTerms } from '../../reference'
import { term } from '../../registry'
import { lifeHTML, toast, type Stage } from '../../shell'
import {
  decisionEntries, foldWaiting, itemEntries, openDecision, ordered, requestEntries, requestsFrom, threadEntries,
  type DecisionItem, type Entry, type Publication, type RequestsRead, type Role, type ThreadReview,
} from './entries'
import { answersChanged, GROUPS, LEVELS, readLevel, saveLevel, setAnswerGroups, shownAt, tally } from './level'
import { ago, clockAt, json, readLine, reason, reportRead, ServiceError, slug, uid, unread, whileVisible, type Read, type PartContext } from './util'

/** How long Dismiss and Silence wait in the tab, which is their Undo. */
export const HOLD_MS = 8000
const QUESTION_DRAFTS = 'poise-chat-question-drafts'

interface Progress {
  stage: Stage | 'Failed'
  words: string
  label: string
  at: number
  /** The service could not say whether it acted: repeat only once a read shows it still open. */
  uncertain?: boolean
  /** Settled: the entry stays where it is until you look away. */
  settled?: boolean
  /** A held send that can still be taken back. */
  undo?: boolean
}

interface HandledRow { title: string, note: string, at: number, undo?: string }
interface ServerHandled { id: number, title: string, outcome: string, actor: string, at: string }

const ACTORS: Record<string, string> = { person: 'by you', api: 'through the API', poise: 'by Poise', 'notices-service': 'by Poise', behaviors: 'by Behaviors', caller: 'by Caller', recovery: 'by recovery' }

export interface Answers {
  /** The chain's journal, read by the place for Answer here and In motion. */
  setChains(chains: ReadonlyMap<string, { sequence: number, held: string | null }>, attention: ChainAttentionRow[]): void
  /** Behaviors' diagnostics were read again. */
  diagnosticsChanged(): void
  /** Open entries, for the Behaviors table's chips. */
  entries(): readonly Entry[]
  leave(): void
}

export function mountAnswers(ctx: PartContext, root: HTMLElement, options: { role: Role, onEntries: (entries: readonly Entry[]) => void, chainsChanged: () => void }): Answers {
  const list: HTMLElement = $('[data-nlist]', root)
  const { signal } = ctx
  let feed: NoticesState = noticeFeed.current
  let attention: ChainAttentionRow[] = []
  let chains: ReadonlyMap<string, { sequence: number, held: string | null }> = new Map()
  const requests: Read<RequestsRead> & { frame: number, asked: number, shown: number } = { ...unread<RequestsRead>(), frame: 0, asked: 0, shown: 0 }
  const board: Read<DecisionItem[]> & { revision: number } = { ...unread<DecisionItem[]>(), revision: -1 }
  const reviews: Read<Publication[]> = unread()
  const threads = new Map<string, { reviews: ThreadReview[], openThreads: number, error: string }>()
  const handled: Read<ServerHandled[]> = unread()

  let level = readLevel()
  let current: Entry[] = []
  let shown: Entry[] = []
  /** Ids on screen while you are in the list; null while not holding. */
  let holding: string[] | null = null
  let inside = false
  let settleTimer = 0
  const lastSeen = new Map<string, Entry>()
  const progress = new Map<string, Progress>()
  /** Settled here, kept off the open list while its source still lists it. */
  const done = new Map<string, HandledRow>()
  const settledHere: HandledRow[] = []
  const holds = new Map<string, { kind: 'dismiss' | 'silence', notice?: Notice, decision?: number, timer: number }>()
  const opened = new Set<string>()
  const replying = new Set<string>()
  const fresh = new Set<string>()
  const known = new Set<string>()
  const actionIds = new Map<string, string>()
  const impacts = new Map<string, { text: string, at: number }>()
  let autoOpen = false
  let handledOpen = false
  let inFlight = 0

  // ---------- Entries ----------
  function compute(): Entry[] {
    const notices = feed.notices.filter((notice) => feed.enabled || (LOCAL_NOTICE_KINDS as readonly string[]).includes(notice.kind))
    const items = notificationItems(notices, getBehaviorDiagnostics(), Date.now(), attention)
    const reviewed = (reviews.data ?? []).flatMap((publication) => threadEntries(publication, threads.get(publication.slug)?.reviews ?? [], editorHref))
    return ordered(foldWaiting([
      ...itemEntries(items, options.role, chains),
      ...requestEntries(requests.data?.requests ?? [], options.role),
      ...decisionEntries(board.data ?? [], options.role),
      ...reviewed,
    ]))
  }
  const editorHref = (slugName: string) => placeHref('editor', { doc: slugName, back: 'overview' })

  /** Open at the level: not settled here, not waiting to be sent away. */
  const isOpen = (entry: Entry) => !done.has(entry.id) && !progress.get(entry.id)?.settled
  const openEntries = () => current.filter(isOpen)

  // ---------- Why a request can no longer be answered here ----------
  function unavailable(entry: Entry): string {
    if (entry.source === 'request' && chatClient.connectionState() !== 'open') return 'The connection to Poise dropped. Answers wait until it is back; nothing is sent meanwhile.'
    if (entry.decision && board.data?.find((item) => item.id === entry.decision!.id)?.source.exists === false) return 'The chat that asked no longer exists, so it can no longer be answered.'
    return ''
  }
  function goneWords(entry: Entry): string {
    if (entry.source === 'request') return 'No longer open: it was answered elsewhere, or its chat cancelled or reset it. Nothing was sent from here.'
    if (entry.source === 'decision') {
      const item = board.data?.find((value) => `decision:${value.id}` === entry.id)
      if (item?.answer) return `Answered elsewhere: “${item.answer.label}”, at ${clockAt(item.answer.at)}. These choices no longer apply.`
      if (item?.resolved) return `Settled in its chat at ${clockAt(item.resolved.at)}: ${item.resolved.reason}`
      return 'No longer open in the Switchboard.'
    }
    if (entry.source === 'thread') return 'Resolved elsewhere, or no longer open on GitHub.'
    if (entry.source === 'chain') return 'The chain has moved on: this no longer needs attention.'
    return 'Cleared: it no longer stands.'
  }

  // ---------- Drawing ----------
  const chip = (state: string) => `<span class="st" data-state="${state}" data-ref="state"><span data-term="state.${state}">${esc(term(`state.${state}`))}</span></span>`

  function statusHTML(p: Progress | undefined): string {
    if (!p) return ''
    if (p.stage === 'Failed') return `<p class="nc-fail" role="status"><span class="sdot is-warn"></span>${esc(p.words)}</p>`
    if (p.settled) {
      return `<p class="nc-done" role="status"><span class="sdot is-saved"></span><b>${esc(p.label)}</b> · ${esc(p.words)} · ${clockAt(p.at)}${p.undo ? ' · <button class="lnk" data-act="undo" data-ref="ov.undo">Undo</button>' : ''}</p>`
    }
    return `<div class="life" data-ref="life" data-life="${p.stage}" role="status">${lifeHTML(p.stage, `${p.label} · ${p.words}`, true)}</div>`
  }

  function questionDraft(entry: Entry): Map<string, { value: string, checked: boolean, type: string }> {
    const out = new Map<string, { value: string, checked: boolean, type: string }>()
    if (!entry.request) return out
    try {
      const saved = JSON.parse(sessionStorage.getItem(QUESTION_DRAFTS) || '{}') as Record<string, [string, { name: string, type: string, value: string, checked: boolean }[]][]>
      const rows = Array.isArray(saved?.[entry.request.sessionId]) ? saved[entry.request.sessionId] : []
      for (const [key, inputs] of rows) {
        if (key !== `q:${entry.request.id}` || !Array.isArray(inputs)) continue
        for (const input of inputs) out.set(`${input.name}\u0000${input.type === 'text' ? '' : input.value}`, input)
      }
    } catch { /* an unreadable draft is no draft */ }
    return out
  }

  function formHTML(entry: Entry, blocked: string, sending: string): string {
    const draft = questionDraft(entry)
    const disabled = blocked ? ' disabled' : ''
    const id = entry.request!.id
    const fields = entry.questions!.map((q, qi) => {
      const name = `q-${id}-${qi}`
      const choices = q.options.map((o, oi) => {
        const checked = draft.get(`${name}\u0000${o.label}`)?.checked
        return `<label class="nc-qo"><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="${esc(name)}" value="${esc(o.label)}"${checked ? ' checked' : ''}${disabled}><span class="k">${oi + 1}</span><span>${esc(o.label)}</span>${o.description ? `<span class="dim">${esc(o.description)}</span>` : ''}</label>`
      }).join('')
      const free = q.freeText ? `<input type="text" class="nc-qt" name="${esc(`free-${id}-${qi}`)}" value="${esc(draft.get(`free-${id}-${qi}\u0000`)?.value ?? '')}" placeholder="Type an answer…" aria-label="Your answer to ${esc(q.question)}"${disabled}>` : ''
      return `<fieldset class="nc-q" data-qid="${esc(q.id)}" data-multi="${q.multiSelect ? 1 : 0}"><legend>${q.header ? `<span class="t-micro">${esc(q.header)}</span> ` : ''}${esc(q.question)}</legend>${choices}${free}</fieldset>`
    }).join('')
    return `<form class="nc-form" data-form="${esc(entry.id)}">${fields}<div class="nc-acts"><button type="submit" class="btn-ghost is-primary" data-ref="ov.option"${blocked || sending ? ` aria-disabled="true" data-why="${esc(blocked || sending)}"` : ''}>Submit</button></div></form>`
  }

  function replyHTML(entry: Entry, disabled: string): string {
    const free = entry.freeText!
    const draft = entry.request ? questionDraft(entry).get(`free-${entry.request.id}-0\u0000`)?.value ?? '' : replyDrafts.get(entry.id) ?? ''
    return `<div class="nc-reply"><textarea rows="2" data-reply="${esc(entry.id)}" placeholder="${esc(free.placeholder)}" aria-label="${esc(free.placeholder)}">${esc(draft)}</textarea><div class="nc-acts"><button class="btn-ghost is-primary" data-act="send" data-ref="ov.reply"${disabled || !draft.trim() ? ' aria-disabled="true"' : ''}${disabled ? ` data-why="${esc(disabled)}"` : ''}>${esc(free.send)}</button>${entry.options.length ? '<button class="btn-ghost" data-act="reply-cancel">Cancel</button>' : ''}</div></div>`
  }
  const replyDrafts = new Map<string, string>()

  function entryHTML(entry: Entry, gone: string): string {
    const p = progress.get(entry.id)
    const busy = !!p && (p.stage === 'Accepted' || p.stage === 'Queued' || p.stage === 'Executing')
    const closed = gone || unavailable(entry)
    const blocked = closed || (p?.uncertain ? 'Not confirmed yet: wait for Poise to read whether it is still open.' : '')
    const off = (why: string) => (why ? ` aria-disabled="true" data-why="${esc(why)}"` : '')
    const isOpenDetail = opened.has(entry.id)
    const answerable = !p?.settled && !busy
    const opts = answerable ? entry.options.map((o, i) => `<button class="btn-ghost${o.primary ? ' is-primary' : ''}" data-act="answer" data-option="${esc(o.key)}" data-ref="ov.option"${off(blocked)}${o.detail ? ` title="${esc(o.detail)}"` : ''}><span class="k">${i + 1}</span>${esc(o.label)}</button>`).join('') : ''
    const typed = !entry.options.length || replying.has(entry.id)
    // Your own words stay on screen while an answer is on its way, so typing
    // goes on; a failed send keeps what is there now.
    const sending = busy ? 'Sending your answer.' : ''
    const reply = !p?.settled && entry.freeText
      ? (typed ? replyHTML(entry, blocked || sending) : answerable ? `<button class="btn-ghost" data-act="reply-open" data-ref="ov.reply"${off(blocked)}>${esc(entry.freeText.label)}</button>` : '')
      : ''
    const form = !p?.settled && entry.questions ? formHTML(entry, blocked, sending) : ''
    const acts = opts || (reply && !typed) ? `<div class="nc-acts">${opts}${typed ? '' : reply}</div>` : ''
    const impact = entry.diagnostic && isOpenDetail ? impacts.get(entry.diagnostic.eventId)?.text : ''
    const body = isOpenDetail ? [
      entry.body ? `<p>${esc(entry.body).replace(/\n/g, '<br>')}</p>` : '',
      entry.code ? `<pre class="t-mono">${esc(entry.code)}</pre>` : '',
      entry.details.length ? `<ul class="nc-lines">${entry.details.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : '',
      impact ? `<p class="nc-impact" data-ref="ov.impact">Work impact: ${esc(impact)}</p>` : '',
      entry.why ? `<p class="nc-why" data-ref="mgr.why">Why this came to you: ${esc(entry.why)}</p>` : '',
    ].join('') : ''
    const more = entry.body || entry.code || entry.details.length || entry.why || entry.diagnostic
    const tools = p?.settled ? '' : [
      entry.open ? `<a class="lnk" href="${esc(entry.open.href)}"${entry.open.external ? ' target="_blank" rel="noopener"' : ''} data-act="open" data-ref="ov.open">${esc(entry.open.label)}${entry.open.external ? ' ↗' : ''}</a>` : '',
      entry.github && !entry.open?.external ? `<a class="lnk" href="${esc(entry.github)}" target="_blank" rel="noopener" data-ref="ov.open">Open on GitHub ↗</a>` : '',
      entry.timeline ? `<a class="lnk" href="${esc(entry.timeline)}" data-act="open" data-ref="ov.timeline">Open its timeline</a>` : '',
      entry.diagnostic ? `<a class="lnk" href="${esc(diagnosticLink(entry.diagnostic))}" data-act="open" data-ref="ov.diagnostic">Open its diagnostic</a>` : '',
      entry.silenceable && !busy ? '<button class="lnk" data-act="silence" data-ref="ov.silence">Silence reminders</button>' : '',
      entry.dismissable && !busy ? '<button class="lnk" data-act="dismiss" data-ref="ov.dismiss">Dismiss</button>' : '',
      more ? `<button class="lnk" data-act="more" aria-expanded="${isOpenDetail}">${isOpenDetail ? 'Less' : 'More'}</button>` : '',
    ].filter(Boolean).join('')
    const ref = entry.notice?.kind === 'worker_idle' ? 'ov.idle' : 'ov.notice'
    const metaRef = entry.source === 'chain' ? ' data-ref="ov.advance"' : ''
    return `<article class="nc is-${entry.group}${p?.settled ? ' is-answered' : ''}${fresh.has(entry.id) ? ' is-fresh' : ''}${gone ? ' is-gone' : ''}" data-key="e:${esc(entry.id)}" data-notice="${esc(entry.id)}" data-ref="${ref}" tabindex="0" aria-labelledby="nt-${slug(entry.id)}">
      <header class="nc-h"><span class="t-micro">${esc(entry.kind)}</span>${fresh.has(entry.id) ? '<span class="chip is-agent">New</span>' : ''}${entry.meta ? `<span class="nc-meta"${metaRef}>${esc(entry.meta)}</span>` : ''}<span class="nc-when">${entry.since ? `<time datetime="${esc(entry.since)}" title="${esc(clockAt(entry.since))}">${esc(ago(entry.since))}</time>` : ''}</span></header>
      <h3 class="nc-t" id="nt-${slug(entry.id)}">${esc(entry.title)}</h3>
      <p class="nc-m">${entry.state ? chip(entry.state) : ''}<span>${esc(entry.who)}</span>${entry.where ? `<span class="dim">· ${esc(entry.where)}</span>` : ''}</p>
      ${closed && !p?.settled ? `<p class="nc-gone" data-ref="ov.gone">${esc(closed)}</p>` : ''}
      ${body ? `<div class="nc-b">${body}</div>` : ''}
      ${statusHTML(p)}
      ${p?.uncertain && entry.open ? `<p class="nc-fail"><a class="lnk" href="${esc(entry.open.href)}" data-act="open" data-ref="ov.open">${esc(entry.open.label)}</a> to see what happened.</p>` : ''}
      ${acts}${typed ? reply : ''}${form}
      ${tools ? `<footer class="nc-f">${tools}</footer>` : ''}
    </article>`
  }
  const diagnosticLink = (ref: DiagnosticEvidence) => placeHref('observe', { part: 'logging', event: ref.eventId, from: ref.from, to: ref.to, back: 'overview' })

  function handledRows(): HandledRow[] {
    const server = (handled.data ?? []).map((row): HandledRow => ({ title: row.title, note: `${row.outcome} · ${ACTORS[row.actor] ?? row.actor}`, at: Date.parse(row.at) }))
    const mine = settledHere.filter((row) => !server.some((s) => s.title === row.title && s.at >= row.at - 60_000))
    return [...mine, ...server].sort((a, b) => b.at - a.at)
  }

  function coverage(): string {
    const lines = [
      readLine('Your chats’ requests', requests),
      requests.data && !requests.data.complete ? 'Only the newest 200 chat requests are listed; open Chat for the rest.' : '',
      readLine('The Switchboard’s decisions', board),
      readLine('Review threads', reviews),
      ...[...threads].flatMap(([name, value]) => value.error ? [`Review threads of ${name} could not be read: ${value.error}`] : []),
      ...(reviews.data ?? []).flatMap((publication) => publication.problems.length ? [`${publication.site} · ${publication.repo}#${publication.pr}: ${publication.problems.join(' ')}${publication.checkedAt ? ` Last checked ${clockAt(publication.checkedAt)}.` : ''}`] : []),
      readLine('Handled today', handled),
    ].filter(Boolean)
    const checked = (reviews.data ?? []).map((publication) => publication.checkedAt).filter((at): at is string => !!at).sort()[0]
    const reviewLine = reviews.data?.length && checked ? `Review threads last checked ${clockAt(checked)}.` : ''
    return lines.length || reviewLine ? `<div class="ocover" data-key="cover" data-ref="ov.read">${[...lines, reviewLine].filter(Boolean).map((line) => `<p>${esc(line)}</p>`).join('')}</div>` : ''
  }

  function listHTML(): string {
    const goneIds = new Set<string>()
    if (holding) {
      const byId = new Map(current.filter((entry) => shownAt(entry.group, level)).map((entry) => [entry.id, entry]))
      shown = holding.map((id) => byId.get(id) ?? lastSeen.get(id)).filter((entry): entry is Entry => !!entry)
      for (const entry of shown) if (!byId.has(entry.id) && !progress.get(entry.id)?.settled) goneIds.add(entry.id)
    } else {
      shown = current.filter((entry) => shownAt(entry.group, level) && isOpen(entry))
    }
    for (const entry of shown) lastSeen.set(entry.id, entry)
    const groups = GROUPS.slice(0, level + 1).map(([group, name, gloss]) => {
      const items = shown.filter((entry) => entry.group === group)
      if (!items.length) return ''
      const open = items.filter((entry) => isOpen(entry) && !goneIds.has(entry.id)).length
      const folded = group === 'auto' && !autoOpen && shown.some((entry) => entry.group !== 'auto')
      const head = `<h2 class="ng-h"><span class="t-micro">${esc(name)}</span><span class="n">${open}</span>${group === 'auto' ? `<button class="lnk" data-act="auto" aria-expanded="${!folded}" data-ref="ov.fold">${folded ? 'Show' : 'Fold'}</button>` : `<span class="t-gloss">${esc(gloss)}</span>`}</h2>`
      return `<section class="ng is-${group}" data-key="g:${group}" aria-label="${esc(name)}">${head}${folded ? '' : items.map((entry) => entryHTML(entry, goneIds.has(entry.id) ? goneWords(entry) : '')).join('')}</section>`
    }).join('')
    const off = feed.enabled || !noticeFeed.answered ? '' : `<p class="nempty" data-key="off">Notifications are off in <a class="lnk" href="${esc(placeHref('settings', { settings: 'general', back: 'overview' }))}">Settings, General</a>. Your chats’ requests, your documents’ review threads and Behaviors’ diagnostics still show here.</p>`
    const empty = shown.length ? '' : `<p class="nempty" data-key="empty">Nothing ${level === 0 ? 'needs you' : 'is open at this level'}. ${level < 3 ? 'Show more with the control above, or rest.' : 'Rest.'}</p>`
    const rows = handledRows()
    const handledHTML = `<section class="ng is-handled" data-key="g:handled"><h2 class="ng-h"><span class="t-micro">Handled today</span><span class="n">${rows.length}</span><button class="lnk" data-act="handled" aria-expanded="${handledOpen}" data-ref="ov.handled">${handledOpen ? 'Fold' : 'Show'}</button></h2>${handledOpen ? `<ul class="hl">${rows.map((row) => `<li><span class="sdot is-saved"></span><span class="hl-t">${esc(row.title)}</span><span class="hl-n">${esc(row.note)} · ${clockAt(row.at)}</span>${row.undo && holds.has(row.undo) ? `<button class="lnk" data-act="undo" data-undo="${esc(row.undo)}" data-ref="ov.undo">Undo</button>` : ''}</li>`).join('')}</ul>` : ''}</section>`
    return off + groups + empty + coverage() + handledHTML
  }

  /** How many entries each level shows: choosing one visibly does what it says (#1380). */
  const levelCounts = (): number[] => {
    const open = openEntries()
    return LEVELS.map((_, i) => open.filter((entry) => shownAt(entry.group, i)).length)
  }
  const levelName = (name: string, n: number) => `${name}, ${n} ${n === 1 ? 'entry' : 'entries'}`
  function levelHTML(counts: number[]): string {
    return `<div class="seg olevel" role="radiogroup" aria-label="How much to show" data-ref="ov.level">${LEVELS.map(([name, gloss], i) => `<button role="radio" aria-checked="${i === level}" aria-pressed="${i === level}" tabindex="${i === level ? 0 : -1}" data-level="${i}" title="${esc(gloss)}" aria-label="${esc(levelName(name, counts[i]))}">${esc(name)}<small data-level-n>${counts[i]}</small></button>`).join('')}</div>`
  }

  // A source's first read is the list loading, not an arrival: its entries
  // join the list at once, unmarked, even while you are in it.
  const ready: Record<Entry['source'], () => boolean> = {
    notice: () => noticeFeed.answered, diagnostic: () => !!getBehaviorDiagnostics(), chain: () => chainsRead,
    request: () => !!requests.data, decision: () => !!board.data, thread: () => !!reviews.data,
  }
  const seeded = new Set<Entry['source']>()
  let chainsRead = false

  function paint(): void {
    current = compute()
    for (const entry of current) {
      if (known.has(entry.id)) continue
      known.add(entry.id)
      if (seeded.has(entry.source)) fresh.add(entry.id)
      else if (holding) holding = current.filter((value) => holding!.includes(value.id) || value.id === entry.id).map((value) => value.id)
    }
    for (const source of Object.keys(ready) as Entry['source'][]) if (ready[source]()) seeded.add(source)
    for (const id of [...done.keys()]) if (!current.some((entry) => entry.id === id) && !progress.get(id)?.settled) done.delete(id)
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null
    patchContent(list, listHTML())
    if (focused && !focused.isConnected) $(`[data-notice="${CSS.escape(focused.closest<HTMLElement>('[data-notice]')?.dataset.notice ?? '')}"]`, list)?.focus({ preventScroll: true })
    paintTerms(list)
    const levelBox = $('[data-levelbox]', root)
    const counts = levelCounts()
    if (levelBox && levelBox.dataset.shown !== String(level)) { levelBox.innerHTML = levelHTML(counts); levelBox.dataset.shown = String(level) }
    // Counts change in place, so focus on a level is never lost to a redraw.
    else if (levelBox) {
      const buttons = Array.from((levelBox as HTMLElement).querySelectorAll<HTMLElement>('[data-level]'))
      buttons.forEach((button, i) => {
        const n = button.querySelector('[data-level-n]')
        if (n && n.textContent !== String(counts[i])) { n.textContent = String(counts[i]); button.setAttribute('aria-label', levelName(LEVELS[i][0], counts[i])) }
      })
    }
    const count = $('[data-ncount]', root)
    const t = tally(openEntries().map((entry) => entry.group), level)
    if (count) { count.textContent = String(t.count); if (t.tone) count.dataset.tone = t.tone; else delete count.dataset.tone }
    const heldEl = $('[data-held]', root)
    const waiting = holding ? current.filter((entry) => shownAt(entry.group, level) && isOpen(entry) && !holding!.includes(entry.id)).length : 0
    if (heldEl) {
      heldEl.classList.toggle('is-none', !waiting)
      heldEl.setAttribute('aria-hidden', String(!waiting))
      heldEl.innerHTML = waiting ? `${waiting} new · <button class="lnk" data-act="release">Show now</button>` : ''
    }
    answersChanged()
    options.onEntries(openEntries())
  }

  // ---------- Holding still while you are in the list ----------
  function enter(): void {
    window.clearTimeout(settleTimer)
    if (inside) return
    inside = true
    holding = shown.map((entry) => entry.id)
  }
  function leaveSoon(): void {
    window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      if (root.matches(':hover') || root.contains(document.activeElement)) return
      inside = false
      holding = null
      // Answered entries fold into Handled today; what arrived shows, marked New.
      for (const [id, p] of progress) if (p.settled) { progress.delete(id); fresh.delete(id) }
      paint()
    }, 400)
  }
  signal.addEventListener('abort', () => window.clearTimeout(settleTimer))
  root.addEventListener('pointerenter', enter, { signal })
  root.addEventListener('pointerleave', () => { if (!root.contains(document.activeElement)) leaveSoon() }, { signal })
  root.addEventListener('focusin', enter, { signal })
  root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget as Node | null) && !root.matches(':hover')) leaveSoon() }, { signal })
  // A look at an entry is enough to stop calling it new.
  list.addEventListener('pointerover', (e) => { const id = (e.target as Element).closest<HTMLElement>('[data-notice]')?.dataset.notice; if (id) fresh.delete(id) }, { signal })

  // ---------- Answering ----------
  function setProgress(id: string, next: Progress): void { progress.set(id, next); paint() }
  function settle(entry: Entry, label: string, words: string, extra: Partial<Progress> = {}): void {
    const row: HandledRow = { title: entry.title, note: `${label} · ${words}`, at: Date.now(), ...(extra.undo ? { undo: entry.id } : {}) }
    done.set(entry.id, row)
    settledHere.unshift(row)
    setProgress(entry.id, { stage: 'Completed', label, words, at: Date.now(), settled: true, ...extra })
    void readHandled()
  }
  function fail(entry: Entry, label: string, error: unknown): void {
    const inDoubt = error instanceof ChatCommandError && error.code === 'command_in_doubt'
    const words = inDoubt ? 'Not confirmed: check the chat. It can be answered again once Poise reads that it is still open.' : `Failed: ${reason(error)}`
    setProgress(entry.id, { stage: 'Failed', label, words, at: Date.now(), uncertain: inDoubt })
    if (entry.source === 'request') void readRequests()
  }

  function questionAnswers(entry: Entry, key: string | null, text: string | null): Record<string, string | string[]> {
    if (!entry.questions) return { [entry.request!.options[0]]: text ?? key ?? '' }
    // As Chat's question form collects them (src/views/chat-transcript.ts).
    const answers: Record<string, string | string[]> = {}
    const form = $(`[data-form="${CSS.escape(entry.id)}"]`, list) as HTMLFormElement | null
    for (const q of form ? $$('.nc-q', form) as HTMLElement[] : []) {
      const qid = q.dataset.qid!
      const picked = ($$('input:checked', q) as HTMLInputElement[]).map((input) => input.value)
      const free = (q.querySelector('.nc-qt') as HTMLInputElement | null)?.value.trim() || ''
      answers[qid] = q.dataset.multi === '1' ? (free ? [...picked, free] : picked) : free || picked[0] || ''
    }
    return answers
  }

  async function answer(entry: Entry, key: string | null, text: string | null = null): Promise<void> {
    const p = progress.get(entry.id)
    if (p && p.stage !== 'Failed') return
    if (p?.uncertain) return
    const option = key === null ? null : entry.options.find((o) => o.key === key)
    const label = text !== null ? `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”` : option?.label ?? (entry.questions ? 'Answered' : key ?? '')
    setProgress(entry.id, { stage: 'Accepted', label, words: 'sending', at: Date.now() })
    inFlight += 1
    try {
      if (entry.request) {
        const r = entry.request
        await chatClient.send(r.kind === 'permission'
          ? { type: 'permission.respond', sessionId: r.sessionId, id: r.id, optionId: key! }
          : { type: 'question.answer', sessionId: r.sessionId, id: r.id, answers: questionAnswers(entry, key, text) })
        // Sent: done once the request leaves the open list, which the chat changes in the same step.
        clearQuestionDraft(entry)
        replyDrafts.delete(entry.id)
        setProgress(entry.id, { stage: 'Executing', label, words: 'Sent · waiting for the chat to record it', at: Date.now() })
        void readRequests()
      } else if (entry.decision) {
        const next = parseBoard(await chatClient.answerSwitchboardItem(entry.decision.id, text !== null ? { text } : { optionId: key! }))
        if (next) acceptBoard(next)
        replyDrafts.delete(entry.id)
        const relay = next?.items.find((item) => item.id === entry.decision!.id)?.answer?.relay
        if (relay === 'delivered') settle(entry, label, `Delivered to ${entry.who}`)
        else settle(entry, label, relay === 'held' ? `Held: ${entry.who} is stopped; open it to resume it` : `Queued for ${entry.who}; delivered when the chat is free`)
      } else if (entry.thread) {
        const result = await json<{ reviews?: ThreadReview[] }>(`/api/editor/doc/${encodeURIComponent(entry.thread.slug)}/reviews/action`, {
          method: 'POST', body: JSON.stringify(key === 'resolve' ? { id: entry.thread.id, action: 'resolve' } : { id: entry.thread.id, action: 'reply', body: text }),
        })
        const before = threads.get(entry.thread.slug)
        if (Array.isArray(result.reviews)) threads.set(entry.thread.slug, { reviews: result.reviews, openThreads: before?.openThreads ?? 0, error: '' })
        replyDrafts.delete(entry.id)
        settle(entry, label, key === 'resolve' ? 'Resolved on GitHub' : 'Replied on GitHub, as you')
      } else if (entry.chain) {
        await json('/api/behavior-chains', { method: 'POST', body: JSON.stringify({ id: entry.chain.id, sequence: entry.chain.sequence, operation: 'resume' }) })
        settle(entry, label, 'Resumed: the chain proceeds under its own gates')
        options.chainsChanged()
      } else if (entry.pull && (key === 'merge' || key === 'approve')) {
        await pullAction(entry, key, label)
      } else if (entry.pull && key === 'review') {
        await json('/api/pr-review', { method: 'POST', body: JSON.stringify({ url: entry.pull.url }) })
        settle(entry, label, 'Started: the review runs in Observe → Behaviors')
      } else {
        throw new Error('This answer is not available here.')
      }
    } catch (error) {
      fail(entry, label, error)
    } finally {
      inFlight -= 1
    }
  }

  // Approve and Merge act as you, on the head Poise read, under one actionId
  // that a repeat reuses: the service reconciles and never acts twice.
  async function pullAction(entry: Entry, kind: 'merge' | 'approve', label: string): Promise<void> {
    const pull = entry.pull!
    const actionKey = `${kind}:${pull.repo}#${pull.number}`
    setProgress(entry.id, { stage: 'Accepted', label, words: 'reading its head commit', at: Date.now() })
    const read = await json<{ held?: { repo: string, number: number, head: string | null }[] }>('/api/gh', { method: 'POST', body: JSON.stringify({ operation: 'green_pr' }) })
    const head = read.held?.find((row) => row.repo.toLowerCase() === pull.repo.toLowerCase() && row.number === pull.number)?.head
    if (!head) throw new Error('Poise could not read this pull request’s head commit, so nothing was sent. Open it on GitHub.')
    const actionId = actionIds.get(actionKey) ?? uid()
    actionIds.set(actionKey, actionId)
    setProgress(entry.id, { stage: 'Executing', label, words: kind === 'merge' ? 'merging, as you' : 'approving, as you', at: Date.now() })
    const response = await fetch(`/api/pull-requests/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ repo: pull.repo, number: pull.number, expectedHeadSha: head, actionId }) })
    const body = await response.json().catch(() => null) as Record<string, any> | null
    const outcome = String(body?.outcome ?? '')
    const short = (sha: unknown) => typeof sha === 'string' ? sha.slice(0, 7) : 'unknown'
    if (outcome === 'unknown') {
      setProgress(entry.id, { stage: 'Failed', label, words: `Not confirmed: GitHub ${body?.github?.merged ? 'reports it merged' : 'did not say whether it acted'}. Pressing again checks under the same action and never acts twice.`, at: Date.now() })
      return
    }
    actionIds.delete(actionKey)
    const words: Record<string, string> = {
      approved: `Approved as ${body?.actor ?? 'you'}`, already_approved: `Already approved as ${body?.actor ?? 'you'}`,
      merged: `Merged${body?.mergeMethod ? ` (${body.mergeMethod})` : ''}`, enqueued: 'In the merge queue', in_queue: 'Already in the merge queue',
      already_merged: `Already merged${body?.mergedBy ? ` by ${body.mergedBy}` : ''}`,
    }
    if (response.ok && words[outcome]) { settle(entry, label, words[outcome]); return }
    if (outcome === 'superseded') throw new Error(`New commits arrived: its head moved from ${short(body?.expectedHead)} to ${short(body?.actualHead)}, so nothing was merged.`)
    if (outcome === 'not_ready') throw new Error('GitHub says it is not ready to merge yet; nothing was merged.')
    throw new ServiceError(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`, response.status, body)
  }

  // ---------- Dismiss and Silence: held for eight seconds, with Undo ----------
  function holdSend(entry: Entry, kind: 'dismiss' | 'silence'): void {
    if (!(entry.notice || entry.decision) || holds.has(entry.id)) return
    const timer = window.setTimeout(() => sendHeld(entry.id), HOLD_MS)
    holds.set(entry.id, { kind, notice: entry.notice, decision: entry.decision?.id, timer })
    settle(entry, kind === 'dismiss' ? 'Dismissed' : 'Silenced', kind === 'dismiss' ? 'Put away' : 'No more reminders while it stays open', { undo: true })
  }
  function undo(id: string): void {
    const hold = holds.get(id)
    if (!hold) return
    window.clearTimeout(hold.timer)
    holds.delete(id)
    progress.delete(id)
    done.delete(id)
    const at = settledHere.findIndex((row) => row.undo === id)
    if (at >= 0) settledHere.splice(at, 1)
    paint()
  }
  function sendHeld(id: string, leaving = false): void {
    const hold = holds.get(id)
    if (!hold) return
    window.clearTimeout(hold.timer)
    holds.delete(id)
    const p = progress.get(id)
    if (p) progress.set(id, { ...p, undo: false })
    const { notice, decision } = hold
    const action = decision !== undefined
      ? chatClient.dismissSwitchboardItem(decision).then((state) => { const next = parseBoard(state); if (next) acceptBoard(next) }, () => undefined)
      : hold.kind === 'dismiss' ? noticeFeed.dismiss(notice!.id) : noticeFeed.silence(notice!.id)
    if (leaving) return
    paint()
    void action.then(() => {
      // Put away when the next read omits it; one still there could not be.
      const still = decision !== undefined
        ? (board.data ?? []).some((item) => item.id === decision && openDecision(item))
        : noticeFeed.current.notices.some((value) => value.id === notice!.id && (hold.kind === 'silence' || value.due === notice!.due))
      if (!still || signal.aborted) return
      done.delete(id)
      progress.set(id, { stage: 'Failed', label: hold.kind === 'dismiss' ? 'Dismiss' : 'Silence', words: 'It could not be put away; it is still open.', at: Date.now() })
      paint()
    })
  }
  // Leaving the page sends them at once; a page that is going away can only send.
  addEventListener('pagehide', () => {
    for (const [id, hold] of holds) {
      window.clearTimeout(hold.timer)
      holds.delete(id)
      const path = hold.decision !== undefined ? `/api/chat/switchboard/items/${hold.decision}/dismiss` : `/api/notices/${encodeURIComponent(hold.notice!.id)}/${hold.kind}`
      void fetch(path, { method: 'POST', keepalive: true, headers: { Accept: 'application/json' } }).catch(() => undefined)
    }
  }, { signal })

  // ---------- Question drafts, shared with Chat (src/views/chat-transcript.ts) ----------
  function saveQuestionDraft(entry: Entry): void {
    if (!entry.request || entry.request.kind !== 'question') return
    const card = $(`[data-notice="${CSS.escape(entry.id)}"]`, list) as HTMLElement | null
    if (!card) return
    const inputs = ($$('input', card) as HTMLInputElement[]).map((input) => ({ name: input.name, type: input.type, value: input.value, checked: input.checked }))
    const reply = card.querySelector<HTMLTextAreaElement>('[data-reply]')
    if (reply) inputs.push({ name: `free-${entry.request.id}-0`, type: 'text', value: reply.value, checked: false })
    try {
      const saved = JSON.parse(sessionStorage.getItem(QUESTION_DRAFTS) || '{}') as Record<string, [string, unknown][]>
      const merged = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
      const rows = (Array.isArray(merged[entry.request.sessionId]) ? merged[entry.request.sessionId] : []).filter(([key]) => key !== `q:${entry.request!.id}`)
      if (inputs.some((input) => input.type === 'text' ? !!input.value : input.checked)) rows.push([`q:${entry.request.id}`, inputs])
      if (rows.length) merged[entry.request.sessionId] = rows; else delete merged[entry.request.sessionId]
      sessionStorage.setItem(QUESTION_DRAFTS, JSON.stringify(merged))
    } catch { /* the draft stays on the page */ }
  }
  function clearQuestionDraft(entry: Entry): void {
    if (!entry.request) return
    try {
      const saved = JSON.parse(sessionStorage.getItem(QUESTION_DRAFTS) || '{}') as Record<string, [string, unknown][]>
      const rows = Array.isArray(saved?.[entry.request.sessionId]) ? saved[entry.request.sessionId].filter(([key]) => key !== `q:${entry.request!.id}`) : []
      if (rows.length) saved[entry.request.sessionId] = rows; else delete saved[entry.request.sessionId]
      sessionStorage.setItem(QUESTION_DRAFTS, JSON.stringify(saved))
    } catch { /* nothing to clear */ }
  }
  const draftTyped = () => [...replyDrafts.values()].some((value) => !!value.trim()) || current.some((entry) => entry.request?.kind === 'question' && questionDraft(entry).size > 0
    && [...questionDraft(entry).values()].some((input) => input.type === 'text' ? !!input.value.trim() : input.checked))

  // An answer on its way, or a Dismiss or Silence still waiting in the tab, is
  // something a reload would cut short; a half-answered question is unsaved work.
  const unguard = registerReloadGuard(() => {
    const out: string[] = []
    if (inFlight > 0 || holds.size) out.push('command')
    if (draftTyped()) out.push('question-form')
    return out
  })

  // ---------- Work impact, read when an entry opens ----------
  async function readImpact(ref: DiagnosticEvidence): Promise<void> {
    const knownImpact = impacts.get(ref.eventId)
    if (knownImpact && Date.now() - knownImpact.at < 60_000) return
    impacts.set(ref.eventId, { text: 'reading the workspace’s chain evidence…', at: Date.now() })
    paint()
    let words = 'unknown: the workspace’s chain evidence is unavailable.'
    try {
      const access = await loggingAccess(signal)
      const { event } = await loggingEvent(access, ref.eventId, 'workspace', signal)
      const work = (await loggingWorkImpacts(access, [event], signal)).get(event.id) ?? null
      words = work
        ? `${work.impact} · ${work.target} · ${work.stage} · last verified progress ${clockAt(work.progressAt)}${work.retryAt !== null ? ` · next retry ${clockAt(work.retryAt)}` : ''}${work.nextAction ? ` · next: ${work.nextAction}` : ''}`
        : 'unknown: no managed chain invocation matches this evidence.'
    } catch {
      if (signal.aborted) return
    }
    impacts.set(ref.eventId, { text: words, at: Date.now() })
    paint()
  }

  // ---------- Reads ----------
  let staleReads = 0
  async function readRequests(): Promise<void> {
    const asked = ++requests.asked
    try {
      const read = requestsFrom(await json('/api/chat/requests'))
      if (!read) throw new Error('the service answered with something this page cannot read')
      // A response older than one shown, or than a frame already seen, is history;
      // the latter is read again, a few times at most.
      if (asked < requests.shown) return
      if (read.revision < requests.frame) {
        if (asked === requests.asked && staleReads++ < 3) void readRequests()
        return
      }
      staleReads = 0
      requests.shown = asked
      requests.data = read
      requests.error = ''
      requests.at = Date.now()
      for (const [id, p] of progress) {
        if (!id.startsWith('request:')) continue
        const listed = read.requests.some((request) => `request:${request.id}` === id)
        if (!listed && p.stage === 'Executing') {
          const entry = lastSeen.get(id)
          if (entry) settle(entry, p.label, entry.request?.kind === 'permission' ? 'Recorded in the chat' : 'Answered in the chat')
        }
        // A request that might have been answered can be answered again once a read shows it still open.
        if (listed && p.stage === 'Failed') progress.set(id, { ...p, uncertain: false })
      }
    } catch (error) {
      if (asked < requests.shown) return
      requests.error = reason(error)
    }
    reportRead(ctx, 'overview-requests', 'Your chats’ requests could not be read', requests)
    paint()
  }

  function parseBoard(value: unknown): { revision: number, items: DecisionItem[] } | null {
    const state = value as { revision?: unknown, items?: unknown } | null
    return state && Number.isSafeInteger(state.revision) && Array.isArray(state.items) ? { revision: state.revision as number, items: state.items as DecisionItem[] } : null
  }
  function acceptBoard(next: { revision: number, items: DecisionItem[] }): void {
    if (next.revision < board.revision) return
    board.revision = next.revision
    board.data = next.items
    board.error = ''
    board.at = Date.now()
  }
  let boardReading: Promise<void> | null = null
  let boardAgain = false
  function readBoard(): Promise<void> {
    if (boardReading) { boardAgain = true; return boardReading }
    boardReading = chatClient.switchboard().then((value) => {
      const next = parseBoard(value)
      if (!next) throw new Error('the service answered with something this page cannot read')
      acceptBoard(next)
    }).catch((error: unknown) => { board.error = reason(error) }).finally(() => {
      reportRead(ctx, 'overview-switchboard', 'The Switchboard’s decisions could not be read', board)
      boardReading = null
      paint()
      if (boardAgain) { boardAgain = false; void readBoard() }
    })
    return boardReading
  }

  async function readReviews(): Promise<void> {
    try {
      const data = await json<{ publications?: Publication[] }>('/api/editor/reviews')
      if (!Array.isArray(data.publications)) throw new Error('the service answered with something this page cannot read')
      // Threads' text comes from each document's cached reviews, read only where
      // threads are open; the list shows them together with their publications.
      for (const publication of data.publications) {
        const before = threads.get(publication.slug)
        if (!publication.openThreads) { threads.delete(publication.slug); continue }
        if (before && before.openThreads === publication.openThreads && !before.error) continue
        try {
          const cached = await json<{ reviews?: ThreadReview[] }>(`/api/editor/doc/${encodeURIComponent(publication.slug)}/reviews`)
          threads.set(publication.slug, { reviews: Array.isArray(cached.reviews) ? cached.reviews : [], openThreads: publication.openThreads, error: '' })
        } catch (error) {
          threads.set(publication.slug, { reviews: before?.reviews ?? [], openThreads: publication.openThreads, error: reason(error) })
        }
      }
      reviews.data = data.publications
      reviews.error = ''
      reviews.at = Date.now()
    } catch (error) {
      reviews.error = reason(error)
    }
    reportRead(ctx, 'overview-reviews', 'Review threads could not be read', reviews)
    paint()
  }

  async function readHandled(): Promise<void> {
    try {
      const data = await json<{ handled?: ServerHandled[] }>(`/api/notices/handled?${new URLSearchParams({ since: midnightInZone(0).toISOString() })}`)
      if (!Array.isArray(data.handled)) throw new Error('the service answered with something this page cannot read')
      handled.data = data.handled
      handled.error = ''
      handled.at = Date.now()
    } catch (error) {
      handled.error = reason(error)
    }
    reportRead(ctx, 'overview-handled', 'Handled today could not be read', handled)
    paint()
  }

  // ---------- Events ----------
  root.addEventListener('click', (e) => {
    const target = e.target as Element
    const level_ = target.closest<HTMLElement>('[data-level]')
    if (level_) { setLevel(Number(level_.dataset.level)); return }
    const button = target.closest<HTMLElement>('[data-act]')
    if (!button || !root.contains(button)) return
    if (button.matches('[aria-disabled="true"]')) { e.preventDefault(); return }
    const id = button.closest<HTMLElement>('[data-notice]')?.dataset.notice
    const entry = id ? (current.find((value) => value.id === id) ?? lastSeen.get(id)) : undefined
    switch (button.dataset.act) {
      case 'answer': if (entry) void answer(entry, button.dataset.option ?? null); break
      case 'send': {
        const textArea = button.closest('[data-notice]')?.querySelector<HTMLTextAreaElement>('[data-reply]')
        const value = textArea?.value.trim()
        if (entry && value) void answer(entry, entry.thread ? 'reply' : null, value)
        break
      }
      case 'reply-open': if (id) { replying.add(id); paint(); $(`[data-notice="${CSS.escape(id)}"] [data-reply]`, list)?.focus() } break
      case 'reply-cancel': if (id) { replying.delete(id); paint() } break
      case 'dismiss': if (entry) holdSend(entry, 'dismiss'); break
      case 'silence': if (entry) holdSend(entry, 'silence'); break
      case 'undo': undo(button.dataset.undo ?? id ?? ''); break
      case 'more': if (id) toggleMore(id); break
      case 'auto': autoOpen = !autoOpen; paint(); break
      case 'handled': handledOpen = !handledOpen; paint(); break
      case 'release': holding = null; enter(); paint(); break
      default:
    }
  }, { signal })
  function toggleMore(id: string): void {
    if (opened.has(id)) opened.delete(id); else opened.add(id)
    const entry = current.find((value) => value.id === id)
    if (opened.has(id) && entry?.diagnostic) void readImpact(entry.diagnostic)
    paint()
  }
  function setLevel(next: number): void {
    if (!(next >= 0 && next < LEVELS.length) || next === level) return
    const added = GROUPS.slice(level + 1, next + 1).map(([group]) => group)
    level = next
    saveLevel(level)
    // Choosing what to see is a deliberate change: the list redraws at the new
    // level, and what the level adds comes into view, or says there is none.
    if (holding) holding = null
    paint()
    if (inside) holding = shown.map((entry) => entry.id)
    $(`[data-level="${level}"]`, root)?.focus()
    if (!added.length) return
    const first = added.map((group) => $(`[data-key="g:${group}"]`, list)).find(Boolean)
    if (first) first.scrollIntoView({ block: 'nearest' }); else toast('Nothing more is open at this level.')
  }
  root.addEventListener('submit', (e) => {
    const form = (e.target as Element).closest<HTMLFormElement>('[data-form]')
    if (!form) return
    e.preventDefault()
    const entry = current.find((value) => value.id === form.dataset.form)
    if (entry && !form.querySelector('[aria-disabled="true"][type="submit"]')) void answer(entry, null)
  }, { signal })
  root.addEventListener('input', (e) => {
    const target = e.target as HTMLElement
    const id = target.closest<HTMLElement>('[data-notice]')?.dataset.notice
    const entry = id ? current.find((value) => value.id === id) : undefined
    if (!entry || !id) return
    if (target.matches('[data-reply]')) {
      replyDrafts.set(id, (target as HTMLTextAreaElement).value)
      const send = target.closest('.nc-reply')?.querySelector<HTMLElement>('[data-act="send"]')
      if (send && !send.dataset.why) send.setAttribute('aria-disabled', String(!(target as HTMLTextAreaElement).value.trim()))
    }
    saveQuestionDraft(entry)
  }, { signal })
  root.addEventListener('change', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-notice]')?.dataset.notice
    const entry = id ? current.find((value) => value.id === id) : undefined
    if (entry) saveQuestionDraft(entry)
  }, { signal })
  // Keys: J and K move between entries; 1–9 answer; Enter or E opens the detail; O opens it where it lives.
  root.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('textarea, input, select')) return
    const levelButton = target.closest<HTMLElement>('[data-level]')
    if (levelButton && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault()
      setLevel(Math.max(0, Math.min(LEVELS.length - 1, level + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1))))
      return
    }
    const card = target.closest<HTMLElement>('[data-notice]')
    if (!card || e.metaKey || e.ctrlKey || e.altKey) return
    const cards = $$('[data-notice]', list) as HTMLElement[]
    const at = cards.indexOf(card)
    const entry = current.find((value) => value.id === card.dataset.notice) ?? lastSeen.get(card.dataset.notice ?? '')
    if (e.key === 'j' || (e.key === 'ArrowDown' && target === card)) { e.preventDefault(); cards[Math.min(cards.length - 1, at + 1)]?.focus(); return }
    if (e.key === 'k' || (e.key === 'ArrowUp' && target === card)) { e.preventDefault(); cards[Math.max(0, at - 1)]?.focus(); return }
    if (!entry) return
    if (/^[1-9]$/.test(e.key)) {
      const button = $$('[data-act="answer"]', card)[Number(e.key) - 1] as HTMLElement | undefined
      if (button) { e.preventDefault(); button.click() }
      return
    }
    if ((e.key === 'Enter' || e.key === 'e') && target === card) { e.preventDefault(); toggleMore(entry.id); return }
    if (e.key === 'o' && entry.open) { e.preventDefault(); ($('[data-act="open"]', card) as HTMLElement | null)?.click() }
  }, { signal })

  // ---------- Live ----------
  // Leaving clears Overview's notices one by one; a place that has left does not repaint for each.
  const unsubscribe = noticeFeed.subscribe((state) => { feed = state; if (!signal.aborted) paint() })
  chatClient.start()
  const offRequests = chatClient.on('chatRequests', (revision) => {
    requests.frame = Math.max(requests.frame, revision)
    if (!requests.data || revision > requests.data.revision) void readRequests()
  })
  const offBoard = chatClient.on('switchboard', (revision) => { if (revision > board.revision) void readBoard() })
  const offConnection = chatClient.on('connection', (state) => {
    // Reconnected: what changed meanwhile is read again. Dropped: answers wait.
    if (state === 'open') { void readRequests(); void readBoard() }
    paint()
  })
  setAnswerGroups(() => openEntries().map((entry) => entry.group))
  paint()
  void readRequests()
  void readBoard()
  whileVisible(ctx, 60_000, () => { void readReviews(); void readHandled() })
  if (location.hash === '#answer') requestAnimationFrame(() => (($('[data-notice]', list) as HTMLElement | null) ?? $('[data-ref="ov.answer"]', root))?.focus?.({ preventScroll: true }))

  return {
    setChains(next, rows) { chains = next; attention = rows; chainsRead = true; paint() },
    diagnosticsChanged() { paint() },
    entries: () => openEntries(),
    leave() {
      // Leaving sends what was held, at once.
      for (const id of [...holds.keys()]) sendHeld(id, true)
      unsubscribe()
      offRequests()
      offBoard()
      offConnection()
      unguard()
      setAnswerGroups(null)
    },
  }
}
