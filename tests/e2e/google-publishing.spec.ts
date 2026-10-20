import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
const VERSION = 'a'.repeat(64), REMOTE = 'b'.repeat(64), TEXT = '# Draft\n\nThe local paragraph.\n'
const accounts = { configured: true, clientId: 'poise.apps.googleusercontent.com', origin: 'http://127.0.0.1:5566', accounts: [{ id: 'one', email: 'one@example.test', connected: true }, { id: 'two', email: 'two@example.test', connected: true }] }
const publication = { accountId: 'one', fileId: 'file-one', title: 'Draft', url: 'https://docs.google.com/document/d/file-one/edit', sourceSha: VERSION, remoteSha: REMOTE, email: 'one@example.test', connected: true, remoteChanged: true, localChanged: true, comments: [{ id: 'c1', author: 'Reviewer', body: 'Please clarify.', quote: 'The local paragraph.', resolved: false, replies: [{ author: 'Second reviewer', body: 'Please also check the example.' }], start: 9, end: 29 }] }
async function setup(page: Page, options: { initialSyncFailure?: boolean, remoteText?: string, emptyFirstLoad?: boolean } = {}) {
  await workspace(page)
  let content = TEXT
  const remoteText = options.remoteText ?? '# Draft\n\nThe Google paragraph.\n'
  let docListReads = 0
  const actions: Array<{ path: string, body: Record<string, unknown> }> = []
  await page.route('**/api/google/accounts', route => route.fulfill({ json: accounts }))
  await page.route('**/api/editor/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method()
    if (method === 'POST' || method === 'PUT') actions.push({ path, body: route.request().postData() ? route.request().postDataJSON() as Record<string, unknown> : {} })
    if (path === '/api/editor/docs') {
      if (options.emptyFirstLoad && method === 'POST') return route.fulfill({ status: 503, json: { error: 'Fixture draft creation unavailable.' } })
      return route.fulfill({ json: { docs: options.emptyFirstLoad && docListReads++ === 0 ? [] : [{ slug: 'google-draft', title: 'Draft', updated_at: '2026-10-20T08:00:00Z', size: content.length }] } })
    }
    if (path === '/api/editor/doc/google-draft') return route.fulfill({ json: { slug: 'google-draft', content, version: VERSION } })
    if (path.endsWith('/chat-session')) return route.fulfill({ json: { session_id: 'editor-google-draft-1792487000000' } })
    if (path.endsWith('/annotations')) return route.fulfill({ json: { annotations: [], version: VERSION } })
    if (path.endsWith('/reviews') || path.endsWith('/reviews/sync')) return route.fulfill({ json: { reviews: [], checkedAt: null, active: false, stale: false, problems: [] } })
    if (path.endsWith('/publishing')) return route.fulfill({ json: { title: 'Draft', slug: 'draft', today: '2026-10-20', publications: [] } })
    if (path.endsWith('/google/sync') && options.initialSyncFailure) return route.fulfill({ status: 503, json: { error: 'Google synchronization is unavailable.' } })
    if (path.endsWith('/google') || path.endsWith('/google/sync') || path.endsWith('/google/publish')) return route.fulfill({ json: { version: VERSION, publications: [publication] } })
    if (path.endsWith('/google/review')) return route.fulfill({ json: { localText: content, remoteText, localVersion: VERSION, remoteSha: REMOTE, fileId: 'file-one', connectionVersion: 'connection-one', comments: publication.comments } })
    if (path.endsWith('/google/import')) { content = remoteText; return route.fulfill({ json: { ok: true, content, version: VERSION } }) }
    return route.fulfill({ json: {} })
  })
  const emptyLoadFailed = options.emptyFirstLoad ? page.waitForEvent('console', { predicate: message => message.text().includes('[editor] newDoc failed:') }) : null
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  if (emptyLoadFailed) await emptyLoadFailed
  else await expect(page.locator('#editor-doc')).toContainText('The local paragraph.')
  return actions
}
test('returning to an empty Editor resumes Google synchronization for a subsequently loaded draft', async ({ page }) => {
  await page.clock.install()
  const actions = await setup(page, { emptyFirstLoad: true })
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(page.locator('#editor-doc')).toContainText('The local paragraph.')
  const syncCount = () => actions.filter(action => action.path.endsWith('/google/sync')).length
  await expect.poll(syncCount).toBeGreaterThan(0)
  const initial = syncCount()
  await page.clock.fastForward(61_000)
  await expect.poll(syncCount).toBeGreaterThan(initial)
})
test('publishes the open document through the selected Google account', async ({ page }) => {
  const actions = await setup(page)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Publish', exact: true })
  await dialog.getByLabel('Google publishing account').selectOption('two')
  await dialog.getByRole('button', { name: 'Publish to Google', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Published.')
  expect(actions.find(action => action.path.endsWith('/google/publish'))?.body).toEqual({ accountId: 'two', localVersion: VERSION })
})
test('shows native comments, reviews incoming changes and imports only after explicit acceptance', async ({ page }) => {
  const actions = await setup(page, { remoteText: '# Draft\n\nThe Google paragraph. Additional imported words.\n' })
  const google = page.locator('.google-documents')
  await google.locator('summary').click()
  await expect(google).toContainText('Please clarify.')
  await expect(google).toContainText('Please also check the example.')
  expect(actions.some(action => action.path.endsWith('/google/import'))).toBe(false)
  await google.getByRole('button', { name: 'Review Google changes', exact: true }).click()
  await expect(google.locator('.google-local')).toContainText('The local paragraph.')
  await expect(google.locator('.google-remote')).toContainText('The Google paragraph.')
  expect(actions.some(action => action.path.endsWith('/google/import'))).toBe(false)
  await google.getByRole('button', { name: 'Keep Poise draft', exact: true }).click()
  await expect(page.locator('#editor-doc')).toContainText('The local paragraph.')
  await google.getByRole('button', { name: 'Review Google changes', exact: true }).click()
  await google.getByRole('button', { name: 'Import Google version', exact: true }).click()
  await expect(page.locator('#editor-doc')).toContainText('The Google paragraph.')
  await expect(page.locator('#editor-meta')).toHaveText('8 words · saved')
  expect(actions.find(action => action.path.endsWith('/google/import'))?.body).toEqual({ accountId: 'one', localVersion: VERSION, remoteSha: REMOTE, fileId: 'file-one', connectionVersion: 'connection-one' })
  expect(actions.some(action => action.path.endsWith('/google/publish'))).toBe(false)
})

test('requires review before explicitly publishing the Poise version over Google changes', async ({ page }) => {
  const actions = await setup(page), google = page.locator('.google-documents')
  await google.locator('summary').click()
  await google.getByRole('button', { name: 'Review Google changes', exact: true }).click()
  await expect(google.locator('.google-remote')).toContainText('The Google paragraph.')
  await google.getByRole('button', { name: 'Publish Poise version instead', exact: true }).click()
  await expect(google.locator('.google-change-review')).toHaveCount(0)
  expect(actions.find(action => action.path.endsWith('/google/publish'))?.body).toEqual({ accountId: 'one', localVersion: VERSION, reviewedRemoteSha: REMOTE, fileId: 'file-one', connectionVersion: 'connection-one' })
  await expect(page.locator('#editor-doc')).toContainText('The local paragraph.')
})
test('lists multiple Google connections and disconnects only the chosen account', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/google/accounts', route => route.fulfill({ json: accounts }))
  let disconnected: unknown
  await page.route('**/api/google/disconnect', route => {
    disconnected = route.request().postDataJSON()
    return route.fulfill({ json: { ...accounts, accounts: [{ ...accounts.accounts[0], connected: false }, accounts.accounts[1]] } })
  })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover').getByRole('button', { name: 'Accounts', exact: true }).click()
  const google = page.locator('.st-google-accounts')
  await expect(google).toContainText('one@example.test · Connected')
  await expect(google).toContainText('two@example.test · Connected')
  await google.getByRole('button', { name: 'Disconnect', exact: true }).first().click()
  await expect(google).toContainText('one@example.test · Disconnected')
  await expect(google).toContainText('two@example.test · Connected')
  expect(disconnected).toEqual({ accountId: 'one' })
})
test('retains the Poise draft when Google changes after review', async ({ page }) => {
  await setup(page)
  await page.route('**/api/editor/doc/google-draft/google/import', route => route.fulfill({ status: 409, json: { error: 'Google changed after the review opened. Review the latest version.' } }))
  const google = page.locator('.google-documents')
  await google.locator('summary').click()
  await google.getByRole('button', { name: 'Review Google changes', exact: true }).click()
  await google.getByRole('button', { name: 'Import Google version', exact: true }).click()
  await expect(google.getByRole('alert')).toContainText('Google changed after the review opened.')
  await expect(page.locator('#editor-doc')).toContainText('The local paragraph.')
  await expect(page.locator('#editor-doc')).toHaveAttribute('contenteditable', 'true')
  await google.getByRole('button', { name: 'Refresh Google', exact: true }).click()
  await expect(google.getByRole('alert')).toContainText('Google changed after the review opened.')
})

test('an older Google refresh cannot overwrite a newer publication read', async ({ page }) => {
  await setup(page)
  const google = page.locator('.google-documents')
  await google.locator('summary').click()
  let reads = 0, release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const first = new Promise<void>(resolve => { started = resolve })
  await page.route('**/api/editor/doc/google-draft/google/sync', async route => {
    reads++
    if (reads === 1) { started(); await held; return route.fulfill({ json: { version: VERSION, publications: [publication] } }) }
    return route.fulfill({ json: { version: VERSION, publications: [{ ...publication, remoteChanged: false, localChanged: false }] } })
  })
  await google.getByRole('button', { name: 'Refresh Google', exact: true }).click()
  await first
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:google-published')))
  await expect(google).toContainText('Published version matches.')
  const response = page.waitForResponse(response => response.url().endsWith('/google/sync'))
  release(); await response
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  await expect(google).toContainText('Published version matches.')
  await expect(google.locator('summary')).not.toContainText('Updates available')
})
test('a failed Google read is visibly unknown rather than synchronized', async ({ page }) => {
  await setup(page)
  const google = page.locator('.google-documents')
  await google.locator('summary').click()
  await page.route('**/api/editor/doc/google-draft/google/sync', route => route.fulfill({ json: { version: VERSION, publications: [{ ...publication, remoteChanged: null, localChanged: false, problem: 'Google unavailable.' }] } }))
  await google.getByRole('button', { name: 'Refresh Google', exact: true }).click()
  await expect(google).toContainText('Google status unavailable.')
  await expect(google.getByRole('alert')).toHaveText('Google unavailable.')
  await expect(google).not.toContainText('Published version matches.')
})
test('OAuth return opens Accounts and displays the result without depending on workspace cookies', async ({ page }) => {
  await workspace(page)
  const browserSecret = 'a'.repeat(64)
  await page.evaluate(secret => sessionStorage.setItem('poise-google-login-secret', secret), browserSecret)
  await page.route('**/api/google/accounts', route => route.fulfill({ json: accounts }))
  let exchanged: unknown
  await page.route('**/api/google/callback', route => { exchanged = route.request().postDataJSON(); return route.fulfill({ json: accounts }) })
  await page.goto('/?code=proof-code&state=proof-state')
  await expect(page.locator('#settings-panel')).toBeVisible()
  await expect(page.locator('.st-google-accounts')).toBeVisible()
  await expect(page.locator('.google-account-status')).toHaveText('Google account connected.')
  expect(exchanged).toEqual({ code: 'proof-code', state: 'proof-state', browserSecret })
  expect(new URL(page.url()).searchParams.has('code')).toBe(false)
  expect(await page.evaluate(() => sessionStorage.getItem('poise-google-login-secret'))).toBeNull()
})
test('import freezes typing and agent edits before draining pending annotation saves', async ({ page }) => {
  await page.clock.install()
  const actions = await setup(page), google = page.locator('.google-documents')
  await page.evaluate(() => window.addEventListener('poise:open-chat', event => {
    const detail = (event as CustomEvent<{ onEditAccept: (edit: { old: string, new: string }) => string }>).detail
    Reflect.set(window, 'googleAcceptProbe', detail.onEditAccept)
    event.stopImmediatePropagation()
  }, { capture: true }))
  await page.locator('.editor-chat-btn').click()
  await page.getByRole('button', { name: 'Close chat', exact: true }).click()
  await page.clock.fastForward(1000)
  await google.locator('summary').click()
  await google.getByRole('button', { name: 'Review Google changes', exact: true }).click()
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), pending = new Promise<void>(resolve => { started = resolve })
  await page.route('**/api/editor/doc/google-draft/annotations', async route => {
    if (route.request().method() !== 'GET') { started(); await held }
    return route.fulfill({ json: { annotations: [], version: VERSION } })
  })
  await page.evaluate(() => {
    const line = document.querySelector('#editor-doc')!.children[2], range = document.createRange()
    range.selectNodeContents(line)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.locator('#editor-comment-btn').click()
  await page.getByRole('textbox', { name: 'Add a comment…', exact: true }).fill('Keep this annotation during import.')
  await google.getByRole('button', { name: 'Import Google version', exact: true }).click()
  await pending
  await expect(page.locator('#editor-doc')).toHaveAttribute('contenteditable', 'false')
  const applied = await page.evaluate(() => {
    const accept = Reflect.get(window, 'googleAcceptProbe') as (edit: { old: string, new: string }) => string
    return accept({ old: 'The local paragraph.', new: 'An unwanted pending agent edit.' })
  })
  expect(applied).toBe('conflict')
  await expect(page.locator('#editor-doc')).toContainText('The local paragraph.')
  release()
  await expect(page.locator('#editor-doc')).toContainText('The Google paragraph.')
  await page.clock.fastForward(1000)
  expect(actions.filter(action => action.path === '/api/editor/doc/google-draft')).toEqual([])
})
test('a minute tick during a busy Google review cannot stop future polling', async ({ page }) => {
  await page.clock.install()
  await setup(page)
  const google = page.locator('.google-documents')
  await google.locator('summary').click()
  let reads = 0, release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), pending = new Promise<void>(resolve => { started = resolve })
  await page.route('**/api/editor/doc/google-draft/google/sync', route => { reads++; return route.fulfill({ json: { version: VERSION, publications: [publication] } }) })
  await page.route('**/api/editor/doc/google-draft/google/review', async route => { started(); await held; return route.fulfill({ json: { localText: TEXT, remoteText: '# Google version', localVersion: VERSION, remoteSha: REMOTE, fileId: 'file-one', connectionVersion: 'connection-one', comments: [] } }) })
  await google.getByRole('button', { name: 'Review Google changes', exact: true }).click()
  await pending
  await page.clock.fastForward(65_000)
  expect(reads).toBe(0)
  release()
  await expect(google.locator('.google-remote')).toHaveText('# Google version')
  await expect.poll(() => reads).toBe(1)
  await page.clock.fastForward(60_000)
  await expect.poll(() => reads).toBe(2)
})
test('an OAuth return without its tab binding still opens Accounts and explains the failure', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/google/accounts', route => route.fulfill({ json: accounts }))
  await page.goto('/?code=proof-code&state=wrong-tab')
  await expect(page.locator('.st-google-accounts')).toBeVisible()
  await expect(page.locator('.google-account-status')).toContainText('another browser tab')
  expect(new URL(page.url()).searchParams.has('code')).toBe(false)
})
test('a stale clean Editor tab cannot publish another tab\'s unseen server version', async ({ page }) => {
  await setup(page)
  let mutated = false, sentVersion: unknown
  await page.route('**/api/editor/doc/google-draft/google', route => route.fulfill({ json: { version: REMOTE, publications: [publication] } }))
  await page.route('**/api/editor/doc/google-draft/google/publish', route => {
    sentVersion = (route.request().postDataJSON() as Record<string, unknown>).localVersion
    if (sentVersion !== REMOTE) return route.fulfill({ status: 409, json: { error: 'The document changed in another tab. Reload before publishing.' } })
    mutated = true
    return route.fulfill({ json: { version: REMOTE, publications: [publication] } })
  })
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Publish', exact: true })
  await dialog.getByRole('button', { name: 'Publish to Google', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('changed in another tab')
  expect(sentVersion).toBe(VERSION); expect(mutated).toBe(false)
  await expect(page.locator('#editor-doc')).toContainText('The local paragraph.')
})
test('a failed first Google read stays visible and offers recovery', async ({ page }) => {
  await setup(page, { initialSyncFailure: true })
  const google = page.locator('.google-documents')
  await expect(google).toBeVisible()
  await expect(google.locator('summary')).toHaveText('Google Docs · Status unavailable')
  await expect(google.getByRole('alert')).toHaveText('Google synchronization is unavailable.')
  await page.route('**/api/editor/doc/google-draft/google/sync', route => route.fulfill({ json: { version: VERSION, publications: [publication] } }))
  await google.getByRole('button', { name: 'Refresh Google', exact: true }).click()
  await expect(google).toContainText('Please clarify.')
  await expect(google.getByRole('alert')).toHaveCount(0)
})
