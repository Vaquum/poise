// Settings → Publishing and the Editor's Publish panel (docs/Publishing.md).
// The sites are kept in the meta table as their repositories, with a
// description for a repository that has no publish.yaml; what each document
// was published as, and where, is a side-car beside it (server/editor.ts).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { db, getMeta, setMeta } from './db'
import { MAX_PUBLISH_LEDGER_BYTES, readDoc, readPublishLedger, withPublishLock, writePublishLedger, type PublishRecord } from './editor'
import { HttpError, readJson } from './http'
import { releaseBackgroundPaused, trackReleaseBackground } from './release-background'
import {
  PUBLISH_FILE,
  PostFileError,
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
  type DocumentParts,
  type FieldKind,
  type FieldValue,
  type FilledPost,
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
  type PullRequestInfo,
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

/** Read and write the sites in one transaction: two changes at once both keep. */
function updateSites(change: (sites: StoredSite[]) => StoredSite[]): void {
  db.transaction(() => saveSites(change(storedSites()))).immediate()
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
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/i, '')
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
  // Read again after GitHub's answer: another add may have finished meanwhile.
  updateSites((sites) => {
    if (sites.some((s) => [name, info.fullName].some((n) => s.repo.toLowerCase() === n.toLowerCase()))) throw new HttpError(409, `${info.fullName} is already one of your sites.`)
    return [...sites, site]
  })
  forgetSites()
  return { site: (await cachedSite(session, site)).view }
}

function removeSite(repo: string): { ok: true } {
  const site = findSite(repo)
  updateSites((sites) => sites.filter((s) => s.repo !== site.repo))
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
  updateSites((sites) => {
    if (!sites.some((s) => s.repo === site.repo)) throw new HttpError(404, `${repo} is not one of your publishing sites.`)
    return sites.map((s) => (s.repo === site.repo ? next : s))
  })
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
  /** Still this document's there: its pull request is open or merged, or an earlier one was merged. */
  live: boolean
  /** The document's first line when it was published here. */
  docTitle?: string
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
      pullRequest: { ...record.pullRequest, state: 'unknown' }, live: true, ...(record.docTitle !== undefined ? { docTitle: record.docTitle } : {}),
      changed: record.sourceSha !== sha256(doc.content),
    }
    try {
      view.pullRequest.state = (await pullRequest(session!, record.repo, record.pullRequest.number)).state
      view.live = view.pullRequest.state !== 'closed' || record.landed !== undefined
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

type Landed = NonNullable<PublishRecord['landed']>

interface Target {
  destination: Destination
  ready: ReadySite
  section: PublishSection
  key: string
  /** Its live publication there: a pull request open or merged. */
  previous?: PublishRecord
  /** That pull request's state; new when there is none. */
  state: 'new' | 'open' | 'merged'
  /** This document's side of the version on the site, when one was merged. */
  landed?: Landed
}

function placeKey(repo: string, section: string): string {
  return `${repo.toLowerCase()}#${section}`
}

function resultFor(target: Target, fields: Partial<PublishResult>): PublishResult {
  return { repo: target.destination.repo, section: target.destination.section, ok: false, ...fields }
}

function viewOf(record: PublishRecord, state: PublicationView['pullRequest']['state']): PublicationView {
  return {
    repo: record.repo, section: record.section, site: record.site, slug: record.slug, path: record.path, url: record.url,
    values: record.values, publishedAt: record.publishedAt, updatedAt: record.updatedAt,
    pullRequest: { ...record.pullRequest, state }, live: true, changed: false,
    ...(record.docTitle !== undefined ? { docTitle: record.docTitle } : {}),
  }
}

const publishing = new Set<string>()

async function publishDocument(slug: string, body: unknown): Promise<{ results: PublishResult[] }> {
  const destinations = destinationsFrom(body)
  const replace = (body as { replace?: unknown }).replace === true
  // A drain admits no new publication: a restart between opening a pull
  // request and recording it would leave the pull request unknown here.
  if (releaseBackgroundPaused()) throw new HttpError(503, 'Poise is installing an update; nothing was published.')
  if (publishing.has(slug)) throw new HttpError(409, 'This document is being published already.')
  publishing.add(slug)
  const finished = trackReleaseBackground()
  try {
    return await withPublishLock(() => publishLocked(slug, destinations, replace))
  } finally {
    finished()
    publishing.delete(slug)
  }
}

function fillFor(target: Target, parts: DocumentParts, places: Place[], todayValue: string): FilledPost {
  const { destination, section, previous } = target
  const self = places.find((p) => p.key === target.key)!
  const filled = fillPost(section, destination.slug, destination.values, { title: parts.title, today: todayValue, date: previous?.date, places, self })
  if (previous && previous.path !== filled.path) {
    throw new PublishValueError([`This piece is published on ${previous.site} as ${previous.path}; publish it with slug ${previous.slug} and its date unchanged.`])
  }
  return filled
}

async function publishLocked(slug: string, destinations: Destination[], replace: boolean): Promise<{ results: PublishResult[] }> {
  const session = await signIn(getMeta('me') || '')
  const doc = await readDoc(slug)
  const parts = documentParts(doc.content)
  if (!parts.whole) throw new HttpError(400, 'The document is empty.')
  const ledger = await readPublishLedger(slug)
  const todayValue = today(timeZone())

  // Which earlier publications are live. A pull request closed unmerged left
  // nothing on its site: it owns no file there and is named nowhere.
  // A pull request that cannot be read (its repository gone, say) fails only
  // a publication to that site; elsewhere it is still named where it was.
  const states = new Map<string, PullRequestInfo['state'] | 'unknown'>()
  const unread = new Map<string, string>()
  await Promise.all(ledger.records.map(async (record) => {
    const key = placeKey(record.repo, record.section)
    try {
      states.set(key, (await pullRequest(session, record.repo, record.pullRequest.number)).state)
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error
      states.set(key, 'unknown')
      unread.set(key, error.message)
    }
  }))
  // A merged version stays on the site, and stays this document's, even when
  // a later pull request is closed unmerged. Worked out here, and written only
  // with a record this publication writes.
  const landedOf = (record: PublishRecord): Landed | undefined => states.get(placeKey(record.repo, record.section)) === 'merged'
    ? snapshotOf(record)
    : record.landed
  const live = ledger.records.filter((record) => states.get(placeKey(record.repo, record.section)) !== 'closed' || record.landed)

  const targets: Target[] = []
  const results = new Map<string, PublishResult>()
  for (const destination of destinations) {
    const read = await readSite(session, findSite(destination.repo))
    if (!read.ready) throw new HttpError(read.view.state === 'unavailable' ? 502 : 409, `${destination.repo}: ${read.view.problem}`)
    const section = read.ready.config.sections.find((s) => s.name === destination.section)
    if (!section) throw new HttpError(400, `${read.ready.config.site} has no section ${destination.section}.`)
    const key = placeKey(read.ready.repo, section.name)
    if (unread.has(key)) {
      results.set(key, { repo: destination.repo, section: destination.section, ok: false, error: `Its earlier pull request could not be read: ${unread.get(key)}` })
      continue
    }
    const previous = live.find((r) => placeKey(r.repo, r.section) === key)
    // Only an open pull request is still on its way; anything else that is
    // live is the merged version on the site.
    const state = !previous ? 'new' : states.get(key) === 'open' ? 'open' : 'merged'
    targets.push({ destination, ready: read.ready, section, key, previous, state, landed: previous && landedOf(previous) })
  }

  // The date each publication going again will go by: a date the site
  // changed and this document did not is the site's, as reconcile keeps it,
  // and so is the address other sites name.
  const dates = new Map<string, string>()
  for (const target of targets) {
    const field = target.section.fields.find((f) => f.kind === 'date')
    if (!target.previous || !field) continue
    const from = target.state === 'open' ? { repo: target.previous.headRepo, branch: target.previous.branch } : { repo: target.ready.repo, branch: target.ready.base }
    const current = await fileAt(session, from.repo, target.previous.path, from.branch)
    let theirs: unknown
    try { theirs = current && parsePost(current.text).data[field.name] } catch (error) {
      // publishTo reports a file that cannot be read, for its site.
      if (!(error instanceof PostFileError)) throw error
    }
    const base = target.state === 'open' ? target.previous : target.landed ?? target.previous
    const ours = postDate(target.section, target.destination.values, todayValue, target.previous.date)
    if (typeof theirs === 'string' && theirs !== base.data[field.name] && ours === base.data[field.name]) dates.set(target.key, theirs)
  }

  // Every place the piece is published, the original first: where it is live
  // already, in the order it went there, then the sites it goes to now.
  const placesFor = (going: Target[]): Place[] => {
    // A later update closed unmerged changed nothing on the site: name what landed there.
    const places: Place[] = [...live]
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
      .map((r) => {
        const key = placeKey(r.repo, r.section)
        return { key, site: r.site, url: states.get(key) === 'closed' && r.landed ? r.landed.url : r.url }
      })
    for (const target of going) {
      const { destination, section, ready } = target
      const date = dates.get(target.key) ?? postDate(section, destination.values, todayValue, target.previous?.date)
      const place = { key: target.key, site: ready.config.site, url: placeUrl(section, destination.slug, date) }
      const at = places.findIndex((p) => p.key === target.key)
      if (at >= 0) places[at] = place
      else places.push(place)
    }
    return places
  }

  // The values first, for every site: one refused is named on no other.
  let going = targets.filter((target) => {
    try {
      fillFor(target, parts, placesFor(targets), todayValue)
      return true
    } catch (error) {
      if (!(error instanceof PublishValueError)) throw error
      results.set(target.key, resultFor(target, { error: error.message, problems: error.problems }))
      return false
    }
  })
  assertLedgerFits(ledger.records, going.map((target) => provisionalRecord(target, fillFor(target, parts, placesFor(going), todayValue), parts.title)))

  const record = async (target: Target, outcome: Outcome) => {
    if (outcome.record) {
      ledger.records = [...ledger.records.filter((r) => placeKey(r.repo, r.section) !== target.key), outcome.record]
      await writePublishLedger(slug, ledger)
    }
    const kept = outcome.record ?? target.previous!
    results.set(target.key, resultFor(target, { ok: true, ...(outcome.unchanged ? { unchanged: true } : {}), publication: viewOf(kept, outcome.state) }))
    return kept
  }

  const published: Array<{ target: Target, record: PublishRecord, places: Place[], state: Outcome['state'] }> = []
  for (const target of [...going]) {
    const places = placesFor(going)
    try {
      const outcome = await publishTo(session, target, parts, places, todayValue, replace, doc.content)
      const kept = await record(target, outcome)
      published.push({ target, record: kept, places, state: outcome.state })
    } catch (error) {
      if (!(error instanceof PublishValueError || error instanceof PublishConflictError || error instanceof PostFileError || error instanceof GitHubError || error instanceof HttpError)) throw error
      results.set(target.key, resultFor(target, {
        error: error.message,
        ...(error instanceof PublishValueError ? { problems: error.problems } : {}),
        ...(error instanceof PublishConflictError ? { conflicts: error.conflicts } : {}),
      }))
      // A site that failed is named on none of the others.
      going = going.filter((t) => t !== target)
    }
  }

  // A site that failed after others were published is named in their files:
  // publish those again on their open pull requests, without it.
  const final = placesFor(going)
  for (const { target, record: kept, places, state } of published) {
    if (!target.section.fields.some((f) => f.kind === 'places' || f.kind === 'canonical') || samePlaces(places, final)) continue
    try {
      // On its open pull request; a version already on the site gets an update of its own.
      const again: Target = state === 'open'
        ? { ...target, previous: kept, state: 'open', landed: kept.landed }
        : { ...target, previous: kept, state: 'merged', landed: kept.landed ?? target.landed ?? snapshotOf(kept) }
      assertLedgerFits(ledger.records, [provisionalRecord(again, fillFor(again, parts, final, todayValue), parts.title)])
      await record(target, await publishTo(session, again, parts, final, todayValue, replace, doc.content))
    } catch (error) {
      if (!(error instanceof GitHubError || error instanceof HttpError || error instanceof PublishConflictError || error instanceof PostFileError)) throw error
      results.set(target.key, resultFor(target, {
        error: `Published as pull request #${kept.pullRequest.number}, but it still names a site that failed: ${error.message} Publish again to correct it.`,
      }))
    }
  }
  return { results: destinations.map((d) => [...results.values()].find((r) => placeKey(r.repo, r.section) === placeKey(d.repo, d.section))!) }
}

function largestLanded(target: Target, filled: FilledPost): Landed | undefined {
  const open = target.state === 'open' && target.previous
  const candidates = [
    target.landed,
    open ? snapshotOf(target.previous!) : undefined,
    open ? { data: filled.frontmatter, bodySha: '0'.repeat(64), pullRequest: target.previous!.pullRequest.number, url: filled.url } : undefined,
  ].filter((landed): landed is Landed => !!landed)
  return largestOf(candidates)
}

/** The landed version that takes most bytes as written: indented, in a record, in the record list. */
export function largestOf(candidates: Landed[]): Landed | undefined {
  const bytes = (landed: Landed) => Buffer.byteLength(JSON.stringify({ records: [{ landed }] }, null, 2), 'utf8')
  return candidates.reduce<Landed | undefined>((largest, landed) => (!largest || bytes(landed) > bytes(largest) ? landed : largest), undefined)
}

/** This document's side of a record's version, as it stands on the site once merged. */
function snapshotOf(record: PublishRecord): Landed {
  return { data: record.data, bodySha: record.bodySha, pullRequest: record.pullRequest.number, url: record.url }
}

function samePlaces(a: Place[], b: Place[]): boolean {
  return a.length === b.length && a.every((place, i) => place.key === b[i].key && place.url === b[i].url && place.site === b[i].site)
}

/** A record as large as the one a publication will write, before anything is written on GitHub. */
function provisionalRecord(target: Target, filled: FilledPost, docTitle: string): PublishRecord {
  const at = new Date().toISOString()
  const digest = '0'.repeat(64)
  return {
    repo: target.ready.repo, section: target.section.name, site: target.ready.config.site, headRepo: target.ready.repo,
    branch: `publish/${target.destination.slug}-9`, base: target.ready.base, path: filled.path, url: filled.url,
    slug: target.destination.slug, date: filled.date,
    pullRequest: { number: 999_999, url: `https://github.com/${target.ready.repo}/pull/999999` },
    publishedAt: at, updatedAt: at, sourceSha: digest, values: target.destination.values, data: filled.frontmatter, bodySha: digest, docTitle,
    // Kept by publishTo, so counted here. An open pull request merged while
    // its commit lands puts its own version, or this new one, in its place: the
    // largest counts.
    ...(largestLanded(target, filled) ? { landed: largestLanded(target, filled) } : {}),
  }
}

// The record is written after each pull request opens. A record that cannot
// be written then would leave that pull request unknown, and the next publish
// would open another; so a record that would not fit is refused first.
function assertLedgerFits(records: PublishRecord[], provisional: PublishRecord[]): void {
  // Each record is written as its site is published, and any site can fail
  // and keep its old record: so the record must fit with every site at the
  // larger of its old and new versions, which covers every step and outcome.
  // Measured as written, indented within the record list: a long list grows more there than a long string.
  const size = (record: PublishRecord) => Buffer.byteLength(JSON.stringify({ records: [record] }, null, 2), 'utf8')
  const worst = new Map(records.map((record) => [placeKey(record.repo, record.section), record]))
  for (const record of provisional) {
    const key = placeKey(record.repo, record.section)
    const old = worst.get(key)
    if (!old || size(record) > size(old)) worst.set(key, record)
  }
  if (Buffer.byteLength(JSON.stringify({ records: [...worst.values()] }, null, 2), 'utf8') > MAX_PUBLISH_LEDGER_BYTES) {
    throw new HttpError(413, 'The record of where this document is published would grow past 1 MB. Publish to fewer sites at once, or shorten the longest fields.')
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
async function publishTo(session: GitHubSession, target: Target, parts: DocumentParts, places: Place[], todayValue: string, replace: boolean, content: string): Promise<Outcome> {
  const { destination, ready, section, previous, state, landed } = target
  const filled = fillFor(target, parts, places, todayValue)
  const title = String(filled.frontmatter[section.firstLine ?? 'title'] ?? parts.title)
  const ours: PostFile = { data: filled.frontmatter, body: section.firstLine ? parts.rest : parts.whole }
  const upstream = ready.info

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
  const published = { data: ours.data, bodySha: sha256(ours.body), date: filled.date, docTitle: parts.title }
  let file: PostFile = ours
  if (current && previous) {
    // On an open pull request, what this document last pushed there; on the
    // site, what of this document was last merged.
    const base = state === 'open' ? previous : landed ?? previous
    const merged = reconcile({ data: base.data, bodySha: base.bodySha }, ours, parsePost(current.text))
    if (merged.conflicts.length && !replace) throw new PublishConflictError(ready.config.site, merged.conflicts)
    file = merged
  }
  const text = renderPost(file.data, file.body)
  // The address as the file being published dates it: a date the site kept is the site's.
  const url = placeUrl(section, destination.slug, postDate(section, file.data, todayValue, previous?.date))
  const now = new Date().toISOString()
  if (current && current.text === text) {
    // The site has this version already: nothing to commit, nothing to open.
    return {
      record: { ...previous!, site: ready.config.site, url, sourceSha: sha256(content), values: destination.values, ...published, ...(landed ? { landed } : {}), updatedAt: now },
      state: state as 'open' | 'merged',
      unchanged: true,
    }
  }

  const open = (headRepo: string, branch: string, update: boolean) => openPullRequest(session, upstream.fullName, {
    title: update ? `Update: ${title}` : title,
    body: [
      `Published from Poise by @${session.me}.`,
      '',
      `- File: \`${filled.path}\``,
      ...(url ? [`- Address once merged: ${url}`] : []),
    ].join('\n'),
    head: headRepo === upstream.fullName ? branch : `${headRepo.split('/')[0]}:${branch}`,
    base: ready.base,
  })

  let branch: string
  let headRepo: string
  let pr: { number: number, url: string }
  let kept = landed
  let outcome: Outcome['state'] = 'open'
  if (state === 'open') {
    branch = previous!.branch
    headRepo = previous!.headRepo
    const commit = await commitFile(session, headRepo, branch, head, `Update ${filled.path}`, filled.path, text)
    // Merged or closed while this was committed: the commit needs a pull
    // request of its own, or the update would reach no one, unless the merge
    // took this commit with it.
    const after = await pullRequest(session, upstream.fullName, previous!.pullRequest.number)
    if (after.state === 'open') pr = previous!.pullRequest
    else if (after.state === 'merged' && after.headSha === commit) {
      pr = previous!.pullRequest
      kept = { data: published.data, bodySha: published.bodySha, pullRequest: pr.number, url }
      outcome = 'merged'
    } else {
      // Merged meanwhile: what it held is on the site now, and this document's.
      if (after.state === 'merged') kept = snapshotOf(previous!)
      const opened = await open(headRepo, branch, kept !== undefined)
      pr = { number: opened.number, url: opened.url }
    }
  } else {
    // The site's own repository when the writer can push to it, otherwise
    // their fork. Only a merged pull request makes this an update.
    const where = upstream.canPush ? upstream : await fork(session, upstream.fullName)
    headRepo = where.fullName
    branch = await freshBranch(session, headRepo, `publish/${destination.slug}`, head)
    await commitFile(session, headRepo, branch, head, `${state === 'merged' ? 'Update' : 'Publish'} ${filled.path}`, filled.path, text)
    const opened = await open(headRepo, branch, state === 'merged')
    pr = { number: opened.number, url: opened.url }
  }
  return {
    state: outcome,
    record: {
      repo: upstream.fullName, section: section.name, site: ready.config.site, headRepo, branch, base: ready.base,
      path: filled.path, url, slug: destination.slug, pullRequest: pr,
      publishedAt: previous?.publishedAt ?? now, updatedAt: now,
      sourceSha: sha256(content), values: destination.values, ...published,
      ...(kept ? { landed: kept } : {}),
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
    if (['EDITOR_LOCK_UNAVAILABLE', 'PROCESS_LOCK_UNAVAILABLE'].includes(String((error as { code?: string }).code))) return send(503, { error: (error as Error).message })
    return send(500, { error: error instanceof Error ? error.message : String(error) })
  }
}
