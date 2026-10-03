import { expect, test, type Page } from '@playwright/test'

// What a person sees in a workspace where a feature of the personal computer
// is turned off: the server's answers as service mode gives them, each shown
// where the feature would otherwise be offered.

const LOGIN_OFF = 'Claude sign-in through a local browser is not available in service mode. Connect Claude in Settings → Connected accounts.'
const UPDATER_OFF = 'No production updater runs in service mode: the server upgrades this workspace with its image, so there is no update record here and no desktop notification.'

async function serviceModeApi(page: Page, calls: string[]): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    calls.push(`${route.request().method()} ${url.pathname}`)
    if (url.pathname === '/api/claude-auth') {
      await route.fulfill({ json: {
        status: 'reauth_required', reason: 'Claude subscription sign-in is required.', checkedAt: '2026-07-15T09:00:00.000Z',
        verifiedAt: null, authMethod: null, subscriptionType: null, loginInProgress: false, loginUnavailable: LOGIN_OFF,
      } })
      return
    }
    if (url.pathname === '/api/claude-auth/login') {
      await route.fulfill({ status: 409, json: { error: LOGIN_OFF, code: 'service_mode' } })
      return
    }
    if (url.pathname === '/api/settings') {
      await route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', models: {} } })
      return
    }
    if (url.pathname === '/api/health') {
      await route.fulfill({ json: { status: 'ok', production: {
        status: 'off', reason: UPDATER_OFF, checkedAt: null, deployedCommit: null, remoteCommit: null, behind: null, failingSince: null, error: null,
      } } })
      return
    }
    if (url.pathname === '/api/snippets') {
      await route.fulfill({ json: { snippets: [{ trigger: ';sig', replace: 'Kind regards' }], version: 'a'.repeat(64), skills: { revision: 0, switches: [] }, desktop: 'poise-link' } })
      return
    }
    if (url.pathname === '/api/gh') {
      const body = route.request().postDataJSON() as { count_only?: boolean }
      await route.fulfill({ json: body.count_only ? { count: 0 } : { records: [] } })
      return
    }
    if (url.pathname === '/api/accounts') {
      await route.fulfill({ json: { accounts: [
        { id: 'claude', installed: true, version: '2.1.288', signedIn: false, identity: null, detail: null, login: { label: 'claude auth login --claudeai' } },
      ] } })
      return
    }
    await route.fulfill({ json: {} })
  })
}

test.beforeEach(async ({ page }) => {
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
})

test('signs in to Claude from the banner in a Connected accounts terminal, not a local browser', async ({ page }) => {
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  const calls: string[] = []
  await serviceModeApi(page, calls)
  // The terminal never reaches the preview server, which would run a real login.
  const terminals: string[] = []
  await page.routeWebSocket(/\/ws\/terminal/, (ws) => {
    terminals.push(new URL(ws.url()).searchParams.get('preset') ?? '')
    ws.onMessage(() => {})
    ws.send(JSON.stringify({ type: 'output', data: Buffer.from('Paste code here if prompted > ').toString('base64') }))
  })
  await page.goto('/')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Claude subscription sign-in required')
  await expect(alert).toContainText('Claude-backed work is paused.')
  await expect(alert).toContainText('Connect Claude in Settings → Connected accounts.')
  await expect(alert).not.toContainText('connected to this computer')

  await alert.getByRole('button', { name: 'Sign in with Claude' }).click()
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await expect(page.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true')
  const terminal = page.locator('.st-terminal[data-preset="claude"]')
  await expect(terminal.locator('.st-terminal-title')).toHaveText('claude auth login --claudeai')
  await expect(terminal.locator('.xterm-rows')).toContainText('Paste code here if prompted')
  expect(terminals).toEqual(['claude'])
  expect(calls).not.toContain('POST /api/claude-auth/login')
})

test('says in Settings that no production updater runs in a workspace', async ({ page }) => {
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await serviceModeApi(page, [])
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  const line = page.locator('.st-production')
  await expect(line).toHaveText(UPDATER_OFF)
  await expect(line).toHaveClass(/st-help-info/)
  await expect(page.locator('.st-production-updater')).toBeHidden()
  await expect(page.locator('.st-production-group')).not.toContainText('launchd', { useInnerText: true })
})

test('says snippets reach the desktop through Poise Link, not an Espanso on the server', async ({ page }) => {
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'snippets') })
  await serviceModeApi(page, [])
  await page.goto('/')
  const view = page.locator('#view-snippets')
  await expect(view.locator('.snip-row[data-trigger=";sig"]')).toBeVisible()
  await expect(view.locator('.snip-link-hint')).toBeVisible()
  await expect(view.locator('.snip-link-hint')).toHaveText('Snippets reach your desktop through Poise Link, which keeps Espanso there in sync.')
  await expect(view.locator('.snip-espanso-hint')).toBeHidden()
})
