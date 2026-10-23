// Inline threads: passage and review chats that open under their text.
// The thread is never a child of #editor-doc — serializeDoc() joins every
// child of the doc as a source line, and other code treats those children
// as lines too — so it renders in a layer, .editor-inline-threads, inside
// .editor-page, beside #editor-doc. The layer is not aria-hidden, so markers
// and drafts stay visible to assistive technology and the self-update guard.
//
// Room for the thread is a padding-bottom equal to the thread's height, set
// inline on the passage's last .editor-line. A MutationObserver keeps the
// padding on exactly that line; a ResizeObserver on the thread and on
// #editor-doc repositions the thread and keeps the padding in sync. Each
// change dispatches editor:inline-thread-moved, and the Editor redraws its
// annotation and review marks, so stale marks never sit over the thread.
//
// One thread is open at a time. Opening another keeps the first one's draft
// for its subject while the page lives. A closed passage chat with a session
// shows a margin marker in the layer, fed by the session's status and events
// on the shared client. Review chats reopen from their underline or list
// item, so they show no marker.
import { chatClient } from '../chat-client'
import type { ChatEnvelope, ChatSubject } from '../../server/chat/protocol'
import type { ComposerDraft } from './chat-composer'
import { mountSessionSurface, type SessionSurface, type SurfaceOptions } from './chat-session-surface'
import { chatSidePane } from './chat-side-pane'

export interface InlineThreadOptions {
  page: HTMLElement
  doc: HTMLElement
  line: HTMLElement
  range: { start: number, end: number }
  subject: ChatSubject
  note?: { value: string, label: string, onInput(value: string): void }
  header?: (section: HTMLElement) => void
  inFlowAfter?: HTMLElement
  edits: SurfaceOptions['edits']
  beforeSend: () => Promise<void>
}

function subjectKey(subject: ChatSubject): string {
  return `${subject.surface}:${subject.key}`
}

interface OpenThread {
  thread: HTMLElement
  surface: SessionSurface
  subject: ChatSubject
  key: string
  page: HTMLElement
  doc: HTMLElement
  line: HTMLElement
  lineIndex: number
  range: { start: number, end: number }
  sessionId: string | null
  status: string | null
  inFlow: boolean
  onState: (event: Event) => void
  onKey: (event: KeyboardEvent) => void
  mutObserver: MutationObserver | null
  resizeObserver: ResizeObserver | null
}

interface Tracked {
  subject: ChatSubject
  sessionId: string | null
  status: string | null
  pendingRequests: Set<string>
  page: HTMLElement
  first: HTMLElement
  firstIndex: number
  last: HTMLElement
  el: HTMLButtonElement | null
  unsubscribe: (() => void) | null
}

let open: OpenThread | null = null
/** Unsent drafts by subject, while the page lives. */
const drafts = new Map<string, ComposerDraft>()
/** Closed passage chats under watch, with or without a marker on screen. A
 *  chat is tracked from close until its thread reopens: later activity grows
 *  a marker, and the Editor's overlay pass moves it with its passage. */
const tracked = new Map<string, Tracked>()
/** Latest finish not yet acknowledged by a surface's read cursor. */
const unseenReply = new Map<string, number>()
/** The chat is open in the side pane. */
const inPane = new Set<string>()
/** The passage can no longer be located. */
const passageChanged = new Set<string>()

if (typeof window !== 'undefined') {
  window.addEventListener('chat:side-pane-closed', (event) => {
    const detail = (event as CustomEvent<{ subject: ChatSubject, sessionId?: string | null, status?: string | null, afterSeq?: number, pendingRequests?: string[], draft: ComposerDraft | null }>).detail
    const subject = detail?.subject
    if (!subject) return
    const closedKey = subjectKey(subject)
    // The pane owns the newest composer snapshot, including an explicit
    // empty draft, even if navigation already cleared its tracking.
    if (subject.surface === 'editor-passage' || subject.surface === 'editor-review') keepThreadDraft(subject, detail.draft)
    // A retained tracker also hears replies the pane displayed. Clear only
    // those the surface actually applied; buffered or later replies stay new.
    const finishedSeq = unseenReply.get(closedKey)
    if (finishedSeq !== undefined && finishedSeq <= (detail.afterSeq ?? 0)) unseenReply.delete(closedKey)
    if (!inPane.has(closedKey)) return
    inPane.delete(closedKey)
    const entry = tracked.get(closedKey)
    if (!entry) return
    // A chat moved to the pane before its first message has no sessionId
    // yet; adopt the pane's session so a running or finished reply still
    // marks. A chat that never got a session leaves nothing to track.
    if (!entry.sessionId) {
      const sessionId = detail?.sessionId ?? null
      if (!sessionId) {
        untrack(closedKey)
        layoutMarkers(entry.page)
        return
      }
      track(subject, sessionId, entry.page, entry.first, detail?.status ?? null, detail?.afterSeq ?? 0, detail.pendingRequests)
      return
    }
    if (detail.pendingRequests) entry.pendingRequests = new Set(detail.pendingRequests)
    renderMarker(closedKey)
  })
}

function ensureLayer(page: HTMLElement): HTMLElement {
  let layer = page.querySelector<HTMLElement>(':scope > .editor-inline-threads')
  if (!layer) {
    layer = document.createElement('div')
    layer.className = 'editor-inline-threads'
    page.appendChild(layer)
  }
  return layer
}

function lineIndexOf(doc: HTMLElement, line: HTMLElement): number {
  return Math.max(0, Array.from(doc.children).indexOf(line))
}

function linesOf(doc: HTMLElement): HTMLElement[] {
  return Array.from(doc.children) as HTMLElement[]
}

// ── Positioning ──────────────────────────────────────────────────────

// Page-local rect of an element inside the page.
function pageRect(page: HTMLElement, el: HTMLElement): { top: number, bottom: number, left: number, width: number } {
  const pageBox = page.getBoundingClientRect()
  const box = el.getBoundingClientRect()
  return { top: box.top - pageBox.top, bottom: box.bottom - pageBox.top, left: box.left - pageBox.left, width: box.width }
}

function layoutThread(state: OpenThread): void {
  if (state.inFlow) return
  // The tracked line may be gone (its text was deleted). Fall back to the
  // stored index, clamped into the document; an empty document keeps the
  // thread hidden until text returns.
  if (!state.line.isConnected) {
    const lines = linesOf(state.doc)
    if (!lines.length) { state.thread.hidden = true; return }
    state.lineIndex = Math.max(0, Math.min(state.lineIndex, lines.length - 1))
    state.line = lines[state.lineIndex]!
  }
  state.thread.hidden = false
  const height = state.thread.offsetHeight
  state.line.style.paddingBottom = `${height + 16}px`
  const box = pageRect(state.page, state.line)
  // The thread sits in the gap its own padding makes: its top is 8 px below
  // the line's text, within 16 px of the bottom of the source line, and the
  // next line moved down by at least the thread's height.
  state.thread.style.top = `${box.bottom - (height + 16) + 8}px`
  // The notch points at the passage's first character: proportionally across
  // the line, clamped into the thread.
  const textLength = Math.max(1, state.line.textContent?.length || 1)
  const frac = Math.max(0, Math.min(1, state.range.start / textLength))
  const notch = state.thread.querySelector<HTMLElement>('.editor-inline-thread-notch')
  if (notch) notch.style.left = `${Math.max(12, Math.min(state.thread.offsetWidth - 12, box.left + frac * box.width))}px`
  state.page.dispatchEvent(new CustomEvent('editor:inline-thread-moved', { bubbles: true }))
}

function observeThread(state: OpenThread): void {
  // Keep the padding on exactly the tracked line, and the thread under it.
  // Typing above the thread shifts the lines without resizing the doc or
  // touching its children, so text changes reposition too. A native Enter
  // split copies the style onto the new line; strip it there.
  state.mutObserver = new MutationObserver(() => {
    for (const child of linesOf(state.doc)) {
      if (child !== state.line && child.style.paddingBottom) child.style.paddingBottom = ''
    }
    layoutThread(state)
  })
  state.mutObserver.observe(state.doc, { childList: true, subtree: true, characterData: true })
  // Wrapping, font and window-size changes mutate nothing but move the
  // lines; reposition on every size change instead.
  state.resizeObserver = new ResizeObserver(() => layoutThread(state))
  state.resizeObserver.observe(state.thread)
  state.resizeObserver.observe(state.doc)
}

// ── Markers ────────────────────────────────────────────────────────────

function markerLabel(key: string, sessionId: string | null, status: string | null): string | null {
  if (inPane.has(key)) return 'In side pane'
  if (passageChanged.has(key)) return 'Passage changed'
  if (tracked.get(key)?.pendingRequests.size) return 'Needs you'
  if (sessionId && (status === 'running' || status === 'starting')) return 'Working'
  if (unseenReply.has(key)) return 'New reply'
  return null
}

function layoutMarkers(page: HTMLElement): void {
  const layer = page.querySelector<HTMLElement>(':scope > .editor-inline-threads')
  if (!layer) return
  const pageBox = page.getBoundingClientRect()
  // Markers sit in the right margin while there is room for them; on narrow
  // screens they sit after the passage's last line instead. Markers on one
  // line stack.
  const narrow = window.innerWidth - pageBox.right < 140
  const stride = new Map<number, number>()
  for (const entry of tracked.values()) {
    if (entry.page !== page || !entry.el) continue
    if (!entry.first.isConnected || !entry.last.isConnected) {
      entry.el.hidden = true
      continue
    }
    entry.el.hidden = false
    const first = pageRect(page, entry.first)
    if (narrow) {
      const last = pageRect(page, entry.last)
      entry.el.style.left = `${first.left}px`
      entry.el.style.top = `${last.bottom + 4}px`
    } else {
      const slot = stride.get(entry.firstIndex) || 0
      stride.set(entry.firstIndex, slot + 1)
      entry.el.style.left = `${pageBox.width + 12}px`
      entry.el.style.top = `${first.top + slot * (entry.el.offsetHeight + 6)}px`
    }
  }
}

function renderMarker(key: string): void {
  const entry = tracked.get(key)
  if (!entry) return
  const label = markerLabel(key, entry.sessionId, entry.status)
  if (!label) {
    entry.el?.remove()
    entry.el = null
    return
  }
  if (!entry.el) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'editor-thread-marker'
    el.addEventListener('click', () => {
      // A chat open in the pane moves back like its Back button; a closed
      // chat opens in place.
      window.dispatchEvent(new CustomEvent(inPane.has(key) ? 'editor:inline-thread-back' : 'editor:inline-thread-open', {
        detail: { subject: entry.subject },
      }))
    })
    ensureLayer(entry.page).appendChild(el)
    entry.el = el
  }
  entry.el.textContent = label
  entry.el.dataset.label = label
  layoutMarkers(entry.page)
}

function untrack(key: string): void {
  const entry = tracked.get(key)
  if (!entry) return
  entry.el?.remove()
  entry.unsubscribe?.()
  tracked.delete(key)
  unseenReply.delete(key)
}

/** Watch a closed passage chat: later activity grows a marker, and the
 *  Editor's overlay pass moves it with its passage. Anything without news
 *  shows no marker. */
function track(subject: ChatSubject, sessionId: string | null, page: HTMLElement, line: HTMLElement, status: string | null, afterSeq?: number, pendingRequests?: readonly string[]): void {
  if (subject.surface !== 'editor-passage') return
  const key = subjectKey(subject)
  if (open?.key === key) return
  let entry = tracked.get(key)
  if (!entry) {
    entry = {
      subject, sessionId, status, pendingRequests: new Set(pendingRequests), page, first: line,
      firstIndex: lineIndexOf(line.parentElement as HTMLElement, line), last: line, el: null, unsubscribe: null,
    }
    tracked.set(key, entry)
  } else {
    entry.sessionId = sessionId ?? entry.sessionId
    entry.status = status
    entry.page = page
    entry.first = line
    entry.firstIndex = lineIndexOf(line.parentElement as HTMLElement, line)
    entry.last = line
    if (pendingRequests) entry.pendingRequests = new Set(pendingRequests)
  }
  if (entry.sessionId && !entry.unsubscribe) {
    // Resubscribe from what the surface already showed: from 0 the server
    // replays the whole transcript and every historical turn.finished would
    // raise a spurious New reply marker.
    const id = entry.sessionId
    chatClient.subscribe(id, afterSeq ?? chatClient.subscribedAfter(id) ?? 0)
    const off = chatClient.on('event', (envelope: ChatEnvelope) => {
      if (envelope.sessionId !== id) return
      const event = envelope.event
      const live = tracked.get(key)
      if (!live) return
      if (event.type === 'turn.finished') unseenReply.set(key, Math.max(unseenReply.get(key) ?? 0, envelope.seq))
      else if (event.type === 'permission.requested' || event.type === 'question.asked') live.pendingRequests.add(event.id)
      else if (event.type === 'permission.resolved' || event.type === 'question.answered') live.pendingRequests.delete(event.id)
      else if (event.type === 'session.updated') live.status = event.session.status
      else if (event.type === 'session.reset') { unseenReply.delete(key); live.pendingRequests.clear() }
      else return
      renderMarker(key)
    })
    entry.unsubscribe = () => { off(); chatClient.unsubscribe(id) }
  }
  renderMarker(key)
}

// ── Open / close / move ────────────────────────────────────────────────

function teardown(state: OpenThread): void {
  state.mutObserver?.disconnect()
  state.resizeObserver?.disconnect()
  state.thread.removeEventListener('chat:surface-state', state.onState)
  state.thread.removeEventListener('keydown', state.onKey)
  if (state.line.isConnected && !state.inFlow) state.line.style.paddingBottom = ''
  const draft = state.surface.takeDraft()
  if (draft) drafts.set(state.key, draft)
  else drafts.delete(state.key)
  state.surface.destroy()
  state.thread.remove()
  state.page.dispatchEvent(new CustomEvent('editor:inline-thread-moved', { bubbles: true }))
}

function fireClosed(state: OpenThread, returnCaret: boolean): void {
  window.dispatchEvent(new CustomEvent('editor:inline-thread-closed', {
    detail: { subject: state.subject, returnCaret, sessionId: state.sessionId },
  }))
}

function closeState(state: OpenThread, returnCaret: boolean): void {
  const afterSeq = state.surface.lastSeq()
  const pendingRequests = state.surface.pendingRequests()
  teardown(state)
  if (state.sessionId) track(state.subject, state.sessionId, state.page, state.line, state.status, afterSeq, pendingRequests)
  fireClosed(state, returnCaret)
}

/** Close the open thread, if any. Closing never stops a turn. */
export function closeInlineThread(): void {
  const state = open
  if (!state) return
  open = null
  closeState(state, false)
}

/** Close the thread and drop every marker and subscription, for a document
 *  switch. Drafts stay while the page lives. The closed event still fires,
 *  so the discard rule runs as for any close. */
export function clearInlineThreads(): void {
  const state = open
  open = null
  if (state) {
    teardown(state)
    fireClosed(state, false)
  }
  for (const key of [...tracked.keys()]) untrack(key)
  inPane.clear()
  passageChanged.clear()
}

/** Drop one subject's tracking, marker and draft, for a delete. */
export function dropThread(subject: ChatSubject): void {
  const key = subjectKey(subject)
  untrack(key)
  drafts.delete(key)
  inPane.delete(key)
  passageChanged.delete(key)
}

/** Stage a draft for a subject, so reopening its thread restores it. The
 *  side pane's Back button stages the pane's draft this way. */
export function keepThreadDraft(subject: ChatSubject, draft: ComposerDraft | null): void {
  if (draft) drafts.set(subjectKey(subject), draft)
  else drafts.delete(subjectKey(subject))
}

export function hasThreadDraft(subject: ChatSubject): boolean {
  return drafts.has(subjectKey(subject))
}

/** Move the tracked chat for a subject, from the Editor's overlay pass.
 *  Untracked subjects are ignored; a newly unlocatable passage grows its
 *  Passage changed marker here. */
export function syncThreadMarker(subject: ChatSubject, position: { first: HTMLElement, last: HTMLElement, changed: boolean }): void {
  const key = subjectKey(subject)
  const entry = tracked.get(key)
  if (!entry) return
  if (position.changed) passageChanged.add(key)
  else passageChanged.delete(key)
  entry.first = position.first
  entry.last = position.last
  entry.firstIndex = lineIndexOf(position.first.parentElement as HTMLElement, position.first)
  renderMarker(key)
}

/** The open thread's session, for the notification rail. */
export function inlineThreadSessionInView(): string | null {
  return open && !open.page.closest('[hidden]') ? open.sessionId : null
}

/** The open thread's subject, if any. */
export function inlineThreadSubjectInView(): ChatSubject | null {
  return open?.subject ?? null
}

export function openInlineThread(options: InlineThreadOptions): { close(returnCaret: boolean): void, toSidePane(): void } {
  // One thread is open at a time. Closing first fires the closed event, so
  // the Editor's discard rule runs before the new thread opens.
  if (open) {
    const previous = open
    open = null
    closeState(previous, false)
  }
  const key = subjectKey(options.subject)
  untrack(key)
  inPane.delete(key)

  const thread = document.createElement('div')
  thread.className = 'editor-inline-thread'
  thread.setAttribute('role', 'dialog')
  thread.setAttribute('aria-label', options.subject.surface === 'editor-review' ? 'Review comment' : 'Passage chat')
  const headerEl = document.createElement('div')
  headerEl.className = 'editor-inline-thread-header'
  for (const [label, name] of [['Move to the side pane', 'move'], ['Open in Chat', 'open'], ['Close', 'close']] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `editor-inline-thread-${name}`
    button.textContent = label
    button.addEventListener('click', () => {
      if (name === 'close') api.close(true)
      else if (name === 'open') {
        const draft = state.surface.takeDraft()
        window.dispatchEvent(new CustomEvent('poise:open-chat-session', {
          detail: { subject: options.subject, ...(draft ? { draft } : {}) },
        }))
      } else api.toSidePane()
    })
    headerEl.appendChild(button)
  }
  thread.appendChild(headerEl)
  if (options.header) {
    const section = document.createElement('div')
    section.className = 'editor-inline-thread-section editor-inline-thread-head'
    thread.appendChild(section)
    options.header(section)
  }
  if (options.note) {
    const section = document.createElement('div')
    section.className = 'editor-inline-thread-section editor-inline-thread-note'
    const label = document.createElement('label')
    label.textContent = options.note.label
    const area = document.createElement('textarea')
    // The panel's class: the annotations spec finds the note through it.
    area.className = 'editor-annotation-text'
    area.rows = 3
    area.placeholder = 'Add a comment…'
    area.value = options.note.value
    const onInput = options.note.onInput
    area.addEventListener('input', () => onInput(area.value))
    label.appendChild(area)
    section.appendChild(label)
    thread.appendChild(section)
  }
  if (options.subject.surface === 'editor-review') {
    const caption = document.createElement('div')
    caption.className = 'editor-inline-thread-private'
    caption.textContent = 'Private agent thread · not posted to GitHub'
    thread.appendChild(caption)
  }
  const surfaceEl = document.createElement('div')
  surfaceEl.className = 'editor-inline-thread-surface'
  thread.appendChild(surfaceEl)
  const notch = document.createElement('div')
  notch.className = 'editor-inline-thread-notch'
  notch.setAttribute('aria-hidden', 'true')
  thread.appendChild(notch)

  const inFlow = !!options.inFlowAfter
  if (inFlow) {
    thread.classList.add('editor-inline-thread-flow')
    options.inFlowAfter!.after(thread)
  } else {
    ensureLayer(options.page).appendChild(thread)
  }

  const state: OpenThread = {
    thread,
    surface: mountSessionSurface(surfaceEl, {
      subject: options.subject,
      ...(drafts.get(key) ? { draft: drafts.get(key)! } : {}),
      ...(options.edits ? { edits: options.edits } : {}),
      ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
    }),
    subject: options.subject, key,
    page: options.page, doc: options.doc, line: options.line, lineIndex: lineIndexOf(options.doc, options.line),
    range: options.range, sessionId: null, status: null, inFlow,
    onState: (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string | null, status: string | null }>).detail
      state.sessionId = detail.sessionId
      state.status = detail.status
    },
    onKey: (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        api.close(true)
      }
    },
    mutObserver: null, resizeObserver: null,
  }
  thread.addEventListener('chat:surface-state', state.onState as EventListener)
  thread.addEventListener('keydown', state.onKey)

  const api = {
    close(returnCaret: boolean): void {
      if (open !== state) return
      open = null
      closeState(state, returnCaret)
    },
    toSidePane(): void {
      if (open !== state) return
      open = null
      const draft = state.surface.takeDraft()
      keepThreadDraft(state.subject, draft)
      const sessionId = state.sessionId
      const status = state.status
      const subject = state.subject
      const page = state.page
      const line = state.line
      const afterSeq = state.surface.lastSeq()
      const pendingRequests = state.surface.pendingRequests()
      teardown(state)
      // The chat is open in the pane now; its marker reads In side pane.
      inPane.add(key)
      track(subject, sessionId, page, line, status, afterSeq, pendingRequests)
      chatSidePane.close()
      chatSidePane.toggle({ subject, draft, back: () => {
        window.dispatchEvent(new CustomEvent('editor:inline-thread-back', { detail: { subject } }))
      } })
    },
  }
  open = state
  if (!inFlow) {
    observeThread(state)
    layoutThread(state)
  }
  if (options.note) thread.querySelector('textarea')?.focus()
  else state.surface.focus()
  return api
}
