// Analytics — the headline numbers in the burger menu's Analytics panel.
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

import { getMeta, listCompletedBehaviorActions, type BehaviorLaunchAction, type CompletedBehaviorAction } from './db'
import { HttpError } from './http'
import { involvementScopes, runCli, selectOrganizations, type DatastoreRecord, type OrganizationReadError } from './gh'
import type { Organization } from './organizations'

export interface AnalyticsWindow {
  /** Inclusive start; null is "since the beginning". */
  since: string | null
  /** Exclusive end; null is "until now". */
  until: string | null
}

export interface AnalyticsReport {
  window: AnalyticsWindow
  issues: { opened: number, closed: number }
  pullRequests: {
    merged: number
    /** Conversation and review comments per merged PR; null without merged PRs. */
    commentsPerPr: number | null
    lines: {
      /** Additions plus deletions over the merged PRs whose size is known. */
      total: number | null
      median: number | null
      /** How many merged PRs have a known size; the rest await a full sync. */
      counted: number
    }
    behaviors: {
      perPr: number | null
      approvals: number
      reviews: number
      changesRequested: number
    }
    /** Mean time from opening to merge, in milliseconds. */
    averageTimeToMergeMs: number | null
  }
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
  errors?: OrganizationReadError[]
}): AnalyticsReport {
  const { window } = input
  const merged = input.prs.filter((pr) => pr.status === 'merged' && inWindow(pr.closed_at, window))

  const sizes = merged
    .filter((pr) => Number.isSafeInteger(pr.additions) && Number.isSafeInteger(pr.deletions))
    .map((pr) => pr.additions! + pr.deletions!)

  const mergedKeys = new Set(merged.map((pr) => itemKey(pr.repo, pr.number)))
  const behaviors = { approvals: 0, reviews: 0, changesRequested: 0 }
  for (const action of input.behaviors) {
    if (mergedKeys.has(itemKey(action.repo, action.pr))) behaviors[BEHAVIOR_FIELD[action.action]] += 1
  }
  const behaviorTotal = behaviors.approvals + behaviors.reviews + behaviors.changesRequested

  return {
    window,
    issues: {
      opened: input.issues.filter((issue) => inWindow(issue.created_at, window)).length,
      closed: input.issues.filter((issue) => issue.status === 'closed' && inWindow(issue.closed_at, window)).length,
    },
    pullRequests: {
      merged: merged.length,
      commentsPerPr: mean(merged.map((pr) => (pr.comments_count ?? 0) + (pr.review_comments_count ?? 0))),
      lines: {
        total: sizes.length ? sizes.reduce((sum, size) => sum + size, 0) : null,
        median: median(sizes),
        counted: sizes.length,
      },
      behaviors: { perPr: merged.length ? behaviorTotal / merged.length : null, ...behaviors },
      averageTimeToMergeMs: mean(merged.map((pr) => Date.parse(pr.closed_at!) - Date.parse(pr.created_at))),
    },
    errors: input.errors ?? [],
  }
}

function dedupe(rows: DatastoreRecord[]): DatastoreRecord[] {
  const byKey = new Map<string, DatastoreRecord>()
  for (const row of rows) byKey.set(itemKey(row.repo, row.number), row)
  return [...byKey.values()]
}

async function readOrganization(org: Organization, me: string, window: AnalyticsWindow): Promise<{ issues: DatastoreRecord[], prs: DatastoreRecord[] }> {
  // Anything opened, closed or merged since the window began was updated
  // since then too, so the datastore can narrow the read. It rounds the time
  // down to the second, which only widens the read; the window itself is
  // applied exactly in computeAnalytics.
  const common = [...(window.since ? ['--updated-since-datetime', window.since] : []), '--format', 'json']
  const read = (scope: string[]) => runCli(org, ['view', ...scope, ...common])
  const [issueRows, prScopeRows, prDetails] = await Promise.all([
    Promise.all(involvementScopes('issue', me).map(read)),
    Promise.all(involvementScopes('pr', me).map(read)),
    // views.user has no comment counts or sizes; views.pr has both.
    read(['pr']),
  ])
  const inScope = new Set(prScopeRows.flat().map((row) => itemKey(row.repo, row.number)))
  return {
    issues: dedupe(issueRows.flat()),
    prs: dedupe(prDetails.filter((row) => inScope.has(itemKey(row.repo, row.number)))),
  }
}

export async function readAnalytics(window: AnalyticsWindow, orgLogin?: string): Promise<AnalyticsReport> {
  const orgs = selectOrganizations(orgLogin)
  if (!orgs.length) throw new HttpError(409, 'No GitHub account is ready yet')
  const me = getMeta('me') || ''
  const results = await Promise.allSettled(orgs.map((org) => readOrganization(org, me, window)))
  const issues: DatastoreRecord[] = []
  const prs: DatastoreRecord[] = []
  const errors: OrganizationReadError[] = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      issues.push(...result.value.issues)
      prs.push(...result.value.prs)
      // A readable cache can still be stale after synchronization failed.
      if (orgs[i].error) errors.push({ org: orgs[i].login, error: orgs[i].error! })
    } else {
      errors.push({ org: orgs[i].login, error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
    }
  })
  // Numbers from no account at all would read as a quiet week.
  if (results.every((result) => result.status === 'rejected')) {
    throw new HttpError(502, errors.map((entry) => `${entry.org}: ${entry.error}`).join('; '))
  }
  return computeAnalytics({ window, issues, prs, behaviors: listCompletedBehaviorActions(), errors })
}
