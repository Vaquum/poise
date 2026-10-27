import { expect, test, type Page } from '@playwright/test'
import { BEHAVIORS } from '../../src/behaviors'
import { workspace } from './fixtures/workspace'
import { feedback } from './fixtures/view-feedback'

const version = 'e'.repeat(64)

async function editor(page: Page) {
  await workspace(page)
  await page.route('**/api/repos', route => route.fulfill({ json: { repos: ['acme/project'] } }))
  await page.route('**/api/editor/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/editor/docs') return route.fulfill({ json: { docs: [{ slug: 'draft', title: 'Draft', size: 15, updated_at: new Date().toISOString() }] } })
    if (path.endsWith('/annotations')) return route.fulfill({ json: { annotations: [], version } })
    if (path.endsWith('/reviews')) return route.fulfill({ json: { reviews: [], problems: [], checkedAt: null, active: false, stale: false } })
    return route.fulfill({ json: { slug: 'draft', content: 'Keep this passage', version } })
  })
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  const doc = page.locator('#editor-doc')
  await expect(doc).toHaveText('Keep this passage')
  await doc.focus()
  await doc.press('ControlOrMeta+a')
}

test('independent Current draft failures remain accessible with notifications off', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/current', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { error: 'Write unavailable' } }) : route.fallback())
  for (const lane of ['Idea', 'Concept']) {
    await page.getByRole('button', { name: `Add a card to ${lane}`, exact: true }).click()
    const composer = page.locator(`.lane[data-lane="${lane.toLowerCase()}"] .composer`)
    await composer.locator('textarea').fill(`Keep ${lane}`)
    const failed = page.waitForResponse(response => response.url().endsWith('/api/current') && response.status() === 503)
    await composer.getByRole('button', { name: 'Add', exact: true }).click()
    await failed
  }
  const rail = await feedback(page)
  await expect(rail.locator('.nr-card').filter({ hasText: 'Current action needs attention' })).toHaveCount(2)
  await expect(page.locator('.nr-toast')).toHaveCount(0)
  await expect(page.locator('.lane[data-lane="idea"] .composer textarea')).toHaveValue('Keep Idea')
  await expect(page.locator('.lane[data-lane="concept"] .composer textarea')).toHaveValue('Keep Concept')
})

for (const kind of ['issue', 'snippet'] as const) test(`reading an Editor ${kind} failure preserves its unsaved composer`, async ({ page }) => {
  await editor(page)
  await page.route(kind === 'issue' ? '**/api/gh' : '**/api/snippets', route => route.fulfill({ status: 503, json: { error: 'Write unavailable' } }))
  await page.getByRole('button', { name: kind === 'issue' ? 'Create issue from selection' : 'Save selection as snippet', exact: true }).click()
  const composer = page.locator(`.editor-floating-composer.composer-${kind}`)
  const title = composer.locator(kind === 'issue' ? '.issue-title' : '.snippet-trigger')
  await title.fill(kind === 'issue' ? 'Keep issue title' : ';keep-draft')
  if (kind === 'issue') await composer.locator('.issue-repo').selectOption('acme/project')
  const body = composer.locator(kind === 'issue' ? '.issue-body' : '.snippet-body')
  await body.fill('Keep this unsaved body')
  await composer.getByRole('button', { name: kind === 'issue' ? 'Open issue' : 'Save snippet', exact: true }).click()
  const notice = await feedback(page, 'Editor action needs attention')
  await expect(notice).toContainText(kind === 'issue' ? '503' : 'Write unavailable')
  await notice.locator('.nr-card-head').click()
  await expect(composer).toBeVisible()
  await expect(title).toHaveValue(kind === 'issue' ? 'Keep issue title' : ';keep-draft')
  await expect(body).toHaveValue('Keep this unsaved body')
})

test('reading a Behavior memory conflict never retries or overwrites the other writer', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/behaviors', route => route.fulfill({ json: Object.fromEntries(BEHAVIORS.map(({ key }) => [key,
    { owner: 'review-bot', enabled: false, setting: 'p2', reviewers: 1, scratchpad: 'Original memory', repos: [], skipRepos: [], authors: [], lastTriggered: null },
  ])) }))
  const writes: Array<{ scratchpad: string, scratchpadPrevious: string }> = []
  await page.route('**/api/behaviors/review-new-prs', route => {
    const body = route.request().postDataJSON()
    writes.push(body)
    return route.fulfill(writes.length === 1 ? { status: 409, json: { error: 'Changed elsewhere', scratchpad: 'Other writer' } }
      : { json: { ok: true, enabled: false, setting: 'p2', reviewers: 1, scratchpad: body.scratchpad } })
  })
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await page.getByRole('button', { name: 'Edit memory for review-new-prs', exact: true }).click()
  const panel = page.locator('#behavior-memory-panel')
  const input = panel.locator('textarea')
  await input.fill('My unsaved memory')
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  const notice = await feedback(page, 'Behavior memory needs attention')
  await expect(notice).toContainText('changed elsewhere')
  await notice.locator('.nr-card-head').click()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveClass(/open/)
  await expect(input).toHaveValue('My unsaved memory')
  expect(writes).toHaveLength(1)
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toMatchObject({ scratchpad: 'My unsaved memory', scratchpadPrevious: 'Other writer' })
})

test('annotation conflicts belong to Needs you while the local annotation is retained', async ({ page }) => {
  await editor(page)
  await page.route('**/api/editor/doc/draft/annotations', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 409, json: { error: 'Annotations changed since they were loaded' } })
    : route.fulfill({ json: { annotations: [], version } }))
  await page.getByRole('button', { name: 'Add comment', exact: true }).click()
  const input = page.locator('.editor-annotation-text')
  await input.fill('Keep my annotation')
  const rail = await feedback(page)
  await expect(rail.getByRole('region', { name: 'Needs you', exact: true })).toContainText('Annotation conflict')
  await expect(input).toHaveValue('Keep my annotation')
})

test('a partial trigger save retains rejected-author feedback after leaving Behaviors', async ({ page }) => {
  await workspace(page)
  const state = Object.fromEntries(BEHAVIORS.map(({ key }) => [key,
    { owner: 'review-bot', enabled: false, setting: 'p2', reviewers: 1, scratchpad: '', repos: [] as string[], skipRepos: [], authors: [] as string[], lastTriggered: null },
  ]))
  await page.route('**/api/behaviors', route => route.fulfill({ json: state }))
  await page.route('**/api/repos', route => route.fulfill({ json: { repos: ['acme/project'] } }))
  const writes: Array<{ repos?: string[], authors?: string[] }> = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/behaviors/review-new-issues', async route => {
    const body = route.request().postDataJSON()
    writes.push(body)
    if (writes.length === 1) await held
    Object.assign(state['review-new-issues'], body)
    await route.fulfill({ json: { ok: true, ...state['review-new-issues'] } })
  })
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  const opener = page.locator('tr[data-behavior="review-new-issues"] .behavior-triggers-btn')
  await opener.click()
  const dialog = page.getByRole('dialog', { name: /Review New Issues/ })
  await dialog.getByRole('checkbox', { name: 'acme/project', exact: true }).check()
  await dialog.getByLabel('Trusted authors').fill('invalid!')
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect.poll(() => writes).toEqual([{ repos: ['acme/project'] }])
    const notice = await feedback(page, 'Behavior settings need attention')
    await expect(notice).toContainText('trusted authors were not saved')
    await expect(notice).toHaveCount(1)
    release()
    await expect(dialog).toBeHidden()
    await expect(notice).toContainText('not a GitHub username: invalid!')
    await page.locator('#notification-bell').click()
    await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
    await opener.click()
    await dialog.getByLabel('Trusted authors').fill('octocat')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect.poll(() => writes.length).toBe(2)
    await expect(dialog).toBeHidden()
    await expect(await feedback(page)).not.toContainText('Behavior settings need attention')
  } finally { release() }
})
