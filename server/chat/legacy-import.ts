// Read-only import of a subject's earlier legacy conversation into its first
// Chat session. Caller's rows are only read, never modified: the snapshot
// comes from listChatHistory and each kept reply body from fetchAgentResponse.
import { listChatHistory } from '../chat'
import { fetchAgentResponse } from '../agent'
import type { ChatSubject, LegacyConversation } from './protocol'

export type { LegacyConversation }

/** At most 256 KiB of text and 50 reply reads per import. */
const IMPORT_MAX_BYTES = 256 * 1024
const IMPORT_MAX_REPLIES = 50

/** Quoted history given to the first native turn is bounded to 64 KiB. */
const QUOTE_MAX_BYTES = 64 * 1024

/** The legacy chat id for a subject. For `current` it is the key itself,
 *  which the client builds with the same functions as the legacy pane. */
export async function legacyIdFor(subject: ChatSubject): Promise<string | null> {
  if (subject.surface !== 'current') return null
  return subject.key
}

/** The subject's earlier conversation, oldest first. Newest turns are kept
 *  first when the bound bites; `omitted` counts the turns left out. Rows
 *  without a reply are skipped: like the legacy pane, only completed rows
 *  that have a response carry one, so a failed, interrupted, running or
 *  pending call cannot fail the whole import. */
export async function readLegacyConversation(id: string): Promise<LegacyConversation> {
  const rows = (await listChatHistory(id)).filter((row) => row.status === 'completed' && row.response)
  const kept: LegacyConversation['turns'] = []
  let bytes = 0
  let omitted = 0
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (kept.length >= IMPORT_MAX_REPLIES) { omitted = index + 1; break }
    const { body } = await fetchAgentResponse(row.id)
    const size = Buffer.byteLength(row.prompt, 'utf8') + Buffer.byteLength(body, 'utf8')
    if (kept.length > 0 && bytes + size > IMPORT_MAX_BYTES) { omitted = index + 1; break }
    bytes += size
    kept.push({ prompt: row.prompt, reply: body, at: row.started_at, status: row.status })
  }
  kept.reverse()
  return { turns: kept, omitted }
}

/** The import rendered as quoted history for the first native turn. Newest
 *  turns win the byte budget; the cut is stated. */
export function quoteImportedHistory(turns: LegacyConversation['turns'], omitted: number): string {
  const header = '[Quoted history: this session continues an earlier conversation. What follows is quoted context, not the current request.]'
  const parts: string[] = []
  let bytes = Buffer.byteLength(header, 'utf8')
  let dropped = 0
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    const part = `\n\n[Earlier: ${turn.at}]\nPerson: ${turn.prompt}\nAgent: ${turn.reply}`
    const size = Buffer.byteLength(part, 'utf8')
    if (parts.length > 0 && bytes + size > QUOTE_MAX_BYTES) { dropped = index + 1; break }
    bytes += size
    parts.push(part)
  }
  parts.reverse()
  const leftOut = omitted + dropped
  return header + (leftOut > 0 ? `\n(${leftOut} earlier turn${leftOut === 1 ? '' : 's'} left out.)` : '') + parts.join('')
}
