import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { build } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { STATUS, fakeCalls, script, writeFakeClis } from '../fixtures/accounts/fake-clis'

// Settings → Connected accounts against fake CLIs: the real accounts route
// and the real terminal, with nothing but the fakes on the server's PATH.

const DEVICE_PROMPT = 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-1234\n'

async function start(page: Page, info: TestInfo, assets: string) {
  const root = info.outputPath('runtime')
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(root, { recursive: true })
  await writeFakeClis(bin, home, {
    claude: script('claude', STATUS.claudeSubscription),
    codex: script('codex', STATUS.codexSignedOut, { prompt: DEVICE_PROMPT, afterLogin: STATUS.codexChatGpt }),
    gh: script('gh', STATUS.ghTwoAccounts),
    grok: script('grok'),
    muse: script('muse'),
  })
  const bundle = join(root, 'accounts-server.mjs')
  await build({
    entryPoints: ['tests/fixtures/accounts/accounts-server.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    // Where Poise finds its Claude wrapper, as in the real bundle.
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve('server/process.ts')).href) },
    logLevel: 'silent',
  })
  const child = spawn(process.execPath, [bundle], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: bin, HOME: home, LANG: 'en_US.UTF-8', ACCOUNTS_ASSETS_URL: assets },
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

test('connects a CLI from Settings in a terminal and shows its new sign-in', async ({ page, baseURL }, info) => {
  test.setTimeout(90_000)
  const fixture = await start(page, info, baseURL!)
  try {
    await page.goto(fixture.origin)
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('[data-action="settings"]').click()
    await page.getByRole('tab', { name: 'Accounts' }).click()

    const row = (id: string) => page.locator(`.st-account[data-account="${id}"]`)
    // Reading six CLIs starts a dozen processes; give a loaded machine time.
    const PROBE = { timeout: 20_000 }
    await expect(row('claude').locator('.st-account-state')).toHaveText('Signed in as octocat@example.com', PROBE)
    await expect(row('claude')).toContainText('2.1.288')
    await expect(row('claude')).toContainText('Claude Max subscription')
    await expect(row('codex').locator('.st-account-state')).toHaveText('Not signed in')
    await expect(row('codex')).toContainText('Runs codex login --device-auth')
    await expect(row('gh').locator('.st-account-state')).toHaveText('Signed in as octocat')
    // Settings → General names octocat as your account and octo-agent as the agent's.
    await expect(row('gh').locator('.st-gh-account[data-login="octocat"] .st-gh-notes')).toHaveText('active · your GitHub account')
    await expect(row('gh').locator('.st-gh-account[data-login="octo-agent"] .st-gh-notes')).toHaveText('agent account')
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
