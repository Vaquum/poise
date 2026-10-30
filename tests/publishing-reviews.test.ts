import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locateReview, REVIEW_INTERVAL_MS, type ArticleReviews } from '../src/publishing-review'
import type { PublishRecord } from '../server/editor'

const mocks = vi.hoisted(() => ({ query: vi.fn(), signIn: vi.fn(), file: vi.fn(), repository: vi.fn() }))
vi.mock('../server/publishing-github', async (original) => ({
  ...(await original<typeof import('../server/publishing-github')>()), queryGitHub: mocks.query, signIn: mocks.signIn, fileAt: mocks.file, repositoryById: mocks.repository,
}))

const SHA = 'a'.repeat(40)
const SOURCE = '---\ntitle: "A question"\n---\n\nOpening paragraph.\n\nSecond line.\nThird line.\n'
const page = <T>(nodes: T[], more = false, cursor = 'next') => ({ nodes, pageInfo: { hasNextPage: more, endCursor: more ? cursor : null } })
const comment = (id = 'comment-1', body = 'Clarify this passage.') => ({ id, body, author: { login: 'reviewer' }, createdAt: '2026-10-18T08:00:00Z', url: `https://github.com/acme/site/pull/7#${id}` })
const inline = (id = 'inline-1') => ({ ...comment(id), originalCommit: { oid: SHA }, originalLine: 5, originalStartLine: null as number | null })
const thread = (id = 'thread-1') => ({ id, path: 'posts/question.md', isResolved: false, isOutdated: false, diffSide: 'RIGHT', viewerCanReply: true, viewerCanResolve: true, comments: page([inline()]) })
const pull = () => ({ id: 'pull-7', number: 7, url: 'https://github.com/acme/site/pull/7', state: 'OPEN', locked: false, reviewThreads: page([thread()]), comments: page([comment()]), reviews: page([comment('review-1', 'Please make these changes.')]) })
const record = (): PublishRecord => ({ repo: 'acme/site', repoId: 42, section: 'Posts', site: 'Site', headRepo: 'writer/site', branch: 'publish/question', base: 'main', path: 'posts/question.md', slug: 'question', url: 'https://site.example/question/', date: '2026-10-18', publishedAt: '2026-10-18T08:00:00Z', updatedAt: '2026-10-18T08:00:00Z', pullRequest: { number: 7, url: 'https://github.com/acme/site/pull/7' }, sourceSha: 'a'.repeat(64), bodySha: 'b'.repeat(64), values: {}, data: {} })

let root: string
let server: Server
let base: string
let database: typeof import('../server/db')
let editor: typeof import('../server/editor')
let api: typeof import('../server/publishing-reviews')
let github: typeof import('../server/publishing-github')
let current: ReturnType<typeof pull>
let remaining: number
const previous = new Map<string, string | undefined>()

async function request(suffix = '', body?: unknown, slug = 'draft') {
  const response = await fetch(`${base}/api/editor/doc/${slug}/reviews${suffix}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as ArticleReviews & { error?: string } }
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-18T10:00:00Z'))
  root = await mkdtemp(join(tmpdir(), 'poise-article-reviews-'))
  for (const key of ['POISE_EDITOR_DIR', 'POISE_DB']) previous.set(key, process.env[key])
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_DB = join(root, 'db.sqlite3')
  database = await import('../server/db')
  database.setMeta('me', 'writer')
  editor = await import('../server/editor')
  api = await import('../server/publishing-reviews')
  github = await import('../server/publishing-github')
  await editor.writeDoc('draft', '# A question\n\nOpening paragraph.\n\nSecond line.\nThird line.')
  await editor.writePublishLedger('draft', { records: [record()] })
  current = pull()
  remaining = 4500
  mocks.signIn.mockReset().mockImplementation(async (me: string) => ({ me, token: `token-${me}` }))
  mocks.file.mockReset().mockResolvedValue({ text: SOURCE, sha: SHA })
  mocks.repository.mockReset().mockResolvedValue({ id: 42, fullName: 'acme/renamed' })
  mocks.query.mockReset().mockImplementation(async (_session: unknown, query: string, variables: Record<string, unknown>) => {
    if (query.includes('ResolveArticleReview')) {
      const found = current.reviewThreads.nodes.find((item) => item.id === variables.id)
      if (found) found.isResolved = true
      return { resolveReviewThread: { thread: { id: variables.id, isResolved: true } } }
    }
    if (query.includes('ReplyArticleReview')) {
      current.reviewThreads.nodes[0].comments.nodes.push({ ...inline('reply-1'), body: String(variables.body) })
      return { addPullRequestReviewThreadReply: { comment: comment('reply-1', String(variables.body)) } }
    }
    if (query.includes('ReplyArticleDiscussion')) {
      current.comments.nodes.push(comment('reply-2', String(variables.body)))
      return { addComment: { commentEdge: { node: comment('reply-2') } } }
    }
    if (query.includes('ArticleReviewPage')) throw new Error('Unexpected pagination')
    return { repository: { databaseId: 42, nameWithOwner: 'acme/site', pullRequest: structuredClone(current) }, rateLimit: { remaining, cost: 1, resetAt: '2026-10-18T11:00:00Z' } }
  })
  server = createServer((req, res) => { void api.handleArticleReviewsApi(req, res, req.url!).then((handled) => { if (!handled) { res.statusCode = 404; res.end('{}') } }) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Review test server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  database.closeDatabase()
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('review positions', () => {
  it('uses the reviewed body after frontmatter and supports multi-line comments', () => {
    const anchor = api.anchorFromSource(SOURCE, 7, 8)!
    expect(anchor.quote).toBe('Second line.\nThird line.')
    expect(locateReview('# A question\n\nInserted paragraph.\n\nSecond line.\nThird line.', anchor)).toEqual({ start: 35, end: 59 })
    expect(api.anchorFromSource(SOURCE, 2, 2)).toBeUndefined()
  })

  it('retains removed, duplicated and ambiguous passages without guessing', () => {
    const anchor = { quote: 'Repeated.', before: '', after: '', unique: false }
    expect(locateReview('Repeated.\n\nRepeated.', anchor)).toBeNull()
    expect(locateReview('Repeated.', anchor)).toBeNull()
    expect(locateReview('A replacement.', { ...anchor, unique: true })).toBeNull()
    expect(locateReview('First\nRepeated.\nAfter\n\nSecond\nRepeated.\nEnd', { ...anchor, before: 'Second', after: 'End' })).toEqual({ start: 30, end: 39 })
  })

  it('requires complete context lines rather than matching their suffixes or prefixes', () => {
    const anchor = { quote: 'Repeated.', before: 'Context', after: 'After', unique: false }
    expect(locateReview('DifferentContext\nRepeated.\nAfterwards\n\nUnrelated\nRepeated.\nElse', anchor)).toBeNull()
    const text = 'DifferentContext\nRepeated.\nAfterwards\n\nContext\nRepeated.\nAfter'
    expect(locateReview(text, anchor)?.start).toBe(text.lastIndexOf('Repeated.'))
  })

  it('maps normalized reviewed passages back to the exact CRLF document offsets', () => {
    const anchor = api.anchorFromSource(SOURCE.replace(/\n/g, '\r\n'), 7, 8)!
    const text = '# A question\r\n\r\nOpening paragraph.\r\n\r\nSecond line.\r\nThird line.'
    expect(locateReview(text, anchor)).toEqual({ start: text.indexOf('Second line.'), end: text.length })
  })

  it('preserves Markdown hard-break spaces and blank lines in following context', () => {
    const source = '---\ntitle: "Question"\n---\n\nStart A\nRepeated.\nAfter  \n\nOther A\n\nStart B\nRepeated.\nAfter\n\nOther B\n'
    const anchor = api.anchorFromSource(source, 6, 6)!
    expect(anchor.after).toBe('After  \n')
    const changed = '# Question\n\nEdited start\nRepeated.\nAfter  \n\nOther A\n\nStart A\nRepeated.\nAfter\n\nOther B'
    expect(locateReview(changed, anchor)).toBeNull()
    const unchanged = changed.replace('Edited start', 'Start A')
    expect(locateReview(unchanged, anchor)?.start).toBe(unchanged.indexOf('Repeated.'))
  })
})

describe('cached article review synchronization', () => {
  it('serves cached data without GitHub calls, and scopes the cache to the account', async () => {
    expect((await request()).body.reviews).toEqual([])
    expect(mocks.query).not.toHaveBeenCalled()
    await request('/sync', {})
    expect((await request()).body.reviews).toHaveLength(3)
    expect(mocks.query).toHaveBeenCalledTimes(1)
    database.setMeta('me', 'someone-else')
    expect((await request()).body.reviews).toEqual([])
    expect((await request('/action', { id: 'thread-1', action: 'resolve' })).status).toBe(404)
  })

  it('coalesces readers, preserves provenance and reads immutable sources once', async () => {
    const responses = await Promise.all([request('/sync', {}), request('/sync', {}), request('/sync', {})])
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(responses[0].body.reviews[0]).toMatchObject({ id: 'thread-1', site: 'Site', pr: 7, resolved: false, messages: [{ author: 'reviewer' }], anchor: { quote: 'Opening paragraph.' } })
    expect(mocks.file).toHaveBeenCalledWith({ me: 'writer', token: 'token-writer' }, 'acme/site', 'posts/question.md', SHA)
    await request('/sync', {})
    expect(mocks.query).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS)
    await request('/sync', {})
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.file).toHaveBeenCalledTimes(1)
  })

  it('gives manual refresh a shared cooldown and reports closed PRs as inactive', async () => {
    await request('/sync', {})
    await request('/sync', { force: true })
    expect(mocks.query).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 11_000)
    current.state = 'MERGED'
    expect((await request('/sync', { force: true })).body.active).toBe(false)
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it('polls only open PRs when a multi-site document also has a merged publication', async () => {
    await editor.writePublishLedger('draft', { records: [record(), { ...record(), pullRequest: { number: 8, url: 'https://github.com/acme/site/pull/8' } }] })
    const original = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args) as { repository: { pullRequest: ReturnType<typeof pull> } }
      const variables = args[2] as { number: number }
      result.repository.pullRequest.state = variables.number === 8 ? 'MERGED' : 'OPEN'
      result.repository.pullRequest.number = variables.number
      return result
    })
    await request('/sync', {})
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS)
    await request('/sync', { poll: true })
    expect(mocks.query.mock.calls.map((call) => (call[2] as { number: number }).number)).toEqual([7, 8, 7])
    vi.setSystemTime(Date.now() + 11_000)
    await request('/sync', { force: true })
    expect(mocks.query).toHaveBeenCalledTimes(5)
  })

  it('keeps feedback accessible when an original passage cannot be fetched', async () => {
    mocks.file.mockRejectedValue(new github.GitHubError('The reviewed commit is unavailable.', 404))
    const result = (await request('/sync', {})).body
    expect(result.reviews[0]).toMatchObject({ location: expect.stringContaining('unavailable') })
    expect(result.reviews[0].anchor).toBeUndefined()
    expect(result.reviews).toHaveLength(3)
  })

  it('retains stale feedback and backs off after failures, including forced refreshes', async () => {
    await request('/sync', {})
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS)
    mocks.query.mockRejectedValue(new github.GitHubError('GitHub is unavailable.', 502))
    const failure = (await request('/sync', {})).body
    expect(failure.reviews).toHaveLength(3)
    expect(failure).toMatchObject({ stale: true, problems: ['Site: GitHub is unavailable.'], retryAt: expect.any(String) })
    await request('/sync', { force: true })
    expect(mocks.query).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS)
    const again = (await request('/sync', {})).body
    expect(Date.parse(again.retryAt!) - Date.now()).toBe(REVIEW_INTERVAL_MS * 2)
  })

  it('reserves the shared account budget until reset without extra quota calls', async () => {
    await request('/sync', {})
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS)
    remaining = 50
    await request('/sync', {})
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS)
    const paused = (await request('/sync', {})).body
    expect(paused.problems[0]).toContain('API budget')
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(paused.retryAt).toBe('2026-10-18T11:00:00.000Z')
  })

  it('honors GitHub rate-limit reset times for other publications of the account', async () => {
    mocks.query.mockRejectedValue(new github.GitHubError('Rate limit exceeded.', 429, Date.now() + 3600_000))
    await request('/sync', {})
    await editor.writeDoc('other', 'Another article')
    await editor.writePublishLedger('other', { records: [{ ...record(), pullRequest: { number: 8, url: 'https://github.com/acme/site/pull/8' } }] })
    const other = await request('/sync', {}, 'other')
    expect(other.body.problems[0]).toContain('API budget')
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })

  it.each(['source', 'repository'])('shares rate-limit backoff from direct %s reads with other publications', async (where) => {
    const failure = new github.GitHubError('Rate limit exceeded.', 429, Date.now() + 3600_000)
    if (where === 'source') mocks.file.mockRejectedValue(failure)
    else {
      const original = mocks.query.getMockImplementation()!
      mocks.query.mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args) as { repository: { databaseId: number } }
        result.repository.databaseId = 999
        return result
      })
      mocks.repository.mockRejectedValue(failure)
    }
    await request('/sync', {})
    await editor.writeDoc('other', 'Another article')
    await editor.writePublishLedger('other', { records: [{ ...record(), pullRequest: { number: 8, url: 'https://github.com/acme/site/pull/8' } }] })
    const other = await request('/sync', {}, 'other')
    expect(other.body.problems[0]).toContain('API budget')
    expect(other.body.retryAt).toBe('2026-10-18T11:00:00.000Z')
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })

  it('retains new comments after a source timeout, deduplicates failures and increases backoff', async () => {
    current.reviewThreads.nodes.push(thread('same-source'))
    mocks.file.mockRejectedValue(new github.GitHubError('Source request timed out.', 502))
    const first = (await request('/sync', {})).body
    expect(first.reviews).toHaveLength(4)
    expect(first.stale).toBe(true)
    expect(mocks.file).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS)
    const second = (await request('/sync', {})).body
    expect(mocks.file).toHaveBeenCalledTimes(2)
    expect(Date.parse(second.retryAt!) - Date.now()).toBe(REVIEW_INTERVAL_MS * 2)
    await request('/sync', { force: true })
    expect(mocks.query).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS * 2)
    mocks.file.mockResolvedValue({ text: SOURCE, sha: SHA })
    expect((await request('/sync', {})).body).toMatchObject({ stale: false, problems: [] })
    expect(mocks.file).toHaveBeenCalledTimes(3)
  })

  it('never shortens a later account reset when an earlier source request finishes', async () => {
    let started!: () => void
    let rejectSource!: (error: Error) => void
    const sourceStarted = new Promise<void>((resolve) => { started = resolve })
    mocks.file.mockImplementation(() => new Promise((_resolve, reject) => { rejectSource = reject; started() }))
    const original = mocks.query.getMockImplementation()!
    const longReset = Date.now() + 3600_000
    const shortReset = Date.now() + 10 * 60_000
    mocks.query.mockImplementation(async (...args: unknown[]) => {
      if ((args[2] as { number: number }).number === 8) throw new github.GitHubError('Later, longer reset.', 429, longReset)
      return original(...args)
    })
    const earlier = request('/sync', {})
    await sourceStarted
    for (const number of [8, 9]) {
      await editor.writeDoc(`draft-${number}`, `Article ${number}`)
      await editor.writePublishLedger(`draft-${number}`, { records: [{ ...record(), pullRequest: { number, url: `https://github.com/acme/site/pull/${number}` } }] })
    }
    await request('/sync', {}, 'draft-8')
    rejectSource(new github.GitHubError('Earlier, shorter reset.', 429, shortReset))
    expect((await earlier).body.retryAt).toBe(new Date(longReset).toISOString())
    expect(Number(database.getMeta('publishing-reviews:budget:writer'))).toBe(longReset)
    mocks.file.mockResolvedValue({ text: SOURCE, sha: SHA })
    vi.setSystemTime(shortReset + 60_000)
    expect((await request('/sync', {}, 'draft-9')).body.problems[0]).toContain('API budget')
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it('does not attach removed-side or metadata comments to unrelated draft text', async () => {
    current.reviewThreads.nodes[0].diffSide = 'LEFT'
    current.reviewThreads.nodes.push({ ...thread('metadata'), comments: page([{ ...inline(), originalLine: 2 }]) })
    const items = (await request('/sync', {})).body.reviews
    expect(items[0]).toMatchObject({ location: 'Removed text' })
    expect(items[1].anchor).toBeUndefined()
  })

  it('follows repository identity and refuses a repository occupying the old name', async () => {
    const original = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args) as { repository: { databaseId: number, nameWithOwner: string } }
      const variables = args[2] as { name: string }
      result.repository.databaseId = variables.name === 'site' ? 999 : 42
      result.repository.nameWithOwner = variables.name === 'site' ? 'acme/site' : 'acme/renamed'
      return result
    })
    expect((await request('/sync', {})).body.reviews[0].repo).toBe('acme/renamed')
    expect(mocks.repository).toHaveBeenCalledWith(expect.objectContaining({ me: 'writer' }), 42)
  })

  it('paginates threads, their replies, discussion comments and review summaries', async () => {
    current.reviewThreads.pageInfo = { hasNextPage: true, endCursor: 'threads-next' }
    current.reviewThreads.nodes[0].comments.pageInfo = { hasNextPage: true, endCursor: 'replies-next' }
    current.comments.pageInfo = { hasNextPage: true, endCursor: 'comments-next' }
    current.reviews.pageInfo = { hasNextPage: true, endCursor: 'reviews-next' }
    const original = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[1])
      const variables = args[2] as { id: string, after: string }
      if (!text.includes('ArticleReviewPage')) return original(...args)
      if (variables.id === 'thread-1') return { node: { comments: page([inline('reply-page-2')]) } }
      if (variables.after === 'threads-next') return { node: { reviewThreads: page([thread('thread-page-2')]) } }
      if (variables.after === 'comments-next') return { node: { comments: page([comment('discussion-page-2')]) } }
      return { node: { reviews: page([comment('review-page-2')]) } }
    })
    const result = (await request('/sync', {})).body
    expect(result.reviews.map((item) => item.id)).toEqual(['thread-1', 'thread-page-2', 'comment-1', 'discussion-page-2', 'review-1', 'review-page-2'])
    expect(result.reviews[0].messages.map((item) => item.id)).toEqual(['inline-1', 'reply-page-2'])
    expect(mocks.query).toHaveBeenCalledTimes(5)
  })

  it('reports malformed pagination without replacing previously cached feedback', async () => {
    await request('/sync', {})
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS)
    current.reviewThreads.pageInfo = { hasNextPage: true, endCursor: null }
    const result = (await request('/sync', {})).body
    expect(result.reviews).toHaveLength(3)
    expect(result.stale).toBe(true)
    expect(result.problems[0]).toContain('pagination cursor')
  })

  it('finds a renamed publication by id when its old name cannot be queried', async () => {
    const original = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (...args: unknown[]) => {
      const variables = args[2] as { name: string }
      if (variables.name === 'site') throw new github.GitHubError('Repository not found.', 404)
      const result = await original(...args) as { repository: { nameWithOwner: string } }
      result.repository.nameWithOwner = 'acme/renamed'
      return result
    })
    expect((await request('/sync', {})).body.reviews[0].repo).toBe('acme/renamed')
    vi.setSystemTime(Date.now() + REVIEW_INTERVAL_MS)
    await request('/sync', {})
    expect(mocks.repository).toHaveBeenCalledTimes(1)
  })
})

describe('explicit review actions', () => {
  it('replies and resolves on the publishing account, then reads authoritative state', async () => {
    await request('/sync', {})
    const replied = await request('/action', { id: 'thread-1', action: 'reply', body: 'Clarified in the latest update.' })
    expect(replied.status).toBe(200)
    expect(replied.body.reviews[0].messages).toHaveLength(2)
    expect(mocks.query).toHaveBeenCalledWith({ me: 'writer', token: 'token-writer' }, expect.stringContaining('addPullRequestReviewThreadReply'), { id: 'thread-1', body: 'Clarified in the latest update.' })
    const resolved = await request('/action', { id: 'thread-1', action: 'resolve' })
    expect(resolved.body.reviews[0].resolved).toBe(true)
  })

  it('posts a reply to general feedback to that PR discussion', async () => {
    await request('/sync', {})
    expect((await request('/action', { id: 'comment-1', action: 'reply', body: 'Thank you; updated.' })).status).toBe(200)
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ me: 'writer' }), expect.stringContaining('addComment'), { id: 'pull-7', body: 'Thank you; updated.' })
  })

  it('refuses foreign IDs, blank replies, local-only operations and missing permission', async () => {
    current.reviewThreads.nodes[0].viewerCanResolve = false
    await request('/sync', {})
    const before = mocks.query.mock.calls.length
    expect((await request('/action', { id: 'foreign', action: 'resolve' })).status).toBe(404)
    expect((await request('/action', { id: 'thread-1', action: 'reply', body: ' ' })).status).toBe(400)
    expect((await request('/action', { id: 'thread-1', action: 'delete' })).status).toBe(400)
    expect((await request('/action', { id: 'thread-1', action: 'resolve' })).status).toBe(403)
    expect(mocks.query).toHaveBeenCalledTimes(before)
  })

  it('never retries a failed mutation or claims it resolved', async () => {
    await request('/sync', {})
    mocks.query.mockRejectedValue(new github.GitHubError('Permission denied.', 403))
    expect((await request('/action', { id: 'thread-1', action: 'resolve' })).status).toBe(502)
    expect((await request()).body.reviews[0].resolved).toBe(false)
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })
})
