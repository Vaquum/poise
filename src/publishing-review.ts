/** GitHub review data stays separate from the writer's editable annotations. */
export interface ReviewMessage {
  id: string
  author: string
  body: string
  url: string
  createdAt: string
}

export interface ReviewAnchor {
  quote: string
  before: string
  after: string
  unique: boolean
}

export interface ArticleReview {
  id: string
  kind: 'thread' | 'comment' | 'review'
  repo: string
  site: string
  pr: number
  prUrl: string
  path?: string
  resolved: boolean
  outdated: boolean
  canReply: boolean
  canResolve: boolean
  messages: ReviewMessage[]
  anchor?: ReviewAnchor
  location?: string
}

export interface ArticleReviews {
  reviews: ArticleReview[]
  checkedAt: string | null
  active: boolean
  stale: boolean
  problems: string[]
  retryAt?: string
}

export const REVIEW_INTERVAL_MS = 5 * 60_000

/** Exact passage plus surrounding lines. Ambiguous locations stay in the review list. */
export function locateReview(text: string, anchor: ReviewAnchor): { start: number, end: number } | null {
  const original = text
  text = text.replace(/\r\n/g, '\n')
  const rawOffset = (offset: number): number => {
    let removed = 0
    for (const match of original.matchAll(/\r\n/g)) {
      if (match.index! - removed >= offset) break
      removed++
    }
    return offset + removed
  }
  const rangeAt = (at: number) => ({ start: rawOffset(at), end: rawOffset(at + anchor.quote.length) })
  if (!anchor.quote.trim()) return null
  const candidates: number[] = []
  for (let at = text.indexOf(anchor.quote); at >= 0; at = text.indexOf(anchor.quote, at + 1)) {
    if ((at === 0 || text[at - 1] === '\n') && (at + anchor.quote.length === text.length || text[at + anchor.quote.length] === '\n')) candidates.push(at)
  }
  if (candidates.length === 1 && anchor.unique) return rangeAt(candidates[0])
  if (!anchor.before && !anchor.after) return null
  const contextual = candidates.filter((at) => {
    const beforeStart = at - anchor.before.length - 1
    const afterEnd = at + anchor.quote.length + 1 + anchor.after.length
    return (!anchor.before || (text.slice(0, at).endsWith(`${anchor.before}\n`) && (beforeStart === 0 || text[beforeStart - 1] === '\n')))
      && (!anchor.after || (text.slice(at + anchor.quote.length).startsWith(`\n${anchor.after}`) && (afterEnd === text.length || text[afterEnd] === '\n')))
  })
  return contextual.length === 1 ? rangeAt(contextual[0]) : null
}
