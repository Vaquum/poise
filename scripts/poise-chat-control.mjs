import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

function requestIdentity(value) {
  if (value === undefined) return randomUUID()
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('requestId must be a UUID when supplied')
  return value
}

/** One native-shell entry point for every provider; no provider credentials. */
export async function controlRequest(configPath, input) {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const origin = new URL(config.origin)
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || !origin.port
    || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('control connection must name a local Poise TCP listener')
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.operation !== 'string') throw new Error('a JSON object with operation is required')
  const api = input.operation === 'api'
  const method = api ? (input.method || 'GET') : 'POST'
  if (!['GET', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(method)) throw new Error('unsupported API method')
  const path = api ? input.path : '/api/chat/control'
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('#') || /[\r\n\\]/.test(path)) throw new Error('path must be a local /api/ path')
  const url = new URL(path, origin)
  if (url.origin !== origin.origin || !url.pathname.startsWith('/api/')) throw new Error('API path escaped the local workspace')
  const requestId = requestIdentity(input.requestId)
  const body = api ? input.body : { ...input, requestId }
  if (method === 'GET' && body !== undefined) throw new Error('GET cannot carry a body')
  const encoded = body === undefined ? undefined : JSON.stringify(body)
  if (encoded && Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('request exceeds 1 MiB')
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { 'Content-Type': 'application/json', ...(api ? {} : { 'X-Poise-Chat': config.sessionId, Authorization: `Bearer ${config.token}` }) }, body: encoded })
  let bytes = 0
  const chunks = []
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > 8 * 1024 * 1024) throw new Error('Poise response exceeds 8 MiB; use pagination')
    chunks.push(chunk)
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!response.ok) throw new Error(JSON.stringify({ requestId, status: response.status, ...result }))
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = process.argv[2]
    if (!config) throw new Error('usage: node poise-chat-control.mjs CONNECTION.json [JSON_REQUEST]; omit JSON_REQUEST to read stdin')
    let raw = process.argv[3]
    if (!raw) {
      const chunks = []
      let bytes = 0
      for await (const chunk of process.stdin) {
        bytes += chunk.length
        if (bytes > 1024 * 1024) throw new Error('request exceeds 1 MiB')
        chunks.push(chunk)
      }
      raw = Buffer.concat(chunks).toString('utf8')
    }
    const input = JSON.parse(raw)
    // Print the retry identity before IO, so a lost response can be inspected
    // and retried with the same ID instead of executing another mutation.
    input.requestId = requestIdentity(input.requestId)
    process.stderr.write(`Poise requestId: ${input.requestId}\n`)
    process.stdout.write(JSON.stringify(await controlRequest(config, input), null, 2) + '\n')
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  }
}
