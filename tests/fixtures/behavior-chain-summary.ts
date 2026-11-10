import Database from 'better-sqlite3'
import { BehaviorChainJournal, type PublicationPlanCondition } from '../../server/behavior-chain-store'
import { behaviorChainSummary } from '../../server/behavior-chain-summary'
import { CheckSemaphore } from '../../server/check-semaphore'
import type { ChainObservation } from '../../server/behavior-chain-decision'

/** UI regression fixture: real isolated journal and production wire mapper,
 * never a behavior run or acceptance artifact. No global server DB is imported. */
export function chainSummaryFixture(state: 'unmerged' | 'pending-active' | 'pending-admitted' | 'pending-no-invocation' | 'pending-original-response' | 'complete' | 'historical', publicationPlan?: PublicationPlanCondition) {
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
      if (publicationPlan) chain = journal.append(chain.id, 'plan-condition', chain.sequence, {
        type: 'invocation.reconciled', invocationId: 'original-work', evidence: { publicationPlan } })
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
    return { chains: [summary], next: null, runtime: [], cutover: { ...cutover, blockers: [], support: { status: 'supported', error: null } },
      settings: { enabled: false, seedMode: 'label', label: 'work-ready' },
      capacity: { status: 'available', reservedModelInvocations: journal.liveModelInvocationCount(), modelInvocationLimit: semaphore.laneCapacity('behavior'),
        processLocal: { behaviorRunning: processSlots.behaviorRunning, allRunning: processSlots.running, cap: processSlots.cap },
        enabled: false, mode: cutover.mode, intake: { seedMode: 'label', label: 'work-ready' } } }
  } finally { db.close() }
}
