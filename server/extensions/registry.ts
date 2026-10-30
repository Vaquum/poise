// The Extensions directory: a local mirror of the official MCP Registry.
// The registry's own search answers in tens of seconds and single pages
// often take most of a minute, so Poise crawls it in the background (resuming
// where a failed page stopped), keeps the last complete catalog, and searches
// its copy instantly.

import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { db, getMeta, setMeta } from '../db'
import { ExtensionError } from './store'
import { nameFrom, type DirectoryEntry, type DirectoryInput, type DirectoryStatus, type Field, type InstallOption, type ServerSpec } from './types'

db.exec(`CREATE TABLE IF NOT EXISTS extension_directory (
  name TEXT PRIMARY KEY,
  entry TEXT NOT NULL,
  generation INTEGER NOT NULL
)`)

const SYNC_KEY = 'extension_directory_sync'
const PAGE = 100
const PAGE_TIMEOUT_MS = 90_000
const ATTEMPTS = 3
const FRESH_MS = 24 * 60 * 60_000
// After a failed crawl, opening the view does not try again for a while; Refresh does.
const RETRY_MS = 10 * 60_000
const OFFICIAL = 'io.modelcontextprotocol.registry/official'

/** Shown before anything is searched; each checked against the live registry
 *  (October 2026). Names that are not in the mirror are skipped. */
export const FEATURED = [
  'io.github.github/github-mcp-server',
  'com.notion/mcp',
  'app.linear/linear',
  'io.github.microsoft/playwright-mcp',
  'io.github.upstash/context7',
  'com.stripe/mcp',
  'com.atlassian/atlassian-mcp-server',
  'com.cloudflare.mcp/mcp',
  'com.figma.mcp/mcp',
  'com.supabase/mcp',
  'ai.exa/exa',
]

interface SyncState { generation: number, cursor: string | null, startedAt?: string, completedAt?: string, error?: string, failedAt?: string }

export function registryUrl(): string {
  return (process.env.POISE_MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io').replace(/\/+$/, '')
}

function syncState(): SyncState {
  const raw = getMeta(SYNC_KEY)
  return raw ? JSON.parse(raw) as SyncState : { generation: 0, cursor: null }
}

let entries: { stamp: string, list: DirectoryEntry[] } | null = null
let running: Promise<void> | null = null

/** The mirror, parsed once per change of its rows. */
function all(): DirectoryEntry[] {
  const { n, g } = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(generation), 0) AS g FROM extension_directory').get() as { n: number, g: number }
  const stamp = `${n}:${g}`
  if (entries?.stamp !== stamp) entries = { stamp, list: (db.prepare('SELECT entry FROM extension_directory ORDER BY name').all() as Array<{ entry: string }>).map((row) => JSON.parse(row.entry) as DirectoryEntry) }
  return entries.list
}

export function directoryStatus(): DirectoryStatus {
  const state = syncState()
  return { count: all().length, syncing: running !== null, ...(state.completedAt ? { completedAt: state.completedAt } : {}), ...(state.error ? { error: state.error } : {}) }
}

/** Crawl the registry when the mirror is older than a day, or when asked. */
export function syncDirectory(options: { force?: boolean } = {}): Promise<void> {
  if (running) return running
  const state = syncState()
  const fresh = state.completedAt && !state.cursor && Date.now() - Date.parse(state.completedAt) < FRESH_MS
  const resting = state.failedAt && Date.now() - Date.parse(state.failedAt) < RETRY_MS
  if ((fresh || resting) && !options.force) return Promise.resolve()
  running = crawl(state).finally(() => { running = null })
  return running
}

async function fetchPage(cursor: string | null): Promise<{ servers: unknown[], next: string | null }> {
  const url = `${registryUrl()}/v0.1/servers?limit=${PAGE}&version=latest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
  let last: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`the registry answered ${response.status}`)
      const body = await response.json() as { servers?: unknown, metadata?: { nextCursor?: unknown } }
      if (!Array.isArray(body.servers)) throw new Error('the registry sent a page without servers')
      return { servers: body.servers, next: typeof body.metadata?.nextCursor === 'string' && body.metadata.nextCursor ? body.metadata.nextCursor : null }
    } catch (error) {
      last = error
    }
  }
  throw new Error(`The MCP Registry did not answer after ${ATTEMPTS} attempts: ${last instanceof Error ? last.message : String(last)}`)
}

async function crawl(previous: SyncState): Promise<void> {
  // A crawl that stopped part-way resumes with its own generation.
  const state: SyncState = previous.cursor
    ? { ...previous, error: undefined, failedAt: undefined }
    : { generation: previous.generation + 1, cursor: null, startedAt: new Date().toISOString(), ...(previous.completedAt ? { completedAt: previous.completedAt } : {}) }
  setMeta(SYNC_KEY, JSON.stringify(state))
  const upsert = db.prepare('INSERT INTO extension_directory (name, entry, generation) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET entry = excluded.entry, generation = excluded.generation')
  try {
    do {
      const page = await fetchPage(state.cursor)
      db.transaction(() => {
        for (const raw of page.servers) {
          const entry = directoryEntry(raw)
          if (entry) upsert.run(entry.name, JSON.stringify(entry), state.generation)
        }
      })()
      entries = null
      state.cursor = page.next
      setMeta(SYNC_KEY, JSON.stringify(state))
    } while (state.cursor)
    db.prepare('DELETE FROM extension_directory WHERE generation < ?').run(state.generation)
    entries = null
    setMeta(SYNC_KEY, JSON.stringify({ generation: state.generation, cursor: null, startedAt: state.startedAt, completedAt: new Date().toISOString() } satisfies SyncState))
  } catch (error) {
    setMeta(SYNC_KEY, JSON.stringify({ ...state, error: error instanceof Error ? error.message : String(error), failedAt: new Date().toISOString() } satisfies SyncState))
    throw error
  }
}

// ── Mapping registry entries ───────────────────────────────────────────

interface RawInput { name?: unknown, description?: unknown, isRequired?: unknown, isSecret?: unknown, value?: unknown, default?: unknown, choices?: unknown, variables?: unknown, type?: unknown, valueHint?: unknown }

const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
// Registry links become links in the page: anything but HTTPS (javascript:, data:) is dropped.
const https = (value: unknown): string | undefined => { const text = str(value); return text && /^https:\/\//i.test(text) ? text : undefined }
const placeholders = (template: string) => [...template.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1])

function publisherOf(name: string): string {
  const namespace = name.split('/')[0]
  const github = /^io\.github\.(.+)$/.exec(namespace)
  return github ? `github.com/${github[1]}` : namespace.split('.').reverse().join('.')
}

function input(key: string, raw: RawInput, label: string, secret = false): DirectoryInput {
  const choices = Array.isArray(raw.choices) ? raw.choices.filter((choice): choice is string => typeof choice === 'string') : []
  return {
    key, label,
    ...(str(raw.description) ? { description: str(raw.description) } : {}),
    required: raw.isRequired === true, secret: raw.isSecret === true || secret,
    ...(str(raw.default) ? { default: str(raw.default) } : {}),
    ...(choices.length ? { choices } : {}),
  }
}

/** Inputs for the `{placeholders}` of a templated value; a placeholder is required unless its variable says otherwise. */
function templateInputs(prefix: string, template: string, variables: unknown, secret: boolean): DirectoryInput[] {
  const vars = (variables && typeof variables === 'object' ? variables : {}) as Record<string, RawInput>
  return placeholders(template).map((name) => input(`${prefix}:${name}`, { ...(vars[name] ?? {}), isRequired: vars[name]?.isRequired ?? true }, name, secret))
}

function remoteOption(raw: Record<string, unknown>, index: number): InstallOption {
  const url = str(raw.url) ?? ''
  const inputs: DirectoryInput[] = templateInputs('url', url, raw.variables, false)
  const headers: NonNullable<InstallOption['headers']> = []
  for (const header of Array.isArray(raw.headers) ? raw.headers as RawInput[] : []) {
    const name = str(header.name)
    if (!name) continue
    const template = str(header.value)
    const secret = header.isSecret === true
    if (template && placeholders(template).length) inputs.push(...templateInputs(`header:${name}`, template, header.variables, secret))
    else if (!template) inputs.push(input(`header:${name}`, header, name))
    headers.push({ name, ...(template ? { template } : {}), secret })
  }
  const unsupported = raw.type !== 'streamable-http' && raw.type !== 'sse' ? `Poise cannot connect to a ${String(raw.type)} remote.`
    : !url ? 'The registry lists no URL for this remote.' : undefined
  return { id: `remote-${index}`, kind: 'remote', transport: raw.type === 'sse' ? 'sse' : 'http', summary: url, inputs, url, headers, ...(unsupported ? { unsupported } : {}) }
}

/** Fixed arguments as text; required ones without a value become inputs; optional ones without a value are left out. */
function argumentParts(args: unknown, prefix: string, inputs: DirectoryInput[]): Array<string | { input: string }> {
  const parts: Array<string | { input: string }> = []
  ;(Array.isArray(args) ? args as RawInput[] : []).forEach((arg, index) => {
    const value = str(arg.value) ?? str(arg.default)
    const flag = arg.type === 'named' ? str(arg.name) : undefined
    if (value && !placeholders(value).length) { parts.push(...(flag ? [flag, value] : [value])); return }
    if (arg.isRequired !== true) return
    const key = `arg:${prefix}${index}`
    inputs.push(input(key, arg, str(arg.valueHint) ?? flag ?? `Argument ${index + 1}`))
    parts.push(...(flag ? [flag, { input: key }] : [{ input: key }]))
  })
  return parts
}

function packageOption(raw: Record<string, unknown>, index: number): InstallOption {
  const registryType = str(raw.registryType) ?? 'unknown'
  const identifier = str(raw.identifier) ?? ''
  const version = str(raw.version)
  const transport = (raw.transport as { type?: unknown } | undefined)?.type ?? 'stdio'
  const inputs: DirectoryInput[] = []
  const runtime = argumentParts(raw.runtimeArguments, 'r', inputs)
  const packaged = argumentParts(raw.packageArguments, 'p', inputs)
  for (const env of Array.isArray(raw.environmentVariables) ? raw.environmentVariables as RawInput[] : []) {
    const name = str(env.name)
    if (name) inputs.push(input(`env:${name}`, env, name))
  }
  const launcher = registryType === 'npm' ? { command: 'npx', args: ['-y', ...runtime, version ? `${identifier}@${version}` : identifier, ...packaged] }
    : registryType === 'pypi' ? { command: 'uvx', args: [...runtime, version ? `${identifier}==${version}` : identifier, ...packaged] }
    : null
  const secretArgument = inputs.some((input) => input.key.startsWith('arg:') && input.secret)
  const unsupported = transport !== 'stdio' ? 'This package runs its own HTTP server; add it as a custom server instead.'
    : !launcher ? `Poise does not run ${registryType} packages; add it as a custom server instead.`
    : !identifier ? 'The registry lists no package name.'
    // Arguments are part of the visible definition and of a command line, never secret.
    : secretArgument ? 'It takes a secret on its command line, which Poise does not store; add it as a custom server instead.'
    : undefined
  const label = (part: string | { input: string }) => typeof part === 'string' ? part : `<${inputs.find((candidate) => candidate.key === part.input)?.label ?? part.input}>`
  const summary = launcher ? [launcher.command, ...launcher.args.map(label)].join(' ') : `${registryType} ${identifier}`
  return { id: `package-${index}`, kind: 'package', transport: 'stdio', summary, inputs, ...(launcher ? launcher : {}), ...(unsupported ? { unsupported } : {}) }
}

/** A registry `ServerResponse` as the directory shows it; null for entries the
 *  registry marks deprecated or deleted, or that are malformed. */
export function directoryEntry(raw: unknown): DirectoryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const server = (raw as { server?: unknown }).server as Record<string, unknown> | undefined
  const official = ((raw as { _meta?: Record<string, unknown> })._meta?.[OFFICIAL] ?? {}) as { status?: unknown }
  if (!server || typeof server !== 'object' || (official.status !== undefined && official.status !== 'active')) return null
  const name = str(server.name)
  const version = str(server.version)
  if (!name || !version) return null
  const icons = Array.isArray(server.icons) ? server.icons as Array<{ src?: unknown }> : []
  const repository = server.repository as { url?: unknown } | undefined
  const options = [
    ...(Array.isArray(server.remotes) ? server.remotes as Array<Record<string, unknown>> : []).map(remoteOption),
    ...(Array.isArray(server.packages) ? server.packages as Array<Record<string, unknown>> : []).map(packageOption),
  ]
  if (!options.length) return null
  return {
    name, version,
    title: str(server.title) ?? name.split('/').pop()!,
    description: (str(server.description) ?? '').slice(0, 400),
    publisher: publisherOf(name),
    ...(https(server.websiteUrl) ? { websiteUrl: https(server.websiteUrl) } : {}),
    ...(https(repository?.url) ? { repositoryUrl: https(repository?.url) } : {}),
    ...(icons.map((icon) => https(icon.src)).find(Boolean) ? { icon: icons.map((icon) => https(icon.src)).find(Boolean) } : {}),
    options,
  }
}

// ── Searching ──────────────────────────────────────────────────────────

function launchable(command: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try { accessSync(join(dir, command), constants.X_OK); return true } catch { /* next directory */ }
  }
  return false
}

/** Mark package options this host cannot launch (the workspace image has npx, not uvx). */
function withHost(entry: DirectoryEntry): DirectoryEntry {
  return {
    ...entry,
    options: entry.options.map((option) => {
      if (option.unsupported || option.kind !== 'package') return option
      const command = option.command ?? ''
      return launchable(command) ? option : { ...option, unsupported: `${command} is not installed where Poise runs.` }
    }),
  }
}

export function directoryEntryByName(name: string): DirectoryEntry {
  const entry = all().find((candidate) => candidate.name === name)
  if (!entry) throw new ExtensionError(404, `${name} is not in the directory. Refresh the directory and try again.`)
  return withHost(entry)
}

export function searchDirectory(query: string, kind: 'any' | 'remote' | 'local', limit: number, offset: number): { entries: DirectoryEntry[], total: number, featured: boolean } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const fits = (entry: DirectoryEntry) => kind === 'any' || entry.options.some((option) => (option.kind === 'remote') === (kind === 'remote'))
  if (!words.length) {
    const byName = new Map(all().map((entry) => [entry.name, entry]))
    const featured = FEATURED.map((name) => byName.get(name)).filter((entry): entry is DirectoryEntry => !!entry && fits(entry))
    const rest = all().filter((entry) => !FEATURED.includes(entry.name) && fits(entry))
    const ordered = [...featured, ...rest]
    return { entries: ordered.slice(offset, offset + limit).map(withHost), total: ordered.length, featured: featured.length > 0 }
  }
  const scored = all().flatMap((entry) => {
    if (!fits(entry)) return []
    const title = entry.title.toLowerCase()
    const haystack = `${title} ${entry.name.toLowerCase()} ${entry.description.toLowerCase()}`
    if (!words.every((word) => haystack.includes(word))) return []
    const phrase = words.join(' ')
    const score = title === phrase ? 4 : title.startsWith(phrase) ? 3 : title.includes(phrase) ? 2 : entry.name.toLowerCase().includes(phrase) ? 1 : 0
    return [{ entry, score }]
  }).sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
  return { entries: scored.slice(offset, offset + limit).map(({ entry }) => withHost(entry)), total: scored.length, featured: false }
}

// ── Installing ─────────────────────────────────────────────────────────

const fill = (template: string, prefix: string, values: Record<string, string>) => template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, name: string) => values[`${prefix}:${name}`] ?? '')

/** A directory option turned into a server definition and its secrets, from
 *  the values the person entered. Required values must be present. */
export function installSpec(entry: DirectoryEntry, optionId: string, values: Record<string, string>, name: string): { spec: ServerSpec, secrets: Record<string, string> } {
  const option = entry.options.find((candidate) => candidate.id === optionId)
  if (!option) throw new ExtensionError(404, 'That install option no longer exists. Refresh the directory and try again.')
  if (option.unsupported) throw new ExtensionError(400, option.unsupported)
  const filled: Record<string, string> = {}
  for (const input of option.inputs) {
    const text = (values[input.key] ?? '').trim() || (input.secret ? '' : input.default ?? '')
    if (!text && input.required) throw new ExtensionError(400, `Enter ${input.label}.`)
    if (/[\r\n\0]/.test(text)) throw new ExtensionError(400, `${input.label} must be a single line.`)
    if (text) filled[input.key] = text
  }
  const secrets: Record<string, string> = {}
  const registry = { name: entry.name, version: entry.version, option: option.id, ...(entry.websiteUrl ? { websiteUrl: entry.websiteUrl } : {}), ...(entry.repositoryUrl ? { repositoryUrl: entry.repositoryUrl } : {}) }
  const base = { name, title: entry.title, source: 'directory' as const, auth: 'none' as const, registry }
  if (option.kind === 'remote') {
    const headers: Field[] = []
    for (const header of option.headers ?? []) {
      const own = option.inputs.filter((candidate) => candidate.key === `header:${header.name}` || candidate.key.startsWith(`header:${header.name}:`))
      // An optional header the person left empty is not sent at all.
      if (own.length && own.every((candidate) => !filled[candidate.key])) continue
      const text = header.template ? fill(header.template, `header:${header.name}`, filled) : filled[`header:${header.name}`] ?? ''
      const secret = header.secret || own.some((candidate) => candidate.secret)
      if (secret) { secrets[`header:${header.name}`] = text; headers.push({ name: header.name, secret: true }) }
      else headers.push({ name: header.name, value: text, secret: false })
    }
    return { spec: { ...base, transport: option.transport, url: fill(option.url ?? '', 'url', filled), headers }, secrets }
  }
  const args = (option.args ?? []).map((part) => typeof part === 'string' ? part : filled[part.input] ?? '')
  const env: Field[] = []
  for (const input of option.inputs.filter((candidate) => candidate.key.startsWith('env:'))) {
    const text = filled[input.key]
    if (!text) continue
    const envName = input.key.slice(4)
    if (input.secret) { secrets[`env:${envName}`] = text; env.push({ name: envName, secret: true }) }
    else env.push({ name: envName, value: text, secret: false })
  }
  return { spec: { ...base, transport: 'stdio', command: option.command, args, env }, secrets }
}

export function uniqueName(title: string, taken: (name: string) => boolean): string {
  const base = nameFrom(title)
  if (!taken(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 44)}-${n}`
    if (!taken(candidate)) return candidate
  }
  throw new ExtensionError(409, 'Choose a different name for this server.')
}
