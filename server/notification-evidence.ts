import { normalize } from '../gateway/src/diagnostics/contract'
import type { EvidenceAttachment } from '../gateway/src/diagnostics/evidence-contract'
import type { EvidenceSelector } from '../gateway/src/diagnostics/query-evidence'
import type { NoticesState } from './alerts/notices'
import { openAlerts } from './alerts/store'
import { getMeta, getBehaviorIncident, db } from './db'
import { retainedEvidence } from './logging-api'
import { quotaEvidenceSelector } from './github-quota'
import { loggingWorkspace } from './logging'
import { conditionCorrelation } from './logging-context'

const cliBehavior = (behavior: string) => ({ 'review-new-prs': 'pr_review', 'approve-prs': 'pr_approve', 'review-new-issues': 'issue_review' } as Record<string, string>)[behavior]
const targetRef = (target: string) => target.match(/^[^#]+#\d+/)?.[0] ?? target
function heldSelector(row: { callId?: string | null; correlationId?: string | null; behavior: string; target?: string; error?: string; actor?: string | null; repo?: string | null }): EvidenceSelector | null {
  if (!row.target || !row.error) return null
  const target = targetRef(row.target)
  if (row.callId && /^[a-f0-9]{32}$/.test(row.callId)) {
    const behavior = cliBehavior(row.behavior)
    if (!behavior) return null
    const eventId = normalize({ id: 'caller:' + row.callId, level: 'error', source: 'caller', operation: 'identity', workspace: loggingWorkspace(), message: '' })!.id
    return { eventId, callId: row.callId, source: 'caller', behavior, target, cause: row.error,
      ...(row.correlationId ? { correlationId: row.correlationId } : {}), ...(row.actor ? { account: row.actor } : {}), ...(row.repo ? { repository: row.repo } : {}) }
  }
  if (row.correlationId) return { source: 'poise', correlationId: row.correlationId, behavior: row.behavior, target, cause: row.error }
  return null
}
/** Decoration is bounded and read-only. Condition creation never waits for the diagnostic sink. */
export async function noticeEvidence(state: NoticesState): Promise<NoticesState> {
  const alerts = new Map(openAlerts().map((alert) => [alert.id, alert]))
  const selected: Array<{ index: number; selector: EvidenceSelector }> = []
  const notices = state.notices.map((notice, index) => {
    const alert = alerts.get(notice.id)
    let selector: EvidenceSelector | null = null
    if (notice.subject) {
      const incident = getBehaviorIncident(notice.subject.behavior, notice.subject.target)
      if (incident) selector = heldSelector(incident)
    } else if (alert?.kind === 'storage_low') {
      selector = { source: 'poise', correlationId: conditionCorrelation('storage', alert.dedupeKey, notice.since), operation: 'storage.pressure' }
    } else if (alert?.kind === 'datastore_sync_failing') {
      const login = alert.dedupeKey.slice('datastore-sync:'.length)
      const row = db.prepare('SELECT login,sync_failing_since,error FROM organizations WHERE lower(login)=?').get(login) as { login: string; sync_failing_since: number; error: string | null } | undefined
      if (row?.sync_failing_since) selector = { source: 'poise', correlationId: conditionCorrelation('datastore-sync', login, String(row.sync_failing_since)), account: row.login, operation: 'datastore.sync', ...(row.error ? { cause: row.error } : {}) }
    } else if (alert?.kind === 'github_quota_warning' || alert?.kind === 'github_quota_exhausted') {
      const [, login, resource, reset] = alert.dedupeKey.split(':')
      const account = [getMeta('me'), getMeta('agentAccount')].find((value) => value?.toLowerCase() === login)
      if (account) {
        selector = quotaEvidenceSelector(account, resource, new Date(Number(reset)).toISOString(), alert.kind === 'github_quota_exhausted')
      }
    }
    if (selector && selected.length < 20) selected.push({ index, selector })
    return { ...notice, ...(selector ? { evidenceStatus: 'pending' as const } : {}) }
  })
  const found = await retainedEvidence(selected.map((row) => row.selector))
  selected.forEach((row, index) => Object.assign(notices[row.index], found[index]))
  return { ...state, notices }
}
interface BehaviorEvidenceRow extends EvidenceAttachment { callId?: string | null; correlationId?: string | null; behavior: string; target?: string; error?: string }
export async function behaviorEvidence<T extends { failures: BehaviorEvidenceRow[]; deadLetters: BehaviorEvidenceRow[] }>(diagnostics: T): Promise<T> {
  const failures = diagnostics.failures.map((row) => ({ ...row }))
  const deadLetters = diagnostics.deadLetters.map((row) => ({ ...row }))
  const selected: Array<{ row: EvidenceAttachment; selector: EvidenceSelector }> = []
  for (const row of [...failures, ...deadLetters]) {
    const selector = heldSelector(row)
    if (selector) {
      Object.assign(row, { evidenceStatus: 'pending' })
      if (selected.length < 20) selected.push({ row, selector })
    }
  }
  const found = await retainedEvidence(selected.map((row) => row.selector))
  selected.forEach((row, index) => Object.assign(row.row, found[index]))
  return { ...diagnostics, failures, deadLetters }
}
