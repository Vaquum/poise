// The Manager place (#556 PR 3): the Manager's chat beside the Switchboard,
// on Chat's view (places/chat.ts), reached from Chat and from Settings →
// Manager's controls.
import { $ } from '../dom'
import { routeBack, toast } from '../shell'
import type { MountPlace } from '../router'
import { mountChatView } from './chat'
import { openManagerChat, openSwitchboardPane } from './chat/view'

export const mount: MountPlace = async ({ root, address, signal }) => {
  root.innerHTML = '<main class="chat-place is-manager"><a class="back chat-back" href="#" data-back hidden data-ref="back"></a></main>'
  routeBack($('[data-back]', root), address)
  const leave = await mountChatView(root, signal, 'manager')
  const found = await openManagerChat()
  openSwitchboardPane()
  if (!found) toast('There is no Manager yet. New chat offers Manager; the Switchboard works without one.')
  return leave
}
