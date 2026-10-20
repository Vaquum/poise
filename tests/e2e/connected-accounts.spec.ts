import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { build } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { STATUS, fakeCalls, script, setScript, writeFakeClis } from '../fixtures/accounts/fake-clis'
import { cliHomes } from '../fixtures/cli-isolation'
import { CATALOG } from '../model-catalog-fixture'
import { gatewayKeys, serviceEnvironment } from '../service-fixture'
import { WebSocket } from 'ws'
import { workspace } from './fixtures/workspace'

// Settings → Connected accounts against fake CLIs: the production server
// and its real terminal, with nothing but the fakes on the server's PATH.

const DEVICE_PROMPT = 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-1234\n'

async function start(page: Page, info: TestInfo, options: { service?: boolean, reuse?: boolean, seed?: Record<string, string>, antigravity?: boolean } = {}) {
  const root = info.outputPath('runtime')
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(join(root, 'agent'), { recursive: true })
  if (!options.reuse) {
    await writeFakeClis(bin, home, {
      claude: script('claude', STATUS.claudeSubscription),
      codex: script('codex', STATUS.codexSignedOut, { prompt: DEVICE_PROMPT, afterLogin: STATUS.codexChatGpt }),
      gh: script('gh', STATUS.ghTwoAccounts),
      grok: script('grok', undefined, { prompt: 'Open https://example.test/device and enter ABCD-1234\n' }),
      muse: script('muse', undefined, { prompt: 'Open https://example.test/device and enter ABCD-1234\n' }),
      ...(options.antigravity ? { antigravity: script('antigravity', undefined, { prompt: 'Sign in to Antigravity\n' }) } : {}),
    })
    await writeFile(join(bin, 'caller.cjs'), `process.stdout.write(process.argv.includes('--models') ? ${JSON.stringify(JSON.stringify(CATALOG))} : '[]')`)
    for (const command of ['agent-interface', 'github-interface', 'github-datastore']) {
      await writeFile(join(bin, command), '#!/bin/sh\nexec node "${0%/*}/caller.cjs" "$@"\n')
      await chmod(join(bin, command), 0o755)
    }
  }
  const bundle = join(root, 'accounts-server.mjs')
  await build({
    entryPoints: ['tests/fixtures/accounts/accounts-server.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    // Where Poise finds its Claude wrapper, as in the real bundle.
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('server/process.ts')).href) },
    logLevel: 'silent',
  })
  const child = spawn(process.execPath, [bundle], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    // Only the fakes on PATH, and every CLI's configuration in folders of its
    // own; HOME is the fakes' home, where they keep their state.
    env: { ...cliHomes(join(root, 'homes')), ...(options.service ? serviceEnvironment(gatewayKeys()) : {}), HOME: home, PATH: bin, LANG: 'en_US.UTF-8', FAKE_CLI_BIN: bin, CALLER_BIN_ROOT: bin, AGENT_INTERFACE_ROOT: join(root, 'agent'), ACCOUNTS_SEED: options.seed ? JSON.stringify(options.seed) : '' },
  })
  let stderr = ''
  child.stderr!.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4096) })
  const port = await new Promise<number>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture startup deadline: ${stderr}`)), 30_000)
    let output = ''
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
      for (const line of output.split('\n')) {
        try { const value = JSON.parse(line); if (value.port) { clearTimeout(timer); done(value.port) } } catch { /* not the ready line */ }
      }
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${stderr}`)) })
  })
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  return { origin: `http://127.0.0.1:${port}`, child, home }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('exit', () => { clearTimeout(timer); done() })
    child.kill('SIGTERM')
  })
}

test('connects a CLI from Settings in a terminal and shows its new sign-in', async ({ page }, info) => {
  test.setTimeout(90_000)
  const fixture = await start(page, info)
  try {
    // Where a sign-in alert opens the workspace: Settings → Connected accounts.
    await page.goto(`${fixture.origin}/?settings=accounts`)
    await expect(page.locator('#settings-panel')).toHaveClass(/open/)
    await expect(page.locator('#settings-panel')).toHaveAttribute('data-section', 'accounts')
    await expect(page).toHaveURL(`${fixture.origin}/`)

    const row = (id: string) => page.locator(`.st-account[data-account="${id}"]`)
    // Reading six CLIs starts a dozen processes; give a loaded machine time.
    const PROBE = { timeout: 20_000 }
    await expect(row('claude').locator('.st-account-state')).toHaveText('Signed in as octocat@example.com', PROBE)
    await expect(row('claude')).toContainText('2.1.288')
    await expect(row('claude')).toContainText('Claude Max subscription')
    await expect(row('codex').locator('.st-account-state')).toHaveText('Not signed in')
    await expect(row('codex').getByRole('button', { name: 'Connect Codex' })).toHaveAttribute('data-help', 'Opens a sign-in terminal: codex login --device-auth')
    await expect(row('gh').locator('.st-account-state')).toHaveText('Signed in as octocat')
    // Settings → General names octocat as your account and octo-agent as the agent's.
    await expect(row('gh').locator('.st-gh-account[data-login="octocat"] .st-gh-notes')).toHaveText('active · your GitHub account')
    await expect(row('gh').locator('.st-gh-account[data-login="octo-agent"] .st-gh-notes')).toHaveText('automation account')
    await expect(row('gh').locator('.st-gh-missing')).toHaveCount(0)
    await expect(row('grok').locator('.st-account-state')).toHaveText('Sign-in not reported')
    await expect(row('grok')).toContainText('Grok\'s CLI has no command that reports whether it is signed in.')
    await expect(row('antigravity').locator('.st-account-state')).toHaveText('Not installed')
    await expect(page.getByRole('button', { name: 'Connect Antigravity' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Reconnect Claude' })).toBeEnabled()
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
      await page.locator('#settings-panel').screenshot({ path: info.outputPath(`connected-accounts-${theme}.png`), animations: 'disabled' })
    }

    await page.getByRole('button', { name: 'Connect Codex' }).click()
    const terminal = page.locator('.st-terminal[data-preset="codex"]')
    await expect(terminal.locator('.st-terminal-title')).toHaveText('codex login --device-auth')
    await expect(terminal.locator('.xterm-rows')).toContainText('ABCD-1234')
    await expect(terminal.locator('.st-terminal-status')).toHaveText('Running in your workspace. Close ends it.')
    await expect(page.locator('#settings-panel')).toHaveClass(/st-terminal-open/)
    await page.setViewportSize({ width: 420, height: 820 })
    await expect.poll(() => page.locator('#settings-panel').evaluate((panel) => {
      const frame = document.getElementById('menu-surface')!
      return panel.scrollWidth - frame.clientWidth
    })).toBeLessThanOrEqual(1)
    await page.setViewportSize({ width: 1280, height: 720 })
    // One login at a time from here.
    await expect(page.getByRole('button', { name: 'Reconnect Claude' })).toBeDisabled()
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; window.dispatchEvent(new CustomEvent('poise:theme-changed')) }, theme)
      await page.locator('#settings-panel').screenshot({ path: info.outputPath(`terminal-${theme}.png`), animations: 'disabled' })
    }

    // The device-code login waits for Enter; the terminal has the focus.
    await page.keyboard.press('Enter')
    await expect(terminal.locator('.st-terminal-status')).toHaveText('Exited with code 0.')
    await expect(row('codex').locator('.st-account-state')).toHaveText('Signed in', PROBE)
    await expect(row('codex')).toContainText('Signed in with ChatGPT')
    await expect(row('codex').getByRole('button', { name: 'Reconnect Codex' })).toBeEnabled()

    await terminal.getByRole('button', { name: 'Close' }).click()
    await expect(terminal).toHaveCount(0)
    await expect(page.locator('#settings-panel')).not.toHaveClass(/st-terminal-open/)

    const calls = await fakeCalls(fixture.home)
    const login = calls.find((call) => call.name === 'codex' && call.args.join(' ') === 'login --device-auth')
    expect(login).toMatchObject({ tty: true, term: 'xterm-256color' })
    // Only status commands ran on their own; the one login was the person's.
    expect(calls.filter((call) => call.args.includes('login') && call.args.join(' ') !== 'login status')).toHaveLength(1)
  } finally {
    await stop(fixture.child)
  }
})


test('account sign-in notices are amber while account read failures stay red', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/accounts**', async route => {
    const id = new URL(route.request().url()).searchParams.get('id') ?? 'gh'
    await route.fulfill({ json: { accounts: [{ id, installed: true, version: '2.92.0', signedIn: false, identity: null, detail: null,
      login: { label: 'Connect account' }, ...(id === 'gh' ? { accounts: [
        { login: 'octocat', active: true, signedIn: false, detail: 'Sign-in needed' },
        { login: 'octo-agent', active: false, signedIn: false, detail: 'Sign-in needed' },
      ] } : {}) }] } })
  })
  await page.locator('#menu-toggle').click()
  await page.locator('#menu-popover [data-settings="accounts"]').click()
  const row = page.locator('.st-account[data-account="gh"]')
  await expect(row.locator('.st-gh-missing')).toHaveCount(2)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    for (const note of await row.locator('.st-gh-missing, .st-gh-problem').all()) {
      await expect.soft(note).toHaveCSS('color', 'rgb(168, 121, 43)')
    }
    for (const state of await row.locator('.st-account-state-off').all()) {
      await expect.poll(() => state.evaluate(el => getComputedStyle(el, '::before').backgroundColor)).toBe('rgb(168, 121, 43)')
    }
  }
  await page.route('**/api/accounts**', route => route.fulfill({ status: 503, json: { error: 'Fixture accounts unavailable' } }))
  await page.keyboard.press('Escape')
  await page.locator('#menu-toggle').click()
  await page.locator('#menu-popover [data-settings="accounts"]').click()
  await expect(page.locator('.st-account-checks-status')).toContainText('Could not check gh')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await expect.soft(page.locator('.st-account-checks-status')).toHaveCSS('color', 'rgb(184, 80, 72)')
  }
})


for (const service of [false, true]) {
  test(`retains Grok and Muse terminal sign-ins across Settings and process restarts (${service ? 'service' : 'local'})`, async ({ page }, info) => {
    test.setTimeout(120_000)
    let fixture = await start(page, info, { service })
    try {
      // Login before any onboarding request: the production exit hook must be independent of setup.
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${fixture.origin.replace('http:', 'ws:')}/ws/terminal?preset=muse`, { origin: fixture.origin })
        socket.on('error', reject)
        socket.on('message', raw => {
          const frame = JSON.parse(String(raw))
          if (frame.type === 'output' && Buffer.from(frame.data, 'base64').toString().includes('ABCD-1234')) socket.send(JSON.stringify({ type: 'input', data: '\r' }))
          if (frame.type === 'exit') { socket.close(); if (frame.code === 0) resolve(); else reject(new Error(`login exit ${frame.code}`)) }
        })
      })
      await page.goto(`${fixture.origin}/?settings=accounts`)
      const row = (id: string) => page.locator(`.st-account[data-account="${id}"]`)
      await expect(row('muse').locator('.st-account-state')).toHaveText('Signed in here', { timeout: 20_000 })
      await row('grok').getByRole('button', { name: 'Connect Grok' }).click()
      const terminal = page.locator('.st-terminal[data-preset="grok"]')
      await expect(terminal.locator('.xterm-rows')).toContainText('ABCD-1234')
      await page.keyboard.press('Enter')
      await expect(terminal.locator('.st-terminal-status')).toHaveText('Exited with code 0.')
      await expect(row('grok').locator('.st-account-state')).toHaveText('Signed in here', { timeout: 20_000 })
      await expect(row('grok')).toContainText('The CLI cannot verify its current status.')
      await expect(row('grok').getByRole('button', { name: 'Reconnect Grok' })).toBeEnabled()
      await terminal.getByRole('button', { name: 'Close' }).click()
      await page.keyboard.press('Escape')
      await page.locator('#menu-toggle').click()
      await page.locator('#menu-popover [data-settings="accounts"]').click()
      await expect(row('grok').locator('.st-account-state')).toHaveText('Signed in here')
      await page.reload()
      await page.goto(`${fixture.origin}/?settings=accounts`)
      await expect(row('grok').locator('.st-account-state')).toHaveText('Signed in here', { timeout: 20_000 })
      const before = await (await page.request.get(`${fixture.origin}/api/accounts?id=grok`)).json()
      expect(before.accounts[0]).toMatchObject({ signedIn: null, identity: null, signInRecordedAt: expect.any(String) })
      await page.locator('#settings-panel').screenshot({ path: info.outputPath('completed-grok-login.png') })
      await stop(fixture.child)
      fixture = await start(page, info, { service, reuse: true })
      await page.goto(`${fixture.origin}/?settings=accounts`)
      await expect(row('grok').locator('.st-account-state')).toHaveText('Signed in here', { timeout: 20_000 })
      await expect(row('muse').locator('.st-account-state')).toHaveText('Signed in here')
      const after = await (await page.request.get(`${fixture.origin}/api/accounts?id=grok`)).json()
      expect(after.accounts[0].signInRecordedAt).toBe(before.accounts[0].signInRecordedAt)
      const setup = await (await page.request.get(`${fixture.origin}/api/onboarding`)).json()
      if (service) expect(setup).toMatchObject({ status: 'done', step: 'finish', completedAt: '2026-10-09T07:00:00Z' })
      else {
        expect(setup).toEqual({ available: false, status: 'done' })
        expect((await page.request.post(`${fixture.origin}/api/onboarding`, { data: { account: 'grok', signedIn: false } })).status()).toBe(404)
      }
    } finally { await stop(fixture.child) }
  })
}

test('preserves legacy confirmations and setup controls with production Accounts responses', async ({ page }, info) => {
  test.setTimeout(120_000)
  const at = '2026-10-09T06:00:00Z'
  const seed = { grok: at, muse: at, antigravity: at, claude: at, codex: at, gh: at }
  const fixture = await start(page, info, { service: true, seed, antigravity: true })
  try {
    await setScript(fixture.home, 'codex', { ...script('codex'), 'login status': { stdout: 'unreadable status' } })
    await page.goto(`${fixture.origin}/?settings=accounts`)
    const row = (id: string) => page.locator(`.st-account[data-account="${id}"]`)
    for (const id of ['grok', 'muse', 'antigravity']) await expect(row(id).locator('.st-account-state')).toHaveText('Signed in here', { timeout: 20_000 })
    await expect(row('codex').locator('.st-account-state')).toHaveText('Sign-in not reported')
    await expect(row('codex')).toContainText('gave no answer Poise can read')
    expect((await (await page.request.get(`${fixture.origin}/api/onboarding`)).json()).logins).toEqual(seed)
    // Warm both cache shapes; changes must be visible immediately, with no 15s wait.
    for (const id of ['grok', 'muse', 'antigravity']) {
      await page.request.get(`${fixture.origin}/api/accounts?id=${id}`)
      for (const signedIn of [false, true]) {
        await page.request.post(`${fixture.origin}/api/onboarding`, { data: { account: id, signedIn } })
        for (const query of ['', `?id=${id}`]) {
          const body = await (await page.request.get(`${fixture.origin}/api/accounts${query}`)).json()
          expect(!!body.accounts.find((account: { id: string }) => account.id === id).signInRecordedAt).toBe(signedIn)
        }
        await page.goto(`${fixture.origin}/?settings=accounts`)
        await expect(row(id).locator('.st-account-state')).toHaveText(signedIn ? 'Signed in here' : 'Sign-in not reported')
      }
    }
    await page.request.post(`${fixture.origin}/api/onboarding`, { data: { restart: true } })
    await page.request.post(`${fixture.origin}/api/onboarding`, { data: { step: 'ai' } })
    await page.goto(fixture.origin)
    const setupGrok = page.locator('.ob-ai-row[data-account="grok"]')
    await expect(setupGrok.locator('.ob-ai-state')).toHaveText('Signed in here')
    await setupGrok.locator('.ob-ai-mark').click()
    await expect(setupGrok.locator('.ob-ai-state')).toHaveText('Not signed in yet')
    await expect(page.locator('.ob-ai-row[data-account="codex"] .ob-ai-mark')).toHaveCount(0)
    await page.locator('.ob-next').click()
    await expect(page.locator('.ob-chip-on')).toHaveText(['Claude', 'Antigravity', 'Muse'])
    const stored = await (await page.request.get(`${fixture.origin}/api/onboarding`)).json()
    expect(stored.logins).toMatchObject({ claude: at, codex: at, gh: at })
    expect(stored.logins).not.toHaveProperty('grok')
  } finally { await stop(fixture.child) }
})


test('can withdraw a retained setup confirmation while the version probe fails', async ({ page }, info) => {
  test.setTimeout(90_000)
  const fixture = await start(page, info, { service: true, seed: { grok: '2026-10-09T06:00:00Z' } })
  try {
    await setScript(fixture.home, 'grok', { '--version': { stderr: 'broken installation', code: 1 } })
    await page.request.post(`${fixture.origin}/api/onboarding`, { data: { restart: true } })
    await page.request.post(`${fixture.origin}/api/onboarding`, { data: { step: 'ai' } })
    await page.goto(fixture.origin)
    const row = page.locator('.ob-ai-row[data-account="grok"]')
    await expect(row.locator('.ob-ai-state')).toContainText('broken installation')
    await expect(row.locator('.ob-ai-mark')).toHaveText('Not signed in')
    await row.locator('.ob-ai-mark').click()
    await expect(row.locator('.ob-ai-mark')).toHaveCount(0)
    await expect(row.locator('.ob-ai-state')).toContainText('broken installation')
    const setup = await (await page.request.get(`${fixture.origin}/api/onboarding`)).json()
    expect(setup.logins).not.toHaveProperty('grok')
    const accounts = await (await page.request.get(`${fixture.origin}/api/accounts?id=grok`)).json()
    expect(accounts.accounts[0]).toMatchObject({ signedIn: null, detail: expect.stringContaining('broken installation') })
    expect(accounts.accounts[0]).not.toHaveProperty('signInRecordedAt')
  } finally { await stop(fixture.child) }
})
