// Analytics — the headline numbers of the Analytics view (burger menu).
//
// It counts what Current shows: the issues and pull requests `me` is
// involved in plus what the agent account authored (involvementScopes), in
// the selected account or all of them. Counts are of events inside the
// window; every per-PR number is over the pull requests merged in it, so the
// numbers describe one set of pull requests rather than a mix.
//
// Behaviors per PR come from Poise's own ledger of completed launches
// (behavior_seen): an approval or a review counts once its agent reported the
// result, which is what actually happened on GitHub.
//
// Pull request flow counts openings, unmerged closings and first reviews in
// the window. A first review is the earliest review someone other than the
// author submitted; its time runs from the pull request's opening.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { WORK_TYPES, workType, type ReviewSummary, type WorkReviewAnalytics } from '../src/analytics-work-review'
import { getMeta, listCompletedBehaviorActions, type BehaviorLaunchAction, type CompletedBehaviorAction } from './db'
import { HttpError } from './http'
import { involvementScopes, repoBelongsTo, selectOrganizations, type DatastoreRecord, type OrganizationReadError } from './gh'
import type { Organization } from './organizations'
import { agentAccount } from './settings'

export interface AnalyticsWindow {
  /** Inclusive start; null is "since the beginning". */
  since: string | null
  /** Exclusive end; null is "until now". */
  until: string | null
}

export interface AnalyticsReport {
  window: AnalyticsWindow
  /** The agent account from Settings; null when none is set. */
  agentAccount: string | null
  issues: { opened: number, closed: number }
  pullRequests: {
    opened: number
    /** Closed without merging. */
    closedUnmerged: number
    merged: number
    workReview: WorkReviewAnalytics
    /** Merged pull requests the agent account merged; null without one. */
    mergedByAgent: number | null
    /** First reviews submitted in the window, timed from each opening. */
    firstReview: { count: number, medianMs: number | null }
    /** Conversation and review comments per merged PR; null without merged PRs. */
    commentsPerPr: number | null
    medianCommentsPerPr?: number | null
    lines: {
      /** Additions plus deletions over the merged PRs whose size is known. */
      total: number | null
      median: number | null
      /** How many merged PRs have a known size; the rest await a full sync. */
      counted: number
    }
    behaviors: {
      perPr: number | null
      medianPerPr?: number | null
      approvals: number
      reviews: number
      changesRequested: number
    }
    /** Mean time from opening to merge, in milliseconds. */
    averageTimeToMergeMs: number | null
    medianTimeToMergeMs: number | null
  }
  daily?: AnalyticsPeriod[]
  errors: Array<OrganizationReadError & { stale?: boolean }>
}

/** The same metrics as the selected day, aggregated over one history period. */
export interface AnalyticsPeriod {
  since: string
  until: string
  issues: AnalyticsReport['issues']
  pullRequests: AnalyticsReport['pullRequests']
}

export interface AnalyticsHistory {
  periods: AnalyticsPeriod[]
  errors: OrganizationReadError[]
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function windowBound(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, `${name} must be a date and time with a timezone`)
  }
  // Exact to the millisecond: rounding would move an edge of the window.
  return new Date(Date.parse(value)).toISOString()
}

export function parseWindow(since: unknown, until: unknown): AnalyticsWindow {
  const window = { since: windowBound(since, 'since'), until: windowBound(until, 'until') }
  if (window.since && window.until && Date.parse(window.since) >= Date.parse(window.until)) {
    throw new HttpError(400, 'since must be before until')
  }
  return window
}

/** A year and a half of weekly periods at most, plus the closing edge. */
const MAX_BOUNDS = 80

/** The edges of consecutive periods: comma-separated zoned times, increasing. */
export function parseBounds(value: unknown): string[] {
  const parts = typeof value === 'string' && value ? value.split(',') : []
  if (parts.length < 2 || parts.length > MAX_BOUNDS) throw new HttpError(400, `bounds must list 2 to ${MAX_BOUNDS} period edges`)
  const bounds = parts.map((part) => {
    const bound = windowBound(part, 'every bound')
    if (!bound) throw new HttpError(400, 'every bound must be a date and time with a timezone')
    return bound
  })
  if (bounds.some((bound, i) => i > 0 && Date.parse(bounds[i - 1]) >= Date.parse(bound))) {
    throw new HttpError(400, 'bounds must increase')
  }
  return bounds
}

function inWindow(at: string | null | undefined, window: AnalyticsWindow): boolean {
  if (!at) return false
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return false
  return (!window.since || t >= Date.parse(window.since)) && (!window.until || t < Date.parse(window.until))
}

function itemKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

const BEHAVIOR_FIELD: Record<BehaviorLaunchAction, 'approvals' | 'reviews' | 'changesRequested'> = {
  approved: 'approvals',
  reviewed_clean: 'reviews',
  requested_changes: 'changesRequested',
}

/** The numbers, from records already narrowed to the person's scope. */
export function computeAnalytics(input: {
  window: AnalyticsWindow
  issues: DatastoreRecord[]
  prs: DatastoreRecord[]
  behaviors: CompletedBehaviorAction[]
  /** The agent account from Settings, whose merges are counted. */
  agent?: string
  errors?: OrganizationReadError[]
}): AnalyticsReport {
  const { window } = input
  const agent = input.agent?.toLowerCase() || null
  const merged = input.prs.filter((pr) => pr.status === 'merged' && inWindow(pr.closed_at, window))

  const mergeTimes = merged.map((pr) => Date.parse(pr.closed_at!) - Date.parse(pr.created_at))
  const firstReviewTimes = input.prs
    .filter((pr) => inWindow(pr.first_review_at, window))
    .map((pr) => Date.parse(pr.first_review_at!) - Date.parse(pr.created_at))
    .filter((ms) => ms >= 0)

  const sizes = merged
    .filter((pr) => Number.isSafeInteger(pr.additions) && Number.isSafeInteger(pr.deletions))
    .map((pr) => pr.additions! + pr.deletions!)

  const mergedKeys = new Set(merged.map((pr) => itemKey(pr.repo, pr.number)))
  const behaviors = { approvals: 0, reviews: 0, changesRequested: 0 }
  const behaviorsByPr = new Map([...mergedKeys].map((key) => [key, 0]))
  for (const action of input.behaviors) {
    const key = itemKey(action.repo, action.pr)
    if (mergedKeys.has(key)) {
      behaviors[BEHAVIOR_FIELD[action.action]] += 1
      behaviorsByPr.set(key, behaviorsByPr.get(key)! + 1)
    }
  }
  const behaviorTotal = behaviors.approvals + behaviors.reviews + behaviors.changesRequested
  const reviewed = merged.flatMap((pr) => pr.review_summary ? [pr.review_summary] : [])
  const knownRounds = reviewed.filter((review) => review.missingCommits === 0)
  const distribution = new Map<number, number>()
  for (const review of knownRounds) distribution.set(review.rounds, (distribution.get(review.rounds) ?? 0) + 1)
  const types = new Map(WORK_TYPES.map((type) => [type, 0]))
  for (const pr of merged) {
    const type = workType(pr.title)
    types.set(type, types.get(type)! + 1)
  }

  return {
    window,
    agentAccount: input.agent || null,
    issues: {
      opened: input.issues.filter((issue) => inWindow(issue.created_at, window)).length,
      closed: input.issues.filter((issue) => issue.status === 'closed' && inWindow(issue.closed_at, window)).length,
    },
    pullRequests: {
      opened: input.prs.filter((pr) => inWindow(pr.created_at, window)).length,
      closedUnmerged: input.prs.filter((pr) => pr.status === 'closed' && inWindow(pr.closed_at, window)).length,
      merged: merged.length,
      workReview: {
        reviewed: reviewed.length === merged.length ? reviewed.filter((review) => review.rounds > 0 || review.missingCommits > 0).length : null,
        types: [...types].filter(([, count]) => count > 0).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
        rounds: {
          median: knownRounds.length === merged.length ? median(knownRounds.map((review) => review.rounds)) : null,
          counted: knownRounds.length,
          missingReviews: reviewed.reduce((sum, review) => sum + review.missingCommits, 0),
          distribution: [...distribution].sort(([a], [b]) => a - b).map(([rounds, prs]) => ({ rounds, prs })),
        },
        changesRequested: {
          prs: reviewed.length === merged.length ? reviewed.filter((review) => review.changeRequests > 0).length : null,
          reviews: reviewed.length === merged.length ? reviewed.reduce((sum, review) => sum + review.changeRequests, 0) : null,
          dismissed: reviewed.length === merged.length ? reviewed.reduce((sum, review) => sum + review.dismissed, 0) : null,
          counted: reviewed.length,
        },
      },
      mergedByAgent: agent ? merged.filter((pr) => pr.merged_by?.toLowerCase() === agent).length : null,
      firstReview: { count: firstReviewTimes.length, medianMs: median(firstReviewTimes) },
      commentsPerPr: mean(merged.map((pr) => (pr.comments_count ?? 0) + (pr.review_comments_count ?? 0))),
      medianCommentsPerPr: median(merged.map((pr) => (pr.comments_count ?? 0) + (pr.review_comments_count ?? 0))),
      lines: {
        total: sizes.length ? sizes.reduce((sum, size) => sum + size, 0) : null,
        median: median(sizes),
        counted: sizes.length,
      },
      behaviors: { perPr: merged.length ? behaviorTotal / merged.length : null, medianPerPr: median([...behaviorsByPr.values()]), ...behaviors },
      averageTimeToMergeMs: mean(mergeTimes),
      medianTimeToMergeMs: median(mergeTimes),
    },
    errors: input.errors ?? [],
  }
}

/** The headline numbers of each consecutive period between the bounds, counted as a day is. */
export function computeHistory(input: {
  bounds: string[]
  issues: DatastoreRecord[]
  prs: DatastoreRecord[]
  errors?: OrganizationReadError[]
  behaviors?: CompletedBehaviorAction[]
  agent?: string
}): AnalyticsHistory {
  return {
    periods: input.bounds.slice(1).map((until, i) => {
      const since = input.bounds[i]
      const report = computeAnalytics({ window: { since, until }, issues: input.issues, prs: input.prs, behaviors: input.behaviors ?? [], agent: input.agent })
      return { since, until, issues: report.issues, pullRequests: report.pullRequests }
    }),
    errors: input.errors ?? [],
  }
}

// Read the same datastore views and involvement scopes as Current without
// starting Python for every scope. Project only fields used by the report:
// unused view columns can parse large payloads and count entire discussions.
async function readOrganization(org: Organization, me: string, window: AnalyticsWindow): Promise<{ issues: DatastoreRecord[], prs: DatastoreRecord[] }> {
  const path = org.datastorePath ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'github-datastore', 'github_datastore.sqlite')
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 1_000 })
  try {
    // Keep one snapshot while yielding between bounded slices of work. A
    // synchronous .all() across a year prevents even quota/health reads.
    const scopeByKind = { issue: involvementScopes('issue', me), pr: involvementScopes('pr', me) }
    db.exec('BEGIN')
    const mergedDetails = db.prepare<[number], Pick<DatastoreRecord, 'comments_count' | 'review_comments_count' | 'additions' | 'deletions' | 'merged_by'>>(`
      SELECT comments_count, review_comments_count, additions, deletions,
        json_extract(i.expanded_json, '$.pull.merged_by.login') AS merged_by
      FROM prs JOIN items i ON i.item_id = pr_ref WHERE pr_ref = ?
    `)
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
      const scopes = scopeByKind[kind].map(scope => {
        const user = scope[0] === 'user'
        const filters: string[] = []
        if (user) {
          filters.push('a.username = ?', 'i.item_type = ?')
          params.push(me, kind)
        } else if (scope[1] === '--author') {
          filters.push('author = ?')
          params.push(scope[2])
        }
        // Match the CLI's second-resolution narrowing; computeAnalytics
        // applies the exact inclusive/exclusive millisecond boundaries.
        if (window.since) {
          filters.push('updated_at >= ?')
          params.push(new Date(window.since).toISOString().slice(0, 19))
        }
        // Only membership is needed. user_items groups all involvement
        // evidence into explanations before it can return these same IDs.
        return `SELECT ${user ? 'a.item_id' : ref} FROM ${user ? 'associations a JOIN items i ON i.item_id = a.item_id' : view}${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}`
      })
      // A pending review is not submitted, and an author's own review is a
      // reply. A review counts unless it is known to be the author's: a
      // deleted account leaves either login NULL.
      // Discussion counts and size JSON are only used for PRs merged in
      // this window; openings and first reviews need none of that payload.
      const details = kind === 'pr' ? `pr_ref, 0 AS comments_count,
        (SELECT min(r.submitted_at) FROM reviews r WHERE r.item_id = pr_ref AND r.submitted_at IS NOT NULL
          AND r.state <> 'PENDING' AND (r.author_login IS NULL OR author IS NULL OR lower(r.author_login) <> lower(author))) AS first_review_at`
        : '0 AS comments_count'
      const query = db.prepare<string[], DatastoreRecord>(`
        SELECT repo, number, status, author, updated_at, created_at, closed_at, title, url, ${details}
        FROM ${view} WHERE ${ref} IN (${scopes.join(' UNION ')})
      `)
      const rows: DatastoreRecord[] = []
      let sliceStart = performance.now()
      for (const row of query.iterate(...params)) {
        if (!repoBelongsTo(row.repo, org.login)) throw new Error(`datastore contains records outside ${org.login}`)
        if (kind === 'pr' && row.status === 'merged' && inWindow(row.closed_at, window)) {
          Object.assign(row, mergedDetails.get(row.pr_ref!))
          row.review_summary = mergedReviews.get(row.pr_ref!)!
        }
        rows.push(row)
        if (rows.length % 64 === 0 || performance.now() - sliceStart >= 8) {
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

async function readScoped(window: AnalyticsWindow, orgLogin: string | undefined): Promise<{ issues: DatastoreRecord[], prs: DatastoreRecord[], errors: Array<OrganizationReadError & { stale?: boolean }> }> {
  const orgs = selectOrganizations(orgLogin)
  if (!orgs.length) throw new HttpError(409, 'No GitHub account is ready yet')
  const me = getMeta('me') || ''
  const results = await Promise.allSettled(orgs.map((org) => readOrganization(org, me, window)))
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
    throw new HttpError(502, errors.map((entry) => `${entry.org}: ${entry.error}`).join('; '))
  }
  return { issues, prs, errors }
}

export async function readAnalytics(window: AnalyticsWindow, orgLogin?: string, dailyBounds?: string[]): Promise<AnalyticsReport> {
  if (dailyBounds && (dailyBounds.length !== 8 || dailyBounds[0] !== window.since || dailyBounds.at(-1) !== window.until)) {
    throw new HttpError(400, 'daily bounds must cover the requested seven-day window')
  }
  const agent = agentAccount()
  const { issues, prs, errors } = await readScoped(window, orgLogin)
  const input = { window, issues, prs, behaviors: listCompletedBehaviorActions(), agent, errors }
  return { ...computeAnalytics(input), ...(dailyBounds ? { daily: computeHistory({ ...input, bounds: dailyBounds }).periods } : {}) }
}

/** One local datastore read across every period, then each period counted alike. */
export async function readAnalyticsHistory(bounds: string[], orgLogin?: string): Promise<AnalyticsHistory> {
  const agent = agentAccount()
  const { issues, prs, errors } = await readScoped({ since: bounds[0], until: bounds.at(-1)! }, orgLogin)
  return computeHistory({ bounds, issues, prs, errors, behaviors: listCompletedBehaviorActions(), agent })
}
