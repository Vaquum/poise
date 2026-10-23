import { expect, test, type Page } from '@playwright/test'
import type { ArticleReview, ArticleReviews } from '../../src/publishing-review'
import { REVIEW_INTERVAL_MS } from '../../src/publishing-review'
import { workspace } from './fixtures/workspace'
import { installRoutes, installSocket, makeState, session } from './fixtures/chat'
type ChatSocket = Awaited<ReturnType<typeof installSocket>>

const VERSION = 'a'.repeat(64)
const TEXT = '# A question\n\nOpening paragraph.\n\nA final thought.'
const review = (): ArticleReview => ({
  id: 'thread-1', kind: 'thread', repo: 'acme/site', site: 'Site', pr: 7, prUrl: 'https://github.com/acme/site/pull/7', path: 'posts/question.md', resolved: false, outdated: false, canReply: true, canResolve: true,
  messages: [{ id: 'comment-1', author: 'reviewer', body: 'Please clarify this passage.', url: 'https://github.com/acme/site/pull/7#discussion-1', createdAt: '2026-10-18T08:00:00Z' }],
  anchor: { quote: 'Opening paragraph.', before: '', after: '\nA final thought.', unique: true },
})

async function editorWithReviews(page: Page, initial: ArticleReview[] = [review()], options: { preserveOnReload?: boolean } = {}) {
  const state = makeState([], {})
  state.models = {
    catalog: { models: [{ identity: 'opus-5-max', selector: 'claude-opus-5', effort: 'max', provider: 'claude' }], review_providers: [], path: '' },
    places: [{ key: 'editor', default: 'opus-5-max' }],
    fixed: [],
    refresh: null,
  }
  state.forbidLegacyChat = true
  // The socket route must exist before navigation: registered after, the
  // WebSocket connects to the real server instead of the fixture.
  const sock = await installSocket(page, state)
  await workspace(page, 'current', undefined, options)
  // REST routes resolve last-registered-wins, so these go after the
  // workspace catch-all.
  await installRoutes(page, state)
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
  return { calls, data, state, sock }
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
  // The comment's time is on Poise's clock in Settings' time zone, UTC here.
  await expect(panel.locator('.editor-review-messages time')).toHaveText(/^18 Oct (2026 )?08:00$/)
  await expect(panel.getByRole('link', { name: 'PR #7' })).toHaveAttribute('href', 'https://github.com/acme/site/pull/7')
  await expect(panel.locator('.editor-review-reply')).toHaveCount(1)
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
  const { calls, state } = await editorWithReviews(page)
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await expect(panel).toContainText('Private agent thread · not posted to GitHub')
  await expect(panel.locator('.editor-inline-thread-surface .chat-input')).toBeVisible()
  expect(calls.filter((call) => call.path.endsWith('/action'))).toEqual([])
  expect(state.calls.filter((call) => call.path === '/api/chat')).toEqual([])
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

const thread = (page: Page) => page.locator('.editor-inline-thread')
const threadInput = (page: Page) => thread(page).locator('.chat-input')
const threadTranscript = (page: Page) => thread(page).locator('.chat-surface-transcript')

async function sendThreadMessage(page: Page, sock: ChatSocket, text: string): Promise<string> {
  const before = sock.framesOf('prompt').length
  await threadInput(page).fill(text)
  await threadInput(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(before + 1)
  return (sock.framesOf('prompt')[before].command as { sessionId: string }).sessionId
}

async function finishReply(sock: ChatSocket, id: string, text: string, reply: string) {
  await sock.subscribed(id)
  const turnId = 't1'
  const messageId = 't1-reply'
  return [
    sock.push(id, { type: 'turn.started', turnId, prompt: { text, attachments: [], mentions: [] } }),
    sock.push(id, { type: 'text.delta', turnId, messageId, delta: reply }),
    sock.push(id, { type: 'turn.finished', turnId, stopReason: 'end_turn' }),
  ]
}

test('keeps the draft of a review opened from Chat before any inline thread', async ({ page }) => {
  const { state, calls } = await editorWithReviews(page)
  const existing = session({ id: 's-review', subject: { surface: 'editor-review', key: 'draft:thread-1', label: 'Review · Site #7' }, status: 'idle' })
  state.sessions.unshift(existing)
  state.history[existing.id] = []
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail: { slug: 'draft', session: 's-review' } })))
  const pane = page.locator('#chat-side-pane')
  await expect(pane.locator('.chat-input')).toBeVisible()
  await pane.locator('.chat-input').fill('Fresh private review draft')
  await pane.locator('.chat-close').click()
  await page.locator('.editor-review-mark').first().click()
  await expect(threadInput(page)).toHaveValue('Fresh private review draft')
  expect(calls.filter((call) => call.path.endsWith('/action'))).toEqual([])
})

test("opens a review thread inline with its GitHub conversation and a private agent chat", async ({ page }) => {
  const { state, sock } = await editorWithReviews(page)
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await expect(panel).toContainText('Review · Site')
  await expect(panel).toContainText('Please clarify this passage.')
  await expect(panel.getByRole('button', { name: 'Reply on GitHub', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Resolve thread', exact: true })).toBeVisible()
  await expect(panel).toContainText('Private agent thread · not posted to GitHub')
  const id = await sendThreadMessage(page, sock, 'How should I address this?')
  const created = state.calls.find((call) => call.method === 'POST' && call.path === '/api/chat/sessions')
  expect(created?.body).toMatchObject({ subject: { surface: 'editor-review', key: 'draft:thread-1' } })
  await finishReply(sock, id, 'How should I address this?', 'Clarify the opening sentence.')
  await expect(threadTranscript(page)).toContainText('Clarify the opening sentence.')
  // Under the anchored paragraph: within 16 px of its text bottom (the
  // thread sits in the gap its own padding makes in the source line).
  await expect.poll(async () => {
    const box = await thread(page).boundingBox()
    const lineBox = await page.locator('#editor-doc .editor-line', { hasText: 'Opening paragraph.' }).first().boundingBox()
    const padding = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('#editor-doc .editor-line')]
      const found = lines.find((el) => el.textContent!.includes('Opening paragraph.')) as HTMLElement
      return Number.parseFloat(found.style.paddingBottom || '0')
    })
    return Math.abs(box!.y - (lineBox!.y + lineBox!.height - padding))
  }).toBeLessThanOrEqual(16)
})

test("keeps a review's private chat across a reload", async ({ page }) => {
  const { state, sock } = await editorWithReviews(page, [review()], { preserveOnReload: true })
  await page.locator('.editor-review-mark').first().click()
  const id = await sendThreadMessage(page, sock, 'How should I address this?')
  const envelopes = await finishReply(sock, id, 'How should I address this?', 'Clarify the opening sentence.')
  state.history[id] = envelopes
  await page.reload()
  await expect(page.locator('#editor-doc')).toContainText('Opening paragraph.')
  await page.locator('.editor-review-mark').first().click()
  await expect(threadTranscript(page)).toContainText('Clarify the opening sentence.')
})

test('fills the GitHub reply from a suggested reply without posting it', async ({ page }) => {
  const { calls, sock } = await editorWithReviews(page)
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  const id = await sendThreadMessage(page, sock, 'Draft a reply')
  const reply = JSON.stringify({ chat: 'Here is a draft.', reply: 'Thanks — clarified in the latest update.' })
  await finishReply(sock, id, 'Draft a reply', reply)
  await expect(threadTranscript(page)).toContainText('Suggested GitHub reply')
  await threadTranscript(page).getByRole('button', { name: 'Use as reply', exact: true }).click()
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Thanks — clarified in the latest update.')
  expect(calls.filter((call) => call.path.endsWith('/action'))).toEqual([])
})

test('keeps a newly selected suggested reply when an earlier GitHub reply succeeds', async ({ page }) => {
  const { calls, sock } = await editorWithReviews(page)
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  const id = await sendThreadMessage(page, sock, 'Draft the next reply')
  await finishReply(sock, id, 'Draft the next reply', JSON.stringify({ chat: 'Another draft.', reply: 'Keep this new unsent reply.' }))
  await expect(threadTranscript(page)).toContainText('Keep this new unsent reply.')
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { started = resolve })
  await page.route('**/api/editor/doc/draft/reviews/action', async route => { started(); await held; await route.fallback() })
  try {
    await panel.getByLabel('Reply on GitHub', { exact: true }).fill('The earlier submitted reply.')
    await panel.getByRole('button', { name: 'Reply on GitHub', exact: true }).click()
    await requested
    await threadTranscript(page).getByRole('button', { name: 'Use as reply', exact: true }).click()
    await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Keep this new unsent reply.')
    release()
    await expect(panel).toContainText('The earlier submitted reply.')
    await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toBeEnabled()
    await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Keep this new unsent reply.')
    expect(calls.filter(call => call.path.endsWith('/action')).map(call => call.body)).toEqual([{ id: 'thread-1', action: 'reply', body: 'The earlier submitted reply.' }])
  } finally { release() }
})

test('uses a suggested reply from a review moved to the side pane', async ({ page }) => {
  const { state, sock } = await editorWithReviews(page)
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  const id = await sendThreadMessage(page, sock, 'Draft a reply')
  const reply = JSON.stringify({ chat: 'Here is a draft.', reply: 'Thanks — clarified in the latest update.' })
  const envelopes = await finishReply(sock, id, 'Draft a reply', reply)
  state.history[id] = envelopes
  await thread(page).getByRole('button', { name: 'Move to the side pane', exact: true }).click()
  const paneTranscript = page.locator('#chat-side-pane .chat-surface-transcript')
  await expect(paneTranscript).toContainText('Suggested GitHub reply')
  // Clicking in the pane must not drop the review selection first.
  await paneTranscript.getByRole('button', { name: 'Use as reply', exact: true }).click()
  await page.locator('#chat-side-pane').getByRole('button', { name: 'Back to the review', exact: true }).click()
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Thanks — clarified in the latest update.')
})

test('keeps a side-pane suggested reply for its original document after switching documents', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  const { calls, state, sock } = await editorWithReviews(page)
  await page.route('**/api/editor/doc/other', route => route.fulfill({ json: {
    slug: 'other', title: 'Other document', content: '# Other document\n\nOpening paragraph.', updated_at: '2026-10-18T08:00:00Z', version: VERSION,
  } }))
  const other = { ...review(), messages: [{ ...review().messages[0], body: 'Feedback on the other document.' }] }
  for (const endpoint of ['reviews', 'reviews/sync']) {
    await page.route(`**/api/editor/doc/other/${endpoint}`, route => route.fulfill({ json: {
      reviews: [other], checkedAt: '2026-10-18T08:00:00Z', active: true, stale: false, problems: [],
    } }))
  }
  await page.locator('.editor-review-mark').first().click()
  const id = await sendThreadMessage(page, sock, 'Draft a reply')
  state.history[id] = await finishReply(sock, id, 'Draft a reply', JSON.stringify({ chat: 'A draft.', reply: 'Reply for the original document.' }))
  await thread(page).getByRole('button', { name: 'Move to the side pane', exact: true }).click()
  const pane = page.locator('#chat-side-pane')
  await expect(pane).toContainText('Reply for the original document.')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail: { slug: 'other' } })))
  await expect(page.locator('#editor-doc')).toContainText('Other document')
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await expect(panel).toContainText('Feedback on the other document.')
  await panel.getByLabel('Reply on GitHub', { exact: true }).fill('Keep the other document draft.')
  await pane.getByRole('button', { name: 'Use as reply', exact: true }).click()
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Keep the other document draft.')
  await pane.getByRole('button', { name: 'Back to the review', exact: true }).click()
  await expect(panel).toContainText('Please clarify this passage.')
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Reply for the original document.')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail: { slug: 'other' } })))
  await expect(page.locator('#editor-doc')).toContainText('Other document')
  await page.locator('.editor-review-mark').first().click()
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Keep the other document draft.')
  expect(calls.filter((call) => call.path.endsWith('/action'))).toEqual([])
})

test('opens a reply-only review response from Chat in Editor and hands off its reply', async ({ page }) => {
  const { calls, state, sock } = await editorWithReviews(page)
  await page.locator('.editor-review-mark').first().click()
  const id = await sendThreadMessage(page, sock, 'Draft only a reply')
  state.history[id] = await finishReply(sock, id, 'Draft only a reply', JSON.stringify({ chat: 'A reply without document edits.', reply: 'Thanks for the review.' }))
  await thread(page).getByRole('button', { name: 'Move to the side pane', exact: true }).click()
  await page.locator('#chat-side-pane').getByRole('button', { name: 'Open in Chat', exact: true }).click()
  const transcript = page.locator('.chat-transcript')
  await expect(transcript).toContainText('Thanks for the review.')
  await expect(transcript.getByRole('button', { name: 'Use as reply', exact: true })).toHaveCount(0)
  await expect(transcript.getByRole('button', { name: 'Open in Editor', exact: true })).toHaveCount(1)
  await transcript.getByRole('button', { name: 'Open in Editor', exact: true }).click()
  await page.locator('#chat-side-pane').getByRole('button', { name: 'Use as reply', exact: true }).click()
  await page.locator('.editor-review-mark').first().click()
  await expect(thread(page).getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Thanks for the review.')
  expect(calls.filter((call) => call.path.endsWith('/action'))).toEqual([])
})

test('keeps a side-pane suggestion bound to its review after another review opens inline', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  const second: ArticleReview = { ...review(), id: 'thread-2', site: 'Second site', anchor: { quote: 'A final thought.', before: '', after: '', unique: true } }
  const { calls, state, sock } = await editorWithReviews(page, [review(), second])
  await page.locator('.editor-review-mark[data-review="thread-1"]').first().click()
  const id = await sendThreadMessage(page, sock, 'Draft a reply')
  state.history[id] = await finishReply(sock, id, 'Draft a reply', JSON.stringify({ chat: 'A draft.', reply: 'Reply for the first review.' }))
  await thread(page).getByRole('button', { name: 'Move to the side pane', exact: true }).click()
  const paneTranscript = page.locator('#chat-side-pane .chat-surface-transcript')
  await expect(paneTranscript).toContainText('Reply for the first review.')
  await page.locator('.editor-review-mark[data-review="thread-2"]').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await expect(panel).toContainText('Second site')
  await panel.getByLabel('Reply on GitHub', { exact: true }).fill('Keep the second draft.')
  await paneTranscript.getByRole('button', { name: 'Use as reply', exact: true }).click()
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Keep the second draft.')
  await page.locator('#chat-side-pane').getByRole('button', { name: 'Back to the review', exact: true }).click()
  await expect(panel).toContainText('Review · Site')
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('Reply for the first review.')
  expect(calls.filter((call) => call.path.endsWith('/action'))).toEqual([])
})

test("opens an unlocated review's thread under the review list", async ({ page }) => {
  const missing: ArticleReview = { ...review(), id: 'missing', anchor: { quote: 'Absent passage.', before: '', after: '', unique: false }, outdated: true }
  await editorWithReviews(page, [missing])
  await expect(page.locator('.editor-review-mark')).toHaveCount(0)
  await page.locator('.editor-review-list summary').click()
  await page.locator('.editor-review-item').click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await expect(panel).toContainText('Passage changed or ambiguous')
  // In flow directly under the list, with no room made in the text.
  const placement = await page.evaluate(() => {
    const list = document.querySelector('.editor-review-list')!
    const dialog = document.querySelector('.editor-inline-thread')!
    const padded = [...document.querySelectorAll('#editor-doc .editor-line')].filter((el) => (el as HTMLElement).style.paddingBottom)
    return { afterList: list.nextElementSibling === dialog, padded: padded.length }
  })
  expect(placement.afterList).toBe(true)
  expect(placement.padded).toBe(0)
})

test("keeps the private chat's draft while the review re-renders", async ({ page }) => {
  await editorWithReviews(page)
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await panel.getByLabel('Reply on GitHub', { exact: true }).fill('An unfinished reply.')
  await threadInput(page).fill('An unsent private thought')
  const line = page.locator('#editor-doc .editor-line').first()
  await line.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' More.')
  await expect(threadInput(page)).toHaveValue('An unsent private thought')
  await expect(panel.getByLabel('Reply on GitHub', { exact: true })).toHaveValue('An unfinished reply.')
})


test('returns a moved review to its original document after switching documents', async ({ page }) => {
  await editorWithReviews(page)
  await page.route('**/api/editor/doc/other', route => route.fulfill({ json: {
    slug: 'other', title: 'Other document', content: '# Other document\n\nOpening paragraph.', updated_at: '2026-10-18T08:00:00Z', version: VERSION,
  } }))
  const other = { ...review(), messages: [{ ...review().messages[0], body: 'Feedback on the other document.' }] }
  await page.route('**/api/editor/doc/other/reviews', route => route.fulfill({ json: {
    reviews: [other], checkedAt: '2026-10-18T08:00:00Z', active: true, stale: false, problems: [],
  } }))
  await page.route('**/api/editor/doc/other/reviews/sync', route => route.fulfill({ json: {
    reviews: [other], checkedAt: '2026-10-18T08:00:00Z', active: true, stale: false, problems: [],
  } }))
  await page.locator('.editor-review-mark').first().click()
  const panel = page.getByRole('dialog', { name: 'Review comment', exact: true })
  await panel.locator('.chat-input').fill('Draft for the original review')
  await panel.getByRole('button', { name: 'Move to the side pane', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail: { slug: 'other' } })))
  await expect(page.locator('#editor-doc')).toContainText('Other document')
  await expect(page.locator('.editor-review-mark').first()).toBeVisible()
  await page.locator('#chat-side-pane').getByRole('button', { name: 'Back to the review', exact: true }).click()
  await expect(page.locator('#editor-doc')).toContainText('A question')
  await expect(panel).toContainText('Please clarify this passage.')
  await expect(panel).not.toContainText('Feedback on the other document.')
  await expect(panel.locator('.chat-input')).toHaveValue('Draft for the original review')
  await expect(page.locator('#chat-side-pane')).not.toHaveClass(/open/)
})
