import { feedback } from './fixtures/view-feedback'
import { expect, test } from '@playwright/test'
import { workspace } from './fixtures/workspace'

const failedRun = {
  kind: 'action', repo: 'acme/site', number: 42, title: 'Deploy · Release after merge',
  url: 'https://github.com/acme/site/actions/runs/42', author: 'octocat', state: 'failure',
  branch: 'main', event: 'push', updated_at: '2026-10-14T08:00:00Z',
}

for (const width of [1280, 1920]) {
  test(`failed Actions are the default and Archive follows Swarm at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const requests: Record<string, unknown>[] = []
    await workspace(page, 'swarm')
    const swarmBox = await page.locator('#view-swarm main').boundingBox()
    await page.route('**/api/gh', route => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      requests.push(body)
      return route.fulfill({ json: body.count_only ? { count: 1 } : { records: [failedRun], count: 1 } })
    })
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(page.locator('#tbody')).toContainText('Deploy · Release after merge')
    expect(requests.every(body => body.operation === 'actions' && body.record_state === 'failed')).toBe(true)
    await expect(page.locator('#filter-type [data-filter="action"]')).toHaveClass('active')
    await expect(page.locator('#filter-action-status [data-action-status="failed"]')).toHaveClass('active')
    await expect(page.locator('#tbody .agent-org')).toHaveText('acme')
    await expect(page.locator('#tbody .repo-name')).toHaveText('site')
    await expect(page.locator('#tbody .repo-name')).toHaveAttribute('title', 'acme/site')
    await expect(page.locator('#tbody .title-cell a')).toHaveAttribute('href', failedRun.url)
    await expect(page.locator('#tbody .branch-cell')).toHaveText('main')
    await expect(page.locator('#tbody .agent-status.bad')).toHaveText('Failure')
    await expect(page.locator('#tbody .review-btn')).toHaveCount(0)
    const archiveBox = await page.locator('#view-main main').boundingBox()
    expect(archiveBox!.x).toBeCloseTo(swarmBox!.x)
    expect(archiveBox!.width).toBeCloseTo(swarmBox!.width)
    expect(await page.locator('#table th').first().evaluate(el => getComputedStyle(el).position)).toBe('sticky')
    await page.screenshot({ path: `test-results/archive-actions-${width}.png` })
  })
}

test('outcomes, issue history and persistent filters remain selectable', async ({ page }) => {
  await workspace(page, 'swarm', undefined, { preserveOnReload: true })
  await page.route('**/api/gh', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    const action = body.operation === 'actions'
    const records = action ? [{ ...failedRun, state: body.record_state === 'all' ? 'success' : 'failure' }]
      : [{ ...failedRun, kind: 'issue', state: 'open', title: 'Issue history', url: 'https://github.com/acme/site/issues/42', owner_login: null, owner_avatar: null, merged_at: null }]
    return route.fulfill({ json: body.count_only ? { count: 1 } : { records, count: records.length } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.locator('#filter-action-status [data-action-status="all"]').click()
  await expect(page.locator('#tbody .agent-status.ok')).toHaveText('Success')
  await page.locator('#filter-type [data-filter="issue"]').click()
  await page.locator('#filter-type [data-filter="action"]').click()
  await expect(page.locator('#tbody')).toContainText('Issue history')
  await expect(page.locator('#table .col-owner')).toHaveText('Owner')
  await expect(page.locator('#filter-action-status [data-action-status="failed"]')).toBeHidden()
  await page.reload()
  await expect(page.locator('#tbody')).toContainText('Issue history')
  await page.locator('#filter-type [data-filter="action"]').click()
  await page.locator('#filter-action-status [data-action-status="failed"]').click()
  await expect(page.locator('#tbody .agent-status.bad')).toHaveText('Failure')
})

test('snapshot limits stay out of Archive while failed refreshes and recovery remain visible', async ({ page }) => {
  await workspace(page, 'swarm')
  let failed = false
  let recovered = false
  await page.route('**/api/gh', route => {
    if (failed) return route.fulfill({ status: 502, json: { error: 'Actions offline' } })
    const body = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({ json: {
      ...(body.count_only ? { count: recovered ? 0 : 1 } : { records: recovered ? [] : [failedRun], count: recovered ? 0 : 1 }),
      warnings: recovered ? [] : ['acme/site: showing the latest 100 of 130 failed runs. Open GitHub for older runs.'],
    } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.locator('#tbody')).toContainText('Deploy')
  await expect(page.locator('#view-main')).not.toContainText('showing the latest')
  await expect((await feedback(page)).locator('.nr-card').filter({ hasText: 'Archive data is incomplete' })).toHaveCount(0)
  failed = true
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(await feedback(page)).toContainText('Not updating')
  await expect(page.locator('#tbody')).toContainText('Deploy')
  failed = false
  recovered = true
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(page.locator('#tbody tr')).toHaveCount(0)
  await expect((await feedback(page)).locator('.nr-card').filter({ hasText: 'Archive data is incomplete' })).toHaveCount(0)
})

for (const width of [390, 1280]) test(`fourteen repository snapshot limits produce no Archive notices at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await workspace(page, 'swarm')
  const warnings = Array.from({ length: 14 }, (_, i) => `acme/repository-${i}: showing the latest 100 of ${130 + i} failed runs. Open GitHub for older runs.`)
  await page.route('**/api/gh', route => {
    const action = route.request().postDataJSON().operation === 'actions'
    return route.fulfill({ json: { records: action ? [failedRun] : [], count: action ? 1 : 0,
      warnings: action ? warnings : [], errors: action ? [{ org: 'beta', error: 'Repository unavailable' }] : [] } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.locator('#tbody')).toContainText('Deploy')
  await expect(await feedback(page)).toContainText('Repository unavailable')
  await expect(page.locator('#view-main')).not.toContainText('showing the latest')
  await expect(page.locator('#view-main')).not.toContainText('Open GitHub for older runs')
  await expect(page.locator('#main-history-notice')).toHaveCount(0)
  await page.screenshot({ path: `test-results/archive-notices-${width}.png` })
})


test('empty Actions stay free of messages and account changes while hidden do not read workflows', async ({ page }) => {
  await workspace(page, 'main')
  await expect(page.locator('#empty')).toHaveCount(0)
  await expect(page.locator('#view-main')).not.toContainText('No failed workflow runs')
  let reads = 0
  await page.route('**/api/gh', route => { reads++; return route.fulfill({ json: { records: [], count: 0 } }) })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:organization-filter-changed')))
  await page.waitForTimeout(150)
  expect(reads).toBe(0)
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect.poll(() => reads).toBeGreaterThan(0)
})


test('returning to Archive resumes pagination after a hidden page finishes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 })
  await workspace(page, 'swarm')
  let releaseInitial!: () => void
  let releaseRefresh!: () => void
  const initial = new Promise<void>(resolve => { releaseInitial = resolve })
  const refresh = new Promise<void>(resolve => { releaseRefresh = resolve })
  let firstPageReads = 0
  await page.route('**/api/gh', async route => {
    const body = route.request().postDataJSON() as { count_only?: boolean, offset: number }
    if (body.count_only) return route.fulfill({ json: { count: 40 } })
    if (body.offset === 0) {
      firstPageReads++
      await (firstPageReads === 1 ? initial : refresh)
    }
    return route.fulfill({ json: { count: 40, records: Array.from({ length: 20 }, (_, i) => ({ ...failedRun, number: body.offset + i + 1 })) } })
  })
  try {
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect.poll(() => firstPageReads).toBe(1)
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    const hiddenPage = page.waitForResponse(response => response.url().endsWith('/api/gh') && response.request().postDataJSON().offset === 0 && !response.request().postDataJSON().count_only)
    releaseInitial()
    await (await hiddenPage).finished()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // Hidden views retain the response without spending layout work painting it.
    await expect(page.locator('#tbody tr')).toHaveCount(0)
    await expect(page.locator('#loader')).toBeHidden()
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect.poll(() => firstPageReads).toBe(2)
    // Let the sentinel's entrance notification occur while refresh is pending.
    await page.waitForTimeout(150)
    releaseRefresh()
    await expect(page.locator('#tbody tr')).toHaveCount(40)
  } finally { releaseInitial(); releaseRefresh() }
})

const pullRequest = { ...failedRun, kind: 'pr', number: 9, title: 'A pull request',
  url: 'https://github.com/acme/site/pull/9', state: 'open', owner_login: null, owner_avatar: null, merged_at: null }

test('type toggles combine independently, retain rows and persist without including issues in PR', async ({ page }) => {
  await workspace(page, 'swarm', undefined, { preserveOnReload: true })
  let prReads = 0
  await page.route('**/api/gh', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    const action = body.operation === 'actions'
    if (!action) {
      expect(body.record_type).toBe('pull_request')
      prReads++
    }
    return route.fulfill({ json: { records: [action ? failedRun : pullRequest], count: 1 } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.locator('#tbody tr')).toHaveCount(1)
  await page.getByRole('button', { name: 'PR', exact: true }).click()
  await expect(page.locator('#tbody tr')).toHaveCount(2)
  await expect(page.locator('[data-filter="action"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-filter="pr"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#count')).toHaveText('2 / 2')
  const reads = prReads
  await page.getByRole('button', { name: 'PR', exact: true }).click()
  await expect(page.locator('#tbody tr')).toHaveCount(1)
  const elapsed = await page.evaluate(() => new Promise<number>(resolve => {
    const start = performance.now()
    document.querySelector<HTMLButtonElement>('[data-filter="pr"]')!.click()
    requestAnimationFrame(() => resolve(performance.now() - start))
  }))
  await expect(page.locator('#tbody tr')).toHaveCount(2)
  expect(prReads).toBe(reads)
  expect(elapsed).toBeLessThan(200)
  console.log(`Archive cached PR toggle: ${elapsed.toFixed(1)}ms; no new request`)
  await page.reload()
  await expect(page.locator('[data-filter="action"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-filter="pr"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#tbody tr')).toHaveCount(2)
})

test('a pending Actions scan does not delay PR paint and its loader actually animates', async ({ page }) => {
  await workspace(page, 'swarm')
  let pending = true
  await page.route('**/api/gh', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    const action = body.operation === 'actions'
    return route.fulfill({ json: { records: action ? pending ? [] : [failedRun] : [pullRequest], count: 1, pending: action && pending } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.locator('#loader')).toBeVisible()
  const times = await page.locator('#loader span').first().evaluate(async element => {
    const animation = element.getAnimations()[0]
    if (!animation) return []
    const before = Number(animation.currentTime)
    await new Promise(resolve => setTimeout(resolve, 80))
    return [before, Number(animation.currentTime)]
  })
  expect(times).toHaveLength(2)
  expect(times[1]).toBeGreaterThan(times[0])
  const start = Date.now()
  await page.getByRole('button', { name: 'PR', exact: true }).click()
  await expect(page.locator('#tbody')).toContainText('A pull request', { timeout: 1000 })
  console.log(`Archive PR paint with Actions pending: ${Date.now() - start}ms`)
  await expect(page.locator('#loader')).toBeVisible()
  pending = false
  await expect(page.locator('#tbody tr')).toHaveCount(2)
  await expect(page.locator('#loader')).toBeHidden()
})

for (const width of [390, 768, 1280]) test(`Any/Open controls fit completely at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await workspace(page, 'main')
  await page.getByRole('button', { name: 'PR', exact: true }).click()
  await expect(page.locator('#filter-status')).toBeVisible()
  for (const status of ['all', 'open']) {
    const button = page.locator(`#filter-status [data-status="${status}"]`)
    await expect(button).toBeVisible()
    expect(await button.evaluate(element => {
      const box = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect()
      return element.scrollWidth <= element.clientWidth && box.left >= parent.left && box.right <= parent.right + 1 && box.right <= innerWidth
    })).toBe(true)
  }
  await page.screenshot({ path: `test-results/archive-filters-${width}.png` })
})


test('history pagination proceeds while its full count is pending', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 })
  await workspace(page, 'swarm')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const offsets: number[] = []
  await page.route('**/api/gh', async route => {
    const body = route.request().postDataJSON() as { operation: string, count_only?: boolean, offset?: number }
    if (body.operation === 'actions') return route.fulfill({ json: { records: [], count: 0 } })
    if (body.count_only) { await held; return route.fulfill({ json: { count: 21 } }) }
    const offset = body.offset ?? 0
    offsets.push(offset)
    const records = Array.from({ length: offset === 0 ? 20 : offset === 20 ? 1 : 0 }, (_, i) => ({ ...pullRequest, number: offset + i + 1 }))
    return route.fulfill({ json: { records } })
  })
  try {
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await page.getByRole('button', { name: 'PR', exact: true }).click()
    await expect(page.locator('#tbody tr')).toHaveCount(21)
    expect(offsets).toEqual([0, 20])
    release()
    await expect(page.locator('#count')).toHaveText('21 / 21')
  } finally { release() }
})


test('paging preserves an already completed full-history count', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 300 })
  await workspace(page, 'swarm')
  await page.route('**/api/gh', route => {
    const body = route.request().postDataJSON() as { operation: string, count_only?: boolean, offset?: number }
    if (body.operation === 'actions') return route.fulfill({ json: { records: [], count: 0 } })
    if (body.count_only) return route.fulfill({ json: { count: 21 } })
    const offset = body.offset ?? 0
    return route.fulfill({ json: { records: Array.from({ length: offset === 0 ? 20 : offset === 20 ? 1 : 0 }, (_, i) => ({ ...pullRequest, number: offset + i + 1 })) } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.getByRole('button', { name: 'PR', exact: true }).click()
  await expect(page.locator('#count')).toHaveText('20 / 21')
  await page.locator('#main-sentinel').evaluate(element => element.scrollIntoView())
  await expect(page.locator('#tbody tr')).toHaveCount(21)
  await expect(page.locator('#count')).toHaveText('21 / 21')
})

test('re-enabling an unfinished cached source resumes paging without another observer entrance', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 })
  await workspace(page, 'swarm')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const offsets: number[] = []
  await page.route('**/api/gh', async route => {
    const body = route.request().postDataJSON() as { operation: string, count_only?: boolean, offset?: number }
    if (body.operation === 'actions') return route.fulfill({ json: { records: [failedRun], count: 1 } })
    if (body.count_only) return route.fulfill({ json: { count: 21 } })
    const offset = body.offset ?? 0
    offsets.push(offset)
    if (!offset) await held
    return route.fulfill({ json: { records: Array.from({ length: offset === 0 ? 20 : 1 }, (_, i) => ({ ...pullRequest, number: offset + i + 1 })) } })
  })
  try {
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await page.getByRole('button', { name: 'PR', exact: true }).click()
    await expect.poll(() => offsets.length).toBe(1)
    await page.getByRole('button', { name: 'PR', exact: true }).click()
    const finished = page.waitForResponse(response => response.url().endsWith('/api/gh') && response.request().postDataJSON().record_type === 'pull_request' && !response.request().postDataJSON().count_only)
    release()
    await (await finished).finished()
    await page.getByRole('button', { name: 'PR', exact: true }).click()
    await expect(page.locator('#tbody tr')).toHaveCount(22)
    expect(offsets).toEqual([0, 20])
  } finally { release() }
})

test('healthy-source pagination cannot restart an exhausted failed source', async ({ page }) => {
  // This case owns its refresh ticks. Crossing a real minute boundary can
  // legitimately admit another scheduled refresh after exhaustion.
  await page.clock.setFixedTime(new Date('2026-10-09T12:00:01Z'))
  await page.setViewportSize({ width: 1280, height: 300 })
  await workspace(page, 'swarm')
  let actionsReads = 0
  await page.route('**/api/gh', route => {
    const body = route.request().postDataJSON() as { operation: string, count_only?: boolean, offset?: number }
    if (body.operation === 'actions') { actionsReads++; return route.fulfill({ status: 502, json: { error: 'Actions offline' } }) }
    if (body.count_only) return route.fulfill({ json: { count: 60 } })
    const offset = body.offset ?? 0
    return route.fulfill({ json: { records: Array.from({ length: 20 }, (_, i) => ({ ...pullRequest, number: offset + i + 1 })) } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(await feedback(page)).toContainText('Github 502')
  await page.getByRole('button', { name: 'PR', exact: true }).click()
  await expect(page.locator('#count')).toContainText('20')
  while (actionsReads < 5) {
    const response = page.waitForResponse(response => response.url().endsWith('/api/gh') && response.request().postDataJSON().operation === 'actions')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
    await (await response).finished()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
  }
  await page.setViewportSize({ width: 1280, height: 2400 })
  await expect(page.locator('#tbody tr')).toHaveCount(60)
  await page.waitForTimeout(100)
  expect(actionsReads).toBe(5)
})

test('changing GitHub identity cannot reuse another identity\'s cached outcome', async ({ page }) => {
  await workspace(page, 'swarm')
  let me = 'octocat'
  await page.route('**/api/settings', route => {
    if (route.request().method() === 'POST') me = route.request().postDataJSON().me
    return route.fulfill({ json: { org: 'acme', me, agentAccount: 'octo-agent', timezone: 'UTC', models: {} } })
  })
  await page.route('**/api/gh', route => route.fulfill({ json: { records: [{ ...failedRun, title: `${me} workflow` }], count: 1 } }))
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.locator('[data-action-status="all"]').click()
  await expect(page.locator('#tbody')).toContainText('octocat workflow')
  await page.locator('[data-action-status="failed"]').click()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-settings="general"]').click()
  await page.getByLabel('Your GitHub account', { exact: true }).fill('new-owner')
  await page.locator('.st-save').click()
  await expect(page.locator('.st-status')).toHaveText('Saved.')
  await page.keyboard.press('Escape')
  await page.locator('[data-action-status="all"]').click()
  await expect(page.locator('#tbody')).toContainText('new-owner workflow')
  await expect(page.locator('#tbody')).not.toContainText('octocat workflow')
})


test('retained unchanged rows refresh their displayed age without replacing the row', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-14T08:01:00Z'))
  await workspace(page, 'swarm')
  await page.route('**/api/gh', route => route.fulfill({ json: { records: [failedRun], count: 1 } }))
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  const date = page.locator('#tbody .date')
  await expect(date).toHaveText('1m')
  const row = await page.locator('#tbody tr').elementHandle()
  await page.clock.setFixedTime(new Date('2026-10-14T08:02:00Z'))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(date).toHaveText('2m')
  expect(await row!.evaluate(element => element.isConnected && element === document.querySelector('#tbody tr'))).toBe(true)
})


test('a persistently failing later page retries that page and stops after its retry budget', async ({ page }) => {
  // Keep the wall-clock refresh outside this retry window.
  await page.clock.setFixedTime(new Date('2026-10-14T08:00:01Z'))
  await page.setViewportSize({ width: 1280, height: 1400 })
  await workspace(page, 'swarm')
  let firstPages = 0, failedPages = 0
  await page.route('**/api/gh', route => {
    const body = route.request().postDataJSON() as { operation: string, count_only?: boolean, offset?: number }
    if (body.operation === 'actions') return route.fulfill({ json: { records: [], count: 0 } })
    if (body.count_only) return route.fulfill({ json: { count: 40 } })
    if (body.offset) { failedPages++; return route.fulfill({ status: 502, json: { error: 'Later page unavailable' } }) }
    firstPages++
    return route.fulfill({ json: { records: Array.from({ length: 20 }, (_, i) => ({ ...pullRequest, number: i + 1 })) } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.getByRole('button', { name: 'PR', exact: true }).click()
  await expect.poll(() => failedPages, { timeout: 22_000 }).toBe(5)
  await page.waitForTimeout(1200)
  expect(failedPages).toBe(5)
  expect(firstPages).toBe(1)
  await expect(page.locator('#tbody tr')).toHaveCount(20)
})

test('adding a type preserves scheduled recovery for another selected source', async ({ page }) => {
  await workspace(page, 'swarm')
  let reads = 0
  await page.route('**/api/gh', route => {
    const body = route.request().postDataJSON() as { operation: string }
    if (body.operation !== 'actions') return route.fulfill({ json: { records: [pullRequest], count: 1 } })
    if (++reads === 2) return route.fulfill({ status: 502, json: { error: 'Temporary failure' } })
    return route.fulfill({ json: { records: [{ ...failedRun, title: reads > 2 ? 'Recovered workflow' : failedRun.title }], count: 1 } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.locator('#tbody')).toContainText(failedRun.title)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(await feedback(page)).toContainText('Github 502')
  await page.getByRole('button', { name: 'PR', exact: true }).click()
  await expect(page.locator('#tbody')).toContainText('Recovered workflow', { timeout: 4000 })
  expect(reads).toBe(3)
})
