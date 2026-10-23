import { parentPort, workerData } from 'node:worker_threads'
import { BehaviorLedgerStore } from './behavior-ledger-store'
import { LEDGER_RESPONSE_BYTES, LedgerError, type LedgerPending, type LedgerReply, type LedgerWorkerData, type LedgerWorkerReply, type LedgerWorkerRequest, type LedgerWorkerTiming } from './behavior-ledger-contract'

export function executeLedgerRequest(store: BehaviorLedgerStore, request: LedgerWorkerRequest): LedgerWorkerReply {
  const startedAt = performance.now()
  const scanBefore = store.budgetScanMs
  const timing: LedgerWorkerTiming | undefined = request.operation === 'read' ? { totalMs: 0, budgetScanMs: 0 } : undefined
  const measure = <T>(phase: 'readMs' | 'pendingMs' | 'encodeMs', operation: () => T): T => {
    if (!timing) return operation()
    const start = performance.now()
    try { return operation() } finally { timing[phase] = performance.now() - start }
  }
  const pending = (): LedgerPending[] => {
    try { return measure('pendingMs', () => store.pending()) } catch { return [] }
  }
  const reply = (result: { status: number; body: LedgerReply }): LedgerWorkerReply => {
    const rows = pending()
    if (timing) {
      timing.totalMs = performance.now() - startedAt
      timing.budgetScanMs = store.budgetScanMs - scanBefore
    }
    return { id: request.id, ...result, pending: rows, ...(timing ? { timing } : {}) }
  }
  try {
    if (request.operation === 'capture') {
      if (!request.observation) throw new Error('Missing ledger observation')
      store.capture(request.observation)
    } else if (request.operation === 'read') {
      if (!request.request) throw new Error('Missing ledger read')
      const read = request.request
      const result = measure('readMs', () => store.read(read))
      if (measure('encodeMs', () => Buffer.byteLength(JSON.stringify(result.body))) > LEDGER_RESPONSE_BYTES) throw new Error('Ledger response bound')
      return reply(result)
    } else if (request.operation === 'close') store.close()
    else if (request.operation !== 'pending') throw new Error('Unknown ledger operation')
    return reply({ status: 200, body: { version: 1, health: store.health() } })
  } catch (error) {
    // Poison carries its 4xx rejection so the observer sheds it; anything
    // else is storage-side and held for retry.
    const failure = error instanceof LedgerError ? error : new LedgerError(503, 'ledger_unavailable')
    return reply({ status: failure.status, body: { version: 1, health: store.health(), error: failure.code } })
  }
}

if (parentPort) {
  const port = parentPort
  const data = workerData as LedgerWorkerData
  const store = new BehaviorLedgerStore(data.path, data.policy)
  port.postMessage({ ready: true, health: store.health(), pending: store.pending() })
  port.on('message', (request: LedgerWorkerRequest) => {
    port.postMessage(executeLedgerRequest(store, request))
  })
}
