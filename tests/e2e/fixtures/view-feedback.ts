import { expect, type Page } from '@playwright/test'

/** Read the shared rail through its real UI, including when notifications are off. */
export async function feedback(page: Page, title?: string) {
  const bell = page.locator('#notification-bell')
  if (await bell.getAttribute('aria-expanded') !== 'true') await bell.click()
  const rail = page.locator('#notification-rail')
  await expect(rail).toBeVisible()
  return title ? rail.locator('.nr-card').filter({ hasText: title }) : rail
}
