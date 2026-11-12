// The datastore views' reader thread (server/datastore-reader.ts): one
// read-only connection per datastore file, kept across reads and reopened
// when the file is replaced, so a read costs a query, not a process.
import { statSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { selectView, type DatastoreViewQuery } from './datastore-views'

export interface DatastoreReadRequest { id: number, path: string, query: DatastoreViewQuery }
export type DatastoreReadReply = { id: number, ok: true, rows: Record<string, unknown>[] }
  | { id: number, ok: false, message: string }

interface Connection { db: Database.Database, dev: number, ino: number }
const connections = new Map<string, Connection>()

function connection(path: string): Database.Database {
  const { dev, ino } = statSync(path)
  const open = connections.get(path)
  if (open && open.dev === dev && open.ino === ino) return open.db
  // A rebuilt datastore is a new file: the old connection would keep
  // reading the unlinked one.
  connections.delete(path)
  open?.db.close()
  const db = new Database(path, { readonly: true, fileMustExist: true })
  connections.set(path, { db, dev, ino })
  return db
}

if (parentPort) {
  const port = parentPort
  port.on('message', ({ id, path, query }: DatastoreReadRequest) => {
    let reply: DatastoreReadReply
    try {
      reply = { id, ok: true, rows: selectView(connection(path), query) }
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
