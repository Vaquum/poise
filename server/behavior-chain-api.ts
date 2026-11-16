import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { behaviorChainJournal } from './behavior-chain-journal'
import { HttpError, endJson, httpStatus, readJson } from './http'
import { getBehaviorChainSettings, getSettings } from './settings'
import { getBehaviorChainCapacity, getBehaviorChainRuntimeHealth } from './behaviors'
import { behaviorCutoverBlockers } from './behavior-cutover'
import { BehaviorChainRevisionConflict, canCloseMergedReviewHold, chainIdentity, type BehaviorChain, type BehaviorChainJournal, type ChainEvent } from './behavior-chain-store'
import { closedIssuesWithLabel, requireConfiguredRepository } from './gh'
import { behaviorChainAttention, behaviorChainSummary, behaviorChainWorkImpact, behaviorChainWorkImpacts } from './behavior-chain-summary'
import { nativeCleanupSupport, requireNativeCleanup } from './native-cleanup-support'
import { parseHandoffCandidates } from '../gateway/src/diagnostics/query-handoff'
import { verifiedLoggingHandoffs } from './logging-handoff'
import { db } from './db'
import { implementationReportBinding, reviewReportBinding, setImplementationReportDisposition } from './behavior-chain-report'
import { openWorkBindings } from './chat/control-store'

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json'); endJson(res, JSON.stringify(value))
}

// A list read computes a page of chain summaries and every active chain's
// attention synchronously on the server's thread, and Overview, Board and
// Observe poll it from every open tab. Identical reads within a few seconds
// share that work; a change made through this API clears it at once.
const LIST_REUSE_MS = 10_000
const listReuse = new Map<string, { at: number, chains: unknown[], next: string | null }>()
let attentionReuse: { at: number, chatInstance: string | null, value: unknown } | null = null

export function invalidateBehaviorChainReads(): void {
  listReuse.clear()
  attentionReuse = null
}

async function closeMergedReviewHolds(journal: BehaviorChainJournal, repository: unknown, targets: unknown) {
  if (typeof repository !== 'string' || !Array.isArray(targets) || !targets.length || targets.length > 100) {
    throw new HttpError(400, 'Choose a repository and up to 100 observed review holds')
  }
  requireConfiguredRepository(repository)
  const { seedMode, label } = getBehaviorChainSettings()
  const actor = getSettings().me
  if (seedMode !== 'label' || !label || !actor) throw new HttpError(409, 'Closing review holds requires the configured GitHub account and intake label')
  const ids = new Set<string>()
  const candidates: BehaviorChain[] = []
  for (const target of targets) {
    if (typeof target?.id !== 'string' || !Number.isSafeInteger(target.sequence) || target.sequence < 1 || ids.has(target.id)) {
      throw new HttpError(400, 'Each review hold needs a unique chain and its observed sequence')
    }
    const number = Number(target.id.slice(target.id.lastIndexOf('#') + 1))
    if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647 || target.id !== chainIdentity(repository, number)) {
      throw new HttpError(400, 'Review holds must belong to the selected repository')
    }
    ids.add(target.id)
    const chain = journal.read(target.id)
    if (chain && chain.sequence === target.sequence && canCloseMergedReviewHold(chain)) candidates.push(chain)
  }
  const closed: string[] = []
  if (candidates.length) {
    const eligible = await closedIssuesWithLabel(repository, candidates.map(chain => chain.issue), actor, label)
    const intake = getBehaviorChainSettings()
    requireConfiguredRepository(repository)
    if (intake.seedMode !== seedMode || intake.label !== label || getSettings().me !== actor) {
      throw new HttpError(409, 'The GitHub account or intake label changed during the check')
    }
    for (const chain of candidates) {
      if (!eligible.has(chain.issue)) continue
      try {
        journal.append(chain.id, randomUUID(), chain.sequence, { type: 'chain.review-hold-closed',
          closure: { mergeSha: chain.mergeSha!, actor, label } })
        closed.push(chain.id)
      } catch (error) {
        if (!(error instanceof BehaviorChainRevisionConflict)) throw error
      }
    }
  }
  return { closed, skipped: [...ids].filter(id => !closed.includes(id)) }
}

export async function handleBehaviorChains(req: IncomingMessage, res: ServerResponse, url: string, chatInstance: string | null = null, person = false): Promise<void> {
  let clearAfter = false
  try {
    const params = new URL(url, 'http://localhost').searchParams
    const journal = behaviorChainJournal()
    const summary = (chain: BehaviorChain) => behaviorChainSummary(chain, journal, { at: journal.reconciliationAt(chain) })
    const cutover = () => ({ ...journal.cutover(), support: nativeCleanupSupport(),
      blockers: journal.cutover().mode === 'draining' ? behaviorCutoverBlockers() : [] })
    if (req.method === 'GET') {
      if (params.has('handoffs')) {
        if (params.size !== 1 || (params.get('handoffs')?.length ?? 0) > 6000) throw new HttpError(400, 'Invalid bounded review handoff selectors')
        const candidates = parseHandoffCandidates(JSON.parse(params.get('handoffs')!))
        return reply(res, 200, { warnings: verifiedLoggingHandoffs(candidates, journal, db) })
      }
      if (params.has('batch') || params.has('callId') || params.has('correlationId')) {
        const batch = params.get('batch') === '1'
        const calls = batch ? params.getAll('callId').map(value => value || null) : [params.get('callId')]
        const correlations = batch ? params.getAll('correlationId').map(value => value || null) : [params.get('correlationId')]
        if (params.has('batch') && !batch || !calls.length || calls.length > 100 || calls.length !== correlations.length
          || calls.some((callId, index) => {
            const correlationId = correlations[index]
            return !callId && !correlationId || callId !== null && !/^[a-f0-9]{32}$/i.test(callId)
              || correlationId !== null && !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(correlationId)
          })) {
          throw new HttpError(400, 'valid Call or correlation identity is required')
        }
        return reply(res, 200, batch
          ? { impacts: behaviorChainWorkImpacts(journal, calls.map((callId, index) => ({ callId, correlationId: correlations[index] }))) }
          : { impact: behaviorChainWorkImpact(journal, calls[0], correlations[0]) })
      }
      const id = params.get('id')
      if (id) {
        const chain = journal.read(id)
        if (!chain) throw new HttpError(404, 'behavior chain not found')
        const after = Number(params.get('after') || 0)
        const rows = journal.history(id, after, 20)
        const events = rows.map((row) => {
          const event = JSON.parse(row.payload) as ChainEvent
          return { sequence: row.sequence, at: row.at, type: event.type,
            ...('invocationId' in event ? { invocationId: event.invocationId } : {}),
            ...('reason' in event ? { reason: event.reason } : {}),
            ...('outcome' in event ? { outcome: event.outcome } : {}),
            ...(event.type === 'chain.resumed' ? { recovery: event.recovery ?? null } : {}),
            ...(event.type === 'chain.review-hold-closed' ? { reviewHoldClosure: event.closure } : {}),
            ...('evidence' in event ? { callId: 'callId' in event ? event.callId : event.evidence.nativeCallId ?? event.evidence.callId ?? null,
              evidence: { diagnostic: event.evidence.diagnostic,
                ...(event.type === 'chain.merged' && typeof event.evidence.review_complete === 'boolean'
                  ? { review_complete: event.evidence.review_complete } : {}) } } : {}) }
        })
        return reply(res, 200, { chain: summary(chain), implementationReport: implementationReportBinding(db, chain), reviewReport: reviewReportBinding(db, chain), events, next: rows.length === 20 ? rows.at(-1)!.sequence : null,
          cutover: cutover(), settings: getBehaviorChainSettings(), runtime: getBehaviorChainRuntimeHealth(), capacity: getBehaviorChainCapacity() })
      }
      const after = params.get('after') || ''
      const now = Date.now()
      const merged = params.get('state') === 'active' ? false : params.get('state') === 'merged' ? true : null
      // Only what the page depends on keys it, and nothing outlives its window.
      const key = `${after}|${merged}`
      for (const [old, kept] of listReuse) if (now - kept.at >= LIST_REUSE_MS) listReuse.delete(old)
      let page = listReuse.get(key)
      if (!page) {
        const chains = journal.page(after, 100, merged)
        page = { at: now, chains: chains.map(summary), next: chains.length === 100 ? chains.at(-1)!.id : null }
        listReuse.set(key, page)
      }
      if (!after && (!attentionReuse || now - attentionReuse.at >= LIST_REUSE_MS || attentionReuse.chatInstance !== chatInstance)) {
        const owners = chatInstance ? openWorkBindings(chatInstance) : []
        const chats = new Map(owners.map(({ target, session, role }) => [target, { kind: 'chat' as const, session, manager: role === 'manager' }]))
        attentionReuse = { at: now, chatInstance, value: behaviorChainAttention(journal, now, chats) }
      }
      return reply(res, 200, { chains: page.chains, next: page.next,
        ...(!after ? { attention: attentionReuse!.value } : {}),
        cutover: cutover(), settings: getBehaviorChainSettings(), runtime: getBehaviorChainRuntimeHealth(), capacity: getBehaviorChainCapacity() })
    }
    if (req.method !== 'POST') throw new HttpError(405, 'behavior chains support GET and POST')
    // Cleared once the change is made (finally, below): a read that arrives while
    // this one awaits its body or a check must not keep what came before it.
    clearAfter = true
    const body = await readJson<unknown>(req)
    if (body && typeof body === 'object' && 'operation' in body && body.operation === 'close-merged-review-holds') {
      if (!person) throw new HttpError(403, 'Review holds are closed by the workspace owner in Tasks')
      return reply(res, 200, await closeMergedReviewHolds(journal,
        'repository' in body ? body.repository : null, 'targets' in body ? body.targets : null))
    }
    if (body && typeof body === 'object' && 'operation' in body && ['switch-to-v2', 'cancel-cutover'].includes(String(body.operation))) {
      if (!('sequence' in body) || !Number.isSafeInteger(body.sequence)) throw new HttpError(400, 'current cutover sequence is required')
      const accounts = getSettings()
      if (body.operation === 'switch-to-v2' && (!accounts.me || !accounts.agentAccount || accounts.me.toLowerCase() === accounts.agentAccount.toLowerCase())) throw new HttpError(409, 'Cutover requires distinct author and automation GitHub accounts')
      if (body.operation === 'switch-to-v2') await requireNativeCleanup()
      journal.changeAdmission(Number(body.sequence), body.operation === 'switch-to-v2' ? 'draining' : 'v1')
      return reply(res, 200, { cutover: cutover() })
    }
    if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string'
      || !('sequence' in body) || !Number.isSafeInteger(body.sequence) || !('operation' in body)
      || !['hold', 'resume', 'report-disposition'].includes(String(body.operation))) throw new HttpError(400, 'id, current sequence and hold/resume/report-disposition operation are required')
    const chain = journal.read(body.id)
    if (!chain) throw new HttpError(404, 'behavior chain not found')
    if (chain.mergeSha) throw new HttpError(409, 'Merged chains permit original receipt reconciliation only; new invocations cannot resume')
    if (chain.supersession) throw new HttpError(409, 'Superseded chains are terminal; new invocations cannot resume')
    if (body.operation === 'report-disposition') {
      await setImplementationReportDisposition(db, journal, chain, Number(body.sequence),
        'binding' in body ? body.binding : null, 'disposition' in body ? body.disposition : null)
      return reply(res, 200, { chain: summary(journal.read(chain.id)!), implementationReport: implementationReportBinding(db, chain),
        reviewReport: reviewReportBinding(db, chain) })
    }
    const operation = body.operation
    const next = journal.append(chain.id, randomUUID(), Number(body.sequence), operation === 'hold'
      ? { type: 'chain.held', reason: 'New invocations held by the person' } : { type: 'chain.resumed', recovery: { origin: 'operator' } })
    return reply(res, 200, { chain: summary(next) })
  } catch (error) {
    return reply(res, httpStatus(error, 409), { error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (clearAfter) invalidateBehaviorChainReads()
  }
}
