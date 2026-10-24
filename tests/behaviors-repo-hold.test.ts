import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_STDOUT } from './model-catalog-fixture'

// The repository hold: when the agent account cannot read a repository at
// all (GitHub 404 or NOT_FOUND for it), the PR behaviors record one held
// state for it instead of failing every sweep, skip it until access comes
// back, and recheck at most hourly. Caller is faked at the process boundary
// like in behaviors-repo-skips.test.ts.
const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn() }))

vi.mock('../server/process', () => ({
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
  runningCallerLaunches: () => 0,
  claudeSubscriptionEnvironment: () => ({ CLAUDE_CLI: '/poise/claude-subscription' }),
}))
vi.mock('../server/claude-auth', () => ({
  claudeAuth: {
    snapshot: () => ({ status: 'authenticated' }),
    requireReady: async () => undefined,
    observeProcessFailure: () => undefined,
  },
}))

const ME = 'poise-user'
const AGENT = 'review-bot'
const HEAD = 'a'.repeat(40)
const API = 'acme/api'
const WEB = 'acme/web'

let tempRoot = ''
let database: typeof import('../server/db') | null = null
let behaviors: typeof import('../server/behaviors') | null = null
let pulls: Array<Record<string, unknown>> = []
let changeRequested = false
let unresolvedConversations = 0
let healthFailure: Error | null = null
// Repositories github-interface answers 404/NOT_FOUND for, as if the agent
// account could not read them.
let deniedRepos = new Set<string>()
// Repositories whose candidates carry one grey workflow run to rerun.
let greyRunRepos = new Set<string>()
// A wholesale batch failure, unattributable to any one repository.
let batchEnvelopeFailure: Error | null = null

function pull(repo: string, number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo, number, url: `https://github.com/${repo}/pull/${number}`, status: 'open', author: ME, draft: 0, updated_at: '2026-07-15T12:00:00Z', ...overrides }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

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
  if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
  if (command === 'agent-interface' && args[0] === '--logs') return json([])
  if (command === 'github-interface') {
    const repository = githubRepository(args, options)
    const number = Number(String(args[1] || '').replace(/^#/, ''))
    const changesEvidence = (repo: string, num: number) => ({
      action: 'requested_changes_addressed', pr_author: 'poise-user', repository: repo, pull_number: num, username: flagValue(args, '--username'),
      status: changeRequested, has_change_request: changeRequested,
      reviewer_latest_state: changeRequested ? 'CHANGES_REQUESTED' : null,
      reviewer_latest_commit: changeRequested ? HEAD : null,
      latest_request_at: changeRequested ? '2026-07-10T10:00:00Z' : null, head_sha: HEAD,
      commits_after_request: changeRequested ? 1 : 0, author_commits_after_request: changeRequested ? 1 : 0,
      author_inline_replies_after_request: 0, response_count: changeRequested ? 1 : 0,
    })
    const activityEvidence = (repo: string, num: number) => ({
      action: 'review_activity_since', repository: repo, pull_number: num, username: flagValue(args, '--username'),
      state: 'OPEN', draft: false, head_sha: HEAD, reviewer_requested: false, active_change_request_authors: [],
      unresolved_conversation_count: unresolvedConversations, unresolved_live_conversation_count: unresolvedConversations,
      unresolved_conversation_authors: [], unresolved_live_conversation_authors: [],
      reviewer_latest_state: 'APPROVED', reviewer_latest_commit: HEAD, reviewer_reviews_since: 0, reviewer_pending_reviews: 0,
      latest_activity_at: null,
    })
    const batchRequests = (): Array<{ repository: string, number: number }> =>
      JSON.parse(args[args.indexOf('--requests-json') + 1])
    if (args[0] === '--local-checkout-path') return json({ action: 'local_checkout_path', repository, path: tempRoot })
    if (args[0] === '--head-sha') {
      if (deniedRepos.has(repository)) throw new Error('GitHub 404: Not Found')
      return json({ action: 'head_sha', repository, pull_number: number, head_sha: HEAD })
    }
    if (args[0] === '--requested-changes-addressed' && args.includes('--requests-json')) {
      return json({ action: 'requested_changes_addressed_batch', username: flagValue(args, '--username'),
        records: batchRequests().map((request) => deniedRepos.has(request.repository)
          ? { repository: request.repository, pull_number: request.number, error: 'GitHub 404: Not Found' }
          : { ...changesEvidence(request.repository, request.number), error: null }) })
    }
    if (args[0] === '--requested-changes-addressed') {
      if (deniedRepos.has(repository)) throw new Error('GitHub 404: Not Found')
      return json(changesEvidence(repository, number))
    }
    if (args[0] === '--review-activity-since' && args.includes('--requests-json')) {
      return json({ action: 'review_activity_since_batch', username: flagValue(args, '--username'),
        records: batchRequests().map((request) => deniedRepos.has(request.repository)
          ? { repository: request.repository, pull_number: request.number, error: 'GitHub 404: Not Found' }
          : { ...activityEvidence(request.repository, request.number), error: null }) })
    }
    if (args[0] === '--review-activity-since') {
      if (deniedRepos.has(repository)) throw new Error('GitHub 404: Not Found')
      return json(activityEvidence(repository, number))
    }
    if (args[0] === '--resolve-nonblocking-conversations-if-ready') {
      if (deniedRepos.has(repository)) throw new Error("[{'type': 'NOT_FOUND', 'path': ['repository'], 'message': 'Not Found.'}]")
      return json({
        action: 'resolved_nonblocking_conversations_if_ready', repository, pull_number: number, head_sha: HEAD,
        ready_except_conversations: false, reviewer_approved_current_head: false, changes_requested: false,
        statuses_green: false, checks_green: false, checks_present: false, blockers: ['reviewer_not_approved_current_head'],
        resolved_count: 0, unresolved_count: unresolvedConversations, conversations: [],
      })
    }
    if (args[0] === '--grey-ci-candidates') {
      if (batchEnvelopeFailure) throw batchEnvelopeFailure
      const requests = JSON.parse(args[2]!) as Array<{ repository: string, number: number }>
      return json({ action: 'grey_ci_candidates', actor: AGENT, graphql_cost: 1,
        records: requests.map((request) => deniedRepos.has(request.repository)
          ? { ...request, head_sha: null, author: null, runs: [], error: `Could not resolve to a Repository with the name '${request.repository}'.` }
          : { ...request, head_sha: HEAD, author: ME, error: null,
            runs: greyRunRepos.has(request.repository)
              ? [{ run_id: 100, run_attempt: 1, workflow_id: 7, status: 'completed', conclusion: 'cancelled',
                event: 'pull_request', created_at: '2026-07-15T12:00:00Z' }]
              : [] }) })
    }
    if (args[0] === '--rerun-grey-ci-if-ready') {
      // The preflight read the pull request, then its workflow run was gone.
      return json({ action: 'rerun_grey_ci_if_ready', repository, pull_number: number, head_sha: HEAD,
        run_id: Number(flagValue(args, '--run-id')), run_attempt: Number(flagValue(args, '--run-attempt')),
        outcome: 'read_failed', error: 'GitHub 404: Not Found' })
    }
    if (args[0] === '--merge-candidates') {
      if (batchEnvelopeFailure) throw batchEnvelopeFailure
      const requests = JSON.parse(args[2]!) as Array<{ repository: string, number: number }>
      return json({ action: 'merge_candidates', actor: AGENT, graphql_cost: 1,
        records: requests.map((request) => deniedRepos.has(request.repository)
          ? { ...request, head_sha: null, author: null, ready: false, behind: false, approved_at: null,
            error: `Could not resolve to a Repository with the name '${request.repository}'.` }
          : { ...request, head_sha: HEAD, author: ME, ready: true, behind: false, approved_at: null, error: null }) })
    }
    if (args[0] === '--merge-if-ready') {
      if (deniedRepos.has(repository)) throw new Error('GitHub 404: Not Found')
      return json({ action: 'merge_if_ready', repository, pull_number: number, head_sha: HEAD, outcome: 'merged', merge_sha: 'b'.repeat(40) })
    }
  }
  throw new Error(`unexpected CLI call: ${command} ${all.join(' ')}`)
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

type TestBehavior = 'review-new-prs' | 'approve-prs' | 'resolve-unblocking' | 'merge-prs' | 'rerun-grey-ci'

function enable(db: typeof import('../server/db'), behavior: TestBehavior): void {
  if (behavior === 'review-new-prs') {
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
  }
  if (behavior === 'approve-prs') changeRequested = true
  if (behavior === 'resolve-unblocking') unresolvedConversations = 1
  db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
}

function actedOn(behavior: TestBehavior): string[] {
  if (behavior === 'resolve-unblocking' || behavior === 'merge-prs') {
    const action = behavior === 'merge-prs' ? '--merge-if-ready' : '--resolve-nonblocking-conversations-if-ready'
    return mocks.runFile.mock.calls
      .filter(([command, args]) => command === 'github-interface' && args[0] === action)
      .map(([, args, options]) => `${githubRepository(args, options)}${args[1]}`)
  }
  if (behavior === 'rerun-grey-ci') {
    return mocks.runFile.mock.calls
      .filter(([command, args]) => command === 'github-interface' && args[0] === '--rerun-grey-ci-if-ready')
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

function githubCalls(repo: string): unknown[][] {
  return mocks.runFile.mock.calls.filter(([command, args, options]) => {
    if (command !== 'github-interface') return false
    if ((args as string[]).includes('--requests-json')) {
      const at = (args as string[]).indexOf('--requests-json') + 1
      const requests = JSON.parse((args as string[])[at]) as Array<{ repository: string }>
      return requests.some((request) => request.repository === repo)
    }
    return githubRepository(args as string[], options as { cwd?: string } | undefined) === repo
  })
}

function holdsOf(runtime: typeof import('../server/behaviors')) {
  return runtime.getBehaviorsRuntimeHealth().holds
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'poise-repo-hold-'))
  mocks.runFile.mockReset().mockImplementation(cli)
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  pulls = [pull(API, 1), pull(WEB, 2)]
  changeRequested = false
  unresolvedConversations = 0
  healthFailure = null
  deniedRepos = new Set()
  greyRunRepos = new Set()
  batchEnvelopeFailure = null
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
  await behaviors?.stopBehaviorsRuntime()
  vi.useRealTimers()
  if (database?.db.open) database.closeDatabase()
  behaviors = null
  database = null
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('Repository hold', () => {
  it('review-new-prs records one held diagnostic for a 404 repository and never calls it again', async () => {
    const { runtime } = await start()
    enable(database!, 'review-new-prs')
    deniedRepos.add(WEB)
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(actedOn('review-new-prs')).toEqual([`${API}#1`])
    expect(holdsOf(runtime)).toEqual([expect.objectContaining({ repo: WEB })])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])

    mocks.runFile.mockClear()
    mocks.spawnDetached.mockClear()
    await runtime.runEnabledBehaviorsOnce()

    expect(githubCalls(WEB)).toEqual([])
    expect(holdsOf(runtime)).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('approve-prs holds a repository whose checks answer 404', async () => {
    const { runtime } = await start()
    enable(database!, 'approve-prs')
    deniedRepos.add(WEB)
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(actedOn('approve-prs')).toEqual([`${API}#1`])
    expect(holdsOf(runtime)).toEqual([expect.objectContaining({ repo: WEB })])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])

    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()

    expect(githubCalls(WEB)).toEqual([])
    expect(holdsOf(runtime)).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('resolve-unblocking holds a repository whose resolve answers NOT_FOUND', async () => {
    const { runtime } = await start()
    enable(database!, 'resolve-unblocking')
    deniedRepos.add(WEB)
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(holdsOf(runtime)).toEqual([expect.objectContaining({ repo: WEB })])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])

    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()

    expect(githubCalls(WEB)).toEqual([])
    expect(holdsOf(runtime)).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('merge-prs holds a repository GraphQL cannot resolve', async () => {
    const { runtime } = await start()
    enable(database!, 'merge-prs')
    deniedRepos.add(WEB)
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(actedOn('merge-prs')).toEqual([`${API}#1`])
    expect(holdsOf(runtime)).toEqual([expect.objectContaining({ repo: WEB })])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])

    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()

    expect(githubCalls(WEB)).toEqual([])
    expect(holdsOf(runtime)).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('rerun-grey-ci holds a repository GraphQL cannot resolve', async () => {
    const { runtime } = await start()
    enable(database!, 'rerun-grey-ci')
    deniedRepos.add(WEB)
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(holdsOf(runtime)).toEqual([expect.objectContaining({ repo: WEB })])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])

    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()

    expect(githubCalls(WEB)).toEqual([])
    expect(holdsOf(runtime)).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it.each([
    ['approve-prs', '--requested-changes-addressed'],
    ['resolve-unblocking', '--review-activity-since'],
    ['rerun-grey-ci', '--grey-ci-candidates'],
  ] as const)('%s never holds another repository for an unscopable batch failure', async (behavior, batchCommand) => {
    const { runtime } = await start()
    enable(database!, behavior)
    // The unscoped shape from Caller's batch envelope: the error names a
    // repository but belongs to no single request in the batch.
    batchEnvelopeFailure = new Error(
      `GitHub merge candidate query failed: [{'message': "Could not resolve to a Repository with the name '${WEB}'.", 'path': []}]`)
    if (behavior !== 'rerun-grey-ci') {
      mocks.runFile.mockImplementation(async (command: string, all: string[], options?: { cwd?: string }) => {
        if (command === 'github-interface' && (all as string[])[0] === batchCommand) throw batchEnvelopeFailure
        return cli(command, all, options)
      })
    }
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(holdsOf(runtime)).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures.length).toBeGreaterThan(0)
  })

  it('a recheck that succeeds clears the hold and resumes the repository', async () => {
    const { db, runtime } = await start()
    enable(database!, 'merge-prs')
    deniedRepos.add(WEB)
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(holdsOf(runtime)).toHaveLength(1)

    // Access is restored after the hourly recheck comes due.
    deniedRepos.clear()
    const stored = JSON.parse(db.getMeta('behavior_repo_hold:review-bot:acme/web')!)
    db.setMeta('behavior_repo_hold:review-bot:acme/web', JSON.stringify({ ...stored, nextRecheckAtMs: Date.now() - 1 }))
    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()

    expect(githubCalls(WEB).length).toBeGreaterThan(0)
    expect(actedOn('merge-prs')).toContain(`${WEB}#2`)
    expect(holdsOf(runtime)).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('a recheck that fails differently ends the hold and records the failure', async () => {
    const { db, runtime } = await start()
    enable(database!, 'merge-prs')
    deniedRepos.add(WEB)
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(holdsOf(runtime)).toHaveLength(1)

    const stored = JSON.parse(db.getMeta('behavior_repo_hold:review-bot:acme/web')!)
    db.setMeta('behavior_repo_hold:review-bot:acme/web', JSON.stringify({ ...stored, nextRecheckAtMs: Date.now() - 1 }))
    deniedRepos.clear()
    mocks.runFile.mockImplementation(async (command: string, all: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && (all as string[])[0] === '--merge-candidates') {
        const requests = JSON.parse((all as string[])[2]!) as Array<{ repository: string, number: number }>
        return { stdout: JSON.stringify({ action: 'merge_candidates', actor: AGENT, graphql_cost: 1,
          records: requests.map((request) => request.repository === WEB
            ? { ...request, head_sha: null, author: null, ready: false, behind: false, approved_at: null,
              error: 'request timed out after 10 seconds' }
            : { ...request, head_sha: HEAD, author: ME, ready: true, behind: false, approved_at: null, error: null }) }), stderr: '' }
      }
      return cli(command, all, options)
    })
    await runtime.runEnabledBehaviorsOnce()

    expect(holdsOf(runtime)).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({
      behavior: 'merge-prs', target: `${WEB}#2`, error: expect.stringContaining('timed out'),
    })])
  })

  it('a 403 action refusal keeps its per-target failure and never holds the repository', async () => {
    const { runtime } = await start()
    enable(database!, 'merge-prs')
    mocks.runFile.mockImplementation(async (command: string, all: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && (all as string[])[0] === '--merge-candidates') {
        const requests = JSON.parse((all as string[])[2]!) as Array<{ repository: string, number: number }>
        return { stdout: JSON.stringify({ action: 'merge_candidates', actor: AGENT, graphql_cost: 1,
          records: requests.map((request) => request.repository === WEB
            ? { ...request, head_sha: HEAD, author: ME, ready: false, behind: false, approved_at: null,
              error: 'GitHub 403: Must have admin rights to Repository.' }
            : { ...request, head_sha: HEAD, author: ME, ready: true, behind: false, approved_at: null, error: null }) }), stderr: '' }
      }
      return cli(command, all, options)
    })
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(holdsOf(runtime)).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({
      behavior: 'merge-prs', target: `${WEB}#2`,
    })])
  })

  it('rerun-grey-ci keeps a deleted-run 404 as a per-target failure, never a hold', async () => {
    const { runtime } = await start()
    pulls = [pull(API, 1)]
    enable(database!, 'rerun-grey-ci')
    greyRunRepos.add(API)
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()

    expect(actedOn('rerun-grey-ci')).toEqual([`${API}#1`])
    expect(holdsOf(runtime)).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({
      behavior: 'rerun-grey-ci', target: `${API}#1:workflow:7:pull_request:${HEAD}`,
    })])
  })

  it('a quarantined launch never releases the repository hold', async () => {
    const { db, runtime } = await start()
    pulls = [pull(API, 1)]
    enable(database!, 'review-new-prs')
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(actedOn('review-new-prs')).toEqual([`${API}#1`])

    // Access is lost after the launch; the hold is recorded.
    db.setMeta('behavior_repo_hold:review-bot:acme/api', JSON.stringify({ repo: API, error: 'GitHub 404: Not Found',
      heldAtMs: Date.now(), nextRecheckAtMs: Date.now() + 3_600_000 }))
    // The agent log feed fails while the claim is still open.
    mocks.runFile.mockImplementation(async (command: string, all: string[], options?: { cwd?: string }) => {
      if (command === 'agent-interface' && all[0] === '--logs') throw new Error('shared log temporarily unavailable')
      return cli(command, all, options)
    })
    await (await import('../server/agent')).resetAgentLogCache()
    await runtime.runEnabledBehaviorsOnce()

    expect(db.listBehaviorLaunchClaims('review-new-prs')[0]?.launchQuarantine).toBe('unreadable')
    expect(holdsOf(runtime)).toEqual([expect.objectContaining({ repo: API })])
  })

  it('refuses a replay for a held repository, and admits it once the hold expires', async () => {
    const { db, runtime } = await start()
    db.setMeta('behavior_repo_hold:review-bot:acme/web', JSON.stringify({ repo: WEB, error: 'GitHub 404: Not Found',
      heldAtMs: Date.now(), nextRecheckAtMs: Date.now() + 3_600_000 }))
    await expect(runtime.admitReplay('pr_review', WEB, 2)).rejects.toThrow(
      `Replay refused: agent account has no access to ${WEB}; PR behaviors are held for this repository.`)
    await expect(runtime.admitReplay('pr_review', API, 1)).resolves.toMatchObject({ author: 'poise-user' })

    db.setMeta('behavior_repo_hold:review-bot:acme/web', JSON.stringify({ repo: WEB, error: 'GitHub 404: Not Found',
      heldAtMs: Date.now() - 7_200_000, nextRecheckAtMs: Date.now() - 1 }))
    await expect(runtime.admitReplay('pr_review', WEB, 2)).resolves.toMatchObject({ author: 'poise-user' })
  })
})
