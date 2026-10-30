import { expect, test, type Page } from '@playwright/test'
import type { SwitchboardItem, SwitchboardState } from '../../server/chat/protocol'
import { NOW, session, installRoutes, installSocket, makeState, switchboardState } from './fixtures/chat'

const SWITCHBOARD = '5b000000-0000-4000-8000-000000000000'
const AT = new Date(Date.now() - 4 * 60_000).toISOString()
function item(overrides: Partial<SwitchboardItem> & Pick<SwitchboardItem, 'id' | 'kind' | 'text'>): SwitchboardItem {
  return {
    source: { sessionId: 's1', title: 'Fix the login bug', agent: 'claude', model: 'opus-5-max', exists: true },
    sourceSeq: 3, detail: null, createdAt: AT, explanation: { state: 'none' }, ...overrides,
  }
}
const decision = item({ id: 7, kind: 'decision', text: 'Which MCP settings design should I build?', detail: 'Both mocks are ready.',
  source: { sessionId: 's2', title: 'MCP settings and adapters', agent: 'claude', model: 'opus-5-max', exists: true },
  options: [{ id: 'o1', label: 'A · Settings panel', detail: 'A panel in the menu', recommended: true }, { id: 'o2', label: 'B · Manager sheet', detail: null, recommended: false }] })
const second = item({ id: 8, kind: 'decision', text: 'Rebase onto main now?', options: [{ id: 'o1', label: 'Rebase now', detail: null, recommended: false }] })
const blocked = item({ id: 5, kind: 'blocked', text: 'GitHub API quota is exhausted until 18:42.' })
const done = item({ id: 4, kind: 'done', text: '#337 merged.', source: { sessionId: 's3', title: 'Fix review launch contention', agent: 'codex', model: 'gpt-6-astra-ultra', exists: true } })
const live = (items: SwitchboardItem[], overrides: Partial<SwitchboardState> = {}) => switchboardState({ status: 'live', sessionId: SWITCHBOARD, sessionStatus: 'idle', chats: 3, items, ...overrides })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('chat-fixture-initialized')) {
      localStorage.clear()
      localStorage.setItem('poise-view', 'chat')
      sessionStorage.setItem('chat-fixture-initialized', '1')
    }
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort())
})

const pane = (page: Page) => page.locator('#chat-switchboard-pane')
const width = async (page: Page, selector: string) => Math.round(await page.locator(selector).evaluate(el => el.getBoundingClientRect().width))

test('shows and hides the Switchboard at one third, snaps to half, and remembers its share', async ({ page }) => {
  const state = makeState([session()])
  state.switchboard = live([decision, blocked])
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  const toggle = page.getByRole('button', { name: /^Switchboard/ })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle.locator('.chat-switchboard-badge')).toHaveText('1')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(pane(page).getByRole('heading', { name: 'Switchboard' })).toBeVisible()
  const total = await width(page, '.chat-layout')
  await expect.poll(() => width(page, '#chat-switchboard-pane')).toBe(Math.round(total / 3))

  const handle = page.getByRole('separator', { name: 'Resize Switchboard' })
  const edge = (await handle.boundingBox())!
  await page.mouse.move(edge.x + 2, edge.y + 200)
  await page.mouse.down()
  await page.mouse.move(edge.x + 2 - (total / 2 - total / 3) + 9, edge.y + 200, { steps: 10 })
  await expect(page.locator('.sb-readout')).toHaveText('Half')
  await page.mouse.up()
  await expect.poll(() => width(page, '#chat-switchboard-pane')).toBe(Math.round(total / 2))
  expect(Number(await page.evaluate(() => localStorage.getItem('poise-chat-switchboard-width')))).toBeCloseTo(.5, 2)

  await page.reload()
  await expect.poll(() => width(page, '#chat-switchboard-pane')).toBe(Math.round(total / 2))
  // Manager and Switchboard half and half: the sessions list hidden.
  await page.getByRole('button', { name: 'Toggle sessions' }).click()
  await expect.poll(async () => Math.abs(await width(page, '.chat-main') - await width(page, '#chat-switchboard-pane'))).toBeLessThanOrEqual(2)

  await handle.dblclick()
  await expect.poll(() => width(page, '#chat-switchboard-pane')).toBe(Math.round(total / 3))
  await handle.focus()
  await handle.press('ArrowLeft')
  await expect.poll(() => width(page, '#chat-switchboard-pane')).toBe(Math.round(total / 3) + 16)
  await handle.press('Shift+ArrowRight')
  await expect.poll(() => width(page, '#chat-switchboard-pane')).toBe(Math.round(total / 3) - 24)

  await pane(page).getByRole('button', { name: 'Hide Switchboard' }).click()
  await expect.poll(() => width(page, '#chat-switchboard-pane')).toBe(0)
  expect(await pane(page).evaluate(el => (el as HTMLElement).inert)).toBe(true)
  await expect(toggle.locator('.chat-switchboard-badge')).toHaveText('1')
})

test('floats over a narrow chat, and never stacks with Memories', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 760 })
  const state = makeState([session()])
  state.switchboard = live([blocked])
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await page.locator('.chat-session-item').click()
  const toggle = page.getByRole('button', { name: /^Switchboard/ })
  await toggle.click()
  await expect(pane(page)).toHaveCSS('position', 'absolute')
  await page.locator('.chat-h-memories').click()
  await expect(page.locator('#chat-memories-pane')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(page.locator('.chat-h-memories')).toHaveAttribute('aria-pressed', 'false')
  await pane(page).getByRole('button', { name: 'Hide Switchboard' }).focus()
  await page.keyboard.press('Escape')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('answers decisions with a choice or in its own words, exactly once each', async ({ page }) => {
  const state = makeState([session(), session({ id: 's2', title: 'MCP settings and adapters' })])
  state.switchboard = live([second, decision, blocked, done])
  state.switchboardAnswer = (id, body) => {
    const answer = 'optionId' in body ? { label: id === 7 ? 'A · Settings panel' : 'Rebase now', freeText: false } : { label: body.text, freeText: true }
    state.switchboard = { ...state.switchboard!, revision: state.switchboard!.revision + 1,
      items: state.switchboard!.items.map(entry => entry.id === id ? { ...entry, answer: { ...answer, at: new Date().toISOString(), relay: 'queued' } } : entry) }
    return state.switchboard
  }
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: /^Switchboard/ }).click()
  const card = pane(page).locator('.sb-decision')
  // The longest-waiting decision is in front; the other waits as a row.
  await expect(card.locator('.sb-q')).toHaveText('Which MCP settings design should I build?')
  await expect(card.getByRole('button', { name: /A · Settings panel/ })).toContainText('Recommended')
  await expect(pane(page).locator('.sb-next')).toContainText('Rebase onto main now?')
  await card.getByRole('button', { name: /A · Settings panel/ }).click()
  await expect(pane(page).getByRole('status').filter({ hasText: 'You answered' })).toContainText('“A · Settings panel”')
  const answers = () => state.calls.filter(call => call.path.endsWith('/answer'))
  expect(answers()).toEqual([{ method: 'POST', path: '/api/chat/switchboard/items/7/answer', body: { optionId: 'o1' } }])

  await expect(card.locator('.sb-q')).toHaveText('Rebase onto main now?')
  await card.getByRole('button', { name: /Something else/ }).click()
  const text = card.getByRole('textbox', { name: /Your answer to/ })
  await expect(text).toBeFocused()
  const send = card.getByRole('button', { name: 'Send answer' })
  await expect(send).toBeDisabled()
  await text.fill('Wait for #345 if it touches runtime.ts.')
  await text.press('ControlOrMeta+Enter')
  await expect.poll(() => answers().length).toBe(2)
  expect(answers()[1].body).toEqual({ text: 'Wait for #345 if it touches runtime.ts.' })
  await expect(pane(page).locator('.sb-decision')).toHaveCount(0)
})

test('explains an update inline once and shows the answer when it arrives', async ({ page }) => {
  const state = makeState([session()])
  state.switchboard = live([blocked, done])
  state.switchboardExplain = id => {
    state.switchboard = { ...state.switchboard!, revision: state.switchboard!.revision + 1,
      items: state.switchboard!.items.map(entry => entry.id === id ? { ...entry, explanation: { state: 'pending', since: NOW } } : entry) }
    return state.switchboard
  }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: /^Switchboard/ }).click()
  const line = pane(page).locator('.sb-line', { hasText: 'Fix the login bug' })
  await line.locator('.sb-line-head').click()
  await line.getByRole('button', { name: 'Explain' }).click()
  await expect(line.getByRole('region', { name: 'Explanation of update 5' })).toContainText('Asking the Switchboard')
  expect(state.calls.filter(call => call.path.endsWith('/explain'))).toHaveLength(1)
  state.switchboard = { ...state.switchboard, revision: state.switchboard.revision + 1, items: state.switchboard.items.map(entry => entry.id === 5
    ? { ...entry, explanation: { state: 'ready', changed: 'The worker hit the rate limit.', matters: '#339 waits until 18:42.', uncertain: 'Whether CI passed.', at: NOW } } : entry) }
  sock.ws!.send(JSON.stringify({ kind: 'switchboard.updated', revision: state.switchboard.revision }))
  const region = line.getByRole('region', { name: 'Explanation of update 5' })
  await expect(region).toContainText('What changed')
  await expect(region).toContainText('The worker hit the rate limit.')
  await expect(region).toContainText('#339 waits until 18:42.')
  await expect(region).toContainText('Whether CI passed.')
  await line.getByRole('button', { name: 'Hide explanation' }).click()
  await line.getByRole('button', { name: 'Explain' }).click()
  expect(state.calls.filter(call => call.path.endsWith('/explain'))).toHaveLength(1)
})

test('leaves the Switchboard chat out of the session list and opens it from the pane', async ({ page }) => {
  const switchboardChat = session({ id: SWITCHBOARD, agent: 'muse', model: 'muse-spark-1.3-contributor-max', title: 'Switchboard', context: { kind: 'switchboard', title: 'Switchboard' } })
  const state = makeState([switchboardChat, session()])
  state.switchboard = live([done])
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await expect(page.locator('.chat-session-item')).toHaveCount(1)
  await expect(page.locator('.chat-session-item')).toContainText('Fix the login bug')
  await page.getByRole('button', { name: /^Switchboard/ }).click()
  await pane(page).getByRole('button', { name: "Open the Switchboard's chat" }).click()
  await expect(page.locator('.chat-h-agent')).toHaveText('Muse')
  await expect(page.locator('.chat-session-item')).toHaveCount(1)
  // Poise runs it: it can be followed and its own questions answered, never messaged.
  await expect(page.locator('.chat-observer-note')).toHaveText('Poise runs this chat for the Switchboard pane. It takes no messages; answer here only what it asks you.')
  await expect(page.locator('.chat-dock')).toBeHidden()
  await page.locator('.chat-session-item').click()
  await expect(page.locator('.chat-dock')).toBeVisible()
})

test('says where each answer is: queued, delivered, or held for a stopped chat', async ({ page }) => {
  const at = new Date(Date.now() - 60_000).toISOString()
  const answered = (id: number, title: string, relay: 'queued' | 'delivered' | 'held') => item({ id, kind: 'decision', text: `Question ${id}?`,
    source: { sessionId: `s${id}`, title, agent: 'claude', model: 'opus-5-max', exists: true },
    options: [{ id: 'o1', label: 'Yes', detail: null, recommended: false }], answer: { label: 'Yes', freeText: false, at, relay } })
  const state = makeState([session()])
  state.switchboard = live([answered(11, 'Queued chat', 'queued'), answered(12, 'Delivered chat', 'delivered'), answered(13, 'Held chat', 'held')])
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: /^Switchboard/ }).click()
  const status = (title: string) => pane(page).locator('.sb-answered', { hasText: title })
  await expect(status('Queued chat')).toContainText('Queued for Queued chat; it is delivered when the chat is free')
  await expect(status('Delivered chat')).toContainText('Delivered to Delivered chat')
  await expect(status('Held chat')).toContainText('Held: Held chat is stopped; open it to resume it')
  await expect(status('Held chat')).toHaveClass(/is-held/)
})

test('turns off only on a second click, and keeps what it reported', async ({ page }) => {
  const state = makeState([session()])
  state.switchboard = live([blocked, done])
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: /^Switchboard/ }).click()
  await pane(page).getByRole('button', { name: 'Turn the Switchboard off' }).click()
  const confirm = pane(page).getByRole('button', { name: 'Confirm turning the Switchboard off' })
  await expect(confirm).toHaveText('Sure?')
  expect(state.calls.filter(call => call.path.endsWith('/off'))).toHaveLength(0)
  await confirm.click()
  await expect(pane(page).getByRole('button', { name: 'Start the Switchboard' })).toBeVisible()
  expect(state.calls.filter(call => call.path.endsWith('/off'))).toEqual([{ method: 'POST', path: '/api/chat/switchboard/off', body: null }])
  await expect(pane(page).locator('.sb-disclosure')).toContainText('It runs the Muse model muse-spark-1.3-contributor-max')
  expect(state.switchboard.items).toHaveLength(2)
})

test('says it stopped even while hidden, and restarts on request', async ({ page }) => {
  const state = makeState([session()])
  state.switchboard = live([done], { status: 'stopped', error: 'The Switchboard did not finish its last 3 checks (it finished without switchboard.checked).' })
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Switchboard, stopped' })
  await expect(toggle.locator('.chat-switchboard-badge')).toHaveText('!')
  await toggle.click()
  await expect(pane(page).getByRole('alert')).toContainText('did not finish its last 3 checks')
  await expect(pane(page).getByRole('button', { name: 'Check every chat now' })).toBeDisabled()
  await pane(page).getByRole('button', { name: 'Restart the Switchboard' }).click()
  await expect(pane(page).locator('.sb-live')).toHaveText('Live')
  await expect(pane(page).getByRole('alert')).toHaveCount(0)
  expect(state.calls.filter(call => call.path.endsWith('/restart'))).toHaveLength(1)
})

test('starts the Switchboard, and says why when it cannot', async ({ page }, info) => {
  const state = makeState([session()])
  let attempt = 0
  state.switchboardStart = () => {
    attempt++
    if (attempt === 1) return { status: 409, json: { error: 'The Switchboard could not start: Muse is unavailable: not signed in' } }
    state.switchboard = live([blocked, done])
    return { status: 200, json: state.switchboard }
  }
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: /^Switchboard/ }).click()
  const start = pane(page).getByRole('button', { name: 'Start the Switchboard' })
  await start.click()
  await expect(pane(page).getByRole('alert')).toContainText('Muse is unavailable: not signed in')
  await start.click()
  await expect(pane(page).locator('.sb-line')).toHaveCount(2)
  await expect(pane(page).locator('.sb-live')).toContainText('Live')
  await page.screenshot({ path: info.outputPath('switchboard-light.png'), animations: 'disabled' })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await expect(pane(page)).toHaveCSS('background-color', 'rgb(28, 33, 41)')
  await page.screenshot({ path: info.outputPath('switchboard-dark.png'), animations: 'disabled' })
})
