// Tab-local history survives a release reload without sharing undo between tabs.
export interface EditorHistoryEntry {
  text: string
  line: number
  offset: number
}

export interface EditorHistorySnapshot {
  version: 1
  current: EditorHistoryEntry
  undo: EditorHistoryEntry[]
  redo: EditorHistoryEntry[]
}

export const HISTORY_LIMIT = 300
export const editorHistoryKey = (slug: string): string => `poise-editor-history:${slug}`

type HistoryStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isEntry(value: unknown): value is EditorHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.text === 'string'
    && Number.isSafeInteger(entry.line) && (entry.line as number) >= 0
    && Number.isSafeInteger(entry.offset) && (entry.offset as number) >= 0
}

function isStack(value: unknown): value is EditorHistoryEntry[] {
  return Array.isArray(value) && value.length <= HISTORY_LIMIT && value.every(isEntry)
}

export function readEditorHistory(store: HistoryStore, slug: string, text: string): EditorHistorySnapshot | null {
  const raw = store.getItem(editorHistoryKey(slug))
  if (!raw) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { value = null }
  if (value && typeof value === 'object') {
    const snapshot = value as Record<string, unknown>
    if (snapshot.version === 1 && isEntry(snapshot.current) && snapshot.current.text === text
        && isStack(snapshot.undo) && isStack(snapshot.redo)) {
      return { version: 1, current: snapshot.current, undo: snapshot.undo, redo: snapshot.redo }
    }
  }
  // An external edit invalidates the timeline; never revive it on a later load.
  store.removeItem(editorHistoryKey(slug))
  return null
}

export function writeEditorHistory(store: HistoryStore, slug: string, snapshot: EditorHistorySnapshot): void {
  const key = editorHistoryKey(slug)
  if (!snapshot.undo.length && !snapshot.redo.length) {
    store.removeItem(key)
    return
  }
  const raw = JSON.stringify(snapshot)
  store.setItem(key, raw)
  if (store.getItem(key) !== raw) throw new Error('Editor history storage did not retain the complete snapshot')
}
