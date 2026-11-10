import { BehaviorChainJournal, type ChainEvent } from '../../server/behavior-chain-store'
import type { ChainObservation } from '../../server/behavior-chain-decision'

/** Chain-owned failure, with real journal reduction and exact diagnostic identities. */
export function loggingWorkFixture(journal: BehaviorChainJournal, repository: string, issue: number, invocationId: string, callId: string, at: number) {
  let chain = journal.append(`${repository.toLowerCase()}#${issue}`, `seed:${repository}#${issue}:${invocationId}`, 0, { type: 'chain.admitted',
    repository, issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' }, at)
  const append = (event: ChainEvent, time: number) => {
    chain = journal.append(chain.id, `${chain.id}:${invocationId}:${chain.sequence}`, chain.sequence, event, time)
    return chain
  }
  const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const observation: ChainObservation = { checkedAt: at + 1000, existingPulls: [],
    issue: { open: true, eligible: true, revision: 'issue', commentIds: [] }, issueReviewers: [], prReviewers: [],
    implementer: reviewer, repairer: reviewer, approver: reviewer,
    publication: { pull_number: issue + 100, head_sha: 'a'.repeat(40), head_invocation: null, state: 'open', merged: false, merge_sha: null },
    pull: { number: issue + 100, head: 'a'.repeat(40), headSince: at, state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'review', reviewContext: 'b'.repeat(64), greyRuns: [], checksState: 'FAILURE',
      pending: false, failing: ['required check'], conflict: false, behind: false } }
  append({ type: 'chain.observed', observation }, at + 1000)
  append({ type: 'invocation.admitted', invocation: { id: invocationId, behavior: 'repair-pr', basis: 'repair', actor: 'author',
    model: 'fixture', slot: 'primary', admittedAt: at + 2000,
    request: { command: 'agent-interface', cwd: '/isolated/fixture', argv: [] } } }, at + 2000)
  append({ type: 'invocation.settled', invocationId, callId, outcome: 'preflight_failed',
    evidence: { status: 'failed', action: 'not_started', completedAt: at + 3000 } }, at + 3000)
  append({ type: 'chain.waiting', reason: 'repair-pr is in native failure backoff' }, at + 3000)
  return { chain, observation, append }
}
