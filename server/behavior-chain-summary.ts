import { attributedNativeAction, matchingNativeActionReceipt, nativeActionSettlement } from './behavior-chain-action'
import { CHAIN_OBSERVATION_MAX_AGE_MS, chainReviewResponse, closedChainTarget, type ChainObservation } from './behavior-chain-decision'
import { reduceChain, type BehaviorChain, type BehaviorChainJournal, type ChainEvent } from './behavior-chain-store'

export const CHAIN_ATTENTION_DELAY_MS = 24 * 60 * 60_000

/** Effective blocking conversations, mirroring decideBehaviorChain: live
 * threads always block, outdated ones only while readiness stays red on
 * conversation blockers. */
function blockingThreads(pull: NonNullable<ChainObservation['pull']>): number {
  if (pull.unresolved) return pull.unresolved
  if (!pull.ready && Array.isArray(pull.readinessBlockers) && pull.readinessBlockers.length > 0
    && pull.readinessBlockers.every(blocker => blocker === 'merge_state_not_clean' || blocker === 'required_reviews_not_approved')) {
    return Number.isSafeInteger(pull.unresolvedOutdated) ? pull.unresolvedOutdated as number : 0
  }
  return 0
}

function exactPull(observation: ChainObservation | null) {
  const pull = observation?.pull
  return pull && /^[a-f0-9]{40}$/i.test(pull.head) && observation!.publication?.pull_number === pull.number
    && observation!.publication.head_sha === pull.head && Array.isArray(pull.failing) && Array.isArray(pull.reviewReceipts)
    && ['pending', 'approved', 'changesRequested', 'conflict', 'behind'].every(key => typeof pull[key as keyof typeof pull] === 'boolean')
    && Number.isSafeInteger(pull.unresolved) ? pull : null
}

/** Derive the clock from immutable history, never the latest poll or attempt.
 * Replaying here leaves reducer state and historical hashes unchanged. */
function chainProgress(journal: BehaviorChainJournal, id: string) {
  let chain: BehaviorChain | null = null
  let at = 0, sequence = 0, after = 0
  let previous: ChainObservation['pull'] = null
  const verified = new Set<string>()
  for (;;) {
    const events = journal.history(id, after)
    for (const row of events) {
      const event = JSON.parse(row.payload) as ChainEvent
      chain = reduceChain(chain, event, row.sequence, id)
      let advanced = event.type === 'chain.admitted'
      const record = (key: string) => { if (!verified.has(key)) { verified.add(key); advanced = true } }
      if (event.type === 'chain.merged') record(`merge:${chain.mergeSha}:${chain.reviewPending}`)
      if (event.type === 'invocation.settled' || event.type === 'invocation.reconciled') {
        const invocation = chain.invocations.find(invocation => invocation.id === event.invocationId)!
        const receipt = matchingNativeActionReceipt(chain, invocation)
        if (receipt?.result.outcome === 'enqueued') record(`queue:${receipt.result.head_sha}:${receipt.result.queue_entry_id}`)
      }
      if (['chain.observed', 'invocation.settled', 'invocation.reconciled'].includes(event.type)) {
        const observation = chain.observation as ChainObservation | null
        if (observation && Number.isFinite(observation.checkedAt) && observation.checkedAt <= row.at
          && row.at - observation.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS) {
          const pull = exactPull(observation)
          if (pull) {
            record(`head:${pull.number}:${pull.head}`)
            if (pull.queueEntry) record(`queue:${pull.head}:${pull.queueEntry}`)
            if (event.type === 'chain.observed') {
              if (previous?.head === pull.head && (
                (pull.checksState === 'SUCCESS' && !pull.pending && !pull.failing.length
                  && (previous.checksState !== 'SUCCESS' || previous.pending || previous.failing.length > 0))
                || (!previous.approved && pull.approved) || (previous.changesRequested && !pull.changesRequested)
                || (blockingThreads(pull) < blockingThreads(previous)
                  && ((pull.unresolved ?? 0) < (previous.unresolved ?? 0)
                    || (pull.unresolvedOutdated ?? 0) < (previous.unresolvedOutdated ?? 0)))
                || (previous.conflict && !pull.conflict) || (previous.behind && !pull.behind))) advanced = true
              previous = pull
            }
          }
          for (const invocation of chain.invocations) {
            if (invocation.state !== 'settled' || invocation.evidence?.status !== 'completed') continue
            if (pull && ['review-pr', 'approve-pr'].includes(invocation.behavior)
              && chainReviewResponse(chain, invocation, observation, row.at)) record(`review:${invocation.evidence.review_id}`)
            if (invocation.behavior === 'review-issue' && invocation.evidence.action === 'commented'
              && invocation.evidence.issue_revision === observation.issue?.revision && Array.isArray(observation.issue?.commentIds)
              && Array.isArray(invocation.evidence.receipts)) {
              for (const receipt of invocation.evidence.receipts as Array<{ issue: string, author: string, comment_id: number }>) {
                if (receipt.issue?.toLowerCase() === id.toLowerCase() && receipt.author?.toLowerCase() === chain.reviewer.toLowerCase()
                  && observation.issue.commentIds.includes(receipt.comment_id)) record(`comment:${receipt.comment_id}`)
              }
            }
          }
        }
      }
      if (advanced) { at = row.at; sequence = row.sequence }
    }
    if (events.length < 100) break
    after = events.at(-1)!.sequence
  }
  if (!chain) throw new Error(`behavior chain admission history is unavailable: ${id}`)
  return { at, sequence }
}

/** Read-only attention across every active page, including unpublished issues
 * and merged chains whose original review obligation remains open. */
export function behaviorChainAttention(journal: BehaviorChainJournal, now = Date.now()) {
  const entries = []
  let after = ''
  for (;;) {
    const chains = journal.active(after)
    for (const chain of chains) {
      const progress = chainProgress(journal, chain.id)
      const active = chain.invocations.find(invocation => invocation.state !== 'settled')
      const ageMs = Math.max(0, now - progress.at)
      if (!chain.held && !chain.reviewPending && active?.state !== 'uncertain' && ageMs < CHAIN_ATTENTION_DELAY_MS) continue
      const observation = chain.observation as ChainObservation | null
      const pull = exactPull(observation)
      const state = !observation ? 'unavailable' : !Number.isFinite(observation.checkedAt) || observation.checkedAt > now
        || typeof observation.issue?.open !== 'boolean'
        ? 'incomplete' : now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS ? 'stale'
          : observation.pull && (!pull || !['SUCCESS', 'PENDING', 'EXPECTED', 'FAILURE', 'ERROR'].includes(pull.checksState ?? '')) ? 'incomplete' : 'fresh'
      const gates = pull ? [
        `Head ${pull.head.slice(0, 12)}`,
        pull.failing?.length ? `CI failing: ${pull.failing.join(', ')}` : pull.pending ? 'Required CI pending'
          : pull.checksState === 'SUCCESS' ? 'Required CI passed' : 'Required CI unverified',
        pull.changesRequested ? 'Review changes requested' : 'No change requests observed',
        pull.approved ? 'Current-head approval observed' : 'Current-head approval required',
        ...(pull.unresolved ? [`${pull.unresolved} unresolved review conversation(s)`] : []),
        ...(pull.conflict ? ['Branch conflict requires repair'] : []),
        ...(pull.behind ? ['Native policy requires a base update'] : []),
        ...(pull.readinessBlockers ?? []),
        ...(pull.queueEntry ? ['Native queue owns the candidate; merge completion unverified'] : []),
      ] : [observation?.pull ? 'Exact-head PR evidence incomplete; merge gates unverified'
        : 'No verified PR evidence; merge completion unverified']
      const last = chain.invocations.at(-1)
      let next = chain.reviewPending ? 'Reconcile original pre-merge review evidence; no new invocation can start after merge'
        : active?.state === 'uncertain' ? 'Reconcile the original invocation receipt before any retry'
          : chain.held ? 'Resolve the durable hold, then explicitly resume the chain'
            : active ? 'Await the original invocation outcome'
              : state !== 'fresh' ? 'Await a fresh, complete chain observation'
                : pull?.queueEntry ? 'Await verified GitHub merge completion; a queue receipt cannot establish a merge'
                  : pull?.failing.length ? 'Repair the failing required checks'
                    : pull?.changesRequested ? 'Address current-head review findings'
                      : pull?.conflict || pull?.behind ? 'Repair the branch conflict or required base update'
                        : pull?.pending && Number.isFinite(pull.headSince) && now - pull.headSince >= 30 * 60_000
                          ? 'Diagnose the checks pending over 30 minutes through repair-pr'
                          : pull?.pending ? 'Await exact-head CI completion'
                            : pull && !pull.approved ? 'Obtain qualifying current-head review and approval'
                            : chain.waiting || 'Await the next invocation under existing admission gates'
      let retryAt: number | null = null
      if (!chain.held && !chain.reviewPending && !active && last && chain.waiting === `${last.behavior} is in native failure backoff`) {
        const attempts = chain.invocations.filter(invocation => invocation.behavior === last.behavior && invocation.basis === last.basis
          && invocation.slot === last.slot && invocation.state === 'settled' && invocation.evidence?.status !== 'deferred'
          && invocation.admissionSequence > chain.resumedAfterSequence)
        if (attempts.length > 0 && attempts.length < 3 && (last.evidence?.action === 'not_started' || last.evidence?.outcome === 'superseded')
          && Number.isFinite(last.evidence?.completedAt)) {
          retryAt = Number(last.evidence!.completedAt) + 60_000 * 2 ** (attempts.length - 1)
          next = 'Automatic retry eligible after backoff, subject to existing admission gates'
        }
      }
      const preview = (value: string) => value.length <= 1024 ? value : `${value.slice(0, 1023)}…`
      entries.push({ id: chain.id, repository: chain.repository, issue: chain.issue,
        pullNumber: observation?.publication?.pull_number ?? null,
        step: active ? `${active.behavior}: ${active.state}` : chain.reviewPending ? 'Merged; review evidence pending'
          : !chain.held ? chain.waiting || (pull ? 'PR merge gates' : 'Issue admission')
          : last ? `${last.behavior}: ${last.outcome ?? last.state}` : 'Issue admission',
        progressAt: progress.at, ageMs,
        blocker: preview([chain.held, active?.state === 'uncertain' ? active.outcome || 'Original receipt unverified' : null,
          chain.reviewPending ? 'Original pre-merge review evidence pending' : null, chain.waiting].filter(Boolean).join('; ')
          || 'No verified progress for at least 24 hours'),
        evidence: { state, checkedAt: observation?.checkedAt ?? null, gates: gates.map(preview) },
        nextAction: preview(next), retryAt,
        reconciliation: { nextObservationAt: journal.reconciliationAt(chain), waitingForResourceRelease: chainWaitsForResourceRelease(chain) },
        journal: `/api/behavior-chains?${new URLSearchParams({ id: chain.id, after: String(Math.max(0, progress.sequence - 1)) })}` })
    }
    if (chains.length < 100) break
    after = chains.at(-1)!.id
  }
  return entries.sort((a, b) => a.progressAt - b.progressAt || a.id.localeCompare(b.id))
}

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
