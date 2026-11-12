import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({ started: [] as string[], release: () => {}, docs: ['first', 'second', 'third'] }))
vi.mock('../server/editor', async (original) => ({
  ...(await original<typeof import('../server/editor')>()),
  listDocs: async () => ledger.docs.map((slug) => ({ slug })),
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
  ledger.docs = ['first', 'second', 'third']
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

it('keeps at most sixteen ledgers open at once, however many documents there are', async () => {
  ledger.docs = Array.from({ length: 20 }, (_, index) => `doc-${index}`)
  const { listPublicationReviews } = await import('../server/publishing-reviews')
  const list = listPublicationReviews()
  await vi.waitFor(() => expect(ledger.started).toHaveLength(16))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(ledger.started).toHaveLength(16)
  ledger.release()
  await vi.waitFor(() => expect(ledger.started).toHaveLength(20))
  ledger.release()
  expect((await list).publications).toEqual([])
})
