import { expect, test, type Page } from '@playwright/test'
import type { ArticleReview, ArticleReviews } from '../../src/publishing-review'
import { REVIEW_INTERVAL_MS } from '../../src/publishing-review'
import { workspace } from './fixtures/workspace'

const VERSION = 'a'.repeat(64)
const TEXT = '# A question\n\nOpening paragraph.\n\nA final thought.'
const review = (): ArticleReview => ({
  id: 'thread-1', kind: 'thread', repo: 'acme/site', site: 'Site', pr: 7, prUrl: 'https://github.com/acme/site/pull/7', path: 'posts/question.md', resolved: false, outdated: false, canReply: true, canResolve: true,
  messages: [{ id: 'comment-1', author: 'reviewer', body: 'Please clarify this passage.', url: 'https://github.com/acme/site/pull/7#discussion-1', createdAt: '2026-10-18T08:00:00Z' }],
  anchor: { quote: 'Opening paragraph.', before: '', after: '\nA final thought.', unique: true },
})

async function editorWithReviews(page: Page, initial: ArticleReview[] = [review()]) {
  await workspace(page)
  const data: ArticleReviews = { reviews: initial, checkedAt: '2026-10-18T08:00:00Z', active: true, stale: false, problems: [] }
  const calls: Array<{ path: string, body: Record<string, unknown> }> = []
  let content = TEXT
  await page.route('**/api/publishing/sites', (route) => route.fulfill({ json: { sites: [{ repo: 'acme/site', id: 42, site: 'Site', state: 'ready', sections: [{ name: 'Posts', firstLine: 'title', fields: [{ name: 'title', kind: 'text', required: true }] }] }] } }))
  await page.route('**/api/editor/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const body = request.method() === 'POST' || request.method() === 'PUT' ? request.postDataJSON() as Record<string, unknown> : {}
    if (path === '/api/editor/docs') return route.fulfill({ json: { docs: [{ slug: 'draft', title: 'A question', updated_at: '2026-10-18T08:00:00Z', size: TEXT.length }] } })
    if (path === '/api/editor/doc/draft') {
      if (request.method() === 'PUT' || request.method() === 'POST') content = String(body.content)
      return route.fulfill({ json: { slug: 'draft', title: 'A question', content, updated_at: '2026-10-18T08:00:00Z', version: VERSION } })
    }
    if (path.endsWith('/annotations')) return route.fulfill({ json: { annotations: [], version: VERSION } })
    if (path.endsWith('/google/sync')) return route.fulfill({ json: { publications: [], version: VERSION } })
    if (path.endsWith('/reviews')) return route.fulfill({ json: { ...data, reviews: [], checkedAt: null, stale: true } })
    if (path.endsWith('/reviews/sync')) { calls.push({ path, body }); return route.fulfill({ json: data }) }
    if (path.endsWith('/reviews/action')) {
      calls.push({ path, body })
      const target = data.reviews.find((item) => item.id === body.id)!
      if (body.action === 'resolve') target.resolved = true
      else target.messages.push({ id: 'reply-1', author: 'octocat', body: String(body.body), url: `${target.prUrl}#reply`, createdAt: '2026-10-18T09:00:00Z' })
      return route.fulfill({ json: data })
    }
    const publication = { repo: 'acme/site', repoId: 42, site: 'Site', section: 'Posts', slug: 'question', path: 'posts/question.md', url: 'https://site.example/question/', values: { title: 'A question' }, publishedAt: '2026-10-18T08:00:00Z', updatedAt: '2026-10-18T08:00:00Z', pullRequest: { number: 7, url: 'https://github.com/acme/site/pull/7', state: 'open' }, live: true, changed: true }
    if (path.endsWith('/publishing')) return route.fulfill({ json: { title: 'A question', slug: 'question', today: '2026-10-18', publications: [publication] } })
    if (path.endsWith('/publish')) { calls.push({ path, body }); return route.fulfill({ json: { results: [{ repo: 'acme/site', section: 'Posts', ok: true, publication }] } }) }
    return route.fulfill({ json: {} })
  })
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(page.locator('#editor-doc')).toContainText('Opening paragraph.')
  await expect.poll(() => calls.filter((call) => call.path.endsWith('/sync')).length).toBe(1)
  return { calls, data }
}

test('an inline review survives editing, updates the existing PR, and supports reply and resolution', async ({ page }, info) => {
  const { calls } = await editorWithReviews(page)
  const mark = page.locator('.editor-review-mark').first()
  await expect(mark).toBeVisible()
  await mark.click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await expect(panel).toContainText('Review · Site')
  await expect(panel).toContainText('@reviewer')
  await expect(panel).toContainText('Please clarify this passage.')
  await expect(panel.getByRole('link', { name: 'PR #7' })).toHaveAttribute('href', 'https://github.com/acme/site/pull/7')
  await expect(panel.locator('textarea')).toHaveCount(1)
  await expect.poll(() => panel.getAttribute('data-motion-running')).toBeNull()
  await page.screenshot({ path: info.outputPath('inline-review.png') })

  await page.locator('#editor-doc .editor-line').nth(2).fill('A clarified opening paragraph.')
  await expect(page.locator('.editor-review-mark')).toHaveCount(0)
  await page.locator('.editor-review-list summary').click()
  await page.locator('.editor-review-item').click()
  await expect(panel).toContainText('Passage changed or ambiguous')
  await expect(panel.getByRole('button', { name: 'Resolve thread' })).toBeVisible()

  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const publish = page.getByRole('dialog', { name: 'Publish', exact: true })
  await publish.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(publish.getByRole('link', { name: 'Pull request #7', exact: true })).toBeVisible()
  expect(calls.find((call) => call.path.endsWith('/publish'))?.body).toMatchObject({ destinations: [{ repo: 'acme/site', slug: 'question' }] })
  await page.keyboard.press('Escape')
  await page.locator('.editor-review-item').click()
  await panel.getByLabel('Reply on GitHub', { exact: true }).fill('Clarified in the latest update.')
  await panel.getByRole('button', { name: 'Reply on GitHub', exact: true }).click()
  await expect(panel).toContainText('Clarified in the latest update.')
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('')
  await panel.getByRole('button', { name: 'Resolve thread', exact: true }).click()
  await expect(panel.locator('.editor-review-state')).toHaveText('Resolved')
  expect(calls.filter((call) => call.path.endsWith('/action')).map((call) => call.body.action)).toEqual(['reply', 'resolve'])
  await expect.poll(() => panel.getAttribute('data-motion-running')).toBeNull()
  await page.screenshot({ path: info.outputPath('resolved-review.png') })
})

test('general, metadata, outdated and ambiguous feedback stays accessible without a guessed highlight', async ({ page }) => {
  const repeated = { ...review(), anchor: { quote: 'Absent passage.', before: '', after: '', unique: false }, outdated: true }
  const general: ArticleReview = { ...review(), id: 'general', kind: 'comment', canResolve: false, anchor: undefined, location: 'Document feedback' }
  const metadata: ArticleReview = { ...review(), id: 'metadata', anchor: undefined, location: 'File or metadata feedback' }
  await editorWithReviews(page, [repeated, general, metadata])
  await expect(page.locator('.editor-review-mark')).toHaveCount(0)
  await page.locator('.editor-review-list summary').click()
  await expect(page.locator('.editor-review-item')).toHaveCount(3)
  await page.locator('.editor-review-item').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await expect(panel).toContainText('Outdated · unresolved')
  await page.locator('.editor-review-item').nth(1).click()
  await expect(panel).toContainText('Document feedback')
  await expect(panel.getByRole('button', { name: 'Resolve thread' })).toHaveCount(0)
})

test('private agent assistance drafts the review context without sending to GitHub', async ({ page }) => {
  const { calls } = await editorWithReviews(page)
  await page.evaluate(() => window.addEventListener('poise:open-chat', (event) => {
    const detail = (event as CustomEvent<{ draft?: string, session: string }>).detail
    document.body.dataset.reviewChat = JSON.stringify({ draft: detail.draft, session: detail.session })
  }))
  await page.locator('.editor-review-mark').first().click()
  await page.getByRole('button', { name: 'Ask agent privately' }).click()
  await expect.poll(() => page.locator('body').getAttribute('data-review-chat')).toContain('Please clarify this passage.')
  expect(calls.filter((call) => call.path.endsWith('/action'))).toEqual([])
})

test('review replies survive refreshing and retain reviewer text as read-only', async ({ page }) => {
  await editorWithReviews(page)
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await panel.getByLabel('Reply on GitHub', { exact: true }).fill('An unfinished reply.')
  await page.locator('.editor-review-list summary').click()
  await page.getByRole('button', { name: 'Refresh reviews' }).click()
  await page.locator('.editor-review-item').click()
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('An unfinished reply.')
  await expect(panel.locator('.editor-review-messages textarea')).toHaveCount(0)
})

test('only the visible editor polls, and closed publications stop polling', async ({ page }) => {
  await page.clock.install()
  const { calls, data } = await editorWithReviews(page)
  await expect(page.locator('.editor-review-mark').first()).toBeVisible()
  await page.clock.fastForward(REVIEW_INTERVAL_MS + 1000)
  await expect.poll(() => calls.filter((call) => call.path.endsWith('/sync')).length).toBe(2)
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  const before = calls.filter((call) => call.path.endsWith('/sync')).length
  await page.clock.fastForward(REVIEW_INTERVAL_MS * 2)
  expect(calls.filter((call) => call.path.endsWith('/sync'))).toHaveLength(before)
  data.active = false
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect.poll(() => calls.filter((call) => call.path.endsWith('/sync')).length).toBe(before + 1)
  await page.clock.fastForward(REVIEW_INTERVAL_MS * 2)
  expect(calls.filter((call) => call.path.endsWith('/sync'))).toHaveLength(before + 1)
})

test('a failed sync keeps comments visible and reports stale feedback', async ({ page }) => {
  const { data } = await editorWithReviews(page)
  data.stale = true
  data.problems = ['Site: GitHub is unavailable.']
  data.retryAt = new Date(Date.now() + 3600_000).toISOString()
  await page.locator('.editor-review-list summary').click()
  await page.getByRole('button', { name: 'Refresh reviews' }).click()
  await expect(page.locator('.editor-review-list')).toContainText('Cached')
  await expect(page.getByRole('alert')).toContainText('GitHub is unavailable')
  await expect(page.locator('.editor-review-item')).toHaveCount(1)
})

test('switching documents during a GitHub reply does not suspend the new document', async ({ page }) => {
  await editorWithReviews(page)
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const actionStarted = new Promise<void>((resolve) => { started = resolve })
  await page.route('**/api/editor/doc/draft/reviews/action', async (route) => { started(); await held; await route.fallback() })
  let secondSyncs = 0
  const second: ArticleReviews = { reviews: [{ ...review(), id: 'thread-second', pr: 8, site: 'Another site', anchor: { quote: 'Different paragraph.', before: '', after: '', unique: true } }], checkedAt: '2026-10-18T08:00:00Z', active: true, stale: false, problems: [] }
  await page.route('**/api/editor/doc/another**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/annotations')) return route.fulfill({ json: { annotations: [], version: VERSION } })
    if (path.endsWith('/google/sync')) return route.fulfill({ json: { publications: [], version: VERSION } })
    if (path.endsWith('/reviews/sync')) secondSyncs++
    if (path.includes('/reviews')) return route.fulfill({ json: second })
    return route.fulfill({ json: { slug: 'another', content: '# Another\n\nDifferent paragraph.', version: VERSION } })
  })
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await panel.getByLabel('Reply on GitHub', { exact: true }).fill('A reply still in flight.')
  await panel.getByRole('button', { name: 'Reply on GitHub', exact: true }).click()
  await actionStarted
  try {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail: { slug: 'another' } })))
    await expect(page.locator('#editor-doc')).toContainText('Different paragraph.')
    await expect.poll(() => secondSyncs).toBe(1)
    await page.locator('.editor-review-list summary').click()
    await expect(page.getByRole('button', { name: 'Refresh reviews' })).toBeEnabled()
    await page.locator('.editor-review-item').click()
    await expect(panel).toContainText('Another site')
  } finally { release() }
})

for (const action of ['reply', 'resolve'] as const) test(`an earlier sync cannot undo a successful ${action}`, async ({ page }) => {
  const { data } = await editorWithReviews(page)
  const old = structuredClone(data)
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const syncStarted = new Promise<void>((resolve) => { started = resolve })
  await page.route('**/api/editor/doc/draft/reviews/sync', async (route) => { started(); await held; await route.fulfill({ json: old }) })
  const delivered = page.waitForResponse((response) => response.url().endsWith('/reviews/sync'))
  await page.locator('.editor-review-list summary').click()
  await page.getByRole('button', { name: 'Refresh reviews' }).click()
  await syncStarted
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  try {
    await page.locator('.editor-review-mark').first().click()
    if (action === 'reply') {
      await panel.getByLabel('Reply on GitHub', { exact: true }).fill('A retained reply.')
      await panel.getByRole('button', { name: 'Reply on GitHub', exact: true }).click()
      await expect(panel).toContainText('A retained reply.')
    } else {
      await panel.getByRole('button', { name: 'Resolve thread', exact: true }).click()
      await expect(panel.locator('.editor-review-state')).toHaveText('Resolved')
    }
  } finally { release() }
  await (await delivered).finished()
  // Let the delivered fetch and its render complete before checking the retained state.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  if (action === 'reply') await expect(panel).toContainText('A retained reply.')
  else await expect(panel.locator('.editor-review-state')).toHaveText('Resolved')
})
