// Best-effort GitHub item titles for chat auto-naming: a first message that
// references an issue or PR names the chat after the item. The datastore is
// optional — a miss or a failure falls back to the stripped sentence and
// never fails the turn.

import type { IssueReference } from '../../src/chat-title'
import { runCli, selectOrganizations, type DatastoreRecord } from '../gh'

/** The item's title from the local datastore, or null when it is not there. */
export async function resolveIssueTitle(ref: IssueReference): Promise<string | null> {
  let orgs
  try { orgs = selectOrganizations() } catch { return null }
  const org = orgs.find((o) => o.login.toLowerCase() === ref.owner.toLowerCase())
  if (!org) return null
  const repo = `${ref.owner}/${ref.repo}`
  const views = ref.kind === 'unknown' ? ['issue', 'pr'] as const : [ref.kind === 'pull' ? 'pr' : 'issue'] as const
  const reads = await Promise.all(views.map((view) =>
    runCli(org, ['view', view, '--repo', repo, '--number', String(ref.number), '--format', 'json'])
      .then((rows) => rows, (): DatastoreRecord[] => []),
  ))
  for (const rows of reads) {
    const title = rows.map((row) => row.title).find((value): value is string => typeof value === 'string' && !!value.trim())
    if (title) return title
  }
  return null
}
