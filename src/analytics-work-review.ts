/** Conventional Commit prefixes; titles without one remain unclassified. */
export const WORK_TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert', 'unclassified'] as const
export type WorkType = typeof WORK_TYPES[number]

export function workType(title: string): WorkType {
  const prefix = /^([a-z]+)(?:\([^()\r\n]+\))?!?:\s+\S/i.exec(title)?.[1].toLowerCase()
  return WORK_TYPES.find((type) => type !== 'unclassified' && type === prefix) ?? 'unclassified'
}

/** Submitted non-author reviews observed at or before merge. */
export interface ReviewSummary {
  rounds: number
  missingCommits: number
  changeRequests: number
  dismissed: number
}

export interface WorkReviewAnalytics {
  /** Merged PRs with any eligible submitted review; null if summaries are unavailable. */
  reviewed: number | null
  types: Array<{ type: WorkType, count: number }>
  rounds: {
    /** Distinct reviewed revisions per merged PR; null for empty or incomplete cohorts. */
    median: number | null
    /** PRs with exact counts, including zero-review PRs. */
    counted: number
    /** Eligible review records lacking commit identities. */
    missingReviews: number
    distribution: Array<{ rounds: number, prs: number }>
  }
  /** Observed affected PRs/review records; counted is available local per-PR summaries. */
  changesRequested: { prs: number | null, reviews: number | null, dismissed: number | null, counted: number }
}

export function roundCoverage(pr: { merged: number, workReview?: WorkReviewAnalytics }, cohort: string): string {
  if (!pr.merged) return `${cohort}: no merged PRs.`
  const work = pr.workReview
  if (!work) return `${cohort}: review aggregates unavailable for ${pr.merged} merged PRs.`
  return `${cohort}: exact round counts for ${work.rounds.counted} of ${pr.merged} merged PRs; ${work.rounds.missingReviews} reviews lack commit identities. ${work.reviewed ?? 'Unknown'} of ${pr.merged} PRs had an eligible review.`
}

export function changeCoverage(pr: { merged: number, workReview?: WorkReviewAnalytics }, cohort: string): string {
  if (!pr.merged) return `${cohort}: no merged PRs.`
  const work = pr.workReview
  if (!work) return `${cohort}: review aggregates unavailable for ${pr.merged} merged PRs.`
  const changes = work.changesRequested
  return `${cohort}: ${changes.prs ?? 'Unknown'} of ${pr.merged} merged PRs with observed change requests (${changes.reviews ?? 'unknown'} reviews). Stored summaries available for ${changes.counted} of ${pr.merged} PRs. ${work.reviewed ?? 'Unknown'} of ${pr.merged} PRs had an eligible review; ${changes.dismissed ?? 'unknown'} dismissed reviews.`
}

export function changeRequestShare(pr: { merged: number, workReview?: WorkReviewAnalytics }): number | null {
  const count = pr.workReview?.changesRequested.prs
  return pr.merged && count !== null && count !== undefined ? count / pr.merged * 100 : null
}
