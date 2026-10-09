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
// Writes (open_issue, post_comment) aren't supported by github-datastore
// — it's a read-only consumer view of GitHub. We return 501 so the
// frontend's existing error handling kicks in.
//
// Reference: caller/github_datastore/CONSUMER_CONTRACT.md.

import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMeta } from './db'
import { HttpError } from './http'
import { getOrganizations, readyOrganizations, organizationArgs, type Organization } from './organizations'
import { MAX_PROCESS_ARG_BYTES, runFile } from './process'
import { agentAccount, requireAgentAccount } from './settings'

const CLI = 'github-datastore'
const GH_INTERFACE = 'github-interface'
const GH = 'gh'
const ISSUE_TITLE_PREFIX = 'title='
const ISSUE_BODY_PREFIX = 'body='

function fitsProcessArgument(prefix: string, value: string): boolean {
  return Buffer.byteLength(prefix + value, 'utf8') <= MAX_PROCESS_ARG_BYTES
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
// Current's colour for a pull request: green when it is ready to merge, yellow when
// its merge button is green but a check fails or runs, or a conversation is open.
type PrColour = 'green' | 'yellow'
// Null: neither colour. Undefined: GitHub could not be asked, so nothing is known.
type PrStatus = PrColour | null | undefined
const greenCache = new Map<string, { status: PrStatus, expiry: number }>()

// Subset of fields the datastore returns. Pr-only and issue-only fields
// are optional; the user-footprint view adds `item_type` and `reasons`.
interface DatastoreRecord {
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
  owner_login?: string | null
  owner_avatar?: string | null
  // Issue-only
  issue_ref?: number
  // user-footprint-only
  username?: string
  item_type?: 'pr' | 'issue'
  reasons?: string
  evidence_count?: number
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
}

async function runCli(org: Organization, args: string[]): Promise<DatastoreRecord[]> {
  const { stdout } = await runFile(CLI, organizationArgs(org, args), {
    timeoutMs: 30_000,
    maxOutputBytes: 32 * 1024 * 1024,
  })
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('datastore returned empty output')
  const records = JSON.parse(trimmed)
  if (!Array.isArray(records)) throw new Error('datastore returned a non-array')
  if (records.some((row) => !row || typeof row.repo !== 'string' || !repoBelongsTo(row.repo, org.login))) {
    throw new Error(`datastore contains records outside ${org.login}`)
  }
  return records
}

function toLegacy(r: DatastoreRecord, kind: 'pr' | 'issue'): GhRecord {
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
}
const REPO_LIST_TTL_MS = 5 * 60 * 1000

async function discoverOrgRepos(org: Organization): Promise<string[]> {
  const key = org.login.toLowerCase()
  const now = Date.now()
  const cached = repoListCache.get(key)
  if (cached && cached.expiry > now) return cached.repos
  const generation = repoCacheGeneration
  // Repositories are listed as the person: what they can see.
  const me = getMeta('me') || ''
  if (!me) throw new Error('Set your GitHub account in Settings → GitHub to list repositories')
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
  if (generation === repoCacheGeneration) repoListCache.set(key, { repos: sorted, expiry: now + REPO_LIST_TTL_MS })
  return sorted
}

export async function listOrganizationsRepos(login?: string): Promise<{ repos: string[], errors: OrganizationReadError[] }> {
  const orgs = selectOrganizations(login)
  const results = await Promise.allSettled(orgs.map(discoverOrgRepos))
  const repos: string[] = []
  const errors: OrganizationReadError[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') repos.push(...result.value)
    else errors.push({ org: orgs[i].login, error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
  })
  if (orgs.length && errors.length === orgs.length) throw new HttpError(502, errors.map((entry) => `${entry.org}: ${entry.error}`).join('; '))
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
export async function getHeadSha(
  repo: string,
  number: number,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (!repo.includes('/')) throw new Error('repo must be owner/name')
  const [owner, name] = repo.split('/', 2)
  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, name)
  await mkdir(cwd, { recursive: true })
  const actor = requireAgentAccount()
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
  return headSha
}

// Ask github-interface whether a single PR is "green" (mergeable, open,
// not draft, mergeable_state == clean). Cached per PR for ~60s so the
// once-a-minute frontend poll doesn't refire the whole fanout every tick.
//
// github-interface infers the repo from cwd when no `--repository` flag
// or git remote is available. We just point cwd at a tmp directory whose
// last two parts are `<owner>/<repo>` and the CLI picks it up.
async function checkPrStatus(owner: string, repo: string, number: number, agent: string): Promise<PrStatus> {
  const key = `${owner}/${repo}#${number}`
  const now = Date.now()
  const cached = greenCache.get(key)
  if (cached && cached.expiry > now) return cached.status

  const cwd = join(GH_INTERFACE_CWD_ROOT, owner, repo)
  try {
    await mkdir(cwd, { recursive: true })
    const { stdout } = await runFile(GH_INTERFACE, ['--mergeable', `#${number}`, '--token-user', agent], {
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
    greenCache.set(key, { status, expiry: now + GREEN_TTL_MS })
    return status
  } catch {
    // Network blip / API error / parse failure — cache it so we don't hammer
    // on every retry. Current shows such a PR uncoloured: better to
    // under-show green than to over-show it.
    greenCache.set(key, { status: undefined, expiry: now + GREEN_TTL_MS })
    return undefined
  }
}

/** One of the person's own open pull requests: authored by their GitHub
 *  account or by the agent account. */
export interface OwnPullRequest {
  repo: string
  number: number
  title: string
  /** Current's colour; null when it has neither, undefined when GitHub could not say. */
  status: PrStatus
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
      return { repo: pr.repo, number: pr.number, title: pr.title, status: await checkPrStatus(owner, name, pr.number, agent) }
    })))
  }
  const failed = new Set(read.errors.map((error) => error.org.toLowerCase()))
  return { pullRequests, read: orgs.map((org) => org.login).filter((login) => !failed.has(login.toLowerCase())), tracked }
}

// Resolve mergeable-true PRs across the user's open-PR set. Concurrency
// capped to be polite to GitHub's REST endpoint — typical involvement
// only has a handful of open PRs at once.
async function fetchGreenPrs(me: string, body: any, orgs: Organization[]): Promise<{ records: { repo: string, number: number, status: PrColour }[], errors: OrganizationReadError[] }> {
  // Checked up front: each check below fails quietly to "not green", which
  // would hide a missing agent account behind an empty result.
  const agent = requireAgentAccount()
  const read = await fetchKind('pr', { ...body, record_state: 'open', count_only: true }, me, orgs)
  const openPrs = read.records

  const results: { repo: string, number: number, status: PrColour }[] = []
  for (let i = 0; i < openPrs.length; i += GREEN_CONCURRENCY) {
    const chunk = openPrs.slice(i, i + GREEN_CONCURRENCY)
    const checks = await Promise.all(chunk.map(async (pr) => {
      if (!pr.repo.includes('/')) return { pr, status: null }
      const [owner, repoName] = pr.repo.split('/', 2)
      const status = await checkPrStatus(owner, repoName, pr.number, agent)
      return { pr, status }
    }))
    for (const { pr, status } of checks) {
      if (status) results.push({ repo: pr.repo, number: pr.number, status })
    }
  }
  return { records: results, errors: read.errors }
}

// Query each ready organization's own datastore. Full repository identities
// survive merging; the final pagination applies only after the combined sort.
async function fetchKind(itemType: 'pr' | 'issue', body: any, me: string, orgs: Organization[]): Promise<{ records: GhRecord[], errors: OrganizationReadError[] }> {
  // Scope(s) selecting WHICH records — the leading CLI args that differ
  // per query. The common filters (status / since / limit / format) are
  // appended identically to each scope below.
  //
  // When body.author is set, scope is "PRs/issues authored by X across
  // the org" (uses views.pr / views.issue with --author). The author
  // path lets behaviors target a specific user (e.g. the Poise account)
  // even when the configured `me` is a different user — no agent union.
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
  // us, not every PR it merely reviewed). Deduped by repo#number below.
  const scopes: string[][] = []
  const agent = agentAccount()
  if (body.author) {
    scopes.push([itemType, '--author', String(body.author)])
  } else if (me) {
    scopes.push(['user', '--username', me, '--item-type', itemType])
    if (agent && agent !== me) {
      scopes.push([itemType, '--author', agent])
    }
  } else {
    scopes.push([itemType])
  }

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
      out.push(toLegacy(r, itemType))
    }
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return { records: out, errors }
}

export async function handleGhBody(body: any): Promise<{ status: number, body: unknown }> {
  const op = body?.operation
  const me = getMeta('me') || ''

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
    try { requireConfiguredRepository(repoFull) }
    catch (error) { return { status: 400, body: { error: (error as Error).message } } }
    if (!me) return { status: 400, body: { error: 'Set your GitHub account in Settings → GitHub before creating issues' } }
    const [owner, repo] = repoFull.split('/', 2)

    // Resolve `me`'s gh credential.
    let token = ''
    try {
      const tokenArgs = ['auth', 'token', '--hostname', 'github.com', '--user', me]
      token = (await runFile(GH, tokenArgs, {
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
    } catch (err: any) {
      const msg = err?.stderr?.toString?.() || err?.message || String(err)
      return { status: 502, body: { error: `could not resolve a gh token for ${me} (run \`gh auth login\` as ${me}): ${msg}` } }
    }

    try {
      // `-f` sends raw string fields (no true/false/number coercion); gh
      // switches to POST automatically once fields are set. Body is
      // optional — only send the field when non-empty so a title-only
      // issue is created with no body (GitHub allows that).
      const apiArgs = ['api', `repos/${owner}/${repo}/issues`, '-f', `title=${title}`]
      if (issueBody) apiArgs.push('-f', `body=${issueBody}`)
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
        labels: [],
        owner_login: null,
        owner_avatar: null,
      }
      return { status: 200, body: { record } }
    } catch (err: any) {
      let msg = err?.stderr?.toString?.() || err?.message || String(err)
      if (token) msg = msg.split(token).join('***')   // never leak the token in errors
      return { status: 502, body: { error: 'gh api create issue failed: ' + msg } }
    }
  }

  return { status: 400, body: { error: 'unknown operation: ' + String(op) } }
}
