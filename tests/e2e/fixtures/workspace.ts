import { BEHAVIORS } from '../../../src/behaviors'
import type { Page } from '@playwright/test'

export async function workspace(page: Page, view = 'current', fontResponse?: Promise<void>, options: { preserveOnReload?: boolean; realLogging?: boolean; realExtensions?: boolean; path?: string; timezone?: string } = {}): Promise<void> {
  await page.addInitScript(({ view, preserveOnReload }) => {
    if (preserveOnReload && sessionStorage.getItem('poise-workspace-initialized')) return
    localStorage.clear()
    localStorage.setItem('poise-view', view)
    sessionStorage.setItem('poise-workspace-initialized', '1')
  }, { view, preserveOnReload: options.preserveOnReload })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, async route => {
    if (!fontResponse) return route.abort()
    await fontResponse
    await route.fulfill({ contentType: 'text/css', body: '' })
  })
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (options.realLogging && path.startsWith('/api/logging')) return route.continue()
    if (options.realExtensions && path.startsWith('/api/extensions')) return route.continue()
    const organizations = [{ login: 'acme', managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: '2026-10-01T08:00:00Z' }]
    if (path === '/api/settings') return route.fulfill({ json: { org: 'acme', me: 'octocat', agentAccount: 'octo-agent', timezone: options.timezone ?? 'UTC', organizations, models: {} } })
    if (path === '/api/organizations') return route.fulfill({ json: { organizations } })
    if (path === '/api/workspace') return route.fulfill({ json: { mode: 'local' } })
    if (path === '/api/current') return route.fulfill({ json: { cards: [] } })
    if (path === '/api/repos') return route.fulfill({ json: { repos: [] } })
    if (path === '/api/gh') return route.fulfill({ json: { records: [], count: 0, errors: [] } })
    if (path === '/api/behavior-metrics') return route.fulfill({ json: { behaviors: Object.fromEntries(BEHAVIORS.map(({ key }) => [key, null])), error: null } })
    if (path === '/api/agent-logs') return route.fulfill({ json: { logs: [] } })
    if (path === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    if (path === '/api/notices') return route.fulfill({ json: { enabled: false, notices: [] } })
    if (path === '/api/publishing/sites') return route.fulfill({ json: { sites: [] } })
    if (path === '/api/google/accounts') return route.fulfill({ json: { configured: false, accounts: [] } })
    if (/^\/api\/editor\/doc\/[^/]+\/reviews(?:\/sync)?$/.test(path)) return route.fulfill({ json: { reviews: [], checkedAt: null, active: false, stale: false, problems: [] } })
    if (path === '/api/accounts') return route.fulfill({ json: { accounts: [
      { id: 'codex', installed: true, version: '1.2.3', signedIn: true, identity: 'person@example.test', detail: null, login: { label: 'codex login --device-auth' } },
      { id: 'gh', installed: true, version: '2.92.0', signedIn: true, identity: 'octocat', detail: null, login: { label: 'gh auth login --web' }, accounts: [{ login: 'octocat', active: true, signedIn: true, detail: null }] },
    ] } })
    if (path === '/api/models') return route.fulfill({ json: {
      catalog: { models: [{ identity: 'opus-5-max', provider: 'claude', selector: 'opus', effort: 'max' }, { identity: 'gpt-6-astra-max', provider: 'codex', selector: 'gpt-6-astra', effort: 'max' }], review_providers: [], path: '' },
      places: [{ key: 'chat', label: 'Chat', why: 'The default model for new chats.', review: false, reviewers: false, default: 'opus-5-max', fallback: 'gpt-6-astra-max', notes: [], stored: null }],
      fixed: [], presets: [], refresh: null,
    } })
    if (path === '/api/analytics') return route.fulfill({ json: {
      window: { since: null, until: null }, agentAccount: 'octo-agent', issues: { opened: 12, closed: 9 },
      pullRequests: { opened: 5, closedUnmerged: 1, merged: 4, mergedByAgent: 3, firstReview: { count: 3, medianMs: 75_000 }, commentsPerPr: 3.25, lines: { total: 4210, median: 180, counted: 3 }, behaviors: { perPr: 2, approvals: 4, reviews: 4, changesRequested: 0 }, averageTimeToMergeMs: 27 * 3_600_000, medianTimeToMergeMs: 6 * 3_600_000 }, errors: [],
    } })
    return route.fulfill({ json: {} })
  })
  await page.goto(options.path ?? '/', { waitUntil: fontResponse ? 'domcontentloaded' : 'load' })
}

