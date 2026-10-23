// A Current card's chat runs as that card's Chat session in the side pane:
// resolve on open, create on the first message, adopt when it exists.
import { expect, test, type Page } from '@playwright/test'
import { installRoutes, installSocket, makeState, session, env, NOW } from './fixtures/chat'
import type { ChatSubject } from '../../server/chat/protocol'
type ChatSocket = Awaited<ReturnType<typeof installSocket>>

const ISSUE = { kind: 'issue', repo: 'acme/app', number: 7, state: 'open', title: 'Broken logout', url: 'https://github.com/acme/app/issues/7', created_at: NOW, updated_at: NOW, merged_at: null }
const SUBJECT: ChatSubject = { surface: 'current', key: 'poise.issue.acme/app.7', label: 'acme/app#7', url: 'https://github.com/acme/app/issues/7' }

function modelsState() {
  return {
    catalog: { models: [
      { identity: 'opus-5-max', selector: 'claude-opus-5', effort: 'max', provider: 'claude' },
      { identity: 'opus-5-high', selector: 'claude-opus-5', effort: 'high', provider: 'claude' },
    ], review_providers: [], path: '' },
    places: [{ key: 'chat', default: 'opus-5-max' }],
    fixed: [],
    refresh: null,
  }
}

async function currentRoutes(page: Page): Promise<void> {
  await page.route('**/api/gh', (route) => route.fulfill({ json: { records: [ISSUE] } }))
  await page.route('**/api/current', (route) => route.fulfill({ json: { cards: [] } }))
}

const pane = (page: Page) => page.locator('#chat-side-pane')
const paneInput = (page: Page) => pane(page).locator('.chat-input')
const paneTranscript = (page: Page) => pane(page).locator('.chat-surface-transcript')

async function openCardPane(page: Page): Promise<void> {
  const card = page.locator('.card-live', { hasText: 'Broken logout' })
  await card.hover()
  await card.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(pane(page)).toBeVisible()
}

async function sendPaneMessage(page: Page, sock: ChatSocket, text: string): Promise<string> {
  await paneInput(page).fill(text)
  await paneInput(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  return (sock.framesOf('prompt')[0].command as { sessionId: string }).sessionId
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('poise-view', 'current'))
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
})

test('streams a reply to an issue card\'s chat in the side pane', async ({ page }) => {
  const state = makeState([], {})
  state.forbidLegacyChat = true
  state.models = modelsState()
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  await expect(pane(page).locator('.chat-title')).toHaveText('acme/app#7')
  await expect(paneInput(page)).toHaveValue('Broken logout\nhttps://github.com/acme/app/issues/7')
  const id = await sendPaneMessage(page, sock, 'Why does logout fail?')
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ type: 'prompt', sessionId: id, text: 'Why does logout fail?' })
  sock.push(id, { type: 'turn.started', turnId: 't1', prompt: { text: 'Why does logout fail?', attachments: [], mentions: [] } })
  sock.push(id, { type: 'text.delta', turnId: 't1', messageId: 'reply', delta: 'Because the cookie survives.' })
  sock.push(id, { type: 'turn.finished', turnId: 't1', stopReason: 'end_turn' })
  await expect(paneTranscript(page).locator('.chat-msg-agent')).toContainText('Because the cookie survives.')
  expect(state.calls.filter((c) => c.path === '/api/chat')).toHaveLength(0)
})

test('creates the card\'s session on the first message, not when the pane opens', async ({ page }) => {
  const state = makeState([], {})
  state.forbidLegacyChat = true
  state.models = modelsState()
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  await expect(paneInput(page)).toHaveValue('Broken logout\nhttps://github.com/acme/app/issues/7')
  expect(state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat/sessions')).toHaveLength(0)
  await pane(page).locator('.chat-default-model').click()
  await pane(page).locator('.chat-model-option[data-identity="opus-5-high"]').click()
  await paneInput(page).fill('Why does logout fail?')
  await paneInput(page).press('Enter')
  await expect.poll(() => state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat/sessions')).toHaveLength(1)
  const created = state.calls.find((c) => c.method === 'POST' && c.path === '/api/chat/sessions')!.body as Record<string, unknown>
  expect(created).toMatchObject({ subject: SUBJECT, agent: 'claude', model: 'opus-5-high' })
  expect(created).not.toHaveProperty('context')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(state.calls.filter((c) => c.path === '/api/chat')).toHaveLength(0)
})

test('opens a card\'s existing session when its pane opens again', async ({ page }) => {
  const existing = session({ id: 'card-1', title: 'Broken logout', subject: SUBJECT, lastSeq: 2 })
  const state = makeState([existing], { 'card-1': [
    env('card-1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'Why does logout fail?', attachments: [], mentions: [] } }),
    env('card-1', 2, { type: 'text.delta', turnId: 't1', messageId: 'reply', delta: 'Because the cookie survives.' }),
  ] })
  state.forbidLegacyChat = true
  state.models = modelsState()
  await installRoutes(page, state)
  await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  await expect(paneTranscript(page).locator('.chat-msg-agent')).toContainText('Because the cookie survives.')
  expect(state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat/sessions')).toHaveLength(0)
  await page.reload()
  await openCardPane(page)
  await expect(paneTranscript(page).locator('.chat-msg-agent')).toContainText('Because the cookie survives.')
  expect(state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat/sessions')).toHaveLength(0)
})

test('answers a question and a permission request from the side pane', async ({ page }) => {
  const existing = session({ id: 'card-1', title: 'Broken logout', status: 'running', subject: SUBJECT, lastSeq: 1 })
  const state = makeState([existing], { 'card-1': [
    env('card-1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'Fix it', attachments: [], mentions: [] } }),
  ] })
  state.forbidLegacyChat = true
  state.models = modelsState()
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  await sock.subscribed('card-1')
  sock.seq = 1
  sock.push('card-1', { type: 'permission.requested', id: 'p1', turnId: 't1', title: 'Run npm test', options: [{ id: 'once', name: 'Allow once', kind: 'allow_once' }] })
  await paneTranscript(page).locator('.chat-permission .chat-card-btn').first().click()
  await expect.poll(() => sock.framesOf('permission.respond').length).toBe(1)
  expect(sock.framesOf('permission.respond')[0].command).toMatchObject({ type: 'permission.respond', sessionId: 'card-1', id: 'p1', optionId: 'once' })
  sock.push('card-1', { type: 'question.asked', id: 'q1', turnId: 't1', questions: [
    { id: 'lib', question: 'Which library?', options: [{ label: 'zod' }, { label: 'yup' }], multiSelect: false, freeText: false },
  ] })
  const q = paneTranscript(page).locator('.chat-question')
  await q.locator('input[value="yup"]').check()
  await q.locator('.chat-q-submit').click()
  await expect.poll(() => sock.framesOf('question.answer').length).toBe(1)
  expect(sock.framesOf('question.answer')[0].command).toMatchObject({ type: 'question.answer', id: 'q1', answers: { lib: 'yup' } })
})

test('continues the same session in Chat from the pane\'s Open in Chat with the draft', async ({ page }) => {
  const existing = session({ id: 'card-1', title: 'Broken logout', subject: SUBJECT, lastSeq: 1 })
  const state = makeState([existing], { 'card-1': [
    env('card-1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'Why does logout fail?', attachments: [], mentions: [] } }),
  ] })
  state.forbidLegacyChat = true
  state.models = modelsState()
  await installRoutes(page, state)
  await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  await expect(paneTranscript(page).locator('.chat-msg-user')).toContainText('Why does logout fail?')
  await paneInput(page).fill('And the fix?')
  await pane(page).locator('.chat-pane-open').click()
  await expect(page.locator('#view-chat')).toBeVisible()
  await expect(page.locator('#view-chat .chat-msg-user')).toContainText('Why does logout fail?')
  await expect(page.locator('#view-chat .chat-input')).toHaveValue('And the fix?')
  expect(state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat/sessions')).toHaveLength(0)
})

test('shows a card\'s earlier conversation and continues it', async ({ page }) => {
  const state = makeState([], {})
  state.forbidLegacyChat = true
  state.models = modelsState()
  state.legacy = { 'poise.issue.acme/app.7': { turns: [
    { prompt: 'First question', reply: 'First answer', at: '2026-10-20T10:00:00Z', status: 'completed' },
    { prompt: 'Second question', reply: 'Second answer', at: '2026-10-20T10:05:00Z', status: 'completed' },
  ], omitted: 0 } }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  const earlier = pane(page).locator('.chat-imported')
  await expect(earlier).toBeVisible()
  await expect(earlier).toContainText('First question')
  await expect(earlier).toContainText('Second answer')
  const id = await sendPaneMessage(page, sock, 'And now?')
  sock.push(id, { type: 'history.imported', legacyId: 'poise.issue.acme/app.7', turns: state.legacy!['poise.issue.acme/app.7']!.turns, omitted: 0 })
  sock.push(id, { type: 'turn.started', turnId: 't1', prompt: { text: 'And now?', attachments: [], mentions: [] } })
  await expect(paneTranscript(page).locator('.chat-imported')).toContainText('First question')
  await expect(paneTranscript(page).locator('.chat-msg-user')).toContainText('And now?')
})

test('keeps a running turn going when the pane closes and shows it on return', async ({ page }) => {
  const existing = session({ id: 'card-1', title: 'Broken logout', status: 'running', subject: SUBJECT, lastSeq: 1 })
  const state = makeState([existing], { 'card-1': [
    env('card-1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'Fix it', attachments: [], mentions: [] } }),
  ] })
  state.forbidLegacyChat = true
  state.models = modelsState()
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  await expect(paneTranscript(page).locator('.chat-msg-user')).toContainText('Fix it')
  await pane(page).locator('.chat-close').click()
  await expect(pane(page)).not.toHaveClass(/open/)
  expect(sock.framesOf('cancel')).toHaveLength(0)
  await openCardPane(page)
  await expect(paneTranscript(page).locator('.chat-msg-user')).toContainText('Fix it')
  expect(sock.framesOf('cancel')).toHaveLength(0)
})

test('runs /content while a turn is running without steering it', async ({ page }) => {
  const existing = session({ id: 'card-1', title: 'Broken logout', status: 'running', subject: SUBJECT, lastSeq: 1 })
  const state = makeState([existing], { 'card-1': [
    env('card-1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'Fix it', attachments: [], mentions: [] } }),
  ] })
  state.forbidLegacyChat = true
  state.models = modelsState()
  state.content = () => ({ status: 200, json: { call_id: 'c1', status: 'pending' } })
  state.contentJobs = { c1: { call_id: 'c1', status: 'completed', slug: 'release-notes' }, l1: { call_id: 'c1', status: 'completed', slug: 'release-notes' } }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  await sock.subscribed('card-1')
  sock.seq = 1
  await paneInput(page).fill('/content Release notes')
  await paneInput(page).press('Enter')
  await expect.poll(() => state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat-content')).toHaveLength(1)
  expect(state.calls.find((c) => c.method === 'POST' && c.path === '/api/chat-content')!.body).toMatchObject({ topic: 'Release notes', chatSession: 'card-1' })
  expect(sock.framesOf('steer')).toHaveLength(0)
  expect(sock.framesOf('prompt')).toHaveLength(0)
  sock.push('card-1', { type: 'content.started', topic: 'Release notes', launchId: 'l1', callId: 'c1' })
  await expect(paneTranscript(page).locator('.chat-content-card')).toContainText('Release notes')
  await expect(paneTranscript(page).locator('.chat-content-open')).toBeVisible()
})

test('refuses a Chat-only command with a note that names it', async ({ page }) => {
  const state = makeState([], {})
  state.forbidLegacyChat = true
  state.models = modelsState()
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  await paneInput(page).fill('/fork')
  await paneInput(page).press('Enter')
  await expect(pane(page).locator('.chat-surface-notice')).toContainText('Open in Chat to use /fork.')
  await expect(paneInput(page)).toHaveValue('/fork')
  expect(sock.framesOf('prompt')).toHaveLength(0)
  expect(state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat/sessions')).toHaveLength(0)
})

test('keeps the pane session subscribed across a server restart', async ({ page }) => {
  const existing = session({ id: 'card-1', title: 'Broken logout', subject: SUBJECT, lastSeq: 1 })
  const state = makeState([existing], { 'card-1': [
    env('card-1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'Fix it', attachments: [], mentions: [] } }),
  ] })
  state.forbidLegacyChat = true
  state.models = modelsState()
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await currentRoutes(page)
  await page.addInitScript(() => localStorage.setItem('poise-view', 'chat'))
  await page.goto('/')
  await sock.subscribed('card-1')
  const cardSubs = () => sock.framesOf('subscribe').filter((f) => (f.command as { sessionId: string }).sessionId === 'card-1').length
  const before = cardSubs()
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  await openCardPane(page)
  await expect(paneTranscript(page).locator('.chat-msg-user')).toContainText('Fix it')
  state.serverStartedAt = 'new-server-start'
  sock.ws!.close()
  await expect.poll(cardSubs).toBeGreaterThan(before)
  sock.seq = 1
  sock.push('card-1', { type: 'text.delta', turnId: 't1', messageId: 'reply', delta: 'Fixed by clearing the cookie.' })
  sock.push('card-1', { type: 'turn.finished', turnId: 't1', stopReason: 'end_turn' })
  await expect(paneTranscript(page).locator('.chat-msg-agent')).toContainText('Fixed by clearing the cookie.')
  await pane(page).locator('.chat-close').click()
  await expect(pane(page)).not.toHaveClass(/open/)
  expect(sock.framesOf('unsubscribe')).toHaveLength(0)
})

test('clears a /content command at send in the pane and keeps the composer usable', async ({ page }) => {
  const existing = session({ id: 'card-1', title: 'Broken logout', subject: SUBJECT, lastSeq: 0 })
  const state = makeState([existing], { 'card-1': [] })
  state.forbidLegacyChat = true
  state.models = modelsState()
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await currentRoutes(page)
  await page.goto('/')
  await openCardPane(page)
  await sock.subscribed('card-1')
  await paneInput(page).fill('/content Release notes')
  await paneInput(page).press('Enter')
  await expect(paneInput(page)).toHaveValue('')
  await expect.poll(() => state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chat-content')).toHaveLength(1)
  await paneInput(page).fill('A follow-up question')
  await paneInput(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ text: 'A follow-up question' })
})

const LEGACY_ROW = {
  id: 'legacy-row-1', repo: null, pr_id: null, actor: null, model: 'claude',
  behavior: 'chat', source: 'agent-interface', session_id: 'legacy-chat-1',
  prompt: 'An old conversation', started_at: NOW, started_at_precise: NOW,
  completed_at: NOW, time_elapsed: '1s', status: 'completed', outcome: 'ok',
  response: 'The old reply', error: '',
}

async function legacySwarm(page: Page, sessions: ReturnType<typeof session>[]): Promise<void> {
  const state = makeState(sessions)
  await installRoutes(page, state)
  await installSocket(page, state)
  await currentRoutes(page)
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ json: { logs: [LEGACY_ROW] } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator('#swarm-table')).toBeVisible()
}

test('opens the session that imported a legacy chat from its Swarm row', async ({ page }) => {
  await legacySwarm(page, [session({ id: 's-imported', title: 'Imported legacy chat', importedFrom: 'legacy-chat-1' })])
  await page.locator('.agent-session-link', { hasText: 'legacy-chat-1' }).click()
  await expect(page.locator('#view-chat')).toBeVisible()
  await expect(page.locator('.chat-session-item.active')).toContainText('Imported legacy chat')
})

test('a legacy chat never opened in Chat says so on its Swarm row', async ({ page }) => {
  await legacySwarm(page, [])
  await page.locator('.agent-session-link', { hasText: 'legacy-chat-1' }).click()
  await expect(page.locator('.agent-never-imported')).toHaveText('This conversation was never opened in Chat — its replies stay in Swarm.')
  await expect(page.locator('#view-chat')).not.toBeVisible()
})

for (const returnToSwarm of [false, true]) {
  test(`ignores a legacy lookup after leaving Swarm, return=${returnToSwarm}`, async ({ page }) => {
    await page.addInitScript(() => {
      const json = Response.prototype.json
      Response.prototype.json = async function () {
        const value: unknown = await json.call(this)
        if (new URL(this.url).searchParams.has('legacy')) Reflect.set(window, 'legacyLookupRead', true)
        return value
      }
      window.addEventListener('poise:open-chat-session', () => Reflect.set(window, 'legacyChatOpened', true))
    })
    const imported = session({ id: 's-imported', title: 'Imported legacy chat', importedFrom: 'legacy-chat-1' })
    await legacySwarm(page, [imported])
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const requested = new Promise<void>(resolve => { started = resolve })
    await page.route('**/api/chat/sessions?legacy=legacy-chat-1', async route => {
      started()
      await held
      await route.fulfill({ json: { session: imported } })
    })
    try {
      await page.locator('.agent-session-link', { hasText: 'legacy-chat-1' }).click()
      await requested
      await page.getByRole('button', { name: 'Current', exact: true }).click()
      await expect(page.locator('#view-swarm')).toBeHidden()
      if (returnToSwarm) {
        await page.getByRole('button', { name: 'Swarm', exact: true }).click()
        await expect(page.locator('#view-swarm')).toBeVisible()
      }
      release()
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'legacyLookupRead'))).toBe(true)
      expect(await page.evaluate(() => Reflect.get(window, 'legacyChatOpened'))).not.toBe(true)
      await expect(page.locator(returnToSwarm ? '#view-swarm' : '#view-current')).toBeVisible()
      await expect(page.locator('#view-chat')).toBeHidden()
    } finally { release() }
  })
}
