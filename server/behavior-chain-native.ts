import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentInterfaceCwd } from './models'
import { headroomShortfall, measureBehaviorHeadroom, readBehaviorResourceAdmission, type BehaviorResourceHeadroom } from './behavior-resources'
import { parseAgentLogStdout, type LogEntry } from './agent-log-parse'
import { chainBasis, type BehaviorChain, type ChainBehavior, type ChainInvocation } from './behavior-chain-store'
import { chainReviewResponse, type ChainDecision, type ChainObservation, type ChainReviewer } from './behavior-chain-decision'
import type { ChainRuntimeOperations, ChainSeed } from './behavior-chain-runtime'
import { organizationArgs, organizationForRepository, type Organization } from './organizations'
import { getBehaviorChainSettings, getSettings } from './settings'
import { runFile, spawnDetached } from './process'

type Roster = Pick<ChainObservation, 'issueReviewers' | 'prReviewers' | 'implementer' | 'repairer' | 'approver'>
type Invoke = Extract<ChainDecision, { kind: 'invoke' }>
export interface NativeChainHooks {
  roster(chainKey: string): Promise<Roster>
  resolve(decision: Invoke, chainKey: string): Promise<ChainReviewer | null>
  prepare(identities: string[]): Promise<NodeJS.ProcessEnv>
  borrow(): (() => void) | null
  available(): boolean
  capacity(): number
  measureHeadroom?: () => BehaviorResourceHeadroom
  permitted(chain: BehaviorChain, decision: Invoke): boolean
  note(behavior: ChainBehavior): string
  severity(behavior: ChainBehavior): string
  received(invocation: ChainInvocation, call: LogEntry): void
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
  const { stdout } = await runFile('agent-interface', ['--read-action-plan', callId], { cwd: agentInterfaceCwd(), timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024 })
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
    permitted: hooks.permitted,
    wake: hooks.wake,
    received: hooks.received,
    async discover(): Promise<ChainSeed[]> {
      await runFile('github-datastore', organizationArgs(org, ['health', '--max-age-seconds', '120']), { timeoutMs: 30_000 })
      const settings = getBehaviorChainSettings()
      const base = ['view', 'issue', '--status', 'open', '--format', 'json', '--limit', '100',
        ...(settings.seedMode === 'label' ? ['--label', settings.label] : [])]
      // The latest page catches newly labelled old issues immediately; the
      // stable repository/number page drains older intake without truncation.
      const pages = await Promise.all([base, [...base, '--after-repo', discoveryCursor.repo, '--after-number', String(discoveryCursor.number)]].map(async (args) => {
        const { stdout } = await runFile('github-datastore', organizationArgs(org, args), { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })
        const rows: unknown = JSON.parse(stdout)
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
    async readInvocations(ids) {
      const { stdout } = await runFile('agent-interface', ['--logs', '--select', JSON.stringify({ latest: [], ids: [], correlations: ids })],
        { cwd: agentInterfaceCwd(), timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 })
      return parseAgentLogStdout(stdout, 'behavior chain native receipts')
    },
    async observe(chain): Promise<ChainObservation> {
      if (!ownsRepository(chain.repository)) throw new Error('behavior chain organization is no longer followed')
      const actor = ['--token-user', chain.author]
      const issueRef = `#${chain.issue}`
      // The chain's draws seed by its seed issue, so every observation
      // refresh re-reads the same roster instead of admitting new slots.
      const chainKey = `${chain.repository}#${chain.issue}`
      // One process reads the seed issue, its comments and the publication
      // inspection together, reusing their existing projections. The output
      // cap is the sum of the three previous per-read caps, so no facet
      // loses budget; any facet failure still fails the whole observation.
      const [seed, roster] = await Promise.all([
        github(chain.repository, ['--chain-seed', issueRef, '--branch', chain.branch, ...actor], 3 * 2 * 1024 * 1024),
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
        observation.reviewPublication = { callId: pendingReview.evidence.callId, complete: receipts.length === plan.posts.length,
          issueRevision: plan.issue_revision, receipts }
      }
      const number = observation.publication.pull_number
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
          resumable: artifact.replies_started === false && artifact.publication_head === observation.publication.head_sha,
          planSha: String(artifact.plan_sha) }
      }
      const reviewer = ['--token-user', chain.reviewer]
      const state = await github(chain.repository, ['--pull-action-state', String(number), '--queue-evidence', ...reviewer])
      if (state.pull_number !== number || !['open', 'closed'].includes(String(state.state))) throw new Error('native pull state is incomplete')
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
      const [readiness, ci, reviewRevision] = await Promise.all([
        github(chain.repository, ['--pr-readiness', String(number), '--username', chain.reviewer, '--expected-head', head, ...reviewer]),
        github(chain.repository, ['--list-failing-ci', String(number), ...reviewer]), hooks.reviews(chain.repository, number),
      ])
      if (readiness.head_sha !== head || ci.head_sha !== head || ci.pull_number !== number || !Array.isArray(ci.failing)
        || !Array.isArray(state.my_reviews) || typeof readiness.draft !== 'boolean' || typeof readiness.reviewer_approved_current_head !== 'boolean'
        || !Number.isSafeInteger(readiness.unresolved_live_conversation_count) || Number(readiness.unresolved_live_conversation_count) < 0
        || typeof readiness.green !== 'boolean' || typeof state.merged !== 'boolean'
        || !Array.isArray(readiness.blockers) || readiness.blockers.some((blocker) => typeof blocker !== 'string')
        || (state.queue_entry_id !== null && (typeof state.queue_entry_id !== 'string' || !state.queue_entry_id))
        || !Array.isArray(state.queue_removals)) throw new Error('native PR observations changed head or are incomplete')
      const checks = ci.failing.map((item) => object(item, 'CI check'))
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
        queueRemoval: removal ? { id: String(removal.id), reason: typeof removal.reason === 'string' ? removal.reason : null,
          at: Date.parse(String(removal.createdAt)), actor: removal.actor ? String(object(removal.actor, 'queue actor').login) : null } : null,
        changesRequested: latest?.state === 'CHANGES_REQUESTED' && latest.commit_id === head,
        unresolved: Number(readiness.unresolved_live_conversation_count), approved: readiness.reviewer_approved_current_head,
        ready: readiness.green === true, reviewIds: reviews.filter((review) => review.commit_id === head && review.state !== 'DISMISSED').map((review) => positive(review.id, 'review')),
        reviewReceipts, reviewContext: state.review_context,
        reviewRevision, greyRuns, pending, failing: failures.map((check) => `${check.name}:${check.conclusion || check.state}`).sort(),
        // The existing readiness primitive already applies the repository's
        // queue policy: BEHIND needs a base update only without a merge queue.
        conflict: ci.mergeable === false, behind: ci.mergeable_state === 'behind' && readiness.blockers.includes('merge_state_not_clean') }
      return observation
    },
    async request(chain, observation, decision, id) {
      const cwd = await directory(chain.repository)
      const pull = observation.pull
      const common = ['--source', 'poise:behavior-chain', '--correlation-id', id, '--actor', decision.actor]
      const note = [hooks.note(decision.behavior), decision.reason].filter(Boolean).join('\n\n')
      if (decision.reviewer) {
        const selected = await hooks.resolve(decision, `${chain.repository}#${chain.issue}`)
        if (!selected) return null
        const model = ['--model', selected.model, '--recovery-model', selected.recovery]
        if (decision.behavior === 'review-issue') return { command: 'agent-interface', cwd: agentInterfaceCwd(), argv: ['--issue-review', `${chain.repository}#${chain.issue}`,
          ...common, ...model, '--expected-issue-revision', observation.issue.revision, '--note', note] }
        if (decision.behavior === 'implement-issue' || decision.behavior === 'repair-pr') return { command: 'agent-interface', cwd: agentInterfaceCwd(),
          ...(pull ? { context: { head: pull.head, reviewRevision: pull.reviewRevision,
            ...(pull.queueRemoval ? { queueRemoval: pull.queueRemoval.id } : {}) } } : {}), argv: ['--atomic-work', `${chain.repository}#${chain.issue}`,
          ...common, '--model', selected.model, '--branch', chain.branch, '--expected-issue-revision', observation.issue.revision,
          ...(pull ? ['--pull-number', String(pull.number), '--expected-head', pull.head, ...(pull.conflict || pull.behind || pull.queueRemoval ? ['--merge-base'] : [])] : []), '--note', note] }
        if (!pull) throw new Error('PR behavior requires its actual pull request')
        return { command: 'agent-interface', cwd: agentInterfaceCwd(), argv: [decision.behavior === 'review-pr' ? '--pr-review' : '--pr-approve', `https://github.com/${chain.repository}/pull/${pull.number}`,
          ...common, ...model, '--pwd', cwd, '--expected-head', pull.head, '--p', hooks.severity(decision.behavior), '--note', note] }
      }
      if (decision.behavior === 'publish-issue') {
        const partial = [...chain.invocations].reverse().find((invocation) => invocation.callId === observation.publication.head_invocation)
        const artifact = object(partial?.evidence?.artifact, 'publication recovery')
        const plan = await actionPlan(partial?.callId || '', artifact.plan_sha)
        const publication = object(plan.publication, 'publication metadata')
        if (typeof publication.title !== 'string' || typeof publication.body !== 'string' || !partial?.callId || !observation.publication.head_sha) throw new Error('publication recovery lacks its original durable metadata')
        return { command: 'github-interface', cwd, argv: ['--issue-work', String(chain.issue), '--mode', 'complete', '--branch', chain.branch,
          '--expected-head', observation.publication.head_sha, '--invocation-id', partial.callId, '--title', publication.title, '--body', publication.body, '--token-user', chain.author] }
      }
      if (!pull) throw new Error('native PR action requires a verified pull request')
      const fixed = ['--expected-head', pull.head, '--token-user', decision.actor]
      if (decision.behavior === 'resolve-threads') return { command: 'github-interface', cwd, argv: ['--resolve-nonblocking-conversations-if-ready', String(pull.number), '--username', chain.reviewer, ...fixed] }
      if (decision.behavior === 'rerun-grey-ci') {
        const run = pull.greyRuns[0]
        if (!run) throw new Error('grey CI recovery lacks a native workflow identity')
        return { command: 'github-interface', cwd, argv: ['--rerun-grey-ci-if-ready', String(pull.number), '--run-id', String(run.id), '--run-attempt', String(run.attempt), '--author', chain.author, ...fixed] }
      }
      const reviewed = [...chain.invocations].reverse().find((invocation) => invocation.state === 'settled'
        && invocation.evidence?.status === 'completed' && ['reviewed_clean', 'approved'].includes(String(invocation.evidence.action))
        && chainReviewResponse(chain, invocation, observation, Date.now()))
      if (!reviewed) throw new Error('native merge lacks its retained final-context review response')
      const response = chainReviewResponse(chain, reviewed, observation, Date.now())!
      return { command: 'github-interface', cwd, argv: ['--merge-if-ready', String(pull.number), '--author', chain.author,
        '--review-response-json', JSON.stringify({ ...response, review_id: reviewed.evidence!.review_id }), ...fixed] }
    },
    async launch(invocation, onExit, allowed) {
      // Provider preparation finished after the durable admission, so
      // re-verify measured headroom at the last boundary before spawn. A
      // deferral settles as launch_deferred without consuming an attempt;
      // the next tick's pre-check records the explicit wait reason.
      const resources = readBehaviorResourceAdmission()
      if (resources) {
        try {
          if (headroomShortfall((hooks.measureHeadroom ?? measureBehaviorHeadroom)(), resources.reservation)) return false
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
        await spawnDetached('agent-interface', invocation.request.argv, { cwd: invocation.request.cwd, env,
          onExit: (result) => { release(); onExit(result) } })
        return true
      } catch (error) { release(); throw error }
    },
    async perform(invocation) {
      const { stdout } = await runFile('github-interface', invocation.request.argv, { cwd: invocation.request.cwd, timeoutMs: 30_000, maxOutputBytes: 256 * 1024 })
      const evidence = object(JSON.parse(stdout), 'native behavior action')
      if (evidence.outcome === 'read_failed') return { ...evidence, status: 'failed', action: 'not_started', completedAt: Date.now() }
      const deferred = ['not_ready', 'superseded'].includes(String(evidence.outcome))
        || (invocation.behavior === 'resolve-threads' && evidence.ready_except_conversations !== true)
      return deferred ? { ...evidence, status: 'deferred', action: 'not_started', completedAt: Date.now() } : evidence
    },
    async resumePublication(invocation, head) {
      const callId = invocation.evidence?.callId
      const artifact = object(invocation.evidence?.artifact, 'repair publication receipt')
      if (typeof callId !== 'string' || !/^[0-9a-f]{32}$/.test(callId) || typeof artifact.plan_sha !== 'string') throw new Error('repair lacks its original native publication identity')
      const { stdout } = await runFile('agent-interface', ['--complete-atomic-publication', callId, artifact.plan_sha, head],
        { cwd: agentInterfaceCwd(), timeoutMs: 30_000, maxOutputBytes: 256 * 1024 })
      return object(JSON.parse(stdout), 'native repair publication completion')
    },
  }
}
