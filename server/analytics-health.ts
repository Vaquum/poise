import { setImmediate } from 'node:timers/promises'
import type { AnalyticsHealth, HealthInterval, WorkError, WorkRecovery } from '../src/analytics-health-types'
import { callerDiagnostic } from '../gateway/src/diagnostics/sources'
import { normalize } from '../gateway/src/diagnostics/contract'
import { behaviorChainJournal } from './behavior-chain-journal'
import { chainProgressOf } from './behavior-chain-summary'
import { CHAIN_OBSERVATION_MAX_AGE_MS, chainReviewResponse, decideBehaviorChain, type ChainObservation } from './behavior-chain-decision'
import { matchingNativeActionReceipt, nativeActionSettlement } from './behavior-chain-action'
import { nativeBehavior } from './behavior-chain-runtime'
import { type BehaviorChain, type BehaviorChainJournal, type ChainEvent, type ChainInvocation } from './behavior-chain-store'
import { nativeResourcesPending, resourceReleaseContradicted } from './behavior-resource-receipt'
import { dependencySnapshot, type LedgerHistory, type Dependencies } from './health'
import { getOrganizations, type Organization } from './organizations'
import { HttpError } from './http'

const DAY = 86_400_000

/** Historical completeness is independent of the source's current condition. */
export function healthIntervals(history: LedgerHistory, since: number, until: number): HealthInterval[] {
  const time = (value: string | null) => value === null ? NaN : Date.parse(value)
  const start = Math.max(time(history.coverageStart), time(history.retainedFrom ?? history.coverageStart),
    history.detailFloor === null ? 0 : time(history.detailFloor) + 1)
  const end = Math.min(time(history.observedAt), time(history.callerObservedAt))
  const gaps = history.gaps.map(gap => ({ since: time(gap.since), until: gap.until === null ? until : time(gap.until) }))
  const cuts = [...new Set([since, until, start, end, ...gaps.flatMap(gap => [gap.since, gap.until])]
    .filter(at => Number.isFinite(at) && at >= since && at <= until))].sort((a, b) => a - b)
  return cuts.slice(1).map((edge, i) => {
    const from = cuts[i]
    const state = gaps.some(gap => gap.since < edge && gap.until > from) ? 'gap'
      : Number.isFinite(start) && Number.isFinite(end) && from >= start && edge <= end ? 'covered' : 'unknown'
    return { since: from, until: edge, state }
  })
}

function historyRows(journal: BehaviorChainJournal, id: string) {
  const rows = []
  let after = 0
  for (;;) {
    const page = journal.history(id, after)
    rows.push(...page.map(row => ({ ...row, event: JSON.parse(row.payload) as ChainEvent })))
    if (page.length < 100) return rows
    after = page.at(-1)!.sequence
  }
}

function journalHref(id: string, sequence = 1): string {
  return '/?' + new URLSearchParams({ view: 'logging', chain: id, after: String(Math.max(0, sequence - 1)) })
}

/** Failures count by the same incident identity as Logging, regardless of severity.
 * Successful preparation warnings and routine/no-effect outcomes are excluded.
 * Reconciled `native_publication` failures arrive nested as `publicationReceipt`. */
function failureRecord(evidence: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null
  if (evidence.status === 'failed' || evidence.nativeCallStatus === 'failed') return evidence
  const nested = evidence.publicationReceipt
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>
    if (record.status === 'failed' || record.nativeCallStatus === 'failed') return record
  }
  return null
}

export function workError(chain: BehaviorChain, invocation: ChainInvocation): WorkError | null {
  const evidence = failureRecord(invocation.evidence as Record<string, unknown> | null | undefined)
    ?? (invocation.evidence as Record<string, unknown> | null | undefined)
  const callId = typeof evidence?.callId === 'string' ? evidence.callId
    : typeof evidence?.nativeCallId === 'string' ? evidence.nativeCallId : invocation.callId
  const failed = evidence?.status === 'failed' || (evidence as Record<string, unknown> | null)?.nativeCallStatus === 'failed'
  if (!evidence || !failed || !callId || !Number.isFinite(evidence.completedAt)
    || evidence.outcome === 'target_closed' || evidence.action === 'no_changes' || evidence.error_code === 'atomic_work_blocked') return null
  const at = Number(evidence.completedAt)
  const input = callerDiagnostic({ ...evidence, id: callId, repo: chain.repository,
    pr_id: String(chain.issue), actor: invocation.actor, behavior: nativeBehavior(invocation.behavior),
    completed_at: new Date(at).toISOString(), correlation_id: invocation.id }, 'local')
  if (!input || input.source !== 'caller') return null
  const event = normalize(input, at)
  return event ? { work: chain.id, journal: journalHref(chain.id, invocation.admissionSequence), summary: event.message,
    at, callId, incident: event.incidentId, invocation: invocation.id } : null
}

interface HealthInput {
  now: number, scope: string, organizations: Organization[], dependencies: Dependencies, history: LedgerHistory
  signal?: AbortSignal
}

export function retryProven(chain: BehaviorChain, retry: ChainInvocation, observation: ChainObservation | null, at: number): boolean {
  if (!observation || !Number.isFinite(observation.checkedAt) || observation.checkedAt > at
    || at - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS) return false
  const evidence = retry.evidence!
  if (retry.behavior === 'review-issue') return evidence.action === 'commented' && evidence.issue_revision === observation.issue.revision
    && Array.isArray(evidence.receipts) && evidence.receipts.some((receipt: { issue: string, author: string, comment_id: number }) =>
      receipt.issue?.toLowerCase() === chain.id && receipt.author?.toLowerCase() === chain.reviewer.toLowerCase()
      && observation.issue.commentIds.includes(receipt.comment_id))
  if (retry.behavior === 'review-pr' || retry.behavior === 'approve-pr') return !!chainReviewResponse(chain, retry, observation, at)
  if (retry.behavior === 'publish-issue') {
    const argv = retry.request.argv
    const invocationId = argv.includes('--invocation-id') ? argv[argv.indexOf('--invocation-id') + 1] : null
    const result = (evidence.nativeActionResult as Record<string, unknown> | undefined) ?? evidence
    const action = typeof evidence.action === 'string' ? evidence.action
      : typeof result.action === 'string' ? result.action : null
    const outcome = typeof evidence.outcome === 'string' ? evidence.outcome
      : typeof result.outcome === 'string' ? result.outcome : null
    const head = typeof evidence.head_sha === 'string' ? evidence.head_sha
      : typeof result.head_sha === 'string' ? result.head_sha : null
    // A reconciled lost-response retry keeps action null while recover()
    // adds outcome published with verified publication fields.
    return (action === 'published' || action === 'issue_work' || action === null) && outcome === 'published' && typeof head === 'string'
      && observation.pull?.head === head && observation.publication.head_sha === head
      && observation.publication.head_invocation === invocationId
  }
  if (retry.behavior === 'implement-issue' || retry.behavior === 'repair-pr') {
    return evidence.action === 'published' && typeof evidence.head_sha === 'string'
      && observation.pull?.head === evidence.head_sha && observation.publication.head_sha === evidence.head_sha
      && observation.publication.head_invocation === retry.callId
  }
  if (retry.behavior === 'rerun-grey-ci') {
    if (observation.greyRecovery?.invocationId === retry.id
      && String((observation.greyRecovery.receipt as Record<string, unknown>).outcome) === 'rerun_observed') return true
    // Settled retries retain their native receipt in evidence after the
    // observation no longer carries greyRecovery (e.g. at merge time).
    const argv = retry.request.argv
    const runId = argv.includes('--run-id') ? Number(argv[argv.indexOf('--run-id') + 1]) : null
    const attempt = argv.includes('--run-attempt') ? Number(argv[argv.indexOf('--run-attempt') + 1]) : null
    const expected = argv.includes('--expected-head') ? argv[argv.indexOf('--expected-head') + 1] : null
    const outcome = (evidence as Record<string, unknown>).outcome
    const head = (evidence as Record<string, unknown>).head_sha
    return evidence.status === 'completed' && ['rerun_observed', 'rerun_requested'].includes(String(outcome)) && typeof head === 'string'
      && observation.pull?.head === head && head === expected
      && (evidence as Record<string, unknown>).run_id === runId
      && (evidence as Record<string, unknown>).run_attempt === attempt
  }
  const receipt = matchingNativeActionReceipt(chain, retry)
  if (!receipt || receipt.observedAt > at) return false
  return ['enqueued', 'merged', 'resolved'].includes(String(nativeActionSettlement(receipt).outcome))
}

/** Confirmed closed seeds mirror journal.page(false): issue closed with no
 * remaining pulls, settled ownership and no merged publication/PR. Only the
 * verified external closing reference is discounted; a test-merge SHA on the
 * confirmed unmerged binding is not a merge. */
function isConfirmedClosed(chain: BehaviorChain): boolean {
  const observation = chain.observation as ChainObservation | null
  if (!observation || observation.issue.open !== false) return false
  const external = observation.externalMerge
  const closing = typeof external?.merge_sha === 'string' && Number.isSafeInteger(external.pull_number) && external.pull_number > 0
    ? `https://github.com/${chain.repository}/pull/${external.pull_number}`.toLowerCase() : null
  if (!Array.isArray(observation.existingPulls)
    || (closing === null ? observation.existingPulls.length !== 0
      : observation.existingPulls.some(url => typeof url !== 'string' || url.toLowerCase() !== closing))) return false
  if (chain.invocations.some(invocation => invocation.state !== 'settled')) return false
  if (chain.invocations.some(invocation => nativeResourcesPending({ ...invocation }))) return false
  if (chain.reviewPending === true) return false
  if (observation.publication.merged !== false) return false
  const pull = observation.pull
  if (pull === null) return observation.publication.pull_number === null && observation.publication.state === null
    && observation.publication.merge_sha == null
  return pull.state === 'closed' && observation.publication.state === 'closed'
    && pull.number === observation.publication.pull_number && pull.merged === false && pull.mergeSha == null
}

/** One error's recovery as the journal proves it; the clock decides only whether it counts. */
type RecoveryFact = { unknown: true, errorAt: number, advancedAt: number | null }
  | { unknown: false, origin: 'automatic' | 'operator', at: number | null | undefined, outcome: WorkRecovery }

/** What one revision of a chain's journal says apart from the clock. Its
 * errors leave out those later than the clock it was read at, so it stands
 * for a clock in [from, until): the latest error counted to the earliest left out. */
interface ChainFacts {
  revision: number, from: number, until: number
  admittedAt: number, progress: { at: number, sequence: number }
  errors: WorkError[]
  /** A merge verified but for the clock: its GitHub time, its lifetime's incidents and whether that evidence is incomplete. */
  merge: { at: number, incidents: number, incomplete: boolean } | null
  recoveries: RecoveryFact[]
}

/** Replaying each chain's journal was the whole cost of a read, and history is
 * immutable: a chain's facts stand until its next event. */
const factsByJournal = new WeakMap<BehaviorChainJournal, Map<string, ChainFacts>>()

function chainFacts(journal: BehaviorChainJournal, chain: BehaviorChain, now: number): ChainFacts {
  const rows = historyRows(journal, chain.id)
  const admittedAt = rows[0]?.at
  // The rows just read stand for the clock too: each event is parsed once.
  const progress = chainProgressOf(rows, chain.id, undefined, true)
  let from = -Infinity, until = Infinity
  // Reconciliation can replace the current outcome with a verified success.
  // Original failure receipts remain in the immutable journal, including
  // failed Calls whose resource/publication outcome is still uncertain.
  const errors: WorkError[] = []
  // Each error recovers against the failure row that produced it: one
  // invocation can fail an original Call and later a publication Call, and
  // the first failure row is the wrong window for the later incident.
  const failureByError = new Map<WorkError, typeof rows[number]>()
  const seenErrors = new Set<string>()
  for (const row of rows) {
    const event = row.event
    if (event.type !== 'invocation.settled' && event.type !== 'invocation.reconciled') continue
    const invocation = chain.invocations.find(item => item.id === event.invocationId)!
    const error = workError(chain, { ...invocation, evidence: event.evidence,
      callId: event.type === 'invocation.settled' ? event.callId : null })
    if (error && error.at > now) until = Math.min(until, error.at)
    if (!error || error.at > now || seenErrors.has(`${error.callId}:${error.incident}`)) continue
    seenErrors.add(`${error.callId}:${error.incident}`)
    errors.push(error)
    failureByError.set(error, row)
    from = Math.max(from, error.at)
  }
  // GitHub's own merge facts verify the merge: the first observation whose pull
  // request carries the chain's merge commit and its mergedAt, on the chain's own
  // publication or, where an existing pull request closed the seed, on that one.
  // GitHub's mergedAt is the same in every observation of the merged pull
  // request; Poise's copy of its publication can lag a read behind it.
  let mergedAt: number | undefined
  for (const row of chain.mergeSha ? rows : []) {
    if (row.event.type !== 'chain.observed') continue
    const observation = row.event.observation as ChainObservation
    const pull = observation.pull
    if (!pull?.merged || pull.mergeSha !== chain.mergeSha || typeof pull.mergedAt !== 'number' || !Number.isFinite(pull.mergedAt)) continue
    if (observation.publication.pull_number !== null && observation.publication.pull_number !== pull.number) continue
    mergedAt = pull.mergedAt
    break
  }
  const merge = mergedAt !== undefined ? {
    at: mergedAt,
    // Delayed reconciliation can stamp a pre-merge failure after merging;
    // the admitted attempt still proves the incident belongs to the lifetime.
    incidents: new Set(errors.filter(error => {
      if (error.at <= mergedAt!) return true
      const failed = chain.invocations.find(invocation => invocation.id === error.invocation)!
      return failed.admittedAt <= mergedAt!
    }).map(error => error.incident)).size,
    incomplete: chain.invocations.some(invocation => invocation.admittedAt <= mergedAt!
      && (!invocation.evidence || invocation.evidence.status === 'failed' && (!invocation.callId || !Number.isFinite(invocation.evidence.completedAt))
        || invocation.state === 'uncertain')),
  } : null
  const recoveries: RecoveryFact[] = []
  for (const error of errors) {
    const failed = chain.invocations.find(invocation => invocation.id === error.invocation)!
    const failure = failureByError.get(error)
    if (!failure) continue
    const later = chain.invocations.find(invocation => invocation.admissionSequence > failure.sequence
      && invocation.behavior === failed.behavior && invocation.basis === failed.basis && invocation.slot === failed.slot
      && invocation.evidence?.status === 'completed')
    // recover() settles verified native publication success on the
    // original invocation instead of admitting a later retry: the retry
    // may share the failure's admission or predate its settlement.
    const fallback = !later ? chain.invocations.find(invocation => invocation.behavior === failed.behavior
      && invocation.basis === failed.basis && invocation.slot === failed.slot && invocation.evidence?.status === 'completed'
      && rows.some(row => (row.event.type === 'invocation.settled' || row.event.type === 'invocation.reconciled')
        && row.event.invocationId === invocation.id && row.sequence > failure.sequence
        && (row.event.evidence as Record<string, unknown>).status === 'completed') ) : undefined
    const retry = later ?? fallback
    const success = retry && rows.find(row => (row.event.type === 'invocation.settled' || row.event.type === 'invocation.reconciled')
      && row.event.invocationId === retry.id && row.sequence > failure.sequence && row.event.evidence.status === 'completed')
    // Same-invocation publication retries launch via a recorded
    // publicationResume before their success settles. An operator
    // Hold/Resume while that automatic retry runs must not relabel it.
    // A cleared launch (CallerReceiptStoreError) may precede the launch
    // that actually succeeds; use the latest launch before success so an
    // operator Resume between them is not excluded.
    const launch = retry && retry.admissionSequence <= failure.sequence ? rows.filter(row => row.sequence > failure.sequence
      && (!success || row.sequence < success.sequence) && row.event.type === 'invocation.reconciled' && row.event.invocationId === retry.id
      && typeof (row.event.evidence as Record<string, unknown> | null)?.publicationResume === 'object'
      && (row.event.evidence as Record<string, unknown> | null)?.publicationResume !== null
      && typeof (((row.event.evidence as Record<string, unknown>).publicationResume as Record<string, unknown>).correlation) === 'string').at(-1) : undefined
    const resumed = rows.filter(row => row.sequence > failure.sequence && row.event.type === 'chain.resumed'
      && (!retry || (retry.admissionSequence > failure.sequence ? row.sequence < retry.admissionSequence
        : launch ? row.sequence < launch.sequence : !success || row.sequence < success.sequence)))
    const operator = resumed.filter(row => row.event.type === 'chain.resumed' && row.event.recovery?.origin === 'operator').at(-1)
    // A runtime CI recovery carries its own ciRecovery evidence and is not
    // an ambiguous operator resume.
    const ambiguous = resumed.some(row => row.event.type === 'chain.resumed' && !row.event.ciRecovery
      && (!row.event.recovery || row.event.recovery.origin === 'unknown'))
    const action = operator ?? resumed.at(-1)
    const origin = operator ? 'operator' : ambiguous ? 'unknown' : 'automatic'
    // Same-invocation continuations preserve the failed Call's
    // completedAt through recover(), so the stale stamp would accept a
    // head advance observed before publicationResume. Require progress
    // after the launch that actually succeeds; a verified published head
    // journaled after that launch but before its success settlement still
    // counts. Without a launch (e.g. publish-issue settled from the
    // observation), require progress after the failure instead of the
    // later success settlement. Later-admission retries keep the
    // preceding-observation proof (e.g. grey CI success observed before
    // its settlement).
    const sameInvocation = !!retry && !!success && retry.admissionSequence <= failure.sequence
    const bound = sameInvocation ? (launch ?? failure) : undefined
    const retryAt = bound ? bound.at : Number(retry?.evidence?.completedAt)
    const advanced = retry && success && progress.advances.find(point => {
      if (point.sequence < failure.sequence || point.at < retryAt || point.at < error.at) return false
      if (sameInvocation && bound && point.sequence < bound.sequence) return false
      const observed = rows.filter(row => row.sequence <= point.sequence && row.event.type === 'chain.observed').at(-1)
      return observed?.event.type === 'chain.observed' && retryProven(chain, retry, observed.event.observation as ChainObservation, point.at)
    })
    const recovery = operator?.event.type === 'chain.resumed' ? operator.event.recovery : null
    const interventionAt = recovery?.intervention?.at ?? (operator && advanced ? operator.at : null)
    const verifiedHelp = !!recovery?.intervention && recovery.intervention.at > error.at
      && recovery.intervention.verifiedAt >= recovery.intervention.at
    const outcomeAt = origin === 'operator' ? interventionAt : advanced?.at
    if (origin === 'unknown' || !advanced || recovery?.intervention && !verifiedHelp) {
      recoveries.push({ unknown: true, errorAt: error.at, advancedAt: advanced ? advanced.at : null })
      continue
    }
    recoveries.push({ unknown: false, origin, at: outcomeAt, outcome: { work: chain.id, journal: journalHref(chain.id, failure.sequence), summary: error.summary,
      failedCall: error.callId, origin,
      actionSequence: action?.sequence ?? (retry!.admissionSequence > failure.sequence || !success ? retry!.admissionSequence : success.sequence),
      actionAt: action?.at ?? (retry!.admissionSequence > failure.sequence || !success ? retry!.admittedAt : success.at), progressAt: advanced.at,
      interventionAt: origin === 'operator' ? interventionAt : null } })
  }
  return { revision: chain.sequence, from, until, admittedAt, progress: { at: progress.at, sequence: progress.sequence }, errors, merge, recoveries }
}

/** Only canonical v2 ownership enters this population. Nothing here observes
 * GitHub, reads Caller again, or changes chain decisions. */
export async function projectAnalyticsHealth(journal: BehaviorChainJournal, input: HealthInput): Promise<AnalyticsHealth> {
  const { now, scope, organizations, dependencies, history } = input
  const since = now - DAY
  const result: AnalyticsHealth = { readAt: now, window: { since, until: now }, scope, limits: [],
    rate: { completed: 0, errors: 0, perItem: null, unsettled: 0, withheld: null, items: [] },
    blocked: { count: 0, oldestProgressAt: null, largestStage: null, items: [] },
    recovery: { automatic: [], intervention: [], unknown: 0 },
    lastError: { error: null, lastObserved: true, coveredSince: null, coveredUntil: null }, coverage: [] }
  let complete = true, lifetimeStart = since
  // Why the rate cannot be known, in words; the first reason found stands.
  const withhold = (reason: string) => { complete = false; result.rate.withheld ??= reason }
  const stages = new Map<string, number>()
  const addLimit = (value: string) => { if (!result.limits.includes(value)) result.limits.push(value) }
  const covered = (from: number, until: number) => healthIntervals(history, from, until).every(part => part.state === 'covered')
  const legacy = journal.cutover().legacyPulls.filter(id => !scope || id.split('/')[0].toLowerCase() === scope.toLowerCase())
  addLimit(`v2-only; uncorrelated legacy work excluded${legacy.length ? `: ${legacy.join(', ')}` : ' (cutover inventory: 0)'}`)
  for (const org of organizations) {
    const dependency = dependencies.datastore.find(entry => entry.org?.toLowerCase() === org.login.toLowerCase())
    const status = org.status !== 'ready' ? org.status : dependency?.status ?? 'unknown'
    result.coverage.push({ name: 'GitHub', scope: org.login, status, lastReadAt: dependency?.lastSuccessAt ?? null, intervals: null })
    if (status !== 'ok') { withhold(`GitHub evidence for ${org.login} is ${status}, so merges may be missing`); addLimit(`${org.login}: GitHub evidence ${status}`) }
  }
  if (!organizations.length) { withhold('no GitHub account is configured'); addLimit('No configured GitHub account is available') }
  const accountsComplete = complete
  let memo = factsByJournal.get(journal)
  if (!memo) { memo = new Map(); factsByJournal.set(journal, memo) }
  let after = ''
  for (;;) {
    const page = journal.page(after, 100, null)
    for (const chain of page) {
      input.signal?.throwIfAborted()
      if (!organizations.some(org => chain.repository.split('/')[0].toLowerCase() === org.login.toLowerCase())) continue
      let facts = memo.get(chain.id)
      if (!facts || facts.revision !== chain.sequence || now < facts.from || now >= facts.until) {
        facts = chainFacts(journal, chain, now)
        memo.set(chain.id, facts)
      }
      const { admittedAt, progress, errors, merge } = facts
      for (const error of errors) if (!result.lastError.error || error.at > result.lastError.error.at) result.lastError.error = error
      const verifiedMerge = !!merge && merge.at <= now
      if (chain.mergeSha && !verifiedMerge) {
        withhold(`GitHub's merge time for ${chain.id} is unknown, so it may belong to these 24 hours`)
        addLimit(`${chain.id}: original GitHub merge time unavailable`)
      }
      if (verifiedMerge && merge.at >= since) {
        result.rate.completed++
        result.rate.errors += merge.incidents
        result.rate.items.push({ work: chain.id, journal: journalHref(chain.id), summary: `${merge.incidents} errors; merged ${new Date(merge.at).toISOString()}` })
        lifetimeStart = Math.min(lifetimeStart, admittedAt)
        // Work errors come from the journal, which keeps every settled
        // invocation: the observational ledger's coverage gaps cannot hide
        // one. A run admitted before the merge that has not settled can
        // still add one, so the rate is then a lower bound.
        if (merge.incomplete) {
          result.rate.unsettled++
          addLimit(`${chain.id}: a run admitted before its merge is still unsettled`)
        }
      }
      if (!chain.supersession && !isConfirmedClosed(chain) && (!chain.mergeSha || chain.reviewPending)) {
        const active = chain.invocations.find(invocation => invocation.state !== 'settled')
        const current = chain.observation as ChainObservation | null
        const fresh = !!current && current.checkedAt <= now && now - current.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS
        const decision = fresh ? decideBehaviorChain(chain, current, now) : null
        const independent = !!chain.held || !!chain.reviewPending || active?.state === 'uncertain'
          || chain.invocations.some(invocation => !!invocation.evidence && resourceReleaseContradicted(invocation.evidence))
        // Known waits take precedence over age. Stale observations cannot prove
        // a healthy wait; pending CI past its native diagnosis deadline is overdue.
        const overdueCi = fresh && current.pull?.pending && !current.pull.draft && !current.pull.queueEntry
          && now - current.pull.headSince >= 30 * 60_000
        const healthyWait = fresh && decision?.kind === 'wait' && (!!current.pull?.draft || !!current.pull?.queueEntry
          || decision.reason === 'seed issue no longer matches intake settings'
          || decision.reason === 'exact-head CI is still running' && !overdueCi
          || decision.reason.endsWith('is in native failure backoff') || decision.reason.startsWith('shared baseline CI dependency:'))
        const blocked = independent || decision?.kind === 'hold' || overdueCi
          || now - progress.at >= DAY && !healthyWait
        if (blocked) {
          const stage = active?.behavior ?? chain.invocations.at(-1)?.behavior ?? 'Issue admission'
          stages.set(stage, (stages.get(stage) ?? 0) + 1)
          result.blocked.count++
          result.blocked.oldestProgressAt = Math.min(result.blocked.oldestProgressAt ?? progress.at, progress.at)
          result.blocked.items.push({ work: chain.id, journal: journalHref(chain.id, progress.sequence), summary: chain.held || (decision && 'reason' in decision ? decision.reason : 'Progress overdue or uncertain') })
        }
        if (!fresh) addLimit(`${chain.id}: live chain observation stale or unavailable`)
      }
      const outcomes = new Map<'automatic' | 'operator', WorkRecovery>()
      let unknownRecovery = false
      for (const recovery of facts.recoveries) {
        if (recovery.unknown) {
          if (recovery.errorAt >= since || recovery.advancedAt !== null && recovery.advancedAt >= since) unknownRecovery = true
          continue
        }
        if (recovery.at === null || recovery.at === undefined || recovery.at < since || recovery.at > now || outcomes.has(recovery.origin)) continue
        outcomes.set(recovery.origin, recovery.outcome)
      }
      if (unknownRecovery) result.recovery.unknown++
      for (const [origin, outcome] of outcomes) result.recovery[origin === 'automatic' ? 'automatic' : 'intervention'].push(outcome)
      await setImmediate()
    }
    if (page.length < 100) break
    after = page.at(-1)!.id
  }
  if (result.recovery.unknown) addLimit('Older, ambiguous or uncorrelated recovery origins remain unknown')
  result.blocked.largestStage = [...stages].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([stage, count]) => `${stage}: ${count}`)[0] ?? null
  if (!result.rate.completed) withhold('no v2 work merged in the last 24 hours')
  result.rate.perItem = complete ? result.rate.errors / result.rate.completed : null
  if (result.rate.perItem !== null) result.rate.withheld = null
  const intervals = healthIntervals(history, lifetimeStart, now)
  result.coverage.unshift({ name: 'Chain journal', scope: scope || 'All configured accounts', status: 'verified v2', lastReadAt: new Date(now).toISOString(), intervals: null },
    { name: 'Caller receipts', scope: 'Instance-wide coverage history; selected v2 work', status: dependencies.ledger.status,
      lastReadAt: history.callerObservedAt, intervals })
  const trailing = healthIntervals(history, since, now)
  const last = result.lastError.error
  result.lastError.lastObserved = !accountsComplete || !covered(last?.at ?? since, now)
  const coveredParts = trailing.filter(part => part.state === 'covered')
  if (accountsComplete && coveredParts.length) {
    const latest = coveredParts.at(-1)!
    result.lastError.coveredSince = latest.since
    result.lastError.coveredUntil = latest.until
  }
  return result
}

export function readAnalyticsHealth(scope = '', signal?: AbortSignal): Promise<AnalyticsHealth> {
  const organizations = getOrganizations().filter(org => !scope || org.login.toLowerCase() === scope.toLowerCase())
  if (scope && !organizations.length) throw new HttpError(400, 'GitHub account is not configured')
  const snapshot = dependencySnapshot()
  return projectAnalyticsHealth(behaviorChainJournal(), { now: Date.now(), scope, organizations,
    dependencies: snapshot.dependencies, history: snapshot.history.ledger, signal })
}
