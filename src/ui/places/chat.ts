// Chat (#556 PR 3): every function of classic's Chat, on classic's own modules
// (places/chat/view.ts wires them as src/views/chat-view.ts does), in the new
// interface's tokens. Its view lives for the page's life, as classic's does:
// leaving moves it off screen, so a running turn keeps folding in and
// returning is immediate.
import './chat/classic.css'
import './chat/chat.css'
import { $ } from '../dom'
import { routeBack } from '../shell'
import { takeOpenChat } from '../open-chat'
import type { MountPlace } from '../router'
import { initChatView, openChatForSubject, openChatSession, stopChatRefresh } from './chat/view'
import { loadSettings } from '../../config'
import { installIconTooltips } from '../../icon-tooltips'

let viewEl: HTMLElement | null = null
let keep: HTMLElement | null = null

/** The one chat view, created once and kept while the page lives. */
export function chatView(): HTMLElement {
  if (!viewEl) {
    viewEl = document.createElement('section')
    viewEl.id = 'view-chat'
    viewEl.className = 'view'
    // Classic's icon buttons explain themselves with classic's own tooltips.
    installIconTooltips(viewEl)
  }
  return viewEl
}

async function openRequested(chat: string | null): Promise<void> {
  const request = takeOpenChat()
  if (request?.id) await openChatSession(request.id)
  else if (request?.subject) await openChatForSubject(request.subject, request.prefill, request.draft)
  else if (chat) await openChatSession(chat)
}

/** Mounts the chat view under the place; returns what to do as it leaves. */
export async function mountChatView(root: HTMLElement, signal: AbortSignal, place: 'chat' | 'manager'): Promise<() => void> {
  const main: HTMLElement = $('main', root)
  const view = chatView()
  main.append(view)
  view.hidden = false
  view.dataset.place = place
  // Times are on Poise's clock, in Settings' time zone, as classic reads them.
  await loadSettings().catch(() => undefined)
  await initChatView()
  document.addEventListener('poise:open-chat-pending', () => { void openRequested(null) }, { signal })
  return () => {
    stopChatRefresh()
    view.hidden = true
    if (!keep) {
      keep = Object.assign(document.createElement('div'), { hidden: true })
      keep.dataset.chatKeep = ''
      document.body.append(keep)
    }
    keep.append(view)
  }
}

export const mount: MountPlace = async ({ root, address, query, signal }) => {
  root.innerHTML = '<main class="chat-place"><a class="back chat-back" href="#" data-back hidden data-ref="back"></a></main>'
  routeBack($('[data-back]', root), address)
  const leave = await mountChatView(root, signal, 'chat')
  await openRequested(query.get('chat'))
  return leave
}
