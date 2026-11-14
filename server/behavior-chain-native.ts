import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentInterfaceCwd } from './models'
import { headroomShortfall, measureBehaviorHeadroom, readBehaviorResourceAdmission, validateExecutionLimits, type BehaviorResourceHeadroom } from './behavior-resources'
import { parseAgentLogStdout, type LogEntry } from './agent-log-parse'
import { chainBasis, type BehaviorChain, type ChainBehavior, type ChainInvocation } from './behavior-chain-store'
import { chainCiDependency, chainReviewResponse, implementationTestDependency, type ChainDecision, type ChainObservation, type ChainReviewer } from './behavior-chain-decision'
import { MissingPublicationPlanError, type ChainRuntimeOperations, type ChainSeed } from './behavior-chain-runtime'
import { organizationArgs, organizationForRepository, type Organization } from './organizations'
import { datastoreViewOrCli } from './datastore-reader'
import { getBehaviorChainSettings, getSettings } from './settings'
import { attributedNativeAction, nativeRequestSha } from './behavior-chain-action'
import { resourceReleaseProven } from './behavior-resource-receipt'
import { isExpectedFailure, runFile, spawnDetached } from './process'
import { runDatastoreHealth } from './datastore-health'
import { requireCallerReceipts } from './service/caller-calls'

type Roster = Pick<ChainObservation, 'issueReviewers' | 'prReviewers' | 'implementer' | 'repairer' | 'approver'>
type Invoke = Extract<ChainDecision, { kind: 'invoke' }>
// Caller contains a 30-second GitHub command in a 60-second execution scope.
// Leave the outer client room for startup, receipt commits and teardown too.
const NATIVE_ACTION_TIMEOUT_MS = 120_000

export async function readNativeInvocations(ids: string[], mode: 'strict' | 'resource-recovery' = 'strict') {
  requireCallerReceipts()
  const { stdout } = await runFile('agent-interface', ['--logs', '--select', JSON.stringify({ latest: [], ids: [], correlations: ids,
    ...(mode === 'resource-recovery' ? { resourceRecovery: true } : {}) })],
    { cwd: agentInterfaceCwd(), timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 })
  return parseAgentLogStdout(stdout, 'behavior chain native receipts')
}
export interface NativeChainHooks {
  roster(chainKey: string): Promise<Roster>
  resolve(decision: Invoke, chainKey: string, chain: BehaviorChain, observation: ChainObservation): Promise<ChainReviewer | null>
  prepare(identities: string[]): Promise<NodeJS.ProcessEnv>
  borrow(): (() => void) | null
  available(): boolean
  capacity(): number
  measureHeadroom?: () => BehaviorResourceHeadroom
  permitted(chain: BehaviorChain, decision: Invoke): boolean
  note(behavior: ChainBehavior, chain: BehaviorChain, pull: { number: number } | null): string | Promise<string>
  reviewScope?(chain: BehaviorChain, pull: { number: number }): string | Promise<string>
  severity(behavior: ChainBehavior): string
  received(invocation: ChainInvocation, call: LogEntry): void
  authenticationRejected?(call: LogEntry): void
  authRecovered?: ChainRuntimeOperations['authRecovered']
  reviews(repository: string, number: number): Promise<string>
  existing(seeds: ChainSeed[]): Promise<Set<string>>
  wake(): void
}

function object(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source} returned invalid evidence`)
  return value as Record<string, unknown>
}
function sha(value: unknown, source: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${source} returned no commit identity`)
  return value.toLowerCase()
}
function positive(value: unknown, source: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${source} returned an invalid artifact number`)
  return value
}
async function directory(repository: string): Promise<string> {
  const path = join(tmpdir(), 'poise-gh-interface', ...repository.split('/'))
  await mkdir(path, { recursive: true })
  return path
}
async function github(repository: string, argv: string[], maxOutputBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  const { stdout } = await runFile('github-interface', argv, { cwd: await directory(repository), timeoutMs: 30_000, maxOutputBytes })
  const value = object(JSON.parse(stdout), argv[0])
  if (typeof value.repository === 'string' && value.repository.toLowerCase() !== repository.toLowerCase()) throw new Error('native evidence belongs to another repository')
  return value
}

async function actionPlan(callId: string, digest: unknown): Promise<Record<string, unknown>> {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('native action plan lacks its original digest')
  let stdout: string
  try {
    ({ stdout } = await runFile('agent-interface', ['--read-action-plan', callId], { cwd: agentInterfaceCwd(), timeoutMs: 30_000,
      maxOutputBytes: 2 * 1024 * 1024, expected: { codes: [1],
        stderr: /(?:^|\n)ValueError: native call has no durable publication plan\r?\n?$/ } }))
  } catch (error) {
    if (isExpectedFailure(error)) throw new MissingPublicationPlanError(callId, digest)
    throw error
  }
  const response = object(JSON.parse(stdout), 'native publication plan')
  const plan = object(response.plan, 'native publication plan')
  if (response.id !== callId || response.sha !== digest || chainBasis(plan) !== digest) throw new Error('native publication plan differs from its durable receipt')
  return plan
}

/** Uses the existing datastore/scheduler and Caller primitives. This adapter
 * has no independent polling, synthetic workers, Chat binding or merge bypass. */
export function nativeChainOperations(org: Organization, hooks: NativeChainHooks): ChainRuntimeOperations {
  let discoveryCursor: { repo: string, number: number } = { repo: '', number: 0 }
  const ownsRepository = (repository: string) => organizationForRepository(repository)?.login.toLowerCase() === org.login.toLowerCase()
  const accounts = () => {
    const settings = getSettings()
    if (!settings.me || !settings.agentAccount || settings.me.toLowerCase() === settings.agentAccount.toLowerCase()) throw new Error('behavior chains require two distinct configured GitHub accounts')
    return { author: settings.me, reviewer: settings.agentAccount }
  }
  return {
    enabled: () => getBehaviorChainSettings().enabled,
    accounts,
    ownsRepository,
    available: hooks.available,
    capacity: hooks.capacity,
    measureHeadroom: hooks.measureHeadroom,
    permitted(chain, decision) {
      requireCallerReceipts()
      return hooks.permitted(chain, decision)
    },
    wake: hooks.wake,
    received: hooks.received,
    authenticationRejected: hooks.authenticationRejected,
    authRecovered: hooks.authRecovered,
    async discover(): Promise<ChainSeed[]> {
      await runDatastoreHealth(org, { timeoutMs: 30_000 }, ['review-new-issues'])
      const settings = getBehaviorChainSettings()
      const base = ['view', 'issue', '--status', 'open', '--format', 'json', '--limit', '100',
        ...(settings.seedMode === 'label' ? ['--label', settings.label] : [])]
      // The latest page catches newly labelled old issues immediately; the
      // stable repository/number page drains older intake without truncation.
      const pages = await Promise.all([base, [...base, '--after-repo', discoveryCursor.repo, '--after-number', String(discoveryCursor.number)]].map(async (args) => {
        const rows = await datastoreViewOrCli(org.datastorePath, args, async () =>
          (await runFile('github-datastore', organizationArgs(org, args), { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })).stdout)
        if (!Array.isArray(rows) || rows.length > 100) throw new Error('datastore issue intake returned an invalid page')
        return rows.map((raw) => {
          const row = object(raw, 'issue intake')
          if (typeof row.repo !== 'string' || !ownsRepository(row.repo) || row.status !== 'open') throw new Error('issue intake escaped its followed organization')
          return { repository: row.repo, number: positive(row.number, 'issue intake') }
        })
      }))
      const tail = pages[1].at(-1)
      discoveryCursor = pages[1].length === 100 && tail ? { repo: tail.repository, number: tail.number } : { repo: '', number: 0 }
      const seeds = [...new Map(pages.flat().map((seed) => [`${seed.repository}#${seed.number}`, seed])).values()]
      const existing = await hooks.existing(seeds)
      return seeds.filter((seed) => !existing.has(`${seed.repository.toLowerCase()}#${seed.number}`))
    },
    readInvocations: readNativeInvocations,
    async observe(chain): Promise<ChainObservation> {
      if (!ownsRepository(chain.repository)) throw new Error('behavior chain organization is no longer followed')
      const actor = ['--token-user', chain.author]
      const issueRef = `#${chain.issue}`
      // The chain's draws seed by its seed issue, so every observation
      // refresh re-reads the same roster instead of admitting new slots.
      const chainKey = `${chain.repository}#${chain.issue}`
      const testHold = chain.testHold ?? (!chain.testRecovery?.admission ? chain.testRecovery?.hold : undefined)
      const originalTest = chain.invocations.find(invocation => invocation.id === testHold?.invocationId)
      const testProof = originalTest && implementationTestDependency(originalTest)
      // One process reads the seed issue, its comments and the publication
      // inspection together, reusing their existing projections. The output
      // cap is the sum of the three previous per-read caps, so no facet
      // loses budget; any facet failure still fails the whole observation.
      const [seed, roster] = await Promise.all([
        github(chain.repository, ['--chain-seed', issueRef, '--branch', chain.branch,
          ...(testProof ? ['--test-dependency-json', JSON.stringify(testProof)] : []), ...actor], 3 * 2 * 1024 * 1024),
        hooks.roster(chainKey),
      ])
      if (seed.issue_number !== chain.issue || seed.branch !== chain.branch
        || String(seed.actor).toLowerCase() !== chain.author.toLowerCase()) throw new Error('native seed observation belongs to another chain or actor')
      const rawIssue: Record<string, unknown> = { issue: seed.issue }
      const rawComments: Record<string, unknown> = { comments: seed.comments }
      const publication = object(seed.publication, 'native issue-to-PR ownership evidence')
      const issue = object(rawIssue.issue, 'seed issue')
      if (!Array.isArray(rawComments.comments) || !Array.isArray(issue.labels) || typeof issue.title !== 'string'
        || (issue.body !== null && typeof issue.body !== 'string') || !['open', 'closed'].includes(String(issue.state))) throw new Error('seed issue observation is incomplete')
      const settings = getBehaviorChainSettings()
      const labels = issue.labels.map((label) => typeof label === 'string' ? label : object(label, 'issue label').name)
      if (!Array.isArray(publication.existing_pulls) || publication.existing_pulls.some((url) => typeof url !== 'string')) throw new Error('native issue-to-PR ownership evidence is incomplete')
      const observation: ChainObservation = { checkedAt: Date.now(), existingPulls: publication.existing_pulls, issue: { open: issue.state === 'open',
        revision: chainBasis([issue.title, issue.body || '']), eligible: settings.seedMode === 'all' || labels.some((label) => typeof label === 'string' && label.toLowerCase() === settings.label.toLowerCase()),
        commentIds: rawComments.comments.map((comment) => positive(object(comment, 'issue comment').id, 'issue comment')) }, ...roster,
        publication: { pull_number: publication.pull_number === null ? null : positive(publication.pull_number, 'publication'),
          head_sha: publication.head_sha === null ? null : sha(publication.head_sha, 'publication'), head_invocation: typeof publication.head_invocation === 'string' ? publication.head_invocation : null,
          state: typeof publication.state === 'string' ? publication.state : null, merged: publication.merged === true,
          merge_sha: publication.merge_sha === null ? null : sha(publication.merge_sha, 'publication') }, pull: null }
      if (seed.full_suite) observation.fullSuite = object(seed.full_suite, 'full-suite recovery')
      if (seed.remediation) observation.remediation = object(seed.remediation, 'redundant remediation')
      if (testProof && originalTest) {
        const proof = object(seed.test_dependency, 'implementation test dependency')
        if (proof.verified === true && ['base', 'run', 'runAttempt', 'baselineRun', 'baselineAttempt', 'remediation', 'failures',
          ...(testProof.source === 'relay' ? ['source', 'capture', 'candidate', 'baselineCapture', 'relay', 'totals'] : [])]
          .some(key => chainBasis(proof[key]) !== chainBasis(testProof[key as keyof typeof testProof]))) throw new Error('original implementation test evidence changed')
        const recovery = proof.recovered === true ? object(proof.recovery, 'implementation test recovery') : null
        observation.testDependency = { invocationId: originalTest.id, verified: proof.verified === true, recovered: proof.recovered === true,
          ...(typeof proof.reason === 'string' ? { reason: proof.reason } : {}),
          ...(recovery ? { recovery: { merge: sha(recovery.merge, 'delivered test recovery'), base: sha(recovery.base, 'recovered implementation base'),
            run: object(recovery.run, 'original-test validation run') } } : {}) }
      }
      const pendingReview = chain.invocations.find((invocation) => invocation.state === 'uncertain' && invocation.behavior === 'review-issue')
      if (pendingReview && typeof pendingReview.evidence?.callId === 'string') {
        const artifact = object(pendingReview.evidence.artifact, 'issue review publication receipt')
        const plan = await actionPlan(pendingReview.evidence.callId, artifact.plan_sha)
        if (plan.kind !== 'issue_review' || !Array.isArray(plan.posts) || typeof plan.model !== 'string' || typeof plan.issue_revision !== 'string') throw new Error('native issue review plan is invalid')
        const receipts: NonNullable<ChainObservation['reviewPublication']>['receipts'] = []
        const used = new Set<number>()
        const commentsByIssue = new Map<string, unknown[]>([[`${chain.repository}#${chain.issue}`.toLowerCase(), rawComments.comments]])
        for (const raw of plan.posts) {
          const post = object(raw, 'planned issue review comment')
          const match = /^([^#]+)#([1-9][0-9]*)$/.exec(String(post.issue))
          if (!match || typeof post.body !== 'string') throw new Error('native issue comment plan has an invalid target')
          const ref = String(post.issue).toLowerCase()
          if (!commentsByIssue.has(ref)) {
            const response = await github(match[1], ['--issue-comments', `#${match[2]}`, '--token-user', chain.reviewer])
            if (!Array.isArray(response.comments)) throw new Error('issue review reconciliation has no complete comment list')
            commentsByIssue.set(ref, response.comments)
          }
          const body = `${post.body}\n\n---\n<sub>Issue review · \`${plan.model}\` · rev \`${plan.issue_revision.slice(0, 8)}\`</sub>\n<!-- agent-interface issue-review call=${pendingReview.evidence.callId} -->`
          // A comment an older Caller posted before revision markers has the
          // same terminal call marker without the rev stamp: still this run's
          // receipt, so an upgrade mid-chain does not block on work GitHub
          // already shows.
          const legacy = `${post.body}\n\n---\n<sub>Issue review · \`${plan.model}\`</sub>\n<!-- agent-interface issue-review call=${pendingReview.evidence.callId} -->`
          const found = commentsByIssue.get(ref)!.map((comment) => object(comment, 'published issue review comment')).find((comment) =>
            typeof comment.id === 'number' && !used.has(comment.id) && typeof comment.author === 'string'
              && comment.author.toLowerCase() === chain.reviewer.toLowerCase()
              && (comment.body === body || comment.body === legacy))
          if (found) { const id = positive(found.id, 'published issue comment'); used.add(id);
            receipts.push({ issue: String(post.issue), comment_id: id, author: String(found.author), url: typeof found.url === 'string' ? found.url : null }) }
        }
        observation.reviewPublication = { callId: pendingReview.evidence.callId, planSha: String(artifact.plan_sha), complete: receipts.length === plan.posts.length,
          issueRevision: plan.issue_revision, receipts }
      }
      let number = observation.publication.pull_number
      if (number === null && observation.issue.open && !observation.publication.head_sha) {
        await runDatastoreHealth(org, { timeoutMs: 30_000 }, ['implement-issue'])
        const dependencies = object(publication.prerequisites ?? {}, 'live issue prerequisites')
        const base = typeof publication.base_sha === 'string' && /^[0-9a-f]{40}$/.test(publication.base_sha) ? publication.base_sha : null
        const prerequisites: NonNullable<ChainObservation['prerequisites']> = { wait: null, base, evidence: [dependencies] }
        observation.prerequisites = prerequisites
        if (String(dependencies.repo).toLowerCase() !== chain.repository.toLowerCase() || dependencies.number !== chain.issue
          || dependencies.found !== true || dependencies.complete !== true || !Array.isArray(dependencies.prerequisites)) {
          prerequisites.wait = `GitHub blocked-by evidence is missing or incomplete for ${chain.id}`
        } else if (!base) {
          prerequisites.wait = `Implementation base evidence is missing for ${chain.id}`
        } else {
          for (const raw of dependencies.prerequisites) {
            const dependency = object(raw, 'issue prerequisite')
            if (String(dependency.repo).toLowerCase() !== chain.repository.toLowerCase()) throw new Error('issue prerequisite escaped its repository')
            const issue = positive(dependency.number, 'issue prerequisite')
            const delivery = await github(chain.repository, ['--read-issue', `#${issue}`, '--delivery-base', base, ...actor])
            prerequisites.evidence.push(delivery)
            if (String(delivery.repository).toLowerCase() !== chain.repository.toLowerCase()
              || delivery.issue_number !== issue || delivery.base_sha !== base || delivery.state !== 'closed' || delivery.verified !== true
              || typeof delivery.merge_sha !== 'string' || !/^[0-9a-f]{40}$/.test(delivery.merge_sha)
              || typeof delivery.pull_number !== 'number' || !Number.isSafeInteger(delivery.pull_number) || delivery.pull_number < 1) {
              prerequisites.wait = `Waiting for prerequisite ${chain.repository}#${issue}: ${String(delivery.reason || 'delivery is not verified on the implementation base')}`
              break
            }
          }
        }
      }
      const external = number === null && !observation.issue.open && seed.external_merge
        ? object(seed.external_merge, 'external merge') : null
      if (external) number = positive(external.pull_number, 'external merge')
      if (number === null) return observation
      const interruptedWork = chain.invocations.find((invocation) => invocation.state === 'uncertain' && invocation.behavior === 'repair-pr'
        && typeof invocation.evidence?.callId === 'string' && invocation.evidence.artifact)
      if (interruptedWork) {
        const artifact = object(interruptedWork.evidence!.artifact, 'repair publication receipt')
        const plan = await actionPlan(String(interruptedWork.evidence!.callId), artifact.plan_sha)
        const metadata = object(plan.publication, 'repair publication plan')
        const replies = metadata.replies ?? []
        if (!Array.isArray(replies)) throw new Error('repair publication plan contains invalid replies')
        const inspected = await github(chain.repository, ['--issue-work', issueRef, '--mode', 'inspect', '--branch', chain.branch,
          '--invocation-id', String(interruptedWork.evidence!.callId), '--replies-json', JSON.stringify(replies), ...actor])
        observation.workPublication = { callId: String(interruptedWork.evidence!.callId), repliesComplete: !replies.length || inspected.replies_complete === true,
          resumable: resourceReleaseProven(interruptedWork.evidence!, true)
            && artifact.replies_started === false && artifact.publication_head === observation.publication.head_sha,
          planSha: String(artifact.plan_sha) }
      }
      const reviewer = ['--token-user', chain.reviewer]
      const state = await github(chain.repository, ['--pull-action-state', String(number), '--queue-evidence', ...reviewer])
      if (state.pull_number !== number || !['open', 'closed'].includes(String(state.state))) throw new Error('native pull state is incomplete')
      if (external && (state.state !== 'closed' || state.merged !== true
        || sha(state.merge_sha, 'merged pull') !== sha(external.merge_sha, 'external merge'))) {
        throw new Error('external merge differs from its closing PR evidence')
      }
      if (!observation.issue.open && observation.publication.state === 'closed' && !observation.publication.merged
        && state.state === 'closed' && state.merged === false && seed.external_merge) {
        const closing = object(seed.external_merge, 'external merge')
        const closingNumber = positive(closing.pull_number, 'external merge')
        if (closingNumber === number) throw new Error('external merge conflicts with the unmerged bound PR')
        const merged = await github(chain.repository, ['--pull-action-state', String(closingNumber), '--queue-evidence', ...reviewer])
        if (merged.pull_number !== closingNumber || merged.state !== 'closed' || merged.merged !== true
          || sha(merged.merge_sha, 'merged pull') !== sha(closing.merge_sha, 'external merge')) {
          throw new Error('external merge differs from its closing PR evidence')
        }
        // Keep the closed binding as the target; the closing PR owns no native review obligation.
        observation.externalMerge = { pull_number: closingNumber, merge_sha: sha(merged.merge_sha, 'external merge') }
      }
      const head = sha(state.head_sha, 'pull state')
      const uncertainGrey = chain.invocations.find((invocation) => invocation.behavior === 'rerun-grey-ci' && invocation.state === 'uncertain')
      if (uncertainGrey) {
        const argv = uncertainGrey.request.argv
        const runId = positive(Number(argv[argv.indexOf('--run-id') + 1]), 'admitted grey workflow')
        const attempt = positive(Number(argv[argv.indexOf('--run-attempt') + 1]), 'admitted grey attempt')
        const expected = sha(argv[argv.indexOf('--expected-head') + 1], 'admitted grey head')
        const receipt = await github(chain.repository, ['--rerun-grey-ci-if-ready', String(number), '--inspect',
          '--run-id', String(runId), '--run-attempt', String(attempt), '--expected-head', expected, '--author', chain.author,
          '--token-user', chain.reviewer])
        if (receipt.pull_number !== number || receipt.head_sha !== expected || receipt.run_id !== runId || receipt.run_attempt !== attempt
          || !['rerun_observed', 'superseded', 'unconfirmed'].includes(String(receipt.outcome))) throw new Error(`grey CI recovery evidence is invalid: ${String(receipt.error || receipt.outcome)}`)
        if (receipt.outcome === 'rerun_observed' && positive(receipt.observed_run_attempt, 'observed grey attempt') <= attempt) throw new Error('grey CI recovery did not advance its actual attempt')
        observation.greyRecovery = { invocationId: uncertainGrey.id, receipt }
      }
      const prior = chain.observation as ChainObservation | null
      const headSince = prior?.pull?.head === head ? prior.pull.headSince : Date.now()
      if (typeof state.review_context !== 'string' || !/^[0-9a-f]{64}$/.test(state.review_context) || !Array.isArray(state.my_reviews)) throw new Error('native pull state lacks its review context')
      const reviews = state.my_reviews.map((item) => object(item, 'native review'))
      const reviewReceipts = reviews.filter((review) => review.state !== 'PENDING').map((review) => ({ id: positive(review.id, 'review'),
        head: sha(review.commit_id, 'review commit'), state: String(review.state), invocation: typeof review.invocation_id === 'string' ? review.invocation_id : null,
        response: review.review_response, submittedAt: Date.parse(String(review.submitted_at)) }))
      if (state.merged === true) {
        const mergedAt = Date.parse(String(state.merged_at))
        if (!Number.isFinite(mergedAt) || mergedAt > Date.now()) throw new Error('merged pull lacks its actual merge time')
        observation.pull = { number, head, headSince, state: String(state.state), draft: false, merged: true, mergeSha: sha(state.merge_sha, 'merged pull'),
          queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
          reviewIds: reviewReceipts.filter((review) => review.head === head && review.state !== 'DISMISSED').map((review) => review.id),
          reviewReceipts, reviewContext: state.review_context, mergedAt,
          reviewRevision: prior?.pull?.reviewRevision ?? '', greyRuns: [], pending: false, failing: [], conflict: false, behind: false }
        return observation
      }
      const baseUpdateFrom = chain.held && chain.ciHold && chain.ciHold.head !== head ? chain.ciHold.head : null
      const [readiness, ci, reviewRevision] = await Promise.all([
        github(chain.repository, ['--pr-readiness', String(number), '--username', chain.reviewer, '--expected-head', head, ...reviewer]),
        github(chain.repository, ['--list-failing-ci', String(number),
          ...(baseUpdateFrom ? ['--base-update-from', baseUpdateFrom] : []), ...reviewer]), hooks.reviews(chain.repository, number),
      ])
      if (readiness.head_sha !== head || ci.head_sha !== head || ci.pull_number !== number || !Array.isArray(ci.failing)
        || !Array.isArray(state.my_reviews) || typeof readiness.draft !== 'boolean' || typeof readiness.reviewer_approved_current_head !== 'boolean'
        || !Number.isSafeInteger(readiness.unresolved_live_conversation_count) || Number(readiness.unresolved_live_conversation_count) < 0
        || !Number.isSafeInteger(readiness.unresolved_outdated_conversation_count) || Number(readiness.unresolved_outdated_conversation_count) < 0
        || typeof readiness.green !== 'boolean' || typeof state.merged !== 'boolean'
        || !Array.isArray(readiness.blockers) || readiness.blockers.some((blocker) => typeof blocker !== 'string')
        || (state.queue_entry_id !== null && (typeof state.queue_entry_id !== 'string' || !state.queue_entry_id))
        || (state.state === 'open' && !Array.isArray(state.queue_removals))) throw new Error('native PR observations changed head or are incomplete')
      const checks = ci.failing.map((item) => object(item, 'CI check'))
      let queueEntryDetails: NonNullable<ChainObservation['pull']>['queueEntryDetails'] = null
      if (state.queue_entry_id !== null) {
        const entry = object(state.queue_entry, 'native queue entry')
        if (entry.id !== state.queue_entry_id || !['QUEUED', 'AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'UNMERGEABLE'].includes(String(entry.state))) {
          throw new Error('native queue entry disposition is incomplete or mismatched')
        }
        queueEntryDetails = { id: String(entry.id), state: String(entry.state),
          base: entry.base === null ? null : sha(entry.base, 'queue integration base'),
          head: entry.head === null ? null : sha(entry.head, 'queue integration head') }
      }
      const pending = checks.some((check) => ['queued', 'pending', 'in_progress', 'requested', 'waiting'].includes(String(check.state)) || (check.state === 'completed' && check.conclusion == null))
      const failures = checks.filter((check) => ['failure', 'error'].includes(String(check.state)) || (check.state === 'completed' && ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(String(check.conclusion))))
      if (checks.some((check) => typeof check.name !== 'string' || !['completed', 'queued', 'pending', 'in_progress', 'requested', 'waiting', 'failure', 'error', 'success'].includes(String(check.state)))) throw new Error('native CI observation contains an unknown state')
      if (reviews.some((review) => !['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED', 'DISMISSED', 'PENDING'].includes(String(review.state)))) throw new Error('native review observation contains an unknown state')
      reviews.sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')))
      const latest = reviews.filter((review) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(String(review.state))).at(-1)
      const removals = Array.isArray(state.queue_removals) ? state.queue_removals.map((item) => object(item, 'queue removal')) : []
      const removal = removals.at(-1)
      if (removal && (typeof removal.id !== 'string' || !removal.id || typeof removal.createdAt !== 'string'
        || !Number.isFinite(Date.parse(removal.createdAt)) || Date.parse(removal.createdAt) > Date.now()
        || (removal.reason !== null && typeof removal.reason !== 'string'))) throw new Error('queue removal evidence is incomplete')
      const greyRuns: Array<{ id: number, attempt: number }> = []
      if (failures.length && failures.every((check) => ['cancelled', 'stale', 'timed_out'].includes(String(check.conclusion)))) {
        const batch = await github(chain.repository, ['--grey-ci-candidates', '--requests-json', JSON.stringify([{ repository: chain.repository, number }]), ...reviewer])
        if (!Array.isArray(batch.records) || batch.records.length !== 1) throw new Error('grey CI read is incomplete')
        const record = object(batch.records[0], 'grey CI')
        if (record.error || record.head_sha !== head || !Array.isArray(record.runs)) throw new Error('grey CI read failed or changed head')
        for (const item of record.runs) { const run = object(item, 'grey workflow'); greyRuns.push({ id: positive(run.run_id, 'workflow'), attempt: positive(run.run_attempt, 'workflow attempt') }) }
      }
      observation.pull = { number, head, headSince, state: String(state.state), draft: readiness.draft, merged: false, mergeSha: null,
        queueEntry: typeof state.queue_entry_id === 'string' ? state.queue_entry_id : null,
        queueEntryDetails,
        queueRemoval: removal ? { id: String(removal.id), reason: typeof removal.reason === 'string' ? removal.reason : null,
          at: Date.parse(String(removal.createdAt)), actor: removal.actor ? String(object(removal.actor, 'queue actor').login) : null } : null,
        changesRequested: latest?.state === 'CHANGES_REQUESTED' && latest.commit_id === head,
        unresolved: Number(readiness.unresolved_live_conversation_count), unresolvedOutdated: Number(readiness.unresolved_outdated_conversation_count),
        approved: readiness.reviewer_approved_current_head,
        ready: readiness.green === true, reviewIds: reviews.filter((review) => review.commit_id === head && review.state !== 'DISMISSED').map((review) => positive(review.id, 'review')),
        checksState: typeof readiness.checks_state === 'string' ? readiness.checks_state : null,
        readinessBlockers: readiness.blockers as string[],
        reviewReceipts, reviewContext: state.review_context,
        reviewRevision, greyRuns, pending, failing: failures.map((check) => `${check.name}:${check.conclusion || check.state}`).sort(),
        // The existing readiness primitive already applies the repository's
        // queue policy: BEHIND needs a base update only without a merge queue.
        conflict: ci.mergeable === false, behind: ci.mergeable_state === 'behind' && readiness.blockers.includes('merge_state_not_clean') }
      if (baseUpdateFrom) {
        if (ci.repository !== chain.repository || readiness.repository !== chain.repository || readiness.pull_number !== number
          || ci.ref !== head || observation.publication.head_sha !== head || !('base_update' in ci)) {
          throw new Error('CI base update proof differs from the observed repository, PR or head')
        }
        sha(ci.base_sha, 'CI base update target')
        if (ci.base_update !== null) {
          const update = object(ci.base_update, 'CI base update proof')
          if (update.from !== baseUpdateFrom || !Array.isArray(ci.parents) || ci.parents.length !== 2
            || ci.parents[0] !== baseUpdateFrom || ci.parents[1] !== update.base) throw new Error('CI base update proof differs from the retained failed head or parents')
          observation.ciBaseUpdate = { from: baseUpdateFrom, head,
            base: sha(update.base, 'CI base update parent'), tree: sha(update.tree, 'CI base update tree') }
        }
      }
      const dependency = chainCiDependency(chain, observation.pull.queueRemoval?.id)
      if (dependency) {
        const baseline = await github(chain.repository, ['--list-failing-ci', String(number), '--ref', 'base', ...reviewer])
        if (baseline.head_sha !== head || baseline.ref !== ci.base_sha || !Array.isArray(baseline.checks) || !Array.isArray(baseline.runs)) {
          throw new Error('CI dependency recovery changed candidate/base or lacks complete checks')
        }
        const checks = baseline.checks.map(item => object(item, 'baseline check'))
        const runs = baseline.runs.map(item => object(item, 'baseline workflow'))
        if (checks.some(check => !Number.isSafeInteger(check.check_run_id) || typeof check.name !== 'string'
          || check.head_sha !== baseline.ref)) throw new Error('CI dependency recovery lacks exact check identities')
        observation.ciDependency = { invocationId: dependency.invocation.id, base: sha(baseline.ref, 'baseline recovery'),
          recovered: dependency.dependency.failures.every(failure => {
            // Select within the retained workflow first: another workflow
            // may publish a newer same-named check, which must not shadow
            // the retained workflow's recovery.
            const matching = checks.filter(check => check.name === failure.name && check.head_sha === baseline.ref
              && !['skipped', 'neutral'].includes(String(check.conclusion))
              && runs.some(run => run.id === check.run_id && run.head_sha === baseline.ref && run.workflow_id === failure.workflow
                && ['push', 'workflow_dispatch', 'schedule', 'merge_group'].includes(String(run.event))))
            const latest = matching.sort((a, b) => Number(b.check_run_id) - Number(a.check_run_id))[0]
            return !!latest && latest.state === 'completed' && latest.conclusion === 'success'
          }) }
      }
      return observation
    },
    async request(chain, observation, decision, id) {
      const cwd = await directory(chain.repository)
      const pull = observation.pull
      const common = ['--source', 'poise:behavior-chain', '--correlation-id', id, '--actor', decision.actor]
      const dependency = pull && decision.behavior === 'repair-pr' ? chainCiDependency(chain, pull.queueRemoval?.id) : null
      const note = [await hooks.note(decision.behavior, chain, pull), decision.reason,
        dependency ? `Retained shared baseline CI dependency; keep candidate repairs scoped and do not duplicate its remediation: ${JSON.stringify(dependency.dependency)}` : ''].filter(Boolean).join('\n\n')
      if (decision.reviewer) {
        const selected = await hooks.resolve(decision, `${chain.repository}#${chain.issue}`, chain, observation)
        if (!selected) return null
        const model = ['--model', selected.model, '--recovery-model', selected.recovery]
        if (decision.behavior === 'review-issue') return { command: 'agent-interface', cwd: agentInterfaceCwd(), argv: ['--issue-review', `${chain.repository}#${chain.issue}`,
          ...common, ...model, '--expected-issue-revision', observation.issue.revision, '--note', note] }
        if (decision.behavior === 'implement-issue' || decision.behavior === 'repair-pr') return { command: 'agent-interface', cwd: agentInterfaceCwd(),
          ...(pull ? { context: { head: pull.head, reviewRevision: pull.reviewRevision,
            ...(pull.queueRemoval ? { queueRemoval: pull.queueRemoval.id } : {}) } } : {}), argv: ['--atomic-work', `${chain.repository}#${chain.issue}`,
          ...common, '--model', selected.model, '--branch', chain.branch, '--expected-issue-revision', observation.issue.revision,
          ...(pull ? ['--pull-number', String(pull.number), '--expected-head', pull.head,
            ...(pull.conflict || pull.behind || pull.queueRemoval?.reason === 'merge_conflict' ? ['--merge-base'] : [])] : []), '--note', note] }
        if (!pull) throw new Error('PR behavior requires its actual pull request')
        const scope = await hooks.reviewScope?.(chain, pull) ?? ''
        const reviewNote = scope
          ? `${note}\n\nApply this scope directive when reviewing the remediation. Caller includes it once in the formal GitHub review.\n\n${scope}` : note
        return { command: 'agent-interface', cwd: agentInterfaceCwd(), argv: [decision.behavior === 'review-pr' ? '--pr-review' : '--pr-approve', `https://github.com/${chain.repository}/pull/${pull.number}`,
          ...common, ...model, '--pwd', cwd, '--expected-head', pull.head, '--p', hooks.severity(decision.behavior),
          ...(scope ? ['--review-scope', scope] : []), '--note', reviewNote] }
      }
      if (decision.behavior === 'publish-issue') {
        const partial = [...chain.invocations].reverse().find((invocation) => invocation.callId === observation.publication.head_invocation)
        const artifact = object(partial?.evidence?.artifact, 'publication recovery')
        const plan = await actionPlan(partial?.callId || '', artifact.plan_sha)
        const publication = object(plan.publication, 'publication metadata')
        if (typeof publication.title !== 'string' || typeof publication.body !== 'string' || !partial?.callId || !observation.publication.head_sha) throw new Error('publication recovery lacks its original durable metadata')
        return { command: 'github-interface', cwd, nativeResources: 2, argv: ['--issue-work', String(chain.issue), '--mode', 'complete', '--branch', chain.branch,
          '--expected-head', observation.publication.head_sha, '--invocation-id', partial.callId, '--title', publication.title, '--body', publication.body, '--token-user', chain.author] }
      }
      if (!pull) throw new Error('native PR action requires a verified pull request')
      const fixed = ['--expected-head', pull.head, '--token-user', decision.actor]
      if (decision.behavior === 'retire-pr') return { command: 'github-interface', cwd, nativeResources: 2,
        argv: ['--issue-work', String(chain.issue), '--mode', 'retire', '--branch', chain.branch, '--pull-number', String(pull.number),
          '--coverage-json', JSON.stringify(observation.fullSuite ?? observation.remediation), ...fixed] }
      if (decision.behavior === 'resolve-threads') return { command: 'github-interface', cwd, nativeResources: 2, argv: ['--resolve-nonblocking-conversations-if-ready', String(pull.number), '--username', chain.reviewer, ...fixed] }
      if (decision.behavior === 'rerun-grey-ci') {
        const run = pull.greyRuns[0]
        if (!run) throw new Error('grey CI recovery lacks a native workflow identity')
        return { command: 'github-interface', cwd, nativeResources: 2, argv: ['--rerun-grey-ci-if-ready', String(pull.number), '--run-id', String(run.id), '--run-attempt', String(run.attempt), '--author', chain.author, ...fixed] }
      }
      const reviewed = [...chain.invocations].reverse().find((invocation) => invocation.state === 'settled'
        && invocation.evidence?.status === 'completed' && ['reviewed_clean', 'approved'].includes(String(invocation.evidence.action))
        && chainReviewResponse(chain, invocation, observation, Date.now()))
      if (!reviewed) throw new Error('native merge lacks its retained final-context review response')
      const response = chainReviewResponse(chain, reviewed, observation, Date.now())!
      return { command: 'github-interface', cwd, nativeResources: 2, argv: ['--merge-if-ready', String(pull.number), '--author', chain.author,
        '--review-response-json', JSON.stringify({ ...response, review_id: reviewed.evidence!.review_id }), ...fixed] }
    },
    async launch(invocation, onExit, allowed) {
      if (!allowed()) return false
      requireCallerReceipts()
      // Provider preparation finished after the durable admission, so
      // re-verify measured headroom at the last boundary before spawn. A
      // deferral settles as launch_deferred without consuming an attempt;
      // the next tick's pre-check records the explicit wait reason.
      if (invocation.request.resourceLimits) validateExecutionLimits(invocation.request.resourceLimits, invocation.reservation)
      const reservation = invocation.reservation ?? readBehaviorResourceAdmission()?.reservation
      if (reservation) {
        try {
          if (headroomShortfall((hooks.measureHeadroom ?? measureBehaviorHeadroom)(), reservation)) return false
        } catch {
          return false
        }
      }
      const release = hooks.borrow()
      if (!release) return false
      try {
        const identities = ['--model', '--recovery-model'].flatMap((flag) => { const index = invocation.request.argv.indexOf(flag); return index >= 0 ? [invocation.request.argv[index + 1]] : [] })
        const env = await hooks.prepare(identities)
        if (!allowed()) { release(); return false }
        requireCallerReceipts()
        await spawnDetached('agent-interface', invocation.request.argv, { cwd: invocation.request.cwd, env,
          onExit: (result) => { release(); onExit(result) } })
        return true
      } catch (error) { release(); throw error }
    },
    async fenceClosedTarget(chain, invocation) {
      const behavior = ({ 'review-issue': 'issue_review', 'implement-issue': 'implement_issue', 'repair-pr': 'repair_pr',
        'review-pr': 'pr_review', 'approve-pr': 'pr_approve' } as Partial<Record<ChainBehavior, string>>)[invocation.behavior]
      if (!behavior || invocation.request.command !== 'agent-interface' || !invocation.model) throw new Error('closed-target fence requires the original model invocation')
      const args = invocation.request.argv
      const expected = args.includes('--expected-head') ? args[args.indexOf('--expected-head') + 1] : null
      const target = behavior === 'repair_pr' ? Number(args[args.indexOf('--pull-number') + 1])
        : ['pr_review', 'pr_approve'].includes(behavior) ? Number(/(?:\/pull\/|^#?)([1-9][0-9]*)$/.exec(args[1])?.[1]) : chain.issue
      if (!Number.isSafeInteger(target) || target < 1) throw new Error('closed-target fence lacks the original target number')
      const { stdout } = await runFile('agent-interface', ['--fence-closed-behavior', '--model', invocation.model, '--actor', invocation.actor,
        '--repo', chain.repository, '--number', String(target), '--behavior', behavior, '--correlation-id', invocation.id,
        ...(expected ? ['--expected-head', expected] : [])], { cwd: agentInterfaceCwd(), timeoutMs: 30_000, maxOutputBytes: 16 * 1024 })
      const proof = object(JSON.parse(stdout), 'native closed-target fence')
      if (!/^[0-9a-f]{32}$/.test(String(proof.id)) || !['fenced', 'existing'].includes(String(proof.outcome)) || proof.model !== invocation.model
        || proof.actor !== invocation.actor || proof.repo !== chain.repository || proof.pr_id !== String(target) || proof.behavior !== behavior
        || proof.source !== 'poise:behavior-chain' || proof.correlation_id !== invocation.id || proof.expected_head !== expected) throw new Error('native closed-target fence conflicts with its original admission')
      return proof.outcome === 'fenced'
    },
    async perform(invocation, chain) {
      requireCallerReceipts()
      let stdout: string
      let processFailure: { code: unknown, signal: unknown } | null = null
      try {
        ({ stdout } = await runFile('agent-interface', ['--native-action', '--repository', chain.repository, '--actor', invocation.actor,
          '--source', 'poise:behavior-chain', '--correlation-id', invocation.id, '--request-cwd', invocation.request.cwd,
          ...(invocation.request.nativeResources === 2 ? ['--native-resource-v2'] : []),
          ...(invocation.request.resourceLimits ? ['--resource-limits-json', JSON.stringify(invocation.request.resourceLimits)] : []), '--', ...invocation.request.argv],
        { cwd: agentInterfaceCwd(), timeoutMs: NATIVE_ACTION_TIMEOUT_MS, maxOutputBytes: 256 * 1024 }))
      } catch (error) {
        const failure = error as { stdout?: unknown, code?: unknown, signal?: unknown }
        if (!attributedNativeAction(invocation) || typeof failure.stdout !== 'string' || !failure.stdout.trim()) throw error
        try {
          const response = object(JSON.parse(failure.stdout), 'native action response after process failure')
          object(response.result, 'native action result after process failure')
          if (typeof response.id !== 'string' || !/^[0-9a-f]{32}$/.test(response.id)) throw error
        }
        catch { throw error }
        // The runtime validates the response against the original admission
        // before retaining it. A process failure cannot erase accepted work.
        stdout = failure.stdout
        processFailure = { code: failure.code ?? null, signal: failure.signal ?? null }
      }
      const response = object(JSON.parse(stdout), 'native behavior action')
      if (typeof response.id !== 'string' || !/^[0-9a-f]{32}$/.test(response.id)) throw new Error('native action lacks its original physical Call')
      const evidence: Record<string, unknown> = { ...object(response.result, 'native action result'), nativeCallId: response.id,
        ...(processFailure ? { nativeOuterProcessFailure: processFailure } : {}) }
      if (attributedNativeAction(invocation)) return evidence
      if (evidence.outcome === 'read_failed') return { ...evidence, status: 'failed', action: 'not_started', completedAt: Date.now() }
      const deferred = ['not_ready', 'superseded'].includes(String(evidence.outcome))
        || (invocation.behavior === 'resolve-threads' && evidence.ready_except_conversations !== true)
      return deferred ? { ...evidence, status: 'deferred', action: 'not_started', completedAt: Date.now() } : evidence
    },
    async readActionResult(invocation, call) {
      if (call.artifact?.request_sha !== nativeRequestSha(invocation.request) || typeof call.artifact.response_sha !== 'string') {
        throw new Error('native action response differs from its immutable request')
      }
      const { stdout } = await runFile('agent-interface', ['--read-response', call.id],
        { cwd: agentInterfaceCwd(), timeoutMs: 30_000, maxOutputBytes: 256 * 1024,
          callId: call.id, readerPurpose: 'native-action-receipt' })
      // Caller prints the retained bytes plus one newline. Hash those bytes,
      // not a JavaScript reserialization (Python's 1.0 is JavaScript's 1).
      if (!stdout.endsWith('\n') || createHash('sha256').update(stdout.slice(0, -1)).digest('hex') !== call.artifact.response_sha) {
        throw new Error('native action response differs from its retained digest')
      }
      const result = object(JSON.parse(stdout), 'original native action response')
      return result
    },
    async resumePublication(invocation, head, correlation) {
      requireCallerReceipts()
      const callId = invocation.evidence?.callId
      const artifact = object(invocation.evidence?.artifact, 'repair publication receipt')
      if (typeof callId !== 'string' || !/^[0-9a-f]{32}$/.test(callId) || typeof artifact.plan_sha !== 'string') throw new Error('repair lacks its original native publication identity')
      const { stdout } = await runFile('agent-interface', ['--complete-atomic-publication', callId, artifact.plan_sha, head,
        '--source', 'poise:behavior-chain', '--correlation-id', correlation,
        ...(invocation.request.resourceLimits ? ['--resource-limits-json', JSON.stringify(invocation.request.resourceLimits)] : [])],
        { cwd: agentInterfaceCwd(), timeoutMs: NATIVE_ACTION_TIMEOUT_MS, maxOutputBytes: 256 * 1024 })
      const response = object(JSON.parse(stdout), 'native repair publication completion')
      if (typeof response.id !== 'string' || !/^[0-9a-f]{32}$/.test(response.id)) throw new Error('native publication lacks its physical Call')
      return { ...object(response.result, 'native publication result'), nativeCallId: response.id }
    },
  }
}
