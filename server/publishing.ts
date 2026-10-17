// How a site takes a post, as it says in publish.yaml at the root of its
// repository (docs/Publishing.md), and the file an Editor document becomes
// there. Nothing in this module reaches GitHub or the disk: it reads and
// checks a description, fills a section's fields, renders the file, and
// reconciles it with what the site has changed since it was published.

import { createHash } from 'node:crypto'
import { createContext, runInContext } from 'node:vm'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { stripMarkdownForTitle } from './editor'

export const PUBLISH_FILE = 'publish.yaml'
export const MAX_DESCRIPTION_BYTES = 64 * 1024

export const FIELD_KINDS = ['text', 'choice', 'list', 'date', 'boolean', 'places', 'canonical'] as const
export type FieldKind = typeof FIELD_KINDS[number]
export type FieldValue = string | boolean | string[]
/** A place's entry in a `places` field: an object of filled templates, or one filled template. */
export type PlaceTemplate = string | Record<string, string>

export interface PublishField {
  name: string
  kind: FieldKind
  label?: string
  required: boolean
  default?: FieldValue
  value?: FieldValue
  max?: number
  pattern?: string
  lines?: 'one' | 'many'
  choices?: string[]
  suggest?: { file: string, path: string }
  self?: PlaceTemplate
  item?: PlaceTemplate
}

export interface PublishSection {
  name: string
  path: string
  url?: string
  slug: string
  firstLine?: string
  fields: PublishField[]
}

export interface PublishConfig {
  version: 1
  site: string
  branch?: string
  sections: PublishSection[]
}

export class PublishConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishConfigError'
  }
}

/** A post on the site that cannot be read back: its frontmatter is not YAML fields. */
export class PostFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PostFileError'
  }
}

/** What is wrong with the values given for a section, one sentence each. */
export class PublishValueError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '))
    this.name = 'PublishValueError'
  }
}

/* ---------------------------------------------------------------- patterns */

// A site's patterns run in a context of their own with a time limit: a
// pattern that backtracks without end is stopped instead of holding the
// server. The description comes from a repository, so it is not trusted.
const patternContext = createContext(Object.create(null))
const PATTERN_TIMEOUT_MS = 50
const MAX_PATTERN_LENGTH = 200

function runPattern(pattern: string, value: string | null): boolean {
  const test = value === null ? '' : `.test(${JSON.stringify(value)})`
  return runInContext(`new RegExp(${JSON.stringify(pattern)})${test}`, patternContext, { timeout: PATTERN_TIMEOUT_MS }) === true
}

/** Whether `value` matches the site's `pattern`. */
export function matchesPattern(pattern: string, value: string): boolean {
  try {
    return runPattern(pattern, value)
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new PublishValueError([`The site's pattern ${pattern} took too long to check.`])
    }
    throw error
  }
}

function checkPattern(pattern: unknown, at: string): string {
  if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN_LENGTH) {
    throw new PublishConfigError(`${at}: give a regular expression of up to ${MAX_PATTERN_LENGTH} characters`)
  }
  try {
    runPattern(pattern, null)
  } catch (error) {
    throw new PublishConfigError(`${at}: not a valid regular expression (${(error as Error).message})`)
  }
  return pattern
}

/* ---------------------------------------------------------------- reading publish.yaml */

type Mapping = Record<string, unknown>

const TOP_KEYS = ['version', 'site', 'branch', 'sections']
const SECTION_KEYS = ['name', 'path', 'url', 'slug', 'first_line', 'fields']
const INPUT_KEYS = ['kind', 'label', 'required', 'default', 'value']
const KIND_KEYS: Record<FieldKind, string[]> = {
  text: [...INPUT_KEYS, 'max', 'pattern', 'lines'],
  choice: [...INPUT_KEYS, 'choices'],
  list: [...INPUT_KEYS, 'max', 'pattern', 'suggest'],
  date: INPUT_KEYS,
  boolean: INPUT_KEYS,
  // Poise fills these from where the piece is published; nothing is typed.
  places: ['kind', 'self', 'item'],
  canonical: ['kind'],
}
const PATH_NAMES = ['slug', 'date', 'year', 'month', 'day']
const PLACE_NAMES = ['site', 'url']
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,59}$/
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,100}(?<!\/)$/
const SUGGEST = /^([^#\s]+)#([A-Za-z_][A-Za-z0-9_-]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_-]*(?:\[\])?)*)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function isMapping(value: unknown): value is Mapping {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Mapping, allowed: string[], at: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new PublishConfigError(`${at}: unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`)
}

function text(value: unknown, at: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PublishConfigError(`${at}: give text of up to ${max} characters`)
  }
  return value.trim()
}

/** The placeholders a template uses, each one of `names`; stray braces are an error. */
function checkTemplate(template: string, names: string[], at: string): string[] {
  const used: string[] = []
  const rest = template.replace(/\{([a-z]+)\}/g, (_, name: string) => {
    if (!names.includes(name)) throw new PublishConfigError(`${at}: {${name}} is not a placeholder here (use ${names.map((n) => `{${n}}`).join(', ')})`)
    used.push(name)
    return ''
  })
  if (/[{}]/.test(rest)) throw new PublishConfigError(`${at}: a brace that is not part of a placeholder`)
  return used
}

/** A path inside the repository: relative, no empty, `.` or `..` parts, never into .git. */
export function isRepositoryPath(path: string): boolean {
  if (!path || path.length > 300 || path.startsWith('/') || path.endsWith('/') || /[\\\0-\x1f]/.test(path)) return false
  return path.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

function calendarDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

function placeTemplate(value: unknown, at: string): PlaceTemplate {
  if (typeof value === 'string') {
    checkTemplate(text(value, at, 300), PLACE_NAMES, at)
    return value
  }
  if (!isMapping(value) || !Object.keys(value).length) throw new PublishConfigError(`${at}: give a template, or keys with templates`)
  const out: Record<string, string> = {}
  for (const [key, template] of Object.entries(value)) {
    if (!FIELD_NAME.test(key)) throw new PublishConfigError(`${at}.${key}: not a usable key`)
    checkTemplate(text(template, `${at}.${key}`, 300), PLACE_NAMES, `${at}.${key}`)
    out[key] = template as string
  }
  return out
}

function readField(name: string, spec: unknown, at: string): PublishField {
  if (!FIELD_NAME.test(name)) throw new PublishConfigError(`${at}: a field name is letters, digits, _ and -, starting with a letter`)
  if (!isMapping(spec)) throw new PublishConfigError(`${at}: describe the field with kind and its options`)
  const kind = spec.kind as FieldKind
  if (!FIELD_KINDS.includes(kind)) throw new PublishConfigError(`${at}.kind: one of ${FIELD_KINDS.join(', ')}`)
  onlyKeys(spec, KIND_KEYS[kind], at)
  const field: PublishField = { name, kind, required: false }
  if (spec.label !== undefined) field.label = text(spec.label, `${at}.label`, 60)
  if (spec.required !== undefined) {
    if (typeof spec.required !== 'boolean') throw new PublishConfigError(`${at}.required: true or false`)
    field.required = spec.required
  }
  if (spec.default !== undefined && spec.value !== undefined) throw new PublishConfigError(`${at}: give default or value, not both`)
  if (spec.max !== undefined) {
    if (!Number.isSafeInteger(spec.max) || (spec.max as number) < 1 || (spec.max as number) > 100_000) throw new PublishConfigError(`${at}.max: a whole number from 1`)
    field.max = spec.max as number
  }
  if (spec.pattern !== undefined) field.pattern = checkPattern(spec.pattern, `${at}.pattern`)
  if (kind === 'text' && spec.lines !== undefined) {
    if (spec.lines !== 'one' && spec.lines !== 'many') throw new PublishConfigError(`${at}.lines: one or many`)
    field.lines = spec.lines
  }
  if (kind === 'choice') {
    const choices = spec.choices
    if (!Array.isArray(choices) || !choices.length || choices.length > 100
      || !choices.every((c) => typeof c === 'string' && c.trim() && c.length <= 100)
      || new Set(choices).size !== choices.length) {
      throw new PublishConfigError(`${at}.choices: a list of different words to choose from`)
    }
    field.choices = choices as string[]
  }
  if (kind === 'list' && spec.suggest !== undefined) {
    const match = typeof spec.suggest === 'string' ? SUGGEST.exec(spec.suggest) : null
    if (!match || !isRepositoryPath(match[1])) throw new PublishConfigError(`${at}.suggest: a file in the repository and where in it, like content/topics.yaml#topics[].tag`)
    field.suggest = { file: match[1], path: match[2] }
  }
  if (kind === 'places') {
    if (spec.item === undefined) throw new PublishConfigError(`${at}.item: say how each place is written`)
    field.item = placeTemplate(spec.item, `${at}.item`)
    if (spec.self !== undefined) field.self = placeTemplate(spec.self, `${at}.self`)
  }
  for (const key of ['default', 'value'] as const) {
    if (spec[key] === undefined) continue
    field[key] = fieldConstant(field, spec[key], `${at}.${key}`, key)
  }
  return field
}

function fieldConstant(field: PublishField, value: unknown, at: string, key: 'default' | 'value'): FieldValue {
  switch (field.kind) {
    case 'text':
      if (typeof value !== 'string') throw new PublishConfigError(`${at}: text`)
      return value
    case 'choice':
      if (typeof value !== 'string' || !field.choices!.includes(value)) throw new PublishConfigError(`${at}: one of the choices`)
      return value
    case 'list':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new PublishConfigError(`${at}: a list of words`)
      return value as string[]
    case 'date':
      if (typeof value !== 'string' || !(calendarDate(value) || (key === 'default' && value === 'today'))) {
        throw new PublishConfigError(`${at}: a date as YYYY-MM-DD${key === 'default' ? ', or today' : ''}`)
      }
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw new PublishConfigError(`${at}: true or false`)
      return value
    default:
      throw new PublishConfigError(`${at}: ${field.kind} fields are filled in by the editor`)
  }
}

function readSection(spec: unknown, at: string): PublishSection {
  if (!isMapping(spec)) throw new PublishConfigError(`${at}: describe the section with name, path, slug and fields`)
  onlyKeys(spec, SECTION_KEYS, at)
  const name = text(spec.name, `${at}.name`, 60)
  const path = text(spec.path, `${at}.path`, 200)
  if (!checkTemplate(path, PATH_NAMES, `${at}.path`).includes('slug')) throw new PublishConfigError(`${at}.path: include {slug}`)
  if (!isRepositoryPath(path.replace(/\{[a-z]+\}/g, 'x'))) throw new PublishConfigError(`${at}.path: a file path inside the repository`)
  const section: PublishSection = { name, path, slug: checkPattern(spec.slug, `${at}.slug`), fields: [] }
  if (spec.url !== undefined) {
    const url = text(spec.url, `${at}.url`, 300)
    if (!/^https?:\/\/[^\s/{}]+/.test(url)) throw new PublishConfigError(`${at}.url: an address starting with https://`)
    checkTemplate(url, PATH_NAMES, `${at}.url`)
    section.url = url
  }
  if (spec.fields !== undefined && !isMapping(spec.fields)) throw new PublishConfigError(`${at}.fields: name each field with its kind`)
  const fields = Object.entries((spec.fields ?? {}) as Mapping)
  if (fields.length > 50) throw new PublishConfigError(`${at}.fields: at most 50 fields`)
  section.fields = fields.map(([fieldName, fieldSpec]) => readField(fieldName, fieldSpec, `${at}.fields.${fieldName}`))
  if (spec.first_line !== undefined) {
    const target = section.fields.find((f) => f.name === spec.first_line)
    if (!target || target.kind !== 'text' || target.value !== undefined) throw new PublishConfigError(`${at}.first_line: name a text field of this section`)
    section.firstLine = target.name
  }
  return section
}

/** A site's publish.yaml, read and checked. An error names the key that is wrong. */
export function parsePublishConfig(source: string): PublishConfig {
  if (Buffer.byteLength(source, 'utf8') > MAX_DESCRIPTION_BYTES) throw new PublishConfigError(`${PUBLISH_FILE} is larger than ${MAX_DESCRIPTION_BYTES / 1024} KB`)
  let root: unknown
  try {
    root = parseYaml(source, { maxAliasCount: 0 })
  } catch (error) {
    throw new PublishConfigError(`not valid YAML: ${(error as Error).message.split('\n')[0]}`)
  }
  if (!isMapping(root)) throw new PublishConfigError('describe the site with version, site and sections')
  onlyKeys(root, TOP_KEYS, 'publish.yaml')
  if (root.version !== 1) throw new PublishConfigError('version: must be 1')
  const config: PublishConfig = { version: 1, site: text(root.site, 'site', 80), sections: [] }
  if (root.branch !== undefined) {
    if (typeof root.branch !== 'string' || !BRANCH.test(root.branch)) throw new PublishConfigError('branch: a branch name')
    config.branch = root.branch
  }
  if (!Array.isArray(root.sections) || !root.sections.length || root.sections.length > 20) {
    throw new PublishConfigError('sections: a list of one to twenty sections')
  }
  config.sections = root.sections.map((spec, index) => readSection(spec, `sections[${index}]`))
  const names = config.sections.map((s) => s.name.toLowerCase())
  if (new Set(names).size !== names.length) throw new PublishConfigError('sections: each section needs a name of its own')
  return config
}

/* ---------------------------------------------------------------- a document as a post */

export interface DocumentParts {
  /** The first non-empty line, as it reads on the page. */
  title: string
  /** The text after that line. */
  rest: string
  /** The whole document. */
  whole: string
}

/** Leading blank lines and trailing whitespace are not part of a post's text. */
export function normalizeBody(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')
}

export function documentParts(content: string): DocumentParts {
  const lines = content.split('\n')
  const index = lines.findIndex((line) => line.trim().length > 0)
  if (index < 0) return { title: '', rest: '', whole: '' }
  return {
    title: stripMarkdownForTitle(lines[index]),
    rest: normalizeBody(lines.slice(index + 1).join('\n')),
    whole: normalizeBody(content),
  }
}

/** The address part a title suggests: lowercase words joined by hyphens. */
export function slugFromTitle(title: string): string {
  const words = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (words.length <= 80) return words
  const cut = words.slice(0, 81)
  return cut.slice(0, cut.lastIndexOf('-') > 0 ? cut.lastIndexOf('-') : 80)
}

// A slug becomes part of a file path, whatever the site's own pattern allows.
const SAFE_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,119})$/

/** Today as YYYY-MM-DD in a time zone (the system's when none is set). */
export function today(timeZone?: string, now = new Date()): string {
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch (error) {
    throw new Error(`The time zone in Settings → General, ${timeZone}, is not one this computer knows.`, { cause: error })
  }
  return format.format(now)
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (_, name: string) => values[name] ?? '')
}

/** Where a piece is published: the site, its address, and which destination it is. */
export interface Place {
  key: string
  site: string
  url: string
}

export interface FillContext {
  /** The document's first line, as it reads. */
  title: string
  today: string
  /** The date a section without a date field goes by, once published: its first publication's. */
  date?: string
  /** Every place the piece is published, the original first. */
  places: Place[]
  /** This destination. */
  self: Place
}

export interface FilledPost {
  slug: string
  /** The date the path and address were filled with. */
  date: string
  path: string
  url: string
  frontmatter: Record<string, unknown>
}

/** A value given for a field, never one inherited: a field may be called constructor. */
function own(values: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(values, name) ? values[name] : undefined
}

function empty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

function renderPlace(template: PlaceTemplate, place: Place): unknown {
  const values = { site: place.site, url: place.url }
  if (typeof template === 'string') return fillTemplate(template, values)
  const out: Record<string, string> = {}
  for (const [key, part] of Object.entries(template)) {
    const filled = fillTemplate(part, values)
    if (filled) out[key] = filled
  }
  return out
}

function inputValue(field: PublishField, raw: unknown, problems: string[]): FieldValue | undefined {
  const label = field.label ?? field.name
  if (empty(raw)) return undefined
  switch (field.kind) {
    case 'text': {
      if (typeof raw !== 'string') { problems.push(`${label} must be text.`); return undefined }
      const value = field.lines === 'many' ? raw.trim() : raw.replace(/\s+/g, ' ').trim()
      if (field.max && value.length > field.max) problems.push(`${label} is longer than ${field.max} characters.`)
      if (field.pattern && value && !matchesPattern(field.pattern, value)) problems.push(`${label} does not match the site's pattern ${field.pattern}.`)
      return value || undefined
    }
    case 'choice':
      if (typeof raw !== 'string' || !field.choices!.includes(raw)) { problems.push(`${label} must be one of ${field.choices!.join(', ')}.`); return undefined }
      return raw
    case 'list': {
      const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null
      if (!items || !items.every((item) => typeof item === 'string')) { problems.push(`${label} must be a list of words.`); return undefined }
      const values = [...new Set((items as string[]).map((item) => item.trim()).filter(Boolean))]
      if (field.max && values.length > field.max) problems.push(`${label} takes at most ${field.max}.`)
      for (const value of values) {
        if (field.pattern && !matchesPattern(field.pattern, value)) problems.push(`${label}: "${value}" does not match the site's pattern ${field.pattern}.`)
      }
      return values.length ? values : undefined
    }
    case 'date':
      if (typeof raw !== 'string' || !calendarDate(raw)) { problems.push(`${label} must be a date as YYYY-MM-DD.`); return undefined }
      return raw
    case 'boolean':
      if (typeof raw !== 'boolean') { problems.push(`${label} must be true or false.`); return undefined }
      return raw
    default:
      return undefined
  }
}

/**
 * The date a post goes by in paths and addresses: its first date field's, as
 * fillPost resolves it, or `fallback` for a section without one (today, or the
 * date a published piece was first filled with). One rule, so a path and the
 * address another site lists for it can never disagree.
 */
export function postDate(section: PublishSection, values: Record<string, unknown>, todayValue: string, fallback = todayValue): string {
  const field = section.fields.find((f) => f.kind === 'date')
  if (!field) return fallback
  const given = own(values, field.name)
  const raw = field.value ?? (empty(given) ? (field.default === 'today' ? todayValue : field.default) : given)
  return typeof raw === 'string' && calendarDate(raw) ? raw : todayValue
}

/**
 * The file a document becomes in one section of a site: its slug, path,
 * address and frontmatter, in the order the section lists its fields. What is
 * wrong with the values is thrown together, one sentence each.
 */
export function fillPost(section: PublishSection, slug: string, values: Record<string, unknown>, context: FillContext): FilledPost {
  const problems: string[] = []
  if (!SAFE_SLUG.test(slug) || slug.includes('..')) problems.push('The slug must be letters, digits, dots, hyphens and underscores, up to 120.')
  else if (!matchesPattern(section.slug, slug)) problems.push(`The slug "${slug}" does not match the site's pattern ${section.slug}.`)

  const frontmatter: Record<string, unknown> = {}
  // A path or address with {date} in it must not move when a piece without a
  // date field is published again on another day.
  const date = postDate(section, values, context.today, context.date ?? context.today)
  for (const field of section.fields) {
    let value: unknown
    if (field.kind === 'places') {
      const places = context.places.length ? context.places : [context.self]
      value = places.map((place) => renderPlace(place.key === context.self.key && field.self !== undefined ? field.self : field.item!, place))
    } else if (field.kind === 'canonical') {
      const original = context.places[0]
      value = original && original.key !== context.self.key && original.url ? original.url : undefined
    } else if (field.value !== undefined) {
      value = field.value
    } else {
      // The document's first line stands for a title left empty, and is held
      // to the same limits as one typed.
      const given = own(values, field.name)
      const raw = empty(given) && field.name === section.firstLine ? context.title : given
      const known = problems.length
      value = inputValue(field, raw, problems)
      if (value === undefined && empty(raw)) value = field.default === 'today' && field.kind === 'date' ? context.today : field.default
      // A value given but wrong has said so already.
      if (empty(value) && field.required && problems.length === known) problems.push(`${field.label ?? field.name} is required.`)
    }
    if (!empty(value)) frontmatter[field.name] = value
  }
  if (problems.length) throw new PublishValueError(problems)

  const [year, month, day] = date.split('-')
  const parts = { slug, date, year, month, day }
  const path = fillTemplate(section.path, parts)
  if (!isRepositoryPath(path)) throw new PublishValueError([`The path ${path} is not inside the repository.`])
  return { slug, date, path, url: section.url ? fillTemplate(section.url, parts) : '', frontmatter }
}

/** The address a section gives a slug, before anything is published. */
export function placeUrl(section: PublishSection, slug: string, date: string): string {
  if (!section.url) return ''
  const [year, month, day] = date.split('-')
  return fillTemplate(section.url, { slug, date, year, month, day })
}

/* ---------------------------------------------------------------- the file */

export function renderPost(frontmatter: Record<string, unknown>, body: string): string {
  const text = normalizeBody(body)
  if (!Object.keys(frontmatter).length) return `${text}\n`
  // Every string is quoted: a date left bare is read as a date, not text, by
  // the YAML 1.1 readers many site generators use.
  const head = stringifyYaml(frontmatter, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN', lineWidth: 0 })
  return `---\n${head}---\n${text ? `\n${text}\n` : ''}`
}

export interface PostFile {
  data: Record<string, unknown>
  body: string
}

// The fences are whole lines; the frontmatter between them may be empty.
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/** A post's frontmatter and text, as the site has it now. */
export function parsePost(source: string): PostFile {
  const match = FRONTMATTER.exec(source)
  if (!match) return { data: {}, body: normalizeBody(source) }
  let data: unknown
  try {
    data = parseYaml(match[1] ?? '', { maxAliasCount: 0 }) ?? {}
  } catch (error) {
    throw new PostFileError(`The file on the site has frontmatter that is not valid YAML: ${(error as Error).message.split('\n')[0]}`, { cause: error })
  }
  if (!isMapping(data)) throw new PostFileError('The file on the site has frontmatter that is not a set of fields.')
  return { data, body: normalizeBody(source.slice(match[0].length)) }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isMapping(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

/** What was published last time: the frontmatter, and the text's digest. */
export interface PublishedState {
  data: Record<string, unknown>
  bodySha: string
}

export interface Reconciled extends PostFile {
  /** Fields, or `the text`, changed both here and on the site since. */
  conflicts: string[]
}

/**
 * The file to publish again, given what was published, what is published
 * now (theirs), and what this document makes now (ours). A field or the text
 * changed on one side only takes that side; changed on both sides, and
 * differently, it is a conflict, and ours is used only when the caller says so.
 */
export function reconcile(base: PublishedState, ours: PostFile, theirs: PostFile): Reconciled {
  const conflicts: string[] = []
  const data: Record<string, unknown> = {}
  const keys = [...Object.keys(ours.data), ...Object.keys(theirs.data).filter((key) => !Object.hasOwn(ours.data, key))]
  for (const key of keys) {
    const mine = own(ours.data, key), site = own(theirs.data, key), was = own(base.data, key)
    let value: unknown
    if (same(mine, site) || same(site, was)) value = mine
    else if (same(mine, was)) value = site
    else {
      conflicts.push(key)
      value = mine
    }
    if (value !== undefined) data[key] = value
  }
  const mineSha = sha256(ours.body), siteSha = sha256(theirs.body)
  let body = ours.body
  if (mineSha !== siteSha && siteSha !== base.bodySha) {
    if (mineSha === base.bodySha) body = theirs.body
    else conflicts.push('the text')
  }
  return { data, body, conflicts }
}

/* ---------------------------------------------------------------- suggestions */

/** The words a `suggest` source offers: `topics[].tag` in a YAML or JSON file. */
export function suggestionsFrom(source: string, path: string): string[] {
  let value: unknown
  try {
    value = parseYaml(source, { maxAliasCount: 0 })
  } catch (error) {
    throw new PublishConfigError(`not valid YAML: ${(error as Error).message.split('\n')[0]}`)
  }
  let values: unknown[] = [value]
  for (const part of path.split('.')) {
    const many = part.endsWith('[]')
    const key = many ? part.slice(0, -2) : part
    values = values.flatMap((v) => {
      const next = isMapping(v) ? v[key] : undefined
      return many ? (Array.isArray(next) ? next : []) : [next]
    })
  }
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim()))].slice(0, 500)
}
