import { homedir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import Database from 'better-sqlite3'
import type { ReviewSummary } from '../src/analytics-work-review'
import type { AnalyticsWindow } from './analytics'
import type { DatastoreRecord, OrganizationReadError } from './gh'
import type { Organization } from './organizations'

type AnalyticsDatastoreOrganization = Pick<Organization, 'login' | 'datastorePath' | 'error'>

export interface AnalyticsDatastoreQuery {
  organizations: AnalyticsDatastoreOrganization[]
  me: string
  window: AnalyticsWindow
  scopes: { issue: string[][], pr: string[][] }
}
export interface AnalyticsDatastoreRecords {
  issues: DatastoreRecord[]
  prs: DatastoreRecord[]
  errors: Array<OrganizationReadError & { stale?: boolean }>
}

export function inWindow(at: string | null | undefined, window: AnalyticsWindow): boolean {
  if (!at) return false
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return false
  return (!window.since || t >= Date.parse(window.since)) && (!window.until || t < Date.parse(window.until))
}

/** Shared query boundary for merged-detail reads and their performance contract. */
export function prepareMergedDetails(db: Database.Database) {
  return db.prepare<[number], Pick<DatastoreRecord, 'comments_count' | 'review_comments_count' | 'additions' | 'deletions' | 'merged_by'>>(`
    WITH payload AS MATERIALIZED (
      SELECT item_id, json_extract(expanded_json,
        '$.pull.graphql.additions', '$.pull.graphql.deletions', '$.pull.merged_by.login') AS details
      FROM items WHERE item_id = ?
    )
    SELECT (SELECT count(*) FROM comments c WHERE c.item_id = payload.item_id) AS comments_count,
      (SELECT count(*) FROM review_comments c WHERE c.item_id = payload.item_id) AS review_comments_count,
      CAST(json_extract(details, '$[0]') AS INTEGER) AS additions,
      CAST(json_extract(details, '$[1]') AS INTEGER) AS deletions,
      json_extract(details, '$[2]') AS merged_by
    FROM payload
  `)
}

// Read the same datastore views and involvement scopes as Current without
// starting Python for every scope. Project only fields used by the report:
// unused view columns can parse large payloads and count entire discussions.
async function readOrganization(org: AnalyticsDatastoreOrganization, me: string, window: AnalyticsWindow, scopeByKind: AnalyticsDatastoreQuery['scopes']): Promise<{ issues: DatastoreRecord[], prs: DatastoreRecord[] }> {
  const path = org.datastorePath ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'github-datastore', 'github_datastore.sqlite')
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1_000 })
  try {
    // Bound mapped address space, avoiding repeated page copies through the
    // service sandbox. SQLite retains its snapshot and WAL visibility rules.
    db.pragma('mmap_size = 1073741824')
    // Keep one snapshot while yielding between bounded slices of work. A
    // synchronous .all() across a year prevents even quota/health reads.
    db.exec('BEGIN')
    const mergedDetails = prepareMergedDetails(db)
    const mergedReviews = db.prepare<[number], ReviewSummary>(`
      SELECT count(DISTINCT nullif(trim(r.commit_id), '')) AS rounds,
        count(CASE WHEN nullif(trim(r.commit_id), '') IS NULL THEN 1 END) AS missingCommits,
        count(CASE WHEN r.state = 'CHANGES_REQUESTED' THEN 1 END) AS changeRequests,
        count(CASE WHEN r.state = 'DISMISSED' THEN 1 END) AS dismissed
      FROM reviews r JOIN items i ON i.item_id = r.item_id
      WHERE r.item_id = ? AND r.submitted_at IS NOT NULL AND r.state IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED')
        AND julianday(r.submitted_at) <= julianday(i.closed_at)
        AND (r.author_login IS NULL OR i.author_login IS NULL OR lower(r.author_login) <> lower(i.author_login))
    `)
    const read = async (kind: 'issue' | 'pr'): Promise<DatastoreRecord[]> => {
      const view = kind === 'pr' ? 'prs' : 'issues'
      const ref = kind === 'pr' ? 'pr_ref' : 'issue_ref'
      const params: string[] = []
      if (window.since) {
        params.push(new Date(window.since).toISOString().slice(0, 19))
      }
      const scopes = scopeByKind[kind].map(scope => {
        const user = scope[0] === 'user'
        if (user) {
          params.push(me)
          return `EXISTS (SELECT 1 FROM associations a WHERE a.item_id = v.${ref} AND a.username = ?)`
        }
        if (scope[1] === '--author') {
          params.push(scope[2])
          return 'v.author = ?'
        }
        return '1'
      })
      // Stream every range candidate, including nonmatches, so filtering cannot
      // hide a long scan from the cooperative yield below.
      const source = window.since
        ? `(SELECT DISTINCT repo_id FROM items) AS repositories
          CROSS JOIN items AS recent ON recent.repo_id = repositories.repo_id AND recent.updated_at >= ?
          LEFT JOIN ${view} v ON v.${ref} = recent.item_id AND (${scopes.join(' OR ')})`
        : `${view} v WHERE (${scopes.join(' OR ')})`
      // A pending review is not submitted, and an author's own review is a
      // reply. A review counts unless it is known to be the author's: a
      // deleted account leaves either login NULL.
      // Discussion counts and size JSON are only used for PRs merged in
      // this window; openings and first reviews need none of that payload.
      const details = kind === 'pr' ? `v.pr_ref, 0 AS comments_count,
        (SELECT min(r.submitted_at) FROM reviews r WHERE r.item_id = v.pr_ref AND r.submitted_at IS NOT NULL
          AND r.state <> 'PENDING' AND (r.author_login IS NULL OR v.author IS NULL OR lower(r.author_login) <> lower(v.author))) AS first_review_at`
        : '0 AS comments_count'
      const query = db.prepare<string[], DatastoreRecord | { number: null }>(`
        SELECT v.repo, v.number, v.status, v.author, v.updated_at, v.created_at, v.closed_at, v.title, v.url, ${details}
        FROM ${source}
      `)
      const rows: DatastoreRecord[] = []
      let sliceStart = performance.now()
      let scanned = 0
      for (const row of query.iterate(...params)) {
        if (row.number !== null) {
          if (row.repo.split('/', 1)[0].toLowerCase() !== org.login.toLowerCase()) throw new Error(`datastore contains records outside ${org.login}`)
          if (kind === 'pr' && row.status === 'merged' && inWindow(row.closed_at, window)) {
            Object.assign(row, mergedDetails.get(row.pr_ref!))
            row.review_summary = mergedReviews.get(row.pr_ref!)!
          }
          rows.push(row)
        }
        if (++scanned % 64 === 0 || performance.now() - sliceStart >= 8) {
          await setImmediate()
          sliceStart = performance.now()
        }
      }
      return rows
    }
    const prs = await read('pr')
    return { issues: await read('issue'), prs }
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK')
    db.close()
  }
}

export async function readAnalyticsDatastores(input: AnalyticsDatastoreQuery): Promise<AnalyticsDatastoreRecords> {
  const { organizations: orgs, me, window, scopes } = input
  const results = await Promise.allSettled(orgs.map((org) => readOrganization(org, me, window, scopes)))
  const issues: DatastoreRecord[] = []
  const prs: DatastoreRecord[] = []
  const errors: Array<OrganizationReadError & { stale?: boolean }> = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      issues.push(...result.value.issues)
      prs.push(...result.value.prs)
      // A readable cache can still be stale after synchronization failed.
      if (orgs[i].error) errors.push({ org: orgs[i].login, error: orgs[i].error!, stale: true })
    } else {
      errors.push({ org: orgs[i].login, error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
    }
  })
  // Numbers from no account at all would read as a quiet week.
  if (results.every((result) => result.status === 'rejected')) {
    throw Object.assign(new Error(errors.map((entry) => `${entry.org}: ${entry.error}`).join('; ')), { statusCode: 502 })
  }
  return { issues, prs, errors }
}

