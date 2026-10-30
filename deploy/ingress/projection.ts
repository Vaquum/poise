import { classifyHost, hostName } from '../../gateway/src/hosts.js'
import { redact } from '../../gateway/src/diagnostics/redaction.mjs'

const domain = process.argv[2]
let size = 0
const chunks: Buffer[] = []
process.stdin.on('data', (chunk: Buffer) => {
  size += chunk.length
  if (size > 1024 * 1024) throw new Error('Ingress projection exceeds 1 MiB')
  chunks.push(chunk)
})
process.stdin.on('end', () => {
  const records: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!domain || !Array.isArray(records) || records.length > 100) throw new Error('Invalid ingress projection')
  const result = records.flatMap((record) => {
    if (!record || typeof record !== 'object' || !record.log || typeof record.log !== 'object') throw new Error('Invalid native ingress projection')
    const log = record.log
    const header = log.request?.host ?? log.server_name ?? log.identifier
    if (typeof header !== 'string' || /:\d+$/.test(header) && Number(header.slice(header.lastIndexOf(':') + 1)) > 65535
      || classifyHost(header, domain).kind === 'unknown' || /^http\.log\.access(?:\.|$)/.test(String(log.logger))) return []
    const safe: Record<string, unknown> = {}
    for (const key of ['level', 'msg', 'message', 'logger', 'request_id', 'error', 'err_id', 'err_trace', 'upstream', 'errno', 'server_name', 'identifier']) {
      if (typeof log[key] === 'string') safe[key] = redact(log[key]).replace(/\?[^\s'"\]]+/g, '?[query omitted]')
    }
    for (const key of ['ts', 'status', 'duration']) if (typeof log[key] === 'number' && Number.isFinite(log[key])) safe[key] = log[key]
    safe.request = { host: hostName(header), method: typeof log.request?.method === 'string' ? redact(log.request.method) : null }
    return [{ id: record.id, time: record.time, log: safe }]
  })
  process.stdout.write(JSON.stringify(result))
})
