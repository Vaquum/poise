import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The commit this Poise runs and since when (server/running-release.ts),
// which the menu's first line shows.

let root = ''
let database: typeof import('../server/db')
let release: typeof import('../server/running-release')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-running-release-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  database = await import('../server/db')
  release = await import('../server/running-release')
})

beforeEach(() => {
  database.db.prepare("DELETE FROM meta WHERE key = 'running_release'").run()
})

afterAll(async () => {
  database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const at = (iso: string) => Date.parse(iso)

describe('the running release', () => {
  it('is since the first start on its commit, whatever restarts follow', () => {
    release.recordRunningRelease(A, at('2026-10-09T18:40:00Z'))
    release.recordRunningRelease(A, at('2026-10-09T20:15:00Z'))
    expect(release.runningRelease(A)).toEqual({ commit: A, since: '2026-10-09T18:40:00.000Z', repo: 'autonomio/poise' })
  })

  it('starts over with a new commit', () => {
    release.recordRunningRelease(A, at('2026-10-09T18:40:00Z'))
    release.recordRunningRelease(B, at('2026-10-09T19:05:00Z'))
    expect(release.runningRelease(B)).toEqual({ commit: B, since: '2026-10-09T19:05:00.000Z', repo: 'autonomio/poise' })
  })

  it('knows no time for a commit it has no record of', () => {
    release.recordRunningRelease(A, at('2026-10-09T18:40:00Z'))
    expect(release.runningRelease(B)).toEqual({ commit: B, since: null, repo: 'autonomio/poise' })
    database.setMeta('running_release', '{not json')
    expect(release.runningRelease(A)).toEqual({ commit: A, since: null, repo: 'autonomio/poise' })
  })

  it('records and shows nothing for a build without a commit', () => {
    release.recordRunningRelease(null, at('2026-10-09T18:40:00Z'))
    expect(database.getMeta('running_release')).toBeNull()
    expect(release.runningRelease(null)).toEqual({ commit: null, since: null, repo: 'autonomio/poise' })
  })
})

describe('the release source', () => {
  it('is the official repository unless POISE_RELEASE_REPO names a fork', () => {
    expect(release.releaseRepo({})).toBe('autonomio/poise')
    expect(release.releaseRepo({ POISE_RELEASE_REPO: '  ' })).toBe('autonomio/poise')
    expect(release.releaseRepo({ POISE_RELEASE_REPO: ' fork/poise ' })).toBe('fork/poise')
  })

  it('refuses a malformed override, naming it', () => {
    for (const value of ['not a repo', 'a/b/c', '/leading', 'trailing/', 'a/']) {
      expect(() => release.releaseRepo({ POISE_RELEASE_REPO: value }))
        .toThrow(`POISE_RELEASE_REPO must be a GitHub repository like owner/name; got "${value}"`)
    }
  })
})
