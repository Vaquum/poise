import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

// The behavior ledger's claims, leases and seen targets are written and read
// per target on every pass: their statements compile once per connection,
// not on each call.
let root = ''
let database: typeof import('../server/db')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-db-statements-'))
  process.env.POISE_DB = join(root, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
})

afterAll(async () => {
  if (database?.db.open) database.closeDatabase()
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

function pass(round: number): void {
  const claim = database.claimPrOperationOwned(`acme/repo#${round}`, 60_000)
  expect(claim).not.toBeNull()
  expect(database.renewPrOperationOwned(claim!, 60_000)).toBe(true)
  expect(database.releasePrOperationOwned(claim!)).toBe(true)
  const seen = database.claimSeenOwned('review-new-prs', `acme/repo#${round}`)
  expect(seen).not.toBeNull()
  expect(database.renewSeenOwned('review-new-prs', `acme/repo#${round}`, seen!)).toBe(true)
  expect(database.hasSeen('review-new-prs', `acme/repo#${round}`)).toBe(true)
  expect(database.listSeenTargets('review-new-prs')).toContain(`acme/repo#${round}`)
  database.setMeta('behavior_review_new_prs_enabled', String(round))
}

it('claims, renews and releases again without compiling a statement', () => {
  pass(1)
  const prepare = vi.spyOn(database.db, 'prepare')
  let compiled: string[] = []
  try {
    pass(2)
  } finally {
    // Read before restoring: restoring a spy clears its calls.
    compiled = prepare.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim().slice(0, 60))
    prepare.mockRestore()
  }
  expect(compiled).toEqual([])
})
