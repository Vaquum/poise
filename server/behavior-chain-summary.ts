import { attributedNativeAction, matchingNativeActionReceipt, nativeActionSettlement } from './behavior-chain-action'
import { CHAIN_OBSERVATION_MAX_AGE_MS, chainReviewResponse, closedChainTarget, lastChainQueueInvocation, type ChainObservation } from './behavior-chain-decision'
import { chainBasis, reduceChain, type BehaviorChain, type BehaviorChainJournal, type ChainEvent } from './behavior-chain-store'

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

/** Missing required PR-review slot, mirroring decideBehaviorChain review-pr first:
 * any configured reviewer without a completed review-pr on the current head
 * and review context (base/title/body) needs review. */
function needsPrReview(chain: BehaviorChain, observation: ChainObservation | null, pull: NonNullable<ChainObservation['pull']>): boolean {
  if (!observation || !Array.isArray(observation.prReviewers) || observation.prReviewers.length === 0) return false
  const expected = chainBasis(['pr', pull.head, pull.reviewContext])
  return observation.prReviewers.some(reviewer => !chain.invocations.some(invocation =>
    invocation.behavior === 'review-pr' && invocation.evidence?.status === 'completed'
    && invocation.basis === expected
    && (invocation.evidence.head_sha === pull.head || invocation.request.context?.head === pull.head)
    && invocation.slot === reviewer.slot))
}

/** Completed issue review without its posted GitHub comment, mirroring
 * decideBehaviorChain reviewComplete: the original evidence remains
 * unverified and the chain holds instead of reviewing again. */
function issueReviewMissingArtifact(chain: BehaviorChain, observation: ChainObservation | null): boolean {
  if (!observation || !Array.isArray(observation.issueReviewers) || observation.issueReviewers.length === 0) return false
  const basis = chainBasis(['issue', observation.issue.revision])
  return observation.issueReviewers.some(reviewer => {
    const invocation = [...chain.invocations].reverse().find(candidate =>
      candidate.behavior === 'review-issue' && candidate.basis === basis && candidate.slot === reviewer.slot
      && candidate.state === 'settled' && candidate.evidence?.status === 'completed')
    if (!invocation) return false
    const evidence = invocation.evidence as Record<string, unknown>
    if (evidence.action !== 'commented' || evidence.issue_revision !== observation.issue.revision || !Array.isArray(evidence.receipts)) return true
    return !(evidence.receipts as Array<{ issue?: unknown, author?: unknown, comment_id?: unknown }>).some(receipt =>
      typeof receipt.issue === 'string' && receipt.issue.toLowerCase() === `${chain.repository}#${chain.issue}`.toLowerCase()
      && typeof receipt.author === 'string' && receipt.author.toLowerCase() === chain.reviewer.toLowerCase()
      && typeof receipt.comment_id === 'number' && observation.issue.commentIds.includes(receipt.comment_id))
  })
}

/** Completed PR review without its exact-head submission receipt, mirroring
 * decideBehaviorChain reviewComplete: the original evidence remains
 * unverified and the chain holds instead of advancing downstream. */
function prReviewMissingArtifact(chain: BehaviorChain, observation: ChainObservation | null, pull: NonNullable<ChainObservation['pull']>): boolean {
  if (!observation || !Array.isArray(observation.prReviewers) || observation.prReviewers.length === 0) return false
  const expected = chainBasis(['pr', pull.head, pull.reviewContext])
  return observation.prReviewers.some(reviewer => {
    const invocation = [...chain.invocations].reverse().find(candidate =>
      candidate.behavior === 'review-pr' && candidate.basis === expected && candidate.slot === reviewer.slot
      && candidate.state === 'settled' && candidate.evidence?.status === 'completed')
    if (!invocation) return false
    const evidence = invocation.evidence!
    if (!chainReviewResponse(chain, invocation, observation, observation.checkedAt)) return true
    if (typeof evidence.review_id !== 'number' || !(evidence.review_id > 0)) return true
    if (!observation.pull?.reviewIds.includes(evidence.review_id)) return true
    if (evidence.head_sha !== observation.pull?.head) return true
    if (!['reviewed_clean', 'requested_changes'].includes(String(evidence.action))) return true
    return false
  })
}

/** Missing required issue review, mirroring decideBehaviorChain review-issue
 * first: any configured reviewer without a completed review-issue for the
 * current seed revision and its posted comment needs review. */
function needsIssueReview(chain: BehaviorChain, observation: ChainObservation | null): boolean {
  if (!observation || !Array.isArray(observation.issueReviewers) || observation.issueReviewers.length === 0) return false
  const basis = chainBasis(['issue', observation.issue.revision])
  return observation.issueReviewers.some(reviewer => {
    const invocation = [...chain.invocations].reverse().find(candidate =>
      candidate.behavior === 'review-issue' && candidate.basis === basis && candidate.slot === reviewer.slot
      && candidate.state === 'settled' && candidate.evidence?.status === 'completed')
    if (!invocation) return true
    const evidence = invocation.evidence as Record<string, unknown>
    if (evidence.action !== 'commented' || evidence.issue_revision !== observation.issue.revision || !Array.isArray(evidence.receipts)) return true
    return !(evidence.receipts as Array<{ issue?: unknown, author?: unknown, comment_id?: unknown }>).some(receipt =>
      typeof receipt.issue === 'string' && receipt.issue.toLowerCase() === `${chain.repository}#${chain.issue}`.toLowerCase()
      && typeof receipt.author === 'string' && receipt.author.toLowerCase() === chain.reviewer.toLowerCase()
      && typeof receipt.comment_id === 'number' && observation.issue.commentIds.includes(receipt.comment_id))
  })
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
      const lastQueue = pull ? lastChainQueueInvocation(chain) : undefined
      const queueRemoval = pull?.queueRemoval ?? null
      // Mirroring decideBehaviorChain: a previously queued head without current
      // removal evidence waits for that evidence instead of review or repair.
      const queueAwaitingRemoval = !!pull && lastQueue?.evidence?.head_sha === pull.head
        && (!queueRemoval || typeof queueRemoval.at !== 'number' || queueRemoval.at < lastQueue.admittedAt)
      const queueMergedNeedsWait = !!pull && lastQueue?.evidence?.head_sha === pull.head
        && !!queueRemoval && typeof queueRemoval.at === 'number' && queueRemoval.at >= lastQueue.admittedAt
        && queueRemoval.reason === 'merged'
      // Mirroring decideBehaviorChain: a removal for any other reason than a
      // merge or an integration rejection needs an explicit queue decision.
      const queueRemovalNeedsDecision = !!pull && lastQueue?.evidence?.head_sha === pull.head
        && !!queueRemoval && typeof queueRemoval.at === 'number' && queueRemoval.at >= lastQueue.admittedAt
        && queueRemoval.reason !== 'merged' && queueRemoval.reason !== 'failed_checks' && queueRemoval.reason !== 'merge_conflict'
      let queueRejectionNeedsRepair = false
      if (pull && lastQueue?.evidence?.head_sha === pull.head && queueRemoval
        && typeof queueRemoval.at === 'number' && queueRemoval.at >= lastQueue.admittedAt
        && (queueRemoval.reason === 'failed_checks' || queueRemoval.reason === 'merge_conflict')) {
        const diagnosis = [...chain.invocations].reverse().find(invocation => invocation.behavior === 'repair-pr'
          && invocation.evidence?.status === 'completed' && invocation.request.context?.head === pull.head
          && invocation.request.context.queueRemoval === queueRemoval.id)
        if (!diagnosis || ((pull.changesRequested || pull.failing.length || pull.conflict || pull.behind)
          && diagnosis.request.context?.reviewRevision !== pull.reviewRevision)) queueRejectionNeedsRepair = true
      }
      const answeredRepair = pull ? chain.invocations.some(invocation => invocation.behavior === 'repair-pr'
        && invocation.evidence?.status === 'completed' && invocation.request.context?.head === pull.head
        && invocation.request.context.reviewRevision === pull.reviewRevision) : false
      const publishedRepair = pull && observation ? chain.invocations.some(invocation => invocation.behavior === 'repair-pr'
        && invocation.evidence?.status === 'completed' && invocation.evidence?.action === 'published'
        && invocation.evidence?.head_sha === pull.head && invocation.callId === observation.publication.head_invocation
        && invocation.request.argv.includes('--expected-issue-revision')
        && invocation.request.argv[invocation.request.argv.indexOf('--expected-issue-revision') + 1] === observation.issue.revision) : false
      const repairVerified = pull ? (answeredRepair || (publishedRepair && !pull.changesRequested))
        && !pull.failing.length && !pull.conflict && !pull.behind : false
      const grey = pull?.greyRuns?.[0] ?? null
      // Mirroring decideBehaviorChain propose(): a completed same-head stuck-CI
      // diagnosis waits for its verified artifact or changed input.
      const stuckCiDiagnosed = !!pull && !!observation && pull.pending && Number.isFinite(pull.headSince) && now - pull.headSince >= 30 * 60_000
        && chain.invocations.some(invocation => invocation.behavior === 'repair-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === chainBasis(['stuck-ci', pull.head])
          && invocation.slot === observation.repairer.slot)
      // Mirroring decideBehaviorChain propose(): a successful current-basis
      // repair-pr waits for its verified artifact or changed input.
      const repairBasis = pull && observation
        ? chainBasis(['repair', pull.head, pull.failing, pull.conflict, pull.behind,
          pull.changesRequested, pull.unresolved, pull.reviewRevision, observation.issue.revision]) : null
      const repairCompleted = !!pull && !!observation && !!repairBasis
        && chain.invocations.some(invocation => invocation.behavior === 'repair-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === repairBasis
          && invocation.slot === observation.repairer.slot)
      const repairNeedsWait = !!pull && repairCompleted && !repairVerified
        && (!!pull.failing.length || pull.conflict || pull.behind || pull.changesRequested
          || ((pull.unresolved ?? 0) > 0 && !pull.approved))
      // Mirroring decideBehaviorChain propose(): a successful current-basis
      // rerun-grey-ci waits for its verified artifact or changed input.
      const greyBasis = pull && grey ? chainBasis(['grey', pull.head, grey.id, grey.attempt]) : null
      const greyCompleted = !!pull && !!observation && !!greyBasis
        && chain.invocations.some(invocation => invocation.behavior === 'rerun-grey-ci' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === greyBasis && invocation.slot === null)
      // Mirroring decideBehaviorChain: an undiagnosed queue rejection holds
      // repair, while a diagnosed one needs independent approve-pr
      // verification on the queue-verification basis before re-enqueueing.
      let queueVerificationBasis: string | null = null
      if (pull && observation && lastQueue?.evidence?.head_sha === pull.head && queueRemoval
        && typeof queueRemoval.at === 'number' && queueRemoval.at >= lastQueue.admittedAt
        && (queueRemoval.reason === 'failed_checks' || queueRemoval.reason === 'merge_conflict') && !queueRejectionNeedsRepair) {
        const diagnosis = [...chain.invocations].reverse().find(invocation => invocation.behavior === 'repair-pr'
          && invocation.evidence?.status === 'completed' && invocation.request.context?.head === pull.head
          && invocation.request.context.queueRemoval === queueRemoval.id)
        if (diagnosis) queueVerificationBasis = chainBasis(['queue-verification', pull.head, queueRemoval.id, diagnosis.id])
      }
      const queueVerificationApproved = !!pull && !!observation && !!queueVerificationBasis
        && chain.invocations.some(invocation => invocation.behavior === 'approve-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === queueVerificationBasis
          && invocation.slot === observation.approver.slot && invocation.evidence.action === 'approved'
          && invocation.evidence.head_sha === pull.head && typeof invocation.evidence.review_id === 'number'
          && pull.reviewIds.includes(invocation.evidence.review_id)
          && !!chainReviewResponse(chain, invocation, observation, now))
      const queueApproveCompleted = !!pull && !!observation && !!queueVerificationBasis
        && chain.invocations.some(invocation => invocation.behavior === 'approve-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === queueVerificationBasis
          && invocation.slot === observation.approver.slot)
      // Mirroring decideBehaviorChain propose(): a successful approve-pr on the
      // current verify-repair or approve basis waits for its verified artifact.
      const verifyApproveBasis = pull
        ? queueVerificationBasis ?? chainBasis(['verify-repair', pull.head, pull.reviewRevision]) : null
      const verifyApproveCompleted = !!pull && !!observation && !!verifyApproveBasis
        && chain.invocations.some(invocation => invocation.behavior === 'approve-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === verifyApproveBasis
          && invocation.slot === observation.approver.slot)
      const normalApproveRepairId = [...chain.invocations].reverse()
        .find(invocation => invocation.behavior === 'repair-pr' && invocation.evidence?.status === 'completed')?.id ?? null
      const normalApproveBasis = pull && observation
        ? chainBasis(['approve', pull.head, pull.reviewRevision, normalApproveRepairId]) : null
      const normalApproveCompleted = !!pull && !!observation && !!normalApproveBasis
        && chain.invocations.some(invocation => invocation.behavior === 'approve-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === normalApproveBasis
          && invocation.slot === observation.approver.slot)
      let next = chain.reviewPending ? 'Reconcile original pre-merge review evidence; no new invocation can start after merge'
        : active?.state === 'uncertain' ? 'Reconcile the original invocation receipt before any retry'
          : chain.held ? 'Resolve the durable hold, then explicitly resume the chain'
            : active ? 'Await the original invocation outcome'
              : state !== 'fresh' ? 'Await a fresh, complete chain observation'
                : pull && pull.state !== 'open' ? 'Hold: pull request closed without a confirmed merge; a decision is required'
                : pull?.draft ? 'Await the draft pull request becoming ready for review'
                  : observation && observation.existingPulls.length
                  ? `Hold: seed issue already belongs to existing work: ${observation.existingPulls.join(', ')}; resolve ownership before review`
                  : observation && !pull && !observation.issue.eligible ? 'Await the seed issue matching intake settings'
                    : observation && issueReviewMissingArtifact(chain, observation)
                    ? 'Hold for the missing original issue comment evidence; the posted GitHub comment remains unverified'
                    : observation && needsIssueReview(chain, observation) ? 'Review the current seed issue through review-issue'
                    : pull?.queueEntry ? 'Await verified GitHub merge completion; a queue receipt cannot establish a merge'
                      : queueAwaitingRemoval && pull
                        ? 'Await GitHub queue removal evidence; the queue outcome remains unverified'
                        : queueMergedNeedsWait && pull
                        ? 'Await confirmed GitHub merge evidence; GitHub queue reports a merge'
                        : queueRemovalNeedsDecision && pull
                        ? `Hold: queue removal requires a decision: ${queueRemoval!.reason || 'unknown reason'} (${queueRemoval!.id}); re-enqueueing needs an explicit decision`
                        : queueRejectionNeedsRepair && pull
                        ? `Diagnose and repair GitHub queue rejection ${queueRemoval!.id}: ${queueRemoval!.reason} through repair-pr; PR-head green checks do not prove integration success`
                        : pull && observation && prReviewMissingArtifact(chain, observation, pull)
                        ? 'Hold for the missing original PR submission receipt; the exact-head review evidence remains unverified'
                        : pull && needsPrReview(chain, observation, pull) ? 'Review the actual current pull-request head through review-pr'
                          : greyCompleted && pull
                          ? 'Await the grey recovery verified artifact or changed input; rerun-grey-ci already completed for this head'
                          : grey ? `Recover completed grey workflow ${grey.id} attempt ${grey.attempt} through rerun-grey-ci`
                            : repairNeedsWait && pull
                            ? 'Await the repair verified artifact or changed input; repair-pr already completed for this candidate'
                            : pull?.failing.length ? 'Repair the failing required checks'
                              : pull?.changesRequested && !repairVerified ? 'Address current-head review findings'
                                : pull?.conflict || pull?.behind ? 'Repair the branch conflict or required base update'
                                  : pull && (pull.unresolved ?? 0) > 0 && !pull.approved && !repairVerified ? 'Address current-head review conversations through repair-pr'
                                    : pull && verifyApproveCompleted && repairVerified
                                    && (pull.changesRequested || ((pull.unresolved ?? 0) > 0 && !pull.approved)) && !pull.approved
                                      ? 'Await the approval verified artifact or changed input; approve-pr already completed for this candidate'
                                    : pull && repairVerified && (pull.changesRequested || ((pull.unresolved ?? 0) > 0 && !pull.approved)) && !pull.approved
                                      ? 'Obtain qualifying current-head review and approval'
                                      : stuckCiDiagnosed && pull
                                        ? 'Await the stuck-CI diagnosis verified artifact or changed input; repair-pr already completed for this head'
                                        : pull?.pending && Number.isFinite(pull.headSince) && now - pull.headSince >= 30 * 60_000
                                        ? 'Diagnose the checks pending over 30 minutes through repair-pr'
                                        : pull?.pending ? 'Await exact-head CI completion'
                                          : queueVerificationBasis && pull && observation && !queueVerificationApproved
                                          ? queueApproveCompleted && pull
                                            ? 'Await the queue-verification approval verified artifact or changed input; approve-pr already completed for this head'
                                            : 'Verify the queue-rejection diagnosis through approve-pr approval on the queue-verification basis before re-enqueueing'
                                          : normalApproveCompleted && pull && !pull.approved
                                          ? 'Await the approval verified artifact or changed input; approve-pr already completed for this candidate'
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
