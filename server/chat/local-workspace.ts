// New Chat sessions use ignored Poise-owned storage. Its private Git
// repository is only a checkpoint mechanism; it never switches Poise itself.
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { db } from '../db'
import { CLAUDE_SUBSCRIPTION_CLI, runFile } from '../process'
import { isServiceMode, serviceStatePath } from '../service/config'
import { CheckoutLease, canonicalCheckout, type CheckoutLeaseOptions } from './checkout-lock'
import { runGuarded } from './git'
import { pgidAlive } from './worker'

export const POISE_ROOT = dirname(dirname(CLAUDE_SUBSCRIPTION_CLI))
const DEFAULT_LOCAL_CHAT_ROOT = join(POISE_ROOT, '.poise-chat')
// Immutable releases keep user data in the original installation's ignored
// workspace, selected by the trusted launcher, never a browser request. In
// service mode it lives in the home volume, outside the installed image.
export const LOCAL_CHAT_ROOT = process.env.POISE_CHAT_ROOT
  ? resolve(process.env.POISE_CHAT_ROOT)
  : isServiceMode() ? serviceStatePath('chat') : DEFAULT_LOCAL_CHAT_ROOT
const OWNER = 'Poise local Chat workspace v1\n'

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error: any) { if (error?.code !== 'EEXIST') throw error }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Chat storage is not a plain directory: ${path}`)
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`Chat storage belongs to another user: ${path}`)
}

// Creating another session should not wait for an existing coding turn just
// to rediscover a workspace that has already been initialized.
async function readyWorkspace(checkout: string): Promise<boolean> {
  try {
    const marker = join(checkout, '.poise-workspace-owner')
    const mark = await lstat(marker)
    const metadata = await lstat(join(checkout, '.git'))
    if (!mark.isFile() || mark.isSymbolicLink() || (await readFile(marker, 'utf8')) !== OWNER) throw new Error('Invalid local Chat ownership marker')
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Local Chat Git metadata must not be a link or worktree')
    const top = (await runFile('git', ['rev-parse', '--show-toplevel'], { cwd: checkout })).stdout.trim()
    if (canonicalCheckout(top) !== checkout) throw new Error('Local Chat storage must not use the enclosing Poise repository')
    return await runFile('git', ['rev-parse', '--verify', 'HEAD'], { cwd: checkout }).then(() => true, () => false)
  } catch (error: any) { if (error?.code === 'ENOENT') return false; throw error }
}

/** Storage inside the installation's own checkout must be ignored by it —
 *  the default root and every workspace under it. Any other root (service
 *  mode's, a release's, a test's) needs no checkout of Poise at all. */
export function needsIgnoreCheck(root: string): boolean {
  if (root === DEFAULT_LOCAL_CHAT_ROOT) return true
  const rel = relative(DEFAULT_LOCAL_CHAT_ROOT, root)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function ensureLocalWorkspace(root = LOCAL_CHAT_ROOT, instance = 'poise', heldLease?: CheckoutLease): Promise<string> {
  // Only the installation's own default storage must be ignored by its
  // checkout; any other root (service mode's, a release's) needs no checkout
  // of Poise at all.
  if (needsIgnoreCheck(root)) {
    await runFile('git', ['check-ignore', '--quiet', '--no-index', '.poise-chat/workspace'], { cwd: POISE_ROOT })
      .catch(() => { throw new Error('Poise must ignore /.poise-chat/ before local Chat storage can be created') })
  }
  await privateDirectory(root)
  const workspace = join(root, 'workspace')
  await privateDirectory(workspace)
  const checkout = canonicalCheckout(workspace)
  if (heldLease && (!heldLease.held || heldLease.canonical !== checkout)) throw new Error('Initializing Chat storage requires its held checkout lease')
  if (await readyWorkspace(checkout)) return checkout
  const lease = heldLease ?? new CheckoutLease(checkout, { ownerKind: 'poise:chat', ownerId: 'local-workspace-init', ownerLabel: 'Preparing local Chat storage', instance })
  if (!heldLease) await lease.acquire({ signal: AbortSignal.timeout(15_000) })
  try {
    const marker = join(checkout, '.poise-workspace-owner')
    let owned = false
    try {
      const info = await lstat(marker)
      owned = info.isFile() && !info.isSymbolicLink() && (await readFile(marker, 'utf8')) === OWNER
      if (!owned) throw new Error('The local Chat workspace has an invalid ownership marker')
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    if (!owned) {
      if ((await readdir(checkout)).length) throw new Error('Refusing to adopt an existing non-empty directory as Chat storage')
      await writeFile(marker, OWNER, { flag: 'wx', mode: 0o600 })
    }
    const metadata = join(checkout, '.git')
    let initialized = false
    try {
      const info = await lstat(metadata)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local Chat Git metadata must be a private directory, not a link or worktree')
      initialized = true
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    const git = async (args: string[]) => {
      const result = await runGuarded(lease, 'git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: checkout })
      if (result.code !== 0) throw new Error(`Preparing local Chat storage failed: ${result.stderr.slice(0, 1000)}`)
      return result.stdout.trim()
    }
    if (!initialized) await git(['init', '--quiet', '--initial-branch=main', '--template=', checkout])
    const top = (await runFile('git', ['rev-parse', '--show-toplevel'], { cwd: checkout })).stdout.trim()
    if (canonicalCheckout(top) !== checkout) throw new Error('Local Chat storage must not use the enclosing Poise repository')
    const hasHead = await runFile('git', ['rev-parse', '--verify', 'HEAD'], { cwd: checkout }).then(() => true, () => false)
    if (!hasHead) {
      await git(['config', 'user.name', 'Poise local Chat'])
      await git(['config', 'user.email', 'poise-chat@example.invalid'])
      await git(['config', 'commit.gpgSign', 'false'])
      await git(['config', 'core.hooksPath', '/dev/null'])
      await mkdir(join(metadata, 'info'), { recursive: true, mode: 0o700 })
      await writeFile(join(metadata, 'info', 'exclude'), '.poise-workspace-owner\n.poise-chat/\n', { mode: 0o600 })
      await git(['commit', '--quiet', '--allow-empty', '--no-gpg-sign', '-m', 'Initialize private Chat workspace'])
    }
    return checkout
  } finally {
    if (!heldLease && lease.held) {
      const row = lease.read()
      // A bootstrap command that did not settle still owns the workspace.
      // Releasing here would defeat runGuarded's retained worker record.
      if (!(row?.token === lease.currentToken && row.worker_pgid && pgidAlive(row.worker_pgid))) lease.release()
    }
  }
}

/** Only plain private directories may precede canonical lease construction.
 *  Ownership markers and Git initialization are written under that lease. */
export async function ensureWorkerWorkspaceDirectory(root: string, id: string): Promise<string> {
  if (!WORKSPACE_ID.test(id)) throw new Error('Invalid worker workspace ID')
  await privateDirectory(root)
  const workers = join(root, 'workers')
  await privateDirectory(workers)
  const home = join(workers, id)
  await privateDirectory(home)
  const workspace = join(home, 'workspace')
  await privateDirectory(workspace)
  return canonicalCheckout(workspace)
}

/** Validate every managed parent before using the private workspace initializer. */
export async function ensureWorkerWorkspace(root: string, id: string, instance: string, heldLease?: CheckoutLease): Promise<string> {
  await ensureWorkerWorkspaceDirectory(root, id)
  return ensureLocalWorkspace(join(root, 'workers', id), instance, heldLease)
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True only for a directory Poise itself initialized as Chat storage. A
 *  missing or foreign marker fails safe: the directory is kept, never
 *  removed. */
export async function workspaceMarkerValid(checkout: string): Promise<boolean> {
  try {
    const marker = join(checkout, '.poise-workspace-owner')
    const info = await lstat(marker)
    return info.isFile() && !info.isSymbolicLink() && (await readFile(marker, 'utf8')) === OWNER
  } catch {
    return false
  }
}

/** When `checkout` is exactly one `workers/<id>/workspace` directory under
 *  `root`, its id and parent directory (for best-effort cleanup of the
 *  emptied parent). Anything else — the legacy shared workspace, a
 *  repository checkout, another root — is not ours to remove. */
export function workerWorkspaceRef(root: string, checkout: string): { id: string, home: string } | null {
  if (basename(checkout) !== 'workspace') return null
  const id = basename(dirname(checkout))
  if (!WORKSPACE_ID.test(id)) return null
  const workers = dirname(dirname(checkout))
  if (basename(workers) !== 'workers') return null
  try {
    if (canonicalCheckout(dirname(workers)) !== canonicalCheckout(root)) return null
  } catch {
    return null
  }
  return { id, home: dirname(checkout) }
}

/** Under the checkout's lease, taken without waiting: remove a workers/<id>/workspace that no session row claims and that carries Poise's owner marker. Anything else is kept. Lock files are never touched. */
export async function discardUnclaimedWorkspace(root: string, checkout: string, instance: string, probes?: CheckoutLeaseOptions): Promise<'removed' | 'kept'> {
  const ref = workerWorkspaceRef(root, checkout)
  if (!ref) {
    console.log(`[chat] kept unclaimed workspace ${checkout}: not a workers/<id>/workspace directory; remove it by hand`)
    return 'kept'
  }
  let canonical: string
  try {
    canonical = canonicalCheckout(checkout)
  } catch (error) {
    console.log(`[chat] kept unclaimed workspace ${checkout}: ${error instanceof Error ? error.message : String(error)}; remove it by hand`)
    return 'kept'
  }
  const lease = new CheckoutLease(canonical, {
    ownerKind: 'poise:chat',
    ownerId: `discard:${ref.id}`,
    ownerLabel: `Discarding unclaimed workspace ${ref.id}`,
    instance,
  }, probes)
  if (!lease.tryAcquire().acquired) {
    console.log(`[chat] kept unclaimed workspace ${canonical}: the checkout lease is busy; remove it by hand`)
    return 'kept'
  }
  try {
    if (!(await workspaceMarkerValid(canonical))) {
      console.log(`[chat] kept unclaimed workspace ${canonical}: invalid or missing owner marker; remove it by hand`)
      return 'kept'
    }
    const claimed = db.prepare('SELECT id FROM chat_sessions WHERE checkout = ? LIMIT 1').get(canonical) as { id: string } | undefined
    if (claimed) {
      console.log(`[chat] kept unclaimed workspace ${canonical}: a session row still claims it; remove it by hand`)
      return 'kept'
    }
    try {
      await rm(ref.home, { recursive: true, force: true })
    } catch (error) {
      console.log(`[chat] kept unclaimed workspace ${canonical}: ${error instanceof Error ? error.message : String(error)}; remove it by hand`)
      return 'kept'
    }
    return 'removed'
  } finally {
    if (lease.held) lease.release()
  }
}
