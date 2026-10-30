import { expect, test, type Page, type Route } from '@playwright/test'
import { HISTORY_BYTE_BUDGET } from '../../src/editor-history'
import { settled } from './fixtures/motion'
import { feedback } from './fixtures/view-feedback'
import { workspace } from './fixtures/workspace'

// The Editor keeps whole-document undo snapshots; a large document must
// still save, switch and reopen with exact text, and any trimming or
// storage failure must stay visible instead of trapping navigation.

const VERSION = 'e'.repeat(64)
const NOW = '2026-10-14T08:00:00Z'

interface DocState {
  content: string
  saved: string | null
  saves: number
  failSaves: boolean
}

const makeDoc = (content: string): DocState => ({ content, saved: null, saves: 0, failSaves: false })

function docsRoute(docs: Record<string, DocState>) {
  return async (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (path === '/api/editor/docs' && req.method() === 'GET') {
      await route.fulfill({ json: { docs: Object.entries(docs).map(([slug, doc]) => ({ slug, title: slug, updated_at: NOW, size: doc.content.length })) } })
      return
    }
    const match = /^\/api\/editor\/doc\/([^/]+)(\/annotations)?$/.exec(path)
    if (match) {
      const doc = docs[match[1]]
      if (!doc) { await route.fulfill({ status: 404, json: {} }); return }
      if (match[2]) { await route.fulfill({ json: { annotations: [], version: VERSION } }); return }
      if (req.method() === 'GET') {
        await route.fulfill({ json: { slug: match[1], content: doc.content, version: VERSION, title: match[1] } })
        return
      }
      if (req.method() === 'PUT') {
        if (doc.failSaves) { await route.fulfill({ status: 500, json: { error: 'save failed' } }); return }
        doc.content = req.postDataJSON().content as string
        doc.saved = doc.content
        doc.saves++
        await route.fulfill({ json: { version: VERSION, title: match[1], updated_at: NOW, size: doc.content.length } })
        return
      }
    }
    await route.fulfill({ json: {} })
  }
}

async function openEditor(page: Page, docs: Record<string, DocState>): Promise<void> {
  await workspace(page)
  await settled(page)
  await page.route('**/api/editor/**', docsRoute(docs))
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
}

async function openDoc(page: Page, slug: string): Promise<void> {
  await page.locator('.editor-doc-trigger').click()
  await page.locator(`.editor-doc-item[data-slug="${slug}"]`).click()
}

async function typeAndSave(page: Page, doc: DocState, text: string): Promise<void> {
  const saves = doc.saves
  await page.locator('#editor-doc').press('ControlOrMeta+End')
  await page.keyboard.type(text)
  await expect.poll(() => doc.saves).toBeGreaterThan(saves)
}

async function persistedHistoryBytes(page: Page): Promise<{ key: string, bytes: number }[]> {
  return page.evaluate(() => {
    const found: { key: string, bytes: number }[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i) || ''
      if (key.startsWith('poise-editor-history:')) found.push({ key, bytes: (sessionStorage.getItem(key) || '').length })
    }
    return found
  })
}

test('a large document saves, switches away and reopens with exact text', async ({ page }) => {
  // The reported fixture: 2,802,818 bytes. Before the fix the single undo
  // step doubled it past the ~5 MB sessionStorage quota and the switch
  // away was refused; after the fix no timeline is persisted for the
  // oversized document and navigation proceeds with a notice.
  const fixture = '# Imported large\n' + ('x'.repeat(1000) + '\n').repeat(2800)
  const docs = { large: makeDoc(fixture), other: makeDoc('other') }
  await openEditor(page, docs)
  const doc = page.locator('#editor-doc')
  await expect(doc).toContainText('Imported large')
  await typeAndSave(page, docs.large, '!')
  expect(docs.large.saved).toBe(fixture + '!')
  // The oversized step cannot be retained: undo is a no-op, not a trap.
  const edited = await doc.innerText()
  await doc.press('ControlOrMeta+z')
  expect(await doc.innerText()).toBe(edited)
  expect(docs.large.saves).toBe(1)
  await openDoc(page, 'other')
  await expect(doc).toHaveText('other')
  await expect(await feedback(page)).toContainText('document too large for browser storage')
  expect(await persistedHistoryBytes(page)).toEqual([])
  // The reopened document is the exact saved text: a second edit saves
  // exactly on top of it.
  await openDoc(page, 'large')
  await expect(doc).toContainText('Imported large')
  await typeAndSave(page, docs.large, '?')
  expect(docs.large.saved).toBe(fixture + '!?')
})

test('forced storage exhaustion neither loses text nor blocks leaving a saved document', async ({ page }) => {
  const docs = { notes: makeDoc('original'), other: makeDoc('other') }
  await openEditor(page, docs)
  const doc = page.locator('#editor-doc')
  await expect(doc).toHaveText('original')
  await typeAndSave(page, docs.notes, ' first')
  expect(docs.notes.saved).toBe('original first')
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('poise-editor-history:')) throw new Error('storage full')
      original.call(this, key, value)
    }
  })
  await openDoc(page, 'other')
  await expect(doc).toHaveText('other')
  await expect(await feedback(page)).toContainText('Undo history could not be preserved')
  await openDoc(page, 'notes')
  await expect(doc).toHaveText('original first')
  // Unsaved text still refuses to be left behind silently: the existing
  // save guard asks, and dismissing keeps the text in place.
  const dialogs: string[] = []
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
  docs.notes.failSaves = true
  await doc.press('ControlOrMeta+End')
  await page.keyboard.type(' second')
  await openDoc(page, 'other')
  await expect.poll(() => dialogs.length).toBe(1)
  expect(dialogs[0]).toContain('could not be saved')
  await expect(doc).toHaveText('original first second')
})

test('repeated edits across documents stay within the history budget', async ({ page }) => {
  const docs = { alpha: makeDoc('alpha'), beta: makeDoc('beta') }
  await openEditor(page, docs)
  const doc = page.locator('#editor-doc')
  await expect(doc).toHaveText('alpha')
  await typeAndSave(page, docs.alpha, ' one')
  await typeAndSave(page, docs.alpha, ' two')
  expect(docs.alpha.saved).toBe('alpha one two')
  await openDoc(page, 'beta')
  await expect(doc).toHaveText('beta')
  await typeAndSave(page, docs.beta, ' uno')
  await openDoc(page, 'alpha')
  await expect(doc).toHaveText('alpha one two')
  const persisted = await persistedHistoryBytes(page)
  expect(persisted.length).toBe(2)
  for (const { bytes } of persisted) expect(bytes).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET)
  // Undo still walks the retained steps of this document only.
  await doc.press('ControlOrMeta+z')
  await expect(doc).toHaveText('alpha one')
  await doc.press('ControlOrMeta+z')
  await expect(doc).toHaveText('alpha')
  await openDoc(page, 'beta')
  await doc.press('ControlOrMeta+z')
  await expect(doc).toHaveText('beta')
})
