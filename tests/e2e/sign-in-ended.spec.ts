import { expect, test, type Page } from '@playwright/test'

// What a person sees in a workspace once the sign-in in front of it has ended
// (src/signed-out.ts): the gateway's own session turning the page's requests
// away with 401, or a login proxy in front of it, such as a portal,
// redirecting them to its login page on another origin.

type SignIn = 'valid' | 'ended' | 'redirected'

const PORTAL = 'https://portal.example.test'

async function workspace(page: Page, state: { signIn: SignIn, claudeReachable?: boolean }): Promise<void> {
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  // The login page of a proxy in front of Poise: on another origin, so the page's own requests cannot read it.
  await page.route(`${PORTAL}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Sign in</p>' }))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (state.signIn === 'ended') {
      return route.fulfill({ status: 401, json: { error: 'unauthorized', message: 'Sign in to use this workspace. Sign in at https://poise.example.test/.' } })
    }
    if (state.signIn === 'redirected') {
      return route.fulfill({ status: 303, headers: { location: `${PORTAL}/login?next=${encodeURIComponent(url.href)}` } })
    }
    if (url.pathname === '/api/workspace') return route.fulfill({ json: { mode: 'service', owner: 'octocat' } })
    if (url.pathname === '/api/claude-auth') {
      if (state.claudeReachable === false) return route.abort('connectionrefused')
      return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    }
    if (url.pathname === '/api/settings') return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', models: {} } })
    return route.fulfill({ json: {} })
  })
}

/** A request from the page, as any view makes one; repeated until the page has started watching. */
async function untilNoticed(page: Page): Promise<void> {
  await expect.poll(async () => {
    await page.evaluate(() => fetch('/api/current').catch(() => null))
    return page.locator('.up-backdrop').count()
  }, { timeout: 10_000 }).toBe(1)
}

for (const signIn of ['ended', 'redirected'] as const) {
  test(`says the sign-in has ended when ${signIn === 'ended' ? 'the gateway answers 401' : 'a login proxy redirects'}, and signs in again by reloading`, async ({ page }) => {
    const state: { signIn: SignIn } = { signIn: 'valid' }
    await workspace(page, state)
    await page.goto('/')
    await expect(page.locator('#app')).toBeVisible()

    state.signIn = signIn
    await untilNoticed(page)
    const notice = page.getByRole('alertdialog', { name: 'Your sign-in has ended' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Sign in again to go on where you were.')
    const again = notice.getByRole('button', { name: 'Sign in again' })
    await expect(again).toBeFocused()

    // Signed in again: the reload comes back to Poise, which answers as before.
    state.signIn = 'valid'
    await Promise.all([page.waitForEvent('load'), again.click()])
    await expect(page.locator('#app')).toBeVisible()
    await expect(page.locator('.up-backdrop')).toHaveCount(0)
  })
}

test('offers no Claude reconnect when Poise\'s own server cannot be reached, and claims no ended sign-in', async ({ page }) => {
  await workspace(page, { signIn: 'valid', claudeReachable: false })
  await page.goto('/')
  const banner = page.locator('#claude-auth-banner')
  await expect(banner.locator('.claude-auth-title')).toHaveText('Poise could not check the Claude subscription')
  await expect(banner).toContainText('This is a problem reaching Poise\'s own server, not necessarily the subscription.')
  await expect(banner.locator('.claude-auth-login')).toHaveCount(0)
  await expect(page.locator('.up-backdrop')).toHaveCount(0)
})
