// Markdown editor — file-backed CRUD over ~/.poise/editor/*.md (or
// $POISE_EDITOR_DIR if set). Each document is a plain UTF-8 markdown
// file; there's no metadata header, no DB row, no schema. The
// document's slug is its filename without the trailing `.md`. The
// title is derived from the first non-empty line at read time —
// users can rename a doc just by editing line 1.
//
// Why files: this is the writer's own corpus. Plain markdown files
// in their home directory means it integrates with whatever
// versioning / sync / backup they already have (git, Dropbox, iCloud,
// etc.). No lock-in.

import { mkdir, open, unlink, readdir, rename, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { withProcessLock } from './process-lock'
import type { GooglePublication } from './google/types'

const EDITOR_DIR = process.env.POISE_EDITOR_DIR || join(homedir(), '.poise', 'editor')
const EDITOR_LOCK_PATH = join(EDITOR_DIR, '.poise-editor-lock.sqlite3')
const STALE_TMP_AGE_MS = 24 * 60 * 60 * 1000
const CHAT_SESSION_MAX_BYTES = 64 * 1024
const EDITOR_LOCK_TIMEOUT_MS = 10_000

export type EditorVersion = string

function versionFor(content: string): EditorVersion {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// Missing state needs its own version so deleting an empty document cannot be
// mistaken for leaving an empty document unchanged. Annotation absence is a
// readable state, so its sentinel is returned by readAnnotations.
const MISSING_DOC_VERSION = versionFor('poise:editor:missing-document:v1')
const MISSING_ANNOTATIONS_VERSION = versionFor('poise:editor:missing-annotations:v1')

// All writes go through writeAtomic: write to a sibling .tmp file,
// then rename to the target path. POSIX rename is atomic — readers
// either see the old file or the new one, never a half-written file.
// If the write fails mid-way (disk full, process crash, etc.) the
// original target is untouched. The .tmp filename includes pid + a
// monotonic counter so concurrent writes from re-entrant code or
// multiple vite processes don't collide on the same temp path.
let tmpCounter = 0

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error: any) {
    // Windows does not consistently support opening/fsyncing directories.
    // POSIX directory fsync errors remain fatal because they mean rename
    // durability could not be established.
    const unsupportedOnWindows = process.platform === 'win32'
      && ['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)
    if (!unsupportedOnWindows) throw error
  } finally {
    await handle?.close()
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const tmpPath = `${target}.tmp.${process.pid}.${Date.now()}.${++tmpCounter}`
  let handle
  try {
    let mode = 0o600
    try { mode = (await stat(target)).mode & 0o777 }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error }

    handle = await open(tmpPath, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmpPath, target)
    await syncDirectory(dirname(target))
  } catch (err) {
    // Mid-write failure: leave the original target alone and try
    // to remove the abandoned tmp file. Swallow unlink errors —
    // tmp cleanup happens at startup too (cleanStaleTmpFiles).
    try { await handle?.close() } catch { /* best-effort */ }
    try { await unlink(tmpPath) } catch { /* best-effort */ }
    throw err
  }
}

export class EditorLockError extends Error {
  readonly code = 'EDITOR_LOCK_UNAVAILABLE'
  readonly statusCode = 503

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EditorLockError'
  }
}

async function runWithEditorLock<T>(mutation: () => Promise<T>): Promise<T> {
  return withProcessLock({
    path: EDITOR_LOCK_PATH,
    timeoutMs: EDITOR_LOCK_TIMEOUT_MS,
    unavailableMessage: 'editor mutation lock is unavailable',
    timeoutMessage: 'timed out waiting for editor mutation lock',
    errorFactory: (message, cause) => new EditorLockError(message, { cause }),
  }, mutation)
}

// Serialize mutations per target path for deterministic same-process order,
// then take a process-shared lock around each read/compare/write transaction.
const mutationTails = new Map<string, Promise<void>>()

async function serializeMutation<T>(
  target: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(target) || Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => { release = resolve })
  mutationTails.set(target, tail)
  await previous
  try {
    return await runWithEditorLock(mutation)
  } finally {
    release()
    if (mutationTails.get(target) === tail) mutationTails.delete(target)
  }
}

// On startup, sweep stale .tmp.* files left behind by a previous
// crash or a kill during writeAtomic. Tmp files in the editor dir
// are never user-visible (no slug looks like `*.tmp.<pid>.<...>`),
// so deleting them is safe. Idempotent: rerun any time.
async function cleanStaleTmpFiles(): Promise<void> {
  await ensureDir()
  let names: string[] = []
  try { names = await readdir(EDITOR_DIR) } catch { return }
  for (const f of names) {
    // Match the writeAtomic pattern: <anything>.tmp.<pid>.<ms>[.<counter>]
    const match = f.match(/\.tmp\.\d+\.(\d+)(?:\.\d+)?$/)
    if (!match) continue
    const createdAt = Number(match[1])
    // Another Poise process can be inside writeAtomic right now. Only sweep
    // files old enough that they cannot plausibly be an active write.
    if (!Number.isFinite(createdAt) || Date.now() - createdAt < STALE_TMP_AGE_MS) continue
    try { await unlink(join(EDITOR_DIR, f)) } catch { /* best-effort */ }
  }
}
// Public operations await startup cleanup. That prevents the sweep
// from mistaking an active atomic-write temp file for stale debris.
const editorReady = cleanStaleTmpFiles()

// Cap per-doc size so a runaway paste or a corrupt sync doesn't
// blow out memory on read. 5 MB is well past any prose document.
export const MAX_DOC_BYTES = 5 * 1024 * 1024

async function readTitle(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(4096, maxBytes))
    const decoder = new StringDecoder('utf8')
    const parts: string[] = []
    let offset = 0
    let nonempty = false
    while (offset < maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - offset), offset)
      if (!bytesRead) break
      offset += bytesRead
      const text = decoder.write(buffer.subarray(0, bytesRead))
      for (const part of text.split(/(?<=\n)/)) {
        parts.push(part)
        nonempty ||= part.trim().length > 0
        if (nonempty && part.endsWith('\n')) return deriveTitle(parts.join(''))
      }
    }
    parts.push(decoder.end())
    return deriveTitle(parts.join(''))
  } finally {
    await handle.close()
  }
}

async function readUtf8Limited(
  path: string,
  maxBytes: number,
  label: string,
): Promise<{ content: string, updatedAt: string, size: number }> {
  const handle = await open(path, 'r')
  try {
    const fileStat = await handle.stat()
    if (fileStat.size > maxBytes) throw new Error(`${label} too large (max ${maxBytes} bytes)`)
    const buffer = Buffer.alloc(fileStat.size)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return {
      content: buffer.subarray(0, offset).toString('utf-8'),
      updatedAt: fileStat.mtime.toISOString(),
      size: fileStat.size,
    }
  } finally {
    await handle.close()
  }
}

async function ensureDir(): Promise<void> {
  await mkdir(EDITOR_DIR, { recursive: true })
}

// A public slug and its on-disk basename must be a bijection. Rejecting rather
// than sanitizing is important: "a b", "a_b", and overlong common prefixes
// must never address the same document.
export const MAX_SLUG_LENGTH = 120
const CANONICAL_SLUG_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/

export function isCanonicalSlug(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_SLUG_LENGTH
    && CANONICAL_SLUG_RE.test(value)
}

function canonicalSlug(value: unknown): string {
  if (!isCanonicalSlug(value)) throw new Error('invalid slug')
  return value
}

function fileFor(slug: string): string {
  return join(EDITOR_DIR, canonicalSlug(slug) + '.md')
}

// The document's first non-empty line, rendered as plain text.
//
// The title is a label — in the document switcher, the window of the
// editor bar, the menu. It should read the way the line reads on the
// page, so the markup that produces that rendering is stripped rather
// than shown: a doc whose first line is `**Portfolio** is the entirety`
// titles as `Portfolio is the entirety`, not `**Portfolio **is the…`.
// Only the leading `#` used to be removed, so every other marker leaked
// through verbatim.
//
// Kept deliberately literal: this mirrors the small inline grammar the
// editor itself renders (bold, italic, inline code, links, block
// markers) and nothing more. Truncated at 200 chars so titles can't
// dominate the list.
function deriveTitle(content: string): string {
  const line = (content || '').split('\n').find((l) => l.trim().length > 0)
  if (!line) return 'Untitled'
  const t = stripMarkdownForTitle(line).slice(0, 200)
  return t || 'Untitled'
}

// Strip the markers the editor hides when it renders a line. Order
// matters: block markers are anchored to the start, so they go first.
export function stripMarkdownForTitle(line: string): string {
  let t = String(line || '').trim()
  // Block markers: heading hashes, bullet, or an ordered-list number.
  t = t.replace(/^#{1,6}\s+/, '')
  t = t.replace(/^(?:-\s+|\d+[.)]\s+)/, '')
  // Fenced-code markers carry no prose; drop the fence and any language.
  t = t.replace(/^```+\s*\S*\s*/, '')
  // Inline runs in one left-to-right pass, the way the editor parses
  // them: a code span matches whole, so markup inside backticks is
  // never unwrapped. Alternation order is precedence — bold before
  // italic so `**x**` isn't consumed one asterisk at a time. Italic
  // keeps the editor's own rules (word edges both sides, no space
  // inside the delimiters), so arithmetic and identifiers stay
  // literal, and the link URL stops at the first `)`, as the
  // editor's parser does. Whitespace that sat inside a delimiter
  // (`**Portfolio **`) is preserved as the space it renders as, then
  // collapsed below.
  t = t.replace(
    /`([^`]+)`|\*\*([^*]+)\*\*|(?<!\w)\*(\S|\S.*?\S)\*(?!\w)|(?<!\w)_(\S|\S.*?\S)_(?!\w)|\[([^\]]+)\]\(\S+?\)/g,
    (_match, code, bold, star, underscore, link) => code ?? bold ?? star ?? underscore ?? link,
  )
  // Any delimiters left over are unmatched, so they render literally in
  // the editor too — leave them alone rather than guess.
  return t.replace(/\s+/g, ' ').trim()
}

export interface DocSummary {
  slug: string         // filename without `.md`
  title: string        // first non-empty line, "#"-stripped
  updated_at: string   // ISO mtime
  size: number         // bytes
}

// Metadata is rechecked on every listing, including edits made outside Poise.
const summaryCache = new Map<string, { fingerprint: string, summary: DocSummary }>()

export async function listDocs(): Promise<DocSummary[]> {
  await editorReady
  let names: string[] = []
  try { names = await readdir(EDITOR_DIR) } catch { return [] }
  const slugs = names.filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).filter(isCanonicalSlug)
  const order = new Map(slugs.map((slug, index) => [slug, index]))
  const present = new Set(slugs)
  for (const slug of summaryCache.keys()) if (!present.has(slug)) summaryCache.delete(slug)
  const out: DocSummary[] = []
  let next = 0
  // Bound open files and disk work even for libraries with thousands of notes.
  await Promise.all(Array.from({ length: Math.min(8, slugs.length) }, async () => {
    while (next < slugs.length) {
      const slug = slugs[next++]
      const fullPath = join(EDITOR_DIR, slug + '.md')
      try {
        const st = await stat(fullPath, { bigint: true })
        if (!st.isFile()) continue
        const fingerprint = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
        let cached = summaryCache.get(slug)
        if (cached?.fingerprint !== fingerprint) {
          const title = await readTitle(fullPath, Math.min(Number(st.size), MAX_DOC_BYTES))
          cached = { fingerprint, summary: { slug, title, updated_at: new Date(Math.round(Number(st.mtimeNs) / 1_000_000)).toISOString(), size: Number(st.size) } }
          summaryCache.set(slug, cached)
        }
        out.push({ ...cached.summary })
      } catch { /* skip unreadable files silently */ }
    }
  }))
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || order.get(a.slug)! - order.get(b.slug)!)
  return out
}

export interface DocReadResult {
  slug: string
  content: string
  updated_at: string
  version: EditorVersion
}

export async function readDoc(slug: string): Promise<DocReadResult> {
  await editorReady
  const path = fileFor(slug)
  const loaded = await readUtf8Limited(path, MAX_DOC_BYTES, 'doc')
  return {
    slug: canonicalSlug(slug),
    content: loaded.content,
    updated_at: loaded.updatedAt,
    version: versionFor(loaded.content),
  }
}

export interface EditorWriteContext {
  clientId: string
  revision: number
  baseVersion: EditorVersion
}

interface ValidWriteContext {
  clientId: string
  revision: number
  baseVersion: EditorVersion
}

export interface DocWriteResult extends DocSummary {
  version: EditorVersion
  stale?: true
}

export class EditorConflictError extends Error {
  readonly code = 'EDITOR_CONFLICT'
  readonly statusCode = 409

  constructor(readonly currentVersion: EditorVersion) {
    super('editor content changed since it was loaded')
    this.name = 'EditorConflictError'
  }
}

const MAX_REVISION_ENTRIES = 10_000
interface ClientWriteState {
  revision: number
  version: EditorVersion
}
const latestClientWrites = new Map<string, ClientWriteState>()

function validWriteContext(input?: EditorWriteContext): ValidWriteContext | null {
  if (input === undefined) return null
  if (!input || typeof input !== 'object') throw new Error('invalid write context')
  if (typeof input.clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.clientId)) {
    throw new Error('invalid client_id')
  }
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0) {
    throw new Error('invalid revision')
  }
  if (typeof input.baseVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseVersion)) {
    throw new Error('invalid base_version')
  }
  return { clientId: input.clientId, revision: input.revision, baseVersion: input.baseVersion }
}

function clientWriteKey(target: string, context: ValidWriteContext): string {
  return `${target}\0${context.clientId}`
}

function previousClientWrite(target: string, context: ValidWriteContext): ClientWriteState | undefined {
  const key = clientWriteKey(target, context)
  const previous = latestClientWrites.get(key)
  // Losing a revision watermark could let an evicted lower revision write.
  // Fail closed for a new client instead; deletion and process restart clear
  // the bounded state in normal operation.
  if (!previous && latestClientWrites.size >= MAX_REVISION_ENTRIES) {
    throw new Error('too many active editor clients')
  }
  return previous
}

function rememberClientWrite(
  target: string,
  context: ValidWriteContext,
  version: EditorVersion,
): void {
  const key = clientWriteKey(target, context)
  latestClientWrites.delete(key)
  latestClientWrites.set(key, { revision: context.revision, version })
}

function forgetClientWrites(target: string): void {
  const prefix = `${target}\0`
  for (const key of latestClientWrites.keys()) {
    if (key.startsWith(prefix)) latestClientWrites.delete(key)
  }
}

function canReplaceVersion(
  currentVersion: EditorVersion,
  context: ValidWriteContext,
  previous: ClientWriteState | undefined,
): void {
  // Consecutive saves may have been snapshotted against the same read version.
  // Permit that same client to advance only while its own last write remains
  // current. Any intervening tab/external write breaks the chain.
  if (context.baseVersion === currentVersion) return
  if (previous?.version === currentVersion) return
  throw new EditorConflictError(currentVersion)
}

function docWriteResult(
  slug: string,
  loaded: { content: string, updatedAt: string, size: number },
  stale?: true,
): DocWriteResult {
  return {
    slug: canonicalSlug(slug),
    title: deriveTitle(loaded.content),
    updated_at: loaded.updatedAt,
    size: loaded.size,
    version: versionFor(loaded.content),
    ...(stale ? { stale } : {}),
  }
}

export async function writeDoc(
  slug: string,
  content: string,
  writeContext?: EditorWriteContext,
): Promise<DocWriteResult> {
  if (typeof content !== 'string') throw new Error('content must be a string')
  if (Buffer.byteLength(content, 'utf-8') > MAX_DOC_BYTES) {
    throw new Error(`doc too large (max ${MAX_DOC_BYTES} bytes)`)
  }
  await editorReady
  const path = fileFor(slug)
  const context = validWriteContext(writeContext)
  return serializeMutation(path, async () => {
    if (context) {
      let current
      try {
        current = await readUtf8Limited(path, MAX_DOC_BYTES, 'doc')
      } catch (error: any) {
        if (error?.code === 'ENOENT') throw new EditorConflictError(MISSING_DOC_VERSION)
        throw error
      }
      const currentVersion = versionFor(current.content)
      const previous = previousClientWrite(path, context)
      if (previous && context.revision <= previous.revision) {
        return docWriteResult(slug, current, true)
      }
      canReplaceVersion(currentVersion, context, previous)
    }
    await writeAtomic(path, content)
    const st = await stat(path)
    const version = versionFor(content)
    if (context) rememberClientWrite(path, context, version)
    return {
      slug: canonicalSlug(slug),
      title: deriveTitle(content),
      updated_at: st.mtime.toISOString(),
      size: st.size,
      version,
    }
  })
}

export async function deleteDoc(slug: string): Promise<{ ok: true }> {
  await editorReady
  const path = fileFor(slug)
  // Take any side-cars with the doc — annotations, chat-session and
  // publishing bookkeeping. All best-effort: ENOENT on a side-car is
  // normal (most docs won't have annotations, a chat or a publication).
  const annPath = annotationsFileFor(slug)
  const chatPath = chatSessionFileFor(slug)
  const publishPath = publishLedgerFileFor(slug)
  const remove = (target: string) => serializeMutation(target, async () => {
    try { await unlink(target) }
    catch (err: any) { if (err.code !== 'ENOENT') throw err }
    forgetClientWrites(target)
  })
  // The doc first: a publishing record written meanwhile is either removed
  // with the side-cars or finds the doc gone (writePublishLedger).
  await remove(path)
  await Promise.all([annPath, chatPath, publishPath, googleLedgerFile(slug)].map(remove))
  return { ok: true }
}

// Mint a fresh, sortable slug for a new blank doc. Millisecond time
// keeps creation order legible; a UUID prevents collisions across
// simultaneous requests and multiple processes.
export function newSlug(): string {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '')
  return `untitled-${stamp}-${randomUUID()}`
}

// ── Annotations ───────────────────────────────────────────────────────
//
// Each editor doc can carry side-car annotations: range-anchored notes
// the writer attaches to specific spans of text. Stored alongside the
// .md file as `<slug>.annotations.json`. The markdown file stays
// pristine (no inline metadata pollution) so it round-trips cleanly
// through git/Dropbox/etc.
//
// Range anchoring: the annotation pins to a (line, char-offset) pair
// at write time AND records a snippet of the highlighted text. On
// load we first try the recorded coords; if the snippet there has
// drifted (the user edited above and lines shifted), the front-end
// searches for the snippet in the current doc and rebinds. Genuinely
// orphaned annotations stay in storage but render as inert.
//
// Annotation ids and session_ids are caller-supplied (the front-end
// mints them) — keeping them client-owned means we don't need a
// generation endpoint round-trip to create one. A single session_id
// per annotation lets each comment grow into a long-running chat
// thread later (Phase 2) by passing it to agent-interface --chat.

export const MAX_ANNOTATIONS_BYTES = 1 * 1024 * 1024     // 1 MB / doc — many hundreds of comments

export interface AnnotationRange {
  start_line: number
  start_offset: number
  end_line: number
  end_offset: number
}

export interface Annotation {
  id: string
  session_id: string
  range: AnnotationRange
  snippet: string         // the highlighted text at create time, used for re-anchoring
  comment: string
  created_at: string
  updated_at: string
}

export interface AnnotationsFile {
  annotations: Annotation[]
}

export interface AnnotationsReadResult extends AnnotationsFile {
  version: EditorVersion
}

export interface AnnotationsWriteResult {
  ok: true
  version: EditorVersion
  stale?: true
}

function annotationsFileFor(slug: string): string {
  return join(EDITOR_DIR, canonicalSlug(slug) + '.annotations.json')
}

function parseAnnotationsContainer(raw: string): AnnotationsFile {
  const parsed: unknown = JSON.parse(raw)
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !Array.isArray((parsed as { annotations?: unknown }).annotations)
  ) {
    throw new Error('annotations must be an array')
  }
  return { annotations: (parsed as AnnotationsFile).annotations }
}

export async function readAnnotations(slug: string): Promise<AnnotationsReadResult> {
  await editorReady
  const path = annotationsFileFor(slug)
  try {
    const raw = (await readUtf8Limited(path, MAX_ANNOTATIONS_BYTES, 'annotations')).content
    return { ...parseAnnotationsContainer(raw), version: versionFor(raw) }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { annotations: [], version: MISSING_ANNOTATIONS_VERSION }
    }
    // Corrupt JSON or unreadable file: don't silently lose user data.
    // The front-end can decide whether to overwrite on next save.
    throw err
  }
}

export async function writeAnnotations(
  slug: string,
  file: AnnotationsFile,
  writeContext?: EditorWriteContext,
): Promise<AnnotationsWriteResult> {
  if (!file || !Array.isArray(file.annotations)) throw new Error('annotations must be an array')
  const body = JSON.stringify({ annotations: file.annotations }, null, 2)
  if (Buffer.byteLength(body, 'utf-8') > MAX_ANNOTATIONS_BYTES) {
    throw new Error(`annotations too large (max ${MAX_ANNOTATIONS_BYTES} bytes)`)
  }
  await editorReady
  const path = annotationsFileFor(slug)
  const context = validWriteContext(writeContext)
  return serializeMutation(path, async () => {
    let currentVersion = MISSING_ANNOTATIONS_VERSION
    if (context) {
      try {
        const current = await readUtf8Limited(path, MAX_ANNOTATIONS_BYTES, 'annotations')
        currentVersion = versionFor(current.content)
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
      const previous = previousClientWrite(path, context)
      if (previous && context.revision <= previous.revision) {
        return { ok: true, version: currentVersion, stale: true }
      }
      canReplaceVersion(currentVersion, context, previous)
    }
    await writeAtomic(path, body)
    const version = versionFor(body)
    if (context) rememberClientWrite(path, context, version)
    return { ok: true, version }
  })
}

// Annotations follow the doc — when the doc is deleted, the side-car
// goes with it. Best-effort: if the side-car is already gone we
// don't surface that.
export async function deleteAnnotations(slug: string): Promise<{ ok: true }> {
  await editorReady
  const path = annotationsFileFor(slug)
  return serializeMutation(path, async () => {
    try { await unlink(path) }
    catch (err: any) { if (err.code !== 'ENOENT') throw err }
    forgetClientWrites(path)
    return { ok: true }
  })
}

// ── Legacy chat session ───────────────────────────────────────────────
//
// Before every Editor chat ran as a Chat session, each doc's conversation
// lived in agent-interface under a single session_id string, remembered
// here as a side-car next to the .md and .annotations.json:
//   <slug>.chat.json  →  { session_id, created_at }
//
// session_id format: `editor-<canonical-slug>-<ms>`. Nothing mints these
// anymore; the side-car is read-only history so a doc's first Chat session
// can import its earlier conversation. Deleting the doc still removes it.

export interface ChatSessionFile {
  session_id: string
  created_at: string
}

function chatSessionFileFor(slug: string): string {
  return join(EDITOR_DIR, canonicalSlug(slug) + '.chat.json')
}

// Read the legacy chat id for `slug` without minting one. A missing or
// unusable side-car reads as no legacy conversation: the caller imports
// nothing. Unexpected read errors still surface.
export async function peekChatSession(slug: string): Promise<string | null> {
  await editorReady
  const path = chatSessionFileFor(slug)
  let raw: string
  try {
    raw = (await readUtf8Limited(path, CHAT_SESSION_MAX_BYTES, 'chat session')).content
  } catch (err: any) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ChatSessionFile>
    return parsed && typeof parsed.session_id === 'string' && parsed.session_id ? parsed.session_id : null
  } catch {
    return null
  }
}

// ── Publishing ────────────────────────────────────────────────────────
//
// Where a document has been published (server/publishing-api.ts), one
// record per site and section, kept as a fourth side-car:
//   <slug>.publish.json  →  { records: [...] }
// Publishing again finds the same pull request through it, and what was
// published is what tells the site's own changes apart from the writer's.

export const MAX_PUBLISH_LEDGER_BYTES = 1 * 1024 * 1024

export interface PublishRecord {
  repo: string                  // the site's repository
  repoId?: number               // its GitHub id: the same through a rename, another for a repository taking its old name
  section: string
  site: string                  // the site's name when published
  headRepo: string              // where the branch is: the repository, or the writer's fork
  branch: string
  base: string                  // the branch the pull request goes to
  path: string
  url: string
  slug: string
  date: string                  // the date its path and address were filled with
  pullRequest: { number: number, url: string, base?: string } // base: the branch it went to when last read
  publishedAt: string           // first published there
  updatedAt: string
  sourceSha: string             // the document as it was published
  docTitle?: string             // its first line then, to tell a title typed in the panel from one that followed it
  values: Record<string, unknown>
  data: Record<string, unknown> // the frontmatter this document gave it
  bodySha: string               // the text this document gave it
  /** This document's side of the version last merged there: still the
   *  site's file, and still this document's, whatever came after it. */
  landed?: { data: Record<string, unknown>, bodySha: string, pullRequest: number, url: string, date?: string, base?: string, unknown?: true }
  /** An update committed while its pull request could not be read: its
   *  commit, and the address of the version before it, until a later
   *  publication reads the pull request again. */
  unconfirmed?: { commit: string, url: string, date?: string }
}

export interface PublishLedger {
  records: PublishRecord[]
}

function publishLedgerFileFor(slug: string): string {
  return join(EDITOR_DIR, canonicalSlug(slug) + '.publish.json')
}

function isPublishRecord(value: unknown): value is PublishRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const pr = record.pullRequest as Record<string, unknown> | undefined
  return ['repo', 'section', 'site', 'headRepo', 'branch', 'base', 'path', 'url', 'slug', 'date', 'publishedAt', 'updatedAt', 'sourceSha', 'bodySha']
    .every((key) => typeof record[key] === 'string')
    && !!pr && Number.isSafeInteger(pr.number) && typeof pr.url === 'string' && (pr.base === undefined || typeof pr.base === 'string')
    && !!record.values && typeof record.values === 'object' && !Array.isArray(record.values)
    && !!record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    && (record.landed === undefined || isLanded(record.landed))
    && (record.docTitle === undefined || typeof record.docTitle === 'string')
    && (record.unconfirmed === undefined || isUnconfirmed(record.unconfirmed))
    && (record.repoId === undefined || Number.isSafeInteger(record.repoId))
}

function isUnconfirmed(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const unconfirmed = value as Record<string, unknown>
  return typeof unconfirmed.commit === 'string' && typeof unconfirmed.url === 'string'
    && (unconfirmed.date === undefined || typeof unconfirmed.date === 'string')
}

function isLanded(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const landed = value as Record<string, unknown>
  return !!landed.data && typeof landed.data === 'object' && !Array.isArray(landed.data)
    && typeof landed.bodySha === 'string' && Number.isSafeInteger(landed.pullRequest) && typeof landed.url === 'string'
    && (landed.date === undefined || typeof landed.date === 'string')
    && (landed.base === undefined || typeof landed.base === 'string')
    && (landed.unknown === undefined || landed.unknown === true)
}

export async function readPublishLedger(slug: string): Promise<PublishLedger> {
  await editorReady
  const path = publishLedgerFileFor(slug)
  let raw: string
  try {
    raw = (await readUtf8Limited(path, MAX_PUBLISH_LEDGER_BYTES, 'publishing record')).content
  } catch (err: any) {
    if (err.code === 'ENOENT') return { records: [] }
    throw err
  }
  // A record that cannot be read is never taken for "not published": that
  // would open a second pull request for a piece already on its way.
  const parsed = JSON.parse(raw) as { records?: unknown }
  if (!parsed || !Array.isArray(parsed.records) || !parsed.records.every(isPublishRecord)) {
    throw new Error(`the publishing record beside ${canonicalSlug(slug)} is unreadable`)
  }
  return { records: parsed.records }
}

export async function writePublishLedger(slug: string, ledger: PublishLedger): Promise<void> {
  const body = JSON.stringify({ records: ledger.records }, null, 2)
  if (Buffer.byteLength(body, 'utf-8') > MAX_PUBLISH_LEDGER_BYTES) {
    throw new Error(`publishing record too large (max ${MAX_PUBLISH_LEDGER_BYTES} bytes)`)
  }
  await editorReady
  const path = publishLedgerFileFor(slug)
  await serializeMutation(path, async () => {
    // A doc deleted while it was being published takes its record with it:
    // none is written again for it. Its pull requests stay.
    await stat(fileFor(slug))
    await writeAtomic(path, body)
  })
}

const PUBLISH_LOCK_PATH = join(EDITOR_DIR, '.poise-publish-lock.sqlite3')
const PUBLISH_LOCK_TIMEOUT_MS = 30_000

/**
 * One publication at a time across every Poise process sharing this Editor
 * folder: each reads a document's record, publishes, and writes it back, so
 * two at once would each write over the other's pull requests.
 */
export async function withPublishLock<T>(operation: () => Promise<T>, timeoutMs = PUBLISH_LOCK_TIMEOUT_MS): Promise<T> {
  await editorReady
  return withProcessLock({
    path: PUBLISH_LOCK_PATH,
    timeoutMs,
    unavailableMessage: 'the publishing lock is unavailable',
    timeoutMessage: 'Another Poise is publishing from this Editor folder; try again once it has finished.',
  }, operation)
}

function googleLedgerFile(slug: string): string { return join(EDITOR_DIR, canonicalSlug(slug) + '.google.json') }

const MISSING_GOOGLE_LEDGER_VERSION = versionFor('poise:google:missing:v1')
export async function readGoogleLedgerState(slug: string): Promise<{ records: GooglePublication[], version: string }> {
  await editorReady
  let raw: string
  try { raw = (await readUtf8Limited(googleLedgerFile(slug), MAX_PUBLISH_LEDGER_BYTES, 'Google publishing record')).content }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A missing ledger still belongs to one file incarnation, including before ID allocation.
    try {
      const file = await stat(fileFor(slug))
      return { records: [], version: versionFor(`${MISSING_GOOGLE_LEDGER_VERSION}:${file.dev}:${file.ino}:${file.birthtimeMs}`) }
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], version: MISSING_GOOGLE_LEDGER_VERSION }
      throw missing
    }
  }
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.length > 10 || !value.every(item => item && typeof item === 'object'
    && ['accountId', 'fileId', 'title', 'url', 'sourceSha', 'remoteSha'].every(key => typeof item[key] === 'string')
    && /^[A-Za-z0-9_-]+$/.test(item.accountId) && /^[A-Za-z0-9_-]+$/.test(item.fileId)
    && item.url === `https://docs.google.com/document/d/${item.fileId}/edit`
    && (item.pending === undefined || typeof item.pending === 'boolean'))) throw new Error('The Google publishing record is unreadable.')
  return { records: value as GooglePublication[], version: versionFor(raw) }
}
export async function readGoogleLedger(slug: string): Promise<GooglePublication[]> { return (await readGoogleLedgerState(slug)).records }

export async function readGoogleDocumentState(slug: string): Promise<{ doc: DocReadResult, ledger: Awaited<ReturnType<typeof readGoogleLedgerState>> }> {
  await editorReady
  return serializeMutation(fileFor(slug), async () => ({ doc: await readDoc(slug), ledger: await readGoogleLedgerState(slug) }))
}

export async function writeGoogleLedger(slug: string, records: GooglePublication[], baseVersion: string): Promise<string> {
  await editorReady
  const body = JSON.stringify(records)
  if (Buffer.byteLength(body) > MAX_PUBLISH_LEDGER_BYTES || records.length > 10) throw new Error('The Google publishing record exceeds its limit.')
  await serializeMutation(fileFor(slug), async () => {
    await stat(fileFor(slug))
    const current = await readGoogleLedgerState(slug)
    if (current.version !== baseVersion) throw new EditorConflictError(current.version)
    await writeAtomic(googleLedgerFile(slug), body)
  })
  return versionFor(body)
}

/** Back up and replace under the same process-shared lock and exact content precondition. */
export async function importGoogleDocument(slug: string, content: string, baseVersion: string, ledgerVersion: string): Promise<void> {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_DOC_BYTES) throw new Error('The Google document exceeds the Editor limit.')
  await editorReady
  const path = fileFor(slug)
  await serializeMutation(path, async () => {
    if ((await readGoogleLedgerState(slug)).version !== ledgerVersion) throw new EditorConflictError(ledgerVersion)
    const current = await readUtf8Limited(path, MAX_DOC_BYTES, 'doc')
    const version = versionFor(current.content)
    if (baseVersion !== version) throw new EditorConflictError(version)
    const folder = join(EDITOR_DIR, '.google-history', canonicalSlug(slug))
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeAtomic(join(folder, `${Date.now()}-${randomUUID()}.md`), current.content)
    await writeAtomic(path, content)
    forgetClientWrites(path)
  })
}
