// The browser's side of publishing (server/publishing-api.ts, docs/Publishing.md):
// the sites in Settings → Publishing, and what the Editor's Publish panel
// reads and sends.

export type FieldKind = 'text' | 'choice' | 'list' | 'date' | 'boolean'
export type FieldValue = string | boolean | string[]

export interface FieldView {
  name: string
  kind: FieldKind
  label?: string
  required: boolean
  default?: FieldValue
  max?: number
  lines?: 'one' | 'many'
  choices?: string[]
  suggestions?: string[]
}

export interface SectionView {
  name: string
  url?: string
  firstLine?: string
  fields: FieldView[]
}

export interface SiteView {
  repo: string
  state: 'ready' | 'invalid' | 'missing' | 'unavailable'
  source: 'repository' | 'settings' | null
  site?: string
  sections?: SectionView[]
  problem?: string
  warning?: string
  description?: string
}

export interface PublicationView {
  repo: string
  section: string
  site: string
  slug: string
  path: string
  url: string
  values: Record<string, unknown>
  publishedAt: string
  updatedAt: string
  pullRequest: { number: number, url: string, state: 'open' | 'closed' | 'merged' | 'unknown' }
  /** Still this document's there, so its slug holds: open, merged, or merged before. */
  live: boolean
  /** The document's first line when it was published there. */
  docTitle?: string
  changed: boolean
  problem?: string
}

export interface DocumentPublishing {
  title: string
  slug: string
  today: string
  publications: PublicationView[]
}

export interface Destination {
  repo: string
  section: string
  slug: string
  values: Record<string, unknown>
}

export interface PublishResult {
  repo: string
  section: string
  ok: boolean
  publication?: PublicationView
  unchanged?: boolean
  error?: string
  problems?: string[]
  conflicts?: string[]
}

/** Sent on window when a site is added, described or removed. */
export const SITES_CHANGED = 'poise:publishing-sites-changed'

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const data = await response.json().catch(() => null) as { error?: unknown } | null
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Poise answered ${response.status}`)
  return data as T
}

function sitePath(repo: string): string {
  return `/api/publishing/sites/${repo.split('/').map(encodeURIComponent).join('/')}`
}

function changed(): void {
  window.dispatchEvent(new CustomEvent(SITES_CHANGED))
}

export async function fetchSites(): Promise<SiteView[]> {
  const { sites } = await call<{ sites?: unknown }>('/api/publishing/sites')
  if (!Array.isArray(sites)) throw new Error('Poise sent no list of sites.')
  return sites as SiteView[]
}

export async function addSite(repo: string): Promise<SiteView> {
  const { site } = await call<{ site: SiteView }>('/api/publishing/sites', 'POST', { repo })
  changed()
  return site
}

export async function removeSite(repo: string): Promise<void> {
  await call(sitePath(repo), 'DELETE')
  changed()
}

export async function describeSite(repo: string, description: string): Promise<SiteView> {
  const { site } = await call<{ site: SiteView }>(`${sitePath(repo)}/description`, 'PUT', { description })
  changed()
  return site
}

export function fetchDocumentPublishing(slug: string): Promise<DocumentPublishing> {
  return call<DocumentPublishing>(`/api/editor/doc/${encodeURIComponent(slug)}/publishing`)
}

export async function publishDocument(slug: string, destinations: Destination[], replace: boolean): Promise<PublishResult[]> {
  return (await call<{ results: PublishResult[] }>(`/api/editor/doc/${encodeURIComponent(slug)}/publish`, 'POST', { destinations, ...(replace ? { replace } : {}) })).results
}

/** The address part a title suggests, as the server suggests it (server/publishing.ts, slugFromTitle). */
export function slugFromTitle(title: string): string {
  const words = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (words.length <= 80) return words
  const cut = words.slice(0, 81)
  return cut.slice(0, cut.lastIndexOf('-') > 0 ? cut.lastIndexOf('-') : 80)
}

/** A first description for a repository without publish.yaml, to edit. */
export function starterDescription(repo: string): string {
  return [
    'version: 1',
    `site: ${JSON.stringify(repo.split('/')[1])}`,
    'sections:',
    '  - name: Posts',
    '    path: content/posts/{slug}.md',
    '    url: https://example.com/posts/{slug}/',
    '    slug: "^[a-z0-9]+(?:-[a-z0-9]+)*$"',
    '    first_line: title',
    '    fields:',
    '      title: { kind: text, required: true }',
    '      date:  { kind: date, default: today }',
    '',
  ].join('\n')
}
