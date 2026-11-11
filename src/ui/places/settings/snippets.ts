// Settings → Snippets (#556; SETTINGS.md, S1–S8): classic's Snippets view,
// embedded unchanged in what it holds, with the built-in /manager and /worker.
import { initSnippetsView } from '../../../views/snippets-view'
import { keptView, putAway } from './keep'
import type { SectionDef } from './types'

export const SNIPPETS: SectionDef = {
  key: 'snippets',
  name: 'Snippets',
  what: 'Text you reuse, in Chat and anywhere on your paired computers. Each is also a Chat skill; /manager and /worker are built in.',
  findText: 'snippet snippets espanso trigger skill /manager /worker standing instructions import',
  mount: async (body) => {
    const { el } = keptView('view-snippets')
    el.hidden = false
    body.append(el)
    await initSnippetsView()
    return () => putAway(el)
  },
}
