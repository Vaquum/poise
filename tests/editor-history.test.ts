import { describe, expect, it } from 'vitest'
import { editorHistoryKey, HISTORY_LIMIT, readEditorHistory, writeEditorHistory, type EditorHistorySnapshot } from '../src/editor-history'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}
const entry = (text: string) => ({ text, line: 0, offset: text.length })
const snapshot = (): EditorHistorySnapshot => ({ version: 1, current: entry('second'), undo: [entry('first')], redo: [entry('third')] })

describe('persistent editor history', () => {
  it('retains both stacks and caret across a new reader, separately for each document', () => {
    const store = storage()
    writeEditorHistory(store, 'notes', snapshot())
    expect(readEditorHistory(store, 'other', 'second')).toBeNull()
    expect(readEditorHistory(store, 'notes', 'second')).toEqual(snapshot())
    expect(readEditorHistory(store, 'notes', 'second')).toEqual(snapshot())
  })

  it('discards external edits permanently instead of reviving a stale timeline later', () => {
    const store = storage()
    writeEditorHistory(store, 'notes', snapshot())
    expect(readEditorHistory(store, 'notes', 'external edit')).toBeNull()
    expect(readEditorHistory(store, 'notes', 'second')).toBeNull()
  })

  it.each([
    '{',
    JSON.stringify({ ...snapshot(), version: 2 }),
    JSON.stringify({ ...snapshot(), undo: [{ text: 'bad', line: -1, offset: 0 }] }),
    JSON.stringify({ ...snapshot(), redo: [{ text: 'bad', line: 0, offset: '0' }] }),
    JSON.stringify({ ...snapshot(), undo: Array.from({ length: HISTORY_LIMIT + 1 }, () => entry('too many')) }),
  ])('rejects malformed or unsupported storage: %s', (raw) => {
    const store = storage()
    store.setItem(editorHistoryKey('notes'), raw)
    expect(readEditorHistory(store, 'notes', 'second')).toBeNull()
    expect(store.getItem(editorHistoryKey('notes'))).toBeNull()
  })

  it('removes an old timeline when there are no steps', () => {
    const store = storage()
    writeEditorHistory(store, 'notes', snapshot())
    writeEditorHistory(store, 'notes', { ...snapshot(), undo: [], redo: [] })
    expect(store.getItem(editorHistoryKey('notes'))).toBeNull()
  })

  it('reports denied or incomplete writes so updates can wait', () => {
    const store = storage()
    expect(() => writeEditorHistory({ ...store, setItem: () => { throw new Error('quota') } }, 'notes', snapshot())).toThrow('quota')
    expect(() => writeEditorHistory({ ...store, setItem: () => {} }, 'notes', snapshot())).toThrow('complete snapshot')
  })
})
