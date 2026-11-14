import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { parseFailedSource, type LogEntry } from './agent-log-parse'
import { CHAIN_OBSERVATION_MAX_AGE_MS, decideBehaviorChain, type ChainObservation } from './behavior-chain-decision'
import { chainBasis, chainIdentity, type BehaviorChain, type BehaviorChainJournal, type ChainBehavior } from './behavior-chain-store'
import { ReviewScopeIndexingError } from './behavior-chain-runtime'
import { behaviorChainWorkImpact } from './behavior-chain-summary'
import { behaviorErrorMessage } from './behavior-diagnostics'
import { nativeResourcesPending, resourceReleaseProven } from './behavior-resource-receipt'
import { runDatastoreHealth, validatedHealth } from './datastore-health'
import { handleGhBody, reconcileRepairReport } from './gh'
import { HttpError } from './http'
import { organizationArgs, organizationForRepository } from './organizations'
import { runFile } from './process'
import type { ProcessDiagnostic } from './process-diagnostic'
import { getBehaviorChainSettings, getSettings } from './settings'
import { isServiceMode, readServiceConfig } from './service/config'

export const REMEDIATION_SCOPE = `Minimal, clinical interventions all the way. Get in, get out, do the thing that actually has to be done, never expand it beyond that. Keep asking "is this truly the cleanest and simplest and least intrusive way to get this done" and do it that way and only that way. Don't let others come expand it, let them come make it cleaner.`

const MERGE_CAUSE = 'merge_submission_uncertain'
const CLOSED_CAUSE = 'pull_closed_unmerged'
const IMPLEMENTATION_CAUSE = 'atomic_work_blocked'
const IMPLEMENTATION_PUBLICATION_CAUSE = 'implementation_publication_uncertain'
const CAUSES = ['repair_incomplete_replies', 'repair_execution_budget_exhausted', 'review_budget_exhausted', MERGE_CAUSE, CLOSED_CAUSE, IMPLEMENTATION_CAUSE, IMPLEMENTATION_PUBLICATION_CAUSE] as const
const PREFIX = 'behavior_chain_repair_report:'
const REPOSITORIES_KEY = 'service_repair_exhaustion_repositories'
// Caller retains validation reasons wrapped as `atomic behavior failed during
// {phase}: {reason} ({operation})` and bounds them at 500 chars, so the
// sentence is matched where it appears: the reason stays verbatim inside
// the wrapper, and only this Caller-authored sentence matches it.
const INCOMPLETE_REPLIES = /repair did not answer every unresolved review finding(?:: missing_root_comment_ids=\[[0-9, ]*\]; missing_count=[1-9][0-9]*; required_count=[1-9][0-9]*)?/
const REPORT_MARKER = /<!-- poise-repair-exhaustion:[a-f0-9]{64} -->/

interface RepairReport {
  key: string
  source: string
  pull: number | null
  holdSequence: number | null
  heldAt: number | null
  head: string | null
  basis: string
  slot: string | null
  attempts: Array<{ invocation: string, call: string, completedAt: number }>
  issueNumber: number | null
  disposition?: { kind: 'source-only' | 'distinct-fix', revision: string, review: string, commentId: number,
    diagnosis: string, nextAction: string }
}

const SCOPE_DIRECTIVE = 'Include this exact paragraph in the linked PR review.'

async function seedScopeDirective(repository: string, issue: number, author: string): Promise<boolean> {
  let result: { repository?: unknown, issue_number?: unknown,
    issue?: { number?: unknown, body?: unknown, pull_request?: unknown } }
  try {
    const { stdout } = await runFile('github-interface', ['--read-issue', String(issue), '--repository', repository,
      '--token-user', author], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })
    result = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`Review scope seed read failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof result.repository !== 'string' || result.repository.toLowerCase() !== repository.toLowerCase()
    || result.issue_number !== issue || !result.issue || result.issue.number !== issue
    || (result.issue.body !== null && typeof result.issue.body !== 'string') || result.issue.pull_request) {
    throw new Error('Review scope seed read is incomplete')
  }
  return typeof result.issue.body === 'string' && result.issue.body.includes(`${REMEDIATION_SCOPE}\n\n${SCOPE_DIRECTIVE}`)
}

export async function repairReportReviewScope(db: Database, chain: Pick<BehaviorChain, 'repository' | 'issue' | 'author'>, pull: number): Promise<string> {
  const { repository, issue } = chain
  const report = db.prepare(`SELECT 1 FROM meta WHERE key GLOB ? AND json_extract(value, '$.source') GLOB ?
    AND json_extract(value, '$.issueNumber') = ? LIMIT 1`).get(PREFIX + '*', repository.toLowerCase() + '#*', issue)
  if (!report && !(await seedScopeDirective(repository, issue, chain.author))) return ''
  const org = organizationForRepository(repository)
  if (!org) throw new Error('Repair report review requires its followed organization')
  // Episode-aware: a raw health gate would emit fresh process and runtime
  // faults on every retry for the same open stale episode.
  const { stale, stdout: health } = await runDatastoreHealth(org, { timeoutMs: 30_000 }, ['review-pr', 'approve-pr'])
  if (stale) throw stale
  if (validatedHealth(health, org)?.status !== 'healthy') throw new Error('Repair report review lacks valid datastore freshness evidence')
  const { stdout } = await runFile('github-datastore', organizationArgs(org, ['view', 'pr-closing', '--repo', repository,
    '--format', 'json', '--limit', '1', ...(pull > 1 ? ['--after-number', String(pull - 1)] : [])]),
  { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 })
  const page = JSON.parse(stdout) as { prs?: Array<{ repo: string, number: number, closes_via: string, closing_truncated: boolean,
    closing: Array<{ repo: string, number: number }> }>, more?: boolean, truncated?: boolean } | null
  if (!page || !Array.isArray(page.prs) || page.prs.length > 1 || typeof page.more !== 'boolean'
    || typeof page.truncated !== 'boolean' || (!page.prs.length && (page.more || page.truncated))) {
    throw new Error('Repair report review lacks PR closing references')
  }
  const pr = page.prs[0]
  if (pr !== undefined && (!pr || typeof pr.repo !== 'string' || pr.repo.toLowerCase() !== repository.toLowerCase()
    || !Number.isSafeInteger(pr.number) || pr.number < pull || pr.closes_via !== 'closing-references'
    || pr.closing_truncated !== false || !Array.isArray(pr.closing)
    || pr.closing.some(ref => !ref || typeof ref.repo !== 'string' || !ref.repo.length
      || !Number.isSafeInteger(ref.number) || ref.number < 1))) {
    throw new Error('Repair report review has incomplete PR closing references')
  }
  if (page.truncated !== page.more) throw new Error('Repair report review has incomplete PR closing references')
  if (!pr || pr.number !== pull) throw new ReviewScopeIndexingError(repository, pull)
  if (!pr.closing.some(ref => ref.repo.toLowerCase() === repository.toLowerCase() && ref.number === issue)) return ''
  return REMEDIATION_SCOPE
}

function repositoryNames(configured: string): string[] {
  if (!configured.trim()) return []
  const repositories = configured.split(',').map(value => value.trim())
  for (const value of repositories) {
    const [owner, repo, extra] = value.split('/')
    if (!owner || !repo || extra !== undefined) throw new Error('POISE_REPAIR_EXHAUSTION_REPOSITORIES requires comma-separated owner/repo names')
    chainIdentity(value, 1)
  }
  return repositories
}

/** Health answers must fit the gateway's 64 KiB service-answer budget with room for every other field. */
export const MAX_REPAIR_REPORT_REPOSITORIES_BYTES = 8 * 1024

export function repairReportRepositories(db: Database): string {
  // An applied empty value must survive restart over a legacy container environment.
  const applied = isServiceMode()
    ? db.prepare('SELECT value FROM meta WHERE key = ?').get(REPOSITORIES_KEY) as { value: string } | undefined
    : undefined
  return applied?.value ?? process.env.POISE_REPAIR_EXHAUSTION_REPOSITORIES ?? ''
}

export function repairReportRepositoriesHealth(db: Database): string {
  const configured = repairReportRepositories(db)
  if (Buffer.byteLength(configured) <= MAX_REPAIR_REPORT_REPOSITORIES_BYTES) return configured
  // This invalid value cannot match an accepted allowlist, even when a legacy
  // value starts with the gateway's complete desired configuration.
  return '[oversized]'
}

export function setRepairReportRepositories(db: Database, configured: unknown): void {
  if (typeof configured !== 'string') throw new HttpError(400, 'repairExhaustionRepositories must be a string; empty disables reporting')
  if (Buffer.byteLength(configured) > MAX_REPAIR_REPORT_REPOSITORIES_BYTES) throw new HttpError(400,
    `repairExhaustionRepositories exceeds ${MAX_REPAIR_REPORT_REPOSITORIES_BYTES} bytes; the gateway cannot reconcile a larger health answer`)
  try { repositoryNames(configured) }
  catch { throw new HttpError(400, 'repairExhaustionRepositories requires comma-separated owner/repo names') }
  if (db.pragma('synchronous', { simple: true }) !== 2) db.pragma('synchronous = FULL')
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(REPOSITORIES_KEY, configured)
}

function enabled(db: Database, repository: string): boolean {
  return repositoryNames(repairReportRepositories(db)).some(value => value.toLowerCase() === repository.toLowerCase())
}

// Review reports describe the PR obligation, including when ownership moves
// between the legacy ledger and a chain with a different source issue.
function existingReviewReport(db: Database, repository: string, pull: number) {
  const rows = db.prepare(`SELECT key, value FROM meta WHERE key GLOB ?
    AND json_extract(value, '$.source') GLOB ? AND json_extract(value, '$.pull') = ?
    ORDER BY json_extract(value, '$.issueNumber') IS NULL, key`)
    .all(PREFIX + '*', repository.toLowerCase() + '#*', pull) as Array<{ key: string, value: string }>
  return rows.find(row => {
    const report = JSON.parse(row.value) as RepairReport
    return row.key === PREFIX + report.key && report.key === chainBasis(['review_budget_exhausted', report.source, pull])
  })
}

function reserveReport(db: Database, report: RepairReport): boolean {
  if (db.pragma('synchronous', { simple: true }) !== 2) db.pragma('synchronous = FULL')
  return db.transaction(() => {
    if (report.pull !== null && report.key === chainBasis(['review_budget_exhausted', report.source, report.pull])
      && existingReviewReport(db, report.source.split('#')[0], report.pull)) return false
    return db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run(PREFIX + report.key, JSON.stringify(report)).changes !== 0
  }).immediate()
}

async function createReport(db: Database, repository: string, report: RepairReport, title: string, body: string) {
  const result = await handleGhBody({ operation: 'open_issue', repository_full_name: repository, title, body, labels: ['poise'] })
  const publication = result.body as { record?: { number?: unknown, url?: unknown }, error?: string }
  if (result.status !== 200 || !Number.isSafeInteger(publication.record?.number) || Number(publication.record?.number) < 1
    || publication.record?.url !== `https://github.com/${repository}/issues/${publication.record?.number}`) {
    throw new Error(`Repair report ${report.key} creation is unconfirmed: ${publication.error || 'no verified issue receipt'}; reconcile its marker before any further action`)
  }
  report.issueNumber = Number(publication.record.number)
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(report), PREFIX + report.key)
}

export interface LegacyReviewTimeout {
  repository: string
  pull: number
  author: string
  reviewer: string
  behavior: 'review-new-prs' | 'approve-prs'
  target: string
  head: string
  slot: string
  heldAt: number
  attempts: LogEntry[]
}

/** Evidence and the retained stop are checked by legacy reconciliation, without
 * making a chain or borrowing v2's retry policy. Publication uses the same intent. */
export async function reportLegacyReviewTimeout(db: Database, journal: BehaviorChainJournal, source: LegacyReviewTimeout,
  verify: () => Promise<boolean>, allowed: () => boolean): Promise<string | null> {
  if (!enabled(db, source.repository) || !allowed()) return null
  const linked = existingReviewReport(db, source.repository, source.pull)
  let report = linked ? JSON.parse(linked.value) as RepairReport : null
  const accountsMatch = () => {
    const accounts = getSettings()
    return accounts.me.toLowerCase() === source.author.toLowerCase()
      && accounts.agentAccount.toLowerCase() === source.reviewer.toLowerCase()
  }
  if (!report) {
    if (!accountsMatch() || !await verify()) return null
    const identity = `${source.repository.toLowerCase()}#${source.pull}`
    const key = chainBasis(['review_budget_exhausted', identity, source.pull])
    const marker = `<!-- poise-repair-exhaustion:${key} -->`
    const { stdout } = await runFile('github-interface', ['--read-issue', String(source.pull), '--repository', source.repository,
      '--token-user', source.author], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })
    const original = JSON.parse(stdout) as { repository: string, issue_number: number,
      issue?: { number: number, body: string | null, state: string, html_url: string, pull_request?: unknown } }
    const issue = original.issue
    if (original.repository !== source.repository || original.issue_number !== source.pull || issue?.number !== source.pull
      || !issue.pull_request || issue.html_url !== `https://github.com/${source.repository}/pull/${source.pull}`
      || issue.body !== null && typeof issue.body !== 'string' || !['open', 'closed'].includes(issue.state)) {
      throw new Error('Legacy review report source PR is unavailable')
    }
    if (issue.state !== 'open' || REPORT_MARKER.test(issue.body ?? '')) return null
    const existing = await reconcileRepairReport(source.repository, marker, null)
    // Re-read the native target and stop after all publication discovery reads.
    if (!await verify() || !accountsMatch() || !enabled(db, source.repository) || !allowed()) return null
    // A chain reporter may have reserved the same obligation while we read GitHub.
    const concurrent = existingReviewReport(db, source.repository, source.pull)
    if (concurrent) report = JSON.parse(concurrent.value) as RepairReport
    else {
      report = { key, source: identity, pull: source.pull, holdSequence: null, heldAt: source.heldAt,
        head: source.head, basis: chainBasis([source.behavior, source.target, source.head]), slot: source.slot,
        attempts: source.attempts.map(call => ({ invocation: call.correlation_id!, call: call.id,
          completedAt: Date.parse(call.completed_at!) })), issueNumber: existing?.number ?? null }
      if (!reserveReport(db, report)) return 'Repair exhaustion report pending: another reconciliation reserved this report'
      if (!existing) {
        if (!enabled(db, source.repository) || !allowed()) return 'Repair exhaustion report creation is unconfirmed; admissions are paused'
        const body = [marker, '', `Poise is holding https://github.com/${source.repository}/pull/${source.pull}.`, '',
          `Stage: ${source.behavior}. Cause: review_budget_exhausted. Held since ${new Date(source.heldAt).toISOString()}.`,
          `Retained legacy target: ${source.target}; head ${source.head}; slot ${source.slot}.`,
          `Retry-stop model: ${/^[a-zA-Z0-9_.-]{1,160}$/.test(source.attempts.at(-1)!.model) ? source.attempts.at(-1)!.model : 'unknown'}.`,
          'Retry-stop cause: two qualifying automatic same-head/model review timeouts; automatic retries stopped.',
          'Verified original Caller attempts failed before review submission. Fresh target and activity evidence still verify this hold.', '',
          ...source.attempts.map(call => reviewAttemptLine(call.correlation_id!, call.id, Date.parse(call.completed_at!), call.error_code, call.diagnostic)), '',
          'Next action: inspect the original Calls and timeout diagnostics, address the cause, then explicitly retry the held review when appropriate. This report preserves the source hold and PR; it does not relaunch review or relax publication, review, admission or merge gates.',
          '', REMEDIATION_SCOPE, '', SCOPE_DIRECTIVE].join('\n')
        await createReport(db, source.repository, report, `fix: PR review exhausted its time limits for #${source.pull}`, body)
      }
    }
  }
  return confirmReport(db, journal, source, report, 'Repair exhaustion', allowed)
}

function reviewAttemptLine(invocation: string, call: string, completedAt: number, errorCode: unknown, diagnostic?: ProcessDiagnostic | null) {
  const step = (['operation', 'phase'] as const).map(field => {
    const value = diagnostic?.[field]
    return `${field}=${typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(value) ? value : 'unknown'}`
  }).join('; ')
  const timeout = diagnostic?.context?.timeout_seconds
  return `- Invocation ${invocation}; Caller ${call}; completed ${new Date(completedAt).toISOString()}; error_code=${errorCode}; ${step}; timeout_seconds=${typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : 'unknown'}.`
}

function isReviewTimeoutCode(code: unknown): boolean {
  return code === 'review_budget_exhausted' || code === 'review_inspection_timeout'
}

function isMixedReviewProvider(invocation: { evidence?: unknown }): boolean {
  const evidence = invocation.evidence as { error_code?: unknown, diagnostic?: unknown } | null | undefined
  if (evidence?.error_code !== 'review_provider_exit' && evidence?.error_code !== 'authentication_failed') return false
  const diagnostic = evidence?.diagnostic as { operation?: unknown, phase?: unknown, submission?: unknown,
    context?: { submission?: unknown } | null } | null | undefined
  if (!diagnostic || typeof diagnostic !== 'object') return false
  if (typeof diagnostic.operation !== 'string' || !diagnostic.operation
    || typeof diagnostic.phase !== 'string' || !diagnostic.phase) return false
  const context = diagnostic.context != null && typeof diagnostic.context === 'object'
    ? (diagnostic.context as { submission?: unknown }).submission : undefined
  return (context ?? (diagnostic as { submission?: unknown }).submission) === 'none'
}

function isMixedReviewTimeouts(attempts: Array<{ evidence?: unknown }>): boolean {
  return attempts.length === 3 && attempts.filter(invocation =>
    isReviewTimeoutCode((invocation.evidence as { error_code?: unknown } | null | undefined)?.error_code)).length === 2
    && attempts.filter(isMixedReviewProvider).length === 1
}

/** The normal decision still has to request work on precisely this basis.
 * Ignore failed attempts only to ask what would be needed without exhaustion. */
function qualifyingAttempts(db: Database, chain: BehaviorChain, observation: ChainObservation, now: number) {
  if (!chain.held || chain.mergeSha || !observation.issue.open || !observation.pull
    || !Number.isFinite(observation.checkedAt) || observation.checkedAt > now
    || now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS
    || chain.invocations.some(invocation => invocation.state !== 'settled')) return null
  const decision = decideBehaviorChain({ ...chain, held: null,
    invocations: chain.invocations.filter(invocation => !['repair-pr', 'review-pr'].includes(invocation.behavior) || invocation.evidence?.status === 'completed'),
  }, observation, now)
  if (decision.kind !== 'invoke' || decision.behavior !== 'repair-pr' && decision.behavior !== 'review-pr') return null
  const review = decision.behavior === 'review-pr'
  if (review ? !/^[a-f0-9]{64}$/.test(observation.pull.reviewContext ?? '')
    : !/^[a-f0-9]{64}$/.test(observation.pull.reviewRevision)
      || observation.pull.reviewRevision === chainBasis(['datastore-not-yet-indexed', chain.repository, observation.pull.number])) return null
  const attempts = chain.invocations.filter(invocation => invocation.behavior === decision.behavior
    && invocation.basis === decision.basis && invocation.slot === decision.reviewer?.slot
    && invocation.admissionSequence > chain.resumedAfterSequence && invocation.evidence?.status !== 'deferred')
  const original = chain.invocations.at(-1)
  if (!review && original?.evidence?.error_code === IMPLEMENTATION_CAUSE) {
    const evidence = original.evidence
    const artifact = evidence.artifact as Record<string, unknown> | null | undefined
    const argv = original.request.argv
    const pull = observation.pull
    if (chain.supersession || chain.ciHold || original !== attempts.at(-1) || original.actor !== decision.actor
      || original.request.command !== 'agent-interface' || !/^[a-f0-9]{32}$/.test(original.callId ?? '')
      || original.request.context?.head !== pull.head || original.request.context.reviewRevision !== pull.reviewRevision
      || argv[argv.indexOf('--pull-number') + 1] !== String(pull.number)
      || !argv.includes('--expected-head') || argv[argv.indexOf('--expected-head') + 1] !== pull.head
      || !argv.includes('--expected-issue-revision') || argv[argv.indexOf('--expected-issue-revision') + 1] !== observation.issue.revision
      || pull.state !== 'open' || pull.merged !== false || pull.mergeSha !== null || !/^[a-f0-9]{40}$/i.test(pull.head)
      || observation.publication.pull_number !== pull.number || observation.publication.head_sha !== pull.head
      || observation.publication.state !== 'open' || observation.publication.merged !== false || observation.publication.merge_sha !== null
      || evidence.status !== 'failed' || evidence.action !== 'not_started' || evidence.outcome !== 'preflight_failed'
      || evidence.error !== chain.held || artifact?.phase !== 'executing'
      || [artifact.plan_sha, artifact.publication_head, artifact.replies_started, artifact.publication, artifact.result,
        artifact.receipts, evidence.receipts, evidence.review_id, evidence.head_sha, evidence.publicationPlan,
        evidence.publicationResume, evidence.publicationReceipt, evidence.nativeActionReceipt].some(value => value != null)
      || typeof evidence.completedAt !== 'number' || !Number.isFinite(evidence.completedAt) || evidence.completedAt > now
      || !resourceReleaseProven(evidence, true) || observation.checkedAt < evidence.completedAt
      || observation.checkedAt < Date.parse(String(evidence.resources_settled_at))) return null
    const hold = db.prepare(`SELECT sequence, at, json_extract(payload, '$.reason') AS reason FROM behavior_chain_events
      WHERE chain_id = ? AND json_extract(payload, '$.type') = 'chain.held' AND sequence > ? ORDER BY sequence DESC LIMIT 1`)
      .get(chain.id, chain.resumedAfterSequence) as { sequence: number, at: number, reason: string } | undefined
    return hold && hold.sequence > original.admissionSequence && hold.reason === evidence.error && hold.at <= now
      ? { decision, attempts: [original], cause: IMPLEMENTATION_CAUSE } : null
  }
  if (attempts.length < 3 || attempts.some(invocation => {
    const evidence = invocation.evidence
    const artifact = evidence?.artifact as Record<string, unknown> | null | undefined
    const argv = invocation.request.argv
    return !invocation.callId || invocation.state !== 'settled' || invocation.actor !== decision.actor
      || (review ? !argv.includes('--expected-head') || argv[argv.indexOf('--expected-head') + 1] !== observation.pull!.head
        : invocation.request.context?.head !== observation.pull!.head
          || invocation.request.context.reviewRevision !== observation.pull!.reviewRevision
          || !argv.includes('--expected-issue-revision') || argv[argv.indexOf('--expected-issue-revision') + 1] !== observation.issue.revision)
      || evidence?.status !== 'failed' || evidence.action !== 'not_started' || evidence.outcome !== 'preflight_failed'
      || (review ? artifact?.phase !== 'reviewing' : artifact != null && !['preparing', 'prepared', 'executing'].includes(String(artifact.phase)))
      || artifact != null && (artifact.plan_sha != null || artifact.publication_head != null || artifact.replies_started != null)
      || evidence.receipts != null || evidence.review_id != null || evidence.head_sha != null
      || typeof evidence.completedAt !== 'number' || !Number.isFinite(evidence.completedAt) || evidence.completedAt > now
      || !resourceReleaseProven(evidence, true)
  })) return null
  // Keep the existing review report identity across both pre-submission timeouts.
  const mixedReview = review && isMixedReviewTimeouts(attempts)
    && chain.held === `review-pr failed before publication three times: ${String(attempts.at(-1)?.evidence?.error || 'native failure')}`
  const cause = review ? attempts.every(invocation => isReviewTimeoutCode(invocation.evidence?.error_code)) || mixedReview
    ? 'review_budget_exhausted' : null
    : attempts.every(invocation => invocation.evidence?.error_code === 'atomic_work_execution_budget_exhausted')
    ? 'repair_execution_budget_exhausted'
    : attempts.every(invocation => invocation.evidence?.error_code === 'atomic_work_failed'
      && typeof invocation.evidence.error === 'string' && INCOMPLETE_REPLIES.test(invocation.evidence.error))
      ? 'repair_incomplete_replies' : null
  return cause ? { decision, attempts, cause } : null
}

function qualifyingMergeSubmission(chain: BehaviorChain, observation: ChainObservation, now: number) {
  const invocation = chain.invocations.find(invocation => invocation.state !== 'settled')
  const evidence = invocation?.evidence
  const argv = invocation?.request.argv ?? []
  const call = invocation?.callId ?? evidence?.nativeCallId
  const pull = observation.pull
  if (!invocation || invocation.behavior !== 'merge-pr' || invocation.state !== 'uncertain'
    || invocation.request.command !== 'github-interface' || argv[0] !== '--merge-if-ready'
    || invocation.actor !== chain.reviewer || typeof call !== 'string' || !/^[a-f0-9]{32}$/.test(call)
    || evidence?.status !== 'failed' || evidence.action === 'not_started' || evidence.nativeActionReceipt
    || typeof evidence.completedAt !== 'number' || !Number.isFinite(evidence.completedAt) || evidence.completedAt > now
    || !resourceReleaseProven(evidence, true) || chain.mergeSha || observation.issue.open !== true
    || !Number.isFinite(observation.checkedAt) || observation.checkedAt > now || observation.checkedAt < evidence.completedAt
    || observation.checkedAt < Date.parse(String(evidence.resources_settled_at))
    || now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS
    || !pull || pull.state !== 'open' || pull.merged !== false || pull.mergeSha !== null || pull.queueEntry !== null
    || pull.number !== Number(argv[1]?.replace(/^#/, '')) || argv.filter(arg => arg === '--expected-head').length !== 1
    || !/^[a-f0-9]{40}$/i.test(pull.head) || pull.head !== argv[argv.indexOf('--expected-head') + 1]) return null
  return { invocation, call }
}

function qualifyingClosedPull(chain: BehaviorChain, observation: ChainObservation, now: number): boolean {
  return !!chain.held && !chain.mergeSha && !chain.supersession && observation.issue.open === true
    && Number.isFinite(observation.checkedAt) && observation.checkedAt <= now
    && now - observation.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS
    && observation.pull?.state === 'closed' && observation.pull.merged === false && observation.pull.mergeSha === null
    && observation.publication.pull_number === observation.pull.number && observation.publication.merged === false
    && observation.existingPulls.length === 0
    // A receipt-store failure settles without a Call or resources and holds no
    // reservation; it must not permanently fence a later continuation. Real
    // pending or unproven Call resources still block, mirroring supersession.
    && chain.invocations.every(invocation => invocation.state === 'settled' && !nativeResourcesPending({ ...invocation })
      && (invocation.model === null || invocation.callId === null || resourceReleaseProven(invocation.evidence ?? {}, true)))
}

/** Only an explicit work-continuation relationship can cover the closed PR.
 * Ordinary references (for example to an original-outcome investigation) cannot. */
async function closedPullSuccessor(chain: BehaviorChain, pull: number): Promise<string | null> {
  const read = async (operation: '--read-issue' | '--issue-comments', number: number) => {
    const { stdout } = await runFile('github-interface', [operation, String(number), '--repository', chain.repository,
      '--token-user', chain.author], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })
    const result = JSON.parse(stdout) as { repository: string, issue_number: number,
      issue?: { number: number, html_url: string, body: string | null, state: string, labels: Array<{ name: string }>, pull_request?: unknown },
      comments?: Array<{ author: string, body: string }> }
    if (result.repository?.toLowerCase() !== chain.repository.toLowerCase() || result.issue_number !== number) {
      throw new Error('Closed PR continuation evidence belongs to another target')
    }
    return result
  }
  const [seed, prior, comments, pullComments] = await Promise.all([
    read('--read-issue', chain.issue), read('--read-issue', pull),
    read('--issue-comments', chain.issue), read('--issue-comments', pull),
  ])
  const valid = (issue: NonNullable<typeof seed.issue>, number: number, pr = false) => issue.number === number
    && issue.html_url?.toLowerCase() === `https://github.com/${chain.repository}/${pr ? 'pull' : 'issues'}/${number}`.toLowerCase()
    && (issue.body === null || typeof issue.body === 'string') && ['open', 'closed'].includes(issue.state)
    && Array.isArray(issue.labels) && issue.labels.every(label => typeof label.name === 'string')
  if (!seed.issue || !valid(seed.issue, chain.issue) || seed.issue.pull_request
    || !prior.issue || !valid(prior.issue, pull, true) || !prior.issue.pull_request
    || !Array.isArray(comments.comments) || !Array.isArray(pullComments.comments)
    || [...comments.comments, ...pullComments.comments].some(comment => typeof comment.body !== 'string' || typeof comment.author !== 'string')) {
    throw new Error('Closed PR continuation evidence is incomplete')
  }
  if (seed.issue.state !== 'open' || prior.issue.state !== 'closed' || !seed.issue.labels.some(label => label.name.toLowerCase() === 'poise')) {
    return 'Closed PR continuation pending: the source is no longer an open poise issue'
  }
  if (REPORT_MARKER.test(seed.issue.body ?? '')) return 'Closed PR continuation suppressed for a generated remediation issue'
  const text = [seed.issue.body, prior.issue.body, ...[...comments.comments, ...pullComments.comments]
    .filter(comment => [chain.author.toLowerCase(), chain.reviewer.toLowerCase()].includes(comment.author.toLowerCase()))
    .map(comment => comment.body)].join('\n')
  const references = (body: string) => [...body.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9][0-9]*)\b|(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g)]
    .map(match => `${(match[1] ?? match[3] ?? chain.repository).toLowerCase()}#${match[2] ?? match[4]}`)
  const successors = new Set<string>()
  for (const match of text.matchAll(/\b(?:Continuation(?: issue)?\s*:|Replacement issue\s*:|Continued in\b\s*:?|Work (?:moved|continued) to\b\s*:?|Superseded by\b\s*:?)[^\S\n]*([^\n]+?)(?=\b(?:Continuation(?: issue)?\s*:|Replacement issue\s*:|Continued in\b|Work (?:moved|continued) to\b|Superseded by\b)|\n|$)/gi)) {
    // A reference back to the source or its closed PR is ordinary prose, not a successor.
    const targets = [...new Set(references(match[1].split(/(?<=[.!?])\s/)[0]))]
      .filter(target => target !== chain.id.toLowerCase() && target !== `${chain.repository.toLowerCase()}#${pull}`)
    if (!targets.length) continue
    if (targets.length !== 1) throw new Error('Closed PR continuation relationship is ambiguous')
    successors.add(targets[0])
  }
  if (!successors.size) return null
  const target = [...successors][0]
  const [repository, number] = target.split('#')
  if (successors.size !== 1 || repository !== chain.repository.toLowerCase() || Number(number) === chain.issue) {
    throw new Error('Closed PR continuation relationship is ambiguous or outside the source repository')
  }
  const successor = (await read('--read-issue', Number(number))).issue
  if (!successor || !valid(successor, Number(number)) || successor.pull_request
    || !references(successor.body ?? '').includes(chain.id)
    || !references(successor.body ?? '').includes(`${chain.repository.toLowerCase()}#${pull}`)) {
    throw new Error(`Closed PR continuation ${target} does not verify coverage of the source issue and closed PR`)
  }
  const link = `Closed PR continuation https://github.com/${chain.repository}/issues/${number}`
  return successor.state === 'open' && successor.labels.some(label => label.name.toLowerCase() === 'poise')
    ? `${link}: already tracks the source issue and closed PR; ordinary intake and ownership gates apply`
    : `${link}: pending verification of an open poise successor; no replacement will be created`
}

function qualifyingImplementationHold(db: Database, chain: BehaviorChain, observation: ChainObservation, now: number) {
  const invocation = chain.invocations.at(-1)
  const evidence = invocation?.evidence
  const artifact = evidence?.artifact as Record<string, unknown> | null | undefined
  const publication = observation.publication
  if (!chain.held || chain.mergeSha || chain.supersession || observation.issue.open !== true || observation.pull !== null
    || publication.pull_number !== null || publication.head_sha !== null || publication.head_invocation !== null
    || publication.state !== null || publication.merged !== false || publication.merge_sha !== null || observation.existingPulls.length
    || !invocation || invocation.behavior !== 'implement-issue' || invocation.actor !== chain.author
    || invocation.request.command !== 'agent-interface' || invocation.admissionSequence <= chain.resumedAfterSequence
    || chain.invocations.some(attempt => attempt.state !== 'settled')
    || !invocation.callId || !/^[a-f0-9]{32}$/.test(invocation.callId)
    || evidence?.status !== 'failed' || evidence.action !== 'not_started' || evidence.outcome !== 'preflight_failed'
    || evidence.error_code !== IMPLEMENTATION_CAUSE || evidence.error !== chain.held
    || artifact?.phase !== 'executing'
    || [artifact.plan_sha, artifact.publication_head, artifact.replies_started, artifact.publication, artifact.result,
      artifact.receipts, evidence.receipts, evidence.review_id, evidence.head_sha, evidence.publicationPlan,
      evidence.publicationResume, evidence.publicationReceipt, evidence.nativeActionReceipt].some(value => value != null)
    || typeof evidence.completedAt !== 'number' || !Number.isFinite(evidence.completedAt) || evidence.completedAt > now
    || !resourceReleaseProven(evidence, true)
    || !Number.isFinite(observation.checkedAt) || observation.checkedAt > now || observation.checkedAt < evidence.completedAt
    || observation.checkedAt < Date.parse(String(evidence.resources_settled_at))
    || now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS) return null
  // Reconciliation records the automatic hold with the original Caller error.
  // The person's later Hold replaces it and cannot report that older receipt.
  const hold = db.prepare(`SELECT sequence, at, json_extract(payload, '$.reason') AS reason FROM behavior_chain_events
    WHERE chain_id = ? AND json_extract(payload, '$.type') = 'chain.held' AND sequence > ? ORDER BY sequence DESC LIMIT 1`)
    .get(chain.id, chain.resumedAfterSequence) as { sequence: number, at: number, reason: string } | undefined
  return hold && hold.sequence > invocation.admissionSequence && hold.reason === evidence.error && hold.at <= now
    ? { invocation, call: invocation.callId, hold } : null
}

function implementationReport(db: Database, chain: BehaviorChain): RepairReport | null {
  const rows = db.prepare(`SELECT key, value FROM meta WHERE key GLOB ?
    AND json_extract(value, '$.source') GLOB ? AND json_extract(value, '$.issueNumber') = ?`)
    .all(PREFIX + '*', chain.repository.toLowerCase() + '#*', chain.issue) as Array<{ key: string, value: string }>
  const reports = rows.filter(row => {
    const report = JSON.parse(row.value) as RepairReport
    const key = chainBasis([IMPLEMENTATION_CAUSE, report.source])
    if (row.key === PREFIX + key && report.key !== key) throw new Error('Implementation report conflicts with its durable source intent')
    return row.key === PREFIX + report.key && report.key === key
  }).map(row => JSON.parse(row.value) as RepairReport)
  if (reports.length > 1) throw new Error('Implementation report has conflicting source intents')
  return reports[0] ?? null
}

export function implementationReportBinding(db: Database, chain: BehaviorChain) {
  const report = implementationReport(db, chain)
  return report ? { key: report.key, source: report.source, holdSequence: report.holdSequence,
    invocation: report.attempts[0]?.invocation, call: report.attempts[0]?.call,
    revision: (chain.observation as ChainObservation | null)?.issue.revision ?? null,
    disposition: report.disposition ?? null } : null
}

function unconfirmedImplementationReports(db: Database, repository: string): RepairReport[] {
  const rows = db.prepare(`SELECT key, value FROM meta WHERE key GLOB ?
    AND json_extract(value, '$.source') GLOB ? AND json_extract(value, '$.issueNumber') IS NULL`)
    .all(PREFIX + '*', repository.toLowerCase() + '#*') as Array<{ key: string, value: string }>
  return rows.flatMap(row => {
    const report = JSON.parse(row.value) as RepairReport
    const key = chainBasis([IMPLEMENTATION_CAUSE, report.source])
    if (row.key === PREFIX + key && report.key !== key) throw new Error('Implementation report conflicts with its durable source intent')
    return row.key === PREFIX + report.key && report.key === key ? [report] : []
  })
}

function boundImplementationSource(db: Database, journal: BehaviorChainJournal, chain: BehaviorChain, report: RepairReport) {
  const source = journal.read(report.source), attempt = report.attempts[0]
  const invocation = source?.invocations.at(-1)
  const hold = db.prepare(`SELECT sequence FROM behavior_chain_events WHERE chain_id = ?
    AND json_extract(payload, '$.type') = 'chain.held' ORDER BY sequence DESC LIMIT 1`)
    .get(report.source) as { sequence: number } | undefined
  const accounts = getSettings()
  if (!source || report.pull !== null || report.head !== null || report.attempts.length !== 1
    || !hold || hold.sequence !== report.holdSequence || source.resumedAfterSequence >= hold.sequence
    || !source.held || source.mergeSha || source.supersession || !invocation || invocation.id !== attempt.invocation
    || invocation.callId !== attempt.call || invocation.basis !== report.basis || invocation.slot !== report.slot
    || invocation.evidence?.error !== source.held || source.invocations.some(item => item.state !== 'settled')
    || source.author.toLowerCase() !== chain.author.toLowerCase() || source.reviewer.toLowerCase() !== chain.reviewer.toLowerCase()
    || accounts.me.toLowerCase() !== source.author.toLowerCase() || accounts.agentAccount.toLowerCase() !== source.reviewer.toLowerCase()) return null
  return source
}

function dispositionReview(chain: BehaviorChain, observation: ChainObservation, disposition: NonNullable<RepairReport['disposition']>) {
  return disposition.revision === observation.issue.revision && chain.invocations.some(invocation =>
    invocation.id === disposition.review && invocation.behavior === 'review-issue' && invocation.state === 'settled'
    && invocation.actor.toLowerCase() === chain.reviewer.toLowerCase() && !!invocation.callId
    && invocation.basis === chainBasis(['issue', disposition.revision])
    && invocation.evidence?.status === 'completed' && invocation.evidence.action === 'commented'
    && invocation.evidence.issue_revision === disposition.revision && Array.isArray(invocation.evidence.receipts)
    && invocation.evidence.receipts.some((receipt: { issue?: string, author?: string, comment_id?: number }) =>
      receipt?.issue?.toLowerCase() === chain.id.toLowerCase() && receipt.author?.toLowerCase() === chain.reviewer.toLowerCase()
      && receipt.comment_id === disposition.commentId && observation.issue.commentIds.includes(receipt.comment_id)))
}

async function verifiedImplementationReport(chain: BehaviorChain, report: RepairReport, revision: string) {
  const issue = await reconcileRepairReport(chain.repository, `<!-- poise-repair-exhaustion:${report.key} -->`, report.issueNumber)
  return issue?.state === 'open' && typeof issue.title === 'string' && chainBasis([issue.title, issue.body]) === revision
}

function dispositionReason(chain: BehaviorChain, report: RepairReport) {
  const disposition = report.disposition!
  return `Implementation hold report https://github.com/${chain.repository}/issues/${report.issueNumber}: ${disposition.kind} disposition for ${report.source}, reviewed revision ${disposition.revision}; original Call ${report.attempts[0].call}. Diagnosis: ${disposition.diagnosis} Next action: ${disposition.nextAction} Source hold retained; checkout availability is unverified. Any source retry requires existing recovery or explicit Resume.`
}

/** Explicit owner triage, using the existing guarded chain control. Comment
 * prose, labels and closure never supply this authority. */
export async function setImplementationReportDisposition(db: Database, journal: BehaviorChainJournal, chain: BehaviorChain,
  sequence: number, binding: unknown, value: unknown): Promise<void> {
  if (chain.sequence !== sequence) throw new HttpError(409, 'Report chain changed before disposition')
  const report = implementationReport(db, chain)
  if (!report || chainBasis(binding) !== chainBasis(implementationReportBinding(db, chain))) throw new HttpError(409, 'Implementation report binding is missing or stale')
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'source-only' && value.kind !== 'distinct-fix'
    || !('review' in value) || typeof value.review !== 'string' || !('commentId' in value) || !Number.isSafeInteger(value.commentId)
    || !('diagnosis' in value) || typeof value.diagnosis !== 'string' || !value.diagnosis.trim() || value.diagnosis.length > 2000
    || !('nextAction' in value) || typeof value.nextAction !== 'string' || !value.nextAction.trim() || value.nextAction.length > 2000) {
    throw new HttpError(400, 'Disposition requires source-only/distinct-fix, native review and commentId, diagnosis and nextAction')
  }
  const observation = chain.observation as ChainObservation | null
  const disposition: NonNullable<RepairReport['disposition']> = { kind: value.kind,
    revision: observation?.issue.revision ?? '', review: value.review, commentId: Number(value.commentId),
    diagnosis: behaviorErrorMessage(value.diagnosis, 2000), nextAction: behaviorErrorMessage(value.nextAction, 2000) }
  if (!observation || observation.pull || observation.publication.head_sha || observation.existingPulls.length
    || chain.invocations.some(invocation => invocation.state !== 'settled') || !dispositionReview(chain, observation, disposition)
    || !await verifiedImplementationReport(chain, report, disposition.revision)) throw new HttpError(409, 'Disposition lacks its current authenticated report review')
  db.transaction(() => {
    const current = journal.read(chain.id)
    if (current?.sequence !== sequence || chainBasis(implementationReport(db, chain)) !== chainBasis(report)) throw new HttpError(409, 'Report changed during disposition verification')
    const source = boundImplementationSource(db, journal, chain, report)
    if (!source) throw new HttpError(409, 'Original implementation hold or Call changed before disposition')
    report.disposition = disposition
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(report), PREFIX + report.key)
    journal.append(source.id, `report-disposition:${chain.id}:${sequence}`, source.sequence,
      { type: 'chain.waiting', reason: dispositionReason(chain, report) })
    journal.append(chain.id, `report-disposition:${sequence}`, sequence,
      { type: 'chain.waiting', reason: dispositionReason(chain, report) })
  }).immediate()
}

/** Runs at implementation admission even when new report publishing is off. */
export async function implementationReportAdmission(db: Database, journal: BehaviorChainJournal, chain: BehaviorChain,
  observation: ChainObservation, observe: (source: BehaviorChain) => Promise<ChainObservation>) {
  const wait = 'Implementation hold report awaits a current explicit source-only or verified distinct-fix disposition'
  let report = implementationReport(db, chain)
  if (!report) {
    // A lost creation acknowledgement leaves the stored intent without its
    // issue number while GitHub already serves the report to intake. Match
    // such intents against this chain before allowing implementation.
    for (const candidate of unconfirmedImplementationReports(db, chain.repository)) {
      let issue
      try {
        issue = await reconcileRepairReport(chain.repository, `<!-- poise-repair-exhaustion:${candidate.key} -->`, chain.issue)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('identity differs')) continue
        return { reason: `${wait}: verification unavailable: ${behaviorErrorMessage(message, 500)}` }
      }
      if (issue?.number === chain.issue) {
        candidate.issueNumber = chain.issue
        db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(candidate), PREFIX + candidate.key)
        report = candidate
        break
      }
    }
    if (!report) return { reason: null }
  }
  const disposition = report.disposition
  if (!disposition || !['source-only', 'distinct-fix'].includes(disposition.kind)
    || !dispositionReview(chain, observation, disposition)) return { reason: wait }
  const source = boundImplementationSource(db, journal, chain, report)
  if (!source) return { reason: `${wait}: original source hold or Call changed` }
  let fresh: ChainObservation
  try {
    fresh = await observe(source)
    if (!await verifiedImplementationReport(chain, report, observation.issue.revision)) return { reason: `${wait}: reviewed report changed` }
  } catch (error) {
    return { reason: `${wait}: verification unavailable: ${behaviorErrorMessage(error instanceof Error ? error.message : String(error), 500)}` }
  }
  if (!fresh.issue.eligible || report.basis !== chainBasis(['issue', fresh.issue.revision])
    || journal.read(source.id)?.sequence !== source.sequence
    || chainBasis(implementationReport(db, chain)) !== chainBasis(report)
    || !qualifyingImplementationHold(db, source, fresh, Date.now())) return { reason: `${wait}: source or reviewed report evidence changed` }
  if (disposition.kind === 'source-only') return { reason: dispositionReason(chain, report) }
  return { reason: null, source: { id: source.id, sequence: source.sequence } }
}

function qualifyingImplementationPublication(chain: BehaviorChain, observation: ChainObservation, now: number) {
  const invocation = chain.invocations.find(invocation => invocation.state !== 'settled')
  const evidence = invocation?.evidence
  const artifact = evidence?.artifact as Record<string, unknown> | null | undefined
  const publication = observation.publication
  const call = evidence?.callId
  if (!invocation || invocation.behavior !== 'implement-issue' || invocation.state !== 'uncertain'
    || invocation.actor !== chain.author || invocation.request.command !== 'agent-interface'
    || typeof call !== 'string' || !/^[a-f0-9]{32}$/.test(call)
    || evidence?.status !== 'failed' || evidence.action != null || evidence.outcome != null || evidence.head_sha != null
    || artifact?.phase !== 'publishing' || artifact.result != null || evidence.receipts != null
    || evidence.publicationResume != null || evidence.publicationReceipt != null
    || typeof evidence.completedAt !== 'number' || !Number.isFinite(evidence.completedAt) || evidence.completedAt > now
    || !resourceReleaseProven(evidence, true) || chain.mergeSha || chain.supersession || observation.issue.open !== true
    || observation.pull !== null || publication.pull_number !== null || publication.head_sha !== null
    || publication.head_invocation !== null || publication.state !== null || publication.merged !== false
    || publication.merge_sha !== null || observation.existingPulls.length
    || !Number.isFinite(observation.checkedAt) || observation.checkedAt > now || observation.checkedAt < evidence.completedAt
    || observation.checkedAt < Date.parse(String(evidence.resources_settled_at))
    || now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS) return null
  return { invocation, call }
}

function repairExhaustionReports(db: Database, chain: BehaviorChain, reportIssue = false): RepairReport[] {
  const rows = db.prepare(`SELECT key, value FROM meta WHERE key GLOB ? AND ${reportIssue
    ? "json_extract(value, '$.source') GLOB ? AND json_extract(value, '$.issueNumber') = ?"
    : "json_extract(value, '$.source') = ?"}`)
    .all(PREFIX + '*', reportIssue ? chain.repository.toLowerCase() + '#*' : chain.id,
      ...(reportIssue ? [chain.issue] : [])) as Array<{ key: string, value: string }>
  return rows.flatMap(row => {
    const report = JSON.parse(row.value) as RepairReport
    if (!['repair_incomplete_replies', 'repair_execution_budget_exhausted']
      .some(cause => report.key === chainBasis([cause, report.source, report.pull]))) return []
    if (report.issueNumber === null) return []
    if (row.key !== PREFIX + report.key || !Number.isSafeInteger(report.issueNumber) || Number(report.issueNumber) < 1
      || !Number.isSafeInteger(report.holdSequence) || Number(report.holdSequence) < 1
      || !Number.isSafeInteger(report.pull) || Number(report.pull) < 1 || !/^[a-f0-9]{40}$/.test(report.head ?? '')
      || !/^[a-f0-9]{64}$/.test(report.basis) || !report.slot || !Array.isArray(report.attempts)) {
      throw new Error('Repair exhaustion recovery lacks its saved source hold')
    }
    return [report]
  })
}

/** A saved exhaustion report is diagnostic work, never a replacement owner for
 * the source PR. This also fences an already-admitted ordinary implementation. */
export function repairReportImplementationFence(db: Database, chain: BehaviorChain, behavior: ChainBehavior): string | null {
  if (!['implement-issue', 'publish-issue'].includes(behavior)) return null
  const reports = repairExhaustionReports(db, chain, true)
  return reports.length ? `Repair exhaustion report routes diagnosis to its source repair owner ${reports.map(report => report.source).join(', ')}; ordinary report implementation is fenced` : null
}

/** Reuse the original repair owner and journal admission. A blocked diagnostic
 * Call proves provenance and no publication, not that its proposed fix is right;
 * the exact-head repair must validate it through the normal publication gates. */
export async function recoverReportedRepair(db: Database, journal: BehaviorChainJournal, chain: BehaviorChain,
  observation: ChainObservation, verify: (target: BehaviorChain) => Promise<ChainObservation>,
  allowed: () => boolean): Promise<string | null> {
  const fence = repairReportImplementationFence(db, chain, 'implement-issue')
  if (fence) {
    // Pending review work and started work must still settle through the
    // runtime's receipt-only recovery; only unstarted ordinary implementation stays fenced.
    if (chain.invocations.some(invocation => invocation.state !== 'settled'
      && (invocation.state !== 'admitted' || invocation.behavior === 'review-issue'))) return null
    const decision = decideBehaviorChain(chain, observation, Date.now())
    return decision.kind === 'invoke' && decision.behavior === 'review-issue' ? null : fence
  }
  // A merged source has no recovery to pend; ordinary merged-review
  // reconciliation owns the chain from here.
  if (chain.mergeSha || observation.pull?.merged) return null
  if (chain.repairRecovery?.admission || !chain.held && !chain.repairRecovery) return null
  const reports = repairExhaustionReports(db, chain)
  if (!reports.length) return null
  const pending = (reason: string) => `Repair report recovery pending: ${reason}; inspect the report and source Calls before explicitly resuming`
  if (!enabled(db, chain.repository) || !allowed()) return pending('recovery admissions are disabled')
  const accounts = getSettings()
  if (accounts.me.toLowerCase() !== chain.author.toLowerCase() || accounts.agentAccount.toLowerCase() !== chain.reviewer.toLowerCase()) {
    return pending('configured accounts differ from the original repair owner')
  }
  const hold = db.prepare(`SELECT sequence, at, json_extract(payload, '$.reason') AS reason FROM behavior_chain_events
    WHERE chain_id = ? AND json_extract(payload, '$.type') = 'chain.held' ORDER BY sequence DESC LIMIT 1`)
    .get(chain.id) as { sequence: number, at: number, reason: string } | undefined
  const matching = reports.filter(report => report.holdSequence === hold?.sequence && report.heldAt === hold.at
    && report.head === observation.pull?.head && (!chain.repairRecovery || report.key === chain.repairRecovery.key))
  if (matching.length !== 1) return pending('the saved automatic hold, source head or unique report no longer matches')
  const report = matching[0], last = chain.invocations.at(-1)
  if (chain.mergeSha || chain.supersession || chain.ciHold || !last || last.behavior !== 'repair-pr'
    || hold!.reason !== `repair-pr failed before publication three times: ${String(last.evidence?.error || 'native failure')}`
    || chain.held !== null && chain.held !== hold!.reason
    || chain.held === null && !chain.repairRecovery) return pending('the original automatic repair hold was replaced')
  const reportChain = journal.read(chainIdentity(chain.repository, report.issueNumber!))
  if (!reportChain || reportChain.author !== chain.author || reportChain.reviewer !== chain.reviewer) {
    return pending(`report #${report.issueNumber} has no unambiguous diagnostic owner`)
  }
  const freshReport = await verify(reportChain)
  if (!freshReport.issue.open || !freshReport.issue.eligible || freshReport.pull || freshReport.existingPulls.length
    || freshReport.publication.pull_number !== null || freshReport.publication.head_sha !== null
    || freshReport.publication.head_invocation !== null || freshReport.publication.state !== null
    || freshReport.publication.merged || freshReport.publication.merge_sha !== null
    || reportChain.mergeSha || reportChain.supersession || reportChain.invocations.some(invocation => invocation.state !== 'settled'
      || invocation.callId !== null && !resourceReleaseProven(invocation.evidence ?? {}, true))) {
    return pending(`report #${report.issueNumber} still owns work, publication or unsettled resources`)
  }
  const diagnosis = qualifyingImplementationHold(db, reportChain, freshReport, Date.now())
  const evidence = diagnosis?.invocation.evidence
  const artifact = evidence?.artifact as { prepared?: Record<string, unknown> } | undefined
  const prepared = artifact?.prepared
  const diagnostic = evidence?.diagnostic as ProcessDiagnostic | undefined
  const implementations = reportChain.invocations.filter(invocation => invocation.behavior === 'implement-issue' || invocation.behavior === 'publish-issue')
  if (implementations.length && (implementations.length !== 1 || !diagnosis || !prepared
    || prepared.repository !== chain.repository || prepared.issue_number !== report.issueNumber
    || prepared.actor !== chain.author || prepared.branch !== reportChain.branch || prepared.pull_number !== null || prepared.head_sha !== null
    || diagnosis.invocation.request.argv[diagnosis.invocation.request.argv.indexOf('--expected-issue-revision') + 1] !== freshReport.issue.revision
    || diagnostic?.operation !== 'provider.atomic_work' || diagnostic.outcome !== 'blocked'
    || diagnostic.context.submission !== 'none' || diagnostic.stderr_truncated !== false)
    || !implementations.length && reportChain.held) return pending(`report #${report.issueNumber} lacks its original no-publication diagnosis receipt or has a later hold`)
  const issue = await reconcileRepairReport(chain.repository, `<!-- poise-repair-exhaustion:${report.key} -->`, report.issueNumber)
  if (!issue || issue.state !== 'open') return pending(`report #${report.issueNumber} is not verified open`)
  const { stdout } = await runFile('github-interface', ['--issue-comments', String(report.issueNumber), '--repository', chain.repository,
    '--token-user', chain.author], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })
  const result = JSON.parse(stdout) as { repository: string, issue_number: number, comments: Array<{ id: number, author: string, body: string }> }
  if (result.repository?.toLowerCase() !== chain.repository.toLowerCase() || result.issue_number !== report.issueNumber
    || !Array.isArray(result.comments) || result.comments.some(comment => !Number.isSafeInteger(comment.id) || comment.id < 1
      || typeof comment.author !== 'string' || typeof comment.body !== 'string')) throw new Error('Repair report diagnosis comments are incomplete')
  const comments = result.comments.filter(comment => [chain.author.toLowerCase(), chain.reviewer.toLowerCase()].includes(comment.author.toLowerCase()))
  // Review alone is insufficient: the original comment must name this exact
  // source PR/head and a concrete code site. The repair validates the diagnosis.
  const repository = chain.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const actionable = (text: unknown): text is string => typeof text === 'string' && text.includes(report.head!)
    && (new RegExp(`https://github\\.com/${repository}/pull/${report.pull}(?!\\d)`).test(text) || new RegExp(`\\bPR #${report.pull}\\b`, 'i').test(text))
    && /\b[\w.-]+(?:\/[\w.-]+)*\.[\w]+:\d+\b/.test(text)
  const reviewed = !implementations.length ? reportChain.invocations.flatMap(invocation => {
    const evidence = invocation.evidence
    const receipts = evidence?.receipts as Array<{ issue: string, comment_id: number, author: string }> | undefined
    if (invocation.behavior !== 'review-issue' || !invocation.callId || invocation.actor !== chain.reviewer
      || evidence?.status !== 'completed' || evidence.action !== 'commented' || evidence.issue_revision !== freshReport.issue.revision
      || !Array.isArray(receipts)) return []
    return comments.filter(comment => comment.author.toLowerCase() === chain.reviewer.toLowerCase()
      && freshReport.issue.commentIds.includes(comment.id) && actionable(comment.body)
      && comment.body.includes(`<!-- agent-interface issue-review call=${invocation.callId} -->`)
      && receipts.some(receipt => receipt && typeof receipt.issue === 'string' && receipt.issue.toLowerCase() === reportChain.id
        && receipt.comment_id === comment.id && typeof receipt.author === 'string' && receipt.author.toLowerCase() === chain.reviewer.toLowerCase()))
      .map(comment => ({ call: invocation.callId!, text: comment.body }))
  }) : []
  const text = implementations.length ? diagnostic?.stderr : reviewed[0]?.text
  const call = implementations.length ? diagnosis?.call : reviewed[0]?.call
  if (!call || !actionable(text)) return pending(`report #${report.issueNumber} lacks an actionable diagnosis pinned to the source PR/head`)
  const digest = chainBasis([report.key, reportChain.id, call, prepared ?? null,
    diagnostic ?? null, text, freshReport.issue.revision, comments])
  if (chain.repairRecovery && chain.repairRecovery.diagnosis !== digest) return pending(`report #${report.issueNumber} diagnosis changed after recovery preparation`)
  const note = [`Repair-exhaustion diagnosis from ${issue.url}; original diagnostic Call ${call}.`,
    `Keep source ${chain.id}, branch ${chain.branch}, PR #${report.pull}, head ${report.head} and repair basis ${report.basis}.`,
    'Original repair Calls prove no publication; diagnostic work and resources are settled. Verify the worker-reported diagnosis on the source PR through normal validation, publication, review and CI.',
    text, ...comments.map(comment => `Report comment ${comment.id} (${comment.author}):\n${comment.body}`)].join('\n\n')
  if (Buffer.byteLength(note) > 32 * 1024) return pending('the complete diagnosis exceeds the bounded repair note')
  const fresh = await verify(chain)
  const qualifying = qualifyingAttempts(db, { ...chain, held: hold!.reason, repairRecovery: undefined }, fresh, Date.now())
  const owners = db.prepare(`SELECT chain_id FROM behavior_chain_current WHERE chain_id != ?
    AND lower(json_extract(state, '$.repository')) = ? AND
    (json_extract(state, '$.observation.pull.number') = ? OR json_extract(state, '$.observation.publication.pull_number') = ?)`)
    .all(chain.id, chain.repository.toLowerCase(), report.pull, report.pull)
  if (!qualifying || !['repair_incomplete_replies', 'repair_execution_budget_exhausted'].includes(qualifying.cause)
    || report.key !== chainBasis([qualifying.cause, chain.id, report.pull]) || qualifying.decision.basis !== report.basis
    || qualifying.decision.reviewer?.slot !== report.slot || fresh.pull?.head !== report.head
    || fresh.pull.state !== 'open' || fresh.pull.merged || fresh.pull.queueEntry || fresh.existingPulls.length
    || fresh.publication.pull_number !== report.pull || fresh.publication.head_sha !== report.head
    || fresh.publication.state !== 'open' || fresh.publication.merged || fresh.publication.merge_sha !== null
    || chainBasis(report.attempts) !== chainBasis(qualifying.attempts.map(invocation => ({ invocation: invocation.id,
      call: invocation.callId, completedAt: invocation.evidence!.completedAt })))
    || qualifying.attempts.some(invocation => {
      const evidence = invocation.evidence!, artifact = evidence.artifact as Record<string, unknown> | null
      return [artifact?.publication, artifact?.result, artifact?.receipts, evidence.publicationPlan, evidence.publicationResume,
        evidence.publicationReceipt, evidence.nativeActionReceipt].some(value => value != null)
    }) || owners.length) return pending('the source PR, repair basis, original receipts or sole ownership no longer verifies')
  if (!enabled(db, chain.repository) || !allowed() || journal.read(chain.id)?.sequence !== chain.sequence
    || journal.read(reportChain.id)?.sequence !== reportChain.sequence
    || getSettings().me !== accounts.me || getSettings().agentAccount !== accounts.agentAccount) return pending('source, diagnosis owner or admission controls changed during verification')
  let current = journal.append(chain.id, randomUUID(), chain.sequence, { type: 'chain.observed', observation: fresh })
  if (!current.repairRecovery) current = journal.append(current.id, randomUUID(), current.sequence, { type: 'chain.resumed',
    repairRecovery: { report: report.issueNumber!, key: report.key, holdSequence: report.holdSequence!, head: report.head!,
      basis: report.basis, slot: report.slot!, diagnosis: digest, note }, recovery: { origin: 'automatic' } })
  return null
}

/** A pre-PR failure pairs one unambiguous test file:line, case and failure
 * excerpt with the Caller's retained diagnostic facts. Changed IDs, wording
 * or report closure alone never qualify; a missing or ambiguous identity or
 * diagnostic stays unknown. */
function prePrTestFileLine(error: unknown): { file: string, line: number } | null {
  if (typeof error !== 'string') return null
  const found = new Map<string, number>()
  for (const match of error.matchAll(/\b([\w.-]+(?:\/[\w.-]+)*\.(?:test|spec)\.[tj]s[x]?):(\d+)\b/g)) {
    const line = Number(match[2])
    if (!Number.isSafeInteger(line) || line < 1) return null
    const file = match[1]
    if (found.has(file) && found.get(file) !== line) return null
    found.set(file, line)
  }
  if (found.size !== 1) return null
  const [file, line] = [...found.entries()][0]
  return { file, line }
}

function escapePrePrRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function prePrTestCase(error: string, file: string): string | null {
  const found = new Set<string>()
  for (const match of error.matchAll(new RegExp(`\\b${escapePrePrRegExp(file)}\\s*>\\s*([^:\\n]+?)\\s*:`, 'g'))) {
    const test = match[1].trim()
    if (!test) return null
    found.add(test)
  }
  if (found.size !== 1) return null
  return [...found][0]
}

function prePrFailureExcerpt(error: string, file: string, test: string): string | null {
  const matches = [...error.matchAll(new RegExp(`\\b${escapePrePrRegExp(file)}\\s*>\\s*${escapePrePrRegExp(test)}\\s*:\\s*`, 'g'))]
  if (matches.length !== 1 || matches[0].index === undefined) return null
  let excerpt = error.slice(matches[0].index + matches[0][0].length)
  const cut = excerpt.search(/Captured candidate/i)
  if (cut >= 0) excerpt = excerpt.slice(0, cut)
  excerpt = excerpt.trim().replace(/\s+/g, ' ')
  return excerpt ? excerpt : null
}

function prePrFileAndTest(error: unknown): { file: string, test: string } | null {
  if (typeof error !== 'string') return null
  const parsed = prePrTestFileLine(error)
  if (!parsed) return null
  const test = prePrTestCase(error, parsed.file)
  return test ? { file: parsed.file, test } : null
}

function prePrDiagnosticFingerprint(diagnostic: unknown): Record<string, unknown> | null {
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return null
  const row = diagnostic as { operation?: unknown, phase?: unknown, outcome?: unknown,
    context?: Record<string, unknown> | null }
  if (typeof row.operation !== 'string' || typeof row.phase !== 'string'
    || row.outcome !== null && typeof row.outcome !== 'string') return null
  const context = row.context ?? {}
  for (const key of ['submission', 'exit_code', 'signal', 'errno'] as const) {
    const value = (context as Record<string, unknown>)[key]
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') return null
  }
  return { operation: row.operation, phase: row.phase, outcome: row.outcome,
    submission: (context as Record<string, unknown>).submission ?? null,
    exit_code: (context as Record<string, unknown>).exit_code ?? null,
    signal: (context as Record<string, unknown>).signal ?? null,
    errno: (context as Record<string, unknown>).errno ?? null }
}

function prePrFailure(invocation: BehaviorChain['invocations'][number]) {
  const error = invocation.evidence?.error
  const file = prePrTestFileLine(error)
  if (!file || typeof error !== 'string') return null
  const test = prePrTestCase(error, file.file)
  if (!test) return null
  const failure = prePrFailureExcerpt(error, file.file, test)
  if (!failure) return null
  const diagnostic = prePrDiagnosticFingerprint(invocation.evidence?.diagnostic)
  return diagnostic ? { ...file, test, failure, diagnostic } : null
}

function prePrReports(db: Database, chainId: string) {
  const rows = db.prepare(`SELECT key, value FROM meta WHERE key GLOB ?
    AND json_extract(value, '$.source') = ? AND json_extract(value, '$.pull') IS NULL
    AND json_extract(value, '$.holdSequence') IS NOT NULL
    ORDER BY json_extract(value, '$.holdSequence') DESC`)
    .all(PREFIX + '*', chainId) as Array<{ key: string, value: string }>
  return rows.map(row => ({ storageKey: row.key, value: row.value, report: JSON.parse(row.value) as RepairReport }))
}

/** Runs only on the existing reconciliation opportunity. The existing meta
 * store holds creation intent; neither its absence on GitHub nor a restart
 * can reopen that intent for another POST. Intake remains the normal reader. */
export async function reportRepairExhaustion(db: Database, journal: BehaviorChainJournal, chain: BehaviorChain,
  verify: () => Promise<ChainObservation>, allowed: () => boolean): Promise<string | null> {
  const retained = db.prepare('SELECT value FROM meta WHERE key = ?')
    .get(PREFIX + chainBasis([IMPLEMENTATION_CAUSE, chain.id])) as { value: string } | undefined
  if (retained) {
    const report = JSON.parse(retained.value) as RepairReport
    const target = report.issueNumber && journal.read(chainIdentity(chain.repository, report.issueNumber))
    if (report.disposition && target && boundImplementationSource(db, journal, target, report)) return dispositionReason(target, report)
  }
  const pendingMerge = chain.invocations.find(invocation => invocation.behavior === 'merge-pr' && invocation.state !== 'settled')
  const pendingImplementation = chain.invocations.find(invocation => invocation.behavior === 'implement-issue' && invocation.state !== 'settled')
  if (!enabled(db, chain.repository) || !allowed() || !chain.held && !pendingMerge && !pendingImplementation) return null
  const observation = chain.observation as ChainObservation | null
  if (!observation) return null
  const qualifying = qualifyingAttempts(db, chain, observation, Date.now())
  const merge = qualifyingMergeSubmission(chain, observation, Date.now())
  const closed = qualifyingClosedPull(chain, observation, Date.now())
  const implementation = qualifyingImplementationHold(db, chain, observation, Date.now())
    ?? qualifyingImplementationPublication(chain, observation, Date.now())
  const implementationCause = implementation?.invocation.state === 'uncertain' ? IMPLEMENTATION_PUBLICATION_CAUSE : IMPLEMENTATION_CAUSE
  // A pre-PR hold after Resume reconciles against its own attempt and hold
  // sequence. A prior closed intent never silently consumes a newer
  // qualifying failure; same failures deduplicate, unknown stays pending.
  let prePrOverride: { cause: typeof IMPLEMENTATION_CAUSE, key: string, storageKey: string, stored: { value: string } | undefined } | null = null
  if (implementation && implementationCause === IMPLEMENTATION_CAUSE && !observation.pull && !merge && !closed && !qualifying) {
    const currentHold = db.prepare(`SELECT sequence, at FROM behavior_chain_events WHERE chain_id = ?
      AND json_extract(payload, '$.type') = 'chain.held' AND sequence > ? ORDER BY sequence DESC LIMIT 1`)
      .get(chain.id, chain.resumedAfterSequence) as { sequence: number, at: number } | undefined
    const priors = prePrReports(db, chain.id)
    const exact = currentHold && priors.find(candidate => candidate.report.attempts.length === 1
      && candidate.report.attempts[0].invocation === implementation.invocation.id
      && candidate.report.attempts[0].call === implementation.call
      && candidate.report.holdSequence === currentHold.sequence && candidate.report.heldAt === currentHold.at)
    if (exact) {
      prePrOverride = { cause: IMPLEMENTATION_CAUSE, key: exact.report.key, storageKey: exact.storageKey, stored: { value: exact.value } }
    } else if (priors.length) {
      const waitingPrefix = `Stage: implement-issue. Worker-reported blocker: ${behaviorErrorMessage(chain.held!, 500)}. Next action: inspect the implementation Call, address the blocker, then explicitly Resume. `
      const current = prePrFailure(implementation.invocation)
      if (!currentHold || !current) {
        return `${waitingPrefix}Implementation hold reporting pending: current Call ${implementation.call} after Resume has an uncertain failure relationship (no unambiguous test file:line, case and failure excerpt in its worker blocker or missing Caller diagnostic); prior report preserves its hold; inspect the current Call before explicitly resuming; the source remains held`
      }
      const same: typeof priors = []
      const unknown: string[] = []
      let different = true
      for (const candidate of priors) {
        const priorInvocation = chain.invocations.find(invocation => invocation.id === candidate.report.attempts[0]?.invocation)
        const prior = priorInvocation ? prePrFailure(priorInvocation) : null
        if (!priorInvocation || !prior) { different = false; unknown.push(`prior report ${candidate.report.issueNumber ?? candidate.report.key.slice(0, 8)} original Call evidence is unavailable`); continue }
        if (current.file === prior.file && current.line === prior.line && current.test === prior.test
          && current.failure === prior.failure && chainBasis(current.diagnostic) === chainBasis(prior.diagnostic)) { same.push(candidate); continue }
        if (current.file !== prior.file && chainBasis(current.diagnostic) === chainBasis(prior.diagnostic)) continue
        if (current.file === prior.file && current.line === prior.line && current.test === prior.test
          && current.failure !== prior.failure && chainBasis(current.diagnostic) === chainBasis(prior.diagnostic)) continue
        different = false
        unknown.push(current.file === prior.file && current.line !== prior.line
          ? `current Call ${implementation.call} (${current.file}:${current.line}) shares its failing file with prior report ${candidate.report.issueNumber ?? candidate.report.key.slice(0, 8)} (${prior.file}:${prior.line}) but lines differ`
          : current.file === prior.file && current.line === prior.line && current.test !== prior.test
          ? `current Call ${implementation.call} (${current.file}:${current.line}) shares its failing location with prior report ${candidate.report.issueNumber ?? candidate.report.key.slice(0, 8)} (${prior.file}:${prior.line}) but test case differs`
          : `current Call ${implementation.call} diagnostic differs from prior report ${candidate.report.issueNumber ?? candidate.report.key.slice(0, 8)}`)
      }
      if (same.length) {
        prePrOverride = { cause: IMPLEMENTATION_CAUSE, key: same[0].report.key, storageKey: same[0].storageKey, stored: { value: same[0].value } }
      } else if (!different || unknown.length) {
        return `${waitingPrefix}Implementation hold reporting pending: current Call ${implementation.call} (${current.file}:${current.line}) after Resume has an uncertain failure relationship (${unknown.join('; ') || 'no verified same or different failure'}); prior report preserves its hold; inspect the current Call and prior report before explicitly resuming; the source remains held`
      } else {
        const scoped = chainBasis([IMPLEMENTATION_CAUSE, chain.id, implementation.invocation.id, currentHold.sequence])
        prePrOverride = { cause: IMPLEMENTATION_CAUSE, key: scoped, storageKey: PREFIX + scoped, stored: undefined }
      }
    }
  }
  const intents = CAUSES.filter(cause => cause === MERGE_CAUSE ? pendingMerge
    : cause === IMPLEMENTATION_PUBLICATION_CAUSE ? pendingImplementation : cause === IMPLEMENTATION_CAUSE || observation.pull).flatMap(cause => {
    // A terminal repair has its own PR identity; retain the older implementation intent for historical status.
    const bases = cause === IMPLEMENTATION_CAUSE
      ? [...(observation.pull ? [[cause, chain.id, observation.pull.number]] : []), [cause, chain.id]]
      : [[cause, chain.id, cause === MERGE_CAUSE ? pendingMerge!.id
        : cause === IMPLEMENTATION_PUBLICATION_CAUSE ? pendingImplementation!.id : observation.pull!.number]]
    return bases.map(basis => {
      const key = chainBasis(basis)
      const storageKey = PREFIX + key
      const stored = db.prepare('SELECT value FROM meta WHERE key = ?').get(storageKey) as { value: string } | undefined
      return { cause, key, storageKey, stored }
    })
  })
  // A closed target must keep any prior source/PR report, including one under
  // another cause, an uncertain merge's invocation-based key, or a legacy
  // PR-scoped source after a v2 chain takes ownership.
  const linked = closed ? db.prepare(`SELECT key, value FROM meta WHERE key GLOB ?
    AND json_extract(value, '$.pull') = ?
    AND (json_extract(value, '$.source') = ? OR json_extract(value, '$.source') = ?)
    ORDER BY json_extract(value, '$.issueNumber') IS NULL, key LIMIT 1`)
    .get(PREFIX + '*', observation.pull!.number, chain.id,
      `${chain.repository.toLowerCase()}#${observation.pull!.number}`) as { key: string, value: string } | undefined
    : qualifying?.cause === 'review_budget_exhausted' ? existingReviewReport(db, chain.repository, observation.pull!.number) : undefined
  let intent = linked ? { cause: closed ? CLOSED_CAUSE : 'review_budget_exhausted', key: (JSON.parse(linked.value) as RepairReport).key,
    storageKey: linked.key, stored: linked }
    : intents.find(intent => intent.cause === (merge ? MERGE_CAUSE : closed ? CLOSED_CAUSE : implementation ? implementationCause : qualifying?.cause)) ?? intents.find(intent => intent.stored)
  if (prePrOverride) intent = prePrOverride
  if (!intent) return pendingMerge || !observation.pull ? null : 'Repair exhaustion reporting: hold has no verified repair or PR review exhaustion on the current basis'
  const { cause, key, storageKey, stored } = intent
  const implementationReport = cause === IMPLEMENTATION_PUBLICATION_CAUSE
    || cause === IMPLEMENTATION_CAUSE && (stored ? (JSON.parse(stored.value) as RepairReport).pull === null : observation.pull === null)
  const label = cause === CLOSED_CAUSE ? 'Closed PR continuation' : cause === MERGE_CAUSE ? 'Merge submission'
    : cause === IMPLEMENTATION_PUBLICATION_CAUSE ? 'Implementation publication'
    : cause === IMPLEMENTATION_CAUSE ? implementationReport ? 'Implementation hold' : 'Repair hold' : 'Repair exhaustion'
  let report: RepairReport | null = stored ? JSON.parse(stored.value) as RepairReport : null
  if (report && (storageKey !== PREFIX + key || report.key !== key || (!linked && report.source !== chain.id) || report.pull !== (implementationReport ? null : observation.pull!.number)
    || report.issueNumber !== null && (!Number.isSafeInteger(report.issueNumber) || report.issueNumber < 1))) {
    throw new Error('Repair report intent conflicts with its source hold')
  }
  const marker = `<!-- poise-repair-exhaustion:${key} -->`
  // Report creation and confirmation save through createReport and
  // confirmReport; only the linked-report matcher stays local.
  const references = (body: string) => [...body.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\b|(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g)]
    .filter(match => (match[1] ?? match[3] ?? chain.repository).toLowerCase() === chain.repository.toLowerCase())
    .map(match => Number(match[2] ?? match[4]))
  const original = report?.attempts[0] ?? (implementation ? { invocation: implementation.invocation.id, call: implementation.call } : null)
  const linkedReport = cause === IMPLEMENTATION_PUBLICATION_CAUSE && original ? (body: string, author: string) =>
    [chain.author.toLowerCase(), chain.reviewer.toLowerCase()].includes(author.toLowerCase())
    && references(body).includes(chain.issue)
    && [original.invocation, original.call].every(id => body.split(/[^A-Za-z0-9:_-]+/).includes(id))
    && /\b(?:implementation|publication) (?:remains |is )uncertain\b/i.test(body)
    && /\b(?:no|missing|without|lacks)[^.\n]{0,120}\b(?:push (?:result|outcome|evidence)|publication receipt)\b/i.test(body)
    : undefined
  // A blocked-by remedy for a new pre-PR failure verifies by its failing file
  // and test case. The remedy predates the hold, so it cannot carry the new
  // marker or Call; a file mention alone leaves ownership unresolved.
  const prePrRemedy = cause === IMPLEMENTATION_CAUSE && implementationReport && implementation
    ? (() => {
        const failure = prePrFileAndTest(implementation.invocation.evidence?.error)
        return failure ? (body: string, author: string) =>
          [chain.author.toLowerCase(), chain.reviewer.toLowerCase()].includes(author.toLowerCase())
          && !REPORT_MARKER.test(body) && body.includes(failure.file) && body.includes(failure.test)
          : undefined
      })()
    : undefined
  if (report && implementationReport && getBehaviorChainSettings().seedMode === 'label') {
    const fresh = await verify()
    const settings = getBehaviorChainSettings()
    if (settings.seedMode === 'label' && fresh.issue.eligible !== true) {
      return `${label} reporting pending: the source is not verified eligible for intake label ${settings.label}`
    }
  }
  if (!report) {
    const accounts = getSettings()
    if (accounts.me.toLowerCase() !== chain.author.toLowerCase() || accounts.agentAccount.toLowerCase() !== chain.reviewer.toLowerCase()) {
      return `${label} reporting pending: configured accounts differ from the source chain`
    }
    if (cause === CLOSED_CAUSE ? !closed : implementationReport ? !implementation || implementationCause !== cause : cause === MERGE_CAUSE ? !merge : qualifying?.cause !== cause) return cause === MERGE_CAUSE || implementationReport
      ? `${label} reporting: source has no verified failure on the current basis`
      : 'Repair exhaustion reporting: hold has no verified repair or PR review exhaustion on the current basis'
    if (db.prepare(`SELECT 1 FROM meta WHERE key GLOB ? AND json_extract(value, '$.source') GLOB ?
      AND json_extract(value, '$.issueNumber') = ? LIMIT 1`).get(PREFIX + '*', chain.repository.toLowerCase() + '#*', chain.issue)) {
      return `${label} reporting suppressed for a generated remediation issue; its ordinary hold or uncertainty remains active`
    }
    // verify performs the existing datastore health check before re-reading
    // reviews. A fresh native head alone cannot validate local review rows.
    const fresh = await verify()
    const settings = getBehaviorChainSettings()
    if (implementationReport && settings.seedMode === 'label' && fresh.issue.eligible !== true) {
      return `${label} reporting pending: the source is not verified eligible for intake label ${settings.label}`
    }
    const verified = qualifyingAttempts(db, chain, fresh, Date.now())
    const verifiedMerge = qualifyingMergeSubmission(chain, fresh, Date.now())
    const verifiedImplementation = cause === IMPLEMENTATION_PUBLICATION_CAUSE
      ? qualifyingImplementationPublication(chain, fresh, Date.now()) : qualifyingImplementationHold(db, chain, fresh, Date.now())
    if (cause === CLOSED_CAUSE ? (!qualifyingClosedPull(chain, fresh, Date.now()) || fresh.pull?.number !== observation.pull!.number)
      : implementationReport ? (!verifiedImplementation || verifiedImplementation.invocation.id !== implementation?.invocation.id)
      : cause === MERGE_CAUSE ? (!verifiedMerge || fresh.pull?.head !== observation.pull!.head)
        : (verified?.cause !== cause || fresh.pull?.head !== observation.pull!.head || verified!.decision.basis !== qualifying!.decision.basis)) {
      return implementationReport
        ? `${label} reporting pending: the open source, ${cause === IMPLEMENTATION_CAUSE ? 'automatic hold' : 'original receipt'} or absence of publication no longer verifies the original failure`
        : cause === MERGE_CAUSE
        ? `${label} reporting pending: the current head or review basis no longer verifies the original failure`
        : 'Repair exhaustion reporting pending: the current head or review basis no longer verifies the exhausted attempts'
    }
    const seed = await handleGhBody({ operation: 'read_issue', repository_full_name: chain.repository, issue_number: chain.issue })
    const source = seed.body as { issue?: { body?: unknown, state?: string }, error?: string }
    if (seed.status !== 200 || typeof source.issue?.body !== 'string') throw new Error(source.error || 'Repair report source issue is unavailable')
    if ((cause === MERGE_CAUSE || cause === CLOSED_CAUSE || cause === IMPLEMENTATION_CAUSE || implementationReport) && source.issue.state !== 'open') return `${label} reporting pending: the source issue is no longer open`
    if (REPORT_MARKER.test(source.issue.body)) return `${label} reporting suppressed for a generated remediation issue; its ordinary hold or uncertainty remains active`
    if (cause === CLOSED_CAUSE) {
      const successor = await closedPullSuccessor(chain, fresh.pull!.number)
      if (successor) return successor
    }
    let existing = await reconcileRepairReport(chain.repository, marker, null)
    // A new pre-PR failure after Resume adopts its blocked-by remedy when one
    // markerless open issue verifies the current failing file and test case.
    // An unavailable or ambiguous owner read stays pending; it never counts
    // as no owner. A file mention alone leaves ownership unresolved.
    if (!existing && cause === IMPLEMENTATION_CAUSE && implementationReport && key !== chainBasis([cause, chain.id])) {
      const failure = prePrFileAndTest(implementation!.invocation.evidence?.error)
      if (!failure) return `${label} reporting pending: current Call ${implementation!.call} failure identity is unavailable during remedy lookup; prior report preserves its hold; inspect the current Call before explicitly resuming`
      const deps = (fresh.prerequisites?.evidence?.[0] ?? null) as { repo?: unknown, number?: unknown,
        found?: unknown, complete?: unknown, prerequisites?: unknown } | null
      if (!fresh.prerequisites || !deps || String(deps.repo ?? '').toLowerCase() !== chain.repository.toLowerCase()
        || deps.number !== chain.issue || deps.found !== true || deps.complete !== true || !Array.isArray(deps.prerequisites)) {
        return `${label} reporting pending: blocked-by evidence is unavailable or incomplete for ${chain.id}; cannot establish an existing remedy for ${failure.file}; inspect the current Call before explicitly resuming`
      }
      const blockedBy = deps.prerequisites as Array<{ repo?: unknown, number?: unknown }>
      if (blockedBy.some(entry => !entry || typeof entry !== 'object' || String((entry as { repo?: unknown }).repo ?? '').toLowerCase() !== chain.repository.toLowerCase()
        || !Number.isSafeInteger((entry as { number?: unknown }).number) || Number((entry as { number?: unknown }).number) < 1
        || Number((entry as { number?: unknown }).number) === chain.issue)) {
        return `${label} reporting pending: blocked-by evidence for ${chain.id} is invalid or self-referential; cannot establish an existing remedy for ${failure.file}; inspect the current Call before explicitly resuming`
      }
      if (blockedBy.length) {
        const verifier = (body: string, author: string) =>
          [chain.author.toLowerCase(), chain.reviewer.toLowerCase()].includes(author.toLowerCase())
          && !REPORT_MARKER.test(body) && body.includes(failure.file) && body.includes(failure.test)
        const candidates: Array<{ number: number, url: string, state: string, labels: string[], title: unknown, body: string }> = []
        for (const entry of blockedBy) {
          const number = Number((entry as { number: number }).number)
          try {
            const candidate = await reconcileRepairReport(chain.repository, marker, number, false, verifier)
            if (candidate) candidates.push(candidate)
          } catch (error) {
            return `${label} reporting pending: existing remedy #${number} read is unavailable or ambiguous (${error instanceof Error ? error.message : String(error)}); cannot establish an owner for ${failure.file}; inspect the current Call before explicitly resuming`
          }
        }
        const open = candidates.filter(candidate => candidate.state === 'open')
        if (open.length > 1) {
          return `${label} reporting pending: multiple existing remedies match ${failure.file} (${open.map(candidate => `#${candidate.number}`).join(', ')}); cannot establish a unique owner; inspect the current Call before explicitly resuming`
        }
        if (open.length === 1) existing = open[0]
      }
    }
    if (!existing && linkedReport) {
      const { stdout } = await runFile('github-interface', ['--issue-comments', String(chain.issue), '--repository', chain.repository,
        '--token-user', chain.author], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })
      const comments = JSON.parse(stdout) as { repository: string, issue_number: number, comments: Array<{ author: string, body: string }> }
      if (comments.repository?.toLowerCase() !== chain.repository.toLowerCase() || comments.issue_number !== chain.issue
        || !Array.isArray(comments.comments) || comments.comments.some(comment => typeof comment.author !== 'string' || typeof comment.body !== 'string')) {
        throw new Error('Implementation publication report links are incomplete')
      }
      const text = [source.issue.body, ...comments.comments.filter(comment => [chain.author.toLowerCase(), chain.reviewer.toLowerCase()]
        .includes(comment.author.toLowerCase())).map(comment => comment.body)].join('\n')
      for (const number of new Set(references(text))) {
        if (number === chain.issue) continue
        const linked = await reconcileRepairReport(chain.repository, marker, number, false, linkedReport)
        if (linked && existing && linked.number !== existing.number) throw new Error('Multiple linked issues report the original uncertain implementation publication')
        if (linked) existing = linked
      }
    }
    // Optional presentation must finish before the final source check and the
    // one-shot creation intent. Its failure cannot consume the only POST.
    const snapshotAt = new Date().toISOString()
    let workSnapshot = `Work impact snapshot as of ${snapshotAt} (at filing; not live status).\nCurrent impact: unknown. No exact managed-work association is available.`
    try {
      const attempt = verifiedImplementation?.invocation ?? verifiedMerge?.invocation ?? verified?.attempts.at(-1)
        ?? chain.invocations.at(-1)
      const work = attempt ? behaviorChainWorkImpact(journal, attempt.callId
        ?? (typeof attempt.evidence?.nativeCallId === 'string' ? attempt.evidence.nativeCallId : null), attempt.id) : null
      if (work) {
        const origin = readServiceConfig()?.publicOrigin
        // Report causes already use their vetted detail paths; the live hold
        // text may contain private diagnostics or review comment identities.
        const nextAction = work.nextAction?.startsWith('Resolve the hold and explicitly resume:')
          ? 'Resolve the hold and explicitly resume; inspect the original journal evidence for the cause' : work.nextAction
        workSnapshot = [`Work impact snapshot as of ${snapshotAt} (at filing; not live status).`,
          `Current impact: ${work.impact}. Work target: ${work.target}. Work stage: ${work.stage}.`,
          `Last verified progress: ${new Date(work.progressAt).toISOString()}.`,
          `Next retry: ${work.retryAt === null ? 'not recorded' : new Date(work.retryAt).toISOString()}.`,
          `Next action: ${nextAction ? behaviorErrorMessage(nextAction, 500) : 'not recorded'}.`,
          ...(work.recovered ? ['Matched failure recovered; verified progress followed this invocation failure.'] : []),
          origin ? `[Journal evidence](${new URL(work.journal, origin).href}) (owning workspace access required).`
            : `Journal evidence in the owning Poise workspace: \`${work.journal}\`.`,
        ].join('\n')
      }
    } catch {
      workSnapshot = `Work impact snapshot as of ${snapshotAt} (at filing; not live status).\nCurrent impact: unknown. Workspace chain evidence is unavailable.`
    }
    const current = journal.read(chain.id)
    if (!current || current.resumedAfterSequence !== chain.resumedAfterSequence || current.sequence !== chain.sequence
      || (cause === CLOSED_CAUSE ? !qualifyingClosedPull(current, fresh, Date.now())
        : cause === MERGE_CAUSE ? qualifyingMergeSubmission(current, fresh, Date.now())?.invocation.id !== pendingMerge?.id
        : implementationReport ? (cause === IMPLEMENTATION_PUBLICATION_CAUSE ? qualifyingImplementationPublication(current, fresh, Date.now())
          : qualifyingImplementationHold(db, current, fresh, Date.now()))?.invocation.id !== implementation?.invocation.id
          : !current.held || qualifyingAttempts(db, current, fresh, Date.now())?.cause !== cause)) {
      return `${label} reporting pending: source changed during verification`
    }
    const verifiedAccounts = getSettings()
    if (verifiedAccounts.me.toLowerCase() !== chain.author.toLowerCase()
      || verifiedAccounts.agentAccount.toLowerCase() !== chain.reviewer.toLowerCase()) {
      return `${label} reporting pending: configured accounts differ from the source chain`
    }
    const hold = db.prepare(`SELECT sequence, at FROM behavior_chain_events WHERE chain_id = ?
      AND json_extract(payload, '$.type') = 'chain.held' AND sequence > ? ORDER BY sequence DESC LIMIT 1`)
      .get(chain.id, chain.resumedAfterSequence) as { sequence: number, at: number } | undefined
    if (!hold && cause !== MERGE_CAUSE && cause !== IMPLEMENTATION_PUBLICATION_CAUSE) throw new Error('Repair report has no durable active hold')
    report = { key, source: chain.id, pull: observation.pull?.number ?? null, holdSequence: hold?.sequence ?? null, heldAt: hold?.at ?? null,
      head: fresh.pull?.head ?? null, basis: cause === CLOSED_CAUSE ? key : verifiedImplementation?.invocation.basis ?? verifiedMerge?.invocation.basis ?? verified!.decision.basis,
      slot: verifiedImplementation?.invocation.slot ?? verified?.decision.reviewer?.slot ?? null,
      attempts: cause === CLOSED_CAUSE ? [] : implementationReport ? [{ invocation: verifiedImplementation!.invocation.id, call: verifiedImplementation!.call,
        completedAt: Number(verifiedImplementation!.invocation.evidence!.completedAt) }]
        : cause === MERGE_CAUSE ? [{ invocation: verifiedMerge!.invocation.id, call: verifiedMerge!.call,
        completedAt: Number(verifiedMerge!.invocation.evidence!.completedAt) }]
        : verified!.attempts.map(invocation => ({ invocation: invocation.id, call: invocation.callId!, completedAt: Number(invocation.evidence!.completedAt) })),
      issueNumber: existing?.number ?? null }
    // FULL durability precedes the external effect. A competing runtime or a
    // crash after this insert may reconcile, but may never create again.
    if (!enabled(db, chain.repository) || !allowed()) return null
    const concurrent = cause === 'review_budget_exhausted' ? existingReviewReport(db, chain.repository, report.pull!) : undefined
    if (concurrent) return confirmReport(db, journal, chain, JSON.parse(concurrent.value) as RepairReport, label, allowed)
    if (!reserveReport(db, report)) return `${label} report pending: another reconciliation reserved this report`
    if (!existing) {
      if (!enabled(db, chain.repository)) return null
      if (!allowed()) return `${label} report creation is unconfirmed; admissions are paused`
      const review = cause === 'review_budget_exhausted'
      const reviewCauses = review ? [...new Set(verified!.attempts.map(invocation => invocation.evidence!.error_code))].join(' or ') : null
      const mixedReviewTimeouts = review && isMixedReviewTimeouts(verified!.attempts)
      const lastTimeout = mixedReviewTimeouts ? [...verified!.attempts].reverse()
        .find(invocation => isReviewTimeoutCode(invocation.evidence?.error_code)) : null
      const lastTimeoutPhase = (() => {
        const phase = (lastTimeout?.evidence?.diagnostic as { phase?: unknown } | null | undefined)?.phase
        return typeof phase === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(phase) ? phase : 'unknown'
      })()
      const terminalAttempt = mixedReviewTimeouts ? verified!.attempts.at(-1)! : null
      const terminalCode = typeof terminalAttempt?.evidence?.error_code === 'string'
        && /^[a-z0-9_]{1,160}$/.test(terminalAttempt.evidence.error_code) ? terminalAttempt.evidence.error_code : 'not recorded'
      const budget = cause === 'repair_execution_budget_exhausted'
      const age = hold ? Math.max(0, Math.floor((Date.now() - hold.at) / 60_000)) : null
      const evidence = verifiedImplementation?.invocation.evidence ?? verifiedMerge?.invocation.evidence
        ?? (cause === IMPLEMENTATION_CAUSE ? verified?.attempts[0].evidence : null)
      const diagnostic = evidence?.diagnostic as ProcessDiagnostic | undefined
      const artifact = evidence?.artifact
      const failedSource = implementationReport && artifact && typeof artifact === 'object' && !Array.isArray(artifact)
        && 'failed_source' in artifact ? parseFailedSource(artifact.failed_source) : null
      const details = cause === CLOSED_CAUSE ? [
        `Poise's open source issue https://github.com/${chain.repository}/issues/${chain.issue} has no live replacement for its closed unmerged PR https://github.com/${chain.repository}/pull/${report.pull}.`, '',
        `Cause: ${cause}. Source: ${chain.id}; hold event ${hold!.sequence}; head ${report.head}.`,
        'Fresh GitHub evidence confirms the source remains open with the poise label and its only linked PR closed without merge. No verified successor covers the work.',
      ] : cause === IMPLEMENTATION_PUBLICATION_CAUSE ? [
        `Poise cannot confirm implementation publication for https://github.com/${chain.repository}/issues/${chain.issue}.`, '',
        `Stage: implement-issue. Cause: ${cause}. Source: ${chain.id}; basis ${report.basis}.`,
        `The original implementation remains uncertain after fresh reconciliation. Its terminal Call failed during publishing; resources were released at ${evidence!.resources_settled_at}. No conclusive push result, attributable pushed branch or bound PR was observed.`,
        `Recorded cause: ${typeof evidence!.error_code === 'string' && /^[a-z0-9_]{1,160}$/.test(evidence!.error_code) ? evidence!.error_code : 'not recorded'}.`,
        'Missing original evidence: a pre-push no-write checkpoint or conclusive push result attributable to the original Call. GitHub absence alone cannot settle that publication.',
      ] : cause === IMPLEMENTATION_CAUSE ? [
        implementationReport ? `Poise is holding implementation of https://github.com/${chain.repository}/issues/${chain.issue}.`
          : `Poise is holding repair of https://github.com/${chain.repository}/pull/${report.pull}. Source issue: https://github.com/${chain.repository}/issues/${chain.issue}.`, '',
        `Stage: ${implementationReport ? 'implement-issue' : 'repair-pr'}. Cause: ${cause}. Held since ${new Date(hold!.at).toISOString()} (${age} minutes at reporting).`,
        `Source: ${chain.id}; hold event ${hold!.sequence};${implementationReport ? '' : ` head ${report.head};`} basis ${report.basis}; slot ${report.slot}.`, '',
        `Verified receipt: one settled original Caller ${implementationReport ? 'implementation' : 'repair'} after the last Resume; status=failed; action=not_started; outcome=preflight_failed; error_code=${cause}. Resources were released at ${evidence!.resources_settled_at}. ${implementationReport ? 'No publication plan, result or receipts, pushed branch, bound PR or competing linked work was observed.' : 'No publication plan, result or GitHub action receipts were recorded; the repair ended before publication.'}`,
        `Worker-reported blocker: ${behaviorErrorMessage(evidence!.error, 500)}`,
        diagnostic ? `Caller diagnostic facts: ${behaviorErrorMessage(JSON.stringify({ operation: diagnostic.operation,
          phase: diagnostic.phase, outcome: diagnostic.outcome, submission: diagnostic.context.submission,
          exit_code: diagnostic.context.exit_code, signal: diagnostic.context.signal, errno: diagnostic.context.errno }), 1500)}.`
          : 'Caller diagnostic facts: not recorded in this historical Call receipt.',
        'The blocked result is verified; the worker-reported explanation is not independently verified.',
        ...(implementationReport ? failedSource?.status === 'available' && failedSource.expires_at * 1000 > Date.now() ? [
          `Validation-time source changes are privately retained in the owning workspace until ${new Date(failedSource.expires_at * 1000).toISOString()}. Candidate ${failedSource.candidate}; run ${failedSource.run}; base ${failedSource.base}.`,
          `The linked remediation's implementation Call can inspect their private file location with \`agent-interface --read-failed-source ${verifiedImplementation!.call} ${failedSource.candidate} ${failedSource.run}\`. Source contents must stay out of GitHub, notifications and logs.`,
          'This is the earlier failed capture, not any later untested edit. It grants no publication, retry or approval authority; corrections require fresh validation. If retrieval is unavailable, reproduce afresh.',
        ] : ['Validation-time source changes are unavailable; start with a fresh reproduction.'] : []),
      ] : cause === MERGE_CAUSE ? [
        `Poise cannot confirm the merge submission for https://github.com/${chain.repository}/pull/${report.pull}.`, '',
        `Stage: merge-pr. Cause: ${cause}. Source issue: https://github.com/${chain.repository}/issues/${chain.issue}.`,
        `Source: ${chain.id}; head ${report.head}; basis ${report.basis}.`,
        `Terminal Caller receipt: status=${evidence!.status}; action=${evidence!.action ?? 'not recorded'}; outcome=${evidence!.outcome ?? 'not recorded'}. Resources were released; an accepted merge response is missing.`,
        `Recorded cause: ${typeof evidence!.error_code === 'string' && /^[a-z0-9_]+$/.test(evidence!.error_code) ? evidence!.error_code : 'not recorded'}.`,
        diagnostic ? `Process diagnostic: ${JSON.stringify({ operation: diagnostic.operation, phase: diagnostic.phase,
          outcome: diagnostic.outcome, exit_code: diagnostic.context.exit_code, signal: diagnostic.context.signal,
          errno: diagnostic.context.errno, refusal: diagnostic.context.refusal })}.`
          : 'Process diagnostic: not recorded in this historical Call receipt; the underlying process cause is unavailable.',
      ] : [
        `Poise is holding https://github.com/${chain.repository}/pull/${report.pull}.`, '',
        `Stage: ${verified!.decision.behavior}. Cause: ${reviewCauses ?? cause}. Held since ${new Date(hold!.at).toISOString()} (${age} minutes at reporting).`,
        `Source: ${chain.id}; hold event ${hold!.sequence}; head ${report.head}; basis ${report.basis}; slot ${report.slot}.`, '',
        `Verified receipts: three or more settled Caller ${review ? 'PR reviews' : 'repairs'} on this basis after the last Resume. Each failed before ${review ? 'review submission' : 'publication'} with ${review ? `${reviewCauses}, action=not_started, outcome=preflight_failed` : budget ? 'atomic_work_execution_budget_exhausted, action=not_started, outcome=preflight_failed' : 'atomic_work_failed, action=not_started, outcome=preflight_failed and the incomplete-reply validation cause'}; resources were released.${mixedReviewTimeouts ? ` Last timeout phase: ${lastTimeoutPhase}; terminal attempt: ${terminalCode}.` : ''}`,
      ]
      const body = [marker, '', ...details,
        ...report.attempts.map((attempt, index) => {
          const line = `- Invocation ${attempt.invocation}; Caller ${attempt.call}; completed ${new Date(attempt.completedAt).toISOString()}`
          if (!review) return `${line}.`
          const evidence = verified!.attempts[index].evidence!
          return reviewAttemptLine(attempt.invocation, attempt.call, attempt.completedAt, evidence.error_code, evidence.diagnostic as ProcessDiagnostic | undefined)
        }), '',
        workSnapshot, '',
        cause === CLOSED_CAUSE
          ? 'Next action: implement the remaining source issue work through this continuation after inspecting the closed PR and original journal receipts. Original invocation and resource evidence remain retained; this report never authorizes replay, replacement publication or resource release from an unreadable or incomplete original receipt.'
          : cause === IMPLEMENTATION_PUBLICATION_CAUSE
          ? 'Next action: recover and reconcile the original Call\'s pre-push no-write checkpoint or conclusive push result. Keep the source fenced until its original publication outcome is verified. This report preserves the original invocation\'s uncertainty and ownership; it authorizes neither replacement implementation nor a second push.'
          : cause === IMPLEMENTATION_CAUSE
          ? `Next action: inspect the original Call and worker-reported blocker, address the cause, then explicitly Resume the source chain for a fresh ${implementationReport ? 'implementation' : 'repair'} when appropriate. This report preserves its hold and ownership; it never relaunches ${implementationReport ? 'implementation' : 'repair'} or relaxes review, resource, admission or merge gates.`
          : cause === MERGE_CAUSE
          ? `Next action: inspect the original Call diagnostics and reconcile the PR and merge queue at the pinned head before deciding whether to repair or replace the candidate. The external effect remains unconfirmed. This report retains the original invocation's uncertainty and chain ownership; it never retries the merge or relaxes any review, resource, admission or merge gate.`
          : `Next action: inspect the ${review ? 'PR review timeouts' : budget ? 'repair execution budget' : 'repair reply validation'} and source receipts, address the cause, then explicitly Resume the source chain when appropriate. This report preserves its hold and does not recover ${review ? 'review' : 'repair'} or relax any review, admission or merge gate.`,
        '', REMEDIATION_SCOPE, '', 'Include this exact paragraph in the linked PR review.',
      ].join('\n')
      await createReport(db, chain.repository, report,
        cause === CLOSED_CAUSE ? `fix: continue #${chain.issue} after closed unmerged PR #${report.pull}`
          : cause === IMPLEMENTATION_PUBLICATION_CAUSE ? `fix: uncertain implementation publication for #${chain.issue}`
          : cause === IMPLEMENTATION_CAUSE ? `fix: blocked ${implementationReport ? 'implementation' : 'repair'} for #${implementationReport ? chain.issue : report.pull}`
          : cause === MERGE_CAUSE ? `fix: uncertain merge submission for #${report.pull}`
          : `fix: ${review ? 'PR review exhausted its time limits' : budget ? 'repair exhausted execution budget' : 'repair exhausted incomplete review replies'} for #${report.pull}`, body)
    }
  }
  const last = chain.invocations.at(-1)?.behavior
  const repair = last === 'repair-pr'
  const source = cause === IMPLEMENTATION_CAUSE && chain.held && (repair || last === 'implement-issue')
    ? `Stage: ${repair ? 'repair-pr' : 'implement-issue'}. Worker-reported blocker: ${behaviorErrorMessage(chain.held, 500)}. Next action: inspect the ${repair ? 'repair' : 'implementation'} Call, address the blocker, then explicitly Resume. `
    : ''
  const publicationAction = cause === IMPLEMENTATION_PUBLICATION_CAUSE
    ? `Original Call ${original!.call} publication remains uncertain: reconcile its missing pre-push no-write checkpoint or conclusive push result. ` : ''
  return confirmReport(db, journal, chain, report, label, allowed, source, linkedReport ?? prePrRemedy, publicationAction)
}

async function confirmReport(db: Database, journal: BehaviorChainJournal,
  chain: Pick<BehaviorChain, 'repository' | 'author' | 'reviewer'>, report: RepairReport,
  label: string, allowed: () => boolean, closedPrefix = '', linkedReport?: (body: string, author: string) => boolean,
  publicationAction = ''): Promise<string> {
  const marker = `<!-- poise-repair-exhaustion:${report.key} -->`
  const save = () => db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(report), PREFIX + report.key)
  let issue = await reconcileRepairReport(chain.repository, marker, report.issueNumber, false, linkedReport)
  if (!issue) return `${publicationAction}${label} report creation is unconfirmed; no matching issue is visible yet. Reconcile the same marker; do not create a replacement`
  if (report.issueNumber === null) { report.issueNumber = issue.number; save() }
  const link = `${publicationAction}${closedPrefix}${issue.state === 'closed' ? 'Historical ' : ''}${label} report ${issue.url} (last verified ${new Date().toISOString()}; not live status)`
  if (issue.state === 'closed') return `${link} is closed; no replacement will be created`
  if (!issue.labels.some(label => label.toLowerCase() === 'poise') && enabled(db, chain.repository) && allowed()) {
    try { issue = (await reconcileRepairReport(chain.repository, marker, issue.number, true, linkedReport))! }
    catch (error) { return `${link}: poise label pending: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!issue.labels.some(label => label.toLowerCase() === 'poise')) return `${link}: admission blocked because GitHub has not applied the poise label`
  const settings = getBehaviorChainSettings()
  if (!settings.enabled) return `${link}: admission pending while behavior chains are disabled`
  if (settings.seedMode === 'label' && !issue.labels.some(label => label.toLowerCase() === settings.label.toLowerCase())) {
    return `${link}: admission blocked by saved intake label ${settings.label}; use ordinary issue intake to assign it`
  }
  const accounts = getSettings()
  if (accounts.me.toLowerCase() !== chain.author.toLowerCase() || accounts.agentAccount.toLowerCase() !== chain.reviewer.toLowerCase()) {
    return `${link}: admission blocked because configured accounts differ from the source chain`
  }
  const admitted = journal.read(chainIdentity(chain.repository, issue.number))
  return admitted ? `${link}: admitted as ${admitted.id}${admitted.held ? `; remediation is held: ${admitted.held}` : ''}`
    : `${link}: admission pending normal datastore intake and ownership gates`
}
