import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatastoreRecord } from '../server/gh'

// The Analytics view's numbers (server/analytics.ts): the window, each count,
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
const { computeAnalytics, computeHistory, parseBounds, parseWindow, readAnalytics, readAnalyticsHistory } = await import('../server/analytics')

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

describe('the periods of a history', () => {
  it('takes increasing zoned edges, exact to the millisecond', () => {
    expect(parseBounds('2026-10-01T00:00:00+03:00,2026-10-08T00:00:00.500Z')).toEqual(['2026-09-30T21:00:00.000Z', '2026-10-08T00:00:00.500Z'])
    expect(parseBounds(Array.from({ length: 80 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString()).join(','))).toHaveLength(80)
  })

  it('refuses missing, unzoned, empty, repeated, decreasing and too many edges', () => {
    for (const bad of [null, '', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00,2026-10-08T00:00:00Z', '2026-10-01T00:00:00Z,,2026-10-08T00:00:00Z',
      '2026-10-08T00:00:00Z,2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z,2026-10-01T00:00:00Z',
      Array.from({ length: 81 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString()).join(',')]) {
      expect(() => parseBounds(bad), String(bad)).toThrow()
    }
  })

  it('counts each period as a day is counted, every edge inclusive at the start', () => {
    const history = computeHistory({
      bounds: ['2026-09-28T00:00:00Z', '2026-10-05T00:00:00Z', '2026-10-12T00:00:00Z'],
      issues: [issue(1, '2026-09-28T00:00:00Z'), issue(2, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'), issue(3, '2026-10-12T00:00:00Z')],
      prs: [
        pr(1, '2026-09-28T00:00:00Z', '2026-09-28T06:00:00Z', { additions: 10, deletions: 0 }),
        pr(2, '2026-09-29T00:00:00Z', '2026-10-05T00:00:00Z', { additions: null, deletions: null }),
        pr(3, '2026-10-05T00:00:00Z', '2026-10-05T02:00:00Z', { additions: 1, deletions: 1 }),
      ],
    })
    expect(history.errors).toEqual([])
    expect(history.periods).toEqual([
      { since: '2026-09-28T00:00:00Z', until: '2026-10-05T00:00:00Z', issues: { opened: 1, closed: 0 },
        pullRequests: { merged: 1, lines: { total: 10, counted: 1 }, averageTimeToMergeMs: 6 * HOUR } },
      { since: '2026-10-05T00:00:00Z', until: '2026-10-12T00:00:00Z', issues: { opened: 1, closed: 1 },
        pullRequests: { merged: 2, lines: { total: 2, counted: 1 }, averageTimeToMergeMs: (6 * 24 * HOUR + 2 * HOUR) / 2 } },
    ])
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
    expect(report.pullRequests.medianTimeToMergeMs).toBe(4 * HOUR)
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

  it('takes the midpoint of the two central merge durations', () => {
    const report = computeAnalytics({ window: WEEK, issues: [], behaviors: [], prs: [
      pr(1, '2026-10-05T00:00:00Z', '2026-10-05T02:00:00Z'),
      pr(2, '2026-10-05T00:00:00Z', '2026-10-05T06:00:00Z'),
    ] })
    expect(report.pullRequests.medianTimeToMergeMs).toBe(4 * HOUR)
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
      agentAccount: null,
      issues: { opened: 0, closed: 0 },
      pullRequests: {
        opened: 0,
        closedUnmerged: 0,
        merged: 0,
        mergedByAgent: null,
        firstReview: { count: 0, medianMs: null },
        commentsPerPr: null,
        lines: { total: null, median: null, counted: 0 },
        behaviors: { perPr: null, approvals: 0, reviews: 0, changesRequested: 0 },
        averageTimeToMergeMs: null,
        medianTimeToMergeMs: null,
      },
      errors: [],
    })
  })

  it('counts pull requests opened and closed without merging inside the window', () => {
    const report = computeAnalytics({ window: WEEK, issues: [], behaviors: [], prs: [
      pr(1, '2026-10-05T00:00:00Z', null),                                              // opened on the first instant
      pr(2, '2026-10-06T00:00:00Z', '2026-10-07T00:00:00Z'),                            // opened, then merged
      { ...pr(3, '2026-10-01T00:00:00Z', null), status: 'closed', closed_at: '2026-10-08T00:00:00Z' },  // closed unmerged inside
      { ...pr(4, '2026-10-06T00:00:00Z', null), status: 'closed', closed_at: '2026-10-12T00:00:00Z' },  // closed on the end: outside
      pr(5, '2026-10-12T00:00:00Z', null),                                              // opened on the end: outside
    ] })
    expect(report.pullRequests.opened).toBe(3)
    expect(report.pullRequests.closedUnmerged).toBe(1)
    expect(report.pullRequests.merged).toBe(1)
  })

  it('times first reviews submitted in the window from each opening, to the millisecond', () => {
    const report = computeAnalytics({ window: WEEK, issues: [], behaviors: [], prs: [
      pr(1, '2026-10-05T00:00:00Z', null, { first_review_at: '2026-10-05T00:00:42Z' }),
      pr(2, '2026-10-04T23:00:00Z', null, { first_review_at: '2026-10-05T00:03:00Z' }),      // opened before, reviewed inside
      pr(3, '2026-10-06T00:00:00Z', null, { first_review_at: '2026-10-06T02:00:00.500Z' }),
      pr(4, '2026-10-01T00:00:00Z', null, { first_review_at: '2026-10-04T23:59:59.999Z' }),  // reviewed before the window
      pr(5, '2026-10-06T00:00:00Z', null, { first_review_at: null }),                        // not reviewed yet
    ] })
    expect(report.pullRequests.firstReview).toEqual({ count: 3, medianMs: 63 * 60_000 })
  })

  it('counts merges by the agent account without case, and does not guess without one', () => {
    const prs = [
      pr(1, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { merged_by: 'Robot' }),
      pr(2, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { merged_by: 'octocat' }),
      pr(3, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { merged_by: null }),
      pr(4, '2026-09-05T00:00:00Z', '2026-09-06T00:00:00Z', { merged_by: 'robot' }),      // merged before the window
    ]
    const report = computeAnalytics({ window: WEEK, issues: [], behaviors: [], prs, agent: 'robot' })
    expect(report.agentAccount).toBe('robot')
    expect(report.pullRequests.mergedByAgent).toBe(1)
    const unset = computeAnalytics({ window: WEEK, issues: [], behaviors: [], prs })
    expect(unset.agentAccount).toBeNull()
    expect(unset.pullRequests.mergedByAgent).toBeNull()
  })
})

describe('reading what Current shows', () => {
  let root: string
  const schema = readFileSync(resolve('caller/github_datastore/github_datastore/db.py'), 'utf8')
  function create(path: string) {
    const db = new Database(path)
    db.exec(schema.match(/SCHEMA = """([\s\S]*?)"""/)![1])
    db.exec(schema.match(/VIEW_SCHEMA = """([\s\S]*?)"""/)![1])
    db.prepare(`INSERT INTO repos VALUES (1, 'repo', 'alpha', 'app', 'alpha/app', 0, 0, 1, '{}', '2026-10-09T00:00:00Z')`).run()
    db.close()
  }
  function seed(row: DatastoreRecord, kind: 'pr' | 'issue', involved = false) {
    const db = new Database(mocks.orgs[0].datastorePath)
    try {
      db.prepare(`INSERT INTO items (node_id, repo_id, repo_full_name, number, item_type, state, title, author_login, created_at, updated_at, closed_at, raw_json, expanded_json, synced_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`).run(
        String(row.number), row.repo, row.number, kind, row.status, row.title, row.author, row.created_at, row.updated_at, row.closed_at,
        JSON.stringify({ pull: { graphql: { additions: row.additions, deletions: row.deletions }, merged_by: row.merged_by ? { login: row.merged_by } : null } }), row.updated_at,
      )
      const id = db.prepare<[], { item_id: number }>('SELECT max(item_id) AS item_id FROM items').get()!.item_id
      if (involved) {
        const insert = db.prepare(`INSERT INTO associations VALUES ('octocat', ?, ?, 'comment', ?, 'body', '', ?)`)
        insert.run(id, 'author', '1', row.created_at)
        insert.run(id, 'commenter', '2', row.created_at)
      }
      for (const [table, count] of [['comments', row.comments_count], ['review_comments', row.review_comments_count ?? 0]] as const) {
        const insert = db.prepare(`INSERT INTO ${table} (node_id, item_id, created_at, updated_at, raw_json) VALUES (?, ?, ?, ?, '{}')`)
        for (let i = 0; i < count; i++) insert.run(`${id}-${i}`, id, row.created_at, row.updated_at)
      }
      return id
    } finally { db.close() }
  }
  function review(itemId: number, author: string | null, state: string, submitted: string | null) {
    const db = new Database(mocks.orgs[0].datastorePath)
    try {
      db.prepare(`INSERT INTO reviews (node_id, item_id, author_login, state, submitted_at, raw_json) VALUES (?, ?, ?, ?, ?, '{}')`)
        .run(`review-${itemId}-${author}-${state}-${submitted}`, itemId, author, state, submitted)
    } finally { db.close() }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'analytics-reads-'))
    mocks.meta = { me: 'octocat', agentAccount: 'robot' }
    mocks.behaviors = []
    mocks.runFile.mockReset()
    mocks.orgs.forEach(org => {
      org.datastorePath = join(root, `${org.login}.sqlite`)
      org.status = 'ready'
      org.error = null
      create(org.datastorePath)
    })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function data() {
    seed(issue(7, '2026-10-06T00:00:00Z'), 'issue', true)
    seed(issue(8, '2026-10-06T00:00:00Z', null, 'alpha/app'), 'issue')
    seed({ ...issue(9, '2026-10-06T00:00:00Z'), author: 'robot' }, 'issue', true)
    seed(pr(1, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { additions: 10, deletions: 2, comments_count: 4 }), 'pr', true)
    seed(pr(2, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { author: 'robot', additions: 1, deletions: 1 }), 'pr')
    seed(pr(3, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { author: 'stranger', additions: 500 }), 'pr')
  }

  it('deduplicates involvement and agent authorship and reads PR sizes and comments without CLI processes', async () => {
    data()
    const report = await readAnalytics(WEEK)
    expect(report.issues.opened).toBe(2)
    expect(report.pullRequests.merged).toBe(2)
    expect(report.pullRequests.lines).toEqual({ total: 14, median: 7, counted: 2 })
    expect(report.pullRequests.commentsPerPr).toBe(2)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('reads first reviews by someone else, and who merged, from the stored pull requests', async () => {
    const reviewed = seed(pr(1, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { merged_by: 'robot' }), 'pr', true)
    // The author's own review and a review still pending are not a first review.
    review(reviewed, 'octocat', 'COMMENTED', '2026-10-05T00:00:05Z')
    review(reviewed, 'robot', 'PENDING', null)
    review(reviewed, 'robot', 'COMMENTED', '2026-10-05T00:00:42Z')
    review(reviewed, 'robot', 'APPROVED', '2026-10-05T00:09:00Z')
    seed(pr(2, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { merged_by: 'octocat' }), 'pr', true)
    seed({ ...pr(3, '2026-10-05T00:00:00Z', null), status: 'closed', closed_at: '2026-10-07T00:00:00Z' }, 'pr', true)
    const report = await readAnalytics(WEEK)
    expect(report.pullRequests.firstReview).toEqual({ count: 1, medianMs: 42_000 })
    expect(report.pullRequests).toMatchObject({ opened: 3, merged: 2, closedUnmerged: 1, mergedByAgent: 1 })
    expect(report.agentAccount).toBe('robot')
  })

  it('counts a first review on a pull request whose author account was deleted', async () => {
    const orphan = seed({ ...pr(1, '2026-10-05T00:00:00Z', null), author: null as unknown as string }, 'pr', true)
    review(orphan, 'robot', 'COMMENTED', '2026-10-05T00:00:30Z')
    const deleted = seed(pr(2, '2026-10-05T00:00:00Z', null), 'pr', true)
    review(deleted, null, 'APPROVED', '2026-10-05T00:02:00Z')
    expect((await readAnalytics(WEEK)).pullRequests.firstReview).toEqual({ count: 2, medianMs: 75_000 })
  })

  it('reads a history in one pass over every period, for the selected account', async () => {
    data()
    seed(pr(4, '2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z', { additions: 3, deletions: 3 }), 'pr', true)
    const bounds = ['2026-09-28T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z']
    const history = await readAnalyticsHistory(bounds, 'alpha')
    expect(history.periods.map((p) => [p.issues.opened, p.pullRequests.merged, p.pullRequests.lines])).toEqual([
      [0, 1, { total: 6, counted: 1 }],
      [2, 2, { total: 14, counted: 2 }],
    ])
    // The second period is the week the day report reads, and agrees with it.
    const week = await readAnalytics({ since: bounds[1], until: bounds[2] }, 'alpha')
    expect(history.periods[1].issues).toEqual(week.issues)
    expect(history.periods[1].pullRequests).toEqual({ merged: week.pullRequests.merged, lines: { total: week.pullRequests.lines.total, counted: week.pullRequests.lines.counted }, averageTimeToMergeMs: week.pullRequests.averageTimeToMergeMs })
    expect((await readAnalyticsHistory(bounds, 'beta')).periods.every((p) => p.pullRequests.merged === 0)).toBe(true)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('reads only the selected account, including all history for unbounded windows', async () => {
    data()
    expect((await readAnalytics({ since: null, until: null }, 'BETA')).pullRequests.merged).toBe(0)
    expect((await readAnalytics({ since: null, until: null }, 'alpha')).pullRequests.merged).toBe(2)
    mocks.meta.me = ''
    expect((await readAnalytics({ since: null, until: null }, 'alpha')).pullRequests.merged).toBe(3)
  })

  it('preserves exact millisecond boundaries after the CLI-compatible coarse filter', async () => {
    seed(issue(1, '2026-10-09T00:00:00.500Z'), 'issue', true)
    expect((await readAnalytics(parseWindow('2026-10-09T00:00:00.500Z', '2026-10-09T00:00:00.501Z'))).issues.opened).toBe(1)
    expect((await readAnalytics(parseWindow(null, '2026-10-09T00:00:00.500Z'))).issues.opened).toBe(0)
  })

  it('sees datastore writes immediately instead of caching previous reports', async () => {
    expect((await readAnalytics(WEEK)).issues.opened).toBe(0)
    seed(issue(1, '2026-10-06T00:00:00Z'), 'issue', true)
    expect((await readAnalytics(WEEK)).issues.opened).toBe(1)
  })

  it('names unreadable accounts, retains sync errors and fails when none are readable', async () => {
    rmSync(mocks.orgs[1].datastorePath)
    mocks.orgs[0].error = 'sync failed'
    const report = await readAnalytics(WEEK)
    expect(report.errors).toEqual([{ org: 'alpha', error: 'sync failed' }, { org: 'beta', error: expect.any(String) }])
    rmSync(mocks.orgs[0].datastorePath)
    await expect(readAnalytics(WEEK)).rejects.toThrow('alpha:')
  })

  it('rejects records belonging to another account', async () => {
    seed(pr(1, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', { repo: 'foreign/app' }), 'pr', true)
    await expect(readAnalytics(WEEK, 'alpha')).rejects.toThrow('datastore contains records outside alpha')
  })

  it('refuses to answer before any account is ready', async () => {
    mocks.orgs.forEach(org => { org.status = 'initializing' })
    await expect(readAnalytics(WEEK)).rejects.toThrow('No GitHub account is ready')
  })

  it('matches the previous Python view reads and measures the eliminated startup cost', async () => {
    data()
    const run = promisify(execFile)
    const python = `import sys\nsys.path.insert(0, sys.argv[1])\nfrom github_datastore import views\nprint(getattr(views, sys.argv[3])(db_path=sys.argv[2], updated_since_datetime=sys.argv[4], **__import__('json').loads(sys.argv[5])))`
    const start = performance.now()
    const old = await Promise.all([
      ['user', { username: 'octocat', item_type: 'issue' }], ['issue', { author: 'robot' }],
      ['user', { username: 'octocat', item_type: 'pr' }], ['pr', { author: 'robot' }], ['pr', {}],
    ].map(async ([view, filters]) => {
      const { stdout } = await run('python3', ['-c', python, resolve('caller/github_datastore'), mocks.orgs[0].datastorePath, String(view), WEEK.since, JSON.stringify(filters)])
      return JSON.parse(stdout) as DatastoreRecord[]
    }))
    const oldMs = performance.now() - start
    const expected = computeAnalytics({ window: WEEK,
      issues: [...new Map([...old[0], ...old[1]].map(row => [row.number, row])).values()],
      prs: old[4].filter(row => [...old[2], ...old[3]].some(scope => scope.number === row.number)), behaviors: [], agent: 'robot',
    })
    const directStart = performance.now()
    expect(await readAnalytics(WEEK, 'alpha')).toEqual(expected)
    const directMs = performance.now() - directStart
    console.info(`Analytics equivalent reads: Python ${oldMs.toFixed(1)} ms; direct SQLite ${directMs.toFixed(1)} ms`)
    expect(directMs).toBeLessThan(oldMs)
  })
})
