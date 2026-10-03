import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_STDOUT } from './model-catalog-fixture'

// Skip lists of the three PR behaviors, and the check a Swarm replay shares
// with the scheduler. Caller is faked at the process boundary: the datastore
// and github-interface answer from the rows each test sets, and every call is
// recorded, so a test can prove what was never asked.
const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn() }))

vi.mock('../server/process', () => ({
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
  claudeSubscriptionEnvironment: () => ({ CLAUDE_CLI: '/poise/claude-subscription' }),
}))
vi.mock('../server/claude-auth', () => ({
  claudeAuth: {
    snapshot: () => ({ status: 'authenticated' }),
    requireReady: async () => undefined,
    observeProcessFailure: () => undefined,
  },
}))

type Skippable = 'review-new-prs' | 'approve-prs' | 'resolve-unblocking'
const SKIPPABLE: Skippable[] = ['review-new-prs', 'approve-prs', 'resolve-unblocking']
const ME = 'poise-user'
const AGENT = 'review-bot'
const HEAD = 'a'.repeat(40)
const API = 'acme/api'
const WEB = 'acme/web'

let tempRoot = ''
let database: typeof import('../server/db') | null = null
let behaviors: typeof import('../server/behaviors') | null = null
let pulls: Array<Record<string, unknown>> = []
let issues: Array<Record<string, unknown>> = []
let changeRequested = false
let unresolvedConversations = 0
let healthFailure: Error | null = null
// github-interface subcommands to hold until a test releases them.
let held: Record<string, { reached: () => void, release: () => void, released: Promise<void> }> = {}

function pull(repo: string, number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo, number, url: `https://github.com/${repo}/pull/${number}`, status: 'open', author: ME, draft: 0, ...overrides }
}

function issue(repo: string, number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const created = new Date(Date.now() - 20 * 60_000).toISOString()
  return { repo, number, url: `https://github.com/${repo}/issues/${number}`, status: 'open', author: ME, created_at: created, updated_at: created, ...overrides }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

// The datastore applies its filters the way github-datastore does.
function view(rows: Array<Record<string, unknown>>, args: string[]): string {
  const repo = flagValue(args, '--repo')
  const number = flagValue(args, '--number')
  const status = flagValue(args, '--status')
  return JSON.stringify(rows.filter((row) => (repo === undefined || row.repo === repo)
    && (number === undefined || String(row.number) === number)
    && (status === undefined || row.status === status)))
}

function cwdRepo(options?: { cwd?: string }): string {
  const parts = String(options?.cwd || '').split('/')
  return `${parts.at(-2)}/${parts.at(-1)}`
}

function githubRepository(args: string[], options?: { cwd?: string }): string {
  if (args[0] === '--local-checkout-path') return `${args[1]}/${args[2]}`
  return flagValue(args, '--repository') ?? cwdRepo(options)
}

async function cli(command: string, all: string[], options?: { cwd?: string }) {
  const args = all[0] === '--db' ? all.slice(2) : all
  const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' })
  if (command === 'github-datastore' && args[0] === 'health') {
    if (healthFailure) throw healthFailure
    const now = new Date().toISOString()
    return json({
      action: 'health', status: 'healthy', healthy: true, database: all[0] === '--db' ? all[1] : join(tempRoot, 'github.sqlite'),
      max_age_seconds: 120, age_seconds: 1, last_sync_at: now, last_success_at: now, checked_at: now,
    })
  }
  if (command === 'github-datastore' && args[0] === 'view' && args[1] === 'pr') return { stdout: view(pulls, args), stderr: '' }
  if (command === 'github-datastore' && args[0] === 'view' && args[1] === 'issue') return { stdout: view(issues, args), stderr: '' }
  if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
  if (command === 'agent-interface' && args[0] === '--logs') return json([])
  if (command === 'github-interface') {
    const hold = held[args[0]]
    if (hold) {
      hold.reached()
      await hold.released
    }
    const repository = githubRepository(args, options)
    const number = Number(String(args[1] || '').replace(/^#/, ''))
    if (args[0] === '--local-checkout-path') return json({ action: 'local_checkout_path', repository, path: tempRoot })
    if (args[0] === '--head-sha') return json({ action: 'head_sha', repository, pull_number: number, head_sha: HEAD })
    if (args[0] === '--requested-changes-addressed') {
      return json({
        action: 'requested_changes_addressed', repository, pull_number: number, username: flagValue(args, '--username'),
        status: changeRequested, has_change_request: changeRequested,
        reviewer_latest_state: changeRequested ? 'CHANGES_REQUESTED' : null,
        reviewer_latest_commit: changeRequested ? HEAD : null,
        latest_request_at: changeRequested ? '2026-07-10T10:00:00Z' : null, head_sha: HEAD,
        commits_after_request: changeRequested ? 1 : 0, author_commits_after_request: changeRequested ? 1 : 0,
        author_inline_replies_after_request: 0, response_count: changeRequested ? 1 : 0,
      })
    }
    if (args[0] === '--review-activity-since') {
      return json({
        action: 'review_activity_since', repository, pull_number: number, username: flagValue(args, '--username'),
        state: 'OPEN', draft: false, head_sha: HEAD, reviewer_requested: false, active_change_request_authors: [],
        unresolved_conversation_count: unresolvedConversations, unresolved_live_conversation_count: unresolvedConversations,
        unresolved_conversation_authors: [], unresolved_live_conversation_authors: [],
        reviewer_latest_state: null, reviewer_latest_commit: null, reviewer_reviews_since: 0, reviewer_pending_reviews: 0,
        latest_activity_at: null,
      })
    }
    if (args[0] === '--resolve-nonblocking-conversations-if-ready') {
      return json({
        action: 'resolved_nonblocking_conversations_if_ready', repository, pull_number: number, head_sha: HEAD,
        ready_except_conversations: false, reviewer_approved_current_head: false, changes_requested: false,
        statuses_green: false, checks_green: false, checks_present: false, blockers: ['reviewer_not_approved_current_head'],
        resolved_count: 0, unresolved_count: unresolvedConversations, conversations: [],
      })
    }
    if (args[0] === '--sub-issues') return json({ action: 'sub_issues', repository, issue_number: number, sub_issues: [] })
  }
  throw new Error(`unexpected CLI call: ${command} ${all.join(' ')}`)
}

// Hold one github-interface subcommand; resolves once a call has reached it.
function hold(subcommand: string): { reached: Promise<void>, release: () => void } {
  let reached!: () => void
  let release!: () => void
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  held[subcommand] = { reached, release, released }
  return { reached: reachedPromise, release }
}

async function start() {
  process.env.POISE_DB = join(tempRoot, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
  database.setMeta('org', 'acme')
  database.setMeta('me', ME)
  database.setMeta('agentAccount', AGENT)
  behaviors = await import('../server/behaviors')
  return { db: database, runtime: behaviors }
}

// Enabled with its anti-flood baseline already taken, as a running install is.
function enable(db: typeof import('../server/db'), behavior: Skippable | 'review-new-issues'): void {
  if (behavior === 'review-new-prs') {
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
  }
  if (behavior === 'approve-prs') changeRequested = true
  if (behavior === 'resolve-unblocking') unresolvedConversations = 1
  db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
}

// What a behavior did to a pull request: a launched agent, or for Resolve
// Unblocking the resolution call that is its action.
function actedOn(behavior: Skippable): string[] {
  if (behavior === 'resolve-unblocking') {
    return mocks.runFile.mock.calls
      .filter(([command, args]) => command === 'github-interface' && args[0] === '--resolve-nonblocking-conversations-if-ready')
      .map(([, args, options]) => `${githubRepository(args, options)}${args[1]}`)
  }
  const flag = behavior === 'review-new-prs' ? '--pr-review' : '--pr-approve'
  const launches = database!.db.prepare(`
    SELECT launch_repo AS repo, launch_pr AS number FROM behavior_seen
    WHERE key = ? AND launch_requested_at IS NOT NULL ORDER BY launch_repo
  `).all(behavior) as Array<{ repo: string, number: number }>
  expect(mocks.spawnDetached.mock.calls.filter(([, args]) => (args as string[])[0] === flag)).toHaveLength(launches.length)
  return launches.map((launch) => `${launch.repo}#${launch.number}`)
}

function ledgerRows(repo: string): unknown[] {
  return database!.db.prepare("SELECT key, target FROM behavior_seen WHERE target LIKE ? || '#%'").all(repo)
}

function githubCalls(repo: string): unknown[][] {
  return mocks.runFile.mock.calls.filter(([command, args, options]) => command === 'github-interface' && githubRepository(args, options) === repo)
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'poise-repo-skips-'))
  mocks.runFile.mockReset().mockImplementation(cli)
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  pulls = [pull(API, 1), pull(WEB, 2)]
  issues = []
  changeRequested = false
  unresolvedConversations = 0
  healthFailure = null
  held = {}
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
  for (const pending of Object.values(held)) pending.release()
  await behaviors?.stopBehaviorsRuntime()
  vi.useRealTimers()
  if (database?.db.open) database.closeDatabase()
  behaviors = null
  database = null
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('Skip repositories', () => {
  it.each(SKIPPABLE)('%s never claims, reads, launches or dead-letters in a skipped repository', async (behavior) => {
    const { db, runtime } = await start()
    enable(db, behavior)
    runtime.setRepositorySkips(behavior, [WEB])
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(actedOn(behavior)).toEqual([`${API}#1`])
    expect(githubCalls(WEB)).toEqual([])
    expect(ledgerRows(WEB)).toEqual([])
    expect(db.db.prepare("SELECT key FROM meta WHERE key LIKE '%acme/web%'").all()).toEqual([])
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('keeps each behavior to its own list', async () => {
    const { db, runtime } = await start()
    enable(db, 'approve-prs')
    runtime.setRepositorySkips('review-new-prs', [WEB])
    runtime.setRepositorySkips('resolve-unblocking', [API, WEB])
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(actedOn('approve-prs')).toEqual([`${API}#1`, `${WEB}#2`])
  })

  it.each([
    ['review-new-prs', '--head-sha'],
    ['approve-prs', '--head-sha'],
    ['resolve-unblocking', '--review-activity-since'],
  ] as const)('%s leaves a repository skipped while its launch is prepared', async (behavior, subcommand) => {
    const { db, runtime } = await start()
    pulls = [pull(API, 1)]
    enable(db, behavior)
    runtime.startBehaviorsRuntime()
    const gate = hold(subcommand)
    const tick = runtime.runEnabledBehaviorsOnce()
    await gate.reached
    runtime.setRepositorySkips(behavior, [API])
    gate.release()
    await tick

    expect(actedOn(behavior)).toEqual([])
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    // The claim and the per-PR lock taken for it are given back.
    expect(ledgerRows(API)).toEqual([])
    expect(db.listBehaviorDeadLetters()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('reviews an unskipped repository\'s new pull requests on the next tick, never the backlog its baseline recorded', async () => {
    const { db, runtime } = await start()
    db.setMeta('behavior_review_new_prs_keyver', '3')
    runtime.setRepositorySkips('review-new-prs', [WEB])
    runtime.startBehaviorsRuntime()
    // The first enable records what is already open, skipped repositories included.
    await runtime.setEnabled('review-new-prs', true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(db.hasSeen('review-new-prs', `${WEB}#2`)).toBe(true)

    // Opened while its repository is skipped: left alone, and not recorded.
    pulls = [...pulls, pull(WEB, 3)]
    await runtime.runEnabledBehaviorsOnce()
    expect(actedOn('review-new-prs')).toEqual([])
    expect(db.hasSeen('review-new-prs', `${WEB}#3`)).toBe(false)

    // Saving the list touches nothing the scheduler has recorded.
    const ledger = db.db.prepare('SELECT key, target, seen_at, claim_id FROM behavior_seen ORDER BY key, target').all()
    const meta = db.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'behavior_%' AND key NOT LIKE '%skip_repos' ORDER BY key").all()
    runtime.setRepositorySkips('review-new-prs', [])
    expect(db.db.prepare('SELECT key, target, seen_at, claim_id FROM behavior_seen ORDER BY key, target').all()).toEqual(ledger)
    expect(db.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'behavior_%' AND key NOT LIKE '%skip_repos' ORDER BY key").all()).toEqual(meta)

    await runtime.runEnabledBehaviorsOnce()
    expect(actedOn('review-new-prs')).toEqual([`${WEB}#3`])
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
  })

  it('stores one sorted entry per repository, shared by every account', async () => {
    const { db, runtime } = await start()
    expect(runtime.getRepositorySkips('approve-prs')).toEqual([])
    expect(runtime.setRepositorySkips('approve-prs', ['acme/Web', API, 'ACME/web'])).toEqual([API, 'acme/Web'])
    expect(JSON.parse(db.getMeta('behavior_approve_prs_skip_repos')!)).toEqual([API, 'acme/Web'])
    db.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('beta', ?, 1, 'ready', 'ready', ?)`).run(join(tempRoot, 'beta.sqlite'), ME)
    expect(runtime.withBehaviorOrganization('beta', () => runtime.getRepositorySkips('approve-prs'))).toEqual([API, 'acme/Web'])
    expect(runtime.getRepositorySkips('review-new-prs')).toEqual([])
    // A case-insensitive match: GitHub treats the two spellings as one repository.
    enable(db, 'approve-prs')
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(actedOn('approve-prs')).toEqual([])
  })

  it.each([
    ['unreadable', '[not json'],
    ['malformed', JSON.stringify(['not a repository'])],
    ['not a list', JSON.stringify({ repos: [WEB] })],
  ])('refuses an %s stored list and launches nothing rather than skipping nothing', async (_kind, stored) => {
    const { db, runtime } = await start()
    enable(db, 'review-new-prs')
    db.setMeta('behavior_review_new_prs_skip_repos', stored)
    expect(() => runtime.getRepositorySkips('review-new-prs')).toThrow('holds')
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({
      behavior: 'review-new-prs', kind: 'operation', error: expect.stringContaining('Skip repositories list'),
    })])
  })
})

describe('Replay checks', () => {
  async function refusal(behavior: 'pr_review' | 'pr_approve' | 'issue_review', repo: string, number: number): Promise<string | null> {
    try {
      await behaviors!.admitReplay(behavior, repo, number)
      return null
    } catch (error) {
      expect(error).toBeInstanceOf(behaviors!.ReplayRefusedError)
      expect((error as { statusCode: number }).statusCode).toBe(409)
      return (error as Error).message
    }
  }

  it('admits an open pull request of yours outside the skipped repositories, for review and approval', async () => {
    const { runtime } = await start()
    runtime.setRepositorySkips('review-new-prs', [WEB])
    runtime.setRepositorySkips('approve-prs', [WEB])
    await expect(refusal('pr_review', API, 1)).resolves.toBeNull()
    await expect(refusal('pr_approve', API, 1)).resolves.toBeNull()
    // Read fresh, behind the scheduler's own freshness gate.
    const reads = mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore').map(([, args]) => (args as string[]).join(' '))
    expect(reads).toEqual([
      'health --max-age-seconds 120', `view pr --repo ${API} --number 1 --format json`,
      'health --max-age-seconds 120', `view pr --repo ${API} --number 1 --format json`,
    ])
  })

  it.each([
    ['pr_review', 'closed', { status: 'closed' }, `Replay refused: ${API}#1 is not an open pull request.`],
    ['pr_approve', 'merged', { status: 'merged' }, `Replay refused: ${API}#1 is not an open pull request.`],
    ['pr_review', 'a draft', { draft: 1 }, `Replay refused: ${API}#1 is a draft.`],
    ['pr_approve', 'authored by someone else', { author: 'someone-else' }, `Replay refused: ${API}#1 is authored by someone-else, not by your GitHub account ${ME}.`],
  ] as const)('refuses %s replay of a pull request that is %s', async (behavior, _case, facts, message) => {
    await start()
    pulls = [pull(API, 1, facts)]
    await expect(refusal(behavior, API, 1)).resolves.toBe(message)
  })

  it('refuses a pull request the datastore does not have', async () => {
    await start()
    await expect(refusal('pr_review', API, 99)).resolves.toBe(`Replay refused: ${API}#99 is not an open pull request.`)
  })

  it('refuses when your GitHub account is not set', async () => {
    const { db } = await start()
    db.setMeta('me', '')
    await expect(refusal('pr_approve', API, 1)).resolves
      .toBe(`Replay refused: ${API}#1 cannot be matched to your GitHub account: none is set in Settings → GitHub.`)
  })

  it('refuses a repository skipped for that behavior only', async () => {
    const { runtime } = await start()
    runtime.setRepositorySkips('review-new-prs', [API])
    await expect(refusal('pr_review', API, 1)).resolves
      .toBe(`Replay refused: ${API} is in the Skip repositories list of Review New Pull Requests.`)
    await expect(refusal('pr_approve', API, 1)).resolves.toBeNull()
    runtime.setRepositorySkips('approve-prs', ['ACME/API'])
    await expect(refusal('pr_approve', API, 1)).resolves
      .toBe(`Replay refused: ${API} is in the Skip repositories list of Approve Pull Requests.`)
  })

  it('refuses a repository outside every ready account without reading anything', async () => {
    await start()
    await expect(refusal('pr_review', 'elsewhere/api', 1)).resolves
      .toBe('Replay refused: elsewhere/api does not belong to a ready GitHub account.')
    await expect(refusal('issue_review', 'elsewhere/api', 1)).resolves
      .toBe('Replay refused: elsewhere/api does not belong to a ready GitHub account.')
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('admits an open issue of a trusted author in an opted-in repository', async () => {
    const { runtime } = await start()
    runtime.setIssueRepositories([API])
    issues = [issue(API, 4, { author: AGENT })]
    await expect(refusal('issue_review', API, 4)).resolves.toBeNull()
  })

  it.each([
    ['in a repository that is not opted in', [], {}, `Replay refused: ${API} is not opted in to Review New Issues.`],
    ['that is closed', [API], { status: 'closed' }, `Replay refused: ${API}#4 is not an open issue.`],
    ['by an author who is not trusted', [API], { author: 'stranger' }, `Replay refused: ${API}#4 was opened by stranger, who is not a trusted author of Review New Issues.`],
  ] as const)('refuses an issue review replay of an issue %s', async (_case, repos, facts, message) => {
    const { runtime } = await start()
    runtime.setIssueRepositories(repos)
    issues = [issue(API, 4, facts)]
    await expect(refusal('issue_review', API, 4)).resolves.toBe(message)
  })

  it('refuses an issue the datastore does not have, and follows the trusted author list', async () => {
    const { runtime } = await start()
    runtime.setIssueRepositories([API])
    await expect(refusal('issue_review', API, 4)).resolves.toBe(`Replay refused: ${API}#4 is not an open issue.`)
    issues = [issue(API, 4, { author: 'zero-bang' })]
    runtime.setIssueAuthors(['Zero-Bang'])
    await expect(refusal('issue_review', API, 4)).resolves.toBeNull()
  })

  it('launches nothing when the facts cannot be read, and says why', async () => {
    await start()
    healthFailure = new Error('datastore unavailable')
    const failure = behaviors!.admitReplay('pr_review', API, 1)
    await expect(failure).rejects.toMatchObject({ statusCode: 502 })
    await expect(failure).rejects.toThrow(`Replay could not check ${API}#1: github-datastore freshness gate failed: datastore unavailable`)
    await expect(failure).rejects.not.toBeInstanceOf(behaviors!.ReplayRefusedError)
    healthFailure = null
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) =>
      command === 'github-datastore' && args[0] === 'view' ? { stdout: '{}', stderr: '' } : cli(command, args, options))
    await expect(behaviors!.admitReplay('issue_review', API, 1)).rejects.toMatchObject({ statusCode: 502 })
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) =>
      command === 'github-datastore' && args[0] === 'view'
        ? { stdout: JSON.stringify([pull(API, 1), pull(API, 2)]), stderr: '' }
        : cli(command, args, options))
    await expect(behaviors!.admitReplay('pr_review', API, 1)).rejects.toThrow(`returned rows other than ${API}#1`)
  })
})

// The scheduler's candidate filter and a replay's admission are one check. For
// each set of facts, the scheduler launches exactly when a replay of the same
// target is admitted, and a replay refused names the check that failed.
describe('the scheduler and a replay apply the same check', () => {
  async function admitted(behavior: 'pr_review' | 'pr_approve' | 'issue_review', repo: string, number: number): Promise<true | string> {
    try {
      await behaviors!.admitReplay(behavior, repo, number)
      return true
    } catch (error) {
      if (!(error instanceof behaviors!.ReplayRefusedError)) throw error
      return error.message
    }
  }

  const pullRequestCases: Array<[string, Record<string, unknown> | null, string[], string | true]> = [
    ['open, yours and not skipped', {}, [], true],
    ['a draft', { draft: 1 }, [], 'is a draft'],
    ['authored by someone else', { author: 'someone-else' }, [], 'not by your GitHub account'],
    ['merged', { status: 'merged' }, [], 'is not an open pull request'],
    ['missing from the datastore', null, [], 'is not an open pull request'],
    ['in a skipped repository', {}, [API], 'Skip repositories list'],
  ]

  for (const [behavior, replay] of [['review-new-prs', 'pr_review'], ['approve-prs', 'pr_approve']] as const) {
    it.each(pullRequestCases)(`${behavior}: a pull request %s`, async (_case, facts, skipped, expected) => {
      const { db, runtime } = await start()
      pulls = facts ? [pull(API, 1, facts)] : []
      runtime.setRepositorySkips(behavior, skipped)
      enable(db, behavior)
      runtime.startBehaviorsRuntime()
      await runtime.runEnabledBehaviorsOnce()
      const launched = actedOn(behavior).length === 1
      // Refused by the scan itself: never claimed, nothing asked of GitHub.
      const scanned = { github: githubCalls(API), ledger: ledgerRows(API) }
      const admission = await admitted(replay, API, 1)
      expect(launched).toBe(admission === true)
      if (expected === true) expect(admission).toBe(true)
      else {
        expect(admission).toContain(expected)
        expect(scanned).toEqual({ github: [], ledger: [] })
      }
    })
  }

  const issueCases: Array<[string, Record<string, unknown> | null, string[], string | true]> = [
    ['open, by a trusted author, opted in', {}, [API], true],
    ['by an author who is not trusted', { author: 'stranger' }, [API], 'not a trusted author'],
    ['closed', { status: 'closed' }, [API], 'is not an open issue'],
    ['missing from the datastore', null, [API], 'is not an open issue'],
    ['in a repository that is not opted in', {}, [], 'is not opted in'],
  ]

  it.each(issueCases)('review-new-issues: an issue %s', async (_case, facts, repos, expected) => {
    const { db, runtime } = await start()
    issues = facts ? [issue(API, 4, facts)] : []
    db.setMeta('behavior_review_new_issues_repos', JSON.stringify(repos.map((repo) => ({ repo, since: new Date(Date.now() - 60 * 60_000).toISOString() }))))
    enable(db, 'review-new-issues')
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    const launched = mocks.spawnDetached.mock.calls.filter(([, args]) => (args as string[])[0] === '--issue-review').length === 1
    const scanned = { github: githubCalls(API), ledger: ledgerRows(API) }
    const admission = await admitted('issue_review', API, 4)
    expect(launched).toBe(admission === true)
    if (expected === true) expect(admission).toBe(true)
    else {
      expect(admission).toContain(expected)
      expect(scanned).toEqual({ github: [], ledger: [] })
    }
  })
})
