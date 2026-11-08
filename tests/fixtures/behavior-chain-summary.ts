import Database from 'better-sqlite3'
import { BehaviorChainJournal } from '../../server/behavior-chain-store'
import { behaviorChainAttention, behaviorChainSummary } from '../../server/behavior-chain-summary'
import { CheckSemaphore } from '../../server/check-semaphore'
import type { ChainObservation } from '../../server/behavior-chain-decision'

/** UI regression fixture: real isolated journal and production wire mapper,
 * never a behavior run or acceptance artifact. No global server DB is imported. */
export function chainSummaryFixture(state: 'unmerged' | 'pending-active' | 'pending-admitted' | 'pending-no-invocation' | 'pending-original-response' | 'complete' | 'historical') {
  const db = new Database(':memory:')
  try {
    const journal = new BehaviorChainJournal(db)
    const draining = journal.changeAdmission(0, 'draining')
    const cutover = journal.changeAdmission(draining.sequence, 'v2')
    let chain = journal.append('acme/repo#7', 'seed', 0, { type: 'chain.admitted', repository: 'acme/repo', issue: 7,
      branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
    const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
    const observation: ChainObservation = { checkedAt: Date.now(), existingPulls: [],
      issue: { open: false, eligible: true, revision: 'issue', commentIds: [] }, issueReviewers: [], prReviewers: [reviewer],
      implementer: reviewer, repairer: reviewer, approver: reviewer,
      publication: { pull_number: 17, head_sha: 'a'.repeat(40), head_invocation: null, state: 'closed', merged: true, merge_sha: 'a'.repeat(40) },
      pull: { number: 17, head: 'a'.repeat(40), headSince: Date.now() - 1000, state: 'closed', draft: false, merged: true,
        mergeSha: 'a'.repeat(40), mergedAt: Date.now() - 1000, queueEntry: null, queueRemoval: null, changesRequested: false,
        unresolved: 0, approved: false, ready: false, reviewIds: [], reviewReceipts: [], reviewRevision: 'missing',
        reviewContext: 'b'.repeat(64), greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }
    if (state === 'unmerged') {
      observation.issue.open = true
      Object.assign(observation.publication, { merged: false, state: 'open', merge_sha: null })
      Object.assign(observation.pull!, { merged: false, state: 'open', mergeSha: null, mergedAt: null })
    }
    chain = journal.append(chain.id, 'observed', chain.sequence, { type: 'chain.observed', observation })
    if (state === 'pending-active' || state === 'pending-admitted' || state === 'pending-original-response') {
      const direct = state === 'pending-original-response'
      chain = journal.append(chain.id, 'admit', chain.sequence, { type: 'invocation.admitted', invocation: { id: 'original-work',
        behavior: direct ? 'merge-pr' : 'repair-pr', actor: direct ? 'reviewer' : 'author', model: direct ? null : 'fixture',
        slot: direct ? null : 'primary', basis: 'original-work', admittedAt: Date.now(),
        request: { command: direct ? 'github-interface' : 'agent-interface', cwd: '/isolated/fixture', argv: direct
          ? ['--merge-if-ready', '17', '--expected-head', 'a'.repeat(40), '--token-user', 'reviewer']
          : ['--atomic-work', 'acme/repo#7', '--model', 'fixture'] } } })
      if (state !== 'pending-admitted') chain = journal.append(chain.id, 'uncertain', chain.sequence, {
        type: 'invocation.uncertain', invocationId: 'original-work', reason: 'original response missing' })
    }
    const pending = state.startsWith('pending')
    if (state !== 'unmerged') chain = journal.append(chain.id, 'merge', chain.sequence, { type: 'chain.merged', mergeSha: 'a'.repeat(40),
      evidence: { repository: chain.repository, pull_number: 17, merged: true, merge_sha: 'a'.repeat(40),
        ...(state === 'historical' ? {} : { review_complete: !pending }) } })
    if (state === 'pending-no-invocation') chain = journal.append(chain.id, 'held', chain.sequence, { type: 'chain.held',
      reason: 'qualifying original pre-merge review evidence is missing' })
    const before = journal.history(chain.id)
    journal.rebuild()
    const current = journal.read(chain.id)!
    const summary = behaviorChainSummary(current, { at: journal.reconciliationAt(current) })
    const semaphore = new CheckSemaphore(() => 4)
    const processSlots = semaphore.stats()
    if (JSON.stringify(journal.history(chain.id)) !== JSON.stringify(before)) throw new Error('summary fixture changed historical authority')
    return { chains: [summary], attention: behaviorChainAttention(journal), next: null, runtime: [], cutover: { ...cutover, blockers: [], support: { status: 'supported', error: null } },
      settings: { enabled: false, seedMode: 'label', label: 'work-ready' },
      capacity: { status: 'available', reservedModelInvocations: journal.liveModelInvocationCount(), modelInvocationLimit: semaphore.laneCapacity('behavior'),
        processLocal: { behaviorRunning: processSlots.behaviorRunning, allRunning: processSlots.running, cap: processSlots.cap },
        enabled: false, mode: cutover.mode, intake: { seedMode: 'label', label: 'work-ready' } } }
  } finally { db.close() }
}

/** Frozen regression cases from #917, using production journal/summary reads.
 * This is display evidence, not a live GitHub or execution acceptance claim. */
export function delayedChainFixture(journal: BehaviorChainJournal, now: number) {
  const admittedAt = now - 3 * 24 * 60 * 60_000
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  for (const [index, [issue, number]] of [[887, 893], [896, 900], [898, 901]].entries()) {
    let chain = journal.append(`autonomio/poise#${issue}`, `seed-${issue}`, 0, { type: 'chain.admitted',
      repository: 'autonomio/poise', issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' }, admittedAt + index * 60_000)
    const checkedAt = admittedAt + (index + 1) * 60 * 60_000
    const observation: ChainObservation = { checkedAt, existingPulls: [],
      issue: { open: true, eligible: true, revision: 'issue', commentIds: [] }, issueReviewers: [], prReviewers: [reviewer],
      implementer: reviewer, repairer: reviewer, approver: reviewer,
      publication: { pull_number: number, head_sha: 'a'.repeat(40), head_invocation: null, state: 'open', merged: false, merge_sha: null },
      pull: { number, head: 'a'.repeat(40), headSince: checkedAt, state: 'open', draft: false, merged: false, mergeSha: null,
        queueEntry: null, queueRemoval: null, changesRequested: index < 2, unresolved: index < 2 ? 1 : 0,
        approved: false, ready: false, reviewIds: [], reviewReceipts: [], reviewRevision: 'findings', reviewContext: 'b'.repeat(64),
        greyRuns: [], checksState: index < 2 ? 'SUCCESS' : 'FAILURE', pending: false,
        failing: index < 2 ? [] : ['Unit/integration (2/2):failure'], conflict: false, behind: false } }
    chain = journal.append(chain.id, `published-${issue}`, chain.sequence, { type: 'chain.observed', observation }, checkedAt)
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = `repair-${issue}-${attempt}`
      const completedAt = checkedAt + (attempt + 1) * 60_000
      chain = journal.append(chain.id, `${id}-admit`, chain.sequence, { type: 'invocation.admitted', invocation: { id,
        behavior: 'repair-pr', actor: chain.author, model: 'fixture', slot: 'primary', basis: 'repair', admittedAt: completedAt - 1,
        request: { command: 'agent-interface', cwd: '/isolated/fixture', argv: [] } } }, completedAt - 1)
      chain = journal.append(chain.id, `${id}-failed`, chain.sequence, { type: 'invocation.settled', invocationId: id,
        callId: id, outcome: 'preflight_failed', evidence: { status: 'failed', action: 'not_started', completedAt,
          error: index < 2 ? 'incomplete review replies' : 'required CI shard failed' } }, completedAt)
    }
    chain = journal.append(chain.id, `hold-${issue}`, chain.sequence, { type: 'chain.held',
      reason: `repair-pr failed before publication three times: ${index < 2 ? 'incomplete review replies' : 'required CI shard failed'}` }, checkedAt + 5 * 60_000)
    journal.append(chain.id, `poll-${issue}`, chain.sequence, { type: 'chain.observed', observation: { ...observation, checkedAt: now } }, now)
  }
  return { chains: journal.page().map(chain => behaviorChainSummary(chain, { at: journal.reconciliationAt(chain) })),
    attention: behaviorChainAttention(journal, now), next: null, runtime: [],
    cutover: { mode: 'v2', sequence: 0, legacyPulls: [], blockers: [], support: { status: 'supported', error: null } } }
}
