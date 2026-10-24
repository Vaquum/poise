import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ArticleReview, ArticleReviews, ReviewAnchor, ReviewMessage } from '../src/publishing-review'
import { REVIEW_INTERVAL_MS } from '../src/publishing-review'
import { db, getMeta, setMeta } from './db'
import { listDocs, readDoc, readPublishLedger, type PublishRecord } from './editor'
import { HttpError, readJson } from './http'
import { isRepositoryPath, parsePost, PostFileError } from './publishing'
import { fileAt, GitHubError, queryGitHub, repositoryById, signIn, type GitHubSession } from './publishing-github'
import { releaseBackgroundPaused, trackReleaseBackground } from './release-background'

interface Page<T> { nodes: Array<T | null>, pageInfo: { hasNextPage: boolean, endCursor: string | null } }
interface Comment { id: string, author: { login: string } | null, body: string, url: string, createdAt: string }
interface InlineComment extends Comment { originalCommit: { oid: string } | null, originalLine: number | null, originalStartLine: number | null }
interface Thread {
  id: string, path: string, isResolved: boolean, isOutdated: boolean, diffSide: string,
  startDiffSide: string | null, viewerCanReply: boolean, viewerCanResolve: boolean, comments: Page<InlineComment>
}
interface Pull {
  id: string, number: number, url: string, state: string, locked: boolean,
  reviewThreads: Page<Thread>, comments: Page<Comment>, reviews: Page<Comment>
}
interface Quota { remaining: number, resetAt: string, cost: number }
interface PullAnswer { repository: { databaseId: number, nameWithOwner: string, pullRequest: Pull | null } | null }
interface Snapshot { reviews: ArticleReview[], checkedAt: string, active: boolean, pullId: string, repo: string, repoId: number }
interface SnapshotRead { snapshot: Snapshot, problem?: string, retryAt?: number }
interface Cached { snapshot?: Snapshot, nextAt: number, failures: number, problem?: string }

const PREFIX = 'publishing-reviews:'
const MAX_PAGES = 100
const MAX_CACHE_BYTES = 2 * 1024 * 1024
const pending = new Map<string, Promise<Cached>>()
const actions = new Map<string, Promise<unknown>>()
const sources = new Map<string, Promise<string | null>>()
const MESSAGE_FIELDS = 'id body url createdAt author { login }'
const INLINE_FIELDS = `${MESSAGE_FIELDS} originalCommit { oid } originalLine originalStartLine`
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
const THREAD_FIELDS = `id path isResolved isOutdated diffSide startDiffSide viewerCanReply viewerCanResolve comments(first: 50) { nodes { ${INLINE_FIELDS} } ${PAGE_INFO} }`
const PULL_QUERY = `query ArticleReview($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name, followRenames: true) {
    databaseId nameWithOwner pullRequest(number: $number) {
      id number url state locked
      reviewThreads(first: 50) { nodes { ${THREAD_FIELDS} } ${PAGE_INFO} }
      comments(first: 50) { nodes { ${MESSAGE_FIELDS} } ${PAGE_INFO} }
      reviews(first: 50) { nodes { ${MESSAGE_FIELDS} } ${PAGE_INFO} }
    }
  }
  rateLimit { remaining resetAt cost }
}`

function cached(key: string): Cached {
  const raw = getMeta(key)
  if (!raw) return { nextAt: 0, failures: 0 }
  const value = JSON.parse(raw) as Cached
  if (!Number.isFinite(value.nextAt) || !Number.isSafeInteger(value.failures)
    || (value.snapshot && !Array.isArray(value.snapshot.reviews))) throw new Error('The saved article review cache is unreadable.')
  return value
}

function save(key: string, value: Cached): Cached {
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw) > MAX_CACHE_BYTES) throw new HttpError(422, 'The article review history exceeds the 2 MB cache limit.')
  setMeta(key, raw)
  return value
}

function keyFor(me: string, record: PublishRecord): string {
  return `${PREFIX}${me.toLowerCase()}:${record.repoId ?? record.repo.toLowerCase()}:${record.pullRequest.number}`
}

function budgetKey(me: string): string { return `${PREFIX}budget:${me.toLowerCase()}` }

/** An in-flight answer must never shorten another publication's wait. */
function deferAccount(me: string, until: number): number {
  if (!Number.isFinite(until) || until < 0) throw new GitHubError('GitHub returned an invalid quota reset time.', 502)
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`)
    .run(budgetKey(me), String(until))
  return Number(getMeta(budgetKey(me)))
}

function checkBudget(me: string): void {
  const until = Number(getMeta(budgetKey(me)))
  if (Date.now() < until) throw new GitHubError('GitHub review refresh is waiting for the account API budget to reset.', 429, until)
}

async function query<T>(session: GitHubSession, text: string, variables: Record<string, unknown>): Promise<T> {
  checkBudget(session.me)
  try {
    const result = await queryGitHub<T & { rateLimit?: Quota }>(session, text, variables)
    const quota = result.rateLimit
    // Leave a reserve for publishing and the account's other GitHub activity.
    if (quota && quota.remaining < 100) deferAccount(session.me, Date.parse(quota.resetAt))
    return result
  } catch (error) {
    if (error instanceof GitHubError && error.retryAt) deferAccount(session.me, error.retryAt)
    throw error
  }
}

async function allPages<T>(session: GitHubSession, id: string, type: string, field: string, fields: string, first: Page<T>): Promise<T[]> {
  const rows: T[] = []
  let page = first
  const cursors = new Set<string>()
  for (let n = 0; n < MAX_PAGES; n++) {
    rows.push(...page.nodes.filter((node): node is T => node !== null))
    if (!page.pageInfo.hasNextPage) return rows
    const cursor = page.pageInfo.endCursor
    if (!cursor || cursors.has(cursor)) throw new GitHubError('GitHub returned an invalid review pagination cursor.', 502)
    cursors.add(cursor)
    const more = await query<{ node: Record<string, Page<T>> | null }>(session,
      `query ArticleReviewPage($id: ID!, $after: String!) { node(id: $id) { ... on ${type} { ${field}(first: 50, after: $after) { nodes { ${fields} } ${PAGE_INFO} } } } rateLimit { remaining resetAt cost } }`, { id, after: cursor })
    if (!more.node?.[field]) throw new GitHubError('The GitHub review conversation is no longer available.', 404)
    page = more.node[field]
  }
  throw new GitHubError('The GitHub review history exceeds 100 pages; open the pull request to inspect the remaining history.', 422)
}

const messageOf = (comment: Comment): ReviewMessage => ({ id: comment.id, author: comment.author?.login ?? '[deleted]', body: comment.body, url: comment.url, createdAt: comment.createdAt })

/** Extract from the immutable reviewed file, never from today's PR head. */
export function anchorFromSource(source: string, start: number, end: number): ReviewAnchor | undefined {
  const text = source.replace(/\r\n/g, '\n')
  const body = parsePost(text).body
  const bodyStart = text.trimEnd().length - body.length
  const firstBodyLine = text.slice(0, bodyStart).split('\n').length
  const lines = text.split('\n')
  const contextLines = text.endsWith('\n') ? lines.slice(0, -1) : lines
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < firstBodyLine || end < start || end > lines.length) return undefined
  const quote = lines.slice(start - 1, end).join('\n')
  if (!quote.trim()) return undefined
  const occurrences = contextLines.slice(firstBodyLine - 1).filter((_, i, all) => all.slice(i, i + end - start + 1).join('\n') === quote).length
  return { quote, before: lines.slice(Math.max(firstBodyLine - 1, start - 3), start - 1).join('\n'), after: contextLines.slice(end, end + 2).join('\n'), unique: occurrences === 1 }
}

async function sourceFor(session: GitHubSession, repo: string, path: string, commit: string): Promise<string | null> {
  if (!/^[a-f0-9]{40,64}$/i.test(commit) || !isRepositoryPath(path)) return null
  const key = `${session.me.toLowerCase()}:${repo.toLowerCase()}:${commit}:${path}`
  let read = sources.get(key)
  if (!read) {
    checkBudget(session.me)
    read = fileAt(session, repo, path, commit).then((file) => file?.text ?? null)
    sources.set(key, read)
    if (sources.size > 64) sources.delete(sources.keys().next().value!)
  }
  try { return await read } catch (error) { sources.delete(key); throw error }
}

async function readSnapshot(session: GitHubSession, record: PublishRecord, previous?: Snapshot): Promise<SnapshotRead> {
  const expectedId = record.repoId ?? previous?.repoId
  const read = (repo: string) => query<PullAnswer>(session, PULL_QUERY, { owner: repo.split('/')[0], name: repo.split('/')[1], number: record.pullRequest.number })
  let result: PullAnswer
  try { result = await read(previous && previous.repoId === expectedId ? previous.repo : record.repo) }
  catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404 || !expectedId || error.retryAt) throw error
    const own = await repositoryById(session, expectedId)
    result = await read(own.fullName)
  }
  if (expectedId && result.repository?.databaseId !== expectedId) {
    const own = await repositoryById(session, expectedId)
    result = await read(own.fullName)
  }
  const repository = result.repository
  const pull = repository?.pullRequest
  if (!repository || !pull || (expectedId && repository.databaseId !== expectedId)) throw new GitHubError('The publication pull request could not be read in its own repository.', 404)
  const threads = await allPages(session, pull.id, 'PullRequest', 'reviewThreads', THREAD_FIELDS, pull.reviewThreads)
  const comments = await allPages(session, pull.id, 'PullRequest', 'comments', MESSAGE_FIELDS, pull.comments)
  const reviews = await allPages(session, pull.id, 'PullRequest', 'reviews', MESSAGE_FIELDS, pull.reviews)
  const common = { repo: repository.nameWithOwner, site: record.site, pr: pull.number, prUrl: pull.url }
  const items: ArticleReview[] = []
  const sourceFailures = new Map<string, GitHubError | PostFileError>()
  const problems = new Set<string>()
  let unavailable: GitHubError | undefined
  let retryAt = 0
  for (const thread of threads) {
    const messages = await allPages(session, thread.id, 'PullRequestReviewThread', 'comments', INLINE_FIELDS, thread.comments)
    if (!messages.length) continue
    const first = messages[0]
    const item: ArticleReview = { ...common, id: thread.id, kind: 'thread', path: thread.path, resolved: thread.isResolved, outdated: thread.isOutdated,
      canReply: thread.viewerCanReply, canResolve: thread.viewerCanResolve, messages: messages.map(messageOf) }
    item.location = thread.diffSide === 'LEFT' ? 'Removed text' : 'File or metadata feedback'
    if (thread.path === record.path && thread.diffSide === 'RIGHT' && thread.startDiffSide !== 'LEFT' && first.originalCommit && first.originalLine) {
      const sourceKey = `${thread.path}:${first.originalCommit.oid}`
      try {
        const failure = unavailable ?? sourceFailures.get(sourceKey)
        if (failure) throw failure
        const source = await sourceFor(session, repository.nameWithOwner, thread.path, first.originalCommit.oid)
        if (source) item.anchor = anchorFromSource(source, first.originalStartLine ?? first.originalLine, first.originalLine)
        if (!source) item.location = 'The reviewed file is no longer available'
      } catch (error) {
        if (!(error instanceof GitHubError || error instanceof PostFileError)) throw error
        sourceFailures.set(sourceKey, error)
        if (error instanceof GitHubError) {
          problems.add(`Review passage unavailable: ${error.message}`)
          if (error.status >= 500 || error.retryAt) unavailable = error
          if (error.retryAt) {
            retryAt = Math.max(retryAt, deferAccount(session.me, error.retryAt))
          }
        }
        item.location = `Passage unavailable: ${error.message}`
      }
    }
    items.push(item)
  }
  for (const [kind, rows] of [['comment', comments], ['review', reviews]] as const) {
    for (const comment of rows) if (comment.body.trim()) items.push({ ...common, id: comment.id, kind, resolved: false, outdated: false, canReply: !pull.locked, canResolve: false, messages: [messageOf(comment)], location: 'Document feedback' })
  }
  return { snapshot: { reviews: items, active: pull.state === 'OPEN', checkedAt: new Date().toISOString(), pullId: pull.id, repo: repository.nameWithOwner, repoId: repository.databaseId },
    ...(problems.size ? { problem: [...problems].join(' '), ...(retryAt ? { retryAt } : {}) } : {}) }
}

async function refresh(me: string, record: PublishRecord, force: boolean, polling = false): Promise<Cached> {
  const key = keyFor(me, record)
  const active = pending.get(key)
  if (active) return active
  const old = cached(key)
  if (polling && !force && old.snapshot && !old.snapshot.active) return old
  const now = Date.now()
  // Force still has a short shared cooldown; background reads always observe five minutes.
  if (now < old.nextAt && (!force || old.problem || now - Date.parse(old.snapshot?.checkedAt ?? '') < 10_000)) return old
  const read = (async () => {
    try {
      const { snapshot, problem, retryAt } = await readSnapshot(await signIn(me), record, old.snapshot)
      const failures = problem ? old.failures + 1 : 0
      const delay = problem ? Math.min(REVIEW_INTERVAL_MS * 2 ** Math.min(failures - 1, 4), 60 * 60_000) : REVIEW_INTERVAL_MS
      return save(key, { snapshot, nextAt: Math.max(Date.now() + delay, retryAt ?? 0), failures, ...(problem ? { problem } : {}) })
    } catch (error) {
      if (!(error instanceof GitHubError || error instanceof HttpError)) throw error
      const retryAt = error instanceof GitHubError && error.retryAt ? deferAccount(me, error.retryAt) : 0
      const failures = old.failures + 1
      const nextAt = Math.max(Date.now() + Math.min(REVIEW_INTERVAL_MS * 2 ** Math.min(failures - 1, 4), 60 * 60_000), retryAt)
      return save(key, { ...old, nextAt, failures, problem: error.message })
    }
  })()
  pending.set(key, read)
  try { return await read } finally { pending.delete(key) }
}

/** Cached GET never reaches GitHub. Only a visible editor asks POST to synchronize. */
export async function articleReviews(slug: string, synchronize = false, force = false, polling = false): Promise<ArticleReviews> {
  await readDoc(slug)
  const { records } = await readPublishLedger(slug)
  const me = getMeta('me') ?? ''
  const result: ArticleReviews = { reviews: [], checkedAt: null, active: false, stale: false, problems: [] }
  let retryAt = 0
  // Serial requests also keep multi-site articles from producing a burst.
  for (const record of records) {
    const value = synchronize ? await refresh(me, record, force, polling) : cached(keyFor(me, record))
    if (value.snapshot) {
      result.reviews.push(...value.snapshot.reviews)
      result.active ||= value.snapshot.active
      if (!result.checkedAt || value.snapshot.checkedAt < result.checkedAt) result.checkedAt = value.snapshot.checkedAt
    } else result.active = true
    result.stale ||= !value.snapshot || !!value.problem || Date.now() >= value.nextAt
    if (value.problem) result.problems.push(`${record.site}: ${value.problem}`)
    if (value.problem && value.nextAt > retryAt) retryAt = value.nextAt
  }
  result.reviews = [...new Map(result.reviews.map((review) => [review.id, review])).values()]
  if (retryAt) result.retryAt = new Date(retryAt).toISOString()
  return result
}

async function reviewAction(slug: string, value: unknown): Promise<ArticleReviews> {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Give a review and an action.')
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || !['reply', 'resolve'].includes(String(input.action))) throw new HttpError(400, 'Choose Reply or Resolve for a review.')
  if (input.action === 'reply' && (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 65_536)) throw new HttpError(400, 'A reply must contain between 1 and 65,536 characters.')
  await readDoc(slug)
  const me = getMeta('me') ?? ''
  const { records } = await readPublishLedger(slug)
  const owners = records.map((record) => ({ record, value: cached(keyFor(me, record)) }))
  const owner = owners.find(({ value }) => value.snapshot?.reviews.some((review) => review.id === input.id))
  const review = owner?.value.snapshot?.reviews.find((item) => item.id === input.id)
  if (!owner?.value.snapshot || !review) throw new HttpError(404, 'That review is not part of this document’s publication.')
  if (input.action === 'reply' ? !review.canReply : !review.canResolve || review.resolved) throw new HttpError(403, 'GitHub does not permit that action on this review.')
  const lockKey = keyFor(me, owner.record)
  if (actions.has(lockKey)) throw new HttpError(409, 'A review action is already in progress for this publication.')
  const operation = (async () => {
    const session = await signIn(me)
    if (input.action === 'resolve') {
      await query(session, 'mutation ResolveArticleReview($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }', { id: review.id })
    } else if (review.kind === 'thread') {
      await query(session, `mutation ReplyArticleReview($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { ${MESSAGE_FIELDS} } } }`, { id: review.id, body: String(input.body).trim() })
    } else {
      await query(session, `mutation ReplyArticleDiscussion($id: ID!, $body: String!) { addComment(input: {subjectId: $id, body: $body}) { commentEdge { node { ${MESSAGE_FIELDS} } } } }`, { id: owner.value.snapshot!.pullId, body: String(input.body).trim() })
    }
    // Invalidate before refreshing; a concurrent ordinary poll cannot certify stale state.
    await pending.get(lockKey)
    save(lockKey, { ...cached(lockKey), nextAt: 0 })
    await refresh(me, owner.record, true)
  })()
  actions.set(lockKey, operation)
  try { await operation } finally { actions.delete(lockKey) }
  return articleReviews(slug)
}

// ── Background sweep ──
// New review feedback on a publication nobody has opened is seen without
// opening it: the sweep reads every GitHub publication as your GitHub
// account, oldest checked first, one publication a minute. An open
// publication is re-read at most every 15 minutes; a closed or merged one,
// which the Editor serves from cache for good, is re-read once a day, so a
// reopened pull request or late feedback is seen within a day. Google
// publications are excluded: their reads need live browser delegation.
const SWEEP_INTERVAL_MS = 60_000
const SWEEP_ACTIVE_MS = 15 * 60_000
const SWEEP_TERMINAL_MS = 24 * 60 * 60_000

export interface PublicationReviewEntry {
  slug: string, site: string, repo: string, pr: number, prUrl: string,
  checkedAt: string | null, active: boolean, stale: boolean,
  problems: string[], retryAt?: string, openThreads: number,
}
export interface PublicationReviewList {
  publications: PublicationReviewEntry[],
  sweep: { publications: number, longestDelayMinutes: number },
}

interface Candidate { slug: string, record: PublishRecord, value: Cached }

function checkedMs(value: Cached): number {
  const at = value.snapshot ? Date.parse(value.snapshot.checkedAt) : NaN
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
}

async function listCandidates(me: string): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const doc of await listDocs()) {
    const { records } = await readPublishLedger(doc.slug)
    for (const record of records) out.push({ slug: doc.slug, record, value: cached(keyFor(me, record)) })
  }
  // The publication checked longest ago goes first, each publication
  // separately, so documents published to several sites progress per site.
  out.sort((a, b) => checkedMs(a.value) - checkedMs(b.value))
  return out
}

function entryOf(candidate: Candidate, now: number): PublicationReviewEntry {
  const { slug, record, value } = candidate
  const snapshot = value.snapshot
  return {
    slug, site: record.site, repo: snapshot?.repo ?? record.repo,
    pr: record.pullRequest.number, prUrl: record.pullRequest.url,
    checkedAt: snapshot?.checkedAt ?? null,
    active: snapshot?.active ?? true,
    stale: !snapshot || !!value.problem || now >= value.nextAt,
    problems: value.problem ? [value.problem] : snapshot ? [] : ['Not read yet.'],
    ...(value.problem && value.nextAt ? { retryAt: new Date(value.nextAt).toISOString() } : {}),
    openThreads: snapshot?.reviews.filter((review) => review.kind === 'thread' && !review.resolved).length ?? 0,
  }
}

/** Every publication with its review state, including ones with no open
 *  thread. A cold or failed one stays listed with its staleness, never
 *  disappearing as though it had no feedback. */
export async function listPublicationReviews(now = Date.now()): Promise<PublicationReviewList> {
  const me = getMeta('me') ?? ''
  const publications = (await listCandidates(me)).map((candidate) => entryOf(candidate, now))
  return { publications, sweep: { publications: publications.length, longestDelayMinutes: Math.max(15, publications.length) } }
}

/** Read the due publication checked longest ago: an open one at most every
 *  15 minutes, a closed or merged one once a day. One publication per
 *  call; the timer calls this once a minute. */
export async function runPublicationReviewSweepOnce(now = Date.now()): Promise<{ read: { slug: string, site: string, repo: string, pr: number } | null }> {
  if (releaseBackgroundPaused()) return { read: null }
  const me = getMeta('me') ?? ''
  if (!me) return { read: null }
  // The sweep pauses while the account's budget is deferred, like the Editor.
  try { checkBudget(me) } catch { return { read: null } }
  const next = (await listCandidates(me)).find(({ value }) => {
    // A failed read keeps the Editor's backoff before it is retried.
    if (value.problem && now < value.nextAt) return false
    if (!value.snapshot) return true
    return now - checkedMs(value) >= (value.snapshot.active ? SWEEP_ACTIVE_MS : SWEEP_TERMINAL_MS)
  })
  if (!next) return { read: null }
  // Forced past the Editor's terminal exclusion: a closed publication that
  // reopened, or gained late feedback, is read again. The release drain
  // waits for the read; pausing stops admission, never this read.
  const finished = trackReleaseBackground()
  try {
    await refresh(me, next.record, true)
  } finally { finished() }
  const { slug, record } = next
  return { read: { slug, site: record.site, repo: record.repo, pr: record.pullRequest.number } }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

export function startPublicationReviewsRuntime(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    void runPublicationReviewSweepOnce().catch((error: unknown) => console.error('[publishing-reviews] background sweep failed:', error))
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

export async function stopPublicationReviewsRuntime(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}

export async function handleArticleReviewsApi(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
  const match = /^\/api\/editor\/doc\/([A-Za-z0-9._-]+)\/reviews(?:\/(sync|action))?$/.exec(url.split('?')[0])
  const send = (status: number, value: unknown): true => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(value))
    return true
  }
  if (url.split('?')[0] === '/api/editor/reviews') {
    try {
      if (req.method !== 'GET') return send(405, { error: 'Use GET for every publication’s review state.' })
      return send(200, await listPublicationReviews())
    } catch (error) {
      if (error instanceof HttpError) return send(error.statusCode, { error: error.message })
      return send(500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (!match) return false
  let finished: (() => void) | undefined
  try {
    if (req.method === 'GET' && !match[2]) return send(200, await articleReviews(match[1]))
    if (req.method !== 'POST' || !match[2]) return send(405, { error: 'Use GET for cached reviews or POST to synchronize or act.' })
    if (releaseBackgroundPaused()) throw new HttpError(503, 'Poise is installing an update; try again afterwards.')
    finished = trackReleaseBackground()
    const input = await readJson<Record<string, unknown>>(req)
    if (match[2] === 'sync') return send(200, await articleReviews(match[1], true, input?.force === true, input?.poll === true))
    return send(200, await reviewAction(match[1], input))
  } catch (error) {
    if (error instanceof HttpError) return send(error.statusCode, { error: error.message })
    if (error instanceof GitHubError) return send(502, { error: error.message, ...(error.retryAt ? { retryAt: new Date(error.retryAt).toISOString() } : {}) })
    if ((error as { code?: string }).code === 'ENOENT') return send(404, { error: 'That document does not exist.' })
    return send(500, { error: error instanceof Error ? error.message : String(error) })
  } finally { finished?.() }
}
