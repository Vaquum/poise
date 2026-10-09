import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatastoreRecord } from '../server/gh'

// The Analytics panel's numbers (server/analytics.ts): the window, each count,
// the per-PR numbers over the pull requests merged in the window, and reading
// exactly what Current shows from each account's datastore.

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  meta: {} as Record<string, string>,
  behaviors: [] as Array<{ repo: string, pr: number, action: string, completedAt: string }>,
  orgs: [
    { login: 'alpha', datastorePath: '/alpha.sqlite', status: 'ready', error: null as string | null },
    { login: 'beta', datastorePath: '/beta.sqlite', status: 'ready', error: null as string | null },
  ],
}))
vi.mock('../server/db', () => ({
  getMeta: (key: string) => mocks.meta[key] ?? null,
  setMeta: vi.fn(),
  listCompletedBehaviorActions: () => mocks.behaviors,
}))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, MAX_PROCESS_ARG_BYTES: 64 * 1024 }))
vi.mock('../server/organizations', () => ({
  getOrganizations: () => mocks.orgs,
  readyOrganizations: () => mocks.orgs.filter((org) => org.status === 'ready'),
  organizationArgs: (org: { datastorePath: string }, args: string[]) => ['--db', org.datastorePath, ...args],
}))
const { computeAnalytics, parseWindow, readAnalytics } = await import('../server/analytics')

const HOUR = 60 * 60 * 1000
const WEEK = { since: '2026-10-05T00:00:00Z', until: '2026-10-12T00:00:00Z' }

function issue(number: number, created: string, closed: string | null = null, repo = 'alpha/app'): DatastoreRecord {
  return {
    repo, number, status: closed ? 'closed' : 'open', author: 'octocat', title: `issue ${number}`,
    url: `https://github.com/${repo}/issues/${number}`, created_at: created, updated_at: closed ?? created,
    closed_at: closed, comments_count: 0,
  }
}

function pr(number: number, created: string, merged: string | null, extra: Partial<DatastoreRecord> = {}): DatastoreRecord {
  return {
    repo: 'alpha/app', number, status: merged ? 'merged' : 'open', author: 'octocat', title: `pr ${number}`,
    url: `https://github.com/alpha/app/pull/${number}`, created_at: created, updated_at: merged ?? created,
    closed_at: merged, comments_count: 0, review_comments_count: 0, additions: 0, deletions: 0, ...extra,
  }
}

describe('the window', () => {
  it('takes zoned times in UTC to the millisecond, and leaves absent bounds open', () => {
    expect(parseWindow('2026-10-08T21:00:00.000Z', '2026-10-09T21:00:00.250Z'))
      .toEqual({ since: '2026-10-08T21:00:00.000Z', until: '2026-10-09T21:00:00.250Z' })
    expect(parseWindow('2026-10-09T00:00:00+03:00', undefined)).toEqual({ since: '2026-10-08T21:00:00.000Z', until: null })
    expect(parseWindow(null, '')).toEqual({ since: null, until: null })
  })

  it('keeps a bound inside a second where it is: since stays inclusive and until exclusive', () => {
    const at = [issue(1, '2026-10-09T00:00:00Z'), issue(2, '2026-10-09T00:00:01Z')]
    const after = computeAnalytics({ window: parseWindow('2026-10-09T00:00:00.500Z', null), issues: at, prs: [], behaviors: [] })
    expect(after.issues.opened).toBe(1)
    const before = computeAnalytics({ window: parseWindow(null, '2026-10-09T00:00:00.500Z'), issues: at, prs: [], behaviors: [] })
    expect(before.issues.opened).toBe(1)
  })

  it('refuses a time without a zone, garbage and an empty window', () => {
    expect(() => parseWindow('2026-10-09T00:00:00', null)).toThrow('timezone')
    expect(() => parseWindow('yesterday', null)).toThrow('timezone')
    expect(() => parseWindow(null, ['2026-10-09T00:00:00Z'])).toThrow('timezone')
    expect(() => parseWindow('2026-10-09T00:00:00Z', '2026-10-09T00:00:00Z')).toThrow('before until')
  })
})

describe('the numbers', () => {
  it('counts issues opened and closed inside the window, since inclusive and until exclusive', () => {
    const report = computeAnalytics({
      window: WEEK,
      issues: [
        issue(1, '2026-10-05T00:00:00Z'),                          // opened on the first instant
        issue(2, '2026-10-01T00:00:00Z', '2026-10-06T00:00:00Z'),  // closed inside, opened before
        issue(3, '2026-10-12T00:00:00Z'),                          // opened on the end: outside
        issue(4, '2026-10-06T00:00:00Z', '2026-10-07T00:00:00Z'),  // both inside
        issue(5, '2026-10-01T00:00:00Z', '2026-10-04T23:59:59Z'),  // closed before
      ],
      prs: [],
      behaviors: [],
    })
    expect(report.issues).toEqual({ opened: 2, closed: 2 })
  })

  it('takes every per-PR number over the pull requests merged in the window', () => {
    const report = computeAnalytics({
      window: WEEK,
      issues: [],
      prs: [
        pr(1, '2026-10-05T00:00:00Z', '2026-10-05T02:00:00Z', { comments_count: 2, review_comments_count: 3, additions: 90, deletions: 10 }),
        pr(2, '2026-10-01T00:00:00Z', '2026-10-06T00:00:00Z', { comments_count: 1, review_comments_count: 0, additions: 5, deletions: 5 }),
        pr(3, '2026-10-06T00:00:00Z', '2026-10-06T04:00:00Z', { comments_count: 0, review_comments_count: 0, additions: 300, deletions: 200 }),
        // Not merged in the window: open, closed unmerged, merged before.
        pr(4, '2026-10-06T00:00:00Z', null, { comments_count: 50, additions: 9999 }),
        { ...pr(5, '2026-10-06T00:00:00Z', null), status: 'closed', closed_at: '2026-10-07T00:00:00Z', additions: 9999 },
        pr(6, '2026-09-01T00:00:00Z', '2026-10-04T00:00:00Z', { additions: 9999 }),
      ],
      behaviors: [],
    })
    expect(report.pullRequests.merged).toBe(3)
    expect(report.pullRequests.commentsPerPr).toBe(2)
    expect(report.pullRequests.lines).toEqual({ total: 610, median: 100, counted: 3 })
    // 2h, 5 days and 4h, averaged.
    expect(report.pullRequests.averageTimeToMergeMs).toBe((2 * HOUR + 120 * HOUR + 4 * HOUR) / 3)
  })

  it('takes the median of an even count as the middle pair, and leaves unsized pull requests out of it', () => {
    const report = computeAnalytics({
      window: { since: null, until: null },
      issues: [],
      prs: [
        pr(1, '2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', { additions: 10, deletions: 0 }),
        pr(2, '2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', { additions: 20, deletions: 0 }),
        pr(3, '2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', { additions: 25, deletions: 15 }),
        pr(4, '2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', { additions: 100, deletions: 0 }),
        // Stored before the datastore read sizes.
        pr(5, '2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', { additions: null, deletions: null }),
        pr(6, '2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', { additions: undefined, deletions: undefined }),
      ],
      behaviors: [],
    })
    expect(report.pullRequests.merged).toBe(6)
    expect(report.pullRequests.lines).toEqual({ total: 170, median: 30, counted: 4 })
  })

  it('says a size nobody read is unknown rather than zero', () => {
    const report = computeAnalytics({
      window: { since: null, until: null },
      issues: [],
      prs: [pr(1, '2026-10-05T00:00:00Z', '2026-10-05T01:00:00Z', { additions: null, deletions: null })],
      behaviors: [],
    })
    expect(report.pullRequests.lines).toEqual({ total: null, median: null, counted: 0 })
  })

  it('counts the reviews and approvals behaviors completed on the merged pull requests', () => {
    const report = computeAnalytics({
      window: WEEK,
      issues: [],
      prs: [
        pr(1, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'),
        pr(2, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'),
        pr(3, '2026-10-05T00:00:00Z', null),
      ],
      behaviors: [
        { repo: 'alpha/app', pr: 1, action: 'requested_changes', completedAt: '2026-10-05T01:00:00Z' },
        { repo: 'alpha/app', pr: 1, action: 'reviewed_clean', completedAt: '2026-10-05T03:00:00Z' },
        // Repository names compare without case, as GitHub does.
        { repo: 'Alpha/App', pr: 1, action: 'approved', completedAt: '2026-10-05T04:00:00Z' },
        { repo: 'alpha/app', pr: 2, action: 'reviewed_clean', completedAt: '2026-10-05T01:00:00Z' },
        // Work on a pull request not merged in the window, or in another repository.
        { repo: 'alpha/app', pr: 3, action: 'approved', completedAt: '2026-10-05T01:00:00Z' },
        { repo: 'alpha/other', pr: 2, action: 'approved', completedAt: '2026-10-05T01:00:00Z' },
      ],
    })
    expect(report.pullRequests.behaviors).toEqual({ perPr: 2, approvals: 1, reviews: 2, changesRequested: 1 })
  })

  it('reports an empty range as zero counts and no averages', () => {
    const report = computeAnalytics({ window: WEEK, issues: [], prs: [], behaviors: [] })
    expect(report).toEqual({
      window: WEEK,
      issues: { opened: 0, closed: 0 },
      pullRequests: {
        merged: 0,
        commentsPerPr: null,
        lines: { total: null, median: null, counted: 0 },
        behaviors: { perPr: null, approvals: 0, reviews: 0, changesRequested: 0 },
        averageTimeToMergeMs: null,
      },
      errors: [],
    })
  })
})

describe('reading what Current shows', () => {
  // Answers per (database, view, scope) the way github-datastore would.
  function datastore(rows: Record<string, DatastoreRecord[]>) {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      const db = args[1]
      const view = args.slice(3, args.indexOf('--format')).filter((arg, i, all) => arg !== '--updated-since-datetime' && all[i - 1] !== '--updated-since-datetime')
      const key = `${db} ${view.join(' ')}`
      if (!(key in rows)) throw new Error(`unexpected read: ${key}`)
      return { stdout: JSON.stringify(rows[key]), stderr: '' }
    })
  }

  beforeEach(() => {
    mocks.meta = { me: 'octocat', agentAccount: 'robot' }
    mocks.behaviors = []
    mocks.runFile.mockReset()
    mocks.orgs.forEach((org) => { org.status = 'ready'; org.error = null })
  })

  it('counts what the person is involved in and what the agent opened, with sizes from the PR view', async () => {
    const mine = pr(1, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { additions: 10, deletions: 2, comments_count: 4 })
    const agents = pr(2, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { author: 'robot', additions: 1, deletions: 1 })
    const someoneElses = pr(3, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { author: 'stranger', additions: 500, deletions: 0 })
    // views.user carries neither comment counts nor sizes.
    const mineInUserView = { ...mine, comments_count: undefined as unknown as number, additions: undefined, deletions: undefined }
    datastore({
      '/alpha.sqlite user --username octocat --item-type issue': [issue(7, '2026-10-06T00:00:00Z')],
      '/alpha.sqlite issue --author robot': [issue(7, '2026-10-06T00:00:00Z'), issue(8, '2026-10-06T00:00:00Z')],
      '/alpha.sqlite user --username octocat --item-type pr': [mineInUserView],
      '/alpha.sqlite pr --author robot': [agents],
      '/alpha.sqlite pr': [mine, agents, someoneElses],
      '/beta.sqlite user --username octocat --item-type issue': [],
      '/beta.sqlite issue --author robot': [],
      '/beta.sqlite user --username octocat --item-type pr': [],
      '/beta.sqlite pr --author robot': [],
      '/beta.sqlite pr': [],
    })
    const report = await readAnalytics(WEEK)
    expect(report.issues.opened).toBe(2)
    expect(report.pullRequests.merged).toBe(2)
    expect(report.pullRequests.lines).toEqual({ total: 14, median: 7, counted: 2 })
    expect(report.pullRequests.commentsPerPr).toBe(2)
    // The datastore narrows to what changed since the window began.
    for (const call of mocks.runFile.mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(['--updated-since-datetime', WEEK.since, '--format', 'json']))
    }
  })

  it('reads only the selected account, and every pull request when Any time is picked', async () => {
    datastore({
      '/beta.sqlite user --username octocat --item-type issue': [],
      '/beta.sqlite issue --author robot': [],
      '/beta.sqlite user --username octocat --item-type pr': [],
      '/beta.sqlite pr --author robot': [],
      '/beta.sqlite pr': [],
    })
    await readAnalytics({ since: null, until: null }, 'BETA')
    expect(mocks.runFile.mock.calls.every((call) => call[1][1] === '/beta.sqlite')).toBe(true)
    expect(mocks.runFile.mock.calls.some((call) => call[1].includes('--updated-since-datetime'))).toBe(false)
  })

  it('names an account it could not read, and fails when it could read none', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[1] === '/beta.sqlite') throw new Error('offline')
      return { stdout: '[]', stderr: '' }
    })
    const report = await readAnalytics(WEEK)
    expect(report.errors).toEqual([{ org: 'beta', error: 'offline' }])
    mocks.runFile.mockRejectedValue(new Error('offline'))
    await expect(readAnalytics(WEEK)).rejects.toThrow('alpha: offline; beta: offline')
  })

  it('refuses to answer before any account is ready', async () => {
    mocks.orgs.forEach((org) => { org.status = 'initializing' })
    await expect(readAnalytics(WEEK)).rejects.toThrow('No GitHub account is ready')
  })
})
