import { mcpRepositoryAllowed, type McpGrantScope, type McpPullArguments } from '../gateway/src/mcp-contract'
import { fetchSelectedAgentLogSnapshot, type LogEntry } from './agent'
import { readBehaviorLedger } from './behavior-ledger'
import { requireConfiguredRepository } from './gh'
import { HttpError } from './http'
import { readLivePull } from './mcp-live-pull'
import { organizationForRepository } from './organizations'

function failure(row: LogEntry) {
  const value = row.artifact?.github_failure as Record<string, unknown> | undefined
  if (value && value.call_id === row.id && ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(String(value.method))
    && ['graphql query', 'graphql mutation', 'pull request reviews', 'pull request', 'other GitHub request'].includes(String(value.operation))
    && (value.status === null || Number.isInteger(value.status) && Number(value.status) >= 400 && Number(value.status) <= 599)
    && ['none', 'uncertain'].includes(String(value.submission))) {
    return { method: value.method, operation: value.operation, status: value.status, submission: value.submission }
  }
  const status = /(?:^|\n)(?:error: )?GitHub (\d{3})(?: rate-limit)?:/.exec(row.error ?? '')?.[1]
  if (row.status !== 'failed') return null
  return { method: null, operation: null, status: status && Number(status) >= 400 && Number(status) <= 599 ? Number(status) : null,
    submission: 'unknown' }
}

export async function readMcpPull(args: McpPullArguments, grant: McpGrantScope) {
  if (!grant.pullDiagnostics) throw new HttpError(403, 'pull request diagnostics consent is required')
  if (!mcpRepositoryAllowed(grant, args.repository)) throw new HttpError(403, 'repository is outside this grant')
  requireConfiguredRepository(args.repository)
  if (organizationForRepository(args.repository)?.status !== 'ready') throw new HttpError(403, 'repository is outside the ready workspace accounts')
  const observedAt = new Date().toISOString()
  const [ledger, live] = await Promise.all([
    readBehaviorLedger({ operation: 'list', repository: args.repository, number: args.pull, limit: 10 }).catch(() => null),
    readLivePull(args.repository, args.pull, null, null),
  ])
  let calls: LogEntry[] = []
  let incomplete = !ledger || ledger.status !== 200 || ledger.body.health.status !== 'ok' || ledger.body.health.pending > 0
    || !ledger.body.health.coverageStart || ledger.body.health.gaps.length > 0 || ledger.body.health.detailFloor !== null
    || !!ledger.body.nextCursor
  try {
    const snapshot = await fetchSelectedAgentLogSnapshot({ latest: [], ids: [],
      pull: { repository: args.repository, number: args.pull, limit: 11 } }, { fresh: true })
    calls = snapshot.entries.filter(row => row.repo?.toLowerCase() === args.repository.toLowerCase()
      && String(row.pr_id) === String(args.pull) && row.behavior === 'pr_approve')
    incomplete ||= snapshot.quarantined.length > 0 || calls.length !== snapshot.entries.length || calls.length > 10
    calls = calls.slice(-10)
  } catch { incomplete = true }
  return { repository: args.repository, pull: args.pull, observedAt,
    coverage: incomplete ? 'partial' : 'complete',
    ...(incomplete ? { reason: !ledger || ledger.status !== 200 ? 'Behavior Ledger is unavailable'
      : 'Retained approval runs or ledger coverage are incomplete' } : {}),
    ledgerCoverage: ledger ? { from: ledger.body.health.coverageStart, observedAt: ledger.body.health.observedAt,
      gaps: ledger.body.health.gaps.length, truncated: !!ledger.body.nextCursor } : null,
    source: 'Behavior Ledger and exact Caller records', liveGitHub: live,
    runs: calls.map(row => ({ id: row.id, status: row.status, action: row.action, outcome: row.outcome,
      expectedHead: row.expected_head, head: row.head_sha, reviewId: row.review_id ?? null,
      startedAt: row.started_at_precise ?? row.started_at, completedAt: row.completed_at ?? null,
      failure: failure(row) })),
    links: { pull: `https://github.com/${args.repository}/pull/${args.pull}`, runs: '/?view=observe&part=behaviors' },
  }
}
