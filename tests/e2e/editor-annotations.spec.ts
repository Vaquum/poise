import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'

const VERSION = 'e'.repeat(64)
const AT = '2026-10-21T08:00:00Z'
const TEXT = 'First line\nSecond line'

// One document, TEXT. Annotation saves are kept, as the server keeps them.
async function editor(page: Page, stored: unknown[]) {
  await workspace(page)
  let annotations = stored
  await page.route('**/api/editor/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/editor/docs') return route.fulfill({ json: { docs: [{ slug: 'notes', title: 'Notes', updated_at: AT, size: TEXT.length }] } })
    if (path.endsWith('/annotations')) {
      if (request.method() !== 'PUT') return route.fulfill({ json: { annotations, version: VERSION } })
      annotations = (request.postDataJSON() as { annotations: unknown[] }).annotations
      return route.fulfill({ json: { ok: true, version: VERSION } })
    }
    if (path.endsWith('/reviews')) return route.fulfill({ json: { reviews: [], problems: [], checkedAt: null, active: false, stale: false } })
    return route.fulfill({ json: { slug: 'notes', content: TEXT, version: VERSION } })
  })
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(page.locator('#editor-doc .editor-line')).toHaveText(['First line', 'Second line'])
}

// One underline on each of the two lines the annotation covers.
async function expectMarksOnBothLines(page: Page) {
  const marks = page.locator('.annotation-mark')
  await expect(marks.first()).toBeVisible()
  expect(new Set(await marks.evaluateAll((els) => els.map((el) => (el as HTMLElement).style.top))).size).toBe(2)
  return marks
}

test('draws a stored multi-line annotation and opens its note from its mark', async ({ page }) => {
  // A selection across lines stores its snippet with the lines joined by '\n'.
  // The session id has the bound shape, so opening the note re-mints nothing.
  await editor(page, [{ id: 'ann-1', session_id: 'editor-notes-1760000000000123', range: { start_line: 0, start_offset: 6, end_line: 1, end_offset: 6 }, snippet: 'line\nSecond', comment: 'Spans two lines', created_at: AT, updated_at: AT }])
  const marks = await expectMarksOnBothLines(page)
  await marks.last().click()
  await expect(page.locator('.editor-annotation-text')).toHaveValue('Spans two lines')
})

test('keeps a multi-line annotation made from a selection and reopens it after its panel closes', async ({ page }) => {
  await editor(page, [])
  const doc = page.locator('#editor-doc')
  await doc.focus()
  await doc.press('ControlOrMeta+a')
  await page.getByRole('button', { name: 'Add comment', exact: true }).click()
  const note = page.locator('.editor-annotation-text')
  await note.fill('Covers both lines')
  await page.keyboard.press('Escape')
  await expect(note).toBeHidden()
  const marks = await expectMarksOnBothLines(page)
  await marks.last().click()
  await expect(note).toHaveValue('Covers both lines')
})
