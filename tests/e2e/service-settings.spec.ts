import { expect, test, type Page } from '@playwright/test'
import type { AdminOverview, GatewayAccount, PairedDevice } from '../../src/gateway-client'
import { adminPage, type AdminView } from '../../gateway/src/pages'

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

function device(id: string, state: PairedDevice['state'] = 'active', connected = state === 'active'): PairedDevice {
  const paired = Date.parse('2026-10-09T07:00:00Z')
  return { id, label: 'PoiseLink/0.3.1', createdAt: paired, lastUsedAt: null, revokedAt: state === 'revoked' ? paired : null, state, connected }
}

/** A computer whose Poise Link was last connected at 07:53 and is not running now. */
function stopped(id: string): PairedDevice {
  return { ...device(id, 'active', false), lastUsedAt: Date.parse('2026-10-09T07:53:00Z') }
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
      if (path === 'admin/users/enable') {
        state.admin.users = state.admin.users.map((user) => user.handle === body?.handle ? { ...user, disabled: false, access: 'allow list' } : user)
        return route.fulfill({ json: state.admin })
      }
      if (['admin/workspaces/start', 'admin/workspaces/stop', 'admin/workspaces/restart'].includes(path)) {
        state.admin.users = state.admin.users.map((user) => user.handle === body?.handle
          ? { ...user, workspace: { state: path.endsWith('/stop') ? 'exited' : 'running', image: user.workspace?.image ?? null } } : user)
        return route.fulfill({ json: state.admin })
      }
      return route.fulfill({ status: 404, json: { error: 'not_found', message: 'There is nothing at this address.' } })
    }
    if (url.pathname === '/api/workspace') return route.fulfill({ json: mode === 'service' ? { mode: 'service', owner: 'octocat' } : { mode: 'local' } })
    if (url.pathname === '/api/settings') {
      return route.fulfill({ json: { org: '', me: 'octocat', timezone: 'UTC', organizations: [{ login: 'acme', managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: '2026-10-01T08:00:00Z' }], models: {} } })
    }
    if (url.pathname === '/api/accounts') return route.fulfill({ json: { accounts: [] } })
    if (url.pathname === '/api/snippets') {
      return route.fulfill({ json: { snippets: [{ trigger: ';combo', replace: 'Work closely together.' }], version: 'a'.repeat(64), skills: { revision: 0, switches: [] }, desktop: 'poise-link' } })
    }
    if (url.pathname === '/api/models') return route.fulfill({ json: { catalog: { models: [], review_providers: [], path: '' }, slots: { primary: '', secondary: '', tertiary: '', notes: [], stored: null }, places: [], fixed: [], refresh: null } })
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
  await expect(page.locator('#settings-panel')).toHaveAttribute('data-section', 'accounts')
  // The address is consumed, so a reload does not open Settings again.
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.st-link-label')).toHaveText('Poise Link')
  await expect(page.locator('.pl-command-text')).toHaveText(`curl -fsSL ${INSTALLER} | sh`)
  await expect(page.locator('.pl-devices')).toContainText('No computer is paired yet.')
  await expect(page.locator('.pl-code')).toBeFocused()
  await expect(page.locator('#settings-panel [data-tab="admin"]')).toHaveCount(0)

  await page.locator('.pl-code').fill('bcdf-gggg')
  await page.locator('.pl-approve').click()
  await expect(page.locator('.pl-status')).toHaveText('That code is not valid or has expired. Start pairing again in Poise Link.')

  await page.locator('.pl-code').fill('bcdf-ghjk')
  await expect(page.locator('.pl-code')).toHaveValue('BCDF-GHJK')
  await page.locator('.pl-code').press('Enter')
  await expect(page.locator('.pl-status')).toContainText('Approved.')
  await expect(page.locator('.pl-status')).toHaveText('Poise Link 0.3.1 is paired. Your snippets and alerts now reach that computer.', { timeout: 10_000 })
  await expect(page.locator('.pl-device')).toHaveCount(1)
  await expect(page.locator('.pl-device-state')).toHaveText('Connected')
  expect(state.gatewayCalls.filter((call) => call.path === 'devices/pair').map((call) => call.body)).toEqual([
    { userCode: 'BCDF-GGGG', decision: 'approve' },
    { userCode: 'BCDF-GHJK', decision: 'approve' },
  ])

  await page.locator('.pl-revoke').click()
  await expect(page.locator('.pl-device-state')).toHaveText('Revoked')
  await expect(page.locator('.pl-revoke')).toHaveCount(0)
})

test('says a paired computer whose Poise Link is not running is not connected, and follows it connecting', async ({ page }) => {
  const state = await setup(page, 'service')
  state.devices = [stopped('laptop')]
  // A later day than the pairing, so both times carry their date on Poise's clock.
  await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
  await page.goto('/?settings=link')
  const card = page.locator('.pl-device')
  await expect(card.locator('.pl-device-state')).toHaveText('Not connected')
  await expect(card.locator('.pl-device-state')).toHaveClass(/pl-device-state-disconnected/)
  await expect(card.locator('.pl-device-times')).toHaveText('Paired 9 Oct 07:00 · last seen 9 Oct 07:53')
  await expect(card.locator('.pl-device-state')).toHaveAttribute('data-help', 'Poise Link is not running on that computer, or it cannot reach Poise. Snippets and alerts reach it once it connects again.')

  // Poise Link starts on that computer while Settings stays open.
  state.devices = [device('laptop')]
  await page.clock.fastForward(10_000)
  await expect(card.locator('.pl-device-state')).toHaveText('Connected')
  await expect(card.locator('.pl-device-times')).toHaveText('Paired 9 Oct 07:00')
  await expect(card.locator('.pl-device-state')).not.toHaveAttribute('data-help', /Poise Link is not running/)
})

for (const [name, devices] of [
  ['disconnected', [stopped('laptop')]],
  ['connected', [device('laptop')]],
  ['multiple connected computers', [device('laptop'), device('desktop')]],
  ['revoked', [device('laptop', 'revoked')]],
  ['unpaired', []],
] as const) {
  test(`keeps Poise Link status out of Snippets when ${name}`, async ({ page }) => {
    const state = await setup(page, 'service')
    state.devices = [...devices]
    await page.addInitScript(() => localStorage.setItem('poise-view', 'snippets'))
    await page.clock.install()
    await page.goto('/')
    const view = page.locator('#view-snippets')
    await expect(view.locator('.snip-row[data-trigger=";combo"]')).toBeVisible()
    await expect(view.locator('.snip-link-hint, .snip-link-settings')).toHaveCount(0)
    await expect(view).not.toContainText('Poise Link')
    await expect(view.locator('.snip-espanso-hint')).toBeHidden()

    await page.clock.fastForward(20_000)
    await expect(view).not.toContainText('Poise Link')
    await expect(view.getByRole('button', { name: 'Add snippet' })).toBeVisible()

    // The existing Settings section still reports each computer's status.
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('[data-settings="accounts"]').click()
    await expect(page.locator('.pl-device')).toHaveCount(devices.length)
    const labels = devices.map(entry => entry.state === 'revoked' ? 'Revoked' : entry.connected ? 'Connected' : 'Not connected')
    if (labels.length) await expect(page.locator('.pl-device-state')).toHaveText(labels)
    else await expect(page.locator('.pl-devices')).toContainText('No computer is paired yet.')
  })
}

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
  await page.locator('[data-settings="general"]').click()
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/)
})

test('gives the gateway\'s admins an Admin tab that manages people and workspaces', async ({ page }) => {
  const state = await setup(page, 'service', true)
  // A later day than the sign-ins, so their times carry the date on Poise's clock.
  await page.clock.setFixedTime(new Date('2026-10-21T12:00:00Z'))
  await page.goto('/?settings=admin')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await expect(page.locator('#settings-panel')).toHaveAttribute('data-section', 'admin')
  const alice = page.locator('.ad-user[data-user="alice"]')
  await expect(alice).toContainText('Alice')
  await expect(alice).toContainText('allow list · last sign-in 8 Oct 06:00')
  await expect(alice).toContainText('000000000000 (outdated)')
  await expect(alice).toContainText('the last start timed out')
  // Disk use, as the gateway last measured it.
  await expect(alice).toContainText('61 GB on disk, over its 50 GB budget')
  await expect(page.locator('.ad-user[data-user="octocat"]')).toContainText('2.4 GB on disk')
  await expect(page.locator('.ad-disk')).toContainText('Server disk: 20 GB free of 290 GB, measured 9 Oct 07:00.')
  await expect(page.locator('.ad-disk')).toContainText('Less than a tenth is free.')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await expect(page.locator('.ad-disk .st-help')).toHaveCSS('color', 'rgb(168, 121, 43)')
    await expect(alice.getByText('61 GB on disk, over its 50 GB budget', { exact: true })).toHaveCSS('color', 'rgb(168, 121, 43)')
    await expect(alice.getByText('the last start timed out', { exact: true })).toHaveCSS('color', 'rgb(184, 80, 72)')
  }
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

  await expect(page.locator('.st-tabs')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to menu' }).click()
  await expect(page.locator('#menu-popover [data-settings="admin"]')).toBeVisible()
})

test('Admin keeps distinct user and workspace controls through consecutive changes', async ({ page }) => {
  const state = await setup(page, 'service', true)
  state.admin.users[1].disabled = true
  await page.goto('/?settings=admin')
  const alice = page.locator('.ad-user[data-user="alice"]')
  const changes = [
    ['users/enable', 'Enable', 'alice is enabled.'],
    ['workspaces/start', 'Start', 'The workspace of alice is started.'],
    ['workspaces/stop', 'Stop', 'The workspace of alice is stopped.'],
    ['workspaces/restart', 'Restart', 'The workspace of alice is restarted.'],
  ] as const
  for (const [change, label, status] of changes) {
    await alice.getByRole('button', { name: label, exact: true }).click()
    await expect(page.locator('.ad-status')).toHaveText(status)
    for (const name of ['Start', 'Stop', 'Restart', 'Disable']) {
      await expect(alice.getByRole('button', { name, exact: true })).toBeVisible()
    }
    expect(state.gatewayCalls.at(-1)).toEqual({ path: `admin/${change}`, body: { handle: 'alice' } })
  }
  await expect(alice.locator('.ad-user-state')).toHaveText('running')
  await expect(page.locator('.ad-user[data-user="octocat"] .ad-actions button')).toHaveText(['Start', 'Stop', 'Restart'])
})

test('gateway Admin disk warnings are amber and start failures stay red in both themes', async ({ page }) => {
  const view: AdminView = {
    csrf: 'fixture', admins: ['octocat'], allowed: [], allowedOrgs: [], access: new Map(), dockerError: null,
    users: [{ handle: 'alice', login: 'Alice', githubId: 1, accessOrg: null, createdAt: 0, lastLoginAt: 0, disabledAt: null, disabledBy: null }],
    workspaces: new Map([['alice', { state: 'exited', image: 'outdated' }]]),
    records: new Map([['alice', { handle: 'alice', login: 'Alice', createdAt: 0, lastStartedAt: null, lastError: 'the last start timed out', lastErrorAt: 0 }]]),
    disk: { measuredAt: 0, free: 20 * 1024 ** 3, total: 290 * 1024 ** 3, low: true, workspaces: new Map([['alice', 61 * 1024 ** 3]]) },
    diskBudget: 50 * 1024 ** 3,
  }
  await page.route('https://rsms.me/**', route => route.abort())
  await page.setContent(adminPage(view))
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(page.getByText(/Server disk:.*Less than a tenth is free/)).toHaveCSS('color', 'rgb(168, 121, 43)')
    await expect(page.getByText('61 GB on disk, over its 50 GB budget', { exact: true })).toHaveCSS('color', 'rgb(168, 121, 43)')
    await expect(page.getByText('the last start timed out', { exact: true })).toHaveCSS('color', 'rgb(184, 80, 72)')
  }
})

test('saves the model choices under a name and switches back to them in one step', async ({ page }) => {
  await setup(page, 'service')
  const posts: Array<{ path: string, body: unknown }> = []
  const chat = { key: 'chat', label: 'Chat', why: 'Card chats.', review: false, reviewers: false, notes: [], stored: null, providers: null }
  const currentSlots = { primary: 'opus-5-max', secondary: 'gpt-6-astra-max', tertiary: 'grok-4.6-xhigh' }
  const quotaSlots = { primary: 'gpt-6-astra-max', secondary: 'opus-5-max', tertiary: 'grok-4.6-xhigh' }
  let chosen = { slots: { ...currentSlots }, places: { chat: { slot: 'primary' } } }
  let presets = [{ name: 'Quota day', models: { slots: { ...quotaSlots }, places: { chat: { slot: 'primary' } } }, savedAt: '2026-10-09T12:00:00Z' }]
  let loads = 0
  await page.route('**/api/models', async (route) => {
    // What the server holds when the read starts; every read after the first is slow.
    const answer = {
      slots: { ...chosen.slots, notes: [], stored: null },
      places: [{ ...chat, slot: chosen.places.chat.slot, model: (chosen.slots as Record<string, string>)[chosen.places.chat.slot] }],
      presets: [...presets],
    }
    loads += 1
    if (loads > 1) await new Promise((resolve) => setTimeout(resolve, 800))
    return route.fulfill({ json: { catalog: { models: [
      { identity: 'opus-5-max', provider: 'claude', selector: 'claude-opus-5', effort: 'max' },
      { identity: 'gpt-6-astra-max', provider: 'codex', selector: 'gpt-6-astra', effort: 'max' },
      { identity: 'grok-4.6-xhigh', provider: 'grok', selector: 'grok-4.6', effort: 'xhigh' },
    ], review_providers: [], path: '' }, fixed: [], refresh: null, ...answer } })
  })
  await page.route('**/api/models/presets', async (route) => {
    const body = route.request().postDataJSON() as { name: string, models: Record<string, unknown> }
    posts.push({ path: 'save', body })
    presets = [...presets, { name: body.name, models: body.models as never, savedAt: '2026-10-09T13:00:00Z' }]
    await new Promise((resolve) => setTimeout(resolve, 400))
    return route.fulfill({ json: { presets } })
  })
  await page.route('**/api/models/presets/delete', (route) => {
    const body = route.request().postDataJSON() as { name: string }
    presets = presets.filter((preset) => preset.name !== body.name)
    return route.fulfill({ json: { presets } })
  })
  await page.route('**/api/settings', (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON() as { models: typeof chosen }
    posts.push({ path: 'settings', body })
    chosen = body.models
    return route.fulfill({ json: { org: '', me: 'octocat', agentAccount: '', timezone: 'UTC', models: body.models, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 }, organizations: [] } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-settings="models"]').click()
  const saved = page.getByLabel('Saved model configuration')
  await expect(saved).toHaveValue('Quota day')

  await page.getByLabel('Configuration name').fill('Normal')
  await page.getByRole('button', { name: 'Save current', exact: true }).click()
  // One configuration action at a time: nothing else can start while the save is on its way.
  await expect(page.getByRole('button', { name: 'Use', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
  await expect(page.locator('.st-status')).toHaveText('Saved the model choices as "Normal".')
  await expect(page.getByRole('button', { name: 'Use', exact: true })).toBeEnabled()
  expect(posts[0]).toEqual({ path: 'save', body: { name: 'Normal', models: chosen } })

  // Using one shows its choices at once, before the slow reload, so a Save right away keeps them.
  const reload = page.waitForResponse((response) => response.url().endsWith('/api/models'))
  await saved.selectOption('Quota day')
  await page.getByRole('button', { name: 'Use', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Using "Quota day".')
  expect(posts[1]).toEqual({ path: 'settings', body: { models: presets[0].models } })
  await expect(page.getByLabel('Primary model', { exact: true })).toHaveValue('gpt-6-astra-max')

  // A delete while that reload is on its way stays deleted when the older answer lands.
  await saved.selectOption('Normal')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Deleted "Normal".')
  await reload
  await expect(saved.locator('option')).toHaveText(['Quota day'])
  await expect(page.getByLabel('Primary model', { exact: true })).toHaveValue('gpt-6-astra-max')
})

test('a failed first device read stays visible until a later read succeeds', async ({ page }) => {
  const state = await setup(page, 'service')
  state.devices = [device('laptop')]
  let fail = true
  await page.route('**/_poise/api/devices', async (route) => {
    if (fail) return route.fulfill({ status: 503, json: { message: 'The device store is unavailable.' } })
    return route.fallback()
  })
  await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
  await page.goto('/?settings=link')
  const devices = page.locator('.pl-devices')
  await expect(devices).toContainText('Could not read the paired computers: The device store is unavailable.')
  await expect(page.locator('.pl-device')).toHaveCount(0)
  fail = false
  await page.clock.fastForward(10_000)
  await expect(page.locator('.pl-device-state')).toHaveText('Connected')
  await expect(devices).not.toContainText('Could not read')
})

test('a failed device read keeps retained rows as last-known and recovers on the next read', async ({ page }) => {
  const state = await setup(page, 'service')
  state.devices = [device('laptop')]
  let fail = false
  await page.route('**/_poise/api/devices', async (route) => {
    if (fail) return route.fulfill({ status: 503, json: { message: 'The device store is unavailable.' } })
    return route.fallback()
  })
  await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
  await page.goto('/?settings=link')
  const card = page.locator('.pl-device')
  await expect(card.locator('.pl-device-state')).toHaveText('Connected')
  fail = true
  await page.clock.fastForward(10_000)
  const devices = page.locator('.pl-devices')
  await expect(devices.locator('.pl-devices-stale')).toContainText('Could not read the paired computers: The device store is unavailable.')
  await expect(devices.locator('.pl-devices-stale')).toContainText('Last known list, read 12:00.')
  await expect(card.locator('.pl-device-state')).toHaveText('Connection unknown')
  await expect(card.locator('.pl-device-state')).toHaveClass(/pl-device-state-stale/)
  await expect(card.locator('.pl-device-state')).toHaveAttribute('data-help', 'Poise could not read the paired computers, so this may be out of date.')
  await expect(card.locator('.pl-device-times')).toHaveText('Paired 9 Oct 07:00 · as of 12:00')
  fail = false
  await page.clock.fastForward(10_000)
  await expect(card.locator('.pl-device-state')).toHaveText('Connected')
  await expect(devices.locator('.pl-devices-stale')).toHaveCount(0)
  await expect(card.locator('.pl-device-times')).toHaveText('Paired 9 Oct 07:00')
})

test('overlapping device reads keep the newer observation', async ({ page }) => {
  const state = await setup(page, 'service')
  state.devices = [device('laptop')]
  let holdNext = false, release!: () => void, held!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { held = resolve })
  await page.route('**/_poise/api/devices', async (route) => {
    if (holdNext) {
      holdNext = false
      held()
      await gate
      return route.fulfill({ json: { devices: [device('laptop')] } })
    }
    return route.fallback()
  })
  await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
  await page.goto('/?settings=link')
  const card = page.locator('.pl-device')
  await expect(card.locator('.pl-device-state')).toHaveText('Connected')
  holdNext = true
  await page.clock.fastForward(10_000)
  await started
  state.devices = [stopped('laptop')]
  await page.clock.fastForward(10_000)
  await expect(card.locator('.pl-device-state')).toHaveText('Not connected')
  const response = page.waitForResponse((entry) => entry.url().includes('/_poise/api/devices'))
  release()
  await response
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await expect(card.locator('.pl-device-state')).toHaveText('Not connected')
  await expect(card.locator('.pl-device-times')).toHaveText('Paired 9 Oct 07:00 · last seen 9 Oct 07:53')
})

test('adds no gateway sections on a personal computer', async ({ page }) => {
  const state = await setup(page, 'local')
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-settings="accounts"]').click()
  await expect(page.locator('#settings-panel .tp-title')).toHaveText('Accounts')
  await expect(page.locator('.st-link-label')).toHaveCount(0)
  await expect(page.locator('#settings-panel [data-tab="admin"]')).toHaveCount(0)
  expect(state.gatewayCalls).toEqual([])
})
