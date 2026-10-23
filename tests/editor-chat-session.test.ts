import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type EditorModule = typeof import('../server/editor')

let editor: EditorModule
let editorDir: string
let previousEditorDir: string | undefined

beforeAll(async () => {
  editorDir = await mkdtemp(join(tmpdir(), 'poise-editor-chat-session-test-'))
  previousEditorDir = process.env.POISE_EDITOR_DIR
  process.env.POISE_EDITOR_DIR = editorDir
  editor = await import('../server/editor')
})

afterAll(async () => {
  if (previousEditorDir === undefined) delete process.env.POISE_EDITOR_DIR
  else process.env.POISE_EDITOR_DIR = previousEditorDir
  await rm(editorDir, { recursive: true, force: true })
})

// The legacy per-doc conversation id lives in a side-car the Editor used to
// mint. Nothing mints one anymore; the lookup stays read-only so a doc's
// first Chat session can import its earlier conversation.
describe('editor legacy chat session', () => {
  it("reads a document's legacy chat id without minting one", async () => {
    expect(await editor.peekChatSession('untouched')).toBeNull()
    expect(existsSync(join(editorDir, 'untouched.chat.json'))).toBe(false)
    await writeFile(join(editorDir, 'brief.chat.json'), JSON.stringify({ session_id: 'editor-brief-1769500000000', created_at: '2026-10-20T10:00:00.000Z' }))
    expect(await editor.peekChatSession('brief')).toBe('editor-brief-1769500000000')
    await writeFile(join(editorDir, 'broken.chat.json'), '{oops')
    expect(await editor.peekChatSession('broken')).toBeNull()
    await writeFile(join(editorDir, 'empty.chat.json'), JSON.stringify({ session_id: '', created_at: '2026-10-20T10:00:00.000Z' }))
    expect(await editor.peekChatSession('empty')).toBeNull()
  })
})
