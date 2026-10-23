import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { installRoutes, installSocket, makeState } from './fixtures/chat'
type ServerState = ReturnType<typeof makeState>
const VERSION = 'a'.repeat(64), REMOTE = 'b'.repeat(64), TEXT = '# Draft\n\nThe local paragraph.\n'
const GOOGLE_PROPOSAL = JSON.stringify({
  chat: 'One small edit.',
  edits: [{ description: 'an unwanted pending agent edit', old: 'The local paragraph.', new: 'An unwanted pending agent edit.' }],
})
const accounts = { configured: true, clientId: 'poise.apps.googleusercontent.com', origin: 'http://127.0.0.1:5566', accounts: [{ id: 'one', email: 'one@example.test', connected: true }, { id: 'two', email: 'two@example.test', connected: true }] }
const publication = { accountId: 'one', fileId: 'file-one', title: 'Draft', url: 'https://docs.google.com/document/d/file-one/edit', sourceSha: VERSION, remoteSha: REMOTE, email: 'one@example.test', connected: true, remoteChanged: true, localChanged: true, comments: [{ id: 'c1', author: 'Reviewer', body: 'Please clarify.', quote: 'The local paragraph.', resolved: false, replies: [{ author: 'Second reviewer', body: 'Please also check the example.' }], start: 9, end: 29 }] }
async function setup(page: Page, options: { initialSyncFailure?: boolean, remoteText?: string, emptyFirstLoad?: boolean, chatState?: ServerState } = {}) {
  await workspace(page, 'current', undefined, { preserveOnReload: true })
  let content = TEXT
  const remoteText = options.remoteText ?? '# Draft\n\nThe Google paragraph.\n'
  let docListReads = 0
  const actions: Array<{ path: string, body: Record<string, unknown> }> = []
  // After the workspace catch-all but before the editor routes: REST routes
  // resolve last-registered-wins, so the chat fixture must sit between them.
  if (options.chatState) await installRoutes(page, options.chatState)
  await page.route('**/api/google/accounts', route => route.fulfill({ json: accounts }))
  await page.route('**/api/editor/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method()
    if (method === 'POST' || method === 'PUT') actions.push({ path, body: route.request().postData() ? route.request().postDataJSON() as Record<string, unknown> : {} })
    if (path === '/api/editor/docs') {
      if (options.emptyFirstLoad && method === 'POST') return route.fulfill({ status: 503, json: { error: 'Fixture draft creation unavailable.' } })
      return route.fulfill({ json: { docs: options.emptyFirstLoad && docListReads++ === 0 ? [] : [{ slug: 'google-draft', title: 'Draft', updated_at: '2026-10-20T08:00:00Z', size: content.length }] } })
    }
    if (path === '/api/editor/doc/google-draft') { if (method === 'PUT') content = (route.request().postDataJSON() as { content: string }).content; return route.fulfill({ json: { slug: 'google-draft', content, version: VERSION } }) }
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
  await expect.poll(async () => (await page.locator('#editor-doc').innerText()).replace(/\s+/g, ' ').trim()).toBe('Draft The Google paragraph. Additional imported words.')
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
  await expect(google.locator('[data-google-account="one"]')).toContainText('Connected')
  await expect(google.locator('[data-google-account="two"]')).toContainText('Connected')
  await google.getByRole('button', { name: 'Disconnect', exact: true }).first().click()
  await expect(google.locator('[data-google-account="one"]')).toContainText('Disconnected')
  await expect(google.locator('[data-google-account="two"]')).toContainText('Connected')
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
  await page.route('**/api/google/callback', route => { exchanged = route.request().postDataJSON(); return route.fulfill({ json: { ...accounts, connection: { outcome: 'connected', accountId: 'one' } } }) })
  await page.goto('/?code=proof-code&state=proof-state')
  await expect(page.locator('#settings-panel')).toBeVisible()
  await expect(page.locator('.st-google-accounts')).toBeVisible()
  await expect(page.locator('.google-account-status')).toHaveText('Google account connected.')
  expect(exchanged).toEqual({ code: 'proof-code', state: 'proof-state', browserSecret })
  expect(new URL(page.url()).searchParams.has('code')).toBe(false)
  expect(await page.evaluate(() => sessionStorage.getItem('poise-google-login-secret'))).toBeNull()
})
test('import freezes typing and agent edits before draining pending annotation saves', async ({ page }) => {
  // The socket route must exist before setup navigates: registered after,
  // the WebSocket connects to the real server instead of the fixture.
  const state = makeState([], {})
  state.models = {
    catalog: { models: [{ identity: 'opus-5-max', selector: 'claude-opus-5', effort: 'max', provider: 'claude' }], review_providers: [], path: '' },
    places: [{ key: 'editor', default: 'opus-5-max' }],
    fixed: [],
    refresh: null,
  }
  const sock = await installSocket(page, state)
  const actions = await setup(page, { chatState: state }), google = page.locator('.google-documents')
  // The document chat holds one pending agent edit while the import runs.
  await page.locator('.editor-chat-btn').click()
  await expect(page.locator('#chat-side-pane')).toBeVisible()
  const paneInput = page.locator('#chat-side-pane .chat-input')
  await paneInput.fill('Tighten this up')
  await paneInput.press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  const id = (sock.framesOf('prompt')[0].command as { sessionId: string }).sessionId
  await sock.subscribed(id)
  // The reply is recorded as well as pushed: the pane closes for the
  // annotation flow below (it covers the comment button) and reopens from
  // history for the Accept.
  state.history[id] = [
    sock.push(id, { type: 'turn.started', turnId: 't1', prompt: { text: 'Tighten this up', attachments: [], mentions: [] } }),
    sock.push(id, { type: 'text.delta', turnId: 't1', messageId: 'reply-1', delta: GOOGLE_PROPOSAL }),
    sock.push(id, { type: 'turn.finished', turnId: 't1', stopReason: 'end_turn' }),
  ]
  await expect(page.locator('#chat-side-pane .chat-edit-card').first()).toBeVisible()
  await page.getByRole('button', { name: 'Close chat', exact: true }).click()
  await expect(page.locator('#chat-side-pane')).not.toHaveClass(/open/)
  await page.clock.install()
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
  await page.locator('.editor-inline-thread .editor-annotation-text').fill('Keep this annotation during import.')
  await google.getByRole('button', { name: 'Import Google version', exact: true }).click()
  await pending
  await expect(page.locator('#editor-doc')).toHaveAttribute('contenteditable', 'false')
  await page.locator('.editor-chat-btn').click()
  const card = page.locator('#chat-side-pane .chat-edit-card').first()
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(card.locator('.chat-edit-card-badge-conflict')).toHaveText('Conflict — text not found')
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

const FLOW_STATE = 's'.repeat(43)
async function retainedFlow(page: Page, place: 'accounts' | 'publish' = 'accounts', expectedAccountId?: string) {
  await page.evaluate(({ state, place, expectedAccountId }) => sessionStorage.setItem('poise-google-flow', JSON.stringify({ secret: 'a'.repeat(64), state, createdAt: Date.now(), returnTo: place === 'publish' ? { place, slug: 'google-draft' } : { place }, ...(expectedAccountId ? { expectedAccountId } : {}) })), { state: FLOW_STATE, place, expectedAccountId })
}
for (const theme of ['light', 'dark']) test(`Google accounts reuse compact agent typography at narrow width in ${theme}`, async ({ page }, info) => {
  await workspace(page)
  await page.route('**/api/google/accounts', route => route.fulfill({ json: { ...accounts, accounts: [accounts.accounts[0], { ...accounts.accounts[1], connected: false, state: 'expired' }] } }))
  await page.setViewportSize({ width: 420, height: 820 })
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = '20px'; document.body.style.fontFamily = 'Georgia, serif' }, theme)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover').getByRole('button', { name: 'Accounts', exact: true }).click()
  const google = page.locator('.st-google-accounts')
  await expect(google.locator('[data-google-account="two"] .st-account-state')).toHaveText('Needs sign-in')
  await expect(google.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible()
  await expect(google.locator('input, details, summary, code, .google-config')).toHaveCount(0)
  await expect(google).not.toContainText(/Client ID|Client secret|redirect URI|Cloud/)
  const sizes = await page.evaluate(() => {
    const css = (selector: string) => { const s = getComputedStyle(document.querySelector(selector)!); return [s.fontSize, s.fontFamily, s.fontWeight, s.lineHeight] }
    const panel = document.querySelector('#settings-panel .tp-body')!
    return { name: css('.st-google-accounts .st-account-name'), agentName: css('.st-accounts .st-account-name'), status: css('.st-google-accounts .st-account-state'), agentStatus: css('.st-accounts .st-account-state'), overflow: panel.scrollWidth - panel.clientWidth }
  })
  expect(sizes.name).toEqual(sizes.agentName); expect(sizes.status).toEqual(sizes.agentStatus); expect(sizes.overflow).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath(`google-accounts-${theme}.png`) })
  await page.evaluate(() => { document.documentElement.style.removeProperty('font-size'); document.body.style.removeProperty('font-family') })
  await google.screenshot({ path: info.outputPath(`google-accounts-default-${theme}.png`) })
})
test('central completion restores the exact draft and verified subject without publishing', async ({ page }) => {
  const actions = await setup(page)
  await retainedFlow(page, 'publish')
  await page.evaluate(() => localStorage.setItem('poise-editor-last', 'a-different-draft'))
  let completed: unknown
  await page.route('**/api/google/callback', route => { completed = route.request().postDataJSON(); return route.fulfill({ json: { ...accounts, accounts: [...accounts.accounts].reverse(), connection: { outcome: 'connected', accountId: 'two' } } }) })
  await page.goto('/?google_state=' + FLOW_STATE)
  const panel = page.getByRole('dialog', { name: 'Publish', exact: true })
  await expect(panel).toBeVisible()
  await expect(page.locator('#editor-doc')).toContainText('The local paragraph.')
  await expect(panel.getByLabel('Google publishing account')).toHaveValue('two')
  await expect(panel.getByRole('status')).toHaveText('Google account connected.')
  await expect(page.locator('#settings-panel')).not.toBeVisible()
  expect(completed).toEqual({ state: FLOW_STATE, browserSecret: 'a'.repeat(64) })
  expect(actions.some(a => a.path.endsWith('/publish') || a.path.endsWith('/google/import'))).toBe(false)
  expect(new URL(page.url()).searchParams.has('google_state')).toBe(false)
})
test('cancelled Publish connection returns quietly to the saved draft without publishing', async ({ page }) => {
  const actions = await setup(page); await retainedFlow(page, 'publish')
  await page.route('**/api/google/callback', route => route.fulfill({ json: { ...accounts, connection: { outcome: 'cancelled' } } }))
  await page.goto('/?google_state=' + FLOW_STATE)
  await expect(page.getByRole('dialog', { name: 'Publish', exact: true }).getByRole('status')).toHaveText('Google sign-in cancelled.')
  await expect(page.locator('#editor-doc')).toContainText('The local paragraph.')
  expect(actions.some(a => a.path.endsWith('/publish'))).toBe(false)
})
for (const status of [409, 503]) test(`a failed${status} save refuses Google navigation and keeps the draft`, async ({ page }) => {
  const actions = await setup(page)
  let connections = 0
  await page.route('**/api/google/connect', route => { connections++; return route.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + FLOW_STATE } }) })
  await page.route('**/api/editor/doc/google-draft', route => route.request().method() === 'PUT' ? route.fulfill({ status, json: { error: 'The draft save was refused.' } }) : route.fallback())
  await page.locator('#editor-doc').fill('An unsaved draft that must survive Google connection.')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Publish', exact: true })
  await panel.getByRole('button', { name: 'Add Google account', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('draft could not be saved')
  await expect(page.locator('#editor-doc')).toContainText('An unsaved draft that must survive')
  await expect(page.locator('#editor-doc')).toHaveAttribute('contenteditable', 'true')
  expect(connections).toBe(0)
  expect(actions.some(a => a.path.endsWith('/publish'))).toBe(false)
})
test('a held save finishes before connection and the saved text returns even without unload beacons', async ({ page }) => {
  const actions = await setup(page)
  await page.evaluate(() => { navigator.sendBeacon = () => false })
  let release!: () => void, saving!: () => void, connected = 0
  const held = new Promise<void>(r => { release = r }), started = new Promise<void>(r => { saving = r })
  await page.route('**/api/editor/doc/google-draft', async route => { if (route.request().method() === 'PUT') { saving(); await held }; return route.fallback() })
  await page.route('**/api/google/connect', route => { connected++; return route.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + FLOW_STATE } }) })
  await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Google consent fixture</p>' }))
  await page.route('**/api/google/callback', route => route.fulfill({ json: { ...accounts, connection: { outcome: 'connected', accountId: 'two' } } }))
  const text = ('The complete saved draft. ' + 'Additional saved words. '.repeat(4000)).trim()
  await page.locator('#editor-doc').fill(text)
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Publish', exact: true })
  await panel.getByRole('button', { name: 'Add Google account', exact: true }).click()
  await started
  await expect(page.locator('#editor-doc')).toHaveAttribute('contenteditable', 'false')
  expect(connected).toBe(0)
  release()
  await expect(page).toHaveURL(/accounts\.google\.com/)
  expect(connected).toBe(1)
  await page.goto('/?google_state=' + FLOW_STATE)
  await expect(page.getByRole('dialog', { name: 'Publish', exact: true })).toBeVisible()
  await expect(page.locator('#editor-doc')).toContainText('The complete saved draft.')
  expect((await page.locator('#editor-doc').innerText()).trim()).toBe(text)
  expect(actions.some(a => a.path.endsWith('/publish'))).toBe(false)
})
test('a missing original draft opens Accounts instead of another draft or publication', async ({ page }) => {
  const actions = await setup(page); await retainedFlow(page, 'publish')
  await page.route('**/api/editor/docs', route => route.fulfill({ json: { docs: [{ slug: 'different-draft', title: 'Different', updated_at: '', size: 10 }] } }))
  await page.route('**/api/google/callback', route => route.fulfill({ json: { ...accounts, connection: { outcome: 'connected', accountId: 'two' } } }))
  await page.goto('/?google_state=' + FLOW_STATE)
  await expect(page.locator('.google-account-status')).toContainText('original draft is unavailable')
  await expect(page.getByRole('dialog', { name: 'Publish', exact: true })).toHaveCount(0)
  expect(actions.some(a => a.path.endsWith('/publish'))).toBe(false)
})
test('an opener clone inherits flow possession but only the first verified completion succeeds', async ({ page, context }) => {
  await workspace(page, 'current', undefined, { preserveOnReload: true }); await retainedFlow(page)
  await context.route('**/clone-proof', route => route.fulfill({ contentType: 'text/html', body: '<p>Tab clone fixture</p>' }))
  const popup = page.waitForEvent('popup')
  await page.evaluate(() => { window.open('/clone-proof', '_blank') })
  const child = await popup
  expect(await child.evaluate(() => sessionStorage.getItem('poise-google-flow'))).toBe(await page.evaluate(() => sessionStorage.getItem('poise-google-flow')))
  await workspace(child, 'current', undefined, { preserveOnReload: true, path: '/clone-proof' })
  let consumed = false, attempts = 0
  for (const target of [page, child]) {
    await target.route('**/api/google/accounts', route => route.fulfill({ json: accounts }))
    await target.route('**/api/google/callback', route => { attempts++; if (consumed) return route.fulfill({ status: 403, json: { error: 'Google sign-in was already used.' } }); consumed = true; return route.fulfill({ json: { ...accounts, connection: { outcome: 'connected', accountId: 'one' } } }) })
  }
  await child.goto('/?google_state=' + FLOW_STATE)
  await expect(child.locator('.google-account-status')).toHaveText('Google account connected.')
  await page.goto('/?google_state=' + FLOW_STATE)
  await expect(page.locator('.google-account-status')).toContainText('already used')
  expect(attempts).toBe(2)
  await child.close()
})
test('Reconnect from Accounts replaces stale Publish intent and binds the expected subject', async ({ page }) => {
  await workspace(page, 'current', undefined, { preserveOnReload: true }); await retainedFlow(page, 'publish', 'one')
  await page.route('**/api/google/accounts', route => route.fulfill({ json: { ...accounts, accounts: [accounts.accounts[0], { ...accounts.accounts[1], connected: false, state: 'expired' }] } }))
  let connecting: { accountId?: string; browserSecret: string } | undefined
  await page.route('**/api/google/connect', route => { connecting = route.request().postDataJSON() as typeof connecting; return route.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + FLOW_STATE } }) })
  await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Google consent fixture</p>' }))
  await page.route('**/api/google/callback', route => route.fulfill({ json: { ...accounts, connection: { outcome: 'connected', accountId: 'two' } } }))
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover').getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.locator('[data-google-account="two"]').getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(page).toHaveURL(/accounts\.google\.com/)
  expect(connecting?.accountId).toBe('two')
  await page.goto('/?google_state=' + FLOW_STATE)
  await expect(page.locator('.google-account-status')).toHaveText('Google account connected.')
  await expect(page.getByRole('dialog', { name: 'Publish', exact: true })).toHaveCount(0)
})
test('unavailable browser storage keeps the saved draft on screen and never starts authorization', async ({ page }) => {
  const actions = await setup(page)
  let connected = 0
  await page.route('**/api/google/connect', route => { connected++; return route.fulfill({ json: {} }) })
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) { if (key === 'poise-google-flow') throw new DOMException('disabled', 'SecurityError'); return original.call(this, key, value) }
  })
  await page.locator('#editor-doc').fill('A draft retained when browser storage is unavailable.')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Publish', exact: true })
  await panel.getByRole('button', { name: 'Add Google account', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('Browser storage is unavailable')
  await expect(page.locator('#editor-doc')).toHaveAttribute('contenteditable', 'true')
  await expect(page.locator('#editor-doc')).toContainText('A draft retained')
  expect(connected).toBe(0)
  expect(actions.some(a => a.path.endsWith('/publish'))).toBe(false)
})
test('pending annotations must be acknowledged before leaving for Google', async ({ page }) => {
  await page.clock.install()
  const actions = await setup(page)
  let release!: () => void, saving!: () => void, connected = 0
  const held = new Promise<void>(r => { release = r }), pending = new Promise<void>(r => { saving = r })
  await page.route('**/api/editor/doc/google-draft/annotations', async route => {
    if (route.request().method() !== 'GET') { saving(); await held }
    return route.fallback()
  })
  await page.route('**/api/google/connect', route => { connected++; return route.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + FLOW_STATE } }) })
  await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Google consent fixture</p>' }))
  await page.evaluate(() => {
    const line = document.querySelector('#editor-doc')!.children[2], range = document.createRange()
    range.selectNodeContents(line)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.locator('#editor-comment-btn').click()
  await page.locator('.editor-inline-thread .editor-annotation-text').fill('Keep this annotation before connecting.')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByRole('dialog', { name: 'Publish', exact: true }).getByRole('button', { name: 'Add Google account', exact: true }).click()
  await pending
  await expect(page.locator('#editor-doc')).toHaveAttribute('contenteditable', 'false')
  expect(connected).toBe(0)
  release()
  await expect(page).toHaveURL(/accounts\.google\.com/)
  expect(connected).toBe(1)
  expect(actions.some(a => a.path.endsWith('/annotations') && JSON.stringify(a.body).includes('Keep this annotation'))).toBe(true)
  expect(actions.some(a => a.path.endsWith('/publish'))).toBe(false)
})
test('a disconnected return account never falls back to another publishing identity', async ({ page }) => {
  const actions = await setup(page); await retainedFlow(page, 'publish')
  await page.route('**/api/google/callback', route => route.fulfill({ json: { ...accounts, connection: { outcome: 'connected', accountId: 'two' } } }))
  await page.route('**/api/google/accounts', route => route.fulfill({ json: { ...accounts, accounts: [accounts.accounts[0]] } }))
  await page.goto('/?google_state=' + FLOW_STATE)
  const panel = page.getByRole('dialog', { name: 'Publish', exact: true })
  await expect(panel.getByRole('status')).toContainText('no longer connected')
  await expect(panel.getByLabel('Google publishing account')).toHaveValue('')
  await expect(panel.getByRole('button', { name: 'Publish to Google', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: 'Reconnect Google account', exact: true })).toBeVisible()
  expect(actions.some(a => a.path.endsWith('/publish'))).toBe(false)
  await panel.getByLabel('Google publishing account').selectOption('one')
  await expect(panel.getByRole('button', { name: 'Publish to Google', exact: true })).toBeEnabled()
  expect(actions.some(a => a.path.endsWith('/publish'))).toBe(false)
})
for (const place of ['accounts', 'publish'] as const) test(`persisted pageshow releases ${place} connection controls and Editor mutations`, async ({ page }) => {
  await setup(page)
  await page.route('**/api/google/connect', route => route.fulfill({ json: { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + FLOW_STATE } }))
  await page.route('https://accounts.google.com/**', route => route.abort('aborted'))
  const aborted = page.waitForEvent('requestfailed', { predicate: req => req.isNavigationRequest() && req.url().startsWith('https://accounts.google.com/') })
  if (place === 'accounts') {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('#menu-popover').getByRole('button', { name: 'Accounts', exact: true }).click()
    await page.locator('.st-google-accounts').getByRole('button', { name: 'Add Google account', exact: true }).click({ noWaitAfter: true })
  } else {
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByRole('dialog', { name: 'Publish', exact: true }).getByRole('button', { name: 'Add Google account', exact: true }).click({ noWaitAfter: true })
  }
  await aborted
  // Cancel navigation before commit so the original document and its handlers
  // remain available; exercise the persisted return without a hanging request.
  const states = await page.evaluate(() => {
    const editor = document.querySelector('#editor-doc')!
    const before = editor.getAttribute('contenteditable')
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    const ordinary = editor.getAttribute('contenteditable')
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    return { before, ordinary, restored: editor.getAttribute('contenteditable') }
  })
  expect(states).toEqual({ before: 'false', ordinary: 'false', restored: 'true' })
  await expect(page.locator('#editor-doc')).toHaveAttribute('contenteditable', 'true')
  if (place === 'accounts') await expect(page.locator('.st-google-accounts').getByRole('button', { name: 'Add Google account', exact: true })).toBeEnabled()
  else expect(await page.getByRole('dialog', { name: 'Publish', exact: true }).evaluate(el => (el as HTMLElement).inert)).toBe(false)
})
