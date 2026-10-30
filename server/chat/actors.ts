// Which chat acted on another chat: frozen snapshots for transcripts and
// sanitized names for native headers. Manager status comes only from the
// acting chat's SessionRecord.role — never from creating workers.
import type { ChatActor, SessionRecord } from './protocol'

/** Freeze the acting chat's identity at the moment it acts. */
export function actorOf(record: Pick<SessionRecord, 'id' | 'title' | 'role'>): ChatActor {
  return { kind: 'chat', sessionId: record.id, title: record.title.slice(0, 200), ...(record.role ? { role: record.role } : {}) }
}

/** Sanitized native name: 'the workspace Manager (chat <id>, "<t>")' or 'chat <id> ("<t>")'; no quoted part for an empty title. */
export function nativeName(actor: ChatActor): string {
  const clean = actor.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/["[\];]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!clean) return `chat ${actor.sessionId}`
  return actor.role === 'manager'
    ? `the workspace Manager (chat ${actor.sessionId}, "${clean}")`
    : `chat ${actor.sessionId} ("${clean}")`
}
