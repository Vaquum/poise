// Answer here's dismissals (#1379). Every card can be put away. Notices keep
// their own (server/alerts/notices.ts) and the Switchboard its own; this holds
// the rest — the chain's attention, Behaviors' diagnostics, chats' requests and
// review threads — by the card's key and the revision of what it reported. A
// card returns when its source reports something new. Putting a card away
// never acts on its source: no chain resumes, no run retries, no chat hears of it.
import { recordHandling } from './alerts/handling'
import { db } from './db'
import { HttpError } from './http'

/** Long enough for any card to have changed or cleared; then it may show again. */
export const ANSWER_DISMISSAL_RETENTION_MS = 30 * 24 * 60 * 60_000

export interface AnswerDismissal { key: string, revision: string, at: string }

const SOURCES = ['chain', 'diagnostic', 'request', 'thread'] as const
const MAX_KEY = 2_000
const MAX_TITLE = 500

export function listAnswerDismissals(now = Date.now()): AnswerDismissal[] {
  db.prepare('DELETE FROM answer_dismissals WHERE dismissed_at < ?').run(new Date(now - ANSWER_DISMISSAL_RETENTION_MS).toISOString())
  return db.prepare('SELECT key, revision, dismissed_at AS at FROM answer_dismissals ORDER BY dismissed_at DESC, key').all() as AnswerDismissal[]
}

/** Puts one card away at the revision it showed; the handling log records it under Handled today. */
export function dismissAnswer(input: unknown, now = Date.now()): AnswerDismissal[] {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const { key, revision, title } = body
  if (typeof key !== 'string' || key.length > MAX_KEY || !SOURCES.some((source) => key.startsWith(`${source}:`) && key.length > source.length + 1)) {
    throw new HttpError(400, `key must name a ${SOURCES.join(', ')} card`)
  }
  if (typeof revision !== 'string' || !revision || revision.length > MAX_KEY) throw new HttpError(400, 'revision must say what the card showed')
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE) throw new HttpError(400, 'title must name the card')
  const at = new Date(now).toISOString()
  db.transaction(() => {
    db.prepare(`INSERT INTO answer_dismissals (key, revision, dismissed_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, dismissed_at = excluded.dismissed_at`).run(key, revision, at)
    recordHandling({ kind: 'notice', source: `answer-here:${key.slice(0, key.indexOf(':'))}`, title: title.trim(), startedAt: at, finishedAt: at,
      outcome: 'dismissed', actor: 'person', ref: `answer:${key}:${revision}:dismissed` }, at)
  })()
  return listAnswerDismissals(now)
}
