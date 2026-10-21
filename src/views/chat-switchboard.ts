import type { SwitchboardItem, SwitchboardKind, SwitchboardState } from '../../server/chat/protocol'
import { AGENT_LABELS } from '../../server/chat/protocol'
import { chatClient } from '../chat-client'
import { effectiveTimezone } from '../config'
import { patchContent } from '../dom-patch'
import { escapeHtml } from '../markdown'
import { cancelMotion, spring } from '../motion'
import { CHAT_MIN_WIDTH } from './chat-sidebar'
import './chat-switchboard.css'

// The Switchboard pane (docs/Switchboard.md): a structured view of what every
// other chat is doing, with decisions answered by buttons. It is a renderer of
// the server's Switchboard state; nothing here talks to the Switchboard chat.

const WIDTH_KEY = 'poise-chat-switchboard-width'
const OPEN_KEY = 'poise-chat-switchboard-open'
const DEFAULT_FRACTION = 1 / 3
const SNAPS = [1 / 3, 1 / 2]
const SNAP_PX = 14
const MIN_WIDTH = 300
const QUIET_AFTER_MS = 45 * 60_000
const LINE_ITEMS = 5
/** An answer stays confirmed under Needs you this long. */
const ANSWERED_SHOWN_MS = 10 * 60_000

type LineState = SwitchboardKind | 'quiet'
const STATE_LABEL: Record<LineState, string> = { decision: 'Needs you', blocked: 'Blocked', progress: 'In progress', done: 'Done', quiet: 'Quiet' }
const RANK: Record<LineState, number> = { decision: 0, blocked: 1, progress: 2, done: 3, quiet: 4 }

const svg = (body: string, size = 14, width = 1.5) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
/** The sessions toggle's panel, mirrored, with three lamps. */
export const ICON_SWITCHBOARD = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M9 2.5v9" stroke="currentColor" stroke-width="1.2"/><circle cx="10.75" cy="5" r=".75" fill="currentColor"/><circle cx="10.75" cy="7" r=".75" fill="currentColor"/><circle cx="10.75" cy="9" r=".75" fill="currentColor"/></svg>'
const ICON_EXPLAIN = svg('<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12Z"/><path d="M9.8 9.6a2.3 2.3 0 1 1 3.1 2.1c-.6.3-.9.7-.9 1.3v.4M12 16.2h.01"/>', 13)
const ICON_OPEN = svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 13)
const ICON_CHECK = svg('<path d="M20 11.5a8 8 0 1 1-2.6-5.9M20 4.5v5h-5"/>', 15)
const ICON_PAUSE = svg('<path d="M9 5v14M15 5v14"/>', 15)
const ICON_RESUME = svg('<path d="M7 5l12 7-12 7z"/>', 15)
const ICON_TRANSCRIPT = svg('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>', 15)
const ICON_CLOSE = svg('<path d="M6 6l12 12M18 6 6 18"/>', 14)
const ICON_OFF = svg('<path d="M12 3v8M6.4 6.4a8 8 0 1 0 11.2 0"/>', 15)
const ICON_CHEV = svg('<path d="M6 9l6 6 6-6"/>', 14)
const ICON_DONE = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 13, 2)

function stored(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } }
function remember(key: string, value: string): void { try { localStorage.setItem(key, value) } catch { /* layout still works */ } }

function clock(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: effectiveTimezone() })
}
function age(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000)
  if (!(minutes >= 1)) return 'now'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / 1440)} d`
}

/** A response this build can render; anything else is reported, not guessed at. */
export function parseSwitchboardState(value: unknown): SwitchboardState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<SwitchboardState>
  if (!Number.isSafeInteger(state.revision) || !['off', 'live', 'paused', 'stopped'].includes(String(state.status)) || !Array.isArray(state.items)) return null
  return state as SwitchboardState
}

const openDecision = (item: SwitchboardItem) => item.kind === 'decision' && !item.answer && !item.resolved

/** A chat's line shows its latest report; an open question outranks
 *  everything but a blocker. */
export function lineState(items: SwitchboardItem[], now: number): LineState {
  const report = items.find(item => !openDecision(item))
  if (report?.kind === 'blocked') return 'blocked'
  if (items.some(openDecision)) return 'decision'
  if (!report) return 'quiet'
  if (report.kind === 'decision') return 'progress'
  if (report.kind === 'done' && now - Date.parse(report.createdAt) > QUIET_AFTER_MS) return 'quiet'
  return report.kind
}

export interface SwitchboardPane {
  el: HTMLElement
  /** The Switchboard chat, which the session list leaves out. */
  readonly sessionId: string | null
  readonly open: boolean
  /** Whether it floats over the chat rather than docking beside it. */
  readonly overlaid: boolean
  mount(): void
  hide(): void
  refresh(): Promise<void>
}

export function createSwitchboardPane(view: HTMLElement, toggle: HTMLButtonElement, deps: { openChat(id: string): void, onLayout(): void, onOpen(): void }): SwitchboardPane {
  const layoutEl = view.querySelector<HTMLElement>('.chat-layout')!
  const el = document.createElement('aside')
  el.id = 'chat-switchboard-pane'
  el.className = 'chat-switchboard-pane'
  el.setAttribute('aria-label', 'Switchboard')
  el.innerHTML = `<div class="sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize Switchboard" aria-controls="chat-switchboard-pane" tabindex="0" title="Drag to resize · double-click for one third"></div><div class="sb-inner"></div>`
  const handle = el.querySelector<HTMLElement>('.sb-resize')!
  const inner = el.querySelector<HTMLElement>('.sb-inner')!
  const badge = toggle.querySelector<HTMLElement>('.chat-switchboard-badge')!
  const guides = SNAPS.map(fraction => {
    const guide = document.createElement('div')
    guide.className = 'sb-guide'
    guide.innerHTML = `<span>${fraction === 1 / 3 ? '⅓' : '½'}</span>`
    return { fraction, el: guide }
  })
  const readout = document.createElement('div')
  readout.className = 'sb-readout'

  let state: SwitchboardState | null = null
  let failure: string | null = null
  let notice: string | null = null
  let open = stored(OPEN_KEY) === 'true'
  const savedFraction = Number(stored(WIDTH_KEY))
  let fraction = savedFraction > 0 && savedFraction < 1 ? savedFraction : DEFAULT_FRACTION
  let width = 0
  let drag: { id: number, x: number, width: number } | null = null
  let filter: SwitchboardKind | null = null
  let deck: number | null = null
  const busy = new Set<string>()
  const expanded = new Set<string>()
  const explaining = new Set<number>()
  const answering = new Set<number>()
  let loading: Promise<void> | null = null
  let again = false
  let offArmed = 0

  // ── Width and visibility ────────────────────────────────────────────────

  const overlay = () => getComputedStyle(el).position === 'absolute'
  function bounds() {
    const total = layoutEl.clientWidth
    const occupied = [view.querySelector<HTMLElement>('.chat-sidebar'), view.querySelector<HTMLElement>('.chat-memories-pane')]
      .reduce((sum, pane) => pane && getComputedStyle(pane).position !== 'absolute' ? sum + pane.getBoundingClientRect().width : sum, 0)
    const max = Math.max(MIN_WIDTH, total - occupied - CHAT_MIN_WIDTH)
    return { total, min: Math.min(MIN_WIDTH, max), max }
  }
  function target(): number {
    if (overlay()) return Math.min(420, layoutEl.clientWidth - 24)
    const { total, min, max } = bounds()
    return Math.round(Math.max(min, Math.min(max, fraction * total)))
  }
  function writeWidth(pixels: number): void {
    el.style.width = `${Math.max(0, pixels)}px`
    deps.onLayout()
  }
  function apply(): void {
    if (!layoutEl.clientWidth) return // a hidden view has no usable bounds
    width = target()
    el.style.setProperty('--sb-w', `${width}px`)
    if (!drag && !el.hasAttribute('data-motion-running')) writeWidth(open ? width : 0)
    const { total, min, max } = bounds()
    const percent = (value: number) => Math.round(value / total * 100)
    handle.setAttribute('aria-valuemin', String(percent(min)))
    handle.setAttribute('aria-valuemax', String(percent(max)))
    handle.setAttribute('aria-valuenow', String(percent(width)))
    handle.setAttribute('aria-valuetext', `${Math.abs(width - total / 3) < 2 ? 'One third' : Math.abs(width - total / 2) < 2 ? 'Half' : `${percent(width)} percent`} of Chat`)
  }
  function setOpen(next: boolean, animate = true): void {
    open = next
    remember(OPEN_KEY, String(open))
    if (!open && el.contains(document.activeElement)) toggle.focus()
    el.inert = !open
    el.setAttribute('aria-hidden', String(!open))
    view.classList.toggle('chat-switchboard-open', open)
    toggle.setAttribute('aria-pressed', String(open))
    toggle.setAttribute('aria-expanded', String(open))
    renderBadge()
    width = target()
    el.style.setProperty('--sb-w', `${width}px`)
    const presented = el.getBoundingClientRect().width
    if (!animate) { cancelMotion(el, 'switchboard'); writeWidth(open ? width : 0); return }
    spring(el, 'switchboard', { from: { width: presented }, to: () => ({ width: open ? target() : 0 }),
      write: ({ width }) => writeWidth(width), complete: () => { cancelMotion(el, 'switchboard'); writeWidth(open ? target() : 0) } })
    if (open) { deps.onOpen(); void refresh() }
  }
  function persist(): void {
    fraction = width / bounds().total
    remember(WIDTH_KEY, String(fraction))
  }
  function moveGuides(y: number): void {
    const { total } = bounds()
    let snapped: number | null = null
    for (const guide of guides) {
      guide.el.style.left = `${total - guide.fraction * total}px`
      const on = Math.abs(width - guide.fraction * total) < 1
      guide.el.classList.toggle('is-snapped', on)
      if (on) snapped = guide.fraction
    }
    const rect = layoutEl.getBoundingClientRect()
    readout.style.left = `${total - width}px`
    readout.style.top = `${Math.max(24, Math.min(rect.height - 24, y - rect.top))}px`
    readout.textContent = snapped === 1 / 3 ? 'One third' : snapped === 1 / 2 ? 'Half' : `${Math.round(width / total * 100)}%`
  }
  function endDrag(): void {
    if (!drag) return
    const pointer = drag.id
    drag = null
    view.classList.remove('chat-switchboard-resizing')
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
    persist()
    apply()
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !open || overlay()) return
    event.preventDefault()
    handle.focus({ preventScroll: true })
    cancelMotion(el, 'switchboard')
    drag = { id: event.pointerId, x: event.clientX, width: el.getBoundingClientRect().width }
    handle.setPointerCapture(event.pointerId)
    view.classList.add('chat-switchboard-resizing')
    moveGuides(event.clientY)
  })
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return
    const { total, min, max } = bounds()
    let next = drag.width + drag.x - event.clientX
    for (const snap of SNAPS) if (Math.abs(next - snap * total) < SNAP_PX) next = snap * total
    width = Math.round(Math.max(min, Math.min(max, next)))
    el.style.setProperty('--sb-w', `${width}px`)
    writeWidth(width)
    moveGuides(event.clientY)
  })
  handle.addEventListener('pointerup', endDrag)
  handle.addEventListener('pointercancel', endDrag)
  handle.addEventListener('lostpointercapture', endDrag)
  window.addEventListener('blur', endDrag)
  handle.addEventListener('dblclick', () => { fraction = DEFAULT_FRACTION; remember(WIDTH_KEY, String(fraction)); apply() })
  handle.addEventListener('keydown', event => {
    if (overlay()) return
    const { min, max } = bounds()
    const step = event.shiftKey ? 40 : 16
    // The edge is on the left: moving it left widens the pane.
    const next = event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? width - step
      : event.key === 'Home' ? min : event.key === 'End' ? max : null
    if (next === null) return
    event.preventDefault()
    width = Math.round(Math.max(min, Math.min(max, next)))
    persist()
    apply()
  })
  toggle.addEventListener('click', () => setOpen(!open))
  el.addEventListener('keydown', event => {
    if (event.key === 'Escape' && overlay()) { event.stopPropagation(); setOpen(false) }
  })

  // ── State ───────────────────────────────────────────────────────────────

  function accept(next: SwitchboardState): void {
    if (state && next.revision < state.revision) return
    state = next
    failure = null
    render()
  }
  /** One read at a time; a change announced during it is read once more after. */
  function refresh(): Promise<void> {
    if (loading) { again = true; return loading }
    loading = chatClient.switchboard()
      .then(value => {
        const parsed = parseSwitchboardState(value)
        if (!parsed) throw new Error('the Switchboard state could not be read')
        accept(parsed)
      })
      .catch((error: unknown) => { failure = error instanceof Error ? error.message : String(error); render() })
      .finally(() => {
        loading = null
        if (again) { again = false; void refresh() }
      })
    return loading
  }
  async function act(key: string, operation: () => Promise<SwitchboardState | null>): Promise<void> {
    if (busy.has(key)) return
    busy.add(key)
    notice = null
    render()
    try {
      const next = await operation()
      if (next) accept(next)
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error)
    } finally {
      busy.delete(key)
      render()
    }
  }
  chatClient.on('switchboard', revision => { if (!state || revision > state.revision) void refresh() })
  chatClient.on('connection', connection => { if (connection === 'open') void refresh() })

  // ── Rendering ───────────────────────────────────────────────────────────

  const lamp = (kind: LineState, live = false) => `<span class="sb-lamp${live ? ' is-live' : ''}" data-kind="${kind}"></span>`
  const agentPill = (item: SwitchboardItem) => `<span class="sb-agent">${escapeHtml(AGENT_LABELS[item.source.agent] ?? item.source.agent)}</span>`
  /** `where` keeps ids unique: a decision shows in its card and in its chat's row. */
  function actions(item: SwitchboardItem, where: 'card' | 'line'): string {
    const shown = explaining.has(item.id)
    // A new explanation needs a running Switchboard; one already asked for can always be shown.
    const unavailable = item.explanation.state !== 'ready' && item.explanation.state !== 'pending' && state?.status !== 'live' && state?.status !== 'paused'
    return `<div class="sb-actions">
      <button type="button" class="sb-action" data-act="explain" data-id="${item.id}" aria-expanded="${shown}" aria-controls="sb-expl-${where}-${item.id}"${unavailable ? ' disabled title="The Switchboard is not running"' : ''}>${ICON_EXPLAIN}${shown ? 'Hide explanation' : 'Explain'}</button>
      ${where === 'card' ? `<button type="button" class="sb-action" data-act="open" data-src="${escapeHtml(item.source.sessionId)}"${item.source.exists ? '' : ' disabled title="This chat was deleted"'}>${ICON_OPEN}Open chat</button>` : ''}
    </div>`
  }
  function explanation(item: SwitchboardItem, where: 'card' | 'line'): string {
    if (!explaining.has(item.id)) return `<div class="sb-expl" id="sb-expl-${where}-${item.id}" data-key="expl-${where}-${item.id}"></div>`
    const value = item.explanation
    const body = value.state === 'ready'
      ? `<div class="sb-expl-row"><span class="sb-expl-label">What changed</span><p>${escapeHtml(value.changed)}</p></div>
         <div class="sb-expl-row"><span class="sb-expl-label">Why it matters</span><p>${escapeHtml(value.matters)}</p></div>
         <div class="sb-expl-row"><span class="sb-expl-label">Still uncertain</span><p>${escapeHtml(value.uncertain)}</p></div>
         <div class="sb-expl-foot">Explained by the Switchboard at ${escapeHtml(clock(value.at))} · update ${item.id}</div>`
      : value.state === 'failed'
        ? `<p class="sb-expl-error">${escapeHtml(value.error)}</p><button type="button" class="chat-h-btn" data-act="explain-again" data-id="${item.id}"${busy.has(`explain:${item.id}`) ? ' disabled' : ''}>Try again</button>`
        : `<div class="sb-thinking"><span class="sb-dots"><i></i><i></i><i></i></span>Asking the Switchboard…${state?.sessionStatus === 'running' ? ' It is finishing its current work first.' : ''}</div>`
    return `<div class="sb-expl is-open" id="sb-expl-${where}-${item.id}" data-key="expl-${where}-${item.id}" role="region" aria-live="polite" aria-label="Explanation of update ${item.id}">${body}</div>`
  }
  function answered(item: SwitchboardItem): string {
    const answer = item.answer!
    const relay = answer.relay === 'delivered' ? `Delivered to ${escapeHtml(item.source.title)}`
      : answer.relay === 'held' ? `Held: ${escapeHtml(item.source.title)} is stopped${item.source.exists ? '; open it to resume it' : ' and was deleted'}`
        : `Queued for ${escapeHtml(item.source.title)}; it is delivered when the chat is free`
    return `<div class="sb-answered${answer.relay === 'held' ? ' is-held' : ''}" role="status" data-key="answered-${item.id}">${ICON_DONE}<div>You answered “${escapeHtml(answer.label)}” to “${escapeHtml(item.text)}”<small>${relay} · ${escapeHtml(clock(answer.at))}</small></div></div>`
  }
  function decisionCard(item: SwitchboardItem, now: number): string {
    const sending = busy.has(`answer:${item.id}`)
    // An open question has no choices: its answer box is the only control.
    const choices = item.options ?? []
    const other = answering.has(item.id) || !choices.length
    return `<article class="sb-decision" data-key="decision-${item.id}" aria-label="Decision from ${escapeHtml(item.source.title)}">
      <div class="sb-src">${lamp('decision', true)}<span class="sb-src-title">${escapeHtml(item.source.title)}</span>${agentPill(item)}<time class="sb-time" datetime="${escapeHtml(item.createdAt)}" title="${escapeHtml(clock(item.createdAt))}">${age(item.createdAt, now)}</time></div>
      <p class="sb-q">${escapeHtml(item.text)}</p>
      ${item.detail ? `<p class="sb-ctx">${escapeHtml(item.detail)}</p>` : ''}
      ${item.source.turnsSince ? `<p class="sb-stale">${escapeHtml(item.source.title)} has started ${item.source.turnsSince === 1 ? 'a turn' : `${item.source.turnsSince} turns`} since it asked; the question may be out of date.</p>` : ''}
      <div class="sb-options" role="group" aria-label="Choices">
        ${choices.map(option => `<button type="button" class="sb-option" data-act="choose" data-id="${item.id}" data-option="${escapeHtml(option.id)}"${sending ? ' disabled' : ''}>
          <span class="sb-option-label">${escapeHtml(option.label)}${option.recommended ? '<span class="sb-rec">Recommended</span>' : ''}</span>${option.detail ? `<span class="sb-option-detail">${escapeHtml(option.detail)}</span>` : ''}</button>`).join('')}
        ${choices.length ? `<button type="button" class="sb-option is-other" data-act="other" data-id="${item.id}" aria-expanded="${other}" aria-controls="sb-other-${item.id}"${sending ? ' disabled' : ''}><span class="sb-option-label">Something else…</span><span class="sb-option-detail">Answer in your own words.</span></button>` : ''}
        <div class="sb-other${other ? ' is-open' : ''}" id="sb-other-${item.id}" data-key="other-${item.id}"${other ? '' : ' hidden'}>
          <textarea class="sb-other-text" data-key="text-${item.id}" data-id="${item.id}" aria-label="Your answer to ${escapeHtml(item.source.title)}" placeholder="Your answer to ${escapeHtml(item.source.title)}…" maxlength="2000"></textarea>
          <div class="sb-other-row"><span class="sb-other-hint">⌘↩ sends · delivered once, as your answer</span>${choices.length ? `<button type="button" class="chat-h-btn" data-act="cancel-other" data-id="${item.id}">Cancel</button>` : ''}<button type="button" class="st-save" data-act="send-other" data-id="${item.id}" disabled>Send answer</button></div>
        </div>
      </div>
      ${actions(item, 'card')}
      ${explanation(item, 'card')}
    </article>`
  }
  function update(item: SwitchboardItem): string {
    const kind: LineState = item.kind === 'decision' ? (openDecision(item) ? 'decision' : 'done') : item.kind
    const label = item.kind === 'decision' ? (item.answer ? 'Answered' : item.resolved ? 'Settled' : 'Asked you') : STATE_LABEL[item.kind]
    const detail = item.answer ? `You answered “${item.answer.label}”.` : item.resolved ? `Settled in the chat: ${item.resolved.reason}` : item.detail
    return `<li class="sb-update" data-kind="${kind}" data-key="update-${item.id}">
      <div class="sb-update-meta"><span class="sb-state">${label}</span><time class="sb-time" datetime="${escapeHtml(item.createdAt)}">${escapeHtml(clock(item.createdAt))}</time></div>
      <p class="sb-update-text">${escapeHtml(item.text)}</p>
      ${detail ? `<p class="sb-update-detail">${escapeHtml(detail)}</p>` : ''}
      ${actions(item, 'line')}
      ${explanation(item, 'line')}
    </li>`
  }
  function line(source: string, items: SwitchboardItem[], now: number): string {
    const kind = lineState(items, now)
    const head = kind === 'decision' ? items.find(openDecision)! : items.find(item => !openDecision(item)) ?? items[0]
    const asks = kind !== 'decision' && items.some(openDecision)
    const isOpen = expanded.has(source)
    const headline = head.answer ? `You answered “${head.answer.label}”.` : head.text
    return `<div class="sb-line${isOpen ? ' is-open' : ''}" data-kind="${kind}" data-key="line-${escapeHtml(source)}">
      <button type="button" class="sb-line-head" data-act="line" data-src="${escapeHtml(source)}" aria-expanded="${isOpen}" aria-controls="sb-line-${escapeHtml(source)}">
        ${lamp(kind, kind === 'progress' || kind === 'blocked')}
        <span class="sb-line-title"><b>${escapeHtml(head.source.title)}</b>${agentPill(head)}${asks ? '<span class="sb-asks">Asks you</span>' : ''}</span>
        <span class="sb-line-side"><time class="sb-time" datetime="${escapeHtml(head.createdAt)}" title="${escapeHtml(clock(head.createdAt))}">${age(head.createdAt, now)}</time><span class="sb-chev">${ICON_CHEV}</span></span>
        <span class="sb-line-text"><span class="sb-state">${STATE_LABEL[kind]}</span><span>${escapeHtml(headline)}</span></span>
      </button>
      <div class="sb-line-body" id="sb-line-${escapeHtml(source)}"${isOpen ? '' : ' hidden'}>
        <ol class="sb-updates">${items.slice(0, LINE_ITEMS).map(update).join('')}</ol>
        <div class="sb-line-foot"><button type="button" class="chat-h-btn" data-act="open" data-src="${escapeHtml(source)}"${head.source.exists ? '' : ' disabled title="This chat was deleted"'}>${ICON_OPEN}Open ${escapeHtml(head.source.title)}</button></div>
      </div>
    </div>`
  }
  function header(current: SwitchboardState): string {
    const lampKind: LineState = current.status === 'live' ? 'progress' : current.status === 'stopped' ? 'blocked' : 'quiet'
    const label = current.status === 'stopped' ? 'Stopped' : current.status === 'paused' ? 'Paused' : current.sessionStatus === 'running' || current.checking ? 'Checking…' : 'Live'
    const cost = current.lastCheckTokens ? `${current.lastCheckTokens >= 10_000 ? `${Math.round(current.lastCheckTokens / 1000)}k` : current.lastCheckTokens.toLocaleString()} tokens` : ''
    const when = [current.lastCheckAt ? `checked ${clock(current.lastCheckAt)}` : 'no check finished yet', cost, current.nextCheckAt ? `next ${clock(current.nextCheckAt)}` : ''].filter(Boolean).join(' · ')
    return `<header class="sb-head">
      <div class="sb-title-row">
        <span class="sb-mark">${ICON_SWITCHBOARD}</span>
        <h2 class="sb-title">Switchboard</h2>
        <span class="sb-live" role="status">${lamp(lampKind, current.status === 'live')}${label}</span>
        <span class="sb-spacer"></span>
        <button type="button" class="chat-icon-btn" data-act="check" aria-label="Check every chat now" data-tooltip="Check now"${current.status !== 'live' || current.checking || busy.has('check') ? ' disabled' : ''}>${ICON_CHECK}</button>
        <button type="button" class="chat-icon-btn" data-act="${current.status === 'paused' ? 'resume' : 'pause'}" aria-label="${current.status === 'paused' ? 'Resume checks' : 'Pause checks'}" data-tooltip="${current.status === 'paused' ? 'Resume checks' : 'Pause checks'}"${current.status === 'stopped' || busy.has('pause') ? ' disabled' : ''}>${current.status === 'paused' ? ICON_RESUME : ICON_PAUSE}</button>
        <button type="button" class="chat-icon-btn" data-act="transcript" aria-label="Open the Switchboard's chat" data-tooltip="Open the Switchboard's chat">${ICON_TRANSCRIPT}</button>
        <button type="button" class="chat-icon-btn sb-off-btn${offArmed > Date.now() ? ' is-armed' : ''}" data-act="off" aria-label="${offArmed > Date.now() ? 'Confirm turning the Switchboard off' : 'Turn the Switchboard off'}" data-tooltip="${offArmed > Date.now() ? 'Sure? Click again' : 'Turn off'}"${busy.has('off') ? ' disabled' : ''}>${offArmed > Date.now() ? 'Sure?' : ICON_OFF}</button>
        <button type="button" class="chat-icon-btn" data-act="hide" aria-label="Hide Switchboard" data-tooltip="Hide">${ICON_CLOSE}</button>
      </div>
      <div class="sb-sub">Watching <b>${current.chats} ${current.chats === 1 ? 'chat' : 'chats'}</b> · ${escapeHtml(when)}</div>
      ${current.sessionStatus === 'waiting' && current.status !== 'stopped' ? `<div class="sb-stopped is-waiting" role="alert"><p>The Switchboard is waiting for you in its chat.</p><button type="button" class="chat-h-btn" data-act="transcript">Open its chat</button></div>` : ''}
      ${current.status === 'stopped' ? `<div class="sb-stopped" role="alert"><p>${escapeHtml(current.error || 'The Switchboard stopped.')}</p><button type="button" class="st-save" data-act="restart"${busy.has('restart') ? ' disabled' : ''}>Restart the Switchboard</button></div>` : ''}
    </header>`
  }
  function body(current: SwitchboardState, now: number): string {
    const bySource = new Map<string, SwitchboardItem[]>()
    for (const item of current.items) bySource.set(item.source.sessionId, [...(bySource.get(item.source.sessionId) ?? []), item])
    const decisions = current.items.filter(openDecision).sort((a, b) => a.id - b.id)
    const front = decisions.find(item => item.id === deck) ?? decisions[0]
    const recent = current.items.filter(item => item.answer && now - Date.parse(item.answer.at) < ANSWERED_SHOWN_MS)
    const lines = [...bySource.entries()].map(([source, items]) => ({ source, items, kind: lineState(items, now) }))
      .sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.items[0].id - a.items[0].id)
    const counts = { decision: decisions.length, blocked: 0, progress: 0, done: 0 }
    for (const entry of lines) if (entry.kind === 'blocked' || entry.kind === 'progress') counts[entry.kind]++
      else if (entry.kind === 'done' || entry.kind === 'quiet') counts.done++
    const shown = lines.filter(entry => !filter || (filter === 'decision' ? entry.items.some(openDecision) : filter === 'done' ? entry.kind === 'done' || entry.kind === 'quiet' : entry.kind === filter))
    const count = (kind: SwitchboardKind, label: string) => `<button type="button" class="sb-count" data-act="filter" data-kind="${kind}" aria-pressed="${filter === kind}"${counts[kind] || filter === kind ? '' : ' disabled'}>${lamp(kind)}<b>${counts[kind]}</b> ${label}</button>`
    return `${header(current)}
      <div class="sb-summary" role="group" aria-label="Filter chats">${count('decision', counts.decision === 1 ? 'needs you' : 'need you')}${count('blocked', 'blocked')}${count('progress', 'in progress')}${count('done', 'done')}</div>
      ${notice ? `<p class="sb-notice" role="alert">${escapeHtml(notice)}</p>` : ''}
      <div class="sb-scroll" data-key="scroll">
        ${front || recent.length ? `<section class="sb-section" aria-label="Needs you">
          <h3 class="sb-h is-needs">Needs you <span class="n">${decisions.length}</span></h3>
          ${front ? decisionCard(front, now) : ''}
          ${decisions.filter(item => item !== front).map(item => `<button type="button" class="sb-next" data-act="deck" data-id="${item.id}" data-key="next-${item.id}">
            ${lamp('decision')}<span class="sb-next-text"><b>${escapeHtml(item.source.title)}</b><span>${escapeHtml(item.text)}</span></span><span class="sb-next-go">Answer ${ICON_OPEN}</span></button>`).join('')}
          ${recent.map(answered).join('')}
        </section>` : ''}
        <section class="sb-section" aria-label="All chats">
          <h3 class="sb-h">${filter ? `${filter === 'decision' ? 'Chats asking you' : `${STATE_LABEL[filter]} chats`}` : 'All chats'} <span class="n">${shown.length}</span></h3>
          ${shown.length ? shown.map(entry => line(entry.source, entry.items, now)).join('') : `<p class="sb-empty">${filter ? 'No chat is in this state.' : current.status === 'live' ? 'Nothing to report yet. Updates appear here as the Switchboard checks your chats.' : 'Nothing reported.'}</p>`}
        </section>
        <footer class="sb-coverage">Covers the Poise chats in this workspace. Sessions outside Poise and GPT browser chats are not observed.</footer>
      </div>`
  }
  function offBody(current: SwitchboardState | null): string {
    return `<header class="sb-head"><div class="sb-title-row"><span class="sb-mark">${ICON_SWITCHBOARD}</span><h2 class="sb-title">Switchboard</h2><span class="sb-spacer"></span>
      <button type="button" class="chat-icon-btn" data-act="hide" aria-label="Hide Switchboard" data-tooltip="Hide">${ICON_CLOSE}</button></div></header>
      <div class="sb-off">
        <p>The Switchboard watches every chat in this workspace and reports here: what is blocked, what finished, and what needs your decision. It only reads and reports.</p>
        ${current ? `<p class="sb-disclosure">It runs the Muse model ${escapeHtml(current.model)} and reads your chats' transcripts. In contributor mode, Muse may use that content for product improvement.</p>` : ''}
        ${failure ? `<p class="sb-notice" role="alert">${escapeHtml(failure)}</p>` : ''}
        ${current?.error ? `<p class="sb-notice" role="alert">${escapeHtml(current.error)}</p>` : ''}
        ${notice ? `<p class="sb-notice" role="alert">${escapeHtml(notice)}</p>` : ''}
        ${current ? `<button type="button" class="st-save" data-act="start"${busy.has('start') ? ' disabled' : ''}>${busy.has('start') ? 'Starting…' : 'Start the Switchboard'}</button>` : `<button type="button" class="chat-h-btn" data-act="reload">Try again</button>`}
      </div>`
  }
  function renderBadge(): void {
    const waiting = state?.items.filter(openDecision).length ?? 0
    const stopped = state?.status === 'stopped'
    // A stopped Switchboard says so even while hidden: it is no longer watching.
    badge.textContent = stopped ? '!' : String(waiting)
    badge.classList.toggle('is-error', stopped)
    badge.hidden = open || (!waiting && !stopped)
    toggle.setAttribute('aria-label', stopped ? 'Switchboard, stopped' : waiting ? `Switchboard, ${waiting} ${waiting === 1 ? 'decision' : 'decisions'} waiting` : 'Switchboard')
  }
  function render(): void {
    renderBadge()
    if (!open) return
    const now = Date.now()
    patchContent(inner, state && state.status !== 'off' ? body(state, now) : offBody(state))
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  function sendOther(id: number): void {
    const text = inner.querySelector<HTMLTextAreaElement>(`.sb-other-text[data-id="${id}"]`)?.value.trim()
    if (!text) return
    void act(`answer:${id}`, async () => {
      const next = await chatClient.answerSwitchboardItem(id, { text })
      answering.delete(id)
      return next
    })
  }
  inner.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!target || !inner.contains(target) || (target as HTMLButtonElement).disabled) return
    const id = Number(target.dataset.id)
    switch (target.dataset.act) {
      case 'start': void act('start', () => chatClient.startSwitchboard()); return
      case 'reload': void refresh(); return
      case 'check': void act('check', async () => { const result = await chatClient.checkSwitchboard(); if (!result.queued) notice = result.reason === 'nothing changed' ? 'Nothing changed since the last check.' : `No check started: ${result.reason}.`; return result.state }); return
      case 'pause': void act('pause', () => chatClient.pauseSwitchboard(true)); return
      case 'resume': void act('pause', () => chatClient.pauseSwitchboard(false)); return
      case 'restart': void act('restart', () => chatClient.restartSwitchboard()); return
      case 'off':
        if (offArmed > Date.now()) { offArmed = 0; void act('off', () => chatClient.turnOffSwitchboard()); return }
        offArmed = Date.now() + 4_000
        render()
        setTimeout(render, 4_100)
        return
      case 'transcript': if (state?.sessionId) deps.openChat(state.sessionId); return
      case 'hide': setOpen(false); return
      case 'filter': filter = filter === target.dataset.kind ? null : target.dataset.kind as SwitchboardKind; render(); return
      case 'deck': deck = id; render(); inner.querySelector<HTMLElement>('.sb-decision .sb-option')?.focus({ preventScroll: true }); return
      case 'line': { const source = target.dataset.src!; if (expanded.has(source)) expanded.delete(source); else expanded.add(source); render(); return }
      case 'open': if (target.dataset.src) deps.openChat(target.dataset.src); return
      case 'choose': void act(`answer:${id}`, () => chatClient.answerSwitchboardItem(id, { optionId: target.dataset.option! })); return
      case 'other':
        if (answering.has(id)) answering.delete(id); else answering.add(id)
        render()
        if (answering.has(id)) inner.querySelector<HTMLTextAreaElement>(`.sb-other-text[data-id="${id}"]`)?.focus()
        return
      case 'cancel-other': answering.delete(id); render(); return
      case 'send-other': sendOther(id); return
      case 'explain': {
        if (explaining.has(id)) { explaining.delete(id); render(); return }
        explaining.add(id)
        const item = state?.items.find(entry => entry.id === id)
        if (item && item.explanation.state === 'none') void act(`explain:${id}`, () => chatClient.explainSwitchboardItem(id))
        else render()
        return
      }
      case 'explain-again': void act(`explain:${id}`, () => chatClient.explainSwitchboardItem(id)); return
    }
  })
  inner.addEventListener('input', event => {
    const field = event.target as HTMLElement
    if (!(field instanceof HTMLTextAreaElement) || !field.classList.contains('sb-other-text')) return
    const send = inner.querySelector<HTMLButtonElement>(`[data-act="send-other"][data-id="${field.dataset.id}"]`)
    if (send) send.disabled = !field.value.trim()
  })
  inner.addEventListener('keydown', event => {
    const field = event.target as HTMLElement
    if (field instanceof HTMLTextAreaElement && field.classList.contains('sb-other-text') && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      sendOther(Number(field.dataset.id))
    }
  })
  // Ages and the next check time stay current while the pane is open.
  setInterval(() => { if (open && !document.hidden) render() }, 30_000)
  setInterval(() => { if (open && !document.hidden && !view.hidden) void refresh() }, 60_000)

  new ResizeObserver(() => apply()).observe(layoutEl)
  return {
    el,
    get sessionId() { return state?.sessionId ?? null },
    get open() { return open },
    get overlaid() { return overlay() },
    mount() {
      layoutEl.append(...guides.map(guide => guide.el), readout)
      setOpen(open, false)
      apply()
      void refresh()
    },
    hide() { if (open) setOpen(false) },
    refresh,
  }
}
