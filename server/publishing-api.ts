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
  fileDate,
  fillPost,
  isVersion,
  parsePost,
  parsePublishConfig,
  placeUrl,
  postDate,
  reconcile,
  renderPost,
  sha256,
  siteDate,
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
  contains,
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
  /** Names its repository had before a rename: records made then still go by them. */
  formerly?: string[]
}

/**
 * The stored site going by any of these names: by its name now first, so a
 * repository that has since taken a renamed site's old name is never taken
 * for it; then by a name it had before a rename.
 */
function siteByName(sites: StoredSite[], names: string[]): StoredSite | undefined {
  const is = (n: string) => names.some((name) => name.toLowerCase() === n.toLowerCase())
  return sites.find((s) => is(s.repo)) ?? sites.find((s) => (s.formerly ?? []).some(is))
}

/* ---------------------------------------------------------------- the sites */

function storedSites(): StoredSite[] {
  const raw = getMeta(SITES_KEY)
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  const valid = Array.isArray(parsed) && parsed.every((site) => !!site && typeof site === 'object'
    && typeof site.repo === 'string' && REPOSITORY.test(site.repo)
    && (site.description === undefined || typeof site.description === 'string')
    && (site.formerly === undefined || (Array.isArray(site.formerly) && site.formerly.every((n: unknown) => typeof n === 'string'))))
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

/**
 * A repository renamed on GitHub is kept under its new name: Settings and the
 * panel address it so. Once renamed, it is left as it is: a second read of the
 * same site, from before the rename, changes nothing.
 */
function renameSite(from: string, to: string): void {
  updateSites((sites) => {
    if (!sites.some((s) => s.repo.toLowerCase() === from.toLowerCase())) return sites
    return sites
      .filter((s) => s.repo.toLowerCase() !== to.toLowerCase())
      .map((s) => (s.repo.toLowerCase() === from.toLowerCase() ? { ...s, repo: to, formerly: [...new Set([...(s.formerly ?? []), s.repo])] } : s))
  })
}

/**
 * A stored site by a name it is addressed by. An old name of a repository
 * renamed since finds it too: GitHub answers to an old name, and Settings or
 * the panel may hold one until they read the sites again.
 */
async function siteNamed(name: string, sites = storedSites()): Promise<StoredSite | undefined> {
  const direct = siteByName(sites, [name])
  if (direct) return direct
  const session = await signIn(getMeta('me') || '').catch((error: unknown) => {
    if (error instanceof HttpError) return null
    throw error
  })
  const info = session && await repository(session, name).catch((error: unknown) => {
    if (error instanceof GitHubError) return null
    throw error
  })
  if (!session || !info) return undefined
  const byName = sites.find((s) => s.repo.toLowerCase() === info.fullName.toLowerCase())
  if (byName) return byName
  // Still kept under a name it had before: each site as it is now, its rename followed.
  for (const site of sites) {
    const read = await readSite(session, site)
    if (read.view.repo.toLowerCase() === info.fullName.toLowerCase()) return { ...site, repo: read.view.repo }
  }
  return undefined
}

async function findSite(repo: string): Promise<StoredSite> {
  const site = await siteNamed(repo)
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
  /** The date field that dates it, the first one: one the writer fills, or one the site fixes. */
  dateField?: string
  /** The fields a writer fills in: neither fixed nor filled in by Poise. */
  fields: FieldView[]
}

export interface SiteView {
  repo: string
  /** Names it had before a rename: Settings moves what it holds under one to the site. */
  formerly?: string[]
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
async function readSite(session: GitHubSession, stored: StoredSite, { follow = true } = {}): Promise<SiteRead> {
  const described = stored.description !== undefined ? { description: stored.description } : {}
  let info: RepositoryInfo
  let text: string | null
  try {
    info = await repository(session, stored.repo)
    text = stored.description ?? (await fileAt(session, info.fullName, PUBLISH_FILE, info.defaultBranch))?.text ?? null
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error
    return { view: { repo: stored.repo, state: 'unavailable', source: null, problem: error.message, ...described } }
  }
  const repo = info.fullName
  const renamed = repo.toLowerCase() !== stored.repo.toLowerCase()
  if (follow && renamed) renameSite(stored.repo, repo)
  // The names it had: what Settings holds under one of them is the site's.
  const former = renamed ? [...(stored.formerly ?? []), stored.repo] : stored.formerly ?? []
  const formerly = former.length ? { formerly: former } : {}
  const source = stored.description !== undefined ? 'settings' : 'repository'
  if (text === null) {
    return { view: { repo, state: 'missing', source: null, problem: `${repo} has no ${PUBLISH_FILE}. Add one to the repository, or describe the site here.`, ...formerly } }
  }
  let config: PublishConfig
  try {
    config = parsePublishConfig(text)
  } catch (error) {
    if (!(error instanceof PublishConfigError)) throw error
    const where = source === 'settings' ? 'The description here' : `${PUBLISH_FILE} in ${repo}`
    return { view: { repo, state: 'invalid', source, problem: `${where}: ${error.message}`, ...described, ...formerly } }
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
        ...(s.fields.some((f) => f.kind === 'date') ? { dateField: s.fields.find((f) => f.kind === 'date')!.name } : {}),
        fields: shownFields(s, suggestions),
      })),
      ...(warnings.length ? { warning: [...new Set(warnings)].join(' ') } : {}),
      ...described,
      ...formerly,
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
    // A renamed site's old name, now another repository's: no longer one of its names.
    const pruned = sites.map((s) => (s.formerly?.some((n) => n.toLowerCase() === info.fullName.toLowerCase())
      ? { ...s, formerly: s.formerly.filter((n) => n.toLowerCase() !== info.fullName.toLowerCase()) }
      : s))
    return [...pruned, site]
  })
  forgetSites()
  return { site: (await cachedSite(session, site)).view }
}

async function removeSite(repo: string): Promise<{ ok: true }> {
  const site = await findSite(repo)
  updateSites((sites) => sites.filter((s) => s.repo !== site.repo))
  forgetSites()
  return { ok: true }
}

async function describeSite(repo: string, value: unknown): Promise<{ site: SiteView }> {
  if (typeof value !== 'string') throw new HttpError(400, 'The description is the text of a publish.yaml.')
  const site = await findSite(repo)
  const description = value.trim() ? value : undefined
  // Kept only when it reads: the box keeps the text, and the error, until then.
  if (description !== undefined) parsePublishConfig(description)
  // As stored, its former names too; only the description changes.
  const next: StoredSite = { ...site }
  delete next.description
  if (description !== undefined) next.description = description
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
  /** The date its path and address went by. */
  date: string
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

/**
 * The branch a piece is on: where its pull request went, or, once that is
 * closed unmerged, where the version that landed before it is.
 */
function whereOf(record: PublishRecord, state: PullRequestInfo['state'] | 'unknown' | undefined): string {
  return state === 'closed' && record.landed ? record.landed.base ?? record.base : record.base
}

/**
 * Whether a piece is still this document's on its site's branch: always on
 * the branch it is on; on another the site has moved to since, only if the
 * file there is a version this document published, carried over.
 */
async function stillOurs(session: GitHubSession, ready: ReadySite, record: PublishRecord, landed: Landed | undefined, where: string): Promise<boolean> {
  if (where === ready.base) return true
  const there = await fileAt(session, ready.repo, record.path, ready.base).catch((error: unknown) => {
    if (!(error instanceof GitHubError)) throw error
    return null
  })
  try {
    const file = there && parsePost(there.text)
    return !!file && !landed?.unknown && isVersion(file, landed ?? record)
  } catch (error) {
    if (!(error instanceof PostFileError)) throw error
    return false
  }
}

/**
 * A pull request a maintainer retargeted goes, or went, where GitHub says
 * now: a record whose branch came from it follows it. One moved with its
 * version to another branch since stays there.
 */
/** A site renamed on GitHub since: its record goes by the name its pull request gives now. */
function followRename(record: PublishRecord, info: PullRequestInfo): void {
  if (info.repo && info.repo.toLowerCase() !== record.repo.toLowerCase()) record.repo = info.repo
}

function followBase(record: PublishRecord, info: PullRequestInfo): void {
  const seen = record.pullRequest.base ?? record.base
  if (!info.base || info.state === 'closed' || info.base === seen) return
  if (record.base === seen) record.base = info.base
  record.pullRequest = { ...record.pullRequest, base: info.base }
}

function timeZone(): string | undefined {
  return getMeta('timezone') || undefined
}

async function documentPublishing(slug: string): Promise<{ title: string, slug: string, today: string, publications: PublicationView[] }> {
  const doc = await readDoc(slug)
  const parts = documentParts(doc.content)
  const { records } = await readPublishLedger(slug)
  const session = records.length ? await signIn(getMeta('me') || '') : null
  const sites = records.length ? storedSites() : []
  const siteOf = (names: string[]) => siteByName(sites, names)
  const publications = await Promise.all(records.map(async (record): Promise<PublicationView> => {
    const recorded = record.repo
    const view: PublicationView = {
      repo: record.repo, section: record.section, site: record.site, slug: record.slug, path: record.path, url: record.url,
      values: record.values, date: record.date, publishedAt: record.publishedAt, updatedAt: record.updatedAt,
      pullRequest: { number: record.pullRequest.number, url: record.pullRequest.url, state: 'unknown' }, live: true, ...(record.docTitle !== undefined ? { docTitle: record.docTitle } : {}),
      changed: record.sourceSha !== sha256(doc.content),
    }
    try {
      const info = await pullRequest(session!, record.repo, record.pullRequest.number)
      const state = info.state
      view.pullRequest.state = state
      followRename(record, info)
      followBase(record, info)
      view.live = state !== 'closed' || record.landed !== undefined
      // A site moved to another branch since, where the file is not one this
      // document published: published there afresh, under any slug. Read as
      // it is now, though its name follows only the read Settings shares.
      const stored = view.live && state !== 'open' ? siteOf([recorded, record.repo]) : undefined
      const ready = stored && (await readSite(session!, stored, { follow: false })).ready
      if (ready && !(await stillOurs(session!, ready, record, state === 'merged' ? snapshotOf(record) : record.landed, whereOf(record, state)))) view.live = false
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error
      view.problem = error.message
    }
    // Named as Settings and the panel name its site, by the same read of it,
    // shared while it is cached: never one name here and another there.
    const site = siteOf([recorded, record.repo])
    view.repo = site ? (await cachedSite(session!, site)).view.repo : record.repo
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
  /** The date the version on the site, or on its open pull request, went by: a dateless post's date. */
  since?: string
  /** Its pull request was found closed unmerged while this publication went on. */
  closed?: boolean
}

/** Each destination's own result, as it was asked for: two names of one site are two destinations. */
function resultKey(destination: Destination): string {
  return placeKey(destination.repo, destination.section)
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
    values: record.values, date: record.date, publishedAt: record.publishedAt, updatedAt: record.updatedAt,
    pullRequest: { number: record.pullRequest.number, url: record.pullRequest.url, state }, live: true, changed: false,
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
  const filled = fillPost(section, destination.slug, destination.values, { title: parts.title, today: todayValue, date: target.since, places, self })
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
  // An update committed while its pull request could not be read, where
  // the pull request has since been merged without it.
  const missed = new Set<string>()
  // The name each record had before a rename followed here, to find its stored site by.
  const recordedAs = new Map<PublishRecord, string>(ledger.records.map((record) => [record, record.repo]))
  await Promise.all(ledger.records.map(async (record) => {
    try {
      const info = await pullRequest(session, record.repo, record.pullRequest.number)
      followRename(record, info)
      const key = placeKey(record.repo, record.section)
      if (record.unconfirmed && info.state === 'merged' && !await contains(session, record.headRepo, info.headSha, record.unconfirmed.commit)) missed.add(key)
      followBase(record, info)
      states.set(key, info.state)
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error
      // Unreadable, it still goes by its repository's name now, so a site
      // renamed since finds it: GitHub answers to the old name.
      const current = await repository(session, record.repo).catch((failure: unknown) => {
        if (failure instanceof GitHubError) return null
        throw failure
      })
      if (current) record.repo = current.fullName
      const key = placeKey(record.repo, record.section)
      states.set(key, 'unknown')
      unread.set(key, error.message)
    }
  }))
  // A merged version stays on the site, and stays this document's, even when
  // a later pull request is closed unmerged. Worked out here, and written only
  // with a record this publication writes.
  // Merged without an update committed after it: what it merged is not
  // known, so every difference from the site is asked about.
  const landedOf = (record: PublishRecord): Landed | undefined => {
    const key = placeKey(record.repo, record.section)
    if (states.get(key) !== 'merged') return record.landed
    return missed.has(key)
      ? { data: {}, bodySha: '', pullRequest: record.pullRequest.number, url: record.unconfirmed!.url, ...(record.unconfirmed!.date ? { date: record.unconfirmed!.date } : {}), base: record.base, unknown: true }
      : snapshotOf(record)
  }
  // The date the version on its site went by: the record's own, unless what is
  // there is an earlier version, an update after it closed unmerged or never
  // reaching its merged pull request.
  const sinceOf = (record: PublishRecord): string => {
    const key = placeKey(record.repo, record.section)
    if (states.get(key) === 'closed' && record.landed) return record.landed.date ?? record.date
    if (missed.has(key)) return record.unconfirmed!.date ?? record.date
    return record.date
  }
  const live = ledger.records.filter((record) => states.get(placeKey(record.repo, record.section)) !== 'closed' || record.landed)
  // A publication found closed unmerged while this one went on, with nothing landed before it: named nowhere.
  const gone = new Set<PublishRecord>()

  // A site that cannot be published to now fails alone: the others still go,
  // and where this piece is on it already, it is still named there.
  const targets: Target[] = []
  const results = new Map<string, PublishResult>()
  const refuse = (destination: Destination, error: string) => {
    results.set(resultKey(destination), { repo: destination.repo, section: destination.section, ok: false, error })
  }
  const sites = storedSites()
  for (const destination of destinations) {
    const stored = await siteNamed(destination.repo, sites)
    if (!stored) { refuse(destination, `${destination.repo} is not one of your publishing sites.`); continue }
    const read = await readSite(session, stored)
    if (!read.ready) { refuse(destination, `${destination.repo}: ${read.view.problem}`); continue }
    const section = read.ready.config.sections.find((s) => s.name === destination.section)
    if (!section) { refuse(destination, `${read.ready.config.site} has no section ${destination.section}.`); continue }
    const key = placeKey(read.ready.repo, section.name)
    // Chosen twice under two of its names: once is enough.
    if (targets.some((t) => t.key === key)) { refuse(destination, `${read.ready.config.site} · ${section.name} is chosen twice.`); continue }
    // A record under a name the repository had before is the same publication.
    const names = new Set([key, placeKey(destination.repo, section.name), ...[stored.repo, ...(stored.formerly ?? [])].map((n) => placeKey(n, section.name))])
    const unreadName = [...names].find((name) => unread.has(name))
    if (unreadName) { refuse(destination, `Its earlier pull request could not be read: ${unread.get(unreadName)}`); continue }
    let previous = live.find((r) => names.has(placeKey(r.repo, r.section)))
    const was = previous ? placeKey(previous.repo, previous.section) : key
    let landed = previous && landedOf(previous)
    if (previous && states.get(was) !== 'open') {
      // A site that has moved to another branch since, where the file is not
      // one this document published: the piece is published there afresh.
      // Carried onto that branch as published, what landed is there too.
      const where = whereOf(previous, states.get(was))
      if (!(await stillOurs(session, read.ready, previous, landed, where))) previous = undefined
      else if (where !== read.ready.base && landed) landed = { ...landed, base: read.ready.base }
    }
    // Only an open pull request is still on its way; anything else that is
    // live is the merged version on the site.
    const state = !previous ? 'new' : states.get(was) === 'open' ? 'open' : 'merged'
    targets.push({ destination, ready: read.ready, section, key, previous, state, landed: previous ? landed : undefined, since: previous && sinceOf(previous) })
  }

  // The date each publication going again will go by: a date the site
  // changed and this document did not is the site's, as reconcile keeps it,
  // and so is the address other sites name.
  const dates = new Map<string, string>()
  for (const target of [...targets]) {
    const field = target.section.fields.find((f) => f.kind === 'date')
    if (!target.previous || !field) continue
    const from = target.state === 'open' ? { repo: target.previous.headRepo, branch: target.previous.branch } : { repo: target.ready.repo, branch: target.ready.base }
    const current = await fileAt(session, from.repo, target.previous.path, from.branch).catch((error: unknown) => {
      if (!(error instanceof GitHubError)) throw error
      return error
    })
    if (current instanceof GitHubError) {
      // That site fails alone, as one that cannot be read above.
      results.set(resultKey(target.destination), resultFor(target, { error: current.message }))
      targets.splice(targets.indexOf(target), 1)
      continue
    }
    let theirs: Record<string, unknown> | undefined
    try { theirs = current ? parsePost(current.text).data : undefined } catch (error) {
      // publishTo reports a file that cannot be read, for its site.
      if (!(error instanceof PostFileError)) throw error
    }
    // A merged version that is not known says nothing of what the site changed.
    if (!theirs || (target.state !== 'open' && target.landed?.unknown)) continue
    const base = target.state === 'open' ? target.previous : target.landed ?? target.previous
    const date = siteDate(target.section, base.data, theirs, target.destination.values, todayValue, target.since)
    if (date) dates.set(target.key, date)
  }

  // Where each live place is now, as its site has it: its address as the
  // site's description gives it now, dated as its file is, a date a
  // maintainer changed included. A site published now and failing is named
  // there too. One that cannot be read keeps its record's.
  const addresses = new Map<string, string>()
  await Promise.all(live.map(async (r) => {
    const key = placeKey(r.repo, r.section)
    const state = states.get(key)
    const reached = state === 'open' || (state === 'merged' && !missed.has(key))
    if (state === 'unknown' || (r.unconfirmed && !reached)) return
    const stored = siteByName(sites, [r.repo, recordedAs.get(r) ?? r.repo])
    const ready = targets.find((t) => t.key === key)?.ready ?? (stored && (await readSite(session, stored)).ready)
    const section = ready?.config.sections.find((sec) => sec.name === r.section)
    // A site that has moved to another branch since the piece went where it is: its record says where it was.
    if (!ready || !section?.url || (state !== 'open' && whereOf(r, state) !== ready.base)) return
    let date = sinceOf(r)
    if (section.fields.some((f) => f.kind === 'date')) {
      const from = state === 'open' ? { repo: r.headRepo, branch: r.branch } : { repo: ready.repo, branch: ready.base }
      const file = await fileAt(session, from.repo, r.path, from.branch).catch((error: unknown) => {
        if (!(error instanceof GitHubError)) throw error
        return null
      })
      let data: Record<string, unknown> | undefined
      try { data = file ? parsePost(file.text).data : undefined } catch (error) {
        if (!(error instanceof PostFileError)) throw error
      }
      if (!data) return
      date = fileDate(section, data, todayValue, sinceOf(r))
    }
    addresses.set(key, placeUrl(section, r.slug, date))
  }))

  // Every place the piece is published, the original first: where it is live
  // already, in the order it went there, then the sites it goes to now.
  const placesFor = (going: Target[]): Place[] => {
    // A pull request closed unmerged changed nothing on the site: name what
    // landed there. An update not known to have reached its pull request
    // (merged without it, or still unreadable) is named where it was before.
    const places: Place[] = live
      .filter((r) => !gone.has(r))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
      .map((r) => {
        const key = placeKey(r.repo, r.section)
        const state = states.get(key)
        const reached = state === 'open' || (state === 'merged' && !missed.has(key))
        const url = addresses.get(key) ?? (state === 'closed' && r.landed ? r.landed.url : r.unconfirmed && !reached ? r.unconfirmed.url : r.url)
        return { key, site: r.site, url }
      })
    for (const target of going) {
      const { destination, section, ready } = target
      const date = dates.get(target.key) ?? postDate(section, destination.values, todayValue, target.since)
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
      results.set(resultKey(target.destination), resultFor(target, { error: error.message, problems: error.problems }))
      return false
    }
  })
  assertLedgerFits(ledger.records, going.map((target) => provisionalRecord(target, fillFor(target, parts, placesFor(going), todayValue), parts.title, { commit: false })))
  // Each site again once its file is known: exactly, when nothing changes.
  const fits = (record: PublishRecord) => assertLedgerFits(ledger.records, [record])

  const record = async (target: Target, outcome: Outcome) => {
    if (outcome.record) {
      // In place of its earlier record, under whatever name the repository had then.
      ledger.records = [...ledger.records.filter((r) => r !== target.previous && placeKey(r.repo, r.section) !== target.key), outcome.record]
      await writePublishLedger(slug, ledger)
    }
    const kept = outcome.record ?? target.previous!
    // Named as it was asked for, so the panel keeps finding it until it reads the sites again.
    results.set(resultKey(target.destination), resultFor(target, outcome.error
      ? { error: outcome.error }
      : { ok: true, ...(outcome.unchanged ? { unchanged: true } : {}), publication: { ...viewOf(kept, outcome.state), repo: target.destination.repo } }))
    return kept
  }

  const published: Array<{ target: Target, record: PublishRecord, places: Place[], state: Outcome['state'] }> = []
  for (const target of [...going]) {
    const places = placesFor(going)
    try {
      // Sized in publishTo with the places it goes with now: a site that
      // failed before it can name another original, or an earlier address.
      const outcome = await publishTo(session, target, parts, places, todayValue, replace, doc.content, fits)
      const kept = await record(target, outcome)
      if (outcome.error) {
        // Committed, but whether it can reach the site is not known: the
        // others name it where it was, and it is corrected, with its pull
        // request read again, at the next publication.
        going = going.filter((t) => t !== target)
        continue
      }
      published.push({ target, record: kept, places, state: outcome.state })
    } catch (error) {
      if (!(error instanceof PublishValueError || error instanceof PublishConflictError || error instanceof PostFileError || error instanceof GitHubError || error instanceof HttpError)) throw error
      results.set(resultKey(target.destination), resultFor(target, {
        error: error.message,
        ...(error instanceof PublishValueError ? { problems: error.problems } : {}),
        ...(error instanceof PublishConflictError ? { conflicts: error.conflicts } : {}),
      }))
      // A site that failed is named on none of the others; nor, if its pull
      // request turned out closed unmerged with nothing landed, is it there.
      going = going.filter((t) => t !== target)
      // Its pull request found closed unmerged: for the rest of this publication
      // it is, and the version that landed before it, if any, is what is named.
      if (target.closed && target.previous) {
        const was = placeKey(target.previous.repo, target.previous.section)
        states.set(was, 'closed')
        addresses.delete(was)
        if (!target.landed) gone.add(target.previous)
      }
    }
  }

  // A site that failed after others were published is named in their files:
  // publish those again on their open pull requests, without it.
  const final = placesFor(going)
  for (const { target, record: kept, places, state } of published) {
    if (!target.section.fields.some((f) => f.kind === 'places' || f.kind === 'canonical') || samePlaces(places, final)) continue
    try {
      // On its open pull request; a version already on the site gets an update of its own.
      const landed = state === 'open' ? kept.landed : kept.landed ?? target.landed ?? snapshotOf(kept)
      // Merged meanwhile into a branch the site no longer publishes to, where the
      // file is not this document's: there is nothing of it there to correct.
      if (state !== 'open' && !(await stillOurs(session, target.ready, kept, landed, kept.base))) {
        results.set(resultKey(target.destination), resultFor(target, {
          error: `Published as pull request #${kept.pullRequest.number}, but it still names a site that failed, and ${target.ready.config.site} publishes to ${target.ready.base} now, where this piece is not. Publish again to correct it.`,
        }))
        continue
      }
      const again: Target = state === 'open'
        ? { ...target, previous: kept, state: 'open', landed, since: kept.date }
        : { ...target, previous: kept, state: 'merged', landed, since: landed?.date ?? kept.date }
      await record(target, await publishTo(session, again, parts, final, todayValue, replace, doc.content, fits))
    } catch (error) {
      if (!(error instanceof GitHubError || error instanceof HttpError || error instanceof PublishConflictError || error instanceof PostFileError)) throw error
      results.set(resultKey(target.destination), resultFor(target, {
        error: `Published as pull request #${kept.pullRequest.number}, but it still names a site that failed: ${error.message} Publish again to correct it.`,
      }))
    }
  }
  return { results: destinations.map((d) => results.get(resultKey(d))!) }
}

function largestLanded(target: Target, filled: FilledPost): Landed | undefined {
  const open = target.state === 'open' && target.previous
  const candidates = [
    target.landed,
    open ? snapshotOf(target.previous!) : undefined,
    open ? { data: filled.frontmatter, bodySha: '0'.repeat(64), pullRequest: target.previous!.pullRequest.number, url: filled.url, date: filled.date, base: longest(target.previous!.pullRequest.base, target.previous!.base, target.ready.base) } : undefined,
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
  return { data: record.data, bodySha: record.bodySha, pullRequest: record.pullRequest.number, url: record.url, date: record.date, base: record.base }
}

function samePlaces(a: Place[], b: Place[]): boolean {
  return a.length === b.length && a.every((place, i) => place.key === b[i].key && place.url === b[i].url && place.site === b[i].site)
}

// The longest name a repository can have on GitHub: a 39-character owner, a 100-character name.
const LONGEST_REPOSITORY = `${'o'.repeat(39)}/${'n'.repeat(100)}`

/** The longest of the names given, in bytes as written. */
function longest(...names: Array<string | undefined>): string {
  const bytes = (name: string) => Buffer.byteLength(JSON.stringify(name), 'utf8')
  return names.reduce<string>((most, name) => (name !== undefined && bytes(name) > bytes(most) ? name : most), '')
}

/**
 * A record as large as any a publication may write, before anything is
 * written on GitHub. Each name is the longest it can be: a record kept
 * unchanged keeps the earlier one's, a fork's name is known only once GitHub
 * makes it, and a pull request's number once it opens. With `commit`, also
 * what a commit could add to it: a version a merge during it lands, and its
 * commit if the pull request cannot be read after it.
 */
function provisionalRecord(target: Target, filled: FilledPost, docTitle: string, { commit = true } = {}): PublishRecord {
  const { destination, ready, previous } = target
  const at = new Date().toISOString()
  const digest = '0'.repeat(64)
  const number = Number.MAX_SAFE_INTEGER
  // Kept by publishTo, so counted here. An open pull request merged while
  // its commit lands puts its own version, or this new one, in its place: the
  // largest counts.
  const landed = commit ? largestLanded(target, filled) : target.landed
  return {
    repo: longest(previous?.repo, ready.repo), section: target.section.name, site: ready.config.site,
    headRepo: longest(previous?.headRepo, ready.info.canPush ? ready.repo : LONGEST_REPOSITORY),
    branch: longest(previous?.branch, `${branchFor(destination.slug)}-9`), base: longest(previous?.base, ready.base),
    path: filled.path, url: filled.url, slug: longest(previous?.slug, destination.slug), date: filled.date,
    pullRequest: {
      number, url: longest(previous?.pullRequest.url, `https://github.com/${ready.repo}/pull/${number}`),
      base: longest(previous?.pullRequest.base, previous?.base, ready.base),
    },
    publishedAt: longest(previous?.publishedAt, at), updatedAt: at,
    sourceSha: digest, values: destination.values, data: filled.frontmatter, bodySha: digest, docTitle,
    ...(landed ? { landed } : {}),
    ...(commit && target.state === 'open' && previous ? { unconfirmed: { commit: '0'.repeat(40), url: previous.url, date: previous.date } } : {}),
  }
}

// The record is written after each pull request opens. A record that cannot
// be written then would leave that pull request unknown, and the next publish
// would open another; so a record that would not fit is refused first: every
// site before anything is written, at what its record will hold whatever
// happens, and each again once its file is known (publishTo).
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

/** The branch a slug is published from. Git refuses a dot in some places (a.lock, a trailing dot), so each becomes a hyphen. */
function branchFor(slug: string): string {
  return `publish/${slug.replace(/\./g, '-')}`
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
  /** Committed and recorded, but not known to have reached its pull request. */
  error?: string
}

/**
 * One site. A first publication opens a pull request from a new branch. While
 * that pull request is open, publishing again commits to its branch; once it
 * is merged, an update gets a pull request of its own. What the site changed
 * since is kept, and the same field or text changed on both sides is refused
 * unless `replace` says to use this document's version.
 */
async function publishTo(session: GitHubSession, target: Target, parts: DocumentParts, places: Place[], todayValue: string, replace: boolean, content: string, fits: (record: PublishRecord) => void): Promise<Outcome> {
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
    // A merged version that is not known is no base: every difference is asked about.
    const merged = reconcile(state !== 'open' && landed?.unknown ? null : { data: base.data, bodySha: base.bodySha }, ours, parsePost(current.text))
    if (merged.conflicts.length && !replace) throw new PublishConflictError(ready.config.site, merged.conflicts)
    file = merged
  }
  const text = renderPost(file.data, file.body)
  // The address as the file being published dates it: a date the site kept is the site's.
  const url = placeUrl(section, destination.slug, fileDate(section, file.data, todayValue, target.since))
  const now = new Date().toISOString()
  if (current && current.text === text) {
    // The site has this version already: nothing to commit, nothing to open.
    // A commit left unconfirmed is settled: its pull request was read again.
    // On the site itself, this version is what landed there now, whatever
    // landed before it: a later change of this document's is one from it.
    const landedNow: Landed | undefined = state === 'merged'
      ? { data: published.data, bodySha: published.bodySha, pullRequest: landed?.pullRequest ?? previous!.pullRequest.number, url, date: published.date, base: ready.base }
      : landed
    // On the site, on the branch it publishes to now; on an open pull request, the branch that targets.
    const record: PublishRecord = {
      ...previous!, site: ready.config.site, url, sourceSha: sha256(content), values: destination.values, ...published,
      ...(landedNow ? { landed: landedNow } : {}), ...(state === 'merged' ? { base: ready.base } : {}), updatedAt: now,
    }
    delete record.unconfirmed
    fits(record)
    return { record, state: state as 'open' | 'merged', unchanged: true }
  }
  // Before anything is written: at the most a commit could add to the record.
  fits(provisionalRecord(target, filled, parts.title))

  const open = (headRepo: string, branch: string, update: boolean, base: string) => openPullRequest(session, upstream.fullName, {
    title: update ? `Update: ${title}` : title,
    body: [
      `Published from Poise by @${session.me}.`,
      '',
      `- File: \`${filled.path}\``,
      ...(url ? [`- Address once merged: ${url}`] : []),
    ].join('\n'),
    head: headRepo === upstream.fullName ? branch : `${headRepo.split('/')[0]}:${branch}`,
    base,
  })

  let branch: string
  let headRepo: string
  let pr: PublishRecord['pullRequest']
  let kept = landed
  let outcome: Outcome['state'] = 'open'
  let error: string | undefined
  let unconfirmed: PublishRecord['unconfirmed']
  // The branch the pull request goes to: an open one keeps its own, even if the site has moved since.
  let base = ready.base
  if (state === 'open') {
    branch = previous!.branch
    headRepo = previous!.headRepo
    base = previous!.base
    const commit = await commitFile(session, headRepo, branch, head, `Update ${filled.path}`, filled.path, text)
    // Merged or closed while this was committed: the commit needs a pull
    // request of its own, or the update would reach no one, unless the merge
    // took this commit with it, with or without a maintainer's on top.
    const after = await pullRequest(session, upstream.fullName, previous!.pullRequest.number)
      .then(async (info) => ({ state: info.state, base: info.base, took: info.state === 'merged' && await contains(session, headRepo, info.headSha, commit) }))
      .catch((failure: unknown) => {
        if (!(failure instanceof GitHubError)) throw failure
        return failure
      })
    if (after instanceof GitHubError) {
      // The commit is on the branch whatever GitHub answers: it is recorded
      // as this document's side there, with the commit, for a later
      // publication to settle with the pull request.
      pr = previous!.pullRequest
      unconfirmed = { commit, url: previous!.url, date: previous!.date }
      error = `Committed to the branch of pull request #${pr.number}, but its state could not be read: ${after.message}. Publish again to make sure the update reaches the site.`
    } else if (after.state === 'open') {
      base = after.base || base
      pr = { ...previous!.pullRequest, base }
    } else if (after.took) {
      base = after.base || base
      pr = { ...previous!.pullRequest, base }
      kept = { data: published.data, bodySha: published.bodySha, pullRequest: pr.number, url, date: published.date, base }
      outcome = 'merged'
    } else {
      // Merged meanwhile: what it held is on the site now, and this document's,
      // on the branch it merged into. Closed unmerged, nothing new is there.
      if (after.state === 'merged') {
        base = after.base || base
        kept = { ...snapshotOf(previous!), base }
      } else target.closed = true
      // To the branch the pull request it replaces went to, where what it
      // merged is: should the site have moved since, the next publication
      // asks whether the piece is still this document's there.
      const opened = await open(headRepo, branch, kept !== undefined, base)
      pr = { number: opened.number, url: opened.url, base }
    }
  } else {
    // The site's own repository when the writer can push to it, otherwise
    // their fork. Only a merged pull request makes this an update.
    const where = upstream.canPush ? upstream : await fork(session, upstream.fullName)
    headRepo = where.fullName
    branch = await freshBranch(session, headRepo, branchFor(destination.slug), head)
    await commitFile(session, headRepo, branch, head, `${state === 'merged' ? 'Update' : 'Publish'} ${filled.path}`, filled.path, text)
    const opened = await open(headRepo, branch, state === 'merged', base)
    pr = { number: opened.number, url: opened.url, base }
  }
  return {
    state: outcome,
    ...(error ? { error } : {}),
    record: {
      repo: upstream.fullName, section: section.name, site: ready.config.site, headRepo, branch, base,
      path: filled.path, url, slug: destination.slug, pullRequest: pr,
      publishedAt: previous?.publishedAt ?? now, updatedAt: now,
      sourceSha: sha256(content), values: destination.values, ...published,
      ...(kept ? { landed: kept } : {}),
      ...(unconfirmed ? { unconfirmed } : {}),
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
    if (site && !site[3] && method === 'DELETE') return send(200, await removeSite(`${site[1]}/${site[2]}`))
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
