import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { HttpError, httpStatus, readJson } from '../http'
import { EditorConflictError, importGoogleDocument, readDoc, readGoogleDocumentState, readGoogleLedger, readGoogleLedgerState, withPublishLock, writeGoogleLedger } from '../editor'
import { beginGoogleLogin, completeGoogleLogin, disconnectGoogle, googleAccounts, googleAccountSettings, googleConnectionVersion } from './accounts'
import { readServiceConfig, type ServiceConfig } from '../service/config'
import { withGoogleRequest } from './service'
import { createGoogleFile, googleFileId, readGoogleFile, updateGoogleFile } from './drive'
import { readGoogleMarkdown, updateGoogleMarkdown } from './markdown'
import { releaseBackgroundPaused, trackReleaseBackground } from '../release-background'
import type { GoogleChangeReview, GoogleDocumentView, GooglePublication, GooglePublicationView } from './types'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new HttpError(400, `${field} is required.`)
  return value
}
function binding(records: GooglePublication[], id: string) {
  const record = records.find(record => record.accountId === id)
  if (!record) throw new HttpError(404, 'This document is not published to that Google account.')
  return record
}
async function documentView(slug: string, sync: boolean): Promise<GoogleDocumentView> {
  const doc = await readDoc(slug), records = await readGoogleLedger(slug), accounts = googleAccounts()
  const publications: GooglePublicationView[] = []
  for (const record of records) {
    const a = accounts.find(a => a.id === record.accountId)
    const view: GooglePublicationView = { ...record, email: a?.email ?? 'Disconnected Google account', connected: a?.connected ?? false, remoteChanged: null, localChanged: doc.version !== record.sourceSha, comments: [] }
    if (sync && a?.connected) {
      try {
        const file = await readGoogleFile(record.accountId, record.fileId), parsed = readGoogleMarkdown(file.raw)
        view.remoteChanged = sha(parsed.text) !== record.remoteSha
        view.comments = parsed.comments
      } catch (error) { view.problem = (error as Error).message }
    }
    publications.push(view)
  }
  return { version: doc.version, publications }
}
async function publish(slug: string, input: Record<string, unknown>) {
  const id = text(input.accountId, 'Google account'), version = text(input.localVersion, 'Document version')
  if (!googleAccounts().some(a => a.id === id && a.connected)) throw new HttpError(422, 'Connect that Google account first.')
  return withPublishLock(async () => {
    const { doc, ledger } = await readGoogleDocumentState(slug)
    if (doc.version !== version) throw new EditorConflictError(doc.version)
    const records = ledger.records
    let ledgerVersion = ledger.version
    let record = records.find(r => r.accountId === id)
    if (input.reviewedRemoteSha !== undefined && (!record || input.fileId !== record.fileId || input.connectionVersion !== await googleConnectionVersion(id))) throw new HttpError(409, 'The Google connection or document binding changed after review.')
    if (!record) {
      if (records.length >= 10) throw new HttpError(422, 'A document can have at most ten Google destinations.')
      // Reserve and persist the remote ID before a network write. An uncertain create cannot duplicate it.
      const fileId = await googleFileId(id)
      record = { accountId: id, fileId, title: doc.content.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 200) || slug, url: `https://docs.google.com/document/d/${fileId}/edit`, sourceSha: doc.version, remoteSha: '', pending: true }
      records.push(record)
      ledgerVersion = await writeGoogleLedger(slug, records, ledgerVersion)
    }
    let remote
    try { remote = await readGoogleFile(id, record.fileId) }
    catch (error) {
      if (!record.pending || !(error instanceof HttpError) || error.statusCode !== 404) throw error
      const raw = updateGoogleMarkdown('', doc.content)
      await createGoogleFile(id, record.fileId, record.title + '.md', raw)
      remote = await readGoogleFile(id, record.fileId)
      if (remote.raw !== raw) throw new HttpError(409, 'Google changed immediately after publication. Review the Google file.')
      record.remoteSha = sha(readGoogleMarkdown(raw).text)
    }
    const parsed = readGoogleMarkdown(remote.raw)
    if (input.reviewedRemoteSha !== undefined && input.reviewedRemoteSha !== sha(remote.raw)) throw new HttpError(409, 'Google changed after the review opened. Review the latest version.')
    // Unreviewed retries may adopt only the exact reserved publication.
    if (record.pending && !record.remoteSha && input.reviewedRemoteSha === undefined) {
      if (sha(parsed.text) !== record.sourceSha) throw new HttpError(409, 'The reserved Google publication differs from this draft. Review the Google file.')
      record.remoteSha = sha(parsed.text)
    }
    if (sha(parsed.text) !== record.remoteSha && input.reviewedRemoteSha === undefined) throw new HttpError(409, 'Google has unseen edits. Review Google changes before publishing.')
    const raw = updateGoogleMarkdown(remote.raw, doc.content)
    if (raw !== remote.raw) await updateGoogleFile(id, record.fileId, raw, remote.etag)
    record.sourceSha = doc.version; record.remoteSha = sha(doc.content); record.pending = false
    await writeGoogleLedger(slug, records, ledgerVersion)
    return documentView(slug, true)
  })
}
async function review(slug: string, input: Record<string, unknown>): Promise<GoogleChangeReview> {
  const record = binding(await readGoogleLedger(slug), text(input.accountId, 'Google account'))
  const connectionVersion = await googleConnectionVersion(record.accountId)
  const [doc, remote] = await Promise.all([readDoc(slug), readGoogleFile(record.accountId, record.fileId)])
  const parsed = readGoogleMarkdown(remote.raw)
  if (connectionVersion !== await googleConnectionVersion(record.accountId)) throw new HttpError(409, 'The Google connection changed during review.')
  return { fileId: record.fileId, connectionVersion, localText: doc.content, remoteText: parsed.text, localVersion: doc.version, remoteSha: sha(remote.raw), comments: parsed.comments }
}
async function importChanges(slug: string, input: Record<string, unknown>) {
  const id = text(input.accountId, 'Google account'), version = text(input.localVersion, 'Document version'), remoteSha = text(input.remoteSha, 'Google version')
  return withPublishLock(async () => {
    const ledger = await readGoogleLedgerState(slug), records = ledger.records, record = binding(records, id)
    if (input.fileId !== record.fileId || input.connectionVersion !== await googleConnectionVersion(id)) throw new HttpError(409, 'The Google connection or document binding changed after review.')
    const remote = await readGoogleFile(id, record.fileId)
    if (input.connectionVersion !== await googleConnectionVersion(id)) throw new HttpError(409, 'The Google connection changed during import.')
    if (sha(remote.raw) !== remoteSha) throw new HttpError(409, 'Google changed after the review opened. Review the latest version.')
    const parsed = readGoogleMarkdown(remote.raw)
    await importGoogleDocument(slug, parsed.text, version, ledger.version)
    record.sourceSha = sha(parsed.text); record.remoteSha = sha(parsed.text); record.pending = false
    await writeGoogleLedger(slug, records, ledger.version)
    const imported = await readDoc(slug)
    return { ok: true, content: imported.content, version: imported.version }
  })
}
export async function handleGoogleApi(req: IncomingMessage, res: ServerResponse, url: string, service: ServiceConfig | null = readServiceConfig()): Promise<boolean> {
  const path = url.split('?')[0], match = /^\/api\/editor\/doc\/([A-Za-z0-9._-]+)\/google(?:\/(sync|publish|review|import))?$/.exec(path)
  if (!path.startsWith('/api/google/') && !match) return false
  const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); return true }
  let done: (() => void) | undefined
  try {
    if (path === '/api/google/config') return send(404, { error: 'Google is configured by the Poise operator.' })
    const accountAction = /^\/api\/google\/(accounts|connect|callback|disconnect)$/.exec(path)?.[1]
    if (!accountAction && !match) return send(404, { error: 'Unknown Google action.' })
    const purpose = accountAction === 'accounts' || accountAction === 'connect' || accountAction === 'callback' || accountAction === 'disconnect' ? accountAction : match?.[2] === 'publish' || match?.[2] === 'review' || match?.[2] === 'import' ? match[2] : 'sync'
    return await withGoogleRequest(req, service, purpose, async () => {
    if (req.method === 'GET' && path === '/api/google/accounts') return send(200, googleAccountSettings())
    if (req.method === 'GET' && match && !match[2]) return send(200, await documentView(match[1], false))
    if (req.method !== 'POST') return send(405, { error: 'Use POST for Google actions.' })
    if (releaseBackgroundPaused()) throw new HttpError(503, 'Poise is installing an update; try again afterwards.')
    done = trackReleaseBackground()
    const body = await readJson<Record<string, unknown>>(req, 16 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A Google action object is required.')
    if (path === '/api/google/connect') return send(200, await beginGoogleLogin(req, body))
    if (path === '/api/google/callback') return send(200, await withPublishLock(async () => { const connection = await completeGoogleLogin(req, body); return { ...googleAccountSettings(), connection } }))
    if (path === '/api/google/disconnect') { return send(200, await withPublishLock(async () => { await disconnectGoogle(text(body.accountId, 'Google account')); return googleAccountSettings() })) }
    if (match) {
      if (match[2] === 'sync') return send(200, await documentView(match[1], true))
      if (match[2] === 'publish') return send(200, await publish(match[1], body))
      if (match[2] === 'review') return send(200, await review(match[1], body))
      if (match[2] === 'import') return send(200, await importChanges(match[1], body))
    }
    return send(404, { error: 'Unknown Google action.' })
    })
  } catch (error) {
    return send((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : error instanceof EditorConflictError ? 409 : httpStatus(error, 500), { error: (error as Error).message })
  } finally { done?.() }
}
