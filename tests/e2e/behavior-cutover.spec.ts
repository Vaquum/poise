import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { BEHAVIORS } from '../../src/behaviors'
import type { BehaviorCutoverState } from '../../src/behavior-cutover'

async function general(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover [data-settings="general"]').click()
  return page.getByRole('region', { name: 'Behavior chain settings' })
}
const row = (number: number) => ({ id: `acme/repo#${number}`, repository: 'acme/repo', issue: number, sequence: number,
  held: null, waiting: 'exact-head CI is running', mergeSha: null, pullNumber: number + 10, invocations: [] })

test('one cutover action reports drain, survives reload and reflects actual completion without touching Chats', async ({ page }) => {
  await workspace(page)
  let cutover: BehaviorCutoverState = { sequence: 0, mode: 'v1', requestedAt: null, legacyPulls: [] }
  const writes: unknown[] = []
  await page.route('**/api/behavior-chains', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      writes.push(body)
      cutover = { ...cutover, mode: 'draining', sequence: 1, requestedAt: Date.now() }
    }
    return route.fulfill({ json: { chains: [], next: null, runtime: [], cutover: { ...cutover, blockers: ['1 native Caller invocation(s) still running'] },
      settings: { enabled: cutover.mode === 'v2', seedMode: 'label', label: 'poise' } } })
  })
  const controls = await general(page)
  await expect(controls.getByText('v1 owns new work', { exact: true })).toBeVisible()
  await expect(controls.getByLabel('Run the issue-to-merge chain')).toBeDisabled()
  await controls.getByRole('button', { name: 'Switch to v2', exact: true }).click()
  await expect.poll(() => writes).toEqual([{ operation: 'switch-to-v2', sequence: 0 }])
  await expect(controls.locator('[data-cutover-status]')).toContainText('1 native Caller')
  await expect(controls.getByRole('button', { name: 'Cancel cutover' })).toBeEnabled()
  await page.reload()
  const reloaded = await general(page)
  await expect(reloaded.locator('[data-cutover-status]')).toContainText('Draining behaviors')
  cutover = { ...cutover, sequence: 2, mode: 'v2', legacyPulls: ['acme/repo#9'] }
  await reloaded.getByRole('button', { name: 'Refresh chains' }).click()
  await expect(reloaded.locator('[data-cutover-status]')).toContainText('v2 owns new work')
  await expect(reloaded.getByRole('button', { name: 'v2 active', exact: true })).toBeDisabled()
  await expect(reloaded.getByLabel('Run the issue-to-merge chain')).toBeChecked()
  await page.screenshot({ path: 'test-results/behavior-cutover.png', fullPage: true })
  expect(writes).toHaveLength(1)
})

test('stale cutover and unavailable reads never show a successful activation', async ({ page }) => {
  await workspace(page)
  let unavailable = false
  await page.route('**/api/behavior-chains', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, json: { error: 'behavior cutover changed; reload its current state' } })
    : unavailable ? route.fulfill({ status: 503, json: { error: 'Caller unavailable' } })
      : route.fulfill({ json: { chains: [], next: null, runtime: [], cutover: { mode: 'v1', sequence: 0, legacyPulls: [], blockers: [] } } }))
  const controls = await general(page)
  await controls.getByRole('button', { name: 'Switch to v2', exact: true }).click()
  await expect(controls.locator('[data-chain-status]')).toContainText('Cutover was not applied')
  await expect(controls.locator('[data-cutover-status]')).toHaveText('v1 owns new work')
  unavailable = true
  await controls.getByRole('button', { name: 'Refresh chains' }).click()
  await expect(controls.locator('[data-cutover-status]')).toHaveText('Admission state unavailable')
  await expect(controls.getByRole('button', { name: 'Switch to v2', exact: true })).toBeDisabled()
})

test('chain and journal pagination retain prior results and display the actual waiting reason', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/behavior-chains*', route => {
    const query = new URL(route.request().url()).searchParams
    if (query.has('id')) return route.fulfill({ json: { events: query.get('after') === '0'
      ? [{ sequence: 1, at: Date.now(), type: 'chain.admitted' }] : [{ sequence: 2, at: Date.now(), type: 'chain.waiting', reason: 'CI evidence unavailable' }],
    next: query.get('after') === '0' ? 1 : null } })
    return route.fulfill({ json: { chains: [row(query.has('after') ? 2 : 1)], next: query.has('after') ? null : 'acme/repo#1', runtime: [],
      cutover: { mode: 'v2', sequence: 2, legacyPulls: [], blockers: [] } } })
  })
  const controls = await general(page)
  await expect(controls.locator('[data-chain-list]')).toContainText('exact-head CI is running')
  await controls.getByRole('button', { name: 'More chains' }).click()
  await expect(controls.getByRole('button', { name: 'History', exact: true })).toHaveCount(2)
  await controls.getByRole('button', { name: 'Refresh chains' }).click()
  await expect(controls.getByRole('button', { name: 'History', exact: true })).toHaveCount(2)
  await controls.getByRole('button', { name: 'History', exact: true }).first().click()
  const history = controls.getByRole('region', { name: 'Chain journal' })
  await expect(history).toContainText('chain.admitted')
  await history.getByRole('button', { name: 'More events' }).click()
  await expect(history).toContainText('chain.admitted')
  await expect(history).toContainText('CI evidence unavailable')
})

test('implementation and repair rows expose independent active and pause controls with actual activity', async ({ page }) => {
  await workspace(page)
  const writes: Array<{ key: string, body: Record<string, unknown> }> = []
  const saved: Record<string, { enabled: boolean, pausedUntil: string | null }> = {
    'implement-issues': { enabled: true, pausedUntil: null }, 'repair-prs': { enabled: true, pausedUntil: null },
  }
  await page.route(/\/api\/behaviors(?:\/[^/?]+)?$/, route => {
    const key = new URL(route.request().url()).pathname.split('/')[3]
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      writes.push({ key, body }); Object.assign(saved[key], body)
      return route.fulfill({ json: { ok: true, ...saved[key] } })
    }
    return route.fulfill({ json: Object.fromEntries(BEHAVIORS.map(({ key }) => [key, { owner: 'octocat', enabled: saved[key]?.enabled ?? false,
      pausedUntil: saved[key]?.pausedUntil ?? null, scratchpad: '', lastTriggered: saved[key] ? { at: new Date().toISOString(), target: 'acme/repo#7' } : null }])) })
  })
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  const repair = page.locator('tr[data-behavior="repair-prs"]')
  await expect(repair).toContainText('Repair Pull Requests')
  await expect(repair.locator('.behavior-last-link')).toHaveAttribute('data-target', 'acme/repo#7')
  await repair.locator('.toggle').click()
  await expect.poll(() => writes[0]).toEqual({ key: 'repair-prs', body: { enabled: false } })
  const implement = page.locator('tr[data-behavior="implement-issues"]')
  await expect(implement.locator('input[type="checkbox"]')).toBeChecked()
  await implement.getByRole('button', { name: 'Pause 15 min' }).click()
  await expect(implement.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
  expect(writes[1].key).toBe('implement-issues')
  expect(Date.parse(String(writes[1].body.pausedUntil))).toBeGreaterThan(Date.now())
  await page.screenshot({ path: 'test-results/behavior-v2-rows.png', fullPage: true })
})
