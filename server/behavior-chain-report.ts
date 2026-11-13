import type { Database } from 'better-sqlite3'
import { CHAIN_OBSERVATION_MAX_AGE_MS, decideBehaviorChain, type ChainObservation } from './behavior-chain-decision'
import { chainBasis, chainIdentity, type BehaviorChain, type BehaviorChainJournal } from './behavior-chain-store'
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
const CAUSES = ['repair_incomplete_replies', 'repair_execution_budget_exhausted', 'review_budget_exhausted', MERGE_CAUSE, CLOSED_CAUSE, IMPLEMENTATION_CAUSE] as const
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

/** The normal decision still has to request work on precisely this basis.
 * Ignore failed attempts only to ask what would be needed without exhaustion. */
function qualifyingAttempts(chain: BehaviorChain, observation: ChainObservation, now: number) {
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
  const cause = review ? attempts.every(invocation => invocation.evidence?.error_code === 'review_budget_exhausted'
    || invocation.evidence?.error_code === 'review_inspection_timeout') ? 'review_budget_exhausted' : null
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
    ? { invocation, call: invocation.callId } : null
}

/** Runs only on the existing reconciliation opportunity. The existing meta
 * store holds creation intent; neither its absence on GitHub nor a restart
 * can reopen that intent for another POST. Intake remains the normal reader. */
export async function reportRepairExhaustion(db: Database, journal: BehaviorChainJournal, chain: BehaviorChain,
  verify: () => Promise<ChainObservation>, allowed: () => boolean): Promise<string | null> {
  const pendingMerge = chain.invocations.find(invocation => invocation.behavior === 'merge-pr' && invocation.state !== 'settled')
  if (!enabled(db, chain.repository) || !allowed() || !chain.held && !pendingMerge) return null
  const observation = chain.observation as ChainObservation | null
  if (!observation) return null
  const qualifying = qualifyingAttempts(chain, observation, Date.now())
  const merge = qualifyingMergeSubmission(chain, observation, Date.now())
  const closed = qualifyingClosedPull(chain, observation, Date.now())
  const implementation = qualifyingImplementationHold(db, chain, observation, Date.now())
  const intents = CAUSES.filter(cause => cause === MERGE_CAUSE ? pendingMerge : cause === IMPLEMENTATION_CAUSE || observation.pull).map(cause => {
    const key = chainBasis(cause === IMPLEMENTATION_CAUSE ? [cause, chain.id]
      : [cause, chain.id, cause === MERGE_CAUSE ? pendingMerge!.id : observation.pull!.number])
    const storageKey = PREFIX + key
    const stored = db.prepare('SELECT value FROM meta WHERE key = ?').get(storageKey) as { value: string } | undefined
    return { cause, key, storageKey, stored }
  })
  // A closed target must keep any prior source/PR report, including one under
  // another cause or an uncertain merge's invocation-based key.
  const linked = closed ? db.prepare(`SELECT key, value FROM meta WHERE key GLOB ?
    AND json_extract(value, '$.source') = ? AND json_extract(value, '$.pull') = ?
    ORDER BY json_extract(value, '$.issueNumber') IS NULL, key LIMIT 1`)
    .get(PREFIX + '*', chain.id, observation.pull!.number) as { key: string, value: string } | undefined : undefined
  const intent = linked ? { cause: CLOSED_CAUSE, key: (JSON.parse(linked.value) as RepairReport).key,
    storageKey: linked.key, stored: linked }
    : intents.find(intent => intent.cause === (merge ? MERGE_CAUSE : closed ? CLOSED_CAUSE : implementation ? IMPLEMENTATION_CAUSE : qualifying?.cause)) ?? intents.find(intent => intent.stored)
  if (!intent) return pendingMerge || !observation.pull ? null : 'Repair exhaustion reporting: hold has no verified repair or PR review exhaustion on the current basis'
  const { cause, key, storageKey, stored } = intent
  const label = cause === CLOSED_CAUSE ? 'Closed PR continuation' : cause === MERGE_CAUSE ? 'Merge submission' : cause === IMPLEMENTATION_CAUSE ? 'Implementation hold' : 'Repair exhaustion'
  let report: RepairReport | null = stored ? JSON.parse(stored.value) as RepairReport : null
  if (report && (storageKey !== PREFIX + key || report.key !== key || report.source !== chain.id || report.pull !== (cause === IMPLEMENTATION_CAUSE ? null : observation.pull!.number)
    || report.issueNumber !== null && (!Number.isSafeInteger(report.issueNumber) || report.issueNumber < 1))) {
    throw new Error('Repair report intent conflicts with its source hold')
  }
  const marker = `<!-- poise-repair-exhaustion:${key} -->`
  const save = () => db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(report), storageKey)
  if (report && cause === IMPLEMENTATION_CAUSE && getBehaviorChainSettings().seedMode === 'label') {
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
    if (cause === CLOSED_CAUSE ? !closed : cause === IMPLEMENTATION_CAUSE ? !implementation : cause === MERGE_CAUSE ? !merge : qualifying?.cause !== cause) return cause === MERGE_CAUSE || cause === IMPLEMENTATION_CAUSE
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
    if (cause === IMPLEMENTATION_CAUSE && settings.seedMode === 'label' && fresh.issue.eligible !== true) {
      return `${label} reporting pending: the source is not verified eligible for intake label ${settings.label}`
    }
    const verified = qualifyingAttempts(chain, fresh, Date.now())
    const verifiedMerge = qualifyingMergeSubmission(chain, fresh, Date.now())
    const verifiedImplementation = qualifyingImplementationHold(db, chain, fresh, Date.now())
    if (cause === CLOSED_CAUSE ? (!qualifyingClosedPull(chain, fresh, Date.now()) || fresh.pull?.number !== observation.pull!.number)
      : cause === IMPLEMENTATION_CAUSE ? (!verifiedImplementation || verifiedImplementation.invocation.id !== implementation?.invocation.id)
      : cause === MERGE_CAUSE ? (!verifiedMerge || fresh.pull?.head !== observation.pull!.head)
        : (verified?.cause !== cause || fresh.pull?.head !== observation.pull!.head || verified!.decision.basis !== qualifying!.decision.basis)) {
      return cause === IMPLEMENTATION_CAUSE
        ? `${label} reporting pending: the open source, automatic hold or absence of publication no longer verifies the original failure`
        : cause === MERGE_CAUSE
        ? `${label} reporting pending: the current head or review basis no longer verifies the original failure`
        : 'Repair exhaustion reporting pending: the current head or review basis no longer verifies the exhausted attempts'
    }
    const seed = await handleGhBody({ operation: 'read_issue', repository_full_name: chain.repository, issue_number: chain.issue })
    const source = seed.body as { issue?: { body?: unknown, state?: string }, error?: string }
    if (seed.status !== 200 || typeof source.issue?.body !== 'string') throw new Error(source.error || 'Repair report source issue is unavailable')
    if ((cause === MERGE_CAUSE || cause === CLOSED_CAUSE || cause === IMPLEMENTATION_CAUSE) && source.issue.state !== 'open') return `${label} reporting pending: the source issue is no longer open`
    if (REPORT_MARKER.test(source.issue.body)) return `${label} reporting suppressed for a generated remediation issue; its ordinary hold or uncertainty remains active`
    if (cause === CLOSED_CAUSE) {
      const successor = await closedPullSuccessor(chain, fresh.pull!.number)
      if (successor) return successor
    }
    const existing = await reconcileRepairReport(chain.repository, marker, null)
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
        : cause === IMPLEMENTATION_CAUSE ? qualifyingImplementationHold(db, current, fresh, Date.now())?.invocation.id !== implementation?.invocation.id
          : !current.held || qualifyingAttempts(current, fresh, Date.now())?.cause !== cause)) {
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
    if (!hold && cause !== MERGE_CAUSE) throw new Error('Repair report has no durable active hold')
    report = { key, source: chain.id, pull: observation.pull?.number ?? null, holdSequence: hold?.sequence ?? null, heldAt: hold?.at ?? null,
      head: fresh.pull?.head ?? null, basis: cause === CLOSED_CAUSE ? key : verifiedImplementation?.invocation.basis ?? verifiedMerge?.invocation.basis ?? verified!.decision.basis,
      slot: verifiedImplementation?.invocation.slot ?? verified?.decision.reviewer?.slot ?? null,
      attempts: cause === CLOSED_CAUSE ? [] : cause === IMPLEMENTATION_CAUSE ? [{ invocation: verifiedImplementation!.invocation.id, call: verifiedImplementation!.call,
        completedAt: Number(verifiedImplementation!.invocation.evidence!.completedAt) }]
        : cause === MERGE_CAUSE ? [{ invocation: verifiedMerge!.invocation.id, call: verifiedMerge!.call,
        completedAt: Number(verifiedMerge!.invocation.evidence!.completedAt) }]
        : verified!.attempts.map(invocation => ({ invocation: invocation.id, call: invocation.callId!, completedAt: Number(invocation.evidence!.completedAt) })),
      issueNumber: existing?.number ?? null }
    // FULL durability precedes the external effect. A competing runtime or a
    // crash after this insert may reconcile, but may never create again.
    if (!enabled(db, chain.repository) || !allowed()) return null
    if (db.pragma('synchronous', { simple: true }) !== 2) db.pragma('synchronous = FULL')
    const claimed = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(storageKey, JSON.stringify(report))
    if (!claimed.changes) return `${label} report pending: another reconciliation reserved this report`
    if (!existing) {
      if (!enabled(db, chain.repository)) return null
      if (!allowed()) return `${label} report creation is unconfirmed; admissions are paused`
      const review = cause === 'review_budget_exhausted'
      const reviewCauses = review ? [...new Set(verified!.attempts.map(invocation => invocation.evidence!.error_code))].join(' or ') : null
      const budget = cause === 'repair_execution_budget_exhausted'
      const age = hold ? Math.max(0, Math.floor((Date.now() - hold.at) / 60_000)) : null
      const evidence = verifiedImplementation?.invocation.evidence ?? verifiedMerge?.invocation.evidence
      const diagnostic = evidence?.diagnostic as ProcessDiagnostic | undefined
      const details = cause === CLOSED_CAUSE ? [
        `Poise's open source issue https://github.com/${chain.repository}/issues/${chain.issue} has no live replacement for its closed unmerged PR https://github.com/${chain.repository}/pull/${report.pull}.`, '',
        `Cause: ${cause}. Source: ${chain.id}; hold event ${hold!.sequence}; head ${report.head}.`,
        'Fresh GitHub evidence confirms the source remains open with the poise label and its only linked PR closed without merge. No verified successor covers the work.',
      ] : cause === IMPLEMENTATION_CAUSE ? [
        `Poise is holding implementation of https://github.com/${chain.repository}/issues/${chain.issue}.`, '',
        `Stage: implement-issue. Cause: ${cause}. Held since ${new Date(hold!.at).toISOString()} (${age} minutes at reporting).`,
        `Source: ${chain.id}; hold event ${hold!.sequence}; basis ${report.basis}; slot ${report.slot}.`, '',
        `Verified receipt: one settled original Caller implementation after the last Resume; status=failed; action=not_started; outcome=preflight_failed; error_code=${cause}. Resources were released at ${evidence!.resources_settled_at}. No publication plan, result or receipts, pushed branch, bound PR or competing linked work was observed.`,
        `Worker-reported blocker: ${behaviorErrorMessage(evidence!.error, 500)}`,
        diagnostic ? `Caller diagnostic facts: ${behaviorErrorMessage(JSON.stringify({ operation: diagnostic.operation,
          phase: diagnostic.phase, outcome: diagnostic.outcome, submission: diagnostic.context.submission,
          exit_code: diagnostic.context.exit_code, signal: diagnostic.context.signal, errno: diagnostic.context.errno }), 1500)}.`
          : 'Caller diagnostic facts: not recorded in this historical Call receipt.',
        'The blocked result is verified; the worker-reported explanation is not independently verified.',
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
        `Verified receipts: three or more settled Caller ${review ? 'PR reviews' : 'repairs'} on this basis after the last Resume. Each failed before ${review ? 'review submission' : 'publication'} with ${review ? `${reviewCauses}, action=not_started, outcome=preflight_failed` : budget ? 'atomic_work_execution_budget_exhausted, action=not_started, outcome=preflight_failed' : 'atomic_work_failed, action=not_started, outcome=preflight_failed and the incomplete-reply validation cause'}; resources were released.`,
      ]
      const body = [marker, '', ...details,
        ...report.attempts.map((attempt, index) => {
          const line = `- Invocation ${attempt.invocation}; Caller ${attempt.call}; completed ${new Date(attempt.completedAt).toISOString()}`
          if (!review) return `${line}.`
          const evidence = verified!.attempts[index].evidence!
          const diagnostic = evidence.diagnostic as ProcessDiagnostic | undefined
          // Project only bounded identifiers and a numeric deadline, never CLI arguments or raw errors.
          const step = (['operation', 'phase'] as const).map(field => {
            const value = diagnostic?.[field]
            return `${field}=${typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(value) ? value : 'unknown'}`
          }).join('; ')
          const timeout = diagnostic?.context?.timeout_seconds
          return `${line}; error_code=${evidence.error_code}; ${step}; timeout_seconds=${typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : 'unknown'}.`
        }), '',
        workSnapshot, '',
        cause === CLOSED_CAUSE
          ? 'Next action: implement the remaining source issue work through this continuation after inspecting the closed PR and original journal receipts. Original invocation and resource evidence remain retained; this report never authorizes replay, replacement publication or resource release from an unreadable or incomplete original receipt.'
          : cause === IMPLEMENTATION_CAUSE
          ? 'Next action: inspect the original Call and worker-reported blocker, address the cause, then explicitly Resume the source chain for a fresh implementation when appropriate. This report preserves its hold and ownership; it never relaunches implementation or relaxes review, resource, admission or merge gates.'
          : cause === MERGE_CAUSE
          ? `Next action: inspect the original Call diagnostics and reconcile the PR and merge queue at the pinned head before deciding whether to repair or replace the candidate. The external effect remains unconfirmed. This report retains the original invocation's uncertainty and chain ownership; it never retries the merge or relaxes any review, resource, admission or merge gate.`
          : `Next action: inspect the ${review ? 'PR review timeouts' : budget ? 'repair execution budget' : 'repair reply validation'} and source receipts, address the cause, then explicitly Resume the source chain when appropriate. This report preserves its hold and does not recover ${review ? 'review' : 'repair'} or relax any review, admission or merge gate.`,
        '', REMEDIATION_SCOPE, '', 'Include this exact paragraph in the linked PR review.',
      ].join('\n')
      const result = await handleGhBody({ operation: 'open_issue', repository_full_name: chain.repository,
        title: cause === CLOSED_CAUSE ? `fix: continue #${chain.issue} after closed unmerged PR #${report.pull}`
          : cause === IMPLEMENTATION_CAUSE ? `fix: blocked implementation for #${chain.issue}`
          : cause === MERGE_CAUSE ? `fix: uncertain merge submission for #${report.pull}`
          : `fix: ${review ? 'PR review exhausted its time limits' : budget ? 'repair exhausted execution budget' : 'repair exhausted incomplete review replies'} for #${report.pull}`, body, labels: ['poise'] })
      const publication = result.body as { record?: { number?: unknown, url?: unknown }, error?: string }
      if (result.status !== 200 || !Number.isSafeInteger(publication.record?.number) || Number(publication.record?.number) < 1
        || publication.record?.url !== `https://github.com/${chain.repository}/issues/${publication.record?.number}`) {
        throw new Error(`Repair report ${key} creation is unconfirmed: ${publication.error || 'no verified issue receipt'}; reconcile its marker before any further action`)
      }
      report.issueNumber = Number(publication.record.number)
      save()
    }
  }
  let issue = await reconcileRepairReport(chain.repository, marker, report.issueNumber)
  if (!issue) return `${label} report creation is unconfirmed; no matching issue is visible yet. Reconcile the same marker; do not create a replacement`
  if (report.issueNumber === null) { report.issueNumber = issue.number; save() }
  const link = `${label} report ${issue.url}`
  if (issue.state === 'closed') {
    const closedReport = `${link} is closed; no replacement will be created`
    return cause === IMPLEMENTATION_CAUSE && chain.held && chain.invocations.at(-1)?.behavior === 'repair-pr'
      ? `Stage: repair-pr. Worker-reported blocker: ${behaviorErrorMessage(chain.held, 500)}. Next action: inspect the repair Call, address the blocker, then explicitly Resume. Historical ${closedReport}`
      : closedReport
  }
  if (!issue.labels.some(label => label.toLowerCase() === 'poise') && enabled(db, chain.repository) && allowed()) {
    try { issue = (await reconcileRepairReport(chain.repository, marker, issue.number, true))! }
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
