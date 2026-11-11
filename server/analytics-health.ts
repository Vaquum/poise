import { setImmediate } from 'node:timers/promises'
import type { AnalyticsHealth, HealthInterval, WorkError, WorkRecovery } from '../src/analytics-health-types'
import { callerDiagnostic } from '../gateway/src/diagnostics/sources'
import { normalize } from '../gateway/src/diagnostics/contract'
import { behaviorChainJournal } from './behavior-chain-journal'
import { chainProgress } from './behavior-chain-summary'
import { CHAIN_OBSERVATION_MAX_AGE_MS, chainReviewResponse, decideBehaviorChain, type ChainObservation } from './behavior-chain-decision'
import { matchingNativeActionReceipt } from './behavior-chain-action'
import { nativeBehavior } from './behavior-chain-runtime'
import { type BehaviorChain, type BehaviorChainJournal, type ChainEvent, type ChainInvocation } from './behavior-chain-store'
import { resourceReleaseContradicted } from './behavior-resource-receipt'
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
 * Successful preparation warnings and routine/no-effect outcomes are excluded. */
export function workError(chain: BehaviorChain, invocation: ChainInvocation): WorkError | null {
  const evidence = invocation.evidence
  const callId = typeof evidence?.callId === 'string' ? evidence.callId
    : typeof evidence?.nativeCallId === 'string' ? evidence.nativeCallId : invocation.callId
  if (!evidence || evidence.status !== 'failed' || !callId || !Number.isFinite(evidence.completedAt)
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

function retryProven(chain: BehaviorChain, retry: ChainInvocation, observation: ChainObservation | null, at: number): boolean {
  if (!observation || !Number.isFinite(observation.checkedAt) || observation.checkedAt > at
    || at - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS) return false
  const evidence = retry.evidence!
  if (retry.behavior === 'review-issue') return evidence.action === 'commented' && evidence.issue_revision === observation.issue.revision
    && Array.isArray(evidence.receipts) && evidence.receipts.some((receipt: { issue: string, author: string, comment_id: number }) =>
      receipt.issue?.toLowerCase() === chain.id && receipt.author?.toLowerCase() === chain.reviewer.toLowerCase()
      && observation.issue.commentIds.includes(receipt.comment_id))
  if (retry.behavior === 'review-pr' || retry.behavior === 'approve-pr') return !!chainReviewResponse(chain, retry, observation, at)
  if (retry.behavior === 'implement-issue' || retry.behavior === 'repair-pr' || retry.behavior === 'publish-issue') {
    return evidence.action === 'published' && typeof evidence.head_sha === 'string'
      && observation.pull?.head === evidence.head_sha && observation.publication.head_sha === evidence.head_sha
      && observation.publication.head_invocation === retry.callId
  }
  const receipt = matchingNativeActionReceipt(chain, retry)
  return !!receipt && receipt.observedAt <= at && ['enqueued', 'merged', 'resolved'].includes(String(receipt.result.outcome))
}

/** Only canonical v2 ownership enters this population. Nothing here observes
 * GitHub, reads Caller again, or changes chain decisions. */
export async function projectAnalyticsHealth(journal: BehaviorChainJournal, input: HealthInput): Promise<AnalyticsHealth> {
  const { now, scope, organizations, dependencies, history } = input
  const since = now - DAY
  const result: AnalyticsHealth = { readAt: now, window: { since, until: now }, scope, limits: [],
    rate: { completed: 0, errors: 0, perItem: null, items: [] },
    blocked: { count: 0, oldestProgressAt: null, largestStage: null, items: [] },
    recovery: { automatic: [], intervention: [], unknown: 0 },
    lastError: { error: null, lastObserved: true, coveredSince: null, coveredUntil: null }, coverage: [] }
  let complete = true, lifetimeStart = since
  const stages = new Map<string, number>()
  const addLimit = (value: string) => { if (!result.limits.includes(value)) result.limits.push(value) }
  const covered = (from: number, until: number) => healthIntervals(history, from, until).every(part => part.state === 'covered')
  const legacy = journal.cutover().legacyPulls.filter(id => !scope || id.split('/')[0].toLowerCase() === scope.toLowerCase())
  addLimit(`v2-only; uncorrelated legacy work excluded${legacy.length ? `: ${legacy.join(', ')}` : ' (cutover inventory: 0)'}`)
  for (const org of organizations) {
    const dependency = dependencies.datastore.find(entry => entry.org?.toLowerCase() === org.login.toLowerCase())
    const status = org.status !== 'ready' ? org.status : dependency?.status ?? 'unknown'
    result.coverage.push({ name: 'GitHub', scope: org.login, status, lastReadAt: dependency?.lastSuccessAt ?? null, intervals: null })
    if (status !== 'ok') { complete = false; addLimit(`${org.login}: GitHub evidence ${status}`) }
  }
  if (!organizations.length) { complete = false; addLimit('No configured GitHub account is available') }
  const accountsComplete = complete
  let after = ''
  for (;;) {
    const page = journal.page(after, 100, null)
    for (const chain of page) {
      input.signal?.throwIfAborted()
      if (!organizations.some(org => chain.repository.split('/')[0].toLowerCase() === org.login.toLowerCase())) continue
      const rows = historyRows(journal, chain.id)
      const admittedAt = rows[0]?.at
      const progress = chainProgress(journal, chain.id, undefined, true)
      // Reconciliation can replace the current outcome with a verified success.
      // Original failure receipts remain in the immutable journal, including
      // failed Calls whose resource/publication outcome is still uncertain.
      const errors: WorkError[] = []
      const seenErrors = new Set<string>()
      for (const row of rows) {
        const event = row.event
        if (event.type !== 'invocation.settled' && event.type !== 'invocation.reconciled') continue
        const invocation = chain.invocations.find(item => item.id === event.invocationId)!
        const error = workError(chain, { ...invocation, evidence: event.evidence,
          callId: event.type === 'invocation.settled' ? event.callId : null })
        if (!error || error.at > now || seenErrors.has(`${error.callId}:${error.incident}`)) continue
        seenErrors.add(`${error.callId}:${error.incident}`)
        errors.push(error)
      }
      for (const error of errors) if (!result.lastError.error || error.at > result.lastError.error.at) result.lastError.error = error
      const merged = rows.find(row => row.event.type === 'chain.observed' && row.event.observation.pull
        && (row.event.observation as ChainObservation).pull?.merged)
      const observation = (merged?.event as Extract<ChainEvent, { type: 'chain.observed' }> | undefined)?.observation as ChainObservation | undefined
      const pull = observation?.pull
      const mergedAt = pull?.mergedAt
      const verifiedMerge = !!chain.mergeSha && pull?.mergeSha === chain.mergeSha
        && observation?.publication.pull_number === pull?.number && observation?.publication.merged === true
        && observation.publication.merge_sha === chain.mergeSha && typeof mergedAt === 'number' && Number.isFinite(mergedAt) && mergedAt <= now
      if (chain.mergeSha && !verifiedMerge) { complete = false; addLimit(`${chain.id}: original GitHub merge time unavailable`) }
      if (verifiedMerge && mergedAt! >= since) {
        result.rate.completed++
        const incidents = new Set(errors.filter(error => error.at <= mergedAt!).map(error => error.incident))
        result.rate.errors += incidents.size
        result.rate.items.push({ work: chain.id, journal: journalHref(chain.id), summary: `${incidents.size} errors; merged ${new Date(mergedAt!).toISOString()}` })
        lifetimeStart = Math.min(lifetimeStart, admittedAt)
        if (!covered(admittedAt, mergedAt!) || chain.invocations.some(invocation => invocation.admittedAt <= mergedAt!
          && (!invocation.evidence || invocation.evidence.status === 'failed' && (!invocation.callId || !Number.isFinite(invocation.evidence.completedAt))
            || invocation.state === 'uncertain'))) {
          complete = false
          addLimit(`${chain.id}: incomplete lifetime evidence ${new Date(admittedAt).toISOString()} – ${new Date(mergedAt!).toISOString()}`)
        }
      }
      if (!chain.supersession && (!chain.mergeSha || chain.reviewPending)) {
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
      for (const error of errors) {
        const failed = chain.invocations.find(invocation => invocation.id === error.invocation)!
        const failure = rows.find(row => (row.event.type === 'invocation.settled' || row.event.type === 'invocation.reconciled')
          && row.event.invocationId === failed.id && row.event.evidence.status === 'failed')
        if (!failure) continue
        const retry = chain.invocations.find(invocation => invocation.admissionSequence > failure.sequence
          && invocation.behavior === failed.behavior && invocation.basis === failed.basis && invocation.slot === failed.slot
          && invocation.evidence?.status === 'completed')
        const resumed = rows.filter(row => row.sequence > failure.sequence && row.event.type === 'chain.resumed'
          && (!retry || row.sequence < retry.admissionSequence))
        const operator = resumed.find(row => row.event.type === 'chain.resumed' && row.event.recovery?.origin === 'operator')
        const ambiguous = resumed.some(row => row.event.type === 'chain.resumed' && (!row.event.recovery || row.event.recovery.origin === 'unknown'))
        const action = operator ?? resumed.at(-1)
        const origin = operator ? 'operator' : ambiguous ? 'unknown' : 'automatic'
        const success = retry && rows.find(row => (row.event.type === 'invocation.settled' || row.event.type === 'invocation.reconciled')
          && row.event.invocationId === retry.id && row.event.evidence.status === 'completed')
        const advanced = retry && success && progress.advances.find(point => {
          if (point.sequence < success.sequence || point.at < Number(retry.evidence?.completedAt) || point.at < error.at) return false
          const observed = rows.filter(row => row.sequence <= point.sequence && row.event.type === 'chain.observed').at(-1)
          return observed?.event.type === 'chain.observed' && retryProven(chain, retry, observed.event.observation as ChainObservation, point.at)
        })
        const recovery = operator?.event.type === 'chain.resumed' ? operator.event.recovery : null
        const interventionAt = recovery?.intervention?.at ?? (operator && advanced ? operator.at : null)
        const verifiedHelp = !!recovery?.intervention && recovery.intervention.at > error.at
          && recovery.intervention.verifiedAt >= recovery.intervention.at
          && chain.invocations.some(invocation => invocation.callId === recovery.intervention!.callId)
        const outcomeAt = origin === 'operator' ? interventionAt : advanced?.at
        if (origin === 'unknown' || !advanced || recovery?.intervention && !verifiedHelp) {
          if (error.at >= since || advanced && advanced.at >= since) unknownRecovery = true
          continue
        }
        if (outcomeAt === null || outcomeAt === undefined || outcomeAt < since || outcomeAt > now || outcomes.has(origin)) continue
        outcomes.set(origin, { work: chain.id, journal: journalHref(chain.id, failure.sequence), summary: error.summary,
          failedCall: error.callId, origin, actionSequence: action?.sequence ?? retry!.admissionSequence,
          actionAt: action?.at ?? retry!.admittedAt, progressAt: advanced.at,
          interventionAt: origin === 'operator' ? interventionAt : null })
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
  result.rate.perItem = complete && result.rate.completed > 0 ? result.rate.errors / result.rate.completed : null
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
