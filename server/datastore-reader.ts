import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { DatastoreReadReply, DatastoreReadRequest } from './datastore-reader-worker'
import { parseViewArgs } from './datastore-views'

// GitHub lists read the datastore's `pr`, `issue` and `user` views through
// one long-lived worker thread instead of a Caller process per organization
// and scope: under load, starting those processes was the reads' cost
// (server/datastore-views.ts mirrors what the CLI answers).

const READ_TIMEOUT_MS = 30_000

interface Answer { rows: Record<string, unknown>[], content: string | null }
interface Pending { resolve: (answer: Answer) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }
interface Reader { worker: Worker, pending: Map<number, Pending> }

let reader: Promise<Reader> | null = null
let nextId = 0

async function workerAsset(): Promise<URL> {
  const built = new URL('./datastore-reader-worker.js', import.meta.url)
  if (existsSync(built)) return built
  const source = new URL('./datastore-reader-worker.ts', import.meta.url)
  if (process.env.NODE_ENV === 'production' || !existsSync(source)) throw new Error('The datastore reader worker asset is missing')
  const cache = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url))
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'datastore-reader-'))
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

function startReader(): Promise<Reader> {
  const started: Promise<Reader> = (async () => {
    const worker = new Worker(await workerAsset())
    worker.unref()
    const state: Reader = { worker, pending: new Map() }
    // A stopped thread fails its waiting reads (each takes the CLI) and the
    // next read starts another.
    const retire = (error: Error) => {
      if (reader === started) reader = null
      for (const [id, call] of state.pending) {
        state.pending.delete(id)
        clearTimeout(call.timer)
        call.reject(error)
      }
    }
    worker.on('message', (reply: DatastoreReadReply) => {
      const call = state.pending.get(reply.id)
      if (!call) return
      state.pending.delete(reply.id)
      clearTimeout(call.timer)
      if (reply.ok) call.resolve({ rows: reply.rows, content: reply.content })
      else call.reject(new Error(reply.message))
    })
    worker.on('error', retire)
    worker.on('exit', (code) => retire(new Error(`the datastore reader stopped (exit ${code})`)))
    return state
  })()
  return started
}

async function read(path: string, request: Omit<DatastoreReadRequest, 'id' | 'path'>): Promise<Answer> {
  const started = reader ??= startReader()
  let state: Reader
  try { state = await started }
  catch (error) {
    if (reader === started) reader = null
    throw error
  }
  const id = ++nextId
  return new Promise((resolve, reject) => {
    // A read that outlives Caller's own deadline stops the thread: whatever
    // holds it holds every read behind it. Waiting reads take the CLI.
    const timer = setTimeout(() => { void state.worker.terminate() }, READ_TIMEOUT_MS)
    timer.unref()
    state.pending.set(id, { resolve, reject, timer })
    state.worker.postMessage({ id, path, ...request } satisfies DatastoreReadRequest)
  })
}

/** The rows `github-datastore view …` would print for these arguments, read
 *  in-process; null when the CLI must answer (arguments this reader does not
 *  mirror). A rejection means the reader failed, never that the view did:
 *  the caller asks the CLI then. */
export function readDatastoreView(path: string, args: readonly string[]): Promise<Record<string, unknown>[]> | null {
  const query = parseViewArgs(args)
  if (!query || !existsSync(path)) return null
  return read(path, { query }).then((answer) => answer.rows)
}

/** The datastore's content mark (server/datastore-views.ts): two equal marks
 *  mean no item or evidence changed in between, so every view answers alike.
 *  Null when the file is missing or gives no mark. */
export function readDatastoreContent(path: string): Promise<string | null> | null {
  if (!existsSync(path)) return null
  return read(path, { query: null }).then((answer) => answer.content)
}

/** Test lifecycle: stop the thread; the next read starts another. */
export async function stopDatastoreReader(): Promise<void> {
  const current = reader
  reader = null
  if (current) await (await current).worker.terminate()
}
