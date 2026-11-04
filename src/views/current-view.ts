import { viewFeedback } from '../view-feedback'
import { chatSidePane } from './chat-side-pane'
import type { ChatSubject } from '../../server/chat/protocol'
// Current — five-lane kanban that mixes free-form thinking with live GitHub
// activity. The first three lanes (Idea / Concept / Plan) are manual cards
// you drag around; the last two (Issue / PR) are feeds pulled
// from the local cache of issues + PRs you're involved in. Time + status
// filters in the header narrow the live lanes; the manual lanes are
// unaffected. The Issue lane has a richer composer (title / body / repo)
// that opens a real GitHub issue via the proxy. Issue edits use that same
// composer with a fresh GitHub title/body; PR cards keep their existing actions.

import { disclosure, layout, retire, reveal } from '../motion'
import { patchContent } from '../dom-patch'
import { CURRENT_FILTER_KEY, TIME_RANGES, isTimeRange, timeRangeWindow, type TimeRange } from '../time-range'
import { mountOrganizationFilter, organizationPayload, organizationUrl, getSelectedOrganization, organizationErrors } from '../organizations'

type Lane = 'idea' | 'concept' | 'plan' | 'issue' | 'pr'
type LaneType = 'manual' | 'live'

interface LaneConfig { key: Lane; label: string; type: LaneType }

const LANES: LaneConfig[] = [
  { key: 'idea',    label: 'Idea',    type: 'manual' },
  { key: 'concept', label: 'Concept', type: 'manual' },
  { key: 'plan',    label: 'Plan',    type: 'manual' },
  { key: 'issue',   label: 'Issue',   type: 'live' },
  { key: 'pr',      label: 'PR',      type: 'live' },
]

interface ManualCard {
  id: number
  text: string
  lane: 'idea' | 'concept' | 'plan'
  position: number
  repo: string | null   // optional GitHub repo (full owner/name) the card connects to
  created_at: string
  updated_at: string
}

interface LiveItem {
  // Full GitHub identifier — `${repo}#${number}` is unique app-wide.
  repo: string                     // full name, "acme/foo"
  number: number
  title: string
  url: string
  is_pr: 0 | 1
  state: 'open' | 'closed' | 'merged'
  created_at: string
  merged_at: string | null
  updated_at: string
}

interface GhRecord {
  kind: 'pr' | 'issue'
  repo: string
  number: number
  state: 'open' | 'closed' | 'merged'
  title: string
  url: string
  created_at: string
  updated_at: string
  merged_at: string | null
}

// Green: ready to merge. Caution (yellow): the merge button is green, but a check
// fails or still runs, or a conversation is unresolved.
type PrStatus = 'mergeable' | 'caution'
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000   // PRs created in the last 6h read as "just opened"

type TimeFilter = TimeRange
type StatusFilter = 'all' | 'open'

const FILTER_KEY = CURRENT_FILTER_KEY
const LIVE_LIMIT = 200            // upper bound; time / status filters narrow further

let initialized = false
let manualCards: ManualCard[] = []
let liveItems: LiveItem[] = []
// Every repo of the accounts with any PR/issue history, populated from /api/repos
// on view init. Used by the manual + issue composers so the dropdown
// covers the whole org, not just the repos in the user's involvement.
let allRepos: string[] = []
// Set of `${repo}#${pr_id}` for agent-interface jobs currently running.
// Cards whose key matches get a subtle breathing accent so the user
// sees that something is going on behind the scenes for that ticket.
let agentActiveKeys: Set<string> = new Set()
let dragId: number | null = null
let viewEl: HTMLElement
let timeFilter: TimeFilter = 'all'
let statusFilter: StatusFilter = 'all'
let searchQuery = ''
let searchDebounce: ReturnType<typeof setTimeout> | null = null
let prStatus: Map<string, PrStatus> = new Map()
// Confirmed issue creates/edits stay visible while the polling datastore
// catches up. Its older record cannot overwrite a confirmed edit.
// One-hour TTL is a safety net so a stalled sync can't leave a ghost
// pinned at the top forever.
let pendingLiveItems: LiveItem[] = []
const PENDING_TTL_MS = 60 * 60 * 1000

interface RepoLabel { name: string, color: string, description: string | null }
// Label catalogues by repo, shared across composer opens so a catalogue is
// read once per few minutes however often the composer opens.
const repoLabelCache = new Map<string, { labels: RepoLabel[], at: number }>()
const LABEL_CACHE_TTL_MS = 5 * 60 * 1000
// Tick listener installed on view init; removed via stopCurrentPolling()
// when navigating away. Single shared clock — see startRefreshTicker().
const onLiveTick = () => pollLiveTick()
let liveListening = false
let currentLoadSequence = 0

// ── Helpers ─────────────────────────────────────────────────────────────────

// Attribute-safe HTML escape. textContent → innerHTML only escapes &,
// <, >, which is fine for text-content interpolation but NOT for
// attribute values: an unescaped " or ' will close the attribute and
// the rest of the string will leak out as raw HTML (or just get
// dropped). We use this in both text and attribute positions, so the
// escape covers all five characters.
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

function laneEl(lane: Lane): HTMLElement {
  return viewEl.querySelector(`.lane[data-lane="${lane}"]`)!
}

function laneListEl(lane: Lane): HTMLElement {
  return laneEl(lane).querySelector('.lane-list')!
}

function laneCountEl(lane: Lane): HTMLElement {
  return laneEl(lane).querySelector('.lane-count')!
}

function matchesSearch(...haystacks: (string | null | undefined)[]): boolean {
  if (!searchQuery) return true
  const q = searchQuery.toLowerCase()
  for (const h of haystacks) {
    if (h && h.toLowerCase().includes(q)) return true
  }
  return false
}

function manualInLane(lane: 'idea' | 'concept' | 'plan'): ManualCard[] {
  return manualCards
    .filter((c) => c.lane === lane && matchesSearch(c.text))
    .sort((a, b) => a.position - b.position)
}

function timeWindow(): { since?: string; until?: string } {
  return timeRangeWindow(timeFilter)
}

function liveInLane(lane: 'issue' | 'pr'): LiveItem[] {
  const isPr = lane === 'pr' ? 1 : 0
  // Items already arrive filtered server-side by status / time — search is
  // applied here client-side over the loaded set so typing is instant.
  return liveItems.filter((i) => i.is_pr === isPr && matchesSearch(i.title, i.repo))
}

function relativeTime(iso: string): string {
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

// Open is implicit (the card existing tells you it's open). We only badge
// the deviations — merged and closed — so the eye lands on the cards that
// have actually moved past the "active work" state.
function liveStateLabel(item: LiveItem): { text: string; cls: string } | null {
  if (item.state === 'merged') return { text: 'merged', cls: 'merged' }
  if (item.state === 'closed') return { text: 'closed', cls: 'closed' }
  return null
}

function prKey(item: LiveItem): string {
  // repo is now the full owner/name, matching the /github record shape
  return `${item.repo}#${item.number}`
}

function isFresh(item: LiveItem): boolean {
  // "Fresh" is a stripe that says "newly opened, hasn't gathered review
  // signal yet" — it must not survive closure. A PR that was opened and
  // merged within the same 6-hour window would otherwise keep the blue
  // stripe even after merging, contradicting the merged/closed state
  // already rendered in its meta row.
  if (item.state !== 'open') return false
  return Date.now() - new Date(item.created_at).getTime() < FRESH_WINDOW_MS
}

function isMergeable(item: LiveItem): boolean {
  return item.is_pr === 1 && prStatus.get(prKey(item)) === 'mergeable'
}

function isCaution(item: LiveItem): boolean {
  return item.is_pr === 1 && prStatus.get(prKey(item)) === 'caution'
}

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (isTimeRange(parsed.time)) timeFilter = parsed.time
    if (['all', 'open'].includes(parsed.status)) statusFilter = parsed.status
  } catch { /* ignore */ }
}

function saveFilters() {
  localStorage.setItem(FILTER_KEY, JSON.stringify({ time: timeFilter, status: statusFilter }))
}

// ── Render: shell + lanes ───────────────────────────────────────────────────

function renderShell(): string {
  const lanes = LANES.map((l) => `
    <section class="lane" data-lane="${l.key}" data-lane-type="${l.type}">
      <header class="lane-header">
        <span class="lane-title">${l.label}</span>
        <span class="lane-count">0</span>
      </header>
      ${l.key === 'pr' ? '' : `
        <button class="lane-add" data-lane="${l.key}" aria-label="${l.key === 'issue' ? 'Add an issue' : `Add a card to ${l.label}`}">+ ${l.key === 'issue' ? 'Add an issue' : 'Add a card'}</button>
      `}
      <div class="lane-list" data-lane="${l.key}"></div>
    </section>
  `).join('')

  return `
    <header class="view-header">
      <div class="filter-cluster" id="current-filters">
        <div class="range-picker" id="current-status-filter">
          <button data-status="all" class="${statusFilter === 'all' ? 'active' : ''}">Any</button>
          <button data-status="open" class="${statusFilter === 'open' ? 'active' : ''}">Open</button>
        </div>
        <div class="range-picker" id="current-time-picker">
          ${TIME_RANGES.map((range) => `<button data-time="${range.key}" class="${timeFilter === range.key ? 'active' : ''}">${range.label}</button>`).join('')}
        </div>
        <input class="search-input" id="current-search" type="search" placeholder="Filter…" autocomplete="off" spellcheck="false" aria-label="Filter cards" />
      </div>
    </header>
    <div class="kanban">${lanes}</div>
  `
}

// Read failures remain available across views in the notification rail.
function showLoadError(message: string): void {
  const completed = /^(Card added|Issue created)/.test(message)
  viewFeedback(completed ? 'current-created' : 'current-read', completed ? 'Current item created' : 'Current is not updating', message, completed ? 'action_finished' : 'read_failed')
}

// ── Card chrome strategy ──────────────────────────────────────────────
// All interactive icons live in a single hover-revealed strip anchored
// bottom-right. Content (title/body) gets the full card width — the
// strip overlaps the meta row instead, which fades out on hover so
// icons aren't sitting on top of visible text.
//
//   ┌──────────────── card ──────────────────┐
//   │  card content (FULL WIDTH — no inset)  │
//   │  …                                     │
//   │  meta row (repo · time)                │   meta fades on hover
//   │                          [copy][chat][×] │ ← single bottom-right
//   └────────────────────────────────────────┘    strip; grows leftward
//
// Order is `[tools …][primary]` — destructive/active singletons (×
// delete on manual cards, ▶ review on PRs) anchor as the rightmost
// member. Adding a 4th/5th icon later is just another <button> child
// of .card-actions before the primary slot — no layout reasoning
// needed.

const CHAT_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M2.5 3h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-2.5 2v-2H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>'
// Two-rectangles "duplicate" mark — most universal copy glyph, reads
// as "copy" without the verbosity of a clipboard.
const COPY_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><rect x="3" y="3" width="7" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 3V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
// Checkmark shown for ~1.2s after a successful copy as visual feedback.
const CHECK_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3 7.5l3 3 5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// Tag mark for the issue composer's label picker — quiet on purpose.
const TAG_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 2.5h4.5L12 8a1 1 0 0 1 0 1.4L9.4 12a1 1 0 0 1-1.4 0L2.5 6.9V2.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="5" cy="5" r="1" fill="currentColor"/></svg>'

// Opens the card's Chat session in the Chat view: its session when it has
// one, else the composer with the card's prefill. The first message,
// not the click, creates the session.
const CHAT_SESSION_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M2.5 3h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-2.5 2v-2H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M5 5.5l2 1.5-2 1.5M7.5 8.5h2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function chatSessionButton(item: LiveItem): string {
  return `<button class="card-action-btn card-chat-session-btn" data-repo="${escapeHtml(item.repo)}" data-number="${item.number}" data-pr="${item.is_pr}" title="Open in Chat" aria-label="Open in Chat">${CHAT_SESSION_ICON_SVG}</button>`
}

function chatButton(sessionId: string, label: string, draft: string): string {
  return `<button class="card-action-btn card-chat-btn" data-session="${escapeHtml(sessionId)}" data-label="${escapeHtml(label)}" data-draft="${escapeHtml(draft)}" title="Chat about this card" aria-label="Chat">${CHAT_ICON_SVG}</button>`
}

function copyButton(text: string): string {
  return `<button class="card-action-btn card-copy-btn" data-clip="${escapeHtml(text)}" title="Copy" aria-label="Copy">${COPY_ICON_SVG}</button>`
}

function deleteButton(): string {
  return `<button class="card-action-btn card-delete" title="Delete card" aria-label="Delete card">×</button>`
}

// Offered on every pull request, including the merged and closed ones. It
// spawns a real detached `agent-interface --pr-review`, so a click on a PR
// that shipped last week burns an agent run to review something nobody can
// act on. A finished pull request is not a review target.
function reviewButton(item: LiveItem): string {
  const settled = item.state === 'merged' || item.state === 'closed' || !!item.merged_at
  if (settled) {
    return `<button class="card-action-btn card-review-btn" disabled`
      + ` title="This pull request is ${item.merged_at || item.state === 'merged' ? 'merged' : 'closed'} — nothing to review"`
      + ` aria-label="Run PR review (unavailable)">${PR_REVIEW_PLAY_SVG}</button>`
  }
  return `<button class="card-action-btn card-review-btn" title="Run PR review" aria-label="Run PR review">${PR_REVIEW_PLAY_SVG}</button>`
}

// Bottom-right action strip — single horizontal cluster holding all
// of a card's icons. Order is `[tools …][primary]`: copy + chat (and
// any future tool) on the left, the per-card-type primary action
// (delete on manual cards, review on PRs) anchored as the rightmost
// member. `primary` may be empty (issue cards have no primary).
function cardActions(opts: {
  sessionId: string,
  label: string,
  copyText: string,
  primary?: string,
  /** Extra tool buttons between chat and the primary slot. */
  tools?: string,
}): string {
  return `<div class="card-actions">${copyButton(opts.copyText)}${chatButton(opts.sessionId, opts.label, opts.copyText)}${opts.tools || ''}${opts.primary || ''}</div>`
}

// Copy `text` to the clipboard and briefly swap the button's icon
// for a check mark as visual confirmation. Falls back to a stale
// `document.execCommand('copy')` path for the rare browser/context
// without `navigator.clipboard` (insecure context, old WebView, etc.).
async function copyTextWithFeedback(btn: HTMLButtonElement, text: string): Promise<void> {
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
    console.error('[copy] failed:', err)
  }
  if (!ok) return
  // Swap icon → check, mark .is-copied so CSS can settle the colour
  // to a quiet success tone, then revert after ~1.2s. Using two
  // rAFs ensures the icon swap actually paints before any CSS
  // transition piggy-backs.
  const original = btn.innerHTML
  btn.innerHTML = CHECK_ICON_SVG
  btn.classList.add('is-copied')
  window.setTimeout(() => {
    btn.classList.remove('is-copied')
    btn.innerHTML = original
  }, 1200)
}

function manualSessionId(card: ManualCard): string {
  return `poise.card.${card.id}`
}

function liveSessionId(item: LiveItem): string {
  return `poise.${item.is_pr === 1 ? 'pr' : 'issue'}.${item.repo}.${item.number}`
}

/** The card's Chat subject. Live cards carry their GitHub url, derived from
 *  the key when only the button's dataset is at hand. */
function cardSubject(key: string, label: string, url?: string): ChatSubject {
  const live = /^poise\.(issue|pr)\.(.+)\.(\d+)$/.exec(key)
  const derived = live ? `https://github.com/${live[2]}/${live[1] === 'pr' ? 'pull' : 'issues'}/${live[3]}` : undefined
  return { surface: 'current', key, label, ...(url || derived ? { url: url || derived! } : {}) }
}

function renderManualCard(card: ManualCard): HTMLElement {
  const el = document.createElement('article')
  el.className = 'card card-manual'
  el.draggable = true
  el.dataset.id = String(card.id)
  el.dataset.lane = card.lane
  // Editing was mouse-only: clicking the card opened the editor and there was
  // no keyboard equivalent, though the delete button next to it was reachable
  // by Tab. Make the card itself a focus stop that opens on Enter.
  el.tabIndex = 0
  el.setAttribute('role', 'button')
  el.setAttribute('aria-label', `Edit card: ${card.text.slice(0, 60)}`)
  // Meta row mirrors the PR/Issue card shape — repo (if linked) on the
  // left, timestamp at the end. Bottom-right hosts the delete action;
  // the top-right strip hosts the non-destructive tool icons (chat,
  // copy, …) — see the chrome strategy comment near cardActions().
  const repoTag = card.repo
    ? `<span class="card-repo">${escapeHtml(card.repo)}</span>`
    : ''
  el.innerHTML = `
    <div class="card-text">${escapeHtml(card.text).replace(/\n/g, '<br>')}</div>
    <div class="card-meta">
      ${repoTag}
      <span class="card-time">${relativeTime(card.updated_at)}</span>
    </div>
    ${cardActions({
      sessionId: manualSessionId(card),
      label: card.text.slice(0, 60),
      copyText: card.text,
      primary: deleteButton(),
    })}
  `
  return el
}

// Small play icon for PR cards — same shape Archive uses for its
// consensus-review button so the visual vocabulary stays consistent.
const PR_REVIEW_PLAY_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg>'
const PR_REVIEW_SPIN_SVG = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" class="spin"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="8 6" stroke-linecap="round"/></svg>'

function renderLiveItem(item: LiveItem): HTMLElement {
  const el = document.createElement('article')
  el.dataset.id = prKey(item)        // stable id across refreshes for the FLIP
  paintLiveItem(el, item)
  return el
}

// Repaint an existing live card from the latest data. The animated refresh
// reused the card node and never touched its contents, so a pull request that
// got merged slid to the top of the lane still showing no merged badge and its
// original timestamp — the motion said something had happened and the text
// said nothing had. Relative times were frozen at first paint too.
function paintLiveItem(el: HTMLElement, item: LiveItem): void {
  const classes = ['card', 'card-live']
  if (isMergeable(item))      classes.push('card-mergeable')
  else if (isCaution(item))   classes.push('card-caution')
  else if (isFresh(item) && item.is_pr === 1) classes.push('card-fresh')
  if (agentActiveKeys.has(prKey(item))) classes.push('card-active')
  el.className = classes.join(' ')
  const st = liveStateLabel(item)
  const stateBadge = st ? `<span class="state ${st.cls}">${st.text}</span>` : ''
  // PR cards get a tiny review icon as the rightmost member of the
  // action strip; issue cards expose an explicit edit instead of changing their link.
  const primary = item.is_pr === 1 ? reviewButton(item)
    : `<button class="card-action-btn card-issue-edit" aria-label="Edit issue ${escapeHtml(item.repo)}#${item.number}" title="Edit issue">Edit</button>`
  patchContent(el, `
    <a class="card-link" href="${safeHttpsUrl(item.url)}" target="_blank" rel="noopener">
      <div class="card-text">${escapeHtml(item.title)}</div>
      <div class="card-meta">
        <span class="card-repo">${escapeHtml(item.repo)}</span>
        <span class="card-num">#${item.number}</span>
        ${stateBadge}
        <span class="card-time">${relativeTime(item.updated_at)}</span>
      </div>
    </a>
    ${cardActions({
      sessionId: liveSessionId(item),
      label: `${item.repo}#${item.number}`,
      copyText: `${item.title}\n${item.url}`,
      tools: chatSessionButton(item),
      primary,
    })}
  `)
}

// An open card editor is a child of its card, and renderAll empties every
// lane list — so anything renderAll-triggered while someone was mid-sentence
// (dropping another card, deleting one, typing in the search box) threw the
// typed text away without a word. Capture the draft before the wipe and hand
// it back afterwards.
interface EditDraft { id: number, text: string, repo: string | null }
let openEditDraft: EditDraft | null = null

function captureOpenEdit(): EditDraft | null {
  const editing = viewEl?.querySelector<HTMLElement>('.card.editing')
  if (!editing) return null
  const ta = editing.querySelector<HTMLTextAreaElement>('.card-edit textarea')
  if (!ta) return null
  const repoSel = editing.querySelector<HTMLSelectElement>('.card-edit .manual-repo')
  return { id: Number(editing.dataset.id), text: ta.value, repo: repoSel?.value || null }
}

function restoreOpenEdit(draft: EditDraft | null): void {
  if (!draft) return
  const cardEl = viewEl?.querySelector<HTMLElement>(`.card[data-id="${draft.id}"]:not(.card-live)`)
  // The card can be gone (deleted elsewhere) or filtered out of the DOM. Hold
  // the draft rather than dropping it; the next render that shows the card
  // again restores it.
  if (!cardEl) { openEditDraft = draft; return }
  openEditDraft = null
  startEdit(cardEl, draft)
}

function renderAll(type?: LaneType) {
  const draft = captureOpenEdit() ?? openEditDraft
  layout(viewEl, () => {
    const existing = new Map([...viewEl.querySelectorAll<HTMLElement>('.lane-list > .card')].map(el => [el.dataset.id!, el]))
    const keep = new Set<HTMLElement>()
    for (const lane of LANES) {
      const list = laneListEl(lane.key)
      if (type && lane.type !== type) { for (const actor of list.querySelectorAll<HTMLElement>(':scope > .card')) keep.add(actor); continue }
      let cursor = list.firstChild
      const place = (actor: HTMLElement) => {
        keep.add(actor)
        if (actor !== cursor) list.insertBefore(actor, cursor)
        cursor = actor.nextSibling
      }
      const manual = lane.type === 'manual' ? manualInLane(lane.key as 'idea' | 'concept' | 'plan') : []
      const live = lane.type === 'live' ? liveInLane(lane.key as 'issue' | 'pr') : []
      for (const card of manual) {
        const fresh = renderManualCard(card)
        const actor = existing.get(String(card.id)) ?? fresh
        if (actor !== fresh && !actor.classList.contains('editing')) patchContent(actor, fresh.innerHTML)
        actor.dataset.lane = lane.key
        place(actor)
      }
      for (const item of live) {
        const actor = existing.get(prKey(item)) ?? renderLiveItem(item)
        if (existing.has(prKey(item))) paintLiveItem(actor, item)
        place(actor)
      }
      const count = manual.length + live.length
      laneCountEl(lane.key).textContent = lane.type === 'live' && liveTruncated ? `${count}+` : String(count)
      laneCountEl(lane.key).title = lane.type === 'live' && liveTruncated ? `Showing the ${LIVE_LIMIT} most recently updated issues and pull requests combined; older ones are not loaded.` : ''
    }
    for (const actor of existing.values()) if (!keep.has(actor)) retire(actor)
  }, '.lane-list > .card')
  if (type !== 'live' && !viewEl.querySelector('.card.editing')) restoreOpenEdit(draft)
}

function renderLiveOnly() {
  for (const lane of LANES) if (lane.type === 'live') renderLiveLaneAnimated(lane.key as 'issue' | 'pr')
}

function renderLiveLaneAnimated(laneKey: 'issue' | 'pr') {
  const list = laneListEl(laneKey)
  const items = liveInLane(laneKey)
  layout(list, () => {
    const existing = new Map([...list.querySelectorAll<HTMLElement>(':scope > .card')].map(el => [el.dataset.id!, el]))
    const ids = new Set(items.map(prKey))
    for (const [id, el] of existing) if (!ids.has(id)) retire(el)
    let cursor = list.firstChild
    for (const item of items) {
      const el = existing.get(prKey(item)) ?? renderLiveItem(item)
      if (existing.has(prKey(item))) paintLiveItem(el, item)
      if (cursor !== el) list.insertBefore(el, cursor)
      cursor = el.nextSibling
      if (!existing.has(prKey(item))) reveal(el)
    }
  }, ':scope > .card')
  laneCountEl(laneKey).textContent = String(items.length)
}

// ── Data fetches ─────────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}`)
  return res.json()
}

async function fetchManual(sequence = currentLoadSequence) {
  const org = getSelectedOrganization()
  const res = await fetch(organizationUrl('/api/current'))
  if (!res.ok) throw new Error(`/api/current ${res.status}`)
  const data = await res.json()
  if (org !== getSelectedOrganization() || sequence !== currentLoadSequence) return
  manualCards = data.cards.filter((c: ManualCard) => c.lane === 'idea' || c.lane === 'concept' || c.lane === 'plan')
}

// Repository discovery can paginate GitHub for several seconds on a cache
// miss. It feeds composers, never the board's first paint.
async function fetchAllRepos(sequence = currentLoadSequence) {
  const org = getSelectedOrganization()
  const res = await fetch(organizationUrl('/api/repos'))
  if (!res.ok) throw new Error(`/api/repos ${res.status}`)
  const data = await res.json()
  if (org !== getSelectedOrganization() || sequence !== currentLoadSequence) return
  repoLoadWarning = organizationErrors(data)
  allRepos = Array.isArray(data.repos) ? data.repos : []
  refreshRepositorySelectors()
}

// Pull the running-only /api/agent-logs read and rebuild the set of
// running-job keys. Called alongside fetchLive on each refresh tick.
// Errors are swallowed — the breathing accent simply doesn't show.
async function fetchAgentActive(sequence = currentLoadSequence) {
  const org = getSelectedOrganization()
  try {
    const res = await fetch(organizationUrl('/api/agent-logs?status=running'))
    if (!res.ok) return
    const data = await res.json()
    const next = new Set<string>()
    for (const e of (data.logs || [])) {
      if (e.status === 'running' && e.repo && e.pr_id) {
        next.add(`${e.repo}#${e.pr_id}`)
      }
    }
    if (org !== getSelectedOrganization() || sequence !== currentLoadSequence) return
    agentActiveKeys = next
  } catch { /* ignore */ }
}

// Toggle `.card-active` in place across all live cards. Doesn't touch
// other classes or run a re-render — works alongside the FLIP that
// owns positional updates, similar to applyPrStatusClasses.
function applyActiveClasses() {
  for (const cardEl of viewEl.querySelectorAll<HTMLElement>('.card.card-live')) {
    const id = cardEl.dataset.id || ''
    cardEl.classList.toggle('card-active', agentActiveKeys.has(id))
  }
}

async function fetchPrStatus() {
  const org = getSelectedOrganization()
  if (liveItems.filter((i) => i.is_pr === 1).length === 0) {
    if (prStatus.size > 0) { prStatus.clear(); applyPrStatusClasses() }
    return
  }
  try {
    const res = await fetch('/api/gh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'green_pr', ...organizationPayload() }),
    })
    if (!res.ok) return
    const data = await res.json()
    // The /github endpoint already returns full records — repo here is
    // the full "owner/repo" name, matching the format prKey() builds.
    const next = new Map<string, PrStatus>()
    for (const r of data.records || []) {
      next.set(`${r.repo}#${r.number}`, r.status === 'yellow' ? 'caution' : 'mergeable')
    }
    if (org !== getSelectedOrganization()) return
    const changed = next.size !== prStatus.size
      || [...next.entries()].some(([k, v]) => prStatus.get(k) !== v)
    if (changed) {
      prStatus = next
      applyPrStatusClasses()
    }
  } catch { /* upstream offline — silent, cards stay neutral */ }
}

// Touch the mergeable / fresh classes on PR cards in place. Avoids a full
// re-render so the FLIP-induced inline transforms aren't disturbed and
// the user sees no flicker when only the PR-status map changed.
function applyPrStatusClasses() {
  for (const cardEl of viewEl.querySelectorAll<HTMLElement>('.card.card-live')) {
    const id = cardEl.dataset.id || ''
    const item = liveItems.find((i) => prKey(i) === id)
    if (!item || item.is_pr !== 1) continue
    const merge = isMergeable(item)
    const caution = isCaution(item)
    const fresh = !merge && !caution && isFresh(item)
    cardEl.classList.toggle('card-mergeable', merge)
    cardEl.classList.toggle('card-caution', caution)
    cardEl.classList.toggle('card-fresh', fresh)
  }
}

export function stopCurrentPolling() {
  currentLoadSequence++
  if (liveListening) {
    window.removeEventListener('poise:refresh-tick', onLiveTick)
    liveListening = false
  }
}

// Background tick: re-fetch live items, refresh PR mergeable status,
// and rebuild the agent-active set. The live re-render uses the FLIP
// path so cards glide to their new positions; PR-status and active
// passes only twiddle classes so they don't disturb the FLIP.
async function pollLiveTick() {
  try {
    await fetchLive()
    renderLiveOnly()
    // A refresh that starts working again has to clear the notice it left —
    // otherwise the first failure's message stays on screen for the rest of
    // the session, outliving the problem it described.
    showLoadError(liveLoadWarning || repoLoadWarning)
  } catch (err) {
    // Swallowed entirely before, so a GitHub cache that had gone away left the
    // lanes frozen on the last good data with no indication: the board looked
    // current and quietly was not.
    showLoadError(`Not updating — ${(err as Error).message}`)
  }
  try {
    await fetchPrStatus()
  } catch { /* same */ }
  try {
    await fetchAgentActive()
    applyActiveClasses()
  } catch { /* same */ }
}

// Ordering guard for the live read. The unfiltered query is slow and has no
// loading state, so a person who clicks "Any" and then clicks again gets the
// second, faster answer painted first and the first one landing on top of it
// seconds later — leaving the header highlighting one filter while the lanes
// show another. The newest read wins.
let liveSequence = 0
let liveLoadWarning = ''
let repoLoadWarning = ''

async function fetchLive() {
  const mine = ++liveSequence
  const win = timeWindow()
  const payload: Record<string, unknown> = {
    operation: 'list',
    ...organizationPayload(),
    record_type: 'all',
    record_state: statusFilter === 'open' ? 'open' : 'all',
    // One request covers issues and pull requests together, so they compete
    // for the same slots. Ask for one more than we will show, purely to detect
    // that there were more and say so rather than presenting a truncated board
    // as the whole picture.
    limit: LIVE_LIMIT + 1,
    offset: 0,
  }
  if (win.since) payload.updated_since = win.since
  if (win.until) payload.updated_until = win.until
  const res = await fetch('/api/gh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`/api/gh ${res.status}`)
  const data = await res.json()
  // A read from before the current filter is history; applying it would put
  // the lanes and the header out of step.
  if (mine !== liveSequence) return
  liveLoadWarning = organizationErrors(data)
  const records: GhRecord[] = data.records || []
  liveTruncated = records.length > LIVE_LIMIT
  liveItems = records.slice(0, LIVE_LIMIT).map((r) => ({
    repo: r.repo,
    number: r.number,
    title: r.title,
    url: r.url,
    is_pr: r.kind === 'pr' ? 1 : 0,
    state: r.state,
    created_at: r.created_at,
    merged_at: r.merged_at,
    updated_at: r.updated_at,
  }))
  reconcilePending()
}

// Whether the last live read hit the cap. The lanes showed the first 200
// issues-and-PRs-combined as though that were everything, so filtering for a
// real but older issue produced an empty lane that read as "no such issue".
let liveTruncated = false

// Drop pending entries the datastore has now picked up (matched by
// repo + number) and any older than PENDING_TTL_MS, then prepend the
// remaining optimistic items so they appear at the top of their lane.
// Called from fetchLive() right after liveItems is replaced.
// Whether an item belongs in the lane under the filters that are actually
// applied. A freshly-created issue is stamped now, so with the Yesterday
// window selected the server will never return it — the optimistic copy was
// prepended anyway, into a lane whose filter excludes it, and sat there
// unreconcilable until its TTL expired.
function withinActiveWindow(item: LiveItem): boolean {
  const org = getSelectedOrganization()
  if (org && item.repo.split('/')[0].toLowerCase() !== org.toLowerCase()) return false
  if (statusFilter === 'open' && item.state !== 'open') return false
  const win = timeWindow()
  const t = new Date(item.updated_at || item.created_at).getTime()
  if (!isFinite(t)) return true
  if (win.since && t < new Date(win.since).getTime()) return false
  if (win.until && t >= new Date(win.until).getTime()) return false
  return true
}

function reconcilePending() {
  if (!pendingLiveItems.length) return
  const cutoff = Date.now() - PENDING_TTL_MS
  pendingLiveItems = pendingLiveItems.filter((p) => {
    if (Date.parse(p.updated_at) < cutoff) return false
    return !liveItems.some((li) => li.repo === p.repo && li.number === p.number
      && (Date.parse(li.updated_at) > Date.parse(p.updated_at)
        || Date.parse(li.updated_at) === Date.parse(p.updated_at) && li.title === p.title && li.state === p.state))
  })
  const showable = pendingLiveItems.filter(withinActiveWindow)
  if (showable.length) {
    const keys = new Set(showable.map(prKey))
    liveItems = [...showable, ...liveItems.filter(item => !keys.has(prKey(item)))]
  }
}

// Full repository identities disambiguate matching names across organizations.
function distinctRepos(): string[] {
  const set = new Set<string>()
  for (const i of liveItems) set.add(i.repo)
  return [...set].sort((a, b) => a.localeCompare(b))
}

// ── Composers ────────────────────────────────────────────────────────────────

function attachAddHandlers() {
  for (const l of LANES) {
    if (l.key === 'pr') continue
    const btn = laneEl(l.key).querySelector<HTMLButtonElement>('.lane-add')
    if (!btn) continue
    btn.addEventListener('click', () => {
      if (l.key === 'issue') openIssueComposer()
      else openManualComposer(l.key as 'idea' | 'concept' | 'plan')
    })
  }
}

// "— no repo —" + every repo of the accounts. Falls back to the involvement set
// only if /api/repos hasn't loaded yet (cold start race).
function manualRepoOptionsHtml(selected: string | null = null): string {
  const repos = allRepos.length > 0 ? allRepos : distinctRepos()
  return '<option value="">— no repo —</option>' + repositoryOptionsHtml(repos, selected || '')
}

function repositoryOptionsHtml(repos: string[], selected: string): string {
  // A card's linked repository is intent, even before discovery can confirm
  // it. Never substitute the first live-feed repository for that selection.
  const choices = [...new Set([...repos, ...(selected ? [selected] : [])])]
  return choices.map((repo) => `<option value="${escapeHtml(repo)}"${repo === selected ? ' selected' : ''}>${escapeHtml(repo)}</option>`).join('')
}

function refreshRepositorySelectors(): void {
  const repos = allRepos.length > 0 ? allRepos : distinctRepos()
  for (const select of viewEl.querySelectorAll<HTMLSelectElement>('.manual-repo')) {
    select.innerHTML = manualRepoOptionsHtml(select.value || null)
  }
  for (const select of viewEl.querySelectorAll<HTMLSelectElement>('.issue-repo')) {
    select.innerHTML = repositoryOptionsHtml(repos, select.value)
      || '<option value="">(no repos available)</option>'
  }
}

function openManualComposer(lane: 'idea' | 'concept' | 'plan') {
  const laneNode = laneEl(lane)
  const existing = laneNode.querySelector('.composer')
  if (existing) {
    (existing.querySelector('textarea') as HTMLTextAreaElement | null)?.focus()
    return
  }
  const addBtn = laneNode.querySelector<HTMLButtonElement>('.lane-add')!
  addBtn.hidden = true

  const composer = document.createElement('div')
  composer.className = 'composer'
  composer.innerHTML = `
    <textarea rows="3" placeholder="Write a card..." spellcheck="true"></textarea>
    <select class="manual-repo" aria-label="Link a repository">${manualRepoOptionsHtml()}</select>
    <div class="composer-row">
      <button class="composer-add">Add</button>
      <button class="composer-cancel" type="button">Cancel</button>
    </div>
  `
  laneNode.insertBefore(composer, addBtn)
  disclosure(composer, true, undefined, 0)
  const ta = composer.querySelector<HTMLTextAreaElement>('textarea')!
  const repoSel = composer.querySelector<HTMLSelectElement>('.manual-repo')!
  const addB = composer.querySelector<HTMLButtonElement>('.composer-add')!
  const cancelB = composer.querySelector<HTMLButtonElement>('.composer-cancel')!
  const reportError = (message: string) => viewFeedback(`current-create:${lane}`, 'Current action needs attention', message, 'action_needed')

  const close = () => { retire(composer); addBtn.hidden = false }
  let adding = false
  const submit = async () => {
    if (adding) return
    const text = ta.value.trim()
    if (!text) { close(); return }
    adding = true
    addB.disabled = true
    reportError('')
    try {
      const repo = repoSel.value || null
      const card = await api<ManualCard>('POST', '/api/current', { text, lane, repo })
      manualCards.push(card)
      renderAll()
      close()
      // A card written while the filter box excludes it used to vanish on
      // creation, which is indistinguishable from the write having failed.
      if (searchQuery && !matchesSearch(card.text)) {
        showLoadError('Card added — the filter is hiding it.')
        window.setTimeout(() => viewFeedback('current-created', 'Current item created', ''), 5000)
      }
    } catch (err) {
      // A failed create was a silent no-op: the Add button simply stopped
      // responding and the reason went to the console.
      addB.disabled = false
      reportError(`Not added — ${(err as Error).message}`)
    } finally {
      adding = false
    }
  }

  addB.addEventListener('click', submit)
  cancelB.addEventListener('click', close)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() }
  })
  ta.focus()
}

// `prefill` lets a drag-promote (manual card → Issue lane) reuse this
// composer with the card's content pre-loaded. The user just needs to
// type the title; if the card already had a repo linked, it's
// pre-selected too. On successful submit, the source manual card is
// deleted so the conversion is final. If the user cancels, the card
// stays put.
interface IssueComposerPrefill {
  body?: string
  repo?: string | null
  sourceCardId?: number
  editing?: { number: number, title: string, body: string }
}

async function openIssueEdit(item: LiveItem, button: HTMLButtonElement): Promise<void> {
  button.disabled = true
  button.setAttribute('aria-busy', 'true')
  try {
    const response = await fetch('/api/gh', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'read_issue', repository_full_name: item.repo, issue_number: item.number }) })
    const data = await response.json() as { error?: string, issue?: { number?: number, title?: string, body?: string } }
    if (!response.ok) throw new Error(data.error || 'Could not load the issue')
    const issue = data.issue
    if (!issue || issue.number !== item.number || typeof issue.title !== 'string' || typeof issue.body !== 'string') {
      throw new Error('GitHub did not return the issue title and body')
    }
    openIssueComposer({ repo: item.repo, body: issue.body, editing: { number: item.number, title: issue.title, body: issue.body } })
  } catch (error) {
    viewFeedback(`current-edit:${prKey(item)}`, 'Current action needs attention', (error as Error).message, 'action_needed')
  } finally {
    button.disabled = false
    button.removeAttribute('aria-busy')
  }
}

function openIssueComposer(prefill?: IssueComposerPrefill) {
  const editing = prefill?.editing
  const resultLabel = editing ? 'Issue saved' : 'Issue created'
  const waitMessage = editing ? 'Still saving the issue — wait for it to finish.' : 'Still opening the issue — wait for it to finish.'
  const reportError = (message: string) => viewFeedback(editing ? `current-edit:${prefill?.repo}#${editing.number}` : 'current-create:issue', 'Current action needs attention', message, 'action_needed')
  const reportResult = (message: string) => editing ? viewFeedback('current-edited', 'Current item saved', message, 'action_finished') : showLoadError(message)
  const laneNode = laneEl('issue')
  const existing = laneNode.querySelector('.composer')
  if (existing) {
    if (editing) {
      reportError('Close the current issue composer before editing another issue.')
      existing.querySelector<HTMLInputElement>('input')?.focus()
      return
    }
    if (!prefill || existing.querySelector<HTMLButtonElement>('.composer-add')?.disabled) {
      // A pending write keeps its composer, including during drag promotion.
      if (prefill) reportError('Still opening the issue — wait for it to finish.')
      ;(existing.querySelector('input') as HTMLInputElement | null)?.focus()
      return
    }
    // Drop with new prefill: replace what's there so the dropped card
    // wins. Whatever the user had typed in the existing composer is
    // discarded — that's the price of doing two things at once.
    existing.remove()
  }
  const addBtn = laneNode.querySelector<HTMLButtonElement>('.lane-add')!
  addBtn.hidden = true

  // Show full names in the dropdown and submit owner/name as the
  // value so the API call doesn't have to reassemble it. Sources from
  // /api/repos (every org repo); falls back to the involvement set only
  // if that hasn't loaded yet. If the dropped card carries a repo, we
  // pre-select it; the user can still change it before submitting.
  const repos = allRepos.length > 0 ? allRepos : distinctRepos()
  const wantRepo = prefill?.repo || ''
  const repoOptions = repositoryOptionsHtml(repos, wantRepo)
    || '<option value="">(no repos available)</option>'

  const composer = document.createElement('div')
  composer.className = `composer composer-issue${editing ? ' composer-issue-edit' : ''}`
  composer.innerHTML = `
    ${editing ? `<div class="st-help">Edit ${escapeHtml(prefill?.repo || '')}#${editing.number}</div>` : ''}
    <input type="text" class="issue-title" aria-label="Issue title" placeholder="Issue title" autocomplete="off" spellcheck="true" />
    <textarea class="issue-body" aria-label="Issue body" rows="3" placeholder="Body (optional)" spellcheck="true"></textarea>
    <select class="issue-repo" aria-label="${editing ? 'Repository' : 'Repository for the new issue'}"${editing ? ' disabled' : ''}>${repoOptions}</select>
    <div class="composer-row">
      <button class="composer-add">${editing ? 'Save issue' : 'Open issue'}</button>
      <button class="composer-cancel" type="button">Cancel</button>
      <button class="composer-labels" type="button" aria-label="Labels" aria-expanded="false" aria-haspopup="dialog" title="Labels"${editing ? ' hidden' : ''}>${TAG_ICON_SVG}<span class="composer-labels-count" hidden></span></button>
    </div>
    <div class="composer-labels-pop" role="dialog" aria-label="Issue labels" hidden>
      <input type="search" class="composer-labels-filter" placeholder="Filter labels…" aria-label="Filter labels" autocomplete="off" />
      <div class="composer-labels-list" role="group" aria-label="Labels"></div>
      <div class="composer-labels-foot"></div>
    </div>
  `
  laneNode.insertBefore(composer, addBtn)
  disclosure(composer, true, undefined, 0)
  const titleInput = composer.querySelector<HTMLInputElement>('.issue-title')!
  const bodyTa = composer.querySelector<HTMLTextAreaElement>('.issue-body')!
  const repoSel = composer.querySelector<HTMLSelectElement>('.issue-repo')!
  const addB = composer.querySelector<HTMLButtonElement>('.composer-add')!
  const cancelB = composer.querySelector<HTMLButtonElement>('.composer-cancel')!
  const labelsBtn = composer.querySelector<HTMLButtonElement>('.composer-labels')!
  const labelsCount = composer.querySelector<HTMLElement>('.composer-labels-count')!
  const labelsPop = composer.querySelector<HTMLElement>('.composer-labels-pop')!
  const labelsFilter = composer.querySelector<HTMLInputElement>('.composer-labels-filter')!
  const labelsList = composer.querySelector<HTMLElement>('.composer-labels-list')!
  const labelsFoot = composer.querySelector<HTMLElement>('.composer-labels-foot')!

  // Label picker state. Selections belong to one repo's catalogue: switching
  // repos clears them, since names from repo A must never ride along into B.
  let selectedLabels: string[] = []
  let labelCatalogue: RepoLabel[] | null = null
  let labelCatalogueRepo = ''
  let labelCatalogueError: string | null = null
  let labelLoading = false
  let labelGen = 0
  const paintLabelsCount = () => {
    labelsCount.hidden = selectedLabels.length === 0
    labelsCount.textContent = selectedLabels.length ? String(selectedLabels.length) : ''
    labelsBtn.setAttribute('aria-label', selectedLabels.length ? `Labels, ${selectedLabels.length} selected` : 'Labels')
  }
  const paintLabelsList = () => {
    const query = labelsFilter.value.trim().toLowerCase()
    if (labelLoading) {
      labelsList.innerHTML = '<div class="composer-labels-empty">Loading labels…</div>'
      return
    }
    if (labelCatalogueError) {
      labelsList.innerHTML = `<div class="composer-labels-empty">${escapeHtml(labelCatalogueError)}</div>`
      return
    }
    if (!labelCatalogue) {
      labelsList.innerHTML = '<div class="composer-labels-empty">Pick a repository first.</div>'
      return
    }
    const rows = labelCatalogue.filter((label) => !query || label.name.toLowerCase().includes(query))
    if (!rows.length) {
      labelsList.innerHTML = `<div class="composer-labels-empty">${labelCatalogue.length ? 'No labels match.' : 'This repository has no labels.'}</div>`
      return
    }
    labelsList.innerHTML = rows.map((label) => {
      const checked = selectedLabels.includes(label.name)
      const dot = /^[0-9a-fA-F]{6}$/.test(label.color) ? ` style="--dot: #${label.color}"` : ''
      const hint = label.description ? ` title="${escapeHtml(label.description)}"` : ''
      return `<label class="composer-label-row"${hint}><input type="checkbox" value="${escapeHtml(label.name)}"${checked ? ' checked' : ''} /><span class="composer-label-dot"${dot}></span><span class="composer-label-name">${escapeHtml(label.name)}</span></label>`
    }).join('')
  }
  const paintLabelsFoot = (note: string | null) => {
    const base = selectedLabels.length ? `${selectedLabels.length} selected` : ''
    labelsFoot.textContent = [base, note].filter(Boolean).join(' · ')
  }
  const closeLabelsPop = (focusButton: boolean) => {
    if (labelsPop.hidden) return
    labelsPop.hidden = true
    labelsBtn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', outsideLabels, true)
    if (focusButton && labelsPop.contains(document.activeElement)) labelsBtn.focus()
  }
  const openLabelsPop = () => {
    labelsPop.hidden = false
    labelsBtn.setAttribute('aria-expanded', 'true')
    document.addEventListener('pointerdown', outsideLabels, true)
    // The repo list may have landed after the composer opened, selecting a
    // repo no catalogue was ever read for.
    if (repoSel.value && labelCatalogueRepo !== repoSel.value && !labelLoading) ensureLabels(repoSel.value)
    paintLabelsList()
    labelsFilter.focus()
  }
  function outsideLabels(event: PointerEvent): void {
    if (labelsPop.hidden || labelsPop.contains(event.target as Node) || labelsBtn.contains(event.target as Node)) return
    closeLabelsPop(false)
  }
  const loadLabels = async (repo: string, generation: number): Promise<void> => {
    labelLoading = true
    labelCatalogueError = null
    if (!labelsPop.hidden) paintLabelsList()
    try {
      const res = await fetch('/api/gh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'list_repo_labels', repository_full_name: repo }),
      })
      if (generation !== labelGen || !composer.isConnected) return
      if (!res.ok) throw new Error(`Github ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`)
      const data = await res.json()
      if (!Array.isArray(data?.labels)) throw new Error('unexpected label catalogue shape')
      labelCatalogue = (data.labels as RepoLabel[]).filter((label) => typeof label?.name === 'string')
      labelCatalogueRepo = repo
      repoLabelCache.set(repo, { labels: labelCatalogue, at: Date.now() })
    } catch (err) {
      if (generation !== labelGen || !composer.isConnected) return
      // A failed catalogue must read as failed, not as "no labels", and it
      // must not block a label-less issue: the create path stays open.
      labelCatalogue = null
      labelCatalogueError = `Could not load labels — ${(err as Error).message}`
    } finally {
      if (generation === labelGen && composer.isConnected) {
        labelLoading = false
        if (!labelsPop.hidden) { paintLabelsList(); paintLabelsFoot(null) }
      }
    }
  }
  const ensureLabels = (repo: string): void => {
    if (!repo) { labelCatalogue = null; labelCatalogueRepo = ''; return }
    const cached = repoLabelCache.get(repo)
    if (cached && Date.now() - cached.at < LABEL_CACHE_TTL_MS) {
      labelCatalogue = cached.labels
      labelCatalogueRepo = repo
      labelCatalogueError = null
      return
    }
    labelGen++
    void loadLabels(repo, labelGen)
  }
  labelsBtn.addEventListener('click', () => {
    if (labelsPop.hidden) openLabelsPop()
    else closeLabelsPop(true)
  })
  labelsFilter.addEventListener('input', paintLabelsList)
  labelsFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLabelsPop(true) }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() }
  })
  labelsList.addEventListener('change', (event) => {
    const box = event.target
    if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') return
    if (box.checked) {
      if (!selectedLabels.includes(box.value)) selectedLabels.push(box.value)
    } else selectedLabels = selectedLabels.filter(name => name !== box.value)
    paintLabelsCount()
    paintLabelsFoot(null)
  })
  repoSel.addEventListener('change', () => {
    // A late catalogue for the previous repo must neither populate this one
    // nor carry its selections over.
    labelGen++
    labelLoading = false
    labelCatalogueError = null
    labelsFilter.value = ''
    if (selectedLabels.length) {
      paintLabelsFoot(`Cleared ${selectedLabels.length} label${selectedLabels.length === 1 ? '' : 's'} from the previous repository.`)
      selectedLabels = []
      paintLabelsCount()
    }
    labelCatalogue = null
    ensureLabels(repoSel.value)
    if (!labelsPop.hidden) paintLabelsList()
  })
  if (!editing) ensureLabels(repoSel.value)

  // The list was a one-shot snapshot taken when the composer opened. If
  // /api/repos had not answered yet it silently degraded to the repos inside
  // the current time window — so the one you wanted could be missing and you
  // picked a neighbour, or the list was empty and every submit answered "Repo
  // is required" with no way out but closing the composer and losing the text.
  // Fill it in when the real list lands.
  if (allRepos.length === 0) {
    void fetchAllRepos().catch((error: unknown) => {
      if (composer.isConnected) showError(`Could not load repositories — ${(error as Error).message}`)
    })
  }

  // A promoted card provides its body; an existing issue also restores its title.
  if (prefill?.body) bodyTa.value = prefill.body
  if (editing) titleInput.value = editing.title

  // Cancel is refused while the write is in flight. Removing the composer did
  // not cancel anything: the issue was still created and, on a promoted card,
  // the source card still deleted — the person just never saw either happen.
  const close = () => {
    if (submitting) { showError(waitMessage); return }
    closeLabelsPop(false)
    retire(composer)
    addBtn.hidden = false
  }
  const showError = (msg: string) => {
    reportError(msg)
  }
  // Disabling the button is not a guard: ⌘↵ calls submit() directly and never
  // looks at it. The gh call can take the best part of a minute, so a repeated
  // or held ⌘↵ opened a second and third identical issue on GitHub — the one
  // action in this view that leaves the machine and cannot be taken back.
  let submitting = false
  const submit = async () => {
    if (submitting) return
    const title = titleInput.value.trim()
    const body = editing ? bodyTa.value : bodyTa.value.trim()
    const repo = repoSel.value             // already the full owner/name
    if (!title) { showError('Title is required'); titleInput.focus(); return }
    if (!repo)  { showError('Repo is required'); return }

    submitting = true
    addB.disabled = true
    reportError('')
    let confirmed: LiveItem | undefined
    let labelsDropped: string[] = []
    try {
      const ghRes = await fetch('/api/gh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: editing ? 'edit_issue' : 'open_issue',
          repository_full_name: repo,
          title,
          body,
          ...(editing ? { issue_number: editing.number, expected_title: editing.title, expected_body: editing.body }
            : selectedLabels.length ? { labels: selectedLabels } : {}),
        }),
      })
      if (!ghRes.ok) {
        const text = await ghRes.text().catch(() => '')
        if (editing) {
          let message = text
          try { message = (JSON.parse(text) as { error?: string }).error || text }
          catch { message = text.slice(0, 400) }
          throw new Error(message || 'GitHub did not confirm the issue change')
        }
        throw new Error(`Github ${ghRes.status}: ${text.slice(0, 160)}`)
      }
      // Keep the confirmed GitHub record visible until the polling consumer
      // has observed this create or edit.
      try {
        const result = await ghRes.json()
        if (Array.isArray(result?.labels_dropped)) labelsDropped = result.labels_dropped.filter((name: unknown) => typeof name === 'string')
        const r = result?.record
        if (editing && (!r || r.kind !== 'issue' || r.repo !== repo || r.number !== editing.number || r.title !== title)) {
          throw new Error('GitHub did not confirm the edited issue; your draft is retained')
        }
        if (r && r.kind === 'issue' && r.number) {
          pendingLiveItems = pendingLiveItems.filter((p) => !(p.repo === r.repo && p.number === r.number))
          confirmed = {
            repo: String(r.repo),
            number: Number(r.number),
            title: String(r.title),
            url: String(r.url),
            is_pr: 0,
            state: (r.state as 'open' | 'closed' | 'merged') || 'open',
            created_at: String(r.created_at),
            merged_at: r.merged_at ? String(r.merged_at) : null,
            updated_at: String(r.updated_at),
          }
          pendingLiveItems.unshift(confirmed)
        }
      } catch (error) {
        if (editing) throw error
        // Older create responses may need the following datastore refresh.
      }
      // Drag-promote: the source manual card is deleted only after the
      // issue is confirmed created. If we got here, the POST returned
      // 200 — safe to remove. We swallow delete errors so a later DB
      // hiccup doesn't undo the promotion the user just confirmed.
      if (prefill?.sourceCardId !== undefined) {
        try { await deleteManualCard(prefill.sourceCardId) }
        catch (err) { console.error('[promote] delete source card failed:', err) }
      }
    } catch (err) {
      addB.disabled = false
      addB.textContent = editing ? 'Save issue' : 'Open issue'
      showError((err as Error).message)
      return
    } finally {
      submitting = false
    }
    // The guard is released; close removes live controls before the next await.
    reportError('')
    close()
    if (confirmed && withinActiveWindow(confirmed)) {
      const item = confirmed
      liveItems = [item, ...liveItems.filter(existing => prKey(existing) !== prKey(item))]
    }
    // Show the confirmed record even while its follow-up read is pending.
    renderLiveOnly()
    try { await fetchLive() }
    catch (err) { reportResult(`${resultLabel} — could not refresh: ${(err as Error).message}`); return }
    renderLiveOnly()
    if (confirmed && !withinActiveWindow(confirmed)) {
      reportResult(`${resultLabel} — the current filter is hiding it.`)
      window.setTimeout(() => viewFeedback(editing ? 'current-edited' : 'current-created', editing ? 'Current item saved' : 'Current item created', ''), 6000)
    }
    // GitHub answers 201 and silently drops labels the account may not
    // apply. The issue exists; say plainly which labels did not make it.
    if (labelsDropped.length) {
      const names = labelsDropped.slice(0, 5).join(', ') + (labelsDropped.length > 5 ? ', …' : '')
      reportResult(`${resultLabel} — GitHub did not apply these labels (the account may lack permission): ${names}.`)
    }
  }

  addB.addEventListener('click', submit)
  cancelB.addEventListener('click', close)
  for (const inp of [titleInput, bodyTa] as HTMLElement[]) {
    inp.addEventListener('keydown', (e) => {
      // Escape while the write is out would abandon a request that is still
      // going to create the issue — and delete the promoted card with it.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (submitting) { showError(waitMessage); return }
        close()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() }
    })
  }
  titleInput.focus()
}

// ── Edit / delete (manual lanes only) ────────────────────────────────────────

function startEdit(cardEl: HTMLElement, draft?: EditDraft) {
  if (cardEl.classList.contains('editing')) return
  if (cardEl.classList.contains('card-live')) return  // live cards are read-only
  const id = Number(cardEl.dataset.id)
  const card = manualCards.find((c) => c.id === id)
  if (!card) return
  cardEl.classList.add('editing')
  cardEl.draggable = false

  const originalText = card.text
  const originalRepo = card.repo ?? null
  const wrapper = document.createElement('div')
  wrapper.className = 'card-edit'
  wrapper.innerHTML = `
    <textarea rows="3" spellcheck="true"></textarea>
    <select class="manual-repo" aria-label="Link a repository">${manualRepoOptionsHtml(draft ? draft.repo : originalRepo)}</select>
    <div class="composer-row">
      <button class="composer-add">Save</button>
      <button class="composer-cancel" type="button">Cancel</button>
    </div>
  `
  const ta = wrapper.querySelector<HTMLTextAreaElement>('textarea')!
  const repoSel = wrapper.querySelector<HTMLSelectElement>('.manual-repo')!
  const reportError = (message: string) => viewFeedback(`current-edit:${id}`, 'Current action needs attention', message, 'action_needed')
  // A restored draft is text the person typed that was never stored; it wins
  // over the saved value.
  ta.value = draft ? draft.text : originalText

  const textNode = cardEl.querySelector<HTMLElement>('.card-text')!
  const metaNode = cardEl.querySelector<HTMLElement>('.card-meta')
  const deleteBtn = cardEl.querySelector<HTMLButtonElement>('.card-delete')!
  textNode.hidden = true
  if (metaNode) metaNode.hidden = true
  if (deleteBtn) deleteBtn.hidden = true
  cardEl.appendChild(wrapper)
  disclosure(wrapper, true, undefined, 0)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)

  const close = () => {
    cardEl.classList.remove('editing')
    cardEl.draggable = true
    retire(wrapper)
    textNode.hidden = false
    if (metaNode) metaNode.hidden = false
    if (deleteBtn) deleteBtn.hidden = false
  }
  let saving = false
  const save = async () => {
    if (saving) return
    const text = ta.value.trim()
    const repo = repoSel.value || null
    if (!text) { close(); return }
    if (text === originalText && repo === originalRepo) { close(); return }
    saving = true
    reportError('')
    try {
      const patch: Record<string, unknown> = {}
      if (text !== originalText) patch.text = text
      // The repo dropdown can be missing the card's current repo — it is built
      // from a list that depends on the org fetch and the active time window.
      // Sending the empty value it falls back to silently unlinked the repo,
      // including when Save was pressed with nothing changed. Only write the
      // repo when the dropdown actually offered the current one.
      const repoOffered = [...repoSel.options].some((o) => (o.value || null) === originalRepo)
      if (repoOffered && repo !== originalRepo) patch.repo = repo
      if (Object.keys(patch).length === 0) { close(); return }
      const updated = await api<ManualCard>('PATCH', `/api/current/${id}`, patch)
      const idx = manualCards.findIndex((c) => c.id === id)
      if (idx >= 0) manualCards[idx] = updated
      openEditDraft = null
      renderAll()
    } catch (err) {
      // Closing here threw the rewritten text away and reverted the card, with
      // the reason going only to the console. The editor stays open, holding
      // the only copy, and says what went wrong.
      reportError(`Not saved — ${(err as Error).message}`)
      ta.focus()
    } finally {
      saving = false
    }
  }

  wrapper.querySelector<HTMLButtonElement>('.composer-add')!.addEventListener('click', save)
  wrapper.querySelector<HTMLButtonElement>('.composer-cancel')!.addEventListener('click', close)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save() }
  })
}

async function deleteManualCard(id: number) {
  const lane = manualCards.find((c) => c.id === id)?.lane
  await api('DELETE', `/api/current/${id}`)
  manualCards = manualCards.filter((c) => c.id !== id)
  renderAll()
  // The focused card just stopped existing, so focus fell to <body> and a
  // keyboard user had to tab in from the top of the page again. Land on the
  // next card in the same lane, or that lane's add button.
  if (!lane) return
  const laneNode = viewEl?.querySelector<HTMLElement>(`.lane[data-lane="${lane}"]`)
  const next = laneNode?.querySelector<HTMLElement>('.card-manual')
    ?? laneNode?.querySelector<HTMLElement>('.lane-add')
  next?.focus()
}

// ── Drag and drop (manual lanes only) ────────────────────────────────────────

let dropIndicator: HTMLElement | null = null

function ensureIndicator(): HTMLElement {
  if (!dropIndicator) {
    dropIndicator = document.createElement('div')
    dropIndicator.className = 'drop-indicator'
  }
  return dropIndicator
}

function clearIndicator() {
  if (dropIndicator) dropIndicator.remove()
}

// `excludeId` is passed explicitly rather than read from `dragId`: the drop
// handler clears dragId as soon as it starts (so a stale value cannot outlive
// the drag), and reading it here after that counted the dragged card itself
// and put the insertion one slot too low.
function insertionIndex(list: HTMLElement, clientY: number, excludeId: number | null = dragId): number {
  const cardsInList = [...list.querySelectorAll<HTMLElement>('.card:not(.card-live)')]
    .filter((c) => Number(c.dataset.id) !== excludeId)
  for (let i = 0; i < cardsInList.length; i++) {
    const rect = cardsInList[i].getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return i
  }
  return cardsInList.length
}

// The lane in the DOM is only the cards that pass the search box, but a
// position is an index into the whole lane — and both the optimistic splice
// here and moveCard on the server treated the visible slot as if it were the
// absolute one. Dropping between two visible cards then reordered whatever was
// hidden between them: the drop looked like it did nothing while a card the
// person could not see moved. Anchor the drop to the visible card it lands
// above and translate that into the full lane's index.
function absoluteInsertIndex(
  targetLane: 'idea' | 'concept' | 'plan',
  list: HTMLElement,
  clientY: number,
  movingId: number,
): number {
  const full = manualCards
    .filter((c) => c.lane === targetLane && c.id !== movingId)
    .sort((a, b) => a.position - b.position)
  const visibleIds = [...list.querySelectorAll<HTMLElement>('.card:not(.card-live)')]
    .map((c) => Number(c.dataset.id))
    .filter((cardId) => cardId !== movingId)
  const slot = insertionIndex(list, clientY, movingId)
  // Landing above a visible card means "immediately before that card".
  if (slot < visibleIds.length) {
    const anchor = full.findIndex((c) => c.id === visibleIds[slot])
    return anchor >= 0 ? anchor : full.length
  }
  // Past the last visible card means "after it", not "at the end of the lane".
  const last = visibleIds[visibleIds.length - 1]
  if (last === undefined) return full.length
  const lastIdx = full.findIndex((c) => c.id === last)
  return lastIdx >= 0 ? lastIdx + 1 : full.length
}

function placeIndicator(list: HTMLElement, index: number) {
  const indicator = ensureIndicator()
  const cardsInList = [...list.querySelectorAll<HTMLElement>('.card:not(.card-live)')]
    .filter((c) => Number(c.dataset.id) !== dragId)
  if (index >= cardsInList.length) {
    list.appendChild(indicator)
  } else {
    list.insertBefore(indicator, cardsInList[index])
  }
}

function attachDragHandlers() {
  const kanban = viewEl.querySelector<HTMLElement>('.kanban')!

  kanban.addEventListener('dragstart', (e) => {
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card')
    if (!cardEl || cardEl.classList.contains('editing') || cardEl.classList.contains('card-live')) {
      e.preventDefault()
      return
    }
    dragId = Number(cardEl.dataset.id)
    cardEl.classList.add('dragging')
    e.dataTransfer?.setData('text/plain', String(dragId))
    // 'copyMove' so both kinds of drop targets are valid:
    //  * Manual lanes set dropEffect='move' (reorder).
    //  * Issue lane sets dropEffect='copy' (convert to a GH issue).
    // If effectAllowed doesn't cover the lane's dropEffect, Chrome
    // silently refuses the drop — that's the bug that broke
    // drag-to-issue on real drags.
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'
  })

  kanban.addEventListener('dragend', (e) => {
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card')
    cardEl?.classList.remove('dragging')
    dragId = null
    clearIndicator()
    viewEl.querySelectorAll('.lane.lane-drag-over').forEach((l) => l.classList.remove('lane-drag-over'))
  })

  // Drop targets are only the manual lanes — live lanes don't accept drops
  for (const l of LANES) {
    if (l.type !== 'manual') continue
    const lane = laneEl(l.key)
    const list = laneListEl(l.key)

    lane.addEventListener('dragover', (e) => {
      if (dragId === null) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      const idx = insertionIndex(list, e.clientY)
      placeIndicator(list, idx)
      lane.classList.add('lane-drag-over')
    })

    lane.addEventListener('dragleave', (e) => {
      const related = e.relatedTarget as Node | null
      if (related && lane.contains(related)) return
      clearIndicator()
      lane.classList.remove('lane-drag-over')
    })

    lane.addEventListener('drop', async (e) => {
      e.preventDefault()
      lane.classList.remove('lane-drag-over')
      if (dragId === null) return
      const movingId = dragId
      // renderAll() below detaches the drag source, so the delegated dragend
      // on .kanban never fires and dragId stayed set for the rest of the
      // session — after which a drag from another application over a manual
      // lane was accepted as a card drag and moved this card again.
      dragId = null
      const targetLane = l.key as 'idea' | 'concept' | 'plan'
      const idx = absoluteInsertIndex(targetLane, list, e.clientY, movingId)
      clearIndicator()

      const moving = manualCards.find((c) => c.id === movingId)
      if (!moving) return
      const sourceLane = moving.lane
      const sameLane = sourceLane === targetLane

      const targets = manualCards.filter((c) => c.lane === targetLane && c.id !== movingId)
        .sort((a, b) => a.position - b.position)
      targets.splice(Math.min(idx, targets.length), 0, moving)
      targets.forEach((c, i) => { c.position = i; c.lane = targetLane })

      if (!sameLane) {
        const sources = manualCards.filter((c) => c.lane === sourceLane && c.id !== movingId)
          .sort((a, b) => a.position - b.position)
        sources.forEach((c, i) => { c.position = i })
      }
      renderAll()

      try {
        await api('PATCH', `/api/current/${movingId}`, { lane: targetLane, position: idx, ...organizationPayload() })
      } catch (err) {
        console.error('move failed:', err)
        try { await fetchManual(); renderAll() } catch { /* ignore */ }
      }
    })
  }

  // Issue lane is a special drop target: dragging a manual card here
  // doesn't reorder anything — it converts the card into a draft
  // GitHub issue. The drop opens the issue composer pre-populated
  // with the card's text (as the body) and repo (if linked), focuses
  // the title field, and only deletes the source card after the
  // issue is successfully created on GitHub. No insertion indicator,
  // no position math.
  //
  // The dragover handler MUST call preventDefault unconditionally —
  // gating it on dragId fails subtly when HMR replaces the module
  // (the OLD module's dragstart sets its own dragId, the NEW module's
  // dragover reads its own — different cell). Without preventDefault
  // on dragover the browser doesn't treat the lane as a drop target
  // and never fires `drop`. The drop handler is the right place to
  // sanity-check that we have a manual card to convert; if not, it
  // just no-ops.
  const issueLane = laneEl('issue')
  issueLane.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'   // semantic hint: this is "convert", not "move"
    issueLane.classList.add('lane-drag-over')
  })
  issueLane.addEventListener('dragleave', (e) => {
    const related = e.relatedTarget as Node | null
    if (related && issueLane.contains(related)) return
    issueLane.classList.remove('lane-drag-over')
  })
  issueLane.addEventListener('drop', (e) => {
    e.preventDefault()
    issueLane.classList.remove('lane-drag-over')
    // The card id rides on dataTransfer (set by the kanban dragstart
    // handler) so we can recover it even if the module-level dragId
    // got separated by HMR.
    const idStr = e.dataTransfer?.getData('text/plain') || ''
    const id = Number(idStr) || dragId
    if (!id) return
    const moving = manualCards.find((c) => c.id === id)
    if (!moving) return
    openIssueComposer({
      body: moving.text,
      repo: moving.repo,
      sourceCardId: moving.id,
    })
  })
}

// ── Card-level click delegation ──────────────────────────────────────────────

function attachCardClickHandlers() {
  const kanban = viewEl.querySelector<HTMLElement>('.kanban')!
  // Enter on a focused manual card opens its editor — the keyboard equivalent
  // of the click that was previously the only way in.
  kanban.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card-manual')
    if (!cardEl || cardEl !== e.target) return
    if (cardEl.classList.contains('editing')) return
    e.preventDefault()
    startEdit(cardEl)
  })
  kanban.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement

    // Top-right action strip — both chat and copy live here. We match
    // each in turn before the per-card-type primary action below
    // (review/delete) so a click on a tool icon is never ambiguous
    // with the card-link navigation.

    // Copy icon — copies the card's content to the clipboard and
    // briefly swaps the icon for a checkmark as visual feedback.
    const copyBtn = target.closest<HTMLButtonElement>('.card-copy-btn')
    if (copyBtn) {
      e.preventDefault()
      e.stopPropagation()
      const text = copyBtn.dataset.clip || ''
      if (!text) return
      void copyTextWithFeedback(copyBtn, text)
      return
    }

    // Chat icon — opens (or toggles) the card's Chat session in the side
    // pane. Sibling of card-link / card-text so it doesn't propagate
    // into navigation or edit. The prefill is the card's text, unsent.
    const chatBtn = target.closest<HTMLButtonElement>('.card-chat-btn')
    if (chatBtn) {
      e.preventDefault()
      e.stopPropagation()
      const session = chatBtn.dataset.session || ''
      const label = chatBtn.dataset.label || ''
      const draft = chatBtn.dataset.draft || ''
      if (!session) return
      chatSidePane.toggle({ subject: cardSubject(session, label), prefill: draft || undefined })
      return
    }

    const editIssue = target.closest<HTMLButtonElement>('.card-issue-edit')
    if (editIssue) {
      e.preventDefault()
      e.stopPropagation()
      const key = editIssue.closest<HTMLElement>('.card')?.dataset.id
      const item = liveItems.find(candidate => prKey(candidate) === key && candidate.is_pr === 0)
      if (item && !editIssue.disabled) void openIssueEdit(item, editIssue)
      return
    }

    // Chat session icon — opens the card's Chat session in the Chat view,
    // or its composer with the card's prefill when it has no session yet.
    const chatSessionBtn = target.closest<HTMLButtonElement>('.card-chat-session-btn')
    if (chatSessionBtn) {
      e.preventDefault()
      e.stopPropagation()
      const cardEl = chatSessionBtn.closest<HTMLElement>('.card')!
      const item = liveItems.find((i) => prKey(i) === (cardEl.dataset.id || ''))
      if (!item) return
      window.dispatchEvent(new CustomEvent('poise:open-chat-session', {
        detail: {
          subject: cardSubject(liveSessionId(item), `${item.repo}#${item.number}`, item.url),
          prefill: `${item.title}\n${item.url}`,
        },
      }))
      return
    }

    // PR review icon — fires off agent-interface --pr-review for the PR
    // and shows a brief running/done indicator. Stop propagation so the
    // card link doesn't navigate to GitHub at the same time.
    const reviewBtn = target.closest<HTMLButtonElement>('.card-review-btn')
    if (reviewBtn) {
      e.preventDefault()
      e.stopPropagation()
      if (reviewBtn.disabled) return
      const cardEl = reviewBtn.closest<HTMLElement>('.card')!
      const id = cardEl.dataset.id || ''
      const item = liveItems.find((i) => prKey(i) === id)
      if (!item) return
      reviewBtn.disabled = true
      reviewBtn.classList.add('running')
      reviewBtn.innerHTML = PR_REVIEW_SPIN_SVG
      try {
        const res = await fetch('/api/pr-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: item.url }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text ? `${res.status}: ${text.slice(0, 200)}` : `HTTP ${res.status}`)
        }
        viewFeedback(`current-review:${item.url}`, 'Current action needs attention', '')
        reviewBtn.classList.remove('running')
        reviewBtn.classList.add('done')
        reviewBtn.innerHTML = PR_REVIEW_PLAY_SVG
        // The breathing accent is driven entirely by /api/agent-logs
        // — it captures every running job, not just card-initiated
        // ones. Just nudge a re-poll after agent-interface has had a
        // moment to spawn its Python and write the running row, so
        // the user sees feedback in ~1.5s instead of waiting for the
        // next shared tick boundary.
        window.setTimeout(async () => {
          await fetchAgentActive()
          applyActiveClasses()
        }, 1500)
        // Brief done state, then reset so the user can re-trigger
        window.setTimeout(() => {
          reviewBtn.classList.remove('done')
          reviewBtn.disabled = false
        }, 2500)
      } catch (err) {
        reviewBtn.classList.remove('running')
        reviewBtn.disabled = false
        reviewBtn.innerHTML = PR_REVIEW_PLAY_SVG
        console.error('PR review trigger failed:', err)
        viewFeedback(`current-review:${item.url}`, 'Current action needs attention', `Could not start review: ${(err as Error).message}`)
      }
      return
    }

    const delBtn = target.closest<HTMLElement>('.card-delete')
    if (delBtn) {
      e.stopPropagation()
      const cardEl = delBtn.closest<HTMLElement>('.card')!
      const id = Number(cardEl.dataset.id)
      // A card holds prose the person wrote and there is no undo, no trash and
      // no history — the delete was one unconfirmed click on a 22px × next to
      // the card body. Ask, and show what is about to go.
      const card = manualCards.find((c) => c.id === id)
      const preview = (card?.text || '').trim().replace(/\s+/g, ' ').slice(0, 80)
      if (!window.confirm(preview ? `Delete this card?\n\n${preview}${preview.length === 80 ? '…' : ''}` : 'Delete this card?')) return
      try { await deleteManualCard(id); viewFeedback(`current-delete:${id}`, 'Current action needs attention', '') }
      catch (err) { viewFeedback(`current-delete:${id}`, 'Current action needs attention', `Could not delete the card: ${(err as Error).message}`) }
      return
    }
    const cardEl = target.closest<HTMLElement>('.card')
    if (!cardEl) return
    if (cardEl.classList.contains('card-live')) return     // links handle navigation
    if (cardEl.classList.contains('editing')) return
    if (target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA') return
    startEdit(cardEl)
  })
}

// ── Filters ─────────────────────────────────────────────────────────────────

function attachFilterHandlers() {
  const timePicker = viewEl.querySelector<HTMLElement>('#current-time-picker')!
  timePicker.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !btn.dataset.time) return
    const next = btn.dataset.time as TimeFilter
    if (next === timeFilter) return
    timeFilter = next
    timePicker.querySelectorAll<HTMLButtonElement>('[data-time]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    saveFilters()
    try { await fetchLive(); renderLiveOnly() } catch (err) { console.error(err) }
  })

  const statusBar = viewEl.querySelector<HTMLElement>('#current-status-filter')!
  statusBar.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button')
    if (!btn || !btn.dataset.status) return
    const next = btn.dataset.status as StatusFilter
    if (next === statusFilter) return
    statusFilter = next
    statusBar.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    saveFilters()
    try { await fetchLive(); renderLiveOnly() } catch (err) { console.error(err) }
  })

  // Search — pure client-side filter over what's already loaded. Debounced
  // so typing doesn't thrash the renderer. Re-renders BOTH manual and live
  // lanes since search applies across the whole board.
  const searchEl = viewEl.querySelector<HTMLInputElement>('#current-search')!
  searchEl.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      const next = searchEl.value.trim()
      if (next === searchQuery) return
      searchQuery = next
      renderAll()
    }, 90)
  })
}

// ── Init ────────────────────────────────────────────────────────────────────

export async function initCurrentView() {
  const org = getSelectedOrganization()
  const sequence = ++currentLoadSequence
  viewEl = document.getElementById('view-current')!
  if (!initialized) {
    initialized = true
    loadFilters()
    viewEl.innerHTML = renderShell()
    attachAddHandlers()
    attachDragHandlers()
    attachCardClickHandlers()
    attachFilterHandlers()
    mountOrganizationFilter(viewEl.querySelector<HTMLElement>('#current-filters')!)
    window.addEventListener('poise:organization-filter-changed', () => {
      liveSequence++
      manualCards = []
      liveItems = []
      allRepos = []
      agentActiveKeys.clear()
      prStatus.clear()
      liveLoadWarning = ''
      repoLoadWarning = ''
      renderAll()
      if (!viewEl.hidden) void initCurrentView()
    })
  }
  // Attach before the reads: a slow completion after leaving must never
  // reattach polling. Each source paints independently of the others.
  startLiveTimer()
  const current = () => sequence === currentLoadSequence && org === getSelectedOrganization()
  const failures = new Set<string>()
  const load = async (label: string, read: Promise<void>, paint: () => void) => {
    try {
      await read
      if (!current()) return
      paint()
    } catch {
      if (!current()) return
      failures.add(label)
    }
    showLoadError(failures.size
      ? `Could not load ${[...failures].join(', ')}. Showing what is available.`
      : liveLoadWarning || repoLoadWarning)
  }
  await Promise.all([
    load('your cards', fetchManual(sequence), () => renderAll('manual')),
    load('GitHub issues and pull requests', fetchLive(), () => {
      renderAll('live')
      void fetchPrStatus()
    }),
    load('the repository list', fetchAllRepos(sequence), () => {}),
    load('agent activity', fetchAgentActive(sequence), applyActiveClasses),
  ])
}

function startLiveTimer() {
  if (liveListening) return
  window.addEventListener('poise:refresh-tick', onLiveTick)
  liveListening = true
}
