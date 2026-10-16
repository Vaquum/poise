// Settings → Publishing and the Editor's Publish panel (docs/Publishing.md).
// The sites are kept in the meta table as their repositories, with a
// description for a repository that has no publish.yaml; what each document
// was published as, and where, is a side-car beside it (server/editor.ts).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { getMeta, setMeta } from './db'
import { readDoc, readPublishLedger, writePublishLedger, type PublishRecord } from './editor'
import { HttpError, readJson } from './http'
import {
  PUBLISH_FILE,
  PublishConfigError,
  PublishValueError,
  documentParts,
  fillPost,
  parsePost,
  parsePublishConfig,
  placeUrl,
  postDate,
  reconcile,
  renderPost,
  sha256,
  slugFromTitle,
  suggestionsFrom,
  today,
  type FieldKind,
  type FieldValue,
  type Place,
  type PostFile,
  type PublishConfig,
  type PublishSection,
} from './publishing'
import {
  GitHubError,
  REPOSITORY,
  branchHead,
  commitFile,
  createBranch,
  fileAt,
  fork,
  openPullRequest,
  pullRequest,
  repository,
  signIn,
  type GitHubSession,
  type RepositoryInfo,
} from './publishing-github'

const SITES_KEY = 'publishing_sites'
const SITE_TTL_MS = 60_000
const MAX_DESTINATIONS = 10

interface StoredSite {
  repo: string
  /** The site described here, for a repository without publish.yaml. */
  description?: string
}

/* ---------------------------------------------------------------- the sites */

function storedSites(): StoredSite[] {
  const raw = getMeta(SITES_KEY)
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  const valid = Array.isArray(parsed) && parsed.every((site) => !!site && typeof site === 'object'
    && typeof site.repo === 'string' && REPOSITORY.test(site.repo)
    && (site.description === undefined || typeof site.description === 'string'))
  if (!valid) throw new HttpError(500, 'The publishing sites saved in Settings are unreadable.')
  return parsed as StoredSite[]
}

function saveSites(sites: StoredSite[]): void {
  setMeta(SITES_KEY, JSON.stringify(sites))
}

function findSite(repo: string): StoredSite {
  const site = storedSites().find((s) => s.repo.toLowerCase() === repo.toLowerCase())
  if (!site) throw new HttpError(404, `${repo} is not one of your publishing sites.`)
  return site
}

export type SiteState = 'ready' | 'invalid' | 'missing' | 'unavailable'

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
  /** The fields a writer fills in: neither fixed nor filled in by Poise. */
  fields: FieldView[]
}

export interface SiteView {
  repo: string
  state: SiteState
  source: 'repository' | 'settings' | null
  site?: string
  sections?: SectionView[]
  problem?: string
  warning?: string
  description?: string
}

interface ReadySite {
  repo: string
  info: RepositoryInfo
  base: string
  config: PublishConfig
}

interface SiteRead {
  view: SiteView
  ready?: ReadySite
}

function shownFields(section: PublishSection, suggestions: Map<string, string[]>): FieldView[] {
  return section.fields
    .filter((f) => f.value === undefined && f.kind !== 'places' && f.kind !== 'canonical')
    .map((f) => ({
      name: f.name, kind: f.kind, required: f.required,
      ...(f.label ? { label: f.label } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
      ...(f.max ? { max: f.max } : {}),
      ...(f.lines ? { lines: f.lines } : {}),
      ...(f.choices ? { choices: f.choices } : {}),
      ...(f.suggest ? { suggestions: suggestions.get(`${f.suggest.file}#${f.suggest.path}`) ?? [] } : {}),
    }))
}

/** A site as it is now: its repository, its description and the words it suggests. */
async function readSite(session: GitHubSession, stored: StoredSite): Promise<SiteRead> {
  const repo = stored.repo
  const described = stored.description !== undefined ? { description: stored.description } : {}
  let info: RepositoryInfo
  let text: string | null
  try {
    info = await repository(session, repo)
    text = stored.description ?? (await fileAt(session, repo, PUBLISH_FILE, info.defaultBranch))?.text ?? null
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error
    return { view: { repo, state: 'unavailable', source: null, problem: error.message, ...described } }
  }
  const source = stored.description !== undefined ? 'settings' : 'repository'
  if (text === null) {
    return { view: { repo, state: 'missing', source: null, problem: `${repo} has no ${PUBLISH_FILE}. Add one to the repository, or describe the site here.` } }
  }
  let config: PublishConfig
  try {
    config = parsePublishConfig(text)
  } catch (error) {
    if (!(error instanceof PublishConfigError)) throw error
    const where = source === 'settings' ? 'The description here' : `${PUBLISH_FILE} in ${repo}`
    return { view: { repo, state: 'invalid', source, problem: `${where}: ${error.message}`, ...described } }
  }
  const base = config.branch ?? info.defaultBranch
  const suggestions = new Map<string, string[]>()
  const warnings: string[] = []
  const files = new Map<string, Promise<string | null>>()
  for (const field of config.sections.flatMap((s) => s.fields)) {
    if (!field.suggest) continue
    const { file, path } = field.suggest
    if (!files.has(file)) files.set(file, fileAt(session, repo, file, base).then((f) => f?.text ?? null))
    try {
      const words = await files.get(file)!
      if (words === null) warnings.push(`${file} is not in ${repo}, so ${field.name} has no suggestions.`)
      else suggestions.set(`${file}#${path}`, suggestionsFrom(words, path))
    } catch (error) {
      if (!(error instanceof GitHubError || error instanceof PublishConfigError)) throw error
      warnings.push(`${file}: ${error.message}`)
    }
  }
  return {
    view: {
      repo: info.fullName, state: 'ready', source, site: config.site,
      sections: config.sections.map((s) => ({
        name: s.name, ...(s.url ? { url: s.url } : {}), ...(s.firstLine ? { firstLine: s.firstLine } : {}),
        fields: shownFields(s, suggestions),
      })),
      ...(warnings.length ? { warning: [...new Set(warnings)].join(' ') } : {}),
      ...described,
    },
    ready: { repo: info.fullName, info, base, config },
  }
}

// Settings and the panel read the sites often; a minute is fresh enough to
// list them. Publishing always reads them again.
const siteCache = new Map<string, { expires: number, read: Promise<SiteRead> }>()

function cachedSite(session: GitHubSession, stored: StoredSite): Promise<SiteRead> {
  const key = `${session.me.toLowerCase()} ${stored.repo.toLowerCase()} ${sha256(stored.description ?? '')}`
  const hit = siteCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.read
  const read = readSite(session, stored)
  const entry = { expires: Infinity, read }
  siteCache.set(key, entry)
  read.then((result) => {
    entry.expires = Date.now() + (result.view.state === 'unavailable' ? 0 : SITE_TTL_MS)
  }, () => { siteCache.delete(key) })
  return read
}

export function forgetSites(): void {
  siteCache.clear()
}

async function listSites(): Promise<{ sites: SiteView[] }> {
  const stored = storedSites()
  if (!stored.length) return { sites: [] }
  const session = await signIn(getMeta('me') || '')
  return { sites: (await Promise.all(stored.map((site) => cachedSite(session, site)))).map((read) => read.view) }
}

/** owner/name, also from a pasted GitHub address. */
function repositoryName(value: unknown): string {
  const name = String(value ?? '').trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!REPOSITORY.test(name)) throw new HttpError(400, 'Give the repository as owner/name.')
  return name
}

async function addSite(value: unknown): Promise<{ site: SiteView }> {
  const name = repositoryName(value)
  const stored = storedSites()
  if (stored.some((s) => s.repo.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `${name} is already one of your sites.`)
  const session = await signIn(getMeta('me') || '')
  const info = await repository(session, name)
  const site: StoredSite = { repo: info.fullName }
  saveSites([...stored, site])
  forgetSites()
  return { site: (await cachedSite(session, site)).view }
}

function removeSite(repo: string): { ok: true } {
  const site = findSite(repo)
  saveSites(storedSites().filter((s) => s.repo !== site.repo))
  forgetSites()
  return { ok: true }
}

async function describeSite(repo: string, value: unknown): Promise<{ site: SiteView }> {
  if (typeof value !== 'string') throw new HttpError(400, 'The description is the text of a publish.yaml.')
  const site = findSite(repo)
  const description = value.trim() ? value : undefined
  // Kept only when it reads: the box keeps the text, and the error, until then.
  if (description !== undefined) parsePublishConfig(description)
  const next: StoredSite = { repo: site.repo, ...(description !== undefined ? { description } : {}) }
  saveSites(storedSites().map((s) => (s.repo === site.repo ? next : s)))
  forgetSites()
  const session = await signIn(getMeta('me') || '')
  return { site: (await cachedSite(session, next)).view }
}

/* ---------------------------------------------------------------- a document's publications */

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
  /** The document has changed since it was last published here. */
  changed: boolean
  problem?: string
}

function timeZone(): string | undefined {
  return getMeta('timezone') || undefined
}

async function documentPublishing(slug: string): Promise<{ title: string, slug: string, today: string, publications: PublicationView[] }> {
  const doc = await readDoc(slug)
  const parts = documentParts(doc.content)
  const { records } = await readPublishLedger(slug)
  const session = records.length ? await signIn(getMeta('me') || '') : null
  const publications = await Promise.all(records.map(async (record): Promise<PublicationView> => {
    const view: PublicationView = {
      repo: record.repo, section: record.section, site: record.site, slug: record.slug, path: record.path, url: record.url,
      values: record.values, publishedAt: record.publishedAt, updatedAt: record.updatedAt,
      pullRequest: { ...record.pullRequest, state: 'unknown' },
      changed: record.sourceSha !== sha256(doc.content),
    }
    try {
      view.pullRequest.state = (await pullRequest(session!, record.repo, record.pullRequest.number)).state
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error
      view.problem = error.message
    }
    return view
  }))
  return { title: parts.title, slug: slugFromTitle(parts.title), today: today(timeZone()), publications }
}

interface Destination {
  repo: string
  section: string
  slug: string
  values: Record<string, unknown>
}

function destinationsFrom(body: unknown): Destination[] {
  const list = (body as { destinations?: unknown } | null)?.destinations
  if (!Array.isArray(list) || !list.length || list.length > MAX_DESTINATIONS) {
    throw new HttpError(400, `Choose one to ${MAX_DESTINATIONS} sites to publish to.`)
  }
  const seen = new Set<string>()
  return list.map((item) => {
    const entry = item as Partial<Destination> | null
    if (!entry || typeof entry.repo !== 'string' || typeof entry.section !== 'string' || typeof entry.slug !== 'string'
      || !entry.values || typeof entry.values !== 'object' || Array.isArray(entry.values)) {
      throw new HttpError(400, 'Each site needs its repository, section, slug and values.')
    }
    const key = `${entry.repo.toLowerCase()}#${entry.section}`
    if (seen.has(key)) throw new HttpError(400, `${entry.repo} · ${entry.section} is chosen twice.`)
    seen.add(key)
    return { repo: entry.repo, section: entry.section, slug: entry.slug.trim(), values: entry.values as Record<string, unknown> }
  })
}

/** The same field, or the text, changed both on the site and here since it was published. */
class PublishConflictError extends Error {
  constructor(readonly site: string, readonly conflicts: string[]) {
    super(`Changed on ${site} since you published: ${conflicts.join(', ')}. Publish again to replace it with this document's version.`)
    this.name = 'PublishConflictError'
  }
}

export interface PublishResult {
  repo: string
  section: string
  ok: boolean
  publication?: PublicationView
  /** Nothing to change: the site has this version already. */
  unchanged?: boolean
  error?: string
  problems?: string[]
  conflicts?: string[]
}

interface Target {
  destination: Destination
  ready: ReadySite
  section: PublishSection
  previous?: PublishRecord
  key: string
}

function placeKey(repo: string, section: string): string {
  return `${repo.toLowerCase()}#${section}`
}

const publishing = new Set<string>()

async function publishDocument(slug: string, body: unknown): Promise<{ results: PublishResult[] }> {
  const destinations = destinationsFrom(body)
  const replace = (body as { replace?: unknown }).replace === true
  if (publishing.has(slug)) throw new HttpError(409, 'This document is being published already.')
  publishing.add(slug)
  try {
    const session = await signIn(getMeta('me') || '')
    const doc = await readDoc(slug)
    const parts = documentParts(doc.content)
    if (!parts.whole) throw new HttpError(400, 'The document is empty.')
    const ledger = await readPublishLedger(slug)
    const todayValue = today(timeZone())

    const targets: Target[] = []
    for (const destination of destinations) {
      const read = await readSite(session, findSite(destination.repo))
      if (!read.ready) throw new HttpError(read.view.state === 'unavailable' ? 502 : 409, `${destination.repo}: ${read.view.problem}`)
      const section = read.ready.config.sections.find((s) => s.name === destination.section)
      if (!section) throw new HttpError(400, `${read.ready.config.site} has no section ${destination.section}.`)
      const key = placeKey(read.ready.repo, section.name)
      const previous = ledger.records.find((r) => placeKey(r.repo, r.section) === key)
      targets.push({ destination, ready: read.ready, section, previous, key })
    }

    // Every place the piece is published, the original first: where it went
    // before, in the order it went there, then where it goes now.
    const places: Place[] = [...ledger.records]
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
      .map((r) => ({ key: placeKey(r.repo, r.section), site: r.site, url: r.url }))
    for (const target of targets) {
      const { destination, section, ready } = target
      const place = { key: target.key, site: ready.config.site, url: placeUrl(section, destination.slug, postDate(section, destination.values, target.previous?.date ?? todayValue)) }
      const at = places.findIndex((p) => p.key === target.key)
      if (at >= 0) places[at] = place
      else places.push(place)
    }

    const results: PublishResult[] = []
    for (const target of targets) {
      const { repo, section } = target.destination
      try {
        const outcome = await publishTo(session, target, parts, places, todayValue, replace, doc.content)
        if (outcome.record) {
          ledger.records = [...ledger.records.filter((r) => placeKey(r.repo, r.section) !== target.key), outcome.record]
          await writePublishLedger(slug, ledger)
        }
        const record = outcome.record ?? target.previous!
        results.push({
          repo, section, ok: true, ...(outcome.unchanged ? { unchanged: true } : {}),
          publication: {
            repo: record.repo, section: record.section, site: record.site, slug: record.slug, path: record.path, url: record.url,
            values: record.values, publishedAt: record.publishedAt, updatedAt: record.updatedAt,
            pullRequest: { ...record.pullRequest, state: outcome.state }, changed: false,
          },
        })
      } catch (error) {
        if (error instanceof PublishValueError) results.push({ repo, section, ok: false, error: error.message, problems: error.problems })
        else if (error instanceof PublishConflictError) results.push({ repo, section, ok: false, error: error.message, conflicts: error.conflicts })
        else if (error instanceof GitHubError || error instanceof HttpError) results.push({ repo, section, ok: false, error: error.message })
        else throw error
      }
    }
    return { results }
  } finally {
    publishing.delete(slug)
  }
}

async function freshBranch(session: GitHubSession, repo: string, name: string, sha: string): Promise<string> {
  for (let n = 1; n <= 9; n++) {
    const branch = n === 1 ? name : `${name}-${n}`
    if (await createBranch(session, repo, branch, sha)) return branch
  }
  throw new GitHubError(`Branches ${name} to ${name}-9 already exist in ${repo}; remove the old ones first.`, 409)
}

interface Outcome {
  record?: PublishRecord
  state: 'open' | 'merged' | 'closed'
  unchanged?: boolean
}

/**
 * One site. A first publication opens a pull request from a new branch. While
 * that pull request is open, publishing again commits to its branch; once it
 * is merged, an update gets a pull request of its own. What the site changed
 * since is kept, and the same field or text changed on both sides is refused
 * unless `replace` says to use this document's version.
 */
async function publishTo(session: GitHubSession, target: Target, parts: ReturnType<typeof documentParts>, places: Place[], todayValue: string, replace: boolean, content: string): Promise<Outcome> {
  const { destination, ready, section, previous } = target
  const self = places.find((p) => p.key === target.key)!
  const filled = fillPost(section, destination.slug, destination.values, { title: parts.title, today: todayValue, date: previous?.date, places, self })
  if (previous && previous.path !== filled.path) {
    throw new PublishValueError([`This piece is published on ${previous.site} as ${previous.path}; publish it with slug ${previous.slug} and its date unchanged.`])
  }
  const title = String(filled.frontmatter[section.firstLine ?? 'title'] ?? parts.title)
  const ours: PostFile = { data: filled.frontmatter, body: section.firstLine ? parts.rest : parts.whole }
  const upstream = ready.info

  let state: 'new' | 'open' | 'merged' | 'closed' = 'new'
  if (previous) state = (await pullRequest(session, upstream.fullName, previous.pullRequest.number)).state

  // Where the file is now: on the open pull request's branch, else on the site.
  const readFrom = state === 'open' ? { repo: previous!.headRepo, branch: previous!.branch } : { repo: upstream.fullName, branch: ready.base }
  const head = await branchHead(session, readFrom.repo, readFrom.branch)
  if (!head) throw new GitHubError(`${readFrom.branch} is not in ${readFrom.repo}.`, 409)
  const current = await fileAt(session, readFrom.repo, filled.path, readFrom.branch)
  if (current && !previous) {
    throw new GitHubError(`${filled.path} is already in ${upstream.fullName}, and this document did not publish it. Choose another slug.`, 409)
  }

  // What is recorded as published is this document's side, never the file
  // reconciled with the site: a change made on the site must still read as
  // the site's at every later publication, not only the next one.
  const published = { data: ours.data, bodySha: sha256(ours.body) }
  let file: PostFile = ours
  if (current && previous) {
    const merged = reconcile({ data: previous.data, bodySha: previous.bodySha }, ours, parsePost(current.text))
    if (merged.conflicts.length && !replace) throw new PublishConflictError(ready.config.site, merged.conflicts)
    file = merged
  }
  const text = renderPost(file.data, file.body)
  const now = new Date().toISOString()
  if (current && current.text === text) {
    // The site has this version already: nothing to commit, nothing to open.
    const record = previous && { ...previous, sourceSha: sha256(content), values: destination.values, ...published, updatedAt: now }
    return { record, state: state === 'new' ? 'merged' : state, unchanged: true }
  }

  let branch: string
  let headRepo: string
  let pr: { number: number, url: string }
  if (state === 'open') {
    branch = previous!.branch
    headRepo = previous!.headRepo
    await commitFile(session, headRepo, branch, head, `Update ${filled.path}`, filled.path, text)
    pr = previous!.pullRequest
  } else {
    // The site's own repository when the writer can push to it; otherwise
    // their fork. A pull request closed unmerged left nothing on the site, so
    // only a merged one makes this an update.
    const update = state === 'merged'
    const where = upstream.canPush ? upstream : await fork(session, upstream.fullName)
    headRepo = where.fullName
    branch = await freshBranch(session, headRepo, `publish/${destination.slug}`, head)
    await commitFile(session, headRepo, branch, head, `${update ? 'Update' : 'Publish'} ${filled.path}`, filled.path, text)
    const opened = await openPullRequest(session, upstream.fullName, {
      title: update ? `Update: ${title}` : title,
      body: [
        `Published from Poise by @${session.me}.`,
        '',
        `- File: \`${filled.path}\``,
        ...(filled.url ? [`- Address once merged: ${filled.url}`] : []),
      ].join('\n'),
      head: headRepo === upstream.fullName ? branch : `${where.owner}:${branch}`,
      base: ready.base,
    })
    pr = { number: opened.number, url: opened.url }
  }
  return {
    state: 'open',
    record: {
      repo: upstream.fullName, section: section.name, site: ready.config.site, headRepo, branch, base: ready.base,
      path: filled.path, url: filled.url, slug: destination.slug, date: filled.date, pullRequest: pr,
      publishedAt: previous?.publishedAt ?? now, updatedAt: now,
      sourceSha: sha256(content), values: destination.values, ...published,
    },
  }
}

/* ---------------------------------------------------------------- HTTP */

const SITES = '/api/publishing/sites'
const SITE = /^\/api\/publishing\/sites\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(\/description)?$/
const DOCUMENT = /^\/api\/editor\/doc\/([A-Za-z0-9._-]+)\/(publishing|publish)$/

/** Settings → Publishing (/api/publishing/sites…) and the Editor's panel (/api/editor/doc/:slug/publishing and …/publish). */
export async function handlePublishingApi(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
  const path = url.split('?')[0]
  const site = SITE.exec(path)
  const document = DOCUMENT.exec(path)
  if (path !== SITES && !site && !document) return false
  const send = (status: number, value: unknown): true => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(value))
    return true
  }
  const method = req.method || 'GET'
  try {
    if (path === SITES && method === 'GET') return send(200, await listSites())
    if (path === SITES && method === 'POST') return send(200, await addSite((await readJson<{ repo?: unknown }>(req)).repo))
    if (site && !site[3] && method === 'DELETE') return send(200, removeSite(`${site[1]}/${site[2]}`))
    if (site && site[3] && method === 'PUT') return send(200, await describeSite(`${site[1]}/${site[2]}`, (await readJson<{ description?: unknown }>(req)).description))
    if (document && document[2] === 'publishing' && method === 'GET') return send(200, await documentPublishing(document[1]))
    if (document && document[2] === 'publish' && method === 'POST') return send(200, await publishDocument(document[1], await readJson(req)))
    return send(405, { error: `${method} is not used here.` })
  } catch (error) {
    if (error instanceof HttpError) return send(error.statusCode, { error: error.message })
    // GitHub's own refusals are not Poise's: a 401 or 403 from GitHub must
    // never read as this browser being signed out of Poise.
    if (error instanceof GitHubError) return send([404, 409, 422, 503].includes(error.status) ? error.status : 502, { error: error.message })
    if (error instanceof PublishConfigError || error instanceof PublishValueError) return send(400, { error: error.message })
    if ((error as { code?: string }).code === 'ENOENT') return send(404, { error: 'That document does not exist.' })
    if ((error as { code?: string }).code === 'EDITOR_LOCK_UNAVAILABLE') return send(503, { error: (error as Error).message })
    return send(500, { error: error instanceof Error ? error.message : String(error) })
  }
}
