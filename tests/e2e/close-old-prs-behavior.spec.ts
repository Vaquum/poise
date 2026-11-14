import { expect, test } from '@playwright/test'
import { BEHAVIORS } from '../../src/behaviors'

test('old PR closing requires whole days, persists its setting and skips, and links its last close', async ({ page }) => {
  let enabled = false
  let days: number | null = null
  let skipRepos: string[] = []
  const writes: Array<Record<string, unknown>> = []
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear() })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() as Record<string, unknown> : {}
    if (url.pathname === '/api/settings') return route.fulfill({ json: {
      org: 'acme', me: 'octocat', agentAccount: 'bit-bot', timezone: 'UTC', models: {},
      chat: {}, notifications: { enabled: true }, manager: { version: 3 },
      behaviorChain: { enabled: false, seedMode: 'label', label: 'poise' },
      organizations: [{ login: 'acme', managed: true, status: 'ready', stage: 'ready', error: null }],
    } })
    if (url.pathname === '/api/workspace') return route.fulfill({ json: { mode: 'local' } })
    if (url.pathname === '/api/onboarding') return route.fulfill({ json: { available: false } })
    if (url.pathname === '/api/notices') return route.fulfill({ json: { enabled: true, notices: [] } })
    if (url.pathname === '/api/repos') return route.fulfill({ json: { repos: ['acme/app', 'acme/skip'] } })
    if (url.pathname === '/api/organizations') return route.fulfill({ json: { organizations: [{ login: 'acme', status: 'ready', stage: 'ready', managed: false }] } })
    if (url.pathname === '/api/behavior-metrics') return route.fulfill({ json: { behaviors: Object.fromEntries(BEHAVIORS.map(({ key }) => [key, null])), error: null } })
    if (url.pathname === '/api/behavior-chains') return route.fulfill({ json: { chains: [] } })
    if (url.pathname === '/api/behaviors/close-old-prs') {
      writes.push(body)
      if (typeof body.days === 'number') days = body.days
      if (typeof body.enabled === 'boolean') enabled = body.enabled
      if (Array.isArray(body.skipRepos)) skipRepos = body.skipRepos as string[]
      return route.fulfill({ json: { ok: true, enabled, days, skipRepos } })
    }
    if (url.pathname === '/api/behaviors') {
      const behavior = { owner: 'review-bot', enabled: false, setting: null, reviewers: null, scratchpad: null, skipRepos: [], lastTriggered: null }
      return route.fulfill({ json: {
        'review-new-prs': { ...behavior, setting: 'p2', reviewers: 1, scratchpad: '' },
        'approve-prs': { ...behavior, scratchpad: '' },
        'resolve-unblocking': behavior,
        'merge-prs': behavior,
        'close-old-prs': { ...behavior, enabled, days, skipRepos, lastTriggered: { at: new Date().toISOString(), target: 'acme/app#7', url: 'https://github.com/acme/app/pull/7' } },
        'review-new-issues': { ...behavior, reviewers: 1, repos: [], authors: ['octocat'], scratchpad: '' },
        diagnostics: { status: 'ok', agentLogsError: null, failures: [], deadLetters: [], holds: [],
          datastore: { status: 'healthy', checkedAt: new Date().toISOString(), ageSeconds: 1, lastSuccessAt: null, error: null },
          identity: { status: 'valid', actor: 'review-bot', error: null } },
      } })
    }
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: null, verifiedAt: null, authMethod: null, subscriptionType: null, loginInProgress: false } })
    if (url.pathname === '/api/gh') return route.fulfill({ json: body.count_only ? { count: 0 } : { records: [] } })
    return route.fulfill({ json: {} })
  })
  const row = page.locator('tr[data-behavior="close-old-prs"]')
  const toggle = row.locator('input[type="checkbox"]')
  await page.goto('/?view=settings&settings=behaviors')
  await expect(page.locator('[data-settings]')).toBeVisible()
  await expect(row).toContainText('Close Old Pull Requests')
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  await expect(row.locator('.behavior-memory-btn')).toHaveCount(0)
  await expect(row.locator('.behavior-reviewers')).toHaveCount(0)
  await expect(row.locator('.behavior-last-link')).toHaveAttribute('href', 'https://github.com/acme/app/pull/7')
  await row.locator('.behavior-triggers-btn').click()
  const dialog = page.getByRole('dialog', { name: 'Setting for Close Old Pull Requests' })
  const input = dialog.getByRole('spinbutton', { name: 'Close after days' })
  await input.fill('1.5')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeVisible()
  expect(writes).toEqual([])
  await input.fill('30')
  await dialog.getByRole('checkbox', { name: 'acme/skip', exact: true }).check()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => skipRepos).toEqual(['acme/skip'])
  await expect.poll(() => days).toBe(30)
  await row.locator('.toggle').click()
  await expect(toggle).toBeChecked()
  await expect.poll(() => enabled).toBe(true)
  await page.reload()
  await expect(page.locator('[data-settings]')).toBeVisible()
  await expect(toggle).toBeChecked()
  await expect(row.locator('.behavior-triggers-btn')).toHaveText('30 days, skip 1')
  await row.locator('.toggle').click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(() => enabled).toBe(false)
  expect(writes).toEqual([{ days: 30, skipRepos: ['acme/skip'] }, { enabled: true }, { enabled: false }])
})

test('leaving Settings with invalid days keeps the error and the previous threshold', async ({ page }) => {
  let days: number | null = null
  let skipRepos: string[] = []
  const writes: Array<Record<string, unknown>> = []
  const requested = new Set<string>()
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear() })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    requested.add(url.pathname)
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() as Record<string, unknown> : {}
    if (url.pathname === '/api/settings') return route.fulfill({ json: {
      org: 'acme', me: 'octocat', agentAccount: 'bit-bot', timezone: 'UTC', models: {},
      chat: {}, notifications: { enabled: true }, manager: { version: 3 },
      behaviorChain: { enabled: false, seedMode: 'label', label: 'poise' },
      organizations: [{ login: 'acme', managed: true, status: 'ready', stage: 'ready', error: null }],
    } })
    if (url.pathname === '/api/workspace') return route.fulfill({ json: { mode: 'local' } })
    if (url.pathname === '/api/onboarding') return route.fulfill({ json: { available: false } })
    if (url.pathname === '/api/notices') return route.fulfill({ json: { enabled: true, notices: [] } })
    if (url.pathname === '/api/repos') return route.fulfill({ json: { repos: ['acme/app', 'acme/skip'] } })
    if (url.pathname === '/api/organizations') return route.fulfill({ json: { organizations: [{ login: 'acme', status: 'ready', stage: 'ready', managed: false }] } })
    if (url.pathname === '/api/behavior-metrics') return route.fulfill({ json: { behaviors: Object.fromEntries(BEHAVIORS.map(({ key }) => [key, null])), error: null } })
    if (url.pathname === '/api/behavior-chains') return route.fulfill({ json: { chains: [], attention: [] } })
    if (url.pathname === '/api/chat/requests') return route.fulfill({ json: { revision: 1, complete: true, requests: [] } })
    if (url.pathname === '/api/chat/switchboard') return route.fulfill({ json: { revision: 1, status: 'live', items: [] } })
    if (url.pathname === '/api/editor/reviews') return route.fulfill({ json: { publications: [] } })
    if (url.pathname === '/api/answers/dismissals') return route.fulfill({ json: { dismissals: [] } })
    if (url.pathname === '/api/behaviors/close-old-prs') {
      writes.push(body)
      if (typeof body.days === 'number') days = body.days
      if (Array.isArray(body.skipRepos)) skipRepos = body.skipRepos as string[]
      return route.fulfill({ json: { ok: true, enabled: false, days, skipRepos } })
    }
    if (url.pathname === '/api/behaviors') {
      const behavior = { owner: 'review-bot', enabled: false, setting: null, reviewers: null, scratchpad: null, skipRepos: [], lastTriggered: null }
      return route.fulfill({ json: {
        'review-new-prs': { ...behavior, setting: 'p2', reviewers: 1, scratchpad: '' },
        'approve-prs': { ...behavior, scratchpad: '' },
        'resolve-unblocking': behavior,
        'merge-prs': behavior,
        'close-old-prs': { ...behavior, days, skipRepos },
        'review-new-issues': { ...behavior, reviewers: 1, repos: [], authors: ['octocat'], scratchpad: '' },
        diagnostics: { status: 'ok', agentLogsError: null, failures: [], deadLetters: [], holds: [],
          datastore: { status: 'healthy', checkedAt: new Date().toISOString(), ageSeconds: 1, lastSuccessAt: null, error: null },
          identity: { status: 'valid', actor: 'review-bot', error: null } },
      } })
    }
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: null, verifiedAt: null, authMethod: null, subscriptionType: null, loginInProgress: false } })
    if (url.pathname === '/api/gh') return route.fulfill({ json: body.count_only ? { count: 0 } : { records: [] } })
    return route.fulfill({ json: {} })
  })
  await page.goto('/?view=settings&settings=behaviors')
  await expect(page.locator('[data-settings]')).toBeVisible()
  const row = page.locator('tr[data-behavior="close-old-prs"]')
  await expect(row).toBeVisible()
  // Let the bell's away reads settle, so later bell changes come only from this test.
  await expect.poll(() => ['/api/chat/requests', '/api/chat/switchboard', '/api/behavior-chains', '/api/answers/dismissals']
    .every((path) => requested.has(path))).toBe(true)
  const badge = page.locator('[data-bell]')
  await expect(badge).toHaveText('0')
  // Invalid days alone: leaving saves nothing but keeps the error visible.
  await row.locator('.behavior-triggers-btn').click()
  const dialog = page.getByRole('dialog', { name: 'Setting for Close Old Pull Requests' })
  const input = dialog.getByRole('spinbutton', { name: 'Close after days' })
  await input.fill('1.5')
  await page.locator('a[data-go="general"]').click()
  await expect(page).toHaveURL(/settings=general/)
  await expect(dialog).toBeHidden()
  await expect.poll(() => writes).toEqual([])
  await expect(badge).toHaveText('1')
  await expect(badge).toHaveAttribute('data-tone', 'failed')
  // Invalid days with a skip change: the skip saves, the days do not.
  await page.locator('a[data-go="behaviors"]').click()
  await expect(page).toHaveURL(/settings=behaviors/)
  await expect(row).toBeVisible()
  await row.locator('.behavior-triggers-btn').click()
  await expect(dialog).toBeVisible()
  await input.fill('0')
  await dialog.getByRole('checkbox', { name: 'acme/skip', exact: true }).check()
  await page.locator('a[data-go="general"]').click()
  await expect(page).toHaveURL(/settings=general/)
  await expect.poll(() => writes).toEqual([{ skipRepos: ['acme/skip'] }])
  await expect.poll(() => days).toBeNull()
  await expect(badge).toHaveText('1')
  await page.locator('a[data-go="behaviors"]').click()
  await expect(row.locator('.behavior-triggers-btn')).toHaveText('Set days, skip 1')
})
