import { createHmac, timingSafeEqual } from 'node:crypto'
import type { McpGrantScope, McpWorkArguments } from '../gateway/src/mcp-contract'
import { readBehaviorLedger } from './behavior-ledger'
import type { LedgerHealth, LedgerReadReply, LedgerRecord } from './behavior-ledger-contract'
import { CHAIN_OBSERVATION_MAX_AGE_MS, type ChainObservation } from './behavior-chain-decision'
import { BehaviorChainJournal, chainIdentity, type BehaviorChain } from './behavior-chain-store'
import { behaviorChainSummary } from './behavior-chain-summary'
import { db } from './db'
import { runDatastoreHealth, staleDatastoreFailure, validatedHealth } from './datastore-health'
import { requireConfiguredRepository, type DatastoreRecord } from './gh'
import { HttpError } from './http'
import { organizationArgs, organizationForRepository, type Organization } from './organizations'
import { datastoreViewOrCli } from './datastore-reader'
import { runFile } from './process'
import type { ServiceConfig } from './service/config'

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
  const scope = JSON.stringify([grant.resource, grant.ownerId, grant.handle, args.repository.toLowerCase(), args.label, args.limit])
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
  ledgerShortCircuit: { reply: LedgerReadReply | null }) {
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
  return { repository: issue.repo, issue: issue.number, title: issue.title.slice(0, 1024), state: issue.status, author: issue.author,
    ageMs: Number.isFinite(created) ? Math.max(0, now - created) : null,
    stage, step: active?.behavior ?? latest?.behavior ?? null, stageSince: latest ? new Date(latest.admittedAt).toISOString() : null,
    blocker, reviewStatus: summary?.reviewStatus ?? 'not-recorded', mergeSha: summary?.mergeSha ?? null,
    chain: chain ? { id: chain.id, sequence: chain.sequence, author: chain.author, reviewer: chain.reviewer } : null,
    coverage: { chain: chainCoverage, observation: observationCoverage, receipts: coverage(missingReceipt || omittedInvocations ? 'partial' : chainCoverage.status,
      chainCoverage.observedAt, missingReceipt ? 'Original Call or receipt evidence is not recorded'
        : omittedInvocations ? 'Only the latest five invocations are included' : chainCoverage.reason) },
    receipts, omittedInvocations, ledger,
    github: observation?.pull ? { observedAt: observationCoverage.observedAt, head, merged: observation.pull.merged,
      mergeSha: observation.pull.mergeSha, checks: { pending: observation.pull.pending, failing: observation.pull.failing.slice(0, 10) },
      queueEntry: observation.pull.queueEntry } : null,
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

export async function readMcpWork(args: McpWorkArguments, service: ServiceConfig, grant: McpGrantScope) {
  requireConfiguredRepository(args.repository)
  const org = organizationForRepository(args.repository)
  if (!org || org.status !== 'ready') throw new HttpError(403, 'repository is outside the ready workspace accounts')
  const after = args.issue ? null : pageCursor(args, grant)
  const limit = args.issue ? 1 : args.limit ?? 5
  // Pass the label as one --label=value argument so accepted labels starting
  // with a dash are not mistaken for another option by argparse.
  const filters = args.issue ? ['--number', String(args.issue)] : [`--label=${args.label!}`,
    '--after-repo', after!.repo, '--after-number', String(after!.number)]
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
      || row.author !== null && typeof row.author !== 'string')) throw new Error('datastore returned an invalid work page')
  } catch (error) { rows = []; source = coverage('unavailable', source.observedAt, message(error)) }
  const selected = rows.slice(0, limit)
  const now = Date.now()
  const ledgerShortCircuit: { reply: LedgerReadReply | null } = { reply: null }
  const items: Array<Awaited<ReturnType<typeof workItem>>> = []
  for (const issue of selected) {
    items.push(await workItem(issue, service, source, now, ledgerShortCircuit))
  }
  const last = selected.at(-1)
  return { repository: args.repository, issue: args.issue ?? null, label: args.label ?? null, observedAt: new Date(now).toISOString(),
    coverage: { issues: source }, items,
    nextCursor: rows.length > limit && last ? pageCursor(args, grant, { repo: last.repo, number: last.number }) : null }
}
