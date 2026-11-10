import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { behaviorChainJournal } from './behavior-chain-journal'
import { HttpError, httpStatus, readJson } from './http'
import { getBehaviorChainSettings, getSettings } from './settings'
import { getBehaviorChainCapacity, getBehaviorChainRuntimeHealth } from './behaviors'
import { behaviorCutoverBlockers } from './behavior-cutover'
import type { BehaviorChain, ChainEvent } from './behavior-chain-store'
import { behaviorChainAttention, behaviorChainSummary } from './behavior-chain-summary'
import { nativeCleanupSupport, requireNativeCleanup } from './native-cleanup-support'

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value))
}

export async function handleBehaviorChains(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  try {
    const params = new URL(url, 'http://localhost').searchParams
    const journal = behaviorChainJournal()
    const summary = (chain: BehaviorChain) => behaviorChainSummary(chain, { at: journal.reconciliationAt(chain) })
    const cutover = () => ({ ...journal.cutover(), support: nativeCleanupSupport(),
      blockers: journal.cutover().mode === 'draining' ? behaviorCutoverBlockers() : [] })
    if (req.method === 'GET') {
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
            ...('evidence' in event ? { callId: 'callId' in event ? event.callId : event.evidence.nativeCallId ?? event.evidence.callId ?? null,
              evidence: { diagnostic: event.evidence.diagnostic } } : {}) }
        })
        return reply(res, 200, { chain: summary(chain), events, next: rows.length === 20 ? rows.at(-1)!.sequence : null,
          cutover: cutover(), settings: getBehaviorChainSettings(), runtime: getBehaviorChainRuntimeHealth(), capacity: getBehaviorChainCapacity() })
      }
      const after = params.get('after') || ''
      const chains = journal.page(after, 100, params.get('state') === 'active' ? false : params.get('state') === 'merged' ? true : null)
      return reply(res, 200, { chains: chains.map(summary), next: chains.length === 100 ? chains.at(-1)!.id : null,
        ...(!after ? { attention: behaviorChainAttention(journal) } : {}),
        cutover: cutover(), settings: getBehaviorChainSettings(), runtime: getBehaviorChainRuntimeHealth(), capacity: getBehaviorChainCapacity() })
    }
    if (req.method !== 'POST') throw new HttpError(405, 'behavior chains support GET and POST')
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
      || !['hold', 'resume'].includes(String(body.operation))) throw new HttpError(400, 'id, current sequence and hold/resume operation are required')
    const chain = journal.read(body.id)
    if (!chain) throw new HttpError(404, 'behavior chain not found')
    if (chain.mergeSha) throw new HttpError(409, 'Merged chains permit original receipt reconciliation only; new invocations cannot resume')
    const operation = body.operation
    const next = journal.append(chain.id, randomUUID(), Number(body.sequence), operation === 'hold'
      ? { type: 'chain.held', reason: 'New invocations held by the person' } : { type: 'chain.resumed' })
    return reply(res, 200, { chain: summary(next) })
  } catch (error) {
    return reply(res, httpStatus(error, 409), { error: error instanceof Error ? error.message : String(error) })
  }
}
