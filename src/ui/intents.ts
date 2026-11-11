// Requests classic's modules send to the page (src/main.ts routes them between
// classic's views); here each lands in the place that now holds it (#556).
import { loggingHref, type LoggingLink } from '../logging'
import { placeHref, readAddress, SECTIONS } from './address'

export interface EditorDoc { slug: string, session?: string }
let editorDoc: EditorDoc | null = null

/** The document a request asked the Editor to open, once. */
export function takeEditorDoc(): EditorDoc | null {
  const doc = editorDoc
  editorDoc = null
  return doc
}

const isSection = (value: unknown): value is string => (SECTIONS as readonly unknown[]).includes(value)

export function listenIntents(go: (href: string) => void): void {
  const on = <T>(type: string, handle: (detail: T) => void) =>
    window.addEventListener(type, (event) => { const detail = (event as CustomEvent<T>).detail; if (detail) handle(detail) })
  const back = () => readAddress(location.search).address.place

  // Chat's /content and its read-only edit cards open a document in the Editor.
  on<EditorDoc>('poise:open-editor-doc', (detail) => {
    if (!detail.slug) return
    if (back() === 'editor') { window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail })); return }
    editorDoc = { slug: detail.slug, ...(detail.session ? { session: detail.session } : {}) }
    go(placeHref('editor', { back: back() }))
  })
  for (const type of ['poise:open-settings', 'poise:logging-settings']) {
    on<{ section?: unknown }>(type, ({ section }) => go(placeHref('settings', { settings: isSection(section) ? section : null, back: back() })))
  }
  on<LoggingLink>('poise:open-logging', (link) => {
    const href = loggingHref(link)
    if (href) go(href.replace(/^\/\?/, '?'))
  })
  on<{ id?: unknown, after?: unknown }>('poise:open-chain-journal', ({ id, after }) => {
    if (typeof id !== 'string' || !Number.isSafeInteger(after)) return
    go(placeHref('observe', { part: 'tasks', chain: id, after: String(after), back: back() }))
  })
  on<{ id?: unknown }>('poise:goto-swarm-call', ({ id }) => {
    if (typeof id === 'string') go(placeHref('observe', { part: 'behaviors', call: id, back: back() }))
  })
  on<{ repo?: unknown, pr_id?: unknown }>('poise:goto-swarm-row', ({ repo, pr_id: pr }) => {
    if (typeof repo === 'string' && (typeof pr === 'string' || typeof pr === 'number')) go(placeHref('observe', { part: 'behaviors', pr: `${repo}#${pr}`, back: back() }))
  })
}
