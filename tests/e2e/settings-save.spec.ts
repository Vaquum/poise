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
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator(`[data-settings="${section}"]`).click()
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
  await page.getByLabel('Chat default model', { exact: true }).selectOption('gpt-6-astra-ultra')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  expect(state.posts).toHaveLength(1)
  expect(Object.keys(state.posts[0]).sort()).toEqual(['expect', 'models'])
  expect(Object.keys(state.posts[0].models as object)).toEqual(['chat'])
  expect((state.posts[0].models as Record<string, ModelChoice>).chat.default).toBe('gpt-6-astra-ultra')
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
