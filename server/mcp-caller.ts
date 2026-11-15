import type { McpCallerListArguments, McpGrantScope } from '../gateway/src/mcp-contract'
import { placeHref } from '../src/ui/address'
import { fetchAgentLogById, fetchAgentLogPage, type LogEntry } from './agent'
import { BehaviorChainJournal } from './behavior-chain-store'
import { db } from './db'
import { HttpError } from './http'
import { mcpCursor } from './mcp-cursor'

function callDetails(row: LogEntry) {
  const { id, repo: repository, actor, model, behavior, status, action, outcome, source, runner,
    started_at, started_at_precise, completed_at, resources_settled_at, correlation_id, expected_head, head_sha, review_id, response } = row
  return { kind: 'call', id, repository, actor, model, behavior, status, action, outcome, source, runner: runner ?? 'caller',
    invocationId: correlation_id, startedAt: started_at_precise ?? started_at, completedAt: completed_at ?? null,
    resourceSettlementAt: resources_settled_at ?? null, expectedHead: expected_head, head: head_sha, reviewId: review_id ?? null,
    responseAvailable: response !== null }
}

export async function listCallerRecords(grant: McpGrantScope, args: McpCallerListArguments) {
  const cursor = mcpCursor(grant, ['call', args.limit])
  const after = args.cursor ? cursor.decode(args.cursor) : null
  if (after !== null && (typeof after !== 'string' || !after || after.length > 512)) {
    throw new HttpError(400, 'invalid Caller continuation')
  }
  const source = 'Caller retained Call log'
  const retention = 'Rows retained by Caller, newest first'
  try {
    const page = await fetchAgentLogPage(args.limit, after)
    return { observedAt: new Date().toISOString(), source, retention,
      items: page.entries.map(callDetails), total: page.total, quarantined: page.quarantined.length,
      coverage: page.quarantined.length ? 'partial' : 'complete',
      nextCursor: page.nextCursor ? cursor.encode(page.nextCursor) : null }
  } catch {
    return { observedAt: new Date().toISOString(), source, retention, items: [], total: null, quarantined: null,
      coverage: 'unavailable', nextCursor: null, reason: 'The retained Call log could not be read' }
  }
}

export async function readCallerRecord(kind: 'call' | 'invocation', id: string) {
  const observedAt = new Date().toISOString()
  const source = kind === 'call' ? 'Caller retained Call log' : 'Poise Behavior chain journal'
  const retention = kind === 'call' ? 'Rows retained by Caller' : 'Retained chain events and invocation receipts'
  const href = '/' + placeHref('observe', { part: 'tasks' })
  try {
    if (kind === 'call') {
      const snapshot = await fetchAgentLogById(id)
      const log = snapshot.entries.filter(row => row.id === id)
      const unsafe = log.length > 1 || snapshot.quarantined.length > 0
      const record = unsafe || !log[0] ? null : callDetails(log[0])
      return { observedAt, source, retention, href: record?.responseAvailable ? '/api/agent-response/' + id : href,
        coverage: unsafe ? 'partial' : 'complete', record, ...(unsafe ? { reason: 'The exact Call has ambiguous or quarantined evidence' } : {}) }
    }
    const found = new BehaviorChainJournal(db).forInvocation(null, id)
    if (!found) return { observedAt, source, retention, href, coverage: 'complete', record: null }
    const { chain, invocation } = found
    return { observedAt, source, retention, href: '/' + placeHref('observe', { part: 'tasks', chain: chain.id }),
      coverage: invocation.state === 'uncertain' ? 'partial' : 'complete',
      record: { kind, id, chainId: chain.id, repository: chain.repository, issue: chain.issue, behavior: invocation.behavior,
        actor: invocation.actor, model: invocation.model, state: invocation.state, outcome: invocation.outcome, callId: invocation.callId,
        admittedAt: new Date(invocation.admittedAt).toISOString(), resourcesSettledAt: invocation.evidence?.resources_settled_at ?? null } }
  } catch {
    return { observedAt, source, retention, href, coverage: 'unavailable', record: null, reason: 'The retained source could not be read' }
  }
}
