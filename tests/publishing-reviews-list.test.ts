import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({ started: [] as string[], release: () => {} }))
vi.mock('../server/editor', async (original) => ({
  ...(await original<typeof import('../server/editor')>()),
  listDocs: async () => [{ slug: 'first' }, { slug: 'second' }, { slug: 'third' }],
  readPublishLedger: async (slug: string) => {
    ledger.started.push(slug)
    await new Promise<void>((resolve) => { const before = ledger.release; ledger.release = () => { before(); resolve() } })
    return { records: [] }
  },
}))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-reviews-list-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  ledger.started = []
  ledger.release = () => {}
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('reads every document’s publish ledger at once, not one after another', async () => {
  const { listPublicationReviews } = await import('../server/publishing-reviews')
  const list = listPublicationReviews()
  await vi.waitFor(() => expect(ledger.started).toEqual(['first', 'second', 'third']))
  ledger.release()
  expect((await list).publications).toEqual([])
})
