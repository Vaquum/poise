import { describe, expect, it, vi } from 'vitest'
import { mocks, fixture, loadModules, restartModules, arrangeCli, pr, HEAD_SHA, NEXT_HEAD_SHA, recordCompletedInitialReview, agentLog } from './behaviors-runtime-fixture'

const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

async function initial(author = 'review-bot') {
  arrangeCli(false)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const { database: db, behaviors } = await loadModules()
  db.setMeta('me', 'poise-user')
  db.setMeta('behavior_review_new_prs_enabled', '1')
  db.setMeta('behavior_review_new_prs_keyver', '3')
  db.recordSeen('review-new-prs', '__snapshot_v3__')
  fixture.listedPrs = [{ ...pr, author }]
  return { db, behaviors }
}

describe('PR account routing', () => {
  it.each([
    ['poise-user', 'review-bot'], ['review-bot', 'poise-user'],
    ['REVIEW-BOT', 'poise-user'], ['POISE-USER', 'review-bot'],
  ])('reviews %s PRs as %s throughout preparation and launch', async (author, actor) => {
    const { db, behaviors } = await initial(author)
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    const args = mocks.spawnDetached.mock.calls[0][1] as string[]
    expect(value(args, '--actor')).toBe(actor)
    for (const [command, argv] of mocks.runFile.mock.calls) {
      if (command === 'github-interface' && ['--head-sha', '--requested-changes-addressed'].includes(argv[0])) {
        expect(value(argv, '--token-user')).toBe(actor)
      }
    }
    expect(db.db.prepare('SELECT launch_actor FROM behavior_seen WHERE launch_call_id IS NULL AND launch_behavior = ?').get('pr_review')).toEqual({ launch_actor: actor })
    expect(db.getMeta('me')).toBe('poise-user')
    expect(db.getMeta('agentAccount')).toBe('review-bot')
  })

  it('does not duplicate existing completed work when an unclaimed agent PR becomes eligible', async () => {
    const { db, behaviors } = await initial()
    recordCompletedInitialReview(db, { pull: { ...pr, number: 18 } })
    fixture.listedPrs.push({ ...pr, number: 18, url: pr.url.replace('/17', '/18') })
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    await restartModules()
    await (await import('../server/behaviors')).runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db).toBeDefined()
  })

  it('baselines both authors on genuine first enable', async () => {
    arrangeCli(false)
    const { database: db, behaviors } = await loadModules()
    db.setMeta('me', 'poise-user')
    fixture.listedPrs = [pr, { ...pr, number: 18, author: 'review-bot', url: pr.url.replace('/17', '/18') }]
    await behaviors.setEnabled('review-new-prs', true)
    await behaviors.runEnabledBehaviorsOnce()
    expect(db.hasSeen('review-new-prs', `${pr.repo}#17`)).toBe(true)
    expect(db.hasSeen('review-new-prs', `${pr.repo}#18`)).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('refuses missing, equal and third-party identities without launch', async () => {
    const { db, behaviors } = await initial('someone-else')
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    const { prReviewer } = await import('../server/pr-accounts')
    expect(() => prReviewer('someone-else')).toThrow('outside your configured')
    expect(prReviewer('someone-else', true)).toBe('review-bot')
    db.setMeta('agentAccount', 'POISE-USER')
    expect(() => prReviewer('poise-user')).toThrow('must be different')
    expect(behaviors.getBehaviorsRuntimeHealth().identity).toMatchObject({ status: 'invalid', error: expect.stringContaining('must be different') })
    db.setMeta('me', '')
    expect(() => prReviewer('review-bot')).toThrow('both')
  })

  it('abandons a prepared review when its selected account changes', async () => {
    const { db, behaviors } = await initial()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, options) => {
      const result = await original(command, args, options)
      if (command === 'github-interface' && args[0] === '--head-sha') db.setMeta('me', 'replacement-user')
      return result
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it.each([['review-bot', 'poise-user'], ['dependabot[bot]', 'review-bot'], ['contributor', 'review-bot']])('discovers %s and provisions its manual review as %s', async (author, actor) => {
    const { db } = await initial()
    db.setMeta('behavior_review_new_prs_enabled', '0')
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, options) => {
      const result = await original(command, args, options)
      if (command === 'github-interface' && args[0] === '--head-sha') {
        const packet = JSON.parse(result.stdout); packet.author = author
        return { ...result, stdout: JSON.stringify(packet) }
      }
      return result
    })
    const { triggerPrReview } = await import('../server/agent')
    await triggerPrReview(pr.url)
    expect(value(mocks.spawnDetached.mock.calls[0][1], '--actor')).toBe(actor)
    const headReads = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--head-sha')
    expect(value(headReads[0][1], '--token-user')).toBe('poise-user')
    expect(headReads.slice(1).every(([, args]) => value(args, '--token-user') === actor)).toBe(true)
  })

  it('abandons admission when accounts change after activity evidence', async () => {
    const { db, behaviors } = await initial()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, options) => {
      const result = await original(command, args, options)
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed') db.setMeta('me', 'replacement-user')
      return result
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('holds repository access per actor while the other account continues', async () => {
    const { behaviors } = await initial()
    fixture.listedPrs.push({ ...pr, number: 18, url: pr.url.replace('/17', '/18') })
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'github-interface' && args[0] === '--head-sha' && value(args, '--token-user') === 'poise-user') throw new Error('GitHub 404: Not Found')
      return original(command, args, options)
    })
    const { withNoticeDiagnosticIdentity } = await import('../server/logging-context')
    await withNoticeDiagnosticIdentity({ correlationId: 'outer', behavior: 'review-new-prs', repository: pr.repo, target: `${pr.repo}#17`, account: 'review-bot' }, () => behaviors.runEnabledBehaviorsOnce())
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(value(mocks.spawnDetached.mock.calls[0][1], '--actor')).toBe('review-bot')
    expect(behaviors.getBehaviorsRuntimeHealth().holds).toEqual([expect.objectContaining({ actor: 'poise-user' })])
    const reads = mocks.runFile.mock.calls.length
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.runFile.mock.calls.slice(reads).some(([, args]) => args[0] === '--head-sha' && value(args, '--token-user') === 'poise-user')).toBe(false)
  })

  it('does not use an approval basis from another actor', async () => {
    const { db } = await initial()
    recordCompletedInitialReview(db)
    expect(db.latestApprovalBasisLaunch(pr.repo, pr.number, 'review-bot')).not.toBeNull()
    expect(db.latestApprovalBasisLaunch(pr.repo, pr.number, 'poise-user')).toBeNull()
  })

  it('partitions mixed-author approval evidence by reviewer', async () => {
    const { db, behaviors } = await initial()
    db.setMeta('behavior_review_new_prs_enabled', '0')
    db.setMeta('behavior_approve_prs_enabled', '1')
    fixture.listedPrs = Array.from({ length: 24 }, (_, i) => ({ ...pr, number: i + 1, author: i % 2 ? 'review-bot' : 'poise-user', url: pr.url.replace('/17', `/${i + 1}`) }))
    await behaviors.runEnabledBehaviorsOnce()
    const reads = mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--requested-changes-addressed')
    expect(reads).toHaveLength(4)
    for (const [, args] of reads) {
      const requests = JSON.parse(value(args, '--requests-json')) as Array<{ number: number }>
      const reviewer = value(args, '--username')
      expect(value(args, '--token-user')).toBe(reviewer)
      for (const request of requests) expect(reviewer).toBe(request.number % 2 ? 'review-bot' : 'poise-user')
    }
  })

  it('holds manual change requests rather than automatically approving as the main user', async () => {
    const { db, behaviors } = await initial()
    db.setMeta('behavior_review_new_prs_enabled', '0')
    db.setMeta('behavior_approve_prs_enabled', '1')
    arrangeCli(true)
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.getMeta(`behavior_approve_prs_skip:${pr.repo}#17`)).toContain('no automated review receipt')
  })

  it('approves addressed automated findings with the same actor and its review receipts', async () => {
    const { db, behaviors } = await initial()
    db.setMeta('behavior_review_new_prs_enabled', '0')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { outcome: 'changes_requested' })
    db.db.prepare('UPDATE behavior_seen SET launch_actor = ? WHERE launch_repo = ?').run('poise-user', pr.repo)
    fixture.agentLogs = [agentLog({ id: 'c'.repeat(32), actor: 'poise-user', status: 'completed', action: 'requested_changes', outcome: 'changes_requested', head_sha: HEAD_SHA, review_id: 91, correlation_id: 'old-call', completed_at: new Date().toISOString() })]
    arrangeCli(true, false, { headSha: NEXT_HEAD_SHA, reviewerReviewIdsSince: [91] })
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(value(mocks.spawnDetached.mock.calls[0][1], '--actor')).toBe('poise-user')
    expect(mocks.spawnDetached.mock.calls[0][2].env.GITHUB_INTERFACE_AUTOMATED_REVIEWS).toBe('[91]')
  })

  it('holds an unclaimed manual thread or approval beside automated findings', async () => {
    const { db, behaviors } = await initial()
    db.setMeta('behavior_review_new_prs_enabled', '0')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { outcome: 'changes_requested' })
    db.db.prepare('UPDATE behavior_seen SET launch_actor = ? WHERE launch_repo = ?').run('poise-user', pr.repo)
    arrangeCli(true, false, { reviewerReviewIdsSince: [999] })
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(behaviors.getBehaviorsRuntimeHealth().failures.some((f) => f.error?.includes('Manual or unclaimed'))).toBe(true)
  })

  it.each(['pr_review', 'pr_approve'] as const)('refuses %s replay when accounts change during publication checks', async (behavior) => {
    const { db, behaviors } = await initial()
    db.setMeta('behavior_review_new_prs_enabled', '0')
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, options) => {
      const result = await original(command, args, options)
      if (command === 'github-interface' && args[0] === '--review-activity-since') db.setMeta('me', 'replacement-user')
      return result
    })
    await expect(behaviors.admitReplay(behavior, pr.repo, pr.number)).rejects.toThrow('GitHub accounts changed')
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    db.setMeta('me', 'poise-user')
    // Refusal releases the reservation so the original account can retry.
    mocks.runFile.mockImplementation(original)
    await expect(behaviors.admitReplay(behavior, pr.repo, pr.number)).resolves.toMatchObject({ actor: 'poise-user' })
  })

  it.each(['disable', 'skip', 'model'] as const)('stops approval when %s is saved during its final receipt lookup', async (change) => {
    const { db, behaviors } = await initial()
    db.setMeta('behavior_review_new_prs_enabled', '0')
    db.setMeta('behavior_approve_prs_enabled', '1')
    recordCompletedInitialReview(db, { outcome: 'changes_requested' })
    db.db.prepare('UPDATE behavior_seen SET launch_actor = ? WHERE launch_repo = ?').run('poise-user', pr.repo)
    fixture.agentLogs = [agentLog({ id: 'c'.repeat(32), actor: 'poise-user', status: 'completed', action: 'requested_changes', outcome: 'changes_requested', head_sha: HEAD_SHA, review_id: 91, correlation_id: 'old-call', completed_at: new Date().toISOString() })]
    arrangeCli(true, false, { headSha: NEXT_HEAD_SHA, reviewerReviewIdsSince: [91] })
    const agent = await import('../server/agent')
    const original = mocks.runFile.getMockImplementation()!
    let changed = false
    mocks.runFile.mockImplementation(async (command, args, options) => {
      const result = await original(command, args, options)
      if (command === 'github-interface' && args[0] === '--local-checkout-path') {
        agent.resetAgentLogCache()
        const read = agent.fetchAgentLogSnapshot
        vi.spyOn(agent, 'fetchAgentLogSnapshot').mockImplementationOnce(async (options) => {
          const snapshot = await read(options)
          if (change === 'model') db.setMeta('models', JSON.stringify({ pr_approve: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } }))
          else db.setMeta(change === 'disable' ? 'behavior_approve_prs_enabled' : 'behavior_approve_prs_skip_repos', change === 'disable' ? '0' : JSON.stringify([pr.repo]))
          changed = true
          return snapshot
        })
      }
      return result
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(changed).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it.each(['disable', 'skip'] as const)('stops resolution when %s is saved during its final receipt lookup', async (change) => {
    const { db, behaviors } = await initial()
    db.setMeta('behavior_review_new_prs_enabled', '0')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    arrangeCli(false, false, { reviewerLatestState: 'APPROVED', reviewerLatestCommit: HEAD_SHA, unresolvedConversationCount: 1, reviewerReviewIdsSince: [] })
    const agent = await import('../server/agent')
    const read = agent.fetchAgentLogSnapshot
    const original = mocks.runFile.getMockImplementation()!
    let changed = false
    mocks.runFile.mockImplementation(async (command, args, options) => {
      const result = await original(command, args, options)
      if (command === 'github-interface' && args[0] === '--review-activity-since') {
        // The first receipt read admits the candidate; the second prepares the mutation.
        vi.spyOn(agent, 'fetchAgentLogSnapshot').mockImplementationOnce(read).mockImplementationOnce(async (options) => {
          const snapshot = await read(options)
          db.setMeta(change === 'disable' ? 'behavior_resolve_unblocking_enabled' : 'behavior_resolve_unblocking_skip_repos', change === 'disable' ? '0' : JSON.stringify([pr.repo]))
          changed = true
          return snapshot
        })
      }
      return result
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(changed).toBe(true)
    expect(mocks.runFile.mock.calls.some(([, args]) => args[0] === '--resolve-nonblocking-conversations-if-ready')).toBe(false)
  })

  it('attributes a checkout access failure to the selected main account', async () => {
    const { behaviors } = await initial()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'github-interface' && args[0] === '--local-checkout-path') {
        const message = `error: checkout not found under /fixture: ${pr.repo}`
        throw Object.assign(new Error(message), { code: 1, stderr: message })
      }
      if (command === 'github-interface' && args[0] === '--checkout-repo') {
        expect(value(args, '--token-user')).toBe('poise-user')
        throw new Error('GitHub 404: Not Found')
      }
      return original(command, args, options)
    })
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(behaviors.getBehaviorsRuntimeHealth().holds).toEqual([expect.objectContaining({ actor: 'poise-user' })])
  })

  it('keeps the other account held after a successful main-account review', async () => {
    const { db, behaviors } = await initial()
    const key = `behavior_repo_hold:review-bot:${pr.repo.toLowerCase()}`
    db.setMeta(key, JSON.stringify({ repo: pr.repo, actor: 'review-bot', error: 'GitHub 404: Not Found', heldAtMs: Date.now(), nextRecheckAtMs: Date.now() + 3_600_000 }))
    await behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.getMeta(key)).not.toBe('')
    expect(behaviors.getBehaviorsRuntimeHealth().holds).toEqual([expect.objectContaining({ actor: 'review-bot' })])
  })

  it.each(['manual', 'replay'] as const)('refuses %s launch when accounts change during the final model lookup', async (mode) => {
    const { db } = await initial()
    db.setMeta('behavior_review_new_prs_enabled', '0')
    const models = await import('../server/models')
    const original = mocks.runFile.getMockImplementation()!
    let checkoutReady = false
    mocks.runFile.mockImplementation(async (command, args, options) => {
      const result = await original(command, args, options)
      if (command === 'github-interface' && args[0] === '--head-sha') {
        return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), author: 'review-bot' }) }
      }
      if (command === 'github-interface' && args[0] === '--local-checkout-path') {
        checkoutReady = true
        models.invalidateCatalog()
      }
      if (checkoutReady && command === 'agent-interface' && args[0] === '--models') db.setMeta('me', 'replacement-user')
      return result
    })
    const agent = await import('../server/agent')
    const launch = mode === 'manual' ? agent.triggerPrReview(pr.url)
      : agent.replayAgentJob({ behavior: 'pr_review', repo: pr.repo, pr_id: pr.number }, async () => ({ author: 'review-bot', actor: 'poise-user' }))
    await expect(launch).rejects.toThrow('GitHub accounts changed')
    expect(checkoutReady).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })
})
