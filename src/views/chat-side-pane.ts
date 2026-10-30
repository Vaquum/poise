// A subject's Chat session beside Current or the Editor: one session surface
// inside #chat-side-pane. Per-subject toggle, per-subject drafts kept while
// the page lives, Open in Chat, and Back for a thread moved in from the text.
import type { ChatSubject } from '../../server/chat/protocol'
import type { ComposerDraft } from './chat-composer'
import { mountSessionSurface, type SessionSurface, type SurfaceOptions } from './chat-session-surface'

const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

function subjectKey(subject: ChatSubject): string {
  return `${subject.surface}:${subject.key}`
}

/** Unsent drafts by subject, while the page lives. */
const drafts = new Map<string, ComposerDraft>()

/** Editor wiring for Editor subjects, registered once by the Editor view. A
 *  factory because edit cards bind to the mounted subject's document. */
let editorSurfaceFor: ((subject: ChatSubject) => Pick<SurfaceOptions, 'edits' | 'beforeSend'>) | null = null

export function registerEditorSurface(factory: (subject: ChatSubject) => Pick<SurfaceOptions, 'edits' | 'beforeSend'>): void {
  editorSurfaceFor = factory
}

let panelEl: HTMLElement | null = null
let titleEl: HTMLElement | null = null
let stateEl: HTMLElement | null = null
let backEl: HTMLButtonElement | null = null
let surfaceEl: HTMLElement | null = null
let surface: SessionSurface | null = null
let current: ChatSubject | null = null
let prefill: string | undefined = undefined
let back: (() => void) | undefined = undefined
let lastStatus: string | null = null

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
    + '<button type="button" class="chat-pane-back" hidden></button>'
    + '<button type="button" class="chat-pane-open">Open in Chat</button>'
    + `<button class="chat-close" aria-label="Close chat">${ICON_CLOSE}</button></header>`
    + '<div class="chat-side-surface"></div>'
  document.body.appendChild(panelEl)
  titleEl = panelEl.querySelector('.chat-title')!
  stateEl = panelEl.querySelector('.chat-pane-state')!
  backEl = panelEl.querySelector('.chat-pane-back')!
  surfaceEl = panelEl.querySelector('.chat-side-surface')!
  panelEl.querySelector('.chat-close')!.addEventListener('click', () => chatSidePane.close())
  backEl.addEventListener('click', () => back?.())
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
    lastStatus = status
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

function openPane(next: ChatSubject, cardPrefill?: string, draft?: ComposerDraft | null, onBack?: () => void): void {
  ensureShell()
  if (surface && current && subjectKey(current) !== subjectKey(next)) closePane()
  current = next
  prefill = cardPrefill
  back = onBack
  lastStatus = null
  if (titleEl) titleEl.textContent = next.label
  if (stateEl) stateEl.textContent = ''
  if (backEl) {
    backEl.hidden = !onBack
    backEl.textContent = next.surface === 'editor-review' ? 'Back to the review' : 'Back to the passage'
  }
  panelEl!.classList.add('open')
  panelEl!.removeAttribute('inert')
  panelEl!.removeAttribute('aria-hidden')
  if (!surface && surfaceEl) {
    const kept = draft === undefined ? drafts.get(subjectKey(next)) : draft
    const editor = next.surface === 'current' ? null : editorSurfaceFor?.(next)
    surface = mountSessionSurface(surfaceEl, {
      subject: next,
      ...(kept ? { draft: kept } : cardPrefill ? { prefill: cardPrefill } : {}),
      ...(editor || {}),
    })
  }
  surface?.focus()
}

function closePane(): void {
  if (!panelEl) return
  if (panelEl.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur()
  const sessionId = surface?.session() ?? null
  const status = lastStatus
  const afterSeq = surface?.lastSeq() ?? 0
  const pendingRequests = sessionId ? surface?.pendingRequests() : undefined
  const draft = surface?.takeDraft() ?? null
  teardownSurface()
  const was = current
  current = null
  prefill = undefined
  back = undefined
  lastStatus = null
  panelEl.classList.remove('open')
  panelEl.setAttribute('inert', '')
  panelEl.setAttribute('aria-hidden', 'true')
  if (was) window.dispatchEvent(new CustomEvent('chat:side-pane-closed', { detail: { subject: was, sessionId, status, afterSeq, pendingRequests, draft } }))
}

export const chatSidePane = {
  toggle(target: { subject: ChatSubject, prefill?: string, draft?: ComposerDraft | null, back?: () => void }): void {
    ensureShell()
    if (isOpen() && current && subjectKey(current) === subjectKey(target.subject)) closePane()
    else openPane(target.subject, target.prefill, target.draft, target.back)
  },
  close(): void {
    closePane()
  },
  sessionInView(): string | null {
    return isOpen() ? surface?.session() ?? null : null
  },
  /** The subject on screen, for the Editor's highlight rule. */
  subjectInView(): ChatSubject | null {
    return isOpen() ? current : null
  },
  setHighlight(text: string | null): void {
    surface?.setHighlight(text)
  },
  takeDraft(): ComposerDraft | null {
    return surface?.takeDraft() ?? null
  },
}
