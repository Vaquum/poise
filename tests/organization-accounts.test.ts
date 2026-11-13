import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

// Reading a behavior preference needs only which accounts exist and whether
// each is managed; organizationAccounts answers that without building each
// account's status, and must list exactly what getOrganizations lists.
let root = ''
let database: typeof import('../server/db')
let organizations: typeof import('../server/organizations')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-organization-accounts-'))
  process.env.POISE_DB = join(root, 'cache.db')
  vi.resetModules()
  // Count meta reads, to pin how many an account listing makes.
  vi.doMock('../server/db', async (original) => {
    const actual = await original<typeof import('../server/db')>()
    return { ...actual, getMeta: vi.fn(actual.getMeta) }
  })
  database = await import('../server/db')
  organizations = await import('../server/organizations')
})

afterAll(async () => {
  if (database?.db.open) database.closeDatabase()
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

const listed = () => organizations.getOrganizations().map(({ login, managed }) => ({ login, managed }))

it('lists the accounts in the order and with the legacy account getOrganizations has', () => {
  expect(organizations.organizationAccounts()).toEqual([])
  database.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage)
    VALUES ('alpha', '/alpha.sqlite', 1, 'ready', 'ready'), ('Beta', '/beta.sqlite', 1, 'error', 'failed')`).run()
  database.setMeta('me', 'someone-else')
  expect(organizations.organizationAccounts()).toEqual([{ login: 'alpha', managed: true }, { login: 'Beta', managed: true }])
  expect(organizations.organizationAccounts()).toEqual(listed())

  database.setMeta('org', ' legacy ')
  expect(organizations.organizationAccounts()).toEqual([
    { login: 'legacy', managed: false }, { login: 'alpha', managed: true }, { login: 'Beta', managed: true },
  ])
  expect(organizations.organizationAccounts()).toEqual(listed())

  // A legacy login that is already a followed account is listed once, as that account.
  database.setMeta('org', 'BETA')
  expect(organizations.organizationAccounts()).toEqual([{ login: 'alpha', managed: true }, { login: 'Beta', managed: true }])
  expect(organizations.organizationAccounts()).toEqual(listed())
})

it('reads the user and its rate-limit cooldown once per listing, however many accounts it has', () => {
  database.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage)
    VALUES ('gamma', '/gamma.sqlite', 1, 'ready', 'ready'), ('delta', '/delta.sqlite', 1, 'ready', 'ready')`).run()
  const reads = vi.mocked(database.getMeta)
  reads.mockClear()
  expect(organizations.getOrganizations()).toHaveLength(4)
  // The user, its cooldown and the legacy account: three reads for four accounts.
  expect(reads.mock.calls.map(([key]) => key).sort()).toEqual(['github_rate_limit:someone-else:reset_at', 'me', 'org'])
})
