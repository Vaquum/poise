// Datastore I/O runs in an isolated thread; configuration comes from the
// request, never from importing the application's mutable runtime state.
import { parentPort } from 'node:worker_threads'
import { readAnalyticsDatastores, type AnalyticsDatastoreQuery, type AnalyticsDatastoreRecords } from './analytics-datastore'

export type AnalyticsWorkerReply = { ok: true, records: AnalyticsDatastoreRecords }
  | { ok: false, message: string, statusCode?: number }

if (parentPort) {
  const port = parentPort
  port.once('message', async (input: AnalyticsDatastoreQuery) => {
    try {
      port.postMessage({ ok: true, records: await readAnalyticsDatastores(input) } satisfies AnalyticsWorkerReply)
    } catch (error) {
      port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error),
        statusCode: typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined,
      } satisfies AnalyticsWorkerReply)
    } finally { port.close() }
  })
}
