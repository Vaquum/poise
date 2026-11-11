import { expect, test, type Page } from './fixtures/ui'

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

test('the frame opens Overview, and each move between places is a history entry under the same top bar', async ({ page }) => {
  await open(page)
  await expect(page).toHaveTitle('Poise')
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

test('the bell counts what needs you and opens Answer here with a route back', async ({ page }) => {
  const at = new Date().toISOString()
  const notice = (id: string) => ({ id, kind: 'pr_ready', title: `acme/site#${id} is ready to merge`, body: 'Checks passed.', since: at, due: at, silenceable: true, target: null })
  await open(page, '/?view=board', { notices: [notice('1'), notice('2')] })
  const bell = page.getByRole('button', { name: /^Notifications/ })
  await expect(bell.locator('[data-bell]')).toHaveText('2')
  await expect(bell).toHaveAccessibleName('Notifications, 2 open. Opens Answer here in Overview.')
  await bell.click()
  await expect(nav(page).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  expect(Object.fromEntries(query(page))).toEqual({ view: 'overview', back: 'board' })
  expect(new URL(page.url()).hash).toBe('#answer')
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
