import type Database from 'better-sqlite3'

// Statements compiled once per connection, for constant SQL on hot paths:
// under CPU contention, compiling the same statements again on every call
// was a fifth of the main thread's busy time. The type offers only get, all
// and run. Binding a cached statement, iterating it, or switching it to
// pluck, raw, expand or safeIntegers would carry over into every later caller.
export type CachedStatement = Pick<Database.Statement<unknown[], unknown>, 'get' | 'all' | 'run'>

const statements = new WeakMap<Database.Database, Map<string, CachedStatement>>()

/** `database.prepare(sql)`, compiled on first use and reused after. */
export function cachedStatement(database: Database.Database, sql: string): CachedStatement {
  let cache = statements.get(database)
  if (!cache) statements.set(database, cache = new Map())
  let statement = cache.get(sql)
  if (!statement) cache.set(sql, statement = database.prepare(sql))
  return statement
}

/** The keys that start with `prefix`, as the range a TEXT key's index answers:
 *  `key >= low AND key < high`. A substr() or LIKE comparison reads every row,
 *  value and all, instead. The prefix must end in an ASCII character, whose
 *  successor is the next byte in UTF-8, so the range holds exactly those keys. */
export function prefixRange(prefix: string): [low: string, high: string] {
  const last = prefix.charCodeAt(prefix.length - 1)
  if (!(last >= 0 && last < 0x7f)) throw new Error('a key prefix must end in an ASCII character')
  return [prefix, prefix.slice(0, -1) + String.fromCharCode(last + 1)]
}
