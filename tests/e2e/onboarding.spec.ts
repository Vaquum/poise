import { expect, test, type Page } from '@playwright/test'
import { organization, setupWorkspace } from './onboarding-fixture'

// First-run setup in a workspace behind the gateway, with Poise's API and the
// gateway's stood in for (onboarding-fixture.ts).

const dialog = (page: Page) => page.getByRole('dialog', { name: /./ })
const next = (page: Page) => page.locator('.ob-next')

test('walks a new workspace through setup in order, saving each step where Settings keeps it', async ({ page }) => {
  const state = await setupWorkspace(page)
  await page.goto('/')
  await expect(dialog(page)).toBeVisible()
  // Everything else is dimmed and out of reach while setup runs.
  await expect(page.locator('#app')).toHaveAttribute('inert', '')
  await expect(page.locator('.ob-count')).toHaveText('Step 1 of 8 · Theme')
  await expect(page.locator('.ob-title')).toHaveText('Choose how Poise looks')
  await expect(page.locator('.ob-back')).toBeHidden()

  // 1. Theme, applied at once.
  await page.locator('[data-choice="dark"]').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await next(page).click()

  // 2. GitHub: the connection is checked with GitHub before Continue opens.
  await expect(page.locator('.ob-title')).toHaveText('Connect your GitHub account')
  await expect(page.locator('.ob-intro')).toContainText('octocat')
  await expect(page.locator('.ob-connection')).toHaveAttribute('data-state', 'connected')
  await expect(page.locator('.ob-connection-text')).toContainText('GitHub confirms the account works')
  await next(page).click()

  // 3. The agent account, prefilled from Settings and checked the same way.
  await expect(page.locator('.ob-title')).toHaveText('Add the agent account')
  await expect(page.locator('#ob-agent-login')).toHaveValue('octo-agent')
  await expect(page.locator('.ob-connection')).toHaveAttribute('data-state', 'connected')
  await expect(page.locator('.ob-skip')).toBeHidden()
  await next(page).click()
  expect(state.writes.filter((write) => write.path === '/api/onboarding/github').map((write) => write.body)).toEqual([
    { role: 'me', login: 'octocat' },
    { role: 'agent', login: 'octo-agent' },
  ])

  // 4. Organizations: one that failed before GitHub was connected is retried.
  await expect(page.locator('.ob-title')).toHaveText('Add your organizations')
  await expect(page.locator('.ob-org[data-org="acme"] .ob-org-state')).toHaveText('Activating…')
  await page.locator('.ob-org-input').fill('octo-org')
  await page.locator('.ob-org-input').press('Enter')
  await expect(page.locator('.ob-org[data-org="octo-org"]')).toBeVisible()
  await next(page).click()

  // 5. Time zone and refresh rate.
  await expect(page.locator('.ob-title')).toHaveText('Time zone and refresh rate')
  await page.locator('#ob-timezone').selectOption('Europe/Helsinki')
  await page.locator('.ob-refresh [data-rate="5m"]').click()
  await next(page).click()
  await expect(page.locator('.ob-title')).toHaveText('Sign in to your AI accounts')
  expect(state.timezone).toBe('Europe/Helsinki')
  expect(await page.evaluate(() => localStorage.getItem('poise-refresh-rate'))).toBe('5m')

  // 6. AI accounts in one place; a CLI that cannot report its sign-in counts once its login finished here.
  await expect(page.locator('.ob-ai-row')).toHaveCount(5)
  await expect(page.locator('.ob-ai-row[data-account="claude"] .ob-ai-state')).toHaveText('Signed in as octo@example.test')
  await expect(page.locator('.ob-ai-row[data-account="codex"] .ob-ai-connect')).toHaveText('Connect')
  await expect(page.locator('.ob-ai-row[data-account="grok"] .ob-ai-state')).toHaveText('Signed in here')
  await expect(page.locator('.ob-ai-row[data-account="muse"] .ob-ai-state')).toHaveText('Not signed in yet')
  await expect(page.locator('.ob-ai-row[data-account="antigravity"] .ob-ai-connect')).toBeDisabled()
  await next(page).click()

  // 7. Models: only signed-in providers can be chosen; the rest are dimmed.
  await expect(page.locator('.ob-title')).toHaveText('Choose your models')
  await expect(page.locator('.ob-chip-on')).toHaveText(['Claude', 'Grok'])
  const chatDefault = page.locator('.ob-place[data-place="chat"] select[data-slot="default"]')
  // The proposed default's provider (Codex) is not signed in, so a signed-in model replaces it.
  await expect(chatDefault).toHaveValue('opus-5-max')
  expect(await chatDefault.locator('option[value="gpt-6-astra-ultra"]').evaluate((option) => (option as HTMLOptionElement).disabled)).toBe(true)
  await expect(chatDefault.locator('optgroup[label="Not signed in"] option')).toHaveCount(2)
  await expect(page.locator('.ob-place[data-place="pr_review"] select')).toHaveCount(4)
  await next(page).click()
  await expect(page.locator('.ob-title')).toHaveText('Connect this computer')
  expect(state.models).toEqual({
    chat: { default: 'opus-5-max', fallback: 'opus-5-high' },
    pr_review: { default: 'opus-5-max', fallback: 'opus-5-high', secondary: 'grok-5-heavy', tertiary: 'gpt-6-astra-ultra' },
  })

  // 8. This computer, through the gateway's pairing.
  const link = page.locator('.ob-dialog .pl')
  await expect(link.locator('.pl-command-text')).toContainText('install.sh | sh')
  await link.locator('.pl-code').fill('BCDF-GHJK')
  await link.locator('.pl-approve').click()
  await expect(page.locator('.ob-status')).toHaveText('This computer is paired. Continue when you are ready.', { timeout: 10_000 })
  await next(page).click()

  // Finish: where to change all of it, then Poise itself.
  await expect(page.locator('.ob-title')).toHaveText('You\'re all set')
  await expect(page.locator('.ob-count')).toHaveText('Setup complete')
  await expect(page.locator('.ob-summary-row')).toContainText([
    'Dark', 'octocat', 'octo-agent', 'acme (activating), octo-org (activating)', 'Europe/Helsinki, refreshing every 5 minutes',
    'Claude, Grok', '1 computer paired with Poise Link',
  ])
  await expect(page.locator('.ob-later')).toBeHidden()
  await expect(page.locator('.ob-settings-hint')).toContainText('Open the menu ☰ at the top right and choose Settings')
  await expect(next(page)).toHaveText('Open Poise')
  await next(page).click()
  await expect(page.locator('.ob-backdrop')).toHaveCount(0)
  await expect(page.locator('#app')).not.toHaveAttribute('inert', '')
  await expect(page.locator('#menu-toggle')).toHaveClass(/ob-pulse/)
  expect(state.status).toBe('done')
  expect(state.writes.filter((write) => write.path === '/api/onboarding').map((write) => write.body.step ?? 'done')).toEqual([
    'github', 'agent', 'organizations', 'time', 'ai', 'models', 'link', 'finish', 'done',
  ])

  // Done stays done.
  await page.reload()
  await expect(page.locator('#view-current')).toBeVisible()
  await expect(page.locator('.ob-backdrop')).toHaveCount(0)
})

test('connects GitHub through its one-time code, with gh answered and out of sight', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const state = await setupWorkspace(page, { step: 'github', githubAccounts: [] })
  // gh's own sign-in, as the workspace's terminal socket relays it.
  const inputs: string[] = []
  let approve: (() => void) | null = null
  await page.exposeFunction('approveAtGitHub', () => approve?.())
  await page.routeWebSocket(/\/ws\/terminal\?preset=gh$/, (socket) => {
    const out = (text: string) => socket.send(JSON.stringify({ type: 'output', data: Buffer.from(text).toString('base64') }))
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { type: string, data?: string }
      if (frame.type !== 'input') return
      inputs.push(frame.data ?? '')
      if (inputs.length === 1) {
        out('\u001b[0;32m?\u001b[0m Authenticate Git with your GitHub credentials? \u001b[0;36mYes\u001b[0m\r\n\r\n'
          + '\u001b[0;33m!\u001b[0m Failed to copy one-time code to clipboard\r\n'
          + '\u001b[0;33m!\u001b[0m First copy your one-time code: \u001b[0;1;39m0281-B27E\u001b[0m\r\n'
          + 'Press Enter to open https://github.com/login/device in your browser... ')
      } else if (inputs.length === 2) {
        out('\r\n\u001b[0;31m!\u001b[0m Failed opening a web browser at https://github.com/login/device\r\n')
      }
    })
    out('\u001b[0;32m?\u001b[0m \u001b[0;1;39mAuthenticate Git with your GitHub credentials? \u001b[0m(Y/n) ')
    // The person approves at GitHub; gh says so and exits.
    approve = () => {
      state.githubAccounts.push('octocat')
      out('\u001b[0;32m\u2713\u001b[0m Authentication complete.\r\n\u001b[0;32m\u2713\u001b[0m Logged in as octocat\r\n')
      socket.send(JSON.stringify({ type: 'exit', code: 0 }))
      void socket.close({ code: 1000 })
    }
  })
  await page.goto('/')
  await expect(page.locator('.ob-title')).toHaveText('Connect your GitHub account')
  await expect(page.locator('.ob-connection-text')).toHaveText('Not connected yet.')
  await expect(next(page)).toBeDisabled()

  await page.locator('.ob-connect').click()
  await expect(page.locator('.ob-device')).toBeVisible()
  await expect(page.locator('.ob-device-code')).toHaveText('0281-B27E')
  // The code's own buttons are the only actions while it shows.
  await expect(page.locator('.ob-connect')).toBeHidden()
  await expect(page.locator('.ob-device-status-text')).toHaveText('Waiting for you to approve at GitHub…')
  // gh's own output, its failed clipboard and browser included, stays folded away.
  await expect(page.locator('.st-terminal')).toHaveCount(0)
  await expect(page.locator('.ob-device-log')).not.toHaveAttribute('open', '')
  await expect(page.locator('.ob-device-log pre')).toContainText('Failed opening a web browser')
  expect(inputs).toEqual(['\r', '\r'])

  // One click copies the code and opens GitHub's device page (stood in for: no test reaches GitHub).
  await context.route(/^https:\/\/github\.com\//, (route) => route.fulfill({ contentType: 'text/html', body: '<title>GitHub</title>' }))
  const popup = page.waitForEvent('popup')
  await page.locator('.ob-device-copy').click()
  expect((await popup).url()).toBe('https://github.com/login/device')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('0281-B27E')

  await page.evaluate(() => (window as unknown as { approveAtGitHub: () => void }).approveAtGitHub())
  await expect(page.locator('.ob-connection')).toHaveAttribute('data-state', 'connected')
  await expect(page.locator('.ob-device')).toBeHidden()
  await expect(page.locator('.ob-connect')).toHaveText('Reconnect')
  await expect(next(page)).toBeEnabled()
  expect(state.me).toBe('octocat')
})

test('resumes where setup was left, and lets the steps be revisited with Back', async ({ page }) => {
  await setupWorkspace(page, { step: 'time', me: 'octocat' })
  await page.goto('/')
  await expect(page.locator('.ob-count')).toHaveText('Step 5 of 8 · Time')
  await expect(page.locator('.ob-rail-done')).toHaveCount(4)
  await page.locator('.ob-back').click()
  await expect(page.locator('.ob-title')).toHaveText('Add your organizations')
  // Finish later closes setup for now; it opens again at the same step.
  await page.locator('.ob-later').click()
  await expect(page.locator('.ob-backdrop')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.ob-title')).toHaveText('Add your organizations')
})

test('opens at pairing when Poise Link sends the person to /link during setup', async ({ page }) => {
  await setupWorkspace(page, { step: 'github' })
  await page.goto('/?settings=link')
  await expect(page.locator('.ob-title')).toHaveText('Connect this computer')
  await expect(page.locator('.ob-count')).toHaveText('Step 8 of 8 · This computer')
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/)
  await expect(page).toHaveURL(/\/$/)
})

test('never opens setup in a workspace that is already set up, and offers to run it again', async ({ page }) => {
  await setupWorkspace(page, { status: 'done', step: 'finish', me: 'octocat', organizations: [organization('acme', 'ready')] })
  await page.goto('/')
  await expect(page.locator('#view-current')).toBeVisible()
  await expect(page.locator('.ob-backdrop')).toHaveCount(0)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-action="settings"]').click()
  await page.locator('.st-run-setup').click()
  await expect(page.locator('.ob-title')).toHaveText('Choose how Poise looks')
  await expect(page.locator('#settings-panel')).not.toHaveClass(/open/)
})
