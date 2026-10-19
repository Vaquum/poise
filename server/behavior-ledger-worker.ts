import { parentPort, workerData } from 'node:worker_threads'
import { BehaviorLedgerStore } from './behavior-ledger-store'
import { LEDGER_RESPONSE_BYTES, type LedgerPending, type LedgerWorkerData, type LedgerWorkerReply, type LedgerWorkerRequest } from './behavior-ledger-contract'

export function executeLedgerRequest(store: BehaviorLedgerStore, request: LedgerWorkerRequest): LedgerWorkerReply {
  const pending = (): LedgerPending[] => {
    try { return store.pending() } catch { return [] }
  }
  try {
    if (request.operation === 'capture') {
      if (!request.observation) throw new Error('Missing ledger observation')
      store.capture(request.observation)
    } else if (request.operation === 'read') {
      if (!request.request) throw new Error('Missing ledger read')
      const reply = store.read(request.request)
      if (Buffer.byteLength(JSON.stringify(reply.body)) > LEDGER_RESPONSE_BYTES) throw new Error('Ledger response bound')
      return { id: request.id, ...reply, pending: pending() }
    } else if (request.operation === 'close') store.close()
    else if (request.operation !== 'pending') throw new Error('Unknown ledger operation')
    return { id: request.id, status: 200, body: { version: 1, health: store.health() }, pending: pending() }
  } catch {
    return { id: request.id, status: 503, body: { version: 1, health: store.health(), error: 'ledger_unavailable' }, pending: pending() }
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
