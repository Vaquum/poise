import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { AnalyticsDatastoreQuery, AnalyticsDatastoreRecords } from './analytics-datastore'
import type { AnalyticsWorkerReply } from './analytics-worker'
import { HttpError } from './http'

let asset: Promise<URL> | null = null
async function workerAsset(): Promise<URL> {
  const built = new URL('./analytics-worker.js', import.meta.url)
  if (existsSync(built)) return built
  const source = new URL('./analytics-worker.ts', import.meta.url)
  if (process.env.NODE_ENV === 'production' || !existsSync(source)) throw new Error('The Analytics reader worker asset is missing')
  const cache = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url))
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'analytics-reader-'))
  const output = join(directory, 'worker.mjs')
  try {
    const { build } = await import('esbuild')
    await build({ entryPoints: [fileURLToPath(source)], outfile: output, bundle: true,
      platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
    return pathToFileURL(output)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

/** One read owns one worker and always reaps it, including error and timeout. */
export async function readAnalyticsInWorker(input: AnalyticsDatastoreQuery): Promise<AnalyticsDatastoreRecords> {
  const worker = new Worker(await (asset ??= workerAsset()))
  worker.unref()
  try {
    return await new Promise<AnalyticsDatastoreRecords>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => fail(new Error('Analytics datastore read timed out')), 15_000)
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      worker.once('error', fail)
      worker.once('exit', code => fail(new Error(`Analytics reader stopped (exit ${code})`)))
      worker.once('message', (reply: AnalyticsWorkerReply) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (reply?.ok && Array.isArray(reply.records?.issues) && Array.isArray(reply.records.prs) && Array.isArray(reply.records.errors)) {
          resolve(reply.records)
        } else if (reply && !reply.ok) {
          reject(reply.statusCode ? new HttpError(reply.statusCode, reply.message) : new Error(reply.message))
        } else reject(new Error('Invalid Analytics reader reply'))
      })
      worker.postMessage(input)
    })
  } finally { await worker.terminate() }
}
