// Settings → Extensions (#556; SETTINGS.md, X1–X28): classic's Extensions view,
// copied without its stylesheet (classic/extensions-view.ts), unchanged in
// what it holds: the servers by workspace, the directory and servers of your own.
import { initExtensionsView, stopExtensionsRefresh } from './classic/extensions-view'
import { keptView, putAway } from './keep'
import type { SectionDef } from './types'

export const EXTENSIONS: SectionDef = {
  key: 'extensions',
  name: 'Extensions',
  what: 'The MCP servers chats can use: which workspaces each is on, the directory with Poise’s built-in servers, and servers of your own.',
  findText: 'extensions mcp server servers directory registry oauth sign in tools workspace custom',
  mount: (body) => {
    const { el } = keptView('view-extensions')
    el.hidden = false
    body.append(el)
    initExtensionsView()
    return () => { stopExtensionsRefresh(); putAway(el) }
  },
}
