import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { behaviorChainJournal } from './behavior-chain-journal'
import { HttpError, endJson, httpStatus, readJson } from './http'
import { getBehaviorChainSettings, getSettings } from './settings'
import { getBehaviorChainCapacity, getBehaviorChainRuntimeHealth } from './behaviors'
import { behaviorCutoverBlockers } from './behavior-cutover'
import type { BehaviorChain, ChainEvent } from './behavior-chain-store'
import { behaviorChainAttention, behaviorChainSummary, behaviorChainWorkImpact, behaviorChainWorkImpacts } from './behavior-chain-summary'
import { nativeCleanupSupport, requireNativeCleanup } from './native-cleanup-support'
import { db } from './db'
import { implementationReportBinding, reviewReportBinding, setImplementationReportDisposition } from './behavior-chain-report'

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json'); endJson(res, JSON.stringify(value))
}

// A list read computes a page of chain summaries and every active chain's
// attention synchronously on the server's thread, and Overview, Board and
// Observe poll it from every open tab. Identical reads within a few seconds
// share that work; a change made through this API clears it at once.
const LIST_REUSE_MS = 10_000
let listReuse = new Map<string, { at: number, chains: unknown[], next: string | null }>()
let attentionReuse: { at: number, value: unknown } | null = null

export async function handleBehaviorChains(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  let clearAfter = false
  try {
    const params = new URL(url, 'http://localhost').searchParams
    const journal = behaviorChainJournal()
    const summary = (chain: BehaviorChain) => behaviorChainSummary(chain, journal, { at: journal.reconciliationAt(chain) })
    const cutover = () => ({ ...journal.cutover(), support: nativeCleanupSupport(),
      blockers: journal.cutover().mode === 'draining' ? behaviorCutoverBlockers() : [] })
    if (req.method === 'GET') {
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
      if (!after && (!attentionReuse || now - attentionReuse.at >= LIST_REUSE_MS)) attentionReuse = { at: now, value: behaviorChainAttention(journal) }
      return reply(res, 200, { chains: page.chains, next: page.next,
        ...(!after ? { attention: attentionReuse!.value } : {}),
        cutover: cutover(), settings: getBehaviorChainSettings(), runtime: getBehaviorChainRuntimeHealth(), capacity: getBehaviorChainCapacity() })
    }
    if (req.method !== 'POST') throw new HttpError(405, 'behavior chains support GET and POST')
    // Cleared once the change is made (finally, below): a read that arrives while
    // this one awaits its body or a check must not keep what came before it.
    clearAfter = true
    const body = await readJson<unknown>(req)
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
    if (clearAfter) { listReuse = new Map(); attentionReuse = null }
  }
}
