import { isMcpRepository, type McpDocumentListArguments, type McpGrantScope } from '../gateway/src/mcp-contract'
import { placeHref } from '../src/ui/address'
import { readMemories } from './chat/memories'
import { isCanonicalSlug, pageDocumentSummaries, readDoc, readPublishLedger } from './editor'
import { HttpError } from './http'
import { mcpCursor } from './mcp-cursor'
import { reviewsForPublications } from './publishing-reviews'
import { readSwitch } from './snippet-library'

const CONTENT_LIMIT = 8000
const editorHref = (doc?: string) => '/' + placeHref('editor', { doc })
const text = (content: string) => ({ text: content.slice(0, CONTENT_LIMIT), bytes: Buffer.byteLength(content), truncated: content.length > CONTENT_LIMIT })

export async function readContentRecord(kind: 'document' | 'snippet' | 'memory', id: string) {
  const observedAt = new Date().toISOString()
  const source = kind === 'document' ? 'Editor, publication ledger and cached reviews' : kind === 'snippet' ? 'Saved snippet switch' : 'Saved Chat memories'
  const href = kind === 'document' ? editorHref(id) : kind === 'snippet' ? '/' + placeHref('settings', { settings: 'snippets' }) : '/' + placeHref('chat')
  const base = { observedAt, source, href, retention: kind === 'document' ? 'Current document and retained publication versions' : 'Current saved revision' }
  try {
    if (kind === 'snippet') {
      const saved = readSwitch(id)
      if (!saved) return { ...base, coverage: 'complete', record: null }
      const view = text(saved.content)
      return { ...base, coverage: view.truncated ? 'partial' : 'complete',
        record: { kind, id, value: { name: saved.name, revision: saved.revision, updatedAt: saved.updatedAt, ...view } } }
    }
    if (kind === 'memory') {
      const memory = readMemories(), view = text(memory.text)
      return { ...base, coverage: view.truncated ? 'partial' : 'complete',
        record: { kind, id, value: { revision: memory.revision, ...view } } }
    }
    const doc = await readDoc(id, { noFollow: true })
    const content = text(doc.content)
    const value = { version: doc.version, updatedAt: doc.updated_at, ...content }
    try {
      const { records } = await readPublishLedger(id, { noFollow: true })
      const permitted = records.filter(row => isMcpRepository(row.repo) && Number.isSafeInteger(row.pullRequest.number) && row.pullRequest.number > 0)
      const shown = permitted.slice(0, 10)
      const reviews = await reviewsForPublications(shown)
      const publications = shown.map(row => ({ repository: row.repo, site: row.site.slice(0, 120), branch: row.branch,
        pullNumber: row.pullRequest.number, sourceVersion: row.sourceSha, updatedAt: row.updatedAt,
        pullLink: 'https://github.com/' + row.repo + '/pull/' + row.pullRequest.number,
        retainedMerge: row.landed ? { bodySha: row.landed.bodySha, pullNumber: row.landed.pullRequest } : null }))
      const visibleReviews = reviews.reviews.slice(0, 10).map(({ id, kind, repo, pr, resolved, outdated, messages }) =>
        ({ id, kind, repository: repo, pullNumber: pr, resolved, outdated, messageCount: messages.length }))
      return { ...base, coverage: content.truncated || shown.length < records.length || reviews.stale || visibleReviews.length < reviews.reviews.length
        ? 'partial' : 'complete', record: { kind, id, value: { ...value, publications, morePublications: shown.length < records.length,
          reviews: { checkedAt: reviews.checkedAt, stale: reviews.stale, items: visibleReviews, more: visibleReviews.length < reviews.reviews.length } } } }
    } catch {
      return { ...base, coverage: 'partial', reason: 'Publication or retained review evidence is unavailable', record: { kind, id, value } }
    }
  } catch (error) {
    const missing = kind === 'document' && (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { ...base, coverage: missing ? 'complete' : 'unavailable', record: null }
  }
}

export async function listContentDocuments(grant: McpGrantScope, args: McpDocumentListArguments) {
  const cursor = mcpCursor(grant, ['editor-docs-v1', args.limit])
  const after = args.cursor ? cursor.decode(args.cursor) : ''
  if (after !== '' && !isCanonicalSlug(after)) throw new HttpError(400, 'invalid document cursor')
  const observedAt = new Date().toISOString()
  try {
    const page = await pageDocumentSummaries(after, args.limit)
    return { source: 'Editor', coverage: page.missing ? 'partial' : 'complete', observedAt,
      items: page.items.map(item => ({ ...item, title: item.title.slice(0, 300), href: editorHref(item.slug) })),
      nextCursor: page.next ? cursor.encode(page.next) : null }
  } catch {
    return { source: 'Editor', coverage: 'unavailable', observedAt, items: [], nextCursor: null }
  }
}
