import type { WorkActionReceipt, WorkObservation, WorkStage } from '../../server/work-rehearsal'

// The same identities as the existing behavior runtime fixture; all external
// observations below are isolated stand-ins, except the labelled retained merge.
export const HEAD = 'a'.repeat(40)
export const NEXT_HEAD = 'd'.repeat(40)
export const NOW = Date.parse('2026-10-27T08:00:00Z')
export const TARGET = { repo: 'vaquum/poise-test', kind: 'pull' as const, number: 17,
  url: 'https://github.com/vaquum/poise-test/pull/17' }
export function pull(changes: Partial<Extract<WorkStage, { kind: 'pull' }>> = {}): WorkObservation {
  return { id: 'work-17', revision: 1, checkedAt: NOW, owner: 'rehearsal', mode: 'headless', held: false, refusal: null,
    stage: { kind: 'pull', target: TARGET, head: HEAD,
      ci: { head: HEAD, pending: false, failing: [], mergeable: true, mergeableState: 'clean', draft: false, state: 'open', merged: false },
      ciStuck: false, greyCiEligible: false, review: 'clean', reviewedHead: HEAD, unresolved: 0, approvedHead: HEAD,
      ready: true, mergeQueue: false, queueEntry: null, mergeSha: null, ...changes } }
}
export function receipt(changes: Partial<WorkActionReceipt> = {}): WorkActionReceipt {
  return { attempt: 'native-attempt-17', action: 'merge', basisRevision: 1, head: HEAD, issueBodyRevision: null,
    state: 'uncertain', retryAt: null, reference: 'behavior_seen:merge-prs:vaquum/poise-test#17', requestedAt: NOW, at: NOW, ...changes }
}
export function plan(): WorkObservation {
  return { ...pull(), stage: { kind: 'plan', card: 'plan-17', markdown: '# Fix login\n\nKeep this requirement.',
    context: ['card-chat:17@seq=12'], assigned: true } }
}
export function issue(): WorkObservation {
  return { ...pull(), stage: { kind: 'issue', target: { ...TARGET, kind: 'issues', url: 'https://github.com/vaquum/poise-test/issues/17' },
    bodyRevision: 'body-1', reviewedRevision: null, closed: false } }
}
