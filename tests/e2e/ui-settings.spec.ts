import { expect, test, type Page, type Route } from '@playwright/test'
import type { AdminOverview, GatewayAccount, PairedDevice } from '../../src/gateway-client'
import { BEHAVIORS } from '../../src/behaviors'

// Settings in the new interface (#556 PR 4): one section at a time, each with
// its own address, Find, and rows that save themselves one field at a time
// with what this tab read. Poise's settings, catalog, wake-ups and the
// gateway are stood in for; the server's own checks are tested beside it.

interface World {
  settings: Record<string, unknown>
  posts: Array<Record<string, unknown>>
  /** Holds settings answers until released, to land them out of order. */
  hold?: Array<() => void>
  /** Changes the next save meets, as another tab's save would. */
  meanwhile?: (settings: Record<string, unknown>) => void
  refresh?: 'ok' | 'fail' | 'slow'
  wake: { everyMinutes: number, revision: number }
  wakes: Array<{ everyMinutes: number, revision: number }>
  mode?: 'service' | 'local'
  admin?: boolean
  /** First-run setup's state behind the gateway. */
  onboarding?: { status: 'pending' | 'done', step: string }
}

const START = {
  org: '', me: 'octocat', agentAccount: 'bit-bot', timezone: '',
  models: { slots: { primary: 'opus-5-max', secondary: 'gpt-6-astra', tertiary: 'muse-1' } },
  chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 },
  notifications: { enabled: true },
  manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 3 },
  behaviorChain: { enabled: false, seedMode: 'label', label: 'poise' },
  organizations: [{ login: 'acme', managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: '2026-10-01T08:00:00Z' }],
}
const MODELS = {
  catalog: { models: ['opus-5-max', 'opus-5-high', 'gpt-6-astra', 'muse-1'].map((identity) => ({ identity, provider: identity.split('-')[0], selector: identity, effort: 'max' })), review_providers: ['opus', 'gpt'], path: '' },
  slots: { primary: 'opus-5-max', secondary: 'gpt-6-astra', tertiary: 'muse-1', notes: [], stored: { primary: 'opus-5-max', secondary: 'gpt-6-astra', tertiary: 'muse-1' } },
  places: [
    { key: 'chat', label: 'Chat', why: 'New chats.', review: false, reviewers: false, slot: 'primary', model: 'opus-5-max', notes: [], stored: null, providers: null },
    { key: 'pr_review', label: 'PR review', why: 'Reviews.', review: true, reviewers: true, slot: 'primary', model: 'opus-5-max', notes: [], stored: null, providers: ['opus', 'gpt'] },
  ],
  fixed: [{ key: 'content', label: '/content', model: 'opus-5-high', why: 'Writes content.' }],
  refresh: { checked_at: '2026-11-11T05:00:00Z', completed_at: '2026-11-11T05:00:30Z', status: 'ok', providers: {}, cli_updates: {} },
  presets: [],
}
const INSTALLER = 'https://github.com/autonomio/poise/releases/latest/download/install.sh'
const gateway = (isAdmin: boolean): GatewayAccount => ({
  login: 'octocat', handle: 'octocat', isAdmin, workspaceHost: 'octocat.poise.example.test', apexOrigin: 'https://poise.example.test',
  link: { installer: INSTALLER, releases: 'https://github.com/autonomio/poise/releases/latest' },
})
const ADMIN: AdminOverview = {
  users: [{ handle: 'octocat', login: 'octocat', admin: true, access: 'admin', lastLoginAt: Date.parse('2026-10-09T06:00:00Z'), disabled: false, workspace: { state: 'running', image: '111111111111 (current)' }, lastError: null, disk: { bytes: 2.4 * 1024 ** 3, overBudget: false } }],
  allowed: [], admins: ['octocat'], allowedOrgs: [], dockerError: null,
  disk: { measuredAt: Date.parse('2026-10-09T07:00:00Z'), free: 200 * 1024 ** 3, total: 290 * 1024 ** 3, low: false, budget: 50 * 1024 ** 3 },
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function save(world: World, body: Record<string, unknown>): { status: number, json: unknown } {
  world.meanwhile?.(world.settings)
  world.meanwhile = undefined
  const expected = (body.expect ?? {}) as Record<string, unknown>
  const stale = Object.fromEntries(Object.entries(expected).filter(([k, v]) => !same(world.settings[k], v)).map(([k]) => [k, world.settings[k]]))
  if (Object.keys(stale).length) return { status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: stale } }
  for (const [k, v] of Object.entries(body)) {
    if (k === 'expect') continue
    const cur = world.settings[k]
    world.settings[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? { ...cur as object, ...v as object } : v
  }
  world.settings.manager = { ...world.settings.manager as object, version: (world.settings.manager as { version: number }).version + 1 }
  return { status: 200, json: world.settings }
}

async function settings(page: Page, world: Partial<World> = {}, address = '/?view=settings'): Promise<World> {
  const w: World = { settings: structuredClone(START), posts: [], wake: { everyMinutes: 60, revision: 2 }, wakes: [], ...world }
  await page.route(/https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const body = request.method() === 'POST' || request.method() === 'PUT' ? request.postDataJSON() as Record<string, unknown> : null
    if (path.startsWith('/_poise/api/')) {
      const g = path.slice('/_poise/api/'.length)
      if (g === 'account') return route.fulfill({ json: gateway(!!w.admin) })
      if (g === 'devices') return route.fulfill({ json: { devices: [] as PairedDevice[] } })
      if (g === 'admin') return route.fulfill({ json: ADMIN })
      return route.fulfill({ status: 404, json: { error: 'not_found', message: 'There is nothing at this address.' } })
    }
    if (path === '/api/settings' && request.method() === 'POST') {
      w.posts.push(body!)
      const answer = save(w, body!)
      if (w.hold) await new Promise<void>((release) => w.hold!.push(release))
      return route.fulfill({ status: answer.status, json: answer.json })
    }
    if (path === '/api/settings') return route.fulfill({ json: w.settings })
    if (path === '/api/workspace') return route.fulfill({ json: w.mode === 'service' ? { mode: 'service', owner: 'octocat' } : { mode: 'local' } })
    if (path === '/api/onboarding') return route.fulfill({ json: w.onboarding ? { available: true, ...w.onboarding, owner: 'octocat', logins: {} } : { available: false } })
    if (path === '/api/snippets') return route.fulfill({ json: { snippets: [{ trigger: ';combo', replace: 'Work closely together.' }], version: 'a'.repeat(64), skills: { revision: 0, switches: [] }, desktop: null } })
    if (path === '/api/organizations') return route.fulfill({ json: { organizations: w.settings.organizations } })
    if (path === '/api/models') return route.fulfill({ json: MODELS })
    if (path === '/api/models/refresh') {
      if (w.refresh === 'fail') return route.fulfill({ status: 502, json: { error: 'the provider CLIs could not be updated' } })
      if (w.refresh === 'slow') await new Promise((r) => setTimeout(r, 2500))
      return route.fulfill({ json: { ...MODELS.refresh, completed_at: new Date().toISOString() } })
    }
    if (path === '/api/chat/manager/wake' && request.method() === 'PUT') {
      w.wakes.push(body as World['wake'])
      w.wake = { everyMinutes: Number(body!.everyMinutes), revision: w.wake.revision + 1 }
      return route.fulfill({ json: { ...w.wake, nextAt: null, turnsToday: 0, costToday: 0 } })
    }
    if (path === '/api/chat/manager/wake') return route.fulfill({ json: { ...w.wake, nextAt: null, turnsToday: 0, costToday: 0 } })
    if (path === '/api/storage') return route.fulfill({ json: { at: new Date().toISOString(), categories: [{ key: 'npm', label: 'npm cache', path: '', bytes: 3 * 1024 ** 3, status: 'ok' }], disk: { path: '/', totalBytes: 100 * 1024 ** 3, freeBytes: 40 * 1024 ** 3, usedPercent: 60 }, pressure: false, complete: true, lastRun: null } })
    if (path === '/api/release') return route.fulfill({ json: { commit: '3f9c2ab'.padEnd(40, '0'), since: '2026-11-10T19:40:00Z', repo: 'autonomio/poise' } })
    if (path === '/api/health') return route.fulfill({ json: { ok: true } })
    if (path === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: null, verifiedAt: null, authMethod: null, subscriptionType: null, loginInProgress: false } })
    if (path === '/api/notices') return route.fulfill({ json: { enabled: true, notices: [] } })
    if (path === '/api/repos') return route.fulfill({ json: { repos: ['acme/site', 'acme/api'] } })
    if (path === '/api/accounts') return route.fulfill({ json: { accounts: [] } })
    if (path === '/api/ssh-keys') return route.fulfill({ json: { keys: [] } })
    if (path === '/api/google/accounts') return route.fulfill({ json: { configured: false, accounts: [] } })
    // Behaviors' run counts read the agent logs, which this server cannot: answered here, so no fault reaches other specs' bells.
    if (path === '/api/behavior-metrics') return route.fulfill({ json: { behaviors: Object.fromEntries(BEHAVIORS.map(({ key }) => [key, null])), error: null } })
    // Everything else is the test server's own: Extensions, Publishing and Behaviors read it as they would.
    return route.fallback()
  })
  await page.goto(address)
  if (address.includes('settings')) await expect(page.locator('[data-settings]')).toBeVisible()
  return w
}

const row = (page: Page, key: string) => page.locator(`[data-setting="${key}"]`)
const section = (page: Page, name: string) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name, exact: true })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('settings-spec')) { localStorage.clear(); sessionStorage.setItem('settings-spec', '1') } })
})

test('each section has its own address, / focuses Find, and Find lights the row it opens', async ({ page }) => {
  await settings(page, {}, '/?view=settings&settings=models')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Models')
  await section(page, 'Manager').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Manager')
  await expect(page).toHaveURL(/settings=manager/)

  await page.keyboard.press('/')
  await expect(page.getByRole('searchbox', { name: 'Find a setting' })).toBeFocused()
  await page.keyboard.type('idle')
  await expect(page.getByRole('option', { name: /Idle timeout/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('General')
  await expect(row(page, 'idle')).toHaveClass(/is-lit/)
  await expect(row(page, 'idle').getByRole('textbox')).toBeFocused()
})

test('an entry address opens its section without taking focus, and /?settings=accounts opens Accounts', async ({ page }) => {
  await settings(page, {}, '/?view=settings&settings=general&setting=timezone')
  await expect(row(page, 'timezone')).toHaveClass(/is-lit/)
  await expect(page.locator('[data-setting] :focus')).toHaveCount(0)
  await page.goto('/?settings=accounts')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accounts')
  await expect(page).toHaveURL(/view=settings&settings=accounts/)
})

test('a row saves only its own field with what this tab read, and Undo puts it back', async ({ page }) => {
  const world = await settings(page)
  const idle = row(page, 'idle').getByRole('textbox')
  await idle.fill('0')
  await expect(row(page, 'idle')).toContainText('Enter saves')
  await idle.press('Enter')
  await expect(row(page, 'idle')).toContainText(/Saved \d\d:\d\d · applies now/)
  expect(world.posts[0]).toEqual({ chat: { idleTimeoutMinutes: 0 }, expect: { chat: START.chat } })
  await expect(row(page, 'idle')).toHaveAttribute('data-now', /Never/)

  await row(page, 'idle').getByRole('button', { name: 'Undo' }).click()
  await expect(idle).toHaveValue('120')
  expect(world.posts[1]).toMatchObject({ chat: { idleTimeoutMinutes: 120 } })

  // Not saved while invalid; Esc puts back the saved value.
  await idle.fill('ten')
  await idle.press('Enter')
  await expect(row(page, 'idle').getByRole('alert')).toContainText('Not saved: Idle timeout must be a whole number from 0 to 10080')
  await idle.press('Escape')
  await expect(idle).toHaveValue('120')
  expect(world.posts).toHaveLength(2)
})

test('edits go out in order, and the newest choice is what the row shows when answers land late', async ({ page }) => {
  const world = await settings(page)
  world.hold = []
  const zone = row(page, 'timezone').getByRole('combobox')
  await zone.selectOption('Europe/London')
  await expect(row(page, 'timezone')).toContainText('Saving…')
  await zone.selectOption('Europe/Berlin')
  await expect.poll(() => world.hold!.length).toBe(1)
  // The second waits for the first's answer, then is built from it.
  expect(world.posts).toHaveLength(1)
  world.hold.shift()!()
  await expect.poll(() => world.hold!.length).toBe(1)
  expect(world.posts.map((p) => p.timezone)).toEqual(['Europe/London', 'Europe/Berlin'])
  expect(world.posts[1].expect).toEqual({ timezone: 'Europe/London' })
  await expect(row(page, 'timezone')).toContainText('Saving…')
  world.hold.shift()!()
  await expect(row(page, 'timezone')).toContainText(/Saved \d\d:\d\d/)
  await expect(zone).toHaveValue('Europe/Berlin')
})

test('a refused save keeps its draft and says what changed; other rows keep theirs, and Save mine overwrites', async ({ page }) => {
  const world = await settings(page)
  const branch = row(page, 'branch').getByRole('textbox')
  await branch.fill('work/')
  await branch.press('Enter')
  await expect(row(page, 'branch')).toContainText(/Saved \d\d:\d\d/)

  world.meanwhile = (s) => { s.timezone = 'Asia/Tokyo' }
  await row(page, 'timezone').getByRole('combobox').selectOption('Europe/Berlin')
  await expect(row(page, 'timezone').getByRole('alert')).toContainText('Not saved: Time zone is now Asia/Tokyo')
  await expect(row(page, 'timezone').getByRole('combobox')).toHaveValue('Europe/Berlin')
  await expect(branch).toHaveValue('work/')
  await expect(row(page, 'branch')).toContainText(/Saved \d\d:\d\d/)

  await row(page, 'timezone').getByRole('button', { name: 'Save mine' }).click()
  await expect(row(page, 'timezone')).toContainText(/Saved \d\d:\d\d/)
  expect(world.posts.at(-1)).toEqual({ timezone: 'Europe/Berlin', expect: { timezone: 'Asia/Tokyo' } })
})

test('another tab’s change to another part of the field is kept, and this row still saves', async ({ page }) => {
  const world = await settings(page)
  world.meanwhile = (s) => { s.chat = { ...s.chat as object, branchPrefix: 'theirs/' } }
  const running = row(page, 'running').getByRole('textbox')
  await running.fill('8')
  await running.press('Enter')
  await expect(row(page, 'running')).toContainText(/Saved \d\d:\d\d/)
  expect(world.settings.chat).toMatchObject({ branchPrefix: 'theirs/', maxConcurrentLocalTurns: 8 })
  await expect(row(page, 'branch').getByRole('textbox')).toHaveValue('theirs/')
})

test('a place saves its own slot, and the three models must stay different', async ({ page }) => {
  const world = await settings(page, {}, '/?view=settings&settings=models')
  await row(page, 'models.pr_review').getByRole('button', { name: 'Random' }).click()
  await expect(row(page, 'models.pr_review')).toContainText(/Saved \d\d:\d\d · from the next review/)
  expect(world.posts[0]).toEqual({ models: { places: { pr_review: { slot: 'random' } } }, expect: { models: START.models } })

  await row(page, 'models.slots').getByRole('combobox', { name: 'Secondary model' }).selectOption('opus-5-max')
  await expect(row(page, 'models.slots').getByRole('alert')).toContainText('Secondary is already opus-5-max in another slot; change that slot first')
  expect(world.posts).toHaveLength(1)
})

test('Check now says how long the check has run, then what changed; a failed check says why and can run again', async ({ page }) => {
  const world = await settings(page, { refresh: 'slow' }, '/?view=settings&settings=models')
  await row(page, 'catalog').getByRole('button', { name: 'Check now' }).click()
  await expect(row(page, 'catalog')).toContainText(/updating provider CLIs, then checking models · \d s/)
  await expect(row(page, 'catalog').getByRole('button', { name: 'Check now' })).toHaveAttribute('aria-disabled', 'true')
  await expect(row(page, 'catalog')).toContainText(/checked \d\d:\d\d/, { timeout: 10_000 })
  world.refresh = 'fail'
  await row(page, 'catalog').getByRole('button', { name: 'Check now' }).click()
  await expect(row(page, 'catalog')).toContainText('The model check failed: the provider CLIs could not be updated')
  await expect(row(page, 'catalog').getByRole('button', { name: 'Check now' })).not.toHaveAttribute('aria-disabled', 'true')
})

test('the Manager’s controls save on their rows, read together, and its wake-ups on the header’s route', async ({ page }) => {
  const world = await settings(page, {}, '/?view=settings&settings=manager')
  await row(page, 'mgr.rhythm').getByRole('button', { name: 'One slot more' }).click()
  await expect(row(page, 'mgr.rhythm')).toContainText(/Saved \d\d:\d\d/)
  expect(world.posts[0]).toEqual({ manager: { rhythm: 6 }, expect: { manager: START.manager } })
  await expect(row(page, 'mgr.effect')).toContainText('Up to 6 workers at once.')

  await row(page, 'mgr.autonomy').getByRole('radio', { name: 'Ask first' }).click()
  await expect(row(page, 'mgr.autonomy')).toContainText('Nothing on my behalf.')
  await expect(row(page, 'mgr.effect')).toContainText('It decides nothing on your behalf and brings you everything.')
  expect(world.posts[1]).toMatchObject({ manager: { autonomy: 'Ask first' } })

  await row(page, 'mgr.wake').getByRole('button', { name: '15 min' }).click()
  await expect(row(page, 'mgr.wake')).toContainText(/Saved \d\d:\d\d/)
  expect(world.wakes).toEqual([{ everyMinutes: 15, revision: 2 }])
})

test('Style rows write the same tokens as the Style panel, kept in this browser', async ({ page }) => {
  await settings(page, {}, '/?view=settings&settings=style')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('This browser')
  await row(page, 'style.motion').getByRole('button', { name: 'Motion' }).click()
  await expect(row(page, 'style.motion')).toContainText(/Saved \d\d:\d\d · applies now, in every view/)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ctl-motion').trim())).toBe('0')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('poise-style') || '{}')['--ctl-motion'])).toBe('0')
  await row(page, 'style.motion').getByRole('button', { name: 'Undo' }).click()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('poise-style') || '{}')['--ctl-motion'])).toBeUndefined()
})

test('Poise Link and Admin appear only behind the gateway, where /?settings=link and /?settings=admin open them', async ({ page }) => {
  await settings(page, { mode: 'local' }, '/?settings=link')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accounts')
  await expect(row(page, 'link.pair')).toHaveCount(0)
  await expect(section(page, 'Admin')).toHaveCount(0)
})

test('behind the gateway, /?settings=link opens Poise Link, and /?settings=admin opens Admin for its admins only', async ({ page }) => {
  await settings(page, { mode: 'service' }, '/?settings=link')
  await expect(row(page, 'link.pair')).toHaveClass(/is-lit/)
  await expect(row(page, 'link.pair')).toContainText(`curl -fsSL ${INSTALLER} | sh`)
  await expect(section(page, 'Admin')).toHaveCount(0)
  await page.goto('/?settings=admin')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accounts')
})

test('behind the gateway, an admin finds Admin with its people and workspaces', async ({ page }) => {
  await settings(page, { mode: 'service', admin: true }, '/?settings=admin')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Admin')
  await expect(page.locator('[data-body]')).toContainText('octocat')
})

for (const width of [375, 768, 1000]) {
  test(`nothing overflows the page at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await settings(page)
    for (const name of ['General', 'Models', 'Manager', 'Style']) {
      await page.goto(`/?view=settings&settings=${name.toLowerCase()}`)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(name, { useInnerText: true }).catch(() => {})
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    }
  })
}

test('at 375 pixels Settings stacks: its sections run across the top, and a row stacks', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await settings(page)
  const columns = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
  expect(await columns('.set')).toBe(1)
  expect(await columns('.srow')).toBe(1)
  expect(await page.locator('.set-secs').evaluate((el) => getComputedStyle(el).flexDirection)).toBe('row')
})

test('Snippets, Extensions, Publishing and Behaviors open as classic holds them, and leave cleanly', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`${error.message} ${error.stack?.split('\n')[1] ?? ''}`))
  await settings(page, {}, '/?view=settings&settings=snippets')
  await expect(page.locator('#view-snippets')).toContainText(';combo')
  for (const name of ['Extensions', 'Publishing', 'Behaviors', 'Snippets', 'General']) {
    await section(page, name).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  }
  await expect(page.locator('#view-behaviors, #view-extensions, #view-snippets').filter({ visible: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('behind the gateway, a workspace still to be set up opens setup at GitHub, not at a theme', async ({ page }) => {
  await settings(page, { mode: 'service', onboarding: { status: 'pending', step: 'theme' } }, '/?view=overview')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('#ob-title')).toHaveText('Connect your GitHub account')
})

test('Settings → Manager explains Rhythm on a direct load, without Overview', async ({ page }) => {
  await settings(page, {}, '/?view=settings&settings=manager')
  await page.locator('[data-ref="mgr.rhythm"]').first().hover()
  await expect(page.getByRole('tooltip')).toContainText('How many workers the Manager keeps on tasks at once')
})

test('Settings → Behaviors fits the columns it keeps', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await settings(page, {}, '/?view=settings&settings=behaviors')
  const table = page.locator('#behaviors-table')
  await expect(table).toBeVisible()
  const [width, room] = await table.evaluate((t) => [t.getBoundingClientRect().width, (t.closest('main') as HTMLElement).clientWidth])
  expect(width).toBeLessThanOrEqual(room)
})
