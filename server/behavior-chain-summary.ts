import { attributedNativeAction, matchingNativeActionReceipt, nativeActionSettlement } from './behavior-chain-action'
import { closedChainTarget, type ChainObservation } from './behavior-chain-decision'
import type { BehaviorChain } from './behavior-chain-store'

export function chainWaitsForResourceRelease(chain: BehaviorChain): boolean {
  return chain.invocations.some(invocation => invocation.state !== 'settled' && invocation.model !== null
    && !!closedChainTarget(chain, chain.observation as ChainObservation | null, invocation.behavior)
    && !(typeof invocation.evidence?.resources_settled_at === 'string' && Number.isFinite(Date.parse(invocation.evidence.resources_settled_at))))
}

/** Pure wire projection, shared by the HTTP handler and isolated browser fixtures. */
export function behaviorChainSummary(chain: BehaviorChain, reconciliation?: { at: number | null }) {
  const publication = chain.observation?.publication as { pull_number?: number | null } | undefined
  return { id: chain.id, repository: chain.repository, issue: chain.issue, branch: chain.branch, author: chain.author, reviewer: chain.reviewer,
    sequence: chain.sequence, held: chain.held, waiting: chain.waiting, mergeSha: chain.mergeSha,
    supersession: chain.supersession ?? null,
    reviewPending: chain.reviewPending ?? null,
    reviewStatus: chain.reviewPending === true ? 'pending' : chain.reviewPending === false ? 'complete' : 'not-recorded',
    reconciliation: reconciliation ? { nextObservationAt: reconciliation.at,
      ...(chainWaitsForResourceRelease(chain) ? { waitingForResourceRelease: true } : {}),
      waitingForOriginalResponse: reconciliation.at === null && chain.reviewPending === true
        && chain.invocations.some((invocation) => invocation.state !== 'settled' && attributedNativeAction(invocation)) } : null,
    pullNumber: publication?.pull_number ?? null,
    invocationCount: chain.invocations.length, invocations: chain.invocations.slice(-20).map((invocation) => {
      const proof = attributedNativeAction(invocation) ? matchingNativeActionReceipt(chain, invocation) : null
      const settlement = proof ? nativeActionSettlement(proof) : null
      return { id: invocation.id, behavior: invocation.behavior, state: invocation.state, callId: invocation.callId, model: invocation.model,
        slot: invocation.slot, outcome: invocation.outcome, admittedAt: invocation.admittedAt,
        nativeAction: !attributedNativeAction(invocation) ? null : {
          attribution: proof ? settlement!.status === 'completed' ? 'accepted-response' : 'observed-no-action'
            : invocation.state === 'uncertain' ? 'uncertain' : 'not-recorded',
          outcome: settlement?.outcome ?? null, queueEntryId: settlement?.queue_entry_id ?? null,
          receivedAt: proof?.observedAt ?? null, processFailure: proof?.processFailure ?? null,
        },
        evidence: invocation.evidence ? { action: invocation.evidence.action, outcome: invocation.evidence.outcome,
          review_id: invocation.evidence.review_id, head_sha: invocation.evidence.head_sha,
          resources_settled_at: invocation.evidence.resources_settled_at, error: invocation.evidence.error } : null,
      }
    }) }
}
