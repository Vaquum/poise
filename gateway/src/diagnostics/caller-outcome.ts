/** The typed revision fence precedes publication. Diagnostics omit receipts and
 * artifacts but carry artifact.resource_error; full records may retain the
 * unsubmitted review's resource root. Even empty receipts mean posting began,
 * before the first request. */
export function issueReviewSuperseded(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const artifact = row.artifact as Record<string, unknown> | null | undefined
  const unsubmitted = artifact == null || typeof artifact === 'object' && !Array.isArray(artifact)
    && artifact.phase === 'reviewing' && Object.keys(artifact).every(key => key === 'phase' || key === 'resource_root')
  return row.behavior === 'issue_review' && row.status === 'failed'
    && row.error_code === 'issue_revision_changed' && row.action === 'not_started' && row.outcome === 'preflight_failed'
    && row.receipts == null && unsubmitted && row.review_id == null && row.review_comments == null && row.head_sha == null
    && row.resource_error == null
}
