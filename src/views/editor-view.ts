import { isNotificationInteraction, viewDiagnostic, viewFeedback } from '../view-feedback'
import { scrollToActor } from '../motion'
import { retire, reveal } from '../motion'
import { patchContent } from '../dom-patch'
import { registerReloadGuard, registerReloadSnapshot } from '../self-update-watch'
import { editorHistoryKey, EditorHistoryTooLargeError, HISTORY_BYTE_BUDGET, HISTORY_LIMIT, readEditorHistory, trimHistoryStacks, writeEditorHistory, type EditorHistoryEntry } from '../editor-history'
import { ICON_PUBLISH, closePublishPanel, togglePublishPanel } from './editor-publish'
import { setGoogleConnectionResult, setGoogleNavigationGuard, takeGoogleConnectionResult, takeGooglePublishReturn } from '../google'
import { EditorReviews } from './editor-reviews'
import { GoogleDocuments } from './google-documents'
import { chatClient } from '../chat-client'
import { chatSidePane, registerEditorSurface } from './chat-side-pane'
import { clearInlineThreads, closeInlineThread, dropThread, hasThreadDraft, inlineThreadSubjectInView, keepThreadDraft, openInlineThread, syncThreadMarker } from './editor-inline-thread'
import type { SurfaceOptions } from './chat-session-surface'
import { locateReview, type ArticleReview } from '../publishing-review'
import type { ChatSubject } from '../../server/chat/protocol'
import type { EditProposal } from '../edit-proposals'
// Editor — minimalist markdown writing surface.
//
// Single horizontal control bar at the top, sharing the exact alignment
// of every other view's header (same .view-header rule, same indent,
// same height, same right-pad to clear the top-right burger). Inside
// the header, two halves: icons on the left, meta + doc-picker on the
// right.
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │  +  ×                       25 words · saved   [doc title ▾]│
//   ├─────────────────────────────────────────────────────────────┤
//   │                                                             │
//   │             chromeless writing area, centered page          │
//   │                                                             │
//   └─────────────────────────────────────────────────────────────┘
//
// Storage: each doc is a plain UTF-8 .md file under ~/.poise/editor/.
// Title comes from the first non-empty line at read time. server/editor.ts
// owns sanitization and on-disk layout.
//
// Surface: the writing area is a single `<div contenteditable>` whose
// children are per-line `<div class="editor-line" data-kind=...>`
// blocks. Each line's data-kind (h1 / h2 / body) is recomputed on every
// `input` from its leading `#` / `##` token, and CSS sizes the line
// accordingly — H1 28px, H2 22px, body 19px, each with its own
// line-height. The native caret rides the rendered text because there's
// no mirror to drift against; this replaces an earlier textarea+mirror
// approach where different per-line font-sizes broke cursor alignment.
//
// The line model stays flat — `#editor-doc`'s children are lines and
// nothing else — which is why a pipe table is rendered as a run of
// sibling rows sharing one grid template rather than as a <table>.
//
// What markdown the writer may type is NOT decided here. The grammar
// lives in src/markdown-syntax.ts and is shared with the chat pane's
// renderer, so the two surfaces can never drift into supporting
// different markdown. This file decides only how the editor draws it.

import {
  type BlockKind,
  type InlineSegment,
  blockMarkerLength,
  blockTrailingMarkerLength,
  classifyLines,
  emptyTableRowText,
  inlineSource,
  isTableDelimText,
  isTableRowText,
  isWhollyHidden,
  parseInline,
  parseTableAligns,
  splitTableRow,
  tableDelimTextFor,
} from '../markdown-syntax'

interface DocSummary {
  slug: string
  title: string
  updated_at: string
  size: number
}

// Side-car annotations attached to ranges in the doc. The schema
// mirrors server/editor.ts (Annotation). Ranges are line + char-offset
// pairs; the snippet is the highlighted text at create time and
// re-anchors the annotation if the user inserts/removes lines above
// it. session_id survives only on annotations written before Chat
// sessions, for the legacy import; new annotations omit it.
interface AnnotationRange {
  start_line: number
  start_offset: number
  end_line: number
  end_offset: number
}
interface Annotation {
  id: string
  session_id?: string
  range: AnnotationRange
  snippet: string
  comment: string
  created_at: string
  updated_at: string
}

let viewEl: HTMLElement
let initialized = false
let docs: DocSummary[] = []
let currentSlug: string | null = null
let loadRequestId = 0
let externalOpenRequestId = 0
let deletingSlug: string | null = null
let docEl: HTMLElement | null = null
let triggerEl: HTMLButtonElement | null = null
let triggerTitleEl: HTMLElement | null = null
let menuEl: HTMLElement | null = null
let copyBtnEl: HTMLButtonElement | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

// Annotation state. The list is the source of truth in memory; the
// overlay layer below the editor renders one or more thin underline
// rects per annotation, positioned with Range.getClientRects. The
// floating Comment button appears when a non-collapsed selection
// covers some text; clicking it creates a new annotation and opens
// an inline thread for it. One thread is open at a time.
let annotations: Annotation[] = []
let articleReviews: EditorReviews | undefined
let googleImporting = false
let googleDocuments: GoogleDocuments | null = null
let annotationsReadySlug: string | null = null
const documentVersions = new Map<string, string>()
const annotationsVersions = new Map<string, string>()
let overlayEl: HTMLElement | null = null
let commentBtnEl: HTMLButtonElement | null = null
let issueBtnEl: HTMLButtonElement | null = null
let snippetBtnEl: HTMLButtonElement | null = null
// The annotation created by the Comment press that opened the current thread,
// if any. Only this one may be auto-discarded when the thread closes empty.
let threadCreatedId: string | null = null
let annotationsSaveTimer: ReturnType<typeof setTimeout> | null = null

// Issue composer state. When the user clicks the floating Issue
// trigger after making a selection, we mount a floating .composer
// .composer-issue card near the selection (same DOM as Current's
// lane composer — see src/views/current-view.ts openIssueComposer).
// Selection collapses on focus-change to the title input, so we
// freeze the snippet at click-time rather than reading the live
// selection from inside the composer.
let issueComposerEl: HTMLDivElement | null = null
// Snippet composer state — sibling of the issue composer, mounted from
// the third selection action. Saves the selection as an espanso snippet
// (a ;trigger → body pair) via POST /api/snippets.
let snippetComposerEl: HTMLDivElement | null = null
// Cached org-wide repo list, fetched once per view init from
// /api/repos (the same source Current uses). Empty until the first
// fetch lands; the composer falls back to a polite message.
let allRepos: string[] = []

const SAVE_DEBOUNCE_MS = 500
const ANNOTATIONS_SAVE_DEBOUNCE_MS = 400
const LAST_OPEN_KEY = 'poise-editor-last'

// A debounced save can fire while its previous request is still in
// flight. Keep the newest immutable snapshot dirty until it has
// actually persisted, and drain snapshots one at a time. Updates that
// arrive during a request are picked up by the same drain loop.
export interface SerializedSaveQueue<T> {
  enqueue(snapshot: T): void
  flush(): Promise<boolean>
  discard(): Promise<void>
  isDirty(): boolean
  pending(): T | null
}

export function createSerializedSaveQueue<T>(
  persist: (snapshot: T) => Promise<void>,
  onError?: (error: unknown, snapshot: T) => void,
): SerializedSaveQueue<T> {
  let queuedRevision = 0
  let persistedRevision = 0
  let latest: T | null = null
  let draining: Promise<boolean> | null = null

  async function drain(): Promise<boolean> {
    while (persistedRevision < queuedRevision) {
      const revision = queuedRevision
      const snapshot = latest
      if (snapshot === null) {
        persistedRevision = revision
        continue
      }
      try {
        await persist(snapshot)
      } catch (error) {
        try { onError?.(error, snapshot) } catch { /* reporting must not break the queue */ }
        return false
      }
      persistedRevision = Math.max(persistedRevision, revision)
    }
    return true
  }

  return {
    enqueue(snapshot: T): void {
      latest = snapshot
      queuedRevision += 1
    },
    flush(): Promise<boolean> {
      if (draining) return draining
      const run = drain()
      let tracked: Promise<boolean>
      tracked = run.finally(() => {
        if (draining === tracked) draining = null
      })
      draining = tracked
      return tracked
    },
    async discard(): Promise<void> {
      persistedRevision = queuedRevision
      latest = null
      if (draining) await draining
    },
    isDirty(): boolean {
      return persistedRevision < queuedRevision
    },
    pending(): T | null {
      return persistedRevision < queuedRevision ? latest : null
    },
  }
}

interface DocumentSaveSnapshot {
  baseVersion: string
  slug: string
  content: string
  clientId: string
  revision: number
}

interface AnnotationsSaveSnapshot {
  slug: string
  annotationsJson: string
  clientId: string
  revision: number
}

const EDITOR_CLIENT_ID = typeof globalThis.crypto?.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
let documentSaveRevision = 0
let annotationsSaveRevision = 0

const documentSaveQueue = createSerializedSaveQueue(
  persistDocumentSnapshot,
  (error) => {
    console.error('[editor] save failed:', error)
    setMeta((error as Error)?.message?.includes('changed since') ? 'Conflict — reload' : 'Save failed')
  },
)

const annotationsSaveQueue = createSerializedSaveQueue(
  persistAnnotationsSnapshot,
  (error) => {
    console.error('[editor] save annotations failed:', error)
    setMeta((error as Error)?.message?.includes('changed since') ? 'Annotation conflict — reload' : 'Annotation save failed')
  },
)

// A hidden Editor can still own an unsaved document or annotation.
// A release refresh must wait for the actual queues, not visible status text.
registerReloadGuard(() =>
  documentSaveQueue.isDirty() || annotationsSaveQueue.isDirty() || saveTimer || annotationsSaveTimer || deletingSlug
    ? ['editor'] : [],
)

function isEditorVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function requiredVersion(versions: Map<string, string>, slug: string, label: string): string {
  const version = versions.get(slug)
  if (!isEditorVersion(version)) throw new Error(`${label} version is unavailable; reload before saving`)
  return version
}

async function throwSaveResponseError(res: Response): Promise<never> {
  let message = `HTTP ${res.status}`
  try {
    const body = await res.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error) message = body.error
  } catch { /* retain the status fallback */ }
  throw new Error(message)
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}

function relTime(iso: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!isFinite(t)) return ''
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

function groupBucket(iso: string): string {
  const t = new Date(iso).getTime()
  const days = (Date.now() - t) / 86_400_000
  if (days < 1)  return 'Today'
  if (days < 2)  return 'Yesterday'
  if (days < 7)  return 'This week'
  if (days < 30) return 'This month'
  return 'Older'
}

const ICON_PLUS  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const ICON_TRASH = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4h8M5.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4l.5 7a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l.5-7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// Two-rectangles "duplicate" mark — the same copy glyph used by the
// card chrome, so the meaning carries over.
const ICON_COPY  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="3" width="7" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 3V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// Arrows-to-corners pair for the writer-mode toggle: "expand to fill"
// when entering, "contract back" when exiting. Universal fullscreen
// vocabulary, reads as a mode toggle without a label.
const ICON_FOCUS_ENTER = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 5V2h3M9 2h3v3M2 9v3h3M9 12h3V9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_FOCUS_EXIT  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 2v3H2M9 5h3V2M5 12V9H2M9 9v3h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// Speech-bubble with two short message-lines inside — reads as "chat
// thread" rather than the empty comment-bubble used by the floating
// per-selection annotation button. Same 14×14 stroke weight as the
// rest of the bar so the row stays visually even.
const ICON_CHAT  = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 12 3.5v5A1.5 1.5 0 0 1 10.5 10H6l-2.5 2V10A1.5 1.5 0 0 1 2 8.5v-5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M4.5 5h5M4.5 7h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
// Same bubble with a prompt chevron inside — a Chat *session* about the
// document (the Chat view), as opposed to the pane above.
const ICON_CHAT_SESSION = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 12 3.5v5A1.5 1.5 0 0 1 10.5 10H6l-2.5 2V10A1.5 1.5 0 0 1 2 8.5v-5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 4.5l2 1.5-2 1.5M7.5 7.5h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function renderShell(): string {
  // .view-header carries the standard cross-view alignment (vertical
  // position, side indent, right-pad to clear the burger). The
  // editor-specific behaviour piggybacks on it via the .editor-bar
  // modifier — we only override what's specific (justify-content
  // space-between to split left/right halves).
  return `
    <header class="view-header editor-bar">
      <div class="editor-bar-left">
        <button type="button" class="editor-bar-btn editor-focus-btn"  title="Writer mode" aria-label="Toggle writer mode" aria-pressed="false">${ICON_FOCUS_ENTER}</button>
        <button type="button" class="editor-bar-btn editor-new-btn"    title="New (⌘N)" aria-label="New">${ICON_PLUS}</button>
        <button type="button" class="editor-bar-btn editor-copy-btn"   title="Copy document" aria-label="Copy document">${ICON_COPY}</button>
        <button type="button" class="editor-bar-btn editor-chat-btn"   title="Chat about this document (pane)" aria-label="Open chat">${ICON_CHAT}</button>
        <button type="button" class="editor-bar-btn editor-chat-session-btn" title="Chat about this document" aria-label="Chat about this document">${ICON_CHAT_SESSION}</button>
        <button type="button" class="editor-bar-btn editor-publish-btn" title="Publish" aria-label="Publish" aria-haspopup="dialog" aria-expanded="false">${ICON_PUBLISH}</button>
        <button type="button" class="editor-bar-btn editor-delete-btn" title="Delete" aria-label="Delete">${ICON_TRASH}</button>
      </div>
      <div class="editor-bar-right">
        <div class="editor-doc-wrap">
          <button type="button" class="editor-doc-trigger" aria-haspopup="menu" aria-expanded="false">
            <span class="editor-doc-trigger-title">Untitled</span>
            <span class="editor-doc-trigger-chevron" aria-hidden="true">▾</span>
          </button>
          <div class="editor-doc-menu" id="editor-doc-menu" hidden role="menu"></div>
        </div>
      </div>
    </header>
    <main class="editor-main">
      <div class="editor-page">
        <!-- Single contenteditable surface. Children are per-line
             <div class="editor-line" data-kind="h1|h2|body"> blocks
             whose font-size/line-height come from CSS. The native
             caret tracks rendered text directly — no mirror layer. -->
        <div class="editor-doc" id="editor-doc" contenteditable="true" spellcheck="true" data-empty="true"></div>
        <!-- Annotation overlay: absolutely-positioned underline rects
             live here, one per Range.getClientRects() result per
             annotation. Behind the editor in z-order so the caret
             stays selectable; the rects themselves use pointer-events
             so clicks open the comment panel. -->
        <div class="editor-annotations" id="editor-annotations" aria-hidden="true"></div>
      </div>
      <!-- Floating selection actions: shown only when a non-collapsed
           selection covers some text in the editor. Comment → create
           annotation + open panel. Issue → open the issue composer
           prefilled with the selected snippet as body. Both are 24px
           r-999 circles, anchored just above-right of the selection. -->
      <button type="button" class="editor-comment-btn" id="editor-comment-btn" hidden aria-label="Add comment">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 11.5 4v4a1.5 1.5 0 0 1-1.5 1.5H6.5L4 12V9.5a1.5 1.5 0 0 1-1.5-1.5V4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="editor-comment-btn editor-issue-btn" id="editor-issue-btn" hidden aria-label="Create issue from selection">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="1.4" fill="currentColor"/></svg>
      </button>
      <button type="button" class="editor-comment-btn editor-snippet-btn" id="editor-snippet-btn" hidden aria-label="Save selection as snippet">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M8 1.5L3.5 8H6.5L6 12.5L10.5 6H7.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
      </button>
    </main>
  `
}

// How the editor draws each of the shared grammar's kinds. The grammar
// itself — what counts as a heading, a quote, a link — lives in
// src/markdown-syntax.ts and is shared with the chat renderer, so the
// two can never disagree about what the writer is allowed to type.
//
// The difference between the two renderers is what they do with a
// marker. The chat pane throws it away: `# ` becomes an <h1> tag and the
// characters are gone. The editor keeps every character in the DOM and
// hides the marker with CSS, because the line's textContent IS the
// saved file, and because caret offsets, annotation anchors and the
// copy handler all count in source characters.
//
// So, per kind:
//   - h1…h6 / list-item / quote: leading marker in a hidden span, the
//     rest parsed for inline runs. CSS sizes the line and draws the
//     bullet or the quote bar in the marker's place.
//   - rule: the whole line (`---`) is marker; CSS draws the line.
//   - code fences and a table's delimiter row: the whole line is marker
//     too, but with nothing drawn in its place.
//   - code-content: plain text, no inline parsing — asterisks and
//     backticks inside code are literal.
//   - table-head / table-row: pipes become hidden markers and each cell
//     becomes a `<span class="editor-cell">`. CSS puts the cells on a
//     grid; applyTableLayout gives every row of a table the same tracks.
type LineKind = BlockKind

function isTableRowKind(kind: LineKind): boolean {
  return kind === 'table-head' || kind === 'table-row'
}

// Kinds whose marker is a leading run the writer can delete their way
// out of, demoting the line to prose. The whole-line markers (fences,
// rules, delimiter rows) are deliberately not in this set: there is no
// "rest of the line" left behind to demote to.
function hasStrippableMarker(kind: LineKind): boolean {
  return kind === 'list-item' || kind === 'quote'
    || (kind.length === 2 && kind[0] === 'h')
}

// Column weights for the shared grid template. Every row of a table is
// its own grid container — they are sibling line divs, and wrapping
// them in one element would break the flat line model the whole editor
// is built on — so the columns only line up if each row is handed the
// same explicit track list.
//
// Widths come from the longest cell in each column, measured in
// characters. That is deliberate: measuring rendered boxes would mean
// a layout read on every keystroke, and a character count is stable,
// cheap, and close enough for prose. The clamp keeps a `Yes`/`No`
// column from collapsing to a sliver and a paragraph-in-a-cell from
// starving its neighbours.
const TABLE_COL_MIN = 4
const TABLE_COL_MAX = 24

export function tableColumnTemplate(rows: string[]): string {
  const widths: number[] = []
  for (const row of rows) {
    const parts = splitTableRow(row)
    if (!parts) continue
    parts.cells.forEach((cell, i) => {
      const len = cell.length
      if (widths[i] === undefined || len > widths[i]) widths[i] = len
    })
  }
  if (widths.length === 0) return ''
  return widths
    .map((w) => `minmax(0, ${Math.max(TABLE_COL_MIN, Math.min(TABLE_COL_MAX, w))}fr)`)
    .join(' ')
}

// Every inline run renders as a wrapper holding three children — the
// opening marker, the visible text, the closing marker — with both
// markers in hidden spans. Only the tag and the marker strings differ,
// so the rest of the editor can treat them as one shape.
//
// A link is the same shape with a lopsided closing marker: `[` opens
// it, and `](https://…)` closes it. That is exactly why a link's source
// has to be reachable — see the reveal handling in buildLineEl.
interface InlineWrapSpec { tag: string, open: string, close: string }

function inlineWrapSpec(seg: InlineSegment): InlineWrapSpec | null {
  switch (seg.kind) {
    case 'bold':   return { tag: 'STRONG', open: '**',          close: '**' }
    case 'italic': return { tag: 'EM',     open: seg.marker,    close: seg.marker }
    case 'code':   return { tag: 'CODE',   open: '`',           close: '`' }
    case 'link':   return { tag: 'A',      open: '[',           close: `](${seg.url})` }
    default:       return null
  }
}

function isInlineWrap(el: Element | null): boolean {
  const tag = el?.tagName
  return tag === 'STRONG' || tag === 'EM' || tag === 'CODE' || tag === 'A'
}

function buildMarkerEl(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'md-marker'
  span.textContent = text
  return span
}

function buildInlineWrap(spec: InlineWrapSpec, inner: string): HTMLElement {
  const wrap = document.createElement(spec.tag)
  wrap.appendChild(buildMarkerEl(spec.open))
  wrap.appendChild(document.createTextNode(inner))
  wrap.appendChild(buildMarkerEl(spec.close))
  return wrap
}

// Does this line hold a link? Used to decide whether moving the caret
// onto or off it needs a rebuild, so it has to be cheap enough to run
// on every cursor move — hence a regex over the source rather than a
// parse.
const LINK_HINT_RE = /\[[^\]\n]+\]\(/

// Fill a container with the inline-parsed form of `text`.
//
// `revealLinks` renders a link as its own source instead of as a hidden
// URL. A link is the one run whose marker is arbitrarily long, so a
// caret that cannot reach it means a mistyped URL can only be fixed by
// deleting the whole link and starting again. The editor therefore
// shows the source of any link on the line the caret is on, and hides
// it again the moment the caret leaves — the same bargain the table
// delimiter row strikes. Bold, italic and code keep their markers
// hidden throughout: those are one or two characters sitting right
// against their text, and backspacing through them already works.
//
// An empty container still gets an empty text node: without one there
// is no anchor for the caret to land on, and a fresh table row is
// nothing but empty cells. The trailing sentinel after a wrapped run is
// the same device, for the same reason — typing after a bold run must
// not extend it.
function fillInline(el: HTMLElement, text: string, revealLinks: boolean): void {
  if (text === '') {
    el.appendChild(document.createTextNode(''))
    return
  }
  const segs = parseInline(text)
  let lastWasWrap = false
  for (const seg of segs) {
    const spec = revealLinks && seg.kind === 'link' ? null : inlineWrapSpec(seg)
    if (spec) {
      el.appendChild(buildInlineWrap(spec, seg.text))
      lastWasWrap = true
    } else {
      el.appendChild(document.createTextNode(inlineSource(seg)))
      lastWasWrap = false
    }
  }
  if (lastWasWrap) el.appendChild(document.createTextNode(''))
}


// Build a fresh line element. Every marker character stays in
// textContent — hidden, but present — so save, copy and the caret all
// still see real markdown. `revealLinks` is set for the line the caret
// is on; see fillInline.
function buildLineEl(text: string, kind: LineKind, revealLinks: boolean = false): HTMLDivElement {
  const div = document.createElement('div')
  div.className = 'editor-line'
  div.dataset.kind = kind

  // Kinds whose entire line is marker. A fence, a rule and a table's
  // delimiter row have no content of their own to show: CSS draws
  // whatever stands in their place, or nothing at all.
  if (kind === 'code-fence-open' || kind === 'code-fence-close'
      || kind === 'rule' || kind === 'table-delim') {
    if (text === '') div.appendChild(document.createElement('br'))
    else             div.appendChild(buildMarkerEl(text))
    return div
  }

  // Kinds shown as their own source: code, and the delimiter row the
  // caret is currently on.
  if (kind === 'code-content' || kind === 'source') {
    if (text === '') div.appendChild(document.createElement('br'))
    else             div.appendChild(document.createTextNode(text))
    return div
  }

  if (isTableRowKind(kind)) {
    const parts = splitTableRow(text)
    // classifyLines only hands out row kinds to text that splits, so the
    // fallback is unreachable in practice; keeping it means a line that
    // somehow arrives malformed renders as its own source rather than as
    // an empty row the writer cannot recover.
    if (!parts) {
      if (text === '') div.appendChild(document.createElement('br'))
      else             div.appendChild(document.createTextNode(text))
      return div
    }
    parts.markers.forEach((marker, i) => {
      div.appendChild(buildMarkerEl(marker))
      if (i < parts.cells.length) {
        const cell = document.createElement('span')
        cell.className = 'editor-cell'
        fillInline(cell, parts.cells[i], revealLinks)
        div.appendChild(cell)
      }
    })
    if (revealLinks && LINK_HINT_RE.test(text)) div.dataset.reveal = 'links'
    return div
  }

  const prefix = text.slice(0, blockMarkerLength(kind, text))
  const rest = text.slice(prefix.length)
  if (prefix) div.appendChild(buildMarkerEl(prefix))
  // For list-item lines, publish the visual marker the ::before
  // pseudo-element should display. Bullet lines (`- `) render as a
  // designed `•` glyph; numbered lines preserve the writer's delimiter
  // choice (`1.` vs `1)`), which preserves the typographic distinction
  // those two punctuations make.
  if (kind === 'list-item') {
    div.dataset.listMarker = prefix.startsWith('-') ? '•' : prefix.trimEnd()
  }
  if (rest === '') {
    div.appendChild(document.createElement('br'))
    return div
  }
  fillInline(div, rest, revealLinks)
  if (revealLinks && LINK_HINT_RE.test(rest)) div.dataset.reveal = 'links'
  return div
}

// Cursor-offset helpers — work in textContent character coordinates
// (i.e. counting hidden marker chars too) so we can preserve cursor
// position across line rebuilds. The marker span participates in the
// offset count: if the cursor was at offset 2 in `# Hello`, that's
// just-after the marker in DOM terms, which is offset 0 of the visible
// "Hello" — the right place after a body→h1 transition.
function getCursorOffsetInLine(line: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null
  if (!line.contains(sel.anchorNode)) return null
  let offset = 0
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node === sel.anchorNode) return offset + sel.anchorOffset
    offset += (node.textContent || '').length
  }
  // Anchor was inside line but not in a text node (e.g. before a <br>).
  return offset
}

function setCursorOffsetInLine(line: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let acc = 0
  let node: Node | null
  let prev: Node | null = null
  const sel = window.getSelection()
  const place = (target: Node, at: number) => {
    const r = document.createRange()
    r.setStart(target, at)
    r.collapse(true)
    if (sel) { sel.removeAllRanges(); sel.addRange(r) }
  }
  while ((node = walker.nextNode())) {
    const len = (node.textContent || '').length
    if (acc + len >= offset) {
      const localOffset = offset - acc
      const range = document.createRange()

      // Table rows hide a pipe marker between every pair of cells, so
      // the offset that starts a cell is also the offset that ends the
      // marker before it — and this walk, taking the first node that
      // reaches the offset, lands in the marker. That is a text node
      // the caret cannot be seen in and typing there would grow the
      // pipe rather than the cell, so step to the neighbouring cell's
      // own text instead: forward normally, back for the closing pipe
      // at end-of-row, which has no cell after it. Scoped to table
      // lines on purpose — heading and list markers sit at the very
      // start of a line, and the inline-wrapper case below wants the
      // sentinel rather than the next node.
      if (localOffset === len && isTableRowKind((line.dataset.kind || 'body') as LineKind)
          && (node.parentNode as HTMLElement | null)?.classList?.contains('md-marker')) {
        const next = walker.nextNode()
        if (next)      { place(next, 0); return }
        if (prev)      { place(prev, (prev.textContent || '').length); return }
      }

      // Edge: when the cursor is exactly at the end of the trailing
      // marker of a <strong>/<code>, placing it inside that marker
      // means the user's next keystroke extends the wrapper (the
      // marker grows by one char, the parser still sees `**…X` /
      // `` `…X `` and re-parses with X inside). We want the opposite:
      // typing after a bold or code run should produce plain text.
      // Prefer the trailing empty-text sentinel buildLineEl appends
      // after a wrapped-ending line — that's a real text-node anchor
      // outside the wrapper. Failing that, place at line-level after
      // the wrapper; the sentinel will be re-added on the next
      // reclassify.
      if (localOffset === len && node.parentNode) {
        const markerSpan = node.parentNode as HTMLElement
        if (markerSpan.classList && markerSpan.classList.contains('md-marker')) {
          const wrap = markerSpan.parentNode as HTMLElement | null
          if (wrap && isInlineWrap(wrap) && markerSpan === wrap.lastElementChild) {
            const sentinel = wrap.nextSibling
            if (sentinel && sentinel.nodeType === Node.TEXT_NODE) {
              range.setStart(sentinel, 0)
              range.collapse(true)
              if (sel) { sel.removeAllRanges(); sel.addRange(range) }
              return
            }
            const lineLevel = wrap.parentNode!
            const idx = Array.from(lineLevel.childNodes).indexOf(wrap) + 1
            range.setStart(lineLevel, idx)
            range.collapse(true)
            if (sel) { sel.removeAllRanges(); sel.addRange(range) }
            return
          }
        }
      }

      range.setStart(node, localOffset)
      range.collapse(true)
      if (sel) { sel.removeAllRanges(); sel.addRange(range) }
      return
    }
    acc += len
    prev = node
  }
  // Fallback: place caret at end of line
  const range = document.createRange()
  range.selectNodeContents(line)
  range.collapse(false)
  if (sel) { sel.removeAllRanges(); sel.addRange(range) }
}

// Convert a (container, offset) anchor inside a line to a single
// character offset within that line's textContent (which counts hidden
// marker chars). Used by copy/cut to slice the visible selection out
// of the markdown-bearing textContent.
//   - text-node container: char-offset in that text node + sum of
//     text lengths that come earlier in the line subtree.
//   - element container: offset is a child index; sum lengths of
//     children before that index, recursively.
function offsetInLineFor(line: HTMLElement, container: Node, offset: number): number {
  let acc = 0
  let found = false
  function visit(node: Node): void {
    if (found) return
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) {
        acc += offset
      } else {
        const kids = node.childNodes
        for (let i = 0; i < offset && i < kids.length; i++) {
          acc += (kids[i].textContent || '').length
        }
      }
      found = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      acc += (node.textContent || '').length
      return
    }
    for (const c of Array.from(node.childNodes)) visit(c)
  }
  visit(line)
  return acc
}

// Walk up from a node looking for an ancestor inline wrapper inside
// the editor. The shape (<strong> for bold, <code> for inline code)
// determines which marker the toggle-off path strips.
function inlineWrapAncestorOf(node: Node | null): HTMLElement | null {
  let n: Node | null = node
  while (n) {
    if (n === docEl) return null
    if (n.nodeType === Node.ELEMENT_NODE) {
      if (isInlineWrap(n as Element)) return n as HTMLElement
    }
    n = n.parentNode
  }
  return null
}

// Cmd+B is bold-only: toggle off only when the wrapper is <strong>.
function strongAncestorOf(node: Node | null): HTMLElement | null {
  const wrap = inlineWrapAncestorOf(node)
  return wrap && wrap.tagName === 'STRONG' ? wrap : null
}

// Detect a caret position whose next typed character will, by default,
// land inside the trailing marker of a <strong>/<code> and visually
// extend the wrapper. Three equivalent positions trigger this:
//   1. Caret at the end of the trailing marker's text node (inside
//      the marker span).
//   2. Caret at line-level immediately after a <strong>/<code> with
//      no following text node.
//   3. Caret in the post-wrapper sentinel (empty text node sibling
//      buildLineEl appends after a wrapped-ending line). The sentinel
//      is a real text-node anchor, but Chrome still routes typed
//      characters into the previous element when the sentinel is
//      empty — so we treat this as "caret at wrapper's edge" and
//      redirect the insertion to a fresh text sibling.
// In all three cases we redirect the insertion to a sibling text
// node after the wrapper, so typing produces plain text.
function inlineWrapAtCaretEdge(range: Range): HTMLElement | null {
  const node = range.startContainer
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentNode as HTMLElement | null
    if (!parent) return null
    // Case 1: inside trailing marker, at end of marker text.
    if (parent.classList.contains('md-marker')) {
      const wrap = parent.parentNode as HTMLElement | null
      if (!wrap || (wrap.tagName !== 'STRONG' && wrap.tagName !== 'CODE')) return null
      if (parent !== wrap.lastElementChild) return null
      if (range.startOffset !== (node.textContent || '').length) return null
      return wrap
    }
    // Case 3: in the empty sentinel sibling of a wrapper.
    if (node.textContent === '' && parent.classList.contains('editor-line')
        && node.previousSibling
        && node.previousSibling.nodeType === Node.ELEMENT_NODE) {
      const prev = node.previousSibling as HTMLElement
      if (isInlineWrap(prev)) return prev
    }
    return null
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement
    if (!el.classList.contains('editor-line')) return null
    // Case 2: line-level position immediately after a wrapper.
    const prev = el.childNodes[range.startOffset - 1]
    if (!prev || prev.nodeType !== Node.ELEMENT_NODE) return null
    const tag = (prev as HTMLElement).tagName
    if (tag !== 'STRONG' && tag !== 'CODE') return null
    return prev as HTMLElement
  }
  return null
}

// Wrap `s` in `**…**`, keeping any whitespace at its edges OUTSIDE the
// markers. CommonMark's flanking rules say a `**` run preceded by
// whitespace can't close and one followed by whitespace can't open, so
// `**bold **text` is not emphasis at all — every strict renderer prints
// the asterisks literally. Our own parser is lenient enough to still
// show it bold, which is exactly what let malformed text sit unnoticed
// in saved documents. Selections routinely carry a trailing space
// (that's what a double-click hands us), so normalise here.
// Whitespace-only input is returned untouched — there's nothing to bold.
function wrapBoldPreservingEdgeSpace(s: string): string {
  const lead  = /^\s*/.exec(s)![0]
  const trail = /\s*$/.exec(s.slice(lead.length))![0]
  const core  = s.slice(lead.length, s.length - trail.length)
  return core ? `${lead}**${core}**${trail}` : s
}

// Cmd+B handler. Four behaviours:
//   - Collapsed selection INSIDE a <strong>: exit bold mode. Move
//     the caret to line-level immediately after the strong; the
//     existing bold is preserved (this is the Word / iA Writer /
//     Typora idiom — Cmd+B at a collapsed cursor means "stop bolding
//     what I type next," not "un-bold what I already typed").
//     The beforeinput handler (inlineWrapAtCaretEdge case 2) catches
//     the next keystroke and routes it to a fresh text-node sibling
//     so typing produces plain text.
//   - Non-empty selection INSIDE a <strong>: split the run. Whatever
//     fell INSIDE the selection becomes plain text, whatever sat
//     before / after the selection stays bold. When the selection
//     covers the whole inner text this degenerates to a full unwrap
//     (no surrounding bold runs survive); when the selection is a
//     proper subrange we leave one or two new bold runs flanking the
//     plain text. The implementation rewrites the relevant span of
//     the line's markdown text and lets reclassify rebuild the DOM,
//     so the line ends up canonical regardless of the input shape.
//   - Non-empty selection elsewhere: wrap the visible selected text
//     with `**…**` via insertText. The next reclassify rebuilds the
//     line and the new markers fold into a <strong>.
//   - Collapsed selection elsewhere: insert `****` and park the caret
//     between the two pairs, so the user can type the bold word and
//     the line reclassifies into a <strong> on the next input.
function toggleBoldAtSelection() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  if (!docEl) return
  if (!docEl.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== docEl) return

  const strong = strongAncestorOf(range.commonAncestorContainer)
  // The run-splitting branches below rewrite the DOM directly rather
  // than through insertText, so no beforeinput fires to snapshot for us.
  if (strong && !range.collapsed) recordHistoryPoint()
  if (strong) {
    if (range.collapsed) {
      // Exit bold mode. Caret moves to line-level right after the
      // strong; nothing inside it is touched, so previously-typed
      // bold text stays bold.
      const r = document.createRange()
      r.setStartAfter(strong)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      return
    }
    // Non-empty selection inside strong. Split the inner text into
    // before / selected / after; the selected part loses bold, the
    // before / after parts each become their own `**…**` run. When
    // before or after is empty the corresponding run is omitted, so
    // a full-selection toggle still produces a clean unwrap.
    //
    // We require the selection to be entirely within the strong's
    // inner text node — that's the common case from a double-click,
    // a shift-arrow extend, or a mouse drag wholly inside the bold
    // run. If the selection extends past the inner text (covering
    // the markers or spilling into siblings), fall back to a whole-
    // strong unwrap so we don't try to interpret an ambiguous range.
    const inner = strong.childNodes[1]
    if (!inner || inner.nodeType !== Node.TEXT_NODE
        || range.startContainer !== inner || range.endContainer !== inner) {
      const innerText = (inner && inner.nodeType === Node.TEXT_NODE) ? (inner.textContent || '') : ''
      const textNode = document.createTextNode(innerText)
      strong.parentNode!.replaceChild(textNode, strong)
      const r = document.createRange()
      r.setStart(textNode, innerText.length)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      reclassifyLines()
      updateEmptyState()
      scheduleSave()
      renderAnnotationOverlay()
      return
    }
    const innerText = inner.textContent || ''
    const selStart = Math.min(range.startOffset, range.endOffset)
    const selEnd   = Math.max(range.startOffset, range.endOffset)
    const before   = innerText.slice(0, selStart)
    const selected = innerText.slice(selStart, selEnd)
    const after    = innerText.slice(selEnd)
    const beforeRun = before ? wrapBoldPreservingEdgeSpace(before) : ''
    const afterRun  = after  ? wrapBoldPreservingEdgeSpace(after)  : ''
    const replacement = beforeRun + selected + afterRun
    // The cursor lands at the end of the now-plain selected run — i.e.
    // past the rebuilt `before` run plus the selection itself. Measure
    // the rendered run rather than assuming a fixed 4 marker chars:
    // wrapBoldPreservingEdgeSpace may shift whitespace outside the
    // markers, or decline to wrap a whitespace-only run entirely.
    const cursorInReplacement = beforeRun.length + selected.length
    const replacementNode = document.createTextNode(replacement)
    strong.parentNode!.replaceChild(replacementNode, strong)
    const r = document.createRange()
    r.setStart(replacementNode, cursorInReplacement)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
    reclassifyLines()
    updateEmptyState()
    scheduleSave()
    renderAnnotationOverlay()
    return
  }

  if (range.collapsed) {
    document.execCommand('insertText', false, '****')
    // Move caret back 2 visible chars so the user lands between the
    // two `**` pairs. modify() is non-standard but supported in all
    // contemporary browsers; we wrap in try so a missing impl
    // degrades to "caret stays at end" rather than throwing.
    try {
      sel.modify('move', 'backward', 'character')
      sel.modify('move', 'backward', 'character')
    } catch { /* ignore — caret stays after **** */ }
    return
  }

  const visible = sel.toString()
  document.execCommand('insertText', false, wrapBoldPreservingEdgeSpace(visible))
}

// Find the textContent offset where a given descendant node's content
// starts within the line. Used by the inline marker-snap logic to
// locate <strong> wrappers in line-relative coordinates.
function offsetOfNodeInLine(line: HTMLElement, node: Node): number {
  let acc = 0
  let found = false
  function visit(n: Node): void {
    if (found) return
    if (n === node) { found = true; return }
    if (n.nodeType === Node.TEXT_NODE) acc += (n.textContent || '').length
    else if (n.nodeType === Node.ELEMENT_NODE) {
      for (const c of Array.from(n.childNodes)) visit(c)
    }
  }
  visit(line)
  return found ? acc : -1
}

// Walk #editor-doc's children and emit, per line that intersects the
// range, the visible slice of that line's textContent — with the
// hidden marker added back ONLY when the selection covers the full
// visible content of the line OR of an inline run. Rationale:
//   - User selects all of "Heading One" (visible) → expects `# Heading One`
//     because that's the markdown form of what they selected.
//   - User selects "ead" inside "Heading One" → expects just "ead" —
//     they didn't select the whole heading.
//   - User selects whole "bold" inside `**bold**` → expects `**bold**`
//     because they selected the whole bold run.
//   - User selects "ol" inside `**bold**` → expects just "ol".
// Concretely, for each touched line we compute clipped offsets in
// textContent space; for the block heading prefix we snap start to 0
// when the slice covers visualStart..visualEnd; for each <strong> we
// expand the slice outward when it covers the strong's full visible
// inner content. Otherwise we snap past hidden marker chars so partial
// slices don't pick them up.
function reconstructMarkdownFromRange(range: Range): string | null {
  if (!docEl) return null
  const out: string[] = []
  for (const child of Array.from(docEl.children)) {
    const line = child as HTMLElement
    if (!line.classList.contains('editor-line')) continue
    if (!range.intersectsNode(line)) continue

    const kind = (line.dataset.kind as LineKind) || 'body'
    const lineText = line.textContent || ''

    // Code-fence lines are entirely hidden marker — there's no
    // "visible content" to slice. If the range touches a fence line
    // at all, emit the whole fence text. (The user might be selecting
    // an empty-looking line; copying out the markdown is the right
    // round-trip.) Code-content lines have only visible text and no
    // hidden markers, so the standard slice produces the right text
    // without any marker snap.
    if (kind === 'code-fence-open' || kind === 'code-fence-close'
      || kind === 'rule' || kind === 'table-delim') {
      out.push(lineText)
      continue
    }

    const markerLen = blockMarkerLength(kind, lineText)
    const trailingLen = blockTrailingMarkerLength(kind, lineText)

    let startOffset = 0
    let endOffset = lineText.length
    if (line.contains(range.startContainer) || line === range.startContainer) {
      startOffset = offsetInLineFor(line, range.startContainer, range.startOffset)
    }
    if (line.contains(range.endContainer) || line === range.endContainer) {
      endOffset = offsetInLineFor(line, range.endContainer, range.endOffset)
    }

    // Block-level snap: include the heading marker only if the slice
    // covers the line's full visible content. For a table row the
    // visible content stops short of the closing pipe, so a whole-row
    // selection is measured against that instead of the raw length —
    // otherwise the outer pipes would be dropped and the copied text
    // would no longer be a table.
    const visibleEnd = lineText.length - trailingLen
    const coversWholeVisible = startOffset <= markerLen && endOffset >= visibleEnd
    let s = coversWholeVisible ? 0 : Math.max(startOffset, markerLen)
    let e = coversWholeVisible ? lineText.length : endOffset

    // Inline snap: for each inline wrapper in the line, if the slice
    // covers its full visible inner text, expand outward to include the
    // surrounding markers — so selecting the word inside `**bold**`
    // copies the asterisks with it, and selecting a link's text copies
    // the address it points at. We use the original startOffset /
    // endOffset (visible bounds) for the comparison so the block-marker
    // snap above doesn't double-count. The two markers are measured
    // from the DOM rather than assumed, because a link's are lopsided:
    // `[` opening, `](https://…)` closing. Lines with no inline
    // wrappers make this loop a no-op.
    for (const wrap of Array.from(line.querySelectorAll('strong, em, code, a'))) {
      const wrapStart = offsetOfNodeInLine(line, wrap)
      if (wrapStart < 0) continue
      const wrapEnd = wrapStart + (wrap.textContent || '').length
      const openLen  = (wrap.firstElementChild?.textContent || '').length
      const closeLen = (wrap.lastElementChild?.textContent || '').length
      const innerStart = wrapStart + openLen
      const innerEnd   = wrapEnd - closeLen
      if (startOffset <= innerStart && endOffset >= innerEnd) {
        if (wrapStart < s) s = wrapStart
        if (wrapEnd   > e) e = wrapEnd
      }
    }

    if (e <= s) {
      // Selection touched this line but no visible content — keep the
      // entry as an empty string so the line break is preserved when
      // joining (selecting through a line break should produce a
      // newline in the clipboard).
      out.push('')
    } else {
      out.push(lineText.slice(s, e))
    }
  }
  return out.join('\n')
}

// Replace every child of #editor-doc with one line div per `\n`-split
// row of the source markdown. Preserves the round-trip — what comes out
// of serializeDoc(load(x)) is exactly x for any well-formed document.
function loadIntoEditor(content: string) {
  if (!docEl) return
  docEl.innerHTML = ''
  const lines = content === '' ? [''] : content.split('\n')
  const kinds = classifyLines(lines)
  for (let i = 0; i < lines.length; i++) {
    docEl.appendChild(buildLineEl(lines[i], kinds[i]))
  }
  applyTableLayout()
  updateEmptyState()
}

// Walk the per-line divs, take each one's plain text, join with `\n`.
// textContent transparently strips the <br> filler from empty lines,
// so empty rows serialize back to '' and rejoin into the right string.
function serializeDoc(): string {
  if (!docEl) return ''
  const lines: string[] = []
  for (const child of Array.from(docEl.children)) {
    lines.push((child as HTMLElement).textContent || '')
  }
  return lines.join('\n')
}

// ── Undo / redo ──────────────────────────────────────────────────────
//
// The browser's own undo stack can't be used here. reclassifyLines →
// rebuildLineInPlace rewrites a line's children (`innerHTML = ''`, then
// re-append) outside any editing transaction, so every marker
// transition — `# `, `## `, `- `, `1. `, ``` — detaches the nodes
// Chrome's undo records point at. Those records then become no-ops:
// typing `one`⏎`# two` and pressing Cmd+Z walked back to `# `, silently
// swallowed the next two presses, then deleted the whole line in one
// step, and redo could never recover the word. In a longer document
// undo would also jump to an unrelated earlier line.
//
// So we keep our own history of whole-document markdown snapshots plus a
// caret position, and own Cmd+Z / Cmd+Shift+Z outright. Documents here
// are capped at 5 MiB and typically a few KB, so full snapshots are far
// cheaper than tracking deltas correctly. Both the live stacks and the
// persisted timeline are bounded by HISTORY_BYTE_BUDGET (see
// editor-history); oldest steps go first, and every reduction is
// reported through setMeta so it stays visible.
// Plain typing coalesces into one undo step until this much idle time
// passes; structural edits close the step immediately.
const HISTORY_COALESCE_MS = 450

let historyUndo: EditorHistoryEntry[] = []
let historyRedo: EditorHistoryEntry[] = []
let historyPre: EditorHistoryEntry | null = null
let historyBatchOpen = false
let historyBatchTimer: number | null = null
// Set while we rebuild the document from a snapshot, so the resulting
// DOM churn doesn't record history of its own.
let historySuppress = false
// The trim notice fires once per document; every batch past the budget
// would otherwise repeat it.
let historyTrimNoticed = false

// The byte budget binds the live stacks too: 300 whole-document
// snapshots of a 5 MiB document would otherwise hold 1.5 GiB.
function trimHistoryMemory(): void {
  const dropped = trimHistoryStacks(historyUndo, historyRedo, HISTORY_BYTE_BUDGET)
  if (dropped > 0 && !historyTrimNoticed) {
    historyTrimNoticed = true
    console.warn(`[editor] history dropped ${dropped} steps to stay within its byte budget`)
    setMeta('Older undo steps were dropped to stay within the undo history budget')
  }
}

type HistoryPersistOutcome = 'kept' | 'trimmed' | 'too-large' | 'unavailable'

function historyPersistNotice(outcome: Exclude<HistoryPersistOutcome, 'kept'>): string {
  switch (outcome) {
    case 'trimmed': return 'Older undo steps were dropped to fit browser storage'
    case 'too-large': return 'Undo history could not be preserved — document too large for browser storage'
    case 'unavailable': return 'Undo history could not be preserved — browser storage unavailable'
  }
}

// Best-effort: the document is saved before this runs, so losing undo
// steps must never trap navigation on a saved document — loadDoc keeps
// going and inherits the notice below. Callers gate only an update
// reload, and only on a transient failure that waiting might clear.
function persistEditorHistory(): HistoryPersistOutcome {
  if (!currentSlug || !docEl || currentSlug === deletingSlug) return 'kept'
  try {
    const dropped = writeEditorHistory(sessionStorage, currentSlug, {
      version: 1, current: captureHistoryEntry(), undo: historyUndo, redo: historyRedo,
    })
    if (dropped > 0) {
      console.warn(`[editor] history trimmed ${dropped} steps to fit the byte budget`)
      setMeta(historyPersistNotice('trimmed'))
      return 'trimmed'
    }
    return 'kept'
  } catch (error) {
    if (error instanceof EditorHistoryTooLargeError) {
      console.error('[editor] history exceeds its byte budget:', error)
      setMeta(historyPersistNotice('too-large'))
      return 'too-large'
    }
    console.error('[editor] history could not be preserved:', error)
    setMeta(historyPersistNotice('unavailable'))
    return 'unavailable'
  }
}

// A document that can never fit its budget must not stall the update
// forever; only a transient storage failure is worth waiting out.
registerReloadSnapshot(() => persistEditorHistory() !== 'unavailable')

function captureHistoryEntry(): EditorHistoryEntry {
  const pos = caretSourcePosition()
  return { text: serializeDoc(), line: pos?.line ?? 0, offset: pos?.offset ?? 0 }
}

// Caret as (line index, offset into that line's source text).
function caretSourcePosition(): { line: number, offset: number } | null {
  if (!docEl) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const line = lineElOf(range.startContainer)
  if (!line || line.parentElement !== docEl) return null
  const idx = Array.prototype.indexOf.call(docEl.children, line)
  if (idx < 0) return null
  return { line: idx, offset: offsetInLineFor(line, range.startContainer, range.startOffset) }
}

function resetEditorHistory(): void {
  historyUndo = []
  historyRedo = []
  historyPre = null
  historyTrimNoticed = false
  historyBatchOpen = false
  if (historyBatchTimer !== null) { clearTimeout(historyBatchTimer); historyBatchTimer = null }
}

function closeHistoryBatch(): void {
  historyBatchOpen = false
  historyPre = null
  if (historyBatchTimer !== null) { clearTimeout(historyBatchTimer); historyBatchTimer = null }
}

// Called from beforeinput — snapshots the document as it stands *before*
// the edit lands, so one undo restores it. Cheap when a batch is already
// open (the common case while typing a word).
function noteHistoryPre(): void {
  if (historySuppress || historyBatchOpen) return
  historyPre = captureHistoryEntry()
}

// Called once the edit has landed. `immediate` closes the undo step now
// (structural edit); otherwise typing keeps coalescing into it.
function commitHistoryBatch(immediate: boolean): void {
  if (historySuppress) return
  if (!historyBatchOpen) {
    if (historyPre) {
      historyUndo.push(historyPre)
      if (historyUndo.length > HISTORY_LIMIT) historyUndo.shift()
      historyRedo = []
      trimHistoryMemory()
    }
    historyBatchOpen = true
  }
  if (historyBatchTimer !== null) { clearTimeout(historyBatchTimer); historyBatchTimer = null }
  if (immediate) { closeHistoryBatch(); return }
  historyBatchTimer = window.setTimeout(closeHistoryBatch, HISTORY_COALESCE_MS)
}

// For mutations we make directly, without going through beforeinput /
// input (the bold toggle's run-splitting branch, edit-card apply).
// Snapshot first, then mutate.
function recordHistoryPoint(): void {
  if (historySuppress) return
  closeHistoryBatch()
  historyUndo.push(captureHistoryEntry())
  if (historyUndo.length > HISTORY_LIMIT) historyUndo.shift()
  historyRedo = []
  trimHistoryMemory()
}

function restoreHistoryEntry(entry: EditorHistoryEntry): void {
  if (!docEl) return
  historySuppress = true
  try {
    loadIntoEditor(entry.text)
    const idx = Math.max(0, Math.min(entry.line, docEl.children.length - 1))
    const line = docEl.children[idx] as HTMLElement | undefined
    if (line) {
      docEl.focus()
      setCursorOffsetInLine(line, Math.max(0, Math.min(entry.offset, (line.textContent || '').length)))
    }
    updateEmptyState()
    scheduleSave()
    renderAnnotationOverlay()
  } finally {
    historySuppress = false
  }
}

function undoEditor(): void {
  if (googleImporting) return
  closeHistoryBatch()
  const prev = historyUndo.pop()
  if (!prev) return
  historyRedo.push(captureHistoryEntry())
  if (historyRedo.length > HISTORY_LIMIT) historyRedo.shift()
  trimHistoryMemory()
  restoreHistoryEntry(prev)
}

function redoEditor(): void {
  if (googleImporting) return
  closeHistoryBatch()
  const next = historyRedo.pop()
  if (!next) return
  historyUndo.push(captureHistoryEntry())
  if (historyUndo.length > HISTORY_LIMIT) historyUndo.shift()
  trimHistoryMemory()
  restoreHistoryEntry(next)
}

// ── Source-preserving structural edits ───────────────────────────────
//
// Chrome's native line merge is unusable in this editor. When it joins
// two lines it moves only *rendered* content: our `display:none`
// `.md-marker` spans are discarded (and inline `style` attributes get
// injected in their place). Because reclassify then rebuilds the
// markdown from the surviving textContent, a single Backspace at a line
// start silently rewrote the file — `second with **bold** text` came
// back as `second with bold text`, and the same for `` `code` ``. The
// delimiters, not just their rendering, were gone.
//
// So every edit that spans a line boundary is performed here instead,
// in markdown-source coordinates (each line's textContent, markers
// included), and the DOM is rebuilt from that. Callers preventDefault
// the native behaviour first.

// Nearest .editor-line ancestor of a node, or null when outside.
// Where a pointer event lands, in document terms. caretRangeFromPoint is the
// widely-supported spelling; caretPositionFromPoint is the standard one.
function caretRangeFromPoint(x: number, y: number): Range | null {
  const d = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node, offset: number } | null
  }
  if (typeof d.caretRangeFromPoint === 'function') return d.caretRangeFromPoint(x, y)
  const pos = d.caretPositionFromPoint?.(x, y)
  if (!pos) return null
  const r = document.createRange()
  r.setStart(pos.offsetNode, pos.offset)
  r.collapse(true)
  return r
}

interface DragSource {
  startLine: HTMLElement
  endLine: HTMLElement
  startOffset: number
  endOffset: number
}
let dragSource: DragSource | null = null

function lineElOf(node: Node | null): HTMLElement | null {
  let n: Node | null = node
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE
        && (n as HTMLElement).classList?.contains('editor-line')) return n as HTMLElement
    n = n.parentNode
  }
  return null
}

// Replace the source span between (startLine, startOff) and
// (endLine, endOff) with `insert`, then re-derive the whole line tree.
// `insert` may contain newlines — a paste over a multi-line selection
// goes through here too. Offsets are line-textContent offsets, so they
// address the markdown, not the visible text.
function replaceSourceRange(
  startLine: HTMLElement, startOff: number,
  endLine: HTMLElement, endOff: number,
  insert: string,
): void {
  if (!docEl) return
  const head = (startLine.textContent || '').slice(0, startOff)
  const tail = (endLine.textContent || '').slice(endOff)

  // Drop every line from startLine's successor through endLine; their
  // content is already folded into head/tail.
  if (startLine !== endLine) {
    let n = startLine.nextElementSibling
    while (n) {
      const next = n.nextElementSibling
      const wasEnd = n === endLine
      n.remove()
      if (wasEnd) break
      n = next
    }
  }

  const merged = head + insert + tail
  const caretOffset = head.length + insert.length
  const parts = merged.split('\n')
  // Build as `body` placeholders and let reclassifyLines assign real
  // kinds — it has the cross-line context (code fences) that a local
  // decision here would miss.
  const built: HTMLElement[] = []
  const frag = document.createDocumentFragment()
  for (const part of parts) {
    const el = buildLineEl(part, 'body')
    built.push(el)
    frag.appendChild(el)
  }
  startLine.replaceWith(frag)
  reclassifyLines()

  // Walk the caret's source offset back into (line, offset). rebuild
  // mutates line elements in place, so `built` references stay valid.
  let remaining = caretOffset
  let idx = 0
  while (idx < parts.length - 1 && remaining > parts[idx].length) {
    remaining -= parts[idx].length + 1
    idx++
  }
  const target = built[idx]
  if (target) setCursorOffsetInLine(target, Math.max(0, Math.min(remaining, (target.textContent || '').length)))
}

// Join `line` onto the line above it. The surviving line keeps its own
// block marker; the incoming line's marker is dropped, since a single
// line can only carry one (this is what every markdown editor does when
// you join a list item onto the paragraph above). Inline markers ride
// along untouched because we move source text, not rendered nodes.
function mergeLineBackward(line: HTMLElement): void {
  const keep = line.previousElementSibling as HTMLElement | null
  if (!keep) return
  const kind = (line.dataset.kind || 'body') as LineKind
  const text = line.textContent || ''
  const dropLen = hasStrippableMarker(kind)
    ? blockMarkerLength(kind, text)
    : 0
  replaceSourceRange(keep, (keep.textContent || '').length, line, dropLen, '')
}

// Remove a line's block marker in place, demoting it to body text.
// Backspace at the visible start of a heading or list item used to be a
// dead key: the caret snaps past the hidden marker, so there was nothing
// behind it to delete and the marker could only be removed by selecting
// the whole line. Now it strips the marker, matching iA Writer / Typora,
// and a second Backspace merges the line as usual.
function stripBlockMarker(line: HTMLElement): void {
  const kind = (line.dataset.kind || 'body') as LineKind
  const text = line.textContent || ''
  const len = blockMarkerLength(kind, text)
  if (len <= 0) return
  replaceSourceRange(line, 0, line, len, '')
}

function updateEmptyState() {
  if (!docEl) return
  const text = serializeDoc()
  if (text === '') docEl.dataset.empty = 'true'
  else             docEl.removeAttribute('data-empty')
}

// Test whether a line's current DOM structure matches what
// buildLineEl(textContent, kind) would produce — used to decide
// whether to rebuild on input. Mismatch happens when:
//   - kind changed (user typed/erased a `#` marker prefix, or a
//     ``` fence appeared/disappeared somewhere up the doc)
//   - the marker span content drifted from its kind's prefix
//   - the inline-bold/code structure changed (user typed/closed a
//     `**` or `` ` `` pair, or broke one) so a wrapper needs to
//     appear / disappear / move
//   - any segment got split across multiple text nodes from browser
//     edit operations (cursor offset accounting depends on each
//     segment being a single text node).
// `kind` is supplied by the caller (classifyLines) because code-
// block kinds depend on cross-line state and can't be derived from
// the line's own text alone.
// Does one DOM node match what fillInline would have built for one
// parsed segment? A plain run is a single text node; every wrapped run
// is its tag holding marker / text / marker. A link on a revealed line
// is rendered as its own source, so it matches a plain text node too.
function inlineSegMatches(node: Node | undefined, seg: InlineSegment, revealLinks: boolean): boolean {
  if (!node) return false
  const spec = revealLinks && seg.kind === 'link' ? null : inlineWrapSpec(seg)
  if (!spec) {
    return node.nodeType === Node.TEXT_NODE && node.textContent === inlineSource(seg)
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as HTMLElement
  if (el.tagName !== spec.tag) return false
  if (el.childNodes.length !== 3) return false
  const [open, inner, close] = Array.from(el.childNodes)
  if (open.nodeType !== Node.ELEMENT_NODE || !(open as HTMLElement).classList.contains('md-marker') || open.textContent !== spec.open) return false
  if (close.nodeType !== Node.ELEMENT_NODE || !(close as HTMLElement).classList.contains('md-marker') || close.textContent !== spec.close) return false
  return inner.nodeType === Node.TEXT_NODE && inner.textContent === seg.text
}

// Whether fillInline would have closed this run of segments with the
// empty-text sentinel it appends after a wrapped run.
function endsInWrap(segs: InlineSegment[], revealLinks: boolean): boolean {
  const last = segs[segs.length - 1]
  if (!last) return false
  return !!(revealLinks && last.kind === 'link' ? null : inlineWrapSpec(last))
}

// Validates a run of nodes filled by fillInline — a table cell's
// children, or what follows an ordinary line's block marker.
function inlineMatchesModel(children: Node[], text: string, revealLinks: boolean): boolean {
  if (text === '') {
    return children.length === 1
      && children[0].nodeType === Node.TEXT_NODE
      && children[0].textContent === ''
  }
  const segs = parseInline(text)
  const sentinel = endsInWrap(segs, revealLinks)
  if (children.length !== segs.length && !(sentinel && children.length === segs.length + 1)) return false
  for (let i = 0; i < segs.length; i++) {
    if (!inlineSegMatches(children[i], segs[i], revealLinks)) return false
  }
  if (children.length > segs.length) {
    const tail = children[segs.length]
    if (tail.nodeType !== Node.TEXT_NODE || tail.textContent !== '') return false
  }
  return true
}

function lineMatchesModel(line: HTMLElement, kind: LineKind, revealLinks: boolean): boolean {
  if (line.dataset.kind !== kind) return false
  const txt = line.textContent || ''
  const children = Array.from(line.childNodes)

  // The caret arriving on or leaving a line that holds a link changes
  // how that link is drawn, so it has to force a rebuild.
  const wantReveal = revealLinks && LINK_HINT_RE.test(txt)
  if ((line.dataset.reveal === 'links') !== wantReveal) return false

  // For list-item lines, the visual marker shown by ::before is
  // carried in data-list-marker. If the writer edited the number
  // ("1." → "2."), the textContent prefix changes but the cached
  // attribute would stay stale unless we force a rebuild. Validate
  // the attribute matches what buildLineEl would emit for this text.
  if (kind === 'list-item') {
    const prefix = txt.slice(0, blockMarkerLength(kind, txt))
    const expectedMarker = prefix.startsWith('-') ? '•' : prefix.trimEnd()
    if (line.dataset.listMarker !== expectedMarker) return false
  }

  if (kind === 'code-fence-open' || kind === 'code-fence-close'
      || kind === 'rule' || kind === 'table-delim') {
    if (txt === '') {
      return children.length === 1
        && children[0].nodeType === Node.ELEMENT_NODE
        && (children[0] as HTMLElement).tagName === 'BR'
    }
    return children.length === 1
      && children[0].nodeType === Node.ELEMENT_NODE
      && (children[0] as HTMLElement).classList.contains('md-marker')
      && children[0].textContent === txt
  }

  if (kind === 'code-content' || kind === 'source') {
    if (txt === '') {
      return children.length === 1
        && children[0].nodeType === Node.ELEMENT_NODE
        && (children[0] as HTMLElement).tagName === 'BR'
    }
    return children.length === 1
      && children[0].nodeType === Node.TEXT_NODE
      && children[0].textContent === txt
  }

  if (isTableRowKind(kind)) {
    const parts = splitTableRow(txt)
    if (!parts) {
      // Mirrors buildLineEl's unreachable fallback: one plain text node.
      return children.length === 1
        && children[0].nodeType === Node.TEXT_NODE
        && children[0].textContent === txt
    }
    if (children.length !== parts.markers.length + parts.cells.length) return false
    for (let m = 0; m < parts.markers.length; m++) {
      const marker = children[m * 2]
      if (marker.nodeType !== Node.ELEMENT_NODE) return false
      const me = marker as HTMLElement
      if (!me.classList.contains('md-marker')) return false
      if (me.textContent !== parts.markers[m]) return false
      if (m >= parts.cells.length) continue
      const cell = children[m * 2 + 1]
      if (cell.nodeType !== Node.ELEMENT_NODE) return false
      const ce = cell as HTMLElement
      if (!ce.classList.contains('editor-cell')) return false
      if (!inlineMatchesModel(Array.from(ce.childNodes), parts.cells[m], revealLinks)) return false
    }
    return true
  }

  const prefixLen = blockMarkerLength(kind, txt)
  const expectedPrefix = txt.slice(0, prefixLen)
  const rest = txt.slice(prefixLen)
  let i = 0

  if (expectedPrefix !== '') {
    const first = children[i]
    if (!first || first.nodeType !== Node.ELEMENT_NODE) return false
    const fe = first as HTMLElement
    if (!fe.classList.contains('md-marker')) return false
    if (fe.textContent !== expectedPrefix) return false
    i++
  }

  if (rest === '') {
    // Empty rest: exactly one <br> filler.
    if (children.length !== i + 1) return false
    const br = children[i]
    return br.nodeType === Node.ELEMENT_NODE && (br as HTMLElement).tagName === 'BR'
  }

  // Everything after the block marker is one inline run, validated the
  // same way a table cell's is.
  return inlineMatchesModel(children.slice(i), rest, revealLinks)
}

// Rebuild a line in place at the given kind, preserving cursor offset
// (in textContent coordinates, including any hidden marker characters).
// Replacing only the line's children (not the line div itself) keeps
// any external references to the div alive.
function rebuildLineInPlace(line: HTMLElement, kind: LineKind, revealLinks: boolean = false) {
  const txt = line.textContent || ''
  const cursor = getCursorOffsetInLine(line)
  const fresh = buildLineEl(txt, kind, revealLinks)
  if (fresh.dataset.reveal !== undefined) line.dataset.reveal = fresh.dataset.reveal
  else                                    delete line.dataset.reveal
  line.dataset.kind = fresh.dataset.kind!
  // Mirror list-item's data-list-marker attribute from the fresh
  // element. When a line transitions out of list-item (back to body,
  // or up to a heading), delete the stale attribute so CSS doesn't
  // render a ghost bullet via ::before.
  if (fresh.dataset.listMarker !== undefined) {
    line.dataset.listMarker = fresh.dataset.listMarker
  } else {
    delete line.dataset.listMarker
  }
  line.innerHTML = ''
  while (fresh.firstChild) line.appendChild(fresh.firstChild)
  if (cursor !== null) setCursorOffsetInLine(line, cursor)
}

// Re-classify every line and clean up structure. Runs on every input
// event; the common case is "no structural change" and we touch
// nothing. When the user types a marker character (`# `, `## `, ``` )
// or breaks one (deleting through a marker), the affected line — and
// in the case of code-block fences, every line that follows in the
// block — gets rebuilt in place with cursor preserved at its
// textContent offset.
// Renumber the ordered-list block containing `line`. A numbered list is a run
// of adjacent list-item lines whose markers are numeric; inserting into one
// used to leave the numbers repeating (1, 2, 2, 3) and deleting left a gap.
// Bullets are untouched — their marker carries no ordinal.
function renumberOrderedListAround(line: HTMLElement | null): void {
  if (!docEl || !line) return
  const isNumbered = (el: Element | null) => !!el
    && (el as HTMLElement).dataset?.kind === 'list-item'
    && /^\d+[.)] /.test((el as HTMLElement).textContent || '')
  if (!isNumbered(line)) return

  let first: HTMLElement = line
  while (isNumbered(first.previousElementSibling)) {
    first = first.previousElementSibling as HTMLElement
  }
  const block: HTMLElement[] = []
  for (let el: HTMLElement | null = first; el && isNumbered(el);
       el = el.nextElementSibling as HTMLElement | null) {
    block.push(el)
  }

  // Keep whichever delimiter the writer chose, and start from their first
  // number rather than forcing 1 — a list may deliberately begin at 0 or 5.
  const head = (block[0].textContent || '').match(/^(\d+)([.)]) /)
  if (!head) return
  const start = parseInt(head[1], 10)
  const delim = head[2]
  block.forEach((el, i) => {
    const text = el.textContent || ''
    const want = `${start + i}${delim} `
    const rest = text.replace(/^\d+[.)] /, '')
    if (`${want}${rest}` === text) return
    const caret = getCursorOffsetInLine(el)
    const fresh = buildLineEl(`${want}${rest}`, 'list-item')
    el.dataset.kind = fresh.dataset.kind!
    if (fresh.dataset.listMarker !== undefined) el.dataset.listMarker = fresh.dataset.listMarker
    el.innerHTML = ''
    while (fresh.firstChild) el.appendChild(fresh.firstChild)
    if (caret !== null) setCursorOffsetInLine(el, Math.min(caret, (el.textContent || '').length))
  })
}

function reclassifyLines() {
  if (!docEl) return
  // The browser sometimes promotes the contenteditable into containing
  // bare text nodes (e.g. when typing into an empty doc) or stray <br>s
  // at the root. Wrap any of those in editor-line divs so the
  // per-line model stays consistent. We don't yet know each new line's
  // kind here — body is a safe placeholder; classifyLines below
  // will produce the real kind and trigger a rebuild if needed.
  for (const node of Array.from(docEl.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const wrap = buildLineEl(node.textContent || '', 'body')
      docEl.replaceChild(wrap, node)
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.tagName === 'BR') {
        const wrap = buildLineEl('', 'body')
        docEl.replaceChild(wrap, node)
      } else if (!el.classList.contains('editor-line')) {
        // Some other element snuck in (e.g. <p> from a paste). Re-wrap
        // it as a line and pull the text across.
        const wrap = buildLineEl(el.textContent || '', 'body')
        docEl.replaceChild(wrap, node)
      }
    }
  }
  // Compute kinds doc-level (so code-block fences propagate) and
  // rebuild any line whose DOM doesn't match its expected shape.
  const lines = Array.from(docEl.children) as HTMLElement[]
  const texts = lines.map((l) => l.textContent || '')
  // Find which line currently holds the caret. It gets two things no
  // other line does: classifyLines returns it as `source` if it would
  // otherwise be markup from end to end, and buildLineEl shows the
  // source of any link on it. Both exist so the writer can see and edit
  // characters that are hidden everywhere else.
  let caretLineIdx = -1
  {
    const sel = window.getSelection()
    const anchor = sel && sel.rangeCount > 0 ? sel.anchorNode : null
    if (anchor) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].contains(anchor)) { caretLineIdx = i; break }
      }
    }
  }
  const kinds = classifyLines(texts, caretLineIdx)
  for (let idx = 0; idx < lines.length; idx++) {
    const el = lines[idx]
    // The caret's line shows the source of any link it holds, so the
    // writer can reach a URL that is otherwise hidden. Every other line
    // keeps its links rendered.
    const reveal = idx === caretLineIdx
    if (!lineMatchesModel(el, kinds[idx], reveal)) {
      rebuildLineInPlace(el, kinds[idx], reveal)
    }
    // Ensure empty lines have a <br> filler.
    if ((el.textContent || '') === '' && !el.querySelector('br')) {
      el.appendChild(document.createElement('br'))
    }
  }
  // If the doc somehow got emptied entirely, restore one empty line
  // so the cursor has a place to live.
  if (docEl.children.length === 0) {
    docEl.appendChild(buildLineEl('', 'body'))
  }
  applyTableLayout()
}

function clearTableLayout(line: HTMLElement): void {
  if (line.style.gridTemplateColumns) line.style.gridTemplateColumns = ''
}

// Hand every row of a table the same grid tracks, and each cell its
// column's alignment. This is a separate pass from the rebuild above
// because it depends on the whole block rather than on one line, and
// because column widths change far more often than DOM structure does
// — typing a longer word only shifts the tracks.
function applyTableLayout(): void {
  if (!docEl) return
  const lines = Array.from(docEl.children) as HTMLElement[]
  let i = 0
  while (i < lines.length) {
    if (lines[i].dataset.kind !== 'table-head') {
      clearTableLayout(lines[i])
      i++
      continue
    }
    const rows: HTMLElement[] = [lines[i]]
    let delimText = ''
    let j = i + 1
    const delimKind = lines[j]?.dataset.kind
    if (delimKind === 'table-delim' || delimKind === 'source') {
      delimText = lines[j].textContent || ''
      clearTableLayout(lines[j])
      j++
    }
    while (lines[j]?.dataset.kind === 'table-row') { rows.push(lines[j]); j++ }

    const template = tableColumnTemplate(rows.map((row) => row.textContent || ''))
    const aligns = parseTableAligns(delimText)
    for (const row of rows) {
      if (row.style.gridTemplateColumns !== template) row.style.gridTemplateColumns = template
      row.querySelectorAll<HTMLElement>(':scope > .editor-cell').forEach((cell, c) => {
        const want = aligns[c] ?? ''
        if (cell.style.textAlign !== want) cell.style.textAlign = want
      })
    }
    i = j
  }
}

// ── Table editing ────────────────────────────────────────────────────
//
// Everything below works in source-offset coordinates and rebuilds
// through the same reclassify pass as the rest of the editor, so a
// table row is never a special case for save, undo or annotations —
// only for the gestures a grid of cells needs and prose doesn't.

// Where each cell's content sits in the row's source text. Offsets are
// textContent coordinates, the same ones the caret helpers speak.
function tableCellSpans(text: string): { start: number, end: number }[] {
  const parts = splitTableRow(text)
  if (!parts) return []
  const spans: { start: number, end: number }[] = []
  let at = 0
  parts.markers.forEach((marker, i) => {
    at += marker.length
    if (i < parts.cells.length) {
      spans.push({ start: at, end: at + parts.cells[i].length })
      at += parts.cells[i].length
    }
  })
  return spans
}



function isTableLine(el: Element | null): boolean {
  const kind = (el as HTMLElement | null)?.dataset?.kind
  return kind === 'table-head' || kind === 'table-row'
    || kind === 'table-delim' || kind === 'source'
}

// The next / previous line that holds cells, stepping over the
// delimiter row (which sits between the header and the first body row
// and has no cells of its own).
function nextTableRowLine(line: HTMLElement): HTMLElement | null {
  let el = line.nextElementSibling as HTMLElement | null
  while (el && (el.dataset.kind === 'table-delim' || el.dataset.kind === 'source')) {
    el = el.nextElementSibling as HTMLElement | null
  }
  return el && isTableRowKind(el.dataset.kind as LineKind) ? el : null
}

function prevTableRowLine(line: HTMLElement): HTMLElement | null {
  let el = line.previousElementSibling as HTMLElement | null
  while (el && (el.dataset.kind === 'table-delim' || el.dataset.kind === 'source')) {
    el = el.previousElementSibling as HTMLElement | null
  }
  return el && isTableRowKind(el.dataset.kind as LineKind) ? el : null
}

function lastTableLineOf(line: HTMLElement): HTMLElement {
  let el = line
  while (isTableLine(el.nextElementSibling)) el = el.nextElementSibling as HTMLElement
  return el
}

function placeCaretInTableCell(line: HTMLElement, index: number, at: 'start' | 'end' = 'start'): void {
  const spans = tableCellSpans(line.textContent || '')
  const span = spans[index]
  setCursorOffsetInLine(line, span ? (at === 'start' ? span.start : span.end) : (line.textContent || '').length)
}

// Every table gesture rewrites the DOM directly rather than going
// through beforeinput, so each one closes the same post-edit loop the
// input handler would have run.
function afterTableEdit(): void {
  reclassifyLines()
  updateEmptyState()
  scheduleSave()
  renderAnnotationOverlay()
}

function insertTableRowAfter(anchor: HTMLElement, columns: number): HTMLElement {
  const row = buildLineEl(emptyTableRowText(columns), 'table-row')
  anchor.parentNode!.insertBefore(row, anchor.nextSibling)
  return row
}

// Enter inside a table, and the one gesture that creates a table. Returns
// true when it handled the key.
function handleTableEnter(): boolean {
  if (!docEl) return false
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return false
  const line = lineElOf(range.startContainer)
  if (!line || line.parentElement !== docEl) return false
  const kind = (line.dataset.kind || 'body') as LineKind
  const text = line.textContent || ''

  if (isTableRowKind(kind)) {
    const parts = splitTableRow(text)
    if (!parts) return false
    // A trailing blank row means the writer is done with the table, the
    // same way a blank list item means they are done with the list: the
    // row goes and an empty paragraph takes its place.
    if (kind === 'table-row' && parts.cells.every((c) => c === '') && !nextTableRowLine(line)) {
      recordHistoryPoint()
      const fresh = buildLineEl('', 'body')
      line.replaceWith(fresh)
      setCursorOffsetInLine(fresh, 0)
      afterTableEdit()
      return true
    }
    recordHistoryPoint()
    // From the header the new row belongs under the delimiter, not
    // between the header and it.
    const anchor = kind === 'table-head'
      ? (line.nextElementSibling as HTMLElement | null) ?? line
      : line
    placeCaretInTableCell(insertTableRowAfter(anchor, parts.cells.length), 0)
    afterTableEdit()
    return true
  }

  // A finished pipe line that isn't a table yet: write the delimiter row
  // for it. Typing `| --- | --- |` by hand is the least loved part of
  // table markdown and getting its column count wrong is the usual
  // reason a table renders as prose.
  if (kind === 'body' && isTableRowText(text)) {
    const offset = offsetInLineFor(line, range.startContainer, range.startOffset)
    if (offset !== text.length) return false
    const parts = splitTableRow(text)
    if (!parts) return false
    const below = line.nextElementSibling as HTMLElement | null
    if (below && isTableDelimText(below.textContent || '')) return false
    recordHistoryPoint()
    const delim = buildLineEl(tableDelimTextFor(parts.cells.length), 'table-delim')
    line.parentNode!.insertBefore(delim, line.nextSibling)
    placeCaretInTableCell(insertTableRowAfter(delim, parts.cells.length), 0)
    afterTableEdit()
    return true
  }
  return false
}

// Tab / Shift+Tab walk the cells. Inside a table the key never reaches
// the browser's focus handling — losing the caret to the next control
// mid-table would be a far worse outcome than a swallowed Tab.
function handleTableTab(back: boolean): boolean {
  if (!docEl) return false
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const line = lineElOf(sel.getRangeAt(0).startContainer)
  if (!line || line.parentElement !== docEl) return false
  if (!isTableRowKind((line.dataset.kind || 'body') as LineKind)) return false
  const spans = tableCellSpans(line.textContent || '')
  if (spans.length === 0) return false

  const range = sel.getRangeAt(0)
  const offset = offsetInLineFor(line, range.startContainer, range.startOffset)
  let index = spans.findIndex((s) => offset >= s.start && offset <= s.end)
  // A caret parked inside a pipe belongs to whichever edge we're heading
  // away from.
  if (index < 0) index = back ? spans.length - 1 : 0

  if (back) {
    if (index > 0) { placeCaretInTableCell(line, index - 1, 'end'); return true }
    const prev = prevTableRowLine(line)
    if (prev) placeCaretInTableCell(prev, tableCellSpans(prev.textContent || '').length - 1, 'end')
    return true
  }
  if (index < spans.length - 1) { placeCaretInTableCell(line, index + 1, 'end'); return true }
  const next = nextTableRowLine(line)
  if (next) { placeCaretInTableCell(next, 0, 'end'); return true }
  // Past the last cell of the last row — grow the table. The anchor is
  // the block's last line so tabbing out of a header with no body rows
  // yet lands below the delimiter.
  recordHistoryPoint()
  placeCaretInTableCell(insertTableRowAfter(lastTableLineOf(line), spans.length), 0)
  afterTableEdit()
  return true
}

// Is the caret on the cell's first (up) or last (down) visual line? A
// cell whose text has wrapped has line boxes of its own to move through
// before "down" can mean the next row.
//
// The comparison is against the text's own line fragments rather than
// the cell's box: a caret rect is only as tall as the glyphs, while the
// box adds padding and the full line-height on top, so measuring to the
// box's edge would report "not at the bottom" on a cell of one line.
// Half a line of tolerance absorbs the small differences between a
// caret and an inline run of another size, such as a `code` span.
function caretAtCellEdge(range: Range, cell: HTMLElement, down: boolean): boolean {
  const caret = range.getBoundingClientRect()
  // A caret in an empty cell has no rect to measure; it is on the only
  // line the cell has, which is both its first and its last.
  if (caret.height === 0) return true
  const probe = document.createRange()
  probe.selectNodeContents(cell)
  const rects = Array.from(probe.getClientRects()).filter((r) => r.height > 0)
  if (rects.length === 0) return true
  const slack = (parseFloat(getComputedStyle(cell).lineHeight) || caret.height) / 2
  return down
    ? caret.bottom >= Math.max(...rects.map((r) => r.bottom)) - slack
    : caret.top    <= Math.min(...rects.map((r) => r.top))    + slack
}

// Up / Down inside a table. Every cell is a grid item, so Chrome counts
// each one as a line of its own and the default walks the row cell by
// cell before dropping to the next: three presses to get from a header
// to the row under it, through two columns nobody asked for. Move by
// column instead — which is what up and down mean in a grid of cells —
// and leave movement inside a wrapped cell to the browser.
function handleTableVerticalMove(down: boolean): boolean {
  if (!docEl) return false
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return false
  const line = lineElOf(range.startContainer)
  if (!line || line.parentElement !== docEl) return false
  if (!isTableRowKind((line.dataset.kind || 'body') as LineKind)) return false

  const spans = tableCellSpans(line.textContent || '')
  const offset = offsetInLineFor(line, range.startContainer, range.startOffset)
  const index = spans.findIndex((s) => offset >= s.start && offset <= s.end)
  if (index < 0) return false
  const cell = line.querySelectorAll<HTMLElement>(':scope > .editor-cell')[index]
  if (cell && !caretAtCellEdge(range, cell, down)) return false

  // Nothing above or below inside the table: let the default carry the
  // caret out into the prose on either side.
  const target = down ? nextTableRowLine(line) : prevTableRowLine(line)
  if (!target) return false
  const targetSpans = tableCellSpans(target.textContent || '')
  const to = targetSpans[Math.min(index, targetSpans.length - 1)]
  if (!to) return false
  // Hold the same depth into the cell, so arrowing down a column of
  // similar values keeps reading as a column.
  setCursorOffsetInLine(target, Math.min(to.start + (offset - spans[index].start), to.end))
  return true
}

// Backspace / Delete sitting on a cell boundary. Chrome treats the
// hidden pipe between two cells as zero-width and deletes straight
// through it, taking the pipe and a visible character from the
// neighbouring cell in one keystroke — which silently welds two columns
// together. Owning both boundary positions means the row's shape only
// ever changes deliberately:
//   - into a neighbouring cell that has content: eat one character of it
//   - into an empty row: drop that row
//   - into an empty cell, or across a row boundary: step the caret over
//   - at the outer edge of the first / last row: drop the outer pipe, so
//     the row falls out of the table. This is the table's answer to
//     backspacing a heading's `# ` away, and at the top-left corner it
//     is how a whole table is unmade.
//
// 'moved' and 'edited' are told apart so the caret-only cases don't
// leave an undo step behind that undoes nothing when pressed.
type BoundaryDelete = false | 'moved' | 'edited'

function handleTableBoundaryDelete(line: HTMLElement, forward: boolean, offset: number): BoundaryDelete {
  const text = line.textContent || ''
  const kind = (line.dataset.kind || 'body') as LineKind
  const spans = tableCellSpans(text)
  const index = spans.findIndex((s) => offset >= s.start && offset <= s.end)
  if (index < 0) return false

  const step = (target: HTMLElement, cellIndex: number, at: 'start' | 'end'): BoundaryDelete => {
    placeCaretInTableCell(target, cellIndex, at)
    return 'moved'
  }
  const dropRowInto = (row: HTMLElement, target: HTMLElement): BoundaryDelete => {
    recordHistoryPoint()
    row.remove()
    placeCaretInTableCell(target, tableCellSpans(target.textContent || '').length - 1, 'end')
    afterTableEdit()
    return 'edited'
  }
  const isBlankRow = (row: HTMLElement): boolean => {
    const parts = splitTableRow(row.textContent || '')
    return !!parts && parts.cells.every((c) => c === '')
  }
  // replaceSourceRange reclassifies on its own; the rest of the post-edit
  // loop still has to run.
  const cut = (from: number, to: number): BoundaryDelete => {
    recordHistoryPoint()
    replaceSourceRange(line, from, line, to, '')
    updateEmptyState()
    scheduleSave()
    renderAnnotationOverlay()
    return 'edited'
  }

  if (!forward && offset === spans[index].start) {
    if (index > 0) {
      const before = spans[index - 1]
      return before.end > before.start
        ? cut(before.end - 1, before.end)
        : step(line, index - 1, 'end')
    }
    const prev = prevTableRowLine(line)
    if (!prev) return cut(0, blockMarkerLength(kind, text))
    if (kind === 'table-row' && isBlankRow(line)) return dropRowInto(line, prev)
    return step(prev, tableCellSpans(prev.textContent || '').length - 1, 'end')
  }

  if (forward && offset === spans[index].end) {
    if (index < spans.length - 1) {
      const after = spans[index + 1]
      return after.end > after.start
        ? cut(after.start, after.start + 1)
        : step(line, index + 1, 'start')
    }
    const next = nextTableRowLine(line)
    if (!next) return cut(text.length - blockTrailingMarkerLength(kind, text), text.length)
    if (isBlankRow(next)) return dropRowInto(next, line)
    return step(next, 0, 'start')
  }
  return false
}

// Two things on the caret's line show their source while it is there
// and hide it again once the caret leaves: a line that is marker from
// end to end (a fence, a rule, a table's delimiter row), and any link,
// whose address would otherwise be unreachable hidden text.
// The caret can arrive and depart by click or arrow key, neither of
// which fires `input`, so reclassify alone would leave the line a
// keystroke behind.
//
// This runs on every selectionchange — every cursor move, every frame
// of a drag-select — so the guard has to be cheap: one attribute query,
// one walk up from the anchor, and a regex only on the line the caret
// is actually on. The reclassify behind it can only run on a crossing.
function refreshCaretLineReveal(): void {
  if (!docEl) return
  const sel = window.getSelection()
  const anchor = sel && sel.rangeCount > 0 ? sel.anchorNode : null
  const line = anchor ? lineElOf(anchor) : null
  const open = docEl.querySelector<HTMLElement>(
    '.editor-line[data-kind="source"], .editor-line[data-reveal="links"]',
  )
  if (open && open !== line) { reclassifyLines(); return }
  if (!line) return
  if (isWhollyHidden((line.dataset.kind || 'body') as LineKind)
      || (line.dataset.reveal !== 'links' && LINK_HINT_RE.test(line.textContent || ''))) {
    reclassifyLines()
  }
}

function setMeta(text: string) {
  const source = text.startsWith('Annotation') ? 'editor-annotations' : 'editor-save'
  const routine = /^(Editing|Saving)/.test(text)
  if (routine) viewDiagnostic(source, text)
  else viewFeedback(source, 'Editor needs attention', text, /conflict|changed elsewhere/i.test(text) ? 'action_needed' : 'action_failed')
}

function setMetaForCurrent() {
  viewDiagnostic('editor-save', 'Saved')
  viewFeedback('editor-save', 'Editor needs attention', '')
}

function currentDoc(): DocSummary | null {
  if (!currentSlug) return null
  return docs.find((d) => d.slug === currentSlug) || null
}

// Trigger label is space-constrained — the bar lives at 680px max
// and shares the row with three icons + meta. Truncate to 20 chars
// with an ellipsis so long titles don't push the trigger off the
// bar. The full title still shows in the dropdown menu items.
function truncateTitleForTrigger(s: string): string {
  return s.length > 20 ? s.slice(0, 19).trimEnd() + '…' : s
}

function setTriggerTitle() {
  if (!triggerTitleEl) return
  const d = currentDoc()
  const full = d?.title || 'Untitled'
  triggerTitleEl.textContent = truncateTitleForTrigger(full)
  triggerTitleEl.title = full     // hover-tooltip shows the full title
}

let docsRead: Promise<boolean> | null = null
let docsGeneration = 0
let docsLoaded = false
let docsError = false

function renderDocMenu() {
  if (!menuEl) return
  if (!docs.length) {
    menuEl.innerHTML = `<div class="editor-doc-empty" role="status">${docsError ? 'Could not load documents. Reopen to retry.' : !docsLoaded ? 'Loading documents…' : 'No notes yet.'}</div>`
    return
  }
  const buckets: { name: string, items: DocSummary[] }[] = []
  let prev = ''
  for (const d of docs) {
    const b = groupBucket(d.updated_at)
    if (b !== prev) { buckets.push({ name: b, items: [d] }); prev = b }
    else            { buckets[buckets.length - 1].items.push(d) }
  }
  const parts: string[] = docsError ? ['<div class="editor-doc-empty" role="status">Could not refresh documents. Reopen to retry.</div>'] : []
  for (const b of buckets) {
    parts.push(`<h3 class="editor-doc-bucket">${escapeHtml(b.name)}</h3>`)
    for (const d of b.items) {
      const isActive = d.slug === currentSlug
      parts.push(`
        <button type="button"
                class="editor-doc-item${isActive ? ' is-active' : ''}"
                data-slug="${escapeHtml(d.slug)}"
                role="menuitem"
                title="${escapeHtml(d.title)}">
          <span class="editor-doc-title">${escapeHtml(d.title)}</span>
          <span class="editor-doc-time">${escapeHtml(relTime(d.updated_at))}</span>
        </button>
      `)
    }
  }
  patchContent(menuEl, parts.join(''))
}

function openMenu() {
  if (!menuEl || !triggerEl) return
  if (docsError && !docsRead) void fetchDocs()
  renderDocMenu()
  menuEl.hidden = false
  reveal(menuEl, { distance: 8 })
  triggerEl.setAttribute('aria-expanded', 'true')
  // Defer install so the click that opened the menu doesn't
  // immediately close it. Escape works from anywhere while the menu
  // is open, not just when the textarea has focus.
  setTimeout(() => {
    document.addEventListener('click', onOutsideClick)
    document.addEventListener('keydown', onMenuKeydown)
  }, 0)
}

function closeMenu() {
  if (!menuEl || !triggerEl) return
  menuEl.hidden = true
  triggerEl.setAttribute('aria-expanded', 'false')
  document.removeEventListener('click', onOutsideClick)
  document.removeEventListener('keydown', onMenuKeydown)
}

function onOutsideClick(e: MouseEvent) {
  if (!menuEl || !triggerEl) return
  const target = e.target as Node
  if (menuEl.contains(target) || triggerEl.contains(target)) return
  closeMenu()
}

function onMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeMenu()
  }
}

function fetchDocs({ fresh = false }: { fresh?: boolean } = {}): Promise<boolean> {
  if (docsRead && !fresh) return docsRead
  const generation = ++docsGeneration
  docsError = false
  const pending = readDocs(generation).finally(() => {
    if (docsRead === pending) docsRead = null
    if (generation === docsGeneration && menuEl && !menuEl.hidden) renderDocMenu()
  })
  docsRead = pending
  return pending
}

async function readDocs(generation: number): Promise<boolean> {
  try {
    const res = await fetch('/api/editor/docs')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (generation !== docsGeneration) return false
    if (!Array.isArray(data.docs)) throw new Error('Malformed document list')
    docs = data.docs as DocSummary[]
    docsLoaded = true
    viewFeedback('editor-documents', 'Editor documents unavailable', '')
    if (currentSlug) setTriggerTitle()
    return true
  } catch (err) {
    if (generation !== docsGeneration) return false
    console.error('[editor] fetchDocs failed:', err)
    docsError = true
    viewFeedback('editor-documents', 'Editor documents unavailable', (err as Error).message, 'read_failed')
    return false
  }
}

// Place the caret at the end of the editor (e.g. after loading a doc).
// Used so a freshly-loaded article doesn't pin the cursor at offset 0
// inside the first heading — natural to land where the writer left off.
function placeCaretAtEnd() {
  if (!docEl) return
  const last = docEl.lastElementChild as HTMLElement | null
  if (!last) return
  const range = document.createRange()
  // Walk to the deepest text node so the caret lands inside text rather
  // than after a <br> filler — those produce a "phantom row" caret.
  let target: Node = last
  while (target.lastChild && target.lastChild.nodeType !== Node.TEXT_NODE && target.lastChild.nodeName !== 'BR') {
    target = target.lastChild
  }
  if (target.lastChild && target.lastChild.nodeType === Node.TEXT_NODE) {
    target = target.lastChild
    range.setStart(target, (target.textContent || '').length)
  } else {
    range.selectNodeContents(target)
    range.collapse(false)
  }
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

// A save that will not succeed must not silently lock the editor. When the
// file has changed underneath us the flush keeps failing, and every doc-picker
// click and every Cmd+N used to be a no-op with nothing said — the view simply
// stopped responding for the rest of the session, and the only way out was to
// reload and lose the unsaved text. Say what happened and let the user decide.
async function flushBeforeLeavingDocument(action: string): Promise<boolean> {
  if (await flushEditorSaves()) return true
  const keep = window.confirm(
    `This document could not be saved — it changed somewhere else since it was opened.\n\n`
    + `OK to ${action} anyway and lose the unsaved changes, or Cancel to stay here `
    + `and copy your text out first.`,
  )
  if (!keep) {
    setMeta('Not saved — changed elsewhere')
    return false
  }
  await discardEditorSaves()
  return true
}

async function loadDoc(slug: string) {
  if (!docEl) return
  const requestId = ++loadRequestId
  if (!(await flushBeforeLeavingDocument('switch documents')) || requestId !== loadRequestId) return
  clearInlineThreads()
  closePublishPanel()
  chatSidePane.setHighlight(null)
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(slug)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (requestId !== loadRequestId || viewEl.hidden) return
    const nextSlug = String(data.slug || slug)
    if (typeof data.content !== 'string' || !isEditorVersion(data.version)) {
      throw new Error('malformed editor document response')
    }
    // The current document remains editable while the target request is
    // in flight. Drain once more so keystrokes made during that request
    // cannot be stranded when currentSlug changes below.
    if (!(await flushBeforeLeavingDocument('switch documents')) || requestId !== loadRequestId) return
    // The document is saved here, so history preservation is best-effort:
    // losing undo steps must never trap navigation on a saved document.
    const historyOutcome = persistEditorHistory()
    currentSlug = nextSlug
    docEl.contentEditable = googleImporting ? 'false' : 'true'
    articleReviews?.clear()
    googleDocuments?.load(null)
    documentVersions.set(currentSlug, data.version)
    loadIntoEditor(data.content)
    // History is per-document: undo must never walk back into the
    // previous document's text and save it over this one.
    resetEditorHistory()
    let restored: EditorHistoryEntry | null = null
    try {
      const history = readEditorHistory(sessionStorage, currentSlug, data.content)
      if (history) {
        historyUndo = history.undo
        historyRedo = history.redo
        restored = history.current
      }
    } catch (error) {
      console.error('[editor] history could not be restored:', error)
    }
    try { localStorage.setItem(LAST_OPEN_KEY, currentSlug) } catch { /* ignore */ }
    setTriggerTitle()
    setMetaForCurrent()
    // setMetaForCurrent clears the notice persistEditorHistory just
    // reported; the new document inherits it so the loss stays visible.
    if (historyOutcome !== 'kept') setMeta(historyPersistNotice(historyOutcome))
    docEl.focus()
    placeCaretAtEnd()
    if (restored) {
      const line = docEl.children[Math.min(restored.line, docEl.children.length - 1)] as HTMLElement | undefined
      if (line) setCursorOffsetInLine(line, Math.min(restored.offset, (line.textContent || '').length))
    }
    // Each side panel binds to the document before any independent read can
    // yield; leaving during annotation loading must still permit resume.
    void articleReviews?.load(currentSlug)
    googleDocuments?.load(currentSlug)
    await fetchAnnotations(currentSlug)
    if (requestId !== loadRequestId || viewEl.hidden) return
    renderAnnotationOverlay()
  } catch (err) {
    console.error('[editor] loadDoc failed:', err)
    if (requestId === loadRequestId) setMeta('Could not load document')
  }
}

async function newDoc() {
  if (!(await flushBeforeLeavingDocument('start a new document'))) return
  closePublishPanel()
  try {
    const res = await fetch('/api/editor/docs', { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const slug = String(data.slug || '')
    if (!slug) return
    void fetchDocs({ fresh: true })
    await loadDoc(slug)
  } catch (err) {
    console.error('[editor] newDoc failed:', err)
  }
}

// Copy the entire document (raw markdown) to the clipboard, with a
// brief icon swap to a checkmark for visual confirmation. Falls back
// to the textarea + execCommand path on contexts where
// navigator.clipboard isn't available (insecure origin, some
// embedded webviews).
async function copyDoc() {
  if (!docEl || !copyBtnEl) return
  const text = serializeDoc()
  let ok = false
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      ok = true
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ok = document.execCommand('copy')
      ta.remove()
    }
  } catch (err) {
    console.error('[editor] copy failed:', err)
  }
  if (!ok) return
  const original = copyBtnEl.innerHTML
  copyBtnEl.innerHTML = ICON_CHECK
  copyBtnEl.classList.add('is-copied')
  window.setTimeout(() => {
    if (!copyBtnEl) return
    copyBtnEl.classList.remove('is-copied')
    copyBtnEl.innerHTML = original
  }, 1200)
}

async function deleteCurrent() {
  const d = currentDoc()
  if (!d) return
  const ok = window.confirm(`Delete "${d.title}"? This cannot be undone.`)
  if (!ok) return
  closePublishPanel()
  deletingSlug = d.slug
  await discardEditorSaves()
  loadRequestId += 1
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(d.slug)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    console.error('[editor] delete failed:', err)
    deletingSlug = null
    if (currentSlug === d.slug) {
      scheduleSave()
      scheduleAnnotationsSave()
    }
    return
  }
  // The deleted document must stop being an editable current target before
  // the replacement's async fetches begin. Otherwise keystrokes during that
  // gap can enqueue the old slug and recreate the file we just removed.
  try { sessionStorage.removeItem(editorHistoryKey(d.slug)) } catch (error) {
    console.error('[editor] deleted history could not be removed:', error)
  }
  documentVersions.delete(d.slug)
  annotationsVersions.delete(d.slug)
  currentSlug = null
  articleReviews?.clear()
    googleDocuments?.load(null)
  annotations = []
  annotationsReadySlug = null
  if (docEl) {
    docEl.contentEditable = 'false'
    loadIntoEditor('')
    resetEditorHistory()
  }
  docs = docs.filter((x) => x.slug !== d.slug)
  void fetchDocs({ fresh: true })
  try { localStorage.removeItem(LAST_OPEN_KEY) } catch { /* ignore */ }
  try {
    if (docs.length) {
      await loadDoc(docs[0].slug)
    } else {
      await newDoc()
    }
  } finally {
    deletingSlug = null
    if (docEl) {
      docEl.contentEditable = 'true'
      docEl.focus()
      placeCaretAtEnd()
    }
  }
}

// ── Edit-card binding ────────────────────────────────────────────────
//
// The session surface fires hover / accept / decline on edit cards and
// passes back the shared EditProposal shape. The host's job is:
//   - hover  → locate the `old` text in the doc and visually highlight
//              it; smooth-scroll the highlight into vertical centre.
//   - accept → apply the patch (replace `old` with `new`, or insert
//              after `context_before` for a pure insertion), then
//              save. Returns 'applied', 'conflict' or 'failed' so the
//              surface can record the decision accordingly.
//   - decline → nothing on the doc; the surface records it.
//
// All locate operations work in the same character-offset space as
// the existing annotation system (sum of textContent across lines,
// joined by '\n'). Disambiguation when `old` appears more than once
// uses context_before / context_after as anchors — the same model
// the response-format directive promises.

// Snapshot of the doc as a flat string + a line-prefix table for
// converting global char offsets back into (line, lineOffset) pairs.
// One walk per call — cheap, and the alternative (cached + invalidated
// on every keystroke) would be drift-prone.
function docTextSnapshot(): { text: string, lineStarts: number[] } {
  if (!docEl) return { text: '', lineStarts: [0] }
  const lines: string[] = []
  for (const child of Array.from(docEl.children)) {
    lines.push((child as HTMLElement).textContent || '')
  }
  const text = lines.join('\n')
  const lineStarts: number[] = [0]
  let acc = 0
  for (let i = 0; i < lines.length - 1; i++) {
    acc += lines[i].length + 1                 // +1 for the '\n'
    lineStarts.push(acc)
  }
  return { text, lineStarts }
}

// Locate the edit's target in the doc as a global char-offset range.
// Returns null if `old` isn't findable, or is findable in multiple
// places that context_before / context_after can't disambiguate.
// For pure insertions (old=""): the "range" is a zero-width slot
// positioned right after context_before's occurrence; we never insert
// blind into an ambiguous doc.
function findCharRangeForEdit(text: string, edit: EditProposal): { start: number, end: number } | null {
  const before = edit.context_before || ''
  const after  = edit.context_after  || ''
  if (edit.old === '') {
    if (!before) return null            // pure insertion with no anchor is unsafe
    // Disambiguate context_before by context_after if both given.
    const occurrences = allOccurrences(text, before)
    if (occurrences.length === 0) return null
    if (occurrences.length === 1) {
      const pos = occurrences[0] + before.length
      return { start: pos, end: pos }
    }
    for (const idx of occurrences) {
      const followStart = idx + before.length
      const follow = text.slice(followStart, followStart + after.length)
      if (after && follow === after) return { start: followStart, end: followStart }
    }
    return null
  }
  const occurrences = allOccurrences(text, edit.old)
  if (occurrences.length === 0) return null
  if (occurrences.length === 1) {
    return { start: occurrences[0], end: occurrences[0] + edit.old.length }
  }
  // Multiple matches — refuse to guess. At least one context anchor
  // must be supplied and must positively single out an occurrence;
  // otherwise the host treats it as a conflict and the user can ask
  // the model to provide context.
  if (!before && !after) return null
  for (const idx of occurrences) {
    const leftStart = Math.max(0, idx - before.length)
    const left = text.slice(leftStart, idx)
    const rightEnd = idx + edit.old.length + after.length
    const right = text.slice(idx + edit.old.length, rightEnd)
    if ((!before || left === before) && (!after || right === after)) {
      return { start: idx, end: idx + edit.old.length }
    }
  }
  return null
}

function allOccurrences(text: string, needle: string): number[] {
  if (!needle) return []
  const out: number[] = []
  let from = 0
  while (true) {
    const idx = text.indexOf(needle, from)
    if (idx < 0) break
    out.push(idx)
    from = idx + 1
  }
  return out
}

// Convert a global char range into a DOM Range, using the line-prefix
// table from docTextSnapshot. For zero-width "ranges" (insertion
// points) we collapse the Range to that exact position so a single
// caret-like rect can be measured for highlight + scroll purposes.
function domRangeForCharRange(snap: { text: string, lineStarts: number[] }, start: number, end: number): Range | null {
  if (!docEl) return null
  const lines = Array.from(docEl.children) as HTMLElement[]
  const startLineIdx = locateLine(snap.lineStarts, start)
  const endLineIdx   = locateLine(snap.lineStarts, end)
  const startLine = lines[startLineIdx]
  const endLine   = lines[endLineIdx]
  if (!startLine || !endLine) return null
  const startOff = start - snap.lineStarts[startLineIdx]
  const endOff   = end   - snap.lineStarts[endLineIdx]
  const s = textNodeAtOffset(startLine, startOff)
  const e = textNodeAtOffset(endLine,   endOff)
  if (!s || !e) return null
  try {
    const range = document.createRange()
    range.setStart(s.node, s.offset)
    range.setEnd(e.node, e.offset)
    return range
  } catch { return null }
}

function locateLine(lineStarts: number[], charIdx: number): number {
  // Linear walk — line count is small (writer docs, not log files);
  // bisection is bloat for the scale we're at.
  for (let i = lineStarts.length - 1; i >= 0; i--) {
    if (lineStarts[i] <= charIdx) return i
  }
  return 0
}

// Hover overlay — rendered into the same .editor-annotations container
// as the annotation marks, but with a different class so the visual
// reads as a transient "the model is talking about this" highlight
// rather than a persistent annotation underline. Replaced (not
// appended to) on every hover so a fast move between cards doesn't
// pile up stale marks.
function showEditHoverHighlight(edit: EditProposal): void {
  clearEditHoverHighlight()
  if (!docEl || !overlayEl) return
  const snap = docTextSnapshot()
  const charRange = findCharRangeForEdit(snap.text, edit)
  if (!charRange) return                       // host silently does nothing; conflict surfaces on accept
  // For pure insertions, expand the zero-width range a tiny bit to
  // the LEFT so the user still sees a visible mark at the insertion
  // point. One char of context is enough to draw something.
  let start = charRange.start
  let end = charRange.end
  if (start === end && start > 0) start -= 1
  const range = domRangeForCharRange(snap, start, end)
  if (!range) return
  const page = overlayEl.parentElement as HTMLElement | null
  if (!page) return
  const pageRect = page.getBoundingClientRect()
  const rects = Array.from(range.getClientRects())
  let firstMark: HTMLElement | null = null
  for (const rect of rects) {
    if (rect.width < 0.5 && rect.height < 0.5) continue
    const mark = document.createElement('div')
    mark.className = 'edit-hover-mark'
    mark.style.left   = (rect.left   - pageRect.left) + 'px'
    mark.style.top    = (rect.top    - pageRect.top)  + 'px'
    mark.style.width  = Math.max(rect.width, 2) + 'px'      // 2px floor so zero-width insertions render
    mark.style.height = rect.height + 'px'
    overlayEl.appendChild(mark)
    if (!firstMark) firstMark = mark
  }
  // Smooth-scroll the first rect into vertical centre. Native
  // scrollIntoView with block: 'center' handles both directions and
  // the right scroll container automatically — no need to walk
  // overflow ancestors ourselves.
  if (firstMark) scrollToActor(firstMark, 'center')
}

function clearEditHoverHighlight(): void {
  if (!overlayEl) return
  overlayEl.querySelectorAll('.edit-hover-mark').forEach((el) => el.remove())
}

// Apply an edit to the doc. We work at the markdown source level —
// serialize, splice, re-render — so line classification (headings,
// list items, code fences) re-flows cleanly from the new text without
// us replicating that logic at the DOM level. The cost is losing the
// caret position, but for an explicit accept gesture that's expected:
// the user just made a deliberate change to the doc, they aren't in
// the middle of typing somewhere else.
// Returns 'applied' (success, save scheduled) or 'conflict' (the
// edit's `old` could no longer be located — the pane shows the card
// as conflict so the user can try again after fixing the drift).
// `slug` is the document the chat was opened for. The chat pane outlives a
// document switch, so without this an Accept landed on whatever happened to be
// open — rewriting a document the agent never saw, and silently not applying
// the edit to the one it was about.
function applyEditToDoc(edit: EditProposal, slug: string): 'applied' | 'conflict' {
  if (!docEl || googleImporting) return 'conflict'
  if (currentSlug !== slug) return 'conflict'
  const snap = docTextSnapshot()
  const charRange = findCharRangeForEdit(snap.text, edit)
  if (!charRange) return 'conflict'
  const next = snap.text.slice(0, charRange.start) + edit.new + snap.text.slice(charRange.end)
  // Accepting an agent edit is a discrete, undoable step.
  recordHistoryPoint()
  loadIntoEditor(next)
  // After re-render, scroll the (now visible) `new` text into view.
  const afterSnap = docTextSnapshot()
  const lineIdx = locateLine(afterSnap.lineStarts, charRange.start)
  const lines = Array.from(docEl.children) as HTMLElement[]
  const target = lines[lineIdx]
  if (target) scrollToActor(target, 'center')
  // Refresh annotation overlay (line count / positions may have
  // shifted) and trigger the autosave so the change persists.
  renderAnnotationOverlay()
  scheduleSave()
  return 'applied'
}

// Accept runs the existing apply, then saves before the decision is
// recorded: 'applied' means the saved document changed. A failed save
// withdraws the edit (best-effort revert) so Accept can be retried from a
// clean document instead of conflicting with its own mutation; 'conflict'
// can be retried.
async function acceptEditForDoc(edit: EditProposal, slug: string): Promise<'applied' | 'conflict' | 'failed'> {
  if (applyEditToDoc(edit, slug) === 'conflict') return 'conflict'
  if (!await flushEditorSaves()) {
    applyEditToDoc({ ...edit, old: edit.new, new: edit.old }, slug)
    setMeta('The edit could not be saved, so it was withdrawn and the decision was not recorded. Resolve the save and Accept again.')
    return 'failed'
  }
  return 'applied'
}

// The document a subject's chat belongs to: the key itself for a document
// chat, the part before the first colon for a passage or review chat.
function editorSlugForKey(subject: ChatSubject): string {
  if (subject.surface === 'editor-document') return subject.key
  const at = subject.key.indexOf(':')
  return at < 0 ? subject.key : subject.key.slice(0, at)
}

// Session-surface wiring for Editor subjects: edit cards bind to the
// mounted subject's document, and every send flushes pending saves first so
// the saved body the agent reads is what the person sees.
function editorSurfaceFor(subject: ChatSubject): Pick<SurfaceOptions, 'edits' | 'beforeSend'> {
  const slug = editorSlugForKey(subject)
  return {
    edits: {
      hover: (edit) => { if (currentSlug === slug) showEditHoverHighlight(edit) },
      leave: () => { clearEditHoverHighlight() },
      accept: (edit) => acceptEditForDoc(edit, slug),
    },
    beforeSend: async () => {
      if (!await flushEditorSaves()) throw new Error('The document has unsaved changes that could not be saved. Resolve the save before sending.')
    },
  }
}

async function persistDocumentSnapshot(snapshot: DocumentSaveSnapshot): Promise<void> {
  if (currentSlug === snapshot.slug) setMeta('Saving…')
  const baseVersion = snapshot.baseVersion
  const res = await fetch(`/api/editor/doc/${encodeURIComponent(snapshot.slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: snapshot.content,
      client_id: snapshot.clientId,
      revision: snapshot.revision,
      base_version: baseVersion,
    }),
  })
  if (!res.ok) await throwSaveResponseError(res)
  const data = await res.json()
  if (!isEditorVersion(data.version)) throw new Error('save response omitted document version')
  // A stale acknowledgement may describe a version written later by another
  // tab. Advancing our base from that response would let unchanged local DOM
  // overwrite the other tab on its next edit. Same-client continuation is
  // tracked server-side, so stale responses never need to advance this base.
  if (data.stale !== true) documentVersions.set(snapshot.slug, data.version)
  const idx = docs.findIndex((d) => d.slug === snapshot.slug)
  if (idx >= 0 && data.stale !== true) {
    docs[idx] = {
      slug: snapshot.slug,
      title: String(data.title || docs[idx].title),
      updated_at: String(data.updated_at || new Date().toISOString()),
      size: Number(data.size || snapshot.content.length),
    }
    const [moved] = docs.splice(idx, 1)
    docs.unshift(moved)
  }
  setTriggerTitle()
}

function clearSaveTimer(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
}

async function flushSave(): Promise<boolean> {
  clearSaveTimer()
  const ok = await documentSaveQueue.flush()
  if (ok && !documentSaveQueue.isDirty()) setMetaForCurrent()
  return ok
}

function scheduleSave(): void {
  if (!docEl || !currentSlug || currentSlug === deletingSlug || googleImporting) return
  documentSaveQueue.enqueue({
    baseVersion: requiredVersion(documentVersions, currentSlug, 'document'),
    slug: currentSlug,
    content: serializeDoc(),
    clientId: EDITOR_CLIENT_ID,
    revision: ++documentSaveRevision,
  })
  setMeta('Editing…')
  clearSaveTimer()
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, SAVE_DEBOUNCE_MS)
}

// ── Annotations ──────────────────────────────────────────────────────
//
// Annotations are highlight + comment pairs anchored to ranges in the
// doc. The list is fetched alongside loadDoc and persisted via a
// debounced PUT. Ranges are stored as line + char-offset pairs but
// re-anchored by snippet match on every render — so an annotation
// survives line shifts above it (the caller adds/removes paragraphs
// earlier in the doc) as long as the snippet remains uniquely
// findable. If the snippet vanishes, the annotation orphans (no
// overlay rendered, but the row stays in storage so the user's
// comment text isn't silently lost).

async function fetchAnnotations(slug: string): Promise<void> {
  if (currentSlug === slug) {
    annotations = []
    annotationsReadySlug = null
  }
  try {
    const res = await fetch(`/api/editor/doc/${encodeURIComponent(slug)}/annotations`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (currentSlug !== slug) return
    if (!Array.isArray(data.annotations) || !isEditorVersion(data.version)) {
      throw new Error('malformed annotations response')
    }
    annotations = data.annotations as Annotation[]
    annotationsVersions.set(slug, data.version)
    annotationsReadySlug = slug
    viewFeedback('editor-annotations', 'Editor annotations unavailable', '')
  } catch (err) {
    console.error('[editor] fetchAnnotations failed:', err)
    if (currentSlug === slug) setMeta('Annotations unavailable')
  }
}

async function persistAnnotationsSnapshot(snapshot: AnnotationsSaveSnapshot): Promise<void> {
  const baseVersion = requiredVersion(annotationsVersions, snapshot.slug, 'annotations')
  const res = await fetch(`/api/editor/doc/${encodeURIComponent(snapshot.slug)}/annotations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      annotations: JSON.parse(snapshot.annotationsJson),
      client_id: snapshot.clientId,
      revision: snapshot.revision,
      base_version: baseVersion,
    }),
  })
  if (!res.ok) await throwSaveResponseError(res)
  const data = await res.json()
  if (!isEditorVersion(data.version)) throw new Error('save response omitted annotations version')
  if (data.stale !== true) annotationsVersions.set(snapshot.slug, data.version)
  viewFeedback('editor-annotations', 'Editor annotations unavailable', '')
}

function clearAnnotationsSaveTimer(): void {
  if (!annotationsSaveTimer) return
  clearTimeout(annotationsSaveTimer)
  annotationsSaveTimer = null
}

async function flushAnnotationsSave(): Promise<boolean> {
  clearAnnotationsSaveTimer()
  return annotationsSaveQueue.flush()
}

function scheduleAnnotationsSave(): void {
  if (!currentSlug || currentSlug === deletingSlug) return
  // Never turn a transient/corrupt read into a destructive replacement with
  // an empty in-memory list. Reloading the document retries the side-car.
  if (annotationsReadySlug !== currentSlug) {
    console.error('[editor] annotations are read-only until their side-car loads')
    setMeta('Annotations unavailable')
    return
  }
  annotationsSaveQueue.enqueue({
    slug: currentSlug,
    annotationsJson: JSON.stringify(annotations),
    clientId: EDITOR_CLIENT_ID,
    revision: ++annotationsSaveRevision,
  })
  clearAnnotationsSaveTimer()
  annotationsSaveTimer = setTimeout(() => {
    annotationsSaveTimer = null
    void flushAnnotationsSave()
  }, ANNOTATIONS_SAVE_DEBOUNCE_MS)
}

async function flushEditorSaves(): Promise<boolean> {
  for (;;) {
    const [docSaved, annotationsSaved] = await Promise.all([flushSave(), flushAnnotationsSave()])
    if (!docSaved || !annotationsSaved) return false
    if (!documentSaveQueue.isDirty() && !annotationsSaveQueue.isDirty()) return true
  }
}

async function prepareGoogleNavigation(): Promise<() => void> {
  if (googleImporting) throw new Error('Wait for the current Google action to finish before connecting.')
  const slug = currentSlug, wasInert = viewEl.inert
  googleImporting = true; viewEl.inert = true
  if (docEl) docEl.contentEditable = 'false'
  let released = false
  const release = () => {
    if (released) return
    released = true; googleImporting = false; viewEl.inert = wasInert
    if (docEl) docEl.contentEditable = currentSlug ? 'true' : 'false'
  }
  try {
    if (!await flushEditorSaves()) throw new Error('The draft could not be saved. Keep it open and resolve the save before connecting Google.')
    if (currentSlug !== slug) throw new Error('The open document changed. Connect Google again from that document.')
    return release
  } catch (error) { release(); throw error }
}

async function discardEditorSaves(): Promise<void> {
  clearSaveTimer()
  clearAnnotationsSaveTimer()
  await Promise.all([
    documentSaveQueue.discard(),
    annotationsSaveQueue.discard(),
  ])
}

// Build a DOM Range from an annotation's stored line + char-offset
// pair. Walks the editor-doc's children to the nominated line, then
// counts text-content chars up to the offset (counting hidden marker
// chars too — this matches the offset model annotations were stored
// with). Returns null if the line index is out of bounds, which is
// treated as orphaned at the caller.
function rangeForAnnotation(a: Annotation): Range | null {
  if (!docEl) return null
  const lines = Array.from(docEl.children) as HTMLElement[]
  const startLine = lines[a.range.start_line]
  const endLine   = lines[a.range.end_line]
  if (!startLine || !endLine) return null
  const startNode = textNodeAtOffset(startLine, a.range.start_offset)
  const endNode   = textNodeAtOffset(endLine,   a.range.end_offset)
  if (!startNode || !endNode) return null
  try {
    const range = document.createRange()
    range.setStart(startNode.node, startNode.offset)
    range.setEnd(endNode.node, endNode.offset)
    return range
  } catch {
    return null
  }
}

// Walk text descendants of a line and find the (text-node, offset)
// pair that corresponds to a given char offset within line.textContent.
// Returns null if the offset is past the end of the line.
function textNodeAtOffset(line: HTMLElement, offset: number): { node: Node, offset: number } | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let acc = 0
  let last: Node | null = null
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = (node.textContent || '').length
    if (acc + len >= offset) return { node, offset: offset - acc }
    acc += len
    last = node
  }
  // Past the end — pin to the end of the last text node so a Range
  // can still be built (rather than refusing it) for end-of-line cases.
  if (last) return { node: last, offset: (last.textContent || '').length }
  return null
}

// The text a range covers, its lines joined with '\n': the snippet an
// annotation records, and what re-anchoring compares it with. Null when
// the range does not fit the document's lines.
function rangeText(lines: HTMLElement[], range: AnnotationRange): string | null {
  const first = lines[range.start_line]
  const last  = lines[range.end_line]
  if (!first || !last || range.end_line < range.start_line) return null
  if (range.start_line === range.end_line) return (first.textContent || '').slice(range.start_offset, range.end_offset)
  const parts = [(first.textContent || '').slice(range.start_offset)]
  for (let i = range.start_line + 1; i < range.end_line; i++) parts.push(lines[i].textContent || '')
  parts.push((last.textContent || '').slice(0, range.end_offset))
  return parts.join('\n')
}

// Best-effort re-anchoring: returns the (start_line, start_offset,
// end_line, end_offset) where the snippet currently lives, or null if
// it can't be found. The recorded position is checked first; if the
// text there matches, no change. Otherwise the document's lines are
// searched joined with '\n', the way snippets are recorded, and each
// occurrence is mapped back to its start and end line and offset. No
// occurrence ⇒ the annotation has orphaned.
function reAnchorAnnotation(a: Annotation): AnnotationRange | null {
  if (!docEl) return null
  const lines = Array.from(docEl.children) as HTMLElement[]
  if (!lines.length) return null
  if (rangeText(lines, a.range) === a.snippet) return a.range          // fast path: still in place

  // Search outward from the line the annotation was last seen on, not from
  // the top of the document. Scanning from line 0 and taking the first hit
  // moved a note onto an entirely different passage whenever the document
  // repeated a phrase: a note on the second "Note" in a file jumped to the
  // first one and was persisted there, so its comment then labelled text it
  // was never about — and a second such note landed on the same words,
  // stacking two marks on one span.
  // `home` is a remembered index, so it can point past the end after lines
  // are deleted. Clamp it into the document first: an out-of-range `home`
  // used to cut the search below short and orphan notes that were still in
  // the document.
  const home = Math.max(0, Math.min(a.range.start_line, lines.length - 1))
  const order: number[] = []
  for (let d = 0; d < lines.length; d++) {
    const back = home - d
    const fwd = home + d
    if (back >= 0 && back < lines.length) order.push(back)
    if (d > 0 && fwd >= 0 && fwd < lines.length) order.push(fwd)
  }

  // One search for both shapes. Occurrences of the snippet in the joined
  // document bucket by the line they start on, already left to right; the
  // outward line order above then picks the nearest line, earliest on a
  // tie. A single-line note finds the same occurrence as the old
  // line-by-line search, and a multi-line one is re-found too.
  const texts = lines.map((line) => line.textContent || '')
  const starts: number[] = []
  let acc = 0
  for (const text of texts) { starts.push(acc); acc += text.length + 1 }
  const locate = (abs: number): { line: number, offset: number } => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= abs) lo = mid
      else hi = mid - 1
    }
    return { line: lo, offset: abs - starts[lo] }
  }
  const byLine = new Map<number, AnnotationRange[]>()
  const doc = texts.join('\n')
  for (let idx = doc.indexOf(a.snippet); idx >= 0; idx = doc.indexOf(a.snippet, idx + 1)) {
    const s = locate(idx)
    const e = locate(idx + a.snippet.length)
    const candidate = {
      start_line: s.line, start_offset: s.offset, end_line: e.line, end_offset: e.offset,
    }
    const bucket = byLine.get(s.line)
    if (bucket) bucket.push(candidate)
    else byLine.set(s.line, [candidate])
  }

  // Never re-anchor on top of another annotation's span; prefer the next
  // free occurrence on that line, then keep searching outward.
  const taken = new Set(annotations
    .filter((x) => x.id !== a.id)
    .map((x) => `${x.range.start_line}:${x.range.start_offset}`))

  for (const i of order) {
    for (const candidate of byLine.get(i) ?? []) {
      if (!taken.has(`${candidate.start_line}:${candidate.start_offset}`)) return candidate
    }
  }
  // No free occurrence. Orphan the note rather than park it on top of
  // another one: two marks over the same characters is how a note ends up
  // labelling text it was never about, and the user cannot tell the two
  // apart to remove either.
  return null
}

// Render the annotation underline overlay. Each annotation can occupy
// multiple visual rectangles (multi-line ranges, or wrapped lines), so
// we call Range.getClientRects() and emit a thin underline div for
// each. The container is positioned relative to .editor-page; rects
// are translated into editor-page-local coordinates so they stay
// pinned even as the page scrolls. Re-rendered after every reclassify
// (text edits) and on window resize.
function renderAnnotationOverlay(): void {
  articleReviews?.renderMarks()
  if (!docEl || !overlayEl) return
  overlayEl.innerHTML = ''
  if (!annotations.length) return
  const page = overlayEl.parentElement as HTMLElement
  if (!page) return
  const pageRect = page.getBoundingClientRect()

  // Re-anchor each annotation. Three outcomes per annotation:
  //   - found at recorded position: render as-is.
  //   - found at a new position: update + persist + render at new pos.
  //   - not found at all: orphan — render an inert mark at the line it
  //     was last seen on (the row stays in storage so the user's
  //     comment isn't silently lost; if the snippet reappears on a
  //     later edit, the underline returns).
  let anyChanged = false
  const orphans = new Set<string>()
  for (const a of annotations) {
    const fresh = reAnchorAnnotation(a)
    if (!fresh) { orphans.add(a.id); continue }
    if (fresh.start_line !== a.range.start_line
        || fresh.start_offset !== a.range.start_offset
        || fresh.end_line   !== a.range.end_line
        || fresh.end_offset !== a.range.end_offset) {
      a.range = fresh
      a.updated_at = new Date().toISOString()
      anyChanged = true
    }
  }
  if (anyChanged) scheduleAnnotationsSave()

  // Orphaned notes draw first, as short inert ticks at the start of the
  // line they were last seen on, so a live mark on the same line paints
  // over them. Only the first characters of the line are covered, so the
  // rest of the line can still be clicked into. Nothing about the orphan
  // state is stored: if the snippet reappears, the note is re-found.
  // Orphans sharing a clamped line cascade rightward from the line start,
  // one tick per note: identical boxes would stack and leave all but the
  // topmost unreachable.
  const lineEls = Array.from(docEl.children) as HTMLElement[]
  const orphansOnLine = new Map<number, number>()
  for (const a of annotations) {
    if (!orphans.has(a.id)) continue
    const lineIdx = Math.max(0, Math.min(a.range.start_line, lineEls.length - 1))
    const lineEl = lineEls[lineIdx]
    if (!lineEl) continue
    const slot = orphansOnLine.get(lineIdx) ?? 0
    orphansOnLine.set(lineIdx, slot + 1)
    const rect = lineEl.getBoundingClientRect()
    const mark = document.createElement('div')
    mark.className = 'annotation-mark annotation-orphan'
    mark.dataset.annId = a.id
    mark.style.left   = (rect.left - pageRect.left + slot * rect.height) + 'px'
    mark.style.top    = (rect.top    - pageRect.top)  + 'px'
    mark.style.width  = rect.height + 'px'
    mark.style.height = rect.height + 'px'
    mark.title = a.comment ? `Passage changed: ${a.comment.slice(0, 200)}` : 'Passage changed'
    overlayEl.appendChild(mark)
  }

  for (const a of annotations) {
    if (orphans.has(a.id)) continue
    const range = rangeForAnnotation(a)
    if (!range) continue
    const rects = Array.from(range.getClientRects())
    for (const rect of rects) {
      if (rect.width < 0.5) continue
      const mark = document.createElement('div')
      mark.className = 'annotation-mark'
      mark.dataset.annId = a.id
      mark.style.left   = (rect.left   - pageRect.left) + 'px'
      mark.style.top    = (rect.top    - pageRect.top)  + 'px'
      mark.style.width  = rect.width  + 'px'
      mark.style.height = rect.height + 'px'
      mark.title = a.comment ? a.comment.slice(0, 200) : 'Comment'
      overlayEl.appendChild(mark)
    }
  }

  // Move tracked thread markers with their passages. Subjects without a
  // marker are ignored; an unlocatable passage marks its stored start line.
  if (currentSlug) {
    for (const a of annotations) {
      const changed = orphans.has(a.id)
      const firstIdx = Math.max(0, Math.min(a.range.start_line, lineEls.length - 1))
      const lastIdx = changed ? firstIdx : Math.max(0, Math.min(a.range.end_line, lineEls.length - 1))
      const first = lineEls[firstIdx]
      const last = lineEls[lastIdx]
      if (!first || !last) continue
      syncThreadMarker(
        { surface: 'editor-passage', key: `${currentSlug}:${a.id}`, label: a.snippet.slice(0, 80) || 'Passage' },
        { first, last, changed },
      )
    }
  }
}

// Compute (start_line, start_offset, end_line, end_offset) and the
// text snippet for the current selection inside the editor. Returns
// null if the selection is collapsed, doesn't span text, or escapes
// the editor-doc element.
// Two annotations cover the same span when all four coordinates agree.
function sameRange(a: AnnotationRange, b: AnnotationRange): boolean {
  return a.start_line === b.start_line && a.start_offset === b.start_offset
    && a.end_line === b.end_line && a.end_offset === b.end_offset
}

function selectionAsAnnotationRange(): { range: AnnotationRange, snippet: string } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (range.collapsed) return null
  if (!docEl) return null
  if (!docEl.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== docEl) return null

  const lines = Array.from(docEl.children) as HTMLElement[]
  function locate(node: Node, off: number): { line: number, offset: number } | null {
    // Find the line div containing `node` (or `node` itself if it's a line)
    let l: Node | null = node
    while (l && l.parentNode !== docEl) l = l.parentNode
    if (!l) return null
    const lineIdx = lines.indexOf(l as HTMLElement)
    if (lineIdx < 0) return null
    return { line: lineIdx, offset: offsetInLineFor(l as HTMLElement, node, off) }
  }
  const s = locate(range.startContainer, range.startOffset)
  const e = locate(range.endContainer,   range.endOffset)
  if (!s || !e) return null
  if (s.line > e.line || (s.line === e.line && s.offset >= e.offset)) return null

  // Build the snippet from the lines' textContent so it captures the
  // visible characters the user highlighted (markers included — they
  // round-trip with the source).
  const span = { start_line: s.line, start_offset: s.offset, end_line: e.line, end_offset: e.offset }
  const snippet = rangeText(lines, span)
  return snippet === null ? null : { range: span, snippet }
}

// Hide the whole floating selection cluster. Always dismiss the three
// together: they appear together, so hiding only some of them strands
// the rest on screen with no selection left to act on. (Call sites used
// to hide them one by one, and when a third button joined the original
// pair the older sites kept dismissing two.)
function hideSelectionActions(): void {
  if (commentBtnEl) commentBtnEl.hidden = true
  if (issueBtnEl) issueBtnEl.hidden = true
  if (snippetBtnEl) snippetBtnEl.hidden = true
}

// The control bar is a fixed opaque band across the top of the window, so
// anything we position from a viewport rect has to stay clear of it or it
// lands underneath, invisible and unclickable. menu.ts publishes the bar's
// measured height; the fallback matches the CSS.
function controlBarBottom(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--app-bar-h').trim()
  const h = parseFloat(raw)
  return Number.isFinite(h) && h > 0 ? h : 96
}

// Show or hide the floating selection-action buttons (Comment, Issue,
// Snippet) based on the current selection. All three are anchored just
// above the selection's end rect and grow rightward: Comment sits
// closest to the selection, then Issue, then Snippet. While either
// composer is open the buttons stay hidden — focus is in the composer
// and the selection has collapsed.
// Geometry of the floating selection cluster. The button size matches the
// .editor-comment-btn rule in style.css; the gap and margin are the breathing
// room between the buttons and between the cluster and the writing column.
const SELECTION_BTN = 24
const SELECTION_GAP = 4
const SELECTION_MARGIN = 12
// Minimum breathing room against the window frame when space is tight.
const SELECTION_EDGE = 4

function updateCommentButtonForSelection(): void {
  if (!commentBtnEl || !docEl) return
  const hideAll = hideSelectionActions
  // While either composer is open, focus is in it and the selection has
  // collapsed — keep the whole cluster hidden.
  if (issueComposerEl || snippetComposerEl) { hideAll(); return }
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.getRangeAt(0).collapsed) { hideAll(); return }
  const range = sel.getRangeAt(0)
  if (!docEl.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== docEl) { hideAll(); return }
  const rects = range.getClientRects()
  if (rects.length === 0) { hideAll(); return }
  const first = rects[0]
  const last = rects[rects.length - 1]

  // The cluster belongs in the margin, beside the writing column — never
  // over the prose. Anchored to the selection's end it sat on top of the
  // words: at the end of a line it covered the line below, mid-paragraph it
  // covered the very text being acted on, and it moved with every change of
  // selection. Pinned to the column's edge it has one predictable home and
  // the passage stays legible while the user decides.
  //
  // getClientRects is viewport-relative and these buttons are
  // position:fixed, so a rect IS the coordinate — adding the page scroll
  // double-counts it and puts the cluster off-screen on a scrolled page.
  const page = docEl.closest('.editor-page') as HTMLElement | null
  const column = (page || docEl).getBoundingClientRect()
  const clusterWidth = 3 * SELECTION_BTN + 2 * SELECTION_GAP

  // Vertically: line up with the first line of the selection, so the cluster
  // sits where the passage begins rather than trailing its end. Kept clear of
  // the control bar and of the bottom of the window.
  const preferredTop = first.top + (first.height - SELECTION_BTN) / 2
  const top = Math.max(
    controlBarBottom() + SELECTION_MARGIN,
    Math.min(preferredTop, window.innerHeight - SELECTION_BTN - SELECTION_MARGIN),
  )

  // Horizontally: in the margin beside the column. A row of three needs
  // ~80px of margin; when the window is too narrow for that the same three
  // stack vertically and need only one button's width, which still fits the
  // margin a 680px column leaves at ~760px of viewport. Right margin first,
  // then left. Only when neither margin can hold even a stack does the
  // cluster float past the selection's end.
  const rightRow = column.right + SELECTION_MARGIN
  const leftRow = column.left - SELECTION_MARGIN - clusterWidth
  const fitsRight = rightRow + clusterWidth <= window.innerWidth - SELECTION_MARGIN
  const fitsLeft = leftRow >= SELECTION_MARGIN
  // A stack only needs one button's width, and it may sit closer to the
  // window edge than a row would — the point is to stay off the prose, and
  // EDGE is enough to keep it from touching the frame. That difference is
  // what lets a 680px column still have a usable margin at ~760px of
  // viewport, where a row cannot fit on either side.
  const rightStack = Math.min(column.right + SELECTION_MARGIN,
    window.innerWidth - SELECTION_BTN - SELECTION_EDGE)
  const leftStack = Math.max(column.left - SELECTION_MARGIN - SELECTION_BTN, SELECTION_EDGE)
  const stacksRight = rightStack >= column.right + SELECTION_EDGE
  const stacksLeft = leftStack + SELECTION_BTN <= column.left - SELECTION_EDGE

  let left: number
  let vertical = false
  let below = false
  if (fitsRight) left = rightRow
  else if (fitsLeft) left = leftRow
  else if (stacksRight) { left = rightStack; vertical = true }
  else if (stacksLeft) { left = leftStack; vertical = true }
  else {
    // No margin on either side — the column fills the window. Sit under the
    // selection's last line rather than on top of it, pushed to the column's
    // right edge where a line most often has room left over.
    below = true
    left = Math.max(SELECTION_EDGE,
      Math.min(column.right - clusterWidth, window.innerWidth - clusterWidth - SELECTION_EDGE))
  }

  // A vertical stack is taller than a row, so re-clamp against the window
  // bottom using the stack's full height.
  const stackHeight = 3 * SELECTION_BTN + 2 * SELECTION_GAP
  const clusterTop = below
    ? Math.min(last.bottom + SELECTION_GAP, window.innerHeight - SELECTION_BTN - SELECTION_EDGE)
    : vertical
      ? Math.max(controlBarBottom() + SELECTION_MARGIN,
        Math.min(top, window.innerHeight - stackHeight - SELECTION_MARGIN))
      : top

  const step = SELECTION_BTN + SELECTION_GAP
  const place = (el: HTMLButtonElement | null, slot: number) => {
    if (!el) return
    el.style.left = (vertical ? left : left + slot * step) + 'px'
    el.style.top = (vertical ? clusterTop + slot * step : clusterTop) + 'px'
    el.hidden = false
  }
  place(commentBtnEl, 0)
  place(issueBtnEl, 1)
  place(snippetBtnEl, 2)
}

// Create a new annotation from the current selection, append to the
// list, persist, and immediately open a thread for it so the user
// can type a comment.
function createAnnotationFromSelection(): void {
  if (!currentSlug || annotationsReadySlug !== currentSlug) {
    setMeta('Annotations unavailable')
    return
  }
  const got = selectionAsAnnotationRange()
  if (!got) return
  // Commenting on a span that already has a note opens that note. It used to
  // add a second one over the top: identical range, identical snippet, its own
  // underline, and nothing on screen to say there were now two. Documents
  // collected stacks of them — three on one line in the case that surfaced
  // this — and every one of them intercepted clicks on that text.
  const existing = annotations.find((a) => sameRange(a.range, got.range))
  if (existing) {
    hideSelectionActions()
    window.getSelection()?.removeAllRanges()
    openThreadForAnnotation(existing.id)
    return
  }
  const id = 'ann-' + Math.random().toString(36).slice(2, 10)
  const now = new Date().toISOString()
  // New annotations get no session_id. A passage chat is its subject's Chat
  // session, resolved on open and created on the first message; older
  // annotations keep theirs for the legacy import.
  const a: Annotation = {
    id,
    range: got.range,
    snippet: got.snippet,
    comment: '',
    created_at: now,
    updated_at: now,
  }
  annotations.push(a)
  // Collapse the selection so the floating buttons hide naturally and
  // the underline overlay can be drawn over the now-quiet selection.
  // Dismiss the cluster explicitly too: focus is about to move into the
  // thread, so the selectionchange that follows takes the
  // "not the editor" path and won't do it for us.
  window.getSelection()?.removeAllRanges()
  hideSelectionActions()
  scheduleAnnotationsSave()
  renderAnnotationOverlay()
  openThreadForAnnotation(id)
  // Opened by its own creation, so closing it with nothing in it discards it.
  threadCreatedId = id
}

function deleteAnnotation(id: string): void {
  annotations = annotations.filter((a) => a.id !== id)
  scheduleAnnotationsSave()
  renderAnnotationOverlay()
  closeInlineThread()
  if (currentSlug) dropThread({ surface: 'editor-passage', key: `${currentSlug}:${id}`, label: '' })
}

// ── Selection → "Create issue" composer ──────────────────────────────
// Mirror of Current's lane issue composer (see openIssueComposer in
// src/views/current-view.ts). Same DOM classes (.composer
// .composer-issue) and same POST /api/gh { operation: 'open_issue' }
// submission path — so styling and behavior stay identical between
// the kanban Issue lane and the editor selection action.

function shortRepo(fullRepo: string): string {
  const i = fullRepo.indexOf('/')
  return i < 0 ? fullRepo : fullRepo.slice(i + 1)
}

async function ensureRepos(): Promise<void> {
  if (allRepos.length > 0) return
  try {
    const res = await fetch('/api/repos')
    if (!res.ok) return
    const data = await res.json()
    allRepos = Array.isArray(data.repos) ? data.repos : []
  } catch { /* composer renders the empty-state option */ }
}

// Position a floating element near the original selection rect.
// Prefer below-and-left-aligned with the rect's left edge; fall back
// above the selection if there isn't room below. Width is honoured
// from the element's offsetWidth so we don't need to hard-code it.
function placeComposerNearRect(el: HTMLElement, rect: DOMRect): void {
  const margin = 8
  const w = el.offsetWidth || 320
  const h = el.offsetHeight || 200
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = rect.left
  if (left + w > vw - margin) left = Math.max(margin, vw - margin - w)
  if (left < margin) left = margin
  const spaceBelow = vh - rect.bottom
  let top: number
  if (spaceBelow >= h + margin || spaceBelow >= vh - rect.top) {
    top = rect.bottom + margin
  } else {
    top = Math.max(margin, rect.top - margin - h)
  }
  // Viewport coordinates for a position:fixed element — no scroll term, and
  // never above the control bar.
  el.style.left = left + 'px'
  el.style.top  = Math.max(top, controlBarBottom() + margin) + 'px'
}

function closeIssueComposer(): void {
  if (!issueComposerEl) return
  retire(issueComposerEl)
  issueComposerEl = null
  // The selection-action buttons stay hidden — the selection has
  // collapsed by now (focus moved to the composer). Next non-collapsed
  // selection in the editor will re-show them via selectionchange.
}

function openIssueComposerFromSelection(): void {
  if (issueComposerEl) {
    ;(issueComposerEl.querySelector('input.issue-title') as HTMLInputElement | null)?.focus()
    return
  }
  const got = selectionAsAnnotationRange()
  if (!got) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  // Freeze the selection rect now — clicking into the title input
  // will collapse the selection, so we need its geometry up-front to
  // anchor the composer near where the user was looking.
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  // Hide the selection-action buttons immediately so they don't sit
  // under the composer while it animates in.
  hideSelectionActions()

  const composer = document.createElement('div')
  composer.className = 'composer composer-issue editor-floating-composer'
  // Repo options render synchronously from the cached list; if it's
  // empty we still mount the composer and refresh the <select> when
  // /api/repos lands, so the typing cursor lands in the title field
  // without waiting on the network.
  const repoOptionsFor = (repos: string[]) => repos.length === 0
    ? '<option value="">(no repos available)</option>'
    : repos.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(shortRepo(r))}</option>`).join('')
  composer.innerHTML = `
    <input type="text" class="issue-title" placeholder="Issue title" autocomplete="off" spellcheck="true" />
    <textarea class="issue-body" rows="4" placeholder="Body (optional)" spellcheck="true"></textarea>
    <select class="issue-repo">${repoOptionsFor(allRepos)}</select>
    <div class="composer-row">
      <button class="composer-add">Open issue</button>
      <button class="composer-cancel" type="button">Cancel</button>
    </div>
  `
  document.body.appendChild(composer)
  reveal(composer, { distance: 8 })
  issueComposerEl = composer

  const titleInput = composer.querySelector<HTMLInputElement>('.issue-title')!
  const bodyTa = composer.querySelector<HTMLTextAreaElement>('.issue-body')!
  const repoSel = composer.querySelector<HTMLSelectElement>('.issue-repo')!
  const addB = composer.querySelector<HTMLButtonElement>('.composer-add')!
  const cancelB = composer.querySelector<HTMLButtonElement>('.composer-cancel')!

  // Selection text seeds the body so the user can flesh out the
  // issue without retyping. Same prefill model as Current's
  // drag-promote → issue composer.
  bodyTa.value = got.snippet

  placeComposerNearRect(composer, rect)
  // If /api/repos hadn't returned yet at click-time, repopulate the
  // <select> when it arrives (mirrors Current's behaviour).
  if (allRepos.length === 0) {
    ensureRepos().then(() => {
      if (!issueComposerEl) return
      const cur = repoSel.value
      repoSel.innerHTML = repoOptionsFor(allRepos)
      if (cur && allRepos.includes(cur)) repoSel.value = cur
    })
  }

  const showError = (msg: string) => viewFeedback('editor-action', 'Editor action needs attention', msg, 'action_needed')
  const submit = async () => {
    // Cmd+Enter auto-repeats while held, and the shortcut called this directly
    // — the disabled button only guarded the click. Holding it opened several
    // identical GitHub issues, which the user then had to go and close.
    if (addB.disabled) return
    const title = titleInput.value.trim()
    const body = bodyTa.value.trim()
    const repo = repoSel.value
    if (!title) { showError('Title is required'); titleInput.focus(); return }
    if (!repo)  { showError('Repo is required'); return }

    addB.disabled = true
    showError('')
    try {
      const ghRes = await fetch('/api/gh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'open_issue',
          repository_full_name: repo,
          title,
          body,
        }),
      })
      if (!ghRes.ok) {
        const text = await ghRes.text().catch(() => '')
        throw new Error(`Github ${ghRes.status}: ${text.slice(0, 160)}`)
      }
      closeIssueComposer()
    } catch (err) {
      addB.disabled = false
      addB.textContent = 'Open issue'
      showError((err as Error).message)
    }
  }

  addB.addEventListener('click', submit)
  cancelB.addEventListener('click', closeIssueComposer)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closeIssueComposer() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
  }
  titleInput.addEventListener('keydown', onKey)
  bodyTa.addEventListener('keydown', onKey)
  // Click-outside dismiss: any mousedown outside the composer that
  // isn't the trigger button itself closes it. Captured so we run
  // before the editor sees the click (it would otherwise refocus
  // the doc and collapse anything still selected).
  const outside = (e: MouseEvent) => {
    if (isNotificationInteraction(e.target)) return
    if (!issueComposerEl) { document.removeEventListener('mousedown', outside, true); return }
    const t = e.target as Node
    if (issueComposerEl.contains(t)) return
    if (issueBtnEl && issueBtnEl.contains(t)) return
    closeIssueComposer()
    document.removeEventListener('mousedown', outside, true)
  }
  document.addEventListener('mousedown', outside, true)

  titleInput.focus()
}

// ── Selection → "Save as snippet" composer ───────────────────────────
// Sibling of the issue composer above: identical floating .composer
// chrome, but two fields — a ;trigger and the body (seeded with the
// selected text). Submits to POST /api/snippets, which appends the pair
// to espanso's match/poise.yml (see server/snippets.ts) so it expands
// system-wide immediately.

function closeSnippetComposer(): void {
  if (!snippetComposerEl) return
  retire(snippetComposerEl)
  snippetComposerEl = null
}

function openSnippetComposerFromSelection(): void {
  if (snippetComposerEl) {
    ;(snippetComposerEl.querySelector('input.snippet-trigger') as HTMLInputElement | null)?.focus()
    return
  }
  const got = selectionAsAnnotationRange()
  if (!got) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  // Freeze the selection rect before focus moves to the composer and
  // collapses it — same reason as the issue composer.
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  hideSelectionActions()

  const composer = document.createElement('div')
  composer.className = 'composer composer-snippet editor-floating-composer'
  composer.innerHTML = `
    <input type="text" class="snippet-trigger" placeholder=";trigger" autocomplete="off" spellcheck="false" />
    <textarea class="snippet-body" rows="4" placeholder="Snippet text" spellcheck="true"></textarea>
    <div class="composer-row">
      <button class="composer-add">Save snippet</button>
      <button class="composer-cancel" type="button">Cancel</button>
    </div>
  `
  document.body.appendChild(composer)
  reveal(composer, { distance: 8 })
  snippetComposerEl = composer

  const triggerInput = composer.querySelector<HTMLInputElement>('.snippet-trigger')!
  const bodyTa = composer.querySelector<HTMLTextAreaElement>('.snippet-body')!
  const addB = composer.querySelector<HTMLButtonElement>('.composer-add')!
  const cancelB = composer.querySelector<HTMLButtonElement>('.composer-cancel')!

  // The selected text seeds the body so the user only has to name the
  // trigger; the body stays editable.
  bodyTa.value = got.snippet

  placeComposerNearRect(composer, rect)

  const showError = (msg: string) => viewFeedback('editor-action', 'Editor action needs attention', msg, 'action_needed')
  const submit = async () => {
    const trigger = triggerInput.value.trim()
    const replace = bodyTa.value
    if (!trigger) { showError('Trigger is required'); triggerInput.focus(); return }
    if (!replace.trim()) { showError('Snippet text is required'); bodyTa.focus(); return }

    addB.disabled = true
    showError('')
    try {
      const res = await fetch('/api/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger, replace }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error || `request failed (${res.status})`)
      }
      closeSnippetComposer()
    } catch (err) {
      addB.disabled = false
      addB.textContent = 'Save snippet'
      showError((err as Error).message)
    }
  }

  addB.addEventListener('click', submit)
  cancelB.addEventListener('click', closeSnippetComposer)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSnippetComposer() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
  }
  triggerInput.addEventListener('keydown', onKey)
  bodyTa.addEventListener('keydown', onKey)
  const outside = (e: MouseEvent) => {
    if (isNotificationInteraction(e.target)) return
    if (!snippetComposerEl) { document.removeEventListener('mousedown', outside, true); return }
    const t = e.target as Node
    if (snippetComposerEl.contains(t)) return
    if (snippetBtnEl && snippetBtnEl.contains(t)) return
    closeSnippetComposer()
    document.removeEventListener('mousedown', outside, true)
  }
  document.addEventListener('mousedown', outside, true)

  // Focus the trigger so the keyword can be typed right away — the body
  // already carries the selection.
  triggerInput.focus()
}

function updateAnnotationComment(id: string, comment: string): void {
  const a = annotations.find((x) => x.id === id)
  if (!a) return
  if (a.comment === comment) return
  a.comment = comment
  a.updated_at = new Date().toISOString()
  scheduleAnnotationsSave()
}

// ── Inline threads ───────────────────────────────────────────────────
//
// Passage chats open under their passage. The thread holds the annotation's
// note field and an inline surface for its subject's Chat session; the
// passage reaches the agent through the context file on every turn, not
// through the message.

function passageSubjectFor(id: string): ChatSubject | null {
  if (!currentSlug) return null
  const a = annotations.find((x) => x.id === id)
  if (!a) return null
  return { surface: 'editor-passage', key: `${currentSlug}:${id}`, label: a.snippet.slice(0, 80) || 'Passage' }
}

function openThreadForAnnotation(id: string): void {
  if (!currentSlug || !docEl) return
  const a = annotations.find((x) => x.id === id)
  if (!a) return
  const subject = passageSubjectFor(id)
  if (!subject) return
  // Already open for this annotation: leave it. Closing and reopening would
  // run the discard rule on a note that is still being looked at.
  const shown = inlineThreadSubjectInView()
  if (shown && shown.surface === subject.surface && shown.key === subject.key) return
  // A chat open in the side pane moves back like its Back button; anything
  // else yields to the thread. The pane's draft is newer than the kept one.
  const paneShown = chatSidePane.subjectInView()
  if (paneShown && paneShown.surface === subject.surface && paneShown.key === subject.key) {
    keepThreadDraft(subject, chatSidePane.takeDraft())
    chatSidePane.close()
  }
  const page = docEl.closest('.editor-page') as HTMLElement | null
  if (!page) return
  const lines = Array.from(docEl.children) as HTMLElement[]
  if (!lines.length) return
  const located = reAnchorAnnotation(a)
  // A passage that can no longer be located keeps its chat: the thread opens
  // at the stored start line, clamped into the document.
  const endLine = located ? located.end_line : Math.max(0, Math.min(a.range.start_line, lines.length - 1))
  const line = lines[Math.max(0, Math.min(endLine, lines.length - 1))]!
  const hooks = editorSurfaceFor(subject)
  openInlineThread({
    page, doc: docEl, line,
    range: located && located.start_line === located.end_line
      ? { start: located.start_offset, end: located.end_offset }
      : { start: 0, end: 0 },
    subject,
    header: (section) => {
      if (!located) {
        const notice = document.createElement('div')
        notice.className = 'editor-annotation-orphan'
        notice.textContent = 'Passage changed: the text this note was on is no longer in the document.'
        section.appendChild(notice)
      }
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'editor-annotation-delete'
      del.setAttribute('aria-label', 'Delete')
      del.innerHTML = ICON_TRASH
      del.addEventListener('click', () => deleteAnnotation(id))
      section.appendChild(del)
    },
    note: { value: a.comment, label: 'Note', onInput: (value) => updateAnnotationComment(id, value) },
    edits: hooks.edits,
    beforeSend: hooks.beforeSend!,
  })
}

// Open the thread for a subject from a marker or the side pane's Back
// button. The pane's draft moves back with it.
async function openThreadForSubject(subject: ChatSubject): Promise<void> {
  const at = subject.key.indexOf(':')
  if (at < 0) return
  const slug = subject.key.slice(0, at)
  if (slug !== currentSlug) {
    await loadDoc(slug)
    if (currentSlug !== slug || viewEl.hidden) return
    // The review lookup must wait for this document's data, not the previous
    // document's review ID or an independent in-flight discovery request.
    if (subject.surface === 'editor-review') {
      await articleReviews?.load(slug)
      if (currentSlug !== slug || viewEl.hidden) return
      await articleReviews?.synchronize()
    }
  }
  if (currentSlug !== slug || viewEl.hidden) return
  if (subject.surface === 'editor-passage') openThreadForAnnotation(subject.key.slice(at + 1))
  else if (subject.surface === 'editor-review') articleReviews?.open(subject.key.slice(at + 1))
}

// A review's thread opens under its anchored paragraph when locateReview
// finds it, with the GitHub conversation as its first section and a private
// agent chat below. An unlocated review renders in flow under the review
// list instead, with no room made in the text.
function openThreadForReview(review: ArticleReview, render: (section: HTMLElement) => void): void {
  if (!currentSlug || !docEl) return
  const subject: ChatSubject = { surface: 'editor-review', key: `${currentSlug}:${review.id}`, label: `Review · ${review.site} #${review.pr}` }
  const shown = inlineThreadSubjectInView()
  if (shown && shown.surface === subject.surface && shown.key === subject.key) return
  const paneShown = chatSidePane.subjectInView()
  if (paneShown && paneShown.surface === subject.surface && paneShown.key === subject.key) {
    keepThreadDraft(subject, chatSidePane.takeDraft())
    chatSidePane.close()
  }
  const page = docEl.closest('.editor-page') as HTMLElement | null
  if (!page) return
  const lines = Array.from(docEl.children) as HTMLElement[]
  if (!lines.length) return
  const hooks = editorSurfaceFor(subject)
  const at = review.anchor ? locateReview(serializeDoc(), review.anchor) : null
  const snap = docTextSnapshot()
  const endLineIdx = at ? locateLine(snap.lineStarts, at.end) : -1
  const endLine = endLineIdx >= 0 ? lines[Math.min(endLineIdx, lines.length - 1)]! : null
  const unlocated = !at || !endLine || !domRangeForCharRange(snap, at.start, at.end)
  if (!unlocated && endLine) {
    const startLineIdx = locateLine(snap.lineStarts, at!.start)
    openInlineThread({
      page, doc: docEl, line: endLine,
      range: startLineIdx === endLineIdx
        ? { start: at!.start - snap.lineStarts[startLineIdx]!, end: at!.end - snap.lineStarts[endLineIdx]! }
        : { start: 0, end: 0 },
      subject, header: render, edits: hooks.edits, beforeSend: hooks.beforeSend!,
    })
    return
  }
  const list = viewEl?.querySelector('.editor-review-list') as HTMLElement | null
  openInlineThread({
    page, doc: docEl, line: lines[0]!, range: { start: 0, end: 0 },
    subject, header: render, edits: hooks.edits, beforeSend: hooks.beforeSend!,
    ...(list ? { inFlowAfter: list } : {}),
  })
}

// An annotation carries a comment, a conversation, or both. One that closes
// with neither is not a note — it is the residue of a click, and keeping it
// leaves an invisible trap: the text stays underlined and every later click
// on it reopens an empty thread, which reads as the editor misbehaving
// rather than as a note the user forgot they made. Discard it on close — but
// only the annotation this thread session just created. A note the user did
// not create in this breath is never removed without them asking.
function discardThreadAnnotationIfEmpty(id: string, sessionId: string | null): void {
  if (id !== threadCreatedId) return
  const a = annotations.find((x) => x.id === id)
  if (!a) return
  if (a.comment.trim() !== '' || sessionId || (currentSlug && hasThreadDraft({ surface: 'editor-passage', key: `${currentSlug}:${id}`, label: a.snippet }))) return
  annotations = annotations.filter((x) => x.id !== a.id)
  scheduleAnnotationsSave()
  renderAnnotationOverlay()
}

function returnCaretToPassageEnd(id: string): void {
  if (!docEl) return
  const a = annotations.find((x) => x.id === id)
  if (!a) return
  const range = reAnchorAnnotation(a) || a.range
  const snap = docTextSnapshot()
  const endLine = Math.max(0, Math.min(range.end_line, snap.lineStarts.length - 1))
  const end = Math.min(snap.text.length, snap.lineStarts[endLine]! + range.end_offset)
  const dom = domRangeForCharRange(snap, end, end)
  if (!dom) return
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(dom)
  docEl.focus()
}

function onInlineThreadClosed(ev: Event): void {
  const detail = (ev as CustomEvent<{ subject: ChatSubject, returnCaret: boolean, sessionId: string | null }>).detail
  if (!detail || detail.subject.surface !== 'editor-passage') return
  const at = detail.subject.key.indexOf(':')
  if (at < 0) return
  const id = detail.subject.key.slice(at + 1)
  discardThreadAnnotationIfEmpty(id, detail.sessionId)
  if (detail.returnCaret) returnCaretToPassageEnd(id)
  threadCreatedId = null
}


// While the side pane shows the open document's session, a non-collapsed
// selection inside #editor-doc sets the surface's highlight chip; a collapsed
// one clears it. Selections elsewhere — including in the composer — are
// ignored, so moving focus to the composer keeps the chip. This listener must
// not inherit the selection-actions rule above that returns early unless the
// editor has focus.
function updateHighlightFromSelection(): void {
  const shown = chatSidePane.subjectInView()
  if (!currentSlug || !docEl || shown?.surface !== 'editor-document' || shown.key !== currentSlug) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  if (!docEl.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== docEl) return
  const text = sel.toString()
  chatSidePane.setHighlight(!sel.isCollapsed && text ? text : null)
}

function attachHandlers() {
  triggerEl!.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menuEl!.hidden) openMenu()
    else                closeMenu()
  })
  menuEl!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.editor-doc-item')
    if (!btn) return
    const slug = btn.dataset.slug || ''
    closeMenu()
    if (!slug || slug === currentSlug) return
    void loadDoc(slug)
  })
  viewEl.querySelector<HTMLButtonElement>('.editor-new-btn')!
    .addEventListener('click', () => { void newDoc() })
  viewEl.querySelector<HTMLButtonElement>('.editor-delete-btn')!
    .addEventListener('click', () => { void deleteCurrent() })
  const publishBtn = viewEl.querySelector<HTMLButtonElement>('.editor-publish-btn')!
  publishBtn.addEventListener('click', () => {
    togglePublishPanel(publishBtn, { slug: () => currentSlug, flush: flushEditorSaves, version: () => currentSlug ? documentVersions.get(currentSlug) ?? null : null, published: () => { void articleReviews?.synchronize(true) } })
  })
  copyBtnEl = viewEl.querySelector<HTMLButtonElement>('.editor-copy-btn')!
  copyBtnEl.addEventListener('click', () => { void copyDoc() })
  viewEl.querySelector<HTMLButtonElement>('.editor-chat-btn')!
    .addEventListener('click', () => {
      if (!currentSlug) return
      const d = currentDoc()
      chatSidePane.toggle({ subject: { surface: 'editor-document', key: currentSlug, label: d?.title || currentSlug } })
    })
  // Chat view handoff: opens the document's own chat in Chat.
  viewEl.querySelector<HTMLButtonElement>('.editor-chat-session-btn')!
    .addEventListener('click', () => {
      if (!currentSlug) return
      const d = currentDoc()
      window.dispatchEvent(new CustomEvent('poise:open-chat-session', {
        detail: { subject: { surface: 'editor-document', key: currentSlug, label: d?.title || currentSlug } },
      }))
    })

  const focusBtn = viewEl.querySelector<HTMLButtonElement>('.editor-focus-btn')!
  focusBtn.addEventListener('click', () => {
    // Writer mode = body class + icon swap. The CSS hides everything
    // outside the writing surface (top nav, burger, the rest of the
    // bar), leaving just the page and this one icon.
    const on = document.body.classList.toggle('editor-writer-mode')
    focusBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
    focusBtn.innerHTML = on ? ICON_FOCUS_EXIT : ICON_FOCUS_ENTER
    // Make sure the editor has focus when the user enters writer mode
    // — they came here to type, not to look at chrome.
    if (on) docEl?.focus()
  })

  // Force browser to use <div> (not <p> or <br>) for paragraph splits
  // on Enter, so our line model stays consistent across browsers. Set
  // once at handler attach; some browsers ignore it but Chrome/Safari
  // honour it. Firefox uses <br> by default; reclassifyLines wraps
  // anything we don't recognize into editor-line divs so the model
  // doesn't drift.
  try { document.execCommand('defaultParagraphSeparator', false, 'div') } catch { /* ignore */ }

  // Block native rich-text shortcuts (Cmd+B, Cmd+I, Cmd+U) — those wrap
  // selection in <b>/<i>/<u> tags which serialize back to plain text
  // (good) but render as visually rich for the session (confusing in a
  // markdown editor — the user expects to type **bold** for bold).
  // Cmd+B is handled at keydown to insert markdown markers instead.
  //
  // Also fix a Chrome quirk: when the caret sits at "line-level, just
  // after a <strong>" (no text-node anchor), Chrome routes typed
  // characters into the trailing marker text node — which extends the
  // bold span. We intercept text insertion in that position and create
  // a real sibling text node ourselves, then place the caret in it.
  // The reclassify pass picks the new text node up and parseInline
  // produces the correct (bold + plain) split.
  docEl!.addEventListener('beforeinput', (e: InputEvent) => {
    const t = e.inputType
    if (t === 'formatBold' || t === 'formatItalic' || t === 'formatUnderline'
        || t === 'formatStrikeThrough' || t === 'formatSuperscript'
        || t === 'formatSubscript') {
      e.preventDefault()
      return
    }

    // Snapshot the pre-edit document for undo before anything mutates.
    noteHistoryPre()

    // Any edit that crosses a line boundary has to be done in source
    // coordinates — see replaceSourceRange for why the native merge
    // can't be trusted with our hidden markers.
    const isDelete = t === 'deleteContentBackward' || t === 'deleteContentForward'
      || t === 'deleteByCut' || t === 'deleteByDrag'
      || t === 'deleteWordBackward' || t === 'deleteWordForward'
    const isPlainInsert = (t === 'insertText' || t === 'insertReplacementText'
      || t === 'insertFromPaste' || t === 'insertFromDrop')
    // Enter and Shift+Enter replace the selection with a line break. They were
    // missing from this list, so the one gesture that both deletes across a
    // boundary AND splits a line went to the native path — which merges the
    // blocks before re-splitting them and re-serialises the moved paragraph
    // without our display:none markers. Selecting across two lines and
    // pressing Enter turned `second with **bold** text` into `with bold text`
    // in the source, and autosaved it that way.
    const isBreak = t === 'insertParagraph' || t === 'insertLineBreak'
    if (isDelete || isPlainInsert || isBreak) {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        const startLine = lineElOf(range.startContainer)
        const endLine = lineElOf(range.endContainer)
        if (startLine && endLine && startLine !== endLine) {
          // Multi-line selection: replace it ourselves. For a delete the
          // replacement is empty; for an insert it's the typed/pasted
          // text (which may itself contain newlines).
          const insert = isDelete ? ''
            : isBreak ? '\n'
            : (e.dataTransfer?.getData('text/plain') ?? e.data ?? '')
          e.preventDefault()
          replaceSourceRange(
            startLine, offsetInLineFor(startLine, range.startContainer, range.startOffset),
            endLine, offsetInLineFor(endLine, range.endContainer, range.endOffset),
            insert,
          )
          updateEmptyState()
          scheduleSave()
          renderAnnotationOverlay()
          commitHistoryBatch(true)
          return
        }
      }
    }

    // Collapsed caret sitting on a line boundary. Backward at the start
    // of a line strips its block marker if it has one (demoting the
    // heading / list item), else joins it onto the line above; forward
    // at the end of a line pulls the next line up.
    if (t === 'deleteContentBackward' || t === 'deleteContentForward') {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        if (range.collapsed) {
          const line = lineElOf(range.startContainer)
          if (line && line.parentElement === docEl) {
            const kind = (line.dataset.kind || 'body') as LineKind
            const text = line.textContent || ''
            const markerLen = blockMarkerLength(kind, text)
            const off = offsetInLineFor(line, range.startContainer, range.startOffset)
            const hasBlockMarker = markerLen > 0
              && hasStrippableMarker(kind)
            const boundary = isTableRowKind(kind)
              ? handleTableBoundaryDelete(line, t === 'deleteContentForward', off)
              : false
            if (boundary) {
              e.preventDefault()
              if (boundary === 'edited') commitHistoryBatch(true)
              return
            }
            if (t === 'deleteContentBackward' && off <= markerLen && hasBlockMarker) {
              e.preventDefault()
              stripBlockMarker(line)
              updateEmptyState(); scheduleSave(); renderAnnotationOverlay()
              commitHistoryBatch(true)
              return
            }
            if (t === 'deleteContentBackward' && off === 0 && line.previousElementSibling) {
              e.preventDefault()
              mergeLineBackward(line)
              updateEmptyState(); scheduleSave(); renderAnnotationOverlay()
              commitHistoryBatch(true)
              return
            }
            if (t === 'deleteContentForward' && off === text.length && line.nextElementSibling) {
              e.preventDefault()
              mergeLineBackward(line.nextElementSibling as HTMLElement)
              updateEmptyState(); scheduleSave(); renderAnnotationOverlay()
              commitHistoryBatch(true)
              return
            }
          }
        }
      }
    }

    // Retyping a block marker over an existing one. The caret snaps past a
    // hidden marker, so a `#` typed at the visible start of a heading landed
    // *after* the marker: `## Heading` became `## #Heading`, still an H2, and
    // there was no way to change a heading's level by typing at all — the
    // marker could only be removed with Backspace and the whole thing retyped.
    // Typing `#` at the visible start now clears the line's existing marker
    // and starts the new one, so `## Heading` + `#` + space reads as H1, and
    // `# Heading` + `##` + space reads as H2.
    if (t === 'insertText' && e.data === '#') {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        if (range.collapsed) {
          const line = lineElOf(range.startContainer)
          if (line && line.parentElement === docEl) {
            const kind = (line.dataset.kind || 'body') as LineKind
            const text = line.textContent || ''
            const markerLen = blockMarkerLength(kind, text)
            const hasBlockMarker = markerLen > 0
              && hasStrippableMarker(kind)
            if (hasBlockMarker
                && offsetInLineFor(line, range.startContainer, range.startOffset) === markerLen) {
              e.preventDefault()
              noteHistoryPre()
              // Replace the old marker with the single `#` just typed; the
              // caret lands after it so a second `#` or the space continues
              // the new marker normally.
              replaceSourceRange(line, 0, line, markerLen, '#')
              updateEmptyState(); scheduleSave(); renderAnnotationOverlay()
              commitHistoryBatch(true)
              return
            }
          }
        }
      }
    }

    if ((t === 'insertText' || t === 'insertCompositionText') && typeof e.data === 'string') {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      if (!range.collapsed) return
      const wrap = inlineWrapAtCaretEdge(range)
      if (!wrap) return
      e.preventDefault()
      const lineLevel = wrap.parentNode!
      const after = wrap.nextSibling
      const newText = document.createTextNode(e.data)
      if (after) lineLevel.insertBefore(newText, after)
      else       lineLevel.appendChild(newText)
      const r = document.createRange()
      r.setStart(newText, newText.textContent!.length)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      // The browser won't fire 'input' for a prevented insertion, so
      // run the post-edit pipeline ourselves to reclassify, save and
      // refresh annotation underline geometry (it depends on DOM
      // ranges that just moved) — and close the undo step, which the
      // 'input' handler would otherwise have done.
      reclassifyLines()
      updateEmptyState()
      scheduleSave()
      renderAnnotationOverlay()
      commitHistoryBatch(false)
      return
    }

    // Delete/Backspace near a hidden marker. Chrome's default
    // `deleteContentForward` / `deleteContentBackward` treats a
    // `display:none` marker span as zero-width and consumes it together with
    // the visible character on its other side:
    //   - `# Heading|` + Home + Delete → `eading` (body) — ate `# H`
    //   - `# H|eading` + Backspace      → `eading` (body) — ate `# H`
    // Both shapes are: cursor at offset N of a text node whose immediate
    // previous sibling is a `.md-marker` span; N is 0 for Delete (the char
    // to remove is at offset 0), 1 for Backspace (the char to remove is at
    // offset 0, the cursor sits just past it). In each case we delete just
    // the one visible character ourselves and leave the marker alone, so
    // the line keeps its kind. Inline wrap markers (`**` / `` ` ``) get the
    // same treatment: the inner text node of a <strong>/<code> sits right
    // after a marker span, so the bug otherwise eats the opening delimiter.
    if (t === 'deleteContentForward' || t === 'deleteContentBackward') {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      if (!range.collapsed) return
      const a = range.startContainer
      if (a.nodeType !== Node.TEXT_NODE) return
      const expectedOffset = (t === 'deleteContentForward') ? 0 : 1
      if (range.startOffset !== expectedOffset) return
      const prev = a.previousSibling
      if (!prev || prev.nodeType !== Node.ELEMENT_NODE) return
      if (!(prev as HTMLElement).classList.contains('md-marker')) return
      const txt = a as Text
      if ((txt.data || '').length === 0) return
      e.preventDefault()
      txt.deleteData(0, 1)
      const r = document.createRange()
      r.setStart(txt, 0)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      reclassifyLines()
      updateEmptyState()
      scheduleSave()
      renderAnnotationOverlay()
      commitHistoryBatch(true)
      return
    }
  })

  // Force plain-text paste — markdown editor: any HTML/styled content
  // would inject inline styles and tags we'd then have to scrub.
  docEl!.addEventListener('paste', (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') || ''
    // Snapshot before the insert. execCommand called from inside a paste
    // handler does not reliably deliver a beforeinput of its own, so the
    // usual recorder never sees the edit — a paste landed and Cmd+Z then
    // did nothing at all, while typing or deleting over the same selection
    // undid correctly. Capturing here covers both cases: if beforeinput does
    // fire, this is the same pre-state it would have taken, and the extra
    // commit below is a no-op once the batch has closed.
    noteHistoryPre()
    // insertText respects the line model: newlines split into new
    // editor-line divs via the browser's normal Enter handling.
    document.execCommand('insertText', false, text)
    commitHistoryBatch(true)
  })

  // Drag-and-drop also tries to inject HTML; force plain-text the same
  // way as paste.
  // Remember what was picked up, so an in-document drag can move rather than
  // copy: the drop handler cancels the browser's default, and that default is
  // what would have removed the source.
  docEl!.addEventListener('dragstart', () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.getRangeAt(0).collapsed) { dragSource = null; return }
    const range = sel.getRangeAt(0)
    const startLine = lineElOf(range.startContainer)
    const endLine = lineElOf(range.endContainer)
    if (!startLine || !endLine) { dragSource = null; return }
    dragSource = {
      startLine, endLine,
      startOffset: offsetInLineFor(startLine, range.startContainer, range.startOffset),
      endOffset: offsetInLineFor(endLine, range.endContainer, range.endOffset),
    }
  })
  docEl!.addEventListener('dragend', () => { dragSource = null })

  docEl!.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    const text = e.dataTransfer?.getData('text/plain') || ''
    const source = dragSource
    dragSource = null
    if (!text) return
    noteHistoryPre()

    // Insert where the pointer is, not where the selection happens to be.
    // execCommand targets the selection, so dropped text landed back at its
    // origin: an in-document drag appeared to do nothing at all, and text
    // dragged in from another application went to the last caret position
    // rather than where it was aimed.
    const at = caretRangeFromPoint(e.clientX, e.clientY)
    const dropLine = at ? lineElOf(at.startContainer) : null
    if (!at || !dropLine || dropLine.parentElement !== docEl) return
    const dropOffset = offsetInLineFor(dropLine, at.startContainer, at.startOffset)
    const dropIndex = Array.prototype.indexOf.call(docEl!.children, dropLine)

    if (source) {
      // In-document move: remove the original first, then insert at the drop
      // point. Both go through source coordinates so hidden markers survive.
      // When the removal was earlier on the same line, the drop offset shifts
      // left by however much came out.
      const sameLine = source.startLine === dropLine
      const removed = sameLine && source.endOffset <= dropOffset
        ? source.endOffset - source.startOffset
        : 0
      replaceSourceRange(source.startLine, source.startOffset, source.endLine, source.endOffset, '')
      const target = (docEl!.children[Math.min(dropIndex, docEl!.children.length - 1)] as HTMLElement | undefined) || null
      if (target) {
        const offset = Math.max(0, Math.min(dropOffset - removed, (target.textContent || '').length))
        replaceSourceRange(target, offset, target, offset, text)
      }
    } else {
      replaceSourceRange(dropLine, dropOffset, dropLine, dropOffset, text)
    }
    updateEmptyState()
    scheduleSave()
    renderAnnotationOverlay()
    commitHistoryBatch(true)
  })

  // Selection.toString() and the browser's default copy data both
  // strip display:none content — but our `# `/`## ` markers are
  // hidden that way. Intercept copy and rebuild the markdown from
  // each line's textContent (which still includes the marker chars),
  // sliced to the selection's bounds within each line, joined with
  // newlines. The result is true markdown, exactly as it sits on
  // disk — what the user sees in this editor is the rendering, what
  // they paste elsewhere is the source.
  docEl!.addEventListener('copy', (e: ClipboardEvent) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return
    if (!docEl!.contains(range.commonAncestorContainer)
        && range.commonAncestorContainer !== docEl) return
    const md = reconstructMarkdownFromRange(range)
    if (md == null) return
    e.preventDefault()
    e.clipboardData?.setData('text/plain', md)
  })

  // Cut is copy + delete; same reconstruction so the clipboard sees
  // markdown. The deletion itself is left to the browser's default
  // (which acts on visible text); reclassify on the resulting input
  // event will rebuild any line whose marker was disturbed.
  docEl!.addEventListener('cut', (e: ClipboardEvent) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return
    if (!docEl!.contains(range.commonAncestorContainer)
        && range.commonAncestorContainer !== docEl) return
    const md = reconstructMarkdownFromRange(range)
    if (md == null) return
    e.clipboardData?.setData('text/plain', md)
    // Don't preventDefault — we still want the browser to delete the
    // visible selection. Setting clipboardData on a cut event without
    // preventDefault overrides the default copy data while letting the
    // delete proceed.
    e.preventDefault()
    document.execCommand('delete')
  })

  docEl!.addEventListener('input', (e) => {
    reclassifyLines()
    updateEmptyState()
    scheduleSave()
    // Re-render annotation overlay AFTER reclassifyLines: the line
    // tree has been canonicalised, so DOM ranges and getClientRects
    // produce the right pixel positions for the underlines.
    renderAnnotationOverlay()
    // Plain typing coalesces into one undo step; anything structural
    // (Enter, delete, paste) ends the step where it happened.
    const t = (e as InputEvent).inputType || ''
    const coalescing = t === 'insertText' || t === 'insertCompositionText'
    commitHistoryBatch(!coalescing)
  })

  // Show / hide the floating selection buttons based on the live
  // selection. selectionchange fires on every cursor move, so this
  // also handles the case where the user starts a selection with
  // shift+arrow and grows it.
  document.addEventListener('selectionchange', () => {
    // Only react when the editor is the focused element — avoids
    // showing the buttons while the user has selected text in some
    // other view.
    if (document.activeElement !== docEl) {
      hideSelectionActions()
      return
    }
    refreshCaretLineReveal()
    updateCommentButtonForSelection()
  })

  commentBtnEl = viewEl.querySelector<HTMLButtonElement>('#editor-comment-btn')
  commentBtnEl?.addEventListener('mousedown', (e) => {
    // mousedown (not click) so the action fires before the editor
    // sees the click event and collapses the selection itself.
    e.preventDefault()
    createAnnotationFromSelection()
  })

  // Issue button — sibling of the comment trigger. Same mousedown
  // contract so the live selection survives long enough to be read
  // and the snippet seeded into the composer body.
  issueBtnEl = viewEl.querySelector<HTMLButtonElement>('#editor-issue-btn')
  issueBtnEl?.addEventListener('mousedown', (e) => {
    e.preventDefault()
    openIssueComposerFromSelection()
  })

  // Snippet button — third sibling. Same mousedown contract so the live
  // selection survives to seed the composer body.
  snippetBtnEl = viewEl.querySelector<HTMLButtonElement>('#editor-snippet-btn')
  snippetBtnEl?.addEventListener('mousedown', (e) => {
    e.preventDefault()
    openSnippetComposerFromSelection()
  })

  // Warm the org-wide repo list so the composer's <select> is
  // ready on first click. Cheap (5-min server cache); errors are
  // swallowed inside ensureRepos.
  ensureRepos()

  overlayEl = viewEl.querySelector<HTMLElement>('#editor-annotations')
  overlayEl?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const id = target?.dataset?.annId
    if (!id) return
    e.stopPropagation()
    openThreadForAnnotation(id)
  })

  // Re-position annotation overlays on viewport changes. Resize and
  // scroll both invalidate the cached rects; they're cheap to redraw
  // (a few transient absolute divs), so we do it eagerly.
  window.addEventListener('resize', renderAnnotationOverlay)

  for (const eventName of ['keydown', 'beforeinput', 'paste', 'cut', 'drop']) {
    docEl!.addEventListener(eventName, event => {
      if (googleImporting) { event.preventDefault(); event.stopImmediatePropagation() }
    }, { capture: true })
  }
  docEl!.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      clearSaveTimer()
      void flushEditorSaves()
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault()
      void newDoc()
    }
    // Own undo/redo outright — the native stack is incoherent here
    // because reclassify rebuilds line children behind its back. See the
    // history section above.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) redoEditor()
      else            undoEditor()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y') && !e.shiftKey) {
      e.preventDefault()
      redoEditor()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B') && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      toggleBoldAtSelection()
    }
    // Right-arrow / End from the end of a bold's or code's inner
    // text: Chrome won't navigate the caret past hidden markers, so
    // the user gets stuck inside the wrapper and subsequent typing
    // extends the bold/code. We intercept and jump to the sentinel
    // text node after the wrapper, so one keypress is enough to exit
    // and start typing plain text. The opposite (entering the
    // wrapper from outside) doesn't need a fix — Chrome navigates
    // into wrapper inner text cleanly.
    if ((e.key === 'ArrowRight' || e.key === 'End') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        if (range.collapsed) {
          const node = range.startContainer
          if (node.nodeType === Node.TEXT_NODE) {
            const parent = node.parentNode as HTMLElement | null
            if (parent
                && isInlineWrap(parent)
                && range.startOffset === (node.textContent || '').length
                && node.nextSibling
                && node.nextSibling.nodeType === Node.ELEMENT_NODE
                && (node.nextSibling as HTMLElement).classList.contains('md-marker')) {
              const sentinel = parent.nextSibling
              if (sentinel && sentinel.nodeType === Node.TEXT_NODE) {
                e.preventDefault()
                const r = document.createRange()
                r.setStart(sentinel, 0)
                r.collapse(true)
                sel.removeAllRanges()
                sel.addRange(r)
              }
            }
          }
        }
      }
    }
    // Enter inside a list-item: continue the list. Two cases, mirroring
    // every well-behaved markdown editor:
    //   - Empty list item (text is just the marker): exit the list. The
    //     current line becomes body. No new line is inserted; the user
    //     started a list and then changed their mind, so we don't want to
    //     leave them with a stray blank list item AND a blank body line.
    //   - Non-empty: split at the cursor. Text before the cursor stays in
    //     the current list item; text after the cursor goes to a new
    //     list-item line below, prefixed with the appropriate marker
    //     (`- ` for bullet, incremented `N. ` / `N) ` for numbered). The
    //     cursor lands just after the new marker, ready for typing.
    //   - Cursor inside / before the marker prefix: leave default Enter
    //     behaviour alone. The user is editing the prefix itself; we
    //     shouldn't try to split there.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp')
        && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (handleTableVerticalMove(e.key === 'ArrowDown')) {
        e.preventDefault()
        return
      }
    }
    // Tab walks table cells and does nothing anywhere else — the editor
    // has no indent gesture, so outside a table the key keeps its normal
    // "move focus on" meaning.
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (handleTableTab(e.shiftKey)) {
        e.preventDefault()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (handleTableEnter()) {
        e.preventDefault()
        return
      }
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        if (range.collapsed) {
          // Walk up from the caret container to the line div.
          let n: Node | null = range.startContainer
          let line: HTMLElement | null = null
          while (n) {
            if (n.nodeType === Node.ELEMENT_NODE
                && (n as HTMLElement).classList?.contains('editor-line')) {
              line = n as HTMLElement
              break
            }
            n = n.parentNode
          }
          if (line && line.dataset.kind === 'list-item') {
            const lineText = line.textContent || ''
            const markerMatch = lineText.match(/^(?:- |\d+[.)] )/)
            if (markerMatch) {
              // These branches rewrite the DOM directly, so no beforeinput
              // records them. Without this the new item could not be undone at
              // all, and later in a session the Enter was folded into the
              // preceding typing step so one undo threw away both.
              recordHistoryPoint()
              const marker = markerMatch[0]
              const markerLen = marker.length
              const cursorOffset = getCursorOffsetInLine(line) ?? 0
              if (lineText.length <= markerLen) {
                // Empty list item — exit the list.
                e.preventDefault()
                while (line.firstChild) line.removeChild(line.firstChild)
                line.dataset.kind = 'body'
                delete line.dataset.listMarker
                line.appendChild(document.createElement('br'))
                const r = document.createRange()
                r.setStart(line, 0)
                r.collapse(true)
                sel.removeAllRanges()
                sel.addRange(r)
                reclassifyLines()
                renumberOrderedListAround(line)
                updateEmptyState()
                scheduleSave()
                renderAnnotationOverlay()
                return
              }
              if (cursorOffset >= markerLen) {
                // Non-empty + cursor past the marker — split here.
                e.preventDefault()
                const before = lineText.slice(0, cursorOffset)
                const after = lineText.slice(cursorOffset)
                let newMarker = '- '
                const numMatch = marker.match(/^(\d+)([.)]) /)
                if (numMatch) {
                  // Rename to avoid shadowing the outer `n: Node | null`
                  // walker variable used a few lines above.
                  const nextNum = parseInt(numMatch[1], 10) + 1
                  newMarker = `${nextNum}${numMatch[2]} `
                }
                // Rebuild current line with the `before` text.
                const beforeKind = classifyLines([before])[0]
                const freshBefore = buildLineEl(before, beforeKind)
                line.dataset.kind = freshBefore.dataset.kind!
                if (freshBefore.dataset.listMarker !== undefined) {
                  line.dataset.listMarker = freshBefore.dataset.listMarker
                } else {
                  delete line.dataset.listMarker
                }
                line.innerHTML = ''
                while (freshBefore.firstChild) line.appendChild(freshBefore.firstChild)
                // Create the new line with `newMarker + after`.
                const newLineText = newMarker + after
                const newKind = classifyLines([newLineText])[0]
                const newLine = buildLineEl(newLineText, newKind)
                line.parentNode!.insertBefore(newLine, line.nextSibling)
                setCursorOffsetInLine(newLine, newMarker.length)
                reclassifyLines()
                renumberOrderedListAround(line)
                updateEmptyState()
                scheduleSave()
                renderAnnotationOverlay()
                return
              }
            }
          }
        }
      }
    }
    // Escape while the menu is open is handled by onMenuKeydown
    // (installed at openMenu, removed at closeMenu) so it works
    // whether or not the editor has focus.
  })

  window.addEventListener('pagehide', onEditorPageHide)
}

function onEditorPageHide(event: PageTransitionEvent): void {
  // A bfcache entry can later be evicted without a second pagehide event, so
  // persist on every transition. Per-client revisions make a beacon safe even
  // when an older fetch is still in flight.
  void event
  persistEditorHistory()
  sendPendingEditorBeacons()
}

// sendBeacon always issues POST. The server exposes POST aliases for
// these two PUT routes and accepts the same JSON bodies. Only dirty,
// immutable queue snapshots are sent; a false return means the browser
// declined to queue the payload (typically because its keepalive budget
// is exhausted).
function sendPendingEditorBeacons(): void {
  clearSaveTimer()
  clearAnnotationsSaveTimer()
  if (typeof navigator.sendBeacon !== 'function') return

  const doc = documentSaveQueue.pending()
  if (doc) {
    try {
      const baseVersion = doc.baseVersion
      const body = new Blob(
        [JSON.stringify({
          content: doc.content,
          client_id: doc.clientId,
          revision: doc.revision,
          base_version: baseVersion,
        })],
        { type: 'application/json' },
      )
      if (!navigator.sendBeacon(
        `/api/editor/doc/${encodeURIComponent(doc.slug)}`,
        body,
      )) {
        console.warn('[editor] document unload save was not queued')
      }
    } catch { /* best-effort during unload */ }
  }

  const annotationsSnapshot = annotationsSaveQueue.pending()
  if (annotationsSnapshot) {
    try {
      const baseVersion = requiredVersion(annotationsVersions, annotationsSnapshot.slug, 'annotations')
      const body = new Blob(
        [JSON.stringify({
          annotations: JSON.parse(annotationsSnapshot.annotationsJson),
          client_id: annotationsSnapshot.clientId,
          revision: annotationsSnapshot.revision,
          base_version: baseVersion,
        })],
        { type: 'application/json' },
      )
      if (!navigator.sendBeacon(
        `/api/editor/doc/${encodeURIComponent(annotationsSnapshot.slug)}/annotations`,
        body,
      )) {
        console.warn('[editor] annotations unload save was not queued')
      }
    } catch { /* best-effort during unload */ }
  }
}

// External slug-load: any code anywhere in the app can fire
// `poise:editor-load-doc` with { slug } to open a specific document.
// main.ts uses this when /content in the chat pane finishes
// authoring — chat dispatches poise:open-editor-doc, main.ts
// switches the view + re-dispatches the load event for us. We need
// to start fresh discovery (the new article won't be in our
// in-memory `docs` array or an older discovery response yet).
if (typeof window !== 'undefined') {
  window.addEventListener('poise:editor-load-doc', (ev) => {
    const detail = (ev as CustomEvent<{ slug: string, session?: string }>).detail
    if (!detail?.slug) return
    const requestId = ++externalOpenRequestId
    void (async () => {
      if (!initialized) {
        // initEditorView hasn't run yet — main.ts switchTo('editor')
        // triggers it. Wait one tick.
        await new Promise((r) => setTimeout(r, 100))
      }
      if (requestId !== externalOpenRequestId || !viewEl || viewEl.hidden) return
      void fetchDocs({ fresh: true })
      const loadingDocument = loadDoc(detail.slug)
      const documentRequestId = loadRequestId
      await loadingDocument
      // Chat's read-only edit cards carry their session: open the side pane
      // on the session they came from (falling back to the document chat
      // when it cannot be read).
      if (detail.session && requestId === externalOpenRequestId && documentRequestId === loadRequestId && currentSlug === detail.slug && !viewEl.hidden) {
        const d = currentDoc()
        let subject: ChatSubject = { surface: 'editor-document', key: detail.slug, label: d?.title || detail.slug }
        try {
          const found = await chatClient.fetchSession(detail.session, 0)
          if (found.session.subject) subject = found.session.subject
        } catch { /* fall through to the document chat */ }
        if (requestId !== externalOpenRequestId || documentRequestId !== loadRequestId || currentSlug !== detail.slug || viewEl.hidden) return
        chatSidePane.toggle({ subject })
      }
    })()
  })
}

let editorInitialization: Promise<void> | null = null

export async function initEditorView() {
  viewEl = document.getElementById('view-editor')!
  if (!initialized) {
    initialized = true
    viewEl.innerHTML = renderShell()
    docEl          = viewEl.querySelector<HTMLElement>('#editor-doc')
    docEl!.contentEditable = 'false'
    triggerEl      = viewEl.querySelector<HTMLButtonElement>('.editor-doc-trigger')
    triggerTitleEl = viewEl.querySelector<HTMLElement>('.editor-doc-trigger-title')
    menuEl         = viewEl.querySelector<HTMLElement>('#editor-doc-menu')
    googleDocuments = new GoogleDocuments({
      view: viewEl, flush: flushEditorSaves,
      imported: async (slug, content, version) => {
        // A successful import invalidates the old editor version before any further save.
        if (currentSlug !== slug) return
        documentVersions.set(slug, version)
        loadIntoEditor(content); resetEditorHistory(); setMetaForCurrent()
        googleDocuments?.load(slug)
      },
      freeze: frozen => {
        googleImporting = frozen
        if (docEl) docEl.contentEditable = !frozen && currentSlug ? 'true' : 'false'
      },
    })
    registerEditorSurface(editorSurfaceFor)
    document.addEventListener('selectionchange', updateHighlightFromSelection)
    window.addEventListener('editor:inline-thread-closed', onInlineThreadClosed)
    window.addEventListener('editor:inline-thread-open', (ev) => {
      const subject = (ev as CustomEvent<{ subject: ChatSubject }>).detail?.subject
      if (subject) void openThreadForSubject(subject)
    })
    window.addEventListener('editor:inline-thread-back', (ev) => {
      const subject = (ev as CustomEvent<{ subject: ChatSubject }>).detail?.subject
      if (subject) void openThreadForSubject(subject)
    })
    window.addEventListener('editor:inline-thread-moved', () => renderAnnotationOverlay())
    articleReviews = new EditorReviews({
      view: viewEl, document: docEl!, text: serializeDoc,
      range: (start, end) => domRangeForCharRange(docTextSnapshot(), start, end),
      beforeOpen: closeInlineThread,
      openThread: (review, render) => openThreadForReview(review, render),
    })
    attachHandlers()
    setGoogleNavigationGuard(prepareGoogleNavigation)
  }
  // The editor owns unsaved text, selection and undo history. A return only
  // refreshes its picker; reopening the same file would replace that state.
  articleReviews?.resume()
  if (currentSlug) {
    void fetchDocs()
    requestAnimationFrame(() => {
      if (!viewEl.hidden) { googleDocuments?.resume(); renderAnnotationOverlay() }
    })
    return
  }
  googleDocuments?.resume()
  if (editorInitialization) return editorInitialization
  const loading = openInitialDocument()
  editorInitialization = loading
  try { await loading } finally { if (editorInitialization === loading) editorInitialization = null }
}

async function openInitialDocument(): Promise<void> {
  const returned = takeGooglePublishReturn()
  if (returned) {
    takeGoogleConnectionResult()
    const read = await fetchDocs()
    if (read && docs.some(d => d.slug === returned.slug)) await loadDoc(returned.slug)
    if (!read || currentSlug !== returned.slug) {
      setGoogleConnectionResult(`${returned.message} The original draft is unavailable. Open it in the Editor before publishing.`)
      window.dispatchEvent(new CustomEvent('poise:open-settings', { detail: { section: 'accounts' } }))
      return
    }
    const anchor = viewEl.querySelector<HTMLButtonElement>('.editor-publish-btn')!
    togglePublishPanel(anchor, { slug: () => currentSlug, flush: flushEditorSaves, version: () => currentSlug ? documentVersions.get(currentSlug) ?? null : null, published: () => { void articleReviews?.synchronize(true) } }, returned)
    return
  }
  const listing = fetchDocs()
  let target: string | null = null
  try { target = localStorage.getItem(LAST_OPEN_KEY) } catch { /* ignore */ }
  const initialRequest = loadRequestId + (target ? 1 : 0)
  // The remembered file has its own versioned read; library discovery is
  // independent and must not delay opening it.
  if (target) await loadDoc(target)
  if (!await listing || viewEl.hidden || currentSlug || loadRequestId !== initialRequest) return
  target = docs[0]?.slug || null
  if (target) await loadDoc(target)
  else await newDoc()
}

export function stopEditorRefresh() {
  externalOpenRequestId++
  if (!currentSlug) {
    loadRequestId++
    editorInitialization = null
  }
  articleReviews?.stop()
  googleDocuments?.stop()
  clearSaveTimer()
  clearAnnotationsSaveTimer()
  void flushEditorSaves()
  closeMenu()
  closePublishPanel()
  // Strip the writer-mode body class on view leave — otherwise the
  // hidden top nav stays hidden once you come back from another view
  // and the user is stuck.
  document.body.classList.remove('editor-writer-mode')
}
