import type { SessionRecord, SessionStatus } from '../server/chat/protocol'

/** Fold a `status.changed` event into the live record. A progress-only event
 *  (no reason, still queued) keeps the live reason; leaving `queued` clears
 *  it. The server only ever sets a new reason together with the event. */
export function applyStatusChanged(record: SessionRecord, event: { status: SessionStatus, queuedBehind?: string }, at: string): SessionRecord {
  return { ...record, status: event.status,
    queuedBehind: event.queuedBehind ?? (event.status === 'queued' ? record.queuedBehind : undefined),
    updatedAt: at }
}

/** Slow REST snapshots must not undo a newer streamed model, mode or status. */
export function reconcileSession(current: SessionRecord, incoming: SessionRecord): SessionRecord {
  const record = incoming.lastSeq < current.lastSeq ? current : incoming
  const queue = (current.queue?.revision ?? -1) > (incoming.queue?.revision ?? -1) ? current.queue : incoming.queue
  return queue ? { ...record, queue } : record
}
