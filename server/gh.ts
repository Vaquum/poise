// Bridge from Poise's /api/gh body shape to the github-datastore CLI.
//
// The CLI is shelled out per request (~125ms worst-case for the fattest
// query, sub-100ms for the typical filtered ones — plenty fast for refresh
// ticks). Response shape stays identical to the old /github service so the
// views don't have to change.
//
// Involvement scope: when settings.me is configured, we route through
// `views.user --username <me>` so the lanes show "things I'm involved in"
// — matches Poise's long-standing semantics. Without `me`, fall back to
// org-wide `views.{pr,issue}` so a fresh install isn't blank.
//
// User-initiated issue creation, editing and comments go directly to GitHub
// with the configured account. The datastore remains a read-only consumer.
//
// Reference: caller/github_datastore/CONSUMER_CONTRACT.md.

import { mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewSummary } from '../src/analytics-work-review'
import type { OpenPrClosingList } from './chat/control'
import { readDatastoreContent, readDatastoreView } from './datastore-reader'
import { getMeta, setMeta } from './db'
import { rememberRead } from './warm-up'
import { HttpError } from './http'
import { getOrganizations, readyOrganizations, organizationArgs, type Organization } from './organizations'
import { MAX_PROCESS_ARG_BYTES, runFile } from './process'
import { isRiskPressured, quotaRiskKey } from './quota-risk'
import { agentAccount, getBehaviorChainSettings, requireAgentAccount } from './settings'
import { invalidateActionRunCache, listActionRuns } from './action-runs'

const CLI = 'github-datastore'
const GH_INTERFACE = 'github-interface'
const GH = 'gh'
const ISSUE_TITLE_PREFIX = 'title='
const ISSUE_BODY_PREFIX = 'body='
const ISSUE_LABEL_PREFIX = 'labels[]='
const LABEL_PAGE_SIZE = 100
const LABEL_PAGES_MAX = 10

function fitsProcessArgument(prefix: string, value: string): boolean {
  return Buffer.byteLength(prefix + value, 'utf8') <= MAX_PROCESS_ARG_BYTES
}

/** The stored github.com credential for the configured main user (`me`),
 *  never whichever gh account happens to be active. */
async function resolveMeToken(me: string): Promise<string> {
  try {
    const tokenArgs = ['auth', 'token', '--hostname', 'github.com', '--user', me]
    const token = (await runFile(GH, tokenArgs, {
      // Resolve the stored github.com credential selected above. Inherited
      // token variables and GH_HOST must not redirect identity selection.
      env: {
        GH_HOST: undefined,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        GH_ENTERPRISE_TOKEN: undefined,
        GITHUB_ENTERPRISE_TOKEN: undefined,
      },
      timeoutMs: 15_000,
      maxOutputBytes: 1 * 1024 * 1024,
    })).stdout.trim()
    if (!token) throw new Error('empty token')
    return token
  } catch (err: any) {
    throw new Error(`could not resolve a gh token for ${me} (run \`gh auth login\` as ${me}): ${err?.stderr?.toString?.() || err?.message || String(err)}`)
  }
}

/** Reconcile a marked report or verify an explicitly linked report, including
 * closed issues. Search absence never proves an earlier POST had no effect. */
export async function reconcileRepairReport(repository: string, marker: string, number: number | null, label = false,
  linked?: (body: string, author: string) => boolean) {
  requireConfiguredRepository(repository)
  const me = getMeta('me')
  if (!me) throw new Error('Repair reporting requires the configured GitHub account')
  const token = await resolveMeToken(me)
  const env = { GH_HOST: 'github.com', GH_TOKEN: token, GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined }
  const request = async (args: string[]): Promise<unknown> => JSON.parse((await runFile(GH, args, {
    env, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024,
  })).stdout)
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid repair report issue evidence')
    return value as Record<string, unknown>
  }
  const labels = (value: unknown): string[] => {
    if (!Array.isArray(value)) throw new Error('Repair report labels are unavailable')
    return value.map(entry => {
      const name = object(entry).name
      if (typeof name !== 'string') throw new Error('Invalid repair report label')
      return name
    })
  }
  try {
    let raw: unknown
    if (number !== null) raw = await request(['api', `repos/${repository}/issues/${number}`, '--method', 'GET'])
    else {
      const result = object(await request(['api', 'search/issues', '--method', 'GET', '-f',
        `q=repo:${repository} is:issue in:body "${marker}"`, '-f', 'per_page=100']))
      if (result.incomplete_results !== false || !Number.isSafeInteger(result.total_count)
        || Number(result.total_count) > 100 || !Array.isArray(result.items)
        || result.items.length !== result.total_count) throw new Error('Repair report search is incomplete')
      const matches = result.items.map(object).filter(issue => typeof issue.body === 'string' && issue.body.includes(marker))
      if (matches.length > 1) throw new Error('Multiple issues claim the same repair report')
      if (!matches.length) return null
      raw = matches[0]
    }
    const issue = object(raw)
    const author = object(issue.user)
    if (number !== null && linked && 'pull_request' in issue) return null
    if ('pull_request' in issue || !Number.isSafeInteger(issue.number) || Number(issue.number) < 1
      || number !== null && issue.number !== number || typeof author.login !== 'string'
      || !['open', 'closed'].includes(String(issue.state))
      || String(issue.html_url).toLowerCase() !== `https://github.com/${repository}/issues/${issue.number}`.toLowerCase()) {
      throw new Error('Repair report issue identity differs from its durable intent')
    }
    if (typeof issue.body !== 'string') {
      if (number !== null && linked) return null
      // A missing body cannot contain the marker, so an unconfirmed report
      // reconciled against an unrelated null-body issue must skip it rather
      // than block it as an identity mismatch.
      if (number !== null) throw new Error(`Repair report marker not found in issue #${issue.number}`)
      throw new Error('Repair report issue identity differs from its durable intent')
    }
    if (!issue.body.includes(marker) && number !== null && linked) {
      if (!linked(issue.body, author.login)) return null
    } else if (!issue.body.includes(marker)) {
      throw new Error(`Repair report marker not found in issue #${issue.number}`)
    } else if (author.login.toLowerCase() !== me.toLowerCase()) {
      throw new Error('Repair report issue identity differs from its durable intent')
    }
    let applied = labels(issue.labels)
    if (label && issue.state === 'open' && !applied.some(name => name.toLowerCase() === 'poise')) {
      applied = labels(await request(['api', `repos/${repository}/issues/${issue.number}/labels`, '--method', 'POST', '-f', 'labels[]=poise']))
    }
    return { number: Number(issue.number), url: String(issue.html_url), state: String(issue.state), labels: applied,
      title: issue.title, body: issue.body }
  } catch (error) {
    const failure = error as { stderr?: unknown, message?: string }
    const message = typeof failure.stderr === 'string' && failure.stderr ? failure.stderr : failure.message || String(error)
    throw new Error(`Repair report reconciliation failed: ${message.split(token).join('***')}`)
  }
}

// github-interface resolves the repo from cwd's last two path parts when
// no git remote is found. We make a no-op directory under tmpdir for each
// repo and use that as cwd — `mkdir -p` is cheap and idempotent.
const GH_INTERFACE_CWD_ROOT = join(tmpdir(), 'poise-gh-interface')

// PR mergeable cache — once-a-minute poll cadence on the front, ~60s TTL
// here means we do real work on each user-driven tick but skip duplicate
// checks within the tick.
const GREEN_TTL_MS = 60_000
const GREEN_CONCURRENCY = 5
// green_pr answers with a check this far past its minute and reads it again
// behind the answer: Overview reads every 60 s, so it found every check just
// expired and waited for GitHub on each open pull request, every time.
const GREEN_STALE_MS = 5 * 60_000
// Current's colour for a pull request: green when it is ready to merge, yellow when
// its merge button is green but a check fails or runs, or a conversation is open.
type PrColour = 'green' | 'yellow'
// Null: neither colour. Undefined: GitHub could not be asked, so nothing is known.
type PrStatus = PrColour | null | undefined
// Why an open pull request is held, in display order. A green pull request
// carries no reasons; `unknown` means the evidence was incomplete.
export type HeldReason = 'draft' | 'conflict' | 'checks_failing' | 'changes_requested' | 'review_required' | 'conversation_open' | 'checks_running' | 'behind' | 'blocked' | 'unknown'
export interface HeldChecks { failing: string[], failingCount: number, runningCount: number, partial: boolean }
export interface HeldInfo { reasons: HeldReason[], checks: HeldChecks, threadsChecked: boolean }
export interface HeldEntry { repo: string, number: number, head: string | null, held: HeldInfo }
interface PrCheck { status: PrStatus, held: HeldInfo, head: string | null }
const greenCache = new Map<string, { check: PrCheck, expiry: number }>()
const greenReads = new Map<string, Promise<PrCheck>>()
let greenRefresh: Promise<void> | null = null
/** Expired checks the running refresh has still to read, by key: a later read adds its own. */
const greenStale = new Map<string, [agent: string, owner: string, repo: string, number: number]>()
const greenKey = (agent: string, owner: string, repo: string, number: number): string =>
  `${agent.toLowerCase()}:${owner}/${repo}#${number}`

// Subset of fields the datastore returns. Pr-only and issue-only fields
// are optional; the user-footprint view adds `item_type` and `reasons`.
export interface DatastoreRecord {
  repo: string
  number: number
  status: 'open' | 'closed' | 'merged'
  author: string
  updated_at: string
  created_at: string
  closed_at: string | null
  title: string
  url: string
  comments_count: number
  // PR-only — owner_login/avatar exist on views.pr (currently null
  // until populated upstream); not on views.user yet.
  pr_ref?: number
  diff_ref?: number
  payload_ref?: number
  review_comments_count?: number
  commits_count?: number
  // null for a pull request the datastore stored before it read sizes
  additions?: number | null
  deletions?: number | null
  // Analytics only: the first review by someone other than the author, and
  // who merged a merged pull request.
  first_review_at?: string | null
  merged_by?: string | null
  review_summary?: ReviewSummary
  owner_login?: string | null
  owner_avatar?: string | null
  // Issue-only
  issue_ref?: number
  // user-footprint-only
  username?: string
  item_type?: 'pr' | 'issue'
  reasons?: string
  evidence_count?: number
  // The pull request's current requested reviewers as of the last sync, a
  // JSON array of logins: null for a row from before reviewers were read.
  requested_reviewers?: string | string[] | null
}

// What Poise's views consume. Kept identical to the old /github shape so
// nothing in src/ needs to change. Fields the datastore doesn't expose
// (labels, owner_*, last_commenter*, author_avatar) are nulled out and
// the views degrade gracefully — author becomes the "last" voice on a
// thread, the avatar falls back to github.com/<username>.png, the
// status column defaults to "In review", etc.
interface GhRecord {
  kind: 'pr' | 'issue'
  repo: string
  number: number
  state: 'open' | 'closed' | 'merged'
  title: string
  url: string
  created_at: string
  updated_at: string
  author: string
  author_avatar: string | null
  merged_at: string | null
  comments_count: number
  last_commenter: string | null
  last_commenter_avatar: string | null
  last_comment_body: string | null
  labels: string[]
  owner_login: string | null
  owner_avatar: string | null
  /** Whether your GitHub account is currently asked to review this pull
   *  request: null when unknown, and for issues. */
  reviewRequested: boolean | null
}

/** Parses the projection's reviewer list: null when the row predates it. */
function parseRequestedReviewers(value: unknown): string[] | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : null
  } catch {
    return null
  }
}

// Overview, Board and every open tab ask for the same views at once: an
// identical read in flight is joined, and nothing is kept once it settles.
const datastoreReads = new Map<string, Promise<DatastoreRecord[]>>()

export async function runCli(org: Organization, args: string[]): Promise<DatastoreRecord[]> {
  const key = JSON.stringify([org.login, org.datastorePath, args])
  let read = datastoreReads.get(key)
  if (!read) {
    const started = readKept(args[0] === 'view' ? org.datastorePath : undefined, key, MARKED_VIEWS.has(args[1]), viewReads, () => readDatastore(org, args))
    datastoreReads.set(key, started)
    const settle = () => { if (datastoreReads.get(key) === started) datastoreReads.delete(key) }
    started.then(settle, settle)
    read = started
  }
  return (await read).slice()
}

/** A view only reads the file, which changes only when Caller syncs it: while
 *  its version is the one a view was read at, that view answers alike. What is
 *  read is kept under the version seen before the read began, so a sync while
 *  it ran makes the next caller read again rather than trust it.
 *
 *  The file changes every few seconds while most of those commits change no
 *  item: a view over items whose datastore still has the content mark it was
 *  read under answers alike too, for CONTENT_KEPT_MS. The mark is taken
 *  before the read, like the version. */
async function readKept<T>(path: string | undefined, key: string, marked: boolean, reads: Map<string, KeptRead<T>>, read: () => Promise<T>): Promise<T> {
  const version = path ? await datastoreVersion(path) : null
  const kept = version ? reads.get(key) : undefined
  if (kept && kept.version === version) return kept.value
  // A version the mark vouched for stands only as long as the mark may: a
  // change it cannot see shows within CONTENT_KEPT_MS, whether or not
  // anything is written after it.
  const vouching = kept !== undefined && Date.now() - kept.readAt < CONTENT_KEPT_MS
  if (vouching && kept.vouched === version) return kept.value
  const content = path && version && marked ? await datastoreContent(path, version) : null
  if (vouching && content !== null && kept.content === content) {
    kept.vouched = version
    return kept.value
  }
  const value = await read()
  if (version) {
    reads.delete(key)
    reads.set(key, { version, content, vouched: null, readAt: Date.now(), value })
    if (reads.size > READS_KEPT) reads.delete(reads.keys().next().value!)
  }
  return value
}

/** A read kept with the datastore file version and content mark it was read
 *  at, and the later version the mark last vouched for. */
interface KeptRead<T> { version: string, content: string | null, vouched: string | null, readAt: number, value: T }

/** A read over several datastores, kept by the same rule as one view's read
 *  (readKept): while every datastore's file version is unchanged, or, within
 *  CONTENT_KEPT_MS of the read, while every one's content mark is. Nothing is
 *  kept while any datastore has no version, nor a value `keep` refuses (a read
 *  that failed in part: its failure may pass with no file changing). */
export interface KeptAcross<T> { versions: string[], contents: Array<string | null>, vouched: string[] | null, readAt: number, value: T }
export async function readKeptAcross<T>(paths: readonly string[], key: string, reads: Map<string, KeptAcross<T>>, read: () => Promise<T>,
  options: { keep?: (value: T) => boolean, bound?: number } = {}): Promise<T> {
  const found = await Promise.all(paths.map((path) => datastoreVersion(path)))
  if (found.some((version) => version === null)) return read()
  const versions = found as string[]
  const same = (other: readonly string[] | null) => !!other && other.length === versions.length && other.every((version, i) => version === versions[i])
  const last = reads.get(key)
  if (last && same(last.versions)) return last.value
  const vouching = last !== undefined && Date.now() - last.readAt < CONTENT_KEPT_MS
  if (vouching && same(last.vouched)) return last.value
  const contents = await Promise.all(paths.map((path, i) => datastoreContent(path, versions[i])))
  if (vouching && contents.every((content, i) => content !== null && content === last.contents[i])) {
    last.vouched = versions
    return last.value
  }
  const value = await read()
  if (options.keep && !options.keep(value)) return value
  reads.delete(key)
  reads.set(key, { versions, contents, vouched: null, readAt: Date.now(), value })
  if (reads.size > (options.bound ?? 8)) reads.delete(reads.keys().next().value!)
  return value
}
/** View reads, the oldest dropped first past READS_KEPT. */
const viewReads = new Map<string, KeptRead<DatastoreRecord[]>>()
const READS_KEPT = 200
/** The views over items and their evidence, all the content mark watches. */
const MARKED_VIEWS = new Set(['pr', 'issue', 'user'])
/** How long an unchanged content mark vouches for a view: a change the mark
 *  cannot see (Caller filling a field it newly reads) shows within this. */
const CONTENT_KEPT_MS = 5 * 60_000

/** Each datastore's content mark, read once per file version for all its views; null when there is none. */
const contents = new Map<string, { version: string, content: Promise<string | null> }>()
function datastoreContent(path: string, version: string): Promise<string | null> {
  const known = contents.get(path)
  if (known?.version === version) return known.content
  let content: Promise<string | null>
  try { content = (readDatastoreContent(path) ?? Promise.resolve(null)).catch(() => null) } catch { content = Promise.resolve(null) }
  contents.set(path, { version, content })
  return content
}

/** The datastore file's version: its identity, size and time, and its write-ahead log's,
 *  which every committed sync changes. Null when it cannot be read: then nothing is kept. */
async function datastoreVersion(path: string): Promise<string | null> {
  try {
    const [main, wal] = await Promise.all([stat(path), stat(`${path}-wal`).catch(() => null)])
    return `${main.dev}:${main.ino}:${main.size}:${main.mtimeMs}|${wal ? `${wal.ino}:${wal.size}:${wal.mtimeMs}` : '-'}`
  } catch {
    return null
  }
}

// Reader failures already reported, so a persistent one is logged once.
const readerFailures = new Set<string>()

async function readDatastore(org: Organization, args: string[]): Promise<DatastoreRecord[]> {
  // The `pr`, `issue` and `user` views are read in-process; anything else,
  // and any reader failure, is the CLI's to answer, as before.
  const inProcess = org.datastorePath ? readDatastoreView(org.datastorePath, args) : null
  let records: unknown
  if (inProcess) {
    try {
      records = await inProcess
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!readerFailures.has(message)) {
        readerFailures.add(message)
        console.error(`[datastore-reader] ${org.login}: the in-process read failed, so github-datastore answers it: ${message}`)
      }
      records = await readDatastoreCli(org, args)
    }
  } else records = await readDatastoreCli(org, args)
  if (!Array.isArray(records)) throw new Error('datastore returned a non-array')
  if (records.some((row) => !row || typeof row.repo !== 'string' || !repoBelongsTo(row.repo, org.login))) {
    throw new Error(`datastore contains records outside ${org.login}`)
  }
  return records
}

async function readDatastoreCli(org: Organization, args: string[]): Promise<unknown> {
  const { stdout } = await runFile(CLI, organizationArgs(org, args), {
    timeoutMs: 30_000,
    maxOutputBytes: 32 * 1024 * 1024,
  })
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('datastore returned empty output')
  return JSON.parse(trimmed)
}

function toLegacy(r: DatastoreRecord, kind: 'pr' | 'issue', me: string): GhRecord {
  const reviewers = kind === 'pr' ? parseRequestedReviewers(r.requested_reviewers) : null
  return {
    kind,
    repo: r.repo,
    number: r.number,
    state: r.status,
    title: r.title,
    url: r.url,
    created_at: r.created_at,
    updated_at: r.updated_at,
    author: r.author,
    author_avatar: null,
    merged_at: r.status === 'merged' ? r.closed_at : null,
    comments_count: r.comments_count ?? 0,
    last_commenter: null,
    last_commenter_avatar: null,
    last_comment_body: null,
    labels: [],
    owner_login: r.owner_login ?? null,
    owner_avatar: r.owner_avatar ?? null,
    reviewRequested: reviewers === null || !me ? null : reviewers.some((login) => login.toLowerCase() === me.toLowerCase()),
  }
}

export interface OrganizationReadError { org: string, error: string }

export function repoBelongsTo(repo: string, org: string): boolean {
  return repo.split('/', 1)[0].toLowerCase() === org.toLowerCase()
}

/** The browser's filter never changes which orgs background workers monitor. */
export function selectOrganizations(login?: unknown): Organization[] {
  if (login !== undefined && login !== null && login !== '') {
    if (typeof login !== 'string') throw new HttpError(400, 'org must be a GitHub organization name or personal username')
    const org = getOrganizations().find((entry) => entry.login.toLowerCase() === login.toLowerCase())
    if (!org) throw new HttpError(400, 'GitHub account is not configured')
    if (org.status !== 'ready') throw new HttpError(409, `${org.login} is not ready`)
    return [org]
  }
  return readyOrganizations()
}

export function requireConfiguredRepository(repo: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(repo)
    || !readyOrganizations().some((org) => repoBelongsTo(repo, org.login))) {
    throw new HttpError(400, 'repository must belong to a ready GitHub account')
  }
}

// Cache by owner, including a generation so an old in-flight read cannot
// repopulate the cache after settings invalidation.
const repoListCache = new Map<string, { repos: string[], expiry: number }>()
let repoCacheGeneration = 0
export function invalidateRepoListCache(): void {
  repoCacheGeneration += 1
  repoListCache.clear()
  repoListFailures.clear()
  repoListsKept.clear()
  repoListsInvalidatedAt = Date.now()
  invalidateActionRunCache()
}
const REPO_LIST_TTL_MS = 5 * 60 * 1000

/** Repository reads under way, by generation and identity: one read at a time each. */
const repoListReads = new Map<string, Promise<string[]>>()
/** Why the last read of a list failed, by identity, until one succeeds: a
 *  picker shown the last list is shown this too. */
const repoListFailures = new Map<string, string>()

/** Each list as last read, kept in meta: after a restart a picker shows it at
 *  once and reads it again behind, rather than waiting on GitHub for seconds.
 *  A list kept before the organizations last changed in this process is not used. */
const keptRepoListKey = (key: string): string => `repo_list:${key}`
const repoListsKept = new Map<string, string>()
let repoListsInvalidatedAt = 0

function keptRepoList(org: Organization, key: string): { repos: string[], expiry: number } | undefined {
  let kept: { repos?: unknown, at?: unknown } | null
  try { kept = JSON.parse(getMeta(keptRepoListKey(key)) || 'null') } catch { return undefined }
  if (!kept || typeof kept.at !== 'number' || kept.at <= repoListsInvalidatedAt || !Array.isArray(kept.repos)) return undefined
  const repos = kept.repos
  if (!repos.every((repo): repo is string => typeof repo === 'string' && repoBelongsTo(repo, org.login))) return undefined
  const entry = { repos, expiry: 0 }
  repoListCache.set(key, entry)
  repoListsKept.set(key, JSON.stringify(repos))
  return entry
}

async function discoverOrgRepos(org: Organization, lastIsFine = false): Promise<string[]> {
  const me = getMeta('me') || ''
  if (!me) throw new Error('Set your GitHub account in Settings → General to list repositories')
  const key = `${me.toLowerCase()}:${org.login.toLowerCase()}`
  const cached = repoListCache.get(key) ?? (lastIsFine ? keptRepoList(org, key) : undefined)
  if (cached && cached.expiry > Date.now()) return cached.repos
  // A picker shows the last list at once and reads it again behind;
  // validation waits for a fresh one.
  if (cached && lastIsFine) {
    readOrgRepos(org, me, key).catch(() => undefined)
    return cached.repos
  }
  return readOrgRepos(org, me, key)
}

function readOrgRepos(org: Organization, me: string, key: string): Promise<string[]> {
  const generation = repoCacheGeneration
  const readKey = `${generation}:${key}`
  const running = repoListReads.get(readKey)
  if (running) return running
  const read = (async () => {
    // Repositories are listed as the person: what they can see.
    const { stdout } = await runFile(GH_INTERFACE, ['--view-repos', org.login, '--token-user', me], {
      timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024,
    })
    const data = JSON.parse(stdout)
    if (!Array.isArray(data.repos)) throw new Error('repository discovery returned no repository list')
    const repos: string[] = data.repos.map((r: any) => String(r.full_name || ''))
    if (repos.some((repo) => !repo.includes('/') || !repoBelongsTo(repo, org.login))) {
      throw new Error(`repository discovery returned repositories outside ${org.login}`)
    }
    const sorted = [...new Set(repos)].sort((a, b) => a.localeCompare(b))
    if (generation === repoCacheGeneration) {
      repoListCache.set(key, { repos: sorted, expiry: Date.now() + REPO_LIST_TTL_MS })
      // Written when it changed, not on every read: each commit waits for the disk.
      const text = JSON.stringify(sorted)
      if (repoListsKept.get(key) !== text) {
        setMeta(keptRepoListKey(key), JSON.stringify({ repos: sorted, at: Date.now() }))
        repoListsKept.set(key, text)
      }
    }
    return sorted
  })()
  read.then(() => { if (generation === repoCacheGeneration) repoListFailures.delete(key) },
    (error: unknown) => { if (generation === repoCacheGeneration) repoListFailures.set(key, error instanceof Error ? error.message : String(error)) })
  repoListReads.set(readKey, read)
  const settle = () => { if (repoListReads.get(readKey) === read) repoListReads.delete(readKey) }
  read.then(settle, settle)
  return read
}

function lastListFailure(org: Organization): string | null {
  const key = `${(getMeta('me') || '').toLowerCase()}:${org.login.toLowerCase()}`
  const cached = repoListCache.get(key)
  return cached && cached.expiry <= Date.now() ? repoListFailures.get(key) ?? null : null
}

/** `lastIsFine`: a read-only picker may answer from a list past its time while it is read again. */
export async function listOrganizationsRepos(login?: string, lastIsFine = false): Promise<{ repos: string[], errors: OrganizationReadError[] }> {
  const orgs = selectOrganizations(login)
  const results = await Promise.allSettled(orgs.map((org) => discoverOrgRepos(org, lastIsFine)))
  const repos: string[] = []
  const errors: OrganizationReadError[] = []
  let unread = 0
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      repos.push(...result.value)
      // A list past its time whose read again failed is shown with that failure.
      const failure = lastIsFine ? lastListFailure(orgs[i]) : null
      if (failure) errors.push({ org: orgs[i].login, error: `${failure}; showing the list read before` })
    } else {
      unread += 1
      errors.push({ org: orgs[i].login, error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
    }
  })
  if (orgs.length && unread === orgs.length) throw new HttpError(502, errors.map((entry) => `${entry.org}: ${entry.error}`).join('; '))
  return { repos: [...new Set(repos)].sort((a, b) => a.localeCompare(b)), errors }
}

// Validation needs complete discovery; read-only pickers can show partial
// results with the explicit per-org errors from listOrganizationsRepos.
export async function listOrgRepos(login?: string): Promise<string[]> {
  const result = await listOrganizationsRepos(login)
  if (result.errors.length) throw new HttpError(502, result.errors.map((entry) => `${entry.org}: ${entry.error}`).join('; '))
  return result.repos
}

// Resolve the local checkout path for a repo via
// `github-interface --local-checkout-path ORG REPO`. Returns an absolute
// filesystem path. Used to set --pwd for `agent-interface --pr-review`,
// since the underlying claude run needs the repo's files to read.
export async function localCheckoutPath(owner: string, repo: string): Promise<string> {
  if (!owner || !repo) throw new Error('owner and repo required')
  const { stdout } = await runFile(GH_INTERFACE, ['--local-checkout-path', owner, repo], {
    timeoutMs: 30_000,
    maxOutputBytes: 1 * 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  if (!result.path) throw new Error('github-interface --local-checkout-path returned no path')
  return String(result.path)
}

// Ask github-interface for a PR's current head commit SHA. Used by
// the review-new-prs dedupe key so a force-push (or any new commit)
// is recognised as a fresh target for re-review rather than treated
// as the already-reviewed PR. Single GitHub call, no pagination.
async function readPrHead(
  repo: string,
  number: number,
  options: { signal?: AbortSignal, actor?: string } = {},
): Promise<Record<string, unknown>> {
  if (!repo.includes('/')) throw new Error('repo must be owner/name')
  const [owner, name] = repo.split('/', 2)
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const actor = options.actor ?? requireAgentAccount()
  const { stdout } = await runFile(GH_INTERFACE, [
    '--head-sha',
    `#${number}`,
    '--token-user',
    actor,
  ], {
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 1 * 1024 * 1024,
    signal: options.signal,
  })
  const result: unknown = JSON.parse(stdout)
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('github-interface --head-sha returned a non-object')
  }
  const data = result as Record<string, unknown>
  const headSha = String(data.head_sha || '').toLowerCase()
  if (data.action !== 'head_sha'
    || data.repository !== repo
    || data.pull_number !== number
    || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error('github-interface --head-sha returned malformed state')
  }
  return data
}

export async function getHeadSha(repo: string, number: number, options: { signal?: AbortSignal, actor?: string } = {}): Promise<string> {
  return String((await readPrHead(repo, number, options)).head_sha).toLowerCase()
}

export async function getPrAuthor(repo: string, number: number, actor: string): Promise<string> {
  const data = await readPrHead(repo, number, { actor })
  if (typeof data.author !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?(?:\[bot\])?$/.test(data.author)) {
    throw new Error('github-interface --head-sha returned no valid PR author')
  }
  return data.author
}

// The --mergeable evidence the held reasons read. Absent fields predate the
// evidence and stay benign: only explicit negative evidence claims a reason.
interface MergeableEvidence {
  state?: unknown
  draft?: unknown
  github_mergeable?: unknown
  github_mergeable_state?: unknown
  checks_state?: unknown
  unresolved_conversations?: unknown
  head_sha?: unknown
  review_decision?: unknown
  threads_checked?: unknown
  queue_enabled?: unknown
  has_rollup?: unknown
  check_contexts?: unknown
  contexts_partial?: unknown
}

const AGGREGATE_FAILING = new Set(['FAILURE', 'ERROR'])
const AGGREGATE_RUNNING = new Set(['PENDING', 'EXPECTED'])
const CHECK_FAILING = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const CHECK_RUNNING = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING'])
const LEGACY_RUNNING = new Set(['PENDING', 'EXPECTED'])
const MAX_FAILING_NAMES = 5

function summarizeCheckContexts(contexts: unknown, partial: unknown): HeldChecks {
  if (!Array.isArray(contexts)) return { failing: [], failingCount: 0, runningCount: 0, partial: true }
  const failing: string[] = []
  let failingCount = 0
  let runningCount = 0
  for (const entry of contexts) {
    const context = entry && typeof entry === 'object' ? entry as { name?: unknown, status?: unknown, conclusion?: unknown } : null
    if (!context || typeof context.name !== 'string') continue
    const status = typeof context.status === 'string' ? context.status : null
    const conclusion = typeof context.conclusion === 'string' ? context.conclusion : null
    if (conclusion && CHECK_FAILING.has(conclusion)) {
      failingCount += 1
      if (failing.length < MAX_FAILING_NAMES) failing.push(context.name)
    } else if ((status && CHECK_RUNNING.has(status)) || (!status && !!conclusion && LEGACY_RUNNING.has(conclusion))) {
      runningCount += 1
    }
  }
  return { failing, failingCount, runningCount, partial: partial === true }
}

function heldFromEvidence(evidence: MergeableEvidence): { held: HeldInfo, head: string | null } {
  const mergeState = typeof evidence.github_mergeable_state === 'string' ? evidence.github_mergeable_state : ''
  const aggregate = typeof evidence.checks_state === 'string' ? evidence.checks_state : null
  const decision = typeof evidence.review_decision === 'string' ? evidence.review_decision : null
  const unresolved = typeof evidence.unresolved_conversations === 'number' ? evidence.unresolved_conversations : 0
  const reasons: HeldReason[] = []
  if (evidence.draft === true || mergeState === 'draft') reasons.push('draft')
  if (evidence.github_mergeable === false || mergeState === 'dirty') reasons.push('conflict')
  if (aggregate && AGGREGATE_FAILING.has(aggregate)) reasons.push('checks_failing')
  if (decision === 'CHANGES_REQUESTED') reasons.push('changes_requested')
  if (decision === 'REVIEW_REQUIRED' || (evidence.queue_enabled === true && decision !== 'APPROVED')) reasons.push('review_required')
  if (unresolved > 0) reasons.push('conversation_open')
  if (aggregate && AGGREGATE_RUNNING.has(aggregate)) reasons.push('checks_running')
  if (mergeState === 'behind') reasons.push('behind')
  if (mergeState === 'blocked' && reasons.length === 0) reasons.push('blocked')
  const computing = evidence.state === 'open' && (evidence.github_mergeable === null || mergeState === 'unknown')
  if (evidence.has_rollup === false || computing) reasons.push('unknown')
  const head = typeof evidence.head_sha === 'string' && /^[0-9a-f]{40}$/i.test(evidence.head_sha) ? evidence.head_sha.toLowerCase() : null
  return {
    held: {
      reasons,
      checks: summarizeCheckContexts(evidence.check_contexts, evidence.contexts_partial),
      threadsChecked: evidence.threads_checked !== false,
    },
    head,
  }
}

function unknownHeld(): HeldInfo {
  return { reasons: ['unknown'], checks: { failing: [], failingCount: 0, runningCount: 0, partial: false }, threadsChecked: false }
}

// Ask github-interface whether a single PR is "green" (mergeable, open,
// not draft, mergeable_state == clean). Cached per PR for ~60s so the
// once-a-minute frontend poll doesn't refire the whole fanout every tick.
//
// github-interface infers the repo from cwd when no `--repository` flag
// or git remote is available. We just point cwd at a tmp directory whose
// last two parts are `<owner>/<repo>` and the CLI picks it up.
async function checkPrStatus(owner: string, repo: string, number: number, agent: string): Promise<PrCheck> {
  const key = greenKey(agent, owner, repo, number)
  const now = Date.now()
  const cached = greenCache.get(key)
  if (cached && cached.expiry > now) return cached.check
  const pending = greenReads.get(key)
  if (pending) return pending

  // Current and ready-PR notifications can miss the cache together. Share
  // their read only when it uses the same authenticated account.
  const read = (async (): Promise<PrCheck> => {
    const cwd = join(GH_INTERFACE_CWD_ROOT, owner, repo)
    try {
      await mkdir(cwd, { recursive: true })
      // Under GraphQL pressure on the agent account the check names are left
      // out; the rollup aggregate the same query returns still decides.
      const slim = isRiskPressured(getMeta(quotaRiskKey(agent, 'graphql')))
      const { stdout } = await runFile(GH_INTERFACE, slim
        ? ['--mergeable', `#${number}`, '--token-user', agent, '--no-check-contexts']
        : ['--mergeable', `#${number}`, '--token-user', agent], {
        cwd,
        timeoutMs: 30_000,
        maxOutputBytes: 1 * 1024 * 1024,
      })
      const result = JSON.parse(stdout)
      // GitHub works out whether an open pull request can merge after a push to it
      // or its base; until it has, nothing is known. A github-interface that
      // reports no status says only whether the PR is clean: green.
      const computing = result.state === 'open' && (result.github_mergeable === null || result.github_mergeable_state === 'unknown')
      const status: PrStatus = computing
        ? undefined
        : result.status === 'green' || result.status === 'yellow'
          ? result.status
          : result.status === undefined && result.mergeable ? 'green' : null
      const { held, head } = heldFromEvidence(result && typeof result === 'object' ? result : {})
      const check = { status, held, head }
      greenCache.set(key, { check, expiry: now + GREEN_TTL_MS })
      return check
    } catch {
      // Network blip / API error / parse failure — cache it so we don't hammer
      // on every retry. Current shows such a PR uncoloured: better to
      // under-show green than to over-show it.
      const check: PrCheck = { status: undefined, held: unknownHeld(), head: null }
      greenCache.set(key, { check, expiry: now + GREEN_TTL_MS })
      return check
    }
  })().finally(() => { greenReads.delete(key) })
  greenReads.set(key, read)
  return read
}

/** One of the person's own open pull requests: authored by their GitHub
 *  account or by the agent account. */
export interface OwnPullRequest {
  repo: string
  number: number
  title: string
  /** Current's colour; null when it has neither, undefined when GitHub could not say. */
  status: PrStatus
  /** Why the pull request is held, from the same check that coloured it. */
  held: HeldInfo
}

/** The person's own open pull requests with Current's colour for each. `read`
 *  names the accounts whose pull requests are all listed; `tracked`, every
 *  account Poise follows. Nothing is tracked until both GitHub accounts are set. */
export async function readOwnPullRequests(): Promise<{ pullRequests: OwnPullRequest[], read: string[], tracked: string[] }> {
  const me = getMeta('me') || ''
  const agent = agentAccount()
  if (!me || !agent) return { pullRequests: [], read: [], tracked: [] }
  const tracked = getOrganizations().map((org) => org.login)
  const orgs = readyOrganizations()
  const read = await fetchKind('pr', { record_state: 'open', count_only: true }, me, orgs)
  const authors = new Set([me.toLowerCase(), agent.toLowerCase()])
  const own = read.records.filter((pr) => pr.state === 'open' && pr.repo.includes('/') && authors.has(String(pr.author || '').toLowerCase()))
  const pullRequests: OwnPullRequest[] = []
  for (let i = 0; i < own.length; i += GREEN_CONCURRENCY) {
    const chunk = own.slice(i, i + GREEN_CONCURRENCY)
    pullRequests.push(...await Promise.all(chunk.map(async (pr) => {
      const [owner, name] = pr.repo.split('/', 2)
      const check = await checkPrStatus(owner, name, pr.number, agent)
      return { repo: pr.repo, number: pr.number, title: pr.title, status: check.status, held: check.held }
    })))
  }
  const failed = new Set(read.errors.map((error) => error.org.toLowerCase()))
  return { pullRequests, read: orgs.map((org) => org.login).filter((login) => !failed.has(login.toLowerCase())), tracked }
}

/** An involved open pull request: the person's footprint plus what the agent
 *  account authored, whoever wrote each one. */
export interface InvolvedPullRequest {
  repo: string
  number: number
  title: string
  /** Whether the person's GitHub account is currently asked to review it:
   *  null when the last sync did not say. */
  reviewRequested: boolean | null
}

/** Every involved open pull request with its review request state, from the
 *  datastore sync alone: no GitHub reads. `read` and `tracked` carry the
 *  same completeness contract as the own pull requests. */
export async function readInvolvedPullRequests(): Promise<{ pullRequests: InvolvedPullRequest[], read: string[], tracked: string[] }> {
  const me = getMeta('me') || ''
  if (!me) return { pullRequests: [], read: [], tracked: [] }
  const tracked = getOrganizations().map((org) => org.login)
  const orgs = readyOrganizations()
  const read = await fetchKind('pr', { record_state: 'open', count_only: true }, me, orgs)
  const pullRequests = read.records
    .filter((pr) => pr.state === 'open' && pr.repo.includes('/'))
    .map((pr) => ({ repo: pr.repo, number: pr.number, title: pr.title, reviewRequested: pr.reviewRequested ?? null }))
  const failed = new Set(read.errors.map((error) => error.org.toLowerCase()))
  return { pullRequests, read: orgs.map((org) => org.login).filter((login) => !failed.has(login.toLowerCase())), tracked }
}

// Resolve mergeable-true PRs across the user's open-PR set. Concurrency
// capped to be polite to GitHub's REST endpoint — typical involvement
// only has a handful of open PRs at once.
async function fetchGreenPrs(me: string, body: any, orgs: Organization[]): Promise<{ records: { repo: string, number: number, status: PrColour }[], held: HeldEntry[], errors: OrganizationReadError[] }> {
  // Checked up front: each check below fails quietly to "not green", which
  // would hide a missing agent account behind an empty result.
  const agent = requireAgentAccount()
  const read = await fetchKind('pr', { ...body, record_state: 'open', count_only: true }, me, orgs)
  const openPrs = read.records
  const now = Date.now()
  const expired: Array<[owner: string, repo: string, number: number]> = []

  const results: { repo: string, number: number, status: PrColour }[] = []
  const held: HeldEntry[] = []
  for (let i = 0; i < openPrs.length; i += GREEN_CONCURRENCY) {
    const chunk = openPrs.slice(i, i + GREEN_CONCURRENCY)
    const checks = await Promise.all(chunk.map(async (pr) => {
      if (!pr.repo.includes('/')) return null
      const [owner, repoName] = pr.repo.split('/', 2)
      const cached = greenCache.get(greenKey(agent, owner, repoName, pr.number))
      if (cached && cached.expiry <= now && now - cached.expiry < GREEN_STALE_MS) {
        expired.push([owner, repoName, pr.number])
        return { pr, check: cached.check }
      }
      return { pr, check: await checkPrStatus(owner, repoName, pr.number, agent) }
    }))
    for (const entry of checks) {
      if (!entry) continue
      if (entry.check.status) results.push({ repo: entry.pr.repo, number: entry.pr.number, status: entry.check.status })
      held.push({ repo: entry.pr.repo, number: entry.pr.number, head: entry.check.head, held: entry.check.held })
    }
  }
  if (expired.length) refreshGreenPrs(expired, agent)
  return { records: results, held, errors: read.errors }
}

// The expired checks green_pr answered with, read again five at a time.
// One refresh runs at a time and also reads what later reads add, from any
// organization. A check never rejects: a failed read is cached as unknown.
function refreshGreenPrs(prs: Array<[owner: string, repo: string, number: number]>, agent: string): void {
  for (const [owner, repo, number] of prs) greenStale.set(greenKey(agent, owner, repo, number), [agent, owner, repo, number])
  greenRefresh ??= (async () => {
    try {
      while (greenStale.size) {
        const batch = [...greenStale].slice(0, GREEN_CONCURRENCY)
        for (const [key] of batch) greenStale.delete(key)
        await Promise.all(batch.map(([, [reader, owner, repo, number]]) => checkPrStatus(owner, repo, number, reader)))
      }
    } finally {
      greenRefresh = null
    }
  })()
}

/** The datastore queries that select what Current shows: what `me` is
 *  involved in, plus what the agent account authored on their behalf. */
export function involvementScopes(itemType: 'pr' | 'issue', me: string, author?: string): string[][] {
  // When author is set, scope is "PRs/issues authored by X across the org"
  // (uses views.pr / views.issue with --author). The author path lets
  // behaviors target a specific user (e.g. the Poise account) even when the
  // configured `me` is a different user — no agent union.
  //
  // Otherwise scope is "things `me` is involved in" via views.user. The
  // agent account acts on the user's behalf, so we also union what IT
  // AUTHORED when one is configured and distinct: without this, issues/PRs
  // the agent opened (chores, say) never surface in Current even though
  // they're the user's work.
  //
  // We use the agent's *authored* set (views.{issue,pr} --author), NOT its
  // involvement view: github-datastore only populates views.user for the
  // configured user, so the agent's involvement comes back empty — and
  // "authored" is the semantic we want anyway (what the agent produced for
  // us, not every PR it merely reviewed). Callers dedupe by repo#number.
  if (author) return [[itemType, '--author', author]]
  if (!me) return [[itemType]]
  const scopes = [['user', '--username', me, '--item-type', itemType]]
  const agent = agentAccount()
  if (agent && agent !== me) scopes.push([itemType, '--author', agent])
  return scopes
}

// Query each ready organization's own datastore. Full repository identities
// survive merging; the final pagination applies only after the combined sort.
async function fetchKind(itemType: 'pr' | 'issue', body: any, me: string, orgs: Organization[]): Promise<{ records: GhRecord[], errors: OrganizationReadError[] }> {
  // Scope(s) selecting WHICH records — the leading CLI args that differ
  // per query. The common filters (status / since / limit / format) are
  // appended identically to each scope below.
  const scopes = involvementScopes(itemType, me, body.author ? String(body.author) : undefined)

  const common: string[] = []
  if (body.record_state === 'open') common.push('--status', 'open')
  if (body.updated_since)            common.push('--updated-since-datetime', body.updated_since)

  // Each org must contribute enough rows for the global page. Searches and
  // counts read the full view: a pre-filter limit silently loses matches.
  const needsWide = !!(body.q || body.updated_until || body.count_only)
  if (!needsWide) {
    const want = Math.max(1, (Number(body.offset) || 0) + (Number(body.limit) || 200))
    if (!Number.isSafeInteger(want)) throw new HttpError(400, 'invalid pagination')
    common.push('--limit', String(want))
  }
  common.push('--format', 'json')
  const results = await Promise.allSettled(orgs.map(async (org) => {
    const rows = await Promise.all(scopes.map((scope) => runCli(org, ['view', ...scope, ...common])))
    return rows.flat()
  }))
  const batches: DatastoreRecord[][] = []
  const errors: OrganizationReadError[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      batches.push(result.value)
      // A readable cache can still be stale after synchronization failed.
      if (orgs[i].error) errors.push({ org: orgs[i].login, error: orgs[i].error! })
    } else errors.push({ org: orgs[i].login, error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
  })
  // Merge + dedupe by repo#number: the same item can land in both the
  // user's and the agent's involvement (one opened it, the other reviewed).
  //
  // This used to say handleGhBody re-sorts, so order here did not matter. It
  // only sorts the 'all' branch — with record_type 'pull_request' or 'issue'
  // (the Issues and PRs pills) the merged list went out in scope order, so
  // everything the review agent authored was appended after the user's rows
  // regardless of date. The first page of a supposedly newest-first table then
  // held the user's oldest rows above the agent's newest. Sort here, where the
  // merge happens, rather than relying on a caller that only sometimes does.
  const seen = new Set<string>()
  const out: GhRecord[] = []
  for (const recs of batches) {
    for (const r of recs) {
      const key = `${r.repo}#${r.number}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(toLegacy(r, itemType, me))
    }
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return { records: out, errors }
}

/** Board's intake shows which open pull requests close each issue. Each page
 *  is a Caller process, which costs a second under load, and its answer
 *  changes only with an item: between syncs that leave the content mark alone
 *  a page answers from what it read. Only this display reads them kept; PR
 *  ownership and binding read every page fresh. Null when unavailable, never kept. */
const closingReads = new Map<string, KeptRead<OpenPrClosingList>>()
function readClosingPage(org: Organization, after: { repo: string, number: number } | undefined, read: (org: Organization, after?: { repo: string, number: number }) => Promise<OpenPrClosingList | null>): Promise<OpenPrClosingList | null> {
  const key = JSON.stringify([org.login, org.datastorePath, after ?? null])
  return readKept(org.datastorePath, key, true, closingReads, async () => {
    const page = await read(org, after)
    if (!page) throw new Error('open pull request references are unavailable')
    return page
  }).catch(() => null)
}

// A list read runs a datastore process for every organization, kind and
// scope, and Overview, Board and every open tab ask for the same lists. An
// identical list read that arrives while one is running joins it; once it
// settles, the next one reads afresh.
const listReads = new Map<string, Promise<{ status: number, body: unknown }>>()

export async function handleGhBody(body: any): Promise<{ status: number, body: unknown }> {
  const op = body?.operation
  // The pages' reads, made again after the next start (server/warm-up.ts).
  if ((op === 'list' && !body?.q) || op === 'issue_intake') rememberRead(body)
  const me = getMeta('me') || ''
  if (op !== 'list') return handleGhOperation(body, op, me)
  // Everything the read depends on keys it: an account or an organization that
  // changes while one runs starts a new read, never joins the old one.
  const key = JSON.stringify([me, getMeta('agentAccount') || '', getOrganizations().map((org) => [org.login, org.status, org.datastorePath, org.error]), body])
  const running = listReads.get(key)
  if (running) return running
  const result = handleGhOperation(body, op, me)
  listReads.set(key, result)
  const settle = () => { if (listReads.get(key) === result) listReads.delete(key) }
  result.then(settle, settle)
  return result
}

async function handleGhOperation(body: any, op: unknown, me: string): Promise<{ status: number, body: unknown }> {

  if (op === 'actions') return listActionRuns(body)

  if (op === 'list') {
    const orgs = selectOrganizations(body.org)
    let records: GhRecord[]
    let errors: OrganizationReadError[]
    const recordType = body.record_type
    if (recordType === 'pull_request' || recordType === 'issue') {
      const result = await fetchKind(recordType === 'issue' ? 'issue' : 'pr', body, me, orgs)
      records = result.records
      errors = result.errors
    } else {
      const [prs, issues] = await Promise.all([
        fetchKind('pr', body, me, orgs), fetchKind('issue', body, me, orgs),
      ])
      records = [...prs.records, ...issues.records].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      errors = [...new Map([...prs.errors, ...issues.errors].map((error) => [error.org, error])).values()]
    }
    if (orgs.length && errors.length === orgs.length && records.length === 0) {
      throw new HttpError(502, errors.map((entry) => `${entry.org}: ${entry.error}`).join('; '))
    }

    // Filters the CLI doesn't support — applied in the proxy.
    if (body.updated_until) {
      const cutoff = String(body.updated_until)
      records = records.filter((r) => r.updated_at < cutoff)
    }
    if (body.q && typeof body.q === 'string') {
      const q = body.q.toLowerCase()
      records = records.filter((r) =>
        r.title.toLowerCase().includes(q) ||
        r.repo.toLowerCase().includes(q) ||
        String(r.number).includes(q) ||
        (r.author || '').toLowerCase().includes(q)
      )
    }

    if (body.count_only) {
      return { status: 200, body: { count: records.length, errors } }
    }

    const offset = Math.max(0, Number(body.offset) || 0)
    const limit = Math.max(0, Number(body.limit) || records.length)
    return { status: 200, body: { records: records.slice(offset, offset + limit), errors } }
  }

  if (op === 'green_pr') {
    // Mergeability isn't on the datastore views, so we fan out
    // `github-interface --mergeable '#<n>'` across the user's open PRs.
    // Results are cached ~60s so subsequent ticks within a refresh
    // window are instant.
    const result = await fetchGreenPrs(me, body, selectOrganizations(body.org))
    return { status: 200, body: result }
  }

  if (op === 'read_issue' || op === 'edit_issue' || op === 'assign_issue') {
    const repoFull = String(body.repository_full_name || '')
    const issueNumber: unknown = body.issue_number
    try { requireConfiguredRepository(repoFull) }
    catch (error) { return { status: 400, body: { error: (error as Error).message } } }
    if (typeof issueNumber !== 'number' || !Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      return { status: 400, body: { error: 'issue_number must be a positive integer' } }
    }
    if (!me) return { status: 400, body: { error: 'Set your GitHub account in Settings → General before editing issues' } }
    if (op === 'edit_issue') {
      if (typeof body.title !== 'string' || !body.title.trim() || typeof body.body !== 'string'
        || typeof body.expected_title !== 'string' || typeof body.expected_body !== 'string') {
        return { status: 400, body: { error: 'title, body and the original title/body are required' } }
      }
      if (!fitsProcessArgument(ISSUE_TITLE_PREFIX, body.title.trim()) || !fitsProcessArgument(ISSUE_BODY_PREFIX, body.body)) {
        return { status: 413, body: { error: 'The issue title or body exceeds the supported field size' } }
      }
    }
    let token = ''
    try {
      token = await resolveMeToken(me)
      const env = { GH_HOST: 'github.com', GH_TOKEN: token, GITHUB_TOKEN: undefined,
        GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined }
      const endpoint = `repos/${repoFull}/issues/${issueNumber}`
      const parse = (stdout: string) => {
        const value: unknown = JSON.parse(stdout)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub returned an invalid issue')
        const row = value as Record<string, unknown>
        if ('pull_request' in row) throw new HttpError(400, 'The target is a pull request, not an issue')
        if (row.number !== issueNumber || typeof row.title !== 'string' || !row.title
          || row.body !== null && typeof row.body !== 'string' || !['open', 'closed'].includes(String(row.state))
          || typeof row.html_url !== 'string' || row.html_url.toLowerCase() !== `https://github.com/${repoFull}/issues/${issueNumber}`.toLowerCase()
          || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
          || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) {
          throw new Error('GitHub returned an invalid or mismatched issue')
        }
        return { number: issueNumber, title: row.title, body: row.body ?? '', state: String(row.state),
          url: row.html_url, created_at: row.created_at, updated_at: row.updated_at }
      }
      const current = parse((await runFile(GH, ['api', endpoint, '--method', 'GET'], {
        env, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024,
      })).stdout)
      if (op === 'read_issue') return { status: 200, body: { issue: current } }
      if (op === 'assign_issue') {
        // The label comes from the chain's settings, never from the browser.
        const { seedMode, label } = getBehaviorChainSettings()
        if (seedMode !== 'label') return { status: 409, body: { error: 'The behavior chain takes every open issue, so there is no label to add' } }
        if (current.state !== 'open') return { status: 409, body: { error: 'The issue is closed' } }
        const applied: unknown = JSON.parse((await runFile(GH, ['api', `${endpoint}/labels`, '--method', 'POST', '-f', `${ISSUE_LABEL_PREFIX}${label}`], {
          env, timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024,
        })).stdout)
        if (!Array.isArray(applied) || !applied.some((entry) => typeof entry?.name === 'string' && entry.name.toLowerCase() === label.toLowerCase())) {
          throw new Error(`GitHub did not confirm the ${label} label`)
        }
        return { status: 200, body: { label } }
      }
      const title = body.title.trim(), issueBody = body.body
      const answer = (issue: typeof current) => ({ status: 200,
        body: { issue, record: { kind: 'issue', repo: repoFull, ...issue, merged_at: null } } })
      // A lost acknowledgement may already have saved exactly this edit. Read it back, never repeat it.
      if (current.title === title && current.body === issueBody) return answer(current)
      if (current.title !== body.expected_title || current.body !== body.expected_body) {
        return { status: 409, body: { error: 'The issue changed on GitHub. Keep your draft and reopen the editor to load the latest version.' } }
      }
      const saved = parse((await runFile(GH, ['api', endpoint, '--method', 'PATCH', '-f', `title=${title}`, '-f', `body=${issueBody}`], {
        env, timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024,
      })).stdout)
      if (saved.title !== title || saved.body !== issueBody) throw new Error('GitHub did not confirm the requested title and body')
      return answer(saved)
    } catch (error) {
      const failure = error as { stderr?: unknown, message?: string }
      let message = typeof failure.stderr === 'string' && failure.stderr ? failure.stderr : failure.message || String(error)
      if (token) message = message.split(token).join('***')
      return { status: error instanceof HttpError ? error.statusCode : 502, body: { error: `GitHub issue edit failed: ${message}` } }
    }
  }

  if (op === 'issue_intake') {
    // Current's view of the chain's intake: the same label filter and the same
    // closing references the chain reads, from local rows only. A read that
    // cannot prove absence is an organization error, never an empty answer.
    const { seedMode, label } = getBehaviorChainSettings()
    const { readOpenPrClosingRefs } = await import('./chat/control')
    const orgs = selectOrganizations(body.org)
    const labelled: string[] = []
    const prs: Record<string, { number: number, url: string }[]> = {}
    const errors: OrganizationReadError[] = []
    await Promise.all(orgs.map(async (org) => {
      try {
        const rows = seedMode === 'label' ? await runCli(org, ['view', 'issue', '--status', 'open', '--label', label, '--format', 'json']) : []
        const closing: [string, { number: number, url: string }][] = []
        let after: { repo: string, number: number } | undefined
        for (;;) {
          const page = await readClosingPage(org, after, readOpenPrClosingRefs)
          if (!page || (page.truncated && !page.more) || page.prs.some((pr) => pr.closingTruncated)) throw new Error('open pull request references are incomplete')
          for (const pr of page.prs) for (const ref of pr.closing) closing.push([`${ref.repo}#${ref.number}`.toLowerCase(), { number: pr.number, url: pr.url }])
          if (!page.more) break
          const last = page.prs.at(-1)
          if (!last || (after?.repo === last.repo && after?.number === last.number)) throw new Error('open pull request pagination did not advance')
          after = { repo: last.repo, number: last.number }
        }
        labelled.push(...rows.map((row) => `${row.repo}#${row.number}`.toLowerCase()))
        for (const [issue, pr] of closing) (prs[issue] ??= []).push(pr)
      } catch (error) {
        errors.push({ org: org.login, error: error instanceof Error ? error.message : String(error) })
      }
    }))
    return { status: 200, body: { label: seedMode === 'label' ? label : null, labelled, prs, errors } }
  }

  if (op === 'open_issue') {
    // User-initiated issue creation — authored as the configured main user
    // (settings.me), NOT the agent account.
    //
    // Current's composer and Editor's "create issue from selection" are the
    // user's OWN actions, so we POST through `gh api` with the token pinned
    // to `me` (gh's stored credential for that account) — never whichever
    // gh account happens to be "active". `github-interface --create-issue`
    // is agent work: it acts as the agent account unless told otherwise.
    const repoFull = String(body.repository_full_name || '')
    const title = String(body.title || '').trim()
    const issueBody = String(body.body || '').trim()
    if (!repoFull.includes('/')) return { status: 400, body: { error: 'repository_full_name required (org/repo)' } }
    if (!title)                  return { status: 400, body: { error: 'title is required' } }
    if (!fitsProcessArgument(ISSUE_TITLE_PREFIX, title)) {
      return { status: 413, body: { error: `title exceeds ${MAX_PROCESS_ARG_BYTES - ISSUE_TITLE_PREFIX.length} UTF-8 bytes` } }
    }
    if (issueBody && !fitsProcessArgument(ISSUE_BODY_PREFIX, issueBody)) {
      return { status: 413, body: { error: `body exceeds ${MAX_PROCESS_ARG_BYTES - ISSUE_BODY_PREFIX.length} UTF-8 bytes` } }
    }
    let labelNames: string[] = []
    if (body.labels !== undefined) {
      if (!Array.isArray(body.labels) || body.labels.length > 100) {
        return { status: 400, body: { error: 'labels must be an array of at most 100 names' } }
      }
      for (const name of body.labels) {
        if (typeof name !== 'string' || !name.trim() || name.length > 200) {
          return { status: 400, body: { error: 'each label must be a non-empty name of at most 200 characters' } }
        }
        if (!fitsProcessArgument(ISSUE_LABEL_PREFIX, name)) {
          return { status: 413, body: { error: `label exceeds ${MAX_PROCESS_ARG_BYTES - ISSUE_LABEL_PREFIX.length} UTF-8 bytes` } }
        }
      }
      labelNames = [...new Set(body.labels as string[])]
    }
    try { requireConfiguredRepository(repoFull) }
    catch (error) { return { status: 400, body: { error: (error as Error).message } } }
    if (!me) return { status: 400, body: { error: 'Set your GitHub account in Settings → General before creating issues' } }
    const [owner, repo] = repoFull.split('/', 2)

    // Resolve `me`'s gh credential.
    let token = ''
    try { token = await resolveMeToken(me) }
    catch (err) { return { status: 502, body: { error: (err as Error).message } } }

    try {
      // `-f` sends raw string fields (no true/false/number coercion); gh
      // switches to POST automatically once fields are set. Body is
      // optional — only send the field when non-empty so a title-only
      // issue is created with no body (GitHub allows that).
      const apiArgs = ['api', `repos/${owner}/${repo}/issues`, '-f', `title=${title}`]
      if (issueBody) apiArgs.push('-f', `body=${issueBody}`)
      for (const name of labelNames) apiArgs.push('-f', `${ISSUE_LABEL_PREFIX}${name}`)
      const { stdout } = await runFile(GH, apiArgs, {
        env: {
          GH_HOST: 'github.com',
          GH_TOKEN: token,
          GITHUB_TOKEN: undefined,
          GH_ENTERPRISE_TOKEN: undefined,
          GITHUB_ENTERPRISE_TOKEN: undefined,
        },
        timeoutMs: 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      // gh api returns the full GitHub issue payload at top level. Normalize
      // to a GhRecord so the frontend can splice the new issue straight into
      // liveItems while github-datastore (a polling consumer view) catches
      // up — an immediate refetch wouldn't yet know about the new issue.
      const issue = JSON.parse(stdout)
      const number = Number(issue.number || 0)
      if (!number) {
        return { status: 502, body: { error: 'gh api create issue: missing number in response' } }
      }
      // GitHub answers 201 and silently drops `labels` when the creating
      // user may not apply them. Report what was actually accepted, and
      // name what was dropped, rather than showing a success that lies.
      const applied = new Set(((issue.labels || []) as Array<{ name?: unknown }>).map((label) => String(label?.name || '')))
      applied.delete('')
      const labels_dropped = labelNames.filter((name) => !applied.has(name))
      const nowIso = new Date().toISOString()
      const record: GhRecord = {
        kind: 'issue',
        repo: repoFull,
        number,
        state: (issue.state as 'open' | 'closed' | 'merged') || 'open',
        title: String(issue.title || title),
        url: String(issue.html_url || `https://github.com/${repoFull}/issues/${number}`),
        created_at: String(issue.created_at || nowIso),
        updated_at: String(issue.updated_at || issue.created_at || nowIso),
        author: String(issue.user?.login || me || ''),
        author_avatar: issue.user?.avatar_url ? String(issue.user.avatar_url) : null,
        merged_at: null,
        comments_count: 0,
        last_commenter: null,
        last_commenter_avatar: null,
        last_comment_body: null,
        labels: [...applied],
        owner_login: null,
        owner_avatar: null,
        reviewRequested: null,
      }
      return { status: 200, body: { record, labels_dropped } }
    } catch (err: any) {
      let msg = err?.stderr?.toString?.() || err?.message || String(err)
      if (token) msg = msg.split(token).join('***')   // never leak the token in errors
      return { status: 502, body: { error: 'gh api create issue failed: ' + msg } }
    }
  }

  if (op === 'list_repo_labels') {
    // The repository's label catalogue for Current's issue composer, read
    // as `me` like the create itself. Paged in-process: `gh api --paginate`
    // concatenates page bodies into one unparseable blob.
    const repoFull = String(body.repository_full_name || '')
    if (!repoFull.includes('/')) return { status: 400, body: { error: 'repository_full_name required (org/repo)' } }
    try { requireConfiguredRepository(repoFull) }
    catch (error) { return { status: 400, body: { error: (error as Error).message } } }
    if (!me) return { status: 400, body: { error: 'Set your GitHub account in Settings → General before reading labels' } }
    const [owner, repo] = repoFull.split('/', 2)
    let token = ''
    try { token = await resolveMeToken(me) }
    catch (err) { return { status: 502, body: { error: (err as Error).message } } }
    try {
      const labels: { name: string, color: string, description: string | null }[] = []
      for (let page = 1; page <= LABEL_PAGES_MAX; page++) {
        const { stdout } = await runFile(GH, ['api', `repos/${owner}/${repo}/labels`, '--method', 'GET', '-f', `per_page=${LABEL_PAGE_SIZE}`, '-f', `page=${page}`], {
          env: {
            GH_HOST: 'github.com',
            GH_TOKEN: token,
            GITHUB_TOKEN: undefined,
            GH_ENTERPRISE_TOKEN: undefined,
            GITHUB_ENTERPRISE_TOKEN: undefined,
          },
          timeoutMs: 15_000,
          maxOutputBytes: 1 * 1024 * 1024,
        })
        const entries: unknown = JSON.parse(stdout)
        if (!Array.isArray(entries)) {
          return { status: 502, body: { error: `gh api list labels for ${repoFull}: unexpected response shape` } }
        }
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object' || typeof (entry as { name?: unknown }).name !== 'string') {
            return { status: 502, body: { error: `gh api list labels for ${repoFull}: unexpected response shape` } }
          }
          const row = entry as { name: string, color?: unknown, description?: unknown }
          labels.push({ name: row.name, color: typeof row.color === 'string' ? row.color : '', description: typeof row.description === 'string' ? row.description : null })
        }
        if (entries.length < LABEL_PAGE_SIZE) break
      }
      return { status: 200, body: { labels } }
    } catch (err: any) {
      let msg = err?.stderr?.toString?.() || err?.message || String(err)
      if (token) msg = msg.split(token).join('***')   // never leak the token in errors
      return { status: 502, body: { error: 'gh api list labels failed: ' + msg } }
    }
  }

  return { status: 400, body: { error: 'unknown operation: ' + String(op) } }
}
