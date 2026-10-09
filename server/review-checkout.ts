import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, rename, rm, utimes } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { runFile } from './process'
import { withProcessLock } from './process-lock'

// Each head's checkouts are removed a day after a review last resolved them.
// Caller bounds every review's time and a retry follows within the hour, so
// a review of a head is over long before; a later one provisions it again.
export const REVIEW_CHECKOUT_RETENTION_MS = 24 * 60 * 60_000
const PRUNE_INTERVAL_MS = 60 * 60_000
const HEAD_PATTERN = /^[0-9a-f]{40}$/
const REMOVING_PREFIX = '.removing-'
// A review marks its head used, and a prune judges and moves a head away,
// only while holding this lock in review-checkouts.
const MARK_LOCK = '.lock'
let pruneTimer: ReturnType<typeof setInterval> | null = null
let pruning: Promise<unknown> | null = null

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown })?.code
}

/**
 * Removes the checkouts of every head no review has resolved for
 * REVIEW_CHECKOUT_RETENTION_MS, and returns those heads. A head is renamed
 * out of reach before it is deleted, so a review resolving it afterwards
 * provisions it anew rather than finding it half removed.
 */
export async function pruneReviewCheckouts(root: string, now = Date.now()): Promise<string[]> {
  const checkouts = join(root, 'review-checkouts')
  let entries: Dirent[]
  try {
    entries = await readdir(checkouts, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(checkouts, entry.name)
    try {
      if (entry.name.startsWith(REMOVING_PREFIX)) {
        // An earlier prune stopped before it finished.
        await rm(path, { recursive: true, force: true })
        continue
      }
      if (!HEAD_PATTERN.test(entry.name)) continue
      // Resolving a head sets its directory's time; see resolveReviewCheckout.
      if (now - (await lstat(path)).mtimeMs < REVIEW_CHECKOUT_RETENTION_MS) continue
      const doomed = join(checkouts, `${REMOVING_PREFIX}${entry.name}-${randomUUID()}`)
      // Judged again under the lock a review marks its head under: a review
      // either marked it first, and it stays, or finds it gone and provisions
      // it anew.
      const moved = await withProcessLock({ path: join(checkouts, MARK_LOCK) }, async () => {
        try {
          if (now - (await lstat(path)).mtimeMs < REVIEW_CHECKOUT_RETENTION_MS) return false
          await rename(path, doomed)
          return true
        } catch (error) {
          // Another prune took it first.
          if (errorCode(error) === 'ENOENT') return false
          throw error
        }
      })
      if (!moved) continue
      await rm(doomed, { recursive: true, force: true })
      removed.push(entry.name)
    } catch (error) {
      console.error(`[review-checkout] could not remove ${path}:`, (error as Error).message)
    }
  }
  return removed
}

/** Where Poise keeps its state: beside POISE_DB, or in ~/.poise. */
function poiseRoot(): string {
  return process.env.POISE_DB && process.env.POISE_DB !== ':memory:'
    ? dirname(resolve(process.env.POISE_DB)) : join(homedir(), '.poise')
}

/**
 * Prunes review checkouts now and every hour while Poise runs, whether or not
 * reviews do, one prune at a time and in the background.
 */
export function startReviewCheckoutPruning(intervalMs = PRUNE_INTERVAL_MS): void {
  if (pruneTimer) return
  const run = () => {
    if (pruning) return
    pruning = pruneReviewCheckouts(poiseRoot())
      .catch((error: unknown) => console.error('[review-checkout] prune failed:', (error as Error).message))
      .finally(() => { pruning = null })
  }
  run()
  pruneTimer = setInterval(run, intervalMs)
  pruneTimer.unref()
}

/** Stops pruning, once a prune under way has finished. */
export async function stopReviewCheckoutPruning(): Promise<void> {
  if (pruneTimer) clearInterval(pruneTimer)
  pruneTimer = null
  await pruning
}

export async function resolveReviewCheckout(
  owner: string, repo: string, number: number, actor: string, head: string, signal?: AbortSignal,
): Promise<string> {
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..'
    || !/^[A-Za-z0-9-]+$/.test(actor) || !Number.isSafeInteger(number) || number < 1
    || !/^[0-9a-f]{40}$/.test(head)) throw new Error('Invalid review repository, actor or head')
  try {
    const { stdout } = await runFile('github-interface', ['--local-checkout-path', owner, repo], {
      signal, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
    })
    const result = JSON.parse(stdout) as { action?: unknown, repository?: unknown, path?: unknown }
    if (result?.action !== 'local_checkout_path' || result.repository !== `${owner}/${repo}`
      || typeof result.path !== 'string' || !isAbsolute(result.path)) {
      throw new Error('github-interface --local-checkout-path returned malformed state')
    }
    return result.path
  } catch (error) {
    // Only the CLI's specific absence error permits provisioning. A denied
    // credential, timeout or malformed reply must still fail closed.
    const failure = error as { code?: unknown, stderr?: unknown }
    if (failure?.code !== 1 || typeof failure.stderr !== 'string'
      || !failure.stderr.trim().endsWith(`: ${owner}/${repo}`)
      || !failure.stderr.trim().startsWith('error: checkout not found under ')) throw error
  }
  const root = poiseRoot()
  const headDirectory = join(root, 'review-checkouts', head)
  const base = join(headDirectory, owner.toLowerCase())
  const path = join(base, repo.toLowerCase())
  const remote = `https://github.com/${owner}/${repo}.git`
  // Marks the head used, so its checkouts stay for a day after this review;
  // see pruneReviewCheckouts.
  await withProcessLock({ path: join(root, 'review-checkouts', MARK_LOCK) }, async () => {
    await mkdir(base, { recursive: true })
    const used = new Date()
    await utimes(headDirectory, used, used)
  })
  const verify = async (cwd: string): Promise<void> => {
    const origin = await runFile('git', ['remote', 'get-url', 'origin'], { cwd, signal, timeoutMs: 5_000 })
    const commit = await runFile('git', ['rev-parse', 'HEAD'], { cwd, signal, timeoutMs: 5_000 })
    const status = await runFile('git', ['status', '--porcelain'], { cwd, signal, timeoutMs: 5_000 })
    if (origin.stdout.trim().toLowerCase() !== remote.toLowerCase()
      || commit.stdout.trim() !== head || status.stdout.trim()) throw new Error('Managed review checkout differs from the expected repository/head or has local changes')
  }
  return withProcessLock({ path: `${path}.lock`, timeoutMs: 10_000 }, async () => {
    signal?.throwIfAborted()
    let exists = false
    try {
      const metadata = await lstat(path)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Managed review checkout is not a directory')
      exists = true
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
    if (exists) { await verify(path); return path }
    const temporary = await mkdtemp(join(base, '.staging-'))
    const checkout = join(temporary, owner, repo)
    try {
      await mkdir(dirname(checkout), { recursive: true, mode: 0o700 })
      // Provisioned as the reviewer, who must be able to read the repository.
      const { stdout } = await runFile('github-interface', ['--checkout-repo', `${owner}/${repo}`, '--path', checkout, '--token-user', actor], {
        signal, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
      })
      const result = JSON.parse(stdout) as { action?: unknown, repository?: unknown, path?: unknown }
      if (result?.action !== 'checkout_repo' || result.repository !== `${owner}/${repo}`
        || result.path !== checkout) throw new Error('github-interface --checkout-repo returned malformed state')
      // Caller owns network/authentication. Pin locally using only the history
      // Caller fetched; a fork commit absent from that history fails closed.
      await runFile('git', ['checkout', '--quiet', '--detach', head], { cwd: checkout, signal, timeoutMs: 5_000 })
      await verify(checkout)
      signal?.throwIfAborted()
      await rename(checkout, path)
      return path
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
}
