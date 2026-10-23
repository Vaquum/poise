import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { CATALOG_STDOUT } from './model-catalog-fixture'

// Reading Caller's local model catalog is not external work: no GitHub call,
// no launch. The pause assertions ignore it.
function externalCalls(): unknown[][] {
  return mocks.runFile.mock.calls.filter(([command, args]: any[]) => !(command === 'agent-interface' && args[0] === '--models'))
}

const mocks = vi.hoisted(() => ({
  captureAdmission: vi.fn(), captureOutcome: vi.fn(), observeSnapshot: vi.fn(),
  runFile: vi.fn(),
  spawnDetached: vi.fn(),
  authStatus: 'authenticated',
  requireAuth: vi.fn(),
  observeAuthFailure: vi.fn(),
  lockContention: false,
}))

vi.mock('../server/behavior-ledger', () => ({
  captureBehaviorAdmission: mocks.captureAdmission, captureBehaviorOutcome: mocks.captureOutcome,
  observeAgentSnapshot: mocks.observeSnapshot, behaviorLedgerHeartbeat: vi.fn(),
}))

vi.mock('../server/process', () => ({
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
  claudeSubscriptionEnvironment: () => ({
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CLI: '/poise/claude-subscription',
  }),
}))
vi.mock('../server/claude-auth', () => ({
  claudeAuth: {
    snapshot: () => ({ status: mocks.authStatus }),
    requireReady: mocks.requireAuth,
    observeProcessFailure: mocks.observeAuthFailure,
  },
}))
vi.mock('../server/process-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/process-lock')>()
  return {
    ...actual,
    withProcessLock: async <T>(
      options: import('../server/process-lock').ProcessLockOptions,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (mocks.lockContention) {
        const message = options.timeoutMessage || 'timed out waiting for process lock'
        throw options.errorFactory?.(message, new Error('SQLITE_BUSY')) ?? new Error(message)
      }
      return await actual.withProcessLock(options, operation)
    },
  }
})

const pr = {
  repo: 'Vaquum/poise-test',
  number: 17,
  url: 'https://github.com/Vaquum/poise-test/pull/17',
  status: 'open',
  author: 'poise-user',
  draft: 0,
  updated_at: '2026-07-15T12:00:00Z',
}
const HEAD_SHA = 'a'.repeat(40)
const NEXT_HEAD_SHA = 'd'.repeat(40)
let listedPrs = [pr]

let tempRoot = ''
let database: typeof import('../server/db') | null = null
let behaviors: typeof import('../server/behaviors') | null = null
let agentLogs: Array<Record<string, unknown>> = []

async function loadModules() {
  process.env.POISE_DB = join(tempRoot, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
  database.setMeta('org', 'Vaquum')
  database.setMeta('agentAccount', 'review-bot')
  behaviors = await import('../server/behaviors')
  return { database, behaviors }
}

async function restartModules() {
  await behaviors?.stopBehaviorsRuntime()
  if (database?.db.open) database.closeDatabase()
  behaviors = null
  database = null
  vi.resetModules()
  return loadModules()
}

// The agent-log lanes share a short-TTL snapshot, so a phase that changes
// the mocked log (or its mock) drops the cache first: the next read must
// see the new world, not the previous phase's snapshot. Boundaries after a
// loadModules/restartModules need no reset; those instances start empty.
async function resetLogCache() {
  (await import('../server/agent')).resetAgentLogCache()
}

interface ReviewActivityFixture {
  requestedReviewers?: string[]
  activeChangeRequestAuthors?: string[]
  unresolvedConversationCount?: number
  unresolvedLiveConversationCount?: number
  unresolvedConversationAuthors?: string[]
  unresolvedLiveConversationAuthors?: string[]
  headSha?: string
  state?: string
  draft?: boolean
  latestActivityAt?: string | null
  reviewerLatestState?: string | null
  reviewerLatestCommit?: string | null
  reviewerReviewsSince?: number
  // With ids, as github-interface reports them since Caller #39.
  reviewerReviewIdsSince?: number[]
  reviewerPendingReviews?: number
  resolveSuperseded?: boolean
  resolveUnresolvedCount?: number
  resolveBlockers?: string[]
  resolveResolvedCount?: number
  resolveError?: boolean
}

function arrangeCli(
  changesAddressed = false,
  failCheckout = false,
  reviewActivity: ReviewActivityFixture = {},
  changesEvidence: Record<string, unknown> = {},
): void {
  mocks.runFile.mockImplementation(async (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    if (command === 'github-datastore') {
      if (args[0] === 'health') {
        return {
          stdout: JSON.stringify({
            action: 'health',
            status: 'healthy',
            healthy: true,
            database: join(tempRoot, 'github.sqlite'),
            max_age_seconds: 120,
            age_seconds: 1,
            last_sync_at: new Date().toISOString(),
            last_success_at: new Date().toISOString(),
            checked_at: new Date().toISOString(),
          }),
          stderr: '',
        }
      }
      return { stdout: JSON.stringify(listedPrs), stderr: '' }
    }
    if (command === 'github-interface' && args[0] === '--local-checkout-path') {
      if (failCheckout) throw new Error('checkout unavailable')
      return {
        stdout: JSON.stringify({
          action: 'local_checkout_path',
          repository: `${args[1]}/${args[2]}`,
          path: tempRoot,
        }),
        stderr: '',
      }
    }
    if (command === 'agent-interface' && args[0] === '--models') {
      return { stdout: CATALOG_STDOUT, stderr: '' }
    }
    if (command === 'github-interface' && args[0] === '--head-sha') {
      const cwdParts = String(options?.cwd || '').split('/')
      const repository = cwdParts.length >= 2
        ? `${cwdParts[cwdParts.length - 2]}/${cwdParts[cwdParts.length - 1]}`
        : pr.repo
      const pullNumber = Number(String(args[1] || '').replace(/^#/, ''))
      return {
        stdout: JSON.stringify({
          action: 'head_sha',
          repository,
          pull_number: pullNumber,
          head_sha: reviewActivity.headSha ?? HEAD_SHA,
        }),
        stderr: '',
      }
    }
    const changesRecord = (repository: string, pullNumber: number, username: string) => ({
      action: 'requested_changes_addressed',
      repository,
      pull_number: pullNumber,
      username,
      status: changesAddressed,
      has_change_request: changesAddressed,
      reviewer_latest_state: changesAddressed ? 'CHANGES_REQUESTED' : null,
      reviewer_latest_commit: changesAddressed ? HEAD_SHA : null,
      latest_request_at: changesAddressed ? '2026-07-10T10:00:00Z' : null,
      head_sha: reviewActivity.headSha ?? HEAD_SHA,
      commits_after_request: changesAddressed ? 1 : 0,
      author_commits_after_request: changesAddressed ? 1 : 0,
      author_inline_replies_after_request: 0,
      response_count: changesAddressed ? 1 : 0,
      ...changesEvidence,
    })
    const activityRecord = (repository: string, pullNumber: number, reviewer: string) => {
      const requested = (reviewActivity.requestedReviewers || [])
        .some((login) => login.toLowerCase() === reviewer.toLowerCase())
      return {
        action: 'review_activity_since',
        repository,
        pull_number: pullNumber,
        username: reviewer,
        state: reviewActivity.state ?? 'OPEN',
        draft: reviewActivity.draft ?? false,
        head_sha: reviewActivity.headSha ?? HEAD_SHA,
        reviewer_requested: requested,
        active_change_request_authors: reviewActivity.activeChangeRequestAuthors ?? [],
        unresolved_conversation_count: reviewActivity.unresolvedConversationCount ?? 0,
        unresolved_outdated_conversation_count: Math.max(
          0,
          (reviewActivity.unresolvedConversationCount ?? 0)
            - (reviewActivity.unresolvedLiveConversationCount
              ?? reviewActivity.unresolvedConversationCount
              ?? 0),
        ),
        unresolved_live_conversation_count: reviewActivity.unresolvedLiveConversationCount
          ?? reviewActivity.unresolvedConversationCount
          ?? 0,
        unresolved_conversation_authors: reviewActivity.unresolvedConversationAuthors ?? [],
        unresolved_live_conversation_authors: reviewActivity.unresolvedLiveConversationAuthors
          ?? reviewActivity.unresolvedConversationAuthors
          ?? [],
        reviewer_latest_state: reviewActivity.reviewerLatestState ?? null,
        reviewer_latest_commit: reviewActivity.reviewerLatestCommit ?? null,
        reviewer_change_requests_since: 0,
        reviewer_approvals_since: 0,
        reviewer_reviews_since: reviewActivity.reviewerReviewIdsSince?.length ?? reviewActivity.reviewerReviewsSince ?? 0,
        ...(reviewActivity.reviewerReviewIdsSince
          ? { reviewer_reviews_since_items: reviewActivity.reviewerReviewIdsSince.map((id) => ({ id, node_id: `PRR_${id}`, state: 'COMMENTED', commit: HEAD_SHA, submitted_at: new Date().toISOString() })) }
          : {}),
        reviewer_pending_reviews: reviewActivity.reviewerPendingReviews ?? 0,
        latest_activity_at: reviewActivity.latestActivityAt ?? null,
      }
    }
    if (command === 'github-interface' && args[0] === '--requested-changes-addressed') {
      const username = args[args.indexOf('--username') + 1]
      if (args.includes('--requests-json')) {
        const requests = JSON.parse(args[args.indexOf('--requests-json') + 1]) as Array<{ repository: string, number: number }>
        return {
          stdout: JSON.stringify({
            action: 'requested_changes_addressed_batch',
            username,
            records: requests.map((request) => ({ ...changesRecord(request.repository, request.number, username), error: null })),
          }),
          stderr: '',
        }
      }
      const cwdParts = String(options?.cwd || '').split('/')
      const repository = cwdParts.length >= 2
        ? `${cwdParts[cwdParts.length - 2]}/${cwdParts[cwdParts.length - 1]}`
        : pr.repo
      const pullNumber = Number(String(args[1] || '').replace(/^#/, ''))
      return { stdout: JSON.stringify(changesRecord(repository, pullNumber, username)), stderr: '' }
    }
    if (command === 'github-interface' && args[0] === '--review-activity-since') {
      const reviewer = args[args.indexOf('--username') + 1]
      if (args.includes('--requests-json')) {
        const requests = JSON.parse(args[args.indexOf('--requests-json') + 1]) as Array<{ repository: string, number: number }>
        return {
          stdout: JSON.stringify({
            action: 'review_activity_since_batch',
            username: reviewer,
            records: requests.map((request) => ({ ...activityRecord(request.repository, request.number, reviewer), error: null })),
          }),
          stderr: '',
        }
      }
      const cwdParts = String(options?.cwd || '').split('/')
      const repository = cwdParts.length >= 2
        ? `${cwdParts[cwdParts.length - 2]}/${cwdParts[cwdParts.length - 1]}`
        : pr.repo
      const pullNumber = Number(String(args[1] || '').replace(/^#/, ''))
      return { stdout: JSON.stringify(activityRecord(repository, pullNumber, reviewer.toLowerCase())), stderr: '' }
    }
    if (command === 'github-interface' && args[0] === '--resolve-nonblocking-conversations-if-ready') {
      if (reviewActivity.resolveError) throw new Error('resolution failed')
      const cwdParts = String(options?.cwd || '').split('/')
      const repository = `${cwdParts[cwdParts.length - 2]}/${cwdParts[cwdParts.length - 1]}`
      const pullNumber = Number(args[1].replace(/^#/, ''))
      if (reviewActivity.resolveSuperseded) {
        return {
          stdout: JSON.stringify({
            action: 'resolved_nonblocking_conversations_if_ready',
            repository,
            pull_number: pullNumber,
            outcome: 'superseded',
            head_sha: HEAD_SHA,
            current_head_sha: NEXT_HEAD_SHA,
          }),
          stderr: '',
        }
      }
      return {
        stdout: JSON.stringify({
          ready_except_conversations: (reviewActivity.resolveResolvedCount ?? 0) > 0,
          action: 'resolved_nonblocking_conversations_if_ready',
          repository,
          pull_number: pullNumber,
          head_sha: reviewActivity.headSha ?? HEAD_SHA,
          reviewer_approved_current_head: (reviewActivity.resolveResolvedCount ?? 0) > 0,
          changes_requested: false,
          statuses_green: (reviewActivity.resolveResolvedCount ?? 0) > 0,
          checks_green: (reviewActivity.resolveResolvedCount ?? 0) > 0,
          checks_present: (reviewActivity.resolveResolvedCount ?? 0) > 0,
          blockers: reviewActivity.resolveBlockers
            ?? ((reviewActivity.resolveResolvedCount ?? 0) > 0 ? [] : ['reviewer_not_approved_current_head']),
          resolved_count: reviewActivity.resolveResolvedCount ?? 0,
          unresolved_count: reviewActivity.resolveUnresolvedCount ?? 0,
          latest_reviews: {},
          conversations: Array.from({ length: reviewActivity.resolveResolvedCount ?? 0 }, () => ({ id: 'thread' })),
        }),
        stderr: '',
      }
    }
    if (command === 'agent-interface' && args[0] === '--logs') {
      return { stdout: JSON.stringify(agentLogs), stderr: '' }
    }
    throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
  })
}

function agentLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const behavior = String(overrides.behavior || 'pr_review')
  const completed = overrides.status === 'completed'
  return {
    id: 'f'.repeat(32),
    pr_id: String(pr.number),
    repo: pr.repo,
    actor: 'review-bot',
    model: 'opus-4.7-max',
    behavior,
    session_id: null,
    prompt: '',
    started_at: new Date().toISOString(),
    started_at_precise: new Date().toISOString(),
    completed_at: completed ? new Date().toISOString() : null,
    time_elapsed: '1s',
    status: 'running',
    outcome: null,
    head_sha: null,
    expected_head: HEAD_SHA,
    source: behavior === 'pr_review' ? 'poise:review-new-prs' : 'poise:approve-prs',
    correlation_id: 'correlation-missing',
    action: null,
    response: null,
    error: '',
    ...overrides,
  }
}

function datastoreHealthOutput(): { stdout: string, stderr: string } {
  return {
    stdout: JSON.stringify({
      action: 'health',
      status: 'healthy',
      healthy: true,
      database: join(tempRoot, 'github.sqlite'),
      max_age_seconds: 120,
      age_seconds: 1,
      last_sync_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      checked_at: new Date().toISOString(),
    }),
    stderr: '',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function recordCompletedInitialReview(
  db: typeof import('../server/db'),
  options: {
    pull?: Pick<typeof pr, 'repo' | 'number'>
    target?: string
    completedAt?: string
    headSha?: string
    outcome?: 'clean' | 'changes_requested'
    callId?: string
  } = {},
): void {
  const pull = options.pull ?? pr
  const target = options.target ?? `${pull.repo}#${pull.number}`
  const claimId = db.claimSeenOwned('review-new-prs', target)
  if (!claimId) throw new Error('could not arrange initial review claim')
  const marked = db.markBehaviorLaunchIntentOwned({
    key: 'review-new-prs',
    target,
    claimId,
    launchBehavior: 'pr_review',
    repo: pull.repo,
    pr: pull.number,
    requestedAt: new Date().toISOString(),
    expectedHead: options.headSha ?? HEAD_SHA,
    actor: 'review-bot',
    source: 'poise:review-new-prs',
    correlationId: claimId,
  })
  const callId = options.callId ?? 'c'.repeat(32)
  const linked = db.linkBehaviorLaunchCallOwned('review-new-prs', target, claimId, callId)
  const completed = db.completeReviewLaunchOwned({
    key: 'review-new-prs',
    target,
    claimId,
    outcome: options.outcome ?? 'clean',
    completedAt: options.completedAt
      ?? new Date(Date.now() - (10 * 60_000) - 1).toISOString(),
    headSha: options.headSha ?? HEAD_SHA,
  })
  if (!marked || !linked || !completed) {
    throw new Error('could not arrange completed initial review')
  }
}

async function launchReviewBeforeCrash() {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.behaviors.startBehaviorsRuntime()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
  loaded.database.setMeta('behavior_review_new_prs_enabled', '1')
  loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
  await loaded.behaviors.runEnabledBehaviorsOnce()

  const target = `${pr.repo}#${pr.number}`
  const requestedAt = new Date(Date.now() - 10_000).toISOString()
  loaded.database.db.prepare(`
    UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
    WHERE key = 'review-new-prs' AND target = ?
  `).run(requestedAt, Date.now() - 1, target)
  const launch = loaded.database.db.prepare(`
    SELECT
      launch_correlation_id AS correlationId,
      launch_expected_head AS expectedHead,
      launch_actor AS actor,
      launch_source AS source
    FROM behavior_seen
    WHERE key = 'review-new-prs' AND target = ?
  `).get(target) as {
    correlationId: string
    expectedHead: string
    actor: string
    source: string
  }
  return { ...loaded, target, requestedAt, ...launch }
}

async function launchApprovalBeforeCrash() {
  arrangeCli(true)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  loaded.database.setMeta('me', 'poise-user')
  loaded.database.setMeta('behavior_approve_prs_enabled', '1')
  loaded.behaviors.startBehaviorsRuntime()
  await loaded.behaviors.runEnabledBehaviorsOnce()

  const target = `${pr.repo}#${pr.number}@req=2026-07-10T10:00:00Z/r=1/head=${HEAD_SHA}`
  const requestedAt = new Date(Date.now() - 10_000).toISOString()
  loaded.database.db.prepare(`
    UPDATE behavior_seen SET launch_requested_at = ?, lease_until = ?
    WHERE key = 'approve-prs' AND target = ?
  `).run(requestedAt, Date.now() - 1, target)
  const launch = loaded.database.db.prepare(`
    SELECT
      launch_correlation_id AS correlationId,
      launch_expected_head AS expectedHead,
      launch_actor AS actor,
      launch_source AS source
    FROM behavior_seen
    WHERE key = 'approve-prs' AND target = ?
  `).get(target) as {
    correlationId: string
    expectedHead: string
    actor: string
    source: string
  }
  return { ...loaded, target, requestedAt, ...launch }
}

beforeEach(async () => {
  mocks.captureAdmission.mockReset(); mocks.captureOutcome.mockReset(); mocks.observeSnapshot.mockReset()
  tempRoot = await mkdtemp(join(tmpdir(), 'poise-behavior-test-'))
  mocks.runFile.mockReset()
  mocks.spawnDetached.mockReset()
  mocks.authStatus = 'authenticated'
  mocks.requireAuth.mockReset().mockImplementation(() => {
    if (mocks.authStatus !== 'authenticated') throw new Error('Claude authentication required')
  })
  mocks.observeAuthFailure.mockReset()
  mocks.lockContention = false
  listedPrs = [pr]
  agentLogs = []
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
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

// Live fixture state belongs to this isolated Vitest file, including after restart.
export const fixture = {
  get tempRoot() { return tempRoot },
  get listedPrs() { return listedPrs },
  set listedPrs(value: typeof listedPrs) { listedPrs = value },
  get agentLogs() { return agentLogs },
  set agentLogs(value: typeof agentLogs) { agentLogs = value },
}

export { mocks, pr, HEAD_SHA, NEXT_HEAD_SHA, externalCalls, loadModules, restartModules, resetLogCache, arrangeCli, agentLog, datastoreHealthOutput, deferred, recordCompletedInitialReview, launchReviewBeforeCrash, launchApprovalBeforeCrash }
export type { ReviewActivityFixture }
