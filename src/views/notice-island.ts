import { cancelMotion, finishMotion, reveal, spring } from '../motion'
import { patchContent } from '../dom-patch'
// The notification island: one pill at the top centre of the page, in the
// band above every view's controls, that shows one notice at a time, the most
// pressing first, and is gone when nothing needs the person.
//
// It grows out of a dot when a notice arrives, changes width as one notice
// gives way to the next, and shrinks back into the dot when the last one is put
// away. Clicking a notice takes the person to it and puts it away; × puts it
// away; a pull request ready to merge can also be silenced; "+N" steps to the
// next. Nothing here takes focus or makes a sound.

import { standingFor, type Notice, type NoticeFeed, type NoticeKind, type NoticesState, type NoticeTarget } from '../notices'

const ICONS: Record<NoticeKind, string> = {
  chat_waiting: '<circle cx="3" cy="6" r="1.1" fill="currentColor"/><circle cx="6" cy="6" r="1.1" fill="currentColor"/><circle cx="9" cy="6" r="1.1" fill="currentColor"/>',
  sign_in_needed: '<circle cx="4.2" cy="6" r="2.2" stroke="currentColor" stroke-width="1.4"/><path d="M6.4 6h4.1M9 6v1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  behavior_held: '<path d="M6 2.6v4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="9.3" r="0.95" fill="currentColor"/>',
  datastore_sync_failing: '<path d="M9.7 4.6A4 4 0 0 0 2.6 4M2.3 7.4A4 4 0 0 0 9.4 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2.4 1.9v2.3h2.3M9.6 10.1V7.8H7.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  pr_ready: '<circle cx="3.5" cy="2.8" r="1.3" stroke="currentColor" stroke-width="1.2"/><circle cx="3.5" cy="9.2" r="1.3" stroke="currentColor" stroke-width="1.2"/><circle cx="8.8" cy="6.6" r="1.3" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 4.1v3.8M3.5 4.4c0 1.6 1.3 2.2 4 2.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  chat_turn_finished: '<path d="M2.6 6.3l2.2 2.2 4.6-4.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
}
const ICON_DISMISS = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
const ICON_SILENCE = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M3.4 9.2V6.1a3.1 3.1 0 0 1 5.3-2.2M9.6 5.4v3.8l1 1H5.2M5.4 11.1a1.2 1.2 0 0 0 2.2 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M1.8 1.8l9.4 9.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'

// Where a notice goes, as assistive technology reads it.
function destination(target: NoticeTarget): string {
  if ('view' in target) return 'Open Behaviors'
  if ('swarm' in target) return 'Open the failed run in Swarm'
  if ('settings' in target) return target.settings === 'accounts' ? 'Open Settings, Accounts' : 'Open Settings'
  if ('chat' in target) return 'Open the Chat session'
  return 'Open the pull request on GitHub'
}

/** A reminder says how long its condition has stood; a first showing says nothing more. */
export function noticeMeta(notice: Notice, now: number): string {
  return notice.kind === 'pr_ready' && Date.parse(notice.due) > Date.parse(notice.since)
    ? `for ${standingFor(notice.since, now)}`
    : ''
}

/** Which notice to show: the one shown, while it stands, unless a notice that
 *  has just come due ranks before it; otherwise the first. */
export function chooseShown(previous: readonly Notice[], next: readonly Notice[], shownId: string | null): string | null {
  if (next.length === 0) return null
  const shownAt = next.findIndex((notice) => notice.id === shownId)
  if (shownAt === -1) return next[0].id
  const before = new Map(previous.map((notice) => [notice.id, notice.due]))
  const arrived = next.findIndex((notice, index) => index < shownAt && before.get(notice.id) !== notice.due)
  return arrived === -1 ? next[shownAt].id : next[arrived].id
}

// Sentences joined as they are read, without doubling a full stop.
function sentences(...parts: string[]): string {
  return parts.filter(Boolean).map((part) => /[.!?…]$/.test(part) ? part : `${part}.`).join(' ')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** One notice as the island lays it out; `more` is how many others stand. */
export function noticeHtml(notice: Notice, more: number, now: number): string {
  const meta = noticeMeta(notice, now)
  const text = `<span class="ni-icon" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none">${ICONS[notice.kind]}</svg></span>`
    + `<span class="ni-text"><span class="ni-title">${escapeHtml(notice.title)}</span>${notice.body ? `<span class="ni-body">${escapeHtml(notice.body)}</span>` : ''}</span>`
    + (meta ? `<span class="ni-meta">${escapeHtml(meta)}</span>` : '')
  const main = notice.target
    ? `<button type="button" class="ni-main" data-action="open" aria-label="${escapeHtml(sentences(notice.title, notice.body, destination(notice.target)))}">${text}</button>`
    : `<span class="ni-main">${text}</span>`
  return main
    + '<span class="ni-actions">'
    + (notice.silenceable ? `<button type="button" class="ni-action" data-action="silence" aria-label="Silence reminders for this pull request">${ICON_SILENCE}</button>` : '')
    + (more > 0 ? `<button type="button" class="ni-action ni-more" data-action="next" aria-label="Show the next notification, ${more} more">+${more}</button>` : '')
    + `<button type="button" class="ni-action" data-action="dismiss" aria-label="Dismiss">${ICON_DISMISS}</button>`
    + '</span>'
}

export interface IslandActions {
  open(target: NoticeTarget): void
  /** Whether what a notice is about is on screen already, so it need not be shown. */
  inView?(target: NoticeTarget): boolean
}

const MAX_WIDTH = 560

export function mountNoticeIsland(feed: NoticeFeed, actions: IslandActions): () => void {
  const island = document.createElement('div')
  island.id = 'notice-island'
  island.setAttribute('role', 'region')
  island.setAttribute('aria-label', 'Notifications')
  island.hidden = true
  const shell = document.createElement('div')
  shell.className = 'ni-shell'
  island.append(shell)
  // Kept on the page while the island is hidden: a live region that appears
  // together with its first words is not announced.
  const live = document.createElement('div')
  live.className = 'ni-live'
  live.setAttribute('aria-live', 'polite')
  // First in the page, as it is first on screen.
  document.body.prepend(island, live)

  let notices: Notice[] = []
  let shownId: string | null = null
  let content: HTMLElement | null = null
  const announced = new Set<string>()

  function measure(el: HTMLElement): number {
    // Absolutely placed in the shell, so `width: max-content` is its natural width.
    el.style.width = 'max-content'
    const natural = Math.ceil(el.getBoundingClientRect().width)
    el.style.width = ''
    return Math.min(natural, MAX_WIDTH, document.documentElement.clientWidth - 24)
  }

  function announce(notice: Notice): void {
    const key = `${notice.id}@${notice.due}`
    if (announced.has(key)) return
    announced.add(key)
    live.textContent = `Notification: ${sentences(notice.title, notice.body)}`
  }

  // New words for the notice already shown, keeping keyboard focus on the
  // control it was on.
  function refresh(el: HTMLElement, html: string): void {
    if (el.dataset.html === html) return
    const focused = el.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined
    patchContent(el, html)
    el.dataset.html = html
    if (focused) el.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus()
    shape(measure(el), true)
  }

  function render(): void {
    const shown = notices.find((notice) => notice.id === shownId)
    if (!shown) {
      hide()
      return
    }
    const html = noticeHtml(shown, notices.length - 1, Date.now())
    if (content && content.dataset.id === shown.id && island.dataset.state === 'shown') {
      const reminder = content.dataset.due !== shown.due
      content.dataset.due = shown.due
      refresh(content, html)
      if (reminder) {
        announce(shown)
        island.classList.remove('ni-remind')
        void island.offsetWidth
        island.classList.add('ni-remind')
      }
      return
    }
    announce(shown)
    swap(shown, html)
  }

  function shape(width: number, shown: boolean): void {
    spring(shell, 'shape', { from: { width: shell.getBoundingClientRect().width, opacity: Number(getComputedStyle(shell).opacity) },
      to: { width, opacity: shown ? 1 : 0 },
      write: ({ width, opacity }) => { shell.style.width = `${Math.max(0, width)}px`; shell.style.opacity = String(Math.max(0, Math.min(1, opacity))) },
      complete: () => {
        if (!shown) { island.hidden = true; island.dataset.state = ''; shell.replaceChildren(); content = null }
        cancelMotion(shell, 'shape')
      } })
  }

  function swap(notice: Notice, html: string): void {
    const appearing = island.hidden
    const next = document.createElement('div')
    next.className = 'ni-content'
    next.dataset.id = notice.id; next.dataset.due = notice.due; next.dataset.kind = notice.kind; next.dataset.html = html
    next.innerHTML = html
    island.hidden = false
    island.classList.remove('ni-remind')
    const previous = content
    const hadFocus = !!previous?.contains(document.activeElement)
    shell.append(next)
    content = next
    if (previous) {
      previous.classList.add('ni-leaving'); previous.inert = true; previous.setAttribute('aria-hidden', 'true')
      spring(previous, 'entry', { from: { opacity: Number(getComputedStyle(previous).opacity), y: previous.getBoundingClientRect().top - shell.getBoundingClientRect().top }, to: { opacity: 0, y: -8 },
        write: ({ opacity, y }) => { previous.dataset.flowEnter = ''; previous.style.opacity = String(Math.max(0, Math.min(1, opacity))); previous.style.setProperty('--flow-enter-y', `${y}px`) },
        complete: () => { previous.remove(); cancelMotion(previous, 'entry') } })
    }
    if (appearing) { shell.style.width = '28px'; shell.style.opacity = '0' }
    island.dataset.state = 'shown'
    shape(measure(next), true)
    reveal(next, { distance: 8 })
    if (hadFocus) next.querySelector<HTMLElement>('[data-action="dismiss"]')?.focus({ preventScroll: true })
  }

  function hide(): void {
    shownId = null
    if (island.hidden || island.dataset.state === 'leaving') return
    const hadFocus = island.contains(document.activeElement)
    content?.classList.add('ni-leaving'); content?.setAttribute('inert', ''); content?.setAttribute('aria-hidden', 'true')
    island.dataset.state = 'leaving'
    shape(28, false)
    if (hadFocus) (document.activeElement as HTMLElement | null)?.blur()
  }

  function update(state: NoticesState): void {
    const previous = notices
    notices = state.enabled ? state.notices.filter((notice) => !notice.target || !actions.inView?.(notice.target)) : []
    shownId = chooseShown(previous, notices, shownId)
    render()
  }

  island.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]')
    const shown = notices.find((notice) => notice.id === shownId)
    if (!button || !shown || button.closest('.ni-leaving')) return
    const action = button.dataset.action
    if (action === 'next') {
      shownId = notices[(notices.indexOf(shown) + 1) % notices.length].id
      render()
      return
    }
    if (action === 'open' && shown.target) actions.open(shown.target)
    if (action === 'silence') void feed.silence(shown.id)
    else void feed.dismiss(shown.id)
  })

  // A reminder's "for N min" keeps counting between reads.
  const clock = window.setInterval(() => { if (content && shownId) render() }, 30_000)
  // A narrower window, or a phone turned, narrows the pill with it.
  let fitting = 0
  const fit = () => {
    cancelAnimationFrame(fitting)
    fitting = requestAnimationFrame(() => {
      if (content && island.dataset.state === 'shown') { shape(measure(content), true); finishMotion(shell) }
    })
  }
  window.addEventListener('resize', fit)
  const unsubscribe = feed.subscribe(update)
  update(feed.current)
  return () => {
    unsubscribe()
    window.clearInterval(clock)
    window.removeEventListener('resize', fit)
    cancelAnimationFrame(fitting)
    finishMotion(island)
    island.remove()
    live.remove()
  }
}
