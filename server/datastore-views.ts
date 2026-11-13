import type Database from 'better-sqlite3'

// The datastore's `pr`, `issue` and `user` views, read in-process: the same
// SELECT, filters, order, label-evidence check and datetime normalization as
// Caller's `views._select` (caller/github_datastore/github_datastore/views.py),
// on the SQL views stored in the datastore file itself. Arguments are parsed
// as `github-datastore view` parses the ones Poise passes; anything this
// module does not mirror exactly is declined (null), so the CLI answers it.

const VIEWS = { pr: 'prs', issue: 'issues', user: 'user_items' } as const
type ViewName = keyof typeof VIEWS

const COMMON = ['--format', '--repo', '--status', '--author', '--number', '--updated-since-datetime',
  '--created-since-datetime', '--created-at-datetime', '--limit'] as const
// The flags `run_view` passes on for each view; argparse accepts the others
// and Caller ignores them, so a call naming one is left to the CLI.
const FLAGS: Record<ViewName, readonly string[]> = {
  pr: COMMON,
  issue: [...COMMON, '--label', '--after-repo', '--after-number'],
  user: [...COMMON, '--username', '--item-type'],
}
const INTEGER_FLAGS = new Set(['--number', '--limit', '--after-number'])

export interface DatastoreViewQuery {
  view: (typeof VIEWS)[ViewName]
  filters: {
    username?: string
    item_type?: string
    repo?: string
    status?: string
    author?: string
    number?: number
    updated_since?: string
    created_since?: string
    label?: string
    after_repo?: string
    after_number?: number
  }
  limit: number | null
}

/** The query `github-datastore view …` would run, or null when its answer
 *  could differ from the CLI's in any way. */
export function parseViewArgs(args: readonly string[]): DatastoreViewQuery | null {
  if (args[0] !== 'view' || !Object.hasOwn(VIEWS, args[1] ?? '')) return null
  const name = args[1] as ViewName
  const values = new Map<string, string>()
  for (let i = 2; i < args.length; i += 2) {
    const flag = args[i]
    const value = args[i + 1]
    // argparse refuses a value that looks like an option, and takes the last
    // of a repeated flag: neither occurs in Poise's reads.
    if (!FLAGS[name].includes(flag) || value === undefined || value.startsWith('-') || values.has(flag)) return null
    values.set(flag, value)
  }
  const integer = (flag: string): number | undefined | null => {
    const value = values.get(flag)
    if (value === undefined) return undefined
    return /^[0-9]{1,15}$/.test(value) ? Number(value) : null
  }
  for (const flag of INTEGER_FLAGS) if (integer(flag) === null) return null
  if ((values.get('--format') ?? 'json') !== 'json') return null
  const itemType = values.get('--item-type')
  if (itemType !== undefined && itemType !== 'issue' && itemType !== 'pr') return null

  const datetime = (flag: string): string | undefined | null => {
    const value = values.get(flag)
    return value === undefined ? undefined : normalizeDatetime(value)
  }
  const updatedSince = datetime('--updated-since-datetime')
  // `_created_since`: either flag, never both.
  if (values.has('--created-since-datetime') && values.has('--created-at-datetime')) return null
  const createdSince = datetime(values.has('--created-at-datetime') ? '--created-at-datetime' : '--created-since-datetime')
  if (updatedSince === null || createdSince === null) return null

  const limit = integer('--limit')
  if (limit === 0) return null
  const afterRepo = values.get('--after-repo')
  const afterNumber = integer('--after-number')
  if ((afterRepo === undefined) !== (afterNumber === undefined)) return null
  const label = values.get('--label')
  if (label !== undefined && !label.trim()) return null

  const filters: DatastoreViewQuery['filters'] = {}
  const set = <K extends keyof DatastoreViewQuery['filters']>(key: K, value: DatastoreViewQuery['filters'][K] | undefined) => {
    if (value !== undefined) filters[key] = value
  }
  set('username', values.get('--username'))
  set('item_type', itemType)
  set('repo', values.get('--repo'))
  set('status', values.get('--status'))
  set('author', values.get('--author'))
  set('number', integer('--number') ?? undefined)
  set('updated_since', updatedSince)
  set('created_since', createdSince)
  set('label', label)
  set('after_repo', afterRepo)
  set('after_number', afterNumber ?? undefined)
  return { view: VIEWS[name], filters, limit: limit ?? null }
}

// Three or six fraction digits: the forms every `fromisoformat` since 3.7 reads.
const ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{3}|\.[0-9]{6})?(Z|[+-][0-9]{2}:[0-9]{2})$/

/** `_normalize_datetime`: the instant in UTC, to the second (the fraction is
 *  dropped, as `replace(microsecond=0)` does), as `YYYY-MM-DDTHH:MM:SSZ`.
 *  Null for a form outside this strict subset of what `fromisoformat` reads,
 *  and for any value it refuses (no zone, an impossible date). */
export function normalizeDatetime(value: string): string | null {
  const match = ISO.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const zone = match[7]
  if (year < 1001 || year > 9998 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null
  let offsetMinutes = 0
  if (zone !== 'Z') {
    const hours = Number(zone.slice(1, 3))
    const minutes = Number(zone.slice(4, 6))
    if (hours > 23 || minutes > 59) return null
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (hours * 60 + minutes)
  }
  const instant = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000
  return new Date(instant).toISOString().replace('.000Z', 'Z')
}

/** `_select`: the view's rows, in Caller's order. Throws where Caller's
 *  read fails (incomplete label evidence, a value JSON cannot carry). */
export function selectView(db: Database.Database, query: DatastoreViewQuery): Record<string, unknown>[] {
  const { view, filters, limit } = query
  const where: string[] = []
  const params: Array<string | number> = []
  // `_where`, in its order.
  for (const column of ['username', 'item_type', 'repo', 'status', 'author', 'number'] as const) {
    const value = filters[column]
    if (value === undefined) continue
    where.push(column === 'repo' ? `${column} = ? COLLATE NOCASE` : `${column} = ?`)
    params.push(value)
  }
  if (filters.updated_since !== undefined) { where.push('updated_at >= ?'); params.push(filters.updated_since) }
  if (filters.created_since !== undefined) { where.push('created_at >= ?'); params.push(filters.created_since) }
  const paged = filters.after_repo !== undefined && filters.after_number !== undefined
  if (paged || filters.label !== undefined) {
    if (view !== 'issues') throw new Error(`${view} has no issue filters`)
  }
  if (paged) {
    where.push('(repo > ? OR (repo = ? AND number > ?))')
    params.push(filters.after_repo!, filters.after_repo!, filters.after_number!)
  }
  if (filters.label !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM items chain_issue,
          json_each(chain_issue.expanded_json, '$.issue.labels') chain_label
          WHERE chain_issue.item_id = issues.payload_ref
            AND json_extract(chain_label.value, '$.name') = ? COLLATE NOCASE)`)
    params.push(filters.label)
  }
  let sql = `SELECT * FROM ${view}`
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += paged ? ' ORDER BY repo ASC, number ASC' : ' ORDER BY updated_at DESC, repo ASC, number ASC'
  if (limit !== null) { sql += ' LIMIT ?'; params.push(limit) }

  if (filters.label !== undefined && db.prepare(`SELECT 1 FROM items WHERE item_type='issue' `
    + `AND coalesce(json_type(expanded_json,'$.issue.labels'),'missing') != 'array' LIMIT 1`).get()) {
    throw new Error('issue label evidence is incomplete; ordinary datastore synchronization must refresh the old snapshots')
  }
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value === 'bigint' || Buffer.isBuffer(value)) throw new Error(`${view} returned a value JSON cannot carry`)
    }
  }
  return rows
}

// Every view reads `items`, and `user` reads `associations` too. Caller commits
// its own bookkeeping every few seconds, so the file changes far more often
// than any item does. This mark changes whenever an item is added, removed or
// updated (GitHub moves `updated_at` on every change) and whenever evidence is
// added; it reads only an index and the evidence table's last rowid.
const CONTENT = `SELECT count(*) AS items, coalesce(max(updated_at), '') AS latest,
    coalesce(sum((item_id % 2147483647) * (coalesce(unixepoch(updated_at), 0) % 2147483647) % 2147483647), 0) AS spread,
    coalesce((SELECT max(rowid) FROM associations), 0) AS evidence
  FROM items`

/** What the views' answers depend on, as one string: equal marks mean no item
 *  or evidence changed between two reads. */
export function datastoreContent(db: Database.Database): string {
  const mark = db.prepare(CONTENT).get() as { items: number, latest: string, spread: number, evidence: number }
  return `${mark.items}|${mark.latest}|${mark.spread}|${mark.evidence}`
}
