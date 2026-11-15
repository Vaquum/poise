import { expect, test, type Page, type Route } from '@playwright/test'

// The frame of the new interface (#556 PR 1): the top bar, addresses, the
// Settings menu, the Style panel, the reference, the bell and the page's states.

interface Workspace { notices?: unknown[], claude?: string, updating?: boolean }

async function open(page: Page, address = '/', workspace: Workspace = {}): Promise<void> {
  await page.route(/https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await page.route('**/api/claude-auth', (route) => route.fulfill({ json: {
    status: workspace.claude ?? 'authenticated', reason: null, checkedAt: null, verifiedAt: null, authMethod: null, subscriptionType: null, loginInProgress: false,
  } }))
  await page.route('**/api/notices', (route) => workspace.updating
    ? route.fulfill({ status: 503, headers: { 'x-poise-updating': '1' }, json: { error: 'updating' } })
    : route.fulfill({ json: { enabled: true, notices: workspace.notices ?? [] } }))
  await page.goto(address)
  await expect(page.locator('.topbar')).toBeVisible()
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Poise' })
const query = (page: Page) => new URL(page.url()).searchParams

test('the retired classic page is no longer served', async ({ request }) => {
  expect((await request.get('/classic.html')).status()).toBe(404)
})

test('the frame opens Overview, and each move between places is a history entry under the same top bar', async ({ page }) => {
  await open(page)
  await expect(page).toHaveTitle('Poise — Overview')
  await expect(nav(page).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  expect(query(page).get('view')).toBe('overview')
  await page.locator('.topbar').evaluate((bar) => { (window as unknown as { bar: Element }).bar = bar })

  await nav(page).getByRole('link', { name: 'Board' }).click()
  await expect(nav(page).getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page')
  expect(query(page).get('view')).toBe('board')
  await page.goBack()
  await expect(nav(page).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  expect(await page.locator('.topbar').evaluate((bar) => bar === (window as unknown as { bar: Element }).bar)).toBe(true)
})

test('the addresses the service and notices send open their places', async ({ page }) => {
  await open(page, '/?view=logging&chain=c1&after=2')
  await expect(nav(page).getByRole('link', { name: 'Observe' })).toHaveAttribute('aria-current', 'page')
  expect(Object.fromEntries(query(page))).toEqual({ view: 'observe', chain: 'c1', after: '2', part: 'tasks' })

  await page.goto('/?view=logging&event=evt_1&from=2026-11-10T00:00:00Z&to=2026-11-11T00:00:00Z')
  expect(Object.fromEntries(query(page))).toEqual({ view: 'observe', event: 'evt_1', from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', part: 'logging' })

  await page.goto('/?settings=accounts')
  await expect(nav(page).getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  expect(Object.fromEntries(query(page))).toEqual({ view: 'settings', settings: 'accounts' })
})

test('the route back leads only to a place, and returns to it', async ({ page }) => {
  await open(page, '/?view=board')
  await page.goto('/?view=settings&settings=style&back=board')
  await page.getByRole('link', { name: 'Back to Board' }).click()
  await expect(nav(page).getByRole('link', { name: 'Board' })).toHaveAttribute('aria-current', 'page')

  await page.goto('/?view=settings&back=https://example.com')
  await expect(page.getByRole('link', { name: /Back to/ })).toBeHidden()
  expect(query(page).has('back')).toBe(false)
})

test('the Settings menu opens each section with a route back, and the Style panel keeps its choices', async ({ page }) => {
  await open(page, '/?view=board')
  const settings = nav(page).getByRole('button', { name: 'Settings' })
  await settings.click()
  const menu = page.getByRole('menu', { name: 'Settings' })
  await expect(menu).toBeVisible()
  expect(new URL(await menu.getByRole('menuitem', { name: 'Accounts' }).getAttribute('href') ?? '', page.url()).search).toBe('?view=settings&settings=accounts&back=board')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(settings).toBeFocused()

  await settings.click()
  await menu.getByRole('menuitem', { name: 'Style panel' }).click()
  const panel = page.getByRole('complementary', { name: 'Style' })
  await expect(panel).toHaveClass(/open/)
  await panel.getByRole('button', { name: /Compact/ }).click()
  const density = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ctl-density').trim())
  expect(await density()).toBe('0.8')
  await page.reload()
  await expect(page.locator('.topbar')).toBeVisible()
  expect(await density()).toBe('0.8')
})

test('the Style panel’s Reset to Poise asks “Sure?” first, and Undo puts your style back', async ({ page }) => {
  await open(page)
  await nav(page).getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menu', { name: 'Settings' }).getByRole('menuitem', { name: 'Style panel' }).click()
  const panel = page.getByRole('complementary', { name: 'Style' })
  const density = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ctl-density').trim())
  const poise = await density()
  await panel.getByRole('button', { name: /Compact/ }).click()
  await panel.getByRole('button', { name: 'Reset to Poise' }).click()
  expect(await density()).toBe('0.8')
  await panel.getByRole('button', { name: 'Sure?' }).click()
  expect(await density()).toBe(poise)
  await panel.getByRole('button', { name: 'Undo' }).click()
  expect(await density()).toBe('0.8')
  await expect(panel.getByRole('button', { name: 'Reset to Poise' })).toBeVisible()
})

test('the reference names what the pointer rests on, and explains it in full on ?', async ({ page }) => {
  await open(page)
  const board = nav(page).getByRole('link', { name: 'Board' })
  await board.hover()
  await expect(page.getByRole('tooltip')).toContainText('Ideas, plans, issues and pull requests on one line.')
  await page.keyboard.press('?')
  const card = page.getByRole('dialog', { name: 'Board' })
  await expect(card).toBeVisible()
  await expect(card).toContainText('What is this?')
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  // Opening and closing the reference never moved anywhere.
  expect(query(page).get('view')).toBe('overview')
})

test('a tooltip waits for the pointer to rest half a second; leaving or pressing cancels it', async ({ page }) => {
  await open(page)
  // Paused: only runFor moves time, however slow the host is.
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 1000)
  const heading = page.getByRole('heading', { name: 'Overview', exact: true })
  const tip = page.getByRole('tooltip')
  // Resting: nothing for the first moments, then the tooltip.
  await heading.hover()
  await page.clock.runFor(499)
  await expect(tip).toHaveCount(0)
  await page.clock.runFor(1)
  await expect(tip).toContainText('Overview')
  // Pressing hides it, and the pressed element stays quiet while the pointer rests on it.
  await page.mouse.down()
  await expect(tip).toHaveCount(0)
  await page.clock.runFor(1500)
  await expect(tip).toHaveCount(0)
  await page.mouse.up()
  // Leaving before the half second cancels a pending one; coming back starts again.
  const head = (await page.locator('.ova-head').boundingBox())!
  const away = () => page.mouse.move(head.x + head.width / 2, head.y + head.height / 2)
  await away()
  await heading.hover()
  await page.clock.runFor(300)
  await away()
  await page.clock.runFor(1000)
  await expect(tip).toHaveCount(0)
  await heading.hover()
  await page.clock.runFor(600)
  await expect(tip).toContainText('Overview')
})

test('a press keeps its element quiet only until the keyboard moves: Tab away and back explains it again', async ({ page }) => {
  // Real time: a click waits for the element to settle, which a paused clock never lets happen.
  await open(page)
  const tip = page.getByRole('tooltip')
  await page.getByRole('radio', { name: 'Everything' }).click()
  await page.waitForTimeout(1200)
  await expect(tip).toHaveCount(0)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('radio', { name: 'Everything' })).toBeFocused()
  await expect(tip).toContainText('Show')
})

test('the reference is modal and fits a phone; a cancelled long press leaves the next tap alone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 })
  await open(page)
  await nav(page).getByRole('link', { name: 'Board' }).focus()
  await page.keyboard.press('?')
  const card = page.getByRole('dialog', { name: 'Board' })
  await expect(card).toBeVisible()
  const box = (await card.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
  // The page behind cannot be reached: Tab goes round the card.
  await expect(page.locator('#ui')).toHaveJSProperty('inert', true)
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('.ref-card'))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  await expect(page.locator('#ui')).toHaveJSProperty('inert', false)

  // A long press shows the tip; cancelled, it leaves no click to swallow.
  await page.evaluate(async () => {
    const link = document.querySelector('nav[aria-label="Poise"] a[href*="view=board"]')!
    link.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }))
    await new Promise((r) => setTimeout(r, 900))
    link.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', bubbles: true }))
  })
  await nav(page).getByRole('link', { name: 'Chat' }).click()
  await expect(nav(page).getByRole('link', { name: 'Chat' })).toHaveAttribute('aria-current', 'page')
})

test('Motion off reaches the motion runtime; Copy as CSS says whether it copied; another tab’s typeface brings its fonts', async ({ page, context }) => {
  await open(page)
  const reduced = () => page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  expect(await reduced()).toBe(false)
  await nav(page).getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menu', { name: 'Settings' }).getByRole('menuitem', { name: 'Style panel' }).click()
  const panel = page.getByRole('complementary', { name: 'Style' })
  await panel.getByRole('button', { name: 'Motion' }).click()
  expect(await reduced()).toBe(true)

  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }) })
  await panel.getByRole('button', { name: 'Copy as CSS' }).click()
  await expect(panel.getByRole('button', { name: 'Not copied: the browser refused' })).toBeVisible()
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } }) })
  await expect(panel.getByRole('button', { name: 'Copy as CSS' })).toBeVisible()
  await panel.getByRole('button', { name: 'Copy as CSS' }).click()
  await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible()

  const other = await context.newPage()
  await other.goto('/?view=overview')
  await expect(other.locator('.topbar')).toBeVisible()
  await page.evaluate(() => { localStorage.setItem('poise-style', JSON.stringify({ '--archetype': '"minimalist"', '--ctl-font-ui': '"Manrope"', '--ctl-font-display': '"Space Grotesk"', '--ctl-font-mono': '"JetBrains Mono"' })) })
  await expect.poll(() => other.evaluate(() => document.getElementById('style-fonts')?.getAttribute('href') ?? '')).toContain('family=Manrope')
})

test('the bell counts what needs you and opens Answer here with a route back', async ({ page }) => {
  const at = new Date().toISOString()
  const notice = (id: string, kind: string) => ({ id, kind, title: id, body: '', since: at, due: at, silenceable: false, target: null })
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ json: { logs: [] } }))
  await page.route('**/api/behaviors', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/behavior-chains**', (route) => route.fulfill({ json: { chains: [], attention: [] } }))
  await page.route('**/api/chat/requests', (route) => route.fulfill({ json: { revision: 1, complete: true, requests: [] } }))
  await page.route('**/api/chat/switchboard', (route) => route.fulfill({ json: { revision: 1, items: [] } }))
  await page.route('**/api/editor/reviews', (route) => route.fulfill({ json: { publications: [{ slug: 'notes', openThreads: 1 }] } }))
  await open(page, '/?view=board', { notices: [notice('Formal GitHub review', 'review_requested'), notice('Reconnect Google', 'sign_in_needed'), notice('Ready to merge', 'pr_ready')] })
  const bell = page.getByRole('button', { name: /^Notifications/ })
  await expect(bell.locator('[data-bell]')).toHaveText('2')
  await expect(bell).toHaveAccessibleName('Notifications, 2 open. Opens Answer here in Overview.')
  await bell.click()
  await expect(nav(page).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  expect(Object.fromEntries(query(page))).toEqual({ view: 'overview', back: 'board' })
  expect(new URL(page.url()).hash).toBe('#answer')
})

test('Overview shares attention reads with the bell, and only Overview fetches publication threads', async ({ page }) => {
  const reads: string[] = []
  const read = (name: string, json: unknown) => (route: Route) => { reads.push(name); return route.fulfill({ json }) }
  const count = (name: string) => reads.filter((each) => each === name).length
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ json: { logs: [] } }))
  await page.route('**/api/behaviors', read('behaviors', {}))
  await page.route('**/api/behavior-chains**', read('chains', { chains: [], attention: [] }))
  await page.route('**/api/chat/requests', read('requests', { revision: 1, complete: true, requests: [] }))
  await page.route('**/api/chat/switchboard', read('switchboard', { revision: 1, items: [] }))
  await page.route('**/api/editor/reviews', read('reviews', { publications: [{ slug: 'notes', openThreads: 1 }] }))
  await page.route('**/api/editor/doc/notes/reviews', read('threads', { reviews: [] }))
  await open(page, '/?view=overview')
  // Overview has read its sources once it reads the threads it found open.
  await expect.poll(() => count('threads')).toBe(1)
  await expect.poll(() => [count('behaviors'), count('chains')]).toEqual([1, 1])
  expect(count('reviews')).toBe(1)

  await nav(page).getByRole('link', { name: 'Board' }).click()
  await expect.poll(() => count('chains')).toBe(2)
  expect(count('reviews')).toBe(1)
  expect(count('threads')).toBe(1)
  await expect(page.getByRole('button', { name: /^Notifications/ }).locator('[data-bell]')).toHaveText('0')
})

test('leaving Overview before it has mounted, the bell reads Answer here’s sources at once', async ({ page }) => {
  let requests = 0
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ json: { logs: [] } }))
  await page.route('**/api/behaviors', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/behavior-chains**', (route) => route.fulfill({ json: { chains: [], attention: [] } }))
  await page.route('**/api/chat/requests', (route) => {
    requests++
    return route.fulfill({ json: { revision: 1, complete: true, requests: [{ id: 'p1', kind: 'permission', sessionId: 's1', sessionTitle: 'Chat', content: { title: 'Approve deploy', options: [{ id: 'yes', name: 'Allow once' }] }, createdAt: new Date().toISOString(), ownerAction: true }] } })
  })
  await page.route('**/api/chat/switchboard', (route) => route.fulfill({ json: { revision: 1, items: [] } }))
  // Overview waits on its settings, so it never mounts before the move.
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/settings', async (route) => { if (route.request().method() === 'GET') await held; return route.fallback() })
  await open(page, '/?view=overview')
  expect(requests).toBe(0)
  await nav(page).getByRole('link', { name: 'Board' }).click()
  await expect.poll(() => requests).toBe(1)
  await expect(page.getByRole('button', { name: /^Notifications/ }).locator('[data-bell]')).toHaveText('1')
  release()
})

test('the bell reads after the place it opens on, so the place’s own reads go first', async ({ page }) => {
  const at: Record<string, number> = {}
  const mark = (name: string) => { at[name] ??= Date.now() }
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ json: { logs: [] } }))
  await page.route('**/api/behaviors', (route) => { mark('bell'); return route.fulfill({ json: {} }) })
  await page.route('**/api/behavior-chains**', (route) => route.fulfill({ json: { chains: [], attention: [] } }))
  await page.route('**/api/chat/requests', (route) => route.fulfill({ json: { revision: 1, complete: true, requests: [] } }))
  await page.route('**/api/chat/switchboard', (route) => route.fulfill({ json: { revision: 1, items: [] } }))
  await page.route('**/api/current**', (route) => { mark('board'); return route.fallback() })
  await open(page, '/?view=board')
  await expect.poll(() => at.bell, { timeout: 10_000 }).toBeTruthy()
  // Away from Overview the bell says it opens Answer here there (#1433).
  await expect(page.getByRole('button', { name: /^Notifications/ })).toHaveAccessibleName(/Opens Answer here in Overview\.$/)
  expect(at.board).toBeTruthy()
  expect(at.bell - at.board).toBeGreaterThanOrEqual(2_000)
})

test('Claude’s subscription sits at the foot and the page makes room; updating dims the frame', async ({ page }) => {
  await open(page, '/', { claude: 'reauth_required' })
  const strip = page.locator('.foot #claude-auth-banner')
  await expect(strip).toContainText('Sign in with Claude')
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--foot-h')) || 0)).toBeGreaterThan(0)

  await open(page, '/', { updating: true })
  await expect(page.locator('.up-backdrop')).toContainText('Updating to the latest version')
  await expect(page.locator('.frame')).toHaveAttribute('inert', '')
})

test('a move takes the tooltip with it, and a place enters only the first time it opens', async ({ page }) => {
  await open(page, '/?view=board&back=overview')
  // What the pointer rests on in the next place may show its own tooltip; the back link's never follows.
  const backTip = () => page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].some((tip) => tip.textContent?.includes('Returns to where you were')))
  const back = page.getByRole('link', { name: 'Back to Overview' })
  await back.hover()
  await expect(page.getByRole('tooltip')).toContainText('Returns to where you were')
  await back.click()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  expect(await backTip()).toBe(false)

  await page.waitForFunction(() => !document.querySelector('[data-place-root][data-flow-enter]'))
  await nav(page).getByRole('link', { name: 'Board' }).click()
  await expect(page.locator('.lanes')).toBeVisible()
  expect(await page.locator('[data-place-root]').getAttribute('data-flow-enter')).toBeNull()
})

test('closing the reference returns focus to its element, or to the one a live update put in its place', async ({ page }) => {
  await open(page)
  const board = nav(page).getByRole('link', { name: 'Board' })
  await board.focus()
  await board.hover()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Board' })).toBeVisible()
  await page.evaluate(() => {
    const old = [...document.querySelectorAll<HTMLElement>('a')].find((a) => a.textContent?.trim() === 'Board' && a.closest('nav'))!
    const fresh = old.cloneNode(true) as HTMLElement
    fresh.dataset.fresh = '1'
    old.replaceWith(fresh)
  })
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-fresh="1"]')).toBeFocused()
})

test('a long toast wraps inside a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await open(page, '/?view=manager')
  const toast = page.locator('.toast')
  await expect(toast).toContainText('There is no Manager yet')
  await expect.poll(async () => { const b = await toast.boundingBox(); return !!b && b.x >= 0 && b.x + b.width <= 375 }).toBe(true)
})
