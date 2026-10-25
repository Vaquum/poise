import { expect, test, type Page } from '@playwright/test'
import { ACCOUNT_IDS, ACCOUNT_LOGINS } from '../../server/accounts/types'
import { workspace } from './fixtures/workspace'
import { settled } from './fixtures/motion'
import { AGENTS, installSocket } from './fixtures/chat'

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function settings(page: Page, section: string) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover').getByRole('button', { name: section, exact: true }).click()
}

test('cold startup and Settings stay usable before external font stylesheets respond', async ({ page }) => {
  const fonts = deferred()
  const starting = workspace(page, 'current', fonts.promise)
  try {
    await expect(page.getByRole('button', { name: 'Current', exact: true })).toBeVisible({ timeout: 3000 })
    await starting
    const styles = page.locator('link[rel="stylesheet"][href^="https://fonts.googleapis.com/"]')
    await expect(styles).toHaveCount(2)
    expect(await styles.evaluateAll(links => links.every(link => (link as HTMLLinkElement).media === 'print'))).toBe(true)
    await settings(page, 'General')
    const username = page.getByLabel('Your GitHub account', { exact: true })
    await username.fill('draft-owner')
    fonts.release()
    await expect.poll(() => styles.evaluateAll(links => links.every(link => (link as HTMLLinkElement).media === 'all'))).toBe(true)
    await expect(username).toHaveValue('draft-owner')
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator('#view-swarm')).toBeVisible()
  } finally { fonts.release(); await starting }
})

const destinations = [
  ['Current', 'current', '/api/current'], ['Swarm', 'swarm', '/api/agent-logs'],
  ['Chat', 'chat', '/api/chat/sessions'], ['Archive', 'main', '/api/gh'],
  ['Behaviors', 'behaviors', '/api/behaviors'], ['Snippets', 'snippets', '/api/snippets'],
  ['Editor', 'editor', '/api/editor/docs'],
] as const

for (const [label, slug, path] of destinations) test(`${label} permits navigation while its read is pending and after it fails`, async ({ page }) => {
  await workspace(page, slug === 'current' ? 'main' : 'current')
  await settled(page)
  await installSocket(page)
  await page.route('**/api/chat/agents', route => route.fulfill({ json: AGENTS }))
  const held = deferred(), errors: string[] = []
  let reads = 0, editorWrites = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.route(`**${path}**`, async route => {
    reads++
    if (slug === 'editor' && route.request().method() !== 'GET') editorWrites++
    await held.promise
    await route.fulfill({ status: 503, json: { error: 'Source unavailable' } })
  })
  try {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(page.locator(`#view-${slug}`)).toBeVisible()
    await expect.poll(() => reads).toBeGreaterThan(0)
    const next = slug === 'current' ? 'main' : 'current'
    const elapsed = await page.evaluate(next => new Promise<number>(resolve => {
      requestAnimationFrame(() => {
        const start = performance.now()
        document.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)!.click()
        requestAnimationFrame(() => resolve(performance.now() - start))
      })
    }), next)
    expect(elapsed).toBeLessThan(1000)
    await expect(page.locator(`#view-${next}`)).toBeVisible()
    const failed = page.waitForResponse(response => new URL(response.url()).pathname === path && response.status() === 503)
    held.release()
    await (await failed).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.locator(`#view-${next}`)).toBeVisible()
    expect(errors).toEqual([])
    expect(editorWrites).toBe(0)
  } finally { held.release() }
})

test('Settings isolates slow Models and account probes while retaining fast account results', async ({ page }) => {
  await workspace(page); await settled(page)
  const modelRead = deferred(), githubRead = deferred()
  let models = 0, accountReads = 0, failed = true
  const accounts = ACCOUNT_IDS.map(id => ({ id, installed: true, version: '1.2.3', signedIn: true, identity: `${id}-user`, detail: null, login: { label: ACCOUNT_LOGINS[id].join(' ') } }))
  await page.route('**/api/models', async route => {
    models++
    await modelRead.promise
    await route.fulfill({ json: { catalog: { models: [], review_providers: [] }, slots: { primary: '', secondary: '', tertiary: '', notes: [], stored: null }, places: [], fixed: [], presets: [], refresh: null } })
  })
  await page.route('**/api/accounts**', async route => {
    accountReads++
    const id = new URL(route.request().url()).searchParams.get('id')
    if (id === 'gh') {
      await githubRead.promise
      if (failed) return route.fulfill({ status: 502, json: { error: 'GitHub probe unavailable' } })
    }
    await route.fulfill({ json: { accounts: accounts.filter(account => !id || account.id === id) } })
  })
  try {
    await settings(page, 'General')
    await expect(page.getByLabel('Your GitHub account', { exact: true })).toHaveValue('octocat')
    await settled(page)
    expect({ models, accountReads }).toEqual({ models: 0, accountReads: 0 })
    await page.getByRole('button', { name: 'Back to menu', exact: true }).click()
    await page.locator('#menu-popover').getByRole('button', { name: 'Models', exact: true }).click()
    await expect.poll(() => models).toBe(1)
    await expect(page.locator('.st-models')).toContainText('Loading the catalog')
    await page.getByRole('button', { name: 'Back to menu', exact: true }).click()
    await page.locator('#menu-popover').getByRole('button', { name: 'Accounts', exact: true }).click()
    await expect(page.locator('.st-account[data-account="codex"]')).toContainText('codex-user')
    await expect(page.locator('.st-account-checks-status')).toContainText('gh')
    await expect(page.locator('.st-account[data-account="gh"]')).toHaveCount(0)
    expect(models).toBe(1)
    githubRead.release()
    await expect(page.locator('.st-account-checks-status')).toContainText('GitHub probe unavailable')
    await expect(page.locator('.st-account[data-account="codex"]')).toContainText('codex-user')
    failed = false
    await page.getByRole('button', { name: 'Back to menu', exact: true }).click()
    await page.locator('#menu-popover').getByRole('button', { name: 'Accounts', exact: true }).click()
    await expect(page.locator('.st-account[data-account="gh"]')).toContainText('gh-user')
    await expect(page.locator('.st-account-checks-status')).toBeEmpty()
  } finally { modelRead.release(); githubRead.release() }
})

test('a late Behaviors read cannot restart hidden polling and its cached state appears on return', async ({ page }) => {
  await workspace(page); await settled(page)
  const first = deferred(), second = deferred()
  let reads = 0
  await page.route('**/api/behaviors', async route => {
    await (++reads === 1 ? first.promise : second.promise)
    await route.fulfill({ json: { 'review-new-prs': { enabled: true, owner: 'cached-agent', setting: 'p2', reviewers: 1 } } })
  })
  try {
    await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
    await expect(page.locator('#behaviors-tbody > tr')).not.toHaveCount(0)
    await expect(page.locator('input[data-behavior="review-new-prs"]')).toBeDisabled()
    await expect(page.getByLabel('Reviewers for review-new-prs')).toBeDisabled()
    await expect(page.getByLabel('Edit memory for review-new-prs')).toBeDisabled()
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    const received = page.waitForResponse('**/api/behaviors')
    first.release(); await (await received).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
    await page.waitForTimeout(100)
    expect(reads).toBe(1)
    await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
    await expect.poll(() => reads).toBe(2)
    await expect(page.locator('input[data-behavior="review-new-prs"]')).toBeChecked()
    await expect(page.getByLabel('Reviewers for review-new-prs')).toBeEnabled()
    await expect(page.getByLabel('Edit memory for review-new-prs')).toBeEnabled()
    await expect(page.locator('tr[data-behavior="review-new-prs"]')).toContainText('cached-agent')
  } finally { first.release(); second.release() }
})

test('Editor retains its document actor and undo history while the picker refresh is pending', async ({ page }) => {
  await workspace(page); await settled(page)
  const picker = deferred(), version = 'e'.repeat(64)
  let lists = 0, documentReads = 0
  await page.route('**/api/editor/docs', async route => {
    if (++lists > 1) await picker.promise
    await route.fulfill({ json: { docs: [{ slug: 'notes', title: 'Notes', updatedAt: '2026-10-14T08:00:00Z', size: 13 }] } })
  })
  await page.route('**/api/editor/doc/notes', async route => {
    if (route.request().method() === 'GET') documentReads++
    await route.fulfill({ json: { slug: 'notes', content: '# Notes\n\nOriginal', version, title: 'Notes' } })
  })
  await page.route('**/api/editor/doc/notes/annotations', route => route.fulfill({ json: { annotations: [], version } }))
  try {
    await page.getByRole('button', { name: 'Editor', exact: true }).click()
    const doc = page.locator('#editor-doc')
    await expect(doc).toContainText('Original')
    const actor = await doc.locator('.editor-line').first().elementHandle()
    await doc.click(); await doc.press('ControlOrMeta+End'); await doc.pressSequentially(' kept')
    await expect(doc).toContainText('kept')
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await page.getByRole('button', { name: 'Editor', exact: true }).click()
    await expect.poll(() => lists).toBe(2)
    await expect(doc).toContainText('kept')
    expect(documentReads).toBe(1)
    expect(await actor!.evaluate(element => element.isConnected)).toBe(true)
    await doc.click(); await doc.press('ControlOrMeta+z')
    await expect(doc).not.toContainText('kept')
  } finally { picker.release() }
})

test('a GitHub account control keeps focus when a later AI group arrives', async ({ page }) => {
  await workspace(page); await settled(page)
  const ai = deferred()
  await page.route('**/api/accounts**', async route => {
    const id = new URL(route.request().url()).searchParams.get('id')!
    if (id !== 'gh') await ai.promise
    await route.fulfill({ json: { accounts: [{ id, installed: true, version: '1.2.3', signedIn: true, identity: `${id}-user`, detail: null, login: { label: 'login' } }] } })
  })
  try {
    await settings(page, 'Accounts')
    const button = page.getByRole('button', { name: 'Reconnect GitHub', exact: true })
    await expect(button).toBeVisible()
    const actor = await button.elementHandle(); await actor!.focus()
    ai.release()
    await expect(page.locator('.st-account[data-account="codex"]')).toBeVisible()
    await expect(page.locator('.st-account-checks-status')).toBeEmpty()
    expect(await actor!.evaluate(el => el.isConnected && el === document.activeElement)).toBe(true)
  } finally { ai.release() }
})

test('later account checks cannot erase a terminal-opening failure', async ({ page }) => {
  await workspace(page); await settled(page)
  const github = deferred()
  await page.route('**/*terminal-panel*.js', route => route.abort())
  await page.route('**/api/accounts**', async route => {
    const id = new URL(route.request().url()).searchParams.get('id')!
    if (id === 'gh') await github.promise
    await route.fulfill({ json: { accounts: [{ id, installed: true, version: '1.2.3', signedIn: true, identity: `${id}-user`, detail: null, login: { label: 'login' } }] } })
  })
  try {
    await settings(page, 'Accounts')
    await page.getByRole('button', { name: 'Reconnect Codex', exact: true }).click()
    await expect(page.locator('.st-accounts-status')).toContainText('Could not open the terminal')
    github.release()
    await expect(page.locator('.st-account-checks-status')).toBeEmpty()
    await expect(page.locator('.st-accounts-status')).toContainText('Could not open the terminal')
  } finally { github.release() }
})

test('cached Editor annotation hit targets are redrawn after a hidden resize', async ({ page }) => {
  await workspace(page); await settled(page)
  const version = 'e'.repeat(64)
  const annotation = { id: 'ann-1', session_id: 'ann-1', range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 8 }, snippet: 'Original', comment: 'Read this note', created_at: '2026-10-14T08:00:00Z', updated_at: '2026-10-14T08:00:00Z' }
  await page.route('**/api/editor/docs', route => route.fulfill({ json: { docs: [{ slug: 'notes', title: 'Notes', updatedAt: annotation.updated_at, size: 23 }] } }))
  await page.route('**/api/editor/doc/notes', route => route.fulfill({ json: { slug: 'notes', content: 'Original annotated text', version } }))
  await page.route('**/api/editor/doc/notes/annotations', route => route.fulfill({ json: { annotations: [annotation], version } }))
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  const mark = page.locator('.annotation-mark').first()
  await expect(mark).toBeVisible()
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.setViewportSize({ width: 1000, height: 700 })
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(mark).toBeVisible()
  await mark.click()
  await expect(page.locator('.editor-annotation-text')).toHaveValue('Read this note')
})
