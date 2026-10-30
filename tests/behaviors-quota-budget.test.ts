import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, loadModules, arrangeCli, recordCompletedInitialReview, fixture } from './behaviors-runtime-fixture'

// Core REST cost of one github-interface call, from the per-command table on
// #488: --requested-changes-addressed without an active request is get_pull +
// list_reviews; --head-sha and each resolve gate read is one REST call.
// --review-activity-since, --merge-candidates and --grey-ci-candidates are
// GraphQL and cost the core bucket nothing.
function coreRestCalls(): number {
  let total = 0
  for (const [command, args] of mocks.runFile.mock.calls) {
    if (command !== 'github-interface') continue
    if (args[0] === '--requested-changes-addressed') total += 2
    else if (args[0] === '--head-sha') total += 1
    else if (args[0] === '--resolve-nonblocking-conversations-if-ready') total += 3
  }
  return total
}

function cliCalls(flag: string): unknown[][] {
  return mocks.runFile.mock.calls.filter(([, args]) => args[0] === flag)
}

async function startApproving() {
  const { database: db, behaviors: runtime } = await loadModules()
  runtime.startBehaviorsRuntime()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_approve_prs_enabled', '1')
  return { db, runtime }
}

describe('approve-prs change gate', () => {
  it('skips the REST check while the datastore row is unchanged', async () => {
    arrangeCli(false)
    const { runtime } = await startApproving()

    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(1)
    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('re-checks in the first tick after the datastore row changes', async () => {
    arrangeCli(false)
    const { runtime } = await startApproving()

    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(1)
    fixture.listedPrs = [{ ...pr, updated_at: '2026-07-15T12:01:00Z' }]
    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(2)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('re-checks an unchanged PR once the staleness ceiling passes', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-07-15T12:00:00.000Z').getTime()
    vi.setSystemTime(start)
    arrangeCli(false)
    const { runtime } = await startApproving()

    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(1)
    vi.setSystemTime(start + 19 * 60_000)
    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(1)
    vi.setSystemTime(start + 21 * 60_000)
    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(2)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('re-checks when a completed clean review appears without a datastore change', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { db, runtime } = await startApproving()

    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(1)
    recordCompletedInitialReview(db, { completedAt: '2026-07-15T11:50:00.000Z', headSha: HEAD_SHA })
    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(2)
  })

  it('checks again while a launch for the PR is still in flight', async () => {
    arrangeCli(false)
    const { db, runtime } = await startApproving()

    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(1)
    // A review launch starts after the no-op watermark. Its completion
    // lands in the snapshot's local inputs, so the gate must not treat
    // the in-flight launch as steady state.
    const target = `${pr.repo}#${pr.number}`
    const claimId = db.claimSeenOwned('review-new-prs', target)
    expect(claimId).not.toBeNull()
    const marked = db.markBehaviorLaunchIntentOwned({
      key: 'review-new-prs',
      target,
      claimId: claimId!,
      launchBehavior: 'pr_review',
      repo: pr.repo,
      pr: pr.number,
      requestedAt: new Date().toISOString(),
      expectedHead: HEAD_SHA,
      actor: 'review-bot',
      source: 'poise:review-new-prs',
      correlationId: claimId!,
    })
    expect(marked).toBe(true)
    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(2)
  })

  it('never gates a launched check or a deferred one', async () => {
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { runtime } = await startApproving()

    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(1)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    // The fired target defers without recording a watermark, so the next
    // tick checks again instead of parking the PR until the ceiling.
    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(2)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('retries a held failure on unchanged input instead of gating it', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-07-15T12:00:00.000Z').getTime()
    vi.setSystemTime(start)
    arrangeCli(true, false, {}, { resolved_request_threads: '2', response_count: 3 })
    const { runtime } = await startApproving()

    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ behavior: 'approve-prs', target: `${pr.repo}#17:check` }),
    ])
    arrangeCli(false)
    vi.setSystemTime(start + 61_000)
    await runtime.runEnabledBehaviorsOnce()
    expect(cliCalls('--requested-changes-addressed')).toHaveLength(2)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
})

describe('resolve-unblocking readiness precheck', () => {
  async function startResolving() {
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    return { db, runtime }
  }

  it('skips the resolve call while the reviewer has not approved the head', async () => {
    arrangeCli(false, false, { unresolvedConversationCount: 1 })
    const { runtime } = await startResolving()

    await runtime.runEnabledBehaviorsOnce()

    expect(cliCalls('--review-activity-since')).toHaveLength(1)
    expect(cliCalls('--resolve-nonblocking-conversations-if-ready')).toHaveLength(0)
    expect(cliCalls('--head-sha')).toHaveLength(0)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('resolves with the activity head without a separate head lookup', async () => {
    arrangeCli(false, false, {
      unresolvedConversationCount: 1,
      reviewerLatestState: 'APPROVED',
      reviewerLatestCommit: HEAD_SHA,
      headSha: HEAD_SHA,
      activeChangeRequestAuthors: [],
      resolveResolvedCount: 1,
      resolveUnresolvedCount: 0,
    })
    const { runtime } = await startResolving()

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile).toHaveBeenCalledWith(
      'github-interface',
      [
        '--resolve-nonblocking-conversations-if-ready',
        `#${pr.number}`,
        '--username',
        'review-bot',
        '--expected-head',
        HEAD_SHA,
        '--token-user',
        'review-bot',
      ],
      expect.any(Object),
    )
    expect(cliCalls('--head-sha')).toHaveLength(0)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
})

describe('hourly core REST budget', () => {
  it('keeps 20 unchanged PRs over 60 ticks under 1,000 core calls', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-07-15T12:00:00.000Z').getTime()
    vi.setSystemTime(start)
    const updatedAt = '2026-07-15T11:59:00Z'
    fixture.listedPrs = Array.from({ length: 20 }, (_, index) => ({
      ...pr,
      number: pr.number + index,
      url: `https://github.com/${pr.repo}/pull/${pr.number + index}`,
      updated_at: updatedAt,
    }))
    arrangeCli(false)
    // Merge and grey-CI discovery are one GraphQL batch per tick; nothing is ready.
    const arranged = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && (args[0] === '--merge-candidates' || args[0] === '--grey-ci-candidates')) {
        const requests = JSON.parse(args[args.indexOf('--requests-json') + 1]) as Array<{ repository: string, number: number }>
        const actor = args[args.indexOf('--token-user') + 1]
        return {
          stdout: JSON.stringify({
            action: args[0] === '--merge-candidates' ? 'merge_candidates' : 'grey_ci_candidates',
            actor,
            graphql_cost: 1,
            records: requests.map((request) => ({
              ...request,
              ready: false,
              behind: false,
              head_sha: HEAD_SHA,
              author: 'poise-user',
              approved_at: null,
              queue_entry_id: null,
              runs: [],
              error: null,
            })),
          }),
          stderr: '',
        }
      }
      return arranged(command, args, options)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    for (const behavior of ['review-new-prs', 'approve-prs', 'resolve-unblocking', 'merge-prs', 'rerun-grey-ci'] as const) {
      db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
    }
    // Steady state: every PR already had its initial review, so the
    // review tick has no fresh candidates and only the polling ticks run.
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.setMeta('behavior_review_new_prs_snapshot_recovery_v2', '1')
    for (const row of fixture.listedPrs) db.recordSeen('review-new-prs', `${row.repo}#${row.number}`)

    for (let tick = 0; tick < 60; tick++) {
      await runtime.runEnabledBehaviorsOnce()
      vi.setSystemTime(start + (tick + 1) * 60_000)
    }

    expect(coreRestCalls()).toBeLessThanOrEqual(1000)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  }, 120_000)
})
