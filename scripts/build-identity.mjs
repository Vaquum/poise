import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Embed source identity at build time, never infer it from a running checkout.
 * An uncommitted development build has no releasable SHA. Release builds fail
 * rather than stamping different or dirty bytes with a requested identity.
 * A build without .git, such as the workspace image's (its context leaves
 * .git out), is identified only by the commit its builder declares in
 * POISE_SOURCE_SHA; deploy/install.sh and deploy/upgrade.sh declare it for a
 * clean checkout. A declaration never satisfies a release build and never
 * overrides what a checkout says about itself. */
export function buildSourceSha(root = process.cwd(), expected = process.env.POISE_RELEASE_SHA, declared = process.env.POISE_SOURCE_SHA) {
  if (!existsSync(join(root, '.git'))) {
    if (expected) throw new Error('Release build requires a clean checkout at the exact requested SHA')
    if (!declared) return null
    if (!/^[0-9a-f]{40}$/.test(declared)) throw new Error(`POISE_SOURCE_SHA must be a full 40-character commit SHA; got "${declared}"`)
    return declared
  }
  let sha = null
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const head = git('rev-parse', '--verify', 'HEAD')
    if (/^[0-9a-f]{40}$/.test(head) && !git('status', '--porcelain', '--untracked-files=normal')) sha = head
  } catch { /* Source archives and development builds are not releases. */ }
  if (expected && (!/^[0-9a-f]{40}$/.test(expected) || sha !== expected)) {
    throw new Error('Release build requires a clean checkout at the exact requested SHA')
  }
  return sha
}
