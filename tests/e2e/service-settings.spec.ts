import { expect, test, type Page } from '@playwright/test'
import type { AdminOverview, GatewayAccount, PairedDevice } from '../../src/gateway-client'

// Settings in a workspace behind the gateway: Poise Link under Accounts and,
// for the gateway's admins, an Admin tab. Poise's own API and the gateway's
// (/_poise/api/*) are both stood in for; the gateway's side is tested in
// gateway/tests.

const INSTALLER = 'https://github.com/autonomio/poise/releases/latest/download/install.sh'

function account(isAdmin: boolean): GatewayAccount {
  return {
    login: 'octocat',
    handle: 'octocat',
    isAdmin,
    workspaceHost: 'octocat.poise.example.test',
    apexOrigin: 'https://poise.example.test',
    link: { installer: INSTALLER, releases: 'https://github.com/autonomio/poise/releases/latest' },
  }
}

function device(id: string, state: PairedDevice['state'] = 'active'): PairedDevice {
  const paired = Date.parse('2026-10-09T07:00:00Z')
  return { id, label: 'PoiseLink/0.3.1', createdAt: paired, lastUsedAt: null, revokedAt: state === 'revoked' ? paired : null, state }
}

const ADMIN: AdminOverview = {
  users: [
    { handle: 'octocat', login: 'octocat', admin: true, access: 'admin', lastLoginAt: Date.parse('2026-10-09T06:00:00Z'), disabled: false, workspace: { state: 'running', image: '111111111111 (current)' }, lastError: null, disk: { bytes: 2.4 * 1024 ** 3, overBudget: false } },
    { handle: 'alice', login: 'Alice', admin: false, access: 'allow list', lastLoginAt: Date.parse('2026-10-08T06:00:00Z'), disabled: false, workspace: { state: 'exited', image: '000000000000 (outdated)' }, lastError: 'the last start timed out', disk: { bytes: 61 * 1024 ** 3, overBudget: true } },
  ],
  allowed: [{ handle: 'alice', source: 'admin', addedBy: 'octocat', addedAt: Date.parse('2026-10-01T06:00:00Z') }],
  admins: ['octocat'],
  allowedOrgs: [],
  dockerError: null,
  disk: { measuredAt: Date.parse('2026-10-09T07:00:00Z'), free: 20 * 1024 ** 3, total: 290 * 1024 ** 3, low: true, budget: 50 * 1024 ** 3 },
}

async function setup(page: Page, mode: 'service' | 'local', isAdmin = false) {
  const state = {
    devices: [] as PairedDevice[],
    gatewayCalls: [] as Array<{ path: string, body: unknown }>,
    admin: structuredClone(ADMIN),
  }
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, string> : null
    if (url.pathname.startsWith('/_poise/api/')) {
      const path = url.pathname.slice('/_poise/api/'.length)
      state.gatewayCalls.push({ path, body })
      if (path === 'account') return route.fulfill({ json: account(isAdmin) })
      if (path === 'devices') return route.fulfill({ json: { devices: state.devices } })
      if (path === 'devices/pair') {
        if (body?.userCode !== 'BCDF-GHJK') return route.fulfill({ status: 400, json: { error: 'invalid_code', message: 'That code is not valid or has expired. Start pairing again in Poise Link.' } })
        // Poise Link collects its token a moment after the approval.
        setTimeout(() => { state.devices = [device('laptop')] }, 300)
        return route.fulfill({ json: { decision: 'approve', message: 'Approved. Poise Link on that computer is now paired with octocat.poise.example.test.' } })
      }
      if (path === 'devices/revoke') {
        state.devices = state.devices.map((entry) => entry.id === body?.id ? device(entry.id, 'revoked') : entry)
        return route.fulfill({ json: { devices: state.devices } })
      }
      if (path === 'admin') return route.fulfill({ json: state.admin })
      if (path === 'admin/users/disable') {
        state.admin.users = state.admin.users.map((user) => user.handle === body?.handle ? { ...user, disabled: true, access: 'disabled by octocat' } : user)
        return route.fulfill({ json: state.admin })
      }
      return route.fulfill({ status: 404, json: { error: 'not_found', message: 'There is nothing at this address.' } })
    }
    if (url.pathname === '/api/workspace') return route.fulfill({ json: mode === 'service' ? { mode: 'service', owner: 'octocat' } : { mode: 'local' } })
    if (url.pathname === '/api/settings') {
      return route.fulfill({ json: { org: '', me: 'octocat', timezone: 'UTC', organizations: [{ login: 'acme', managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: '2026-10-01T08:00:00Z' }], models: {} } })
    }
    if (url.pathname === '/api/accounts') return route.fulfill({ json: { accounts: [] } })
    if (url.pathname === '/api/models') return route.fulfill({ json: { catalog: { models: [], review_providers: [], path: '' }, places: [], fixed: [], refresh: null } })
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    if (url.pathname === '/api/gh') return route.fulfill({ json: { records: [], count: 0, errors: [] } })
    return route.fulfill({ json: {} })
  })
  return state
}

test('pairs Poise Link from Settings, where the gateway sends /link, and revokes the computer', async ({ page }) => {
  const state = await setup(page, 'service')
  await page.goto('/?settings=link')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await expect(page.locator('.st-tabs [data-tab="accounts"]')).toHaveAttribute('aria-selected', 'true')
  // The address is consumed, so a reload does not open Settings again.
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.st-link-label')).toHaveText('Poise Link')
  await expect(page.locator('.pl-command-text')).toHaveText(`curl -fsSL ${INSTALLER} | sh`)
  await expect(page.locator('.pl-devices')).toContainText('No computer is paired yet.')
  await expect(page.locator('.pl-code')).toBeFocused()
  await expect(page.locator('.st-tabs [data-tab="admin"]')).toHaveCount(0)

  await page.locator('.pl-code').fill('bcdf-gggg')
  await page.locator('.pl-approve').click()
  await expect(page.locator('.pl-status')).toHaveText('That code is not valid or has expired. Start pairing again in Poise Link.')

  await page.locator('.pl-code').fill('bcdf-ghjk')
  await expect(page.locator('.pl-code')).toHaveValue('BCDF-GHJK')
  await page.locator('.pl-code').press('Enter')
  await expect(page.locator('.pl-status')).toContainText('Approved.')
  await expect(page.locator('.pl-status')).toHaveText('Poise Link 0.3.1 is paired. Your snippets and alerts now reach that computer.', { timeout: 10_000 })
  await expect(page.locator('.pl-device')).toHaveCount(1)
  await expect(page.locator('.pl-device-state')).toHaveText('Paired')
  expect(state.gatewayCalls.filter((call) => call.path === 'devices/pair').map((call) => call.body)).toEqual([
    { userCode: 'BCDF-GGGG', decision: 'approve' },
    { userCode: 'BCDF-GHJK', decision: 'approve' },
  ])

  await page.locator('.pl-revoke').click()
  await expect(page.locator('.pl-device-state')).toHaveText('Revoked')
  await expect(page.locator('.pl-revoke')).toHaveCount(0)
})

test('Escape closes the top-right menu, and Settings opened from it', async ({ page }) => {
  await setup(page, 'service')
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Menu', exact: true })
  const menu = page.locator('#menu-popover')
  await toggle.click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(toggle).toBeFocused()

  await toggle.click()
  await page.locator('[data-action="settings"]').click()
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/)
})

test('gives the gateway\'s admins an Admin tab that manages people and workspaces', async ({ page }) => {
  const state = await setup(page, 'service', true)
  await page.goto('/?settings=admin')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await expect(page.locator('.st-tabs [data-tab="admin"]')).toHaveAttribute('aria-selected', 'true')
  const alice = page.locator('.ad-user[data-user="alice"]')
  await expect(alice).toContainText('Alice')
  await expect(alice).toContainText('allow list')
  await expect(alice).toContainText('000000000000 (outdated)')
  await expect(alice).toContainText('the last start timed out')
  // Disk use, as the gateway last measured it.
  await expect(alice).toContainText('61 GB on disk, over its 50 GB budget')
  await expect(page.locator('.ad-user[data-user="octocat"]')).toContainText('2.4 GB on disk')
  await expect(page.locator('.ad-disk')).toContainText('Server disk: 20 GB free of 290 GB')
  await expect(page.locator('.ad-disk')).toContainText('Less than a tenth is free.')
  // An admin cannot disable themselves.
  await expect(page.locator('.ad-user[data-user="octocat"] [data-change="users/disable"]')).toHaveCount(0)
  await expect(page.locator('.ad-allowed-row')).toContainText('added by octocat')

  // Disabling asks once more before it cuts someone off.
  await alice.locator('[data-change="users/disable"]').click()
  await expect(alice.locator('[data-change="users/disable"]')).toHaveText('Confirm disable')
  expect(state.gatewayCalls.some((call) => call.path === 'admin/users/disable')).toBe(false)
  await alice.locator('[data-change="users/disable"]').click()
  await expect(alice).toContainText('disabled by octocat')
  await expect(alice.locator('[data-change="users/enable"]')).toHaveText('Enable')
  expect(state.gatewayCalls.filter((call) => call.path === 'admin/users/disable').map((call) => call.body)).toEqual([{ handle: 'alice' }])

  // The tabs still fit the panel side by side.
  const tabs = await page.locator('.st-tabs button').evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect()
    return { top: Math.round(box.top), right: box.right }
  }))
  expect(new Set(tabs.map((tab) => tab.top)).size).toBe(1)
  const panelRight = await page.locator('#settings-panel .tp-body').evaluate((body) => body.getBoundingClientRect().right)
  expect(Math.max(...tabs.map((tab) => tab.right))).toBeLessThanOrEqual(panelRight)
})

test('adds no gateway sections on a personal computer', async ({ page }) => {
  const state = await setup(page, 'local')
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await page.locator('.st-tabs [data-tab="accounts"]').click()
  await expect(page.locator('.st-tab[data-tab="accounts"] .tp-group-label').first()).toHaveText('Connected accounts')
  await expect(page.locator('.st-link-label')).toHaveCount(0)
  await expect(page.locator('.st-tabs [data-tab="admin"]')).toHaveCount(0)
  expect(state.gatewayCalls).toEqual([])
})
