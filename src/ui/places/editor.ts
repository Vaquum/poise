// The Editor (#556 PR 3): classic's Editor, every function of it, on its own
// module (src/views/editor-view.ts, which fits the reuse rule), in the new
// interface's tokens. Its view lives for the page's life, as classic's does,
// so a save queued as you leave still lands and returning keeps the draft,
// the selection and the undo history.
import './editor/classic.css'
import './editor/editor.css'
import './chat/classic.css'
import './chat/chat.css'
import { $ } from '../dom'
import { routeBack } from '../shell'
import { takeEditorDoc } from '../intents'
import type { MountPlace } from '../router'
import { initEditorView, stopEditorRefresh } from '../../views/editor-view'
import { chatSidePane } from '../../views/chat-side-pane'
import { loadSettings } from '../../config'
import { installIconTooltips } from '../../icon-tooltips'

let viewEl: HTMLElement | null = null
let keep: HTMLElement | null = null

export const mount: MountPlace = async ({ root, address, query }) => {
  root.innerHTML = '<main class="editor-place"><a class="back editor-back" href="#" data-back hidden data-ref="back"></a></main>'
  // This mount's own route back, taken before any wait: a newer place may own the root by then.
  const back: HTMLAnchorElement = $('[data-back]', root)
  routeBack(back, address)
  if (!viewEl) {
    viewEl = document.createElement('section')
    viewEl.id = 'view-editor'
    viewEl.className = 'view'
    installIconTooltips(viewEl)
  }
  $('main', root).append(viewEl)
  viewEl.hidden = false
  await loadSettings().catch(() => undefined)
  await initEditorView()
  // The route back sits first in the Editor's own header, never over its controls.
  viewEl.querySelector(':scope > .view-header')?.prepend(back)
  // A document another place asked for opens once the Editor is up.
  const slug = query.get('doc')
  const doc = takeEditorDoc() ?? (slug ? { slug } : null)
  if (doc) window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail: doc }))
  return () => {
    back.remove()
    stopEditorRefresh()
    // As classic's views do on leaving: the document chat closes, releasing its
    // hold on the chat, so Chat reads the conversation whole if it opens next.
    chatSidePane.close()
    if (!viewEl) return
    viewEl.hidden = true
    if (!keep) {
      keep = Object.assign(document.createElement('div'), { hidden: true })
      keep.dataset.editorKeep = ''
      document.body.append(keep)
    }
    keep.append(viewEl)
  }
}
