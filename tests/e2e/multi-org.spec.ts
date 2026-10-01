import { expect, test, type Page } from '@playwright/test'
import type { Organization } from '../../src/config'

function organization(login: string, status: Organization['status'] = 'ready'): Organization {
  return { login, managed: true, status, stage: status === 'initializing' ? 'syncing' : status, error: null, activatedAt: status === 'ready' ? '2026-10-01T08:00:00Z' : null }
}

function record(org: string) {
  return { repo: `${org}/same-repo`, number: 1, title: `${org} issue`, kind: 'issue', state: 'open', url: `https://github.com/${org}/same-repo/issues/1`, author: 'octocat', owner_login: null, owner_avatar: null, updated_at: '2026-10-01T08:00:00Z', created_at: '2026-10-01T08:00:00Z', merged_at: null }
}

async function setup(page: Page, initial = [organization('acme')], me = 'octocat') {
  const state = {
    organizations: initial,
    me,
    additions: [] as string[],
    retries: [] as string[],
    polls: 0,
    reads: [] as Array<{ path: string, org: string }>,
    behaviorWrites: [] as Array<{ org: string, body: Record<string, unknown> }>,
    enabled: { acme: true, beta: false } as Record<string, boolean>,
    partial: false,
  }
  await page.clock.setFixedTime(new Date('2026-10-01T08:00:10Z'))
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : {}
    const org = url.searchParams.get('org') || String(body.org || '')
    state.reads.push({ path: url.pathname, org })
    if (url.pathname === '/api/settings') {
      if (request.method() === 'POST') state.me = String(body.me)
      return route.fulfill({ json: { org: 'acme', me: state.me, timezone: 'UTC', organizations: state.organizations, models: {} } })
    }
    if (url.pathname === '/api/organizations') {
      if (request.method() === 'POST') {
        state.additions.push(org)
        state.organizations = [...state.organizations, organization(org, 'initializing')]
      } else state.polls++
      return route.fulfill({ status: request.method() === 'POST' ? 202 : 200, json: { organizations: state.organizations } })
    }
    if (url.pathname.endsWith('/retry')) {
      const login = url.pathname.split('/')[3]
      state.retries.push(login)
      state.organizations = state.organizations.map((entry) => entry.login === login ? organization(login, 'initializing') : entry)
      return route.fulfill({ status: 202, json: { organizations: state.organizations } })
    }
    if (url.pathname === '/api/gh') {
      const records = state.organizations.filter((entry) => entry.status === 'ready' && (!org || entry.login === org)).map((entry) => record(entry.login))
      const errors = state.partial ? [{ org: 'beta', error: 'Sync unavailable' }] : []
      return route.fulfill({ json: body.count_only ? { count: records.length, errors } : { records: body.operation === 'green_pr' ? [] : records, errors } })
    }
    if (url.pathname === '/api/repos') {
      return route.fulfill({ json: { repos: state.organizations.filter((entry) => entry.status === 'ready' && (!org || entry.login === org)).map((entry) => `${entry.login}/same-repo`) } })
    }
    if (url.pathname === '/api/current') {
      return route.fulfill({ json: { cards: [{ id: 'personal', lane: 'idea', text: 'Personal idea', title: 'Personal idea', body: 'Personal idea', repo: null, position: 0, created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z' }] } })
    }
    if (url.pathname === '/api/agent-logs') {
      return route.fulfill({ json: { logs: state.organizations.filter((entry) => entry.status === 'ready' && (!org || entry.login === org)).map((entry) => ({
        id: entry.login, repo: `${entry.login}/same-repo`, pr_id: '1', model: 'opus-5', behavior: 'review', status: 'completed', completed_at: '2026-10-01T08:01:00Z', started_at: '2026-10-01T08:00:00Z', time_elapsed: '1m', response: '', error: '',
      })) } })
    }
    if (url.pathname.startsWith('/api/behaviors/')) {
      state.behaviorWrites.push({ org, body })
      if (typeof body.enabled === 'boolean') state.enabled[org] = body.enabled
      return route.fulfill({ json: { ...body, enabled: state.enabled[org] } })
    }
    if (url.pathname === '/api/behaviors') {
      if (state.organizations.find((entry) => entry.login === org)?.status !== 'ready') return route.fulfill({ status: 503, json: { error: 'Organization is not ready' } })
      const behavior = { enabled: false, setting: 'p2', reviewers: 1, scratchpad: '', repos: [], authors: [], owner: 'octocat', lastTriggered: null }
      return route.fulfill({ json: {
        'review-new-prs': { ...behavior, enabled: !!state.enabled[org] }, 'approve-prs': behavior, 'resolve-unblocking': behavior, 'review-new-issues': behavior,
      } })
    }
    if (url.pathname === '/api/models') return route.fulfill({ json: { catalog: { models: [], review_providers: [], path: '' }, places: [], fixed: [], refresh: null } })
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    return route.fulfill({ json: {} })
  })
  return state
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
}

test('adds an organization, saves the username, shows activation and refreshes the combined dashboard', async ({ page }) => {
  const state = await setup(page, [organization('acme')], '')
  await page.goto('/')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await page.getByLabel('Username (you)').fill('octocat')
  await page.getByLabel('New organization').fill('beta')
  await page.locator('.st-add-organization').click()
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('Syncing repositories…')
  expect(state.me).toBe('octocat')
  expect(state.additions).toEqual(['beta'])
  await expect(page.locator('.st-organization[data-org="acme"]')).toContainText('Ready')
  state.organizations = [organization('acme'), organization('beta')]
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('Ready')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['acme/same-repo', 'beta/same-repo'])
  await page.keyboard.press('Escape')
  await expect(page.locator('#main-filters').getByLabel('Organization filter')).toBeVisible()
})

test('retries failed activation and resumes status checks after reopening Settings', async ({ page }) => {
  const failed = { ...organization('beta', 'error'), error: 'GitHub access denied' }
  const state = await setup(page, [organization('acme'), failed])
  await page.goto('/')
  await openSettings(page)
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('GitHub access denied')
  await page.locator('[data-retry-org="beta"]').click()
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('Activating…')
  expect(state.retries).toEqual(['beta'])
  await page.keyboard.press('Escape')
  // Waiting across two polling intervals verifies the closed panel releases its timer.
  await page.waitForTimeout(100)
  const pollsAtClose = state.polls
  await page.waitForTimeout(3200)
  expect(state.polls).toBe(pollsAtClose)
  state.organizations = [organization('acme'), organization('beta')]
  await openSettings(page)
  await expect(page.locator('.st-organization[data-org="beta"]')).toContainText('Ready')
})

test('shares organization scope across Archive, Current and Swarm with full repository identities', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('beta')])
  await page.goto('/')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['acme/same-repo', 'beta/same-repo'])
  await page.locator('#main-filters').getByLabel('Organization filter').selectOption('beta')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['beta/same-repo'])
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  await expect(page.locator('#current-filters').getByLabel('Organization filter')).toHaveValue('beta')
  await expect(page.locator('#view-current .card-live .card-repo')).toHaveText(['beta/same-repo'])
  await expect(page.locator('#view-current')).toContainText('Personal idea')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator('#swarm-filters').getByLabel('Organization filter')).toHaveValue('beta')
  await expect(page.locator('#swarm-tbody .agent-row')).toHaveCount(1)
  await expect(page.locator('#swarm-tbody')).toContainText('beta/same-repo#1')
  await page.locator('#swarm-filters').getByLabel('Organization filter').selectOption('')
  await expect(page.locator('#swarm-tbody .agent-row')).toHaveCount(2)
  expect(state.reads).toEqual(expect.arrayContaining([{ path: '/api/current', org: 'beta' }, { path: '/api/agent-logs', org: 'beta' }]))
})

test('scopes behavior changes to the explicit organization and reports partial results', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('beta')])
  state.partial = true
  await page.goto('/')
  await expect(page.locator('#main-load-error')).toContainText('beta: Sync unavailable')
  await expect(page.locator('#tbody tr')).toHaveCount(2)
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  const picker = page.getByLabel('Behavior organization')
  const toggle = page.locator('input[data-behavior="review-new-prs"]')
  await expect(picker).toHaveValue('acme')
  await expect(toggle).toBeChecked()
  await picker.selectOption('beta')
  await expect(toggle).not.toBeChecked()
  await page.locator('tr[data-behavior="review-new-prs"] label.toggle').click()
  await expect.poll(() => state.behaviorWrites).toEqual([{ org: 'beta', body: { enabled: true } }])
  await picker.selectOption('acme')
  await expect(toggle).toBeChecked()
  expect(state.enabled).toEqual({ acme: true, beta: true })
})


test('updates organization filters after activation finishes while Settings is closed', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('beta', 'initializing')])
  await page.goto('/')
  await expect(page.locator('#main-filters').getByLabel('Organization filter')).toBeHidden()
  state.organizations = [organization('acme'), organization('beta')]
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(page.locator('#main-filters').getByLabel('Organization filter')).toBeVisible()
  await expect(page.locator('#main-filters').getByLabel('Organization filter').locator('option')).toHaveText(['All organizations', 'acme', 'beta'])
})

test('shows synchronization failures on previously activated organizations with a retry', async ({ page }) => {
  const state = await setup(page, [organization('acme'), { ...organization('beta'), stage: 'sync-error', error: 'GitHub rate limit exceeded' }])
  await page.goto('/')
  await openSettings(page)
  const row = page.locator('.st-organization[data-org="beta"]')
  await expect(row).toContainText('Sync failed')
  await expect(row).toContainText('GitHub rate limit exceeded')
  await row.getByRole('button', { name: 'Retry' }).click()
  await expect(row).toContainText('Syncing repositories…')
  expect(state.retries).toEqual(['beta'])
})


test('continues Archive pagination when an organization is missing only from the count', async ({ page }) => {
  await setup(page, [organization('acme'), organization('beta')])
  const records = Array.from({ length: 25 }, (_, i) => ({ ...record('acme'), number: i + 1, title: `Issue ${i + 1}`, url: `https://github.com/acme/same-repo/issues/${i + 1}` }))
  await page.route('**/api/gh', async (route) => {
    const body = route.request().postDataJSON() as { count_only?: boolean, offset?: number, limit?: number }
    await route.fulfill({ json: body.count_only
      ? { count: 1, errors: [{ org: 'beta', error: 'Count unavailable' }] }
      : { records: records.slice(body.offset || 0, (body.offset || 0) + (body.limit || 20)) } })
  })
  await page.goto('/')
  await expect(page.locator('#tbody tr')).toHaveCount(20)
  await expect(page.locator('#main-load-error')).toContainText('beta: Count unavailable')
  await page.locator('#main-sentinel').scrollIntoViewIfNeeded()
  await expect(page.locator('#tbody tr')).toHaveCount(25)
  await expect(page.locator('#count')).toHaveText('25 available')
})


test('keeps an open behavior memory bound to its organization when readiness disappears', async ({ page }) => {
  const state = await setup(page, [organization('acme'), organization('beta')])
  await page.goto('/')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await page.getByLabel('Behavior organization').selectOption('beta')
  await page.getByLabel('Edit memory for review-new-prs').click()
  await page.locator('.behavior-memory-textarea').fill('Beta-only instructions')
  state.organizations = [organization('acme'), organization('beta', 'initializing')]
  // Keyboard navigation opens Settings without clicking outside the memory,
  // leaving its draft open while the settings refresh reports readiness loss.
  await page.getByRole('button', { name: 'Menu', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-action="settings"]').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await expect(page.getByLabel('Behavior organization')).toHaveValue('beta')
  await expect(page.locator('#behavior-diagnostics')).toContainText('Behaviors API unavailable')
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/)
  await expect(page.locator('.behavior-memory-textarea')).toHaveValue('Beta-only instructions')
  await page.locator('.behavior-memory-save').click()
  await expect(page.locator('.behavior-memory-status')).toContainText('Not saved')
  expect(state.behaviorWrites).toEqual([])
  state.organizations = [organization('acme'), organization('beta')]
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(page.locator('#behavior-diagnostics')).toBeHidden()
  await page.locator('.behavior-memory-save').click()
  await expect.poll(() => state.behaviorWrites).toEqual([{ org: 'beta', body: { scratchpad: 'Beta-only instructions', scratchpadPrevious: '' } }])
})


test('discards a background Archive response whose JSON arrives after switching organization', async ({ page }) => {
  await setup(page, [organization('acme'), organization('beta')])
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window)
    const state = window as typeof window & { holdArchive?: boolean, archiveWaiting?: boolean, releaseArchive?: () => void }
    window.fetch = async (...args) => {
      const response = await fetch(...args)
      const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : {}
      if (String(args[0]) === '/api/gh' && state.holdArchive && !body.count_only) {
        state.holdArchive = false
        const json = response.json.bind(response)
        response.json = async () => {
          const data = await json()
          state.archiveWaiting = true
          await new Promise<void>((resolve) => { state.releaseArchive = resolve })
          return data
        }
      }
      return response
    }
  })
  await page.goto('/')
  const filter = page.locator('#main-filters').getByLabel('Organization filter')
  await filter.selectOption('acme')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['acme/same-repo'])
  await page.evaluate(() => {
    ;(window as typeof window & { holdArchive?: boolean }).holdArchive = true
    window.dispatchEvent(new Event('poise:refresh-tick'))
  })
  await expect.poll(() => page.evaluate(() => !!(window as typeof window & { archiveWaiting?: boolean }).archiveWaiting)).toBe(true)
  await filter.selectOption('beta')
  await expect(page.locator('#tbody .repo-name')).toHaveText(['beta/same-repo'])
  await page.evaluate(() => { (window as typeof window & { releaseArchive?: () => void }).releaseArchive?.() })
  await page.waitForTimeout(100)
  await expect(page.locator('#tbody .repo-name')).toHaveText(['beta/same-repo'])
})
