// Per-row saving (#556, PRD-INTERFACE.md, "Settings saving"). A row sends only
// its own field, with `expect` holding what this tab knows of that field, so
// another tab's change is refused with 409 instead of overwritten. Saves go out
// one at a time, in the order they were made, each built when it is sent from
// the newest settings this tab knows, so two rows of one field never refuse
// each other. Only a row's newest edit decides what the row says: an edit
// made while an older one waits replaces it, and an older answer that lands
// first updates what the tab knows but not the row.
//
// A refusal over another part of the same field (another tab changed the
// branch prefix while this row saves the idle timeout) is not this row's
// conflict: the row sends only its own leaf, so it is sent again on what the
// server now holds, and the other change is kept. A refusal over the row's own
// value is a conflict, and the row keeps its draft.
//
// Pure: the request is passed in, so the unit suite drives it without a server.
import { deepEqual } from '../../../settings-save'

export type Known = Record<string, unknown>

/** What one row sends: its own field, and what this tab knows of it. */
export interface Payload { body: Record<string, unknown>, expect: Record<string, unknown> }

export type Outcome =
  | { kind: 'saved', settings: Known }
  /** 409: `current` holds the server's values for the fields that moved. */
  | { kind: 'conflict', current: Record<string, unknown> }
  | { kind: 'failed', message: string }
  /** A newer edit of the same row replaced this one; the row waits for that. */
  | { kind: 'superseded' }

export interface Answer { status: number, data: unknown }
export type Post = (payload: Payload) => Promise<Answer>

/** How a row saves: what it sends, and which part of the settings is its own. */
export interface Save {
  build: (known: Known) => Payload
  /** The row's own value in the settings; a 409 that leaves it as sent is sent again. */
  own: (known: Known) => unknown
}

interface Entry extends Save { row: string, seq: number, resolve: (outcome: Outcome) => void }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const reason = (data: unknown, status: number): string => isRecord(data) && typeof data.error === 'string' && data.error ? data.error : `Poise answered ${status}`
/** Sends again at most this often when only other parts of the field moved. */
const RESENDS = 2

export interface SaveQueue {
  /** The newest settings this tab knows. */
  known(): Known
  /** A fresh read of the settings, taken as what this tab knows. */
  setKnown(settings: Known): void
  /** Queues a row's save; resolves with what happened to it. */
  send(row: string, save: Save): Promise<Outcome>
  /** Whether any save is waiting or on its way. */
  busy(): boolean
}

export function createSaveQueue(post: Post, onSaved: (settings: Known) => void = () => {}): SaveQueue {
  let known: Known = {}
  let seq = 0
  let sending = false
  const waiting: Entry[] = []
  const newest = new Map<string, number>()

  async function attempt(entry: Entry): Promise<Outcome> {
    for (let resends = 0; ; resends++) {
      const sent = entry.own(known)
      let answer: Answer
      try {
        answer = await post(entry.build(known))
      } catch (error) {
        return { kind: 'failed', message: (error as Error).message || String(error) }
      }
      if (answer.status >= 200 && answer.status < 300 && isRecord(answer.data)) {
        known = answer.data
        onSaved(known)
        return { kind: 'saved', settings: known }
      }
      if (answer.status === 409 && isRecord(answer.data) && isRecord(answer.data.current)) {
        known = { ...known, ...answer.data.current }
        if (deepEqual(entry.own(known), sent) && resends < RESENDS) continue
        return { kind: 'conflict', current: answer.data.current }
      }
      return { kind: 'failed', message: reason(answer.data, answer.status) }
    }
  }

  async function pump(): Promise<void> {
    if (sending) return
    sending = true
    try {
      while (waiting.length) {
        const entry = waiting.shift()!
        const outcome = await attempt(entry)
        entry.resolve(newest.get(entry.row) === entry.seq ? outcome : { kind: 'superseded' })
      }
    } finally {
      sending = false
    }
  }

  return {
    known: () => known,
    setKnown(settings) { known = settings },
    send(row, save) {
      const mine = ++seq
      newest.set(row, mine)
      return new Promise<Outcome>((resolve) => {
        // An edit not yet sent gives its place in line to the newer one.
        const queued = waiting.findIndex((entry) => entry.row === row)
        const entry: Entry = { ...save, row, seq: mine, resolve }
        if (queued >= 0) {
          waiting[queued].resolve({ kind: 'superseded' })
          waiting[queued] = entry
        } else waiting.push(entry)
        void pump()
      })
    },
    busy: () => sending || waiting.length > 0,
  }
}

/** The settings as POST /api/settings takes them, through `fetch`. */
export const postSettings: Post = async (payload) => {
  const response = await fetch('/api/settings', {
    method: 'POST', cache: 'no-store', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...payload.body, ...(Object.keys(payload.expect).length ? { expect: payload.expect } : {}) }),
  })
  return { status: response.status, data: await response.json().catch(() => null) }
}

const expectOf = (name: string, known: Known): Record<string, unknown> => (name in known ? { [name]: known[name] } : {})

/** One top-level field, sent whole, with what this tab knows of it. */
export const field = (name: string, value: unknown): Save => ({
  build: (known) => ({ body: { [name]: value }, expect: expectOf(name, known) }),
  own: (known) => known[name],
})

/** One leaf of an object field (a `chat` setting, say), with the whole field as this tab knows it. */
export const leaf = (name: string, key: string, value: unknown): Save => ({
  build: (known) => ({ body: { [name]: { [key]: value } }, expect: expectOf(name, known) }),
  own: (known) => (isRecord(known[name]) ? (known[name] as Record<string, unknown>)[key] : undefined),
})
