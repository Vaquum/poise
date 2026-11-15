import type { Database } from 'better-sqlite3'
import type { HandoffCandidate } from '../gateway/src/diagnostics/query-handoff'
import { reviewAdmissionHead, reviewHandoffSuccessor, scopedSuccessorObservation } from './behavior-chain-summary'
import type { BehaviorChainJournal } from './behavior-chain-store'
import { chainReviewResponse, type ChainObservation } from './behavior-chain-decision'
import { resourceReleaseContradicted } from './behavior-resource-receipt'
import { cachedStatement } from './statements'

/** This projection grants no retry/publication authority and writes no receipts. */
export function verifiedLoggingHandoffs(candidates: HandoffCandidate[], journal: BehaviorChainJournal, db: Database): string[] {
  return candidates.filter(candidate => {
    const match = journal.forInvocation(candidate.callId, candidate.correlationId)
    if (match) {
      const { chain, invocation } = match
      const successor = reviewHandoffSuccessor(chain, invocation)
      const observation = chain.observation as ChainObservation | null
      const scoped = successor && successor.state === 'settled' && successor.evidence?.status === 'completed'
        ? scopedSuccessorObservation(successor, observation) : null
      return !!successor && !chain.held && !chain.reviewPending
        && !chain.invocations.some(item => item.state === 'uncertain' || item.evidence && resourceReleaseContradicted(item.evidence))
        && reviewAdmissionHead(invocation) === candidate.head && invocation.evidence?.completedAt === candidate.completedAt
        && match.invocation.actor.toLowerCase() === candidate.actor.toLowerCase()
        && chain.repository === candidate.repository
        && invocation.request.argv[1] === `https://github.com/${candidate.repository}/pull/${candidate.pr}`
        && (invocation.behavior === 'approve-pr' ? 'pr_approve' : 'pr_review') === candidate.behavior
        && (successor.state === 'admitted' || successor.state === 'started'
          || !!scoped && !!chainReviewResponse(chain, successor, scoped, observation!.checkedAt))
    }
    // A conflicting native association cannot acquire proof from a legacy row.
    if (cachedStatement(db, `SELECT 1 FROM behavior_chain_current c,json_each(c.state,'$.invocations') i
      WHERE json_extract(i.value,'$.id')=? OR json_extract(i.value,'$.callId')=?
        OR json_extract(i.value,'$.evidence.nativeCallId')=? OR json_extract(i.value,'$.evidence.callId')=? LIMIT 1`)
      .get(candidate.correlationId, candidate.callId, candidate.callId, candidate.callId)) return false
    return legacyHandoff(candidate, db)
  }).map(candidate => candidate.id)
}

function legacyHandoff(candidate: HandoffCandidate, db: Database): boolean {
  const key = candidate.behavior === 'pr_approve' ? 'approve-prs' : 'review-new-prs'
  const source = `poise:${key}`
  const args = [key, candidate.callId, candidate.correlationId, candidate.repository, Number(candidate.pr), candidate.actor, source]
  const originals = cachedStatement(db, `SELECT target FROM behavior_seen WHERE key=? AND launch_call_id=? AND launch_correlation_id=?
      AND launch_repo=? AND launch_pr=? AND lower(launch_actor)=lower(?) AND launch_source=?
    UNION SELECT target FROM behavior_dead_letters WHERE behavior=? AND call_id=? AND correlation_id=?
      AND repo=? AND pr=? AND lower(actor)=lower(?) AND source=? LIMIT 2`).all(...args, ...args) as Array<{ target: string }>
  if (originals.length !== 1) return false
  const target = originals[0].target
  // Approval context is part of the original target. A later verdict for the
  // same PR/head alone cannot substitute for this exact request. Slots may change.
  if (key === 'approve-prs' && (!target.startsWith(`${candidate.repository}#${candidate.pr}@`)
    || !target.includes(`head=${candidate.head}`))) return false
  const next = cachedStatement(db, `SELECT launch_expected_head AS head, launch_actor AS actor, launch_source AS source,
      launch_behavior AS behavior, launch_correlation_id AS correlation, launch_call_id AS callId,
      launch_requested_at AS requestedAt, launch_completed_at AS completedAt, launch_head_sha AS completedHead,
      launch_outcome AS outcome, launch_action AS action, launch_error AS error, launch_quarantine AS quarantine, claim_id AS claim, lease_until AS leaseUntil
    FROM behavior_seen WHERE key=? AND target=? AND launch_repo=? AND launch_pr=?`)
    .get(key, target, candidate.repository, Number(candidate.pr)) as {
      head: string; actor: string; source: string; behavior: string; correlation: string; callId: string | null;
      requestedAt: string; completedAt: string | null; completedHead: string | null; outcome: string | null;
      action: string | null; error: string | null; quarantine: string | null; claim: string; leaseUntil: number | null;
    } | undefined
  if (!next || next.head !== candidate.head || next.actor.toLowerCase() !== candidate.actor.toLowerCase()
    || next.source !== source || next.behavior !== candidate.behavior || next.correlation === candidate.correlationId
    || next.callId === candidate.callId || !Number.isFinite(Date.parse(next.requestedAt))
    || Date.parse(next.requestedAt) < candidate.completedAt || next.error || next.quarantine) return false
  if (cachedStatement(db, `SELECT 1 FROM behavior_seen WHERE launch_repo=? AND launch_pr=?
    AND launch_outcome IS NULL AND (launch_quarantine IS NOT NULL OR launch_error IS NOT NULL) LIMIT 1`)
    .get(candidate.repository, Number(candidate.pr))) return false
  if (next.claim && next.claim === next.correlation && next.outcome === null && next.completedAt === null
    && next.leaseUntil !== null && next.leaseUntil > Date.now()) return true
  return !!next.callId && next.completedHead === candidate.head && !!next.completedAt
    && Date.parse(next.completedAt) >= Date.parse(next.requestedAt)
    && (next.outcome === 'approved' && next.action === 'approved'
      || next.outcome === 'clean' && next.action === 'reviewed_clean'
      || next.outcome === 'changes_requested' && next.action === 'requested_changes')
}
