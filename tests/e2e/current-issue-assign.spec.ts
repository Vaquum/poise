import { expect, test, type Page } from './fixtures/classic'
import { workspace } from './fixtures/workspace'
import { feedback } from './fixtures/view-feedback'

const updated = new Date(Date.now() - 60_000).toISOString()
const issue = (number: number, title: string, state = 'open') => ({ kind: 'issue', repo: 'acme/Project', number, state, title,
  url: `https://github.com/acme/Project/issues/${number}`, created_at: updated, updated_at: updated, merged_at: null })
const RECORDS = [issue(1, 'Unassigned issue'), issue(2, 'Labelled issue'), issue(3, 'Issue with a pull request'), issue(4, 'Closed issue', 'closed')]

interface Intake {
  label: string | null
  labelled: string[]
  prs: Record<string, Array<{ number: number, url: string }>>
  errors: Array<{ org: string, error: string }>
}
const INTAKE: Intake = { label: 'poise', labelled: ['acme/project#2'], errors: [],
  prs: { 'acme/project#3': [{ number: 30, url: 'https://github.com/acme/Project/pull/30' }] } }

async function setup(page: Page, initial: Intake = INTAKE) {
  const state = { assigns: [] as Array<Record<string, unknown>>, intake: initial as Intake | number, assignStatus: 200, reads: 0, held: new Map<number, Promise<void>>() }
  await workspace(page)
  await page.route('**/api/repos', (route) => route.fulfill({ json: { repos: ['acme/Project'] } }))
  await page.route('**/api/gh', async (route) => {
    const body = route.request().postDataJSON()
    if (body?.operation === 'issue_intake') {
      state.reads += 1
      return typeof state.intake === 'number'
        ? route.fulfill({ status: state.intake, json: { error: 'datastore unavailable' } })
        : route.fulfill({ json: state.intake })
    }
    if (body?.operation === 'assign_issue') {
      state.assigns.push(body)
      await state.held.get(body.issue_number)
      return state.assignStatus === 200
        ? route.fulfill({ json: { label: 'poise' } })
        : route.fulfill({ status: state.assignStatus, json: { error: 'GitHub issue edit failed: denied' } })
    }
    return route.fulfill({ json: { records: body?.operation === 'list' ? RECORDS : [] } })
  })
  await page.reload()
  await expect(page.getByRole('link', { name: /Unassigned issue/ })).toBeVisible()
  return state
}

const card = (page: Page, title: string) => page.locator('.card-live').filter({ hasText: title })
const assignButton = (page: Page, number: number) => page.getByRole('button', { name: `Assign to Poise: acme/Project#${number}`, exact: true })
const tick = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
// Holds GitHub's answer for an issue until the returned function is called.
function hold(state: { held: Map<number, Promise<void>> }, number: number): () => void {
  let answer = () => {}
  state.held.set(number, new Promise<void>((resolve) => { answer = resolve }))
  return () => answer()
}

test('shows each open issue\'s intake state without hovering', async ({ page }) => {
  await setup(page)
  await expect(assignButton(page, 1)).toBeVisible()
  await expect(card(page, 'Unassigned issue')).toContainText('No open PR')
  await expect(card(page, 'Labelled issue').locator('.card-intake-label')).toHaveText('poise')
  await expect(assignButton(page, 2)).toHaveCount(0)
  // A pull request is shown, not refused: the label just waits.
  const link = card(page, 'Issue with a pull request').getByRole('link', { name: 'PR #30', exact: true })
  await expect(link).toHaveAttribute('href', 'https://github.com/acme/Project/pull/30')
  // The hover-revealed action strip must not sit on top of it.
  await card(page, 'Issue with a pull request').hover()
  await link.click({ trial: true })
  await expect(assignButton(page, 3)).toBeVisible()
  await expect(card(page, 'Closed issue').locator('.card-intake')).toHaveCount(0)
  await expect(page.locator('.card-link .card-intake-pr')).toHaveCount(0)
})

test('assigns an issue on GitHub and keeps showing it while the datastore catches up', async ({ page }) => {
  const state = await setup(page)
  await assignButton(page, 1).click()
  await expect(card(page, 'Unassigned issue').locator('.card-intake-label')).toHaveText('poise')
  await expect(assignButton(page, 1)).toHaveCount(0)
  await expect(card(page, 'Unassigned issue').locator('.card-link')).toBeFocused()
  expect(state.assigns).toEqual([{ operation: 'assign_issue', repository_full_name: 'acme/Project', issue_number: 1 }])

  // Stale for this issue; the new pull request proves the card repainted from it.
  state.intake = { ...INTAKE, prs: { ...INTAKE.prs, 'acme/project#1': [{ number: 10, url: 'https://github.com/acme/Project/pull/10' }] } }
  await tick(page)
  await expect(card(page, 'Unassigned issue').getByRole('link', { name: 'PR #10', exact: true })).toBeVisible()
  await expect(card(page, 'Unassigned issue').locator('.card-intake-label')).toHaveText('poise')

  // Once the datastore has reported it, the datastore is the only authority again.
  state.intake = { ...INTAKE, labelled: ['acme/project#1', 'acme/project#2'] }
  await tick(page)
  await expect(card(page, 'Unassigned issue').getByRole('link', { name: 'PR #10', exact: true })).toHaveCount(0)
  state.intake = INTAKE
  await tick(page)
  await expect(assignButton(page, 1)).toBeVisible()
  expect(state.assigns).toHaveLength(1)
})

test('returns focus to the card only for a user still on its button when GitHub answers', async ({ page }) => {
  const state = await setup(page)
  const answerFirst = hold(state, 1), answerSecond = hold(state, 3)
  const first = assignButton(page, 1), second = assignButton(page, 3)
  await first.click()
  await expect(first).toBeFocused()
  await expect(first).toBeDisabled()
  await first.click({ force: true })

  // Assigning another card while the first is still waiting.
  await second.click()
  answerFirst()
  await expect(card(page, 'Unassigned issue').locator('.card-intake-label')).toHaveText('poise')
  await expect(second).toBeFocused()
  answerSecond()
  await expect(card(page, 'Issue with a pull request').locator('.card-intake-label')).toHaveText('poise')
  await expect(card(page, 'Issue with a pull request').locator('.card-link')).toBeFocused()
  expect(state.assigns.map((body) => body.issue_number)).toEqual([1, 3])
})

test('leaves a user typing elsewhere undisturbed when GitHub answers', async ({ page }) => {
  const state = await setup(page)
  const answer = hold(state, 1)
  await assignButton(page, 1).click()
  const filter = page.getByRole('searchbox', { name: 'Filter cards' })
  await filter.focus()
  answer()
  await expect(card(page, 'Unassigned issue').locator('.card-intake-label')).toHaveText('poise')
  await expect(filter).toBeFocused()
})

test('does not scroll back to the card when GitHub answers', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 240 })
  const state = await setup(page)
  const answer = hold(state, 1)
  await assignButton(page, 1).click()
  const link = card(page, 'Unassigned issue').locator('.card-link')
  await page.mouse.wheel(0, 2000)
  await expect.poll(async () => (await link.boundingBox())?.y).toBeLessThan(0)
  answer()
  await expect(link).toBeFocused()
  expect((await link.boundingBox())?.y).toBeLessThan(0)
})

test('sends one assignment however the card repaints before GitHub answers', async ({ page }) => {
  const state = await setup(page)
  const answer = hold(state, 1)
  const button = assignButton(page, 1)
  await button.click()

  // The new pull request proves the intake read repainted the card.
  state.intake = { ...INTAKE, prs: { ...INTAKE.prs, 'acme/project#1': [{ number: 10, url: 'https://github.com/acme/Project/pull/10' }] } }
  await tick(page)
  await expect(card(page, 'Unassigned issue').getByRole('link', { name: 'PR #10', exact: true })).toBeVisible()
  await expect(button).toBeDisabled()
  await button.click({ force: true })

  // A failed read removes the row, so the button that comes back is a new element.
  state.intake = 500
  await tick(page)
  await expect(button).toHaveCount(0)
  state.intake = INTAKE
  await tick(page)
  await expect(button).toBeDisabled()
  await button.click({ force: true })

  answer()
  await expect(card(page, 'Unassigned issue').locator('.card-intake-label')).toHaveText('poise')
  await expect(await feedback(page, 'Current action needs attention')).toHaveCount(0)
  expect(state.assigns).toHaveLength(1)
})

test('makes a repainted control available again when the assignment fails', async ({ page }) => {
  const state = await setup(page)
  state.assignStatus = 502
  const answer = hold(state, 1)
  const button = assignButton(page, 1)
  await button.click()
  state.intake = 500
  await tick(page)
  await expect(button).toHaveCount(0)
  state.intake = INTAKE
  await tick(page)
  await expect(button).toBeDisabled()

  answer()
  await expect(await feedback(page, 'Current action needs attention')).toContainText('Could not assign acme/Project#1 to Poise')
  await expect(button).toBeEnabled()
})

test('reports a failed assignment and leaves the control available', async ({ page }) => {
  const state = await setup(page)
  state.assignStatus = 502
  await assignButton(page, 1).click()
  await expect(await feedback(page, 'Current action needs attention')).toContainText('Could not assign acme/Project#1 to Poise — GitHub issue edit failed: denied')
  await expect(assignButton(page, 1)).toBeEnabled()
  await expect(card(page, 'Unassigned issue').locator('.card-intake-label')).toHaveCount(0)
})

test('never presents an unread intake as unassigned or without a pull request', async ({ page }) => {
  const state = await setup(page, { label: 'poise', labelled: [], prs: {}, errors: [{ org: 'acme', error: 'references are incomplete' }] })
  await expect(await feedback(page, 'Current is not updating')).toContainText('acme: references are incomplete')
  await expect(page.locator('.card-intake')).toHaveCount(0)

  state.intake = 500
  await tick(page)
  await expect(await feedback(page, 'Current is not updating')).toContainText('Could not read which issues are assigned to Poise')
  await expect(page.locator('.card-intake')).toHaveCount(0)

  state.intake = INTAKE
  await tick(page)
  await expect(assignButton(page, 1)).toBeVisible()
  await expect(await feedback(page, 'Current is not updating')).toHaveCount(0)
})

test('offers no label or control when the chain takes every open issue', async ({ page }) => {
  await setup(page, { label: null, labelled: [], prs: {}, errors: [] })
  await expect(card(page, 'Unassigned issue').locator('.card-intake')).toHaveText('No open PR')
  await expect(page.locator('.card-assign-btn')).toHaveCount(0)
  await expect(page.locator('.card-intake-label')).toHaveCount(0)
})
