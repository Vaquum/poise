// The commit this Poise runs, and since when: the first line of the menu
// (src/menu.ts). "Since" is the first start on that commit, kept in cache.db,
// so a restart on the same commit leaves it where it was.

import { BUILD_SHA } from './build-identity'
import { getMeta, setMeta } from './db'

const KEY = 'running_release'

/** The repository Poise's releases come from, unless POISE_RELEASE_REPO names a fork's. */
export const DEFAULT_RELEASE_REPO = 'autonomio/poise'
const RELEASE_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/

/** The release source the menu attributes this Poise to: the override when
 *  set, else the official repository. A malformed override fails the release
 *  endpoint naming it rather than linking nowhere. */
export function releaseRepo(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.POISE_RELEASE_REPO?.trim()
  if (!configured) return DEFAULT_RELEASE_REPO
  if (!RELEASE_REPO.test(configured)) throw new Error(`POISE_RELEASE_REPO must be a GitHub repository like owner/name; got "${configured}"`)
  return configured
}

export interface RunningRelease {
  /** The source commit of the running bundle; null for a build without one. */
  commit: string | null
  /** When this Poise first ran that commit; null when it is not known. */
  since: string | null
  /** The repository the commit belongs to, for the menu's link and label. */
  repo: string
}

function stored(): Pick<RunningRelease, 'commit' | 'since'> | null {
  const raw = getMeta(KEY)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<RunningRelease>
    return typeof value.commit === 'string' && typeof value.since === 'string' && Number.isFinite(Date.parse(value.since))
      ? { commit: value.commit, since: value.since }
      : null
  } catch {
    return null
  }
}

/** Records that this Poise runs `commit`, unless it already ran it. */
export function recordRunningRelease(commit: string | null = BUILD_SHA, now = Date.now()): void {
  if (!commit || stored()?.commit === commit) return
  setMeta(KEY, JSON.stringify({ commit, since: new Date(now).toISOString() }))
}

export function runningRelease(commit: string | null = BUILD_SHA): RunningRelease {
  if (!commit) return { commit: null, since: null, repo: releaseRepo() }
  const record = stored()
  return { commit, since: record?.commit === commit ? record.since : null, repo: releaseRepo() }
}
