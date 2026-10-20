import { randomUUID } from 'node:crypto'
import { googleAccessToken } from './accounts'
import { HttpError } from '../http'

const MAX_BYTES = 10 * 1024 * 1024
export interface GoogleFile { id: string, name: string, mimeType: string, trashed?: boolean }
export async function driveRequest(accountId: string, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await googleAccessToken(accountId)
  const response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' })
  if (!response.ok) {
    if (response.status === 401) {
      // Establish whether the offline grant ended. Never replay the remote request.
      await googleAccessToken(accountId, true)
      throw new HttpError(502, 'Google rejected this request. Review the destination before trying again.')
    }
    if (response.status === 403) {
      let failure: { error?: { errors?: Array<{ reason?: string }> } }
      try { failure = await response.json() as typeof failure } catch { throw new HttpError(502, 'Google returned an unreadable access failure.') }
      if (failure.error?.errors?.some(e => e.reason === 'appNotAuthorizedToFile')) throw new HttpError(422, 'This Google document is not authorized for this Poise Google app. Reconnecting cannot grant file access. Keep the existing file and comments; ask the Poise operator to retain the original Google app, or continue editing it in Google Docs.')
    }
    const status = response.status === 412 ? 409 : response.status === 404 ? 404 : 502
    throw new HttpError(status, response.status === 412 ? 'Google changed during publishing. Review the latest version and try again.' : response.status === 404 ? 'This linked Google file is missing or unavailable to this Poise Google app. Keep its binding and check the original file in Google Docs; reconnecting may not restore access.' : response.status === 403 ? 'This Google account cannot access this document. Check its file permissions and Google app authorization.' : `Google Drive answered ${response.status}; no automatic retry was made.`)
  }
  return response
}
async function metadata(accountId: string, id: string) {
  const response = await driveRequest(accountId, `https://www.googleapis.com/drive/v2/files/${encodeURIComponent(id)}?fields=id,title,mimeType,etag,labels/trashed&supportsAllDrives=true`)
  const data = await response.json() as { id: string, title: string, mimeType: string, etag?: string, labels?: { trashed?: boolean } }
  const file: GoogleFile = { id: data.id, name: data.title, mimeType: data.mimeType, trashed: data.labels?.trashed }
  if (file.id !== id || file.mimeType !== 'text/markdown' || file.trashed) throw new HttpError(422, 'The linked Google file must be an available Markdown file.')
  const etag = response.headers.get('etag') ?? data.etag
  if (!etag || !/^"[^"\r\n]+"$/.test(etag)) throw new HttpError(502, 'Google returned no usable strong write precondition; publishing is refused.')
  return { file, etag }
}
export async function readGoogleFile(accountId: string, id: string): Promise<{ raw: string, etag: string, file: GoogleFile }> {
  const { file, etag } = await metadata(accountId, id)
  // Drive's metadata ETag cannot condition its media GET. Verify the metadata
  // again after downloading; use that same validator for the atomic upload.
  const response = await driveRequest(accountId, `https://www.googleapis.com/drive/v2/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`)
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new HttpError(422, 'The Google Markdown file exceeds 10 MB.')
  if (!response.body) throw new HttpError(502, 'Google returned no file content.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) { await reader.cancel(); throw new HttpError(422, 'The Google Markdown file exceeds 10 MB.') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  if ((await metadata(accountId, id)).etag !== etag) throw new HttpError(409, 'Google changed during reading. Refresh and review the latest version.')
  return { raw, etag, file }
}
export async function googleFileId(accountId: string): Promise<string> {
  const response = await driveRequest(accountId, 'https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files')
  const data = await response.json() as { ids?: string[] }
  if (!data.ids?.[0] || !/^[A-Za-z0-9_-]+$/.test(data.ids[0])) throw new HttpError(502, 'Google returned no file ID.')
  return data.ids[0]
}
export async function createGoogleFile(accountId: string, id: string, name: string, raw: string): Promise<void> {
  const boundary = `poise_${randomUUID()}`
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ id, name, mimeType: 'text/markdown' })}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${raw}\r\n--${boundary}--\r\n`
  await driveRequest(accountId, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
}
export async function updateGoogleFile(accountId: string, id: string, raw: string, etag: string): Promise<void> {
  if (!etag || !/^"[^"\r\n]+"$/.test(etag)) throw new HttpError(428, 'A strong Google write precondition is required.')
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new HttpError(422, 'The Google Markdown file exceeds 10 MB.')
  await driveRequest(accountId, `https://www.googleapis.com/upload/drive/v2/files/${encodeURIComponent(id)}?uploadType=media&fields=id&supportsAllDrives=true`, { method: 'PUT', headers: { 'Content-Type': 'text/markdown; charset=UTF-8', 'If-Match': etag }, body: raw })
}
