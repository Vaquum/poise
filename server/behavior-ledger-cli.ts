import { pathToFileURL } from 'node:url'
import { LEDGER_RESPONSE_BYTES, type LedgerRead } from './behavior-ledger-contract'

const PREFIX = '/api/behavior-ledger'
const ID = /^[a-f0-9]{64}$/
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/
const USAGE = 'Usage: behavior-ledger list [--limit N] [--cursor CURSOR] [--parent ID] [--repository OWNER/REPO --number N] | get ID | changes CURSOR [--limit N] | health; each accepts --base-url ORIGIN'

class UsageError extends Error {}

function loopbackOrigin(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new UsageError('base URL must be an HTTP numeric loopback origin') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.href !== url.origin + '/') {
    throw new UsageError('base URL must be an HTTP numeric loopback origin without credentials, path, query or fragment')
  }
  return url
}

export function parseBehaviorLedgerArguments(args: string[], env: NodeJS.ProcessEnv = process.env): URL {
  const [operation, ...rest] = args
  if (!['list', 'get', 'changes', 'health'].includes(operation ?? '')) throw new UsageError(USAGE)
  const flags = new Map<string, string>()
  const positional: string[] = []
  const permitted = operation === 'list' ? ['--base-url', '--limit', '--cursor', '--parent', '--repository', '--number']
    : operation === 'changes' ? ['--base-url', '--limit'] : ['--base-url']
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const value = rest[++index]
    if (!permitted.includes(arg) || flags.has(arg) || value === undefined || value.startsWith('--')) throw new UsageError(USAGE)
    flags.set(arg, value)
  }
  if (positional.length !== (operation === 'get' || operation === 'changes' ? 1 : 0)) throw new UsageError(USAGE)
  if (operation === 'get' && !ID.test(positional[0])) throw new UsageError('ID must be 64 lowercase hexadecimal characters')
  const parent = flags.get('--parent')
  if (parent !== undefined && !ID.test(parent)) throw new UsageError('parent must be 64 lowercase hexadecimal characters')
  const limit = flags.get('--limit')
  if (limit !== undefined && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100)) throw new UsageError('limit must be an integer from 1 to 100')
  const cursor = operation === 'changes' ? positional[0] : flags.get('--cursor')
  if (cursor !== undefined && (!cursor || cursor.length > 2048)) throw new UsageError('cursor must contain 1 to 2048 characters')
  const repository = flags.get('--repository')
  const targetNumber = flags.get('--number')
  if ((repository === undefined) !== (targetNumber === undefined)) throw new UsageError(USAGE)
  if (repository !== undefined && (!REPO.test(repository) || repository.length > 140)) {
    throw new UsageError('repository must be OWNER/REPO with at most 140 characters')
  }
  if (targetNumber !== undefined && (!/^[1-9]\d{0,9}$/.test(targetNumber) || !Number.isSafeInteger(Number(targetNumber)))) {
    throw new UsageError('number must be a positive integer')
  }
  const base = loopbackOrigin(flags.get('--base-url') ?? `http://127.0.0.1:${env.POISE_PORT ?? '5555'}`)
  const request: LedgerRead = operation === 'get' ? { operation, id: positional[0] }
    : operation === 'changes' ? { operation, cursor: positional[0] }
      : operation === 'health' ? { operation } : { operation: 'list' }
  base.pathname = request.operation === 'get' ? `${PREFIX}/${request.id}` : request.operation === 'list' ? PREFIX : `${PREFIX}/${request.operation}`
  if (limit !== undefined) base.searchParams.set('limit', limit)
  if (cursor !== undefined) base.searchParams.set('cursor', cursor)
  if (parent !== undefined) base.searchParams.set('parent', parent)
  if (repository !== undefined) base.searchParams.set('repository', repository)
  if (targetNumber !== undefined) base.searchParams.set('number', targetNumber)
  return base
}

function complete(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('health' in value)) return false
  const health = value.health
  return !!health && typeof health === 'object' && 'status' in health && health.status === 'ok'
    && 'pending' in health && health.pending === 0 && 'dropped' in health && health.dropped === 0
    && 'gaps' in health && Array.isArray(health.gaps) && health.gaps.length === 0
}

export async function runBehaviorLedgerCli(args: string[], write = (text: string) => { process.stdout.write(text) },
  writeError = (text: string) => { process.stderr.write(text) }): Promise<number> {
  let url: URL
  try { url = parseBehaviorLedgerArguments(args) }
  catch (error) {
    if (!(error instanceof UsageError)) throw error
    writeError(error.message + '\n')
    return 2
  }
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
    if (!response.body) throw new Error('Ledger returned no JSON body')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > LEDGER_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Ledger response exceeds 512 KiB')
      }
      chunks.push(value)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const value: unknown = JSON.parse(text)
    write(text.endsWith('\n') ? text : text + '\n')
    return response.ok && complete(value) ? 0 : 1
  } catch (error) {
    writeError((error instanceof Error ? error.message : 'Ledger read failed') + '\n')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBehaviorLedgerCli(process.argv.slice(2))
}
