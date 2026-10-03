import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, httpStatus } from './http'
import { ProcessLockError } from './process-lock'
import { MAX_SNIPPETS_BYTES, SnippetConflictError, snippetDelivery } from './snippets'
import { readSkillSnippets, saveSkillSnippets, addSkillSnippet, importEspansoSnippets } from './snippet-library'

// JSON escaping can grow a file's text up to six times; the YAML itself is
// held to MAX_SNIPPETS_BYTES once decoded.
const IMPORT_BODY_MAX_BYTES = MAX_SNIPPETS_BYTES * 6 + 1024

/** Shared by the application and isolated browser journeys. The caller applies
 * the normal host/origin policy before dispatching any API route. */
export async function handleSnippetApi(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
  const path = url.split('?')[0]
  if (path !== '/api/snippets' && path !== '/api/snippets/import') return false
  function send(status: number, body: unknown): true {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
    return true
  }
  try {
    if (path === '/api/snippets/import') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        return send(405, { error: 'Use POST to import snippets.' })
      }
      const body = await readJson<{ yaml?: unknown }>(req, IMPORT_BODY_MAX_BYTES)
      return send(200, await importEspansoSnippets(body?.yaml))
    }
    if (req.method === 'GET') return send(200, { ...await readSkillSnippets(), ...snippetDelivery() })
    if (req.method === 'PUT') {
      const body = await readJson<{ snippets?: unknown, base_version?: unknown }>(req)
      if (body?.base_version === undefined) return send(428, { error: 'snippet write precondition is required; reload snippets' })
      return send(200, await saveSkillSnippets(body.snippets, body.base_version))
    }
    if (req.method === 'POST') return send(200, await addSkillSnippet(await readJson(req)))
    res.setHeader('Allow', 'GET, PUT, POST')
    return send(405, { error: 'Use GET, PUT or POST for snippets.' })
  } catch (error) {
    const conflict = error instanceof SnippetConflictError
    const status = conflict ? 409 : error instanceof ProcessLockError ? 503 : httpStatus(error, req.method === 'GET' ? 500 : 400)
    return send(status, { error: error instanceof Error ? error.message : String(error), ...(conflict ? { current_version: error.currentVersion } : {}) })
  }
}
