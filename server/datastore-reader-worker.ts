// The datastore views' reader thread (server/datastore-reader.ts): one
// read-only connection per datastore file, kept across reads and reopened
// when the file is replaced, so a read costs a query, not a process.
import { statSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { datastoreContent, selectView, type DatastoreViewQuery } from './datastore-views'

/** A view's rows, or with no query the datastore's content mark. */
export interface DatastoreReadRequest { id: number, path: string, query: DatastoreViewQuery | null }
export type DatastoreReadReply = { id: number, ok: true, rows: Record<string, unknown>[], content: string | null }
  | { id: number, ok: false, message: string }

interface Connection { db: Database.Database, dev: number, ino: number, content?: { version: number, mark: string } }
const connections = new Map<string, Connection>()

function connection(path: string): Connection {
  const { dev, ino } = statSync(path)
  const open = connections.get(path)
  if (open && open.dev === dev && open.ino === ino) return open
  // A rebuilt datastore is a new file: the old connection would keep
  // reading the unlinked one.
  connections.delete(path)
  open?.db.close()
  const fresh = { db: new Database(path, { readonly: true, fileMustExist: true }), dev, ino }
  connections.set(path, fresh)
  return fresh
}

/** The content mark, read once for each commit another connection makes;
 *  null when this datastore cannot give one, and its views are then read as before. */
function contentOf(open: Connection): string | null {
  try {
    return open.db.transaction(() => {
      const version = open.db.pragma('data_version', { simple: true }) as number
      if (open.content?.version !== version) open.content = { version, mark: datastoreContent(open.db) }
      return open.content.mark
    })()
  } catch {
    return null
  }
}

if (parentPort) {
  const port = parentPort
  port.on('message', ({ id, path, query }: DatastoreReadRequest) => {
    let reply: DatastoreReadReply
    try {
      const open = connection(path)
      reply = query ? { id, ok: true, rows: selectView(open.db, query), content: null } : { id, ok: true, rows: [], content: contentOf(open) }
    } catch (error) {
      reply = { id, ok: false, message: error instanceof Error ? error.message : String(error) }
      // The next read opens afresh rather than reuse a connection that failed.
      const open = connections.get(path)
      connections.delete(path)
      try { open?.db.close() } catch { /* already unusable */ }
    }
    port.postMessage(reply)
  })
}
