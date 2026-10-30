import { parseDocument } from 'yaml'
import { HttpError } from '../http'

export interface GoogleComment {
  id: string
  author: string
  body: string
  quote: string
  resolved: boolean
  replies: Array<{ author: string, body: string }>
  start: number | null
  end: number | null
}
interface Marker { id: string, kind: 'begin' | 'end', at: number, raw: string }
export interface GoogleMarkdown { text: string, comments: GoogleComment[], markers: Marker[], suffix: string }

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function decode(text: string): string {
  return text.replace(/&(quot|apos|amp|lt|gt|#39);/g, (_, entity: string) => ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', '#39': "'" })[entity]!)
}
const invalid = () => new HttpError(422, 'Google comment metadata is unsupported or damaged; the document was not changed.')

/** Keep the provider-owned metadata opaque. Only text and safe comment fields leave the server. */
export function readGoogleMarkdown(raw: string): GoogleMarkdown {
  const boundary = /\r?\n---\r?\ngdoc_comments:[ \t]*\r?\n/.exec(raw)
  const suffix = boundary ? raw.slice(boundary.index) : ''
  const body = boundary ? raw.slice(0, boundary.index) : raw
  const markers: Marker[] = []
  let text = '', last = 0
  for (const match of body.matchAll(/<!-- gdoc_comment_(begin|end): ([A-Za-z0-9_-]+) -->/g)) {
    text += body.slice(last, match.index)
    markers.push({ id: match[2], kind: match[1] as 'begin' | 'end', at: text.length, raw: match[0] })
    last = match.index! + match[0].length
  }
  text += body.slice(last)
  if (/gdoc_comment_(?:begin|end):|\bgdoc_comments\b/.test(text) || (!suffix && markers.length)) throw invalid()
  if (!suffix) return { text, comments: [], markers, suffix }
  const ending = /\r?\n---\s*$/.exec(suffix)
  if (!ending) throw invalid()
  const parsed = parseDocument(suffix.slice(suffix.indexOf('gdoc_comments:'), ending.index), { uniqueKeys: true })
  if (parsed.errors.length) throw invalid()
  const data: unknown = parsed.toJS({ maxAliasCount: 0 })
  if (!mapping(data) || !mapping(data.gdoc_comments)) throw invalid()
  const starts = new Map<string, number>(), ranges = new Map<string, { start: number, end: number }>()
  for (const marker of markers) {
    if (!Object.prototype.hasOwnProperty.call(data.gdoc_comments, marker.id)) throw invalid()
    if (marker.kind === 'begin') {
      if (starts.has(marker.id) || ranges.has(marker.id)) throw invalid()
      starts.set(marker.id, marker.at)
    } else {
      const start = starts.get(marker.id)
      if (start === undefined || marker.at <= start) throw invalid()
      ranges.set(marker.id, { start, end: marker.at }); starts.delete(marker.id)
    }
  }
  if (starts.size) throw invalid()
  const comments: GoogleComment[] = []
  for (const [id, value] of Object.entries(data.gdoc_comments)) {
    if (!mapping(value) || !mapping(value.head) || typeof value.head.body !== 'string') throw invalid()
    if (!['ACTIVE', 'RESOLVED'].includes(String(value.status))) throw invalid()
    const replies: GoogleComment['replies'] = []
    if (value.replies !== undefined) {
      if (!Array.isArray(value.replies)) throw invalid()
      for (const reply of value.replies) {
        if (!mapping(reply)) throw invalid()
        if (typeof reply.body === 'string') replies.push({ author: typeof reply.author === 'string' ? reply.author : '', body: decode(reply.body) })
        else if (typeof reply.action !== 'string') throw invalid()
      }
    }
    const range = ranges.get(id)
    comments.push({ id, author: typeof value.head.author === 'string' ? value.head.author : '', body: decode(value.head.body),
      quote: range ? text.slice(range.start, range.end) : typeof value.head.quote === 'string' ? decode(value.head.quote) : '',
      resolved: value.status === 'RESOLVED', replies, start: range?.start ?? null, end: range?.end ?? null })
  }
  return { text, comments, markers, suffix }
}

/** Re-anchor only exact, unambiguous passages; never silently detach reviewer feedback. */
export function updateGoogleMarkdown(raw: string, next: string): string {
  if (/gdoc_comment_(?:begin|end):|\bgdoc_comments\b/.test(next)) throw new HttpError(422, 'The Poise draft contains reserved Google comment metadata.')
  const doc = readGoogleMarkdown(raw)
  if (doc.text === next) return raw
  const ranges = new Map<string, { start: number, end: number }>()
  for (const comment of doc.comments) {
    if (comment.start === null || comment.end === null) continue
    const quote = doc.text.slice(comment.start, comment.end)
    const matches: number[] = []
    for (let at = next.indexOf(quote); at >= 0; at = next.indexOf(quote, at + 1)) matches.push(at)
    const before = doc.text.slice(Math.max(0, comment.start - 64), comment.start)
    const after = doc.text.slice(comment.end, comment.end + 64)
    const originalMatches: number[] = []
    for (let at = doc.text.indexOf(quote); at >= 0; at = doc.text.indexOf(quote, at + 1)) originalMatches.push(at)
    const originalContext = originalMatches.filter(at => doc.text.slice(Math.max(0, at - before.length), at) === before && doc.text.slice(at + quote.length, at + quote.length + after.length) === after)
    const contextual = matches.filter(at => next.slice(Math.max(0, at - before.length), at) === before && next.slice(at + quote.length, at + quote.length + after.length) === after)
    const at = matches.length === 1 && originalMatches.length === 1 ? matches[0] : originalContext.length === 1 && contextual.length === 1 ? contextual[0] : undefined
    if (at === undefined) throw new HttpError(409, 'A Google-commented passage was changed or became ambiguous. Review it in Google Docs before publishing.')
    ranges.set(comment.id, { start: at, end: at + quote.length })
  }
  const markers = doc.markers.map((marker, order) => ({ ...marker, order, at: ranges.get(marker.id)![marker.kind === 'begin' ? 'start' : 'end'] }))
    .sort((a, b) => a.at - b.at || a.order - b.order)
  let result = '', last = 0
  for (const marker of markers) { result += next.slice(last, marker.at) + marker.raw; last = marker.at }
  return result + next.slice(last) + doc.suffix
}
