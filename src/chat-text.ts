// Pure Chat session copy: queueing and delete-confirmation wording. The
// delete preview is best-effort — the server decides authoritatively when
// the session is deleted and reports the outcome with the delete.
import { SLOT_WAIT_REASON } from '../server/chat/protocol'
import type { SessionRecord } from '../server/chat/protocol'

/** What a `queued` session shows: the agent-slot wait reads verbatim,
 *  checkout contention reads as `queued behind …`. */
export function queuedStatusText(queuedBehind?: string): string {
  if (!queuedBehind) return 'queued behind another session'
  if (queuedBehind === SLOT_WAIT_REASON) return SLOT_WAIT_REASON
  return `queued behind ${queuedBehind}`
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isProvisionedWorkspace(checkout: string): boolean {
  const parts = checkout.split('/')
  return parts.length >= 3 && parts[parts.length - 1] === 'workspace' && parts[parts.length - 3] === 'workers'
    && WORKSPACE_ID.test(parts[parts.length - 2])
}

/** Whether deleting `session` is expected to remove its scratch workspace:
 *  a sole Poise-local session on a provisioned workspace whose branch never
 *  moved and whose tree is not known dirty. */
export function deleteRemovesWorkspace(session: SessionRecord, sessions: Iterable<SessionRecord>): boolean {
  if (session.workspaceKind !== 'poise-local') return false
  if (!isProvisionedWorkspace(session.checkout)) return false
  for (const other of sessions) {
    if (other.id !== session.id && other.checkout === session.checkout) return false
  }
  if (session.branch.origin !== 'new' || !session.branch.provisional) return false
  if (session.workspace?.dirty === true) return false
  return true
}

export interface DeleteConfirmCopy { title: string, label: string }

/** The armed delete confirmation says whether the workspace goes with it. */
export function deleteConfirmCopy(session: SessionRecord, sessions: Iterable<SessionRecord>): DeleteConfirmCopy {
  if (deleteRemovesWorkspace(session, sessions)) {
    return { title: 'Confirm delete (also removes its workspace)', label: 'Confirm deleting session (also removes its workspace)' }
  }
  return { title: 'Confirm delete (keeps its workspace)', label: 'Confirm deleting session (keeps its workspace)' }
}
