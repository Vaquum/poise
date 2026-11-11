// Asking to open a chat, from Board's cards, Overview's answers or a notice
// (`poise:open-chat-session`, as classic's views send it): the frame remembers
// the request and moves to Chat, which opens it as it mounts, since Chat may
// not be loaded yet.
import type { ChatSubject } from '../../server/chat/protocol'
import type { ComposerDraft } from '../views/chat-composer'
import { placeHref, readAddress, type Place } from './address'

export interface OpenChat { id?: string, subject?: ChatSubject, prefill?: string, draft?: ComposerDraft }

let pending: OpenChat | null = null

/** The request waiting for Chat, once. */
export function takeOpenChat(): OpenChat | null {
  const request = pending
  pending = null
  return request
}

export function listenOpenChat(go: (href: string) => void): void {
  window.addEventListener('poise:open-chat-session', (event) => {
    const detail = (event as CustomEvent<OpenChat>).detail
    if (!detail || (!detail.id && !detail.subject)) return
    pending = detail
    const here: Place = readAddress(location.search).address.place
    if (here === 'chat' || here === 'manager') document.dispatchEvent(new CustomEvent('poise:open-chat-pending'))
    else go(placeHref('chat', { back: here }))
  })
}
