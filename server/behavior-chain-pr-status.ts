import { CHAIN_OBSERVATION_MAX_AGE_MS, chainReviewResponse, lastChainQueueInvocation, type ChainObservation } from './behavior-chain-decision'
import { chainBasis, type BehaviorChain, type ChainInvocation } from './behavior-chain-store'
import { attributedNativeAction, matchingNativeActionReceipt, type NativeActionReceipt } from './behavior-chain-action'
import { chainWaitsForResourceRelease } from './behavior-chain-summary'
import type { PrBlockerId, PrStatusRow, PrStatusVerdict } from './behavior-pr-status'
import type { DatastorePr } from './behaviors'

/** Presentation only: no observation collection, admission or effect. */
export function projectChainPrStatus(chain: BehaviorChain, pr: DatastorePr, org: string | null, now: number, enabled: boolean,
  pauses: string[] = [], eligibility: PrStatusRow['eligibility'] = { refusal: null, skippedBy: [] }, recheckAt?: number | null) {
  const preview = (text: string) => text.length <= 1024 ? text : `${text.slice(0, 1023)}…`
  const observation = chain.observation as ChainObservation | null
  const pull = observation?.pull?.number === pr.number ? observation.pull : null
  const fresh = !!pull && !!observation && Number.isFinite(observation.checkedAt)
    && observation.checkedAt <= now && now - observation.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS
  const active = chain.invocations.find((invocation) => invocation.state !== 'settled')
  const waitingForResourceRelease = chainWaitsForResourceRelease(chain)
  const ownedWorking = !!active && active.model !== null && active.state !== 'uncertain' && !active.evidence?.resources_settled_at
  const scheduled = recheckAt !== undefined && !!(chain.held || chain.mergeSha || waitingForResourceRelease) && (recheckAt === null || recheckAt > now)
  const observationState = !observation ? 'missing' : fresh ? 'fresh'
    : (ownedWorking || scheduled) && Number.isFinite(observation.checkedAt) && observation.checkedAt <= now ? 'skipped-while-owned'
      : !pull ? 'missing' : 'stale'
  const reviews = fresh && observation && pull ? chain.invocations.filter((invocation) => invocation.state === 'settled'
    && ['review-pr', 'approve-pr'].includes(invocation.behavior) && invocation.evidence?.status === 'completed'
    && chainReviewResponse(chain, invocation, observation, now)) : []
  const latest = reviews.at(-1)
  const verdict: PrStatusVerdict | null = latest ? { action: String(latest.evidence!.action), outcome: latest.outcome ? preview(latest.outcome) : null,
    head: String(latest.evidence!.head_sha), completedAt: new Date(Number(latest.evidence!.completedAt)).toISOString(),
    key: latest.behavior, quarantine: null } : null
  const completed = new Set(reviews.filter((invocation) => invocation.behavior === 'review-pr'
    && observation!.prReviewers.some((reviewer) => reviewer.slot === invocation.slot)).map((invocation) => invocation.slot)).size
  const required = observation?.prReviewers?.length ?? 0
  let originalQueue: ChainInvocation | undefined
  let queueProof: NativeActionReceipt | null = null
  let enqueueOwner: ChainInvocation | undefined
  for (let index = chain.invocations.length - 1; index >= 0; index--) {
    const invocation = chain.invocations[index]
    if (invocation.behavior !== 'merge-pr') continue
    const proof = matchingNativeActionReceipt(chain, invocation)
    if (proof?.result.head_sha === pull?.head && ['enqueued', 'in_queue'].includes(String(proof?.result.outcome))) {
      if (!queueProof) { originalQueue = invocation; queueProof = proof }
      // A later no-action observation cannot erase the earlier accepted
      // enqueue for this same entry, nor acquire its mutation attribution.
      if (proof!.result.outcome === 'enqueued' && proof!.result.queue_entry_id === (fresh && pull?.queueEntry ? pull.queueEntry : queueProof!.result.queue_entry_id)) {
        enqueueOwner = invocation; break
      }
    }
  }
  const responseAt = queueProof?.observedAt ?? 0
  const newerQueue = !!originalQueue && !!observation && responseAt > observation.checkedAt && responseAt <= now
    && now - responseAt <= CHAIN_OBSERVATION_MAX_AGE_MS
  const entry = fresh && pull?.queueEntry ? pull.queueEntry : newerQueue ? String(queueProof!.result.queue_entry_id) : null
  const participation = lastChainQueueInvocation(chain)
  const ejected = fresh && !entry && !!pull?.queueRemoval && participation?.evidence?.head_sha === pull.head
    && pull.queueRemoval.at >= participation.admittedAt && pull.queueRemoval.reason !== 'merged'
  const queue: PrStatusRow['queue'] = { state: entry ? 'queued' : ejected ? 'ejected' : fresh ? 'not_queued' : 'unknown',
    entryId: entry, since: entry ? new Date(newerQueue ? responseAt : observation!.checkedAt).toISOString()
      : ejected ? new Date(pull!.queueRemoval!.at).toISOString() : null }
  const queueAttributed = !!entry && !!enqueueOwner
  if (entry) {
    queue.attribution = queueAttributed ? 'accepted-response' : 'observed'
    if (queueAttributed) queue.invocationId = enqueueOwner!.id
  }
  const checksState = ['SUCCESS', 'PENDING', 'EXPECTED', 'FAILURE', 'ERROR'].includes(pull?.checksState ?? '') ? pull!.checksState : null
  let id: PrBlockerId = 'unknown'
  let line = 'v2 observation unavailable; awaiting a canonical chain observation'
  let key = 'observation'
  const set = (nextId: PrBlockerId, nextLine: string, nextKey: string) => { id = nextId; line = nextLine; key = nextKey }
  if (chain.reviewPending) set('held', `v2 merged ${chain.mergeSha?.slice(0, 12)}; review evidence pending${active ? `; ${active.behavior} ${active.state}` : ''}`, 'review-pending')
  else if (active?.state === 'uncertain') set('held', `v2 ${active.behavior} uncertain: ${active.outcome ?? 'original response unavailable'}`, `uncertain:${active.id}`)
  else if (chain.held) set('held', `v2 held: ${chain.held}`, `held:${chain.held}`)
  else if (active) set(['review-pr', 'approve-pr'].includes(active.behavior) ? 'review_running' : 'blocked',
    `v2 ${active.behavior}: ${active.state}`, `invocation:${active.id}:${active.state}`)
  else if (!enabled) set('blocked', 'v2 admissions paused; existing ownership is retained', 'paused')
  else if (pauses.length) set('blocked', `v2 ${pauses[0]}`, `pause:${pauses.join(';')}`)
  else if (eligibility.refusal) set('not_eligible', `v2 ${eligibility.refusal}`, `refusal:${eligibility.refusal}`)
  else if (!fresh) line = observationState === 'missing' ? 'v2 observation missing; awaiting the first canonical PR observation'
    : 'v2 observation stale; current PR state is unverified'
  else if (entry) set('in_queue', queueAttributed ? 'v2 enqueue accepted for the original invocation; awaiting native integration'
    : 'v2 observed in native queue; enqueue mutation is not attributed', `queue:${entry}:${queue.attribution}`)
  else if (ejected) set('awaiting_author', `v2 queue rejected the candidate: ${pull!.queueRemoval!.reason ?? 'unknown reason'}`, `queue-removal:${pull!.queueRemoval!.id}`)
  else if (pull!.failing.length) set('ci_failing', `v2 CI failing: ${pull!.failing.join(', ')}`, `ci:${pull!.head}`)
  else if (pull!.pending) set('ci_pending', 'v2 exact-head CI is running', `ci:${pull!.head}`)
  else if (pull!.conflict) set('conflicting', 'v2 branch conflict requires repair', `conflict:${pull!.head}`)
  else if (pull!.behind) set('behind', 'v2 native policy requires a base update', `behind:${pull!.head}`)
  else if (pull!.changesRequested) set('awaiting_author', 'v2 current-head review findings require repair', `review:${pull!.head}:${pull!.reviewRevision}`)
  else if (pull!.unresolved) set('unresolved_threads', `v2 ${pull!.unresolved} review conversations remain unresolved`, `threads:${pull!.head}:${pull!.unresolved}`)
  else if (chain.waiting) set('blocked', `v2 waiting: ${chain.waiting}`, `waiting:${chain.waiting}`)
  else if (!pull!.approved || !reviews.length) set('awaiting_review', 'v2 waiting for a qualifying current-head review and approval', `review:${pull!.head}`)
  else if (pull!.ready) set('approved_not_enqueued', 'v2 native readiness is green; awaiting the next chain invocation', `ready:${pull!.head}`)
  else set('blocked', `v2 readiness blocked: ${pull!.readinessBlockers?.join(', ') || 'awaiting verified native readiness'}`, `readiness:${pull!.head}`)
  const created = pr.created_at ? Date.parse(pr.created_at) : Number.NaN
  const row: PrStatusRow = {
    repository: pr.repo, number: pr.number, org, author: pr.author, createdAt: pr.created_at,
    ageMinutes: Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 60_000)) : null,
    ownership: { engine: 'v2', chainId: chain.id, sequence: chain.sequence, reviewPending: chain.reviewPending ?? null,
      reviewStatus: chain.reviewPending === true ? 'pending' : chain.reviewPending === false ? 'complete' : 'not-recorded',
      observation: observationState,
      ...(recheckAt !== undefined ? { reconciliation: { nextObservationAt: recheckAt !== null && recheckAt > 0 ? new Date(recheckAt).toISOString() : null,
        ...(waitingForResourceRelease ? { waitingForResourceRelease: true } : {}),
        waitingForOriginalResponse: recheckAt === null && !!active && attributedNativeAction(active) } } : {}),
      mergeSha: chain.mergeSha, reviews: { completed: fresh ? completed : null, required: fresh ? required : null }, journal: `/api/behavior-chains?id=${encodeURIComponent(chain.id)}` },
    rounds: { completed: null, cap: null, next: null },
    verdict: verdict ? { ...verdict, onCurrentHead: fresh ? verdict.head === pull!.head : null } : null,
    ci: fresh && checksState ? { state: pull!.failing.length ? 'FAILURE' : pull!.pending ? 'PENDING' : checksState,
      head: pull!.head, asOf: new Date(observation!.checkedAt).toISOString() }
      : { state: 'unknown', reason: fresh ? 'native observation lacks a check rollup' : 'chain observation stale or unavailable' },
    queue, blocker: { id, line: line.length <= 160 ? line : `${line.slice(0, 159)}…`,
      since: new Date(now).toISOString(), sinceRestart: true, details: [
        ...(active ? [`Original invocation ${active.id} admitted ${Math.max(0, Math.floor((now - active.admittedAt) / 60_000))} minute(s) ago`] : []),
        ...(active?.outcome ? [active.outcome] : []), ...(chain.held ? [chain.held] : []),
        ...pauses, ...(eligibility.refusal ? [eligibility.refusal] : []),
        ...(chain.waiting ? [chain.waiting] : []), ...(!fresh ? [waitingForResourceRelease ? 'Original native resource release remains unverified; Caller reconciliation continues while GitHub observation is deferred'
          : ownedWorking ? 'GitHub re-observation is skipped while the original native invocation owns its work'
          : scheduled ? recheckAt === null ? 'The original action response is required; GitHub reads cannot settle this invocation'
            : `Original evidence recheck scheduled for ${new Date(recheckAt!).toISOString()}; GitHub facets remain unverified`
            : 'GitHub state is unverified until the next chain observation'] : []),
      ].slice(0, 4).map(preview) },
    flags: { age: false, staleBlocker: false }, eligibility,
    ledger: `/api/behavior-ledger?repository=${pr.repo}&number=${pr.number}`,
  }
  return { row, key: chainBasis([id, key]), stale: !fresh && observationState !== 'skipped-while-owned' }
}
