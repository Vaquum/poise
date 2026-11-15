// Per-PR open status projection: for every open pull request from a
// configured account, its age, review rounds against the cap, last verdict,
// CI and merge-queue state, and a one-line current blocker.
//
// Read-only by construction: datastore `view` reads (cached 60 s), pure
// behavior_seen/dead-letter SELECTs, meta reads, cached Caller history and the in-memory
// merge-candidate cache the existing merge-prs tick fills, or canonical
// journal projections for chain-owned PRs. No Caller
// invocation, no GitHub request, and no claim, retry, incident,
// queue-admission, or launch change (an expired repo hold may be lazily
// purged while reading it, which observes identically either way).
// Blocker-since lives in process memory and resets on restart (marked
// `sinceRestart`).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { classifyBehaviorDiagnostic } from '../src/behavior-failure-cause'
import { getCachedAgentLogSnapshot, quarantinedLogMayMatch } from './agent'
import { countReviewRounds, listGreyCiPendingHeads, listLiveReviewClaims, listPrReviewStates } from './db'
import { getOrganizations } from './organizations'
import { prAccounts } from './pr-accounts'
import { behaviorChainForPull, behaviorChainJournal, behaviorChainOwnsRepository } from './behavior-chain-journal'
import { projectChainPrStatus } from './behavior-chain-pr-status'
import { getBehaviorChainSettings } from './settings'
import { CHAIN_OBSERVATION_MAX_AGE_MS, decideBehaviorChain, type ChainObservation } from './behavior-chain-decision'
import { releaseBackgroundPaused } from './release-background'
import {
  BEHAVIOR_KEYS,
  chainBehaviorKey,
  MERGE_CANDIDATE_CACHE_STALE_MS,
  SKIPPABLE_BEHAVIORS,
  datastoreFreshnessEntries,
  fetchOpenPrRows,
  getBehaviorDiagnosticIncidents,
  getBehaviorFailureState,
  getCachedMergeCandidate,
  getMergeQueueAdmission,
  getRepoHoldRefusal,
  getRepositorySkips,
  getReviewCap,
  isEnabled,
  isPaused,
  ownPullRequestRefusal,
  pullRequestPolicy,
  pullRequestRefusal,
  reviewRoundNumber,
  withBehaviorOrganization,
  type BehaviorKey,
  type DatastorePr,
  type SkippableBehavior,
} from './behaviors'

export type PrBlockerId = 'not_eligible' | 'held' | 'review_running' | 'awaiting_author'
  | 'awaiting_review' | 'ci_pending' | 'ci_failing' | 'unresolved_threads' | 'conflicting'
  | 'behind' | 'blocked' | 'approved_not_enqueued' | 'in_queue' | 'unknown'

export interface PrStatusHeld {
  behavior: string
  code: string
  detail?: string
  /** Incident creation, ISO. */
  since: string
  nextRetryAt?: string
}

export interface PrStatusVerdict {
  action: string | null
  outcome: string | null
  head: string | null
  completedAt: string | null
  key: string
  quarantine: string | null
}

export type PrStatusQueueState = 'queued' | 'ejected' | 'not_queued' | 'no_queue' | 'unknown'

export interface BlockerInput {
  refusal: string | null
  /** Strongest (most recent) incident first. */
  held: PrStatusHeld[]
  liveClaim: { key: string, expectedHead: string | null, others: string[] } | null
  verdict: PrStatusVerdict | null
  /** Whether the verdict head is the current head; null when unverifiable. */
  onCurrentHead: boolean | null
  roundsCompleted: number
  roundsCap: number | null
  currentHead: string | null
  /** Fresh merge-candidate evidence only; nulls when `evidenceFresh` is false. */
  rollupState: string | null
  reviewDecision: string | null
  mergeState: string | null
  unresolvedThreads: number | null
  threadsComplete: boolean | null
  queueEnabled: boolean | null
  queue: { state: PrStatusQueueState, since: string | null, entryId: string | null }
  ejectedUnrecorded: boolean
  mergePrsEnabled: boolean
  mergePrsPaused: boolean
  /** Future merge-prs backoff for this target, ISO, when one stands. */
  mergeRetryAt: string | null
  greyPending: boolean
  evidenceFresh: boolean
  /** Why merge-candidate evidence is unusable, when it is. */
  evidenceWhy: string | null
}

export interface ComputedBlocker {
  id: PrBlockerId
  line: string
  /** Distinguisher within the id; `id:key` is the staleness identity. */
  key: string
  details: string[]
}

const MAX_LINE = 160

function truncateLine(line: string): string {
  return line.length <= MAX_LINE ? line : `${line.slice(0, MAX_LINE - 1)}…`
}

function shortHead(head: string | null): string {
  return head ? head.slice(0, 8) : 'unknown head'
}

function shortTime(iso: string): string {
  const time = iso.slice(11, 16)
  return /^\d{2}:\d{2}$/.test(time) ? `${time}Z` : iso
}

// Closed blocker vocabulary, first match wins. Approvals need proof of
// currency (a stale approval never reads as current); a change request
// stands until a new head or verdict disproves it. Pure: every branch is
// unit-tested.
export function computePrBlocker(input: BlockerInput): ComputedBlocker {
  const details: string[] = []
  const done = (id: PrBlockerId, line: string, key: string): ComputedBlocker =>
    ({ id, line: truncateLine(line), key, details: details.slice(0, 8) })

  if (input.refusal) {
    return done('not_eligible', input.refusal, `refusal:${input.refusal.slice(0, 80)}`)
  }

  const [strongest, ...restHeld] = input.held
  if (strongest) {
    if (strongest.detail) details.push(`${strongest.behavior}: ${strongest.detail}`)
    if (input.liveClaim && input.currentHead
      && input.liveClaim.expectedHead?.toLowerCase() === input.currentHead.toLowerCase()) {
      details.push(`review running: ${input.liveClaim.key} on ${shortHead(input.liveClaim.expectedHead)}`)
      for (const other of input.liveClaim.others) details.push(`also running: ${other}`)
    }
    for (const other of restHeld) details.push(`also held: ${other.behavior} ${other.code} since ${shortTime(other.since)}${other.detail ? `: ${other.detail}` : ''}`)
    const retry = strongest.nextRetryAt ? `, retry ${shortTime(strongest.nextRetryAt)}` : ''
    return done('held', `held: ${strongest.behavior} ${strongest.code} since ${shortTime(strongest.since)}${retry}`,
      `held:${strongest.behavior}:${strongest.code}`)
  }

  if (input.liveClaim) {
    const head = input.liveClaim.expectedHead
    if (head && input.currentHead && head.toLowerCase() !== input.currentHead.toLowerCase()) {
      details.push(`claim is on ${shortHead(head)}, current head is ${shortHead(input.currentHead)}`)
    }
    for (const other of input.liveClaim.others) details.push(`also running: ${other}`)
    return done('review_running', `review running: ${input.liveClaim.key} on ${shortHead(head)}`,
      `running:${input.liveClaim.key}:${head ?? 'unknown'}`)
  }

  const verdict = input.verdict
  const changesRequested = (verdict?.outcome === 'changes_requested' && input.onCurrentHead !== false)
    || (input.evidenceFresh && input.reviewDecision === 'CHANGES_REQUESTED')
  if (changesRequested) {
    const head = verdict?.outcome === 'changes_requested' ? verdict.head : input.currentHead
    if (!input.evidenceFresh) details.push('current head unverified')
    if (verdict?.quarantine) details.push(`latest ${verdict.key} run quarantined`)
    if (input.evidenceFresh && input.reviewDecision === 'CHANGES_REQUESTED' && verdict?.outcome !== 'changes_requested') {
      details.push('requested outside the latest Poise verdict')
    }
    return done('awaiting_author', `changes requested on ${shortHead(head)} need author action`,
      `author:${head ?? 'unknown'}`)
  }

  const verdictCurrent = verdict && input.onCurrentHead === true ? verdict : null
  // A null decision means GitHub requires no reviews on this base; only a
  // concrete non-approved decision blocks.
  const decisionBlocks = input.evidenceFresh && input.reviewDecision !== null && input.reviewDecision !== 'APPROVED'
  const needsReview = !verdictCurrent
    || (verdictCurrent.outcome !== 'approved' && verdictCurrent.outcome !== 'clean')
    || decisionBlocks
  if (needsReview) {
    const cap = input.roundsCap === null ? 'off' : `${input.roundsCompleted}/${input.roundsCap}`
    const capNote = input.roundsCap !== null && input.roundsCompleted >= input.roundsCap ? ' · cap reached' : ''
    if (verdict && input.onCurrentHead === false && verdict.head) {
      details.push(`last verdict on ${shortHead(verdict.head)}`)
    }
    if (decisionBlocks) details.push(`review decision: ${input.reviewDecision}`)
    if (input.evidenceFresh && input.reviewDecision === 'APPROVED' && !verdictCurrent) {
      details.push('review decision already APPROVED without a current Poise verdict')
    }
    return done('awaiting_review', `awaiting review of ${shortHead(input.currentHead)} · cap ${cap}${capNote}`,
      `review:${input.currentHead ?? 'unknown'}`)
  }

  // Queue membership short-circuits the merge gates: GitHub already judged
  // the head, so head-CI churn during integration must not masquerade as
  // the blocker.
  if (input.queue.state === 'queued') {
    const since = input.queue.since ? ` since ${shortTime(input.queue.since)}` : ''
    return done('in_queue', `in merge queue${since}`, `queue:${input.queue.entryId ?? 'unknown'}`)
  }
  if (input.queue.state === 'ejected') {
    const observed = input.queue.since ? ` (observed ${shortTime(input.queue.since)})` : ''
    const cause = input.ejectedUnrecorded ? 'queue entry gone, cause unrecorded' : `removed from merge queue${observed}`
    return done('approved_not_enqueued', `approved, not enqueued: ${cause}`, 'enqueue:ejected')
  }

  // Merge gates need fresh evidence; without it the row ends unknown below.
  const missing: string[] = []
  if (!input.evidenceFresh) missing.push(input.evidenceWhy ?? 'merge-candidate evidence')
  if (input.evidenceFresh) {
    const rollup = input.rollupState
    if (rollup === 'FAILURE' || rollup === 'ERROR') {
      const grey = input.greyPending ? ' · grey rerun pending' : ''
      return done('ci_failing', `CI failing on ${shortHead(input.currentHead)}${grey}`, `ci:${input.currentHead}`)
    }
    // The queue path requires SUCCESS; the direct path tolerates no checks.
    if (rollup !== 'SUCCESS' && !(rollup === null && input.queueEnabled === false)) {
      const grey = input.greyPending ? ' · grey rerun pending' : ''
      return done('ci_pending', `CI pending on ${shortHead(input.currentHead)}${grey}`, `ci:${input.currentHead}`)
    }
  }
  if (input.evidenceFresh) {
    if (input.unresolvedThreads !== null && input.unresolvedThreads > 0) {
      return done('unresolved_threads',
        `${input.unresolvedThreads} unresolved conversation${input.unresolvedThreads === 1 ? '' : 's'} on ${shortHead(input.currentHead)}`,
        `threads:${input.currentHead}`)
    }
    if (input.unresolvedThreads === null || input.threadsComplete === null) missing.push('thread evidence')
    else if (!input.threadsComplete && input.unresolvedThreads === 0) missing.push('complete thread list')
  }
  if (input.evidenceFresh) {
    const state = input.mergeState
    if (state === 'DIRTY') {
      return done('conflicting', `merge conflict on ${shortHead(input.currentHead)}`, `merge:${input.currentHead}`)
    }
    if (state === 'BEHIND') {
      return done('behind', `behind base on ${shortHead(input.currentHead)}`, `merge:${input.currentHead}`)
    }
    if (state === 'BLOCKED') {
      return done('blocked', `merge blocked by GitHub on ${shortHead(input.currentHead)}`, `merge:${input.currentHead}`)
    }
    if (state === null || state === 'UNKNOWN') missing.push('merge state')
  }

  if (missing.length === 0) {
    const sub = !input.mergePrsEnabled ? 'merge-prs disabled'
      : input.mergePrsPaused ? 'merge-prs paused'
      : input.mergeRetryAt ? `merge retry at ${shortTime(input.mergeRetryAt)}`
        : 'waiting for merge-prs scan'
    return done('approved_not_enqueued', `approved, not enqueued: ${sub}`, `enqueue:${sub}`)
  }
  const [first, ...rest] = missing
  for (const name of rest) details.push(`also unavailable: ${name}`)
  return done('unknown', `unknown: ${first} unavailable`, `unknown:${first}`)
}

export interface PrStatusRow {
  ownership?: { engine: 'v1' | 'v2', chainId?: string, sequence?: number, reviewPending?: boolean | null,
    reviewStatus?: 'pending' | 'complete' | 'not-recorded', observation?: 'fresh' | 'stale' | 'missing' | 'skipped-while-owned',
    mergeSha?: string | null, journal?: string, reviews?: { completed: number | null, required: number | null },
    reconciliation?: { nextObservationAt: string | null, waitingForOriginalResponse: boolean, waitingForResourceRelease?: boolean } }
  repository: string
  number: number
  org: string | null
  author: string
  createdAt: string | null
  /** Whole minutes since `createdAt`; null when the age is unknown. */
  ageMinutes: number | null
  /** Legacy counter only; null fields for v2, whose verified panel is in ownership.reviews. */
  rounds: { completed: number | null, cap: number | null, next: number | null }
  verdict: (PrStatusVerdict & { onCurrentHead: boolean | null }) | null
  ci: { state: string | null, head: string | null, asOf: string | null } | { state: 'unknown', reason: string }
  queue: { state: PrStatusQueueState, entryId: string | null, since: string | null,
    attribution?: 'accepted-response' | 'observed', invocationId?: string,
    disposition?: string, integrationBase?: string | null, integrationHead?: string | null }
  blocker: { id: PrBlockerId, line: string, since: string, sinceRestart: boolean, details: string[] }
  flags: { age: boolean, staleBlocker: boolean }
  eligibility: { refusal: string | null, skippedBy: string[] }
  ledger: string
}

export interface PrStatusCoverage {
  org: string | null
  status: 'ready' | 'initializing' | 'unavailable'
  checkedAt: string | null
  ageSeconds: number | null
  lastSuccessAt: string | null
  error: string | null
}

export interface PrStatusReply {
  version: 2
  health: { status: 'ok' | 'stale' | 'unavailable', pending: 0, dropped: 0, gaps: [] }
  asOf: string
  identity: { status: 'valid' | 'invalid', error: string | null }
  datastore: { orgs: PrStatusCoverage[] }
  rows: PrStatusRow[]
  totalOpen: number
  truncated: boolean
}

export const PR_STATUS_DEFAULT_LIMIT = 50
export const PR_STATUS_MAX_LIMIT = 100
export const PR_STATUS_AGE_FLAG_MS = 60 * 60_000
export const PR_STATUS_BLOCKER_STALE_MS = 15 * 60_000
const DATASTORE_CACHE_MS = 60_000

// Latest open-PR listing per datastore scope. Rows are unfiltered: the
// account pair can change between reads, so author matching stays live.
const datastoreCache = new Map<string, { at: number, rows: DatastorePr[] | null, error: string | null }>()

// Observed blocker per pull request. First sight marks `sinceRestart`: the
// blocker may predate this process, and only a witnessed transition clears
// it. Polling never resets an unchanged identity.
const blockerSince = new Map<string, { id: PrBlockerId, key: string, since: string, sinceRestart: boolean }>()

/** Test-only: drop cached listings and observed blockers. */
export function resetPrStatusCaches(): void {
  datastoreCache.clear()
  blockerSince.clear()
}

function targetKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`
}

function incidentKey(incident: { repo: string | null, pr: number | null, target: string }): string | null {
  if (incident.repo && incident.pr) return targetKey(incident.repo, incident.pr)
  const ref = /^[^#]+#\d+/.exec(incident.target)?.[0]
  return ref ? ref.toLowerCase() : null
}

function trackBlocker(key: string, id: PrBlockerId, basis: string, asOf: string) {
  const previous = blockerSince.get(key)
  if (previous && previous.id === id && previous.key === basis) return previous
  const tracked = { id, key: basis, since: asOf, sinceRestart: !previous }
  blockerSince.set(key, tracked)
  return tracked
}

async function readScopeRows(scope: string | null): Promise<{ rows: DatastorePr[] | null, error: string | null }> {
  const key = scope ?? 'legacy'
  const cached = datastoreCache.get(key)
  const now = Date.now()
  if (cached && now - cached.at < DATASTORE_CACHE_MS) return cached
  try {
    const rows = await withBehaviorOrganization(scope ?? undefined, () => fetchOpenPrRows())
    const entry = { at: now, rows, error: null as string | null }
    datastoreCache.set(key, entry)
    return entry
  } catch (error) {
    const entry = { at: now, rows: null, error: error instanceof Error ? error.message : String(error) }
    datastoreCache.set(key, entry)
    return entry
  }
}

export async function readPrStatus(limit: number, now = Date.now()): Promise<PrStatusReply> {
  const asOf = new Date(now).toISOString()
  const unhealthy = (identity: PrStatusReply['identity'], orgs: PrStatusCoverage[]): PrStatusReply => ({
    version: 2, health: { status: 'unavailable', pending: 0, dropped: 0, gaps: [] }, asOf,
    identity, datastore: { orgs }, rows: [], totalOpen: 0, truncated: false,
  })

  let accounts: { me: string, agent: string }
  try {
    accounts = prAccounts()
  } catch (error) {
    return unhealthy({ status: 'invalid', error: error instanceof Error ? error.message : String(error) }, [])
  }
  const pair = [accounts.me.toLowerCase(), accounts.agent.toLowerCase()]

  const organizations = getOrganizations()
  const scopes: Array<{ login: string | null, ready: boolean }> = organizations.length
    ? organizations.map((org) => ({ login: org.login, ready: org.status === 'ready' }))
    : [{ login: null, ready: true }]
  const freshness = new Map(datastoreFreshnessEntries(now).map((entry) => [entry.org?.toLowerCase() ?? 'legacy', entry]))
  const coverage: PrStatusCoverage[] = []
  const inventory: Array<{ pr: DatastorePr, org: string | null }> = []
  // Every organization at once: each read is its own datastore process,
  // and one after another their times added up.
  const reads = await Promise.all(scopes.map((scope) => scope.ready ? readScopeRows(scope.login) : null))
  for (const [index, scope] of scopes.entries()) {
    const observed = freshness.get(scope.login?.toLowerCase() ?? 'legacy')
    if (!scope.ready) {
      coverage.push({ org: scope.login, status: 'initializing', checkedAt: observed?.checkedAt ?? null,
        ageSeconds: observed?.ageSeconds ?? null, lastSuccessAt: observed?.lastSuccessAt ?? null,
        error: 'datastore is initializing' })
      continue
    }
    const { rows, error } = reads[index]!
    if (!rows) {
      coverage.push({ org: scope.login, status: 'unavailable', checkedAt: observed?.checkedAt ?? null,
        ageSeconds: observed?.ageSeconds ?? null, lastSuccessAt: observed?.lastSuccessAt ?? null, error })
      continue
    }
    coverage.push({ org: scope.login, status: 'ready', checkedAt: observed?.checkedAt ?? null,
      ageSeconds: observed?.ageSeconds ?? null, lastSuccessAt: observed?.lastSuccessAt ?? null, error: null })
    // Same ownership rule as the tick: a scope lists its own owner's rows.
    for (const pr of rows) {
      if (!scope.login || pr.repo.split('/')[0].toLowerCase() === scope.login.toLowerCase()) {
        inventory.push({ pr, org: scope.login })
      }
    }
  }
  const readable = coverage.some((entry) => entry.status === 'ready')
  if (!readable) {
    return unhealthy({ status: 'valid', error: null }, coverage)
  }

  const mergePrsEnabled = isEnabled('merge-prs')
  const mergePrsPaused = isPaused('merge-prs')
  const mergePrsRunnable = mergePrsEnabled && !mergePrsPaused
  const cap = getReviewCap()
  // Only the reported pull requests' launches are looked up below.
  const reviewStates = listPrReviewStates(inventory.map(({ pr }) => pr.number))
  const liveClaims = listLiveReviewClaims()
  const greyHeads = listGreyCiPendingHeads()
  const snapshot = getCachedAgentLogSnapshot()
  const incidents = getBehaviorDiagnosticIncidents(snapshot)
  const skips = new Map(SKIPPABLE_BEHAVIORS.map((behavior) =>
    [behavior, new Set(getRepositorySkips(behavior).map((repo) => repo.toLowerCase()))] as const))

  const statesByPr = new Map<string, typeof reviewStates>()
  for (const state of reviewStates) {
    const key = targetKey(state.repo, state.pr)
    const group = statesByPr.get(key) ?? []
    group.push(state)
    statesByPr.set(key, group)
  }
  const claimsByPr = new Map<string, typeof liveClaims>()
  for (const claim of liveClaims) {
    if (claim.requestedAt === null && claim.leaseUntil !== null && claim.leaseUntil <= now) continue
    const key = targetKey(claim.repo, claim.pr)
    const group = claimsByPr.get(key) ?? []
    group.push(claim)
    claimsByPr.set(key, group)
  }
  const incidentsByPr = new Map<string, typeof incidents>()
  for (const incident of incidents) {
    if (!(SKIPPABLE_BEHAVIORS as readonly string[]).includes(incident.behavior)) continue
    const key = incidentKey(incident)
    if (!key) continue
    const group = incidentsByPr.get(key) ?? []
    group.push(incident)
    incidentsByPr.set(key, group)
  }
  for (const group of incidentsByPr.values()) {
    group.sort((a, b) => b.createdAt.localeCompare(a.createdAt)
      || a.behavior.localeCompare(b.behavior) || a.target.localeCompare(b.target))
  }

  const rows: PrStatusRow[] = []
  let chainEvidenceStale = false
  let chainAdmissionsEnabled: boolean | undefined
  for (const { pr, org } of inventory) {
    if (!pair.includes(pr.author.toLowerCase())) continue
    const target = `${pr.repo}#${pr.number}`
    const key = targetKey(pr.repo, pr.number)
    const scoped = <T>(operation: () => T): T => withBehaviorOrganization(org ?? undefined, operation)
    const chain = behaviorChainForPull(pr.repo, pr.number, pr)
    if (chain) {
      // A confirmed completed chain is stronger than an open datastore row
      // that has not caught up. Retained review obligations stay visible.
      if (chain.mergeSha && !chain.reviewPending) continue
      chainAdmissionsEnabled ??= getBehaviorChainSettings().enabled && behaviorChainJournal().cutover().mode === 'v2'
      const observation = chain.observation as ChainObservation | null
      const fresh = !!observation && observation.checkedAt <= now && now - observation.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS
      const active = chain.invocations.find((invocation) => invocation.state !== 'settled')
      const next = fresh && !active ? decideBehaviorChain(chain, observation, now) : null
      const phase = active?.behavior ?? (next?.kind === 'invoke' ? next.behavior : null)
      const phaseKey = phase ? chainBehaviorKey(phase) : null
      const pauses = scoped(() => [
        ...(releaseBackgroundPaused() ? ['release background barrier is paused'] : []),
        ...(phaseKey && !isEnabled(phaseKey) ? [`${phaseKey} is disabled`] : []),
        ...(phaseKey && isPaused(phaseKey) ? [`${phaseKey} admissions are paused`] : []),
      ])
      const skippable = phaseKey && (SKIPPABLE_BEHAVIORS as readonly string[]).includes(phaseKey) ? phaseKey as SkippableBehavior : null
      const refusal = skippable && observation?.pull ? scoped(() => pullRequestRefusal(pullRequestPolicy(skippable), chain.repository, pr.number,
        { author: chain.author, status: observation.pull!.state, draft: observation.pull!.draft })) : null
      const projected = projectChainPrStatus(chain, behaviorChainJournal(), pr, org, now, chainAdmissionsEnabled, pauses,
        { refusal, skippedBy: skippable && skips.get(skippable)?.has(pr.repo.toLowerCase()) ? [skippable] : [] },
        behaviorChainJournal().reconciliationAt(chain))
      const tracked = trackBlocker(key, projected.row.blocker.id, projected.key, asOf)
      projected.row.blocker.since = tracked.since
      projected.row.blocker.sinceRestart = tracked.sinceRestart
      projected.row.flags.age = pr.created_at !== null && now - Date.parse(pr.created_at) > PR_STATUS_AGE_FLAG_MS
      projected.row.flags.staleBlocker = now - Date.parse(tracked.since) > PR_STATUS_BLOCKER_STALE_MS
      chainEvidenceStale ||= projected.stale
      rows.push(projected.row)
      continue
    }
    if ((!pr.headRef || !pr.headRepo) && behaviorChainOwnsRepository(pr.repo)) {
      throw new Error(`PR ${target} lacks branch evidence needed to distinguish legacy and chain ownership`)
    }

    const skippedBy = SKIPPABLE_BEHAVIORS.filter((behavior) => skips.get(behavior)?.has(pr.repo.toLowerCase()))
    const refusal = scoped(() => ownPullRequestRefusal(accounts.me, target, pr, accounts.agent)
      ?? getRepoHoldRefusal(pr.repo)
      ?? (skippedBy.length === SKIPPABLE_BEHAVIORS.length
        ? `${pr.repo} is in the Skip repositories list of every PR behavior (${skippedBy.join(', ')})` : null))

    const completed = countReviewRounds(pr.repo, pr.number)
    const states = statesByPr.get(key) ?? []
    const finished = states
      .filter((state) => state.outcome !== null && state.completedAt !== null)
      .sort((a, b) => (b.completedAt as string).localeCompare(a.completedAt as string))
    const latest = finished[0] ?? null
    const verdict: PrStatusVerdict | null = latest ? {
      action: latest.action, outcome: latest.outcome, head: latest.headSha,
      completedAt: latest.completedAt, key: latest.key, quarantine: latest.quarantine,
    } : null
    const claims = (claimsByPr.get(key) ?? []).sort((a, b) =>
      (b.requestedAt ?? '').localeCompare(a.requestedAt ?? '') || a.key.localeCompare(b.key))
    const [claim, ...otherClaims] = claims

    const cached = getCachedMergeCandidate(pr.repo, pr.number)
    const cacheAge = cached ? now - Date.parse(cached.at) : Number.POSITIVE_INFINITY
    const cacheUsable = !!cached && !cached.error && cacheAge <= MERGE_CANDIDATE_CACHE_STALE_MS && mergePrsRunnable
    const evidenceWhy = !mergePrsEnabled ? 'merge-prs disabled'
      : mergePrsPaused ? 'merge-prs paused'
      : !cached ? 'no merge-candidate reading yet'
      : cached.error ? 'merge-candidate read failed'
      : cacheAge > MERGE_CANDIDATE_CACHE_STALE_MS ? 'merge-candidate reading stale' : null
    const currentHead = cacheUsable && cached.head ? cached.head.toLowerCase() : null
    const onCurrentHead = !verdict ? null
      : !verdict.head || !currentHead ? null
      : verdict.head.toLowerCase() === currentHead

    const admission = scoped(() => getMergeQueueAdmission(target))
    const admissionLive = admission && (!currentHead || admission.head.toLowerCase() === currentHead)
      ? admission : null
    const mergeFailure = scoped(() => getBehaviorFailureState('merge-prs', target))
    const ejectionRecorded = !!mergeFailure?.error?.includes('removed from the merge queue')
    // A cache reading older than the admission cannot disprove it: right
    // after an enqueue it still carries no entry while the admission is
    // already live. Only a newer entry-less reading proves removal.
    const admissionNewerThanCache = !!admissionLive && cacheUsable
      && Date.parse(cached.at) <= Date.parse(admissionLive.at)
    const ejected = !!admissionLive && (ejectionRecorded
      || (cacheUsable && !cached.queueEntryId && !admissionNewerThanCache))
    const ejectionAt = ejected
      ? (ejectionRecorded ? mergeFailure?.lastFailureAt ?? null : null) ?? admissionLive?.at ?? null
      : null
    let queueState: PrStatusRow['queue']['state']
    let queueSince: string | null = null
    if (ejected) {
      queueState = 'ejected'
      queueSince = ejectionAt
    } else if (cacheUsable && cached.queueEntryId) {
      queueState = 'queued'
      queueSince = admissionLive?.at ?? cached.at
    } else if (admissionLive && admissionNewerThanCache) {
      queueState = 'queued'
      queueSince = admissionLive.at
    } else if (!cacheUsable) {
      queueState = 'unknown'
    } else if (cached.queueEnabled === false) {
      queueState = 'no_queue'
    } else {
      queueState = 'not_queued'
    }
    const mergeRetryAt = mergeFailure && !ejected && Date.parse(mergeFailure.nextRetryAt) > now
      ? mergeFailure.nextRetryAt : null
    const greyPending = !!currentHead && greyHeads.has(`${pr.repo.toLowerCase()}:${currentHead}`)

    // Without Caller evidence every incident reads `held_result`; recover the
    // recorded cause from the matching failure row (which kept the Caller
    // error code), else from the incident text. Never a guess: anything
    // unrecognized stays `held_result`.
    const historical: string[] = []
    const held: PrStatusHeld[] = []
    const liveOnCurrentHead = !!currentHead && claim?.expectedHead?.toLowerCase() === currentHead
    const quarantined = states.some((state) => state.quarantine !== null)
    for (const incident of incidentsByPr.get(key) ?? []) {
      let code = incident.diagnostic?.code ?? 'unknown'
      if (code === 'held_result' && incident.callId
        && (BEHAVIOR_KEYS as readonly string[]).includes(incident.behavior)) {
        const failure = scoped(() => getBehaviorFailureState(incident.behavior as BehaviorKey, incident.target))
        const stronger = failure?.callId === incident.callId ? failure.diagnostic?.code : undefined
        if (stronger && stronger !== 'held_result' && stronger !== 'unknown') code = stronger
      }
      if (code === 'held_result') {
        const textCode = classifyBehaviorDiagnostic(incident.error).code
        if (textCode !== 'unknown') code = textCode
      }
      // Recovery can release and reuse a headless launch. Only the original
      // Call/correlation can recover its head; conflicting or possible-write
      // evidence must keep the hold.
      const review = incident.behavior === 'review-new-prs' || incident.behavior === 'approve-prs'
      const targetHead = /(?:@|\/)head=([a-f0-9]{40})(?=$|[/:])/i.exec(incident.target)?.[1].toLowerCase()
      const launch = incident.callId ? states.find((state) => state.key === incident.behavior
        && state.target === incident.target && state.callId === incident.callId) : undefined
      const launchHead = launch?.expectedHead?.toLowerCase()
      const calls = snapshot?.entries.filter((row) => (!!incident.callId && row.id === incident.callId)
        || (!!incident.correlationId && row.correlation_id === incident.correlationId)) ?? []
      const call = calls.length === 1 ? calls[0] : undefined
      const callerHead = call?.expected_head?.toLowerCase()
      const head = targetHead ?? launchHead ?? callerHead
      const consistent = (!launch || (!!launchHead && (!targetHead || targetHead === launchHead)
        && (!launch.headSha || launch.headSha.toLowerCase() === launchHead)
        && (!incident.actor || launch.actor?.toLowerCase() === incident.actor.toLowerCase())
        && (!incident.source || launch.source === incident.source)))
        && calls.length <= 1 && (!call || (call.id === incident.callId
          && !!incident.correlationId && call.correlation_id === incident.correlationId
          && call.repo === incident.repo && String(call.pr_id) === String(incident.pr)
          && call.behavior === (incident.behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve')
          && !!incident.actor && call.actor?.toLowerCase() === incident.actor.toLowerCase()
          && incident.source === `poise:${incident.behavior}` && call.source === incident.source
          && callerHead === head && call.status === 'failed'
          && call.action === 'not_started' && call.outcome === 'preflight_failed'
          && !call.head_sha && call.review_id == null && call.review_comments == null && call.receipts == null
          && !/could not prove a safe recovery/.test(call.error)))
        && !snapshot?.quarantined.some((row) => quarantinedLogMayMatch(row, {
          id: incident.callId, correlationId: incident.correlationId,
          repo: incident.repo, prId: String(incident.pr),
          behavior: incident.behavior === 'review-new-prs' ? 'pr_review' : 'pr_approve',
        }))
        && incidentKey({ repo: null, pr: null, target: incident.target }) === key
      if (review && liveOnCurrentHead && !quarantined && code !== 'invalid_agent_result'
        && consistent && head && /^[a-f0-9]{40}$/.test(head) && head !== currentHead) {
        historical.push(`past review: ${incident.behavior} ${code} on ${head} since ${incident.createdAt}`)
        continue
      }
      held.push({
        behavior: incident.behavior,
        code,
        detail: incident.error,
        since: incident.createdAt,
        ...(incident.nextRetryAt ? { nextRetryAt: incident.nextRetryAt } : {}),
      })
    }

    const computed = computePrBlocker({
      refusal, held,
      liveClaim: claim ? { key: claim.key, expectedHead: claim.expectedHead,
        others: otherClaims.map((other) => `${other.key} on ${shortHead(other.expectedHead)}`) } : null,
      verdict, onCurrentHead, roundsCompleted: completed, roundsCap: cap, currentHead,
      rollupState: cacheUsable ? cached.rollupState : null,
      reviewDecision: cacheUsable ? cached.reviewDecision : null,
      mergeState: cacheUsable ? cached.mergeStateStatus : null,
      unresolvedThreads: cacheUsable ? cached.unresolvedThreads : null,
      threadsComplete: cacheUsable ? cached.threadsComplete : null,
      queueEnabled: cacheUsable ? cached.queueEnabled : null,
      queue: { state: queueState, since: queueSince,
        entryId: queueState === 'queued' && cacheUsable ? cached.queueEntryId : null },
      ejectedUnrecorded: ejected && !ejectionRecorded,
      mergePrsEnabled, mergePrsPaused, mergeRetryAt, greyPending,
      evidenceFresh: cacheUsable, evidenceWhy,
    })
    const checkDetails = scoped(() => ([
      ['review-new-prs', `${target}:check`],
      ['review-new-prs', `${target}:secondary:check`],
      ['review-new-prs', `${target}:tertiary:check`],
      ['approve-prs', `${target}:check`],
    ] as const).flatMap(([behavior, checkTarget]) => {
      const failure = getBehaviorFailureState(behavior, checkTarget)
      if (!failure) return []
      const retry = Date.parse(failure.nextRetryAt) > now ? 'at' : 'due since'
      return [`${behavior} check failed for ${checkTarget}: ${failure.error ?? 'cause unrecorded'}; revision unverified; retry ${retry} ${failure.nextRetryAt}`]
    }))
    computed.details = [...computed.details, ...checkDetails, ...historical].slice(0, 8)

    const tracked = trackBlocker(key, computed.id, computed.key, asOf)

    const createdMs = pr.created_at ? Date.parse(pr.created_at) : Number.NaN
    const ageMinutes = Number.isFinite(createdMs) ? Math.max(0, Math.floor((now - createdMs) / 60_000)) : null
    const ageFlag = Number.isFinite(createdMs) && now - createdMs > PR_STATUS_AGE_FLAG_MS
    const staleFlag = now - Date.parse(tracked.since) > PR_STATUS_BLOCKER_STALE_MS

    rows.push({
      ownership: { engine: 'v1' },
      repository: pr.repo, number: pr.number, org, author: pr.author,
      createdAt: pr.created_at, ageMinutes,
      rounds: { completed, cap, next: reviewRoundNumber(pr.repo, pr.number) },
      verdict: verdict ? { ...verdict, onCurrentHead } : null,
      ci: cacheUsable
        ? { state: cached.rollupState, head: cached.head?.toLowerCase() ?? null, asOf: cached.at }
        : { state: 'unknown', reason: evidenceWhy ?? 'merge-candidate evidence' },
      queue: { state: queueState,
        entryId: queueState === 'queued' && cacheUsable ? cached.queueEntryId : null, since: queueSince },
      blocker: { id: computed.id, line: computed.line, since: tracked.since,
        sinceRestart: tracked.sinceRestart, details: computed.details },
      flags: { age: ageFlag, staleBlocker: staleFlag },
      eligibility: { refusal, skippedBy: skippedBy as string[] },
      ledger: `/api/behavior-ledger?repository=${pr.repo}&number=${pr.number}`,
    })
  }

  // Flagged rows first, then oldest opened first; unknown ages sort last.
  rows.sort((a, b) => Number(b.flags.age || b.flags.staleBlocker) - Number(a.flags.age || a.flags.staleBlocker)
    || (a.createdAt ?? '\uffff').localeCompare(b.createdAt ?? '\uffff')
    || a.repository.localeCompare(b.repository) || a.number - b.number)
  const totalOpen = rows.length
  const sliced = rows.slice(0, limit)
  const partial = chainEvidenceStale || coverage.some((entry) => entry.status !== 'ready')
  return {
    version: 2,
    health: { status: partial ? 'stale' : 'ok', pending: 0, dropped: 0, gaps: [] },
    asOf,
    identity: { status: 'valid', error: null },
    datastore: { orgs: coverage },
    rows: sliced,
    totalOpen,
    truncated: totalOpen > sliced.length,
  }
}

const PR_STATUS_PATH = '/api/behavior-ledger/pr-status'

class InvalidPrStatusRead extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

/** Strictly bounded selector; GET-only, `limit` 1..100, nothing else. */
export function parsePrStatusRead(target: string): { limit: number } {
  const url = new URL(target, 'http://pr-status.invalid')
  if (target.split('?')[0] !== url.pathname || url.pathname !== PR_STATUS_PATH) {
    throw new InvalidPrStatusRead(404, 'not_found')
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'limit' || url.searchParams.getAll(key).length !== 1) {
      throw new InvalidPrStatusRead(400, 'invalid_query')
    }
  }
  const rawLimit = url.searchParams.get('limit')
  if (rawLimit !== null && (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > PR_STATUS_MAX_LIMIT)) {
    throw new InvalidPrStatusRead(400, 'invalid_query')
  }
  return { limit: rawLimit === null ? PR_STATUS_DEFAULT_LIMIT : Number(rawLimit) }
}

const PR_STATUS_RESPONSE_BYTES = 512 * 1024

function sendPrStatus(res: ServerResponse, status: number, body: PrStatusReply): void {
  let text = JSON.stringify(body)
  if (Buffer.byteLength(text) > PR_STATUS_RESPONSE_BYTES) {
    status = 503
    text = JSON.stringify({ version: body.version, health: body.health, error: 'response_too_large' })
  }
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  if (status === 405) res.setHeader('Allow', 'GET')
  res.end(text)
}

function sendPrStatusError(res: ServerResponse, status: number, code: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  if (status === 405) res.setHeader('Allow', 'GET')
  res.end(JSON.stringify({ error: code }))
}

/** GET-only handler, wired in cache-plugin.ts ahead of the ledger dispatch. */
export async function handleBehaviorPrStatus(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  if (req.method !== 'GET') {
    sendPrStatusError(res, 405, 'method_not_allowed')
    return
  }
  let limit: number
  try {
    limit = parsePrStatusRead(url).limit
  } catch (error) {
    sendPrStatusError(res, error instanceof InvalidPrStatusRead ? error.status : 400,
      error instanceof InvalidPrStatusRead ? error.code : 'invalid_query')
    return
  }
  try {
    sendPrStatus(res, 200, await readPrStatus(limit))
  } catch (error) {
    sendPrStatusError(res, 503, error instanceof Error ? error.message : 'pr_status_unavailable')
  }
}
