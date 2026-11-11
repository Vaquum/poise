import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures/classic'
import { loadConfig } from '../../gateway/src/config'
import { DockerClient } from '../../gateway/src/docker'
import { createGateway } from '../../gateway/src/gateway'
import { GitHubClient } from '../../gateway/src/github'
import { loadOrCreateKeys } from '../../gateway/src/keys'
import { createLogger } from '../../gateway/src/log'
import { Orchestrator } from '../../gateway/src/orchestrator'
import { Store } from '../../gateway/src/store'

// What a person sees in a workspace where a feature of the personal computer
// is turned off: the server's answers as service mode gives them, each shown
// where the feature would otherwise be offered.

const LOGIN_OFF = 'Claude sign-in through a local browser is not available in service mode. Connect Claude in Settings → Accounts.'
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
    if (url.pathname === '/_poise/api/devices') {
      await route.fulfill({ json: { devices: [] } })
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
  await expect(alert).toContainText('Connect Claude in Settings → Accounts.')
  await expect(alert).not.toContainText('connected to this computer')

  await alert.getByRole('button', { name: 'Sign in with Claude' }).click()
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await expect(page.locator('#settings-panel')).toHaveAttribute('data-section', 'accounts')
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
  await page.locator('[data-settings="general"]').click()
  const line = page.locator('.st-production')
  await expect(line).toHaveText(UPDATER_OFF)
  await expect(line).toHaveClass(/st-help-info/)
  await expect(page.locator('.st-production-updater')).toBeHidden()
  await expect(page.locator('.st-production-group')).not.toContainText('launchd', { useInnerText: true })
})

test('keeps desktop connection messaging out of the service Snippets toolbar', async ({ page }) => {
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'snippets') })
  await serviceModeApi(page, [])
  await page.goto('/')
  const view = page.locator('#view-snippets')
  await expect(view.locator('.snip-row[data-trigger=";sig"]')).toBeVisible()
  await expect(view.locator('.snip-link-hint, .snip-link-settings')).toHaveCount(0)
  await expect(view).not.toContainText('Poise Link')
  await expect(view.locator('.snip-espanso-hint')).toBeHidden()
})

test('submits MCP consent to a registered callback whose origin is also a font source', async ({ page, context, request, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium enforces form-action on the consent redirect.')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-consent-'))
  const config = loadConfig({ POISE_DOMAIN: 'poise.test', POISE_MCP_ENABLED: '1', POISE_GATEWAY_DATA: dir,
    POISE_GITHUB_CLIENT_ID: 'fixture', POISE_GITHUB_CLIENT_SECRET: 'fixture', POISE_ADMINS: 'alice',
    POISE_GITHUB_URL: 'https://github.poise.invalid', POISE_GITHUB_API_URL: 'https://github.poise.invalid',
    POISE_GATEWAY_CONTAINER: 'fixture-gateway', POISE_RUNTIME_IMAGE: 'fixture-runtime' })
  const log = createLogger(line => console.log(line))
  const store = new Store(join(dir, 'gateway.db'), Date.now)
  const keys = loadOrCreateKeys(dir, log)
  // Consent needs no workspace or Docker calls; neither client points at a live service.
  const docker = new DockerClient(join(dir, 'unused-docker.sock'))
  const upstream = () => ({ host: 'unused.poise.invalid', port: 5555 })
  const deps = { config, store, keys, docker, log, now: Date.now, upstream }
  const gateway = createGateway({ ...deps, github: new GitHubClient(config), orchestrator: new Orchestrator(deps) })
  // The classic fixture's route belongs to the context, so it goes too.
  await page.unrouteAll()
  await context.unrouteAll()
  const cdp = await context.newCDPSession(page)
  try {
    await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
    const local = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`
    const apex = 'https://poise.test'
    const callback = 'https://rsms.me/callback'
    store.saveSignIn({ handle: 'alice', login: 'Alice', githubId: 1001, accessOrg: null })
    const session = store.createApexSession('alice', 60_000)
    await context.addCookies([{ name: 'poise_gw', value: session.id, url: apex, httpOnly: true, secure: true, sameSite: 'Lax' }])
    // Playwright routes only the first request in a redirect chain. CDP also
    // isolates the callback while Chromium still enforces the real page's CSP.
    cdp.on('Fetch.requestPaused', async ({ requestId, request: incoming }) => {
      const url = new URL(incoming.url)
      if (url.origin === apex) {
        const response = await request.fetch(`${local}${url.pathname}${url.search}`, {
          method: incoming.method, headers: { ...incoming.headers, host: url.host },
          data: incoming.postData, maxRedirects: 0,
        })
        await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: response.status(),
          responseHeaders: response.headersArray(), body: (await response.body()).toString('base64') })
      } else if (`${url.origin}${url.pathname}` === callback) {
        await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/html' }],
          body: Buffer.from('<p>Registered callback reached</p>').toString('base64') })
      } else await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' })
    })
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    const registration = await request.post(`${local}/mcp/register`, { headers: { host: 'poise.test' },
      data: { redirect_uris: [callback], token_endpoint_auth_method: 'none' } })
    expect(registration.status()).toBe(201)
    const verifier = 'a'.repeat(43)
    const params = new URLSearchParams({ client_id: (await registration.json()).client_id, redirect_uri: callback,
      response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', resource: `${apex}/mcp`, scope: 'poise:read', state: 'collision-state' })
    const consent = await page.goto(`${apex}/mcp/authorize?${params}`)
    expect(consent?.headers()['content-security-policy']).toContain('font-src https://rsms.me;')
    await page.getByRole('button', { name: 'Allow read access' }).click()
    await expect(page.getByText('Registered callback reached', { exact: true })).toBeVisible()
    const arrived = new URL(page.url())
    expect(`${arrived.origin}${arrived.pathname}`).toBe(callback)
    expect(arrived.searchParams.get('state')).toBe('collision-state')
    expect(arrived.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  } finally {
    await page.close()
    await gateway.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
