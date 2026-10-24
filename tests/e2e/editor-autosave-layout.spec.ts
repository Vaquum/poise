import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { installRoutes, installSocket, makeState } from './fixtures/chat'

// Issue #207: at widths between the 820px breakpoint and ~1000px the
// autosave status text (`Editing…` / `Saving…` / `N words · saved`) wrapped
// to a different number of lines per state, so the header grew and shrank
// and the editor jumped up and down by ~30px on every save. The status text
// no longer lives in the header (routine states are diagnostics, failures
// go to the notice feed's fixed overlay), so nothing in the bar may change
// size across a save cycle any more. This spec locks that: header height,
// published bar height and editor top stay put from typing through
// acknowledgement, including title edits (the picker label legitimately
// changes width) and failed saves.

const VERSION = 'd'.repeat(64)
const NOW = '2026-10-18T08:00:00Z'

type Geometry = { headerH: number, docTop: number, trigX: number, trigW: number, barH: string }

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const header = document.querySelector('#view-editor .view-header')!
    const doc = document.getElementById('editor-doc')!
    const trigger = document.querySelector('.editor-doc-trigger')!
    const h = header.getBoundingClientRect()
    const d = doc.getBoundingClientRect()
    const t = trigger.getBoundingClientRect()
    return {
      headerH: h.height,
      // Document-relative: caret scroll-into-view on short viewports moves
      // the viewport top without any layout shift.
      docTop: d.top + window.scrollY,
      trigX: t.x,
      trigW: t.width,
      barH: getComputedStyle(document.documentElement).getPropertyValue('--app-bar-h').trim(),
    }
  })
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values)
}

async function openEditor(page: Page, title: string, put: 'ok' | 'fail') {
  const state = makeState([], {})
  state.forbidLegacyChat = true
  await installSocket(page, state)
  await workspace(page, 'current')
  await installRoutes(page, state)
  let content = `# ${title}\n\n${'word '.repeat(100).trim()}`
  let saves = 0
  let completed = 0
  let gate: Promise<void> | null = null
  let releaseGate: (() => void) | null = null
  await page.route('**/api/editor/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/editor/docs') {
      return route.fulfill({ json: { docs: [{ slug: 'draft', title, updated_at: NOW, size: content.length }] } })
    }
    if (path === '/api/editor/doc/draft' && request.method() === 'GET') {
      return route.fulfill({ json: { slug: 'draft', title, content, updated_at: NOW, version: VERSION } })
    }
    if (path === '/api/editor/doc/draft' && (request.method() === 'PUT' || request.method() === 'POST')) {
      saves += 1
      content = String((request.postDataJSON() as Record<string, unknown>).content)
      if (gate) await gate
      if (put === 'fail') return route.fulfill({ status: 500, json: { error: 'boom' } })
      const firstLine = content.split('\n')[0].replace(/^#\s*/, '')
      await route.fulfill({ json: { slug: 'draft', title: firstLine || title, content, updated_at: NOW, version: VERSION } })
      completed += 1
      return
    }
    if (path.endsWith('/annotations')) return route.fulfill({ json: { annotations: [], version: VERSION } })
    if (path.endsWith('/google/sync')) return route.fulfill({ json: { publications: [], version: VERSION } })
    if (path.endsWith('/reviews') || path.endsWith('/reviews/sync')) {
      return route.fulfill({ json: { reviews: [], checkedAt: null, active: false, stale: false, problems: [] } })
    }
    return route.fulfill({ json: {} })
  })
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  const doc = page.locator('#editor-doc')
  await expect(doc).toContainText('word')
  return {
    doc,
    saveCount: () => saves,
    completedCount: () => completed,
    holdSaves() { gate = new Promise<void>((done) => { releaseGate = done }) },
    releaseSaves() { const release = releaseGate; gate = null; releaseGate = null; release?.() },
  }
}

type Editor = Awaited<ReturnType<typeof openEditor>>

// One full autosave cycle: rest, debounce pending, PUT in flight, save
// acknowledged. Returns one geometry sample per state.
async function saveCycle(page: Page, editor: Editor, edit: () => Promise<void>): Promise<Geometry[]> {
  const rest = await geometry(page)
  editor.holdSaves()
  await edit()
  await page.waitForTimeout(150)
  const debounced = await geometry(page)
  const before = editor.saveCount()
  await expect.poll(() => editor.saveCount(), { timeout: 10_000 }).toBeGreaterThan(before)
  const count = editor.saveCount()
  await page.waitForTimeout(150)
  const pending = await geometry(page)
  editor.releaseSaves()
  await expect.poll(() => editor.completedCount(), { timeout: 10_000 }).toBe(count)
  await page.waitForTimeout(400)
  const acked = await geometry(page)
  return [rest, debounced, pending, acked]
}

for (const title of ['A question', 'A deliberately lengthy document title that fills the picker']) {
  test(`autosave never moves the editor (${title.length <= 20 ? 'short' : 'long'} title)`, async ({ page }) => {
    const editor = await openEditor(page, title, 'ok')
    for (const width of [821, 900, 1000, 1280, 700, 390]) {
      await page.setViewportSize({ width, height: 800 })
      await page.waitForTimeout(400)
      // Body edit: nothing in the header changes at all.
      const body = await saveCycle(page, editor, async () => {
        await editor.doc.click()
        await page.keyboard.press('End')
        await page.keyboard.type(' x')
      })
      expect(spread(body.map((s) => s.headerH)), `header height at ${width}px`).toBeLessThanOrEqual(1)
      expect(spread(body.map((s) => s.docTop)), `editor top at ${width}px`).toBeLessThanOrEqual(1)
      expect(spread(body.map((s) => s.trigX)), `picker x at ${width}px`).toBeLessThanOrEqual(1)
      expect(spread(body.map((s) => s.trigW)), `picker width at ${width}px`).toBeLessThanOrEqual(1)
      expect(new Set(body.map((s) => s.barH)).size, `published bar height at ${width}px`).toBe(1)
      // Title edit: the picker label changes on acknowledgement, but the
      // header keeps its height and the editor keeps its place.
      const titled = await saveCycle(page, editor, async () => {
        await page.locator('#editor-doc .editor-line').first().click()
        await page.keyboard.press('End')
        await page.keyboard.type('!')
      })
      expect(spread(titled.map((s) => s.headerH)), `header height after title edit at ${width}px`).toBeLessThanOrEqual(1)
      expect(spread(titled.map((s) => s.docTop)), `editor top after title edit at ${width}px`).toBeLessThanOrEqual(1)
      expect(new Set(titled.map((s) => s.barH)).size, `published bar height after title edit at ${width}px`).toBe(1)
    }
  })
}

test('a failed autosave reaches the notice feed without moving the editor', async ({ page }) => {
  const editor = await openEditor(page, 'A question', 'fail')
  await page.setViewportSize({ width: 900, height: 800 })
  await page.waitForTimeout(400)
  const before = await geometry(page)
  await editor.doc.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' x')
  await expect.poll(() => editor.saveCount(), { timeout: 10_000 }).toBeGreaterThan(0)
  // The failure is real and surfaced: the bell counts it while the rail is
  // closed, and the rail card carries the message once opened.
  await expect(page.locator('#notification-bell')).toHaveAccessibleName('Notifications, 1 open', { timeout: 10_000 })
  await page.waitForTimeout(400)
  const after = await geometry(page)
  expect(Math.abs(after.headerH - before.headerH)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.docTop - before.docTop)).toBeLessThanOrEqual(1)
  expect(after.barH).toBe(before.barH)
  await page.locator('#notification-bell').click()
  await expect(page.locator('.nr-card').filter({ hasText: 'Save failed' })).toBeVisible()
})
