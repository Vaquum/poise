// Answer here (#556, Overview): everything that wants you, with the answers
// on each entry, grouped by who acts and shown to the level you chose. It
// reads its four sources, answers through the service and shows only what the
// service confirms; while your pointer or focus is in it, arrivals wait,
// counted, and nothing moves. Classic's rail (src/views/notification-rail.ts)
// is where the joins and the reads it shares come from.
import type { DiagnosticEvidence } from '../../../../gateway/src/diagnostics/evidence-contract'
import { getBehaviorDiagnostics, isBehaviorStateLoaded } from '../../../behaviors'
import { chatClient, ChatCommandError } from '../../../chat-client'
import { getOrganizations, getSettings, midnightInZone } from '../../../config'
import { patchContent } from '../../../dom-patch'
import { loggingAccess, loggingEvent, loggingWorkImpacts } from '../../../logging'
import { LOCAL_NOTICE_KINDS, noticeFeed, type Notice, type NoticesState } from '../../../notices'
import { notificationItems, type ChainAttentionRow } from '../../../notification-items'
import { registerReloadGuard } from '../../../self-update-guards'
import { placeHref } from '../../address'
import { $, $$, esc } from '../../dom'
import { icon } from '../../icons'
import { paintTerms } from '../../reference'
import { lifeHTML, toast, type Stage } from '../../shell'
import type { PrStatus } from '../board/model'
import {
  decisionEntries, itemEntries, keepEntries, KEPT_DISMISSALS, openDecision, ordered, prStatusesFrom, requestEntries, requestsFrom, restoreEntries, threadEntries, undismissed,
  type DecisionItem, type Entry, type Publication, type RequestsRead, type Role, type ThreadReview,
} from './entries'
import { answersChanged, GROUPS, LEVELS, readLevel, saveLevel, setAnswerGroups, shownAt, tally, type Group } from './level'
import type { Opening } from './targets'
import { ago, clockAt, json, readLine, reason, reportRead, ServiceError, slug, uid, unread, whileVisible, type Read, type PartContext } from './util'

/** How long Dismiss and Silence wait in the tab, which is their Undo. */
export const HOLD_MS = 8000

/** The last read, kept across page loads as Answer here drew it: a reload
 *  paints it at once, calm and unanswerable, and each source's fresh read
 *  replaces its own entries. It stands only for the GitHub user and the
 *  organizations configured, each with its status, it was read under. */
export const LAST_ANSWERS_KEY = 'poise-overview-answers-v2'
/** A kept read is written a moment after what is drawn settles, and again at most this often when nothing changed. */
const KEEP_AFTER_MS = 2_000
const KEEP_AGAIN_MS = 60_000
function answersKey(): string {
  const me = getSettings().me ?? ''
  const configured = getOrganizations().map((org) => `${org.login.toLowerCase()}:${org.status}`).sort().join(',')
  return me ? `${me}|${configured}` : ''
}
function rememberedAnswers(key: string): { at: number, entries: Entry[] } | null {
  if (!key) return null
  try {
    const last = JSON.parse(localStorage.getItem(LAST_ANSWERS_KEY) ?? 'null') as { key?: unknown, at?: unknown, entries?: unknown } | null
    return last?.key === key && typeof last.at === 'number' && Number.isFinite(last.at) ? { at: last.at, entries: restoreEntries(last.entries) } : null
  } catch {
    return null
  }
}
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

interface HandledRow { title: string, note: string, at: number, undo?: string, /** What a put-away entry reported. */ revision?: string }
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
  const threads = new Map<string, { reviews: ThreadReview[], openThreads: number, checkedAt: string | null, error: string }>()
  const handled: Read<ServerHandled[]> = unread()
  /** Put-away entries that are not notices or decisions: key → the revision put away. */
  const dismissals: Read<Map<string, string>> = unread()
  /** Each open pull request's next actor, which decides whom its notice waits on. */
  const prs: Read<Map<string, PrStatus>> = unread()

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
  const holds = new Map<string, { kind: 'dismiss' | 'silence', notice?: Notice, decision?: number, kept?: { key: string, revision: string, title: string }, timer: number }>()
  const opened = new Set<string>()
  const replying = new Set<string>()
  const fresh = new Set<string>()
  const known = new Set<string>()
  const actionIds = new Map<string, string>()
  const impacts = new Map<string, { text: string, at: number }>()
  let autoOpen = false
  /** What the bell focused, drawn with the keyboard's ring until focus leaves it: an entry's id, or 'empty'. */
  let ringed: string | null = null
  let handledOpen = false
  let inFlight = 0
  // The last read, painted at once until each source reads afresh (LAST_ANSWERS_KEY).
  let readKey = answersKey()
  const last = rememberedAnswers(readKey)
  let remembered: Entry[] = last?.entries ?? []
  const rememberedAt = last?.at ?? 0
  let keptRead = { signature: '', at: 0 }
  let keepTimer = 0
  signal.addEventListener('abort', () => window.clearTimeout(keepTimer))

  // ---------- Entries ----------
  function compute(): Entry[] {
    const notices = feed.notices.filter((notice) => feed.enabled || (LOCAL_NOTICE_KINDS as readonly string[]).includes(notice.kind))
    const items = notificationItems(notices, getBehaviorDiagnostics(), Date.now(), attention)
    const reviewed = (reviews.data ?? []).flatMap((publication) => threadEntries(publication, threads.get(publication.slug)?.reviews ?? [], editorHref))
    const read = ordered(undismissed([
      ...itemEntries(items, options.role, chains, prs.data ?? new Map(), Date.now()),
      ...requestEntries(requests.data?.requests ?? [], options.role),
      ...decisionEntries(board.data ?? [], options.role),
      ...reviewed,
    ], dismissals.data ?? new Map()))
    if (!remembered.length) return read
    // A source not yet read afresh in this page shows what it had last time; once every one has, the last read is gone.
    const unreadSources = (Object.keys(readAfresh) as Entry['source'][]).filter((source) => !readAfresh[source]())
    if (!unreadSources.length) { remembered = []; return read }
    const ids = new Set(read.map((entry) => entry.id))
    return ordered([...read, ...remembered.filter((entry) => unreadSources.includes(entry.source) && !ids.has(entry.id))])
  }

  /** Keeps what is drawn, once every source has read afresh in this page: a
   *  moment after it settles, when it changed or a minute since, off the path of any paint. */
  function keepSoon(): void {
    if (remembered.length || !dismissals.data || !(Object.keys(readAfresh) as Entry['source'][]).every((source) => readAfresh[source]())) return
    window.clearTimeout(keepTimer)
    keepTimer = window.setTimeout(() => {
      // A place left, or settings changed since it read, keeps nothing.
      if (signal.aborted || !readKey || answersKey() !== readKey) return
      const signature = JSON.stringify(keepEntries(openEntries()))
      if (signature === keptRead.signature && Date.now() - keptRead.at < KEEP_AGAIN_MS) return
      keptRead = { signature, at: Date.now() }
      try { localStorage.setItem(LAST_ANSWERS_KEY, `{"key":${JSON.stringify(readKey)},"at":${keptRead.at},"entries":${signature}}`) } catch { /* the next page reads it anew */ }
    }, KEEP_AFTER_MS)
  }
  const editorHref = (slugName: string) => placeHref('editor', { doc: slugName, back: 'overview' })

  /** Open at the level: not settled here, not waiting to be sent away. */
  const isOpen = (entry: Entry) => !done.has(entry.id) && !progress.get(entry.id)?.settled
  const openEntries = () => current.filter(isOpen)

  // ---------- Why a request can no longer be answered here ----------
  function unavailable(entry: Entry): string {
    if (entry.source === 'request' && chatClient.connectionState() !== 'open') return 'The connection to Poise dropped. Answers wait until it is back; nothing is sent meanwhile.'
    return ''
  }
  function goneWords(entry: Entry): string {
    if (entry.source === 'request') return 'No longer open: it was answered elsewhere, or its chat cancelled or reset it. Nothing was sent from here.'
    if (entry.source === 'decision') {
      const item = board.data?.find((value) => `decision:${value.id}` === entry.id)
      if (item?.answer) return `Answered elsewhere: “${item.answer.label}”, at ${clockAt(item.answer.at)}. These choices no longer apply.`
      if (item?.resolved) return `Settled in its chat at ${clockAt(item.resolved.at)}: ${item.resolved.reason}`
      if (item?.source.exists === false) return 'The chat that asked no longer exists.'
      return 'No longer open in the Switchboard.'
    }
    if (entry.source === 'thread') return 'Resolved elsewhere, or no longer open on GitHub.'
    if (entry.source === 'chain') return 'The chain has moved on: this no longer needs attention.'
    return 'Cleared: it no longer stands.'
  }

  // ---------- Drawing ----------

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
      const free = q.freeText ? `<input type="text" class="nc-qt" name="${esc(`free-${id}-${qi}`)}" value="${esc(draft.get(`free-${id}-${qi}\u0000`)?.value ?? '')}" placeholder="${q.options.length ? 'Other: your own answer…' : 'Type an answer…'}" aria-label="Your answer to ${esc(q.question)}"${disabled}>` : ''
      return `<fieldset class="nc-q" data-qid="${esc(q.id)}" data-multi="${q.multiSelect ? 1 : 0}"><legend>${q.header ? `<span class="t-micro">${esc(q.header)}</span> ` : ''}${esc(q.question)}</legend>${choices}${free}</fieldset>`
    }).join('')
    return `<form class="nc-form" data-form="${esc(entry.id)}">${fields}<div class="nc-acts"><button type="submit" class="btn btn-primary" data-ref="ov.option"${blocked || sending ? ` aria-disabled="true" data-why="${esc(blocked || sending)}"` : ''}>Submit</button></div></form>`
  }

  function replyHTML(entry: Entry, disabled: string): string {
    const free = entry.freeText!
    const draft = entry.request ? questionDraft(entry).get(`free-${entry.request.id}-0\u0000`)?.value ?? '' : replyDrafts.get(entry.id) ?? ''
    return `<div class="nc-reply"><textarea rows="2" data-reply="${esc(entry.id)}" placeholder="${esc(free.placeholder)}" aria-label="${esc(free.placeholder)}">${esc(draft)}</textarea><div class="nc-acts"><button class="btn btn-primary" data-act="send" data-ref="ov.reply"${disabled || !draft.trim() ? ' aria-disabled="true"' : ''}${disabled ? ` data-why="${esc(disabled)}"` : ''}>${esc(free.send)}</button>${entry.options.length ? '<button class="btn btn-line" data-act="reply-cancel">Cancel</button>' : ''}</div></div>`
  }
  const replyDrafts = new Map<string, string>()

  /** The card's edge, in Board's state colours. */
  const EDGE: Record<Group, string> = { 'needs-you': 'needs-you', fault: 'failed', auto: 'waiting' }
  /** Where Open goes, as Board's icons say it. */
  const openIcon = (open: Opening): string => open.external ? 'external' : /[?&]view=chat\b/.test(open.href) ? 'session' : /[?&]view=board\b/.test(open.href) ? 'card' : /[?&]view=editor\b/.test(open.href) ? 'edit' : 'chev'

  function entryHTML(entry: Entry, gone: string): string {
    const p = progress.get(entry.id)
    const busy = !!p && (p.stage === 'Accepted' || p.stage === 'Queued' || p.stage === 'Executing')
    const closed = gone || unavailable(entry)
    // Painted from the last read: it shows its answers, which wait for its source to read afresh.
    const stale = entry.remembered ? 'Reading what is current: it can be answered once read.' : ''
    const blocked = closed || stale || (p?.uncertain ? 'Not confirmed yet: wait for Poise to read whether it is still open.' : '')
    const off = (why: string) => (why ? ` aria-disabled="true" data-why="${esc(why)}"` : '')
    const isOpenDetail = opened.has(entry.id)
    const answerable = !p?.settled && !busy
    // Only what acts is a button; its digit answers from the keyboard.
    const opts = answerable ? entry.options.map((o, i) => `<button class="btn ${o.primary ? 'btn-primary' : 'btn-line'}" data-act="answer" data-option="${esc(o.key)}" data-ref="ov.option" aria-keyshortcuts="${i + 1}"${off(blocked)}${o.detail ? ` data-help="${esc(o.detail)}"` : ''}>${esc(o.label)}</button>`).join('') : ''
    const typed = !entry.remembered && (!entry.options.length || replying.has(entry.id))
    // Your own words stay on screen while an answer is on its way, so typing
    // goes on; a failed send keeps what is there now.
    const sending = busy ? 'Sending your answer.' : ''
    const reply = !p?.settled && entry.freeText
      ? (typed ? replyHTML(entry, blocked || sending) : answerable ? `<button class="btn btn-line" data-act="reply-open" data-ref="ov.reply"${off(blocked)}>${esc(entry.freeText.label)}</button>` : '')
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
    // Everything else waits under the pointer, as on Board's cards.
    const ib = (inner: string, label: string, attrs: string) => `<${attrs.startsWith('href') ? 'a' : 'button'} class="ib" ${attrs} aria-label="${esc(label)}">${inner}</${attrs.startsWith('href') ? 'a' : 'button'}>`
    // A remembered entry only opens where it lives: nothing on it acts until it is read afresh.
    const acting = !entry.remembered
    const tools = p?.settled ? '' : [
      ...(answerable && acting ? entry.quiet ?? [] : []).map((q) => ib(icon(q.icon, 'sm'), q.label, `data-act="answer" data-option="${esc(q.key)}" data-ref="ov.option"${off(blocked)}`)),
      entry.open ? ib(icon(openIcon(entry.open), 'sm'), entry.open.label, `href="${esc(entry.open.href)}"${entry.open.external ? ' target="_blank" rel="noopener"' : ''} data-act="open" data-ref="ov.open"`) : '',
      entry.github && !entry.open?.external ? ib(icon('external', 'sm'), 'Open on GitHub', `href="${esc(entry.github)}" target="_blank" rel="noopener" data-ref="ov.github"`) : '',
      entry.timeline ? ib(icon('chev', 'sm'), 'Open its timeline', `href="${esc(entry.timeline)}" data-act="open" data-ref="ov.timeline"`) : '',
      entry.diagnostic ? ib(icon('term', 'sm'), 'Open its diagnostic', `href="${esc(diagnosticLink(entry.diagnostic))}" data-act="open" data-ref="ov.diagnostic"`) : '',
      more && acting ? ib(icon('down', 'sm'), isOpenDetail ? 'Show less' : 'Show more', `data-act="more" data-ref="ov.more" aria-expanded="${isOpenDetail}"`) : '',
      entry.silenceable && !busy && acting ? ib(icon('mute', 'sm'), 'Silence reminders', 'data-act="silence" data-ref="ov.silence"') : '',
      entry.dismissable && !busy && acting ? ib(icon('cross', 'sm'), 'Dismiss', `data-act="dismiss" data-ref="ov.dismiss" data-words="${esc(entry.dismissWords)}"`) : '',
    ].join('')
    const titleId = `nt-${slug(entry.id)}`
    const title = entry.open && !p?.settled
      ? `<a class="card-title" id="${titleId}" href="${esc(entry.open.href)}"${entry.open.external ? ' target="_blank" rel="noopener"' : ''} data-act="open">${esc(entry.title)}</a>`
      : `<span class="card-title" id="${titleId}">${esc(entry.title)}</span>`
    const edge = p?.settled || gone ? 'done' : EDGE[entry.group]
    // Its title and line are cut short only where More shows them whole, and never on a question you answer here.
    const clamped = !!more && !isOpenDetail && !(entry.options.length || entry.freeText || entry.questions)
    return `<article class="card nc is-${entry.group}${p?.settled ? ' is-answered' : ''}${fresh.has(entry.id) ? ' is-fresh' : ''}${gone ? ' is-gone' : ''}${clamped ? ' is-clamped' : ''}${entry.remembered ? ' is-remembered' : ''}" data-state="${edge}" data-key="e:${esc(entry.id)}"${ringed === entry.id ? ' data-focus-ring' : ''} data-notice="${esc(entry.id)}" data-ref="ov.notice" tabindex="0" aria-labelledby="${titleId}">
      <h3 class="nc-t">${title}</h3>
      ${entry.detail ? `<p class="nc-d">${esc(entry.detail)}</p>` : ''}
      ${closed && !p?.settled ? `<p class="nc-gone" data-ref="ov.gone">${esc(closed)}</p>` : ''}
      ${body ? `<div class="nc-b">${body}</div>` : ''}
      ${statusHTML(p)}
      ${p?.uncertain && entry.open ? `<p class="nc-fail"><a class="lnk" href="${esc(entry.open.href)}" data-act="open" data-ref="ov.open">${esc(entry.open.label)}</a> to see what happened.</p>` : ''}
      ${acts}${typed ? reply : ''}${form}
      <div class="card-meta"><span class="nc-kind">${esc(entry.kind)}</span>${fresh.has(entry.id) ? '<span class="new">New</span>' : ''}${entry.where ? `<span class="repo">${esc(entry.where)}</span>` : ''}${entry.since ? `<time datetime="${esc(entry.since)}" data-help="${esc(clockAt(entry.since))}">${esc(ago(entry.since))}</time>` : ''}</div>
      ${tools ? `<div class="card-acts">${tools}</div>` : ''}
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
      requests.data && !requests.data.complete ? 'The first 200 chat requests were read, with owner requests first. Open Chat for the rest.' : '',
      readLine('The Switchboard’s decisions', board),
      readLine('Review threads', reviews),
      readLine('Pull requests’ status', prs),
      ...[...threads].flatMap(([name, value]) => value.error ? [`Review threads of ${name} could not be read: ${value.error}`] : []),
      ...(reviews.data ?? []).flatMap((publication) => publication.problems.length ? [`${publication.site} · ${publication.repo}#${publication.pr}: ${publication.problems.join(' ')}${publication.checkedAt ? ` Last checked ${clockAt(publication.checkedAt)}.` : ''}`] : []),
      readLine('Handled today', handled),
      readLine('Put-away entries', dismissals),
    ].filter(Boolean)
    const checked = (reviews.data ?? []).map((publication) => publication.checkedAt).filter((at): at is string => !!at).sort()[0]
    const reviewLine = reviews.data?.length && checked ? `Review threads last checked ${clockAt(checked)}.` : ''
    return lines.length || reviewLine ? `<div class="ocover" data-key="cover" data-ref="ov.read">${[...lines, reviewLine].filter(Boolean).map((line) => `<p>${esc(line)}</p>`).join('')}</div>` : ''
  }

  function listHTML(): string {
    const goneIds = new Set<string>()
    if (holding) {
      const byId = new Map(current.filter((entry) => shownAt(entry.group, level)).map((entry) => [entry.id, entry]))
      // A remembered entry its source's first read no longer lists was loading, not a change: it leaves at once, even under the pointer.
      holding = holding.filter((id) => byId.has(id) || !lastSeen.get(id)?.remembered)
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
    const empty = shown.length ? '' : `<p class="nempty" data-key="empty" tabindex="-1"${ringed === 'empty' ? ' data-focus-ring' : ''}>Nothing ${level === 0 ? 'waits on you' : 'is open at this level'}. ${level < LEVELS.length - 1 ? 'Show more with the control above, or rest.' : 'Rest.'}</p>`
    const rows = handledRows()
    const handledHTML = `<section class="ng is-handled" data-key="g:handled"><h2 class="ng-h"><span class="t-micro">Handled today</span><span class="n">${rows.length}</span><button class="lnk" data-act="handled" aria-expanded="${handledOpen}" data-ref="ov.handled">${handledOpen ? 'Fold' : 'Show'}</button></h2>${handledOpen ? `<ul class="hl">${rows.map((row) => `<li><span class="sdot is-saved"></span><span class="hl-t">${esc(row.title)}</span><span class="hl-n">${esc(row.note)} · ${clockAt(row.at)}</span>${row.undo && holds.has(row.undo) ? `<button class="lnk" data-act="undo" data-undo="${esc(row.undo)}" data-ref="ov.undo">Undo</button>` : ''}</li>`).join('')}</ul>` : ''}</section>`
    return off + groups + empty + coverage() + handledHTML
  }

  // The count of what the level shows is the heading's; each group heading counts its own.
  function levelHTML(): string {
    return `<div class="seg olevel" role="radiogroup" aria-label="How much to show" data-ref="ov.level">${LEVELS.map(([name, gloss], i) => `<button role="radio" aria-checked="${i === level}" aria-pressed="${i === level}" tabindex="${i === level ? 0 : -1}" data-level="${i}" data-gloss="${esc(gloss)}">${esc(name)}</button>`).join('')}</div>`
  }

  // A source's first read is the list loading, not an arrival: its entries
  // join the list at once, unmarked, even while you are in it.
  const ready: Record<Entry['source'], () => boolean> = {
    notice: () => noticeFeed.answered, diagnostic: () => !!getBehaviorDiagnostics(), chain: () => chainsRead,
    request: () => !!requests.data, decision: () => !!board.data, thread: () => !!reviews.data,
  }
  const seeded = new Set<Entry['source']>()
  let chainsRead = false
  /** Read afresh, successfully, in this page: only that replaces a source's last read, and only then is the list kept.
   *  A failed read answers too (Behaviors' diagnostics carry its failure, a document's threads their error), but stands for nothing. */
  const readAfresh: Record<Entry['source'], () => boolean> = {
    notice: () => noticeFeed.answered, diagnostic: () => isBehaviorStateLoaded(), chain: () => chainsRead,
    request: () => !!requests.data, decision: () => !!board.data, thread: () => !!reviews.data && [...threads.values()].every((read) => !read.error),
  }
  // Settings read afresh may name another GitHub user or other organizations than the page opened on:
  // the last read no longer stands, and this page keeps nothing.
  window.addEventListener('poise:settings-read', () => {
    if (!readKey || answersKey() === readKey) return
    readKey = ''
    window.clearTimeout(keepTimer)
    if (remembered.length) { remembered = []; paint() }
  }, { signal })

  function paint(): void {
    current = compute()
    for (const entry of current) {
      if (known.has(entry.id)) continue
      known.add(entry.id)
      if (seeded.has(entry.source)) fresh.add(entry.id)
      else if (holding) holding = current.filter((value) => holding!.includes(value.id) || value.id === entry.id).map((value) => value.id)
    }
    for (const source of Object.keys(ready) as Entry['source'][]) if (ready[source]()) seeded.add(source)
    for (const [id, row] of [...done]) {
      const now = current.find((entry) => entry.id === id)
      if (!now) { if (!progress.get(id)?.settled) done.delete(id); continue }
      // What it reports changed while it was being put away: the new report shows,
      // and only the old one is put away.
      if (row.revision !== undefined && now.revision !== row.revision) forgetHold(id)
    }
    forgetCleared()
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null
    patchContent(list, listHTML())
    if (focused && !focused.isConnected) {
      const id = focused.closest<HTMLElement>('[data-notice]')?.dataset.notice
      let next = (id ? $(`[data-notice="${CSS.escape(id)}"]`, list) : null) as HTMLElement | null
      // The empty state gave way to entries, as when the first read lands after the bell: focus moves to the first.
      if (!next && focused.dataset.key === 'empty') next = ($('[data-notice]', list) ?? $('[data-key="empty"]', list)) as HTMLElement | null
      if (next && ringed !== null && (ringed === id || ringed === 'empty')) { ringed = next.dataset.notice ?? 'empty'; next.dataset.focusRing = '' }
      next?.focus({ preventScroll: true })
    }
    paintTerms(list)
    const levelBox = $('[data-levelbox]', root)
    if (levelBox && levelBox.dataset.shown !== String(level)) { levelBox.innerHTML = levelHTML(); levelBox.dataset.shown = String(level) }
    const count = $('[data-ncount]', root)
    const t = tally(openEntries().map((entry) => entry.group), level)
    if (count) { count.textContent = String(t.count); if (t.tone) count.dataset.tone = t.tone; else delete count.dataset.tone }
    const heldEl = $('[data-held]', root)
    const waiting = holding ? current.filter((entry) => shownAt(entry.group, level) && isOpen(entry) && !holding!.includes(entry.id)).length : 0
    // While any entry is from the last read, the heading's line says when that was, in the place the count of new ones takes.
    const lastRead = current.some((entry) => entry.remembered) ? `<span data-ref="ov.remembered">Last read ${esc(clockAt(rememberedAt))}</span>` : ''
    if (heldEl) {
      const note = waiting ? `${waiting} new · <button class="lnk" data-act="release">Show now</button>` : lastRead
      heldEl.classList.toggle('is-none', !note)
      heldEl.setAttribute('aria-hidden', String(!note))
      heldEl.innerHTML = note
    }
    answersChanged()
    options.onEntries(openEntries())
    keepSoon()
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
  /** `revision`, for a card being put away: only that report goes; an answer settles the card whatever it reports next. */
  /** What Handled today calls it: a chain's reason or a pull request's title says where only with its place. */
  const handledTitle = (entry: Entry): string => (entry.source === 'chain' || entry.pull) && entry.where ? `${entry.where} · ${entry.title}` : entry.title
  function settle(entry: Entry, label: string, words: string, extra: Partial<Progress> = {}, revision?: string): void {
    const row: HandledRow = { title: handledTitle(entry), note: `${label} · ${words}`, at: Date.now(), ...(extra.undo ? { undo: entry.id } : {}),
      ...(revision !== undefined ? { revision } : {}) }
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
    if (entry.remembered) return
    const p = progress.get(entry.id)
    if (p && p.stage !== 'Failed') return
    if (p?.uncertain) return
    const option = key === null ? null : entry.options.find((o) => o.key === key) ?? entry.quiet?.find((q) => q.key === key)
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
        if (Array.isArray(result.reviews)) threads.set(entry.thread.slug, { reviews: result.reviews, openThreads: before?.openThreads ?? 0, checkedAt: before?.checkedAt ?? null, error: '' })
        replyDrafts.delete(entry.id)
        settle(entry, label, key === 'resolve' ? 'Resolved on GitHub' : 'Replied on GitHub, as you')
      } else if (entry.chain) {
        await json('/api/behavior-chains', { method: 'POST', body: JSON.stringify({ id: entry.chain.id, sequence: entry.chain.sequence, operation: 'resume' }) })
        settle(entry, label, 'Resumed: the chain proceeds under its own gates')
        options.chainsChanged()
      } else if (entry.pull && key === 'approve') {
        await approvePull(entry, label)
      } else {
        throw new Error('This answer is not available here.')
      }
    } catch (error) {
      fail(entry, label, error)
    } finally {
      inFlight -= 1
    }
  }

  // Approval acts as you, on the head Poise read, under one actionId
  // that a repeat reuses: the service reconciles and never acts twice.
  async function approvePull(entry: Entry, label: string): Promise<void> {
    const pull = entry.pull!
    const actionKey = `${pull.repo}#${pull.number}`
    setProgress(entry.id, { stage: 'Accepted', label, words: 'reading its head commit', at: Date.now() })
    const read = await json<{ held?: { repo: string, number: number, head: string | null }[] }>('/api/gh', { method: 'POST', body: JSON.stringify({ operation: 'green_pr' }) })
    const head = read.held?.find((row) => row.repo.toLowerCase() === pull.repo.toLowerCase() && row.number === pull.number)?.head
    if (!head) throw new Error('Poise could not read this pull request’s head commit, so nothing was sent. Open it on GitHub.')
    const actionId = actionIds.get(actionKey) ?? uid()
    actionIds.set(actionKey, actionId)
    setProgress(entry.id, { stage: 'Executing', label, words: 'approving, as you', at: Date.now() })
    const response = await fetch('/api/pull-requests/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ repo: pull.repo, number: pull.number, expectedHeadSha: head, actionId }) })
    const body = await response.json().catch(() => null) as Record<string, any> | null
    const outcome = String(body?.outcome ?? '')
    const short = (sha: unknown) => typeof sha === 'string' ? sha.slice(0, 7) : 'unknown'
    if (outcome === 'unknown') {
      setProgress(entry.id, { stage: 'Failed', label, words: 'Not confirmed: GitHub did not confirm the approval. Pressing again checks under the same action and never acts twice.', at: Date.now() })
      return
    }
    actionIds.delete(actionKey)
    const words: Record<string, string> = {
      approved: `Approved as ${body?.actor ?? 'you'}`, already_approved: `Already approved as ${body?.actor ?? 'you'}`,
    }
    if (response.ok && words[outcome]) { settle(entry, label, words[outcome]); return }
    if (outcome === 'superseded') throw new Error(`New commits arrived: its head moved from ${short(body?.expectedHead)} to ${short(body?.actualHead)}. Review the current head before approving.`)
    throw new ServiceError(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`, response.status, body)
  }

  // ---------- Dismiss and Silence: held for eight seconds, with Undo ----------
  function holdSend(entry: Entry, kind: 'dismiss' | 'silence'): void {
    if (entry.remembered) return
    const kept = kind === 'dismiss' && KEPT_DISMISSALS.includes(entry.source) ? { key: entry.id, revision: entry.revision, title: handledTitle(entry) } : undefined
    if (!(entry.notice || entry.decision || kept) || holds.has(entry.id)) return
    const timer = window.setTimeout(() => sendHeld(entry.id), HOLD_MS)
    holds.set(entry.id, { kind, notice: entry.notice, decision: entry.decision?.id, kept, timer })
    settle(entry, kind === 'dismiss' ? 'Dismissed' : 'Silenced', kind === 'dismiss' ? `Put away: ${entry.dismissWords}` : 'No more reminders while it stays open', { undo: true }, kept?.revision)
  }
  /** An entry whose report changed mid-hold: its hold goes, its new report shows. */
  function forgetHold(id: string): void {
    const hold = holds.get(id)
    if (hold) { window.clearTimeout(hold.timer); holds.delete(id) }
    done.delete(id)
    progress.delete(id)
    const at = settledHere.findIndex((row) => row.undo === id)
    if (at >= 0) settledHere.splice(at, 1)
  }

  // A diagnostic with no time of its own reports the same key and revision when
  // it recurs: once a successful read no longer lists it, its dismissal goes.
  const forgetting = new Set<string>()
  function forgetCleared(): void {
    if (!dismissals.data || !isBehaviorStateLoaded() || !getBehaviorDiagnostics()) return
    const listed = new Set(current.filter((entry) => entry.source === 'diagnostic').map((entry) => entry.id))
    const hidden = new Set(itemEntries(notificationItems([], getBehaviorDiagnostics(), Date.now(), []), options.role, chains).map((entry) => entry.id))
    const keys = [...dismissals.data.keys()].filter((key) => key.startsWith('diagnostic:') && !listed.has(key) && !hidden.has(key) && !forgetting.has(key)).slice(0, 200)
    if (!keys.length) return
    // Gone from its source, it leaves this tab's settled list too, so a recurrence shows.
    for (const key of keys) {
      forgetting.add(key)
      if (!holds.has(key)) { done.delete(key); progress.delete(key) }
    }
    void json<{ dismissals?: { key: string, revision: string }[] }>('/api/answers/dismissals/forget', { method: 'POST', body: JSON.stringify({ keys }) })
      .then(acceptDismissals, () => undefined).finally(() => { for (const key of keys) forgetting.delete(key) })
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
    const { notice, decision, kept } = hold
    const action = kept
      ? json<{ dismissals?: { key: string, revision: string }[] }>('/api/answers/dismissals', { method: 'POST', body: JSON.stringify(kept), keepalive: leaving })
        .then(acceptDismissals, () => undefined)
      : decision !== undefined
        ? chatClient.dismissSwitchboardItem(decision).then((state) => { const next = parseBoard(state); if (next) acceptBoard(next) }, () => undefined)
        : hold.kind === 'dismiss' ? noticeFeed.dismiss(notice!.id) : noticeFeed.silence(notice!.id)
    if (leaving) return
    paint()
    void action.then(() => {
      // Put away when the next read omits it; one still there could not be.
      const still = kept
        ? dismissals.data?.get(kept.key) !== kept.revision
        : decision !== undefined
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
      if (hold.kept) {
        void fetch('/api/answers/dismissals', { method: 'POST', keepalive: true, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(hold.kept) }).catch(() => undefined)
        continue
      }
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
        // Read again when the sweep checked it since: a reply brings a put-away thread back.
        if (before && before.openThreads === publication.openThreads && before.checkedAt === publication.checkedAt && !before.error) continue
        try {
          const cached = await json<{ reviews?: ThreadReview[] }>(`/api/editor/doc/${encodeURIComponent(publication.slug)}/reviews`)
          threads.set(publication.slug, { reviews: Array.isArray(cached.reviews) ? cached.reviews : [], openThreads: publication.openThreads, checkedAt: publication.checkedAt, error: '' })
        } catch (error) {
          threads.set(publication.slug, { reviews: before?.reviews ?? [], openThreads: publication.openThreads, checkedAt: publication.checkedAt, error: reason(error) })
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

  function acceptDismissals(data: { dismissals?: { key: string, revision: string }[] }): void {
    if (!Array.isArray(data.dismissals)) throw new Error('the service answered with something this page cannot read')
    dismissals.data = new Map(data.dismissals.map((row) => [row.key, row.revision]))
    dismissals.error = ''
    dismissals.at = Date.now()
  }
  async function readDismissals(): Promise<void> {
    try {
      acceptDismissals(await json<{ dismissals?: { key: string, revision: string }[] }>('/api/answers/dismissals'))
    } catch (error) {
      dismissals.error = reason(error)
    }
    reportRead(ctx, 'overview-dismissals', 'Put-away entries could not be read', dismissals)
    paint()
  }

  async function readPrs(): Promise<void> {
    try {
      prs.data = prStatusesFrom(await json('/api/behavior-ledger/pr-status?limit=100'), prs.data)
      prs.error = ''
      prs.at = Date.now()
    } catch (error) {
      prs.error = reason(error)
    }
    reportRead(ctx, 'overview-prs', 'Pull requests’ status could not be read', prs)
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
  whileVisible(ctx, 60_000, () => { void readReviews(); void readHandled(); void readDismissals(); void readPrs() })
  // The bell, here or from another place: Answer here at its top, focus on its
  // first entry, or on its empty state, with the ring keyboard focus shows.
  function bringToFirst(): void {
    list.scrollTop = 0
    root.scrollIntoView({ block: 'start' })
    const card = $('[data-notice]', list) as HTMLElement | null
    ringed = card ? card.dataset.notice! : 'empty'
    const target = (card ?? $('[data-key="empty"]', list) ?? $('[data-ref="ov.answer"]', root)) as HTMLElement | null
    if (!target) return
    target.dataset.focusRing = ''
    target.focus({ preventScroll: true })
  }
  // The ring stays while focus does, through every redraw, and goes when focus leaves.
  list.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (ringed === null) return
      const active = document.activeElement as HTMLElement | null
      const at = active && list.contains(active) ? active.dataset.notice ?? (active.dataset.key === 'empty' ? 'empty' : null) : null
      if (at === ringed) return
      ringed = null
      for (const el of list.querySelectorAll<HTMLElement>('[data-focus-ring]')) delete el.dataset.focusRing
    })
  }, { signal })
  document.addEventListener('poise:answer-here', bringToFirst, { signal })
  if (location.hash === '#answer') requestAnimationFrame(bringToFirst)

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
