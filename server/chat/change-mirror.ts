// Native agents can edit through shells or auto-approved tools that expose
// no trustworthy pre-image. This is an OBSERVATION of checkout changes over
// the whole turn, not a claim that a particular native tool made each edit.
// Capture before invoking the agent, and compare only after workers and
// Poise filesystem services have settled, while still holding the lease.
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { runFile } from '../process'
import { readCheckoutBytes } from './client-fs'
import type { ChatEvent } from './protocol'

export interface MirrorLimits { maxFiles: number, maxFileBytes: number, maxTotalBytes: number }
const DEFAULT_LIMITS: MirrorLimits = { maxFiles: 20_000, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 }
interface Version { exists: boolean, signature: string, text?: string, reason?: string }
export interface CheckoutSnapshot {
  files: Map<string, Version>
  ignored: Set<string>
  inventoryComplete: boolean
  warnings: string[]
  startedAt: number
}
export interface ObservedChange { path: string, oldText: string, newText: string, oldExists: boolean, newExists: boolean }
const absent = (): Version => ({ exists: false, signature: 'absent', text: '' })

function allowedName(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || part === '.git')
}

// Regenerable interpreter caches are never revert-relevant: a turn that runs
// Python would otherwise report every rewritten cache as unrevertable.
function isGeneratedCache(path: string): boolean {
  const parts = path.split('/')
  return parts.includes('__pycache__') || (parts[parts.length - 1]?.endsWith('.pyc') ?? false)
}

async function inventory(checkout: string, ignored: boolean): Promise<string[]> {
  const args = ignored
    ? ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']
    : ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
  const result = await runFile('git', args, { cwd: checkout, timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 })
  return [...new Set(result.stdout.split('\0').filter(Boolean))].filter(allowedName).sort()
}

/** Ignored file names are inventoried but their contents are not copied.
 * Knowing an old ignored path existed prevents an ignore-rule change from
 * making it appear to be a newly created, safely deletable file. */
export async function captureCheckoutSnapshot(
  checkout: string,
  extraPaths: string[] = [],
  overrides: Partial<MirrorLimits> = {},
): Promise<CheckoutSnapshot> {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  const result: CheckoutSnapshot = { files: new Map(), ignored: new Set(), inventoryComplete: true, warnings: [], startedAt: Date.now() }
  let names: string[] = []
  try {
    const [visible, ignored] = await Promise.all([inventory(checkout, false), inventory(checkout, true)])
    names = [...new Set([...visible, ...extraPaths.filter(allowedName)])].filter(name => !isGeneratedCache(name)).sort()
    result.ignored = new Set(ignored)
  } catch (error) {
    result.inventoryComplete = false
    result.warnings.push(`checkout inventory failed: ${error instanceof Error ? error.message : String(error)}`)
    names = [...new Set(extraPaths.filter(allowedName))].filter(name => !isGeneratedCache(name)).sort()
  }
  if (names.length > limits.maxFiles) {
    result.inventoryComplete = false
    result.warnings.push(`checkout inventory exceeds ${limits.maxFiles} files`)
    names = names.slice(0, limits.maxFiles)
  }
  let budget = limits.maxTotalBytes
  for (const path of names) {
    let info
    try { info = await lstat(join(checkout, path)) }
    catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') { result.files.set(path, absent()); continue }
      result.files.set(path, { exists: true, signature: `unreadable:${error?.code}`, reason: 'metadata could not be read' })
      continue
    }
    const signature = `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    const unknown = (reason: string) => { result.files.set(path, { exists: true, signature, reason }) }
    // A nested repository or other directory is tracked by presence only, with
    // a stable marker: metadata churn inside it never warns, creation stays
    // quiet, and removal still reports as unrevertable when compared.
    if (info.isDirectory()) { result.files.set(path, { exists: true, signature: 'directory', reason: 'directory contents are not snapshotted' }); continue }
    // A symlink is tracked by its target: re-creating the same link stays
    // quiet, creation stays quiet, and removal or retarget still reports.
    if (info.isSymbolicLink()) {
      try {
        const target = await readlink(join(checkout, path))
        result.files.set(path, { exists: true, signature: `symlink:${createHash('sha256').update(target).digest('hex')}`, reason: 'not a regular non-symlink file' })
      } catch (error) { unknown(error instanceof Error ? error.message : String(error)) }
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) { unknown('not a regular non-symlink file'); continue }
    if (info.size > limits.maxFileBytes) { unknown(`file exceeds ${limits.maxFileBytes} bytes`); continue }
    if (info.size > budget) { unknown('turn snapshot byte budget exceeded'); continue }
    try {
      // Allocate/read at most this file's observed size; a concurrent growth
      // is refused, not silently truncated into a plausible pre-image.
      const { bytes } = await readCheckoutBytes(checkout, path, info.size)
      const after = await lstat(join(checkout, path))
      if (after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
        unknown('file changed while its snapshot was being read'); continue
      }
      budget -= bytes.length
      const hash = createHash('sha256').update(bytes).digest('hex')
      const text = bytes.toString('utf8')
      if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) {
        result.files.set(path, { exists: true, signature: `binary:${hash}`, reason: 'binary or non-UTF-8 file' })
      } else result.files.set(path, { exists: true, signature: hash, text })
    } catch (error) {
      unknown(error instanceof Error ? error.message : String(error))
    }
  }
  return result
}

function version(snapshot: CheckoutSnapshot, path: string): Version {
  const known = snapshot.files.get(path)
  if (known) return known
  if (snapshot.ignored.has(path)) return { exists: true, signature: 'ignored', reason: 'previously ignored file has no captured pre-image' }
  if (!snapshot.inventoryComplete) return { exists: true, signature: 'unknown', reason: 'incomplete checkout inventory' }
  return absent()
}

const isDirectoryVersion = (value: Version): boolean => value.exists && value.text === undefined && value.signature === 'directory'
const isSymlinkVersion = (value: Version): boolean => value.exists && value.text === undefined && value.signature.startsWith('symlink:')
const isBinaryVersion = (value: Version): boolean => value.exists && value.text === undefined && value.signature.startsWith('binary:')

export function compareCheckoutSnapshots(before: CheckoutSnapshot, after: CheckoutSnapshot): { changes: ObservedChange[], warnings: string[] } {
  const changes: ObservedChange[] = []
  const warnings = [...before.warnings, ...after.warnings]
  for (const path of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
    const old = version(before, path)
    const next = version(after, path)
    if (old.exists === next.exists && old.signature === next.signature) continue
    if (!old.exists && isDirectoryVersion(next)) continue
    if (isDirectoryVersion(old) && !next.exists) { warnings.push(`${path}: directory was removed`); continue }
    if (!isDirectoryVersion(old) && isDirectoryVersion(next)) { warnings.push(`${path}: replaced by a directory`); continue }
    if (!old.exists && isSymlinkVersion(next)) {
      if ([...before.files.keys()].some(key => key.startsWith(`${path}/`))) warnings.push(`${path}: replaced by a symlink`)
      continue
    }
    if (isSymlinkVersion(old) && !next.exists) { warnings.push(`${path}: symlink was removed`); continue }
    if (isSymlinkVersion(old) && isSymlinkVersion(next)) { warnings.push(`${path}: symlink target changed`); continue }
    if (old.exists && old.text !== undefined && isSymlinkVersion(next)) { warnings.push(`${path}: replaced by a symlink`); continue }
    // A binary file created during the turn reverts by deletion, like any
    // other new file, so its creation stays quiet; removal or modification
    // still warns because the lost bytes cannot be restored.
    if (!old.exists && isBinaryVersion(next) && ![...before.files.keys()].some(key => key.startsWith(`${path}/`))) continue
    if (old.text === undefined || next.text === undefined) {
      warnings.push(`${path}: ${old.reason || next.reason || 'a trustworthy before/after image is unavailable'}`)
      continue
    }
    if (old.exists === next.exists && old.text === next.text) continue
    changes.push({ path, oldText: old.text, newText: next.text, oldExists: old.exists, newExists: next.exists })
  }
  return { changes, warnings: [...new Set(warnings)] }
}

export async function emitCheckoutChanges(
  checkout: string,
  turnId: string,
  before: CheckoutSnapshot,
  emit: (event: ChatEvent) => void,
): Promise<void> {
  // Re-read earlier visible paths even if an agent changed ignore rules.
  const after = await captureCheckoutSnapshot(checkout, [...before.files.keys()])
  const { changes, warnings } = compareCheckoutSnapshots(before, after)
  if (changes.length) {
    const toolId = `poise:checkout-changes:${turnId}`
    emit({ type: 'tool.started', turnId, id: toolId, kind: 'edit', title: 'Checkout changes during this turn',
      locations: changes.map(change => ({ path: change.path })),
      input: { source: 'poise', scope: 'whole turn', note: 'Observed before/after state, including shell edits. This is not attribution to a single native tool.' } })
    for (const change of changes) emit({ type: 'diff', turnId, toolId, diffId: randomUUID(), ...change })
    emit({ type: 'tool.finished', turnId, id: toolId, status: 'completed', durationMs: Date.now() - before.startedAt })
  }
  if (warnings.length) emit({ type: 'error', recoverable: true,
    message: `Some checkout changes cannot be safely reverted from the turn snapshot: ${warnings.slice(0, 8).join('; ')}${warnings.length > 8 ? `; and ${warnings.length - 8} more` : ''}. Native tool records remain available.` })
}
