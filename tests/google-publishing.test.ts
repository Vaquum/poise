import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ accounts: vi.fn(), settings: vi.fn(), disconnect: vi.fn(), connection: vi.fn(), read: vi.fn(), create: vi.fn(), update: vi.fn(), id: vi.fn() }))
vi.mock('../server/google/accounts', async original => ({ ...(await original<typeof import('../server/google/accounts')>()), googleAccounts: mocks.accounts, googleAccountSettings: mocks.settings, disconnectGoogle: mocks.disconnect, googleConnectionVersion: mocks.connection }))
vi.mock('../server/google/drive', () => ({ readGoogleFile: mocks.read, createGoogleFile: mocks.create, updateGoogleFile: mocks.update, googleFileId: mocks.id }))
vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, open: vi.fn(actual.open) } })
let root: string, server: Server, base: string
let db: typeof import('../server/db'), editor: typeof import('../server/editor')
const previous = new Map<string, string | undefined>()
let raw: string | null, etag: string
const fileId = 'google-file-one', slug = 'draft'
const body = '# A draft\n\nThe silver owl circles the tower.\n'
async function call(action = '', input?: unknown) {
  const response = await fetch(`${base}/api/editor/doc/${slug}/google${action ? '/' + action : ''}`, input === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  return { status: response.status, body: await response.json() }
}
beforeEach(async () => {
  vi.resetModules(); root = await mkdtemp(join(tmpdir(), 'google-publishing-'))
  for (const key of ['POISE_DB', 'POISE_EDITOR_DIR']) previous.set(key, process.env[key])
  process.env.POISE_DB = join(root, 'cache.db'); process.env.POISE_EDITOR_DIR = join(root, 'editor')
  db = await import('../server/db'); editor = await import('../server/editor'); const api = await import('../server/google/api')
  const { HttpError } = await import('../server/http')
  await editor.writeDoc(slug, body); raw = null; etag = '"revision-one"'
  mocks.accounts.mockReturnValue([{ id: 'one', email: 'one@example.com', connected: true }, { id: 'two', email: 'two@example.com', connected: true }])
  mocks.disconnect.mockReset(); mocks.settings.mockReturnValue({ configured: true, accounts: mocks.accounts() })
  mocks.id.mockResolvedValue(fileId); mocks.connection.mockReturnValue('connection-one')
  mocks.read.mockReset().mockImplementation(async () => { if (raw === null) throw new HttpError(404, 'missing'); return { raw, etag, file: { id: fileId, name: 'A draft.md', mimeType: 'text/markdown' } } })
  mocks.create.mockReset().mockImplementation(async (_account, _id, _title, text: string) => { raw = text })
  mocks.update.mockReset().mockImplementation(async (_account, _id, text: string, expected: string) => { if (expected !== etag) throw new HttpError(409, 'Google changed'); raw = text })
  server = createServer((req, res) => { void api.handleGoogleApi(req, res, req.url!).then(handled => { if (!handled) { res.statusCode = 404; res.end('{}') } }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('not bound'); base = `http://127.0.0.1:${address.port}`
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.closeDatabase(); for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v } await rm(root, { recursive: true, force: true }) })
const publish = async (id = 'one') => call('publish', { accountId: id, localVersion: (await editor.readDoc(slug)).version })

describe('Google document publication and reviewed import', () => {
  it('records an account-specific file and updates it in place under its remote precondition', async () => {
    expect((await publish()).status).toBe(200)
    expect(mocks.create).toHaveBeenCalledWith('one', fileId, 'A draft.md', body)
    await editor.writeDoc(slug, body + '\nNew paragraph.')
    expect((await publish()).status).toBe(200)
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith('one', fileId, body + '\nNew paragraph.', etag)
    expect((await editor.readGoogleLedger(slug))[0].accountId).toBe('one')
  })
  it('blocks an unseen remote change and stale local publishing', async () => {
    await publish(); raw = body + '\nGoogle edit.'
    expect((await publish()).status).toBe(409)
    expect(mocks.update).not.toHaveBeenCalled()
    expect((await call('publish', { accountId: 'one', localVersion: 'a'.repeat(64) })).status).toBe(409)
  })
  it('shows Google native comments but does not import remote changes during synchronization', async () => {
    await publish(); raw = body.replace('The silver owl', '<!-- gdoc_comment_begin: c1 -->The silver owl<!-- gdoc_comment_end: c1 -->') + '\n---\ngdoc_comments:\n  c1:\n    status: ACTIVE\n    token: private-opaque-comment\n    head:\n      author: Reviewer\n      body: Clarify this.\n---\n'
    const synced = await call('sync', {})
    expect(synced.status).toBe(200); expect(synced.body.publications[0].comments[0].body).toBe('Clarify this.')
    expect(JSON.stringify(synced.body)).not.toContain('private-opaque-comment')
    expect((await editor.readDoc(slug)).content).toBe(body)
    await editor.writeDoc(slug, '# New title\n\nThe silver owl circles the tower.\n')
    expect((await publish()).status).toBe(200)
    expect(raw).toContain('gdoc_comments:'); expect(raw).toContain('gdoc_comment_begin: c1')
  })
  it('reports unread remote state as unknown rather than claiming it matches', async () => {
    await publish(); mocks.read.mockRejectedValueOnce(new Error('Google unavailable'))
    const result = await call('sync', {})
    expect(result.status).toBe(200)
    expect(result.body.publications[0]).toMatchObject({ remoteChanged: null, problem: 'Google unavailable' })
  })
  it('requires the reviewed local and remote versions and keeps a recoverable pre-import file', async () => {
    await publish(); raw = body + '\nGoogle edit.'
    const review = await call('review', { accountId: 'one' })
    expect(review.body.remoteText).toContain('Google edit.')
    const imported = await call('import', { accountId: 'one', localVersion: review.body.localVersion, remoteSha: review.body.remoteSha, fileId, connectionVersion: review.body.connectionVersion })
    expect(imported.status).toBe(200); expect((await editor.readDoc(slug)).content).toBe(raw)
    const folder = join(root, 'editor', '.google-history', slug), names = await readdir(folder)
    expect(await readFile(join(folder, names[0]), 'utf8')).toBe(body)
    expect((await editor.readGoogleLedger(slug))[0].sourceSha).toBe((await editor.readDoc(slug)).version)
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('rejects changes made after review on either side', async () => {
    await publish(); raw = body + '\nRemote edit.'
    const review = (await call('review', { accountId: 'one' })).body
    await editor.writeDoc(slug, body + '\nLocal edit.')
    expect((await call('import', { accountId: 'one', localVersion: review.localVersion, remoteSha: review.remoteSha, fileId, connectionVersion: review.connectionVersion })).status).toBe(409)
    raw += '\nNewer remote edit.'
    expect((await call('import', { accountId: 'one', localVersion: (await editor.readDoc(slug)).version, remoteSha: review.remoteSha, fileId, connectionVersion: review.connectionVersion })).status).toBe(409)
    expect((await editor.readDoc(slug)).content).toContain('Local edit.')
  })
  it('permits a reviewed Poise overwrite only for the exact remote version that was shown', async () => {
    await publish(); raw = body + '\nRemote edit.'
    const reviewed = (await call('review', { accountId: 'one' })).body
    expect((await call('publish', { accountId: 'one', localVersion: reviewed.localVersion, reviewedRemoteSha: 'stale', fileId, connectionVersion: reviewed.connectionVersion })).status).toBe(409)
    expect(mocks.update).not.toHaveBeenCalled()
    expect((await call('publish', { accountId: 'one', localVersion: reviewed.localVersion, reviewedRemoteSha: reviewed.remoteSha, fileId, connectionVersion: reviewed.connectionVersion })).status).toBe(200)
    expect(raw).toBe(body)
  })
  it('retains the reserved ID after uncertain creation rather than generating duplicate documents', async () => {
    mocks.create.mockImplementationOnce(async (_a, _id, _name, content: string) => { raw = content; throw new Error('connection lost') })
    expect((await publish()).status).toBe(500)
    expect((await editor.readGoogleLedger(slug))[0].pending).toBe(true)
    expect((await publish()).status).toBe(200)
    expect(mocks.id).toHaveBeenCalledTimes(1); expect(mocks.create).toHaveBeenCalledTimes(1)
  })
  it('allows exact reviewed recovery when an uncertain create was subsequently edited in Google', async () => {
    mocks.create.mockImplementationOnce(async (_a, _id, _name, content: string) => { raw = content; throw new Error('connection lost') })
    expect((await publish()).status).toBe(500)
    raw = body + '\nGoogle edit after uncertain creation.'
    expect((await publish()).status).toBe(409)
    const reviewed = (await call('review', { accountId: 'one' })).body
    const approved = { accountId: 'one', localVersion: reviewed.localVersion, reviewedRemoteSha: reviewed.remoteSha, fileId, connectionVersion: reviewed.connectionVersion }
    raw += '\nNewer Google edit.'
    expect((await call('publish', approved)).status).toBe(409)
    expect(mocks.update).not.toHaveBeenCalled()
    raw = reviewed.remoteText
    expect((await call('publish', approved)).status).toBe(200)
    expect(raw).toBe(body)
    expect((await editor.readGoogleLedger(slug))[0].pending).toBe(false)
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })
  it('keeps account bindings independent and deletes local bindings with the document', async () => {
    await publish(); mocks.id.mockResolvedValueOnce('google-file-two'); raw = null
    expect((await publish('two')).status).toBe(200)
    expect((await editor.readGoogleLedger(slug)).map(r => [r.accountId, r.fileId])).toEqual([['one', fileId], ['two', 'google-file-two']])
    await editor.deleteDoc(slug)
    expect(await editor.readGoogleLedger(slug)).toEqual([])
  })
})
it('rejects approval from an earlier Google connection or another file binding', async () => {
  await publish(); raw = body + '\nGoogle edit.'
  const reviewed = (await call('review', { accountId: 'one' })).body
  mocks.connection.mockReturnValue('reconnected')
  expect((await call('import', { accountId: 'one', localVersion: reviewed.localVersion, remoteSha: reviewed.remoteSha, fileId, connectionVersion: reviewed.connectionVersion })).status).toBe(409)
  mocks.connection.mockReturnValue('connection-one')
  expect((await call('import', { accountId: 'one', localVersion: reviewed.localVersion, remoteSha: reviewed.remoteSha, fileId: 'another-file', connectionVersion: reviewed.connectionVersion })).status).toBe(409)
  expect((await editor.readDoc(slug)).content).toBe(body)
})
it('does not restore a deleted binding onto a replacement document after an in-flight publication', async () => {
  await publish(); await editor.writeDoc(slug, body + '\nPublished change.')
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), pending = new Promise<void>(resolve => { started = resolve })
  mocks.update.mockImplementationOnce(async () => { started(); await held })
  const publication = publish(); await pending
  await editor.deleteDoc(slug); await editor.writeDoc(slug, '# Replacement document')
  release()
  expect((await publication).status).toBe(409)
  expect(await editor.readGoogleLedger(slug)).toEqual([])
  expect((await editor.readDoc(slug)).content).toBe('# Replacement document')
})
it('refuses initial publication if the original document is replaced during remote ID allocation', async () => {
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), pending = new Promise<void>(resolve => { started = resolve })
  mocks.id.mockImplementationOnce(async () => { started(); await held; return fileId })
  const publication = publish(); await pending
  await editor.deleteDoc(slug); await editor.writeDoc(slug, body)
  release()
  expect((await publication).status).toBe(409)
  expect(await editor.readGoogleLedger(slug)).toEqual([])
  expect(mocks.create).not.toHaveBeenCalled()
  expect((await editor.readDoc(slug)).content).toBe(body)
})
it('captures unpublished text and its binding incarnation under one document lock', async () => {
  const version = (await editor.readDoc(slug)).version
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), pending = new Promise<void>(resolve => { started = resolve })
  const realOpen = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
    const handle = await realOpen.open(path, flags, mode), close = handle.close.bind(handle)
    handle.close = async () => { await close(); started(); await held }
    return handle
  })
  const publication = call('publish', { accountId: 'one', localVersion: version }); await pending
  const replacement = (async () => { await editor.deleteDoc(slug); await editor.writeDoc(slug, '# Replacement') })()
  await Promise.race([replacement, new Promise(resolve => setTimeout(resolve, 100))])
  release(); await replacement
  expect([404, 409]).toContain((await publication).status)
  expect(await editor.readGoogleLedger(slug)).toEqual([])
  expect(mocks.create).not.toHaveBeenCalled()
})
it('refuses import before touching a replacement draft when its reviewed binding was deleted', async () => {
  await publish(); raw = body + '\nGoogle edit.'
  const reviewed = (await call('review', { accountId: 'one' })).body
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), pending = new Promise<void>(resolve => { started = resolve })
  const remote = raw
  mocks.read.mockImplementationOnce(async () => { started(); await held; return { raw: remote, etag } })
  const importing = call('import', { accountId: 'one', localVersion: reviewed.localVersion, remoteSha: reviewed.remoteSha, fileId, connectionVersion: reviewed.connectionVersion })
  await pending; await editor.deleteDoc(slug); await editor.writeDoc(slug, body)
  release()
  expect((await importing).status).toBe(409)
  expect((await editor.readDoc(slug)).content).toBe(body)
  expect(await editor.readGoogleLedger(slug)).toEqual([])
  await expect(readdir(join(root, 'editor', '.google-history', slug))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('serializes Google disconnection behind admitted publication work', async () => {
  await publish(); await editor.writeDoc(slug, body + '\nNew local text.')
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), pending = new Promise<void>(resolve => { started = resolve })
  mocks.update.mockImplementationOnce(async () => { started(); await held })
  const publication = publish(); await pending
  const disconnecting = fetch(`${base}/api/google/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'one' }) })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(mocks.disconnect).not.toHaveBeenCalled()
  release()
  expect((await publication).status).toBe(200)
  expect((await disconnecting).status).toBe(200)
  expect(mocks.disconnect).toHaveBeenCalledTimes(1)
})
it('rejects a reviewed publication on a replacement draft before reserving a new destination', async () => {
  await publish(); raw = body + '\nGoogle edit.'
  const reviewed = (await call('review', { accountId: 'one' })).body
  await editor.deleteDoc(slug); await editor.writeDoc(slug, body)
  expect((await call('publish', { accountId: 'one', localVersion: reviewed.localVersion, reviewedRemoteSha: reviewed.remoteSha, fileId, connectionVersion: reviewed.connectionVersion })).status).toBe(409)
  expect(await editor.readGoogleLedger(slug)).toEqual([])
  expect(mocks.id).toHaveBeenCalledTimes(1)
  expect(mocks.create).toHaveBeenCalledTimes(1)
})
it('retains the original destination and baseline when another Google app cannot authorize its file', async () => {
  await publish()
  const before = await editor.readGoogleLedgerState(slug), creates = mocks.create.mock.calls.length, updates = mocks.update.mock.calls.length
  const { HttpError } = await import('../server/http')
  for (const status of [422, 404]) {
    mocks.read.mockRejectedValueOnce(new HttpError(status, 'This linked file is unavailable to the deployment Google app. Reconnecting cannot grant file access.'))
    expect((await publish()).status).toBe(status)
    expect(await editor.readGoogleLedgerState(slug)).toEqual(before)
  }
  expect(mocks.create).toHaveBeenCalledTimes(creates)
  expect(mocks.update).toHaveBeenCalledTimes(updates)
})
it('refuses browser configuration without applying private setup', async () => {
  const response = await fetch(`${base}/api/google/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: 'proof.apps.googleusercontent.com', clientSecret: 'private-test-secret', origin: base }) })
  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain('private-test-secret')
})
