import { expect, test, type Page } from '@playwright/test'
import { CATALOG } from '../model-catalog-fixture'

// Settings saves carry only the active section's drafts, with the values the
// tab read: another section's drafts can neither block nor be committed by
// the save, and another tab's edit to the same field is refused with its
// current value instead of silently overwritten.

type ModelSettings = { slots?: Record<string, string>, places?: Record<string, { slot: string }> }
const CHAT = { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }

function modelsResponse(models: ModelSettings) {
  const slots = {
    primary: models.slots?.primary || 'opus-5-xhigh',
    secondary: models.slots?.secondary || 'gpt-6-astra-ultra',
    tertiary: models.slots?.tertiary || 'grok-4.6-xhigh',
    notes: [],
    stored: models.slots || null,
  }
  const places = [
    { key: 'chat', label: 'Chat', why: 'Card chats.', review: false, reviewers: false, seed: 'author_content' },
    { key: 'editor', label: 'Editor chat', why: 'Editor chats.', review: false, reviewers: false, seed: 'author_content' },
    { key: 'pr_review', label: 'PR review', why: 'Reviews.', review: true, reviewers: true, seed: 'pr_review' },
    { key: 'pr_approve', label: 'PR approval', why: 'Approvals.', review: true, reviewers: false, seed: 'pr_approve' },
  ].map((place) => {
    const slot = models.places?.[place.key]?.slot || 'primary'
    const model = slot === 'secondary' ? slots.secondary : slot === 'tertiary' ? slots.tertiary : slots.primary
    return { ...place, slot, model, notes: [], stored: models.places?.[place.key] || null }
  })
  const fixed = [{ key: 'content', label: '/content', model: (CATALOG.behaviors as Record<string, string>).author_content, why: 'Set by Caller.' }]
  return { catalog: CATALOG, slots, places, fixed, refresh: null }
}

// The stub merges like the server: each models half merges separately.
function mergeModels(prev: ModelSettings, next: ModelSettings): ModelSettings {
  return {
    ...(prev.slots || next.slots ? { slots: { ...prev.slots, ...next.slots } } : {}),
    ...(prev.places || next.places ? { places: { ...prev.places, ...next.places } } : {}),
  }
}

interface SettingsStub {
  settings: Record<string, unknown>
  posts: Array<Record<string, unknown>>
}

// The stub answers like the server: partial updates merge per field, and the
// `expect` comparison is not stored.
async function setupSettings(page: Page, initial: Record<string, unknown>): Promise<SettingsStub> {
  const state: SettingsStub = { settings: initial, posts: [] }
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      const { expect: _ignored, ...rest } = body
      const merged = { ...state.settings, ...rest }
      if (rest.chat && typeof rest.chat === 'object') merged.chat = { ...(state.settings.chat as object), ...(rest.chat as object) }
      if (rest.models && typeof rest.models === 'object') {
        merged.models = mergeModels((state.settings.models ?? {}) as ModelSettings, rest.models as ModelSettings)
      }
      state.settings = merged
    }
    await route.fulfill({ json: state.settings })
  })
  return state
}

async function setupModels(page: Page, state: SettingsStub): Promise<void> {
  await page.route('**/api/models', async (route) => {
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as ModelSettings) })
  })
}

async function openSection(page: Page, section: string): Promise<void> {
  // With the panel open the burger closes it instead of showing the menu;
  // Back to menu is the way between destinations.
  if (await page.locator('#settings-panel.open').count()) {
    await page.getByRole('button', { name: 'Back to menu' }).click()
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
  }
  await page.locator(`#menu-popover [data-settings="${section}"]`).click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('poise-view', 'main')
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
})

test('chain intake and individual holds use explicit settings and current journal sequences', async ({ page }) => {
  const defaults = { enabled: false, seedMode: 'label', label: 'poise' }
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: 'reviewer', timezone: 'UTC',
    chat: { ...CHAT }, models: {}, behaviorChain: defaults })
  await setupModels(page, state)
  const controls: unknown[] = []
  let held: string | null = null
  await page.route('**/api/behavior-chains', async (route) => {
    if (route.request().method() === 'POST') {
      controls.push(route.request().postDataJSON())
      held = 'New invocations held by the person'
      return route.fulfill({ json: {} })
    }
    return route.fulfill({ json: { cutover: { sequence: 0, mode: 'v1', requestedAt: null, legacyPulls: [], blockers: [] }, chains: [{ id: 'acme/repo#7', repository: 'acme/repo', issue: 7, sequence: held ? 12 : 11,
      held, waiting: 'exact-head CI is still running', mergeSha: null, pullNumber: 9, invocations: [] }], next: null, runtime: [] } })
  })
  await page.goto('/')
  await openSection(page, 'general')
  const chain = page.getByRole('region', { name: 'Behavior chain settings' })
  await expect(chain.getByLabel('Run the issue-to-merge chain')).not.toBeChecked()
  await expect(chain.getByLabel('Issue label', { exact: true })).toHaveValue('poise')
  await chain.getByLabel('Seed issues').selectOption('all')
  await expect(chain.getByLabel('Issue label', { exact: true })).toBeDisabled()
  await chain.getByRole('button', { name: 'Save chain settings' }).click()
  await expect.poll(() => state.posts.at(-1)).toEqual({ behaviorChain: { ...defaults, seedMode: 'all' }, expect: { behaviorChain: defaults } })
  await chain.getByRole('button', { name: 'Refresh chains' }).click()
  await chain.getByRole('button', { name: 'Hold new invocations' }).click()
  await expect.poll(() => controls).toEqual([{ id: 'acme/repo#7', sequence: 11, operation: 'hold' }])
  await expect(chain.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
})

test('a models save sends only the edited place and leaves general drafts alone', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  await setupModels(page, state)
  await page.goto('/')
  await openSection(page, 'general')
  await page.locator('#st-timezone').selectOption('Europe/Berlin')
  await openSection(page, 'models')
  await page.getByLabel('Chat slot', { exact: true }).selectOption('secondary')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(1)
  expect(Object.keys(state.posts[0]).sort()).toEqual(['expect', 'models'])
  expect(Object.keys(state.posts[0].models as object)).toEqual(['places'])
  expect((state.posts[0].models as ModelSettings).places?.chat?.slot).toBe('secondary')
  expect(state.posts[0].expect).toEqual({ models: {} })
  // The other tab's timezone is untouched, and the general draft is intact.
  expect(state.settings.timezone).toBe('UTC')
  await openSection(page, 'general')
  await expect(page.locator('#st-timezone')).toHaveValue('Europe/Berlin')
})

test('an invalid model draft does not block a general save', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  await setupModels(page, state)
  await page.goto('/')
  await openSection(page, 'models')
  const secondary = page.getByLabel('Secondary model', { exact: true })
  await secondary.selectOption(await page.getByLabel('Primary model', { exact: true }).inputValue())
  await openSection(page, 'general')
  await page.locator('#st-timezone').selectOption('Europe/Berlin')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(1)
  expect(state.posts[0]).not.toHaveProperty('models')
  expect(state.posts[0].timezone).toBe('Europe/Berlin')
  // The invalid draft was neither committed nor cleared.
  await openSection(page, 'models')
  await expect(secondary).toHaveValue(await page.getByLabel('Primary model', { exact: true }).inputValue())
  expect(state.settings.models).toEqual({})
})

test('a stale timezone save conflicts, keeps the draft and reads again on request', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  let refuses = true
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        // Another tab saved Helsinki first; the server holds it now.
        refuses = false
        state.settings = { ...state.settings, timezone: 'Europe/Helsinki' }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { timezone: 'Europe/Helsinki' } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, ...rest }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'general')
  await page.locator('#st-timezone').selectOption('Europe/Berlin')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Time zone is now "Europe/Helsinki"')
  await expect(page.locator('.st-status')).toContainText('Your edits are kept')
  await expect(page.locator('#st-timezone')).toHaveValue('Europe/Berlin')
  const reread = page.getByRole('button', { name: 'Read again' })
  await expect(reread).toBeVisible()
  await reread.click()
  await expect(page.locator('#st-timezone')).toHaveValue('Europe/Helsinki')
  await expect(page.locator('.st-status')).toHaveText('Read the latest saved values.')
  // Saving again after a fresh edit retries against what the server holds.
  await page.locator('#st-timezone').selectOption('Europe/Berlin')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  expect(state.posts[1].expect).toEqual({ timezone: 'Europe/Helsinki' })
  expect(state.settings.timezone).toBe('Europe/Berlin')
})

test('a stale models save reads the place back without losing other drafts', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  await setupModels(page, state)
  let refuses = true
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        refuses = false
        const current = { places: { chat: { slot: 'primary' } } }
        state.settings = { ...state.settings, models: current }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { models: current } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, models: mergeModels(state.settings.models as ModelSettings, (rest.models ?? {}) as ModelSettings) }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  const chatSlot = page.getByLabel('Chat slot', { exact: true })
  const editorSlot = page.getByLabel('Editor chat slot', { exact: true })
  await chatSlot.selectOption('secondary')
  await editorSlot.selectOption('tertiary')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "chat" is now')
  await expect(chatSlot).toHaveValue('secondary')
  await page.getByRole('button', { name: 'Read again' }).click()
  // Only the stale place takes the saved value; the other draft stays.
  await expect(chatSlot).toHaveValue('primary')
  await expect(editorSlot).toHaveValue('tertiary')
})

test('update turn bound drafts survive close and reopen, and save with Enter', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  await page.goto('/')
  await openSection(page, 'general')
  const bound = page.getByLabel('Update turn bound (minutes)')
  await expect(bound).toHaveValue('15')
  await bound.fill('45')
  await page.keyboard.press('Escape')
  await openSection(page, 'general')
  await expect(bound).toHaveValue('45')
  await bound.press('Enter')
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(1)
  expect((state.posts[0].chat as Record<string, unknown>).updateTurnBoundMinutes).toBe(45)
})

test('idle timeout accepts 0 as no idle expiry and preserves a stored 0', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT, idleTimeoutMinutes: 0 }, models: {} })
  await page.goto('/')
  await openSection(page, 'general')
  const idle = page.getByLabel('Idle timeout (minutes)')
  await expect(idle).toHaveValue('0')
  await expect(page.locator('label[for="st-chat-idle-timeout"]')).toHaveAttribute('data-help', /no idle expiry/)
  await expect(idle).toHaveAttribute('min', '0')
  // An unrelated save leaves the stored 0 alone.
  await page.getByLabel('Update turn bound (minutes)').fill('30')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(1)
  expect(state.posts[0].chat).toEqual({ updateTurnBoundMinutes: 30 })
  expect((state.settings.chat as Record<string, unknown>).idleTimeoutMinutes).toBe(0)
  // And 0 itself saves, while out-of-range values are refused.
  await idle.fill('60')
  await idle.fill('0')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect((state.posts[1].chat as Record<string, unknown>).idleTimeoutMinutes).toBe(0)
  await idle.fill('-1')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Idle timeout must be a whole number of minutes between 0 and 10080.')
  await idle.fill('10081')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Idle timeout must be a whole number of minutes between 0 and 10080.')
})

test('a save shows another tab\'s edit that landed in the response', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  await page.goto('/')
  await openSection(page, 'general')
  await expect(page.locator('#st-timezone')).toHaveValue('UTC')
  // Another tab saves Berlin; this tab has not re-read yet.
  state.settings = { ...state.settings, timezone: 'Europe/Berlin' }
  await page.getByLabel('Your GitHub account').fill('octocat2')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  // Untouched inputs follow the response, so the next draft is based on what is shown.
  await expect(page.locator('#st-timezone')).toHaveValue('Europe/Berlin')
  expect(state.posts).toHaveLength(1)
  expect(state.posts[0]).not.toHaveProperty('timezone')
})

test('a model draft made during the catalog reload baselines the saved choices', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  let loads = 0
  await page.route('**/api/models', async (route) => {
    loads += 1
    // The reload after a save lands late; drafts made meanwhile must still
    // baseline the saved choices, not the pre-save catalog.
    if (loads > 1) await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as ModelSettings) })
  })
  await page.goto('/')
  await openSection(page, 'models')
  await page.getByLabel('Chat slot', { exact: true }).selectOption('secondary')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  await page.getByLabel('Editor chat slot', { exact: true }).selectOption('tertiary')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  // The second save's expectation carries the first save's choice: without
  // the stored mirror it would carry the pre-save absence and 409.
  const sent = (state.posts[0].models as ModelSettings).places!
  const expected = ((state.posts[1].expect as Record<string, ModelSettings>).models.places!)
  expect(expected.chat).toEqual(sent.chat)
})

test('read again shows the saved values when the conflict reload fails', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  let loads = 0
  await page.route('**/api/models', async (route) => {
    loads += 1
    // Only the conflict reload fails; later reloads read the server again.
    if (loads === 2) {
      await route.fulfill({ status: 500, json: { error: 'catalog unavailable' } })
      return
    }
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as ModelSettings) })
  })
  const saved = { places: { chat: { slot: 'secondary' } } }
  let refuses = true
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        refuses = false
        state.settings = { ...state.settings, models: saved }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { models: saved } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, models: mergeModels(state.settings.models as ModelSettings, (rest.models ?? {}) as ModelSettings) }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  const chatSlot = page.getByLabel('Chat slot', { exact: true })
  await chatSlot.selectOption('tertiary')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "chat" is now')
  await page.getByRole('button', { name: 'Read again' }).click()
  // The reload failed, but the 409 carried the saved choice.
  await expect(chatSlot).toHaveValue('secondary')
  // Another tab saves again; the next reload reads it, and the next draft
  // baselines the reloaded choice rather than the 409 snapshot.
  const newer = { places: { chat: { slot: 'tertiary' } } }
  state.settings = { ...state.settings, models: newer }
  await page.keyboard.press('Escape')
  await openSection(page, 'models')
  await page.getByLabel('Editor chat slot', { exact: true }).selectOption('secondary')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect((state.posts[1].expect as Record<string, ModelSettings>).models).toEqual(newer)
})

test('read again prefers the refreshed value over the 409 snapshot', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  let refuses = true
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        // The 409 carries Helsinki, but another tab saves Berlin right after;
        // the conflict refresh sees Berlin.
        refuses = false
        state.settings = { ...state.settings, timezone: 'Europe/Berlin' }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { timezone: 'Europe/Helsinki' } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, ...rest }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'general')
  await page.locator('#st-timezone').selectOption('Europe/Madrid')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Time zone is now "Europe/Helsinki"')
  await page.getByRole('button', { name: 'Read again' }).click()
  // The refresh (Berlin) wins over the older snapshot (Helsinki).
  await expect(page.locator('#st-timezone')).toHaveValue('Europe/Berlin')
  // And the next draft baselines what is shown.
  await page.locator('#st-timezone').selectOption('Europe/Madrid')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts[1].expect).toEqual({ timezone: 'Europe/Berlin' })
})

test('a save after a failed-refresh read-again re-baselines the shown value', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  let refuses = true
  let failNextGet = false
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        refuses = false
        failNextGet = true
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { timezone: 'Europe/Helsinki' } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, ...rest }
    } else if (failNextGet) {
      // The conflict refresh fails: Read again falls back to the snapshot.
      failNextGet = false
      await route.fulfill({ status: 500, json: { error: 'settings unavailable' } })
      return
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'general')
  await page.locator('#st-timezone').selectOption('Europe/Madrid')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Time zone is now "Europe/Helsinki"')
  await page.getByRole('button', { name: 'Read again' }).click()
  await expect(page.locator('#st-timezone')).toHaveValue('Europe/Helsinki')
  // Another tab saves Berlin; an unrelated save shows it.
  state.settings = { ...state.settings, timezone: 'Europe/Berlin' }
  await page.getByLabel('Your GitHub account').fill('octocat2')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  await expect(page.locator('#st-timezone')).toHaveValue('Europe/Berlin')
  // The next draft baselines the shown Berlin, not the retained Helsinki.
  await page.locator('#st-timezone').selectOption('Europe/Madrid')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts[2].expect).toEqual({ timezone: 'Europe/Berlin' })
})

test('a focused input keeps the baseline its shown text was read against', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  let refuses = true
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        refuses = false
        // Another tab saved its account name; the conflict refresh reads it.
        state.settings = { ...state.settings, me: 'octocat2' }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { timezone: 'Europe/Helsinki' } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, ...rest }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'general')
  const me = page.getByLabel('Your GitHub account')
  await page.locator('#st-timezone').selectOption('Europe/Madrid')
  // Enter saves from inside the account field, so it stays focused while the
  // conflict refresh lands and keeps its shown text.
  await me.click()
  await me.press('Enter')
  await expect(page.locator('.st-status')).toContainText('Time zone is now "Europe/Helsinki"')
  await expect(me).toHaveValue('octocat')
  await page.getByRole('button', { name: 'Read again' }).click()
  // The next draft is compared to the shown octocat, not the unseen octocat2.
  await me.fill('octocat3')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts[1].expect).toEqual({ me: 'octocat' })
})

test('saving a remaining draft after read-again succeeds without a second conflict', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  let refuses = true
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        refuses = false
        // The 409 carries idle 0; the refresh then reads conc 6 as well.
        state.settings = { ...state.settings, chat: { ...CHAT, idleTimeoutMinutes: 0, maxConcurrentLocalTurns: 6 } }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { chat: { ...CHAT, idleTimeoutMinutes: 0 } } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      const merged = { ...state.settings, ...rest }
      if (rest.chat && typeof rest.chat === 'object') merged.chat = { ...(state.settings.chat as object), ...(rest.chat as object) }
      state.settings = merged
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'general')
  await page.locator('#st-chat-idle-timeout').fill('45')
  await page.locator('#st-chat-branch-prefix').fill('agent/')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Idle timeout is now 0')
  await page.getByRole('button', { name: 'Read again' }).click()
  await expect(page.locator('#st-chat-idle-timeout')).toHaveValue('0')
  await expect(page.locator('#st-chat-branch-prefix')).toHaveValue('agent/')
  // The retry expects the refreshed chat with the remaining draft's own basis.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  expect(state.posts[1].expect).toEqual({ chat: { ...CHAT, idleTimeoutMinutes: 0, maxConcurrentLocalTurns: 6 } })
})

test('saving again after a conflict retries against the refused value', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  let refuses = true
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        refuses = false
        state.settings = { ...state.settings, timezone: 'Europe/Helsinki' }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { timezone: 'Europe/Helsinki' } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, ...rest }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'general')
  await page.locator('#st-timezone').selectOption('Europe/Madrid')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Time zone is now "Europe/Helsinki"')
  // Save again without reading again: an intentional overwrite of Helsinki.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  expect(state.posts[1].expect).toEqual({ timezone: 'Europe/Helsinki' })
  expect(state.settings.timezone).toBe('Europe/Madrid')
})

test('saving models again after a conflict retries against the refused choice', async ({ page }) => {
  const stored = { slot: 'tertiary' }
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: { places: { chat: stored } } })
  await setupModels(page, state)
  let refuses = true
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        refuses = false
        const current = { places: { chat: { slot: 'primary' } } }
        state.settings = { ...state.settings, models: current }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { models: current } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, models: mergeModels(state.settings.models as ModelSettings, (rest.models ?? {}) as ModelSettings) }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  const chatSlot = page.getByLabel('Chat slot', { exact: true })
  await chatSlot.selectOption('secondary')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "chat" is now')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  expect(((state.posts[1].expect as Record<string, ModelSettings>).models.places ?? {}).chat).toEqual({ slot: 'primary' })
})

test('saving models again after a failed catalog reload retries against the refusal', async ({ page }) => {
  const chatStored = { slot: 'tertiary' }
  const editorStored = { slot: 'secondary' }
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: { places: { chat: chatStored, editor: editorStored } } })
  let loads = 0
  await page.route('**/api/models', async (route) => {
    loads += 1
    // Only the conflict reload fails; later reloads read the server again.
    if (loads === 2) {
      await route.fulfill({ status: 500, json: { error: 'catalog unavailable' } })
      return
    }
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as ModelSettings) })
  })
  const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every((key) => deepEqual(left[key], right[key]))
  }
  // The stub refuses like the server: the whole stored models object must
  // match the expectation, and a refusal carries the current values.
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      const models = state.settings.models as ModelSettings
      const expected = (body.expect as { models?: ModelSettings } | undefined)?.models
      if (expected && !deepEqual(models, expected)) {
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { models } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, models: mergeModels(models, (rest.models ?? {}) as ModelSettings) }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  const chatSlot = page.getByLabel('Chat slot', { exact: true })
  await chatSlot.selectOption('primary')
  // Another tab saves the untouched editor place before this tab's save.
  const editorSaved = { slot: 'primary' }
  state.settings = { ...state.settings, models: { places: { chat: chatStored, editor: editorSaved } } }
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "editor" is now')
  await expect(chatSlot).toHaveValue('primary')
  // Save again compares the untouched place against the refusal, not the
  // stale catalog, and carries only the edited place.
  const reloaded = page.waitForResponse('**/api/models')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  await reloaded
  expect(state.posts).toHaveLength(2)
  expect(Object.keys((state.posts[1].models as ModelSettings).places as object)).toEqual(['chat'])
  expect(((state.posts[1].expect as Record<string, ModelSettings>).models.places ?? {}).editor).toEqual(editorSaved)
  expect(((state.settings.models as ModelSettings).places ?? {}).editor).toEqual(editorSaved)
  // A later genuine concurrent change still conflicts.
  const editorNewer = { slot: 'tertiary' }
  state.settings = { ...state.settings, models: { places: { ...((state.settings.models as ModelSettings).places ?? {}), editor: editorNewer } } }
  await chatSlot.selectOption('secondary')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "editor" is now')
  expect(state.posts).toHaveLength(3)
  expect(((state.posts[2].expect as Record<string, ModelSettings>).models.places ?? {}).editor).toEqual(editorSaved)
})

test('a slots edit after a failed catalog reload keeps the refused models', async ({ page }) => {
  const slotsStored = { primary: 'fable-5.1-max', secondary: 'opus-5-max', tertiary: 'grok-4.6-xhigh' }
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: { slots: slotsStored, places: { chat: { slot: 'tertiary' } } } })
  let loads = 0
  await page.route('**/api/models', async (route) => {
    loads += 1
    // Only the conflict reload fails; later reloads read the server again.
    if (loads === 2) {
      await route.fulfill({ status: 500, json: { error: 'catalog unavailable' } })
      return
    }
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as ModelSettings) })
  })
  const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every((key) => deepEqual(left[key], right[key]))
  }
  // The stub refuses like the server: the whole stored models object must
  // match the expectation, and a refusal carries the current values.
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      const models = state.settings.models as ModelSettings
      const expected = (body.expect as { models?: ModelSettings } | undefined)?.models
      if (expected && !deepEqual(models, expected)) {
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { models } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, models: mergeModels(models, (rest.models ?? {}) as ModelSettings) }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  await page.getByLabel('Primary model', { exact: true }).selectOption('muse-spark-1.3-contributor-max')
  // Another tab saves the slots and the untouched chat place before this tab's save.
  const slotsSaved = { primary: 'opus-5-xhigh', secondary: 'opus-5-max', tertiary: 'grok-4.6-xhigh' }
  state.settings = { ...state.settings, models: { slots: slotsSaved, places: { chat: { slot: 'primary' } } } }
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "slots" is now')
  // The untouched selects show the refused models, not the stale catalog.
  const secondary = page.getByLabel('Secondary model', { exact: true })
  const tertiary = page.getByLabel('Tertiary model', { exact: true })
  await expect(secondary).toHaveValue('opus-5-max')
  await expect(tertiary).toHaveValue('grok-4.6-xhigh')
  await expect(page.getByLabel('Chat slot', { exact: true })).toHaveValue('primary')
  // Editing only the secondary keeps the refused tertiary: the save carries
  // what is shown, not the stale pre-conflict choice.
  await secondary.selectOption('gpt-6-astra-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  const carried = { primary: 'muse-spark-1.3-contributor-max', secondary: 'gpt-6-astra-max', tertiary: 'grok-4.6-xhigh' }
  expect((state.posts[1].models as ModelSettings).slots).toEqual(carried)
  expect((state.settings.models as ModelSettings).slots).toEqual(carried)
  expect(((state.posts[1].expect as Record<string, ModelSettings>).models.places ?? {}).chat).toEqual({ slot: 'primary' })
})

test('a model draft made with nothing stored refuses after another tab fills the place', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  await setupModels(page, state)
  await page.goto('/')
  await openSection(page, 'models')
  const chatSlot = page.getByLabel('Chat slot', { exact: true })
  const editorSlot = page.getByLabel('Editor chat slot', { exact: true })
  await chatSlot.selectOption('secondary')
  // Another tab saves the slots and both places; reopening reads its choices
  // under the draft.
  const saved = {
    slots: { primary: 'opus-5-max', secondary: 'gpt-6-astra-ultra', tertiary: 'grok-4.6-xhigh' },
    places: { chat: { slot: 'primary' }, editor: { slot: 'tertiary' } },
  }
  state.settings = { ...state.settings, models: saved }
  await page.keyboard.press('Escape')
  await openSection(page, 'models')
  // The editor select proves the reload landed; the chat draft is kept.
  await expect(editorSlot).toHaveValue('tertiary')
  await expect(chatSlot).toHaveValue('secondary')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  // The stub answers where a real server would refuse; the wire expectation
  // carries the refusal.
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(1)
  expect(state.posts[0].expect).toEqual({ models: { slots: saved.slots, places: { chat: null, editor: saved.places.editor } } })
})

test('editing the same input after an Enter save compares against the save', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  await page.goto('/')
  await openSection(page, 'general')
  const me = page.getByLabel('Your GitHub account')
  await me.fill('octocat2')
  await me.press('Enter')
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  // Still focused: the next draft starts from the save, not the pre-save read.
  await me.fill('octocat3')
  await me.press('Enter')
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  expect(state.posts[1].expect).toEqual({ me: 'octocat2' })
})

test('a remaining draft retries clean after a failed-refresh read-again', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  let refuses = true
  let failNextGet = false
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        refuses = false
        failNextGet = true
        state.settings = { ...state.settings, chat: { ...CHAT, idleTimeoutMinutes: 0 } }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { chat: { ...CHAT, idleTimeoutMinutes: 0 } } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      const merged = { ...state.settings, ...rest }
      if (rest.chat && typeof rest.chat === 'object') merged.chat = { ...(state.settings.chat as object), ...(rest.chat as object) }
      state.settings = merged
    } else if (failNextGet) {
      failNextGet = false
      await route.fulfill({ status: 500, json: { error: 'settings unavailable' } })
      return
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'general')
  await page.locator('#st-chat-idle-timeout').fill('45')
  await page.locator('#st-chat-branch-prefix').fill('agent/')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Idle timeout is now 0')
  await page.getByRole('button', { name: 'Read again' }).click()
  await expect(page.locator('#st-chat-idle-timeout')).toHaveValue('0')
  await expect(page.locator('#st-chat-branch-prefix')).toHaveValue('agent/')
  // The retry compares the remaining draft against the refusal's chat.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  expect(state.posts[1].expect).toEqual({ chat: { ...CHAT, idleTimeoutMinutes: 0 } })
})
