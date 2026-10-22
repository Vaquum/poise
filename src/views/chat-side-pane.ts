// A card's Chat session beside Current: one session surface inside
// #chat-side-pane, styled by the #chat-panel rules until #370 removes the
// legacy pane. Per-card toggle, per-subject drafts kept while the page
// lives, and Open in Chat, as the legacy pane.
import type { ChatSubject } from '../../server/chat/protocol'
import type { ComposerDraft } from './chat-composer'
import { mountSessionSurface, type SessionSurface } from './chat-session-surface'

const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

function subjectKey(subject: ChatSubject): string {
  return `${subject.surface}:${subject.key}`
}

/** Unsent drafts by subject, while the page lives. */
const drafts = new Map<string, ComposerDraft>()

let panelEl: HTMLElement | null = null
let titleEl: HTMLElement | null = null
let stateEl: HTMLElement | null = null
let surfaceEl: HTMLElement | null = null
let surface: SessionSurface | null = null
let current: ChatSubject | null = null
let prefill: string | undefined = undefined

function isOpen(): boolean {
  return !!panelEl?.classList.contains('open')
}

function ensureShell(): void {
  if (panelEl) return
  panelEl = document.createElement('aside')
  panelEl.id = 'chat-side-pane'
  panelEl.setAttribute('inert', '')
  panelEl.setAttribute('aria-hidden', 'true')
  panelEl.innerHTML = '<header class="chat-header"><span class="chat-title"></span>'
    + '<span class="chat-pane-state" aria-live="polite"></span>'
    + '<button type="button" class="chat-pane-open">Open in Chat</button>'
    + `<button class="chat-close" aria-label="Close chat">${ICON_CLOSE}</button></header>`
    + '<div class="chat-side-surface"></div>'
  document.body.appendChild(panelEl)
  titleEl = panelEl.querySelector('.chat-title')!
  stateEl = panelEl.querySelector('.chat-pane-state')!
  surfaceEl = panelEl.querySelector('.chat-side-surface')!
  panelEl.querySelector('.chat-close')!.addEventListener('click', () => chatSidePane.close())
  panelEl.querySelector('.chat-pane-open')!.addEventListener('click', () => {
    if (!current) return
    const draft = surface?.takeDraft()
    window.dispatchEvent(new CustomEvent('poise:open-chat-session', {
      detail: { subject: current, ...(prefill ? { prefill } : {}), ...(draft ? { draft } : {}) },
    }))
  })
  panelEl.addEventListener('chat:surface-state', ((event: CustomEvent<{ sessionId: string | null, status: string | null }>) => {
    if (!stateEl) return
    const status = event.detail.status
    stateEl.textContent = status && status !== 'idle' ? status : ''
  }) as EventListener)
}

function teardownSurface(): void {
  if (surface && current) {
    const draft = surface.takeDraft()
    if (draft) drafts.set(subjectKey(current), draft)
    else drafts.delete(subjectKey(current))
  }
  surface?.destroy()
  surface = null
  if (surfaceEl) surfaceEl.innerHTML = ''
}

function openPane(next: ChatSubject, cardPrefill?: string): void {
  ensureShell()
  if (surface && current && subjectKey(current) !== subjectKey(next)) teardownSurface()
  current = next
  prefill = cardPrefill
  if (titleEl) titleEl.textContent = next.label
  if (stateEl) stateEl.textContent = ''
  panelEl!.classList.add('open')
  panelEl!.removeAttribute('inert')
  panelEl!.removeAttribute('aria-hidden')
  if (!surface && surfaceEl) {
    const kept = drafts.get(subjectKey(next))
    surface = mountSessionSurface(surfaceEl, kept ? { subject: next, draft: kept } : { subject: next, prefill: cardPrefill })
  }
  surface?.focus()
}

function closePane(): void {
  if (!panelEl) return
  if (panelEl.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur()
  teardownSurface()
  current = null
  prefill = undefined
  panelEl.classList.remove('open')
  panelEl.setAttribute('inert', '')
  panelEl.setAttribute('aria-hidden', 'true')
}

export const chatSidePane = {
  toggle(target: { subject: ChatSubject, prefill?: string }): void {
    ensureShell()
    if (isOpen() && current && subjectKey(current) === subjectKey(target.subject)) closePane()
    else openPane(target.subject, target.prefill)
  },
  close(): void {
    closePane()
  },
  sessionInView(): string | null {
    return isOpen() ? surface?.session() ?? null : null
  },
}
