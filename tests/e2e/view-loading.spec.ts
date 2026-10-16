import { expect, test, type Page } from '@playwright/test'

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const issue = {
  repo: 'acme/project', number: 7, title: 'Available GitHub issue', kind: 'issue',
  state: 'open', url: 'https://github.com/acme/project/issues/7', author: 'octocat',
  updated_at: '2026-10-13T08:00:00Z', created_at: '2026-10-13T08:00:00Z', merged_at: null,
}

async function setup(page: Page, view = 'current') {
  const state = { currentReads: 0 }
  await page.addInitScript((initialView) => {
    localStorage.clear(); localStorage.setItem('poise-filters-v2', JSON.stringify({ types: ['issue'], status: 'all', time: 'all' }))
    localStorage.setItem('poise-view', initialView)
  }, view)
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/settings') return route.fulfill({ json: {
      org: 'acme', me: 'octocat', timezone: 'UTC', models: {},
      organizations: ['acme', 'beta'].map((login) => ({ login, status: 'ready', managed: true, stage: 'ready', error: null, activatedAt: null })),
    } })
    if (path === '/api/current') return route.fulfill({ json: { cards: [{
      id: 1, text: 'Available personal card', lane: 'plan', position: 0, repo: null,
      created_at: issue.created_at, updated_at: issue.updated_at,
    }] } })
    if (path === '/api/gh') {
      const body = route.request().postDataJSON() as { operation?: string, count_only?: boolean, limit?: number }
      if (body.limit === 201) state.currentReads++
      return route.fulfill({ json: body.count_only ? { count: 1 } : { records: body.operation === 'green_pr' ? [] : [issue] } })
    }
    if (path === '/api/repos') return route.fulfill({ json: { repos: ['acme/project'] } })
    if (path === '/api/agent-logs') return route.fulfill({ json: { logs: [] } })
    return route.fulfill({ json: {} })
  })
  return state
}

test('Current paints cards while repository discovery and agent activity remain pending', async ({ page }) => {
  await setup(page)
  const auxiliary = deferred()
  await page.route(/\/api\/(?:repos|agent-logs)(?:\?.*)?$/, async (route) => {
    await auxiliary.promise
    await route.fallback()
  })
  const start = Date.now()
  try {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Edit card: Available personal card', exact: true })).toBeVisible({ timeout: 2000 })
    await expect(page.getByRole('link', { name: /Available GitHub issue/ })).toBeVisible({ timeout: 2000 })
    console.log(`Current first cards: ${Date.now() - start}ms; repository/activity responses still held`)
    // A late auxiliary read must not recreate the card's open composer.
    await page.getByRole('button', { name: 'Add a card to Idea', exact: true }).click()
    await page.getByPlaceholder('Write a card...').fill('Unsaved idea')
    auxiliary.release()
    await expect(page.getByPlaceholder('Write a card...')).toHaveValue('Unsaved idea')
  } finally { auxiliary.release() }
})

test('Current paints personal cards before a delayed GitHub failure and preserves them afterward', async ({ page }) => {
  await setup(page)
  const live = deferred()
  await page.route('**/api/gh', async (route) => {
    await live.promise
    await route.fulfill({ status: 502, json: { error: 'Datastore unavailable' } })
  })
  try {
    await page.goto('/')
    const card = page.getByRole('button', { name: 'Edit card: Available personal card', exact: true })
    await expect(card).toBeVisible({ timeout: 2000 })
    live.release()
    await expect(page.locator('#view-current')).toContainText('Could not load GitHub issues and pull requests.')
    await expect(card).toBeVisible()
  } finally { live.release() }
})

test('a late Current initialization cannot restart polling after navigation away', async ({ page }) => {
  const state = await setup(page)
  const repos = deferred()
  await page.route(/\/api\/repos(?:\?.*)?$/, async (route) => {
    await repos.promise
    await route.fallback()
  })
  try {
    await page.goto('/')
    await expect(page.getByRole('link', { name: /Available GitHub issue/ })).toBeVisible({ timeout: 2000 })
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    repos.release()
    await expect(page.locator('#tbody')).toContainText('Available GitHub issue')
    const before = state.currentReads
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
    await page.waitForTimeout(150) // Allow a wrongly reattached listener to issue its request.
    expect(state.currentReads).toBe(before)
  } finally { repos.release() }
})

test('Archive paints rows before its total-count response and reports a late count failure', async ({ page }) => {
  await setup(page, 'main')
  const count = deferred()
  await page.route('**/api/gh', async (route) => {
    const body = route.request().postDataJSON() as { count_only?: boolean }
    if (!body.count_only) return route.fallback()
    await count.promise
    await route.fulfill({ status: 502, json: { error: 'Count unavailable' } })
  })
  const start = Date.now()
  try {
    await page.goto('/')
    await expect(page.locator('#tbody')).toContainText('Available GitHub issue', { timeout: 2000 })
    console.log(`Archive first rows: ${Date.now() - start}ms; total-count response still held`)
    count.release()
    await expect(page.locator('#view-main')).toContainText('Total count unavailable.')
    await expect(page.locator('#tbody')).toContainText('Available GitHub issue')
  } finally { count.release() }
})

test('Current paints GitHub lanes while its personal-card read remains pending', async ({ page }) => {
  await setup(page)
  const manual = deferred()
  await page.route(/\/api\/current(?:\?.*)?$/, async (route) => {
    await manual.promise
    await route.fallback()
  })
  try {
    await page.goto('/')
    await expect(page.getByRole('link', { name: /Available GitHub issue/ })).toBeVisible({ timeout: 2000 })
    manual.release()
    await expect(page.getByRole('button', { name: 'Edit card: Available personal card', exact: true })).toBeVisible()
  } finally { manual.release() }
})

test('a late repository failure is visible without discarding Current cards', async ({ page }) => {
  await setup(page)
  const repos = deferred()
  await page.route(/\/api\/repos(?:\?.*)?$/, async (route) => {
    await repos.promise
    await route.fulfill({ status: 502, json: { error: 'Repository discovery unavailable' } })
  })
  try {
    await page.goto('/')
    await expect(page.getByRole('link', { name: /Available GitHub issue/ })).toBeVisible({ timeout: 2000 })
    repos.release()
    await expect(page.locator('#view-current')).toContainText('Could not load the repository list.')
    await expect(page.getByRole('button', { name: 'Edit card: Available personal card', exact: true })).toBeVisible()
  } finally { repos.release() }
})

test('Archive soft refresh paints updated rows while its count remains pending', async ({ page }) => {
  await setup(page, 'main')
  const count = deferred()
  let refreshing = false
  await page.route('**/api/gh', async (route) => {
    if (!refreshing) return route.fallback()
    const body = route.request().postDataJSON() as { count_only?: boolean }
    if (!body.count_only) return route.fulfill({ json: { records: [{ ...issue, number: 8, title: 'Updated GitHub issue' }] } })
    await count.promise
    await route.fulfill({ json: { count: 2 } })
  })
  try {
    await page.goto('/')
    await expect(page.locator('#count')).toHaveText('1 / 1')
    refreshing = true
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
    await expect(page.locator('#tbody')).toContainText('Updated GitHub issue', { timeout: 2000 })
    count.release()
    await expect(page.locator('#count')).toHaveText('2 / 2')
  } finally { count.release() }
})

test('Archive ignores a count from the previous account filter', async ({ page }) => {
  await setup(page, 'main')
  const oldCount = deferred()
  await page.route('**/api/gh', async (route) => {
    const body = route.request().postDataJSON() as { count_only?: boolean, org?: string }
    if (!body.count_only) return route.fallback()
    if (body.org === 'beta') return route.fulfill({ json: { count: 42 } })
    await oldCount.promise
    await route.fulfill({ json: { count: 1 } })
  })
  try {
    await page.goto('/')
    await expect(page.locator('#tbody')).toContainText('Available GitHub issue', { timeout: 2000 })
    await page.locator('#main-filters').getByLabel('Account filter').selectOption('beta')
    await expect(page.locator('#count')).toHaveText('1 / 42')
    const oldResponse = page.waitForResponse((response) => response.url().endsWith('/api/gh')
      && response.request().postDataJSON().count_only && !response.request().postDataJSON().org)
    oldCount.release()
    await oldResponse
    await expect(page.locator('#count')).toHaveText('1 / 42')
  } finally { oldCount.release() }
})

test('late repository discovery updates an open manual editor without changing its draft', async ({ page }) => {
  await setup(page)
  const repos = deferred()
  await page.route(/\/api\/repos(?:\?.*)?$/, async (route) => {
    await repos.promise
    await route.fulfill({ json: { repos: ['acme/project', 'acme/discovered'] } })
  })
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Edit card: Available personal card', exact: true }).click()
    const editor = page.locator('.card.editing')
    await editor.locator('textarea').fill('Draft before discovery')
    const picker = editor.locator('.manual-repo')
    await expect(picker).toHaveValue('')
    repos.release()
    await expect(picker.locator('option[value="acme/discovered"]')).toHaveCount(1)
    await expect(picker).toHaveValue('')
    await expect(editor.locator('textarea')).toHaveValue('Draft before discovery')
  } finally { repos.release() }
})

test('promoting a linked card preserves its intended repository before and after discovery', async ({ page }) => {
  await setup(page)
  const repos = deferred()
  await page.route(/\/api\/repos(?:\?.*)?$/, async (route) => {
    await repos.promise
    // Even partial discovery must not replace the explicitly linked repo.
    await route.fulfill({ json: { repos: ['acme/project'], errors: [{ org: 'acme', error: 'Partial repository discovery' }] } })
  })
  await page.route(/\/api\/current(?:\?.*)?$/, (route) => route.fulfill({ json: { cards: [{
    id: 1, text: 'Promote this linked card', lane: 'plan', position: 0, repo: 'acme/intended',
    created_at: issue.created_at, updated_at: issue.updated_at,
  }] } }))
  try {
    await page.goto('/')
    await expect(page.getByRole('link', { name: /Available GitHub issue/ })).toBeVisible()
    await page.locator('.card[data-id="1"]').dragTo(page.locator('.lane[data-lane="issue"]'))
    const picker = page.getByLabel('Repository for the new issue')
    await expect(picker).toHaveValue('acme/intended')
    repos.release()
    await expect(page.locator('#view-current')).toContainText('Partial repository discovery')
    await expect(picker).toHaveValue('acme/intended')
    await expect(page.getByRole('button', { name: 'Edit card: Promote this linked card', exact: true })).toBeVisible()
  } finally { repos.release() }
})

test('Archive continues paging while a delayed count is pending', async ({ page }) => {
  await setup(page, 'main')
  await page.setViewportSize({ width: 1280, height: 1800 })
  const count = deferred()
  let refreshing = false
  const offsets: number[] = []
  await page.route('**/api/gh', async (route) => {
    if (!refreshing) return route.fallback()
    const body = route.request().postDataJSON() as { count_only?: boolean, offset?: number }
    if (body.count_only) {
      await count.promise
      return route.fulfill({ json: { count: 40 } })
    }
    const offset = body.offset || 0
    offsets.push(offset)
    return route.fulfill({ json: { records: Array.from({ length: Math.max(0, Math.min(20, 40 - offset)) }, (_, index) => ({
      ...issue, number: offset + index + 1, title: `Refresh issue ${offset + index + 1}`,
    })) } })
  })
  try {
    await page.goto('/')
    await expect(page.locator('#count')).toHaveText('1 / 1')
    refreshing = true
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
    await expect(page.locator('#tbody')).toContainText('Refresh issue 20')
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect.poll(() => offsets.includes(20)).toBe(true)
    await expect(page.locator('#tbody > tr')).toHaveCount(40)
    count.release()
    await expect(page.locator('#count')).toHaveText('40 / 40')
  } finally { count.release() }
})

test('an issue composer reports discovery failure without an unhandled rejection', async ({ page }) => {
  await setup(page)
  const repos = deferred()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route(/\/api\/repos(?:\?.*)?$/, async (route) => {
    await repos.promise
    await route.fulfill({ status: 502, json: { error: 'Repository discovery unavailable' } })
  })
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Add an issue', exact: true }).click()
    const composer = page.locator('.composer-issue')
    await expect(composer).toBeVisible()
    repos.release()
    await expect(composer).toContainText('Could not load repositories')
    expect(errors).toEqual([])
  } finally { repos.release() }
})

test('empty repository discovery preserves live-feed choices in an open issue composer', async ({ page }) => {
  await setup(page)
  const repos = deferred()
  await page.route(/\/api\/repos(?:\?.*)?$/, async (route) => {
    await repos.promise
    await route.fulfill({ json: { repos: [] } })
  })
  await page.route('**/api/gh', (route) => route.fulfill({ json: { records: [issue, {
    ...issue, repo: 'acme/other', number: 8, title: 'Other repository issue',
  }] } }))
  try {
    await page.goto('/')
    await expect(page.getByRole('link', { name: /Other repository issue/ })).toBeVisible()
    await page.getByRole('button', { name: 'Add an issue', exact: true }).click()
    await page.getByPlaceholder('Issue title', { exact: true }).fill('Draft issue')
    const picker = page.getByLabel('Repository for the new issue')
    await expect(picker.locator('option')).toHaveCount(2)
    const selected = await picker.inputValue()
    const response = page.waitForResponse((reply) => new URL(reply.url()).pathname === '/api/repos')
    repos.release()
    await response
    await expect(picker.locator('option')).toHaveCount(2)
    await expect(picker.locator('option[value="acme/project"]')).toHaveCount(1)
    await expect(picker.locator('option[value="acme/other"]')).toHaveCount(1)
    await expect(picker).toHaveValue(selected)
    await expect(page.getByPlaceholder('Issue title', { exact: true })).toHaveValue('Draft issue')
  } finally { repos.release() }
})
