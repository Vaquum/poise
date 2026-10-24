import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishRecord } from '../server/editor'
import type { PublicationReviewList } from '../server/publishing-reviews'

const mocks = vi.hoisted(() => ({ query: vi.fn(), signIn: vi.fn(), file: vi.fn(), repository: vi.fn() }))
vi.mock('../server/publishing-github', async (original) => ({
  ...(await original<typeof import('../server/publishing-github')>()), queryGitHub: mocks.query, signIn: mocks.signIn, fileAt: mocks.file, repositoryById: mocks.repository,
}))
// A hook into the document listing, so a test can pause the release while
// the sweep is still reading which publications exist. Passes through.
const editorMocks = vi.hoisted(() => ({ beforeList: null as null | (() => Promise<void>) }))
vi.mock('../server/editor', async (original) => {
  const actual = await original<typeof import('../server/editor')>()
  return {
    ...actual,
    listDocs: async (...args: Parameters<typeof actual.listDocs>) => {
      if (editorMocks.beforeList) await editorMocks.beforeList()
      return actual.listDocs(...args)
    },
  }
})

const SHA = 'a'.repeat(40)
const SOURCE = '---\ntitle: "A question"\n---\n\nOpening paragraph.\n\nSecond line.\nThird line.\n'
const page = <T>(nodes: T[], more = false, cursor = 'next') => ({ nodes, pageInfo: { hasNextPage: more, endCursor: more ? cursor : null } })
const comment = (id = 'comment-1', body = 'Clarify this passage.') => ({ id, body, author: { login: 'reviewer' }, createdAt: '2026-10-18T08:00:00Z', url: `https://github.com/acme/site/pull/7#${id}` })
const inline = (id = 'inline-1') => ({ ...comment(id), originalCommit: { oid: SHA }, originalLine: 5, originalStartLine: null as number | null })
const thread = (id = 'thread-1', resolved = false) => ({ id, path: 'posts/question.md', isResolved: resolved, isOutdated: false, diffSide: 'RIGHT', viewerCanReply: true, viewerCanResolve: true, comments: page([inline()]) })
const pull = (number = 7, repo = 'acme/site', state = 'OPEN') => ({ id: `pull-${number}`, number, url: `https://${repo}/pull/${number}`, state, locked: false, reviewThreads: page([thread()]), comments: page([comment()]), reviews: page([]) })
const record = (overrides: Partial<PublishRecord> = {}): PublishRecord => ({ repo: 'acme/site', repoId: 42, section: 'Posts', site: 'Site', headRepo: 'writer/site', branch: 'publish/question', base: 'main', path: 'posts/question.md', slug: 'draft', url: 'https://site.example/question/', date: '2026-10-18', publishedAt: '2026-10-18T08:00:00Z', updatedAt: '2026-10-18T08:00:00Z', pullRequest: { number: 7, url: 'https://acme/site/pull/7' }, sourceSha: 'a'.repeat(64), bodySha: 'b'.repeat(64), values: {}, data: {}, ...overrides })

let root: string
let server: Server
let base: string
let database: typeof import('../server/db')
let editor: typeof import('../server/editor')
let api: typeof import('../server/publishing-reviews')
let release: typeof import('../server/release-background')
let pulls: Map<number, ReturnType<typeof pull>>
let remaining: number
const previous = new Map<string, string | undefined>()

async function list(): Promise<{ status: number, body: PublicationReviewList & { error?: string } }> {
  const response = await fetch(`${base}/api/editor/reviews`)
  return { status: response.status, body: await response.json() }
}

const pullQueries = () => mocks.query.mock.calls.filter(([, text]) => String(text).includes('query ArticleReview(')).length

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-18T10:00:00Z'))
  root = await mkdtemp(join(tmpdir(), 'poise-publication-sweep-'))
  for (const key of ['POISE_EDITOR_DIR', 'POISE_DB']) previous.set(key, process.env[key])
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_DB = join(root, 'db.sqlite3')
  database = await import('../server/db')
  database.setMeta('me', 'writer')
  editor = await import('../server/editor')
  api = await import('../server/publishing-reviews')
  release = await import('../server/release-background')
  release.resumeReleaseBackground()
  await editor.writeDoc('draft', '# A question\n\nOpening paragraph.\n\nSecond line.\nThird line.')
  await editor.writePublishLedger('draft', { records: [record()] })
  pulls = new Map([[7, pull()]])
  remaining = 4500
  mocks.signIn.mockReset().mockImplementation(async (me: string) => ({ me, token: `token-${me}` }))
  mocks.file.mockReset().mockResolvedValue({ text: SOURCE, sha: SHA })
  mocks.repository.mockReset().mockResolvedValue({ id: 42, fullName: 'acme/renamed' })
  mocks.query.mockReset().mockImplementation(async (_session: unknown, _text: string, variables: Record<string, unknown>) => {
    const current = pulls.get(Number(variables.number)) ?? pull(Number(variables.number))
    return { repository: { databaseId: current.number === 7 ? 42 : 43, nameWithOwner: current.number === 7 ? 'acme/site' : 'acme/other', pullRequest: structuredClone(current) }, rateLimit: { remaining, cost: 1, resetAt: '2026-10-18T11:00:00Z' } }
  })
  server = createServer((req, res) => { void api.handleArticleReviewsApi(req, res, req.url!).then((handled) => { if (!handled) { res.statusCode = 404; res.end('{}') } }) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Sweep test server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  release.resumeReleaseBackground()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  database.closeDatabase()
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('the publication review sweep', () => {
  it('reads a cold publication as your GitHub account, which the list then shows', async () => {
    const cold = await list()
    expect(cold.status).toBe(200)
    expect(cold.body.publications).toHaveLength(1)
    expect(cold.body.publications[0]).toMatchObject({ slug: 'draft', site: 'Site', repo: 'acme/site', pr: 7, checkedAt: null, active: true, stale: true, openThreads: 0 })
    expect(cold.body.publications[0].problems).not.toHaveLength(0)
    expect(cold.body.sweep).toEqual({ publications: 1, longestDelayMinutes: 15 })
    const run = await api.runPublicationReviewSweepOnce()
    expect(run).toEqual({ read: { slug: 'draft', site: 'Site', repo: 'acme/site', pr: 7 } })
    expect(mocks.signIn).toHaveBeenCalledWith('writer')
    expect(pullQueries()).toBe(1)
    const warm = await list()
    expect(warm.body.publications[0]).toMatchObject({ checkedAt: '2026-10-18T10:00:00.000Z', active: true, stale: false, openThreads: 1, problems: [] })
  })

  it('re-reads an open publication at most every 15 minutes', async () => {
    await api.runPublicationReviewSweepOnce()
    vi.setSystemTime(new Date('2026-10-18T10:05:00Z'))
    expect(await api.runPublicationReviewSweepOnce()).toEqual({ read: null })
    expect(pullQueries()).toBe(1)
    vi.setSystemTime(new Date('2026-10-18T10:16:00Z'))
    expect((await api.runPublicationReviewSweepOnce()).read).not.toBeNull()
    expect(pullQueries()).toBe(2)
  })

  it('re-reads a closed publication once a day, seeing a reopen', async () => {
    pulls.get(7)!.state = 'CLOSED'
    await api.runPublicationReviewSweepOnce()
    expect((await list()).body.publications[0]).toMatchObject({ active: false })
    vi.setSystemTime(new Date('2026-10-18T11:00:00Z'))
    expect(await api.runPublicationReviewSweepOnce()).toEqual({ read: null })
    expect(pullQueries()).toBe(1)
    pulls.get(7)!.state = 'OPEN'
    vi.setSystemTime(new Date('2026-10-19T10:01:00Z'))
    expect((await api.runPublicationReviewSweepOnce()).read).not.toBeNull()
    expect(pullQueries()).toBe(2)
    expect((await list()).body.publications[0]).toMatchObject({ active: true, openThreads: 1 })
  })

  it('progresses several sites separately, oldest checked first', async () => {
    await editor.writePublishLedger('draft', { records: [
      record(),
      record({ repo: 'acme/other', repoId: 43, site: 'Other', pullRequest: { number: 9, url: 'https://acme/other/pull/9' } }),
    ] })
    pulls.set(9, pull(9, 'acme/other'))
    expect((await list()).body.sweep).toEqual({ publications: 2, longestDelayMinutes: 15 })
    const first = await api.runPublicationReviewSweepOnce()
    expect(first.read).not.toBeNull()
    expect(pullQueries()).toBe(1)
    const middle = await list()
    expect(middle.body.publications.filter((entry) => entry.checkedAt).map((entry) => entry.site)).toEqual([first.read!.site])
    expect(middle.body.publications.find((entry) => !entry.checkedAt)?.stale).toBe(true)
    const second = await api.runPublicationReviewSweepOnce()
    expect(second.read).not.toBeNull()
    expect(second.read!.site).not.toBe(first.read!.site)
    expect(pullQueries()).toBe(2)
    expect((await list()).body.publications.every((entry) => entry.checkedAt)).toBe(true)
  })

  it('pauses on quota exhaustion and resumes after the reset', async () => {
    remaining = 50
    await api.runPublicationReviewSweepOnce()
    expect(pullQueries()).toBe(1)
    await editor.writePublishLedger('draft', { records: [record(), record({ repo: 'acme/other', repoId: 43, site: 'Other', pullRequest: { number: 9, url: 'https://acme/other/pull/9' } })] })
    pulls.set(9, pull(9, 'acme/other'))
    expect(await api.runPublicationReviewSweepOnce()).toEqual({ read: null })
    expect(pullQueries()).toBe(1)
    // The list still answers from the cache while the sweep waits.
    expect((await list()).body.publications).toHaveLength(2)
    vi.setSystemTime(new Date('2026-10-18T11:01:00Z'))
    remaining = 4500
    expect((await api.runPublicationReviewSweepOnce()).read).not.toBeNull()
    expect(pullQueries()).toBe(2)
  })

  it('shares one read with the Editor syncing at the same time', async () => {
    // Whichever starts the read wins; the other sees its fresh result.
    const [sync] = await Promise.all([api.articleReviews('draft', true, true), api.runPublicationReviewSweepOnce()])
    expect(sync.reviews.length).toBeGreaterThan(0)
    expect(pullQueries()).toBe(1)
    expect((await list()).body.publications[0].checkedAt).toBe('2026-10-18T10:00:00.000Z')
  })

  it('stops admission on release pause and finishes a read already in flight', async () => {
    release.pauseReleaseBackground()
    expect(await api.runPublicationReviewSweepOnce()).toEqual({ read: null })
    expect(pullQueries()).toBe(0)
    release.resumeReleaseBackground()
    let resolveQuery!: (value: unknown) => void
    mocks.query.mockImplementationOnce(() => new Promise((resolve) => { resolveQuery = resolve }))
    const run = api.runPublicationReviewSweepOnce()
    await vi.waitFor(() => expect(release.releaseBackgroundBusy()).toBe(1))
    release.pauseReleaseBackground()
    expect(await api.runPublicationReviewSweepOnce()).toEqual({ read: null })
    resolveQuery({ repository: { databaseId: 42, nameWithOwner: 'acme/site', pullRequest: structuredClone(pulls.get(7)) }, rateLimit: { remaining: 4500, cost: 1, resetAt: '2026-10-18T11:00:00Z' } })
    expect((await run).read).not.toBeNull()
    expect(release.releaseBackgroundBusy()).toBe(0)
  })

  it('starts no read when the release pause lands while it lists publications', async () => {
    let releaseList!: () => void
    const listed = new Promise<void>((resolve) => { releaseList = resolve })
    let entered = false
    editorMocks.beforeList = async () => { entered = true; await listed }
    try {
      const run = api.runPublicationReviewSweepOnce()
      await vi.waitFor(() => expect(entered).toBe(true))
      release.pauseReleaseBackground()
      releaseList()
      expect(await run).toEqual({ read: null })
      expect(pullQueries()).toBe(0)
      expect(release.releaseBackgroundBusy()).toBe(0)
    } finally {
      editorMocks.beforeList = null
      release.resumeReleaseBackground()
    }
  })

  it('refuses anything but GET on the list', async () => {
    const response = await fetch(`${base}/api/editor/reviews`, { method: 'POST' })
    expect(response.status).toBe(405)
  })
})
