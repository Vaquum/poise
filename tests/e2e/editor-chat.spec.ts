// The document's own chat runs as an editor-document Chat session in the side
// pane: edit proposals render as cards, Accept saves through the Editor save
// route before the decision is recorded, and highlighted text travels as a
// quote with the next message.
import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { installRoutes, installSocket, makeState, session, env, NOW } from './fixtures/chat'
import { feedback } from './fixtures/view-feedback'
import type { ChatEnvelope, ChatSubject } from '../../server/chat/protocol'
type ChatSocket = Awaited<ReturnType<typeof installSocket>>
type ServerState = ReturnType<typeof makeState>

const VERSION = 'a'.repeat(64)
const AT = '2026-10-21T08:00:00Z'
const TEXT = '# A question\n\nOpening paragraph.\n\nA final thought.'
const SUBJECT: ChatSubject = { surface: 'editor-document', key: 'draft', label: 'A question' }

function modelsState() {
  return {
    catalog: { models: [{ identity: 'opus-5-max', selector: 'claude-opus-5', effort: 'max', provider: 'claude' }], review_providers: [], path: '' },
    places: [{ key: 'editor', model: 'opus-5-max' }],
    fixed: [],
    refresh: null,
  }
}

interface Editor {
  state: ServerState
  sock: ChatSocket
  saves: string[]
  holdSaves: { on: boolean, release: Array<() => void> }
  failSaves: { on: boolean }
}

async function editor(page: Page, content = TEXT, options: { preserveOnReload?: boolean } = {}): Promise<Editor> {
  const state = makeState([], {})
  state.models = modelsState()
  // The socket route must exist before navigation: registered after, the
  // WebSocket connects to the real server instead of the fixture.
  const sock = await installSocket(page, state)
  await workspace(page, 'current', undefined, options)
  // REST routes resolve last-registered-wins, so these go after the
  // workspace catch-all.
  await installRoutes(page, state)
  const saves: string[] = []
  const holdSaves = { on: false, release: [] as Array<() => void> }
  const failSaves = { on: false }
  let body = content
  await page.route('**/api/editor/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/editor/docs') return route.fulfill({ json: { docs: [{ slug: 'draft', title: 'A question', updated_at: AT, size: body.length }] } })
    if (path === '/api/editor/doc/draft') {
      if (request.method() === 'PUT' || request.method() === 'POST') {
        const incoming = String((request.postDataJSON() as { content: unknown }).content)
        if (failSaves.on) return route.fulfill({ status: 500, json: { error: 'Write unavailable' } })
        saves.push(incoming)
        if (holdSaves.on) await new Promise<void>((done) => holdSaves.release.push(done))
        body = incoming
      }
      return route.fulfill({ json: { slug: 'draft', title: 'A question', content: body, updated_at: AT, version: VERSION } })
    }
    if (path.endsWith('/annotations')) return route.fulfill({ json: { annotations: [], version: VERSION } })
    if (path.endsWith('/google/sync')) return route.fulfill({ json: { publications: [], version: VERSION } })
    if (path.endsWith('/reviews') || path.endsWith('/reviews/sync')) {
      return route.fulfill({ json: { reviews: [], checkedAt: null, active: false, stale: false, problems: [] } })
    }
    return route.fulfill({ json: {} })
  })
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(page.locator('#editor-doc')).toContainText('Opening paragraph.')
  return { state, sock, saves, holdSaves, failSaves }
}

const pane = (page: Page) => page.locator('#chat-side-pane')
const paneInput = (page: Page) => pane(page).locator('.chat-input')
const paneTranscript = (page: Page) => pane(page).locator('.chat-surface-transcript')
const docChatButton = (page: Page) => page.locator('.editor-chat-btn')

async function openDocChat(page: Page): Promise<void> {
  await docChatButton(page).click()
  await expect(pane(page)).toBeVisible()
}

async function sendPaneMessage(page: Page, sock: ChatSocket, text: string): Promise<string> {
  await paneInput(page).fill(text)
  await paneInput(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  return (sock.framesOf('prompt')[0].command as { sessionId: string }).sessionId
}

async function finishReply(sock: ChatSocket, id: string, text: string, reply: string): Promise<ChatEnvelope[]> {
  await sock.subscribed(id)
  const turnId = 't1'
  const messageId = 'reply-1'
  return [
    sock.push(id, { type: 'turn.started', turnId, prompt: { text, attachments: [], mentions: [] } }),
    sock.push(id, { type: 'text.delta', turnId, messageId, delta: reply }),
    sock.push(id, { type: 'turn.finished', turnId, stopReason: 'end_turn' }),
  ]
}

const PROPOSAL = JSON.stringify({
  chat: 'Two small edits.',
  edits: [
    { description: 'sharpen the opening', old: 'Opening paragraph.', new: 'Opening paragraph, revised.' },
    { description: 'sharpen the close', old: 'A final thought.', new: 'A final thought, revised.' },
  ],
})

test('proposes edits in the document chat and applies an accepted one to the document', async ({ page }) => {
  const { sock, saves, holdSaves, failSaves } = await editor(page)
  await openDocChat(page)
  const id = await sendPaneMessage(page, sock, 'Tighten this up')
  await finishReply(sock, id, 'Tighten this up', PROPOSAL)
  const cards = paneTranscript(page).locator('.chat-edit-card')
  await expect(cards).toHaveCount(2)
  // The save goes through the Editor save route, and the decision waits for
  // it: while the save is held, no edit.decide is sent.
  holdSaves.on = true
  await cards.nth(0).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect.poll(() => saves.length).toBe(1)
  expect(saves[0]).toContain('Opening paragraph, revised.')
  await page.waitForTimeout(300)
  expect(sock.framesOf('edit.decide')).toHaveLength(0)
  holdSaves.on = false
  for (const release of holdSaves.release.splice(0)) release()
  await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
  expect(sock.framesOf('edit.decide')[0].command).toMatchObject({ type: 'edit.decide', sessionId: id, index: 0, decision: 'applied' })
  await expect(cards.nth(0).locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
  await expect(page.locator('#editor-doc')).toContainText('Opening paragraph, revised.')
  // A refused save records nothing and shows the save error.
  failSaves.on = true
  await cards.nth(1).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect.poll(() => saves.length).toBe(1)
  await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
  await expect(await feedback(page, 'Editor needs attention')).toContainText('could not be saved')
  // The failed save withdrew the edit, so Accept can be retried cleanly.
  await expect(page.locator('#editor-doc')).not.toContainText('A final thought, revised.')
  failSaves.on = false
  await cards.nth(1).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect.poll(() => sock.framesOf('edit.decide').length).toBe(2)
  expect(sock.framesOf('edit.decide')[1].command).toMatchObject({ decision: 'applied' })
  await expect(page.locator('#editor-doc')).toContainText('A final thought, revised.')
})

const INSERTION = JSON.stringify({
  chat: 'One insertion.',
  edits: [{ old: '', new: ' Added once.', context_before: 'Opening paragraph.' }],
})

test('locks a pure insertion across rapid decisions and rerenders while its save is pending', async ({ page }) => {
  const { state, sock, saves, holdSaves } = await editor(page)
  await openDocChat(page)
  const id = await sendPaneMessage(page, sock, 'Add one sentence')
  await finishReply(sock, id, 'Add one sentence', INSERTION)
  const card = paneTranscript(page).locator('.chat-edit-card').first()
  holdSaves.on = true
  await card.getByRole('button', { name: 'Accept', exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  await expect.poll(() => saves.length).toBe(1)
  const accept = card.getByRole('button', { name: 'Accept', exact: true })
  const decline = card.getByRole('button', { name: 'Decline', exact: true })
  await expect(accept).toBeDisabled()
  await expect(decline).toBeDisabled()
  sock.push(id, { type: 'session.updated', session: { ...state.sessions.find((s) => s.id === id)!, status: 'idle' } })
  sock.push(id, { type: 'text.delta', turnId: 't1', messageId: 'reply-1', delta: '' })
  await expect(accept).toBeDisabled()
  await expect(decline).toBeDisabled()
  // Dispatching through the delegated handler also exercises the guard;
  // native disabled buttons already suppress normal clicks.
  for (const button of [accept, decline]) await button.dispatchEvent('click')
  await expect(page.locator('#editor-doc')).toContainText('Opening paragraph. Added once.')
  await expect(page.locator('#editor-doc')).not.toContainText('Added once. Added once.')
  expect(sock.framesOf('edit.decide')).toHaveLength(0)
  holdSaves.on = false
  for (const release of holdSaves.release.splice(0)) release()
  await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
  await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
  expect(saves).toEqual([TEXT.replace('Opening paragraph.', 'Opening paragraph. Added once.')])
})

test('retries recording a saved pure insertion without applying it again', async ({ page }) => {
  const { sock, saves } = await editor(page)
  await openDocChat(page)
  const id = await sendPaneMessage(page, sock, 'Add one sentence')
  await finishReply(sock, id, 'Add one sentence', INSERTION)
  const card = paneTranscript(page).locator('.chat-edit-card').first()
  sock.autoAck = false
  await card.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
  sock.ack(sock.framesOf('edit.decide')[0], false, 'Decision unavailable')
  await expect(pane(page).locator('.chat-surface-notice')).toContainText('Decision unavailable')
  await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
  sock.autoAck = true
  await pane(page).getByRole('button', { name: 'Retry', exact: true }).click()
  await expect.poll(() => sock.framesOf('edit.decide').length).toBe(2)
  expect(sock.framesOf('edit.decide')[1].command).toMatchObject({ decision: 'applied' })
  await expect(pane(page).locator('.chat-surface-notice')).toBeHidden()
  expect(saves).toEqual([TEXT.replace('Opening paragraph.', 'Opening paragraph. Added once.')])
  await expect(page.locator('#editor-doc')).not.toContainText('Added once. Added once.')
})

for (const closeAt of ['after the acknowledgement fails', 'while the acknowledgement is pending', 'while the save is pending'] as const) {
  test(`keeps a saved insertion locked across pane remount ${closeAt}`, async ({ page }) => {
    const { state, sock, saves, holdSaves } = await editor(page)
    await openDocChat(page)
    const id = await sendPaneMessage(page, sock, 'Add one sentence')
    state.history[id] = await finishReply(sock, id, 'Add one sentence', INSERTION)
    const card = paneTranscript(page).locator('.chat-edit-card').first()
    sock.autoAck = false
    holdSaves.on = closeAt === 'while the save is pending'
    await card.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect.poll(() => saves.length).toBe(1)
    if (!holdSaves.on) await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
    if (closeAt === 'after the acknowledgement fails') {
      sock.ack(sock.framesOf('edit.decide')[0], false, 'Decision unavailable')
      await expect(pane(page).locator('.chat-surface-notice')).toContainText('Decision unavailable')
    }
    await pane(page).getByRole('button', { name: 'Close chat', exact: true }).click()
    await openDocChat(page)
    await expect(card).toBeVisible()
    if (holdSaves.on) {
      await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled()
      await expect(card.getByRole('button', { name: 'Decline', exact: true })).toBeDisabled()
      holdSaves.on = false
      for (const release of holdSaves.release.splice(0)) release()
      await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
    }
    if (closeAt !== 'after the acknowledgement fails') {
      sock.ack(sock.framesOf('edit.decide')[0], false, 'Decision unavailable')
    }
    await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
    await expect(card.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0)
    await expect(pane(page).locator('.chat-surface-notice')).toContainText('Decision unavailable')
    sock.autoAck = true
    await pane(page).getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => sock.framesOf('edit.decide').length).toBe(2)
    expect(sock.framesOf('edit.decide')[1].command).toMatchObject({ sessionId: id, decision: 'applied' })
    await expect(pane(page).locator('.chat-surface-notice')).toBeHidden()
    await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
    expect(saves).toEqual([TEXT.replace('Opening paragraph.', 'Opening paragraph. Added once.')])
    await expect(page.locator('#editor-doc')).not.toContainText('Added once. Added once.')
  })
}

for (const confirmation of ['live', 'replayed'] as const) {
  test(`trusts a ${confirmation} saved edit decision before a late failed acknowledgement after remount`, async ({ page }) => {
    const { state, sock, saves } = await editor(page)
    await openDocChat(page)
    const id = await sendPaneMessage(page, sock, 'Add one sentence')
    state.history[id] = await finishReply(sock, id, 'Add one sentence', INSERTION)
    sock.autoAck = false
    const card = paneTranscript(page).locator('.chat-edit-card').first()
    await card.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
    const decided: ChatEnvelope = { seq: ++sock.seq, sessionId: id, at: NOW,
      event: { type: 'edit.decided', turnId: 't1', messageId: 'reply-1', index: 0, decision: 'applied' } }
    state.history[id].push(decided)
    if (confirmation === 'live') {
      sock.ws!.send(JSON.stringify({ kind: 'event', envelope: decided }))
      await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
    }
    await pane(page).getByRole('button', { name: 'Close chat', exact: true }).click()
    await openDocChat(page)
    await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
    sock.ack(sock.framesOf('edit.decide')[0], false, 'Acknowledgement lost')
    // The following frame proves the late acknowledgement and its promise
    // continuation were processed before checking that no retry reappeared.
    sock.push(id, { type: 'session.updated', session: { ...state.sessions.find(s => s.id === id)!, status: 'running' } })
    await expect(pane(page).locator('.chat-pane-state')).toHaveText('running')
    await expect(pane(page).locator('.chat-surface-notice')).toBeHidden()
    await expect(pane(page).getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
    expect(saves).toEqual([TEXT.replace('Opening paragraph.', 'Opening paragraph. Added once.')])
    expect(sock.framesOf('edit.decide')).toHaveLength(1)
  })
}

for (const reopen of ['remount', 'reload'] as const) {
  test(`keeps a later saved insertion after replaying an old conflict on ${reopen}`, async ({ page }) => {
    const { state, sock, saves } = await editor(page, TEXT, { preserveOnReload: true })
    await openDocChat(page)
    const id = await sendPaneMessage(page, sock, 'Add one sentence')
    state.history[id] = await finishReply(sock, id, 'Add one sentence', INSERTION)
    state.history[id].push(sock.push(id, { type: 'edit.decided', turnId: 't1', messageId: 'reply-1', index: 0, decision: 'conflict' }))
    const card = paneTranscript(page).locator('.chat-edit-card').first()
    await expect(card.locator('.chat-edit-card-badge-conflict')).toContainText('Conflict')
    sock.autoAck = false
    await card.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
    sock.ack(sock.framesOf('edit.decide')[0], false, 'Decision unavailable')
    await expect(pane(page).locator('.chat-surface-notice')).toContainText('Decision unavailable')
    const recoveryKey = `poise:editor-applied:v2:${encodeURIComponent(state.sessions.find(s => s.id === id)!.instance)}:${encodeURIComponent(id)}:${encodeURIComponent(JSON.stringify(['t1', 'reply-1', 0]))}`
    const marker = await page.evaluate(key => localStorage.getItem(key), recoveryKey)
    expect(JSON.parse(marker!)).toEqual({ afterSeq: state.history[id].at(-1)!.seq, operationId: expect.any(String) })
    expect(marker).not.toContain('Opening paragraph')
    expect(marker).not.toContain('Added once')
    if (reopen === 'reload') {
      await page.reload()
      await expect(page.locator('#editor-doc')).toContainText('Opening paragraph. Added once.')
    } else await pane(page).getByRole('button', { name: 'Close chat', exact: true }).click()
    await openDocChat(page)
    await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
    await expect(card.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
    await expect(pane(page).getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    sock.autoAck = true
    await pane(page).getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => sock.framesOf('edit.decide').length).toBe(2)
    expect(sock.framesOf('edit.decide')[1].command).toMatchObject({ sessionId: id, decision: 'applied' })
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), recoveryKey)).toBeNull()
    expect(saves).toEqual([TEXT.replace('Opening paragraph.', 'Opening paragraph. Added once.')])
    await expect(page.locator('#editor-doc')).not.toContainText('Added once. Added once.')
    // Once the authoritative receipt exists, history owns the decision and
    // another reload needs neither a local marker nor a retry.
    state.history[id].push({ seq: sock.seq, sessionId: id, at: NOW,
      event: { type: 'edit.decided', turnId: 't1', messageId: 'reply-1', index: 0, decision: 'applied' } })
    await page.reload()
    await expect(page.locator('#editor-doc')).toContainText('Opening paragraph. Added once.')
    await openDocChat(page)
    await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
    await expect(pane(page).getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    expect(saves).toHaveLength(1)
  })
}

test('withdraws a failed decision Retry when the applied receipt arrives later', async ({ page }) => {
  const { state, sock, saves } = await editor(page)
  await openDocChat(page)
  const id = await sendPaneMessage(page, sock, 'Add one sentence')
  await finishReply(sock, id, 'Add one sentence', INSERTION)
  sock.autoAck = false
  const card = paneTranscript(page).locator('.chat-edit-card').first()
  await card.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
  sock.ack(sock.framesOf('edit.decide')[0], false, 'Decision unavailable')
  const retry = pane(page).getByRole('button', { name: 'Retry', exact: true })
  await expect(retry).toBeVisible()
  const stale = await retry.elementHandle()
  sock.push(id, { type: 'edit.decided', turnId: 't1', messageId: 'reply-1', index: 0, decision: 'applied' })
  await expect(retry).toHaveCount(0)
  // A queued click on the removed control must also remain harmless.
  await stale!.evaluate((button: HTMLButtonElement) => button.click())
  sock.push(id, { type: 'session.updated', session: { ...state.sessions.find(item => item.id === id)!, status: 'running' } })
  await expect(pane(page).locator('.chat-pane-state')).toHaveText('running')
  await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
  expect(sock.framesOf('edit.decide')).toHaveLength(1)
  expect(saves).toEqual([TEXT.replace('Opening paragraph.', 'Opening paragraph. Added once.')])
})

test('keeps an unacknowledged saved insertion when another tab declines a different card', async ({ page }) => {
  const first = await editor(page, TEXT, { preserveOnReload: true })
  await openDocChat(page)
  const id = await sendPaneMessage(page, first.sock, 'Add one sentence')
  first.state.history[id] = await finishReply(first.sock, id, 'Add one sentence', JSON.stringify({
    chat: 'Two edits.', edits: [{ old: '', new: ' Added once.', context_before: 'Opening paragraph.' },
      { old: 'A final thought.', new: 'A revised final thought.' }],
  }))
  const other = await page.context().newPage()
  try {
    // Both fixture installers normally clear storage once per tab. Preserve
    // the shared origin here so this exercises real cross-tab marker writes.
    await other.addInitScript(() => {
      sessionStorage.setItem('poise-workspace-initialized', '1')
      sessionStorage.setItem('chat-fixture-initialized', '1')
      localStorage.setItem('poise-view', 'current')
    })
    const second = await editor(other, TEXT, { preserveOnReload: true })
    second.state.sessions.push({ ...first.state.sessions.find(item => item.id === id)! })
    second.state.history[id] = [...first.state.history[id]]
    second.sock.seq = first.sock.seq
    await openDocChat(other)
    await expect(paneTranscript(other).locator('.chat-edit-card')).toHaveCount(2)
    first.sock.autoAck = false
    await paneTranscript(page).locator('.chat-edit-card').first().getByRole('button', { name: 'Accept', exact: true }).click()
    await expect.poll(() => first.sock.framesOf('edit.decide').length).toBe(1)
    first.sock.ack(first.sock.framesOf('edit.decide')[0], false, 'Decision unavailable')
    await expect(pane(page).getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    const markers = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('poise:editor-applied:v2:')))
    const before = await markers()
    expect(before).toHaveLength(1)
    await paneTranscript(other).locator('.chat-edit-card').nth(1).getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(paneTranscript(other).locator('.chat-edit-card-badge-declined')).toHaveText('Declined')
    expect(await markers()).toEqual(before)
    await page.reload()
    await expect(page.locator('#editor-doc')).toContainText('Opening paragraph. Added once.')
    await openDocChat(page)
    const card = paneTranscript(page).locator('.chat-edit-card').first()
    await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
    await expect(card.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
    first.sock.autoAck = true
    await pane(page).getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => first.sock.framesOf('edit.decide').length).toBe(2)
    expect(first.sock.framesOf('edit.decide')[1].command).toMatchObject({ index: 0, decision: 'applied' })
    expect(first.saves).toEqual([TEXT.replace('Opening paragraph.', 'Opening paragraph. Added once.')])
  } finally { await other.close() }
})

test('learns another tab saved an insertion before accepting in an already mounted surface', async ({ page }) => {
  const first = await editor(page, TEXT, { preserveOnReload: true })
  await openDocChat(page)
  const id = await sendPaneMessage(page, first.sock, 'Add one sentence')
  first.state.history[id] = await finishReply(first.sock, id, 'Add one sentence', INSERTION)
  const other = await page.context().newPage()
  try {
    await other.addInitScript(() => {
      sessionStorage.setItem('poise-workspace-initialized', '1')
      sessionStorage.setItem('chat-fixture-initialized', '1')
      localStorage.setItem('poise-view', 'current')
    })
    const second = await editor(other, TEXT, { preserveOnReload: true })
    second.state.sessions.push({ ...first.state.sessions.find(item => item.id === id)! })
    second.state.history[id] = [...first.state.history[id]]
    second.sock.seq = first.sock.seq
    await openDocChat(other)
    const card = paneTranscript(other).locator('.chat-edit-card').first()
    await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeVisible()
    const mountedComposer = await pane(other).locator('.chat-input').elementHandle()
    first.sock.autoAck = false
    await paneTranscript(page).locator('.chat-edit-card').first().getByRole('button', { name: 'Accept', exact: true }).click()
    await expect.poll(() => first.sock.framesOf('edit.decide').length).toBe(1)
    first.sock.ack(first.sock.framesOf('edit.decide')[0], false, 'Decision unavailable')
    await expect(pane(page).getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    expect(first.saves).toEqual([TEXT.replace('Opening paragraph.', 'Opening paragraph. Added once.')])
    let content = first.saves[0]
    const repeatedSaves: string[] = []
    await other.route('**/api/editor/doc/draft', route => {
      if (route.request().method() === 'PUT' || route.request().method() === 'POST') {
        content = String((route.request().postDataJSON() as { content: string }).content)
        repeatedSaves.push(content)
      }
      return route.fulfill({ json: { slug: 'draft', title: 'A question', content, updated_at: AT, version: VERSION } })
    })
    await other.route('**/api/editor/doc/other', route => route.fulfill({ json: { slug: 'other', content: '# Other document', updated_at: AT, version: VERSION } }))
    await other.evaluate(() => window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail: { slug: 'other' } })))
    await expect(other.locator('#editor-doc')).toContainText('Other document')
    await other.evaluate(() => window.dispatchEvent(new CustomEvent('poise:editor-load-doc', { detail: { slug: 'draft' } })))
    await expect(other.locator('#editor-doc')).toContainText('Opening paragraph. Added once.')
    expect(await mountedComposer!.evaluate(el => el.isConnected)).toBe(true)
    await card.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect.poll(() => second.sock.framesOf('edit.decide').length).toBe(1)
    await expect(card.locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
    expect(second.sock.framesOf('edit.decide')[0].command).toMatchObject({ sessionId: id, decision: 'applied' })
    expect(repeatedSaves).toEqual([])
    expect(content).toBe(first.saves[0])
    await expect(other.locator('#editor-doc')).not.toContainText('Added once. Added once.')
  } finally { await other.close() }
})

test("highlights an edit card's target in the document on hover", async ({ page }) => {
  const { sock } = await editor(page)
  await openDocChat(page)
  const id = await sendPaneMessage(page, sock, 'Tighten this up')
  await finishReply(sock, id, 'Tighten this up', PROPOSAL)
  const card = paneTranscript(page).locator('.chat-edit-card').first()
  await expect(card).toBeVisible()
  await card.hover()
  const mark = page.locator('.edit-hover-mark').first()
  await expect(mark).toBeVisible()
  // Let the smooth scroll settle, then read both rectangles.
  const stable = async () => {
    let box = await mark.boundingBox()
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(100)
      const next = await mark.boundingBox()
      if (box && next && Math.abs(box.y - next.y) < 1) return next
      box = next
    }
    return box
  }
  const markBox = await stable()
  const targetBox = await page.evaluate(() => {
    const doc = document.querySelector('#editor-doc')!
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT)
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      const at = node.textContent!.indexOf('Opening paragraph.')
      if (at >= 0) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 'Opening paragraph.'.length)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
    }
    return null
  })
  expect(markBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  const overlap = (a: { x: number, y: number, width: number, height: number }, b: { x: number, y: number, width: number, height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  expect(overlap(markBox!, targetBox!)).toBe(true)
})

test('shows the same edit decisions after a reload and read-only in Chat', async ({ page }) => {
  const { state, sock } = await editor(page, TEXT, { preserveOnReload: true })
  await openDocChat(page)
  const id = await sendPaneMessage(page, sock, 'Tighten this up')
  const envelopes = await finishReply(sock, id, 'Tighten this up', PROPOSAL)
  await paneTranscript(page).locator('.chat-edit-card').first().getByRole('button', { name: 'Accept', exact: true }).click()
  await expect.poll(() => sock.framesOf('edit.decide').length).toBe(1)
  // The reload replays the transcript, including the recorded decision.
  state.history[id] = [...envelopes, { seq: 99, sessionId: id, at: NOW, event: { type: 'edit.decided', turnId: 't1', messageId: 'reply-1', index: 0, decision: 'applied' } }]
  await page.reload()
  // The accepted edit persisted: the doc reopens revised.
  await expect(page.locator('#editor-doc')).toContainText('Opening paragraph, revised.')
  await openDocChat(page)
  await expect(paneTranscript(page).locator('.chat-edit-card-badge-applied')).toHaveText('Applied')
  // Chat shows the same cards read-only, with Open in Editor.
  await page.locator('.editor-chat-session-btn').click()
  const transcript = page.locator('.chat-transcript')
  await expect(transcript.locator('.chat-edit-card')).toHaveCount(2)
  await expect(transcript.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0)
  await expect(transcript.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0)
  await transcript.getByRole('button', { name: 'Open in Editor', exact: true }).first().click()
  await expect(page.locator('#editor-doc')).toBeVisible()
  await expect(pane(page)).toBeVisible()
  await expect(pane(page).locator('.chat-title')).toHaveText('A question')
})

test("opens the document's own chat from Chat about this document", async ({ page }) => {
  const { state, sock } = await editor(page)
  await page.locator('.editor-chat-session-btn').click()
  const input = page.locator('.chat-v-composer .chat-input')
  await expect(input).toBeVisible()
  await input.fill('Hello doc')
  await input.press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  const created = state.calls.find((call) => call.method === 'POST' && call.path === '/api/chat/sessions')
  expect(created?.body).toMatchObject({ subject: SUBJECT })
})

test("shows a document's earlier conversation and continues it", async ({ page }) => {
  const { state, sock } = await editor(page)
  const seeded = session({ id: 's-doc', subject: SUBJECT, importedFrom: 'editor-draft-1760000000000', status: 'idle' })
  state.sessions.unshift(seeded)
  state.history['s-doc'] = [env('s-doc', 1, {
    type: 'history.imported', legacyId: 'editor-draft-1760000000000',
    turns: [{ prompt: 'Earlier question', reply: 'Earlier answer', at: NOW, status: 'completed' }], omitted: 0,
  })]
  await openDocChat(page)
  await expect(paneTranscript(page)).toContainText('Earlier conversation')
  await expect(paneTranscript(page)).toContainText('Earlier question')
  await sendPaneMessage(page, sock, 'Follow-up')
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ type: 'prompt', sessionId: 's-doc', text: 'Follow-up' })
})

test('sends the highlighted text as a quote with the next message and clears the chip', async ({ page }) => {
  const { state, sock } = await editor(page)
  await openDocChat(page)
  await selectLine(page, 'Opening paragraph.')
  const chip = pane(page).locator('.chat-surface-highlight')
  await expect(chip).toContainText('Highlighted ·')
  await expect(chip).toContainText('Opening paragraph.')
  await expect(chip.getByRole('button', { name: 'Remove highlight' })).toBeVisible()
  const firstId = await sendPaneMessage(page, sock, 'What does this mean?')
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ text: '> Opening paragraph.\n\nWhat does this mean?' })
  await sock.subscribed(firstId)
  sock.push(firstId, { type: 'turn.started', turnId: 't1', prompt: { text: 'What does this mean?', attachments: [], mentions: [] } })
  sock.push(firstId, { type: 'turn.finished', turnId: 't1', stopReason: 'end_turn' })
  const created = state.sessions.find((s) => s.id === firstId)!
  sock.push(firstId, { type: 'session.updated', session: { ...created, status: 'idle' } })
  await expect(chip).toBeHidden()
  // A refused send keeps the chip with the draft.
  await selectLine(page, 'A final thought.')
  await expect(chip).toBeVisible()
  sock.autoAck = false
  await paneInput(page).fill('And this?')
  await paneInput(page).press('Enter')
  await expect.poll(() => sock.held.length).toBe(1)
  await expect(chip).toBeVisible()
  sock.ack(sock.held[0], false, 'No thanks')
  // The refused send restores the draft and keeps the chip.
  await expect(paneInput(page)).toHaveValue('And this?')
  await expect(pane(page).locator('.chat-surface-notice')).toContainText('No thanks')
  await expect(chip).toBeVisible()
  sock.autoAck = true
  // A command keeps the head of the prompt so the runtime parses it; the
  // quote follows.
  await paneInput(page).fill('/review be kind')
  await paneInput(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(3)
  const text = (sock.framesOf('prompt')[2].command as { text: string }).text
  expect(text.startsWith('/review be kind')).toBe(true)
  expect(text).toContain('> A final thought.')
})

test('keeps the highlight chip when focus moves to the composer', async ({ page }) => {
  await editor(page)
  await openDocChat(page)
  await selectLine(page, 'Opening paragraph.')
  const chip = pane(page).locator('.chat-surface-highlight')
  await expect(chip).toBeVisible()
  await paneInput(page).click()
  await expect(chip).toBeVisible()
  await expect(chip.getByRole('button', { name: 'Remove highlight' })).toBeVisible()
})

async function selectLine(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const lines = [...document.querySelectorAll('#editor-doc .editor-line')]
    const line = lines.find((el) => el.textContent!.includes(text))!
    const range = document.createRange()
    range.selectNodeContents(line)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }, needle)
}
