import { expect, test, type Locator, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'

const VERSION = 'e'.repeat(64)
const AT = '2026-10-21T08:00:00Z'
const TEXT = 'First line\nSecond line'

// One document, `content`. Annotation saves are kept, as the server keeps
// them; the returned state exposes the last saved list for assertions.
async function editor(page: Page, stored: unknown[], content = TEXT) {
  await workspace(page)
  let annotations = stored
  const state = { saved: null as unknown[] | null }
  await page.route('**/api/editor/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/editor/docs') return route.fulfill({ json: { docs: [{ slug: 'notes', title: 'Notes', updated_at: AT, size: content.length }] } })
    if (path.endsWith('/annotations')) {
      if (request.method() !== 'PUT') return route.fulfill({ json: { annotations, version: VERSION } })
      annotations = (request.postDataJSON() as { annotations: unknown[] }).annotations
      state.saved = annotations
      return route.fulfill({ json: { ok: true, version: VERSION } })
    }
    if (path.endsWith('/reviews')) return route.fulfill({ json: { reviews: [], problems: [], checkedAt: null, active: false, stale: false } })
    return route.fulfill({ json: { slug: 'notes', content, version: VERSION } })
  })
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(page.locator('#editor-doc .editor-line')).toHaveText(content.split('\n'))
  return state
}

// One underline on each of the two lines the annotation covers.
async function expectMarksOnBothLines(page: Page, marks: Locator = page.locator('.annotation-mark')) {
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

test('re-finds single-line and multi-line annotations after a line is added above them', async ({ page }) => {
  // Both notes were recorded one line higher, before 'Intro' was added.
  const state = await editor(page, [
    { id: 'ann-1', session_id: 'editor-notes-1760000000000123', range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 5 }, snippet: 'First', comment: 'Single line', created_at: AT, updated_at: AT },
    { id: 'ann-2', session_id: 'editor-notes-1760000000000124', range: { start_line: 0, start_offset: 6, end_line: 1, end_offset: 6 }, snippet: 'line\nSecond', comment: 'Spans two lines', created_at: AT, updated_at: AT },
  ], 'Intro\nFirst line\nSecond line')
  // Both are drawn; the multi-line note covers two lines.
  await expect(page.locator('.annotation-mark[data-ann-id="ann-1"]')).toHaveCount(1)
  await expectMarksOnBothLines(page, page.locator('.annotation-mark[data-ann-id="ann-2"]'))
  // The save holds their new ranges.
  await expect.poll(() => state.saved?.map((a) => (a as { range: unknown }).range)).toEqual([
    { start_line: 1, start_offset: 0, end_line: 1, end_offset: 5 },
    { start_line: 1, start_offset: 6, end_line: 2, end_offset: 6 },
  ])
})

test('marks a note whose text is gone as Passage changed, and opens and deletes it', async ({ page }) => {
  const state = await editor(page, [
    { id: 'ann-1', session_id: 'editor-notes-1760000000000123', range: { start_line: 5, start_offset: 0, end_line: 6, end_offset: 4 }, snippet: 'Gone\ntext', comment: 'Left behind', created_at: AT, updated_at: AT },
  ])
  const mark = page.locator('.annotation-orphan')
  await expect(mark).toHaveCount(1)
  await expect(mark).toBeVisible()
  await expect(mark).toHaveAttribute('title', 'Passage changed: Left behind')
  // The mark sits on the last line and is narrower than half of it.
  const markBox = await mark.boundingBox()
  const lineBox = await page.locator('#editor-doc .editor-line').last().boundingBox()
  expect(markBox).not.toBeNull()
  expect(lineBox).not.toBeNull()
  expect(markBox!.y).toBeGreaterThanOrEqual(lineBox!.y - 1)
  expect(markBox!.y + markBox!.height).toBeLessThanOrEqual(lineBox!.y + lineBox!.height + 1)
  expect(markBox!.width).toBeLessThan(lineBox!.width / 2)
  // Clicking it opens the note with the Passage changed notice.
  await mark.click()
  await expect(page.locator('.editor-annotation-orphan')).toHaveText('Passage changed: the text this note was on is no longer in the document.')
  await expect(page.locator('.editor-annotation-text')).toHaveValue('Left behind')
  // Delete removes the mark and saves an empty list.
  await page.locator('.editor-annotation-delete').click()
  await expect(mark).toHaveCount(0)
  await expect.poll(() => state.saved).toEqual([])
})

test('keeps two orphaned notes on the same line separately clickable', async ({ page }) => {
  // Both passages are gone and both clamp to the last line.
  await editor(page, [
    { id: 'ann-1', session_id: 'editor-notes-1760000000000123', range: { start_line: 5, start_offset: 0, end_line: 6, end_offset: 4 }, snippet: 'Gone\ntext', comment: 'First orphan', created_at: AT, updated_at: AT },
    { id: 'ann-2', session_id: 'editor-notes-1760000000000124', range: { start_line: 7, start_offset: 0, end_line: 8, end_offset: 4 }, snippet: 'Lost\nwords', comment: 'Second orphan', created_at: AT, updated_at: AT },
  ])
  const marks = page.locator('.annotation-orphan')
  await expect(marks).toHaveCount(2)
  // Side by side, not stacked: each mark sits at its own offset.
  const lefts = await marks.evaluateAll((els) => els.map((el) => (el as HTMLElement).style.left))
  expect(new Set(lefts).size).toBe(2)
  // Each opens its own note.
  const note = page.locator('.editor-annotation-text')
  await marks.first().click()
  await expect(note).toHaveValue('First orphan')
  await page.keyboard.press('Escape')
  await expect(note).toBeHidden()
  await marks.last().click()
  await expect(note).toHaveValue('Second orphan')
})
