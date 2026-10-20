import { feedback } from './fixtures/view-feedback'
import { expect, test, type Page } from '@playwright/test'

// Snippets → Import against the real server: an Espanso file's plain pairs
// join the library, the view lists what was skipped and why, and the desktop
// copy Poise Link fetches carries the new pairs and nothing that runs a command.

async function quietOtherApis(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/api/snippets')) return route.continue()
    if (url.pathname === '/api/settings') return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', models: {} } })
    if (url.pathname === '/api/claude-auth') {
      return route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: null, verifiedAt: null, authMethod: 'claude.ai', subscriptionType: 'max', loginInProgress: false } })
    }
    if (url.pathname === '/api/gh') {
      const body = route.request().postDataJSON() as { count_only?: boolean }
      return route.fulfill({ json: body.count_only ? { count: 0 } : { records: [] } })
    }
    return route.fulfill({ json: {} })
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'snippets') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await quietOtherApis(page)
})

// Unique per attempt: the preview server's library outlives a retried test.
const tag = () => `${test.info().retry}-${Date.now().toString(36)}`

test('imports the plain pairs of a pasted Espanso file and lists what it skipped', async ({ page }, info) => {
  const id = tag()
  const addr = `:addr-${id}`
  const sig = `:sig-${id}`
  const pwn = `:pwn-${id}`
  const file = [
    'global_vars:',
    '  - name: who',
    '    type: shell',
    '    params: { cmd: whoami }',
    'matches:',
    `  - trigger: "${addr}"`,
    '    replace: "1 Main St"',
    `  - trigger: "${sig}"`,
    '    replace: Best, Octo',
    `  - trigger: "${pwn}"`,
    '    replace: "{{out}}"',
    '    vars: [{ name: out, type: shell, params: { cmd: id } }]',
    `  - trigger: "${addr}"`,
    '    replace: a second address',
    '',
  ].join('\n')

  await page.goto('/')
  const view = page.locator('#view-snippets')
  const panel = view.locator('.snip-import')
  await expect(panel).toBeHidden()
  await view.locator('.snip-import-open').click()
  await expect(panel).toBeVisible()
  await expect(view.locator('.snip-import-open')).toHaveAttribute('aria-expanded', 'true')
  await panel.getByRole('textbox', { name: 'Espanso match file' }).fill(file)
  await panel.getByRole('button', { name: 'Import', exact: true }).click()

  const report = await feedback(page, 'Snippet import completed')
  await expect(report).toContainText('Added 2 snippets. Skipped 3:')
  await expect(report).toContainText('global_vars is not a snippet')
  await expect(report).toContainText(`${pwn} — not a plain snippet: it runs a shell command`)
  await expect(report).toContainText(`${addr} — duplicate trigger: an earlier entry in this file has this trigger`)
  await page.locator('#notification-bell').click()
  await expect(view.locator(`.snip-row[data-trigger="${addr}"]`)).toContainText('1 Main St')
  await expect(view.locator(`.snip-row[data-trigger="${sig}"]`)).toContainText('Best, Octo')
  await expect(view.locator(`.snip-row[data-trigger="${pwn}"]`)).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('snippets-import.png'), animations: 'disabled' })

  // The same file again: everything is already there.
  await panel.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(await feedback(page, 'Snippet import completed')).toContainText('Added 0 snippets. Skipped 5:')
  await page.locator('#notification-bell').click()

  const library = await (await page.request.get('/api/snippets')).json() as { snippets: Array<{ trigger: string, replace: string }> }
  expect(library.snippets).toEqual(expect.arrayContaining([{ trigger: addr, replace: '1 Main St' }, { trigger: sig, replace: 'Best, Octo' }]))
  expect(library.snippets.map((snippet) => snippet.trigger)).not.toContain(pwn)
  const desktop = await (await page.request.get('/api/link/snippets')).json() as { yaml: string }
  expect(desktop.yaml).toContain(`- trigger: "${addr}"\n    replace: "1 Main St"\n`)
  expect(desktop.yaml).not.toContain(pwn)
  expect(desktop.yaml).not.toContain('whoami')

  await panel.getByRole('textbox', { name: 'Espanso match file' }).fill('backend: Clipboard\n')
  await panel.getByRole('button', { name: 'Import', exact: true }).click()
  const failedImport = await feedback(page)
  await expect(failedImport.locator('.nr-card').filter({ hasText: 'Snippet import completed' })).toHaveCount(0)
  await expect(failedImport).toContainText('Snippet import needs attention')
  await page.locator('#notification-bell').click()
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel).toBeHidden()
})

test('loads a chosen file to check before importing it, and says why a file is refused', async ({ page }) => {
  const id = tag()
  const file = `matches:\n  - trigger: ":chosen-${id}"\n    replace: from a file\n`
  await page.goto('/')
  const view = page.locator('#view-snippets')
  const panel = view.locator('.snip-import')
  await view.locator('.snip-import-open').click()
  const text = panel.getByRole('textbox', { name: 'Espanso match file' })

  await panel.locator('.snip-import-file').setInputFiles({ name: 'base.yml', mimeType: 'text/yaml', buffer: Buffer.from(file) })
  await expect(text).toHaveValue(file)
  await expect(panel.locator('.snip-import-status')).toHaveCount(0)
  await text.press('ControlOrMeta+Enter')
  await expect(panel.locator('.snip-import-report')).toHaveCount(0)
  await expect(view.locator(`.snip-row[data-trigger=":chosen-${id}"]`)).toBeVisible()

  await text.fill('backend: Clipboard\n')
  await panel.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(await feedback(page, 'Snippet import needs attention')).toContainText('This is not an Espanso match file: it has no list of matches.')
  await expect(page.locator('#view-snippets .snip-import-status')).toHaveCount(0)
})
