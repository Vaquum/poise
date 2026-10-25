import { expect, test, type Page } from '@playwright/test'
import { CATALOG } from '../model-catalog-fixture'

// Settings saves carry only the active section's drafts, with the values the
// tab read: another section's drafts can neither block nor be committed by
// the save, and another tab's edit to the same field is refused with its
// current value instead of silently overwritten.

type ModelChoice = { default: string, fallback: string, secondary?: string, tertiary?: string }
const CHAT = { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }

function modelsResponse(models: Record<string, ModelChoice>) {
  const places = [
    { key: 'chat', label: 'Chat', why: 'Card chats.', review: false, reviewers: false, seed: 'author_content' },
    { key: 'editor', label: 'Editor chat', why: 'Editor chats.', review: false, reviewers: false, seed: 'author_content' },
    { key: 'pr_review', label: 'PR review', why: 'Reviews.', review: true, reviewers: true, seed: 'pr_review' },
    { key: 'pr_approve', label: 'PR approval', why: 'Approvals.', review: true, reviewers: false, seed: 'pr_approve' },
  ].map((place) => ({
    ...place,
    default: models[place.key]?.default || (CATALOG.behaviors as Record<string, string>)[place.seed],
    fallback: models[place.key]?.fallback || (CATALOG.behaviors as Record<string, string>).review_recovery,
    ...(place.reviewers
      ? { secondary: models[place.key]?.secondary || 'gpt-6-astra-ultra', tertiary: models[place.key]?.tertiary || 'grok-4.6-xhigh' }
      : {}),
    notes: [],
    stored: models[place.key] || null,
  }))
  const fixed = [{ key: 'content', label: '/content', model: (CATALOG.behaviors as Record<string, string>).author_content, why: 'Set by Caller.' }]
  return { catalog: CATALOG, places, fixed, refresh: null }
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
      for (const key of ['chat', 'models'] as const) {
        if (rest[key] && typeof rest[key] === 'object') merged[key] = { ...(state.settings[key] as object), ...(rest[key] as object) }
      }
      state.settings = merged
    }
    await route.fulfill({ json: state.settings })
  })
  return state
}

async function setupModels(page: Page, state: SettingsStub): Promise<void> {
  await page.route('**/api/models', async (route) => {
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as Record<string, ModelChoice>) })
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

test('a models save sends only the edited place and leaves general drafts alone', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  await setupModels(page, state)
  await page.goto('/')
  await openSection(page, 'general')
  await page.locator('#st-timezone').selectOption('Europe/Berlin')
  await openSection(page, 'models')
  await page.getByLabel('Chat default model', { exact: true }).selectOption('muse-spark-1.3-contributor-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(1)
  expect(Object.keys(state.posts[0]).sort()).toEqual(['expect', 'models'])
  expect(Object.keys(state.posts[0].models as object)).toEqual(['chat'])
  expect((state.posts[0].models as Record<string, ModelChoice>).chat.default).toBe('muse-spark-1.3-contributor-max')
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
  const fallback = page.getByLabel('Chat fallback model', { exact: true })
  await fallback.selectOption(await page.getByLabel('Chat default model', { exact: true }).inputValue())
  await openSection(page, 'general')
  await page.locator('#st-timezone').selectOption('Europe/Berlin')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(1)
  expect(state.posts[0]).not.toHaveProperty('models')
  expect(state.posts[0].timezone).toBe('Europe/Berlin')
  // The invalid draft was neither committed nor cleared.
  await openSection(page, 'models')
  await expect(fallback).toHaveValue(await page.getByLabel('Chat default model', { exact: true }).inputValue())
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
        const current = { chat: { default: 'opus-5-max', fallback: (CATALOG.behaviors as Record<string, string>).review_recovery } }
        state.settings = { ...state.settings, models: current }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { models: current } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, models: { ...(state.settings.models as object), ...((rest.models ?? {}) as object) } }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  const chatDefault = page.getByLabel('Chat default model', { exact: true })
  const editorDefault = page.getByLabel('Editor chat default model', { exact: true })
  await chatDefault.selectOption('muse-spark-1.3-contributor-max')
  await editorDefault.selectOption('fable-5.1-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "chat" is now')
  await expect(chatDefault).toHaveValue('muse-spark-1.3-contributor-max')
  await page.getByRole('button', { name: 'Read again' }).click()
  // Only the stale place takes the saved value; the other draft stays.
  await expect(chatDefault).toHaveValue('opus-5-max')
  await expect(editorDefault).toHaveValue('fable-5.1-max')
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
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as Record<string, ModelChoice>) })
  })
  await page.goto('/')
  await openSection(page, 'models')
  await page.getByLabel('Chat default model', { exact: true }).selectOption('muse-spark-1.3-contributor-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  await page.getByLabel('Editor chat default model', { exact: true }).selectOption('fable-5.1-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  // The second save's expectation carries the first save's choice: without
  // the stored mirror it would carry the pre-save absence and 409.
  const sent = state.posts[0].models as Record<string, ModelChoice>
  const expected = (state.posts[1].expect as Record<string, Record<string, ModelChoice>>).models
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
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as Record<string, ModelChoice>) })
  })
  const saved = { chat: { default: 'fable-5.1-max', fallback: 'opus-5-max' } }
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
      state.settings = { ...state.settings, models: { ...(state.settings.models as object), ...((rest.models ?? {}) as object) } }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  const chatDefault = page.getByLabel('Chat default model', { exact: true })
  await chatDefault.selectOption('muse-spark-1.3-contributor-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "chat" is now')
  await page.getByRole('button', { name: 'Read again' }).click()
  // The reload failed, but the 409 carried the saved choice.
  await expect(chatDefault).toHaveValue('fable-5.1-max')
  // Another tab saves again; the next reload reads it, and the next draft
  // baselines the reloaded choice rather than the 409 snapshot.
  const newer = { chat: { default: 'opus-5-xhigh', fallback: 'opus-5-max' } }
  state.settings = { ...state.settings, models: newer }
  await page.keyboard.press('Escape')
  await openSection(page, 'models')
  await page.getByLabel('Editor chat default model', { exact: true }).selectOption('fable-5.1-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect((state.posts[1].expect as Record<string, Record<string, ModelChoice>>).models).toEqual(newer)
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
  const stored = { default: 'fable-5.1-max', fallback: (CATALOG.behaviors as Record<string, string>).review_recovery }
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: { chat: stored } })
  await setupModels(page, state)
  let refuses = true
  await page.unroute('**/api/settings')
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      if (refuses) {
        refuses = false
        const current = { chat: { default: 'opus-5-max', fallback: (CATALOG.behaviors as Record<string, string>).review_recovery } }
        state.settings = { ...state.settings, models: current }
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { models: current } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, models: { ...(state.settings.models as object), ...((rest.models ?? {}) as object) } }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  const chatDefault = page.getByLabel('Chat default model', { exact: true })
  await chatDefault.selectOption('muse-spark-1.3-contributor-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "chat" is now')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  expect((state.posts[1].expect as Record<string, Record<string, unknown>>).models.chat)
    .toEqual({ default: 'opus-5-max', fallback: (CATALOG.behaviors as Record<string, string>).review_recovery })
})

test('saving models again after a failed catalog reload retries against the refusal', async ({ page }) => {
  const recovery = (CATALOG.behaviors as Record<string, string>).review_recovery
  const chatStored = { default: 'fable-5.1-max', fallback: recovery }
  const editorStored = { default: 'opus-5-max', fallback: recovery }
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: { chat: chatStored, editor: editorStored } })
  let loads = 0
  await page.route('**/api/models', async (route) => {
    loads += 1
    // Only the conflict reload fails; later reloads read the server again.
    if (loads === 2) {
      await route.fulfill({ status: 500, json: { error: 'catalog unavailable' } })
      return
    }
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as Record<string, ModelChoice>) })
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
      const models = state.settings.models as Record<string, ModelChoice>
      const expected = (body.expect as { models?: Record<string, ModelChoice> } | undefined)?.models
      if (expected && !deepEqual(models, expected)) {
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { models } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, models: { ...models, ...((rest.models ?? {}) as object) } }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  const chatDefault = page.getByLabel('Chat default model', { exact: true })
  await chatDefault.selectOption('muse-spark-1.3-contributor-max')
  // Another tab saves the untouched editor place before this tab's save.
  const editorSaved = { default: 'opus-5-xhigh', fallback: recovery }
  state.settings = { ...state.settings, models: { chat: chatStored, editor: editorSaved } }
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "editor" is now')
  await expect(chatDefault).toHaveValue('muse-spark-1.3-contributor-max')
  // Save again compares the untouched place against the refusal, not the
  // stale catalog, and carries only the edited place.
  const reloaded = page.waitForResponse('**/api/models')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  await reloaded
  expect(state.posts).toHaveLength(2)
  expect(Object.keys(state.posts[1].models as object)).toEqual(['chat'])
  expect((state.posts[1].expect as Record<string, Record<string, ModelChoice>>).models.editor).toEqual(editorSaved)
  expect((state.settings.models as Record<string, ModelChoice>).editor).toEqual(editorSaved)
  // A later genuine concurrent change still conflicts.
  const editorNewer = { default: 'fable-5.1-xhigh', fallback: recovery }
  state.settings = { ...state.settings, models: { ...(state.settings.models as object), editor: editorNewer } }
  await chatDefault.selectOption('gpt-6-astra-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "editor" is now')
  expect(state.posts).toHaveLength(3)
  expect((state.posts[2].expect as Record<string, Record<string, ModelChoice>>).models.editor).toEqual(editorSaved)
})

test('a fallback edit after a failed catalog reload keeps the refused default', async ({ page }) => {
  const recovery = (CATALOG.behaviors as Record<string, string>).review_recovery
  const chatStored = { default: 'fable-5.1-max', fallback: recovery }
  const editorStored = { default: 'opus-5-max', fallback: recovery }
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: { chat: chatStored, editor: editorStored } })
  let loads = 0
  await page.route('**/api/models', async (route) => {
    loads += 1
    // Only the conflict reload fails; later reloads read the server again.
    if (loads === 2) {
      await route.fulfill({ status: 500, json: { error: 'catalog unavailable' } })
      return
    }
    await route.fulfill({ json: modelsResponse((state.settings.models ?? {}) as Record<string, ModelChoice>) })
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
      const models = state.settings.models as Record<string, ModelChoice>
      const expected = (body.expect as { models?: Record<string, ModelChoice> } | undefined)?.models
      if (expected && !deepEqual(models, expected)) {
        await route.fulfill({ status: 409, json: { error: 'Settings changed since this tab read them. Nothing was saved; read again and retry.', current: { models } } })
        return
      }
      const { expect: _ignored, ...rest } = body
      state.settings = { ...state.settings, models: { ...models, ...((rest.models ?? {}) as object) } }
    }
    await route.fulfill({ json: state.settings })
  })
  await page.goto('/')
  await openSection(page, 'models')
  await page.getByLabel('Chat default model', { exact: true }).selectOption('muse-spark-1.3-contributor-max')
  // Another tab saves the untouched editor place before this tab's save.
  const editorSaved = { default: 'opus-5-xhigh', fallback: recovery }
  state.settings = { ...state.settings, models: { chat: chatStored, editor: editorSaved } }
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toContainText('Models "editor" is now')
  // The untouched place shows the refused choice, not the stale catalog.
  const editorDefault = page.getByLabel('Editor chat default model', { exact: true })
  const editorFallback = page.getByLabel('Editor chat fallback model', { exact: true })
  await expect(editorDefault).toHaveValue('opus-5-xhigh')
  await expect(editorFallback).toHaveValue(recovery)
  // Editing only the fallback keeps the refused default: the save carries
  // what is shown, not the stale pre-conflict choice.
  await editorFallback.selectOption('gpt-6-astra-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(2)
  expect((state.posts[1].models as Record<string, ModelChoice>).editor).toEqual({ default: 'opus-5-xhigh', fallback: 'gpt-6-astra-max' })
  expect((state.settings.models as Record<string, ModelChoice>).editor).toEqual({ default: 'opus-5-xhigh', fallback: 'gpt-6-astra-max' })
})

test('a model draft made with nothing stored refuses after another tab fills the place', async ({ page }) => {
  const state = await setupSettings(page, { org: 'acme', me: 'octocat', agentAccount: '', timezone: 'UTC', chat: { ...CHAT }, models: {} })
  await setupModels(page, state)
  await page.goto('/')
  await openSection(page, 'models')
  const chatDefault = page.getByLabel('Chat default model', { exact: true })
  const editorDefault = page.getByLabel('Editor chat default model', { exact: true })
  await chatDefault.selectOption('muse-spark-1.3-contributor-max')
  // Another tab saves both places; reopening reads its choices under the draft.
  const saved = {
    chat: { default: 'opus-5-max', fallback: (CATALOG.behaviors as Record<string, string>).review_recovery },
    editor: { default: 'fable-5.1-max', fallback: (CATALOG.behaviors as Record<string, string>).review_recovery },
  }
  state.settings = { ...state.settings, models: saved }
  await page.keyboard.press('Escape')
  await openSection(page, 'models')
  // The editor select proves the reload landed; the chat draft is kept.
  await expect(editorDefault).toHaveValue('fable-5.1-max')
  await expect(chatDefault).toHaveValue('muse-spark-1.3-contributor-max')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  // The stub answers where a real server would refuse; the wire expectation
  // carries the refusal.
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(1)
  expect(state.posts[0].expect).toEqual({ models: { chat: null, editor: saved.editor } })
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
