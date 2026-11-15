import { createHmac, timingSafeEqual } from 'node:crypto'
import { mcpRepositoryAllowed, type McpGrantScope, type McpWorkArguments } from '../gateway/src/mcp-contract'
import { readBehaviorLedger } from './behavior-ledger'
import type { LedgerHealth, LedgerReadReply, LedgerRecord } from './behavior-ledger-contract'
import { CHAIN_OBSERVATION_MAX_AGE_MS, decideBehaviorChain, type ChainObservation } from './behavior-chain-decision'
import { BehaviorChainJournal, chainIdentity, type BehaviorChain } from './behavior-chain-store'
import { behaviorChainSummary } from './behavior-chain-summary'
import { db } from './db'
import { runDatastoreHealth, staleDatastoreFailure, validatedHealth } from './datastore-health'
import { requireConfiguredRepository, type DatastoreRecord } from './gh'
import { HttpError } from './http'
import { readLivePull } from './mcp-live-pull'
import { organizationArgs, organizationForRepository, type Organization } from './organizations'
import { datastoreViewOrCli } from './datastore-reader'
import { runFile } from './process'
import type { ServiceConfig } from './service/config'
import { getBehaviorChainSettings, type BehaviorChainSettings } from './settings'

type CoverageStatus = 'fresh' | 'stale' | 'partial' | 'unavailable'
interface Coverage { status: CoverageStatus; observedAt: string | null; reason: string | null }
type WorkIssue = Omit<DatastoreRecord, 'author'> & { author: string | null }
const coverage = (status: CoverageStatus, observedAt: string | null, reason: string | null = null): Coverage => ({ status, observedAt, reason })
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1024)
const preview = (value: string | null) => value === null ? null : value.slice(0, 1024)

/** The private grant identity authenticates continuation within that grant,
 * including across access-token rotation. No workspace-wide cursor state. */
function pageCursor(args: McpWorkArguments, grant: McpGrantScope): { repo: string; number: number }
function pageCursor(args: McpWorkArguments, grant: McpGrantScope, after: { repo: string; number: number }): string
function pageCursor(args: McpWorkArguments, grant: McpGrantScope, after?: { repo: string; number: number }) {
  const scope = JSON.stringify([grant.resource, grant.ownerId, grant.handle, args.repository.toLowerCase(), args.label, args.limit,
    ...(args.since || args.until ? [args.since ?? null, args.until ?? null] : [])])
  const sign = (payload: string) => createHmac('sha256', grant.grantId).update(scope).update(payload).digest()
  if (after) {
    const payload = Buffer.from(JSON.stringify(after)).toString('base64url')
    return `${payload}.${sign(payload).toString('base64url')}`
  }
  if (!args.cursor) return { repo: '', number: 0 }
  try {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(args.cursor)) throw new Error('encoding')
    const [payload, signature, extra] = args.cursor.split('.')
    const expected = sign(payload), actual = Buffer.from(signature, 'base64url')
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('signature')
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (!value || typeof value !== 'object' || !('repo' in value) || !('number' in value)
      || typeof value.repo !== 'string' || value.repo.toLowerCase() !== args.repository.toLowerCase()
      || !Number.isSafeInteger(value.number) || Number(value.number) < 1) throw new Error('scope')
    return { repo: value.repo, number: Number(value.number) }
  } catch { throw new HttpError(400, 'invalid work cursor for this grant and selector') }
}

async function mirrorCoverage(org: Organization): Promise<Coverage> {
  try {
    const result = await runDatastoreHealth(org, { timeoutMs: 5000, maxOutputBytes: 16 * 1024 })
    const health = validatedHealth(result.stdout, org)
    if (result.stale) return coverage('stale', result.stale.episode.latest.lastSuccessAt, result.stale.message)
    if (!health) throw new Error('datastore freshness evidence is unavailable')
    return coverage(health.status === 'stale' ? 'stale' : org.error ? 'partial' : 'fresh', health.evidence.lastSuccessAt, org.error)
  } catch (error) {
    const stale = staleDatastoreFailure(error)
    return stale ? coverage('stale', stale.episode.latest.lastSuccessAt, stale.message) : coverage('unavailable', null, message(error))
  }
}

function ledgerCoverage(reply: LedgerReadReply): Coverage {
  const health = reply.body.health
  const status = reply.status !== 200 || ['unavailable', 'stopped'].includes(health.status) ? 'unavailable'
    : health.status === 'stale' ? 'stale' : health.status === 'incomplete' || health.pending > 0 || reply.body.nextCursor ? 'partial' : 'fresh'
  return coverage(status, health.observedAt, reply.body.error ?? (reply.body.nextCursor ? 'Only the first five target receipts are included' : null))
}

async function workItem(issue: WorkIssue, service: ServiceConfig, mirror: Coverage, now: number,
  ledgerShortCircuit: { reply: LedgerReadReply | null }, label: string | undefined, intake: BehaviorChainSettings | null, live?: true) {
  let chain: BehaviorChain | null = null
  let chainCoverage = coverage('fresh', new Date(now).toISOString())
  let summary: ReturnType<typeof behaviorChainSummary> | null = null
  try {
    // Exact verified projection read: the ordinary singleton's initial whole-
    // journal verification is not a request-scoped work-trail scan.
    const journal = new BehaviorChainJournal(db)
    chain = journal.read(chainIdentity(issue.repo, issue.number))
    if (chain) summary = behaviorChainSummary(chain, journal)
  } catch (error) { chainCoverage = coverage('unavailable', null, message(error)); chain = null }
  const observation = chain?.observation as ChainObservation | null
  const checkedAt = observation?.checkedAt
  const observationCoverage = typeof checkedAt !== 'number' || !Number.isFinite(checkedAt) || checkedAt > now
    ? coverage('unavailable', null, 'No valid chain observation recorded')
    : coverage(now - checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS ? 'stale' : 'fresh', new Date(checkedAt).toISOString())
  const pullNumber = summary?.pullNumber ?? null
  const openPull = observation?.pull?.state === 'open' && !observation.pull.merged ? observation.pull : null
  const targets = [...new Set([issue.number, ...(pullNumber ? [pullNumber] : [])])]
  // Ledger reads stay sequential: a full page fans out to two targets per
  // issue against the worker's bounded read slots, so parallel reads
  // deterministically return ledger_busy. Once the ledger proves unresponsive
  // for this page, remaining targets reuse that unavailable evidence instead of
  // paying another two-second read each and exceeding the gateway deadline.
  const ledger: Array<{ number: number; coverage: Coverage; health: LedgerHealth; hasMore: boolean;
    records: Array<Pick<LedgerRecord, 'id' | 'behavior' | 'state' | 'activity' | 'outcome' | 'head' | 'startedAt' | 'completedAt' | 'refs'>> }> = []
  for (const number of targets) {
    if (ledgerShortCircuit.reply) {
      ledger.push({ number, coverage: ledgerCoverage(ledgerShortCircuit.reply), health: ledgerShortCircuit.reply.body.health, hasMore: false,
        records: [] })
      continue
    }
    const reply = await readBehaviorLedger({ operation: 'list', repository: issue.repo, number, limit: 5 })
    if (reply.status !== 200 || reply.body.health.status === 'unavailable' || reply.body.health.status === 'stopped') ledgerShortCircuit.reply = reply
    ledger.push({ number, coverage: ledgerCoverage(reply), health: reply.body.health, hasMore: !!reply.body.nextCursor,
      records: (reply.body.records ?? []).map(record => ({ id: record.id, behavior: record.behavior, state: record.state,
        activity: record.activity, outcome: record.outcome, head: record.head, startedAt: record.startedAt,
        completedAt: record.completedAt, refs: record.refs })) })
  }
  const active = chain?.invocations.find(invocation => invocation.state !== 'settled')
  const latest = chain?.invocations.at(-1)
  const receipts = (summary?.invocations ?? []).slice(-5).map(invocation => ({ id: invocation.id,
    behavior: invocation.behavior, state: invocation.state, callId: invocation.callId, outcome: invocation.outcome,
    admittedAt: invocation.admittedAt, nativeAction: invocation.nativeAction,
    evidence: invocation.evidence ? { action: invocation.evidence.action, outcome: invocation.evidence.outcome,
      reviewId: invocation.evidence.review_id, head: invocation.evidence.head_sha } : null,
    // Verified native-action receipts carry no Call by design; only an unverified native action counts as a gap.
    coverage: ((invocation.callId && invocation.evidence)
      || invocation.nativeAction?.attribution === 'accepted-response' || invocation.nativeAction?.attribution === 'observed-no-action')
      ? 'recorded' : 'not-recorded',
  }))
  // Deliberately settled not_started attempts (launch_deferred, spawn_failed and
  // other pre-launch deferrals) carry no Call by design; only a settled attempt
  // that should have produced a receipt counts as a gap.
  const missingReceipt = receipts.some(receipt => receipt.state !== 'admitted' && receipt.state !== 'started' && receipt.coverage === 'not-recorded'
    && receipt.evidence?.action !== 'not_started')
  const omittedInvocations = Math.max(0, (summary?.invocationCount ?? 0) - receipts.length)
  let stage = 'unknown'
  let blocker = chainCoverage.reason
  if (chain) {
    stage = chain.mergeSha ? chain.reviewPending === false ? 'complete' : chain.reviewPending === true ? 'merged_review_pending' : 'merged_review_not_recorded'
      : chain.supersession ? 'superseded' : chain.held ? 'held' : active?.state === 'uncertain' ? 'unknown'
        : active ? active.state === 'admitted' ? 'admitted' : missingReceipt ? 'unknown' : 'running' : summary?.waiting ? 'delayed'
          : latest?.evidence?.status === 'failed' && latest.admissionSequence > chain.resumedAfterSequence ? 'failed' : 'waiting'
    // A merge preserves the earlier wait reason; it is not the current blocker once merged.
    blocker = preview(chain.held ?? (chain.mergeSha ? null : summary?.waiting) ?? (chain.reviewPending ? 'Original pre-merge review proof is pending'
      : active?.state === 'uncertain' ? active.outcome ?? 'Original invocation receipt is unavailable'
        : missingReceipt ? 'Original Call or receipt evidence is not recorded' : null))
  } else if (chainCoverage.status === 'fresh' && mirror.status === 'fresh' && ledger.every(source => source.coverage.status === 'fresh')) {
    const records = ledger.flatMap(source => source.records)
    stage = records.length ? 'recorded' : 'not_recorded'
  }
  const origin = service.publicOrigin
  const github = `https://github.com/${issue.repo}`
  const pullUrl = pullNumber ? `${github}/pull/${pullNumber}` : null
  const head = observation?.pull?.number === pullNumber ? observation.pull.head : null
  const calls = [...new Set([...receipts.flatMap(receipt => receipt.callId ? [receipt.callId] : []),
    ...ledger.flatMap(source => source.records.flatMap(record => record.refs.filter(ref => ref.kind === 'caller' && ref.availability === 'available').map(ref => ref.identity)))
  ].filter(id => /^[a-f0-9]{32}$/i.test(id)))]
  const reviews = receipts.flatMap(receipt => typeof receipt.evidence?.reviewId === 'number' && pullUrl
    ? [`${pullUrl}#pullrequestreview-${receipt.evidence.reviewId}`] : [])
  const created = Date.parse(issue.created_at)
  const eligible = observationCoverage.status === 'fresh' && observation
    ? typeof observation.issue?.eligible === 'boolean' ? observation.issue.open && observation.issue.eligible : null
    : mirror.status !== 'fresh' || !intake ? null : issue.status !== 'open' ? false
      : intake.seedMode === 'all' || label?.toLowerCase() === intake.label.toLowerCase() ? true : null
  const next = nextWorkAction(stage, blocker, chain, active, observation, observationCoverage, now, eligible)
  return { repository: issue.repo, issue: issue.number, title: issue.title.slice(0, 1024), state: issue.status, author: issue.author,
    createdAt: issue.created_at, ageMs: Number.isFinite(created) ? Math.max(0, now - created) : null,
    intake: { eligible, enabled: intake?.enabled ?? null, seedMode: intake?.seedMode ?? null, configuredLabel: intake?.seedMode === 'label' ? intake.label : null,
      selectedLabel: label ?? null, labelAppliedAt: null,
      labelHistoryCoverage: coverage('unavailable', null, 'The mirror records current label membership; label application history is not retained') },
    stage, step: active?.behavior ?? latest?.behavior ?? null, stageSince: latest ? new Date(latest.admittedAt).toISOString() : null,
    blocker, next, reviewStatus: summary?.reviewStatus ?? 'not-recorded', mergeSha: summary?.mergeSha ?? null,
    chain: chain ? { id: chain.id, sequence: chain.sequence, author: chain.author, reviewer: chain.reviewer } : null,
    coverage: { chain: chainCoverage, observation: observationCoverage, receipts: coverage(missingReceipt || omittedInvocations ? 'partial' : chainCoverage.status,
      chainCoverage.observedAt, missingReceipt ? 'Original Call or receipt evidence is not recorded'
        : omittedInvocations ? 'Only the latest five invocations are included' : chainCoverage.reason) },
    receipts, omittedInvocations, ledger,
    ...(live ? { liveGitHub: observation?.externalMerge
      ? await readLivePull(issue.repo, observation.externalMerge.pull_number, null, observation.externalMerge.merge_sha)
      : pullNumber ? await readLivePull(issue.repo, pullNumber, head, summary?.mergeSha ?? null)
      : { source: 'Live GitHub through Caller', observedAt: new Date(now).toISOString(), coverage: 'unavailable', record: null,
        reason: 'No exact PR binding is recorded for this issue' } } : {}),
    github: observation?.pull ? { observedAt: observationCoverage.observedAt, head, merged: observation.pull.merged,
      mergeSha: observation.pull.mergeSha, checks: { pending: observation.pull.pending, failing: observation.pull.failing.slice(0, 10) },
      queueEntry: observation.pull.queueEntry, approved: openPull?.approved ?? null, changesRequested: openPull?.changesRequested ?? null,
      unresolvedThreads: openPull?.unresolved ?? null, conflicts: openPull?.conflict ?? null, behind: openPull?.behind ?? null } : null,
    links: { issue: `${github}/issues/${issue.number}`,
      chain: chain ? `${origin}/api/behavior-chains?id=${encodeURIComponent(chain.id)}` : null,
      calls: calls.map(id => ({ id, url: `${origin}/api/agent-response/${id}` })), pr: pullUrl,
      review: pullUrl ? `${pullUrl}/files` : null, reviews,
      ci: pullUrl && head ? `${pullUrl}/checks?sha=${encodeURIComponent(head)}` : null,
      queue: observation?.pull?.queueEntry ? `${github}/queue` : null,
      merge: summary?.mergeSha ? `${github}/commit/${summary.mergeSha}` : null,
      ledger: `${origin}/api/behavior-ledger?repository=${encodeURIComponent(issue.repo)}&number=${issue.number}` },
  }
}

function nextWorkAction(stage: string, blocker: string | null, chain: BehaviorChain | null, active: BehaviorChain['invocations'][number] | undefined,
  observation: ChainObservation | null, source: Coverage, now: number, eligible: boolean | null) {
  if (stage === 'complete' || stage === 'superseded' || stage === 'merged_review_not_recorded') return null
  if (stage === 'unknown') return { actor: 'workspace-owner', action: 'inspect-evidence', reason: blocker ?? 'Coverage is incomplete' }
  if (active) return { actor: active.actor, action: 'await-original-receipt', reason: blocker }
  if (stage === 'held') return { actor: 'workspace-owner', action: 'inspect-hold', reason: blocker }
  if (stage === 'merged_review_pending') return { actor: 'workspace-owner', action: 'inspect-original-review', reason: blocker }
  if (stage === 'delayed') return { actor: 'poise', action: 'recheck-admission', reason: blocker }
  if (observation?.pull?.queueEntry && source.status === 'fresh') return { actor: 'github', action: 'observe-queue', reason: blocker }
  if (chain && observation && source.status === 'fresh' && !chain.mergeSha) {
    try {
      const decision = decideBehaviorChain(chain, observation, now)
      if (decision.kind === 'invoke') return { actor: decision.actor, action: decision.behavior, reason: preview(decision.reason) }
      if (decision.kind === 'wait') return { actor: 'poise', action: 'observe', reason: preview(decision.reason) }
      if (decision.kind === 'hold') return { actor: 'workspace-owner', action: 'inspect-prerequisites', reason: preview(decision.reason) }
    } catch { return { actor: 'poise', action: 'refresh-observation', reason: 'The retained observation cannot establish the next action' } }
  }
  if (chain) return { actor: 'poise', action: 'refresh-observation', reason: source.reason }
  return eligible === true ? { actor: 'poise', action: 'check-intake', reason: null } : null
}

export async function readMcpWork(args: McpWorkArguments, service: ServiceConfig, grant: McpGrantScope) {
  if (!mcpRepositoryAllowed(grant, args.repository)) throw new HttpError(403, 'repository is outside this grant')
  requireConfiguredRepository(args.repository)
  const org = organizationForRepository(args.repository)
  if (!org || org.status !== 'ready') throw new HttpError(403, 'repository is outside the ready workspace accounts')
  const after = args.issue ? null : pageCursor(args, grant)
  const limit = args.issue ? 1 : args.limit ?? 5
  // Pass the label as one --label=value argument so accepted labels starting
  // with a dash are not mistaken for another option by argparse.
  const filters = args.issue ? ['--number', String(args.issue)] : [`--label=${args.label!}`,
    '--after-repo', after!.repo, '--after-number', String(after!.number),
    ...(args.since ? ['--created-since-datetime', args.since] : []), ...(args.until ? ['--created-before-datetime', args.until] : [])]
  let source = await mirrorCoverage(org)
  let rows: WorkIssue[] = []
  try {
    const view = ['view', 'issue', '--repo', args.repository, ...filters, '--limit', String(args.issue ? 1 : limit + 1), '--format', 'json']
    const value = await datastoreViewOrCli(org.datastorePath, view, async () =>
      (await runFile('github-datastore', organizationArgs(org, view), { timeoutMs: 10_000, maxOutputBytes: 512 * 1024 })).stdout)
    if (!Array.isArray(value)) throw new Error('datastore returned an invalid work page')
    rows = value as WorkIssue[]
    if (rows.length > (args.issue ? 1 : limit + 1) || rows.some(row => row.repo.toLowerCase() !== args.repository.toLowerCase()
      || !Number.isSafeInteger(row.number) || row.number < 1 || args.issue !== undefined && row.number !== args.issue
      || typeof row.title !== 'string' || typeof row.created_at !== 'string'
      || args.since !== undefined && !(Date.parse(row.created_at) >= Date.parse(args.since))
      || args.until !== undefined && !(Date.parse(row.created_at) < Date.parse(args.until))
      || row.author !== null && typeof row.author !== 'string')) throw new Error('datastore returned an invalid work page')
  } catch (error) { rows = []; source = coverage('unavailable', source.observedAt, message(error)) }
  const selected = rows.slice(0, limit)
  const now = Date.now()
  const ledgerShortCircuit: { reply: LedgerReadReply | null } = { reply: null }
  const items: Array<Awaited<ReturnType<typeof workItem>>> = []
  let intake: BehaviorChainSettings | null = null
  try { intake = getBehaviorChainSettings() } catch { /* corrupt intake settings cannot establish eligibility */ }
  for (const issue of selected) {
    items.push(await workItem(issue, service, source, now, ledgerShortCircuit, args.label, intake, args.live))
  }
  const last = selected.at(-1)
  return { repository: args.repository, issue: args.issue ?? null, label: args.label ?? null, observedAt: new Date(now).toISOString(),
    window: { basis: 'issue_created_at', since: args.since ?? null, until: args.until ?? null },
    coverage: { issues: source }, items,
    nextCursor: rows.length > limit && last ? pageCursor(args, grant, { repo: last.repo, number: last.number }) : null }
}
