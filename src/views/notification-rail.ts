import { cancelMotion, disclosure, layout, retire, scrollToActor, spring, watchPanel } from '../motion'
import { patchContent } from '../dom-patch'
import { BEHAVIORS, getBehaviorDiagnostics, refreshState } from '../behaviors'
import { effectiveTimezone } from '../config'
import {
  GROUPS, behaviorCounts, countItems, headTone, notificationItems, openLabel,
  type ItemCounts, type ItemGroup, type ItemIcon, type NotificationItem,
} from '../notification-items'
import type { Notice, NoticeFeed, NoticesState, NoticeTarget } from '../notices'
// The notification rail: what needs the person and what Behaviors is doing, in
// one place. A bell at the end of the control bar opens a full-height rail
// under the bar. On a window at least 1400px wide it docks, and the page makes
// room for it instead of being covered, so it can stay open while the person
// works. Each entry expands in place to its full words, what happened and what
// can be done about it. A notice that arrives while the rail is closed shows as
// a card under the bar for a few seconds, then tucks into the bell. Nothing
// here takes focus unasked or makes a sound; a screen reader reads each new
// notice once.

const ICONS: Record<ItemIcon, string> = {
  chat: '<circle cx="3" cy="6" r="1.1" fill="currentColor"/><circle cx="6" cy="6" r="1.1" fill="currentColor"/><circle cx="9" cy="6" r="1.1" fill="currentColor"/>',
  key: '<circle cx="4.2" cy="6" r="2.2" stroke="currentColor" stroke-width="1.4"/><path d="M6.4 6h4.1M9 6v1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  held: '<path d="M6 2.6v4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="9.3" r="0.95" fill="currentColor"/>',
  sync: '<path d="M9.7 4.6A4 4 0 0 0 2.6 4M2.3 7.4A4 4 0 0 0 9.4 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2.4 1.9v2.3h2.3M9.6 10.1V7.8H7.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  merge: '<circle cx="3.5" cy="2.8" r="1.3" stroke="currentColor" stroke-width="1.2"/><circle cx="3.5" cy="9.2" r="1.3" stroke="currentColor" stroke-width="1.2"/><circle cx="8.8" cy="6.6" r="1.3" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 4.1v3.8M3.5 4.4c0 1.6 1.3 2.2 4 2.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  check: '<path d="M2.6 6.3l2.2 2.2 4.6-4.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  fault: '<path d="M6 1.9 10.6 9.9H1.4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 5.1v2.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="6" cy="8.5" r=".7" fill="currentColor"/>',
  retry: '<path d="M9.8 6.2A3.8 3.8 0 1 1 8.6 3.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M9 1.5v2.3H6.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
}
const ICON_BELL = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M3.8 10.4V7a3.7 3.7 0 0 1 7.4 0v3.4l1.1 1.2H2.7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.1 12.9a1.5 1.5 0 0 0 2.8 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
const ICON_DOWN = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 3.75 5 6.25l2.5-2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_DOCK = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1.75" y="2.25" width="10.5" height="9.5" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M8.25 2.5v9" stroke="currentColor" stroke-width="1.3"/></svg>'

/** Narrower windows get the rail over the page instead of beside it. */
export const DOCK_MIN_WIDTH = 1400
const TOAST_MS = 6000
const TOAST_HOVER_MS = 2500
const TOAST_LIMIT = 3
/** Behaviors' diagnostics cost an agent-log read on the server: the page reads
 *  them once it has settled, unless the rail or Behaviors reads them first. */
const FIRST_READ_DELAY_MS = 15_000
const PREFERENCE_KEY = 'poise-notification-rail'

type Filter = 'all' | ItemGroup

export interface RailActions {
  open(target: NoticeTarget): void
  /** Whether what a notice is about is on screen already, so it need not be listed. */
  inView?(target: NoticeTarget): boolean
}

export interface NotificationRail {
  /** Reads Behaviors' diagnostics once the page has settled, so the bell counts them. */
  start(): void
}

interface Controller {
  items(): readonly NotificationItem[]
  open(options: { behavior?: string | null, group?: ItemGroup | null }): void
}

let controller: Controller | null = null
const itemListeners = new Set<() => void>()

/** Hears every change to what the rail lists. */
export function onNotificationItems(listener: () => void): () => void {
  itemListeners.add(listener)
  return () => itemListeners.delete(listener)
}

/** What the rail lists about one behavior, by group. */
export function notificationCountsFor(behavior: string): ItemCounts {
  return behaviorCounts(controller?.items() ?? [], behavior)
}

/** Opens the rail, on one behavior when given, with its first entry in
 *  `group` expanded. */
export function openNotifications(options: { behavior?: string | null, group?: ItemGroup | null } = {}): void {
  if (!controller) throw new Error('The notification rail is not mounted.')
  controller.open(options)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// Sentences joined as they are read, without doubling a full stop.
function sentences(...parts: string[]): string {
  return parts.filter(Boolean).map((part) => /[.!?…]$/.test(part) ? part : `${part}.`).join(' ')
}

/** "now", "4m", "3h", "2d": how long ago, as the rest of Poise says it. */
export function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: effectiveTimezone() }).format(new Date(iso))
}

// A stable element id for an item id, which may hold any character.
function slug(id: string): string {
  let hash = 2166136261
  for (const character of id) { hash ^= character.codePointAt(0)!; hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(36)
}

const icon = (name: ItemIcon) => `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">${ICONS[name]}</svg>`

/** One entry as the rail lays it out; `opened` says whether it is expanded. */
export function itemHtml(item: NotificationItem, opened: boolean, now: number): string {
  const id = `nr-details-${slug(item.id)}`
  // A Poise-wide condition's scope can repeat its source: "Behaviors · Behaviors".
  const meta = [item.source, item.scope === item.source ? null : item.scope, item.meta].filter(Boolean).map((part) => escapeHtml(part!)).join(' · ')
  const when = item.when && Number.isFinite(Date.parse(item.when)) ? `<time datetime="${escapeHtml(item.when)}">${ago(item.when, now)}</time>` : ''
  const history = item.details.length
    ? `<ol class="nr-history">${item.details.map((entry) => `<li>${entry.at && Number.isFinite(Date.parse(entry.at)) ? `<time datetime="${escapeHtml(entry.at)}">${clock(entry.at)}</time>` : ''}<span>${escapeHtml(entry.detail)}</span></li>`).join('')}</ol>`
    : ''
  const notice = item.notice
  const label = notice?.target ? openLabel(notice.target) : null
  const actions = notice
    ? (label ? `<button type="button" class="nr-btn nr-btn-primary" data-action="open">${label}</button>` : '')
      + (notice.silenceable ? '<button type="button" class="nr-btn" data-action="silence">Silence reminders</button>' : '')
      + '<button type="button" class="nr-btn" data-action="dismiss">Dismiss</button>'
    : ''
  return `<article class="nr-card${opened ? ' is-open' : ''}${item.group === 'auto' ? ' is-auto' : ''}" data-id="${escapeHtml(item.id)}" data-tone="${item.tone}">`
    + `<button type="button" class="nr-card-head" data-action="expand" aria-expanded="${opened}" aria-controls="${id}">`
    + `<span class="nr-chip">${icon(item.icon)}</span>`
    + `<span class="nr-card-text"><span class="nr-card-title">${escapeHtml(item.title)}</span>${item.body ? `<span class="nr-card-body">${escapeHtml(item.body)}</span>` : ''}<span class="nr-card-meta">${meta}</span></span>`
    + `<span class="nr-card-side">${when}<span class="nr-chev">${ICON_DOWN}</span></span></button>`
    + `<div class="nr-details" id="${id}"${opened ? '' : ' hidden'}>${history}${actions ? `<div class="nr-actions">${actions}</div>` : ''}</div>`
    + '</article>'
}

// A card on its way out: tucking into the bell, or put away.
const leaving = (toast: HTMLElement) => toast.dataset.leaving === 'true'

function readPreference(): { docked: boolean, open: boolean } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? 'null')
    if (value && typeof value === 'object' && typeof (value as { docked?: unknown }).docked === 'boolean' && typeof (value as { open?: unknown }).open === 'boolean') {
      return value as { docked: boolean, open: boolean }
    }
  } catch {
    // An unreadable preference is no preference: the defaults below.
  }
  return { docked: true, open: false }
}

export function mountNotificationRail(feed: NoticeFeed, actions: RailActions): NotificationRail {
  const toggle = document.getElementById('menu-toggle')
  if (!toggle) throw new Error('The notification bell needs the menu button (#menu-toggle) in the control bar.')

  const bell = document.createElement('button')
  bell.id = 'notification-bell'
  bell.type = 'button'
  bell.className = 'nr-bell'
  bell.setAttribute('aria-controls', 'notification-rail')
  bell.setAttribute('aria-expanded', 'false')
  toggle.before(bell)

  const rail = document.createElement('aside')
  rail.id = 'notification-rail'
  rail.className = 'nr-rail'
  rail.setAttribute('aria-label', 'Notifications')
  rail.inert = true
  rail.innerHTML = '<div class="nr-head"><h2 class="nr-title" tabindex="-1">Notifications<span class="nr-count"></span></h2>'
    + `<button type="button" class="nr-icon" data-action="dock" aria-label="Keep beside the page on a wide window">${ICON_DOCK}</button>`
    + `<button type="button" class="nr-icon" data-action="close" aria-label="Close notifications">${ICON_CLOSE}</button></div>`
    + '<div class="nr-filters"></div><div class="nr-body"></div>'
  const title = rail.querySelector<HTMLElement>('.nr-title')!
  const count = rail.querySelector<HTMLElement>('.nr-count')!
  const dock = rail.querySelector<HTMLButtonElement>('[data-action="dock"]')!
  const filters = rail.querySelector<HTMLElement>('.nr-filters')!
  const body = rail.querySelector<HTMLElement>('.nr-body')!

  const toasts = document.createElement('div')
  toasts.className = 'nr-toasts'
  // Kept on the page from the start: a live region that appears together with
  // its first words is not announced.
  const live = document.createElement('div')
  live.className = 'nr-live'
  live.setAttribute('aria-live', 'polite')
  document.body.append(rail, toasts, live)
  watchPanel(rail, () => rail.classList.contains('open'), 1)

  const preference = readPreference()
  let notices: Notice[] = []
  let enabled = false
  let items: NotificationItem[] = []
  let opened = false
  let filter: Filter = 'all'
  let behavior: string | null = null
  let automaticOpen = false
  // Notices standing before this page, or before notifications were turned on,
  // are counted by the bell; only later ones arrive as cards.
  let primed = false
  const expanded = new Set<string>()
  const announced = new Set<string>()
  const toastTimers = new Map<HTMLElement, number>()

  function savePreference(): void {
    try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ docked: preference.docked, open: preference.docked && opened })) }
    catch { /* Storage refused: the preference lasts for this page. */ }
  }

  function dockedNow(): boolean {
    return opened && preference.docked && window.innerWidth >= DOCK_MIN_WIDTH
  }

  function applyDock(): void {
    // The page a docked rail leaves is the window less the reserved scrollbar
    // gutter, which 100vw counts (notification-rail.css). The fixed control bar
    // spans exactly what fixed layers get; clientWidth can miss the gutter.
    const bar = document.querySelector<HTMLElement>('.view:not([hidden]) .view-header')
    const gutter = bar ? window.innerWidth - bar.getBoundingClientRect().width : window.innerWidth - document.documentElement.clientWidth
    document.documentElement.style.setProperty('--scrollbar-w', `${Math.max(0, Math.round(gutter))}px`)
    const docked = dockedNow()
    document.body.classList.toggle('notifications-docked', docked)
    rail.classList.toggle('is-docked', docked)
    dock.setAttribute('aria-pressed', String(preference.docked))
  }

  function scoped(): NotificationItem[] {
    return behavior ? items.filter((item) => item.behaviors.includes(behavior!)) : items
  }

  function renderBell(): void {
    const counts = countItems(items)
    const tone = headTone(counts)
    patchContent(bell, ICON_BELL + (tone ? `<span class="nr-badge" data-tone="${tone}">${counts.open}</span>` : ''))
    bell.setAttribute('aria-label', counts.open ? `Notifications, ${counts.open} open` : 'Notifications')
    bell.setAttribute('aria-expanded', String(opened))
  }

  function groupHtml(group: typeof GROUPS[number], list: readonly NotificationItem[], now: number): string {
    const label = `<span class="nr-group-name">${group.label}</span><span class="nr-group-count">${list.length}</span><span class="nr-group-note">${group.note}</span>`
    const cards = list.map((item) => itemHtml(item, expanded.has(item.id), now)).join('')
    // Automatic recovery stays folded behind its count while anything else is listed.
    const folds = group.key === 'auto' && filter === 'all' && scoped().some((item) => item.group !== 'auto')
    if (!folds) return `<section class="nr-group" data-key="group-${group.key}" data-group="${group.key}" aria-label="${group.label}"><h3 class="nr-group-label">${label}</h3>${cards}</section>`
    return `<section class="nr-group" data-key="group-${group.key}" data-group="${group.key}" aria-label="${group.label}">`
      + `<h3 class="nr-group-label"><button type="button" class="nr-fold" data-action="fold" aria-expanded="${automaticOpen}" aria-controls="nr-automatic" aria-label="${group.label}, ${list.length}">${label}<span class="nr-chev">${ICON_DOWN}</span></button></h3>`
      + `<div class="nr-fold-items" id="nr-automatic"${automaticOpen ? '' : ' hidden'}>${cards}</div></section>`
  }

  function renderRail(): void {
    const now = Date.now()
    const list = scoped()
    const counts = countItems(list)
    count.textContent = counts.open ? `${counts.open} open` : ''
    const options: [Filter, string, number][] = [['all', 'All', list.length], ...GROUPS.map((group): [Filter, string, number] => [group.key, group.short, counts[group.key]])]
    patchContent(filters, `<div class="range-picker nr-picker" role="group" aria-label="Show">${options.map(([key, label, n]) =>
      `<button type="button" data-key="filter-${key}" data-action="filter" data-filter="${key}" class="${filter === key ? 'active' : ''}${n ? '' : ' is-empty'}" aria-pressed="${filter === key}" aria-label="${label}, ${n}">${label}<span class="nr-picker-count">${n}</span></button>`).join('')}</div>`
      + (behavior ? `<span class="nr-tag">${escapeHtml(BEHAVIORS.find((entry) => entry.key === behavior)?.label ?? behavior)}<button type="button" data-action="all-behaviors" aria-label="Show every notification">${ICON_CLOSE}</button></span>` : ''))
    const shown = filter === 'all' ? list : list.filter((item) => item.group === filter)
    const sections = GROUPS.map((group) => ({ group, entries: shown.filter((item) => item.group === group.key) }))
      .filter(({ entries }) => entries.length)
      .map(({ group, entries }) => groupHtml(group, entries, now)).join('')
    const staying = new Set(shown.map((item) => item.id))
    // An entry leaves from where it was shown, though it sits inside its group,
    // and an entry that moves to another group arrives there afresh.
    layout(body, () => {
      for (const card of [...body.querySelectorAll<HTMLElement>('.nr-card')]) if (!staying.has(card.dataset.id!)) retire(card)
      patchContent(body, sections || emptyHtml(), retire)
    }, '.nr-card, .nr-group-label, .nr-empty')
  }

  function emptyHtml(): string {
    const off = enabled ? '' : '<p class="nr-empty-note">Notifications are off in Settings, General. Behaviors’ activity still shows here.</p>'
    return `<div class="nr-empty"><p class="nr-empty-title">${behavior || filter !== 'all' ? 'Nothing here' : 'Nothing needs you'}</p>${off}</div>`
  }

  function recompute(): void {
    const visible = notices.filter((notice) => (enabled || notice.kind === 'read_failed') && (!notice.target || !actions.inView?.(notice.target)))
    items = notificationItems(visible, getBehaviorDiagnostics(), Date.now())
    for (const id of [...expanded]) if (!items.some((item) => item.id === id)) expanded.delete(id)
    renderBell()
    if (opened) renderRail()
    for (const toast of [...toasts.children] as HTMLElement[]) {
      if (!leaving(toast) && !items.some((item) => item.id === toast.dataset.id)) dropToast(toast)
    }
    for (const listener of itemListeners) listener()
  }

  function update(state: NoticesState): void {
    if (state.enabled && !enabled) primed = false
    notices = state.notices
    enabled = state.enabled
    const fresh = state.notices.filter((notice) => !announced.has(`${notice.id}@${notice.due}`))
    for (const notice of state.notices) announced.add(`${notice.id}@${notice.due}`)
    recompute()
    if (!feed.answered || !enabled) return
    if (!primed) { primed = true; return }
    const arrivals = fresh.filter((notice) => !notice.target || !actions.inView?.(notice.target))
    if (!arrivals.length) return
    live.textContent = `Notification: ${sentences(arrivals[0].title, arrivals[0].body)}${arrivals.length > 1 ? ` ${arrivals.length - 1} more.` : ''}`
    for (const notice of arrivals) {
      if (opened) body.querySelector<HTMLElement>(`.nr-card[data-id="${CSS.escape(notice.id)}"]`)?.classList.add('nr-arrived')
      else {
        const item = items.find((entry) => entry.id === notice.id)
        if (item) showToast(item)
      }
    }
  }

  function setOpen(next: boolean, focus: 'rail' | 'bell' | null = null): void {
    if (opened !== next) {
      opened = next
      // watchPanel sets this too, but only once its observer runs: the rail
      // must take focus now.
      rail.inert = !next
      rail.classList.toggle('open', next)
      if (next) {
        renderRail()
        for (const toast of [...toasts.children] as HTMLElement[]) dropToast(toast)
        void refreshDiagnostics()
      }
      applyDock()
      renderBell()
      savePreference()
    }
    if (focus === 'rail') title.focus({ preventScroll: true })
    if (focus === 'bell') bell.focus({ preventScroll: true })
  }

  let refreshing: Promise<void> | null = null
  function refreshDiagnostics(): Promise<void> {
    refreshing ??= refreshState().finally(() => { refreshing = null })
    return refreshing
  }

  function expand(card: HTMLElement, open: boolean): void {
    const id = card.dataset.id!
    const details = card.querySelector<HTMLElement>('.nr-details')!
    if (open === expanded.has(id) && details.hidden === !open) return
    if (open) expanded.add(id); else expanded.delete(id)
    card.classList.toggle('is-open', open)
    card.querySelector<HTMLElement>('.nr-card-head')!.setAttribute('aria-expanded', String(open))
    disclosure(details, open)
  }

  function act(action: string, id: string, toast: HTMLElement | null): void {
    const notice = items.find((item) => item.id === id)?.notice
    if (!notice) return
    if (toast) dropToast(toast)
    if (action === 'open' && notice.target) {
      // Floating, the rail covers part of where the person is going.
      if (opened && !dockedNow()) setOpen(false)
      actions.open(notice.target)
      void feed.dismiss(notice.id)
    }
    if (action === 'dismiss') void feed.dismiss(notice.id)
    if (action === 'silence') void feed.silence(notice.id)
  }

  function showToast(item: NotificationItem): void {
    const label = item.notice?.target ? openLabel(item.notice.target) : null
    const toast = document.createElement('div')
    toast.className = 'nr-toast'
    toast.dataset.id = item.id
    toast.dataset.tone = item.tone
    toast.innerHTML = `<span class="nr-chip nr-chip-solid">${icon(item.icon)}</span>`
      + `<div class="nr-toast-text"><p class="nr-toast-title">${escapeHtml(item.title)}</p>${item.body ? `<p class="nr-toast-body">${escapeHtml(item.body)}</p>` : ''}`
      + `<div class="nr-actions">${label ? `<button type="button" class="nr-btn nr-btn-primary" data-action="open">${label}</button>` : ''}<button type="button" class="nr-btn" data-action="show">Show</button></div></div>`
      + `<button type="button" class="nr-icon" data-action="dismiss" aria-label="Dismiss">${ICON_CLOSE}</button>`
    toasts.prepend(toast)
    spring(toast, 'entry', { from: { opacity: 0, x: 28 }, to: { opacity: 1, x: 0 },
      write: ({ opacity, x }) => { toast.style.opacity = String(Math.max(0, Math.min(1, opacity))); toast.style.translate = `${x}px 0` },
      complete: () => { toast.style.opacity = ''; toast.style.translate = ''; cancelMotion(toast, 'entry') } })
    // Beyond three, the oldest tuck away, but never one the person is using:
    // it goes once focus and pointer have left it.
    const live = ([...toasts.children] as HTMLElement[]).filter((child) => !leaving(child))
    for (const old of live.slice(TOAST_LIMIT)) if (!old.contains(document.activeElement) && !old.matches(':hover')) tuck(old)
    const wait = (ms: number) => { window.clearTimeout(toastTimers.get(toast)); toastTimers.set(toast, window.setTimeout(() => tuck(toast), ms)) }
    const hold = () => window.clearTimeout(toastTimers.get(toast))
    toast.addEventListener('pointerenter', hold)
    toast.addEventListener('focusin', hold)
    toast.addEventListener('pointerleave', () => { if (!toast.contains(document.activeElement)) wait(TOAST_HOVER_MS) })
    toast.addEventListener('focusout', (event) => { if (!toast.contains(event.relatedTarget as Node | null) && !toast.matches(':hover')) wait(TOAST_HOVER_MS) })
    wait(TOAST_MS)
  }

  // Into the bell, which says once more that something is waiting.
  function tuck(toast: HTMLElement): void {
    if (leaving(toast)) return
    toast.dataset.leaving = 'true'
    toast.inert = true
    window.clearTimeout(toastTimers.get(toast))
    toastTimers.delete(toast)
    const from = toast.getBoundingClientRect(), to = bell.getBoundingClientRect()
    const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2)
    spring(toast, 'tuck', { from: { progress: 0 }, to: { progress: 1 },
      write: ({ progress }) => {
        const p = Math.max(0, Math.min(1, progress))
        toast.style.opacity = String(1 - p)
        toast.style.translate = `${dx * p}px ${dy * p}px`
        toast.style.scale = String(1 - .85 * p)
      },
      complete: () => {
        toast.remove()
        cancelMotion(toast, 'tuck')
        const badge = bell.querySelector<HTMLElement>('.nr-badge')
        if (badge) spring(badge, 'bump', { from: { scale: 1.45 }, to: { scale: 1 },
          write: ({ scale }) => { badge.style.scale = String(scale) },
          complete: () => { badge.style.scale = ''; cancelMotion(badge, 'bump') } })
      } })
  }

  // Put away, or no longer standing: it leaves where it is.
  function dropToast(toast: HTMLElement): void {
    if (leaving(toast)) return
    toast.dataset.leaving = 'true'
    window.clearTimeout(toastTimers.get(toast))
    toastTimers.delete(toast)
    const hadFocus = toast.contains(document.activeElement)
    retire(toast)
    if (hadFocus) bell.focus({ preventScroll: true })
  }

  function openOn(options: { behavior?: string | null, group?: ItemGroup | null }): void {
    behavior = options.behavior ?? null
    filter = 'all'
    const first = options.group ? scoped().find((item) => item.group === options.group) : undefined
    if (first?.group === 'auto') automaticOpen = true
    if (first) expanded.add(first.id)
    if (opened) renderRail()
    setOpen(true, 'rail')
    if (!first) return
    const card = body.querySelector<HTMLElement>(`.nr-card[data-id="${CSS.escape(first.id)}"]`)
    if (card) { card.classList.add('nr-arrived'); scrollToActor(card) }
  }

  bell.addEventListener('click', () => setOpen(!opened, opened ? null : 'rail'))

  rail.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]')
    if (!button) return
    const action = button.dataset.action!
    if (action === 'close') { setOpen(false, 'bell'); return }
    if (action === 'dock') { preference.docked = !preference.docked; applyDock(); savePreference(); return }
    if (action === 'filter') { filter = button.dataset.filter as Filter; renderRail(); return }
    if (action === 'all-behaviors') { behavior = null; renderRail(); title.focus({ preventScroll: true }); return }
    if (action === 'fold') {
      automaticOpen = !automaticOpen
      button.setAttribute('aria-expanded', String(automaticOpen))
      disclosure(rail.querySelector<HTMLElement>('#nr-automatic')!, automaticOpen)
      return
    }
    const card = button.closest<HTMLElement>('.nr-card')
    if (!card) return
    if (action === 'expand') expand(card, !expanded.has(card.dataset.id!))
    else act(action, card.dataset.id!, null)
  })

  toasts.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]')
    const toast = button?.closest<HTMLElement>('.nr-toast')
    if (!button || !toast || leaving(toast)) return
    const id = toast.dataset.id!
    if (button.dataset.action === 'show') {
      dropToast(toast)
      const item = items.find((entry) => entry.id === id)
      if (!item) return
      behavior = null
      filter = 'all'
      expanded.add(id)
      if (item.group === 'auto') automaticOpen = true
      if (opened) renderRail()
      setOpen(true, 'rail')
      const card = body.querySelector<HTMLElement>(`.nr-card[data-id="${CSS.escape(id)}"]`)
      if (card) scrollToActor(card)
      return
    }
    act(button.dataset.action!, id, toast)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !opened) return
    const inside = rail.contains(document.activeElement)
    // Docked, the rail is part of the page; Escape elsewhere is someone else's.
    if (!inside && dockedNow()) return
    event.preventDefault()
    setOpen(false, inside ? 'bell' : null)
  })

  document.addEventListener('pointerdown', (event) => {
    if (!opened || dockedNow()) return
    const target = event.target as Element
    // A control that opens the rail on something would otherwise close it first.
    if (rail.contains(target) || bell.contains(target) || toasts.contains(target) || target.closest?.('[data-opens-notifications]')) return
    setOpen(false)
  })

  window.addEventListener('resize', applyDock)
  window.addEventListener('poise:behavior-diagnostics', recompute)
  window.addEventListener('poise:refresh-tick', () => {
    if (!opened) return
    // Behaviors reads the same state on the same tick while it is on screen.
    if (document.getElementById('view-behaviors')?.hidden !== false) void refreshDiagnostics()
    renderRail()
  })
  // A reminder's "for N min" and the entries' ages keep counting between reads.
  window.setInterval(() => { if (opened) renderRail() }, 30_000)

  controller = { items: () => items, open: openOn }
  feed.subscribe(update)
  update(feed.current)
  if (preference.open && preference.docked && window.innerWidth >= DOCK_MIN_WIDTH) setOpen(true)
  else applyDock()

  return {
    start: () => {
      window.setTimeout(() => { if (!getBehaviorDiagnostics()) void refreshDiagnostics() }, FIRST_READ_DELAY_MS)
    },
  }
}

